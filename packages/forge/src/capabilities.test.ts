import { describe, expect, it } from "vitest";
import { CAPABILITY_IDS, CapabilityRequestSchemas, ForgeRequestSchema, ForgeResultSchema } from "./capabilities.js";
import { MockAdapter } from "./mock-adapter.js";

describe("Forge capability contracts", () => {
  it("keeps the complete stable taxonomy and parses every capability", () => {
    expect(CAPABILITY_IDS).toHaveLength(40);
    for (const capability of CAPABILITY_IDS) expect(CapabilityRequestSchemas[capability].parse({ capability })).toEqual({ capability });
    expect(ForgeRequestSchema.safeParse({ capability: "unknown" }).success).toBe(false);
  });
  it("normalizes result shape and rejects an invalid artifact hash", () => {
    expect(ForgeResultSchema.safeParse({ job_id: "j", status: "done", artifacts: [{ id: "a", uri: "x", kind: "image", sha256: "bad" }] }).success).toBe(false);
    expect(ForgeResultSchema.parse({ job_id: "j", status: "done", artifacts: [] }).warnings).toEqual([]);
  });
  it("makes mock success deterministic", async () => {
    const adapter = new MockAdapter({ id: "fixture" });
    const request = { capability: "image.generate" as const, prompt: "a red square" };
    expect(await adapter.run(request)).toEqual(await adapter.run(request));
  });
});
