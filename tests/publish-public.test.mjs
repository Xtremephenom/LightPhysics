import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts", "publish-public.mjs");

function git(repository, ...args) {
  const result = spawnSync("git", args, { cwd: repository, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function publish(source, publisher, ...args) {
  return runPublish(source, publisher, true, ...args);
}

function runPublish(source, publisher, noPush, ...args) {
  const command = [script, "--source-dir", source, "--publisher-dir", publisher,
    "--source-ref", "main", "--message", "publish public snapshot"];
  if (noPush) command.push("--no-push");
  command.push(...args);
  return spawnSync(process.execPath, command, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
}

async function makeRepositories() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lightphysics-publish-public-"));
  const source = path.join(directory, "source");
  const publisher = path.join(directory, "publisher");
  await mkdir(source);
  await mkdir(publisher);
  git(source, "init", "--initial-branch=main");
  git(source, "config", "user.email", "test@example.invalid");
  git(source, "config", "user.name", "LightPhysics test");
  git(publisher, "init", "--initial-branch=main");
  git(publisher, "config", "user.email", "test@example.invalid");
  git(publisher, "config", "user.name", "LightPhysics test");
  await writeFile(path.join(publisher, "OLD.txt"), "old\n");
  git(publisher, "add", ".");
  git(publisher, "commit", "-m", "publisher baseline");
  return { directory, source, publisher };
}

test("publish-public rebuilds the filtered snapshot and records its source commit", async () => {
  const { directory, source, publisher } = await makeRepositories();
  try {
    await mkdir(path.join(source, "docs", "pack"), { recursive: true });
    await mkdir(path.join(source, "master_promptpack_nottobeshipped"), { recursive: true });
    await writeFile(path.join(source, "README.md"), "public v1\n");
    await writeFile(path.join(source, "docs", "pack", "private.md"), "private\n");
    await writeFile(path.join(source, "master_promptpack_nottobeshipped", "private.md"), "private\n");
    await writeFile(path.join(source, "run.sh"), "#!/bin/sh\nexit 0\n");
    if (process.platform !== "win32") await chmod(path.join(source, "run.sh"), 0o755);
    git(source, "add", ".");
    git(source, "commit", "-m", "source with private history");
    const sourceCommit = git(source, "rev-parse", "HEAD");
    git(source, "tag", "source-private-history");

    const result = publish(source, publisher);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(await readFile(path.join(publisher, "README.md"), "utf8"), "public v1\n");
    await assert.rejects(() => readFile(path.join(publisher, "OLD.txt")));
    await assert.rejects(() => readFile(path.join(publisher, "docs", "pack", "private.md")));
    await assert.rejects(() => readFile(path.join(publisher, "master_promptpack_nottobeshipped", "private.md")));
    assert.match(git(publisher, "show", "-s", "--format=%B", "HEAD"), new RegExp(`Source-Commit: ${sourceCommit}`));
    assert.equal(git(publisher, "tag", "--list"), "");
    assert.match(result.stdout, /no push/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("publish-public creates only an explicitly requested publisher tag", async () => {
  const { directory, source, publisher } = await makeRepositories();
  try {
    await writeFile(path.join(source, "README.md"), "public\n");
    git(source, "add", "README.md");
    git(source, "commit", "-m", "public source");
    git(source, "tag", "source-tag");
    const result = publish(source, publisher, "--tag", "phase2-done");
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(git(publisher, "tag", "--list"), "phase2-done");
    assert.equal(git(publisher, "rev-parse", "refs/tags/phase2-done"), git(publisher, "rev-parse", "HEAD"));
    assert.equal(git(publisher, "for-each-ref", "--format=%(refname)", "refs/tags"), "refs/tags/phase2-done");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("publish-public rejects a dirty publisher before changing it", async () => {
  const { directory, source, publisher } = await makeRepositories();
  try {
    await writeFile(path.join(source, "README.md"), "public\n");
    git(source, "add", "README.md");
    git(source, "commit", "-m", "public source");
    await writeFile(path.join(publisher, "uncommitted.txt"), "do not remove\n");
    const before = git(publisher, "rev-parse", "HEAD");
    const result = publish(source, publisher);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /publisher worktree must be clean/);
    assert.equal(git(publisher, "rev-parse", "HEAD"), before);
    assert.equal(await readFile(path.join(publisher, "uncommitted.txt"), "utf8"), "do not remove\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("publish-public pushes only publisher main and an explicitly requested tag", async () => {
  const { directory, source, publisher } = await makeRepositories();
  const remote = path.join(directory, "remote.git");
  try {
    await mkdir(remote);
    git(remote, "init", "--bare", "--initial-branch=main");
    git(publisher, "remote", "add", "origin", remote);
    await writeFile(path.join(source, "README.md"), "public\n");
    git(source, "add", "README.md");
    git(source, "commit", "-m", "public source");
    git(source, "tag", "source-tag");
    const result = runPublish(source, publisher, false, "--tag", "phase2-done");
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const refs = git(remote, "show-ref").split(/\r?\n/).filter(Boolean);
    assert.equal(refs.length, 2);
    assert.ok(refs.some((ref) => ref.endsWith("refs/heads/main")));
    assert.ok(refs.some((ref) => ref.endsWith("refs/tags/phase2-done")));
    assert.ok(!refs.some((ref) => ref.includes("source-tag")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
