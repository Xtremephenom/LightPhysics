import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import {
  Supervisor,
  SupervisorSensitiveDataError,
  SupervisorSpawnError,
  SupervisorValidationError,
  computeSupervisorBackoff,
  isRetryEligible,
  selectProcessTreeTerminationMethod,
  type SupervisorChild,
  type SupervisorKillRequest,
  type SupervisorProcessTreeKiller,
  type SupervisorSpawner,
} from "./index.ts";

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kills: Array<NodeJS.Signals | number | undefined> = [];
  readonly pid: number;

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.kills.push(signal);
    return true;
  }

  finish(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }
}

function childAsSupervisorChild(child: FakeChild): SupervisorChild {
  return child as unknown as SupervisorChild;
}

function closeOnKill(requests: SupervisorKillRequest[]): SupervisorProcessTreeKiller {
  return (request) => {
    requests.push(request);
    request.child.once("close", () => undefined);
    (request.child as unknown as FakeChild).finish(null, request.signal);
    return { ok: true, method: request.method, reason: "requested" };
  };
}

function spawnFrom(children: readonly FakeChild[], calls: Array<{ command: string; args: readonly string[]; options: unknown }>): SupervisorSpawner {
  let index = 0;
  return (command, args, options) => {
    calls.push({ command, args, options });
    const child = children[index];
    index += 1;
    if (!child) throw new Error("fake child exhausted");
    return childAsSupervisorChild(child);
  };
}

function clock(): () => Date {
  let milliseconds = Date.parse("2026-01-01T00:00:00.000Z");
  return () => new Date(milliseconds += 1_000);
}

test("starts with a command plus argv, shell=false, bounded stdio, and safe env", async () => {
  const child = new FakeChild(101);
  const calls: Array<{ command: string; args: readonly string[]; options: any }> = [];
  const supervisor = new Supervisor({
    spawn: spawnFrom([child], calls),
    killer: closeOnKill([]),
    platform: "linux",
    clock: clock(),
  });

  const task = supervisor.start({
    id: "argv-task",
    command: "tool-with-spaces-safe-as-a-path",
    args: ["--mode", "offline", "value with spaces"],
    cwd: process.cwd(),
    env: { LP_TEST_MODE: "1" },
    stdio: { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.command, "tool-with-spaces-safe-as-a-path");
  assert.deepEqual(calls[0]?.args, ["--mode", "offline", "value with spaces"]);
  assert.equal(calls[0]?.options.shell, false);
  assert.deepEqual(calls[0]?.options.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(calls[0]?.options.detached, true);
  assert.deepEqual(calls[0]?.options.env, { LP_TEST_MODE: "1" });

  child.finish(0);
  const result = await task.done;
  assert.equal(result.reason, "success");
  assert.equal(result.state, "exited");
  assert.equal(supervisor.health("argv-task").health, "healthy");
  assert.throws(
    () => supervisor.start({ id: "not-array", command: "tool", args: "tool --unsafe" as unknown as readonly string[] }),
    SupervisorValidationError,
  );
});

test("turns synchronous spawn failures into typed, path-safe errors", () => {
  const secret = ["sk", "-", "x".repeat(24)].join("");
  const privatePath = ["C", ":/private/"].join("");
  const supervisor = new Supervisor({
    spawn: (() => {
      throw Object.assign(new Error(`failed at ${privatePath}${secret}`), { code: "ENOENT" });
    }) as SupervisorSpawner,
  });
  assert.throws(
    () => supervisor.start({ id: "spawn-failure", command: "missing-tool", args: [] }),
    (error: unknown) => error instanceof SupervisorSpawnError
      && !error.message.includes(secret)
      && !error.message.includes(privatePath),
  );
});

test("reports non-zero exits as unhealthy and keeps bounded output", async () => {
  const child = new FakeChild(102);
  const requests: SupervisorKillRequest[] = [];
  const supervisor = new Supervisor({
    spawn: spawnFrom([child], []),
    killer: closeOnKill(requests),
    platform: "linux",
    clock: clock(),
  });
  const task = supervisor.start({ id: "failed-task", command: "tool", args: [], maxOutputBytes: 8 });
  child.stdout.write("123456789");
  const result = await task.done;
  assert.equal(result.reason, "output_limit");
  assert.equal(result.outputTruncated, true);
  assert.equal(result.outputLimitBytes, 8);
  assert.ok(result.outputBytes > result.outputLimitBytes);
  assert.equal(requests.length, 1);
  assert.equal(supervisor.health("failed-task").health, "unhealthy");
});

test("computes bounded exponential backoff without random jitter", () => {
  assert.equal(computeSupervisorBackoff(1, { baseDelayMs: 10, maxDelayMs: 25 }), 10);
  assert.equal(computeSupervisorBackoff(2, { baseDelayMs: 10, maxDelayMs: 25 }), 20);
  assert.equal(computeSupervisorBackoff(3, { baseDelayMs: 10, maxDelayMs: 25 }), 25);
  assert.equal(computeSupervisorBackoff(16, { baseDelayMs: 10, maxDelayMs: 25 }), 25);
  assert.throws(() => computeSupervisorBackoff(1, { baseDelayMs: 20, maxDelayMs: 10 }), SupervisorValidationError);
  assert.throws(() => computeSupervisorBackoff(1, { baseDelayMs: 1, maxDelayMs: 2, jitterMs: 1 as 0 }), SupervisorValidationError);
});

test("retries only when policy names the observed failure", async () => {
  const first = new FakeChild(103);
  const second = new FakeChild(104);
  const calls: Array<{ command: string; args: readonly string[]; options: unknown }> = [];
  const sleepCalls: number[] = [];
  const children = [first, second];
  const supervisor = new Supervisor({
    spawn: ((command, args, options) => {
      const index = calls.length;
      calls.push({ command, args, options });
      const child = children[index];
      if (!child) throw new Error("fake child exhausted");
      queueMicrotask(() => child.finish(index === 0 ? 9 : 0));
      return childAsSupervisorChild(child);
    }) as SupervisorSpawner,
    killer: closeOnKill([]),
    sleep: (milliseconds) => { sleepCalls.push(milliseconds); },
    clock: clock(),
  });
  const result = await supervisor.run({
    id: "retry-task",
    command: "tool",
    args: [],
    retry: { maxAttempts: 2, retryOn: ["exit_code"], baseDelayMs: 7, maxDelayMs: 7 },
  });
  assert.equal(result.reason, "success");
  assert.equal(result.attempts, 2);
  assert.equal(result.retries, 1);
  assert.deepEqual(result.backoffMs, [7]);
  assert.deepEqual(sleepCalls, [7]);
  assert.equal(calls.length, 2);
  assert.equal(isRetryEligible({ ...result, reason: "exit_code", exitCode: 9 }, { maxAttempts: 2, retryOn: ["exit_code"] }, 1), true);
  assert.equal(isRetryEligible({ ...result, reason: "exit_code", exitCode: 9 }, undefined, 1), false);
});

test("selects Windows tree, POSIX group, and POSIX child strategies through injection", async () => {
  assert.equal(selectProcessTreeTerminationMethod("win32", true), "windows-taskkill-tree");
  assert.equal(selectProcessTreeTerminationMethod("linux", true), "posix-process-group");
  assert.equal(selectProcessTreeTerminationMethod("linux", false), "posix-child");

  const windowsChild = new FakeChild(105);
  const windowsRequests: SupervisorKillRequest[] = [];
  const windows = new Supervisor({
    spawn: spawnFrom([windowsChild], []),
    killer: closeOnKill(windowsRequests),
    platform: "win32",
    clock: clock(),
  });
  windows.start({ id: "windows-task", command: "tool", args: [] });
  const windowsStop = await windows.stop("windows-task");
  assert.equal(windowsStop.method, "windows-taskkill-tree");
  assert.equal(windowsRequests[0]?.processGroup, false);

  const posixChild = new FakeChild(106);
  const posixRequests: SupervisorKillRequest[] = [];
  const posix = new Supervisor({
    spawn: spawnFrom([posixChild], []),
    killer: closeOnKill(posixRequests),
    platform: "linux",
    clock: clock(),
  });
  posix.start({ id: "posix-task", command: "tool", args: [] });
  const posixStop = await posix.stop("posix-task");
  assert.equal(posixStop.method, "posix-process-group");
  assert.equal(posixRequests[0]?.processGroup, true);
});

test("killAll preserves the unavailable Warden outcome without a revocation seam", async () => {
  const first = new FakeChild(107);
  const second = new FakeChild(108);
  const requests: SupervisorKillRequest[] = [];
  const supervisor = new Supervisor({
    killer: closeOnKill(requests),
    platform: "linux",
    clock: clock(),
  });
  supervisor.track("first", childAsSupervisorChild(first));
  supervisor.track("second", childAsSupervisorChild(second));
  const result = await supervisor.killAll({ timeoutMs: 100 });
  assert.equal(result.requested, 2);
  assert.equal(result.accepted, 2);
  assert.equal(result.confirmed, 2);
  assert.equal(result.failed, 0);
  assert.equal(result.outstanding, 0);
  assert.equal(result.outcomes.length, 2);
  assert.equal(result.tokenRevocation.available, false);
  assert.equal(result.tokenRevocation.status, "not_available");
  assert.equal(result.tokenRevocation.reason, "Warden is not implemented in the Runner supervisor");
  assert.equal(requests.length, 2);
  assert.equal(supervisor.health().active, 0);
});

test("killAll invokes token revocation after every process-tree stop succeeds", async () => {
  const child = new FakeChild(109);
  const requests: SupervisorKillRequest[] = [];
  let callbackRequestCount = -1;
  const supervisor = new Supervisor({
    killer: closeOnKill(requests),
    tokenRevocation: () => {
      callbackRequestCount = requests.length;
      return true;
    },
    platform: "linux",
    clock: clock(),
  });
  supervisor.track("tree-task", childAsSupervisorChild(child), { processGroup: true });

  const result = await supervisor.killAll({ timeoutMs: 100 });

  assert.equal(callbackRequestCount, 1);
  assert.equal(requests[0]?.processGroup, true);
  assert.deepEqual(result.tokenRevocation, { available: true, status: "revoked" });
  assert.equal(result.confirmed, 1);
  assert.equal(supervisor.health().active, 0);
});

test("killAll bounds token-revocation failures and does not leak callback errors", async () => {
  const child = new FakeChild(110);
  const requests: SupervisorKillRequest[] = [];
  const secret = "Bearer " + "x".repeat(32);
  const supervisor = new Supervisor({
    killer: closeOnKill(requests),
    tokenRevocation: () => {
      throw new Error(`warden failed with ${secret}`);
    },
    platform: "linux",
    clock: clock(),
  });
  supervisor.track("failed-revocation", childAsSupervisorChild(child));

  const result = await supervisor.killAll({ timeoutMs: 100 });

  assert.deepEqual(result.tokenRevocation, {
    available: true,
    status: "failed",
    reason: "Token revocation callback failed",
  });
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(requests.length, 1);
  assert.equal(result.confirmed, 1);
});

test("rejects sensitive input without echoing secrets or paths", () => {
  const secret = ["Bearer", " ", "x".repeat(24)].join("");
  const supervisor = new Supervisor();
  assert.throws(
    () => supervisor.start({ id: "safe-errors", command: "tool", args: [secret] }),
    (error: unknown) => error instanceof SupervisorSensitiveDataError && !error.message.includes(secret),
  );
  const pathValue = [`C`, `:/private/`, "x".repeat(4_200)].join("");
  assert.throws(
    () => supervisor.start({ id: "cwd-bound", command: "tool", args: [], cwd: pathValue }),
    (error: unknown) => error instanceof SupervisorValidationError && !error.message.includes(pathValue),
  );
  assert.throws(
    () => supervisor.start({ id: "env-secret", command: "tool", args: [], env: { ACCESS_TOKEN: secret } }),
    SupervisorSensitiveDataError,
  );
});
