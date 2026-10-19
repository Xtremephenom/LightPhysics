import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CORE_API_JSON_SCHEMA_GOLDEN_FORMAT,
  CORE_API_JSON_SCHEMA_GOLDEN_VERSION,
  CORE_API_SCHEMA_NAMES,
  generateCoreApiJsonSchemaGolden,
  stringifyCoreApiJsonSchemaGolden,
  type CoreApiJsonSchemaGolden,
} from "./core-api-goldens.js";
import {
  JSON_SCHEMA_DRAFT_2020_12,
  zodToJsonSchema,
} from "./json-schema.js";
import { SystemPingResultSchema } from "./index.js";

const goldenPath = new URL("../goldens/core-api.json", import.meta.url);
const checkedInGolden = JSON.parse(readFileSync(goldenPath, "utf8")) as CoreApiJsonSchemaGolden;

describe("Core API JSON-Schema goldens", () => {
  it("has exactly one checked-in document for every registered contract", () => {
    expect(checkedInGolden.format).toBe(CORE_API_JSON_SCHEMA_GOLDEN_FORMAT);
    expect(checkedInGolden.version).toBe(CORE_API_JSON_SCHEMA_GOLDEN_VERSION);
    expect(Object.keys(checkedInGolden.schemas).sort()).toEqual(CORE_API_SCHEMA_NAMES);

    for (const name of CORE_API_SCHEMA_NAMES) {
      const schema = checkedInGolden.schemas[name];
      expect(schema).toMatchObject({
        $id: `urn:lightphysics:core-api:${name}`,
        $schema: JSON_SCHEMA_DRAFT_2020_12,
        title: name,
      });
    }
  });

  it("regenerates byte-for-byte and rejects source-contract drift", () => {
    const generated = generateCoreApiJsonSchemaGolden();
    expect(stringifyCoreApiJsonSchemaGolden(generated)).toBe(
      stringifyCoreApiJsonSchemaGolden(checkedInGolden),
    );
    expect(stringifyCoreApiJsonSchemaGolden()).toBe(stringifyCoreApiJsonSchemaGolden(generated));

    const changed = structuredClone(checkedInGolden) as CoreApiJsonSchemaGolden;
    const context = changed.schemas.CallContextSchema;
    const properties = context.properties as Record<string, Record<string, unknown>>;
    expect(properties.trace_id).toBeDefined();
    properties.trace_id!.minLength = 2;
    expect(stringifyCoreApiJsonSchemaGolden(changed)).not.toBe(
      stringifyCoreApiJsonSchemaGolden(generated),
    );
  });

  it("captures strict envelopes, method literals, and the ping refinement", () => {
    const generated = generateCoreApiJsonSchemaGolden().schemas;
    expect(generated.CallContextSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["session_id", "trace_id"],
    });
    expect(generated.JsonRpcErrorResponseSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
    expect(generated.SystemPingRequestSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
    expect(
      (generated.SystemPingRequestSchema.properties as Record<string, unknown>).method,
    ).toEqual({ const: "system.ping" });
    expect(
      (generated.SystemInfoRequestSchema.properties as Record<string, unknown>).method,
    ).toEqual({ const: "system.info" });
    expect(generated.SystemPingResultSchema.anyOf).toEqual([
      { required: ["ok"] },
      { required: ["pong"] },
    ]);
  });

  it("keeps the runtime ping refinement aligned with its JSON-Schema overlay", () => {
    expect(SystemPingResultSchema.safeParse({ status: "up" }).success).toBe(false);
    expect(SystemPingResultSchema.safeParse({ ok: true }).success).toBe(true);
    expect(SystemPingResultSchema.safeParse({ pong: true }).success).toBe(true);
    expect(SystemPingResultSchema.safeParse({ ok: false }).success).toBe(false);
  });

  it("requires explicit handling for a Zod refinement when no overlay is supplied", () => {
    expect(() => zodToJsonSchema(SystemPingResultSchema)).toThrow(
      "requires an explicit JSON Schema refinement override",
    );
  });
});
