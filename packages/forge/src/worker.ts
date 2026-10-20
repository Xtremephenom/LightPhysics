import { ForgeError } from "./errors.ts";
import { AdapterBase, throwIfCancelled, withTimeout, type AdapterDescription, type RunOptions } from "./adapter.ts";
import { ForgeResultSchema, type ForgeRequest, type ForgeResult } from "./capabilities.ts";

export interface JsonRpcMessage { jsonrpc: "2.0"; id?: string | number; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string }; }
export interface ChildTransport { start(): Promise<void> | void; write(line: string): Promise<void> | void; onLine(listener: (line: string) => void): void; close?(): Promise<void> | void; kill?(): Promise<void> | void; }

/** JSON-RPC lifecycle seam; no child process is created by this package. */
export class StdioJsonRpcWorker {
  private nextId = 1; private readonly pending = new Map<string | number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>(); private started = false;
  private readonly transport: ChildTransport;
  constructor(transport: ChildTransport) { this.transport = transport; transport.onLine((line) => this.receive(line)); }
  async start(): Promise<void> { if (!this.started) { await this.transport.start(); this.started = true; } }
  private receive(line: string): void { let message: JsonRpcMessage; try { message = JSON.parse(line) as JsonRpcMessage; } catch { return; } if (message.id === undefined) return; const waiter = this.pending.get(message.id); if (!waiter) return; this.pending.delete(message.id); if (message.error) waiter.reject(new ForgeError("ProviderError", message.error.message, { details: message.error })); else waiter.resolve(message.result); }
  async request(method: string, params: unknown = {}): Promise<unknown> { await this.start(); const id = this.nextId++; const message = { jsonrpc: "2.0", id, method, params }; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); void Promise.resolve(this.transport.write(JSON.stringify(message) + "\n")).catch(reject); }); }
  async close(): Promise<void> { await this.transport.close?.(); this.started = false; }
  async kill(): Promise<void> { await this.transport.kill?.(); this.pending.clear(); this.started = false; }
}

export interface PythonWorkerAdapterOptions { id?: string; worker: StdioJsonRpcWorker; capabilities: ForgeRequest["capability"][]; }
export class PythonWorkerAdapter extends AdapterBase {
  readonly id: string;
  private readonly options: PythonWorkerAdapterOptions;
  constructor(options: PythonWorkerAdapterOptions) { super(); this.options = options; this.id = options.id ?? "python-worker"; }
  override describe(): AdapterDescription { return { id: this.id, kind: "local", capabilities: this.options.capabilities }; }
  override estimate(_request: ForgeRequest) { return { cost: 0, currency: "USD", resources: { vram_peak_mb: 0, ram_peak_mb: 512, exclusive: false } }; }
  override async health(): Promise<{ healthy: boolean; status: "ok" | "degraded" | "unavailable"; detail?: string }> { try { await this.options.worker.request("health"); return { healthy: true, status: "ok" }; } catch (error) { return { healthy: false, status: "unavailable", detail: error instanceof Error ? error.message : String(error) }; } }
  override async run(request: ForgeRequest, options: RunOptions = {}): Promise<ForgeResult> { throwIfCancelled(options.signal); if (!this.options.capabilities.includes(request.capability)) throw new ForgeError("NotImplemented", `${this.id} does not implement ${request.capability}`, { retryable: false }); const result = await withTimeout(() => this.options.worker.request("run", request), options, `${this.id} request timed out`); try { return ForgeResultSchema.parse(result); } catch { throw new ForgeError("MalformedResponse", `${this.id} returned an invalid Forge result`, { retryable: false }); } }
}

export interface AudioAnalysisInput { samples: readonly number[]; sampleRate: number; loopStart?: number; loopEnd?: number; }
export interface AudioAnalysisResult { peak: number; lufs: number; silence_ratio: number; duration_s: number; loop_seam_score: number; }
export function analyzeAudio(input: AudioAnalysisInput): AudioAnalysisResult {
  if (!Number.isInteger(input.sampleRate) || input.sampleRate <= 0 || input.samples.length === 0) throw new ForgeError("ValidationError", "audio samples and positive sampleRate are required", { retryable: false });
  const start = input.loopStart ?? 0; const end = input.loopEnd ?? input.samples.length - 1; if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end >= input.samples.length) throw new ForgeError("ValidationError", "loop bounds must be inside the sample buffer", { retryable: false });
  const peak = Math.max(...input.samples.map((v) => Math.min(1, Math.abs(v)))); const meanSquare = input.samples.reduce((sum, v) => sum + v * v, 0) / input.samples.length; const lufs = meanSquare === 0 ? -Infinity : -0.691 + 10 * Math.log10(meanSquare); const silence = input.samples.filter((v) => Math.abs(v) < 0.0001).length / input.samples.length; const seam = 1 - Math.min(1, Math.abs((input.samples[start] ?? 0) - (input.samples[end] ?? 0)));
  return { peak, lufs: Number.isFinite(lufs) ? Number(lufs.toFixed(6)) : -Infinity, silence_ratio: Number(silence.toFixed(6)), duration_s: Number((input.samples.length / input.sampleRate).toFixed(6)), loop_seam_score: Number(seam.toFixed(6)) };
}
export function createAudioAnalysisWorker(): (input: AudioAnalysisInput) => AudioAnalysisResult { return analyzeAudio; }
