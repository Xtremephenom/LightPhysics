import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MockAdapter } from "./mock-adapter.js";
import { OpenAICompatibleAdapter, ComfyUIWorkflowAdapter, HostedHttpAdapter, type HttpResponse } from "./http-adapters.js";
import { ForgeError } from "./errors.js";
import { mapHttpError } from "./adapter.js";

const request = { capability: "image.generate" as const, prompt: "fixture" };
function transport(response: HttpResponse) { return { request: async () => response }; }
const recordedOpenAiResponse = readFileSync(new URL("../../../fixtures/forge/openai-compatible-success.json", import.meta.url), "utf8");

describe("Forge adapters", () => {
  it.each(["timeout", "429", "malformed", "policy_refusal", "oom"] as const)("maps mock %s", async (failure) => {
    await expect(new MockAdapter({ failure }).run(request)).rejects.toMatchObject({ code: failure === "429" ? "RateLimit" : failure === "policy_refusal" ? "PolicyRefusal" : failure === "oom" ? "OutOfMemory" : failure === "malformed" ? "MalformedResponse" : "Timeout" });
  });
  it.each([[401, "Authentication"], [404, "ResourceUnavailable"], [408, "Timeout"], [409, "RateLimit"], [413, "OutOfMemory"], [422, "MalformedResponse"], [500, "ProviderError"]] as const)("maps HTTP %s to %s", (status, code) => {
    expect(mapHttpError("fixture", status, status === 413 ? "CUDA out of memory" : "body").code).toBe(code);
  });
  it("sends auth without exposing prompt to adapter metadata", async () => {
    let seen: HttpResponse | undefined;
    const calls: { headers?: Record<string, string>; body?: string }[] = [];
    const adapter = new OpenAICompatibleAdapter({ baseUrl: "http://fixture", apiKey: "secret", transport: { request: async (request) => { calls.push(request); return { status: 200, body: JSON.stringify({ choices: [{ message: { content: "ok" } }] }) }; } } });
    const result = await adapter.run(request); seen = result as unknown as HttpResponse;
    expect(calls[0]?.headers?.authorization).toBe("Bearer secret"); expect(seen).toBeTruthy(); expect(result.provenance).not.toHaveProperty("prompt");
  });
  it("bounds and maps openai responses", async () => {
    await expect(new OpenAICompatibleAdapter({ baseUrl: "x", transport: transport({ status: 200, body: recordedOpenAiResponse }) }).run(request)).resolves.toMatchObject({ status: "done", artifacts: [{ preview: "recorded fixture response" }] });
    await expect(new OpenAICompatibleAdapter({ baseUrl: "x", transport: transport({ status: 200, body: "{" }) }).run(request)).rejects.toMatchObject({ code: "MalformedResponse" });
    await expect(new OpenAICompatibleAdapter({ baseUrl: "x", transport: transport({ status: 429, body: "busy" }) }).run(request)).rejects.toMatchObject({ code: "RateLimit" });
    await expect(new OpenAICompatibleAdapter({ baseUrl: "x", transport: transport({ status: 200, body: {} }) }).run(request)).rejects.toMatchObject({ code: "MalformedResponse" });
  });
  it("honors cancellation and transport timeout", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(new MockAdapter().run(request, { signal: controller.signal })).rejects.toMatchObject({ code: "Cancelled" });
    const slow = new OpenAICompatibleAdapter({ baseUrl: "x", transport: { request: async () => new Promise(() => {}) } });
    await expect(slow.run(request, { timeout_ms: 5 })).rejects.toMatchObject({ code: "Timeout" });
    const during = new AbortController(); const pending = slow.run(request, { signal: during.signal }); during.abort(); await expect(pending).rejects.toMatchObject({ code: "Cancelled" });
  });
  it("runs ComfyUI submit, poll, history output and cancel", async () => {
    const paths: string[] = []; let poll = 0;
    const adapter = new ComfyUIWorkflowAdapter({
      baseUrl: "http://comfy",
      maxPolls: 3,
      transport: {
        request: async (req) => {
          paths.push(req.url);
          if (req.url.endsWith("/prompt")) return { status: 200, body: { prompt_id: "p1" } };
          if (req.url.includes("/history/")) return { status: 200, body: poll++ ? { p1: { completed: true, outputs: { x: [{ filename: "out.png" }] } } } : { p1: {} } };
          return { status: 200, body: {} };
        },
      },
      sleep: async () => {},
    });
    const result = await adapter.run(request); expect(result.artifacts[0]?.uri).toContain("out.png"); expect(paths.some((path) => path.endsWith("/prompt"))).toBe(true); await adapter.cancel("p1"); expect(paths.at(-1)).toContain("interrupt");
  });
  it("fetches ComfyUI output with encoded query parameters", async () => {
    const calls: { method: string; url: string }[] = [];
    const response = { status: 200, body: { image: "fixture" } };
    const adapter = new ComfyUIWorkflowAdapter({
      baseUrl: "http://comfy/",
      transport: { request: async (request) => { calls.push({ method: request.method, url: request.url }); return response; } },
    });

    await expect(adapter.fetch("out image.png", "sub folder", "output")).resolves.toEqual(response.body);
    expect(calls).toEqual([{ method: "GET", url: "http://comfy/view?filename=out%20image.png&subfolder=sub%20folder&type=output" }]);
  });
  it("fails ComfyUI timeout and OOM with typed errors", async () => {
    const timeout = new ComfyUIWorkflowAdapter({ baseUrl: "x", maxPolls: 1, transport: transport({ status: 200, body: { prompt_id: "x" } }), sleep: async () => {} });
    await expect(timeout.run(request)).rejects.toMatchObject({ code: "Timeout" });
    const oom = new ComfyUIWorkflowAdapter({ baseUrl: "x", transport: { request: async (req) => req.url.endsWith("/prompt") ? { status: 200, body: { prompt_id: "x" } } : { status: 200, body: { x: { status: "CUDA out of memory" } } } } });
    await expect(oom.run(request)).rejects.toMatchObject({ code: "OutOfMemory" });
  });
});
