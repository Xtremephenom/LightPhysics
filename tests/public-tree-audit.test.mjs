import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts", "public-tree-audit.mjs");

function git(repository, ...args) {
  const result = spawnSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function audit(repository) {
  return spawnSync(process.execPath, [script], {
    cwd: repository,
    encoding: "utf8",
    windowsHide: true,
  });
}

async function makeRepository() {
  const repository = await mkdtemp(path.join(os.tmpdir(), "lightphysics-public-tree-audit-"));
  git(repository, "init", "--initial-branch=main");
  git(repository, "config", "user.email", "test@example.invalid");
  git(repository, "config", "user.name", "LightPhysics test");
  await writeFile(path.join(repository, "README.md"), "public\n");
  git(repository, "add", "README.md");
  git(repository, "commit", "-m", "initial");
  return repository;
}

test("public-tree-audit accepts clean reachable refs", async () => {
  const repository = await makeRepository();
  try {
    git(repository, "tag", "clean");
    const result = audit(repository);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /clean \(checked/);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("public-tree-audit rejects forbidden paths on any reachable ref", async () => {
  const repository = await makeRepository();
  try {
    await mkdir(path.join(repository, "docs", "pack"), { recursive: true });
    await mkdir(path.join(repository, "master_promptpack_nottobeshipped"), { recursive: true });
    await writeFile(path.join(repository, "docs", "pack", "private.md"), "private\n");
    await writeFile(path.join(repository, "master_promptpack_nottobeshipped", "private.md"), "private\n");
    git(repository, "add", ".");
    git(repository, "commit", "-m", "forbidden content");
    git(repository, "tag", "forbidden");

    const result = audit(repository);
    assert.notEqual(result.status, 0);
    const output = `${result.stdout}${result.stderr}`;
    assert.match(output, /docs\/pack\/private\.md/);
    assert.match(output, /master_promptpack_nottobeshipped\/private\.md/);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});
