#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaPath = path.join(root, "scripts", "config.env.json");
const envPath = path.join(root, ".env.example");
const mode = process.argv.includes("--write") ? "write" : "check";

const fail = (message) => {
  console.error(`env-sync: ${message}`);
  process.exitCode = 1;
};

const isSafeName = (name) => /^LP_[A-Z0-9_]+$/.test(name);

function validateSchema(schema) {
  if (schema?.schema !== 1 || !Array.isArray(schema.variables) || schema.variables.length === 0) {
    throw new Error("scripts/config.env.json must contain schema: 1 and a non-empty variables array");
  }
  const names = new Set();
  for (const variable of schema.variables) {
    if (!variable || typeof variable !== "object" || !isSafeName(variable.name)) {
      throw new Error("every config variable needs a valid LP_ name");
    }
    if (names.has(variable.name)) {
      throw new Error(`duplicate config variable: ${variable.name}`);
    }
    names.add(variable.name);
    if (typeof variable.default !== "string") {
      throw new Error(`${variable.name} default must be a string`);
    }
    if (variable.secret === true && variable.default !== "") {
      throw new Error(`${variable.name} is secret and must have an empty default`);
    }
  }
}

function render(schema) {
  const lines = [
    "# Generated from scripts/config.env.json by scripts/env-sync.mjs.",
    "# Copy to .env for local experimentation; never put credentials in this file.",
    "",
  ];
  for (const variable of schema.variables) {
    lines.push(`# ${variable.description}`);
    lines.push(`${variable.name}=${variable.default}`);
  }
  return `${lines.join("\n")}\n`;
}

function parseEnvExample(contents) {
  const values = new Map();
  const unknown = [];
  for (const [index, rawLine] of contents.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) {
      unknown.push(`line ${index + 1} is not a KEY=value assignment`);
      continue;
    }
    const [, name, value] = match;
    if (values.has(name)) unknown.push(`duplicate variable ${name}`);
    values.set(name, value);
  }
  return { values, unknown };
}

try {
  const schema = JSON.parse(await readFile(schemaPath, "utf8"));
  validateSchema(schema);
  const rendered = render(schema);
  if (mode === "write") {
    await writeFile(envPath, rendered, "utf8");
    console.log(`env-sync: wrote ${path.relative(root, envPath)}`);
    process.exit(0);
  }

  const current = await readFile(envPath, "utf8");
  const parsed = parseEnvExample(current);
  for (const error of parsed.unknown) fail(error);
  const expected = new Map(schema.variables.map((variable) => [variable.name, variable.default]));
  for (const [name, value] of parsed.values) {
    if (!expected.has(name)) fail(`${name} is not declared in scripts/config.env.json`);
    if (expected.get(name) !== value) fail(`${name} has ${JSON.stringify(value)}; expected the declared neutral default`);
  }
  for (const [name, value] of expected) {
    if (!parsed.values.has(name)) fail(`${name} is missing from .env.example`);
    if (value === "" && parsed.values.get(name) !== "") fail(`${name} must be empty in .env.example`);
  }
  if (current !== rendered) fail(".env.example formatting or generated comments differ; run node scripts/env-sync.mjs --write");
  if (process.exitCode !== 1) console.log("env-sync: .env.example is in sync");
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
