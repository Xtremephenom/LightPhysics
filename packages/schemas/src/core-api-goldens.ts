import {
  CORE_API_SCHEMA_REGISTRY,
  CoreJsonValueSchema,
  SystemPingResultSchema,
  type CoreApiSchemaName,
} from "./index.ts";
import { ForgeJsonValueSchema } from "./forge.ts";
import {
  type JsonSchema,
  type JsonSchemaOverride,
  type JsonValue,
  stringifyJson,
  toJsonSchemaDocument,
} from "./json-schema.ts";
import type { ZodTypeAny } from "zod";

export const CORE_API_JSON_SCHEMA_GOLDEN_FORMAT = "lightphysics.core-api-json-schema-golden";
export const CORE_API_JSON_SCHEMA_GOLDEN_VERSION = 1;

export type CoreApiJsonSchemas = Record<CoreApiSchemaName, JsonSchema>;

export interface CoreApiJsonSchemaGolden {
  readonly format: typeof CORE_API_JSON_SCHEMA_GOLDEN_FORMAT;
  readonly version: typeof CORE_API_JSON_SCHEMA_GOLDEN_VERSION;
  readonly schemas: CoreApiJsonSchemas;
}

/** Keep the golden inventory sorted and tied to the public registry. */
export const CORE_API_SCHEMA_NAMES = Object.keys(CORE_API_SCHEMA_REGISTRY).sort() as CoreApiSchemaName[];

/**
 * The source contract has an arbitrary Zod refinement requiring `ok` or
 * `pong`. JSON Schema can represent this particular predicate exactly, but it
 * cannot introspect arbitrary Zod refinement functions, so the overlay is
 * explicit and identity-bound to this schema.
 */
const systemPingResultOverride: JsonSchemaOverride = (base) => {
  if (base.type !== "object") {
    throw new Error("SystemPingResultSchema must remain an object contract");
  }
  return {
    ...base,
    anyOf: [{ required: ["ok"] }, { required: ["pong"] }],
  };
};

/** JSON Schema has no portable assertion for recursive byte/depth bounds. */
const coreJsonValueOverride: JsonSchemaOverride = (base) => ({
  ...base,
  "x-lightphysics-json-bounds": {
    maxBytes: 64 * 1024,
    maxDepth: 24,
    maxItems: 1_024,
    rejectsSecretLikeKeysAndValues: true,
  },
});

/** Forge uses the same bounded JSON rules at its provider/constraint boundary. */
const forgeJsonValueOverride: JsonSchemaOverride = (base) => ({
  ...base,
  "x-lightphysics-json-bounds": {
    maxBytes: 64 * 1024,
    maxDepth: 16,
    maxItems: 256,
    rejectsSecretLikeKeysAndValues: true,
  },
});

const overrides = new Map<ZodTypeAny, JsonSchemaOverride>([
  [SystemPingResultSchema, systemPingResultOverride],
  [CoreJsonValueSchema, coreJsonValueOverride],
  [ForgeJsonValueSchema, forgeJsonValueOverride],
]);
const allowedRefinements = new Set([SystemPingResultSchema, CoreJsonValueSchema, ForgeJsonValueSchema]);

/** Generate every Core API JSON-Schema document from its Zod 3 contract. */
export function generateCoreApiJsonSchemas(): CoreApiJsonSchemas {
  const schemas = {} as CoreApiJsonSchemas;
  for (const name of CORE_API_SCHEMA_NAMES) {
    schemas[name] = toJsonSchemaDocument(name, CORE_API_SCHEMA_REGISTRY[name], {
      allowRefinements: allowedRefinements,
      overrides,
    });
  }
  return schemas;
}

/** Generate the complete checked-in golden document. */
export function generateCoreApiJsonSchemaGolden(): CoreApiJsonSchemaGolden {
  return {
    format: CORE_API_JSON_SCHEMA_GOLDEN_FORMAT,
    version: CORE_API_JSON_SCHEMA_GOLDEN_VERSION,
    schemas: generateCoreApiJsonSchemas(),
  };
}

/** Stable serialization used by the writer and by drift-detection tests. */
export function stringifyCoreApiJsonSchemaGolden(
  golden: CoreApiJsonSchemaGolden = generateCoreApiJsonSchemaGolden(),
): string {
  return stringifyJson(golden as unknown as JsonValue);
}
