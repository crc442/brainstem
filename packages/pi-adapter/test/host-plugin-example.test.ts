import { expect, test, vi } from "vitest";
import { Agent } from "@earendil-works/pi-agent-core";
import { hashAction, mockSystemOne, choiceAnswer, noulAnswer, scoreAnswer } from "@brainstem/core";
import type { GateReview } from "@brainstem/reflexes";
import { createHostAuthorizations, installBrainstem } from "../examples/host-plugin";

const invocation = { toolCallId: "write-1", sessionId: "session-1", revision: 1 };
const action = { tool: "write", arguments: { path: "file.txt", content: "approved bytes" } };
const review = (): GateReview & { toolCallId: string } => ({
  ...invocation,
  subjectId: hashAction(action),
  subject: { ...structuredClone(action), task: "update file.txt" },
  decision: { action: "ask", reasons: ["confirm the write"] },
});
const signal = () => new AbortController().signal;

test("example receipts authorize the exact action once and include write contents", async () => {
  const ledger = createHostAuthorizations();
  ledger.recordApproved(invocation, action);
  expect(await ledger.resolveActionApproval(review(), signal())).toBe("approved");
  expect(await ledger.resolveActionApproval(review(), signal())).toBe("unknown");
  ledger.recordApproved(invocation, action);
  const changed = review();
  (changed.subject as typeof action).arguments.content = "different bytes";
  expect(await ledger.resolveActionApproval(changed, signal())).toBe("unknown");
  expect(await ledger.resolveActionApproval(review(), signal())).toBe("unknown");
});

test.each(["tool", "session", "revision", "arguments", "cancelled"] as const)(
  "%s mismatch consumes the receipt without approval",
  async (kind) => {
    const ledger = createHostAuthorizations();
    ledger.recordApproved(invocation, action);
    const input = review();
    const controller = new AbortController();
    if (kind === "tool") (input.subject as typeof action).tool = "read";
    if (kind === "session") input.sessionId = "different session";
    if (kind === "revision") input.revision++;
    if (kind === "arguments") (input.subject as typeof action).arguments.path = "other.txt";
    if (kind === "cancelled") controller.abort();
    expect(await ledger.resolveActionApproval(input, controller.signal)).toBe("unknown");
    expect(await ledger.resolveActionApproval(review(), signal())).toBe("unknown");
  },
);

test("different invocation IDs, separate ledgers, and cleanup never share approvals", async () => {
  const ledger = createHostAuthorizations();
  ledger.recordApproved(invocation, action);
  expect(await ledger.resolveActionApproval({ ...review(), toolCallId: "other" }, signal())).toBe("unknown");
  expect(await createHostAuthorizations().resolveActionApproval(review(), signal())).toBe("unknown");
  ledger.forget(invocation.toolCallId);
  expect(await ledger.resolveActionApproval(review(), signal())).toBe("unknown");
  ledger.recordApproved(invocation, action);
  ledger.clear();
  expect(await ledger.resolveActionApproval(review(), signal())).toBe("unknown");
});

test("installBrainstem forwards the example resolver and preserves host denial", async () => {
  const ledger = createHostAuthorizations();
  const approve = vi.fn(async () => true);
  let deny = false;
  const agent = new Agent({
    streamFn: () => {
      throw new Error("this test only invokes the tool hook");
    },
    beforeToolCall: async (context) => {
      ledger.forget(context.toolCall.id);
      if (deny) return { block: true, reason: "host denied" };
      ledger.recordApproved(
        { toolCallId: context.toolCall.id, sessionId: plugin.session.sessionId, revision: plugin.session.revision },
        {
          tool: context.toolCall.name,
          arguments: structuredClone(context.args),
        },
      );
    },
  });
  const plugin = installBrainstem(agent, {
    cwd: "/tmp",
    approve,
    resolveActionApproval: ledger.resolveActionApproval,
    judge: mockSystemOne(() => ({
      disposition: choiceAnswer("ask_user", 0.99),
      destructive: scoreAnswer(0, 1),
      touches_credentials: noulAnswer(0),
      exfiltrates: noulAnswer(0),
      on_task: noulAnswer(1),
    })),
  });
  const args = structuredClone(action.arguments);
  const context = { toolCall: { id: invocation.toolCallId, name: action.tool, arguments: args }, args };
  try {
    expect((await agent.beforeToolCall!(context as never))?.block).not.toBe(true);
    expect(approve).not.toHaveBeenCalled();
    deny = true;
    expect(await agent.beforeToolCall!(context as never)).toEqual({ block: true, reason: "host denied" });
    expect(approve).not.toHaveBeenCalled();
  } finally {
    ledger.clear();
    plugin.dispose();
  }
});
