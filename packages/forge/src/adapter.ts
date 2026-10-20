import { createHash } from "node:crypto";
import { ForgeRequestSchema, type CapabilityId, type ForgeRequest, type ForgeResult } from "./capabilities.ts";
import { ForgeError, NotImplementedError, type ForgeErrorCode } from "./errors.ts";
import type { QualificationRecord } from "./qualification.ts";

export type AdapterKind = "local" | "hosted" | "mock";
export interface AdapterDescription { id: string; kind: AdapterKind; capabilities: readonly CapabilityId[]; model?: string; version?: string; }
export interface HealthResult { healthy: boolean; status: "ok" | "degraded" | "unavailable"; detail?: string; }
export interface Estimate { cost: number; currency: string; latency_ms?: number; resources?: { vram_peak_mb: number; ram_peak_mb: number; exclusive: boolean }; }
export interface RunOptions { onProgress?: (progress: { fraction: number; message?: string }) => void; signal?: AbortSignal; timeout_ms?: number; }
export interface ForgeAdapter { readonly id: string; describe(): AdapterDescription; health(): Promise<HealthResult>; estimate(request: ForgeRequest): Estimate; run(request: ForgeRequest, options?: RunOptions): Promise<ForgeResult>; qualify(): Promise<QualificationRecord>; }

export function requestHash(request: ForgeRequest): string {
  return createHash("sha256").update(stableJson(request)).digest("hex");
}
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

export abstract class AdapterBase implements ForgeAdapter {
  abstract readonly id: string;
  abstract describe(): AdapterDescription;
  async health(): Promise<HealthResult> { return { healthy: true, status: "ok" }; }
  estimate(_request: ForgeRequest): Estimate { return { cost: 0, currency: "USD" }; }
  async run(_request: ForgeRequest, _options?: RunOptions): Promise<ForgeResult> { throw new NotImplementedError(`${this.id}.run`); }
  async qualify(): Promise<QualificationRecord> { return { status: "NOT_RUN", adapter_id: this.id, machine_profile: "unknown", versions: {}, date: new Date().toISOString(), checks: [] }; }
}

export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ForgeError("Cancelled", "request cancelled", { retryable: false });
}

export async function withTimeout<T>(operation: () => Promise<T>, options: RunOptions, message = "request timed out"): Promise<T> {
  throwIfCancelled(options.signal);
  const timeout = options.timeout_ms;
  if (timeout !== undefined && (!Number.isSafeInteger(timeout) || timeout <= 0)) throw new ForgeError("ValidationError", "timeout_ms must be a positive integer", { retryable: false });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: (() => void) | undefined;
  const signal = options.signal;
  const timeoutPromise = timeout === undefined ? undefined : new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ForgeError("Timeout", message)), timeout);
  });
  const cancellationPromise = signal === undefined ? undefined : new Promise<never>((_, reject) => {
    const onAbort = () => reject(new ForgeError("Cancelled", "request cancelled", { retryable: false }));
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
  });
  try {
    const pending: Array<Promise<T> | Promise<never>> = [operation()];
    if (timeoutPromise !== undefined) pending.push(timeoutPromise);
    if (cancellationPromise !== undefined) pending.push(cancellationPromise);
    return await Promise.race(pending);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    removeAbortListener?.();
  }
}

export function mapHttpError(provider: string, status: number, body?: unknown): ForgeError {
  const text = typeof body === "string" ? body : JSON.stringify(body ?? "");
  const lower = text.toLowerCase();
  let code: ForgeErrorCode = "ProviderError";
  if (status === 401 || status === 403) code = "Authentication";
  else if (status === 404 || status === 425 || status === 503) code = "ResourceUnavailable";
  else if (status === 408 || status === 504) code = "Timeout";
  else if (status === 409 || status === 429) code = "RateLimit";
  else if (status === 413 || /out.?of.?memory|cuda out of memory|oom/.test(lower)) code = "OutOfMemory";
  else if (status === 400 && /policy|safety|content/.test(lower)) code = "PolicyRefusal";
  else if (status === 400 || status === 422) code = "MalformedResponse";
  const safeBody = typeof body === "string"
    ? body.replace(/(authorization|api[_-]?key|token|password|secret)\s*[:=]\s*[^,\s}]+/gi, "$1=[redacted]").slice(0, 512)
    : body;
  return new ForgeError(code, `${provider} returned HTTP ${status}`, { details: { status, body: safeBody } });
}

export function ensureRequest(request: ForgeRequest): ForgeRequest { return ForgeRequestSchema.parse(request); }
