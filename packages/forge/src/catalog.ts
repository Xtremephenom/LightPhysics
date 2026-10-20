import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { CAPABILITY_IDS, type CapabilityId } from "./capabilities.ts";
import { ForgeError } from "./errors.ts";

const CATALOG_DIRECTORIES = ["providers", "models", "workflows", "pricing"] as const;
const KIND_BY_DIRECTORY = {
  providers: "provider",
  models: "model",
  workflows: "workflow",
  pricing: "pricing",
} as const;
const LICENSES = new Set(["Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "CC0-1.0", "ISC", "MIT", "MPL-2.0"]);
const CAPABILITIES = new Set<string>(CAPABILITY_IDS);
const MAX_FILE_BYTES = 256 * 1024;
const MAX_FILES = 512;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;

export type CatalogDirectory = (typeof CATALOG_DIRECTORIES)[number];
export type CatalogKind = (typeof KIND_BY_DIRECTORY)[CatalogDirectory];

export interface CatalogLicense {
  readonly id: string;
  readonly commercial_use: boolean;
  readonly source: string;
  readonly verified_at: string;
  readonly ledger_id: string;
}

export interface CatalogRecord extends Record<string, unknown> {
  readonly kind: CatalogKind;
  readonly schema_version: 1;
  readonly id: string;
  readonly display_name: string;
  readonly capabilities: readonly CapabilityId[];
  readonly license: CatalogLicense;
  readonly qualification: Readonly<Record<string, unknown>>;
  readonly verified_at: string;
  readonly ledger_id: string;
}

export interface LoadedCatalog {
  readonly root: string;
  readonly records: readonly CatalogRecord[];
  readonly byId: ReadonlyMap<string, CatalogRecord>;
  readonly bytes: number;
}

export class CatalogError extends ForgeError {
  constructor(message: string, details?: unknown) {
    super("ValidationError", message, { retryable: false, details });
    this.name = "CatalogError";
  }
}

function record(value: unknown, location: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CatalogError(`${location}: expected a JSON object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, location: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 8_192) {
    throw new CatalogError(`${location}: expected bounded non-empty text`);
  }
  return value;
}

function date(value: unknown, location: string): string {
  const candidate = text(value, location);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate) || Number.isNaN(Date.parse(`${candidate}T00:00:00Z`))) {
    throw new CatalogError(`${location}: expected an ISO date`);
  }
  return candidate;
}

function ledgerId(value: unknown, location: string): string {
  const candidate = text(value, location);
  if (!/^ledger:[a-z0-9][a-z0-9._:/-]*$/.test(candidate)) {
    throw new CatalogError(`${location}: expected a catalog ledger id`);
  }
  return candidate;
}

function capabilities(value: unknown, location: string): CapabilityId[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > CAPABILITY_IDS.length) {
    throw new CatalogError(`${location}: expected a non-empty capability list`);
  }
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !CAPABILITIES.has(item) || seen.has(item)) {
      throw new CatalogError(`${location}: unknown or duplicate capability`);
    }
    seen.add(item);
  }
  return [...seen] as CapabilityId[];
}

function license(value: unknown, location: string): CatalogLicense {
  const input = record(value, `${location}.license`);
  const id = text(input.id, `${location}.license.id`);
  const commercialUse = input.commercial_use;
  if (typeof commercialUse !== "boolean") {
    throw new CatalogError(`${location}.license.commercial_use: expected boolean`);
  }
  if (!LICENSES.has(id) && commercialUse) {
    throw new CatalogError(`${location}: unknown licenses are non-commercial until verified`);
  }
  return {
    id,
    commercial_use: commercialUse,
    source: text(input.source, `${location}.license.source`),
    verified_at: date(input.verified_at, `${location}.license.verified_at`),
    ledger_id: ledgerId(input.ledger_id, `${location}.license.ledger_id`),
  };
}

function validateRecord(value: unknown, directory: CatalogDirectory, expectedId: string, location: string): CatalogRecord {
  const input = record(value, location);
  if (input.schema_version !== 1) throw new CatalogError(`${location}.schema_version: expected 1`);
  const id = text(input.id, `${location}.id`);
  if (id !== expectedId || !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new CatalogError(`${location}.id: must match its lowercase kebab-case filename`);
  }
  const kind = KIND_BY_DIRECTORY[directory];
  if (input.kind !== kind) throw new CatalogError(`${location}.kind: expected ${kind}`);
  const recordValue = {
    ...input,
    kind,
    schema_version: 1 as const,
    id,
    display_name: text(input.display_name, `${location}.display_name`),
    capabilities: capabilities(input.capabilities, `${location}.capabilities`),
    license: license(input.license, location),
    qualification: record(input.qualification, `${location}.qualification`),
    verified_at: date(input.verified_at, `${location}.verified_at`),
    ledger_id: ledgerId(input.ledger_id, `${location}.ledger_id`),
  };
  if (directory === "models" && recordValue.qualification.status === "QUALIFIED" && input.fixture !== true) {
    throw new CatalogError(`${location}: only fixture models may be qualified offline`);
  }
  return recordValue as CatalogRecord;
}

async function jsonFiles(root: string, directory: CatalogDirectory): Promise<readonly { file: string; id: string }[]> {
  const directoryPath = path.join(root, directory);
  let entries;
  try {
    entries = await readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
    if (code === "ENOENT") return [];
    throw new CatalogError(`${directory}: could not be read`);
  }
  const files: { file: string; id: string }[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink()) throw new CatalogError(`${directory}/${entry.name}: symbolic links are not allowed`);
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const id = entry.name.slice(0, -5);
    files.push({ file: path.join(directoryPath, entry.name), id });
  }
  return files;
}

/** Load the bounded, JSON-only catalog without following user-selected paths. */
export async function loadCatalog(root: string): Promise<LoadedCatalog> {
  const resolvedRoot = path.resolve(root);
  const records: CatalogRecord[] = [];
  const byId = new Map<string, CatalogRecord>();
  let bytes = 0;
  let files = 0;
  for (const directory of CATALOG_DIRECTORIES) {
    for (const entry of await jsonFiles(resolvedRoot, directory)) {
      files += 1;
      if (files > MAX_FILES) throw new CatalogError(`catalog exceeds ${MAX_FILES} records`);
      const stat = await lstat(entry.file);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new CatalogError(`${directory}/${entry.id}.json exceeds catalog bounds`);
      bytes += stat.size;
      if (bytes > MAX_TOTAL_BYTES) throw new CatalogError(`catalog exceeds ${MAX_TOTAL_BYTES} bytes`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(entry.file, "utf8")) as unknown;
      } catch {
        throw new CatalogError(`${directory}/${entry.id}.json is not valid JSON`);
      }
      const item = validateRecord(parsed, directory, entry.id, `${directory}/${entry.id}.json`);
      const key = `${item.kind}:${item.id}`;
      if (byId.has(key)) throw new CatalogError(`duplicate catalog record ${key}`);
      byId.set(key, item);
      records.push(item);
    }
  }
  for (const item of records) {
    const providerId = typeof item.provider === "string" ? item.provider : undefined;
    if (providerId !== undefined && !byId.has(`provider:${providerId}`)) {
      throw new CatalogError(`${item.id}: unknown provider ${providerId}`);
    }
    if (item.kind === "workflow" && typeof item.model === "string" && !byId.has(`model:${item.model}`)) {
      throw new CatalogError(`${item.id}: unknown model ${item.model}`);
    }
  }
  return { root: resolvedRoot, records, byId, bytes };
}
