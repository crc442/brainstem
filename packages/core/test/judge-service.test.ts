import { expect, test } from "vitest";
import { CircuitBreaker, judgmentService, mockSystemOne, choiceAnswer, decideGate, decideSteer, policyForTrust } from "../src";

test("legacy and unavailable confidence cannot approve or route; zero remains distinct", () => {
  const policy = policyForTrust(1);
  for (const answer of [
    { type: "choice" as const, choice: "auto_run", confidence: 1, probabilities: {} },
    { type: "choice" as const, choice: "auto_run", confidence: null, confidenceSource: "unavailable" as const, probabilities: null },
  ]) {
    expect(decideGate({ disposition: answer }, policy).action).toBe("ask");
    expect(decideSteer({ model_tier: { ...answer, choice: "mini" } }, policy).tier).toBe("frontier");
  }
  expect(decideGate({ disposition: choiceAnswer("auto_run", 0) }, policy).action).toBe("ask");
  expect(decideGate({ disposition: choiceAnswer("auto_run", 1) }, policy).action).toBe("auto");
});

test("provider ignoring signals times out, opens breaker, and a cancelled probe releases its slot", async () => {
  let now = 0;
  const breaker = new CircuitBreaker({ threshold: 1, cooldownMs: 10, probe: 1, now: () => now });
  let calls = 0;
  const service = judgmentService(
    {
      name: "ignores-abort",
      ask: () => {
        calls++;
        return new Promise(() => {});
      },
    },
    { deadlineMs: 15, breaker },
  );
  await expect(service.ask({}, {})).rejects.toThrow("deadline");
  await expect(service.ask({}, {})).rejects.toThrow("circuit open");
  expect(calls).toBe(1);
  now = 11;
  const abort = new AbortController();
  const pending = service.ask({}, {}, { signal: abort.signal });
  abort.abort();
  await expect(pending).rejects.toThrow("aborted");
  expect(breaker.canRequest()).toBe(true);
});

test("pre-abort and judgment limit prevent dispatch", async () => {
  const provider = mockSystemOne(() => ({}));
  const service = judgmentService(provider, {
    deadlineMs: 100,
    maxCalls: 1,
    breaker: new CircuitBreaker({ threshold: 3, cooldownMs: 10, probe: 1 }),
  });
  await expect(service.ask({}, {}, { signal: AbortSignal.abort() })).rejects.toThrow("aborted");
  await service.ask({}, {});
  await expect(service.ask({}, {})).rejects.toThrow("limit");
  expect(provider.calls).toHaveLength(1);
});
