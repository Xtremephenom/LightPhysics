import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  CancellationNotRequestedError,
  IllegalJobTransitionError,
  JobJournal,
  JobNotResumableError,
  MAX_PROGRESS_EVENT_BYTES,
  REFERENCE_4GB_PROFILE,
  ResourceGovernor,
  RunnerConflictError,
  SensitiveDataRejectedError,
  decideAdmission,
  type GovernorAction,
  type GovernorJob,
  type ResourceRequestInput,
} from "./index.ts";

function temporaryDatabase(): string {
  return path.join(mkdtempSync(path.join(os.tmpdir(), "lightphysics-runner-test-")), "runner.sqlite");
}

function withDatabase<T>(callback: (databasePath: string) => T): T {
  const root = mkdtempSync(path.join(os.tmpdir(), "lightphysics-runner-test-"));
  const databasePath = path.join(root, "db", "runner.sqlite");
  try {
    return callback(databasePath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("journal persists canonical jobs across close/reopen and bounds secrets", () => {
  withDatabase((databasePath) => {
    const journal = new JobJournal({ databasePath, maxProgressEvents: 3 });
    const job = journal.createJob({
      id: "persisted-job",
      type: "mock-work",
      payload: { z: 1, nested: { b: true, a: "stable" }, a: 0 },
      resources: { vram_peak_mb: 512, ram_peak_mb: 1_024, disk_mb: 4 },
      resumable: true,
    });
    assert.deepEqual(job.payload, { a: 0, nested: { a: "stable", b: true }, z: 1 });
    assert.equal(job.state, "queued");
    assert.throws(
      () => journal.createJob({ type: "unsafe", payload: { providerToken: "do-not-store" } }),
      SensitiveDataRejectedError,
    );
    journal.close();

    const reopened = new JobJournal({ databasePath, maxProgressEvents: 3 });
    assert.deepEqual(reopened.getJob("persisted-job"), job);
    assert.equal(reopened.listJobs().length, 1);
    reopened.close();
  });
});

test("job transitions enforce the state graph and record attempts/timestamps", () => {
  let time = new Date("2026-01-01T00:00:00.000Z");
  const journal = new JobJournal({ databasePath: ":memory:", clock: () => time });
  const job = journal.createJob({ id: "transitions", type: "work" });
  assert.throws(() => journal.succeed(job.id), IllegalJobTransitionError);

  time = new Date("2026-01-01T00:00:01.000Z");
  const running = journal.start(job.id);
  assert.equal(running.state, "running");
  assert.equal(running.attempts, 1);
  assert.equal(running.startedAt, "2026-01-01T00:00:01.000Z");

  time = new Date("2026-01-01T00:00:02.000Z");
  assert.equal(journal.waitForProvider(job.id).state, "waiting_provider");
  time = new Date("2026-01-01T00:00:03.000Z");
  assert.equal(journal.start(job.id).attempts, 2);
  time = new Date("2026-01-01T00:00:04.000Z");
  assert.equal(journal.waitForHuman(job.id).state, "waiting_human");
  const done = journal.succeed(job.id, { ok: true });
  assert.equal(done.state, "succeeded");
  assert.deepEqual(done.result, { ok: true });
  assert.equal(done.finishedAt, "2026-01-01T00:00:04.000Z");
  assert.throws(() => journal.start(job.id), IllegalJobTransitionError);
  const noResult = journal.createJob({ id: "no-result", type: "work" });
  journal.start(noResult.id);
  assert.equal(journal.succeed(noResult.id).state, "succeeded");
  const nullFailure = journal.createJob({ id: "null-failure", type: "work" });
  journal.start(nullFailure.id);
  assert.equal(journal.fail(nullFailure.id, null).state, "failed");
  journal.close();
});

test("checkpoints are idempotent by job and step and reject divergent replay", () => {
  const journal = new JobJournal(":memory:");
  const job = journal.createJob({ id: "checkpoint-job", type: "work" });
  journal.start(job.id);
  const first = journal.checkpoint(job.id, "download", { b: 2, a: 1 });
  const replay = journal.checkpoint(job.id, "download", { a: 1, b: 2 });
  assert.deepEqual(replay, first);
  assert.deepEqual(journal.listCheckpoints(job.id), [first]);
  assert.throws(
    () => journal.checkpoint(job.id, "download", { a: 2 }),
    (error: unknown) => error instanceof RunnerConflictError && error.code === "RunnerConflict",
  );
  assert.throws(() => journal.checkpoint(job.id, "other", { accessToken: "secret" }), SensitiveDataRejectedError);
  journal.close();
});

test("recovery resumes only explicitly resumable work and orphans the rest", () => {
  withDatabase((databasePath) => {
    const first = new JobJournal({ databasePath });
    first.createJob({ id: "resume-me", type: "work", resumable: true });
    first.createJob({ id: "orphan-me", type: "work", resumable: false });
    first.start("resume-me");
    first.start("orphan-me");
    first.close();

    const reopened = new JobJournal({ databasePath });
    const report = reopened.recover({ at: "2026-01-01T00:00:10.000Z" });
    assert.deepEqual(report.resumed, ["resume-me"]);
    assert.deepEqual(report.orphaned, ["orphan-me"]);
    assert.equal(reopened.requireJob("resume-me").state, "queued");
    assert.equal(reopened.requireJob("orphan-me").state, "orphaned");
    assert.equal(reopened.requireJob("orphan-me").error?.code, "JobOrphaned");
    assert.throws(() => reopened.resume("orphan-me"), JobNotResumableError);
    assert.equal(reopened.recover().outcomes.length, 0);
    reopened.close();
  });
});

test("cooperative cancellation and bounded progress preserve idempotent events", () => {
  const journal = new JobJournal({ databasePath: ":memory:", maxProgressEvents: 2 });
  const job = journal.createJob({ id: "cancel-job", type: "work" });
  journal.start(job.id);
  const requested = journal.requestCancel(job.id, "user requested stop");
  assert.equal(requested.state, "running");
  assert.equal(requested.cancelRequested, true);
  assert.equal(journal.isCancellationRequested(job.id), true);
  assert.throws(() => journal.acknowledgeCancellation("missing-request"), /not found/i);
  const noRequest = journal.createJob({ id: "no-request", type: "work" });
  assert.throws(() => journal.acknowledgeCancellation(noRequest.id), CancellationNotRequestedError);
  const first = journal.appendProgress(job.id, { eventId: "p1", stage: "start", percent: 10 });
  const second = journal.appendProgress(job.id, { eventId: "p2", stage: "middle", progress: 0.5 });
  journal.appendProgress(job.id, { eventId: "p3", stage: "end", progress: 1 });
  assert.deepEqual(journal.listProgress(job.id).map((event) => event.eventId), ["p2", "p3"]);
  assert.deepEqual(journal.appendProgress(job.id, { eventId: "p3", stage: "end", progress: 1 }), journal.listProgress(job.id)[1]);
  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  assert.throws(
    () => journal.appendProgress(job.id, { eventId: "too-large", data: "x".repeat(MAX_PROGRESS_EVENT_BYTES) }),
    /exceeds|payload/i,
  );
  const cancelled = journal.acknowledgeCancellation(job.id);
  assert.equal(cancelled.state, "cancelled");
  assert.throws(() => journal.appendProgress(job.id, { progress: 0 }), RunnerConflictError);

  const queued = journal.createJob({ id: "queued-cancel", type: "work" });
  assert.equal(journal.cancel(queued.id, "not needed").state, "cancelled");
  journal.close();
});

test("governor decisions are deterministic across admission, accounting, and safe preemption", () => {
  const cases: Array<{ name: string; request: ResourceRequestInput; running?: readonly GovernorJob[]; expected: GovernorAction }> = [
    { name: "small request admits", request: { vramMb: 512, ramMb: 512, diskMb: 1 }, expected: "admit" },
    { name: "vram over profile denies", request: { vramMb: 4_097, ramMb: 1, diskMb: 1 }, expected: "deny" },
    { name: "ram over profile denies", request: { vramMb: 1, ramMb: 16_385, diskMb: 1 }, expected: "deny" },
    { name: "disk over profile denies", request: { vramMb: 1, ramMb: 1, diskMb: 32_769 }, expected: "deny" },
    {
      name: "request downshifts before denial",
      request: { vramMb: 8_192, ramMb: 4_096, diskMb: 1, downshifts: [{ vramMb: 2_048, ramMb: 2_048, diskMb: 1 }] },
      expected: "downshift",
    },
    {
      name: "busy resources queue without a safe boundary",
      request: { vramMb: 2_048, ramMb: 1, diskMb: 1 },
      running: [{ jobId: "busy", request: { vramMb: 3_000, ramMb: 1, diskMb: 1 }, priority: "normal", safeBoundary: false }],
      expected: "queue",
    },
    {
      name: "higher priority work preempts only at a safe boundary",
      request: { vramMb: 2_048, ramMb: 1, diskMb: 1 },
      running: [{ jobId: "safe-low", request: { vramMb: 3_000, ramMb: 1, diskMb: 1 }, priority: "batch", safeBoundary: true }],
      expected: "preempt",
    },
  ];
  for (const testCase of cases) {
    const result = decideAdmission(
      REFERENCE_4GB_PROFILE,
      { jobId: testCase.name, request: testCase.request },
      testCase.running === undefined ? {} : { running: testCase.running },
    );
    assert.equal(result.action, testCase.expected, testCase.name);
    assert.equal(result.profile.source, "mock");
  }

  const governor = new ResourceGovernor(REFERENCE_4GB_PROFILE);
  assert.equal(governor.submit({ jobId: "low", request: { vramMb: 3_000, ramMb: 1, diskMb: 1 }, priority: "batch", safeBoundary: true }).action, "admit");
  const queued = governor.submit({ jobId: "high", request: { vramMb: 2_048, ramMb: 1, diskMb: 1 }, priority: "interactive" });
  assert.equal(queued.action, "preempt");
  governor.markSafeBoundary("low");
  const committed = governor.commitPreemption("high");
  assert.equal(committed.action, "admit");
  assert.deepEqual(governor.snapshot().running.map((job) => job.jobId), ["high"]);
  assert.equal(governor.snapshot().usage.vramMb, 2_048);
});

test("governor tracks RAM/disk and priority order without claiming host measurements", () => {
  const governor = new ResourceGovernor({
    id: "tiny-mock",
    kind: "mock",
    source: "mock",
    vramMb: 1_024,
    ramMb: 2_048,
    diskMb: 4_096,
    maxConcurrentJobs: 2,
  });
  assert.equal(governor.submit({ jobId: "batch", priority: "batch", request: { vramMb: 1, ramMb: 1, diskMb: 1 } }).action, "admit");
  assert.equal(governor.submit({ jobId: "interactive", priority: "interactive", request: { vramMb: 1, ramMb: 1, diskMb: 1 } }).action, "admit");
  assert.equal(governor.submit({ jobId: "too-much-ram", request: { vramMb: 1, ramMb: 2_049, diskMb: 1 } }).action, "deny");
  assert.equal(governor.submit({ jobId: "too-much-disk", request: { vramMb: 1, ramMb: 1, diskMb: 4_097 } }).action, "deny");
  assert.deepEqual(governor.snapshot().running.map((job) => job.jobId), ["batch", "interactive"]);
  assert.equal(governor.snapshot().profile.source, "mock");
});

test("database close is explicit and further operations fail with a typed error", () => {
  const databasePath = temporaryDatabase();
  try {
    const journal = new JobJournal(databasePath);
    journal.close();
    assert.throws(() => journal.listJobs(), (error: unknown) => {
      return error instanceof Error && "code" in error && error.code === "RunnerClosed";
    });
  } finally {
    rmSync(path.dirname(databasePath), { recursive: true, force: true });
  }
});
