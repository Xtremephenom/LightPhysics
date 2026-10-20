import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Forge consult demo creates an exploration artifact with verified provenance", () => {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/forge-consult-demo.mjs"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.capability, "image.generate");
  assert.equal(report.status, "done");
  assert.equal(report.ledger.chain, "verified");
  assert.equal(report.ledger.records, 3);
  assert.equal(report.artifacts[0].state, "exploration");
  assert.match(report.artifacts[0].recipe_id, /^recipe-[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(report).includes("lighthouse island"), false);
});
