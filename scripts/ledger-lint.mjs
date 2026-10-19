#!/usr/bin/env node
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entriesDirectory = path.join(root, "docs", "research", "entries");
const ledgerPath = path.join(root, "docs", "research", "LEDGER.md");
const allowedStatuses = new Set(["VERIFIED", "ASSUMED", "UNKNOWN", "DISPROVED"]);
const allowedGrades = new Set(["primary", "secondary", "tertiary", "measured", "reported", "memory"]);
const failures = [];
const ids = new Map();

function frontMatter(contents, fileName) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(contents);
  if (!match) {
    failures.push(`${fileName}: missing YAML front matter`);
    return null;
  }
  const fields = new Map();
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (field) fields.set(field[1], field[2].trim());
  }
  return { fields, raw: match[1] };
}

function quotedValue(value) {
  return value?.replace(/^['"]|['"]$/g, "") ?? "";
}

function listValues(raw) {
  if (!raw || raw === "[]") return [];
  const body = raw.replace(/^\[/, "").replace(/\]$/, "");
  return body.split(",").map((item) => quotedValue(item.trim())).filter(Boolean);
}

function resolveAffect(affect) {
  const normalized = affect.replace(/^['"]|['"]$/g, "");
  if (/^ADR-\d{4}$/.test(normalized)) {
    return path.join(root, "docs", "adr", `${normalized.slice(4)}-database-tooling.md`);
  }
  return path.join(root, normalized);
}

try {
  const files = (await readdir(entriesDirectory)).filter((name) => /^R-\d{3}\.md$/.test(name)).sort();
  if (files.length === 0) failures.push("no Research Ledger entries found");
  for (const fileName of files) {
    const fullPath = path.join(entriesDirectory, fileName);
    if (!(await stat(fullPath)).isFile()) continue;
    const document = frontMatter(await readFile(fullPath, "utf8"), fileName);
    if (!document) continue;
    const { fields, raw } = document;
    const id = quotedValue(fields.get("id"));
    const expectedId = fileName.slice(0, -3);
    if (id !== expectedId || !/^R-\d{3}$/.test(id)) failures.push(`${fileName}: id must match its filename`);
    if (ids.has(id)) failures.push(`${fileName}: duplicate id ${id}`);
    ids.set(id, fileName);
    const status = quotedValue(fields.get("status"));
    const grade = quotedValue(fields.get("grade"));
    if (!allowedStatuses.has(status)) failures.push(`${fileName}: invalid status ${status}`);
    if (!allowedGrades.has(grade)) failures.push(`${fileName}: invalid evidence grade ${grade}`);
    if (!["ASSUMED", "UNKNOWN"].includes(status) && !fields.has("sources")) failures.push(`${fileName}: ${status} needs sources`);
    if (["ASSUMED", "UNKNOWN"].includes(status) && (!fields.has("fallback") || quotedValue(fields.get("fallback")) === "")) failures.push(`${fileName}: ${status} needs a fallback`);
    if (status === "VERIFIED" && !/(url:|measured:)/.test(raw)) failures.push(`${fileName}: VERIFIED needs a source URL or measurement`);
    if (status === "DISPROVED" && !/(url:|measured:)/.test(raw)) failures.push(`${fileName}: DISPROVED needs evidence`);
    const affects = listValues(fields.get("affects"));
    if (affects.length === 0) failures.push(`${fileName}: affects must not be empty`);
    for (const affect of affects) {
      if (affect.startsWith("ADR-")) {
        if (!(await stat(resolveAffect(affect)).catch(() => null))) failures.push(`${fileName}: missing affected ADR ${affect}`);
      } else if (!(await stat(path.join(root, affect)).catch(() => null))) {
        failures.push(`${fileName}: missing affected path ${affect}`);
      }
    }
    for (const sourceLine of raw.split(/\r?\n/).filter((line) => /url:\s*/.test(line))) {
      const url = sourceLine.replace(/^.*url:\s*/, "").replace(/[},].*$/, "").trim();
      if (/^https?:\/\//.test(url) && /[:@]/.test(url.replace(/^https?:\/\//, ""))) failures.push(`${fileName}: credential-like source URL`);
    }
  }

  const ledger = await readFile(ledgerPath, "utf8");
  for (const id of ids.keys()) {
    if (!ledger.includes(`| ${id} |`)) failures.push(`LEDGER.md: missing index row for ${id}`);
  }
  for (const id of ledger.matchAll(/\bR-\d{3}\b/g)) {
    if (!ids.has(id[0])) failures.push(`LEDGER.md: index references missing ${id[0]}`);
  }
  if (failures.length > 0) {
    console.error("ledger-lint: failed");
    for (const failure of failures) console.error(`  ${failure}`);
    process.exitCode = 1;
  } else {
    console.log(`ledger-lint: ${ids.size} entry checked`);
  }
} catch (error) {
  console.error(`ledger-lint: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
