import type { ZodTypeAny } from "zod";

/** The draft used by the checked-in Core API schema documents. */
export const JSON_SCHEMA_DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonSchema = { [key: string]: JsonValue };

export type JsonSchemaOverride = (base: JsonSchema) => JsonSchema;

export interface ZodJsonSchemaOptions {
  /**
   * Zod 3 refinements are arbitrary functions and have no inspectable JSON
   * Schema equivalent. Callers must explicitly allow each one and provide an
   * override when the contract has a faithful JSON Schema representation.
   */
  readonly allowRefinements?: ReadonlySet<ZodTypeAny>;
  readonly overrides?: ReadonlyMap<ZodTypeAny, JsonSchemaOverride>;
}

type ZodDefinition = Record<string, unknown>;

function definitionOf(schema: ZodTypeAny): ZodDefinition {
  const definition = (schema as unknown as { _def?: unknown })._def;
  if (definition === null || typeof definition !== "object" || Array.isArray(definition)) {
    throw new Error("Cannot convert a Zod schema without a valid _def");
  }
  return definition as ZodDefinition;
}

function typeNameOf(definition: ZodDefinition): string {
  const typeName = definition.typeName;
  if (typeof typeName !== "string") throw new Error("Cannot convert an unnamed Zod schema");
  return typeName;
}

function schemaValue(value: unknown, path: string): ZodTypeAny {
  if (value === null || typeof value !== "object") {
    throw new Error(`Expected a Zod schema at ${path}`);
  }
  const candidate = value as { _def?: unknown };
  if (candidate._def === undefined) throw new Error(`Expected a Zod schema at ${path}`);
  return value as ZodTypeAny;
}

function recordValue(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected an object at ${path}`);
  }
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`Expected an array at ${path}`);
  return value;
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== "string") throw new Error(`Expected a string at ${path}`);
  return value;
}

function numberValue(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Expected a finite number at ${path}`);
  }
  return value;
}

function propertyIsOptional(schema: ZodTypeAny): boolean {
  const typeName = typeNameOf(definitionOf(schema));
  return typeName === "ZodOptional" || typeName === "ZodDefault" || typeName === "ZodCatch";
}

function pathText(path: readonly string[]): string {
  return path.length === 0 ? "<root>" : path.join(".");
}

function withDescription(schema: ZodTypeAny, result: JsonSchema): JsonSchema {
  const description = definitionOf(schema).description;
  return typeof description === "string" ? { ...result, description } : result;
}

function stringSchema(schema: ZodTypeAny, path: readonly string[]): JsonSchema {
  const result: JsonSchema = { type: "string" };
  const checks = arrayValue(definitionOf(schema).checks ?? [], `${pathText(path)}.checks`);
  for (const [index, rawCheck] of checks.entries()) {
    const check = recordValue(rawCheck, `${pathText(path)}.checks[${index}]`);
    const kind = stringValue(check.kind, `${pathText(path)}.checks[${index}].kind`);
    switch (kind) {
      case "min":
        result.minLength = numberValue(check.value, `${pathText(path)}.checks[${index}].value`);
        break;
      case "max":
        result.maxLength = numberValue(check.value, `${pathText(path)}.checks[${index}].value`);
        break;
      case "length": {
        const length = numberValue(check.value, `${pathText(path)}.checks[${index}].value`);
        result.minLength = length;
        result.maxLength = length;
        break;
      }
      case "email":
        result.format = "email";
        break;
      case "url":
        result.format = "uri";
        break;
      case "uuid":
        result.format = "uuid";
        break;
      case "regex": {
        const regex = check.regex;
        if (!(regex instanceof RegExp)) {
          throw new Error(`Unsupported regex check at ${pathText(path)}.checks[${index}]`);
        }
        result.pattern = regex.source;
        break;
      }
      case "datetime": {
        if (check.offset !== true || check.local !== false || check.precision !== null) {
          throw new Error(`Unsupported datetime options at ${pathText(path)}.checks[${index}]`);
        }
        result.format = "date-time";
        break;
      }
      default:
        throw new Error(`Unsupported Zod string check ${kind} at ${pathText(path)}`);
    }
  }
  return withDescription(schema, result);
}

function numberSchema(schema: ZodTypeAny, path: readonly string[]): JsonSchema {
  const result: JsonSchema = { type: "number" };
  const checks = arrayValue(definitionOf(schema).checks ?? [], `${pathText(path)}.checks`);
  for (const [index, rawCheck] of checks.entries()) {
    const check = recordValue(rawCheck, `${pathText(path)}.checks[${index}]`);
    const kind = stringValue(check.kind, `${pathText(path)}.checks[${index}].kind`);
    switch (kind) {
      case "finite":
        // JSON numbers cannot encode NaN or Infinity, so this Zod check is
        // already implied by the JSON Schema number type.
        break;
      case "int":
        result.type = "integer";
        break;
      case "min": {
        const value = numberValue(check.value, `${pathText(path)}.checks[${index}].value`);
        result[check.inclusive === false ? "exclusiveMinimum" : "minimum"] = value;
        break;
      }
      case "max": {
        const value = numberValue(check.value, `${pathText(path)}.checks[${index}].value`);
        result[check.inclusive === false ? "exclusiveMaximum" : "maximum"] = value;
        break;
      }
      case "multipleOf":
        result.multipleOf = numberValue(check.value, `${pathText(path)}.checks[${index}].value`);
        break;
      default:
        throw new Error(`Unsupported Zod number check ${kind} at ${pathText(path)}`);
    }
  }
  return withDescription(schema, result);
}

function objectSchema(
  schema: ZodTypeAny,
  path: readonly string[],
  convert: (schema: ZodTypeAny, path: readonly string[]) => JsonSchema,
): JsonSchema {
  const definition = definitionOf(schema);
  const shapeFactory = definition.shape;
  if (typeof shapeFactory !== "function") throw new Error(`Object schema has no shape at ${pathText(path)}`);
  const shape = recordValue(shapeFactory(), `${pathText(path)}.shape`);
  const properties: JsonSchema = {};
  const required: string[] = [];

  for (const key of Object.keys(shape).sort()) {
    const child = schemaValue(shape[key], `${pathText(path)}.shape.${key}`);
    properties[key] = convert(child, [...path, "properties", key]);
    if (!propertyIsOptional(child)) required.push(key);
  }

  const unknownKeys = definition.unknownKeys;
  let additionalProperties: JsonValue;
  if (unknownKeys === "strict") additionalProperties = false;
  else if (unknownKeys === "passthrough" || unknownKeys === "strip") additionalProperties = true;
  else throw new Error(`Unsupported Zod object unknownKeys at ${pathText(path)}`);

  const catchall = definition.catchall;
  if (catchall !== undefined) {
    const catchallSchema = schemaValue(catchall, `${pathText(path)}.catchall`);
    if (typeNameOf(definitionOf(catchallSchema)) !== "ZodNever") {
      additionalProperties = convert(catchallSchema, [...path, "additionalProperties"]);
    }
  }

  const result: JsonSchema = {
    type: "object",
    properties,
    ...(required.length === 0 ? {} : { required }),
    additionalProperties,
  };
  return withDescription(schema, result);
}

function convertSchema(
  schema: ZodTypeAny,
  path: readonly string[],
  options: ZodJsonSchemaOptions,
): JsonSchema {
  const definition = definitionOf(schema);
  const typeName = typeNameOf(definition);
  let result: JsonSchema;

  switch (typeName) {
    case "ZodString":
      result = stringSchema(schema, path);
      break;
    case "ZodNumber":
      result = numberSchema(schema, path);
      break;
    case "ZodBoolean":
      result = withDescription(schema, { type: "boolean" });
      break;
    case "ZodLiteral": {
      const value = definition.value;
      if (
        value !== null
        && typeof value !== "string"
        && typeof value !== "number"
        && typeof value !== "boolean"
      ) {
        throw new Error(`Unsupported Zod literal at ${pathText(path)}`);
      }
      result = withDescription(schema, { const: value as JsonValue });
      break;
    }
    case "ZodNull":
      result = withDescription(schema, { type: "null" });
      break;
    case "ZodUnknown":
    case "ZodAny":
      result = withDescription(schema, {});
      break;
    case "ZodNever":
      result = withDescription(schema, { not: {} });
      break;
    case "ZodEnum": {
      const values = arrayValue(definition.values, `${pathText(path)}.values`);
      if (
        values.some(
          (value) =>
            value !== null
            && typeof value !== "string"
            && typeof value !== "number"
            && typeof value !== "boolean",
        )
      ) {
        throw new Error(`Unsupported Zod enum value at ${pathText(path)}`);
      }
      result = withDescription(schema, { enum: values as JsonValue[] });
      break;
    }
    case "ZodUnion": {
      const optionsValue = arrayValue(definition.options, `${pathText(path)}.options`);
      result = {
        anyOf: optionsValue.map((option, index) =>
          convertSchema(schemaValue(option, `${pathText(path)}.options[${index}]`), [...path, "anyOf", String(index)], options),
        ),
      };
      break;
    }
    case "ZodObject":
      result = objectSchema(schema, path, (child, childPath) =>
        convertSchema(child, childPath, options));
      break;
    case "ZodRecord": {
      const keySchema = schemaValue(definition.keyType, `${pathText(path)}.keyType`);
      const keyDefinition = definitionOf(keySchema);
      if (typeNameOf(keyDefinition) !== "ZodString") {
        throw new Error(`Only string-keyed Zod records are supported at ${pathText(path)}`);
      }
      const keyChecks = arrayValue(keyDefinition.checks ?? [], `${pathText(path)}.keyType.checks`);
      const valueSchema = schemaValue(definition.valueType, `${pathText(path)}.valueType`);
      result = {
        type: "object",
        ...(keyChecks.length === 0
          ? {}
          : { propertyNames: convertSchema(keySchema, [...path, "propertyNames"], options) }),
        additionalProperties: convertSchema(valueSchema, [...path, "additionalProperties"], options),
      };
      break;
    }
    case "ZodArray": {
      const itemSchema = schemaValue(definition.type, `${pathText(path)}.type`);
      result = {
        type: "array",
        items: convertSchema(itemSchema, [...path, "items"], options),
      };
      const minLength = definition.minLength;
      if (minLength !== null && minLength !== undefined) {
        const min = recordValue(minLength, `${pathText(path)}.minLength`);
        result.minItems = numberValue(min.value, `${pathText(path)}.minLength.value`);
      }
      const maxLength = definition.maxLength;
      if (maxLength !== null && maxLength !== undefined) {
        const max = recordValue(maxLength, `${pathText(path)}.maxLength`);
        result.maxItems = numberValue(max.value, `${pathText(path)}.maxLength.value`);
      }
      const exactLength = definition.exactLength;
      if (exactLength !== null && exactLength !== undefined) {
        const exact = recordValue(exactLength, `${pathText(path)}.exactLength`);
        const length = numberValue(exact.value, `${pathText(path)}.exactLength.value`);
        result.minItems = length;
        result.maxItems = length;
      }
      break;
    }
    case "ZodOptional":
      result = convertSchema(
        schemaValue(definition.innerType, `${pathText(path)}.innerType`),
        [...path, "innerType"],
        options,
      );
      break;
    case "ZodNullable": {
      const inner = convertSchema(
        schemaValue(definition.innerType, `${pathText(path)}.innerType`),
        [...path, "anyOf", "0"],
        options,
      );
      result = { anyOf: [inner, { type: "null" }] };
      break;
    }
    case "ZodEffects": {
      const effect = recordValue(definition.effect, `${pathText(path)}.effect`);
      if (
        effect.type !== "refinement"
        || !options.allowRefinements?.has(schema)
        || options.overrides?.get(schema) === undefined
      ) {
        throw new Error(
          `Zod effect at ${pathText(path)} requires an explicit JSON Schema refinement override`,
        );
      }
      result = convertSchema(
        schemaValue(definition.schema, `${pathText(path)}.schema`),
        [...path, "schema"],
        options,
      );
      break;
    }
    default:
      throw new Error(`Unsupported Zod type ${typeName} at ${pathText(path)}`);
  }

  const override = options.overrides?.get(schema);
  return override === undefined ? result : override(result);
}

/** Convert a supported Zod 3 contract without adding a runtime dependency. */
export function zodToJsonSchema(
  schema: ZodTypeAny,
  options: ZodJsonSchemaOptions = {},
): JsonSchema {
  return convertSchema(schema, ["root"], options);
}

/** Add stable document metadata to one checked-in contract golden. */
export function toJsonSchemaDocument(
  name: string,
  schema: ZodTypeAny,
  options: ZodJsonSchemaOptions = {},
): JsonSchema {
  return {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    $id: `urn:lightphysics:core-api:${name}`,
    title: name,
    ...zodToJsonSchema(schema, options),
  };
}

/** Recursively sort object keys for stable checked-in JSON and comparisons. */
export function sortJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value !== null && typeof value === "object") {
    const sorted: { [key: string]: JsonValue } = {};
    for (const key of Object.keys(value).sort()) {
      const child = value[key];
      if (child === undefined) throw new Error(`Cannot serialize an undefined JSON value at ${key}`);
      sorted[key] = sortJsonValue(child);
    }
    return sorted;
  }
  return value;
}

/** Serialize a JSON value with deterministic key ordering and a final newline. */
export function stringifyJson(value: JsonValue): string {
  return `${JSON.stringify(sortJsonValue(value), null, 2)}\n`;
}
