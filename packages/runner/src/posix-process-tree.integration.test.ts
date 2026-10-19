import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Supervisor, type SupervisorTaskHandle } from "./index.ts";

const WAIT_STEP_MS = 20;
const WAIT_TIMEOUT_MS = 5_000;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

async function waitForGrandchildPid(task: SupervisorTaskHandle): Promise<number> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  const marker = /runner-process-tree-ready:(\d+)/;
  while (Date.now() < deadline) {
    const match = marker.exec(task.getStatus().stdout);
    if (match?.[1] !== undefined) return Number(match[1]);
    const state = task.getStatus().state;
    if (state !== "running") throw new Error("supervisor child exited before readiness");
    await delay(WAIT_STEP_MS);
  }
  throw new Error("supervisor child did not become ready before the deadline");
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (errorCode(error) === "ESRCH") return;
      throw new Error("could not inspect the grandchild process");
    }
    await delay(WAIT_STEP_MS);
  }
  throw new Error("grandchild remained alive after process-group stop");
}

async function settleWithin(task: SupervisorTaskHandle): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, WAIT_TIMEOUT_MS);
    void task.done.then(finish, finish);
  });
}

test(
  "qualifies POSIX process-group termination of a real process tree",
  { skip: process.platform === "win32" ? "POSIX process-group qualification is not supported on Windows" : false },
  async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "lightphysics-runner-tree-"));
    const childScriptPath = path.join(root, "process-tree-child.mjs");
    const childSource = [
      "import { spawn } from \"node:child_process\";",
      "const grandchild = spawn(process.execPath, [\"-e\", \"setInterval(() => {}, 1000);\"], { detached: false, stdio: [\"ignore\", \"ignore\", \"ignore\"] });",
      "if (grandchild.pid === undefined) throw new Error(\"grandchild did not start\");",
      "process.stdout.write(`runner-process-tree-ready:${grandchild.pid}\\n`);",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    let supervisor: Supervisor | undefined;
    let task: SupervisorTaskHandle | undefined;

    try {
      writeFileSync(childScriptPath, childSource, { encoding: "utf8", mode: 0o600 });
      supervisor = new Supervisor({ defaultCwd: root });
      task = supervisor.start({
        id: "posix-process-tree-child",
        command: process.execPath,
        args: [childScriptPath],
        cwd: root,
        stdio: { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
        maxOutputBytes: 1_024,
      });

      const grandchildPid = await waitForGrandchildPid(task);
      const stop = await supervisor.stop(task.id, {
        force: true,
        signal: "SIGKILL",
        reason: "kill_all",
        timeoutMs: WAIT_TIMEOUT_MS,
      });
      const result = await task.done;
      // The first outcome snapshots confirmation before the real close event;
      // the settled stop confirms completion after task.done resolves.
      const confirmation = await supervisor.stop(task.id);

      assert.equal(stop.requested, true);
      assert.equal(stop.accepted, true);
      assert.equal(stop.confirmed || confirmation.confirmed, true);
      assert.equal(confirmation.confirmed, true);
      assert.equal(stop.method, "posix-process-group");
      assert.equal(result.state, "stopped");
      assert.equal(result.reason, "stopped");
      await waitForProcessExit(grandchildPid);
    } finally {
      if (supervisor && task) {
        const state = task.getStatus().state;
        if (state === "running" || state === "stopping") {
          await supervisor.stop(task.id, {
            force: true,
            signal: "SIGKILL",
            reason: "kill_all",
            timeoutMs: WAIT_TIMEOUT_MS,
          }).catch(() => undefined);
        }
        await settleWithin(task);
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
);
