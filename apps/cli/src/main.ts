#!/usr/bin/env node

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Writable } from "node:stream";
import {
  createRpcClient,
  runCli,
  CLI_VERSION,
  type CommandOptions,
} from "@lightphysics/cli";
import {
  getBearerToken,
  loadConfig,
  type LightPhysicsConfig,
} from "@lightphysics/config";

const HELP = `Usage: lp <command>\n\nCommands:\n  --version             Print the CLI version\n  init [path]           Create a game-repo memory layout\n  project reindex [path]  Rebuild the project memory index\n  project resume [path]   Print the bounded project resume brief\n  resume [path]          Alias for project resume\n  doctor [--json] [--verify-chain]  Check the live daemon, local tools, and Ledger\n  daemon status         Query the live daemon\n  daemon start          Start lpd and record its PID\n  daemon stop           Stop the PID recorded for lpd\n  backup --help         Create, verify, or restore an LP_HOME backup\n`;
const PID_FILE_NAME = "lpd.pid";
const START_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 50;

export type LpCommandErrorCode =
  | "MissingToken"
  | "DaemonAlreadyRunning"
  | "InvalidPidFile"
  | "DaemonStartFailed"
  | "DaemonStopFailed";

export class LpCommandError extends Error {
  readonly code: LpCommandErrorCode;
  readonly suggestedNext: string | undefined;

  constructor(
    code: LpCommandErrorCode,
    message: string,
    suggestedNext?: string,
  ) {
    super(message);
    this.name = "LpCommandError";
    this.code = code;
    this.suggestedNext = suggestedNext;
  }
}

export interface LpRunOptions {
  env?: NodeJS.ProcessEnv;
  stdout?: Writable;
  stderr?: Writable;
}

export function pidFilePath(config: LightPhysicsConfig): string {
  return path.join(config.home, "run", PID_FILE_NAME);
}

function write(stream: Writable | undefined, text: string): void {
  (stream ?? process.stdout).write(text);
}

function writeError(stream: Writable | undefined, error: unknown): void {
  if (error instanceof LpCommandError) {
    const next = error.suggestedNext ? ` ${error.suggestedNext}` : "";
    write(stream ?? process.stderr, `${error.name} [${error.code}]: ${error.message}${next}\n`);
    return;
  }
  write(stream ?? process.stderr, `${error instanceof Error ? error.message : String(error)}\n`);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errnoCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

async function removeFileIfPresent(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") throw error;
  }
}

async function readPidFile(filePath: string): Promise<number | null> {
  let contents: string;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    throw error;
  }
  const value = contents.trim();
  if (!/^\d+$/.test(value)) {
    throw new LpCommandError(
      "InvalidPidFile",
      `PID file ${filePath} does not contain a positive process id`,
      "Remove the invalid PID file and retry.",
    );
  }
  const pid = Number(value);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new LpCommandError(
      "InvalidPidFile",
      `PID file ${filePath} does not contain a positive process id`,
      "Remove the invalid PID file and retry.",
    );
  }
  return pid;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errnoCode(error) === "EPERM";
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processIsAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await sleep(POLL_INTERVAL_MS);
  }
  return true;
}

function workspaceRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

function lpdEntryPoint(): string {
  return path.join(workspaceRoot(), "apps", "lpd", "src", "main.ts");
}

function spawnLpd(env: NodeJS.ProcessEnv): ChildProcess {
  const args = ["--experimental-strip-types", lpdEntryPoint()];
  const spawnOptions: SpawnOptions = {
    // Keep the daemon attached to the caller's game repository so its
    // project-memory methods observe the same source-of-truth files as `lp`.
    // The entry point remains workspace-resolved for local development.
    cwd: process.cwd(),
    env,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  };
  const child = spawn(process.execPath, args, spawnOptions);
  // A detached child can report an asynchronous spawn failure. Consume the
  // event so the wrapper can turn it into the typed readiness error below.
  child.once("error", () => undefined);
  return child;
}

async function daemonResponds(env: NodeJS.ProcessEnv, token: string): Promise<boolean> {
  try {
    const response = await createRpcClient({ env, token, timeoutMs: 250 }).call("system.ping");
    return "result" in response;
  } catch {
    return false;
  }
}

async function waitForDaemon(
  pid: number,
  env: NodeJS.ProcessEnv,
  token: string,
): Promise<boolean> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await daemonResponds(env, token)) return true;
    if (!processIsAlive(pid)) return false;
    await sleep(POLL_INTERVAL_MS);
  }
  return await daemonResponds(env, token);
}

async function startDaemon(options: LpRunOptions): Promise<number> {
  const env = options.env ?? process.env;
  const token = getBearerToken(env);
  if (!token) {
    throw new LpCommandError(
      "MissingToken",
      "LP_TOKEN is required for daemon start; refusing to launch lpd with an inaccessible generated token",
      "Set LP_TOKEN in the environment and retry. The bearer token is never written to the PID file.",
    );
  }

  const config = loadConfig(env);
  const filePath = pidFilePath(config);
  const existingPid = await readPidFile(filePath);
  if (existingPid !== null) {
    if (processIsAlive(existingPid)) {
      throw new LpCommandError(
        "DaemonAlreadyRunning",
        `lpd is already running with PID ${existingPid}`,
        "Run lp daemon status or lp daemon stop first.",
      );
    }
    await removeFileIfPresent(filePath);
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  const childEnv: NodeJS.ProcessEnv = { ...env, LP_TOKEN: token };
  let child: ChildProcess;
  try {
    child = spawnLpd(childEnv);
  } catch (error) {
    throw new LpCommandError(
      "DaemonStartFailed",
      `Unable to spawn lpd: ${error instanceof Error ? error.message : String(error)}`,
      "Check the Node runtime and workspace installation, then retry.",
    );
  }
  const pid = child.pid;
  if (!pid) {
    throw new LpCommandError(
      "DaemonStartFailed",
      "Unable to start lpd because the child process did not expose a PID",
      "Check the Node runtime and workspace installation, then retry.",
    );
  }

  try {
    await writeFile(filePath, `${pid}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // The process may have exited while the PID file was being written.
    }
    if (errnoCode(error) === "EEXIST") {
      throw new LpCommandError(
        "DaemonAlreadyRunning",
        `PID file ${filePath} was created by another start attempt`,
        "Run lp daemon status or lp daemon stop first.",
      );
    }
    throw error;
  }

  child.unref();
  if (!(await waitForDaemon(pid, childEnv, token))) {
    await removeFileIfPresent(filePath);
    if (processIsAlive(pid)) {
      try {
        process.kill(pid, "SIGTERM");
        await waitForExit(pid, 1_000);
      } catch {
        // The readiness error below remains the actionable result.
      }
    }
    throw new LpCommandError(
      "DaemonStartFailed",
      `lpd did not become ready on the configured endpoint (PID ${pid})`,
      "Run lp doctor for the daemon error, then check LP_BIND and LP_PORT before retrying.",
    );
  }

  write(options.stdout, `Daemon started (pid ${pid})\n`);
  return 0;
}

async function stopDaemon(options: LpRunOptions): Promise<number> {
  const env = options.env ?? process.env;
  const config = loadConfig(env);
  const filePath = pidFilePath(config);
  const pid = await readPidFile(filePath);
  if (pid === null) {
    write(options.stdout, "Daemon stopped (no PID file)\n");
    return 0;
  }
  if (!processIsAlive(pid)) {
    await removeFileIfPresent(filePath);
    write(options.stdout, `Daemon stopped (stale pid ${pid} removed)\n`);
    return 0;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    throw new LpCommandError(
      "DaemonStopFailed",
      `Unable to signal lpd with PID ${pid}: ${error instanceof Error ? error.message : String(error)}`,
      "Run lp daemon status and stop the process using the operating system if necessary.",
    );
  }
  if (!(await waitForExit(pid, STOP_TIMEOUT_MS))) {
    throw new LpCommandError(
      "DaemonStopFailed",
      `lpd with PID ${pid} did not stop after SIGTERM; the PID file was retained`,
      "Inspect the daemon and stop it manually before retrying.",
    );
  }
  await removeFileIfPresent(filePath);
  write(options.stdout, `Daemon stopped (pid ${pid})\n`);
  return 0;
}

function commandOptions(options: LpRunOptions): CommandOptions {
  const result: CommandOptions = {};
  if (options.env !== undefined) result.env = options.env;
  if (options.stdout !== undefined) result.stdout = options.stdout;
  if (options.stderr !== undefined) result.stderr = options.stderr;
  return result;
}

function isDaemonCommand(args: readonly string[], action: string): boolean {
  return args[0] === "daemon" && args[1] === action;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && path.resolve(entry) === fileURLToPath(import.meta.url);
}

export async function runLp(
  argv: readonly string[] = process.argv.slice(2),
  options: LpRunOptions = {},
): Promise<number> {
  const args = [...argv];
  while (args[0] === "--") args.shift();
  if (args[0] === "lp") args.shift();
  if (args.includes("--version") || args.includes("-v")) {
    return runCli(args, { ...commandOptions(options), version: CLI_VERSION });
  }
  if (args[0] === "backup") return runCli(args, commandOptions(options));
  if (args.includes("--help") || args.includes("-h")) {
    write(options.stdout, HELP);
    return 0;
  }
  if (isDaemonCommand(args, "start")) return startDaemon(options);
  if (isDaemonCommand(args, "stop")) return stopDaemon(options);
  return runCli(args, commandOptions(options));
}

if (isMainModule()) {
  runLp().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error: unknown) => {
      writeError(undefined, error);
      process.exitCode = 1;
    },
  );
}
