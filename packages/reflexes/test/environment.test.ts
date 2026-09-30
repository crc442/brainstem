import { describe, expect, test } from "vitest";
import { mockSystemOne, choiceAnswer, noulAnswer, scoreAnswer, type Answer } from "@brainstem/core";
import { createReflexes } from "../src/index";

const AUTO_GATE = (): Record<string, Answer> => ({
  destructive: scoreAnswer(0, 0.9),
  touches_credentials: noulAnswer(0.02),
  exfiltrates: noulAnswer(0.01),
  on_task: noulAnswer(0.95),
  disposition: choiceAnswer("auto_run", 0.95, { auto_run: 0.95, ask_user: 0.04, deny: 0.01 }),
});

describe("createReflexes environment", () => {
  test("forwards the environment string into gate judgment state", async () => {
    const mock = mockSystemOne(() => AUTO_GATE());
    const reflexes = createReflexes({ judge: mock, root: "/tmp", environment: "ALLOW: staging deploys are routine" });

    await reflexes.gate({ tool: "bash", command: "echo hi", task: "t" });

    const state = mock.calls[0]!.state as { environment: string };
    expect(state.environment).toBe("ALLOW: staging deploys are routine");
  });

  test("falls back to the engine default when omitted", async () => {
    const mock = mockSystemOne(() => AUTO_GATE());
    const reflexes = createReflexes({ judge: mock, root: "/tmp" });

    await reflexes.gate({ tool: "bash", command: "echo hi", task: "t" });

    const state = mock.calls[0]!.state as { environment: string };
    expect(state.environment).toBe("A git repository in the current working directory.");
  });
});
