import { CircuitBreaker } from "./circuit-breaker";
import { JevCancelledError, JevUnavailableError } from "./errors";
import type { SystemOne } from "./types";

/** Bounds local waiting, not remote compute or host execution. One instance per provider/session. */
export function judgmentService(provider: SystemOne, options: { deadlineMs: number; maxCalls?: number; breaker: CircuitBreaker }): SystemOne {
  if (options.maxCalls !== undefined && (!Number.isInteger(options.maxCalls) || options.maxCalls < 0)) throw new Error("maxJudgmentCalls must be a non-negative integer");
  if (!Number.isFinite(options.deadlineMs) || options.deadlineMs <= 0) throw new Error("judgment deadline must be positive");
  let calls = 0;
  return {
    name: provider.name,
    capabilities: provider.capabilities,
    async ask(state, questions, request = {}) {
      if (request.signal?.aborted) throw new JevCancelledError("judgment aborted before dispatch");
      if (options.maxCalls !== undefined && calls >= options.maxCalls) throw new JevUnavailableError("judgment call limit reached");
      const deadlineMs = Math.min(request.deadlineMs ?? options.deadlineMs, options.deadlineMs);
      if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) throw new JevUnavailableError("judgment deadline exhausted");
      if (!options.breaker.canRequest()) throw new JevUnavailableError("circuit open");
      calls++;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: () => void = () => {};
      try {
        const cancelled = new Promise<never>((_, reject) => {
          onAbort = () => { reject(new JevCancelledError("judgment aborted")); controller.abort(); };
          request.signal?.addEventListener("abort", onAbort, { once: true });
          timer = setTimeout(() => { reject(new JevUnavailableError("judgment deadline exceeded")); controller.abort(); }, deadlineMs);
        });
        const result = await Promise.race([cancelled, provider.ask(state, questions, { signal: controller.signal, deadlineMs })]);
        if (request.signal?.aborted) throw new JevCancelledError("judgment aborted");
        options.breaker.onSuccess();
        return result;
      } catch (error) {
        if (request.signal?.aborted) options.breaker.onCancel();
        else options.breaker.onFailure();
        throw error;
      } finally {
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}
