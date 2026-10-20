import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts", "catalog-lint.mjs");
const sourceCatalog = path.join(root, "catalog");

function run(catalog) {
  return spawnSync(process.execPath, [script, "--catalog", catalog, "--json"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
}

test("catalog-lint accepts the checked-in offline fixtures", () => {
  const result = run(sourceCatalog);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"ok":true/);
});

test("catalog-lint rejects an unknown license marked commercial", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lightphysics-catalog-"));
  try {
    const destination = path.join(temp, "catalog");
    await cp(sourceCatalog, destination, { recursive: true });
    const modelPath = path.join(destination, "models", "mock-image-generator.json");
    const model = JSON.parse(await readFile(modelPath, "utf8"));
    model.license.id = "made-up-license";
    model.license.commercial_use = true;
    await writeFile(modelPath, `${JSON.stringify(model, null, 2)}\n`);
    const result = run(destination);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /unknown license is non-commercial/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("catalog-lint rejects unknown capability ids", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lightphysics-catalog-"));
  try {
    const destination = path.join(temp, "catalog");
    await cp(sourceCatalog, destination, { recursive: true });
    const modelPath = path.join(destination, "models", "mock-image-generator.json");
    const model = JSON.parse(await readFile(modelPath, "utf8"));
    model.capabilities.push("image.not-a-capability");
    await writeFile(modelPath, `${JSON.stringify(model, null, 2)}\n`);
    const result = run(destination);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /unknown capability/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
