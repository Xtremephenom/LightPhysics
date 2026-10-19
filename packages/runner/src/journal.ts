import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  normalizePriority,
  normalizeResourceRequest,
  type MockHardwareProfile,
  type PriorityInput,
  type ResourceRequest,
  type ResourceRequestInput,
} from "./governor.ts";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import {
  mkdirSync,
} from "node:fs";
import path from "node:path";

// Keep the same runtime loading seam as the Ledger package.  Node 24 supplies
// this built-in module, while the pinned TypeScript/Vitest toolchain still
// needs it resolved synchronously rather than bundled as a package import.
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

export const RUNNER_SCHEMA_VERSION = 1;
export const DEFAULT_RUNNER_DATABASE_RELATIVE = path.join("db", "runner.sqlite");
export const DEFAULT_MAX_PROGRESS_EVENTS = 128;
export const MAX_JOB_PAYLOAD_BYTES = 64 * 1024;
export const MAX_CHECKPOINT_BYTES = 64 * 1024;
export const MAX_PROGRESS_EVENT_BYTES = 8 * 1024;
export const MAX_ERROR_DETAILS_BYTES = 16 * 1024;
export const MAX_JOB_ID_BYTES = 256;
export const MAX_STEP_ID_BYTES = 256;
export const MAX_EVENT_ID_BYTES = 256;
export const MAX_TEXT_BYTES = 4 * 1024;
export const MAX_JSON_DEPTH = 24;
export const MAX_JSON_ITEMS = 1_024;

export const JOB_STATES = [
  "queued",
  "running",
  "waiting_provider",
  "waiting_human",
  "succeeded",
  "failed",
  "cancelled",
  "orphaned",
] as const;

export type JobState = (typeof JOB_STATES)[number];
export type JobPriority = PriorityInput;

export type RunnerJsonPrimitive = string | number | boolean | null;
export type RunnerJsonValue =
  | RunnerJsonPrimitive
  | RunnerJsonValue[]
  | { readonly [key: string]: RunnerJsonValue };

export interface JobErrorDetails {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: RunnerJsonValue;
}

export interface Job {
  readonly id: string;
  readonly type: string;
  readonly state: JobState;
  readonly payload: RunnerJsonValue;
  readonly result?: RunnerJsonValue;
  readonly resources: ResourceRequest;
  readonly priority: number;
  readonly priorityClass: string;
  readonly resumable: boolean;
  readonly attempts: number;
  readonly cancelRequested: boolean;
  readonly cancelReason?: string;
  readonly error?: JobErrorDetails;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly lastStartedAt?: string;
  readonly finishedAt?: string;
  readonly orphanedAt?: string;
}

export interface CreateJobInput {
  readonly id?: string;
  readonly type?: string;
  readonly kind?: string;
  readonly payload?: unknown;
  /** Compatibility spelling for callers that describe a job input. */
  readonly input?: unknown;
  readonly resources?: ResourceRequestInput;
  readonly resourceRequest?: ResourceRequestInput;
  readonly priority?: PriorityInput;
  readonly resumable?: boolean;
}

export interface JobJournalOptions {
  readonly databasePath?: string;
  readonly dbPath?: string;
  readonly home?: string;
  readonly maxProgressEvents?: number;
  readonly clock?: () => Date;
}

export interface TransitionOptions {
  readonly at?: Date | string;
  readonly now?: Date | string;
  readonly expectedState?: JobState;
  readonly reason?: string;
  readonly error?: unknown;
  readonly result?: unknown;
}

export interface CheckpointInput {
  readonly stepId?: string;
  readonly step?: string;
  readonly value?: unknown;
  readonly data?: unknown;
}

export interface JobCheckpoint {
  readonly jobId: string;
  readonly stepId: string;
  readonly value: RunnerJsonValue;
  readonly completedAt: string;
}

export interface ProgressInput {
  readonly eventId?: string;
  readonly id?: string;
  readonly stage?: string;
  readonly message?: string;
  /** Fraction in [0, 1]. */
  readonly progress?: number;
  /** Friendly percentage spelling in [0, 100]. */
  readonly percent?: number;
  readonly data?: unknown;
  readonly payload?: unknown;
}

export interface JobProgressEvent {
  readonly jobId: string;
  readonly sequence: number;
  readonly eventId: string;
  readonly stage?: string;
  readonly message?: string;
  readonly progress?: number;
  readonly data: RunnerJsonValue;
  readonly createdAt: string;
}

export type RecoveryAction = "resumed" | "orphaned";

export interface RecoveryOutcome {
  readonly jobId: string;
  readonly previousState: "running";
  readonly state: "queued" | "orphaned";
  readonly action: RecoveryAction;
  readonly resumable: boolean;
  readonly reason: string;
}

export interface RecoveryReport {
  readonly outcomes: readonly RecoveryOutcome[];
  readonly resumed: readonly string[];
  readonly orphaned: readonly string[];
}

export interface ListJobsOptions {
  readonly state?: JobState | readonly JobState[];
  readonly limit?: number;
}

export interface ListProgressOptions {
  readonly limit?: number;
  readonly afterSequence?: number;
}

export type RunnerErrorCode =
  | "RunnerValidationError"
  | "RunnerNotFound"
  | "RunnerConflict"
  | "IllegalJobTransition"
  | "SensitiveDataRejected"
  | "RunnerClosed"
  | "JobNotResumable"
  | "CancellationNotRequested"
  | "RunnerStorageError";

export class RunnerError extends Error {
  readonly code: RunnerErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(code: RunnerErrorCode, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = code;
    this.code = code;
    this.details = details;
  }
}

export class RunnerValidationError extends RunnerError {
  constructor(message: string) {
    super("RunnerValidationError", message);
  }
}

export class RunnerNotFoundError extends RunnerError {
  constructor(jobId: string) {
    super("RunnerNotFound", `Job ${jobId} was not found`, { jobId });
  }
}

export class RunnerConflictError extends RunnerError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super("RunnerConflict", message, details);
  }
}

export class IllegalJobTransitionError extends RunnerError {
  readonly jobId: string;
  readonly from: JobState;
  readonly to: JobState;

  constructor(jobId: string, from: JobState, to: JobState) {
    super("IllegalJobTransition", `Job ${jobId} cannot transition from ${from} to ${to}`, {
      jobId,
      from,
      to,
    });
    this.jobId = jobId;
    this.from = from;
    this.to = to;
  }
}

export class SensitiveDataRejectedError extends RunnerError {
  constructor(message = "Payload contains a secret-like field or value") {
    super("SensitiveDataRejected", message);
  }
}

export class RunnerClosedError extends RunnerError {
  constructor() {
    super("RunnerClosed", "The job journal is closed");
  }
}

export class JobNotResumableError extends RunnerError {
  constructor(jobId: string) {
    super("JobNotResumable", `Job ${jobId} is not explicitly resumable`, { jobId });
  }
}

export class CancellationNotRequestedError extends RunnerError {
  constructor(jobId: string) {
    super("CancellationNotRequested", `Job ${jobId} has no cancellation request`, { jobId });
  }
}

export class RunnerStorageError extends RunnerError {
  constructor(message: string) {
    super("RunnerStorageError", message);
  }
}

const SENSITIVE_KEY = /(?:secret|token|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|credential|authorization|cookie|session[_-]?secret)/i;
const SECRET_VALUE = /(?:-----BEGIN[\s\S]*PRIVATE KEY-----|\b(?:sk|rk|pk|ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9][A-Za-z0-9._-]{11,}|\bAKIA[0-9A-Z]{16}\b|\bBearer\s+[A-Za-z0-9._~+/=-]{12,})/i;

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function jsonFailure(message: string): RunnerValidationError {
  return new RunnerValidationError(`Invalid Runner JSON: ${message}`);
}

function assertSafeText(value: string, field: string, maxBytes = MAX_TEXT_BYTES): string {
  if (value.includes("\u0000")) throw new RunnerValidationError(`${field} may not contain a NUL character`);
  if (byteLength(value) > maxBytes) throw new RunnerValidationError(`${field} exceeds ${maxBytes} bytes`);
  if (SECRET_VALUE.test(value)) throw new SensitiveDataRejectedError();
  return value;
}

function assertObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RunnerValidationError(`${field} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new RunnerValidationError(`${field} must be a plain JSON object`);
  }
  return value as Record<string, unknown>;
}

function normalizeJson(
  value: unknown,
  depth: number,
  rejectSecrets: boolean,
  ancestors = new WeakSet<object>(),
): RunnerJsonValue {
  if (depth > MAX_JSON_DEPTH) throw jsonFailure("maximum nesting depth exceeded");
  if (value === null) return null;
  if (typeof value === "string") {
    if (byteLength(value) > MAX_JOB_PAYLOAD_BYTES) throw jsonFailure("string exceeds the payload bound");
    if (rejectSecrets && SECRET_VALUE.test(value)) throw new SensitiveDataRejectedError();
    return value;
  }
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw jsonFailure("numbers must be finite");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object" || value === undefined || typeof value === "bigint" || typeof value === "function") {
    throw jsonFailure("only JSON values are supported");
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_JSON_ITEMS) throw jsonFailure("array contains too many items");
    if (ancestors.has(value)) throw jsonFailure("cyclic values are not supported");
    ancestors.add(value);
    try {
      return value.map((item) => normalizeJson(item, depth + 1, rejectSecrets, ancestors));
    } finally {
      ancestors.delete(value);
    }
  }
  const object = assertObject(value, "value");
  if (ancestors.has(object)) throw jsonFailure("cyclic values are not supported");
  ancestors.add(object);
  const keys = Object.keys(object).sort();
  if (keys.length > MAX_JSON_ITEMS) throw jsonFailure("object contains too many keys");
  const result: { [key: string]: RunnerJsonValue } = {};
  try {
    for (const key of keys) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        throw jsonFailure(`reserved object key ${key} is not allowed`);
      }
      if (rejectSecrets && SENSITIVE_KEY.test(key)) throw new SensitiveDataRejectedError();
      result[key] = normalizeJson(object[key], depth + 1, rejectSecrets, ancestors);
    }
  } finally {
    ancestors.delete(object);
  }
  return result;
}

/** Stable, recursively key-sorted JSON used by every runner payload column. */
export function canonicalizeRunnerJson(value: unknown): RunnerJsonValue {
  return normalizeJson(value, 0, true);
}

function canonicalJson(value: unknown, maxBytes: number): string {
  const normalized = canonicalizeRunnerJson(value);
  const serialized = JSON.stringify(normalized);
  if (serialized === undefined) throw jsonFailure("value is not serializable");
  if (byteLength(serialized) > maxBytes) {
    throw new RunnerValidationError(`JSON payload exceeds ${maxBytes} bytes`);
  }
  return serialized;
}

function redactText(value: string, maxBytes = MAX_TEXT_BYTES): string {
  let result = value
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[redacted]")
    .replace(/((?:secret|token|password|api[_-]?key|authorization)\s*[:=]\s*)[^,;\s]+/gi, "$1[redacted]")
    .replace(SECRET_VALUE, "[redacted]");
  if (byteLength(result) > maxBytes) result = result.slice(0, maxBytes);
  return result;
}

function sanitizeErrorValue(value: unknown, depth = 0): RunnerJsonValue {
  if (depth > MAX_JSON_DEPTH) return "[truncated]";
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : "[invalid-number]";
  if (typeof value === "string") return redactText(value, MAX_ERROR_DETAILS_BYTES);
  if (Array.isArray(value)) {
    return value.slice(0, MAX_JSON_ITEMS).map((item) => sanitizeErrorValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const result: { [key: string]: RunnerJsonValue } = {};
    let redacted = false;
    for (const key of Object.keys(object).sort()) {
      if (SENSITIVE_KEY.test(key) || key === "stack" || key === "cause") {
        redacted = true;
        continue;
      }
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        redacted = true;
        continue;
      }
      result[key] = sanitizeErrorValue(object[key], depth + 1);
    }
    if (redacted) result.redacted = true;
    return result;
  }
  return "[unsupported]";
}

function errorDetails(error: unknown): JobErrorDetails {
  let code = "JobFailed";
  let message = "Job failed";
  let retryable = false;
  let details: unknown;
  if (error instanceof Error) {
    message = error.message || message;
    const candidate = error as Error & { code?: unknown; retryable?: unknown; details?: unknown };
    if (typeof candidate.code === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(candidate.code)) code = candidate.code;
    if (typeof candidate.retryable === "boolean") retryable = candidate.retryable;
    details = candidate.details;
  } else if (typeof error === "string") {
    message = error;
  } else if (error !== undefined && error !== null) {
    const candidate = error as Record<string, unknown>;
    if (typeof candidate.code === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(candidate.code)) code = candidate.code;
    if (typeof candidate.message === "string") message = candidate.message;
    if (typeof candidate.retryable === "boolean") retryable = candidate.retryable;
    details = property(candidate, "details") ? candidate.details : error;
  }
  const safe: JobErrorDetails = {
    code,
    message: redactText(message),
    retryable,
    ...(details === undefined ? {} : { details: sanitizeErrorValue(details) }),
  };
  let serialized: string;
  try {
    serialized = JSON.stringify(safe);
  } catch {
    return { code, message: "Job failed (error details unavailable)", retryable };
  }
  if (byteLength(serialized) > MAX_ERROR_DETAILS_BYTES) {
    return { code, message: redactText(message), retryable, details: { redacted: true } };
  }
  return safe;
}

function validateIdentifier(value: unknown, field: string, maxBytes: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RunnerValidationError(`${field} must be a non-empty string`);
  }
  if (byteLength(value) > maxBytes) throw new RunnerValidationError(`${field} exceeds ${maxBytes} bytes`);
  if (value.includes("\u0000")) throw new RunnerValidationError(`${field} may not contain a NUL character`);
  if (SECRET_VALUE.test(value)) throw new SensitiveDataRejectedError();
  return value;
}

function validState(value: unknown): JobState {
  if (typeof value !== "string" || !(JOB_STATES as readonly string[]).includes(value)) {
    throw new RunnerStorageError("Stored job state is invalid");
  }
  return value as JobState;
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") throw new RunnerStorageError(`Stored ${field} is not text`);
  return value;
}

function sqliteInteger(value: unknown, field: string): number {
  const numberValue = typeof value === "bigint" ? Number(value) : Number(value);
  if (!Number.isSafeInteger(numberValue) || numberValue < 0) {
    throw new RunnerStorageError(`Stored ${field} is not a safe non-negative integer`);
  }
  return numberValue;
}

function sqliteChanges(value: unknown): number {
  const result = typeof value === "bigint" ? Number(value) : Number(value);
  if (!Number.isSafeInteger(result)) throw new RunnerStorageError("SQLite reported an invalid change count");
  return result;
}

function storedJson(value: unknown, field: string, maxBytes: number): RunnerJsonValue {
  if (typeof value !== "string") throw new RunnerStorageError(`Stored ${field} is not JSON text`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new RunnerStorageError(`Stored ${field} is not valid JSON`);
  }
  let canonical: string;
  try {
    canonical = canonicalJson(parsed, maxBytes);
  } catch (error) {
    throw new RunnerStorageError(`Stored ${field} is not canonical or safe JSON: ${error instanceof Error ? error.message : "invalid"}`);
  }
  if (canonical !== value) throw new RunnerStorageError(`Stored ${field} is not canonical JSON`);
  return parsed as RunnerJsonValue;
}

function iso(value: Date | string): string {
  if (value instanceof Date && !Number.isFinite(value.getTime())) {
    throw new RunnerValidationError("timestamp must be a valid ISO time");
  }
  const candidate = value instanceof Date ? value.toISOString() : value;
  if (typeof candidate !== "string" || !Number.isFinite(new Date(candidate).getTime())) {
    throw new RunnerValidationError("timestamp must be a valid ISO time");
  }
  return new Date(candidate).toISOString();
}

function resolveDatabasePath(options: JobJournalOptions | string | undefined): string {
  if (typeof options === "string") return options === ":memory:" ? options : path.resolve(options);
  const home = path.resolve(options?.home ?? process.env.LP_HOME ?? process.cwd());
  const configured = options?.databasePath ?? options?.dbPath;
  if (!configured) return path.join(home, DEFAULT_RUNNER_DATABASE_RELATIVE);
  if (configured === ":memory:") return configured;
  return path.isAbsolute(configured) ? path.resolve(configured) : path.resolve(home, configured);
}

function ensureDatabaseParent(databasePath: string): void {
  if (databasePath === ":memory:" || databasePath.startsWith("file:")) return;
  mkdirSync(path.dirname(databasePath), { recursive: true });
}

function migrationTimestamp(): string {
  return new Date().toISOString();
}

function applyMigrations(database: DatabaseSyncType): void {
  database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
  database.exec(`
    CREATE TABLE IF NOT EXISTS runner_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);
  const userVersionRow = database.prepare("PRAGMA user_version").get() as Record<string, unknown> | undefined;
  const userVersion = sqliteInteger(userVersionRow?.user_version, "user_version");
  if (userVersion > RUNNER_SCHEMA_VERSION) {
    throw new RunnerStorageError("Runner database requires a newer schema version");
  }
  if (userVersion === 0) {
    database.exec("BEGIN IMMEDIATE;");
    try {
      database.exec(`
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('queued','running','waiting_provider','waiting_human','succeeded','failed','cancelled','orphaned')),
          payload_json TEXT NOT NULL,
          result_json TEXT,
          resource_json TEXT NOT NULL,
          priority INTEGER NOT NULL,
          priority_class TEXT NOT NULL,
          resumable INTEGER NOT NULL CHECK (resumable IN (0,1)),
          attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
          cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0,1)),
          cancel_reason TEXT,
          error_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          started_at TEXT,
          last_started_at TEXT,
          finished_at TEXT,
          orphaned_at TEXT
        ) STRICT;
        CREATE INDEX IF NOT EXISTS jobs_state_priority ON jobs(state, priority DESC, created_at, id);
        CREATE TABLE IF NOT EXISTS job_checkpoints (
          job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
          step_id TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          completed_at TEXT NOT NULL,
          PRIMARY KEY(job_id, step_id)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS job_progress (
          job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
          sequence INTEGER NOT NULL CHECK (sequence > 0),
          event_id TEXT NOT NULL,
          stage TEXT,
          message TEXT,
          progress REAL CHECK (progress IS NULL OR (progress >= 0 AND progress <= 1)),
          data_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(job_id, sequence),
          UNIQUE(job_id, event_id)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS job_progress_order ON job_progress(job_id, sequence);
        INSERT INTO runner_migrations(version, name, applied_at)
          VALUES (1, 'initial job journal', '${migrationTimestamp()}');
        PRAGMA user_version = 1;
      `);
      database.exec("COMMIT;");
    } catch (error) {
      try { database.exec("ROLLBACK;"); } catch { /* preserve the migration error */ }
      throw error;
    }
  }
  const migration = database.prepare("SELECT version FROM runner_migrations WHERE version = 1").get();
  if (!migration) throw new RunnerStorageError("Runner migration metadata is incomplete");
}

function terminal(state: JobState): boolean {
  return state === "succeeded" || state === "failed" || state === "cancelled" || state === "orphaned";
}

function checkpointable(state: JobState): boolean {
  return !terminal(state);
}

const ALLOWED_TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = Object.freeze({
  queued: ["running", "cancelled"],
  running: ["waiting_provider", "waiting_human", "succeeded", "failed", "cancelled", "orphaned"],
  waiting_provider: ["running", "waiting_human", "succeeded", "failed", "cancelled", "orphaned"],
  waiting_human: ["running", "waiting_provider", "succeeded", "failed", "cancelled", "orphaned"],
  succeeded: [],
  failed: [],
  cancelled: [],
  orphaned: [],
});

function property<T extends object>(object: T, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

type SqlRow = Record<string, unknown>;

export class JobJournal {
  readonly databasePath: string;
  readonly db: DatabaseSyncType;
  readonly database: DatabaseSyncType;
  readonly maxProgressEvents: number;
  private readonly clock: () => Date;
  private isClosed = false;

  constructor(options: JobJournalOptions | string = {}) {
    const normalizedOptions: JobJournalOptions = typeof options === "string" ? { databasePath: options } : options;
    const maxProgressEvents = normalizedOptions.maxProgressEvents ?? DEFAULT_MAX_PROGRESS_EVENTS;
    if (!Number.isSafeInteger(maxProgressEvents) || maxProgressEvents < 1 || maxProgressEvents > 10_000) {
      throw new RunnerValidationError("maxProgressEvents must be an integer from 1 through 10000");
    }
    this.maxProgressEvents = maxProgressEvents;
    this.clock = normalizedOptions.clock ?? (() => new Date());
    this.databasePath = resolveDatabasePath(normalizedOptions);
    ensureDatabaseParent(this.databasePath);
    this.db = new DatabaseSync(this.databasePath, { enableForeignKeyConstraints: true });
    this.database = this.db;
    try {
      applyMigrations(this.db);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private ensureOpen(): void {
    if (this.isClosed) throw new RunnerClosedError();
  }

  private now(value?: Date | string): string {
    if (value !== undefined) return iso(value);
    const current = this.clock();
    if (!(current instanceof Date)) throw new RunnerValidationError("clock must return a Date");
    return iso(current);
  }

  private transaction<T>(callback: () => T): T {
    this.ensureOpen();
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const result = callback();
      this.db.exec("COMMIT;");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK;"); } catch { /* preserve the operation error */ }
      throw error;
    }
  }

  private row(id: string): SqlRow | undefined {
    return this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as SqlRow | undefined;
  }

  private rowToJob(row: SqlRow): Job {
    const id = validateIdentifier(row.id, "stored job id", MAX_JOB_ID_BYTES);
    const type = validateIdentifier(row.type, "stored job type", MAX_JOB_ID_BYTES);
    const state = validState(row.state);
    const payload = storedJson(row.payload_json, "job payload", MAX_JOB_PAYLOAD_BYTES);
    const resourceValue = storedJson(row.resource_json, "resource request", MAX_CHECKPOINT_BYTES);
    const resources = normalizeResourceRequest(resourceValue as unknown as ResourceRequestInput);
    const errorValue = row.error_json === null || row.error_json === undefined
      ? undefined
      : storedJson(row.error_json, "job error", MAX_ERROR_DETAILS_BYTES);
    const resultValue = row.result_json === null || row.result_json === undefined
      ? undefined
      : storedJson(row.result_json, "job result", MAX_JOB_PAYLOAD_BYTES);
    const createdAt = validateIdentifier(row.created_at, "stored created_at", MAX_TEXT_BYTES);
    const updatedAt = validateIdentifier(row.updated_at, "stored updated_at", MAX_TEXT_BYTES);
    const startedAt = optionalText(row.started_at, "started_at");
    const lastStartedAt = optionalText(row.last_started_at, "last_started_at");
    const finishedAt = optionalText(row.finished_at, "finished_at");
    const orphanedAt = optionalText(row.orphaned_at, "orphaned_at");
    const cancelReason = optionalText(row.cancel_reason, "cancel_reason");
    const error = errorValue === undefined ? undefined : errorValue as unknown as JobErrorDetails;
    return {
      id,
      type,
      state,
      payload,
      ...(resultValue === undefined ? {} : { result: resultValue }),
      resources,
      priority: sqliteInteger(row.priority, "priority"),
      priorityClass: validateIdentifier(row.priority_class, "priority_class", MAX_TEXT_BYTES),
      resumable: sqliteInteger(row.resumable, "resumable") === 1,
      attempts: sqliteInteger(row.attempts, "attempts"),
      cancelRequested: sqliteInteger(row.cancel_requested, "cancel_requested") === 1,
      ...(cancelReason === undefined ? {} : { cancelReason }),
      ...(error === undefined ? {} : { error }),
      createdAt,
      updatedAt,
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(lastStartedAt === undefined ? {} : { lastStartedAt }),
      ...(finishedAt === undefined ? {} : { finishedAt }),
      ...(orphanedAt === undefined ? {} : { orphanedAt }),
    };
  }

  private require(id: string): Job {
    const normalizedId = validateIdentifier(id, "job id", MAX_JOB_ID_BYTES);
    const row = this.row(normalizedId);
    if (!row) throw new RunnerNotFoundError(normalizedId);
    return this.rowToJob(row);
  }

  create(input: CreateJobInput = {}): Job {
    return this.createJob(input);
  }

  enqueue(input: CreateJobInput = {}): Job {
    return this.createJob(input);
  }

  createJob(input: CreateJobInput = {}): Job {
    this.ensureOpen();
    const id = validateIdentifier(input.id ?? `job-${randomUUID()}`, "job id", MAX_JOB_ID_BYTES);
    const type = validateIdentifier(input.type ?? input.kind ?? "generic", "job type", MAX_JOB_ID_BYTES);
    const payloadInput = property(input, "payload") ? input.payload : input.input;
    const payloadJson = canonicalJson(payloadInput === undefined ? null : payloadInput, MAX_JOB_PAYLOAD_BYTES);
    const resourcesInput = input.resources ?? input.resourceRequest ?? {};
    const resources = normalizeResourceRequest(resourcesInput);
    const resourceJson = canonicalJson(resources, MAX_CHECKPOINT_BYTES);
    const priority = normalizePriority(input.priority);
    const createdAt = this.now();
    try {
      this.db.prepare(`
        INSERT INTO jobs(
          id, type, state, payload_json, result_json, resource_json,
          priority, priority_class, resumable, attempts, cancel_requested,
          cancel_reason, error_json, created_at, updated_at,
          started_at, last_started_at, finished_at, orphaned_at
        ) VALUES (?, ?, 'queued', ?, NULL, ?, ?, ?, ?, 0, 0, NULL, NULL, ?, ?, NULL, NULL, NULL, NULL)
      `).run(
        id,
        type,
        payloadJson,
        resourceJson,
        priority.weight,
        priority.class,
        input.resumable === true ? 1 : 0,
        createdAt,
        createdAt,
      );
    } catch (error) {
      if (error instanceof Error && /unique|constraint/i.test(error.message)) {
        throw new RunnerConflictError(`Job ${id} already exists`, { jobId: id });
      }
      throw error;
    }
    return this.require(id);
  }

  get(id: string): Job | undefined {
    this.ensureOpen();
    const normalizedId = validateIdentifier(id, "job id", MAX_JOB_ID_BYTES);
    const row = this.row(normalizedId);
    return row ? this.rowToJob(row) : undefined;
  }

  getJob(id: string): Job | undefined {
    return this.get(id);
  }

  requireJob(id: string): Job {
    this.ensureOpen();
    return this.require(id);
  }

  listJobs(options: ListJobsOptions = {}): readonly Job[] {
    this.ensureOpen();
    const states = options.state === undefined
      ? undefined
      : Array.isArray(options.state) ? options.state : [options.state];
    if (states?.some((state) => !(JOB_STATES as readonly string[]).includes(state))) {
      throw new RunnerValidationError("listJobs contains an unknown state");
    }
    if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 10_000)) {
      throw new RunnerValidationError("job list limit must be an integer from 1 through 10000");
    }
    const values: Array<string | number> = [];
    const clauses: string[] = [];
    if (states && states.length > 0) {
      clauses.push(`state IN (${states.map(() => "?").join(",")})`);
      values.push(...states);
    }
    const limit = options.limit === undefined ? "" : " LIMIT ?";
    if (options.limit !== undefined) values.push(options.limit);
    const rows = this.db.prepare(`SELECT * FROM jobs ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY created_at ASC, id ASC${limit}`).all(...values) as unknown as SqlRow[];
    return rows.map((row) => this.rowToJob(row));
  }

  transition(jobId: string, nextState: JobState, options: TransitionOptions = {}): Job {
    this.ensureOpen();
    if (!(JOB_STATES as readonly string[]).includes(nextState)) throw new RunnerValidationError(`unknown job state ${nextState}`);
    const job = this.require(jobId);
    if (options.expectedState !== undefined && options.expectedState !== job.state) {
      throw new RunnerConflictError(`Job ${job.id} is ${job.state}, expected ${options.expectedState}`, {
        jobId: job.id,
        expectedState: options.expectedState,
        actualState: job.state,
      });
    }
    if (nextState === job.state) return job;
    if (!ALLOWED_TRANSITIONS[job.state].includes(nextState)) {
      throw new IllegalJobTransitionError(job.id, job.state, nextState);
    }
    if (nextState === "running" && job.cancelRequested) {
      throw new RunnerConflictError(`Job ${job.id} has a pending cancellation request`, { jobId: job.id });
    }
    return this.applyTransition(job, nextState, options);
  }

  private applyTransition(job: Job, nextState: JobState, options: TransitionOptions, recovery = false): Job {
    const at = this.now(options.at ?? options.now);
    const started = nextState === "running";
    const terminalState = terminal(nextState);
    let attempts = job.attempts;
    let startedAt = job.startedAt;
    let lastStartedAt = job.lastStartedAt;
    let finishedAt: string | null | undefined = job.finishedAt;
    let orphanedAt: string | null | undefined = job.orphanedAt;
    let cancelRequested = job.cancelRequested;
    let cancelReason: string | null | undefined = job.cancelReason;
    let errorJson: string | null = job.error === undefined ? null : canonicalJson(job.error, MAX_ERROR_DETAILS_BYTES);
    let resultJson: string | null = job.result === undefined ? null : canonicalJson(job.result, MAX_JOB_PAYLOAD_BYTES);

    if (started) {
      attempts += 1;
      startedAt ??= at;
      lastStartedAt = at;
      finishedAt = null;
      orphanedAt = null;
      errorJson = null;
    }
    if (nextState === "queued" && recovery) {
      finishedAt = null;
      orphanedAt = null;
      errorJson = null;
      cancelRequested = false;
      cancelReason = null;
    }
    if (nextState === "succeeded") {
      finishedAt = at;
      errorJson = null;
      if (property(options, "result")) resultJson = canonicalJson(options.result, MAX_JOB_PAYLOAD_BYTES);
    }
    if (nextState === "failed") {
      finishedAt = at;
      errorJson = canonicalJson(errorDetails(options.error), MAX_ERROR_DETAILS_BYTES);
    }
    if (nextState === "cancelled") {
      finishedAt = at;
      cancelRequested = true;
      cancelReason = options.reason === undefined ? cancelReason ?? null : redactText(assertSafeText(options.reason, "cancel reason"));
    }
    if (nextState === "orphaned") {
      finishedAt = at;
      orphanedAt = at;
      const reason = options.reason ?? "Runner stopped while the job was running";
      errorJson = canonicalJson(
        {
          code: "JobOrphaned",
          message: redactText(reason),
          retryable: false,
        },
        MAX_ERROR_DETAILS_BYTES,
      );
    }
    if (nextState === "waiting_provider" || nextState === "waiting_human") {
      finishedAt = null;
    }
    if (nextState === "queued" && !recovery) {
      throw new IllegalJobTransitionError(job.id, job.state, nextState);
    }

    const changes = this.transaction(() => this.db.prepare(`
      UPDATE jobs SET
        state = ?, attempts = ?, cancel_requested = ?, cancel_reason = ?,
        error_json = ?, result_json = ?, updated_at = ?,
        started_at = ?, last_started_at = ?, finished_at = ?, orphaned_at = ?
      WHERE id = ? AND state = ?
    `).run(
      nextState,
      attempts,
      cancelRequested ? 1 : 0,
      cancelReason ?? null,
      errorJson,
      resultJson,
      at,
      startedAt ?? null,
      lastStartedAt ?? null,
      finishedAt ?? null,
      orphanedAt ?? null,
      job.id,
      job.state,
    ));
    if (sqliteChanges((changes as { changes?: unknown }).changes) !== 1) {
      throw new RunnerConflictError(`Job ${job.id} changed while transitioning`, { jobId: job.id });
    }
    return this.require(job.id);
  }

  start(jobId: string, options: TransitionOptions = {}): Job {
    return this.transition(jobId, "running", options);
  }

  markRunning(jobId: string, options: TransitionOptions = {}): Job {
    return this.start(jobId, options);
  }

  waitForProvider(jobId: string, options: TransitionOptions = {}): Job {
    return this.transition(jobId, "waiting_provider", options);
  }

  markWaitingProvider(jobId: string, options: TransitionOptions = {}): Job {
    return this.waitForProvider(jobId, options);
  }

  waitForHuman(jobId: string, options: TransitionOptions = {}): Job {
    return this.transition(jobId, "waiting_human", options);
  }

  markWaitingHuman(jobId: string, options: TransitionOptions = {}): Job {
    return this.waitForHuman(jobId, options);
  }

  succeed(jobId: string, result?: unknown, options: TransitionOptions = {}): Job {
    const merged: TransitionOptions = property(options, "result") || result === undefined ? options : { ...options, result };
    return this.transition(jobId, "succeeded", merged);
  }

  fail(jobId: string, error?: unknown, options: TransitionOptions = {}): Job {
    const merged: TransitionOptions = property(options, "error") ? options : { ...options, error };
    return this.transition(jobId, "failed", merged);
  }

  /** Record a cooperative request; this does not kill or interrupt a worker. */
  requestCancel(jobId: string, reason?: string): Job {
    this.ensureOpen();
    const job = this.require(jobId);
    if (job.state === "cancelled") return job;
    if (terminal(job.state)) throw new IllegalJobTransitionError(job.id, job.state, "cancelled");
    const updatedAt = this.now();
    const safeReason = reason === undefined ? job.cancelReason : redactText(assertSafeText(reason, "cancel reason"));
    const changes = this.transaction(() => this.db.prepare(`
      UPDATE jobs SET cancel_requested = 1, cancel_reason = ?, updated_at = ?
      WHERE id = ? AND state = ?
    `).run(safeReason ?? null, updatedAt, job.id, job.state));
    if (sqliteChanges((changes as { changes?: unknown }).changes) !== 1) {
      throw new RunnerConflictError(`Job ${job.id} changed while requesting cancellation`, { jobId: job.id });
    }
    return this.require(job.id);
  }

  /** Journal cancellation at a cooperative boundary; no process kill is attempted. */
  cancel(jobId: string, reason?: string): Job {
    const requested = this.requestCancel(jobId, reason);
    if (requested.state === "cancelled") return requested;
    const transitionReason = reason ?? requested.cancelReason;
    const transitionOptions: TransitionOptions = transitionReason === undefined
      ? { expectedState: requested.state }
      : { expectedState: requested.state, reason: transitionReason };
    return this.transition(requested.id, "cancelled", transitionOptions);
  }

  acknowledgeCancellation(jobId: string, options: TransitionOptions = {}): Job {
    const job = this.requireJob(jobId);
    if (job.state === "cancelled") return job;
    if (!job.cancelRequested) throw new CancellationNotRequestedError(job.id);
    const transitionReason = options.reason ?? job.cancelReason;
    const transitionOptions: TransitionOptions = transitionReason === undefined
      ? { ...options }
      : { ...options, reason: transitionReason };
    return this.transition(job.id, "cancelled", transitionOptions);
  }

  isCancellationRequested(jobId: string): boolean {
    return this.requireJob(jobId).cancelRequested;
  }

  checkpoint(jobId: string, stepId: string, value?: unknown): JobCheckpoint;
  checkpoint(jobId: string, input: CheckpointInput): JobCheckpoint;
  checkpoint(jobId: string, stepOrInput: string | CheckpointInput, value?: unknown): JobCheckpoint {
    this.ensureOpen();
    const job = this.require(jobId);
    if (!checkpointable(job.state)) throw new RunnerConflictError(`Cannot checkpoint terminal job ${job.id}`, { jobId: job.id });
    const stepId = typeof stepOrInput === "string"
      ? stepOrInput
      : stepOrInput.stepId ?? stepOrInput.step;
    const stepValue = typeof stepOrInput === "string"
      ? value
      : property(stepOrInput, "value") ? stepOrInput.value : stepOrInput.data;
    const normalizedStepId = validateIdentifier(stepId ?? "", "checkpoint step id", MAX_STEP_ID_BYTES);
    const payloadJson = canonicalJson(stepValue === undefined ? null : stepValue, MAX_CHECKPOINT_BYTES);
    const existing = this.db.prepare("SELECT * FROM job_checkpoints WHERE job_id = ? AND step_id = ?").get(job.id, normalizedStepId) as SqlRow | undefined;
    if (existing) {
      if (existing.payload_json !== payloadJson) {
        throw new RunnerConflictError(`Checkpoint ${normalizedStepId} already has different data`, {
          jobId: job.id,
          stepId: normalizedStepId,
        });
      }
      return this.rowToCheckpoint(existing);
    }
    const completedAt = this.now();
    try {
      this.db.prepare(`
        INSERT INTO job_checkpoints(job_id, step_id, payload_json, completed_at)
        VALUES (?, ?, ?, ?)
      `).run(job.id, normalizedStepId, payloadJson, completedAt);
    } catch (error) {
      if (error instanceof Error && /unique|constraint/i.test(error.message)) {
        const raced = this.db.prepare("SELECT * FROM job_checkpoints WHERE job_id = ? AND step_id = ?").get(job.id, normalizedStepId) as SqlRow | undefined;
        if (raced && raced.payload_json === payloadJson) return this.rowToCheckpoint(raced);
        throw new RunnerConflictError(`Checkpoint ${normalizedStepId} already exists`, { jobId: job.id, stepId: normalizedStepId });
      }
      throw error;
    }
    const created = this.db.prepare("SELECT * FROM job_checkpoints WHERE job_id = ? AND step_id = ?").get(job.id, normalizedStepId) as SqlRow | undefined;
    if (!created) throw new RunnerStorageError("Checkpoint insert was not readable");
    return this.rowToCheckpoint(created);
  }

  putCheckpoint(jobId: string, stepId: string, value?: unknown): JobCheckpoint;
  putCheckpoint(jobId: string, input: CheckpointInput): JobCheckpoint;
  putCheckpoint(jobId: string, stepOrInput: string | CheckpointInput, value?: unknown): JobCheckpoint {
    return typeof stepOrInput === "string"
      ? this.checkpoint(jobId, stepOrInput, value)
      : this.checkpoint(jobId, stepOrInput);
  }

  completeStep(jobId: string, stepId: string, value?: unknown): JobCheckpoint {
    return this.checkpoint(jobId, stepId, value);
  }

  private rowToCheckpoint(row: SqlRow): JobCheckpoint {
    return {
      jobId: validateIdentifier(row.job_id, "stored checkpoint job id", MAX_JOB_ID_BYTES),
      stepId: validateIdentifier(row.step_id, "stored checkpoint step id", MAX_STEP_ID_BYTES),
      value: storedJson(row.payload_json, "checkpoint", MAX_CHECKPOINT_BYTES),
      completedAt: validateIdentifier(row.completed_at, "stored checkpoint timestamp", MAX_TEXT_BYTES),
    };
  }

  listCheckpoints(jobId: string): readonly JobCheckpoint[] {
    const job = this.requireJob(jobId);
    const rows = this.db.prepare("SELECT * FROM job_checkpoints WHERE job_id = ? ORDER BY completed_at ASC, step_id ASC").all(job.id) as unknown as SqlRow[];
    return rows.map((row) => this.rowToCheckpoint(row));
  }

  getCheckpoint(jobId: string, stepId: string): JobCheckpoint | undefined {
    const job = this.requireJob(jobId);
    const normalizedStepId = validateIdentifier(stepId, "checkpoint step id", MAX_STEP_ID_BYTES);
    const row = this.db.prepare("SELECT * FROM job_checkpoints WHERE job_id = ? AND step_id = ?").get(job.id, normalizedStepId) as SqlRow | undefined;
    return row ? this.rowToCheckpoint(row) : undefined;
  }

  appendProgress(jobId: string, input: ProgressInput): JobProgressEvent {
    this.ensureOpen();
    const job = this.require(jobId);
    if (terminal(job.state)) throw new RunnerConflictError(`Cannot append progress to terminal job ${job.id}`, { jobId: job.id });
    const eventId = validateIdentifier(input.eventId ?? input.id ?? `event-${randomUUID()}`, "progress event id", MAX_EVENT_ID_BYTES);
    const existing = this.db.prepare("SELECT * FROM job_progress WHERE job_id = ? AND event_id = ?").get(job.id, eventId) as SqlRow | undefined;
    const dataInput = property(input, "data") ? input.data : input.payload;
    const dataJson = canonicalJson(dataInput === undefined ? null : dataInput, MAX_PROGRESS_EVENT_BYTES);
    let progress: number | undefined;
    if (input.progress !== undefined && input.percent !== undefined) {
      if (input.progress * 100 !== input.percent) throw new RunnerValidationError("progress and percent disagree");
    }
    if (input.progress !== undefined) {
      if (typeof input.progress !== "number" || !Number.isFinite(input.progress) || input.progress < 0 || input.progress > 1) {
        throw new RunnerValidationError("progress must be a number from 0 through 1");
      }
      progress = input.progress;
    } else if (input.percent !== undefined) {
      if (typeof input.percent !== "number" || !Number.isFinite(input.percent) || input.percent < 0 || input.percent > 100) {
        throw new RunnerValidationError("percent must be a number from 0 through 100");
      }
      progress = input.percent / 100;
    }
    const stage = input.stage === undefined ? undefined : assertSafeText(input.stage, "progress stage");
    const message = input.message === undefined ? undefined : assertSafeText(input.message, "progress message");
    const eventSize = byteLength(JSON.stringify({
      stage: stage ?? null,
      message: message ?? null,
      progress: progress ?? null,
      data: JSON.parse(dataJson) as RunnerJsonValue,
    }));
    if (eventSize > MAX_PROGRESS_EVENT_BYTES) {
      throw new RunnerValidationError(`Progress event exceeds ${MAX_PROGRESS_EVENT_BYTES} bytes`);
    }
    if (existing) {
      const existingProgress = existing.progress === null || existing.progress === undefined ? undefined : Number(existing.progress);
      const same = existing.data_json === dataJson && existing.stage === (stage ?? null) && existing.message === (message ?? null) && (existingProgress === progress);
      if (!same) throw new RunnerConflictError(`Progress event ${eventId} already has different data`, { jobId: job.id, eventId });
      return this.rowToProgress(existing);
    }
    const maxRow = this.db.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM job_progress WHERE job_id = ?").get(job.id) as SqlRow | undefined;
    const sequence = sqliteInteger(maxRow?.sequence, "progress sequence") + 1;
    const createdAt = this.now();
    this.db.prepare(`
      INSERT INTO job_progress(job_id, sequence, event_id, stage, message, progress, data_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(job.id, sequence, eventId, stage ?? null, message ?? null, progress ?? null, dataJson, createdAt);
    const oldRows = this.db.prepare(`
      SELECT sequence FROM job_progress WHERE job_id = ? ORDER BY sequence DESC LIMIT -1 OFFSET ?
    `).all(job.id, this.maxProgressEvents) as unknown as SqlRow[];
    for (const oldRow of oldRows) {
      this.db.prepare("DELETE FROM job_progress WHERE job_id = ? AND sequence = ?").run(job.id, sqliteInteger(oldRow.sequence, "progress sequence"));
    }
    const created = this.db.prepare("SELECT * FROM job_progress WHERE job_id = ? AND event_id = ?").get(job.id, eventId) as SqlRow | undefined;
    if (!created) throw new RunnerStorageError("Progress insert was not readable");
    return this.rowToProgress(created);
  }

  progress(jobId: string, input: ProgressInput): JobProgressEvent {
    return this.appendProgress(jobId, input);
  }

  private rowToProgress(row: SqlRow): JobProgressEvent {
    const stage = optionalText(row.stage, "progress stage");
    const message = optionalText(row.message, "progress message");
    const progress = row.progress === null || row.progress === undefined ? undefined : Number(row.progress);
    if (progress !== undefined && (!Number.isFinite(progress) || progress < 0 || progress > 1)) throw new RunnerStorageError("Stored progress is out of range");
    return {
      jobId: validateIdentifier(row.job_id, "stored progress job id", MAX_JOB_ID_BYTES),
      sequence: sqliteInteger(row.sequence, "progress sequence"),
      eventId: validateIdentifier(row.event_id, "stored progress event id", MAX_EVENT_ID_BYTES),
      ...(stage === undefined ? {} : { stage }),
      ...(message === undefined ? {} : { message }),
      ...(progress === undefined ? {} : { progress }),
      data: storedJson(row.data_json, "progress data", MAX_PROGRESS_EVENT_BYTES),
      createdAt: validateIdentifier(row.created_at, "stored progress timestamp", MAX_TEXT_BYTES),
    };
  }

  listProgress(jobId: string, options: ListProgressOptions = {}): readonly JobProgressEvent[] {
    const job = this.requireJob(jobId);
    if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 10_000)) {
      throw new RunnerValidationError("progress list limit must be an integer from 1 through 10000");
    }
    if (options.afterSequence !== undefined && (!Number.isSafeInteger(options.afterSequence) || options.afterSequence < 0)) {
      throw new RunnerValidationError("afterSequence must be a non-negative integer");
    }
    const clauses = ["job_id = ?"];
    const values: Array<string | number> = [job.id];
    if (options.afterSequence !== undefined) {
      clauses.push("sequence > ?");
      values.push(options.afterSequence);
    }
    const limit = options.limit === undefined ? "" : " LIMIT ?";
    if (options.limit !== undefined) values.push(options.limit);
    const rows = this.db.prepare(`SELECT * FROM job_progress WHERE ${clauses.join(" AND ")} ORDER BY sequence ASC${limit}`).all(...values) as unknown as SqlRow[];
    return rows.map((row) => this.rowToProgress(row));
  }

  getProgress(jobId: string, options: ListProgressOptions = {}): readonly JobProgressEvent[] {
    return this.listProgress(jobId, options);
  }

  recover(options: { readonly resumeResumable?: boolean; readonly reason?: string; readonly at?: Date | string } = {}): RecoveryReport {
    this.ensureOpen();
    const rows = this.db.prepare("SELECT * FROM jobs WHERE state = 'running' ORDER BY created_at ASC, id ASC").all() as unknown as SqlRow[];
    const outcomes: RecoveryOutcome[] = [];
    for (const row of rows) {
      const job = this.rowToJob(row);
      const shouldResume = job.resumable && !job.cancelRequested && options.resumeResumable !== false;
      const reason = redactText(options.reason ?? "Runner restarted while the job was running");
      if (shouldResume) {
        const transitionOptions: TransitionOptions = options.at === undefined
          ? { reason }
          : { at: options.at, reason };
        this.applyTransition(job, "queued", transitionOptions, true);
        outcomes.push({ jobId: job.id, previousState: "running", state: "queued", action: "resumed", resumable: true, reason });
      } else {
        const transitionOptions: TransitionOptions = options.at === undefined
          ? { reason }
          : { at: options.at, reason };
        this.applyTransition(job, "orphaned", transitionOptions);
        outcomes.push({ jobId: job.id, previousState: "running", state: "orphaned", action: "orphaned", resumable: job.resumable, reason });
      }
    }
    return {
      outcomes,
      resumed: outcomes.filter((outcome) => outcome.action === "resumed").map((outcome) => outcome.jobId),
      orphaned: outcomes.filter((outcome) => outcome.action === "orphaned").map((outcome) => outcome.jobId),
    };
  }

  recoverInterruptedJobs(options: { readonly resumeResumable?: boolean; readonly reason?: string; readonly at?: Date | string } = {}): RecoveryReport {
    return this.recover(options);
  }

  resume(jobId: string, options: TransitionOptions = {}): Job {
    const job = this.requireJob(jobId);
    if (job.state === "queued" || job.state === "running") return job;
    if (job.state !== "orphaned") throw new IllegalJobTransitionError(job.id, job.state, "queued");
    if (!job.resumable) throw new JobNotResumableError(job.id);
    return this.applyTransition(job, "queued", options, true);
  }

  resumeJob(jobId: string, options: TransitionOptions = {}): Job {
    return this.resume(jobId, options);
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.db.close();
  }
}

/** Names that make the later Core/CLI wiring read naturally. */
export { JobJournal as RunnerJournal, JobJournal as JobStore };
