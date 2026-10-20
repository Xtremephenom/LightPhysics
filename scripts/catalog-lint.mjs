#!/usr/bin/env node

/**
 * Offline, dependency-free validator for the Phase 2 catalog.
 *
 * The catalog deliberately uses JSON rather than YAML. Keeping parsing here
 * bounded and deterministic means the check can run in a fresh clone with no
 * network and no package install beyond the repository's pinned Node runtime.
 */
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CATALOG = path.join(root, "catalog");
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 512;
const MAX_DEPTH = 12;
const MAX_KEYS = 128;
const MAX_STRING = 8 * 1024;
const MAX_ARRAY = 256;

const CAPABILITIES = new Set([
  "reason.plan", "reason.code", "vision.inspect", "vision.ocr", "vision.detect",
  "embed.text", "embed.image", "image.generate", "image.edit", "image.inpaint",
  "image.outpaint", "image.variation", "image.upscale", "image.restore", "image.bgremove",
  "image.segment", "image.depth_normal", "texture.seamless", "texture.pbr",
  "model3d.from_text", "model3d.from_image", "model3d.refine", "model3d.retopo",
  "model3d.uv_bake", "rig.auto", "anim.generate", "anim.retarget", "anim.from_video",
  "audio.sfx", "audio.ambience", "audio.separate_stems", "music.generate", "music.extend_loop",
  "speech.tts", "speech.clone(restricted)", "speech.stt", "lipsync.visemes", "video.generate",
  "video.process", "asset.search",
]);
const KINDS = ["providers", "models", "workflows", "pricing"];
const STATUSES = new Set(["QUALIFIED", "UNQUALIFIED", "NOT_RUN", "FAILED"]);
const HARDWARE_LABELS = new Set(["green", "yellow", "red", "globe"]);
const FIDELITY_TIERS = ["sketch", "draft", "final"];
const KIND_BY_DIRECTORY = { providers: "provider", models: "model", workflows: "workflow", pricing: "pricing" };
const KNOWN_LICENSES = new Set([
  "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "CC0-1.0", "ISC", "MIT", "MPL-2.0",
]);

function fail(message) {
  throw new Error(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function checkBounded(value, depth = 0, location = "record") {
  if (depth > MAX_DEPTH) fail(`${location}: nesting exceeds ${MAX_DEPTH}`);
  if (typeof value === "string") {
    if (value.length > MAX_STRING) fail(`${location}: string exceeds ${MAX_STRING} characters`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY) fail(`${location}: array exceeds ${MAX_ARRAY} items`);
    value.forEach((item, index) => checkBounded(item, depth + 1, `${location}[${index}]`));
    return;
  }
  if (isRecord(value)) {
    const keys = Object.keys(value);
    if (keys.length > MAX_KEYS) fail(`${location}: object exceeds ${MAX_KEYS} keys`);
    for (const key of keys) checkBounded(value[key], depth + 1, `${location}.${key}`);
  }
}

function parseArgs(argv) {
  let catalog = DEFAULT_CATALOG;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") json = true;
    else if (arg === "--catalog") {
      catalog = argv[index + 1];
      if (!catalog) fail("--catalog requires a directory");
      index += 1;
    } else fail(`unknown argument: ${arg}`);
  }
  return { catalog: path.resolve(catalog), json };
}

async function collectFiles(directory, relative = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const full = path.join(directory, entry.name);
    const rel = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) fail(`${rel}: symbolic links are not allowed`);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(full, rel));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push({ full, relative: rel });
    } else if (entry.isFile() && !entry.name.endsWith(".md")) {
      fail(`${rel}: catalog files must be JSON (README.md is the only non-JSON file allowed)`);
    }
  }
  return files;
}

function validDate(value, location) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    fail(`${location}: expected an ISO date (YYYY-MM-DD)`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    fail(`${location}: invalid ISO date`);
  }
}

function validLedger(value, location) {
  if (typeof value !== "string" || !/^ledger:[a-z0-9][a-z0-9._:/-]*$/.test(value)) {
    fail(`${location}: expected a catalog ledger id (ledger:...)`);
  }
}

function requireText(record, key, location) {
  if (typeof record[key] !== "string" || record[key].trim() === "") fail(`${location}.${key}: required text`);
}

function validateLicense(license, location, warnings) {
  if (!isRecord(license)) fail(`${location}.license: required object`);
  requireText(license, "id", `${location}.license`);
  if (typeof license.commercial_use !== "boolean") {
    fail(`${location}.license.commercial_use: required boolean (unknown licenses must be false)`);
  }
  requireText(license, "source", `${location}.license`);
  validDate(license.verified_at, `${location}.license.verified_at`);
  validLedger(license.ledger_id, `${location}.license.ledger_id`);
  if (!KNOWN_LICENSES.has(license.id)) {
    if (license.commercial_use) fail(`${location}.license.id: unknown license is non-commercial; commercial_use must be false`);
    warnings.push(`${location}: unknown license treated as non-commercial`);
  }
}

function validateCapabilities(capabilities, location) {
  if (!Array.isArray(capabilities) || capabilities.length === 0) fail(`${location}.capabilities: non-empty array required`);
  const seen = new Set();
  for (const capability of capabilities) {
    if (typeof capability !== "string" || !CAPABILITIES.has(capability)) fail(`${location}.capabilities: unknown capability ${String(capability)}`);
    if (seen.has(capability)) fail(`${location}.capabilities: duplicate ${capability}`);
    seen.add(capability);
  }
  return seen;
}

function validateHardware(hardware, location) {
  if (!isRecord(hardware)) fail(`${location}.hardware: required object`);
  for (const key of ["vram_gb_min", "ram_gb_min", "disk_gb"]) {
    if (typeof hardware[key] !== "number" || !Number.isFinite(hardware[key]) || hardware[key] < 0 || hardware[key] > 1024) {
      fail(`${location}.hardware.${key}: expected bounded non-negative number`);
    }
  }
  if (!HARDWARE_LABELS.has(hardware.label_on_ref_hw)) fail(`${location}.hardware.label_on_ref_hw: expected green, yellow, red, or globe`);
  requireText(hardware, "notes", `${location}.hardware`);
}

function validateFidelityMap(fidelity, location) {
  if (!isRecord(fidelity)) fail(`${location}.fidelity_map: required object`);
  for (const tier of FIDELITY_TIERS) {
    const entry = fidelity[tier];
    if (!isRecord(entry) || typeof entry.supported !== "boolean") fail(`${location}.fidelity_map.${tier}: supported boolean required`);
    if (entry.max_dimension !== undefined && (!Number.isInteger(entry.max_dimension) || entry.max_dimension < 1 || entry.max_dimension > 16384)) {
      fail(`${location}.fidelity_map.${tier}.max_dimension: expected bounded positive integer`);
    }
  }
}

function validateQualification(qualification, location) {
  if (!isRecord(qualification)) fail(`${location}.qualification: required object`);
  if (!STATUSES.has(qualification.status)) fail(`${location}.qualification.status: unknown status`);
  requireText(qualification, "machine_profile", `${location}.qualification`);
  validDate(qualification.verified_at, `${location}.qualification.verified_at`);
  validLedger(qualification.ledger_id, `${location}.qualification.ledger_id`);
  requireText(qualification, "scope", `${location}.qualification`);
}

function validateCommon(record, location, warnings) {
  if (!isRecord(record)) fail(`${location}: expected JSON object`);
  if (record.schema_version !== 1) fail(`${location}.schema_version: expected 1`);
  if (typeof record.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(record.id)) fail(`${location}.id: expected lowercase kebab-case id`);
  requireText(record, "display_name", location);
  validateCapabilities(record.capabilities, location);
  validateHardware(record.hardware, location);
  validateLicense(record.license, location, warnings);
  validateFidelityMap(record.fidelity_map, location);
  validateQualification(record.qualification, location);
  validDate(record.verified_at, `${location}.verified_at`);
  validLedger(record.ledger_id, `${location}.ledger_id`);
}

async function lint(catalog) {
  const files = await collectFiles(catalog);
  if (files.length === 0) fail("catalog: no JSON records found");
  if (files.length > MAX_FILES) fail(`catalog: more than ${MAX_FILES} records`);
  let totalBytes = 0;
  const records = [];
  const warnings = [];
  for (const file of files) {
    const stat = await lstat(file.full);
    if (!stat.isFile()) fail(`${file.relative}: expected a regular file`);
    if (stat.size > MAX_FILE_BYTES) fail(`${file.relative}: exceeds ${MAX_FILE_BYTES} bytes`);
    totalBytes += stat.size;
    if (totalBytes > MAX_TOTAL_BYTES) fail(`catalog: aggregate input exceeds ${MAX_TOTAL_BYTES} bytes`);
    let record;
    try {
      record = JSON.parse(await readFile(file.full, "utf8"));
    } catch (error) {
      fail(`${file.relative}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
    }
    checkBounded(record, 0, file.relative);
    const [directory, filename] = file.relative.split(path.sep);
    if (!KINDS.includes(directory)) fail(`${file.relative}: record must be under providers, models, workflows, or pricing`);
    const expectedId = filename.slice(0, -5);
    const location = file.relative.replaceAll(path.sep, "/");
    validateCommon(record, location, warnings);
    if (record.kind !== KIND_BY_DIRECTORY[directory]) fail(`${location}.kind: expected ${KIND_BY_DIRECTORY[directory]}`);
    if (record.id !== expectedId) fail(`${location}.id: must match filename ${expectedId}`);
    if (directory === "models" || directory === "providers") {
      if (typeof record.fixture !== "boolean") fail(`${location}.fixture: required boolean`);
    }
    if (record.kind === "model" && record.qualification.status === "QUALIFIED" && record.fixture !== true) {
      fail(`${location}: only fixture models may be QUALIFIED in this offline catalog`);
    }
    records.push({ record, directory, location });
  }

  const byKind = new Map();
  for (const item of records) {
    const key = `${KIND_BY_DIRECTORY[item.directory]}:${item.record.id}`;
    if (byKind.has(key)) fail(`${item.location}: duplicate record ${key}`);
    byKind.set(key, item.record);
  }
  for (const { record, directory, location } of records) {
    if (directory === "models" || directory === "workflows" || directory === "pricing") {
      if (typeof record.provider !== "string" || !byKind.has(`provider:${record.provider}`)) fail(`${location}.provider: unknown provider`);
      const provider = byKind.get(`provider:${record.provider}`);
      const providerCapabilities = new Set(provider.capabilities);
      for (const capability of record.capabilities) if (!providerCapabilities.has(capability)) fail(`${location}: provider ${record.provider} does not declare ${capability}`);
    }
    if (directory === "workflows" && (typeof record.model !== "string" || !byKind.has(`model:${record.model}`))) fail(`${location}.model: unknown model`);
    if (directory === "pricing" && typeof record.model === "string" && !byKind.has(`model:${record.model}`)) fail(`${location}.model: unknown model`);
    if (directory === "pricing") {
      if (typeof record.unit !== "string" || !record.unit.trim()) fail(`${location}.unit: required text`);
      if (record.currency !== "USD") fail(`${location}.currency: only USD is supported by schema version 1`);
      if (typeof record.amount !== "number" || !Number.isFinite(record.amount) || record.amount < 0 || record.amount > 1_000_000) fail(`${location}.amount: expected bounded non-negative number`);
    }
  }
  return { files: files.length, bytes: totalBytes, warnings };
}

try {
  const options = parseArgs(process.argv.slice(2));
  const result = await lint(options.catalog);
  if (options.json) console.log(JSON.stringify({ ok: true, ...result }));
  else {
    console.log(`catalog-lint: PASS (${result.files} records, ${result.bytes} bytes)`);
    for (const warning of result.warnings) console.log(`catalog-lint: WARNING — ${warning}`);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (process.argv.includes("--json")) console.log(JSON.stringify({ ok: false, error: message }));
  else console.error(`catalog-lint: FAIL — ${message}`);
  process.exitCode = 1;
}
