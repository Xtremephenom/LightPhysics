#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const statePath = path.join(root, "docs", "BUILD_STATE.md");
const requiredSections = [
  "## 1. Phase goal & exit criteria",
  "## 2. Done this session",
  "## 3. In progress",
  "## 4. Next 3 actions",
  "## 5. Decisions made",
  "## 6. Unverified",
  "## 7. Known defects",
  "## 8. Opt-in suites",
  "## 9. Footprint metrics vs budgets",
  "## 10. Spend",
  "## 11. Owner asks pending",
  "## 12. How to resume",
];
const failures = [];

try {
  const contents = await readFile(statePath, "utf8");
  const lines = contents.split(/\r?\n/);
  if (lines.length - (contents.endsWith("\n") ? 1 : 0) > 150) failures.push("BUILD_STATE.md must be 150 lines or fewer");
  if (!/^\*\*Phase:\*\*\s*\d+\s+—/m.test(contents)) failures.push("header must declare a numeric phase");
  const dateMatch = /\*\*Date:\*\*\s*(\d{4}-\d{2}-\d{2})/.exec(contents);
  if (!dateMatch || Number.isNaN(Date.parse(`${dateMatch[1]}T00:00:00Z`))) failures.push("header must contain an ISO date");
  const baseline = /^\*\*Baseline `make test`:\*\*\s*(.+)$/m.exec(contents)?.[1] ?? "";
  if (!/(green|red|NOT RUN)/i.test(baseline) || !/\d+\s+passed\s*\/\s*\d+\s+failed\s*\/\s*\d+\s+skipped/i.test(baseline)) failures.push("baseline must include status and passed/failed/skipped counts");
  for (const section of requiredSections) if (!contents.includes(section)) failures.push(`missing ${section}`);
  if (failures.length > 0) {
    console.error("state-lint: failed");
    for (const failure of failures) console.error(`  ${failure}`);
    process.exitCode = 1;
  } else {
    console.log(`state-lint: ${lines.length - 1} lines and all required sections present`);
  }
} catch (error) {
  console.error(`state-lint: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
