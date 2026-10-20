import { ForgeJsonValueSchema, FORGE_SCHEMA_REGISTRY, type ForgeSchemaName } from "./forge.ts";
import {
  type JsonSchema,
  type JsonSchemaOverride,
  type JsonValue,
  stringifyJson,
  toJsonSchemaDocument,
} from "./json-schema.ts";
import type { ZodTypeAny } from "zod";

/** Forge has its own file so consumers can load the creative surface alone. */
export const FORGE_API_JSON_SCHEMA_GOLDEN_FORMAT = "lightphysics.forge-api-json-schema-golden";
export const FORGE_API_JSON_SCHEMA_GOLDEN_VERSION = 1;
export type ForgeApiJsonSchemas = Record<ForgeSchemaName, JsonSchema>;
export interface ForgeApiJsonSchemaGolden {
  readonly format: typeof FORGE_API_JSON_SCHEMA_GOLDEN_FORMAT;
  readonly version: typeof FORGE_API_JSON_SCHEMA_GOLDEN_VERSION;
  readonly schemas: ForgeApiJsonSchemas;
}

export const FORGE_SCHEMA_NAMES = Object.keys(FORGE_SCHEMA_REGISTRY).sort() as ForgeSchemaName[];
const forgeJsonValueOverride: JsonSchemaOverride = (base) => ({
  ...base,
  "x-lightphysics-json-bounds": {
    maxBytes: 64 * 1024,
    maxDepth: 16,
    maxItems: 256,
    rejectsSecretLikeKeysAndValues: true,
  },
});
const overrides = new Map<ZodTypeAny, JsonSchemaOverride>([[ForgeJsonValueSchema, forgeJsonValueOverride]]);
const allowedRefinements = new Set<ZodTypeAny>([ForgeJsonValueSchema]);

export function generateForgeApiJsonSchemas(): ForgeApiJsonSchemas {
  const schemas = {} as ForgeApiJsonSchemas;
  for (const name of FORGE_SCHEMA_NAMES) {
    schemas[name] = toJsonSchemaDocument(name, FORGE_SCHEMA_REGISTRY[name], {
      allowRefinements: allowedRefinements,
      overrides,
    });
    schemas[name].$id = `urn:lightphysics:forge-api:${name}`;
  }
  return schemas;
}

export function generateForgeApiJsonSchemaGolden(): ForgeApiJsonSchemaGolden {
  return {
    format: FORGE_API_JSON_SCHEMA_GOLDEN_FORMAT,
    version: FORGE_API_JSON_SCHEMA_GOLDEN_VERSION,
    schemas: generateForgeApiJsonSchemas(),
  };
}

export function stringifyForgeApiJsonSchemaGolden(
  golden: ForgeApiJsonSchemaGolden = generateForgeApiJsonSchemaGolden(),
): string {
  return stringifyJson(golden as unknown as JsonValue);
}
