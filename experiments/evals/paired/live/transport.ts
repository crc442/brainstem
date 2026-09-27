import { appendFileSync } from "node:fs";
import { digest } from "../protocol";
import { LIVE } from "./protocol";

export interface CallRecord {
  id: string; kind: "main" | "judge"; model: string; responseModel?: string;
  requestHash: string; requestBytes: number; reservedUsd: number;
  status: "reserved" | "completed" | "error";
  durationMs?: number; inputTokens?: number; outputTokens?: number; cachedTokens?: number | null;
  measuredCostUsd?: number | null; uncachedCostUpperUsd?: number; httpStatus?: number; error?: string;
}
export class LiveTransport {
  readonly calls: CallRecord[] = [];
  constructor(private readonly journalPath: string, private readonly runSignal: AbortSignal, private readonly fetcher: typeof fetch = fetch) {}
  private append(call: CallRecord) { appendFileSync(this.journalPath, JSON.stringify(call) + "\n"); }
  async request(kind: "main" | "judge", body: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
    const model = String(body.model);
    const prices = LIVE.prices[model as keyof typeof LIVE.prices];
    if (!prices || kind === "judge" && model !== LIVE.models.judge || kind === "main" && ![LIVE.models.primary, LIVE.models.mini].includes(model as never)) throw new Error("unregistered model");
    const text = JSON.stringify(body);
    if (this.runSignal.aborted || signal?.aborted) throw new Error("cancelled before dispatch");
    if (Buffer.byteLength(text) > LIVE.limits.requestBytes) throw new Error("request byte budget exceeded");
    if (this.calls.filter((c) => c.kind === kind).length >= (kind === "main" ? LIVE.limits.mainCalls : LIVE.limits.judgeCalls)) throw new Error(`${kind} call budget exceeded`);
    if (kind === "main" && (body.max_tokens !== LIVE.limits.outputTokens || JSON.stringify(body.thinking) !== '{"type":"disabled"}' || body.stream !== false)) throw new Error("unbounded main request");
    const reservedUsd = ((kind === "main" ? LIVE.limits.mainContextTokens : LIVE.limits.judgeContextTokens) * prices.input + (kind === "main" ? LIVE.limits.outputTokens : 0) * prices.output) / 1e6;
    if (this.calls.reduce((n, c) => n + c.reservedUsd, 0) + reservedUsd > LIVE.limits.perRunUsd) throw new Error("run spend reservation exceeded");
    const call: CallRecord = { id: `call-${this.calls.length + 1}`, kind, model, requestHash: digest(body), requestBytes: Buffer.byteLength(text), reservedUsd, status: "reserved" };
    const key = process.env[kind === "main" ? "ZAI_API_KEY" : "TYPESAFE_API_KEY"];
    if (!key) throw new Error("provider credential missing");
    this.calls.push(call); this.append(call); // Durable reservation before the network call. No automatic retries.
    const start = performance.now();
    try {
      const response = await this.fetcher(LIVE.endpoints[kind], { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: text, signal: AbortSignal.any([this.runSignal, ...(signal ? [signal] : []), AbortSignal.timeout(kind === "judge" ? 10000 : 60000)]) });
      call.httpStatus = response.status;
      if (!response.ok) throw new Error(`provider HTTP ${response.status}: ${(await response.text()).slice(0, 400)}`);
      const data = await response.json() as any;
      call.responseModel = data.model;
      if (data.model !== model) throw new Error(`provider model mismatch: expected ${model}, received ${String(data.model)}`);
      const input = kind === "main" ? data.usage?.prompt_tokens : data.usage?.input_tokens;
      const output = kind === "main" ? data.usage?.completion_tokens : data.usage?.output_tokens;
      if (!Number.isSafeInteger(input) || input < 0 || !Number.isSafeInteger(output) || output < 0) throw new Error("provider usage unavailable; reservation retained");
      if (input > (kind === "main" ? LIVE.limits.mainContextTokens : LIVE.limits.judgeContextTokens) || kind === "main" && output > LIVE.limits.outputTokens) throw new Error("provider exceeded frozen token bounds");
      call.inputTokens = input; call.outputTokens = output;
      const cached = kind === "judge" ? 0 : data.usage?.prompt_tokens_details?.cached_tokens;
      call.cachedTokens = Number.isSafeInteger(cached) && cached >= 0 && cached <= input ? cached : null;
      call.uncachedCostUpperUsd = (input * prices.input + output * prices.output) / 1e6;
      call.measuredCostUsd = call.cachedTokens == null ? null : ((input - call.cachedTokens) * prices.input + call.cachedTokens * prices.cached + output * prices.output) / 1e6;
      call.status = "completed";
      return data;
    } catch (error) {
      call.status = "error"; call.error = String(error); throw error;
    } finally { call.durationMs = performance.now() - start; this.append(call); }
  }
}
