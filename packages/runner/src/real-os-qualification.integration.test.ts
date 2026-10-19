import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  BackupManager,
  RunnerGitError,
  SafePointManager,
  createNodeGitRunner,
  type GitCommandResult,
  type GitRunner,
} from "./index.ts";

function temporaryRoot(): string {
  return mkdtempSync(path.join(os.tmpdir(), "lightphysics-runner-qualification-"));
}

function runGit(git: GitRunner, cwd: string, args: readonly string[]): GitCommandResult {
  const result = git("git", args, { cwd, shell: false });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result;
}

function normalizedText(filePath: string): string {
  return readFileSync(filePath, "utf8").replaceAll("\r\n", "\n");
}

/**
 * Real-OS qualification for the portable Runner seams.
 *
 * This intentionally qualifies only ordinary filesystem and git operations
 * in a temporary directory. It does not claim daemon quiescence, Warden
 * token revocation, or POSIX process-tree behavior; those have no safe-point
 * or backup seam here (and process-tree coverage is separately POSIX-only).
 */
test("qualifies real git safe-point rollback and filesystem backup round-trip", (context) => {
  const root = temporaryRoot();
  try {
    const git = createNodeGitRunner();
    let probe: GitCommandResult;
    try {
      probe = git("git", ["--version"], { cwd: root, shell: false });
    } catch (error) {
      if (error instanceof RunnerGitError) {
        context.skip("real git is unavailable; qualification remains opt-in");
        return;
      }
      throw error;
    }
    if (probe.status !== 0) {
      context.skip("real git is unavailable; qualification remains opt-in");
      return;
    }

    const repositoryRoot = path.join(root, "repo");
    const databaseRoot = path.join(root, "state");
    const safePointDirectory = path.join(root, "safe-point");
    mkdirSync(repositoryRoot, { recursive: true });
    mkdirSync(path.join(databaseRoot, "db"), { recursive: true });
    writeFileSync(path.join(repositoryRoot, "README.md"), "baseline repository\n");
    writeFileSync(path.join(databaseRoot, "db", "ledger.sqlite"), "baseline database\n");

    runGit(git, repositoryRoot, ["init", "--quiet"]);
    runGit(git, repositoryRoot, ["config", "user.email", "runner-qualification@example.invalid"]);
    runGit(git, repositoryRoot, ["config", "user.name", "Runner Qualification"]);
    runGit(git, repositoryRoot, ["add", "--", "README.md"]);
    runGit(git, repositoryRoot, ["commit", "--quiet", "-m", "runner qualification baseline"]);
    const baselineCommit = runGit(git, repositoryRoot, ["rev-parse", "--verify", "HEAD"]).stdout.trim();
    assert.match(baselineCommit, /^[0-9a-f]{40}$/);

    const safePoints = new SafePointManager({ gitRunner: git });
    const safePoint = safePoints.create({
      repositoryRoot,
      databaseRoot,
      databasePaths: ["db/ledger.sqlite"],
      destination: safePointDirectory,
      id: "real-os-qualification",
    });
    assert.equal(safePoints.verify({ directory: safePoint.directory, repositoryRoot, gitRunner: git }).ok, true);

    writeFileSync(path.join(repositoryRoot, "README.md"), "mutated repository\n");
    writeFileSync(path.join(databaseRoot, "db", "ledger.sqlite"), "mutated database\n");
    const rollback = safePoints.rollback({
      repositoryRoot,
      databaseRoot,
      directory: safePoint.directory,
      overwrite: true,
    });
    assert.equal(rollback.ok, true);
    assert.equal(normalizedText(path.join(repositoryRoot, "README.md")), "baseline repository\n");
    assert.equal(normalizedText(path.join(databaseRoot, "db", "ledger.sqlite")), "baseline database\n");
    assert.equal(runGit(git, repositoryRoot, ["rev-parse", "--verify", "HEAD"]).stdout.trim(), baselineCommit);

    const home = path.join(root, "home");
    mkdirSync(path.join(home, "db"), { recursive: true });
    mkdirSync(path.join(home, "store", "sha256", "ab"), { recursive: true });
    writeFileSync(path.join(home, "db", "ledger.sqlite"), "ledger snapshot\n");
    writeFileSync(path.join(home, "db", "runner.sqlite"), "runner snapshot\n");
    writeFileSync(path.join(home, "store", "sha256", "ab", "object"), "cas snapshot\n");
    const backupDirectory = path.join(root, "backup");
    const restoreRoot = path.join(root, "restored-home");
    const backups = new BackupManager();
    const backup = backups.create({ home, destination: backupDirectory });
    assert.equal(backups.verify({ destination: backup.destination }).ok, true);
    const restored = backups.restore({ destination: backup.destination, destinationRoot: restoreRoot });
    assert.equal(restored.ok, true);
    assert.equal(normalizedText(path.join(restoreRoot, "db", "ledger.sqlite")), "ledger snapshot\n");
    assert.equal(normalizedText(path.join(restoreRoot, "db", "runner.sqlite")), "runner snapshot\n");
    assert.equal(normalizedText(path.join(restoreRoot, "store", "sha256", "ab", "object")), "cas snapshot\n");

    const nonRepository = path.join(root, "not-a-repository");
    mkdirSync(nonRepository, { recursive: true });
    assert.throws(
      () => safePoints.rollback({
        repositoryRoot: nonRepository,
        databaseRoot,
        directory: safePoint.directory,
        overwrite: true,
      }),
      (error: unknown) => error instanceof RunnerGitError
        && typeof error.details?.status === "number"
        && Number.isSafeInteger(error.details.status),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
