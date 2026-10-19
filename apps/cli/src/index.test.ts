import { describe, expect, it, vi } from "vitest";
import { mkdir, readFile, readdir, writeFile, mkdtemp, rm } from "node:fs/promises";
import { Writable } from "node:stream";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "@lightphysics/config";
import { ContentAddressedStore, Ledger, verifyLedgerFile } from "@lightphysics/ledger";
import { JobJournal } from "@lightphysics/runner";
import { serverAddress, startServer, type LpdServer } from "../../lpd/src/index.js";
import {
  createCommandHandler,
  runCli,
  type BackupCommandManager,
  type BackupDaemonControl,
  type CommandOptions,
} from "./index.js";

function capture(): { stream: Writable; value: () => string } {
  const chunks: string[] = [];
  return {
    stream: new Writable({ write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    }}),
    value: () => chunks.join(""),
  };
}

describe("CLI command handler", () => {
  it("prints the version without contacting a daemon", async () => {
    const stdout = capture();
    const exitCode = await runCli(["--version"], { stdout: stdout.stream });
    expect(exitCode).toBe(0);
    expect(stdout.value()).toBe("0.1.0\n");
  });

  it("rejects approve and approval commands with exit 2 and no side effect", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "lightphysics-cli-no-approval-"));
    const transport = vi.fn();
    const toolProbe = vi.fn();
    const manager: BackupCommandManager = { create: vi.fn(), verify: vi.fn(), restore: vi.fn() };
    try {
      for (const args of [["approve"], ["approval"], ["approve", "fixture", "--json"], ["approval", "submit", "--json"]]) {
        const stdout = capture();
        const stderr = capture();
        await expect(runCli(args, {
          env: { LP_HOME: home },
          transport,
          toolProbe,
          backupManager: manager,
          stdout: stdout.stream,
          stderr: stderr.stream,
        })).resolves.toBe(2);
        expect(stderr.value()).toBe("Unknown command. Use --version, doctor, or daemon status.\n");
        expect(stdout.value()).toBe("");
      }
      expect(transport).not.toHaveBeenCalled();
      expect(toolProbe).not.toHaveBeenCalled();
      expect(manager.create).not.toHaveBeenCalled();
      expect(manager.verify).not.toHaveBeenCalled();
      expect(manager.restore).not.toHaveBeenCalled();
      expect(await readdir(home)).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("talks to lpd for daemon status and JSON doctor output", async () => {
    const server: LpdServer = await startServer({
      config: loadConfig({ LP_PORT: "4317" }),
      port: 0,
      token: "cli-token",
    });
    const address = serverAddress(server);
    if (!address) throw new Error("server is not listening");
    const options: CommandOptions = {
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "cli-token",
      toolProbe: async () => ({
        node: { status: "available", version: process.version },
        uv: { status: "missing", version: null },
        godot: { status: "unqualified", version: null },
        blender: { status: "error", version: null },
        ffmpeg: { status: "available", version: "7.0.0" },
      }),
    };
    const statusOut = capture();
    const status = await runCli(["daemon", "status", "--json"], {
      ...options,
      stdout: statusOut.stream,
    });
    expect(status).toBe(0);
    expect(JSON.parse(statusOut.value())).toMatchObject({ ok: true, status: "running" });

    const doctorOut = capture();
    const doctor = await createCommandHandler({
      ...options,
      stdout: doctorOut.stream,
    })(["doctor", "--json"]);
    expect(doctor).toBe(0);
    expect(JSON.parse(doctorOut.value())).toMatchObject({
      ok: true,
      daemon: { status: "ok" },
      tools: {
        node: process.version,
        uv: { status: "missing", version: null },
        godot: { status: "unqualified", version: null },
        blender: { status: "error", version: null },
        ffmpeg: { status: "available", version: "7.0.0" },
      },
    });
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it("verifies the persistent Ledger in JSON and text doctor modes", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "lightphysics-cli-ledger-"));
    const env = { ...process.env, LP_HOME: home };
    const toolProbe = async () => ({
      node: { status: "available" as const, version: process.version },
      uv: { status: "missing" as const, version: null },
      godot: { status: "missing" as const, version: null },
      blender: { status: "missing" as const, version: null },
      ffmpeg: { status: "missing" as const, version: null },
    });
    const transport = async () => ({
      jsonrpc: "2.0",
      id: 1,
      result: {
        name: "lpd",
        version: "0.1.0",
        nodeVersion: process.version,
        platform: process.platform,
        pid: process.pid,
        uptimeSeconds: 0,
      },
    });
    const ledger = new Ledger({ home });
    ledger.appendAudit("doctor-test", { action: "test" }, { timestamp: "2026-01-01T00:00:00.000Z" });
    ledger.close();
    try {
      const jsonOut = capture();
      await expect(runCli(["doctor", "--verify-chain", "--json"], {
        env,
        transport,
        toolProbe,
        stdout: jsonOut.stream,
      })).resolves.toBe(0);
      expect(JSON.parse(jsonOut.value())).toMatchObject({
        ok: true,
        ledger: { status: "verified", ok: true, checkedRecords: 1 },
      });

      const textOut = capture();
      await expect(runCli(["doctor", "--verify-chain"], {
        env,
        transport,
        toolProbe,
        stdout: textOut.stream,
      })).resolves.toBe(0);
      expect(textOut.value()).toContain("Ledger: verified");

      const tampered = new Ledger({ home });
      tampered.db.exec("DROP TRIGGER ledger_records_no_update");
      tampered.db.prepare("UPDATE ledger_records SET payload_json = ? WHERE sequence = 1").run('{"edited":true}');
      tampered.close();
      const invalidOut = capture();
      await expect(runCli(["doctor", "--verify-chain", "--json"], {
        env,
        transport,
        toolProbe,
        stdout: invalidOut.stream,
      })).resolves.toBe(1);
      expect(JSON.parse(invalidOut.value())).toMatchObject({
        ok: false,
        ledger: { status: "invalid", ok: false },
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("reports an uninitialized Ledger as typed unavailable in doctor JSON and text", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "lightphysics-cli-ledger-missing-"));
    const env = { ...process.env, LP_HOME: home };
    const transport = async () => ({
      jsonrpc: "2.0",
      id: 1,
      result: {
        name: "lpd",
        version: "0.1.0",
        nodeVersion: process.version,
        platform: process.platform,
        pid: process.pid,
        uptimeSeconds: 0,
      },
    });
    try {
      const jsonOut = capture();
      await expect(runCli(["doctor", "--verify-chain", "--json"], {
        env,
        transport,
        toolProbe: async () => ({
          node: { status: "available" as const, version: process.version },
          uv: { status: "missing" as const, version: null },
          godot: { status: "missing" as const, version: null },
          blender: { status: "missing" as const, version: null },
          ffmpeg: { status: "missing" as const, version: null },
        }),
        stdout: jsonOut.stream,
      })).resolves.toBe(1);
      expect(JSON.parse(jsonOut.value())).toMatchObject({
        ok: false,
        ledger: { status: "unavailable", code: "LedgerUnavailable", ok: false },
      });

      const textOut = capture();
      const stderrOut = capture();
      await expect(runCli(["doctor", "--verify-chain"], {
        env,
        transport,
        toolProbe: async () => ({
          node: { status: "available" as const, version: process.version },
          uv: { status: "missing" as const, version: null },
          godot: { status: "missing" as const, version: null },
          blender: { status: "missing" as const, version: null },
          ffmpeg: { status: "missing" as const, version: null },
        }),
        stdout: textOut.stream,
        stderr: stderrOut.stream,
      })).resolves.toBe(1);
      expect(textOut.value()).toContain("Ledger: unavailable");
      expect(stderrOut.value()).toContain("LedgerUnavailable");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("creates, verifies, and restores a complete offline backup through lp backup", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lightphysics-cli-backup-"));
    const home = path.join(root, "home");
    const backup = path.join(root, "backup");
    const restoredHome = path.join(root, "restored-home");
    const env = { ...process.env, LP_HOME: home };
    const ledger = new Ledger({ home, now: () => "2026-01-01T00:00:00.000Z" });
    ledger.appendAudit("backup-audit", { action: "fixture" }, { timestamp: "2026-01-01T00:00:00.000Z" });
    ledger.close();
    const journal = new JobJournal({ home, clock: () => new Date("2026-01-01T00:00:00.000Z") });
    journal.createJob({ id: "backup-job", type: "fixture", payload: { value: "before" } });
    journal.close();
    const cas = new ContentAddressedStore({ home });
    const casHash = cas.put("cas-fixture");
    await writeFile(path.join(home, "settings.json"), '{"apiKey":"sk-do-not-copy-this-value","name":"fixture"}\n', "utf8");
    await writeFile(path.join(home, ".env"), "LP_TOKEN=do-not-copy\n", "utf8");

    try {
      const createOut = capture();
      await expect(runCli(["backup", "create", "--destination", backup, "--config", "settings.json", "--config", ".env", "--json"], {
        env,
        stdout: createOut.stream,
      })).resolves.toBe(0);
      const created = JSON.parse(createOut.value()) as { ok: boolean; result: { manifest: { entries: Array<{ category: string; redacted?: boolean }>; omitted: unknown[] } } };
      expect(created.ok).toBe(true);
      expect(created.result.manifest.entries.some((entry) => entry.category === "config" && entry.redacted === true)).toBe(true);
      expect(created.result.manifest.omitted).toHaveLength(1);
      expect(await readFile(path.join(backup, "config", "settings.json"), "utf8")).not.toContain("sk-do-not-copy");
      expect(await readFile(path.join(backup, "manifest.json"), "utf8")).not.toContain("do-not-copy");

      const verifyOut = capture();
      await expect(runCli(["backup", "verify", backup, "--json"], { stdout: verifyOut.stream })).resolves.toBe(0);
      expect(JSON.parse(verifyOut.value())).toMatchObject({ ok: true, operation: "verify", result: { filesChecked: 4 } });

      await rm(home, { recursive: true, force: true });
      const restoreOut = capture();
      await expect(runCli(["backup", "restore", "--from", backup, "--to", restoredHome, "--json"], {
        stdout: restoreOut.stream,
      })).resolves.toBe(0);
      expect(JSON.parse(restoreOut.value())).toMatchObject({ ok: true, operation: "restore" });
      expect(await readFile(path.join(restoredHome, "db", "ledger.sqlite"))).toEqual(await readFile(path.join(backup, "databases", "ledger.sqlite")));
      expect(await readFile(path.join(restoredHome, "db", "runner.sqlite"))).toEqual(await readFile(path.join(backup, "databases", "runner.sqlite")));
      expect(await readFile(path.join(restoredHome, "store", "sha256", casHash.slice(0, 2), casHash.slice(2)), "utf8")).toBe("cas-fixture");
      expect(await readFile(path.join(restoredHome, "settings.json"), "utf8")).not.toMatch(/apiKey|sk-do-not-copy/);
      await expect(readFile(path.join(restoredHome, ".env"))).rejects.toMatchObject({ code: "ENOENT" });

      const conflictOut = capture();
      await expect(runCli(["backup", "restore", "--from", backup, "--to", restoredHome, "--json"], {
        stdout: conflictOut.stream,
      })).resolves.toBe(1);
      expect(JSON.parse(conflictOut.value())).toMatchObject({ ok: false, error: { code: "BackupConflict" } });

      const restoredLedger = verifyLedgerFile(path.join(restoredHome, "db", "ledger.sqlite"));
      expect(restoredLedger).toMatchObject({ ok: true, status: "verified", checkedRecords: 1 });
      const restoredJournal = new JobJournal({ databasePath: path.join(restoredHome, "db", "runner.sqlite") });
      expect(restoredJournal.getJob("backup-job")).toMatchObject({ id: "backup-job", state: "queued" });
      restoredJournal.close();
      const restoredCas = new ContentAddressedStore({ home: restoredHome });
      expect(restoredCas.get(casHash).toString("utf8")).toBe("cas-fixture");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses create and restore while the configured LP_HOME daemon PID is active", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lightphysics-cli-quiescence-active-"));
    const home = path.join(root, "home");
    const env = { ...process.env, LP_HOME: home };
    await mkdir(path.join(home, "run"), { recursive: true });
    await writeFile(path.join(home, "run", "lpd.pid"), `${process.pid}\n`, "utf8");
    const create = vi.fn();
    const restore = vi.fn();
    const manager: BackupCommandManager = {
      create,
      verify: vi.fn(),
      restore,
    };

    try {
      const createOut = capture();
      await expect(runCli(["backup", "create", "--destination", path.join(root, "backup"), "--json"], {
        env,
        backupManager: manager,
        stdout: createOut.stream,
      })).resolves.toBe(1);
      expect(create).not.toHaveBeenCalled();
      expect(JSON.parse(createOut.value())).toMatchObject({
        ok: false,
        operation: "create",
        error: { code: "BackupDaemonActive" },
      });

      const restoreOut = capture();
      await expect(runCli(["backup", "restore", "--from", path.join(root, "backup"), "--to", home, "--json"], {
        env,
        backupManager: manager,
        stdout: restoreOut.stream,
      })).resolves.toBe(1);
      expect(restore).not.toHaveBeenCalled();
      expect(JSON.parse(restoreOut.value())).toMatchObject({
        ok: false,
        operation: "restore",
        error: { code: "BackupDaemonActive" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("quiesces an active daemon only when backup explicitly requests it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lightphysics-cli-quiescence-requested-"));
    const home = path.join(root, "home");
    const pidFile = path.join(home, "run", "lpd.pid");
    const env = { ...process.env, LP_HOME: home };
    await mkdir(path.dirname(pidFile), { recursive: true });
    await writeFile(pidFile, "4242\n", "utf8");
    const manager: BackupCommandManager = {
      create: vi.fn(() => ({ ok: true } as never)),
      verify: vi.fn(),
      restore: vi.fn(),
    };
    const terminate = vi.fn();
    const waitForExit = vi.fn(async () => true);
    const control: BackupDaemonControl = {
      isAlive: (pid) => pid === 4242,
      terminate,
      waitForExit,
    };

    try {
      const output = capture();
      await expect(runCli(["backup", "create", "--destination", path.join(root, "backup"), "--quiesce", "--json"], {
        env,
        backupManager: manager,
        backupDaemonControl: control,
        stdout: output.stream,
      })).resolves.toBe(0);
      expect(terminate).toHaveBeenCalledWith(4242);
      expect(waitForExit).toHaveBeenCalledWith(4242, 5_000);
      expect(manager.create).toHaveBeenCalledTimes(1);
      await expect(readFile(pidFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps create usable with missing or stale PID files and verify does not quiesce", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lightphysics-cli-quiescence-stale-"));
    const home = path.join(root, "home");
    const env = { ...process.env, LP_HOME: home };
    const create = vi.fn(() => ({} as never));
    const verify = vi.fn(() => ({
      ok: true,
      valid: true,
      destination: path.join(root, "backup"),
      filesChecked: 0,
      bytesChecked: 0,
      issues: [],
    }));
    const manager: BackupCommandManager = {
      create,
      verify,
      restore: vi.fn(),
    };

    try {
      const missingOut = capture();
      await expect(runCli(["backup", "create", "--destination", path.join(root, "missing-backup"), "--json"], {
        env,
        backupManager: manager,
        stdout: missingOut.stream,
      })).resolves.toBe(0);
      expect(create).toHaveBeenCalledTimes(1);

      await mkdir(path.join(home, "run"), { recursive: true });
      await writeFile(path.join(home, "run", "lpd.pid"), "2147483647\n", "utf8");
      const staleOut = capture();
      await expect(runCli(["backup", "create", "--destination", path.join(root, "stale-backup"), "--json"], {
        env,
        backupManager: manager,
        stdout: staleOut.stream,
      })).resolves.toBe(0);
      expect(create).toHaveBeenCalledTimes(2);

      await writeFile(path.join(home, "run", "lpd.pid"), `${process.pid}\n`, "utf8");
      const verifyOut = capture();
      await expect(runCli(["backup", "verify", path.join(root, "backup"), "--json"], {
        env,
        backupManager: manager,
        stdout: verifyOut.stream,
      })).resolves.toBe(0);
      expect(verify).toHaveBeenCalledWith({ destination: path.join(root, "backup") });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs the memory facade commands without contacting lpd", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lightphysics-cli-memory-"));
    try {
      const initOut = capture();
      await expect(runCli(["init", root, "--json"], { stdout: initOut.stream })).resolves.toBe(0);
      expect(JSON.parse(initOut.value())).toMatchObject({ root });
      const indexOut = capture();
      await expect(runCli(["project", "reindex", root], { stdout: indexOut.stream })).resolves.toBe(0);
      expect(JSON.parse(indexOut.value())).toMatchObject({ documents: expect.any(Number) });
      const resumeOut = capture();
      await expect(runCli(["resume", root, "--json"], { stdout: resumeOut.stream })).resolves.toBe(0);
      expect(JSON.parse(resumeOut.value())).toMatchObject({ stage: "pre-production", nextActions: expect.any(Array) });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
