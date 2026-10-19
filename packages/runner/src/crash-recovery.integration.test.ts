import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  JobJournal,
  Supervisor,
  type SupervisorTaskHandle,
} from "./index.ts";

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForChildReady(task: SupervisorTaskHandle): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const status = task.getStatus();
    if (status.stdout.includes("runner-child-ready")) return;
    if (status.state !== "running") {
      throw new Error(`real child exited before becoming ready: ${status.reason ?? status.state}`);
    }
    await delay(10);
  }
  throw new Error("real child did not become ready before the test deadline");
}

test("recovers a persisted running job after terminating a real child process", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lightphysics-runner-crash-"));
  const databasePath = path.join(root, "db", "runner.sqlite");
  const childScriptPath = path.join(root, "runner-daemon.mjs");
  const journalModuleUrl = new URL("./journal.ts", import.meta.url).href;
  const childSource = [
    `import { JobJournal } from ${JSON.stringify(journalModuleUrl)};`,
    "const journal = new JobJournal({ databasePath: process.argv[2] });",
    "const resumable = journal.createJob({ id: 'resumable-after-crash', type: 'real-child-work', payload: { worker: 'runner-daemon' }, resumable: true });",
    "const nonResumable = journal.createJob({ id: 'orphaned-after-crash', type: 'one-shot-work', payload: { worker: 'runner-daemon' }, resumable: false });",
    "journal.start(resumable.id);",
    "journal.start(nonResumable.id);",
    "if (journal.requireJob(resumable.id).state !== 'running' || journal.requireJob(nonResumable.id).state !== 'running') throw new Error('child did not persist both jobs as running');",
    "process.stdout.write('runner-child-ready jobs-running\\n');",
    "setInterval(() => {}, 1_000);",
  ].join("\n");
  let journal: JobJournal | undefined;
  let supervisor: Supervisor | undefined;
  let child: SupervisorTaskHandle | undefined;

  try {
    writeFileSync(childScriptPath, childSource, { encoding: "utf8", mode: 0o600 });
    supervisor = new Supervisor({ defaultCwd: root });
    child = supervisor.start({
      id: "crash-recovery-child",
      command: process.execPath,
      args: ["--experimental-strip-types", childScriptPath, databasePath],
      cwd: root,
      stdio: { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    });
    await waitForChildReady(child);

    const stop = await supervisor.stop(child.id, {
      force: true,
      signal: "SIGKILL",
      reason: "kill_all",
      timeoutMs: 5_000,
    });
    const childResult = await child.done;
    assert.equal(stop.requested, true);
    assert.equal(stop.accepted, true);
    assert.equal(childResult.state, "stopped");
    assert.equal(childResult.reason, "stopped");

    // The terminated child owned the journal.  Reopening here is the first
    // parent access to the database after the simulated daemon crash.
    journal = new JobJournal({ databasePath });
    const report = journal.recover({
      at: "2026-01-01T00:00:10.000Z",
      reason: "Runner daemon terminated during the job",
    });
    assert.deepEqual(report.resumed, ["resumable-after-crash"]);
    assert.deepEqual(report.orphaned, ["orphaned-after-crash"]);
    assert.deepEqual(report.outcomes, [
      {
        jobId: "resumable-after-crash",
        previousState: "running",
        state: "queued",
        action: "resumed",
        resumable: true,
        reason: "Runner daemon terminated during the job",
      },
      {
        jobId: "orphaned-after-crash",
        previousState: "running",
        state: "orphaned",
        action: "orphaned",
        resumable: false,
        reason: "Runner daemon terminated during the job",
      },
    ]);
    assert.equal(journal.requireJob("resumable-after-crash").state, "queued");
    assert.equal(journal.requireJob("resumable-after-crash").resumable, true);
    assert.equal(journal.requireJob("orphaned-after-crash").state, "orphaned");
    assert.equal(journal.requireJob("orphaned-after-crash").resumable, false);
    assert.equal(journal.requireJob("orphaned-after-crash").error?.code, "JobOrphaned");
  } finally {
    if (child && supervisor && (child.getStatus().state === "running" || child.getStatus().state === "stopping")) {
      await supervisor.stop(child.id, { force: true, signal: "SIGKILL", timeoutMs: 5_000 }).catch(() => undefined);
      await child.done.catch(() => undefined);
    }
    journal?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
