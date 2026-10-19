import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  fsyncSync,
} from "node:fs";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import path from "node:path";

// Vite 5 does not yet list Node 24's experimental `node:sqlite` in its
// built-in module table and otherwise rewrites it to the non-existent `sqlite`
// package during workspace tests. Resolve the same built-in synchronously at
// runtime while retaining the Node-provided DatabaseSync implementation.
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

/** The on-disk location used by the default Ledger instance. */
export const DEFAULT_LEDGER_DATABASE_RELATIVE = path.join("db", "ledger.sqlite");
/** The default LP_HOME-relative CAS root. */
export const DEFAULT_CAS_ROOT = path.join("store", "sha256");
export const LEDGER_SCHEMA_VERSION = 1;
export const HASH_ALGORITHM = "sha256" as const;
export const GENESIS_HASH = "";

/** Bounds are deliberately conservative: Ledger records are metadata, not blobs. */
export const MAX_PAYLOAD_BYTES = 256 * 1024;
export const MAX_SOURCES_OR_REFERENCES_BYTES = 64 * 1024;
export const MAX_SOURCES_OR_REFERENCES_ITEMS = 256;
export const MAX_JSON_DEPTH = 32;
export const MAX_RECORD_ID_BYTES = 256;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type LedgerRecordType = "artifact" | "evidence" | "approval" | "audit";

const RECORD_TYPES: readonly LedgerRecordType[] = [
  "artifact",
  "evidence",
  "approval",
  "audit",
];

const TYPED_TABLES: Readonly<Record<LedgerRecordType, string>> = {
  artifact: "artifacts",
  evidence: "evidence",
  approval: "approvals",
  audit: "audit_records",
};

type SqlRow = Record<string, unknown>;

export type LedgerErrorCode =
  | "LedgerValidationError"
  | "LedgerConflict"
  | "LedgerIntegrityError"
  | "LedgerUnavailable"
  | "CasPathRejected"
  | "CasHashRejected"
  | "CasNotFound"
  | "CasIntegrityError";

export class LedgerError extends Error {
  readonly code: LedgerErrorCode;

  constructor(code: LedgerErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = code;
    this.code = code;
  }
}

export class LedgerValidationError extends LedgerError {
  constructor(message: string) {
    super("LedgerValidationError", message);
  }
}

export class LedgerConflictError extends LedgerError {
  constructor(message: string) {
    super("LedgerConflict", message);
  }
}

export class LedgerIntegrityError extends LedgerError {
  constructor(message: string) {
    super("LedgerIntegrityError", message);
  }
}

export class LedgerUnavailableError extends LedgerError {
  constructor(message: string) {
    super("LedgerUnavailable", message);
  }
}

export class CasPathRejectedError extends LedgerError {
  constructor(message: string) {
    super("CasPathRejected", message);
  }
}

export class CasHashRejectedError extends LedgerError {
  constructor(message: string) {
    super("CasHashRejected", message);
  }
}

export class CasNotFoundError extends LedgerError {
  constructor(message: string) {
    super("CasNotFound", message);
  }
}

export class CasIntegrityError extends LedgerError {
  constructor(message: string) {
    super("CasIntegrityError", message);
  }
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonError(message: string): LedgerValidationError {
  return new LedgerValidationError(`Invalid Ledger JSON: ${message}`);
}

/**
 * Convert a JSON value to a stable, recursively key-sorted representation.
 * JSON.stringify on the result is the single serialization used for hashes and
 * database storage. No locale-sensitive sorting or runtime object identity is
 * involved.
 */
export function canonicalizeJson(value: unknown, depth = 0): JsonValue {
  if (depth > MAX_JSON_DEPTH) throw jsonError("maximum nesting depth exceeded");
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw jsonError("numbers must be finite");
    // JSON.stringify(-0) is "0". Normalize it before the value reaches the
    // hash so equivalent JSON values cannot have two serialized forms.
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") throw jsonError("only JSON values are supported");

  if (Array.isArray(value)) {
    if (value.length > MAX_SOURCES_OR_REFERENCES_ITEMS * 4) {
      throw jsonError("array contains too many items");
    }
    return value.map((item) => canonicalizeJson(item, depth + 1));
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw jsonError("objects must be plain JSON objects");
  }
  const result: { [key: string]: JsonValue } = {};
  for (const key of Object.keys(value).sort()) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      throw jsonError(`reserved object key ${key} is not allowed`);
    }
    result[key] = canonicalizeJson((value as Record<string, unknown>)[key], depth + 1);
  }
  return result;
}

function canonicalJson(value: unknown): string {
  const normalized = canonicalizeJson(value);
  const result = JSON.stringify(normalized);
  if (result === undefined) throw jsonError("value is not serializable");
  if (byteLength(result) > MAX_PAYLOAD_BYTES) {
    throw new LedgerValidationError(`Ledger payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
  }
  return result;
}

export { canonicalJson };

function validateBoundedSourceFields(value: JsonValue, pathName = "$", depth = 0): void {
  if (depth > MAX_JSON_DEPTH) return;
  if (Array.isArray(value)) {
    for (const item of value) validateBoundedSourceFields(item, pathName, depth + 1);
    return;
  }
  if (!isJsonObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${pathName}.${key}`;
    if (key === "sources" || key === "references") {
      const serialized = JSON.stringify(child);
      if (serialized === undefined || byteLength(serialized) > MAX_SOURCES_OR_REFERENCES_BYTES) {
        throw new LedgerValidationError(
          `${childPath} exceeds ${MAX_SOURCES_OR_REFERENCES_BYTES} bytes`,
        );
      }
      if (Array.isArray(child) && child.length > MAX_SOURCES_OR_REFERENCES_ITEMS) {
        throw new LedgerValidationError(
          `${childPath} contains more than ${MAX_SOURCES_OR_REFERENCES_ITEMS} items`,
        );
      }
    }
    validateBoundedSourceFields(child, childPath, depth + 1);
  }
}

function canonicalPayload(value: unknown): string {
  const normalized = canonicalizeJson(value);
  validateBoundedSourceFields(normalized);
  const result = JSON.stringify(normalized);
  if (result === undefined) throw jsonError("value is not serializable");
  if (byteLength(result) > MAX_PAYLOAD_BYTES) {
    throw new LedgerValidationError(`Ledger payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
  }
  return result;
}

export function sha256(value: Uint8Array | string): string {
  return createHash(HASH_ALGORITHM).update(value).digest("hex");
}

function validateRecordId(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new LedgerValidationError("record id must be a non-empty string");
  }
  if (value.includes("\u0000")) {
    throw new LedgerValidationError("record id may not contain a NUL character");
  }
  if (byteLength(value) > MAX_RECORD_ID_BYTES) {
    throw new LedgerValidationError(`record id exceeds ${MAX_RECORD_ID_BYTES} bytes`);
  }
  return value;
}

function normalizeTimestamp(value: unknown, fallback: () => string): string {
  const candidate = value === undefined ? fallback() : value instanceof Date ? value.toISOString() : value;
  if (typeof candidate !== "string") throw new LedgerValidationError("timestamp must be an ISO string");
  const date = new Date(candidate);
  if (!Number.isFinite(date.getTime())) throw new LedgerValidationError("timestamp must be valid ISO time");
  return date.toISOString();
}

function sqliteInteger(value: unknown, field: string): number {
  const numberValue = typeof value === "bigint" ? Number(value) : Number(value);
  if (!Number.isSafeInteger(numberValue) || numberValue < 0) {
    throw new LedgerIntegrityError(`SQLite ${field} is not a safe non-negative integer`);
  }
  return numberValue;
}

function sqliteText(value: unknown, field: string): string {
  if (typeof value !== "string") throw new LedgerIntegrityError(`SQLite ${field} is not text`);
  return value;
}

function rowValue(row: SqlRow | undefined, field: string): unknown {
  return row?.[field];
}

function parsePayload(payloadJson: string): JsonValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson) as unknown;
  } catch {
    throw jsonError("stored payload is not valid JSON");
  }
  const canonical = canonicalPayload(parsed);
  if (canonical !== payloadJson) throw jsonError("stored payload is not canonical JSON");
  return parsed as JsonValue;
}

function ensureDatabaseParent(databasePath: string): void {
  mkdirSync(path.dirname(databasePath), { recursive: true });
}

function resolveDatabasePath(options: LedgerOptions | string | undefined): string {
  if (typeof options === "string") return path.resolve(options);
  const home = path.resolve(options?.home ?? process.env.LP_HOME ?? process.cwd());
  const configured = options?.databasePath ?? options?.dbPath;
  if (!configured) return path.join(home, DEFAULT_LEDGER_DATABASE_RELATIVE);
  return path.isAbsolute(configured) ? path.resolve(configured) : path.resolve(home, configured);
}

function migrationTimestamp(): string {
  return new Date().toISOString();
}

function applyMigrations(database: DatabaseSyncType): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS ledger_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);

  const appliedRows = database.prepare("SELECT version FROM ledger_migrations ORDER BY version").all() as unknown as SqlRow[];
  const applied = new Set(appliedRows.map((row) => sqliteInteger(rowValue(row, "version"), "migration version")));
  const userVersionRow = database.prepare("PRAGMA user_version").get() as SqlRow | undefined;
  const userVersion = sqliteInteger(rowValue(userVersionRow, "user_version"), "user_version");
  if (userVersion > LEDGER_SCHEMA_VERSION) {
    throw new LedgerUnavailableError("Ledger database requires a newer schema version");
  }
  if ([...applied].some((version) => version > LEDGER_SCHEMA_VERSION)) {
    throw new LedgerUnavailableError("Ledger database requires a newer schema version");
  }
  if (applied.has(1)) {
    if (userVersion !== LEDGER_SCHEMA_VERSION) {
      throw new LedgerUnavailableError("Ledger migration metadata and SQLite user_version disagree");
    }
    return;
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`
      CREATE TABLE ledger_meta (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL CHECK (json_valid(value_json)),
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE ledger_records (
        sequence INTEGER PRIMARY KEY,
        record_type TEXT NOT NULL CHECK (record_type IN ('artifact', 'evidence', 'approval', 'audit')),
        record_id TEXT NOT NULL,
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        timestamp TEXT NOT NULL,
        prev_hash TEXT NOT NULL,
        hash TEXT NOT NULL UNIQUE,
        UNIQUE (record_type, record_id)
      ) STRICT;

      CREATE TABLE ledger_heads (
        sequence INTEGER PRIMARY KEY,
        hash TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY,
        sequence INTEGER NOT NULL UNIQUE,
        record_type TEXT NOT NULL CHECK (record_type = 'artifact'),
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        timestamp TEXT NOT NULL,
        prev_hash TEXT NOT NULL,
        hash TEXT NOT NULL UNIQUE,
        FOREIGN KEY (sequence) REFERENCES ledger_records(sequence)
      ) STRICT;

      CREATE TABLE evidence (
        id TEXT PRIMARY KEY,
        sequence INTEGER NOT NULL UNIQUE,
        record_type TEXT NOT NULL CHECK (record_type = 'evidence'),
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        timestamp TEXT NOT NULL,
        prev_hash TEXT NOT NULL,
        hash TEXT NOT NULL UNIQUE,
        FOREIGN KEY (sequence) REFERENCES ledger_records(sequence)
      ) STRICT;

      CREATE TABLE approvals (
        id TEXT PRIMARY KEY,
        sequence INTEGER NOT NULL UNIQUE,
        record_type TEXT NOT NULL CHECK (record_type = 'approval'),
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        timestamp TEXT NOT NULL,
        prev_hash TEXT NOT NULL,
        hash TEXT NOT NULL UNIQUE,
        FOREIGN KEY (sequence) REFERENCES ledger_records(sequence)
      ) STRICT;

      CREATE TABLE audit_records (
        id TEXT PRIMARY KEY,
        sequence INTEGER NOT NULL UNIQUE,
        record_type TEXT NOT NULL CHECK (record_type = 'audit'),
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        timestamp TEXT NOT NULL,
        prev_hash TEXT NOT NULL,
        hash TEXT NOT NULL UNIQUE,
        FOREIGN KEY (sequence) REFERENCES ledger_records(sequence)
      ) STRICT;

      CREATE VIEW audit_log AS SELECT
        id, sequence, record_type, payload_json, timestamp, prev_hash, hash
        FROM audit_records;

      CREATE TRIGGER ledger_records_no_update BEFORE UPDATE ON ledger_records
      BEGIN SELECT RAISE(ABORT, 'ledger_records are append-only'); END;
      CREATE TRIGGER ledger_records_no_delete BEFORE DELETE ON ledger_records
      BEGIN SELECT RAISE(ABORT, 'ledger_records are append-only'); END;
      CREATE TRIGGER ledger_heads_no_update BEFORE UPDATE ON ledger_heads
      BEGIN SELECT RAISE(ABORT, 'ledger_heads are append-only'); END;
      CREATE TRIGGER ledger_heads_no_delete BEFORE DELETE ON ledger_heads
      BEGIN SELECT RAISE(ABORT, 'ledger_heads are append-only'); END;
      CREATE TRIGGER artifacts_no_update BEFORE UPDATE ON artifacts
      BEGIN SELECT RAISE(ABORT, 'artifacts are append-only'); END;
      CREATE TRIGGER artifacts_no_delete BEFORE DELETE ON artifacts
      BEGIN SELECT RAISE(ABORT, 'artifacts are append-only'); END;
      CREATE TRIGGER evidence_no_update BEFORE UPDATE ON evidence
      BEGIN SELECT RAISE(ABORT, 'evidence is append-only'); END;
      CREATE TRIGGER evidence_no_delete BEFORE DELETE ON evidence
      BEGIN SELECT RAISE(ABORT, 'evidence is append-only'); END;
      CREATE TRIGGER approvals_no_update BEFORE UPDATE ON approvals
      BEGIN SELECT RAISE(ABORT, 'approvals are append-only'); END;
      CREATE TRIGGER approvals_no_delete BEFORE DELETE ON approvals
      BEGIN SELECT RAISE(ABORT, 'approvals are append-only'); END;
      CREATE TRIGGER audit_records_no_update BEFORE UPDATE ON audit_records
      BEGIN SELECT RAISE(ABORT, 'audit_records are append-only'); END;
      CREATE TRIGGER audit_records_no_delete BEFORE DELETE ON audit_records
      BEGIN SELECT RAISE(ABORT, 'audit_records are append-only'); END;
      CREATE TRIGGER ledger_meta_no_update BEFORE UPDATE ON ledger_meta
      BEGIN SELECT RAISE(ABORT, 'ledger_meta is append-only'); END;
      CREATE TRIGGER ledger_meta_no_delete BEFORE DELETE ON ledger_meta
      BEGIN SELECT RAISE(ABORT, 'ledger_meta is append-only'); END;
      CREATE TRIGGER ledger_migrations_no_update BEFORE UPDATE ON ledger_migrations
      BEGIN SELECT RAISE(ABORT, 'ledger_migrations are append-only'); END;
      CREATE TRIGGER ledger_migrations_no_delete BEFORE DELETE ON ledger_migrations
      BEGIN SELECT RAISE(ABORT, 'ledger_migrations are append-only'); END;

      INSERT INTO ledger_meta(key, value_json, created_at)
      VALUES
        ('schema_version', '1', '${migrationTimestamp()}'),
        ('hash_algorithm', '"sha256"', '${migrationTimestamp()}'),
        ('genesis_hash', '""', '${migrationTimestamp()}');
      INSERT INTO ledger_heads(sequence, hash, recorded_at) VALUES (0, '', '${migrationTimestamp()}');
      INSERT INTO ledger_migrations(version, name, applied_at)
      VALUES (1, 'initial-ledger-and-typed-record-tables', '${migrationTimestamp()}');
    `);
    database.exec("PRAGMA user_version = 1");
    database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

function configureDatabase(database: DatabaseSyncType): void {
  const journal = database.prepare("PRAGMA journal_mode = WAL").get() as SqlRow | undefined;
  const journalMode = String(rowValue(journal, "journal_mode") ?? rowValue(journal, "journalMode") ?? "").toLowerCase();
  if (journalMode !== "wal") throw new LedgerUnavailableError("SQLite WAL mode could not be enabled");
  database.exec("PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
}

export interface LedgerOptions {
  /** LP_HOME, already resolved or a path that can be resolved by Node. */
  home?: string;
  /** Absolute database path or a path relative to home. */
  databasePath?: string;
  /** Alias retained for callers that use dbPath terminology. */
  dbPath?: string;
  /** Timestamp source used when append callers do not provide one. */
  now?: () => string;
}

export interface AppendOptions {
  timestamp?: string | Date;
  createdAt?: string | Date;
  created_at?: string | Date;
}

export interface LedgerRecord<TPayload extends JsonValue = JsonValue> {
  readonly sequence: number;
  readonly recordType: LedgerRecordType;
  readonly recordId: string;
  /** Short aliases make the stream convenient to consume without losing the explicit names. */
  readonly type: LedgerRecordType;
  readonly id: string;
  readonly payload: TPayload;
  readonly payloadJson: string;
  readonly payload_json: string;
  readonly timestamp: string;
  readonly prevHash: string;
  readonly prev_hash: string;
  readonly hash: string;
}

export interface TypedRecordInput<TPayload extends JsonValue = JsonValue> extends AppendOptions {
  id?: string;
  recordId?: string;
  record_id?: string;
  artifactId?: string;
  artifact_id?: string;
  evidenceId?: string;
  evidence_id?: string;
  approvalId?: string;
  approval_id?: string;
  auditId?: string;
  audit_id?: string;
  payload?: TPayload;
  data?: TPayload;
}

export type AppendInput<TPayload extends JsonValue = JsonValue> =
  | string
  | TypedRecordInput<TPayload>;

export interface VerificationIssue {
  readonly code:
    | "MissingSequence"
    | "EditedRecord"
    | "DeletedRecord"
    | "ReorderedRecord"
    | "MalformedRecord"
    | "TypedTableMismatch"
    | "ChainHeadMismatch"
    | "MetadataMismatch";
  readonly sequence?: number;
  readonly recordType?: string;
  readonly recordId?: string;
  readonly message: string;
}

export interface LedgerVerificationResult {
  readonly ok: boolean;
  readonly valid: boolean;
  readonly status: "verified" | "invalid";
  readonly checkedRecords: number;
  readonly head: { readonly sequence: number; readonly hash: string };
  readonly issues: readonly VerificationIssue[];
}

export interface LedgerUnavailableResult {
  readonly ok: false;
  readonly valid: false;
  readonly status: "unavailable";
  readonly code: "LedgerUnavailable";
  readonly message: string;
}

function tableForType(type: LedgerRecordType): string {
  return TYPED_TABLES[type];
}

function isRecordType(value: unknown): value is LedgerRecordType {
  return typeof value === "string" && (RECORD_TYPES as readonly string[]).includes(value);
}

function recordFromRow(row: SqlRow): LedgerRecord {
  const payloadJson = sqliteText(rowValue(row, "payload_json"), "payload_json");
  let payload: JsonValue;
  try {
    payload = parsePayload(payloadJson);
  } catch (error) {
    if (error instanceof LedgerError) throw error;
    throw new LedgerIntegrityError("stored Ledger payload could not be read");
  }
  const recordType = sqliteText(rowValue(row, "record_type"), "record_type");
  if (!isRecordType(recordType)) throw new LedgerIntegrityError(`unknown Ledger record type ${recordType}`);
  return {
    sequence: sqliteInteger(rowValue(row, "sequence"), "sequence"),
    recordType,
    recordId: sqliteText(rowValue(row, "record_id"), "record_id"),
    type: recordType,
    id: sqliteText(rowValue(row, "record_id"), "record_id"),
    payload,
    payloadJson,
    payload_json: payloadJson,
    timestamp: sqliteText(rowValue(row, "timestamp"), "timestamp"),
    prevHash: sqliteText(rowValue(row, "prev_hash"), "prev_hash"),
    prev_hash: sqliteText(rowValue(row, "prev_hash"), "prev_hash"),
    hash: sqliteText(rowValue(row, "hash"), "hash"),
  };
}

function canonicalRecordHash(
  sequence: number,
  recordType: LedgerRecordType | string,
  recordId: string,
  payloadJson: string,
  timestamp: string,
  prevHash: string,
): string {
  const material = [
    "lightphysics-ledger-v1",
    String(sequence),
    recordType,
    recordId,
    payloadJson,
    timestamp,
    prevHash,
  ].join("\u0000");
  return sha256(material);
}

export { canonicalRecordHash };

function typedInputPayload<TPayload extends JsonValue>(input: AppendInput<TPayload>, payload: TPayload | undefined): {
  id: string;
  payload: TPayload;
  timestamp?: string | Date;
} {
  if (typeof input === "string") {
    if (payload === undefined) throw new LedgerValidationError("append payload is required");
    return { id: validateRecordId(input), payload };
  }
  const candidate = input as TypedRecordInput<TPayload> & Record<string, unknown>;
  const idValue = candidate.id ?? candidate.recordId ?? candidate.record_id ?? candidate.artifactId ?? candidate.artifact_id ??
    candidate.evidenceId ?? candidate.evidence_id ?? candidate.approvalId ?? candidate.approval_id ??
    candidate.auditId ?? candidate.audit_id;
  const id = validateRecordId(idValue);
  const inputTimestamp = candidate.timestamp ?? candidate.createdAt ?? candidate.created_at;
  const hasPayload = Object.prototype.hasOwnProperty.call(candidate, "payload");
  const hasData = Object.prototype.hasOwnProperty.call(candidate, "data");
  const explicitPayload = (hasPayload ? candidate.payload : candidate.data) as TPayload;
  if (hasPayload || hasData) {
    return inputTimestamp === undefined
      ? { id, payload: explicitPayload }
      : { id, payload: explicitPayload, timestamp: inputTimestamp };
  }

  // Accept a compact object form for audit records and simple metadata calls:
  // appendArtifact({ id: 'A-1', name: '...' }). The identity/timestamp fields
  // remain columns and are not duplicated into the canonical payload.
  const body: Record<string, JsonValue> = {};
  const identityKeys = new Set([
    "id", "recordId", "record_id", "artifactId", "artifact_id", "evidenceId", "evidence_id",
    "approvalId", "approval_id", "auditId", "audit_id", "timestamp", "createdAt", "created_at",
  ]);
  for (const [key, value] of Object.entries(candidate)) {
    if (!identityKeys.has(key)) body[key] = value as JsonValue;
  }
  return inputTimestamp === undefined
    ? { id, payload: body as TPayload }
    : { id, payload: body as TPayload, timestamp: inputTimestamp };
}

export class Ledger {
  readonly databasePath: string;
  /** Exposed for offline tamper tests and migrations; production callers use the methods below. */
  readonly db: DatabaseSyncType;
  readonly database: DatabaseSyncType;
  private readonly now: () => string;

  static open(options: LedgerOptions | string = {}): Ledger {
    return new Ledger(options);
  }

  constructor(options: LedgerOptions | string = {}) {
    this.databasePath = resolveDatabasePath(options);
    ensureDatabaseParent(this.databasePath);
    this.db = new DatabaseSync(this.databasePath, { enableForeignKeyConstraints: true });
    this.database = this.db;
    this.now = typeof options === "string" ? migrationTimestamp : options.now ?? migrationTimestamp;
    try {
      configureDatabase(this.db);
      applyMigrations(this.db);
    } catch (error) {
      this.db.close();
      if (error instanceof LedgerError) throw error;
      throw new LedgerUnavailableError("Ledger database could not be opened");
    }
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  get path(): string {
    return this.databasePath;
  }

  private appendRecord<TPayload extends JsonValue>(
    recordType: LedgerRecordType,
    input: AppendInput<TPayload>,
    payload?: TPayload,
    options: AppendOptions = {},
  ): LedgerRecord<TPayload> {
    const normalized = typedInputPayload(input, payload);
    const timestamp = normalizeTimestamp(
      normalized.timestamp ?? options.timestamp ?? options.createdAt ?? options.created_at,
      this.now,
    );
    const payloadJson = canonicalPayload(normalized.payload);

    const preflight = this.verify();
    if (!preflight.ok) {
      throw new LedgerIntegrityError("Ledger chain must verify before appending a new record");
    }
    const head = this.db.prepare(
      "SELECT sequence, hash FROM ledger_heads ORDER BY sequence DESC LIMIT 1",
    ).get() as SqlRow | undefined;
    if (!head) throw new LedgerIntegrityError("Ledger chain head metadata is missing");
    const sequence = sqliteInteger(rowValue(head, "sequence"), "head sequence") + 1;
    const prevHash = sqliteText(rowValue(head, "hash"), "head hash");
    const hash = canonicalRecordHash(sequence, recordType, normalized.id, payloadJson, timestamp, prevHash);
    const table = tableForType(recordType);

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        INSERT INTO ledger_records(sequence, record_type, record_id, payload_json, timestamp, prev_hash, hash)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(sequence, recordType, normalized.id, payloadJson, timestamp, prevHash, hash);
      this.db.prepare(`
        INSERT INTO ${table}(id, sequence, record_type, payload_json, timestamp, prev_hash, hash)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(normalized.id, sequence, recordType, payloadJson, timestamp, prevHash, hash);
      this.db.prepare(
        "INSERT INTO ledger_heads(sequence, hash, recorded_at) VALUES (?, ?, ?)",
      ).run(sequence, hash, timestamp);
      this.db.exec("COMMIT");
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      if (error instanceof Error && /UNIQUE|constraint/i.test(error.message)) {
        throw new LedgerConflictError("Ledger record identity already exists");
      }
      throw error;
    }
    return {
      sequence,
      recordType,
      recordId: normalized.id,
      type: recordType,
      id: normalized.id,
      payload: normalized.payload,
      payloadJson,
      payload_json: payloadJson,
      timestamp,
      prevHash,
      prev_hash: prevHash,
      hash,
    };
  }

  append<TPayload extends JsonValue>(
    recordType: LedgerRecordType,
    input: AppendInput<TPayload>,
    payload?: TPayload,
    options?: AppendOptions,
  ): LedgerRecord<TPayload> {
    if (!isRecordType(recordType)) throw new LedgerValidationError("unknown Ledger record type");
    return this.appendRecord(recordType, input, payload, options);
  }

  appendArtifact<TPayload extends JsonValue>(
    input: AppendInput<TPayload>,
    payload?: TPayload,
    options?: AppendOptions,
  ): LedgerRecord<TPayload> {
    return this.appendRecord("artifact", input, payload, options);
  }

  appendEvidence<TPayload extends JsonValue>(
    input: AppendInput<TPayload>,
    payload?: TPayload,
    options?: AppendOptions,
  ): LedgerRecord<TPayload> {
    return this.appendRecord("evidence", input, payload, options);
  }

  appendApproval<TPayload extends JsonValue>(
    input: AppendInput<TPayload>,
    payload?: TPayload,
    options?: AppendOptions,
  ): LedgerRecord<TPayload> {
    return this.appendRecord("approval", input, payload, options);
  }

  appendAudit<TPayload extends JsonValue>(
    input: AppendInput<TPayload>,
    payload?: TPayload,
    options?: AppendOptions,
  ): LedgerRecord<TPayload> {
    return this.appendRecord("audit", input, payload, options);
  }

  getRecord(sequence: number): LedgerRecord | null {
    if (!Number.isSafeInteger(sequence) || sequence < 1) return null;
    const row = this.db.prepare("SELECT * FROM ledger_records WHERE sequence = ?").get(sequence) as SqlRow | undefined;
    return row ? recordFromRow(row) : null;
  }

  listRecords(): LedgerRecord[] {
    const rows = this.db.prepare("SELECT * FROM ledger_records ORDER BY sequence").all() as unknown as SqlRow[];
    return rows.map(recordFromRow);
  }

  records(): LedgerRecord[] {
    return this.listRecords();
  }

  private listTyped(type: LedgerRecordType): LedgerRecord[] {
    const table = tableForType(type);
    const rows = this.db.prepare(`SELECT * FROM ${table} ORDER BY sequence`).all() as unknown as SqlRow[];
    return rows.map((row) => {
      const record = recordFromRow({ ...row, record_id: row.id });
      return { ...record, recordType: type };
    });
  }

  getArtifact(id: string): LedgerRecord | null {
    return this.getTyped("artifact", id);
  }

  getEvidence(id: string): LedgerRecord | null {
    return this.getTyped("evidence", id);
  }

  getApproval(id: string): LedgerRecord | null {
    return this.getTyped("approval", id);
  }

  getAudit(id: string): LedgerRecord | null {
    return this.getTyped("audit", id);
  }

  readArtifact(id: string): LedgerRecord | null { return this.getArtifact(id); }
  readEvidenceRecord(id: string): LedgerRecord | null { return this.getEvidence(id); }
  readApproval(id: string): LedgerRecord | null { return this.getApproval(id); }
  readAudit(id: string): LedgerRecord | null { return this.getAudit(id); }

  listArtifacts(): LedgerRecord[] { return this.listTyped("artifact"); }
  listEvidence(): LedgerRecord[] { return this.listTyped("evidence"); }
  listApprovals(): LedgerRecord[] { return this.listTyped("approval"); }
  listAudits(): LedgerRecord[] { return this.listTyped("audit"); }
  readArtifacts(): LedgerRecord[] { return this.listArtifacts(); }
  readEvidence(): LedgerRecord[] { return this.listEvidence(); }
  readApprovals(): LedgerRecord[] { return this.listApprovals(); }
  readAudits(): LedgerRecord[] { return this.listAudits(); }

  private getTyped(type: LedgerRecordType, id: string): LedgerRecord | null {
    const table = tableForType(type);
    const row = this.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as SqlRow | undefined;
    return row ? recordFromRow({ ...row, record_id: row.id }) : null;
  }

  verifyChain(): LedgerVerificationResult {
    return this.verify();
  }

  verify(): LedgerVerificationResult {
    const issues: VerificationIssue[] = [];
    let rows: SqlRow[] = [];
    try {
      rows = this.db.prepare("SELECT * FROM ledger_records ORDER BY sequence").all() as unknown as SqlRow[];
    } catch {
      issues.push({ code: "MetadataMismatch", message: "ledger_records table is unavailable" });
    }

    try {
      const metadataRows = this.db.prepare("SELECT key, value_json FROM ledger_meta").all() as unknown as SqlRow[];
      const metadata = new Map(metadataRows.map((row) => [
        sqliteText(rowValue(row, "key"), "metadata key"),
        sqliteText(rowValue(row, "value_json"), "metadata value"),
      ]));
      const expectedMetadata: Readonly<Record<string, string>> = {
        schema_version: "1",
        hash_algorithm: '"sha256"',
        genesis_hash: '""',
      };
      for (const [key, expected] of Object.entries(expectedMetadata)) {
        if (metadata.get(key) !== expected) {
          issues.push({ code: "MetadataMismatch", message: `Ledger metadata ${key} is missing or edited` });
        }
      }
      const migration = this.db.prepare("SELECT version, name FROM ledger_migrations WHERE version = 1").get() as SqlRow | undefined;
      if (!migration || sqliteText(rowValue(migration, "name"), "migration name") !== "initial-ledger-and-typed-record-tables") {
        issues.push({ code: "MetadataMismatch", message: "initial Ledger migration metadata is missing or edited" });
      }
      const userVersion = sqliteInteger(rowValue(this.db.prepare("PRAGMA user_version").get() as SqlRow | undefined, "user_version"), "user_version");
      if (userVersion !== LEDGER_SCHEMA_VERSION) {
        issues.push({ code: "MetadataMismatch", message: "SQLite user_version does not match the Ledger schema" });
      }
    } catch (error) {
      issues.push({ code: "MetadataMismatch", message: error instanceof Error ? error.message : "Ledger metadata is unavailable" });
    }

    let previousHash = GENESIS_HASH;
    let expectedSequence = 1;
    const chainByIdentity = new Map<string, SqlRow>();
    const chainBySequence = new Map<number, SqlRow>();
    for (const row of rows) {
      let sequence: number;
      try {
        sequence = sqliteInteger(rowValue(row, "sequence"), "sequence");
      } catch (error) {
        issues.push({ code: "MalformedRecord", message: error instanceof Error ? error.message : "invalid sequence" });
        continue;
      }
      const type = String(rowValue(row, "record_type") ?? "");
      const id = String(rowValue(row, "record_id") ?? "");
      const payloadJson = String(rowValue(row, "payload_json") ?? "");
      const timestamp = String(rowValue(row, "timestamp") ?? "");
      const prevHash = String(rowValue(row, "prev_hash") ?? "");
      const storedHash = String(rowValue(row, "hash") ?? "");
      if (sequence !== expectedSequence) {
        issues.push({
          code: sequence > expectedSequence ? "MissingSequence" : "ReorderedRecord",
          sequence,
          recordType: type,
          recordId: id,
          message: `expected sequence ${expectedSequence}, found ${sequence}`,
        });
      }
      if (!isRecordType(type)) {
        issues.push({ code: "MalformedRecord", sequence, recordType: type, recordId: id, message: "unknown record type" });
      }
      try {
        const parsed = JSON.parse(payloadJson) as unknown;
        if (canonicalPayload(parsed) !== payloadJson) {
          issues.push({ code: "EditedRecord", sequence, recordType: type, recordId: id, message: "payload is not canonical" });
        }
      } catch (error) {
        issues.push({ code: "MalformedRecord", sequence, recordType: type, recordId: id, message: error instanceof Error ? error.message : "payload is invalid" });
      }
      if (prevHash !== previousHash) {
        issues.push({ code: "ReorderedRecord", sequence, recordType: type, recordId: id, message: "prev_hash does not match the preceding record" });
      }
      if (isRecordType(type)) {
        const expectedHash = canonicalRecordHash(sequence, type, id, payloadJson, timestamp, prevHash);
        if (storedHash !== expectedHash) {
          issues.push({ code: "EditedRecord", sequence, recordType: type, recordId: id, message: "record hash does not match canonical fields" });
        }
      }
      if (chainBySequence.has(sequence)) {
        issues.push({ code: "ReorderedRecord", sequence, recordType: type, recordId: id, message: "duplicate sequence" });
      }
      chainBySequence.set(sequence, row);
      const identity = `${type}\u0000${id}`;
      if (chainByIdentity.has(identity)) {
        issues.push({ code: "MalformedRecord", sequence, recordType: type, recordId: id, message: "duplicate typed identity" });
      }
      chainByIdentity.set(identity, row);
      previousHash = storedHash;
      expectedSequence = Math.max(expectedSequence, sequence + 1);
    }

    let heads: SqlRow[] = [];
    try {
      heads = this.db.prepare("SELECT sequence, hash FROM ledger_heads ORDER BY sequence").all() as unknown as SqlRow[];
      const expectedHeadCount = rows.length + 1;
      if (heads.length !== expectedHeadCount) {
        issues.push({ code: "ChainHeadMismatch", message: "chain head history does not cover the record stream" });
      }
      for (let index = 0; index < heads.length; index += 1) {
        const head = heads[index];
        if (!head) continue;
        const sequence = sqliteInteger(rowValue(head, "sequence"), "head sequence");
        const expectedHash = sequence === 0 ? GENESIS_HASH : String(rowValue(chainBySequence.get(sequence), "hash") ?? "");
        if (sequence !== index || String(rowValue(head, "hash") ?? "") !== expectedHash) {
          issues.push({ code: "ChainHeadMismatch", sequence, message: "chain head metadata disagrees with ledger records" });
        }
      }
      const latest = heads[heads.length - 1];
      const expectedLatestSequence = rows.length === 0 ? 0 : Math.max(...[...chainBySequence.keys()]);
      const expectedLatestHash = expectedLatestSequence === 0
        ? GENESIS_HASH
        : String(rowValue(chainBySequence.get(expectedLatestSequence), "hash") ?? "");
      if (!latest || sqliteInteger(rowValue(latest, "sequence"), "head sequence") !== expectedLatestSequence || String(rowValue(latest, "hash") ?? "") !== expectedLatestHash) {
        issues.push({ code: "DeletedRecord", message: "latest chain head does not match the ledger stream" });
      }
    } catch (error) {
      issues.push({ code: "MetadataMismatch", message: error instanceof Error ? error.message : "chain head metadata is unavailable" });
    }

    for (const type of RECORD_TYPES) {
      const table = tableForType(type);
      let typedRows: SqlRow[] = [];
      try {
        typedRows = this.db.prepare(`SELECT * FROM ${table} ORDER BY sequence`).all() as unknown as SqlRow[];
      } catch (error) {
        issues.push({ code: "TypedTableMismatch", recordType: type, message: `${table} table is unavailable` });
        continue;
      }
      const seen = new Set<string>();
      for (const typed of typedRows) {
        const id = String(rowValue(typed, "id") ?? "");
        const sequence = Number(rowValue(typed, "sequence"));
        const chain = chainByIdentity.get(`${type}\u0000${id}`);
        seen.add(id);
        if (!chain) {
          issues.push({ code: "TypedTableMismatch", sequence, recordType: type, recordId: id, message: `${table} row has no chain record` });
          continue;
        }
        const fields: readonly [string, string][] = [
          ["sequence", String(sequence)],
          ["payload_json", String(rowValue(typed, "payload_json") ?? "")],
          ["timestamp", String(rowValue(typed, "timestamp") ?? "")],
          ["prev_hash", String(rowValue(typed, "prev_hash") ?? "")],
          ["hash", String(rowValue(typed, "hash") ?? "")],
        ];
        for (const [field, value] of fields) {
          const chainField = field === "sequence" ? String(rowValue(chain, field) ?? "") : String(rowValue(chain, field) ?? "");
          if (value !== chainField) {
            issues.push({ code: "TypedTableMismatch", sequence, recordType: type, recordId: id, message: `${table}.${field} disagrees with ledger_records` });
          }
        }
      }
      for (const chain of rows) {
        if (String(rowValue(chain, "record_type")) !== type) continue;
        const id = String(rowValue(chain, "record_id"));
        if (!seen.has(id)) {
          issues.push({ code: "TypedTableMismatch", sequence: sqliteInteger(rowValue(chain, "sequence"), "sequence"), recordType: type, recordId: id, message: `${table} is missing the chain record` });
        }
      }
    }

    const head = heads[heads.length - 1];
    let headSequence = 0;
    let headHash = GENESIS_HASH;
    if (head) {
      try {
        headSequence = sqliteInteger(rowValue(head, "sequence"), "head sequence");
        headHash = String(rowValue(head, "hash") ?? "");
      } catch (error) {
        issues.push({ code: "MetadataMismatch", message: error instanceof Error ? error.message : "invalid chain head" });
      }
    }
    const ok = issues.length === 0;
    return {
      ok,
      valid: ok,
      status: ok ? "verified" : "invalid",
      checkedRecords: rows.length,
      head: { sequence: headSequence, hash: headHash },
      issues,
    };
  }
}

export function ledgerDatabasePath(home: string, databasePath?: string): string {
  return resolveDatabasePath(databasePath === undefined ? { home } : { home, databasePath });
}

export function openLedger(options: LedgerOptions | string = {}): Ledger {
  return new Ledger(options);
}

export const createLedger = openLedger;

function isAbsoluteLike(candidate: string): boolean {
  return path.isAbsolute(candidate) || path.posix.isAbsolute(candidate) || path.win32.isAbsolute(candidate) ||
    /^[A-Za-z]:/.test(candidate) || /^(?:\\\\|\/\/)/.test(candidate) || /^(?:\\\\\.\\|\\\\\?\\|\/\/\.\/)/.test(candidate);
}

function validateCasRoot(home: string, root: string): string {
  if (typeof root !== "string" || root.trim().length === 0) throw new CasPathRejectedError("CAS root is required");
  if (byteLength(root) > 512) throw new CasPathRejectedError("CAS root is too long");
  if (root.includes("\u0000")) throw new CasPathRejectedError("CAS root contains a NUL character");
  if (isAbsoluteLike(root)) throw new CasPathRejectedError("CAS root must be relative to LP_HOME");
  const normalizedSegments = root.replaceAll("\\", "/").split("/");
  if (normalizedSegments.at(-1) === "") normalizedSegments.pop();
  const reserved = /^(?:con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:[. ].*)?$/i;
  for (const segment of normalizedSegments) {
    if (!segment || segment === "." || segment === "..") throw new CasPathRejectedError("CAS root contains an unsafe segment");
    if (segment.includes(":")) throw new CasPathRejectedError("CAS root contains a device or stream segment");
    if (segment.endsWith(".") || segment.endsWith(" ")) throw new CasPathRejectedError("CAS root contains a trailing dot or space");
    if (reserved.test(segment)) throw new CasPathRejectedError("CAS root contains a reserved device name");
  }
  const homePath = path.resolve(home);
  const resolved = path.resolve(homePath, ...normalizedSegments);
  const relative = path.relative(homePath, resolved);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new CasPathRejectedError("CAS root escapes LP_HOME");
  }
  return resolved;
}

function assertNoSymlinkPath(home: string, target: string): void {
  const relative = path.relative(home, target);
  let current = home;
  for (const segment of relative.split(path.sep)) {
    if (!segment) continue;
    current = path.join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new CasPathRejectedError("CAS path may not contain symbolic links");
      }
    } catch (error) {
      if (error instanceof LedgerError) throw error;
      if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT") continue;
      throw new CasPathRejectedError("CAS path could not be inspected");
    }
  }
}

function validateCasHash(hash: string): string {
  if (typeof hash !== "string" || !/^[0-9a-fA-F]{64}$/.test(hash)) {
    throw new CasHashRejectedError("CAS key must be a 64-character SHA-256 hex digest");
  }
  return hash.toLowerCase();
}

export interface ContentAddressedStoreOptions {
  home: string;
  /** LP_HOME-relative root, for example `store/sha256`. */
  root?: string;
}

export class ContentAddressedStore {
  readonly home: string;
  readonly root: string;

  constructor(options: ContentAddressedStoreOptions);
  constructor(home: string, root?: string);
  constructor(optionsOrHome: ContentAddressedStoreOptions | string, root = DEFAULT_CAS_ROOT) {
    const options = typeof optionsOrHome === "string"
      ? { home: optionsOrHome, root }
      : optionsOrHome;
    this.home = path.resolve(options.home);
    this.root = validateCasRoot(this.home, options.root ?? DEFAULT_CAS_ROOT);
    // Check existing path components before recursive mkdir can follow a
    // symlink into a location outside LP_HOME. Re-check after creation too.
    assertNoSymlinkPath(this.home, this.root);
    mkdirSync(this.root, { recursive: true });
    assertNoSymlinkPath(this.home, this.root);
    const rootStat = lstatSync(this.root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new CasPathRejectedError("CAS root must be a real directory");
    }
  }

  path(hash: string): string {
    const normalized = validateCasHash(hash);
    const shard = path.join(this.root, normalized.slice(0, 2));
    const result = path.join(shard, normalized.slice(2));
    const relative = path.relative(this.root, result);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new CasPathRejectedError("CAS key escapes the configured root");
    }
    assertNoSymlinkPath(this.home, path.dirname(result));
    return result;
  }

  getPath(hash: string): string {
    return this.path(hash);
  }

  has(hash: string): boolean {
    validateCasHash(hash);
    const filePath = this.path(hash);
    try {
      const info = lstatSync(filePath);
      if (info.isSymbolicLink()) throw new CasIntegrityError("CAS entry may not be a symbolic link");
      if (!info.isFile()) return false;
      // A name-only existence check would turn a corrupted object into a
      // seemingly valid hit. Verify the content address on every `has` call.
      this.get(hash);
      return true;
    } catch (error) {
      if (error instanceof LedgerError) throw error;
      if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT") return false;
      throw new CasIntegrityError("CAS entry could not be inspected");
    }
  }

  put(content: Uint8Array | string): string {
    const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
    const hash = sha256(bytes);
    const filePath = this.path(hash);
    const parent = path.dirname(filePath);
    mkdirSync(parent, { recursive: true });
    assertNoSymlinkPath(this.home, parent);
    try {
      const descriptor = openSync(filePath, "wx", 0o600);
      try {
        writeFileSync(descriptor, bytes);
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      return hash;
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "EEXIST")) {
        throw new CasIntegrityError("CAS entry could not be written");
      }
      const info = lstatSync(filePath);
      if (info.isSymbolicLink() || !info.isFile()) throw new CasIntegrityError("CAS entry is not a regular file");
      const existing = readFileSync(filePath);
      if (sha256(existing) !== hash || !existing.equals(bytes)) {
        throw new CasIntegrityError("existing CAS entry does not match its content hash");
      }
      return hash;
    }
  }

  get(hash: string): Buffer {
    const normalized = validateCasHash(hash);
    const filePath = this.path(normalized);
    let info;
    try {
      info = lstatSync(filePath);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT") {
        throw new CasNotFoundError("CAS entry was not found");
      }
      throw new CasIntegrityError("CAS entry could not be inspected");
    }
    if (info.isSymbolicLink() || !info.isFile()) throw new CasIntegrityError("CAS entry is not a regular file");
    const bytes = readFileSync(filePath);
    if (sha256(bytes) !== normalized) throw new CasIntegrityError("CAS entry failed SHA-256 verification");
    return bytes;
  }

  putText(content: string): string {
    return this.put(content);
  }
}

export { ContentAddressedStore as CasStore };
export { ContentAddressedStore as CAS };

export interface VerifyLedgerFileOptions {
  databasePath: string;
}

/** Verify without creating a missing database, for `lp doctor --verify-chain`. */
export function verifyLedgerFile(options: VerifyLedgerFileOptions | string): LedgerVerificationResult | LedgerUnavailableResult {
  const databasePath = typeof options === "string" ? path.resolve(options) : path.resolve(options.databasePath);
  if (!existsSync(databasePath)) {
    return {
      ok: false,
      valid: false,
      status: "unavailable",
      code: "LedgerUnavailable",
      message: "Ledger database is not initialized",
    };
  }
  let ledger: Ledger | undefined;
  try {
    ledger = new Ledger({ databasePath });
    return ledger.verify();
  } catch (error) {
    return {
      ok: false,
      valid: false,
      status: "unavailable",
      code: "LedgerUnavailable",
      message: error instanceof LedgerError ? error.message : "Ledger database could not be opened",
    };
  } finally {
    ledger?.close();
  }
}

export const verifyLedger = verifyLedgerFile;

export function isLedgerVerificationResult(
  result: LedgerVerificationResult | LedgerUnavailableResult,
): result is LedgerVerificationResult {
  return result.status !== "unavailable";
}
