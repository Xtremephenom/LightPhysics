import { createHash } from "node:crypto";
import { AdapterBase, throwIfCancelled, type AdapterDescription, type RunOptions } from "./adapter.ts";
import { ForgeRequestSchema, ForgeResultSchema, type CapabilityId, type ForgeRequest, type ForgeResult } from "./capabilities.ts";
import { ForgeError, type ForgeErrorCode } from "./errors.ts";

export type MockFailure = "timeout" | "429" | "rate_limit" | "malformed" | "policy_refusal" | "oom" | "success";
export interface MockAdapterOptions { id?: string; capabilities?: readonly CapabilityId[]; model?: string; failure?: MockFailure; failures?: readonly MockFailure[]; clock?: () => number; }

export class MockAdapter extends AdapterBase {
  readonly id: string;
  private readonly capabilities: readonly CapabilityId[];
  private readonly failures: MockFailure[];
  private readonly clock: () => number;
  constructor(options: MockAdapterOptions = {}) {
    super(); this.id = options.id ?? "mock"; this.capabilities = options.capabilities ?? ["image.generate", "audio.sfx", "vision.inspect"]; this.failures = [...(options.failures ?? (options.failure ? [options.failure] : ["success"]))]; this.clock = options.clock ?? (() => 0);
  }
  override describe(): AdapterDescription { return { id: this.id, kind: "mock", capabilities: this.capabilities, model: "mock-model", version: "1" }; }
  override estimate(request: ForgeRequest) { ForgeRequestSchema.parse(request); return { cost: 0, currency: "USD", latency_ms: 1, resources: { vram_peak_mb: 0, ram_peak_mb: 32, exclusive: false } }; }
  override async run(request: ForgeRequest, options: RunOptions = {}): Promise<ForgeResult> {
    const normalized = ForgeRequestSchema.parse(request);
    if (!this.capabilities.includes(normalized.capability)) throw new ForgeError("NotImplemented", `${this.id} does not implement ${normalized.capability}`, { retryable: false });
    throwIfCancelled(options.signal);
    const failure = this.failures.length > 1 ? this.failures.shift()! : this.failures[0] ?? "success";
    options.onProgress?.({ fraction: 0 });
    const code: Record<string, ForgeErrorCode> = { timeout: "Timeout", "429": "RateLimit", rate_limit: "RateLimit", malformed: "MalformedResponse", policy_refusal: "PolicyRefusal", oom: "OutOfMemory" };
    if (failure !== "success") {
      const mapped = code[failure];
      if (!mapped) throw new ForgeError("ProviderError", `mock injected ${failure}`, { retryable: false });
      throw new ForgeError(mapped, `mock injected ${failure}`, { details: { injected: failure } });
    }
    const hash = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
    options.onProgress?.({ fraction: 1, message: "complete" });
    return ForgeResultSchema.parse({ job_id: `mock-${hash.slice(0, 12)}`, status: "done", artifacts: [{ id: `artifact-${hash.slice(0, 12)}`, uri: `mock://${hash}`, kind: normalized.capability.startsWith("audio") ? "audio" : "generated", mime: "application/octet-stream", sha256: hash, state: "exploration" }], cost: 0, timing: { latency_ms: this.clock() }, warnings: [], next_actions: [], provenance: { provider: this.id, request_hash: hash, ...(typeof normalized.style_lock === "object" ? { style_lock: { version: normalized.style_lock.version } } : {}) } });
  }
}
