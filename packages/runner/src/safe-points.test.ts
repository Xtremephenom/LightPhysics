import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  BackupManager,
  BackupUnavailableError,
  RunnerNotAvailableError,
  RunnerValidationError,
  SafePointManager,
  defaultRunnerFileSystem,
  type GitCommandResult,
  type GitRunner,
  type RunnerFileSystem,
} from "./index.ts";

function temporaryRoot(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), `lightphysics-${prefix}-`));
}

function withRoot<T>(prefix: string, callback: (root: string) => T): T {
  const root = temporaryRoot(prefix);
  try {
    return callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function fakeGit(calls: Array<{ command: string; args: readonly string[]; options: unknown }>, identifier = "0123456789abcdef0123456789abcdef01234567"): GitRunner {
  return (command, args, options): GitCommandResult => {
    calls.push({ command, args, options });
    return { status: 0, stdout: `${identifier}\n`, stderr: "" };
  };
}

function makeHome(root: string): void {
  mkdirSync(path.join(root, "db"), { recursive: true });
  mkdirSync(path.join(root, "store", "sha256", "ab"), { recursive: true });
  writeFileSync(path.join(root, "db", "ledger.sqlite"), "ledger-before");
  writeFileSync(path.join(root, "db", "runner.sqlite"), "runner-before");
  writeFileSync(path.join(root, "store", "sha256", "ab", "object"), "cas-object");
  writeFileSync(path.join(root, "settings.json"), '{"apiKey":"sk-do-not-copy-this-value","name":"demo"}\n');
  writeFileSync(path.join(root, ".env"), "TOKEN=do-not-copy\n");
}

test("safe points use command argv with shell=false and rollback through injected seams", () => {
  withRoot("safe-point", (root) => {
    const repositoryRoot = path.join(root, "repo");
    const destination = path.join(root, "safe-point");
    const databaseRoot = path.join(root, "state");
    mkdirSync(path.join(repositoryRoot, "src"), { recursive: true });
    mkdirSync(databaseRoot, { recursive: true });
    writeFileSync(path.join(repositoryRoot, "README.md"), "repo");
    writeFileSync(path.join(databaseRoot, "ledger.sqlite"), "before");
    const calls: Array<{ command: string; args: readonly string[]; options: any }> = [];
    const copies: string[] = [];
    const copyFs: RunnerFileSystem = {
      ...defaultRunnerFileSystem,
      copyFile(source, target, options) {
        copies.push(`${source}->${target}`);
        defaultRunnerFileSystem.copyFile?.(source, target, options);
      },
    };
    const manager = new SafePointManager({ fs: copyFs, gitRunner: fakeGit(calls) });
    const created = manager.create({
      repositoryRoot,
      databaseRoot,
      databasePaths: ["ledger.sqlite"],
      destination,
      id: "sp-1",
    });
    assert.equal(calls[0]?.command, "git");
    assert.deepEqual(calls[0]?.args, ["rev-parse", "--verify", "HEAD"]);
    assert.equal(calls[0]?.options.shell, false);
    assert.equal(copies.length, 1);
    assert.equal(created.gitIdentifier, "0123456789abcdef0123456789abcdef01234567");
    assert.throws(
      () => manager.create({
        repositoryRoot,
        databaseRoot,
        databasePaths: ["ledger.sqlite"],
        destination,
        id: "sp-1-retry",
      }),
      /already contains a manifest/i,
    );

    writeFileSync(path.join(databaseRoot, "ledger.sqlite"), "after");
    const rollback = manager.rollback({ repositoryRoot, databaseRoot, directory: destination, overwrite: true });
    assert.equal(rollback.ok, true);
    assert.equal(readFileSync(path.join(databaseRoot, "ledger.sqlite"), "utf8"), "before");
    assert.deepEqual(calls.at(-1)?.args, ["reset", "--hard", created.gitIdentifier]);
    assert.equal(calls.at(-1)?.options.shell, false);
  });
});

test("safe point verification lists bounded snapshots and reports unavailable git instead of success", () => {
  withRoot("safe-point-verify", (root) => {
    const repositoryRoot = path.join(root, "repo");
    const databaseRoot = path.join(root, "state");
    const destination = path.join(root, "safe-point");
    mkdirSync(repositoryRoot, { recursive: true });
    mkdirSync(databaseRoot, { recursive: true });
    writeFileSync(path.join(databaseRoot, "runner.sqlite"), "runner");
    const created = new SafePointManager({ gitRunner: fakeGit([]) }).create({
      repositoryRoot,
      databaseRoot,
      databases: ["runner.sqlite"],
      destination,
      id: "sp-verify",
    });
    const verification = new SafePointManager().verify({ directory: created.directory, verifyGit: false });
    assert.equal(verification.ok, true);
    assert.equal(verification.databases[0]?.status, "verified");
    const unavailable = new SafePointManager().verify({ directory: created.directory });
    assert.equal(unavailable.ok, false);
    assert.equal(unavailable.git.status, "unavailable");
    const listed = new SafePointManager().list({ root });
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, "sp-verify");
  });
});

test("backup manifests are deterministic, hash-verified, and redact secret config material", () => {
  withRoot("backup", (root) => {
    const home = path.join(root, "home");
    makeHome(home);
    const firstDestination = path.join(root, "backup-a");
    const secondDestination = path.join(root, "backup-b");
    const manager = new BackupManager();
    const first = manager.create({ home, destination: firstDestination, configPaths: ["settings.json", ".env"] });
    const second = manager.create({ home, destination: secondDestination, configPaths: ["settings.json", ".env"] });
    assert.deepEqual(first.manifest, second.manifest);
    assert.equal(readFileSync(path.join(firstDestination, "manifest.json"), "utf8"), readFileSync(path.join(secondDestination, "manifest.json"), "utf8"));
    assert.equal(first.manifest.omitted.length, 1);
    assert.equal(first.manifest.entries.some((entry) => entry.category === "config" && entry.redacted === true), true);
    assert.doesNotMatch(readFileSync(path.join(firstDestination, "config", "settings.json"), "utf8"), /sk-do-not-copy/);
    assert.equal(manager.verify({ destination: firstDestination }).ok, true);
    writeFileSync(path.join(firstDestination, "cas", "ab", "object"), "tampered");
    assert.equal(manager.verify({ destination: firstDestination }).ok, false);
    const restoreRoot = path.join(root, "restored-home");
    const restored = manager.restore({ destination: secondDestination, destinationRoot: restoreRoot });
    assert.equal(restored.ok, true);
    assert.equal(readFileSync(path.join(restoreRoot, "db", "ledger.sqlite"), "utf8"), "ledger-before");
    assert.doesNotMatch(readFileSync(path.join(restoreRoot, "settings.json"), "utf8"), /apiKey|sk-do-not-copy/);
    assert.equal(existsSync(path.join(restoreRoot, ".env")), false, "secret-like omitted files are not restored");
  });
});

test("backup rejects traversal/symlink escapes and enforces file/byte bounds", () => {
  withRoot("backup-bound", (root) => {
    const home = path.join(root, "home");
    makeHome(home);
    assert.throws(
      () => new BackupManager().create({ home, destination: path.join(root, "bad"), configPaths: ["../outside.json"] }),
      RunnerValidationError,
    );
    assert.throws(
      () => new BackupManager().create({ home, destination: path.join(root, "too-many"), limits: { maxFiles: 2 } }),
      RunnerValidationError,
    );
    assert.throws(
      () => new BackupManager().create({ home, destination: path.join(root, "too-large"), limits: { maxBytes: 3 } }),
      RunnerValidationError,
    );
    const casPath = path.join(home, "store", "sha256", "ab", "object");
    const symlinkFs: RunnerFileSystem = {
      ...defaultRunnerFileSystem,
      lstat(filePath) {
        if (filePath === casPath) return { kind: "symlink", size: 0 };
        return defaultRunnerFileSystem.lstat(filePath);
      },
    };
    assert.throws(
      () => new BackupManager({ fs: symlinkFs }).create({ home, destination: path.join(root, "symlink") }),
      /symbolic link/i,
    );
  });
});

test("missing git and missing backup prerequisites fail visibly", () => {
  withRoot("unavailable", (root) => {
    const repositoryRoot = path.join(root, "repo");
    mkdirSync(repositoryRoot, { recursive: true });
    assert.throws(
      () => new SafePointManager().create({ repositoryRoot, destination: path.join(root, "sp"), databases: ["missing.sqlite"] }),
      RunnerNotAvailableError,
    );
    assert.throws(
      () => new BackupManager().create({ home: path.join(root, "home"), destination: path.join(root, "backup") }),
      BackupUnavailableError,
    );
  });
});
