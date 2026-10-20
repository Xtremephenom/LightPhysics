import { describe, expect, it } from "vitest";
import { MockAdapter } from "./mock-adapter.js";
import { routeRequest } from "./routing.js";
import { HostedHttpAdapter } from "./http-adapters.js";

describe("Forge routing", () => {
  it("falls back in order and records only hash/provider for hosted egress", async () => {
    const hosted = new HostedHttpAdapter({ id: "hosted", endpoint: "fixture", capabilities: ["image.generate"], transport: { request: async () => ({ status: 200, body: { data: [{ url: "fixture://image" }] } }) } });
    const routed = await routeRequest({ capability: "image.generate", prompt: "private" }, [new MockAdapter({ id: "local", failure: "timeout" }), hosted], { data_policy: "hosted_ok" });
    expect(routed.provider).toBe("hosted"); expect(routed.egress).toEqual([{ request_hash: expect.stringMatching(/^[a-f0-9]{64}$/), provider: "hosted" }]); expect(JSON.stringify(routed.egress)).not.toContain("private");
  });
  it("blocks hosted routes under local_only", async () => {
    const hosted = new HostedHttpAdapter({ id: "hosted", endpoint: "fixture", capabilities: ["image.generate"], transport: { request: async () => ({ status: 200, body: {} }) } });
    await expect(routeRequest({ capability: "image.generate" }, [hosted], { data_policy: "local_only" })).rejects.toMatchObject({ code: "ResourceUnavailable" });
  });
  it("rewrites policy refusal once and retries malformed once with stricter request", async () => {
    const policy = new MockAdapter({ id: "policy", failures: ["policy_refusal", "success"] }); const result = await routeRequest({ capability: "image.generate", prompt: "unsafe" }, [policy], { rewritePolicyRefusal: (request) => ({ ...request, prompt: "safe" }) }); expect(result.result.status).toBe("done");
    const malformed = new MockAdapter({ id: "malformed", failures: ["malformed", "success"] }); const strict = await routeRequest({ capability: "image.generate" }, [malformed], { stricterRetry: (request) => ({ ...request, provider_params: { strict_json: true } }) }); expect(strict.result.status).toBe("done");
  });
});
