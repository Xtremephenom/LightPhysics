import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { analyzeAudio, StdioJsonRpcWorker } from "./worker.js";
import { labelFor, MOCK_HARDWARE_PROFILES, WarmModelScheduler, normalizeResourceRequest, toGovernorResourceRequest } from "./hardware.js";
import { SpendController } from "./spend.js";
import { measuredPerception, withAiDescription, completeTextSummary, contactSheetDescriptors } from "./perception.js";
import { injectStyleLock } from "./style-lock.js";
import { acquireModel, validateAcquisitionUrl } from "./acquisition.js";
import { QualificationHarness, runQualification } from "./qualification.js";
import { MockAdapter } from "./mock-adapter.js";

describe("Forge domain primitives", () => {
  it("runs the JSON-RPC seam and deterministic audio reference worker", async () => {
    const lines: string[] = []; let listener = (_line: string) => {};
    const worker = new StdioJsonRpcWorker({ start() {}, write: async (line) => { lines.push(line); const message = JSON.parse(line); listener(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { ok: true } })); }, onLine: (next) => { listener = next; } });
    await expect(worker.request("health")).resolves.toEqual({ ok: true }); expect(lines[0]).toContain('"method":"health"');
    expect(analyzeAudio({ samples: [0, 0.5, -0.5, 0], sampleRate: 2 })).toEqual({ peak: 0.5, lufs: -9.7219, silence_ratio: 0.5, duration_s: 2, loop_seam_score: 1 });
  });
  it("labels hardware and enforces one heavy warm model", () => {
    expect(labelFor(MOCK_HARDWARE_PROFILES.reference_4gb, { vram_peak_mb: 5000, ram_peak_mb: 100, exclusive: true })).toBe("needs_stronger"); const scheduler = new WarmModelScheduler(1); expect(scheduler.schedule("a").evicted).toEqual([]); expect(scheduler.schedule("b").evicted).toEqual(["a"]); expect(scheduler.snapshot()).toEqual(["b"]);
  });
  it("normalizes Forge resource aliases to Governor-compatible fields", () => {
    expect(toGovernorResourceRequest({ vramPeakMb: 1024, ram_peak_mb: 2048, disk_mb: 4096, exclusive: true })).toEqual({ vramMb: 1024, ramMb: 2048, diskMb: 4096, exclusive: true });
    expect(() => normalizeResourceRequest({ vramMb: 1, vram_peak_mb: 2, ramMb: 1 })).toThrow(/aliases conflict/);
  });
  it("applies spend confirmation, caps, actuals and breaker", () => {
    const spend = new SpendController({ confirm_threshold: 1, daily_cap: 2 }); const estimate = spend.estimate(1.5, "p"); expect(estimate.requires_confirmation).toBe(true); spend.confirm(estimate); spend.confirm(estimate); expect(spend.snapshot().reserved).toEqual({ [estimate.id]: 1.5 }); expect(() => spend.confirm(spend.estimate(1, "p"))).toThrowError(/cap/); spend.recordActual({ amount: 1.5, currency: "USD" }, "p"); expect(() => spend.confirm(spend.estimate(1, "p"))).toThrowError(/circuit/);
  });
  it("separates measured and AI-described perception and injects style provenance", () => {
    const p = withAiDescription(measuredPerception({ peak: 0.5 }), { summary: "red square" }); expect(p.measured.peak).toBe(0.5); expect(p.ai_described?.summary).toBe("red square"); expect(completeTextSummary({ capability: "image.generate", artifacts: [{ id: "a", perception: p }] })).toContain("AI-described (not measured)"); const request = injectStyleLock({ capability: "image.generate", prompt: "square" }, { version: "v2", palette: ["red"], negatives: ["text"] }); expect(request.style_lock).toMatchObject({ version: "v2" }); expect(request.negative).toContain("text");
  });
  it("creates deterministic contact-sheet labels and fallback summaries", () => {
    expect(contactSheetDescriptors([{ id: "first", preview: "bright square" }, { id: "second" }, { id: "third", preview: "blue circle" }])).toEqual([
      { label: "A", artifact_id: "first", summary: "bright square" },
      { label: "B", artifact_id: "second", summary: "No AI description available" },
      { label: "C", artifact_id: "third", summary: "blue circle" },
    ]);
  });
  it("refuses pickle, checks disk and supports ranged fixture downloads", async () => {
    const bytes = new TextEncoder().encode("fixture-model"); const hash = createHash("sha256").update(bytes).digest("hex"); const calls: unknown[] = []; const result = await acquireModel({ url: "fixture", filename: "model.gguf", expectedSha256: hash, diskFreeBytes: 100, expectedBytes: bytes.byteLength, consent: true, chunkBytes: 4, transport: { get: async (_url, range) => { calls.push(range); const start = range?.start ?? 0; const end = Math.min(bytes.length, (range?.end ?? bytes.length - 1) + 1); return { status: start ? 206 : 200, body: bytes.slice(start, end) }; } } }); expect(result.sha256).toBe(hash); expect(calls.length).toBeGreaterThan(1); await expect(acquireModel({ url: "x", filename: "bad.ckpt", expectedSha256: hash, diskFreeBytes: 100, expectedBytes: bytes.length, consent: true, transport: { get: async () => ({ status: 200, body: bytes }) } })).rejects.toMatchObject({ code: "ValidationError" });
    expect(validateAcquisitionUrl("https://models.example/model.gguf")).toBe("https://models.example/model.gguf"); expect(() => validateAcquisitionUrl("file:///secret/model.gguf")).toThrow(/http/); await expect(acquireModel({ url: "fixture", filename: "model.gguf", expectedSha256: hash, diskFreeBytes: 100, expectedBytes: bytes.length, consent: true, chunkBytes: 4, transport: { get: async () => ({ status: 200, body: new Uint8Array(bytes.length + 1) }) } })).rejects.toMatchObject({ code: "ProviderError" }); await expect(acquireModel({ url: "fixture", filename: "model.gguf", expectedSha256: "bad", diskFreeBytes: 100, expectedBytes: bytes.length, consent: true, transport: { get: async () => ({ status: 200, body: bytes }) } })).rejects.toMatchObject({ code: "ValidationError" });
  });
  it("rejects acquisition during disk preflight before downloading", async () => {
    let downloads = 0;
    const bytes = new TextEncoder().encode("fixture-model");
    const hash = createHash("sha256").update(bytes).digest("hex");

    await expect(acquireModel({ url: "fixture", filename: "model.gguf", expectedSha256: hash, diskFreeBytes: bytes.byteLength - 1, expectedBytes: bytes.byteLength, consent: true, transport: { get: async () => { downloads += 1; return { status: 200, body: bytes }; } } })).rejects.toMatchObject({ code: "DiskInsufficient" });
    expect(downloads).toBe(0);
  });
  it("emits the license text SHA-256 alongside the model checksum", async () => {
    const bytes = new TextEncoder().encode("fixture-model");
    const licenseText = "Fixture license text";
    const result = await acquireModel({ url: "fixture", filename: "model.gguf", expectedSha256: createHash("sha256").update(bytes).digest("hex"), diskFreeBytes: bytes.byteLength, expectedBytes: bytes.byteLength, consent: true, licenseText, transport: { get: async () => ({ status: 200, body: bytes }) } });

    expect(result.license_text_sha256).toBe(createHash("sha256").update(licenseText).digest("hex"));
  });
  it("does not claim qualification without an owner machine and passing checks", async () => {
    const adapter = new MockAdapter(); await expect(runQualification(adapter)).resolves.toMatchObject({ status: "NOT_RUN" }); await expect(new QualificationHarness().run(adapter, [async () => ({ name: "health", passed: true })])).resolves.toMatchObject({ status: "UNQUALIFIED" }); await expect(new QualificationHarness("owner-machine").run(adapter, [async () => ({ name: "health", passed: true })])).resolves.toMatchObject({ status: "QUALIFIED" });
  });
});
