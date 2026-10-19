import http from "node:http";
import https from "node:https";
import { open, unlink } from "node:fs/promises";
import type { IncomingMessage, RequestOptions } from "node:http";
import type { Writable } from "node:stream";
import path from "node:path";
import { URL } from "node:url";
import {
  getBearerToken,
  loadConfig,
  type LightPhysicsConfig,
} from "@lightphysics/config";
import {
  JsonRpcResponseSchema,
  SystemInfoResultSchema,
  SystemPingResultSchema,
  type JsonRpcResponse,
  type SystemInfoResult,
  type SystemPingResult,
} from "@lightphysics/schemas";
import {
  ledgerDatabasePath,
  verifyLedgerFile,
  type LedgerVerificationResult,
  type LedgerUnavailableResult,
} from "@lightphysics/ledger";
import {
  BackupManager,
  type BackupRequest,
  type BackupResult,
  type BackupVerification,
  type RestoreBackupResult,
} from "@lightphysics/runner";
import { probeLocalTools, type LocalToolProbe, type LocalToolProbes } from "@lightphysics/cli/tools";
import { initProject, projectResume, reindexProject, renderResumeBrief } from "@lightphysics/memory";

export {
  parseCompactVersion,
  probeLocalTool,
  probeLocalTools,
} from "@lightphysics/cli/tools";
export type {
  LocalToolName,
  LocalToolProbe,
  LocalToolProbeStatus,
  LocalToolProbes,
  ProbeLocalToolOptions,
  ToolCommand,
  ToolDefinition,
  ToolSpawner,
} from "@lightphysics/cli/tools";

export const CLI_VERSION = "0.1.0";
const MAX_RESPONSE_BYTES = 1_048_576;

export interface CliIO {
  stdout?: Writable;
  stderr?: Writable;
}

export interface RpcClientOptions {
  config?: LightPhysicsConfig;
  env?: NodeJS.ProcessEnv;
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
}

export interface RpcCallPayload {
  url: string;
  token?: string | undefined;
  payload: unknown;
  timeoutMs: number;
}

export type RpcTransport = (payload: RpcCallPayload) => Promise<unknown>;

export interface CommandOptions extends RpcClientOptions, CliIO {
  version?: string;
  transport?: RpcTransport;
  toolProbe?: () => Promise<LocalToolProbes>;
  /** Optional deterministic backup seam for CLI tests and embedders. */
  backupManager?: BackupCommandManager;
  /** Optional process-control seam for deterministic daemon-quiescence tests. */
  backupDaemonControl?: BackupDaemonControl;
}

function positionalArgs(args: readonly string[]): readonly string[] {
  return args.filter((arg) => !arg.startsWith("--"));
}

function projectPath(args: readonly string[], index: number): string {
  return positionalArgs(args)[index] ?? process.cwd();
}

async function memoryCommand(args: readonly string[], options: CommandOptions): Promise<number> {
  const json = hasFlag(args, "--json");
  const positionals = positionalArgs(args);
  try {
    if (positionals[0] === "init") {
      if (positionals.length > 2) throw new Error("lp init accepts at most one project path");
      const result = await initProject(projectPath(args, 1));
      output(options.stdout, json ? `${JSON.stringify(result)}\n` : `Initialized project at ${result.root}\nCreated: ${result.created.length}\n`);
      return 0;
    }
    if (positionals[0] === "resume") {
      if (positionals.length > 2) throw new Error("lp resume accepts at most one project path");
      const brief = await projectResume(projectPath(args, 1));
      output(options.stdout, json ? `${JSON.stringify(brief)}\n` : `${renderResumeBrief(brief)}\n`);
      return 0;
    }
    if (positionals[0] !== "project") return -1;
    if (positionals[1] === "reindex") {
      if (positionals.length > 3) throw new Error("lp project reindex accepts at most one project path");
      const result = await reindexProject(projectPath(args, 2));
      output(options.stdout, `${JSON.stringify(result)}\n`);
      return 0;
    }
    if (positionals[1] === "resume") {
      if (positionals.length > 3) throw new Error("lp project resume accepts at most one project path");
      const brief = await projectResume(projectPath(args, 2));
      output(options.stdout, json ? `${JSON.stringify(brief)}\n` : `${renderResumeBrief(brief)}\n`);
      return 0;
    }
    throw new Error("expected lp project reindex|resume");
  } catch (error) {
    output(options.stderr, `${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

export interface BackupCommandManager {
  create(input: BackupRequest): BackupResult;
  verify(input: { readonly destination: string }): BackupVerification;
  restore(input: { readonly destination: string; readonly destinationRoot: string; readonly overwrite?: boolean }): RestoreBackupResult;
}

export type BackupOperation = "create" | "verify" | "restore";

export interface BackupCommandReport {
  readonly ok: boolean;
  readonly operation: BackupOperation;
  readonly result?: BackupResult | BackupVerification | RestoreBackupResult;
  readonly error?: { readonly code: string; readonly message: string };
}

export class CliTransportError extends Error {
  readonly code = "ResourceUnavailable" as const;

  constructor(message: string) {
    super(message);
    this.name = "CliTransportError";
  }
}

const BACKUP_PID_FILE_MAX_BYTES = 64;
const MAX_PORTABLE_PID = 0x7fffffff;
const BACKUP_QUIESCE_TIMEOUT_MS = 5_000;

export class BackupDaemonActiveError extends Error {
  readonly code = "BackupDaemonActive" as const;
  readonly suggestedNext = "Run lp daemon stop, then retry the backup operation.";

  constructor(operation: "create" | "restore", pid: number) {
    super(`Cannot ${operation} a backup while lpd is active with PID ${pid}. Run lp daemon stop, then retry.`);
    this.name = "BackupDaemonActiveError";
  }
}

export class BackupDaemonQuiesceError extends Error {
  readonly code = "BackupDaemonQuiesceFailed" as const;
  readonly suggestedNext = "Run lp daemon stop, verify that lpd has exited, then retry the backup operation.";

  constructor(operation: "create" | "restore") {
    super(`Cannot ${operation} a backup because lpd did not quiesce within the bounded shutdown window`);
    this.name = "BackupDaemonQuiesceError";
  }
}

class BackupPidFileError extends Error {
  readonly code = "BackupPidFileInvalid" as const;
  readonly suggestedNext = "Stop lpd if necessary, remove the invalid PID file, then retry.";

  constructor(filePath: string) {
    super(`PID file ${filePath} does not contain a bounded positive process id`);
    this.name = "BackupPidFileError";
  }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;
}

async function readBackupPid(filePath: string): Promise<number | null> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(filePath, "r");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }

  try {
    const bytes = Buffer.alloc(BACKUP_PID_FILE_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > BACKUP_PID_FILE_MAX_BYTES) throw new BackupPidFileError(filePath);
    const value = bytes.subarray(0, bytesRead).toString("utf8").trim();
    if (!/^\d{1,10}$/.test(value)) throw new BackupPidFileError(filePath);
    const pid = Number(value);
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid > MAX_PORTABLE_PID) {
      throw new BackupPidFileError(filePath);
    }
    return pid;
  } finally {
    await handle.close();
  }
}

async function removeBackupPidFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

export interface BackupDaemonControl {
  readonly isAlive?: (pid: number) => boolean;
  readonly terminate?: (pid: number) => void;
  readonly waitForExit?: (pid: number, timeoutMs: number) => Promise<boolean>;
  readonly removePidFile?: (filePath: string) => Promise<void>;
}

async function waitForBackupDaemonExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processIsAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

async function assertBackupDaemonQuiescent(
  home: string,
  operation: "create" | "restore",
  quiesce: boolean,
  control: BackupDaemonControl = {},
): Promise<void> {
  const pidFile = path.join(home, "run", "lpd.pid");
  const pid = await readBackupPid(pidFile);
  if (pid === null) return;
  const alive = control.isAlive ?? processIsAlive;
  if (!alive(pid)) {
    await (control.removePidFile ?? removeBackupPidFile)(pidFile);
    return;
  }
  if (!quiesce) throw new BackupDaemonActiveError(operation, pid);

  try {
    (control.terminate ?? ((value: number) => process.kill(value, "SIGTERM")))(pid);
  } catch {
    throw new BackupDaemonQuiesceError(operation);
  }
  const exited = await (control.waitForExit ?? waitForBackupDaemonExit)(pid, BACKUP_QUIESCE_TIMEOUT_MS);
  if (!exited) throw new BackupDaemonQuiesceError(operation);
  await (control.removePidFile ?? removeBackupPidFile)(pidFile);
}

function output(stream: Writable | undefined, text: string): void {
  (stream ?? process.stdout).write(text);
}

function configUrl(config: LightPhysicsConfig): string {
  let host = config.bind;
  if (host === "0.0.0.0") host = "127.0.0.1";
  if (host === "::1" || host === "[::1]") host = "[::1]";
  if (host.includes(":") && !host.startsWith("[")) host = `[${host}]`;
  return `http://${host}:${config.port}`;
}

function rpcUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.pathname = "/rpc";
  url.search = "";
  return url.toString();
}

function readResponse(response: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    response.setEncoding("utf8");
    response.on("data", (chunk: string) => {
      total += Buffer.byteLength(chunk);
      if (total > MAX_RESPONSE_BYTES) {
        reject(new CliTransportError("Daemon response is too large"));
        response.destroy();
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    response.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    response.once("error", reject);
  });
}

async function defaultTransport({
  url,
  token,
  payload,
  timeoutMs,
}: RpcCallPayload): Promise<unknown> {
  const target = new URL(url);
  const body = JSON.stringify(payload);
  const requestOptions: RequestOptions = {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port,
    path: `${target.pathname}${target.search}`,
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  };
  const requestFunction = target.protocol === "https:" ? https.request : http.request;
  return new Promise((resolve, reject) => {
    const req = requestFunction(requestOptions, async (response) => {
      try {
        const text = await readResponse(response);
        if (!text) throw new CliTransportError("Daemon returned an empty response");
        let parsed: unknown;
        try {
          parsed = JSON.parse(text) as unknown;
        } catch {
          throw new CliTransportError("Daemon returned invalid JSON");
        }
        resolve(parsed);
      } catch (error) {
        reject(error);
      }
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new CliTransportError("Timed out waiting for the daemon"));
    });
    req.once("error", (error) => {
      reject(
        error instanceof CliTransportError
          ? error
          : new CliTransportError("Unable to connect to the LightPhysics daemon"),
      );
    });
    req.end(body);
  });
}

export function createRpcClient(options: RpcClientOptions = {}): {
  call(method: string, params?: unknown): Promise<JsonRpcResponse>;
} {
  const config = options.config ?? loadConfig(options.env);
  const url = rpcUrl(options.baseUrl ?? configUrl(config));
  const token = options.token ?? getBearerToken(options.env);
  const timeoutMs = options.timeoutMs ?? 2_000;
  return {
    async call(method: string, params: unknown = {}): Promise<JsonRpcResponse> {
      const raw = await defaultTransport({
        url,
        token,
        payload: { jsonrpc: "2.0", id: 1, method, params },
        timeoutMs,
      });
      const parsed = JsonRpcResponseSchema.safeParse(raw);
      if (!parsed.success) throw new CliTransportError("Daemon returned an invalid RPC response");
      return parsed.data;
    },
  };
}

async function callWithOptions(
  method: string,
  params: unknown,
  options: CommandOptions,
): Promise<JsonRpcResponse> {
  const config = options.config ?? loadConfig(options.env);
  const url = rpcUrl(options.baseUrl ?? configUrl(config));
  const token = options.token ?? getBearerToken(options.env);
  const raw = await (options.transport ?? defaultTransport)({
    url,
    token,
    payload: { jsonrpc: "2.0", id: 1, method, params },
    timeoutMs: options.timeoutMs ?? 2_000,
  });
  const parsed = JsonRpcResponseSchema.safeParse(raw);
  if (!parsed.success) throw new CliTransportError("Daemon returned an invalid RPC response");
  return parsed.data;
}

export interface DoctorReport {
  ok: boolean;
  daemon: {
    status: "ok" | "error";
    info?: SystemInfoResult;
    error?: string;
  };
  tools: {
    node: string;
    uv: LocalToolProbe;
    godot: LocalToolProbe;
    blender: LocalToolProbe;
    ffmpeg: LocalToolProbe;
  };
  ledger?: LedgerVerificationReport;
}

export type LedgerVerificationReport =
  | (LedgerVerificationResult & { database: string })
  | (LedgerUnavailableResult & { database: string });

function failedToolProbe(): LocalToolProbe {
  return { status: "error", version: null };
}

async function doctorTools(options: CommandOptions): Promise<DoctorReport["tools"]> {
  let probes: LocalToolProbes;
  try {
    probes = options.toolProbe
      ? await options.toolProbe()
      : await probeLocalTools(options.env === undefined ? {} : { env: options.env });
  } catch {
    // A probe failure must never hide the daemon result or expose a child
    // process error. Keep the report structured and honest instead.
    probes = {
      node: failedToolProbe(),
      uv: failedToolProbe(),
      godot: failedToolProbe(),
      blender: failedToolProbe(),
      ffmpeg: failedToolProbe(),
    };
  }
  return {
    // `tools.node` was the original doctor contract. Keep it as a compact
    // version string while the other local tools use typed probe records.
    node: probes.node.version ?? process.version,
    uv: probes.uv,
    godot: probes.godot,
    blender: probes.blender,
    ffmpeg: probes.ffmpeg,
  };
}

function doctorLedger(options: CommandOptions): LedgerVerificationReport {
  const config = options.config ?? loadConfig(options.env);
  const database = ledgerDatabasePath(config.home);
  const result = verifyLedgerFile(database);
  return { ...result, database };
}

async function doctor(options: CommandOptions, verifyChain = false): Promise<DoctorReport> {
  try {
    const response = await callWithOptions("system.info", {}, options);
    const tools = await doctorTools(options);
    const ledger = verifyChain ? doctorLedger(options) : undefined;
    if ("error" in response) {
      return {
        ok: false,
        daemon: { status: "error", error: response.error.message },
        tools,
        ...(ledger ? { ledger } : {}),
      };
    }
    const info = SystemInfoResultSchema.parse(response.result);
    return {
      ok: !ledger || ledger.ok,
      daemon: { status: "ok", info },
      tools,
      ...(ledger ? { ledger } : {}),
    };
  } catch (error) {
    const tools = await doctorTools(options);
    const ledger = verifyChain ? doctorLedger(options) : undefined;
    return {
      ok: false,
      daemon: {
        status: "error",
        error: error instanceof Error ? error.message : "Daemon unavailable",
      },
      tools,
      ...(ledger ? { ledger } : {}),
    };
  }
}

async function daemonStatus(options: CommandOptions): Promise<{
  ok: boolean;
  status: "running" | "stopped";
  ping?: SystemPingResult;
  error?: string;
}> {
  try {
    const response = await callWithOptions("system.ping", {}, options);
    if ("error" in response) {
      return { ok: false, status: "stopped", error: response.error.message };
    }
    return { ok: true, status: "running", ping: SystemPingResultSchema.parse(response.result) };
  } catch (error) {
    return {
      ok: false,
      status: "stopped",
      error: error instanceof Error ? error.message : "Daemon unavailable",
    };
  }
}

function hasFlag(args: readonly string[], flag: string): boolean {
  return args.includes(flag);
}

const BACKUP_HELP = `Usage: lp backup [create] --destination <path> [options]
       lp backup verify <path>
       lp backup restore --from <backup> --to <LP_HOME>

Options:
  --destination, --output <path>  Backup destination for create (or restore target)
  --config <relative-path>        Include a redacted LP_HOME-relative config file (repeatable)
  --from <path>                   Existing backup for verify/restore
  --to <path>                     Explicit restore destination
  --overwrite                     Allow replacing existing files
  --quiesce                       Gracefully stop an active lpd before create/restore
  --no-ledger                     Omit db/ledger.sqlite
  --no-runner                     Omit db/runner.sqlite
  --no-cas                        Omit store/sha256
  --json                          Print a machine-readable result
`;

class BackupCommandUsageError extends Error {
  readonly code = "BackupUsageError" as const;

  constructor(message: string) {
    super(message);
    this.name = "BackupCommandUsageError";
  }
}

interface ParsedBackupCommand {
  readonly operation: BackupOperation;
  readonly positionals: readonly string[];
  readonly destination?: string;
  readonly from?: string;
  readonly to?: string;
  readonly configPaths: readonly string[];
  readonly overwrite: boolean;
  readonly includeLedgerDatabase: boolean;
  readonly includeRunnerDatabase: boolean;
  readonly includeCas: boolean;
  readonly quiesce: boolean;
  readonly json: boolean;
  readonly help: boolean;
}

function optionValue(
  args: readonly string[],
  index: number,
  name: string,
  inline: string | undefined,
): { readonly value: string; readonly nextIndex: number } {
  const value = inline ?? args[index + 1];
  if (value === undefined || value.length === 0) {
    throw new BackupCommandUsageError(`${name} requires a value`);
  }
  return { value, nextIndex: inline === undefined ? index + 1 : index };
}

function parseBackupCommand(rawArgs: readonly string[]): ParsedBackupCommand {
  const args = [...rawArgs];
  let operation: BackupOperation = "create";
  const first = args[0];
  if (first === "create" || first === "verify" || first === "restore") {
    operation = first;
    args.shift();
  }

  const positionals: string[] = [];
  const configPaths: string[] = [];
  let destination: string | undefined;
  let from: string | undefined;
  let to: string | undefined;
  let overwrite = false;
  let includeLedgerDatabase = true;
  let includeRunnerDatabase = true;
  let includeCas = true;
  let quiesce = false;
  let json = false;
  let help = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token) continue;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const equals = token.indexOf("=");
    const name = equals === -1 ? token : token.slice(0, equals);
    const inline = equals === -1 ? undefined : token.slice(equals + 1);
    switch (name) {
      case "--help":
        help = true;
        break;
      case "--json":
        json = true;
        break;
      case "--overwrite":
        overwrite = true;
        break;
      case "--quiesce":
        quiesce = true;
        break;
      case "--no-ledger":
        includeLedgerDatabase = false;
        break;
      case "--no-runner":
        includeRunnerDatabase = false;
        break;
      case "--no-cas":
        includeCas = false;
        break;
      case "--config":
      case "--config-file": {
        const selected = optionValue(args, index, name, inline);
        configPaths.push(selected.value);
        index = selected.nextIndex;
        break;
      }
      case "--destination":
      case "--output": {
        const selected = optionValue(args, index, name, inline);
        destination = selected.value;
        index = selected.nextIndex;
        break;
      }
      case "--from":
      case "--backup": {
        const selected = optionValue(args, index, name, inline);
        from = selected.value;
        index = selected.nextIndex;
        break;
      }
      case "--to": {
        const selected = optionValue(args, index, name, inline);
        to = selected.value;
        index = selected.nextIndex;
        break;
      }
      default:
        throw new BackupCommandUsageError(`unknown backup option ${name}`);
    }
  }

  return {
    operation,
    positionals,
    ...(destination === undefined ? {} : { destination }),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    configPaths,
    overwrite,
    includeLedgerDatabase,
    includeRunnerDatabase,
    includeCas,
    quiesce,
    json,
    help,
  };
}

function backupError(error: unknown): { readonly code: string; readonly message: string } {
  if (error && typeof error === "object") {
    const candidate = error as { readonly code?: unknown; readonly message?: unknown };
    if (typeof candidate.code === "string" && typeof candidate.message === "string") {
      return { code: candidate.code, message: candidate.message };
    }
  }
  return { code: "BackupCommandError", message: error instanceof Error ? error.message : String(error) };
}

function backupDestination(
  parsed: ParsedBackupCommand,
  positionalIndex: number,
  label: string,
): { readonly value: string; readonly nextIndex: number } {
  const value = parsed.destination ?? parsed.positionals[positionalIndex];
  if (!value) throw new BackupCommandUsageError(`${label} is required`);
  return { value, nextIndex: parsed.destination === undefined ? positionalIndex + 1 : positionalIndex };
}

function assertNoExtraPositionals(parsed: ParsedBackupCommand, nextIndex: number): void {
  if (parsed.positionals.length > nextIndex) throw new BackupCommandUsageError("too many positional backup paths");
}

function backupText(report: BackupCommandReport): string {
  if (!report.ok || !report.result) {
    const error = report.error ?? { code: "BackupCommandError", message: "backup failed" };
    return `${error.code}: ${error.message}\n`;
  }
  if (report.operation === "create") {
    const result = report.result as BackupResult;
    return [
      `Backup created: ${result.destination}`,
      `Files: ${result.manifest.totals.files}`,
      `Bytes: ${result.manifest.totals.bytes}`,
      `Manifest SHA-256: ${result.manifestSha256}`,
      ...(result.manifest.omitted.length > 0 ? [`Omitted config files: ${result.manifest.omitted.length}`] : []),
      "",
    ].join("\n");
  }
  if (report.operation === "verify") {
    const result = report.result as BackupVerification;
    return `Backup verified: ${result.destination}\nFiles: ${result.filesChecked}\nBytes: ${result.bytesChecked}\n`;
  }
  const result = report.result as RestoreBackupResult;
  return `Backup restored: ${result.destinationRoot}\nFiles: ${result.restoredFiles.length}\nBytes: ${result.bytes}\n`;
}

async function backupCommand(rawArgs: readonly string[], options: CommandOptions): Promise<number> {
  let parsed: ParsedBackupCommand;
  try {
    parsed = parseBackupCommand(rawArgs);
    if (parsed.help) {
      output(options.stdout, BACKUP_HELP);
      return 0;
    }
  } catch (error) {
    output(options.stderr, `${error instanceof Error ? error.message : String(error)}\n${BACKUP_HELP}`);
    return 2;
  }

  let report: BackupCommandReport;
  try {
    if (parsed.operation === "create") {
      const destination = backupDestination(parsed, 0, "backup destination");
      assertNoExtraPositionals(parsed, destination.nextIndex);
      if (parsed.from !== undefined || parsed.to !== undefined) {
        throw new BackupCommandUsageError("--from and --to are only valid for restore or verify");
      }
      const config = options.config ?? loadConfig(options.env);
      const request: BackupRequest = {
        home: config.home,
        destination: destination.value,
        configPaths: parsed.configPaths,
        overwrite: parsed.overwrite,
        includeLedgerDatabase: parsed.includeLedgerDatabase,
        includeRunnerDatabase: parsed.includeRunnerDatabase,
        includeCas: parsed.includeCas,
      };
      await assertBackupDaemonQuiescent(config.home, "create", parsed.quiesce, options.backupDaemonControl);
      const manager = options.backupManager ?? new BackupManager();
      report = { ok: true, operation: "create", result: manager.create(request) };
    } else if (parsed.operation === "verify") {
      if (parsed.to !== undefined || parsed.configPaths.length > 0 || parsed.overwrite || parsed.quiesce || !parsed.includeLedgerDatabase || !parsed.includeRunnerDatabase || !parsed.includeCas) {
        throw new BackupCommandUsageError("verify accepts only a backup path and --json");
      }
      const source = parsed.from ?? backupDestination(parsed, 0, "backup path").value;
      assertNoExtraPositionals(parsed, parsed.from === undefined ? 1 : 0);
      const manager = options.backupManager ?? new BackupManager();
      const result = manager.verify({ destination: source });
      report = result.ok
        ? { ok: true, operation: "verify", result }
        : {
          ok: false,
          operation: "verify",
          result,
          error: { code: "BackupIntegrityError", message: result.issues.join("; ") || "backup verification failed" },
        };
    } else {
      const source = parsed.from ?? parsed.positionals[0];
      const target = parsed.to ?? parsed.destination ?? parsed.positionals[1];
      if (!source || !target) throw new BackupCommandUsageError("restore requires --from <backup> and --to <LP_HOME>");
      const consumedPositionals = (parsed.from === undefined ? 1 : 0) +
        (parsed.to === undefined && parsed.destination === undefined ? 1 : 0);
      assertNoExtraPositionals(parsed, consumedPositionals);
      if (parsed.configPaths.length > 0 || !parsed.includeLedgerDatabase || !parsed.includeRunnerDatabase || !parsed.includeCas) {
        throw new BackupCommandUsageError("restore does not accept config or component-selection options");
      }
      const config = options.config ?? loadConfig(options.env);
       if (samePath(target, config.home)) await assertBackupDaemonQuiescent(config.home, "restore", parsed.quiesce, options.backupDaemonControl);
      const manager = options.backupManager ?? new BackupManager();
      report = { ok: true, operation: "restore", result: manager.restore({ destination: source, destinationRoot: target, overwrite: parsed.overwrite }) };
    }
  } catch (error) {
    const details = backupError(error);
    if (error instanceof BackupCommandUsageError) {
      output(options.stderr, `${details.message}\n${BACKUP_HELP}`);
      return 2;
    }
    report = { ok: false, operation: parsed.operation, error: details };
  }

  if (parsed.json) {
    output(options.stdout, `${JSON.stringify(report)}\n`);
  } else {
    output(report.ok ? options.stdout : options.stderr, backupText(report));
  }
  return report.ok && (report.operation !== "verify" || (report.result as BackupVerification).ok) ? 0 : 1;
}

export async function runCli(
  argv: readonly string[],
  options: CommandOptions = {},
): Promise<number> {
  const args = [...argv];
  if (args[0] === "lp") args.shift();
  const version = options.version ?? CLI_VERSION;
  if (args.includes("--version") || args.includes("-v")) {
    output(options.stdout, `${version}\n`);
    return 0;
  }

  if (args[0] === "backup") return backupCommand(args.slice(1), options);

  const memoryResult = await memoryCommand(args, options);
  if (memoryResult >= 0) return memoryResult;

  const json = hasFlag(args, "--json");
  const verifyChain = hasFlag(args, "--verify-chain");
  const command = args.filter((arg) => !arg.startsWith("--"));
  let report: DoctorReport | Awaited<ReturnType<typeof daemonStatus>>;
  if (command[0] === "doctor") {
    report = await doctor(options, verifyChain);
  } else if (command[0] === "daemon" && command[1] === "status") {
    report = await daemonStatus(options);
  } else {
    output(options.stderr, "Unknown command. Use --version, doctor, or daemon status.\n");
    return 2;
  }

  if (json) {
    output(options.stdout, `${JSON.stringify(report)}\n`);
  } else if ("tools" in report) {
    output(options.stdout, `Daemon: ${report.daemon.status}\n`);
    if (report.daemon.info) {
      output(options.stdout, `Service: ${report.daemon.info.name}\n`);
      output(options.stdout, `Version: ${report.daemon.info.version}\n`);
    }
    output(options.stdout, `Node: ${report.tools.node}\n`);
    if (report.ledger) {
      output(options.stdout, `Ledger: ${report.ledger.status}\n`);
      if (report.ledger.status === "unavailable") {
        output(options.stderr, `${report.ledger.code}: ${report.ledger.message}\n`);
      } else if (!report.ledger.ok) {
        output(options.stderr, `Ledger verification failed (${report.ledger.issues.length} issue(s))\n`);
      }
    }
    if (report.daemon.error) output(options.stderr, `${report.daemon.error}\n`);
  } else {
    output(options.stdout, `Daemon: ${report.status}\n`);
    if (report.ping) output(options.stdout, `Service: ${report.ping.service ?? "lpd"}\n`);
    if (report.error) output(options.stderr, `${report.error}\n`);
  }
  return report.ok ? 0 : 1;
}

export const handleCommand = runCli;
export const runCommand = runCli;
export const commandHandler = runCli;

export function createCommandHandler(defaults: CommandOptions = {}):
  (argv: readonly string[]) => Promise<number> {
  return (argv) => runCli(argv, defaults);
}

export async function executeCommand(
  argv: readonly string[],
  options: CommandOptions = {},
): Promise<{ exitCode: number }> {
  return { exitCode: await runCli(argv, options) };
}
