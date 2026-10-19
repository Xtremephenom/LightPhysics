import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import path from "node:path";

/**
 * The supervisor is deliberately a small process-lifecycle seam.  It does
 * not own Warden sessions, safe points, backups, or a job journal.  Callers
 * must provide an explicit retry policy and may inject every side effect for
 * deterministic offline tests.
 */

export const DEFAULT_SUPERVISOR_MAX_OUTPUT_BYTES = 64 * 1024;
export const DEFAULT_SUPERVISOR_MAX_ATTEMPTS = 1;
export const DEFAULT_SUPERVISOR_BACKOFF_BASE_MS = 250;
export const DEFAULT_SUPERVISOR_BACKOFF_MAX_MS = 30_000;
export const DEFAULT_SUPERVISOR_STOP_TIMEOUT_MS = 5_000;

export const MAX_SUPERVISOR_ID_BYTES = 256;
export const MAX_SUPERVISOR_COMMAND_BYTES = 4 * 1024;
export const MAX_SUPERVISOR_ARGS = 256;
export const MAX_SUPERVISOR_ARG_BYTES = 4 * 1024;
export const MAX_SUPERVISOR_ARG_TOTAL_BYTES = 32 * 1024;
export const MAX_SUPERVISOR_CWD_BYTES = 4 * 1024;
export const MAX_SUPERVISOR_ENV_ENTRIES = 128;
export const MAX_SUPERVISOR_ENV_VALUE_BYTES = 4 * 1024;
export const MAX_SUPERVISOR_ENV_TOTAL_BYTES = 32 * 1024;
export const MAX_SUPERVISOR_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
export const MAX_SUPERVISOR_BACKOFF_MS = 5 * 60 * 1_000;
export const MAX_SUPERVISOR_ATTEMPTS = 16;
export const MAX_SUPERVISOR_STOP_TIMEOUT_MS = 30_000;
export const MAX_SUPERVISOR_TRACKED_TASKS = 128;
export const MAX_SUPERVISOR_HISTORY = 256;

const SENSITIVE_NAME = /(?:secret|token|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|credential|authorization|cookie|session[_-]?secret)/i;
const SECRET_VALUE = /(?:-----BEGIN[\s\S]*PRIVATE KEY-----|\b(?:sk|rk|pk|ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9][A-Za-z0-9._-]{11,}|\bAKIA[0-9A-Z]{16}\b|\bBearer\s+[A-Za-z0-9._~+/=-]{12,})/i;
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,31}$/;

export type SupervisorErrorCode =
  | "SupervisorValidationError"
  | "SupervisorSensitiveData"
  | "SupervisorSpawnError"
  | "SupervisorTaskNotFound"
  | "SupervisorConflict"
  | "SupervisorStateError"
  | "SupervisorTimeout"
  | "SupervisorOutputLimit"
  | "SupervisorKillError"
  | "SupervisorRetryExhausted";

export class SupervisorError extends Error {
  readonly code: SupervisorErrorCode;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: SupervisorErrorCode,
    message: string,
    retryable = false,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(safeErrorMessage(message));
    this.name = code;
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

export class SupervisorValidationError extends SupervisorError {
  constructor(message: string) {
    super("SupervisorValidationError", message);
  }
}

export class SupervisorSensitiveDataError extends SupervisorError {
  constructor() {
    super("SupervisorSensitiveData", "Supervisor input contains sensitive data");
  }
}

export class SupervisorSpawnError extends SupervisorError {
  constructor(cause?: unknown) {
    const code = safeCauseCode(cause);
    super(
      "SupervisorSpawnError",
      "Child process could not be started",
      true,
      code === undefined ? undefined : { causeCode: code },
    );
  }
}

export class SupervisorTaskNotFoundError extends SupervisorError {
  constructor() {
    super("SupervisorTaskNotFound", "Supervisor task was not found");
  }
}

export class SupervisorConflictError extends SupervisorError {
  constructor(message = "Supervisor task is already tracked") {
    super("SupervisorConflict", message);
  }
}

export class SupervisorStateError extends SupervisorError {
  constructor(message = "Supervisor task is not in a stoppable state") {
    super("SupervisorStateError", message);
  }
}

export class SupervisorTimeoutError extends SupervisorError {
  constructor() {
    super("SupervisorTimeout", "Child process exceeded its timeout", true);
  }
}

export class SupervisorOutputLimitError extends SupervisorError {
  constructor() {
    super("SupervisorOutputLimit", "Child process exceeded its output limit", true);
  }
}

export class SupervisorKillError extends SupervisorError {
  constructor() {
    super("SupervisorKillError", "Child process could not be stopped", true);
  }
}

export class SupervisorRetryExhaustedError extends SupervisorError {
  constructor() {
    super("SupervisorRetryExhausted", "Child process retry policy was exhausted", false);
  }
}

export type SupervisorTaskState = "running" | "stopping" | "exited" | "failed" | "stopped" | "timed_out";
export type SupervisorTaskHealth = "healthy" | "unhealthy" | "stopped";
export type SupervisorExitReason = "success" | "exit_code" | "signal" | "spawn_error" | "timeout" | "output_limit" | "stopped";

export type SupervisorRetryReason = Exclude<SupervisorExitReason, "success">;

export interface SupervisorRetryPolicy {
  /** Total process attempts, including the first start. Defaults to one. */
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  /** An empty list means that retries are disabled. */
  readonly retryOn?: readonly SupervisorRetryReason[];
  /** If present, only these non-zero exit codes may be retried. */
  readonly retryableExitCodes?: readonly number[];
}

export interface SupervisorBackoffOptions {
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  /** Jitter is intentionally unsupported; zero is the only accepted value. */
  readonly jitterMs?: 0;
}

export interface SupervisorStdioOptions {
  readonly stdin?: "ignore";
  readonly stdout?: "pipe" | "ignore";
  readonly stderr?: "pipe" | "ignore";
}

export type SupervisorStdio =
  | SupervisorStdioOptions
  | readonly ["ignore", "pipe" | "ignore", "pipe" | "ignore"];

export interface SupervisorTaskSpec {
  readonly id: string;
  /** Executable name or path. It is always passed as spawn's command field. */
  readonly command: string;
  /** Arguments are always a separate array; command-line strings are rejected. */
  readonly args: readonly string[];
  readonly cwd?: string;
  /** Explicit env replaces the scrubbed inherited environment. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly stdio?: SupervisorStdio;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly retry?: SupervisorRetryPolicy;
}

export interface SupervisorTrackOptions {
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  /** True only when the tracked process owns a separate POSIX process group. */
  readonly processGroup?: boolean;
}

export interface SupervisorChildStream {
  on(event: "data", listener: (chunk: unknown) => void): this;
  setEncoding?(encoding: BufferEncoding): this;
}

/** Structural child type keeps tests independent of a real OS process. */
export interface SupervisorChild {
  readonly pid?: number;
  readonly stdout?: SupervisorChildStream | null;
  readonly stderr?: SupervisorChildStream | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: "error", listener: (error: unknown) => void): this;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

export interface SupervisorSpawnOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly shell: false;
  readonly stdio: readonly ["ignore", "pipe" | "ignore", "pipe" | "ignore"];
  readonly detached: boolean;
  readonly windowsHide: true;
}

export type SupervisorSpawner = (
  command: string,
  args: readonly string[],
  options: SupervisorSpawnOptions,
) => SupervisorChild;

export type SupervisorClock = () => Date | number;
export type SupervisorSleep = (milliseconds: number) => Promise<void> | void;

export type ProcessTreeTerminationMethod = "windows-taskkill-tree" | "posix-process-group" | "posix-child";

export interface SupervisorKillRequest {
  readonly taskId: string;
  readonly pid: number | undefined;
  readonly child: SupervisorChild;
  readonly platform: NodeJS.Platform;
  readonly method: ProcessTreeTerminationMethod;
  readonly signal: NodeJS.Signals;
  readonly processGroup: boolean;
}

export interface SupervisorKillResult {
  readonly ok: boolean;
  readonly method: ProcessTreeTerminationMethod;
  readonly reason: "requested" | "already_exited" | "unavailable" | "failed";
}

export type SupervisorProcessTreeKiller = (
  request: SupervisorKillRequest,
) => SupervisorKillResult | Promise<SupervisorKillResult>;

/**
 * Dependency-free seam for the Warden-owned credential revocation operation.
 * A successful callback may return void (the common command-style shape) or
 * true. Returning false is a bounded failure outcome; callback errors are
 * intentionally never exposed by the supervisor.
 */
export type SupervisorTokenRevocationCallback = () => boolean | void | Promise<boolean | void>;

/** Structural alternative for callers that expose revocation as an object. */
export interface SupervisorTokenRevocationInterface {
  revokeAll(): boolean | void | Promise<boolean | void>;
}

export type SupervisorTokenRevoker = SupervisorTokenRevocationCallback | SupervisorTokenRevocationInterface;

export interface SupervisorOptions {
  readonly spawn?: SupervisorSpawner;
  readonly killer?: SupervisorProcessTreeKiller;
  /** Alias for killer for callers that prefer the short seam name. */
  readonly kill?: SupervisorProcessTreeKiller;
  /** Optional Warden seam; Runner never imports or depends on Warden. */
  readonly tokenRevocation?: SupervisorTokenRevoker;
  readonly clock?: SupervisorClock;
  readonly sleep?: SupervisorSleep;
  readonly platform?: NodeJS.Platform;
  readonly defaultCwd?: string;
  readonly defaultTimeoutMs?: number;
  readonly defaultMaxOutputBytes?: number;
  readonly defaultRetry?: SupervisorRetryPolicy;
  readonly maxTrackedTasks?: number;
}

export interface SupervisorErrorSummary {
  readonly code: SupervisorErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

export interface SupervisorTaskStatus {
  readonly id: string;
  readonly pid: number | undefined;
  readonly attempt: number;
  readonly state: SupervisorTaskState;
  readonly health: SupervisorTaskHealth;
  readonly reason: SupervisorExitReason | undefined;
  readonly startedAt: string;
  readonly endedAt: string | undefined;
  readonly exitCode: number | null | undefined;
  readonly signal: NodeJS.Signals | null | undefined;
  readonly outputBytes: number;
  readonly outputLimitBytes: number;
  readonly outputTruncated: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly error: SupervisorErrorSummary | undefined;
  readonly stopRequested: boolean;
}

export interface SupervisorReapResult extends SupervisorTaskStatus {
  readonly reason: SupervisorExitReason;
  readonly retryableFailure: boolean;
}

export type SupervisorTaskResult = SupervisorReapResult;

export interface SupervisorTaskHandle {
  readonly id: string;
  readonly pid: number | undefined;
  readonly attempt: number;
  readonly done: Promise<SupervisorReapResult>;
  readonly status: SupervisorTaskStatus;
  getStatus(): SupervisorTaskStatus;
}

export interface SupervisorStopOptions {
  readonly force?: boolean;
  readonly signal?: NodeJS.Signals;
  readonly timeoutMs?: number;
  readonly reason?: "user" | "timeout" | "output_limit" | "kill_all";
}

export interface SupervisorStopOutcome {
  readonly id: string;
  readonly requested: boolean;
  readonly accepted: boolean;
  readonly confirmed: boolean;
  readonly method: ProcessTreeTerminationMethod | undefined;
  readonly reason: "requested" | "already_finished" | "unavailable" | "failed" | "timed_out";
  readonly state: SupervisorTaskState;
  readonly error: SupervisorErrorSummary | undefined;
}

export type SupervisorTokenRevocationResult =
  | {
      readonly available: false;
      readonly status: "not_available";
      readonly reason: "Warden is not implemented in the Runner supervisor";
    }
  | {
      readonly available: true;
      readonly status: "revoked";
    }
  | {
      readonly available: true;
      readonly status: "failed";
      readonly reason: "Token revocation callback failed";
    };

export interface SupervisorKillAllResult {
  readonly requested: number;
  readonly accepted: number;
  readonly confirmed: number;
  readonly failed: number;
  readonly outstanding: number;
  readonly outcomes: readonly SupervisorStopOutcome[];
  readonly tokenRevocation: SupervisorTokenRevocationResult;
}

export interface SupervisorTaskHealthSnapshot {
  readonly id: string;
  readonly state: SupervisorTaskState;
  readonly health: SupervisorTaskHealth;
  readonly pid: number | undefined;
}

export interface SupervisorHealthReport {
  readonly healthy: boolean;
  readonly status: "healthy" | "degraded" | "idle";
  readonly tracked: number;
  readonly active: number;
  readonly unhealthy: number;
  readonly tasks: readonly SupervisorTaskHealthSnapshot[];
  readonly tokenRevocation: "not_available";
}

export interface SupervisorRunResult extends SupervisorReapResult {
  readonly attempts: number;
  readonly retries: number;
  readonly backoffMs: readonly number[];
}

interface NormalizedRetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly retryOn: readonly SupervisorRetryReason[];
  readonly retryableExitCodes: readonly number[];
}

interface NormalizedTaskSpec {
  readonly id: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stdio: readonly ["ignore", "pipe" | "ignore", "pipe" | "ignore"];
  readonly timeoutMs: number | undefined;
  readonly maxOutputBytes: number;
  readonly retry: NormalizedRetryPolicy;
}

interface TaskRecord {
  readonly id: string;
  readonly attempt: number;
  readonly child: SupervisorChild;
  readonly maxOutputBytes: number;
  readonly startedAt: string;
  readonly startedMs: number;
  readonly processGroup: boolean;
  pid: number | undefined;
  state: SupervisorTaskState;
  reason: SupervisorExitReason | undefined;
  endedAt: string | undefined;
  endedMs: number | undefined;
  exitCode: number | null | undefined;
  signal: NodeJS.Signals | null | undefined;
  error: SupervisorErrorSummary | undefined;
  stopRequested: boolean;
  outputTruncated: boolean;
  outputBytes: number;
  stdoutBytes: number;
  stderrBytes: number;
  stdout: string;
  stderr: string;
  settled: boolean;
  timeoutStarted: boolean;
  killPromise: Promise<SupervisorStopOutcome> | undefined;
  resolveCompletion: (result: SupervisorReapResult) => void;
  completion: Promise<SupervisorReapResult>;
}

export interface SupervisorTrackInput {
  readonly id: string;
  readonly child: SupervisorChild;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly processGroup?: boolean;
}

interface NormalizedTrackInput {
  readonly id: string;
  readonly child: SupervisorChild;
  readonly timeoutMs: number | undefined;
  readonly maxOutputBytes: number;
  readonly processGroup: boolean;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function safeErrorMessage(message: string): string {
  if (SECRET_VALUE.test(message)) return "Supervisor operation failed";
  return message
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[redacted]")
    .replace(/((?:secret|token|password|api[_-]?key|authorization)\s*[:=]\s*)[^,;\s]+/gi, "$1[redacted]")
    .slice(0, 512);
}

function safeCauseCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = (error as { readonly code?: unknown }).code;
  return typeof candidate === "string" && SAFE_ERROR_CODE.test(candidate) ? candidate : undefined;
}

function safeSignal(value: unknown): NodeJS.Signals | null {
  if (typeof value !== "string") return null;
  const signals: readonly NodeJS.Signals[] = [
    "SIGABRT",
    "SIGALRM",
    "SIGBUS",
    "SIGCHLD",
    "SIGCONT",
    "SIGFPE",
    "SIGHUP",
    "SIGILL",
    "SIGINT",
    "SIGIO",
    "SIGIOT",
    "SIGKILL",
    "SIGPIPE",
    "SIGPOLL",
    "SIGPROF",
    "SIGPWR",
    "SIGQUIT",
    "SIGSEGV",
    "SIGSTKFLT",
    "SIGSTOP",
    "SIGSYS",
    "SIGTERM",
    "SIGTRAP",
    "SIGTSTP",
    "SIGTTIN",
    "SIGTTOU",
    "SIGURG",
    "SIGUSR1",
    "SIGUSR2",
    "SIGVTALRM",
    "SIGWINCH",
    "SIGXCPU",
    "SIGXFSZ",
  ];
  return signals.includes(value as NodeJS.Signals) ? value as NodeJS.Signals : null;
}

function nowMilliseconds(clock: SupervisorClock): number {
  const value = clock();
  const milliseconds = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(milliseconds)) throw new SupervisorValidationError("clock must return a finite time");
  return milliseconds;
}

function isoTime(milliseconds: number): string {
  const date = new Date(milliseconds);
  if (!Number.isFinite(date.getTime())) throw new SupervisorValidationError("clock returned an invalid time");
  return date.toISOString();
}

function validateBoundedInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new SupervisorValidationError(`${field} is outside its supported bound`);
  }
  return value;
}

function validateText(value: unknown, field: string, maximumBytes: number, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0)) {
    throw new SupervisorValidationError(`${field} must be a non-empty string`);
  }
  if (value.includes("\u0000") || /[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) {
    throw new SupervisorValidationError(`${field} contains unsupported control characters`);
  }
  if (byteLength(value) > maximumBytes) throw new SupervisorValidationError(`${field} exceeds its size bound`);
  if (SECRET_VALUE.test(value)) throw new SupervisorSensitiveDataError();
  return value;
}

function validateIdentifier(value: unknown): string {
  return validateText(value, "task id", MAX_SUPERVISOR_ID_BYTES);
}

function validateCommand(value: unknown): string {
  return validateText(value, "command", MAX_SUPERVISOR_COMMAND_BYTES);
}

function validateArgs(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw new SupervisorValidationError("args must be an array of strings");
  if (value.length > MAX_SUPERVISOR_ARGS) throw new SupervisorValidationError("args exceed their count bound");
  let totalBytes = 0;
  const args: string[] = [];
  for (const arg of value) {
    const normalized = validateText(arg, "argument", MAX_SUPERVISOR_ARG_BYTES, true);
    totalBytes += byteLength(normalized);
    if (totalBytes > MAX_SUPERVISOR_ARG_TOTAL_BYTES) {
      throw new SupervisorValidationError("args exceed their total size bound");
    }
    args.push(normalized);
  }
  return Object.freeze(args);
}

function normalizeCwd(value: unknown, fallback: string): string {
  const candidate = value === undefined ? fallback : validateText(value, "cwd", MAX_SUPERVISOR_CWD_BYTES);
  if (typeof candidate !== "string") throw new SupervisorValidationError("cwd must be a non-empty string");
  let resolved: string;
  try {
    resolved = path.resolve(candidate);
  } catch {
    throw new SupervisorValidationError("cwd is not a valid path");
  }
  if (byteLength(resolved) > MAX_SUPERVISOR_CWD_BYTES) throw new SupervisorValidationError("cwd exceeds its size bound");
  return resolved;
}

function normalizeExplicitEnvironment(value: unknown): NodeJS.ProcessEnv {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SupervisorValidationError("env must be a plain object");
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length > MAX_SUPERVISOR_ENV_ENTRIES) throw new SupervisorValidationError("env exceeds its entry bound");
  const result: NodeJS.ProcessEnv = {};
  let totalBytes = 0;
  for (const [key, rawValue] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && key.toLowerCase() !== "path") {
      throw new SupervisorValidationError("env contains an invalid variable name");
    }
    if (SENSITIVE_NAME.test(key)) throw new SupervisorSensitiveDataError();
    if (rawValue !== undefined && typeof rawValue !== "string") {
      throw new SupervisorValidationError("env values must be strings");
    }
    if (rawValue === undefined) continue;
    if (SECRET_VALUE.test(rawValue)) throw new SupervisorSensitiveDataError();
    if (rawValue.includes("\u0000")) throw new SupervisorValidationError("env contains a NUL character");
    if (byteLength(rawValue) > MAX_SUPERVISOR_ENV_VALUE_BYTES) throw new SupervisorValidationError("env value exceeds its size bound");
    totalBytes += byteLength(key) + byteLength(rawValue);
    if (totalBytes > MAX_SUPERVISOR_ENV_TOTAL_BYTES) throw new SupervisorValidationError("env exceeds its total size bound");
    result[key] = rawValue;
  }
  return result;
}

function inheritedEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  let totalBytes = 0;
  let count = 0;
  const entries = Object.entries(process.env)
    .filter(([key, value]) => !SENSITIVE_NAME.test(key) && typeof value === "string" && !SECRET_VALUE.test(value))
    .sort(([left], [right]) => left.localeCompare(right));
  for (const [key, value] of entries) {
    if (count >= MAX_SUPERVISOR_ENV_ENTRIES || value === undefined) break;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && key.toLowerCase() !== "path") continue;
    if (value.includes("\u0000") || byteLength(value) > MAX_SUPERVISOR_ENV_VALUE_BYTES) continue;
    const entryBytes = byteLength(key) + byteLength(value);
    if (totalBytes + entryBytes > MAX_SUPERVISOR_ENV_TOTAL_BYTES) break;
    result[key] = value;
    totalBytes += entryBytes;
    count += 1;
  }
  return result;
}

function normalizeStdio(value: SupervisorStdio | undefined): readonly ["ignore", "pipe" | "ignore", "pipe" | "ignore"] {
  if (value === undefined) return ["ignore", "pipe", "pipe"];
  if (Array.isArray(value)) {
    if (value.length !== 3 || value[0] !== "ignore" || !["pipe", "ignore"].includes(value[1]) || !["pipe", "ignore"].includes(value[2])) {
      throw new SupervisorValidationError("stdio must use ignore/pipe channels only");
    }
    return ["ignore", value[1], value[2]];
  }
  if (typeof value !== "object" || value === null) throw new SupervisorValidationError("stdio must use ignore/pipe channels only");
  const candidate = value as SupervisorStdioOptions;
  if (Object.keys(candidate).some((key) => !["stdin", "stdout", "stderr"].includes(key))) {
    throw new SupervisorValidationError("stdio contains an unsupported channel");
  }
  if (candidate.stdin !== undefined && candidate.stdin !== "ignore") throw new SupervisorValidationError("stdin must be ignored");
  if (candidate.stdout !== undefined && candidate.stdout !== "pipe" && candidate.stdout !== "ignore") {
    throw new SupervisorValidationError("stdout must be piped or ignored");
  }
  if (candidate.stderr !== undefined && candidate.stderr !== "pipe" && candidate.stderr !== "ignore") {
    throw new SupervisorValidationError("stderr must be piped or ignored");
  }
  return ["ignore", candidate.stdout ?? "pipe", candidate.stderr ?? "pipe"];
}

const RETRY_REASONS: readonly SupervisorRetryReason[] = [
  "exit_code",
  "signal",
  "spawn_error",
  "timeout",
  "output_limit",
  "stopped",
];

function normalizeRetryPolicy(value: SupervisorRetryPolicy | undefined, fallback?: SupervisorRetryPolicy): NormalizedRetryPolicy {
  const candidate = value ?? fallback ?? {};
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new SupervisorValidationError("retry policy must be an object");
  }
  const maxAttempts = candidate.maxAttempts === undefined
    ? DEFAULT_SUPERVISOR_MAX_ATTEMPTS
    : validateBoundedInteger(candidate.maxAttempts, "retry maxAttempts", 1, MAX_SUPERVISOR_ATTEMPTS);
  const baseDelayMs = candidate.baseDelayMs === undefined
    ? DEFAULT_SUPERVISOR_BACKOFF_BASE_MS
    : validateBoundedInteger(candidate.baseDelayMs, "retry baseDelayMs", 0, MAX_SUPERVISOR_BACKOFF_MS);
  const maxDelayMs = candidate.maxDelayMs === undefined
    ? DEFAULT_SUPERVISOR_BACKOFF_MAX_MS
    : validateBoundedInteger(candidate.maxDelayMs, "retry maxDelayMs", 0, MAX_SUPERVISOR_BACKOFF_MS);
  if (maxDelayMs < baseDelayMs) throw new SupervisorValidationError("retry maxDelayMs must not be below baseDelayMs");
  const retryOnInput = candidate.retryOn ?? [];
  if (!Array.isArray(retryOnInput) || retryOnInput.some((reason) => !RETRY_REASONS.includes(reason))) {
    throw new SupervisorValidationError("retryOn contains an unsupported reason");
  }
  const retryOn = [...new Set(retryOnInput)];
  const codesInput = candidate.retryableExitCodes ?? [];
  if (!Array.isArray(codesInput) || codesInput.length > 64 || codesInput.some((code) => typeof code !== "number" || !Number.isSafeInteger(code) || code < 1 || code > 255)) {
    throw new SupervisorValidationError("retryableExitCodes contains an unsupported exit code");
  }
  return Object.freeze({
    maxAttempts,
    baseDelayMs,
    maxDelayMs,
    retryOn: Object.freeze(retryOn),
    retryableExitCodes: Object.freeze([...new Set(codesInput)]),
  });
}

/** Deterministic exponential backoff with a hard upper bound and no jitter. */
export function computeSupervisorBackoff(attempt: number, options: SupervisorBackoffOptions = {}): number {
  const normalizedAttempt = validateBoundedInteger(attempt, "backoff attempt", 1, MAX_SUPERVISOR_ATTEMPTS);
  const baseDelayMs = options.baseDelayMs === undefined
    ? DEFAULT_SUPERVISOR_BACKOFF_BASE_MS
    : validateBoundedInteger(options.baseDelayMs, "backoff baseDelayMs", 0, MAX_SUPERVISOR_BACKOFF_MS);
  const maxDelayMs = options.maxDelayMs === undefined
    ? DEFAULT_SUPERVISOR_BACKOFF_MAX_MS
    : validateBoundedInteger(options.maxDelayMs, "backoff maxDelayMs", 0, MAX_SUPERVISOR_BACKOFF_MS);
  if (maxDelayMs < baseDelayMs) throw new SupervisorValidationError("backoff maxDelayMs must not be below baseDelayMs");
  if (options.jitterMs !== undefined && options.jitterMs !== 0) {
    throw new SupervisorValidationError("backoff jitter is not supported; use zero");
  }
  const exponent = Math.min(normalizedAttempt - 1, 30);
  return Math.min(maxDelayMs, baseDelayMs * 2 ** exponent);
}

export const computeExponentialBackoff = computeSupervisorBackoff;
export const calculateSupervisorBackoff = computeSupervisorBackoff;

function normalizeTimeout(value: number | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  return validateBoundedInteger(value, field, 1, MAX_SUPERVISOR_TIMEOUT_MS);
}

function normalizeOutputLimit(value: number | undefined): number {
  return value === undefined
    ? DEFAULT_SUPERVISOR_MAX_OUTPUT_BYTES
    : validateBoundedInteger(value, "maxOutputBytes", 1, DEFAULT_SUPERVISOR_MAX_OUTPUT_BYTES);
}

function summary(error: SupervisorError): SupervisorErrorSummary {
  return Object.freeze({ code: error.code, message: error.message, retryable: error.retryable });
}

function errorFromUnknown(error: unknown, fallback: SupervisorError): SupervisorError {
  if (error instanceof SupervisorError) return error;
  return fallback;
}

function redactOutput(value: string, maximumBytes: number): string {
  let redacted = value
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[redacted]")
    .replace(/((?:secret|token|password|api[_-]?key|authorization)\s*[:=]\s*)[^,;\s]+/gi, "$1[redacted]")
    .replace(SECRET_VALUE, "[redacted]");
  if (byteLength(redacted) <= maximumBytes) return redacted;
  return Buffer.from(redacted, "utf8").subarray(0, maximumBytes).toString("utf8");
}

function safeChunk(chunk: unknown): string {
  if (typeof chunk === "string") return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString("utf8");
  return String(chunk);
}

function retryableFailure(reason: SupervisorExitReason): boolean {
  return reason !== "success" && reason !== "stopped";
}

function statusHealth(state: SupervisorTaskState, reason: SupervisorExitReason | undefined): SupervisorTaskHealth {
  if (state === "stopped" || reason === "stopped") return "stopped";
  if (state === "exited" && reason === "success") return "healthy";
  if (state === "running") return "healthy";
  return "unhealthy";
}

function selectMethod(
  platform: NodeJS.Platform,
  pid: number | undefined,
  processGroup: boolean,
): ProcessTreeTerminationMethod {
  if (platform === "win32") return "windows-taskkill-tree";
  if (processGroup && pid !== undefined) return "posix-process-group";
  return "posix-child";
}

/** Exported for cross-platform tests and for callers selecting an explicit strategy. */
export function selectProcessTreeTerminationMethod(
  platform: NodeJS.Platform = process.platform,
  processGroupAvailable = false,
  pidAvailable = true,
): ProcessTreeTerminationMethod {
  return selectMethod(platform, pidAvailable ? 1 : undefined, processGroupAvailable);
}

const defaultSleep: SupervisorSleep = (milliseconds) => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, milliseconds);
  timer.unref?.();
});

const defaultSpawner: SupervisorSpawner = (command, args, options) => {
  return nodeSpawn(command, [...args], options as unknown as SpawnOptions) as unknown as SupervisorChild;
};

function spawnTaskkill(
  request: SupervisorKillRequest,
  spawner: SupervisorSpawner,
): Promise<SupervisorKillResult> {
  if (request.pid === undefined) {
    return Promise.resolve({ ok: false, method: request.method, reason: "unavailable" });
  }
  return new Promise((resolve, reject) => {
    let command: SupervisorChild;
    try {
      command = spawner("taskkill", ["/PID", String(request.pid), "/T", "/F"], {
        cwd: process.cwd(),
        env: inheritedEnvironment(),
        shell: false,
        stdio: ["ignore", "ignore", "ignore"],
        detached: false,
        windowsHide: true,
      });
    } catch (error) {
      reject(new SupervisorKillError());
      return;
    }
    command.once("error", () => reject(new SupervisorKillError()));
    command.once("close", (code) => {
      resolve({
        ok: code === 0,
        method: request.method,
        reason: code === 0 ? "requested" : "failed",
      });
    });
  });
}

/**
 * Default platform strategy.  Windows uses the explicit taskkill tree form;
 * POSIX prefers a detached process group and falls back to the child handle.
 * Tests should inject a killer instead of invoking this implementation.
 */
export function createDefaultProcessTreeKiller(
  spawner: SupervisorSpawner = defaultSpawner,
): SupervisorProcessTreeKiller {
  return (request) => {
    if (request.platform === "win32") return spawnTaskkill(request, spawner);
    if (request.method === "posix-process-group" && request.pid !== undefined) {
      try {
        process.kill(-request.pid, request.signal);
        return { ok: true, method: request.method, reason: "requested" };
      } catch (error) {
        if (safeCauseCode(error) === "ESRCH") {
          return { ok: true, method: request.method, reason: "already_exited" };
        }
      }
    }
    try {
      const killed = request.child.kill(request.signal);
      return {
        ok: killed,
        method: "posix-child",
        reason: killed ? "requested" : "failed",
      };
    } catch {
      return { ok: false, method: "posix-child", reason: "failed" };
    }
  };
}

export const defaultProcessTreeKiller = createDefaultProcessTreeKiller();

export function isRetryEligible(
  result: SupervisorReapResult,
  policy: SupervisorRetryPolicy | undefined,
  attempt = result.attempt,
): boolean {
  const normalized = normalizeRetryPolicy(policy);
  if (attempt >= normalized.maxAttempts || result.reason === "success") return false;
  if (!normalized.retryOn.includes(result.reason)) return false;
  if (result.reason === "exit_code" && normalized.retryableExitCodes.length > 0) {
    return result.exitCode !== null && result.exitCode !== undefined && normalized.retryableExitCodes.includes(result.exitCode);
  }
  return true;
}

export const retryAllowed = isRetryEligible;

function validateChild(child: SupervisorChild): SupervisorChild {
  if (!child || typeof child !== "object" || typeof child.once !== "function" || typeof child.kill !== "function") {
    throw new SupervisorSpawnError();
  }
  return child;
}

function validatePid(pid: number | undefined): number | undefined {
  if (pid === undefined) return undefined;
  if (!Number.isSafeInteger(pid) || pid < 1) throw new SupervisorSpawnError();
  return pid;
}

function normalizeTrackInput(input: SupervisorTrackInput, defaultOutput: number, defaultTimeout: number | undefined): NormalizedTrackInput {
  const id = validateIdentifier(input.id);
  const child = validateChild(input.child);
  const timeoutMs = normalizeTimeout(input.timeoutMs ?? defaultTimeout, "timeoutMs");
  const maxOutputBytes = normalizeOutputLimit(input.maxOutputBytes ?? defaultOutput);
  return {
    id,
    child,
    timeoutMs,
    maxOutputBytes,
    processGroup: input.processGroup === true,
  };
}

export class Supervisor {
  private readonly spawn: SupervisorSpawner;
  private readonly killer: SupervisorProcessTreeKiller;
  private readonly tokenRevocation: SupervisorTokenRevoker | undefined;
  private readonly clock: SupervisorClock;
  private readonly sleep: SupervisorSleep;
  private readonly platform: NodeJS.Platform;
  private readonly defaultCwd: string;
  private readonly defaultTimeoutMs: number | undefined;
  private readonly defaultMaxOutputBytes: number;
  private readonly defaultRetry: SupervisorRetryPolicy | undefined;
  private readonly maxTrackedTasks: number;
  private readonly activeTasks = new Map<string, TaskRecord>();
  private readonly history = new Map<string, TaskRecord>();

  constructor(options: SupervisorOptions = {}) {
    this.spawn = options.spawn ?? defaultSpawner;
    this.platform = options.platform ?? process.platform;
    this.clock = options.clock ?? (() => new Date());
    this.sleep = options.sleep ?? defaultSleep;
    this.defaultCwd = normalizeCwd(options.defaultCwd, process.cwd());
    this.defaultTimeoutMs = normalizeTimeout(options.defaultTimeoutMs, "defaultTimeoutMs");
    this.defaultMaxOutputBytes = normalizeOutputLimit(options.defaultMaxOutputBytes);
    this.defaultRetry = options.defaultRetry;
    this.maxTrackedTasks = options.maxTrackedTasks === undefined
      ? MAX_SUPERVISOR_TRACKED_TASKS
      : validateBoundedInteger(options.maxTrackedTasks, "maxTrackedTasks", 1, MAX_SUPERVISOR_TRACKED_TASKS);
    this.killer = options.killer ?? options.kill ?? createDefaultProcessTreeKiller(this.spawn);
    this.tokenRevocation = options.tokenRevocation;
  }

  private normalizeSpec(input: SupervisorTaskSpec): NormalizedTaskSpec {
    if (input === null || typeof input !== "object") throw new SupervisorValidationError("task spec must be an object");
    const id = validateIdentifier(input.id);
    const command = validateCommand(input.command);
    const args = validateArgs(input.args);
    const cwd = normalizeCwd(input.cwd, this.defaultCwd);
    const env = input.env === undefined ? inheritedEnvironment() : normalizeExplicitEnvironment(input.env);
    const stdio = normalizeStdio(input.stdio);
    const timeoutMs = normalizeTimeout(input.timeoutMs ?? this.defaultTimeoutMs, "timeoutMs");
    const maxOutputBytes = normalizeOutputLimit(input.maxOutputBytes ?? this.defaultMaxOutputBytes);
    const retry = normalizeRetryPolicy(input.retry, this.defaultRetry);
    return Object.freeze({ id, command, args, cwd, env, stdio, timeoutMs, maxOutputBytes, retry });
  }

  private assertCanTrack(id: string, allowHistory: boolean): void {
    if (this.activeTasks.has(id)) throw new SupervisorConflictError();
    if (!allowHistory && this.history.has(id)) throw new SupervisorConflictError("Supervisor task id has already been reaped");
    if (this.activeTasks.size >= this.maxTrackedTasks) throw new SupervisorConflictError("Supervisor task limit reached");
  }

  private createRecord(
    id: string,
    child: SupervisorChild,
    attempt: number,
    maxOutputBytes: number,
    processGroup: boolean,
  ): TaskRecord {
    const startedMs = nowMilliseconds(this.clock);
    const startedAt = isoTime(startedMs);
    let resolveCompletion!: (result: SupervisorReapResult) => void;
    const completion = new Promise<SupervisorReapResult>((resolve) => {
      resolveCompletion = resolve;
    });
    const record: TaskRecord = {
      id,
      attempt,
      child,
      maxOutputBytes,
      startedAt,
      startedMs,
      processGroup,
      pid: validatePid(child.pid),
      state: "running",
      reason: undefined,
      endedAt: undefined,
      endedMs: undefined,
      exitCode: undefined,
      signal: undefined,
      error: undefined,
      stopRequested: false,
      outputTruncated: false,
      outputBytes: 0,
      stdoutBytes: 0,
      stderrBytes: 0,
      stdout: "",
      stderr: "",
      settled: false,
      timeoutStarted: false,
      killPromise: undefined,
      resolveCompletion,
      completion,
    };
    this.activeTasks.set(id, record);
    this.attach(record);
    return record;
  }

  private attach(record: TaskRecord): void {
    const stdout = record.child.stdout;
    const stderr = record.child.stderr;
    stdout?.setEncoding?.("utf8");
    stderr?.setEncoding?.("utf8");
    stdout?.on("data", (chunk) => this.collectOutput(record, "stdout", chunk));
    stderr?.on("data", (chunk) => this.collectOutput(record, "stderr", chunk));
    record.child.once("error", (error) => this.handleChildError(record, error));
    record.child.once("exit", (code, signal) => {
      if (record.settled) return;
      if (code !== null && code !== undefined) record.exitCode = code;
      const normalizedSignal = safeSignal(signal);
      if (normalizedSignal !== null) record.signal = normalizedSignal;
    });
    record.child.once("close", (code, signal) => this.handleClose(record, code, signal));
    // A timeout is opt-in at the task boundary.  A missing timeout never
    // silently converts a long-running engine into a failed job.
    const timeoutMs = this.timeoutFor(record.id);
    if (timeoutMs !== undefined) {
      void Promise.resolve(this.sleep(timeoutMs)).then(() => {
        if (!record.settled && !record.timeoutStarted) {
          record.timeoutStarted = true;
          record.reason = "timeout";
          record.error = summary(new SupervisorTimeoutError());
          void this.stopRecord(record, { force: true, signal: "SIGKILL", reason: "timeout" });
        }
      }).catch(() => {
        // A broken test/runtime sleep seam must not expose its error or leak
        // into the child result.  The process remains tracked.
      });
    }
  }

  private readonly timeouts = new Map<string, number | undefined>();

  private timeoutFor(id: string): number | undefined {
    return this.timeouts.get(id);
  }

  private handleChildError(record: TaskRecord, error: unknown): void {
    if (record.settled) return;
    record.reason = "spawn_error";
    record.error = summary(new SupervisorSpawnError(error));
    this.settle(record, "failed");
  }

  private handleClose(record: TaskRecord, code: number | null, signal: NodeJS.Signals | null): void {
    if (record.settled) return;
    if (code !== null && code !== undefined) record.exitCode = code;
    const normalizedSignal = safeSignal(signal);
    if (normalizedSignal !== null) record.signal = normalizedSignal;
    let reason: SupervisorExitReason;
    let state: SupervisorTaskState;
    if (record.timeoutStarted || record.reason === "timeout") {
      reason = "timeout";
      state = "timed_out";
    } else if (record.outputTruncated || record.reason === "output_limit") {
      reason = "output_limit";
      state = "failed";
    } else if (record.stopRequested) {
      reason = "stopped";
      state = "stopped";
    } else if (record.error?.code === "SupervisorSpawnError") {
      reason = "spawn_error";
      state = "failed";
    } else if (record.signal !== null && record.signal !== undefined) {
      reason = "signal";
      state = "failed";
    } else if (record.exitCode === 0) {
      reason = "success";
      state = "exited";
    } else {
      reason = "exit_code";
      state = "failed";
    }
    record.reason = reason;
    this.settle(record, state);
  }

  private collectOutput(record: TaskRecord, stream: "stdout" | "stderr", chunk: unknown): void {
    if (record.settled || record.outputTruncated) return;
    const text = safeChunk(chunk);
    const bytes = byteLength(text);
    const remaining = Math.max(0, record.maxOutputBytes - record.outputBytes);
    const retained = bytes <= remaining
      ? text
      : Buffer.from(text, "utf8").subarray(0, remaining).toString("utf8");
    if (stream === "stdout") {
      record.stdout += retained;
      record.stdoutBytes += bytes;
    } else {
      record.stderr += retained;
      record.stderrBytes += bytes;
    }
    record.outputBytes = Math.min(record.maxOutputBytes + 1, record.outputBytes + bytes);
    if (record.outputBytes > record.maxOutputBytes) {
      record.outputTruncated = true;
      record.reason = "output_limit";
      record.error = summary(new SupervisorOutputLimitError());
      void this.stopRecord(record, { force: true, signal: "SIGKILL", reason: "output_limit" });
    }
  }

  private settle(record: TaskRecord, state: SupervisorTaskState): void {
    if (record.settled) return;
    record.state = state;
    record.endedMs = nowMilliseconds(this.clock);
    record.endedAt = isoTime(record.endedMs);
    record.settled = true;
    this.activeTasks.delete(record.id);
    this.history.delete(record.id);
    this.history.set(record.id, record);
    while (this.history.size > MAX_SUPERVISOR_HISTORY) {
      const oldest = this.history.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.history.delete(oldest);
    }
    const result = this.result(record);
    record.resolveCompletion(result);
  }

  private result(record: TaskRecord): SupervisorReapResult {
    const reason = record.reason ?? (record.state === "exited" ? "success" : "exit_code");
    return Object.freeze({
      ...this.snapshot(record),
      reason,
      retryableFailure: retryableFailure(reason),
    });
  }

  private snapshot(record: TaskRecord): SupervisorTaskStatus {
    return Object.freeze({
      id: record.id,
      pid: record.pid,
      attempt: record.attempt,
      state: record.state,
      health: statusHealth(record.state, record.reason),
      reason: record.reason,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      exitCode: record.exitCode,
      signal: record.signal,
      outputBytes: Math.min(record.outputBytes, record.maxOutputBytes + 1),
      outputLimitBytes: record.maxOutputBytes,
      outputTruncated: record.outputTruncated,
      stdout: redactOutput(record.stdout, record.maxOutputBytes),
      stderr: redactOutput(record.stderr, record.maxOutputBytes),
      error: record.error,
      stopRequested: record.stopRequested,
    });
  }

  private handle(record: TaskRecord): SupervisorTaskHandle {
    const supervisor = this;
    const handle: SupervisorTaskHandle = {
      id: record.id,
      pid: record.pid,
      attempt: record.attempt,
      done: record.completion,
      get status() {
        return supervisor.snapshot(record);
      },
      getStatus: () => supervisor.snapshot(record),
    };
    return Object.freeze(handle);
  }

  private spawnNormalized(spec: NormalizedTaskSpec, attempt: number, allowHistory: boolean): SupervisorTaskHandle {
    this.assertCanTrack(spec.id, allowHistory);
    let child: SupervisorChild;
    try {
      child = validateChild(this.spawn(spec.command, [...spec.args], {
        cwd: spec.cwd,
        env: spec.env,
        shell: false,
        stdio: spec.stdio,
        detached: this.platform !== "win32",
        windowsHide: true,
      }));
    } catch (error) {
      if (error instanceof SupervisorError) throw error;
      throw new SupervisorSpawnError(error);
    }
    this.timeouts.set(spec.id, spec.timeoutMs);
    try {
      const record = this.createRecord(spec.id, child, attempt, spec.maxOutputBytes, this.platform !== "win32");
      return this.handle(record);
    } finally {
      this.timeouts.delete(spec.id);
    }
  }

  /** Start and track one child.  Retries are available through run(). */
  start(spec: SupervisorTaskSpec): SupervisorTaskHandle {
    return this.spawnNormalized(this.normalizeSpec(spec), 1, false);
  }

  startTask(spec: SupervisorTaskSpec): SupervisorTaskHandle {
    return this.start(spec);
  }

  /** Track an already-created child without spawning it. */
  track(input: SupervisorTrackInput): SupervisorTaskHandle;
  track(id: string, child: SupervisorChild, options?: SupervisorTrackOptions): SupervisorTaskHandle;
  track(inputOrId: SupervisorTrackInput | string, child?: SupervisorChild, options: SupervisorTrackOptions = {}): SupervisorTaskHandle {
    const input: SupervisorTrackInput = typeof inputOrId === "string"
      ? {
        id: inputOrId,
        child: child as SupervisorChild,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
        ...(options.processGroup === undefined ? {} : { processGroup: options.processGroup }),
      }
      : inputOrId;
    const normalized = normalizeTrackInput(input, this.defaultMaxOutputBytes, this.defaultTimeoutMs);
    this.assertCanTrack(normalized.id, false);
    this.timeouts.set(normalized.id, normalized.timeoutMs);
    try {
      const record = this.createRecord(
        normalized.id,
        normalized.child,
        1,
        normalized.maxOutputBytes,
        normalized.processGroup === true,
      );
      return this.handle(record);
    } finally {
      this.timeouts.delete(normalized.id);
    }
  }

  private find(id: string): TaskRecord {
    const normalized = validateIdentifier(id);
    const record = this.activeTasks.get(normalized) ?? this.history.get(normalized);
    if (!record) throw new SupervisorTaskNotFoundError();
    return record;
  }

  status(id: string): SupervisorTaskStatus;
  status(): readonly SupervisorTaskStatus[];
  status(id?: string): SupervisorTaskStatus | readonly SupervisorTaskStatus[] {
    if (id !== undefined) return this.snapshot(this.find(id));
    return this.listStatuses();
  }

  getStatus(id: string): SupervisorTaskStatus {
    return this.status(id) as SupervisorTaskStatus;
  }

  listStatuses(): readonly SupervisorTaskStatus[] {
    const records = [...this.history.values(), ...this.activeTasks.values()]
      .sort((left, right) => left.startedMs - right.startedMs || left.id.localeCompare(right.id));
    return Object.freeze(records.slice(-MAX_SUPERVISOR_HISTORY).map((record) => this.snapshot(record)));
  }

  health(id: string): SupervisorTaskHealthSnapshot;
  health(): SupervisorHealthReport;
  health(id?: string): SupervisorTaskHealthSnapshot | SupervisorHealthReport {
    if (id !== undefined) {
      const status = this.snapshot(this.find(id));
      return Object.freeze({ id: status.id, state: status.state, health: status.health, pid: status.pid });
    }
    const statuses = this.listStatuses();
    const tasks = statuses.map((status) => ({ id: status.id, state: status.state, health: status.health, pid: status.pid }));
    const active = statuses.filter((status) => status.state === "running" || status.state === "stopping").length;
    const unhealthy = statuses.filter((status) => status.health === "unhealthy").length;
    return Object.freeze({
      healthy: unhealthy === 0,
      status: unhealthy > 0 ? "degraded" : active > 0 ? "healthy" : "idle",
      tracked: statuses.length,
      active,
      unhealthy,
      tasks: Object.freeze(tasks),
      tokenRevocation: "not_available",
    });
  }

  healthReport(): SupervisorHealthReport {
    return this.health() as SupervisorHealthReport;
  }

  async reap(id: string): Promise<SupervisorReapResult> {
    return this.find(id).completion;
  }

  async stop(id: string, options: SupervisorStopOptions = {}): Promise<SupervisorStopOutcome> {
    const record = this.find(id);
    return this.stopRecord(record, options);
  }

  private async stopRecord(record: TaskRecord, options: SupervisorStopOptions): Promise<SupervisorStopOutcome> {
    if (record.settled) {
      return {
        id: record.id,
        requested: false,
        accepted: false,
        confirmed: true,
        method: undefined,
        reason: "already_finished",
        state: record.state,
        error: record.error,
      };
    }
    if (record.killPromise) return record.killPromise;
    const timeoutMs = options.timeoutMs === undefined
      ? DEFAULT_SUPERVISOR_STOP_TIMEOUT_MS
      : validateBoundedInteger(options.timeoutMs, "stop timeoutMs", 1, MAX_SUPERVISOR_STOP_TIMEOUT_MS);
    const signal = options.signal ?? (options.force === false ? "SIGTERM" : "SIGKILL");
    const method = selectMethod(this.platform, record.pid, record.processGroup);
    record.stopRequested = true;
    if (options.reason === "timeout") record.reason = "timeout";
    if (options.reason === "output_limit") record.reason = "output_limit";
    record.state = "stopping";
    const request: SupervisorKillRequest = {
      taskId: record.id,
      pid: record.pid,
      child: record.child,
      platform: this.platform,
      method,
      signal,
      processGroup: record.processGroup,
    };
    const operation = (async (): Promise<SupervisorStopOutcome> => {
      let killResult: SupervisorKillResult;
      try {
        const killPromise = Promise.resolve(this.killer(request));
        const timeoutPromise = Promise.resolve(this.sleep(timeoutMs)).then(() => undefined);
        const raced = await Promise.race([
          killPromise.then((value) => ({ kind: "result" as const, value })),
          timeoutPromise.then(() => ({ kind: "timeout" as const })),
        ]);
        if (raced.kind === "timeout") {
          record.error = summary(new SupervisorKillError());
          if (!record.settled) record.state = "stopping";
          return {
            id: record.id,
            requested: true,
            accepted: false,
            confirmed: false,
            method,
            reason: "timed_out",
            state: record.state,
            error: record.error,
          };
        }
        killResult = raced.value;
      } catch (error) {
        const safe = errorFromUnknown(error, new SupervisorKillError());
        record.error = summary(safe);
        if (!record.settled) record.state = "running";
        return {
          id: record.id,
          requested: true,
          accepted: false,
          confirmed: false,
          method,
          reason: "failed",
          state: record.state,
          error: record.error,
        };
      }
      if (!killResult.ok) {
        record.error = summary(new SupervisorKillError());
        if (!record.settled) record.state = "running";
        return {
          id: record.id,
          requested: true,
          accepted: false,
          confirmed: false,
          method: killResult.method,
          reason: killResult.reason === "unavailable" ? "unavailable" : "failed",
          state: record.state,
          error: record.error,
        };
      }
      return {
        id: record.id,
        requested: true,
        accepted: true,
        confirmed: record.settled,
        method: killResult.method,
        reason: "requested",
        state: record.state,
        error: record.error,
      };
    })();
    record.killPromise = operation;
    return operation;
  }

  private async revokeTokens(): Promise<SupervisorTokenRevocationResult> {
    if (this.tokenRevocation === undefined) {
      return Object.freeze({
        available: false,
        status: "not_available" as const,
        reason: "Warden is not implemented in the Runner supervisor" as const,
      });
    }

    try {
      const result = typeof this.tokenRevocation === "function"
        ? this.tokenRevocation()
        : this.tokenRevocation.revokeAll();
      const revoked = await Promise.resolve(result);
      if (revoked === false) {
        return Object.freeze({
          available: true,
          status: "failed" as const,
          reason: "Token revocation callback failed" as const,
        });
      }
      return Object.freeze({ available: true, status: "revoked" as const });
    } catch {
      // Revocation is an infrastructure seam. Do not expose callback errors,
      // which may contain credentials or implementation-specific paths.
      return Object.freeze({
        available: true,
        status: "failed" as const,
        reason: "Token revocation callback failed" as const,
      });
    }
  }

  async killAll(options: { readonly timeoutMs?: number } = {}): Promise<SupervisorKillAllResult> {
    const timeoutMs = options.timeoutMs === undefined
      ? DEFAULT_SUPERVISOR_STOP_TIMEOUT_MS
      : validateBoundedInteger(options.timeoutMs, "killAll timeoutMs", 1, MAX_SUPERVISOR_STOP_TIMEOUT_MS);
    const records = [...this.activeTasks.values()].slice(0, this.maxTrackedTasks);
    const outcomes = await Promise.all(records.map((record) => this.stopRecord(record, {
      force: true,
      signal: "SIGKILL",
      timeoutMs,
      reason: "kill_all",
    })));
    const accepted = outcomes.filter((outcome) => outcome.accepted).length;
    const confirmed = outcomes.filter((outcome) => outcome.confirmed).length;
    const failed = outcomes.filter((outcome) => !outcome.accepted).length;
    const tokenRevocation = await this.revokeTokens();
    return Object.freeze({
      requested: records.length,
      accepted,
      confirmed,
      failed,
      outstanding: records.length - confirmed,
      outcomes: Object.freeze(outcomes),
      tokenRevocation,
    });
  }

  async run(spec: SupervisorTaskSpec): Promise<SupervisorRunResult> {
    const normalized = this.normalizeSpec(spec);
    const backoffMs: number[] = [];
    let last: SupervisorReapResult | undefined;
    let attempts = 0;
    while (attempts < normalized.retry.maxAttempts) {
      attempts += 1;
      this.history.delete(normalized.id);
      try {
        this.spawnNormalized(normalized, attempts, true);
        last = await this.reap(normalized.id);
      } catch (error) {
        if (!(error instanceof SupervisorSpawnError)) throw error;
        const startMs = nowMilliseconds(this.clock);
        const failedStatus: SupervisorReapResult = Object.freeze({
          id: normalized.id,
          pid: undefined,
          attempt: attempts,
          state: "failed",
          health: "unhealthy",
          reason: "spawn_error",
          startedAt: isoTime(startMs),
          endedAt: isoTime(startMs),
          exitCode: undefined,
          signal: undefined,
          outputBytes: 0,
          outputLimitBytes: normalized.maxOutputBytes,
          outputTruncated: false,
          stdout: "",
          stderr: "",
          error: summary(error),
          stopRequested: false,
          retryableFailure: true,
        });
        last = failedStatus;
      }
      if (last === undefined || !isRetryEligible(last, normalized.retry, attempts)) break;
      const delay = computeSupervisorBackoff(attempts, {
        baseDelayMs: normalized.retry.baseDelayMs,
        maxDelayMs: normalized.retry.maxDelayMs,
        jitterMs: 0,
      });
      backoffMs.push(delay);
      await this.sleep(delay);
    }
    if (last === undefined) throw new SupervisorRetryExhaustedError();
    return Object.freeze({ ...last, attempts, retries: Math.max(0, attempts - 1), backoffMs: Object.freeze(backoffMs) });
  }
}

export const ChildProcessSupervisor = Supervisor;
export const ProcessSupervisor = Supervisor;
export const createSupervisor = (options: SupervisorOptions = {}): Supervisor => new Supervisor(options);
