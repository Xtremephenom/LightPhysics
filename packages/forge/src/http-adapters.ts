import { AdapterBase, mapHttpError, requestHash, throwIfCancelled, withTimeout, type AdapterDescription, type RunOptions } from "./adapter.ts";
import { ForgeRequestSchema, ForgeResultSchema, type ForgeRequest, type ForgeResult } from "./capabilities.ts";
import { ForgeError } from "./errors.ts";

export interface HttpRequest { method: string; url: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal; }
export interface HttpResponse { status: number; headers?: Record<string, string>; body: string | Uint8Array | unknown; }
export interface HttpTransport { request(request: HttpRequest): Promise<HttpResponse>; }
const MAX_RESPONSE_BYTES = 1_048_576;
function bytes(value: string | Uint8Array): number { return typeof value === "string" ? new TextEncoder().encode(value).byteLength : value.byteLength; }
function boundedJson(body: unknown, maxBytes = MAX_RESPONSE_BYTES): unknown {
  if (body instanceof Uint8Array) {
    if (body.byteLength > maxBytes) throw new ForgeError("MalformedResponse", "provider response exceeds JSON bound");
    body = new TextDecoder().decode(body);
  }
  if (typeof body !== "string") {
    try { if (bytes(JSON.stringify(body)) > maxBytes) throw new ForgeError("MalformedResponse", "provider response exceeds JSON bound"); } catch (error) { if (error instanceof ForgeError) throw error; throw new ForgeError("MalformedResponse", "provider response is not bounded JSON"); }
    return body;
  }
  if (bytes(body) > maxBytes) throw new ForgeError("MalformedResponse", "provider response exceeds JSON bound");
  try { return JSON.parse(body); } catch { throw new ForgeError("MalformedResponse", "provider returned invalid JSON"); }
}
function responseJson(response: HttpResponse, maxBytes = MAX_RESPONSE_BYTES): unknown { return boundedJson(response.body, maxBytes); }
function bearer(headers: Record<string, string>, token?: string): Record<string, string> { return { ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}) }; }
function result(request: ForgeRequest, provider: string, body: unknown): ForgeResult {
  const hash = requestHash(request); const record = body as Record<string, unknown>;
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new ForgeError("MalformedResponse", `${provider} returned a non-object response`);
  const choice = Array.isArray(record.choices) ? record.choices[0] as Record<string, unknown> | undefined : undefined;
  const message = typeof choice?.message === "object" && choice.message !== null
    ? (choice.message as Record<string, unknown>).content
    : choice?.message;
  const text = choice ? String(message ?? choice.text ?? "") : "";
  const data = Array.isArray(record.data) ? record.data : [];
  if (!text && data.length === 0) throw new ForgeError("MalformedResponse", `${provider} response contained no result`);
  const firstData = data[0];
  const dataRecord = typeof firstData === "object" && firstData ? firstData as Record<string, unknown> : undefined;
  const uri = typeof dataRecord?.url === "string" && dataRecord.url.length > 0 ? dataRecord.url : `data://${hash}`;
  return ForgeResultSchema.parse({ job_id: `${provider}-${hash.slice(0, 12)}`, status: "done", artifacts: [{ id: `${provider}-${hash.slice(0, 12)}`, uri, kind: text ? "text" : "generated", mime: text ? "text/plain" : "application/octet-stream", sha256: hash, preview: text.slice(0, 512), state: "exploration" }], cost: 0, timing: {}, warnings: [], next_actions: [], provenance: { provider, request_hash: hash, ...(typeof request.style_lock === "object" ? { style_lock: { version: request.style_lock.version } } : {}) } });
}

export interface OpenAICompatibleOptions { id?: string; baseUrl: string; transport: HttpTransport; apiKey?: string; capabilities?: ForgeRequest["capability"][]; maxResponseBytes?: number; }
export class OpenAICompatibleAdapter extends AdapterBase {
  readonly id: string; private readonly options: OpenAICompatibleOptions;
  constructor(options: OpenAICompatibleOptions) { super(); this.options = options; this.id = options.id ?? "openai-compatible"; }
  override describe(): AdapterDescription { return { id: this.id, kind: "local", capabilities: this.options.capabilities ?? ["reason.plan", "reason.code", "vision.inspect", "embed.text", "image.generate"] }; }
  override estimate(_request: ForgeRequest) { return { cost: 0, currency: "USD", resources: { vram_peak_mb: 0, ram_peak_mb: 512, exclusive: false } }; }
  override async run(request: ForgeRequest, runOptions: RunOptions = {}): Promise<ForgeResult> {
    const req = ForgeRequestSchema.parse(request); throwIfCancelled(runOptions.signal);
    if (!this.describe().capabilities.includes(req.capability)) throw new ForgeError("NotImplemented", `${this.id} does not implement ${req.capability}`, { retryable: false });
    const embeddings = req.capability.startsWith("embed."); const images = req.capability.startsWith("image.");
    const path = embeddings ? "/v1/embeddings" : images ? "/v1/images/generations" : "/v1/chat/completions";
    const body = JSON.stringify({ model: req.provider_params?.model ?? "default", prompt: req.prompt, input: req.input, messages: req.prompt ? [{ role: "user", content: req.prompt }] : undefined, n: req.count, size: req.size ? `${req.size.width}x${req.size.height}` : undefined });
    const response = await withTimeout(() => this.options.transport.request({ method: "POST", url: this.options.baseUrl.replace(/\/$/, "") + path, headers: bearer({ "content-type": "application/json" }, this.options.apiKey), body, ...(runOptions.signal === undefined ? {} : { signal: runOptions.signal }) }), runOptions, `${this.id} request timed out`);
    if (response.status < 200 || response.status >= 300) throw mapHttpError(this.id, response.status, response.body);
    return result(req, this.id, responseJson(response, this.options.maxResponseBytes ?? MAX_RESPONSE_BYTES));
  }
}

export interface ComfyTransport { request(request: HttpRequest): Promise<HttpResponse>; }
export interface ComfyUIOptions { id?: string; baseUrl: string; transport: ComfyTransport; maxPolls?: number; sleep?: (ms: number) => Promise<void>; }
export class ComfyUIWorkflowAdapter extends AdapterBase {
  readonly id: string; private readonly options: ComfyUIOptions;
  constructor(options: ComfyUIOptions) { super(); this.options = options; this.id = options.id ?? "comfyui-workflow"; }
  override describe(): AdapterDescription { return { id: this.id, kind: "local", capabilities: ["image.generate", "image.edit", "image.upscale", "texture.seamless", "model3d.from_text"] }; }
  override estimate(_request: ForgeRequest) { return { cost: 0, currency: "USD", latency_ms: 1000, resources: { vram_peak_mb: 4096, ram_peak_mb: 4096, exclusive: true } }; }
  private async call(path: string, method: string, body?: unknown, signal?: AbortSignal): Promise<unknown> { const request: HttpRequest = { method, url: this.options.baseUrl.replace(/\/$/, "") + path, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(signal === undefined ? {} : { signal }) }; const response = await this.options.transport.request(request); if (response.status < 200 || response.status >= 300) throw mapHttpError(this.id, response.status, response.body); return responseJson(response); }
  async submit(request: ForgeRequest): Promise<string> { const submitted = await this.call("/prompt", "POST", { prompt: request.prompt, client_id: "lightphysics-forge" }) as Record<string, unknown>; const promptId = typeof submitted.prompt_id === "string" ? submitted.prompt_id : typeof submitted.id === "string" ? submitted.id : ""; if (!promptId) throw new ForgeError("MalformedResponse", "ComfyUI submit response had no prompt id"); return promptId; }
  async history(promptId: string): Promise<unknown> { return this.call(`/history/${encodeURIComponent(promptId)}`, "GET"); }
  async fetch(filename: string, subfolder?: string, type?: string): Promise<unknown> { return this.call(`/view?filename=${encodeURIComponent(filename)}${subfolder ? `&subfolder=${encodeURIComponent(subfolder)}` : ""}${type ? `&type=${encodeURIComponent(type)}` : ""}`, "GET"); }
  override async run(request: ForgeRequest, options: RunOptions = {}): Promise<ForgeResult> {
    const req = ForgeRequestSchema.parse(request); throwIfCancelled(options.signal); if (!this.describe().capabilities.includes(req.capability)) throw new ForgeError("NotImplemented", `${this.id} does not implement ${req.capability}`, { retryable: false }); const promptId = await this.submit(req);
    const started = Date.now(); const max = this.options.maxPolls ?? 30; for (let poll = 0; poll < max; poll += 1) { if (options.timeout_ms !== undefined && Date.now() - started >= options.timeout_ms) { await this.cancel(promptId); throw new ForgeError("Timeout", "ComfyUI workflow timed out"); } if (options.signal?.aborted) { await this.cancel(promptId); throw new ForgeError("Cancelled", "ComfyUI request cancelled", { retryable: false }); } options.onProgress?.({ fraction: poll / max }); const history = await this.history(promptId) as Record<string, unknown>; if (/out.?of.?memory|cuda|oom/i.test(JSON.stringify(history))) throw new ForgeError("OutOfMemory", "ComfyUI workflow failed with a resource error"); const entry = (history[promptId] ?? history) as Record<string, unknown>; if (entry.status === "error") throw new ForgeError("ProviderError", "ComfyUI workflow failed", { details: { status: entry.status } }); if (entry.completed || entry.outputs) { const outputs = Object.values((entry.outputs ?? {}) as Record<string, unknown>).flatMap((v) => Array.isArray(v) ? v : [v]); const artifact = outputs[0] as Record<string, unknown> | undefined; if (!artifact) throw new ForgeError("MalformedResponse", "ComfyUI completed without an output artifact"); return ForgeResultSchema.parse({ job_id: promptId, status: "done", artifacts: [{ id: `${this.id}-${promptId}`, uri: artifact.filename ? `${this.options.baseUrl}/view?filename=${encodeURIComponent(String(artifact.filename))}` : `comfy://${promptId}`, kind: "image", mime: "image/png", state: "exploration" }], cost: 0, timing: {}, warnings: [], next_actions: [], provenance: { provider: this.id, request_hash: requestHash(req), ...(typeof req.style_lock === "object" ? { style_lock: { version: req.style_lock.version } } : {}) } }); } await this.options.sleep?.(0); }
    throw new ForgeError("Timeout", "ComfyUI workflow polling timed out");
  }
  async cancel(promptId: string): Promise<void> { await this.call("/interrupt", "POST", { prompt_id: promptId }); }
}

export interface HostedHttpOptions { id: string; endpoint: string; transport: HttpTransport; apiKey?: string; capabilities: ForgeRequest["capability"][]; }
export class HostedHttpAdapter extends AdapterBase {
  readonly id: string; private readonly options: HostedHttpOptions;
  constructor(options: HostedHttpOptions) { super(); this.options = options; this.id = options.id; }
  override describe(): AdapterDescription { return { id: this.id, kind: "hosted", capabilities: this.options.capabilities }; }
  override estimate(_request: ForgeRequest) { return { cost: 0.01, currency: "USD" }; }
  override async run(request: ForgeRequest, options: RunOptions = {}): Promise<ForgeResult> { const req = ForgeRequestSchema.parse(request); throwIfCancelled(options.signal); if (!this.describe().capabilities.includes(req.capability)) throw new ForgeError("NotImplemented", `${this.id} does not implement ${req.capability}`, { retryable: false }); const response = await withTimeout(() => this.options.transport.request({ method: "POST", url: this.options.endpoint, headers: bearer({ "content-type": "application/json" }, this.options.apiKey), body: JSON.stringify({ prompt: req.prompt, input: req.input, capability: req.capability }), ...(options.signal === undefined ? {} : { signal: options.signal }) }), options, `${this.id} request timed out`); if (response.status < 200 || response.status >= 300) throw mapHttpError(this.id, response.status, response.body); return result(req, this.id, responseJson(response)); }
}
