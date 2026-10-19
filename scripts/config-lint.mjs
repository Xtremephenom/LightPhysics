#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const biomePath = path.join(root, "biome.json");
try {
  const biome = JSON.parse(await readFile(biomePath, "utf8"));
  if (biome.formatter?.enabled !== true || biome.linter?.enabled !== true) {
    throw new Error("biome.json must enable both formatter and linter");
  }
  if (biome.formatter?.lineEnding !== "lf") throw new Error("biome.json must use LF line endings");
  console.log("config-lint: biome formatter and linter are enabled");
} catch (error) {
  console.error(`config-lint: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
