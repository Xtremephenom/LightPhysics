import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ArtifactSchema,
  CapabilityRequestSchemas,
  CapabilityResponseSchemas,
  CostCapsSchema,
  CostEstimateSchema,
  EgressRecordSchema,
  FORGE_CAPABILITY_IDS,
  FORGE_SCHEMA_REGISTRY,
  ForgeCapabilityRequestSchema,
  ForgeJsonValueSchema,
  ForgeProvenanceSchema,
  ForgeResultSchema,
  ModelAcquisitionRequestSchema,
  ModelCatalogRecordSchema,
  StyleLockInjectionMetadataSchema,
} from "./forge.js";
import {
  FORGE_API_JSON_SCHEMA_GOLDEN_FORMAT,
  FORGE_API_JSON_SCHEMA_GOLDEN_VERSION,
  FORGE_SCHEMA_NAMES,
  generateForgeApiJsonSchemaGolden,
  stringifyForgeApiJsonSchemaGolden,
  type ForgeApiJsonSchemaGolden,
} from "./forge-api-goldens.js";

const forgeGoldenPath = new URL("../goldens/forge-api.json", import.meta.url);
const checkedInGolden = JSON.parse(readFileSync(forgeGoldenPath, "utf8")) as ForgeApiJsonSchemaGolden;

const validResult = {
  job_id: "job-1",
  status: "done" as const,
  artifacts: [{
    id: "artifact-1",
    uri: "lp://artifact/artifact-1",
    kind: "image",
    mime: "image/png",
    bytes: 12,
    sha256: "a".repeat(64),
    state: "exploration" as const,
  }],
  timing: {},
  warnings: [],
  next_actions: [],
};

describe("Phase 2 Forge schema contracts", () => {
  it("covers every taxonomy id with a literal request and response contract", () => {
    expect(Object.keys(CapabilityRequestSchemas).sort()).toEqual([...FORGE_CAPABILITY_IDS].sort());
    expect(Object.keys(CapabilityResponseSchemas).sort()).toEqual([...FORGE_CAPABILITY_IDS].sort());
    for (const capability of FORGE_CAPABILITY_IDS) {
      const request = CapabilityRequestSchemas[capability].parse({ capability });
      const response = CapabilityResponseSchemas[capability].parse({ capability, result: validResult });
      expect(request.capability).toBe(capability);
      expect(response.capability).toBe(capability);
      expect(() => CapabilityRequestSchemas[capability].parse({ capability, extra: true })).toThrow();
    }
  });

  it("keeps the result, artifact, catalog, acquisition, cost, hardware, and Style Lock contracts strict", () => {
    expect(ForgeResultSchema.parse(validResult).status).toBe("done");
    expect(() => ArtifactSchema.parse({ ...validResult.artifacts[0], extra: true })).toThrow();
    expect(() => ForgeCapabilityRequestSchema.parse({ capability: "image.generate", unknown: true })).toThrow();
    expect(() => StyleLockInjectionMetadataSchema.parse({ version: "v1", anchors: [], palette: [], shape_rules: [], negatives: [], extra: true })).toThrow();
    expect(() => CostEstimateSchema.parse({ amount: 1, currency: "USD", requires_confirmation: false, day: "2026-10-20", project_id: "p", capability: "image.generate", extra: 1 })).toThrow();
    expect(CostCapsSchema.parse({ confirm_threshold: 1, daily_cap: 5, project_cap: 10, currency: "USD" }).daily_cap).toBe(5);
    expect(() => ModelAcquisitionRequestSchema.parse({ model_id: "m", url: "https://example.test/m.gguf", filename: "m.gguf", expected_sha256: "a".repeat(64), expected_bytes: 1, disk_free_bytes: 2, consent: true })).not.toThrow();
    expect(() => ModelAcquisitionRequestSchema.parse({ model_id: "m", url: "https://example.test/m.ckpt", filename: "m.ckpt", expected_sha256: "a".repeat(64), expected_bytes: 1, disk_free_bytes: 2, consent: true })).toThrow();
    expect(() => ModelCatalogRecordSchema.parse({ id: "m", provider_id: "p", name: "model", version: "v1", capabilities: ["image.generate"], runtime: { kind: "mock" }, hardware: { vram_gb_min: 1, ram_gb_min: 1, disk_gb: 1, label_on_ref_hw: "comfortable" }, license: { id: "unknown", commercial_use: "unknown", restrictions: [] }, fidelity_map: {}, determinism: "unknown", qualification: { status: "UNQUALIFIED", machine_profile: "reference-4gb", verified_at: "2026-01-01T00:00:00.000Z", versions: {} }, cost: {} })).not.toThrow();
  });

  it("bounds JSON and rejects secrets in JSON-bearing fields", () => {
    expect(ForgeJsonValueSchema.parse({ nested: [true, null, "safe"] })).toEqual({ nested: [true, null, "safe"] });
    expect(() => ForgeJsonValueSchema.parse({ api_key: "never" })).toThrow();
    expect(() => ForgeJsonValueSchema.parse("x".repeat(64 * 1024 + 1))).toThrow();
  });

  it("does not permit prompt bodies or secrets in egress and provenance records", () => {
    const egress = { request_hash: "a".repeat(64), provider_id: "provider", capability: "image.generate" as const, at: "2026-01-01T00:00:00.000Z" };
    expect(EgressRecordSchema.parse(egress)).toEqual(egress);
    expect(() => EgressRecordSchema.parse({ ...egress, prompt: "private prompt" })).toThrow();
    expect(() => EgressRecordSchema.parse({ ...egress, token: "secret" })).toThrow();
    const provenance = { provider_id: "provider", model_id: "model", request_hash: "a".repeat(64), started_at: "2026-01-01T00:00:00.000Z" };
    expect(ForgeProvenanceSchema.parse(provenance)).toEqual(provenance);
    expect(() => ForgeProvenanceSchema.parse({ ...provenance, prompt: "private prompt" })).toThrow();
    expect(() => ForgeProvenanceSchema.parse({ ...provenance, authorization: "Bearer secret" })).toThrow();
  });

  it("keeps the Forge golden complete and byte-for-byte reproducible", () => {
    expect(checkedInGolden.format).toBe(FORGE_API_JSON_SCHEMA_GOLDEN_FORMAT);
    expect(checkedInGolden.version).toBe(FORGE_API_JSON_SCHEMA_GOLDEN_VERSION);
    expect(Object.keys(checkedInGolden.schemas).sort()).toEqual(FORGE_SCHEMA_NAMES);
    expect(stringifyForgeApiJsonSchemaGolden(generateForgeApiJsonSchemaGolden())).toBe(stringifyForgeApiJsonSchemaGolden(checkedInGolden));
    for (const name of FORGE_SCHEMA_NAMES) {
      expect(checkedInGolden.schemas[name]).toMatchObject({
        $id: `urn:lightphysics:forge-api:${name}`,
        title: name,
      });
      expect(FORGE_SCHEMA_REGISTRY[name]).toBeDefined();
    }
  });
});
