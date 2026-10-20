#!/usr/bin/env node
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = path.join(root, "docs", "adr");
const failures = [];
const statuses = new Set(["proposed", "accepted", "accepted (pre-decided)", "superseded"]);
const requiredSections = ["Context", "Options considered", "Evidence", "Decision", "Consequences", "How to revert"];

try {
  const files = (await readdir(directory)).filter((name) => /^\d{4}-[^/]+\.md$/.test(name)).sort();
  const numbers = files.map((name) => Number(name.slice(0, 4)));
  const expected = Array.from({ length: files.length }, (_, index) => index + 1);
  if (files.length !== expected.length || numbers.some((number, index) => number !== expected[index])) {
    failures.push(`expected sequential ADR numbering through ${String(files.length).padStart(4, "0")}; found ${files.join(", ")}`);
  }
  for (const fileName of files) {
    const fullPath = path.join(directory, fileName);
    if (!(await stat(fullPath)).isFile()) continue;
    const contents = await readFile(fullPath, "utf8");
    const id = fileName.slice(0, 4);
    const statusMatch = /^Status:\s*(.+)$/m.exec(contents);
    const status = statusMatch?.[1]?.trim();
    if (!status || !statuses.has(status)) failures.push(`${fileName}: invalid or missing Status`);
    if (Number(id) <= 16 && status !== "accepted (pre-decided)") failures.push(`${fileName}: ADR 0001-0016 must be accepted (pre-decided)`);
    if (id === "0017" && status !== "proposed") failures.push(`${fileName}: ADR 0017 must remain proposed`);
    for (const section of requiredSections) {
      if (!new RegExp("^## " + section + " *$", "m").test(contents)) failures.push(`${fileName}: missing ## ${section}`);
    }
  }
  if (failures.length > 0) {
    console.error("adr-lint: failed");
    for (const failure of failures) console.error(`  ${failure}`);
    process.exitCode = 1;
  } else {
  console.log(`adr-lint: ADR-0001 through ADR-${String(files.length).padStart(4, "0")} are sequential and structurally valid`);
  }
} catch (error) {
  console.error(`adr-lint: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
