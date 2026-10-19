import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { RunnerValidationError } from "./journal.ts";

/**
 * Safe points and backups are intentionally synchronous in this first slice.
 * Every filesystem and git effect is behind one of these small seams, which
 * keeps the contract deterministic and lets offline tests use an in-memory
 * filesystem without touching a repository.
 */

export const SAFE_POINT_SCHEMA_VERSION = 1 as const;
export const BACKUP_SCHEMA_VERSION = 1 as const;
export const DEFAULT_LEDGER_DATABASE_RELATIVE = path.join("db", "ledger.sqlite");
const BACKUP_DEFAULT_RUNNER_DATABASE_RELATIVE = path.join("db", "runner.sqlite");
const BACKUP_DEFAULT_CAS_ROOT_RELATIVE = path.join("store", "sha256");

export const MAX_SAFE_POINT_DATABASES = 16;
export const MAX_SAFE_POINT_DATABASE_BYTES = 256 * 1024 * 1024;
export const MAX_SAFE_POINT_MANIFEST_BYTES = 128 * 1024;
export const MAX_SAFE_POINTS = 256;
export const MAX_BACKUP_FILES = 4_096;
export const MAX_BACKUP_BYTES = 512 * 1024 * 1024;
export const MAX_BACKUP_MANIFEST_BYTES = 512 * 1024;
export const MAX_BACKUP_CONFIG_BYTES = 256 * 1024;
export const MAX_BACKUP_PATH_BYTES = 4 * 1024;
export const MAX_GIT_OUTPUT_BYTES = 64 * 1024;

const SECRET_NAME = /(?:secret|token|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|credential|authorization|cookie|session[_-]?secret)/i;
const SECRET_FILENAME = /^(?:\.env(?:\..*)?|.*(?:secret|token|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|credential|authorization|cookie|session[_-]?secret).*)$/i;
const SECRET_VALUE = /(?:-----BEGIN[\s\S]*PRIVATE KEY-----|\b(?:sk|rk|pk|ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9][A-Za-z0-9._-]{11,}|\bAKIA[0-9A-Z]{16}\b|\bBearer\s+[A-Za-z0-9._~+/=-]{12,})/i;
const RESERVED_DEVICE = /^(?:con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:[. ].*)?$/i;

export type RunnerFileKind = "file" | "directory" | "symlink" | "other";

export interface RunnerFileStat {
  readonly kind: RunnerFileKind;
  readonly size: number;
}

export type RunnerCopyFile = (
  source: string,
  destination: string,
  options?: { readonly overwrite?: boolean },
) => void;

export interface RunnerFileSystem {
  lstat(filePath: string): RunnerFileStat;
  readdir(directory: string): readonly string[];
  readFile(filePath: string): Uint8Array;
  writeFile(filePath: string, bytes: Uint8Array, options?: { readonly overwrite?: boolean }): void;
  mkdir(directory: string): void;
  /** Optional direct-copy seam; callers fall back to read/write when absent. */
  copyFile?: RunnerCopyFile;
}

export interface GitCommandOptions {
  readonly cwd: string;
  readonly shell: false;
}

export interface GitCommandResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** A command and argv seam. Implementations must not interpret a shell string. */
export type GitRunner = (
  command: string,
  args: readonly string[],
  options: GitCommandOptions,
) => GitCommandResult;

export type RunnerSeamErrorCode =
  | "RunnerNotAvailable"
  | "RunnerGitError"
  | "RunnerFilesystemError"
  | "RunnerValidationError"
  | "SafePointIntegrityError"
  | "SafePointPathRejected"
  | "BackupUnavailable"
  | "BackupConflict"
  | "BackupIntegrityError"
  | "BackupPathRejected";

export class RunnerSeamError extends Error {
  readonly code: RunnerSeamErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(code: RunnerSeamErrorCode, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = code;
    this.code = code;
    this.details = details;
  }
}

export class RunnerNotAvailableError extends RunnerSeamError {
  constructor(message = "A git runner is required for this operation") {
    super("RunnerNotAvailable", message);
  }
}

export class RunnerGitError extends RunnerSeamError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super("RunnerGitError", message, details);
  }
}

export class RunnerFilesystemError extends RunnerSeamError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super("RunnerFilesystemError", message, details);
  }
}

export class SafePointIntegrityError extends RunnerSeamError {
  constructor(message: string) {
    super("SafePointIntegrityError", message);
  }
}

export class SafePointPathRejectedError extends RunnerSeamError {
  constructor(message: string) {
    super("SafePointPathRejected", message);
  }
}

export class BackupUnavailableError extends RunnerSeamError {
  constructor(message: string) {
    super("BackupUnavailable", message);
  }
}

export class BackupConflictError extends RunnerSeamError {
  constructor(message: string) {
    super("BackupConflict", message);
  }
}

export class BackupIntegrityError extends RunnerSeamError {
  constructor(message: string) {
    super("BackupIntegrityError", message);
  }
}

export class BackupPathRejectedError extends RunnerSeamError {
  constructor(message: string) {
    super("BackupPathRejected", message);
  }
}

export {
  RunnerNotAvailableError as SafePointNotAvailableError,
  BackupUnavailableError as BackupNotAvailableError,
};

export interface SafePointDatabaseInput {
  readonly path: string;
  /** Optional basename for the snapshot. It is still validated as one path segment. */
  readonly name?: string;
}

export type SafePointDatabase = string | SafePointDatabaseInput;

export type SafePointGitMode = "head" | "commit" | "tag";

export interface SafePointLimits {
  readonly maxDatabases?: number;
  readonly maxBytes?: number;
  readonly maxManifestBytes?: number;
}

export interface SafePointSeams {
  readonly fs?: RunnerFileSystem;
  readonly fileSystem?: RunnerFileSystem;
  readonly gitRunner?: GitRunner;
  readonly git?: GitRunner;
  readonly copyFile?: RunnerCopyFile;
  readonly copy?: RunnerCopyFile;
}

export interface CreateSafePointInput extends SafePointSeams {
  readonly repositoryRoot?: string;
  readonly repoRoot?: string;
  /** Database paths are relative to databaseRoot unless already absolute. */
  readonly databaseRoot?: string;
  readonly databases?: readonly SafePointDatabase[];
  readonly databasePaths?: readonly SafePointDatabase[];
  /** A caller-selected, explicit directory. It is never inferred from git. */
  readonly destination?: string;
  readonly snapshotDirectory?: string;
  readonly id?: string;
  readonly gitMode?: SafePointGitMode;
  readonly tag?: string;
  readonly commitMessage?: string;
  readonly limits?: SafePointLimits;
}

export interface SafePointDatabaseRecord {
  readonly archivePath: string;
  readonly restorePath: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface SafePointManifest {
  readonly format: "lightphysics-safe-point";
  readonly version: 1;
  readonly id: string;
  readonly gitIdentifier: string;
  readonly gitReference: "commit" | "tag";
  readonly databases: readonly SafePointDatabaseRecord[];
}

export interface SafePoint {
  readonly id: string;
  readonly directory: string;
  readonly manifestPath: string;
  readonly gitIdentifier: string;
  readonly gitReference: "commit" | "tag";
  readonly databases: readonly SafePointDatabaseRecord[];
}

export interface SafePointListInput extends SafePointSeams {
  readonly root: string;
  readonly limit?: number;
}

export interface VerifySafePointInput extends SafePointSeams {
  readonly directory: string;
  /** Repository cwd used for git verification when the snapshot lives elsewhere. */
  readonly repositoryRoot?: string;
  readonly repoRoot?: string;
  /** When false, only the database snapshot is verified. Default is true. */
  readonly verifyGit?: boolean;
}

export interface SafePointVerification {
  readonly ok: boolean;
  readonly valid: boolean;
  readonly directory: string;
  readonly git: {
    readonly status: "verified" | "unavailable" | "invalid" | "not_checked";
    readonly identifier: string;
    readonly message?: string;
  };
  readonly databases: readonly { readonly archivePath: string; readonly status: "verified" | "invalid"; readonly message?: string }[];
  readonly issues: readonly string[];
}

export interface RollbackSafePointInput extends VerifySafePointInput {
  readonly repositoryRoot?: string;
  readonly repoRoot?: string;
  readonly databaseRoot?: string;
  readonly overwrite?: boolean;
}

export interface RollbackResult {
  readonly ok: true;
  readonly safePoint: SafePoint;
  readonly restoredDatabases: readonly string[];
  readonly gitIdentifier: string;
}

export interface BackupLimits {
  readonly maxFiles?: number;
  readonly maxBytes?: number;
  readonly maxManifestBytes?: number;
}

export interface BackupManagerOptions extends SafePointSeams {
  readonly limits?: BackupLimits;
}

export interface BackupRequest extends SafePointSeams {
  readonly home: string;
  readonly destination: string;
  readonly ledgerDatabase?: string | false;
  readonly runnerDatabase?: string | false;
  readonly ledgerPath?: string;
  readonly runnerPath?: string;
  readonly casRoot?: string | false;
  readonly configPaths?: readonly string[];
  readonly configFiles?: readonly string[];
  readonly allowedConfigFiles?: readonly string[];
  readonly includeLedgerDatabase?: boolean;
  readonly includeRunnerDatabase?: boolean;
  readonly includeCas?: boolean;
  readonly overwrite?: boolean;
  readonly limits?: BackupLimits;
}

export interface BackupManifestEntry {
  readonly category: "ledger" | "runner" | "cas" | "config";
  readonly archivePath: string;
  readonly restorePath: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly redacted?: true;
}

export interface BackupManifest {
  readonly format: "lightphysics-backup";
  readonly version: 1;
  readonly entries: readonly BackupManifestEntry[];
  readonly omitted: readonly { readonly category: "config"; readonly reason: "secret-like" }[];
  readonly totals: { readonly files: number; readonly bytes: number };
}

export interface BackupResult {
  readonly ok: true;
  readonly destination: string;
  readonly manifestPath: string;
  readonly manifest: BackupManifest;
  readonly manifestSha256: string;
}

export interface VerifyBackupInput extends SafePointSeams {
  readonly destination: string;
}

export interface BackupVerification {
  readonly ok: boolean;
  readonly valid: boolean;
  readonly destination: string;
  readonly filesChecked: number;
  readonly bytesChecked: number;
  readonly issues: readonly string[];
}

export interface RestoreBackupInput extends VerifyBackupInput {
  /** Explicit validated LP_HOME destination. It is never inferred from the backup. */
  readonly destinationRoot: string;
  readonly overwrite?: boolean;
}

export interface RestoreBackupResult {
  readonly ok: true;
  readonly destinationRoot: string;
  readonly restoredFiles: readonly string[];
  readonly bytes: number;
}

interface NormalizedLimits {
  readonly maxFiles: number;
  readonly maxBytes: number;
  readonly maxManifestBytes: number;
}

const nodeFileSystem: RunnerFileSystem = {
  lstat(filePath) {
    const info = lstatSync(filePath);
    return {
      kind: info.isFile() ? "file" : info.isDirectory() ? "directory" : info.isSymbolicLink() ? "symlink" : "other",
      size: Number(info.size),
    };
  },
  readdir(directory) {
    return readdirSync(directory, { encoding: "utf8" });
  },
  readFile(filePath) {
    return readFileSync(filePath);
  },
  writeFile(filePath, bytes, options = {}) {
    writeFileSync(filePath, Buffer.from(bytes), { flag: options.overwrite === false ? "wx" : "w" });
  },
  mkdir(directory) {
    mkdirSync(directory, { recursive: true });
  },
  copyFile(source, destination, options = {}) {
    copyFileSync(source, destination, options.overwrite === false ? fsConstants.COPYFILE_EXCL : 0);
  },
};

export const defaultRunnerFileSystem = nodeFileSystem;

/** Explicit opt-in real git runner. Safe-point APIs do not install it by default. */
export function createNodeGitRunner(): GitRunner {
  return (command, args, options) => {
    const result = spawnSync(command, [...args], {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    if (result.error) throw new RunnerGitError("git runner could not start", { causeCode: errorCode(result.error) });
    const stdout = String(result.stdout ?? "");
    const stderr = String(result.stderr ?? "");
    if (byteLength(stdout) > MAX_GIT_OUTPUT_BYTES || byteLength(stderr) > MAX_GIT_OUTPUT_BYTES) {
      throw new RunnerGitError("git runner output exceeded its bound");
    }
    return { status: result.status ?? -1, stdout, stderr };
  };
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as { readonly code?: unknown }).code;
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,31}$/.test(value) ? value : undefined;
}

function missing(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function validateText(value: unknown, field: string, maximum = MAX_BACKUP_PATH_BYTES): string {
  if (typeof value !== "string" || value.length === 0) throw new RunnerValidationError(`${field} is required`);
  if (value.includes("\u0000") || /[\u0001-\u001f\u007f]/.test(value)) throw new RunnerValidationError(`${field} contains unsupported control characters`);
  if (byteLength(value) > maximum) throw new RunnerValidationError(`${field} exceeds its size bound`);
  return value;
}

function isAbsoluteLike(value: string): boolean {
  return path.isAbsolute(value) || path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || /^[A-Za-z]:/.test(value) || /^(?:\\\\|\/\/)/.test(value) || /^(?:\\\\\.\\|\\\\\?\\|\/\/\.\/)/.test(value);
}

function pathSegments(value: string): string[] {
  return value.replaceAll("\\", "/").split("/").filter((segment) => segment.length > 0);
}

function rejectUnsafeSegments(value: string, field: string, allowDot = false): void {
  for (const [index, segment] of pathSegments(value).entries()) {
    if (segment === ".." || (!allowDot && segment === ".")) throw new RunnerValidationError(`${field} contains traversal`);
    if (allowDot && index === 0 && /^[A-Za-z]:$/.test(segment)) continue;
    if (segment.includes(":")) throw new RunnerValidationError(`${field} contains a device or stream segment`);
    if (segment.endsWith(".") || segment.endsWith(" ") || RESERVED_DEVICE.test(segment)) {
      throw new RunnerValidationError(`${field} contains an unsafe path segment`);
    }
  }
}

function normalizedRelative(value: unknown, field: string): string {
  const candidate = validateText(value, field);
  if (isAbsoluteLike(candidate)) throw new RunnerValidationError(`${field} must be relative`);
  rejectUnsafeSegments(candidate, field);
  const normalized = pathSegments(candidate).join("/");
  if (normalized.length === 0) throw new RunnerValidationError(`${field} must not be empty`);
  return normalized;
}

function absoluteRoot(value: unknown, field: string): string {
  const candidate = validateText(value, field);
  if (!isAbsoluteLike(candidate) || path.win32.isAbsolute(candidate) && /^[A-Za-z]:/.test(candidate) && process.platform !== "win32") {
    if (!path.isAbsolute(candidate)) throw new RunnerValidationError(`${field} must be an absolute path`);
  }
  if (/^(?:\\\\|\/\/)/.test(candidate)) throw new RunnerValidationError(`${field} may not be UNC`);
  rejectUnsafeSegments(candidate, field, true);
  return path.resolve(candidate);
}

function within(root: string, target: string, field: string, allowRoot = true): void {
  const relative = path.relative(root, target);
  if ((!allowRoot && relative === "") || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new RunnerValidationError(`${field} escapes its validated root`);
  }
}

function lstat(fs: RunnerFileSystem, filePath: string, field: string): RunnerFileStat {
  try {
    return fs.lstat(filePath);
  } catch (error) {
    if (missing(error)) throw new RunnerFilesystemError(`${field} is unavailable`);
    throw new RunnerFilesystemError(`${field} could not be inspected`, { causeCode: errorCode(error) });
  }
}

function assertNoSymlinkPath(fs: RunnerFileSystem, target: string, field: string, allowMissing: boolean): void {
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const segment of pathSegments(path.relative(parsed.root, absolute))) {
    current = path.join(current, segment);
    try {
      const info = fs.lstat(current);
      if (info.kind === "symlink") throw new RunnerValidationError(`${field} may not contain a symbolic link`);
    } catch (error) {
      if (error instanceof RunnerValidationError) throw error;
      if (missing(error)) {
        if (allowMissing) return;
        throw new RunnerFilesystemError(`${field} is unavailable`);
      }
      throw new RunnerFilesystemError(`${field} could not be inspected`, { causeCode: errorCode(error) });
    }
  }
}

function assertDirectory(fs: RunnerFileSystem, directory: string, field: string): void {
  const info = lstat(fs, directory, field);
  if (info.kind === "symlink") throw new RunnerValidationError(`${field} may not be a symbolic link`);
  if (info.kind !== "directory") throw new RunnerValidationError(`${field} must be a directory`);
}

function ensureDirectory(fs: RunnerFileSystem, directory: string, field: string): void {
  const absolute = path.resolve(directory);
  assertNoSymlinkPath(fs, absolute, field, true);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const segment of pathSegments(path.relative(parsed.root, absolute))) {
    current = path.join(current, segment);
    try {
      const info = fs.lstat(current);
      if (info.kind === "symlink") throw new RunnerValidationError(`${field} may not contain a symbolic link`);
      if (info.kind !== "directory") throw new RunnerValidationError(`${field} contains a non-directory component`);
    } catch (error) {
      if (error instanceof RunnerValidationError) throw error;
      if (!missing(error)) throw new RunnerFilesystemError(`${field} could not be inspected`, { causeCode: errorCode(error) });
      try {
        fs.mkdir(current);
      } catch (mkdirError) {
        throw new RunnerFilesystemError(`${field} could not be created`, { causeCode: errorCode(mkdirError) });
      }
    }
  }
  assertDirectory(fs, absolute, field);
  assertNoSymlinkPath(fs, absolute, field, false);
}

function safeOutputPath(fs: RunnerFileSystem, destination: string, relative: string, field: string): string {
  const normalized = normalizedRelative(relative, field);
  const output = path.resolve(destination, ...normalized.split("/"));
  within(destination, output, field, false);
  assertNoSymlinkPath(fs, output, field, true);
  return output;
}

function readRegularFile(fs: RunnerFileSystem, source: string, field: string, maximum: number): Buffer {
  assertNoSymlinkPath(fs, source, field, false);
  const info = lstat(fs, source, field);
  if (info.kind === "symlink") throw new RunnerValidationError(`${field} may not be a symbolic link`);
  if (info.kind !== "file") throw new RunnerValidationError(`${field} must be a regular file`);
  if (!Number.isSafeInteger(info.size) || info.size < 0 || info.size > maximum) throw new RunnerValidationError(`${field} exceeds its size bound`);
  let bytes: Uint8Array;
  try {
    bytes = fs.readFile(source);
  } catch (error) {
    throw new RunnerFilesystemError(`${field} could not be read`, { causeCode: errorCode(error) });
  }
  const result = Buffer.from(bytes);
  if (result.byteLength > maximum) throw new RunnerValidationError(`${field} exceeds its size bound`);
  return result;
}

function backupRequiredFile(fs: RunnerFileSystem, source: string, field: string, maximum: number): Buffer {
  try {
    return readRegularFile(fs, source, field, maximum);
  } catch (error) {
    if (error instanceof RunnerFilesystemError && error.details?.causeCode === "ENOENT") {
      throw new BackupUnavailableError(`${field} is unavailable`);
    }
    throw error;
  }
}

function writeBytes(fs: RunnerFileSystem, destination: string, bytes: Uint8Array, overwrite: boolean, field: string): void {
  const parent = path.dirname(destination);
  ensureDirectory(fs, parent, `${field} parent`);
  try {
    fs.writeFile(destination, bytes, { overwrite });
  } catch (error) {
    if (error instanceof RunnerSeamError) throw error;
    if (errorCode(error) === "EEXIST") throw new BackupConflictError(`${field} already exists`);
    throw new RunnerFilesystemError(`${field} could not be written`, { causeCode: errorCode(error) });
  }
}

function copyVerified(
  fs: RunnerFileSystem,
  source: string,
  destination: string,
  expected: Uint8Array,
  overwrite: boolean,
  field: string,
  copy?: RunnerCopyFile,
): void {
  const copier = copy ?? fs.copyFile;
  if (!copier) {
    writeBytes(fs, destination, expected, overwrite, field);
    return;
  }
  ensureDirectory(fs, path.dirname(destination), `${field} parent`);
  try {
    copier(source, destination, { overwrite });
  } catch (error) {
    if (error instanceof RunnerSeamError) throw error;
    if (errorCode(error) === "EEXIST") throw new BackupConflictError(`${field} already exists`);
    throw new RunnerFilesystemError(`${field} could not be copied`, { causeCode: errorCode(error) });
  }
  const copied = readRegularFile(fs, destination, field, expected.byteLength);
  if (copied.byteLength !== expected.byteLength || sha256(copied) !== sha256(expected)) {
    throw new RunnerFilesystemError(`${field} copy failed verification`);
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stableValue(item));
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(object).sort()) result[key] = stableValue(object[key]);
    return result;
  }
  return value;
}

function manifestBytes(value: unknown, maximum: number): Buffer {
  const serialized = `${JSON.stringify(stableValue(value), null, 2)}\n`;
  if (byteLength(serialized) > maximum) throw new RunnerValidationError(`manifest exceeds ${maximum} bytes`);
  return Buffer.from(serialized, "utf8");
}

function parseManifest<T>(fs: RunnerFileSystem, filePath: string, maximum: number, format: string): T {
  const integrityError = format === "lightphysics-safe-point" ? SafePointIntegrityError : BackupIntegrityError;
  const bytes = readRegularFile(fs, filePath, "manifest", maximum);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new integrityError("manifest is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || (parsed as { format?: unknown }).format !== format) {
    throw new integrityError("manifest format is unsupported");
  }
  const canonical = manifestBytes(parsed, maximum);
  if (!canonical.equals(bytes)) throw new integrityError("manifest is not deterministic canonical JSON");
  return parsed as T;
}

function normalizeLimit(value: number | undefined, field: string, minimum: number, maximum: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new RunnerValidationError(`${field} is outside its bound`);
  return value;
}

function safePointLimits(input: SafePointLimits | undefined): NormalizedLimits {
  return {
    maxFiles: normalizeLimit(input?.maxDatabases, "maxDatabases", 1, MAX_SAFE_POINT_DATABASES, MAX_SAFE_POINT_DATABASES),
    maxBytes: normalizeLimit(input?.maxBytes, "maxBytes", 1, MAX_SAFE_POINT_DATABASE_BYTES, MAX_SAFE_POINT_DATABASE_BYTES),
    maxManifestBytes: normalizeLimit(input?.maxManifestBytes, "maxManifestBytes", 1, MAX_SAFE_POINT_MANIFEST_BYTES, MAX_SAFE_POINT_MANIFEST_BYTES),
  };
}

function backupLimits(input: BackupLimits | undefined): NormalizedLimits {
  return {
    maxFiles: normalizeLimit(input?.maxFiles, "maxFiles", 1, MAX_BACKUP_FILES, MAX_BACKUP_FILES),
    maxBytes: normalizeLimit(input?.maxBytes, "maxBytes", 1, MAX_BACKUP_BYTES, MAX_BACKUP_BYTES),
    maxManifestBytes: normalizeLimit(input?.maxManifestBytes, "maxManifestBytes", 1, MAX_BACKUP_MANIFEST_BYTES, MAX_BACKUP_MANIFEST_BYTES),
  };
}

function fsFor(seams: SafePointSeams | undefined, fallback: RunnerFileSystem): RunnerFileSystem {
  return seams?.fs ?? seams?.fileSystem ?? fallback;
}

function gitFor(seams: SafePointSeams): GitRunner | undefined {
  return seams.gitRunner ?? seams.git;
}

function requireGit(seams: SafePointSeams): GitRunner {
  const runner = gitFor(seams);
  if (!runner) throw new RunnerNotAvailableError();
  return runner;
}

function gitCommand(runner: GitRunner, cwd: string, args: readonly string[]): GitCommandResult {
  let result: GitCommandResult;
  try {
    result = runner("git", [...args], { cwd, shell: false });
  } catch (error) {
    if (error instanceof RunnerSeamError) throw error;
    throw new RunnerGitError("git runner failed", { causeCode: errorCode(error) });
  }
  if (!result || typeof result.status !== "number" || typeof result.stdout !== "string" || typeof result.stderr !== "string") {
    throw new RunnerGitError("git runner returned an invalid result");
  }
  if (byteLength(result.stdout) > MAX_GIT_OUTPUT_BYTES || byteLength(result.stderr) > MAX_GIT_OUTPUT_BYTES) {
    throw new RunnerGitError("git runner output exceeded its bound");
  }
  if (result.status !== 0) throw new RunnerGitError("git command failed", { status: result.status });
  return result;
}

function gitIdentifier(runner: GitRunner, cwd: string): string {
  const result = gitCommand(runner, cwd, ["rev-parse", "--verify", "HEAD"]);
  const identifier = result.stdout.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(identifier) || identifier.includes("..")) throw new RunnerGitError("git returned an invalid commit identifier");
  return identifier;
}

function validateId(value: string | undefined, fallback: string): string {
  const id = validateText(value ?? fallback, "safe point id", 256);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) throw new RunnerValidationError("safe point id contains unsupported characters");
  return id;
}

function validateTag(value: string): string {
  const tag = validateText(value, "git tag", 256);
  if (!/^[-A-Za-z0-9_./]+$/.test(tag) || tag.startsWith("-") || tag.includes("..") || tag.endsWith(".")) {
    throw new RunnerValidationError("git tag contains unsupported characters");
  }
  return tag;
}

function resolveUnder(root: string, input: string, field: string): { absolute: string; relative: string } {
  const candidate = validateText(input, field);
  const absolute = isAbsoluteLike(candidate)
    ? path.resolve(candidate)
    : path.resolve(root, ...normalizedRelative(candidate, field).split("/"));
  within(root, absolute, field, false);
  return { absolute, relative: path.posix.join(...path.relative(root, absolute).split(path.sep)) };
}

function safePointRecord(directory: string, manifest: SafePointManifest): SafePoint {
  return Object.freeze({
    id: manifest.id,
    directory,
    manifestPath: path.join(directory, "manifest.json"),
    gitIdentifier: manifest.gitIdentifier,
    gitReference: manifest.gitReference,
    databases: Object.freeze([...manifest.databases]),
  });
}

function normalizeSafePointManifest(manifest: SafePointManifest): SafePointManifest {
  if (manifest.version !== SAFE_POINT_SCHEMA_VERSION || manifest.format !== "lightphysics-safe-point") throw new SafePointIntegrityError("safe-point manifest version is unsupported");
  validateId(manifest.id, manifest.id);
  if (manifest.gitReference !== "commit" && manifest.gitReference !== "tag") throw new SafePointIntegrityError("safe-point git reference is invalid");
  validateText(manifest.gitIdentifier, "safe-point git identifier", 256);
  if (!Array.isArray(manifest.databases) || manifest.databases.length > MAX_SAFE_POINT_DATABASES) throw new SafePointIntegrityError("safe-point database list is invalid");
  const seen = new Set<string>();
  for (const database of manifest.databases) {
    if (!database || typeof database !== "object") throw new SafePointIntegrityError("safe-point database record is invalid");
    const archivePath = normalizedRelative(database.archivePath, "safe-point archive path");
    const restorePath = normalizedRelative(database.restorePath, "safe-point restore path");
    if (seen.has(archivePath)) throw new SafePointIntegrityError("safe-point archive paths must be unique");
    seen.add(archivePath);
    if (!Number.isSafeInteger(database.bytes) || database.bytes < 0 || !/^[0-9a-f]{64}$/.test(database.sha256)) throw new SafePointIntegrityError("safe-point database hash or size is invalid");
    if (!archivePath.startsWith("databases/")) throw new SafePointIntegrityError("safe-point database archive path is invalid");
    void restorePath;
  }
  return manifest;
}

function databaseInputs(input: CreateSafePointInput, root: string): readonly { absolute: string; relative: string; archivePath: string }[] {
  const values = input.databases ?? input.databasePaths;
  if (!values || values.length === 0) throw new RunnerValidationError("at least one database snapshot is required");
  if (values.length > MAX_SAFE_POINT_DATABASES) throw new RunnerValidationError("database snapshot count exceeds its bound");
  const seen = new Set<string>();
  return values.map((value, index) => {
    const candidate = typeof value === "string" ? { path: value } : value;
    if (!candidate || typeof candidate !== "object") throw new RunnerValidationError(`database ${index} is invalid`);
    const resolved = resolveUnder(root, candidate.path, `database ${index} path`);
    const name = candidate.name === undefined ? path.basename(resolved.absolute) : normalizedRelative(candidate.name, `database ${index} name`);
    if (name.includes("/")) throw new RunnerValidationError(`database ${index} name must be one path segment`);
    const archivePath = `databases/${name}`;
    if (seen.has(archivePath)) throw new RunnerValidationError("database snapshot names must be unique");
    seen.add(archivePath);
    return { absolute: resolved.absolute, relative: resolved.relative, archivePath };
  });
}

function verifySafePointManifest(fs: RunnerFileSystem, directory: string, limits = safePointLimits(undefined)): SafePointManifest {
  const manifestPath = safeOutputPath(fs, directory, "manifest.json", "safe-point manifest path");
  const manifest = normalizeSafePointManifest(parseManifest<SafePointManifest>(fs, manifestPath, limits.maxManifestBytes, "lightphysics-safe-point"));
  let total = 0;
  for (const database of manifest.databases) {
    total += database.bytes;
    if (total > limits.maxBytes) throw new SafePointIntegrityError("safe-point database bytes exceed their bound");
  }
  return manifest;
}

export class SafePointManager {
  private readonly defaultFs: RunnerFileSystem;
  private readonly defaultGit: GitRunner | undefined;
  private readonly defaultCopy: RunnerCopyFile | undefined;

  constructor(options: SafePointSeams = {}) {
    this.defaultFs = fsFor(options, defaultRunnerFileSystem);
    this.defaultGit = gitFor(options);
    this.defaultCopy = options.copyFile ?? options.copy;
  }

  create(input: CreateSafePointInput): SafePoint {
    const fs = fsFor(input, this.defaultFs);
    const repositoryRoot = absoluteRoot(input.repositoryRoot ?? input.repoRoot, "repositoryRoot");
    const databaseRoot = absoluteRoot(input.databaseRoot ?? repositoryRoot, "databaseRoot");
    const destination = absoluteRoot(input.destination ?? input.snapshotDirectory, "safe-point destination");
    within(repositoryRoot, repositoryRoot, "repositoryRoot");
    assertNoSymlinkPath(fs, repositoryRoot, "repositoryRoot", false);
    assertDirectory(fs, repositoryRoot, "repositoryRoot");
    const runner = input.gitRunner ?? input.git ?? this.defaultGit;
    const copy = input.copyFile ?? input.copy ?? this.defaultCopy;
    if (!runner) throw new RunnerNotAvailableError();
    const limits = safePointLimits(input.limits);
    const databases = databaseInputs(input, databaseRoot);
    if (databases.length > limits.maxFiles) throw new RunnerValidationError("database snapshot count exceeds its bound");
    const mode = input.gitMode ?? (input.tag === undefined ? input.commitMessage === undefined ? "head" : "commit" : "tag");
    let identifier: string;
    let reference: "commit" | "tag" = "commit";
    if (mode === "commit") {
      const message = validateText(input.commitMessage ?? "LightPhysics safe point", "commit message", 4 * 1024);
      gitCommand(runner, repositoryRoot, ["commit", "-m", message]);
      identifier = gitIdentifier(runner, repositoryRoot);
    } else {
      const head = gitIdentifier(runner, repositoryRoot);
      if (mode === "tag") {
        const tag = validateTag(input.tag ?? `lp/safepoint/${head.slice(0, 12)}`);
        gitCommand(runner, repositoryRoot, ["tag", tag, head]);
        identifier = tag;
        reference = "tag";
      } else {
        identifier = head;
      }
    }
    const records: SafePointDatabaseRecord[] = [];
    let total = 0;
    const idSeed: string[] = [];
    for (const database of databases) {
      const bytes = readRegularFile(fs, database.absolute, `database ${database.relative}`, limits.maxBytes);
      total += bytes.byteLength;
      if (total > limits.maxBytes) throw new RunnerValidationError("safe-point database bytes exceed their bound");
      const hash = sha256(bytes);
      const record = { archivePath: database.archivePath, restorePath: database.relative, bytes: bytes.byteLength, sha256: hash } satisfies SafePointDatabaseRecord;
      records.push(record);
      idSeed.push(`${record.archivePath}:${record.bytes}:${record.sha256}`);
    }
    const id = validateId(input.id, `safepoint-${sha256(Buffer.from(`${identifier}|${idSeed.join("|")}`, "utf8")).slice(0, 24)}`);
    const manifest: SafePointManifest = {
      format: "lightphysics-safe-point",
      version: SAFE_POINT_SCHEMA_VERSION,
      id,
      gitIdentifier: identifier,
      gitReference: reference,
      databases: records.sort((left, right) => left.archivePath.localeCompare(right.archivePath)),
    };
    const manifestFile = manifestBytes(manifest, limits.maxManifestBytes);
    ensureDirectory(fs, destination, "safe-point destination");
    const manifestPath = safeOutputPath(fs, destination, "manifest.json", "safe-point manifest path");
    const existing = existingPath(fs, manifestPath);
    if (existing) throw new BackupConflictError("safe-point destination already contains a manifest");
    writeBytes(fs, manifestPath, manifestFile, false, "safe-point manifest");
    for (const database of databases) {
      const record = records.find((candidate) => candidate.restorePath === database.relative && candidate.archivePath === database.archivePath);
      if (!record) throw new SafePointIntegrityError("safe-point database record disappeared");
      const bytes = readRegularFile(fs, database.absolute, `database ${database.relative}`, limits.maxBytes);
      if (sha256(bytes) !== record.sha256) throw new SafePointIntegrityError("database changed while creating safe point");
      const target = safeOutputPath(fs, destination, record.archivePath, "safe-point database archive path");
      copyVerified(fs, database.absolute, target, bytes, false, "safe-point database snapshot", copy);
    }
    return safePointRecord(destination, manifest);
  }

  list(input: SafePointListInput): readonly SafePoint[] {
    const fs = fsFor(input, this.defaultFs);
    const root = absoluteRoot(input.root, "safe-point root");
    const limit = normalizeLimit(input.limit, "safe-point list limit", 1, MAX_SAFE_POINTS, MAX_SAFE_POINTS);
    assertNoSymlinkPath(fs, root, "safe-point root", false);
    assertDirectory(fs, root, "safe-point root");
    let names: readonly string[];
    try {
      names = fs.readdir(root);
    } catch (error) {
      throw new RunnerFilesystemError("safe-point root could not be listed", { causeCode: errorCode(error) });
    }
    const result: SafePoint[] = [];
    for (const name of [...names].sort((left, right) => left.localeCompare(right))) {
      if (result.length >= limit) break;
      const relative = normalizedRelative(name, "safe-point entry");
      const directory = path.resolve(root, ...relative.split("/"));
      within(root, directory, "safe-point entry", false);
      const info = lstat(fs, directory, "safe-point entry");
      if (info.kind === "symlink") throw new RunnerValidationError("safe-point entries may not be symbolic links");
      if (info.kind !== "directory") continue;
      const manifestPath = path.join(directory, "manifest.json");
      if (!existingPath(fs, manifestPath)) continue;
      const manifest = verifySafePointManifest(fs, directory);
      result.push(safePointRecord(directory, manifest));
    }
    return Object.freeze(result);
  }

  verify(input: VerifySafePointInput): SafePointVerification {
    const fs = fsFor(input, this.defaultFs);
    const directory = absoluteRoot(input.directory, "safe-point directory");
    const issues: string[] = [];
    let manifest: SafePointManifest | undefined;
    try {
      manifest = verifySafePointManifest(fs, directory);
    } catch (error) {
      issues.push(error instanceof Error ? error.message : "safe-point manifest is invalid");
    }
    const databases: Array<{ archivePath: string; status: "verified" | "invalid"; message?: string }> = [];
    if (manifest) {
      for (const database of manifest.databases) {
        try {
          const filePath = safeOutputPath(fs, directory, database.archivePath, "safe-point database archive path");
          const bytes = readRegularFile(fs, filePath, "safe-point database snapshot", MAX_SAFE_POINT_DATABASE_BYTES);
          if (bytes.byteLength !== database.bytes || sha256(bytes) !== database.sha256) throw new SafePointIntegrityError("snapshot hash or size does not match the manifest");
          databases.push({ archivePath: database.archivePath, status: "verified" });
        } catch (error) {
          const message = error instanceof Error ? error.message : "snapshot is invalid";
          databases.push({ archivePath: database.archivePath, status: "invalid", message });
          issues.push(message);
        }
      }
    }
    const identifier = manifest?.gitIdentifier ?? "";
    let git: SafePointVerification["git"] = { status: "not_checked", identifier };
    if (input.verifyGit !== false && manifest) {
      const runner = input.gitRunner ?? input.git ?? this.defaultGit;
      if (!runner) {
        git = { status: "unavailable", identifier, message: "git runner is not available" };
        issues.push("git runner is not available");
      } else {
        try {
          const repositoryRoot = input.repositoryRoot === undefined && input.repoRoot === undefined
            ? path.dirname(path.resolve(directory))
            : absoluteRoot(input.repositoryRoot ?? input.repoRoot, "repositoryRoot");
          gitCommand(runner, repositoryRoot, ["rev-parse", "--verify", manifest.gitIdentifier]);
          git = { status: "verified", identifier };
        } catch (error) {
          const message = error instanceof Error ? error.message : "git identifier is invalid";
          git = { status: "invalid", identifier, message };
          issues.push(message);
        }
      }
    }
    const ok = issues.length === 0 && (input.verifyGit === false || git.status === "verified");
    return Object.freeze({ ok, valid: ok, directory, git, databases: Object.freeze(databases), issues: Object.freeze(issues) });
  }

  rollback(input: RollbackSafePointInput): RollbackResult {
    const fs = fsFor(input, this.defaultFs);
    const repositoryRoot = absoluteRoot(input.repositoryRoot ?? input.repoRoot, "repositoryRoot");
    const databaseRoot = absoluteRoot(input.databaseRoot ?? repositoryRoot, "databaseRoot");
    const directory = absoluteRoot(input.directory, "safe-point directory");
    const runner = input.gitRunner ?? input.git ?? this.defaultGit;
    if (!runner) throw new RunnerNotAvailableError();
    assertNoSymlinkPath(fs, repositoryRoot, "repositoryRoot", false);
    assertDirectory(fs, repositoryRoot, "repositoryRoot");
    const manifest = verifySafePointManifest(fs, directory);
    const snapshots: Array<{ record: SafePointDatabaseRecord; bytes: Buffer; target: string }> = [];
    for (const record of manifest.databases) {
      const archive = safeOutputPath(fs, directory, record.archivePath, "safe-point database archive path");
      const bytes = readRegularFile(fs, archive, "safe-point database snapshot", MAX_SAFE_POINT_DATABASE_BYTES);
      if (bytes.byteLength !== record.bytes || sha256(bytes) !== record.sha256) throw new SafePointIntegrityError("snapshot hash or size does not match the manifest");
      const relative = normalizedRelative(record.restorePath, "safe-point restore path");
      const target = safeOutputPath(fs, databaseRoot, relative, "rollback database destination");
      snapshots.push({ record, bytes, target });
    }
    gitCommand(runner, repositoryRoot, ["reset", "--hard", manifest.gitIdentifier]);
    const overwrite = input.overwrite === true;
    for (const snapshot of snapshots) writeBytes(fs, snapshot.target, snapshot.bytes, overwrite, "rollback database destination");
    const safePoint = safePointRecord(directory, manifest);
    return { ok: true, safePoint, restoredDatabases: Object.freeze(snapshots.map((snapshot) => snapshot.record.restorePath)), gitIdentifier: manifest.gitIdentifier };
  }

  createSafePoint(input: CreateSafePointInput): SafePoint {
    return this.create(input);
  }

  listSafePoints(input: SafePointListInput): readonly SafePoint[] {
    return this.list(input);
  }

  verifySafePoint(input: VerifySafePointInput): SafePointVerification {
    return this.verify(input);
  }

  rollbackSafePoint(input: RollbackSafePointInput): RollbackResult {
    return this.rollback(input);
  }
}

export function createSafePoint(input: CreateSafePointInput): SafePoint {
  return new SafePointManager(input).create(input);
}

export function listSafePoints(input: SafePointListInput | string): readonly SafePoint[] {
  return new SafePointManager(typeof input === "string" ? {} : input).list(typeof input === "string" ? { root: input } : input);
}

export function verifySafePoint(input: VerifySafePointInput): SafePointVerification {
  return new SafePointManager(input).verify(input);
}

export function rollbackSafePoint(input: RollbackSafePointInput): RollbackResult {
  return new SafePointManager(input).rollback(input);
}

function existingPath(fs: RunnerFileSystem, filePath: string): RunnerFileStat | undefined {
  try {
    return fs.lstat(filePath);
  } catch (error) {
    if (missing(error)) return undefined;
    throw new RunnerFilesystemError("destination could not be inspected", { causeCode: errorCode(error) });
  }
}

function secretLikeFilename(relative: string): boolean {
  const basename = path.posix.basename(relative);
  return basename === ".env" || SECRET_FILENAME.test(basename) || /\.(?:pem|key|p12|pfx|der)$/i.test(basename);
}

function redactConfigValue(value: string): string {
  return SECRET_VALUE.test(value) ? "[REDACTED]" : value;
}

function redactJson(value: unknown): { value: unknown; redacted: boolean } {
  if (typeof value === "string") {
    const redacted = redactConfigValue(value);
    return { value: redacted, redacted: redacted !== value };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const result = value.map((item) => {
      const redacted = redactJson(item);
      changed ||= redacted.redacted;
      return redacted.value;
    });
    return { value: result, redacted: changed };
  }
  if (value && typeof value === "object") {
    let changed = false;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      if (SECRET_NAME.test(key)) {
        changed = true;
      } else {
        const redacted = redactJson((value as Record<string, unknown>)[key]);
        result[key] = redacted.value;
        changed ||= redacted.redacted;
      }
    }
    return { value: result, redacted: changed };
  }
  return { value, redacted: false };
}

function sanitizeConfig(bytes: Buffer, maximum: number): { bytes: Buffer; redacted: boolean } {
  if (bytes.byteLength > maximum) throw new RunnerValidationError("config file exceeds its size bound");
  const text = bytes.toString("utf8");
  if (text.includes("\u0000")) throw new RunnerValidationError("config file contains binary data");
  try {
    const parsed = JSON.parse(text) as unknown;
    const redacted = redactJson(parsed);
    const output = Buffer.from(`${JSON.stringify(stableValue(redacted.value), null, 2)}\n`, "utf8");
    if (output.byteLength > maximum) throw new RunnerValidationError("redacted config file exceeds its size bound");
    return { bytes: output, redacted: redacted.redacted };
  } catch (error) {
    if (error instanceof RunnerSeamError) throw error;
    let redacted = false;
    const output = text.split(/(\r?\n)/).map((line) => {
      const match = /^(\s*(?:export\s+)?["']?)([A-Za-z0-9_.-]+)(["']?\s*(?:[:=])\s*).*$/.exec(line);
      if (match && SECRET_NAME.test(match[2] ?? "")) {
        redacted = true;
        return "[REDACTED CONFIG KEY]";
      }
      const replaced = line.replace(SECRET_VALUE, "[REDACTED]");
      redacted ||= replaced !== line;
      return replaced;
    }).join("");
    const result = Buffer.from(output, "utf8");
    if (result.byteLength > maximum) throw new RunnerValidationError("redacted config file exceeds its size bound");
    return { bytes: result, redacted };
  }
}

interface SourceFile {
  readonly category: "ledger" | "runner" | "cas" | "config";
  readonly source: string;
  readonly archivePath: string;
  readonly restorePath: string;
  readonly config?: boolean;
}

function walkFiles(fs: RunnerFileSystem, root: string, relative = "", result: string[] = []): readonly string[] {
  const directory = relative.length === 0 ? root : path.resolve(root, ...relative.split("/"));
  const info = lstat(fs, directory, "CAS root");
  if (info.kind === "symlink") throw new BackupPathRejectedError("CAS root may not contain symbolic links");
  if (info.kind !== "directory") throw new BackupPathRejectedError("CAS root must be a directory");
  let names: readonly string[];
  try {
    names = fs.readdir(directory);
  } catch (error) {
    throw new RunnerFilesystemError("CAS root could not be listed", { causeCode: errorCode(error) });
  }
  for (const name of [...names].sort((left, right) => left.localeCompare(right))) {
    const child = normalizedRelative(name, "CAS entry");
    const childRelative = relative.length === 0 ? child : `${relative}/${child}`;
    const childPath = path.resolve(root, ...childRelative.split("/"));
    within(root, childPath, "CAS entry", false);
    assertNoSymlinkPath(fs, childPath, "CAS entry", false);
    const childInfo = lstat(fs, childPath, "CAS entry");
    if (childInfo.kind === "directory") walkFiles(fs, root, childRelative, result);
    else if (childInfo.kind === "file") result.push(childRelative);
    else throw new BackupPathRejectedError("CAS entries must be regular files");
    if (result.length > MAX_BACKUP_FILES) throw new RunnerValidationError("backup file count exceeds its bound");
  }
  return result;
}

function backupManifestValid(manifest: BackupManifest): BackupManifest {
  if (manifest.version !== BACKUP_SCHEMA_VERSION || manifest.format !== "lightphysics-backup") throw new BackupIntegrityError("backup manifest version is unsupported");
  if (!Array.isArray(manifest.entries) || !Array.isArray(manifest.omitted) || !manifest.totals) throw new BackupIntegrityError("backup manifest shape is invalid");
  if (manifest.entries.length > MAX_BACKUP_FILES) throw new BackupIntegrityError("backup manifest file count exceeds its bound");
  const seen = new Set<string>();
  let bytes = 0;
  for (const entry of manifest.entries) {
    if (!entry || typeof entry !== "object") throw new BackupIntegrityError("backup manifest entry is invalid");
    const archivePath = normalizedRelative(entry.archivePath, "backup archive path");
    const restorePath = normalizedRelative(entry.restorePath, "backup restore path");
    if (seen.has(archivePath)) throw new BackupIntegrityError("backup archive paths must be unique");
    seen.add(archivePath);
    if (!(["ledger", "runner", "cas", "config"] as readonly string[]).includes(entry.category)) throw new BackupIntegrityError("backup category is invalid");
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[0-9a-f]{64}$/.test(entry.sha256)) throw new BackupIntegrityError("backup entry hash or size is invalid");
    if (entry.archivePath !== archivePath || entry.restorePath !== restorePath) throw new BackupIntegrityError("backup paths are not canonical");
    const expectedPrefix = entry.category === "cas" ? "cas/" : entry.category === "config" ? "config/" : "databases/";
    if (!archivePath.startsWith(expectedPrefix)) throw new BackupIntegrityError("backup archive path does not match its category");
    bytes += entry.bytes;
    if (bytes > MAX_BACKUP_BYTES) throw new BackupIntegrityError("backup bytes exceed their bound");
  }
  if (manifest.totals.files !== manifest.entries.length || manifest.totals.bytes !== bytes) throw new BackupIntegrityError("backup totals do not match entries");
  return manifest;
}

export class BackupManager {
  private readonly defaultFs: RunnerFileSystem;
  private readonly defaultLimits: BackupLimits | undefined;
  private readonly defaultCopy: RunnerCopyFile | undefined;

  constructor(options: BackupManagerOptions = {}) {
    this.defaultFs = fsFor(options, defaultRunnerFileSystem);
    this.defaultLimits = options.limits;
    this.defaultCopy = options.copyFile ?? options.copy;
  }

  create(input: BackupRequest): BackupResult {
    const fs = fsFor(input, this.defaultFs);
    const copy = input.copyFile ?? input.copy ?? this.defaultCopy;
    const limits = backupLimits(input.limits ?? this.defaultLimits);
    const home = absoluteRoot(input.home, "LP_HOME");
    const destination = absoluteRoot(input.destination, "backup destination");
    if (!existingPath(fs, home)) throw new BackupUnavailableError("LP_HOME is unavailable");
    assertNoSymlinkPath(fs, home, "LP_HOME", false);
    assertDirectory(fs, home, "LP_HOME");
    if (path.relative(home, destination) === "" || !path.relative(home, destination).startsWith(`..${path.sep}`) && path.relative(home, destination) !== "..") {
      throw new BackupPathRejectedError("backup destination must be outside LP_HOME");
    }
    const sources: SourceFile[] = [];
    const omitted: Array<{ category: "config"; reason: "secret-like" }> = [];
    const addDatabase = (category: "ledger" | "runner", selected: string | false | undefined, alias: string | undefined, include: boolean | undefined, fallback: string): void => {
      if (include === false || selected === false) return;
      const candidate = selected ?? alias ?? fallback;
      const resolved = resolveUnder(home, candidate, `${category} database path`);
      sources.push({ category, source: resolved.absolute, archivePath: `databases/${category}.sqlite`, restorePath: resolved.relative });
    };
    addDatabase("ledger", input.ledgerDatabase, input.ledgerPath, input.includeLedgerDatabase, DEFAULT_LEDGER_DATABASE_RELATIVE);
    addDatabase("runner", input.runnerDatabase, input.runnerPath, input.includeRunnerDatabase, BACKUP_DEFAULT_RUNNER_DATABASE_RELATIVE);
    if (input.includeCas !== false && input.casRoot !== false) {
      const casCandidate = input.casRoot ?? BACKUP_DEFAULT_CAS_ROOT_RELATIVE;
      const cas = resolveUnder(home, casCandidate, "CAS root");
      let files: readonly string[];
      try {
        files = walkFiles(fs, cas.absolute);
      } catch (error) {
        if (error instanceof RunnerFilesystemError && error.details?.causeCode === "ENOENT") {
          throw new BackupUnavailableError("CAS root is unavailable");
        }
        throw error;
      }
      for (const relative of files) sources.push({ category: "cas", source: path.resolve(cas.absolute, ...relative.split("/")), archivePath: `cas/${relative}`, restorePath: `${cas.relative}/${relative}` });
    }
    const configs = input.configPaths ?? input.configFiles ?? input.allowedConfigFiles ?? [];
    if (configs.length > MAX_BACKUP_FILES) throw new RunnerValidationError("config file count exceeds its bound");
    for (const config of configs) {
      const relative = normalizedRelative(config, "config path");
      if (secretLikeFilename(relative)) {
        omitted.push({ category: "config", reason: "secret-like" });
        continue;
      }
      const resolved = resolveUnder(home, relative, "config path");
      sources.push({ category: "config", source: resolved.absolute, archivePath: `config/${relative}`, restorePath: resolved.relative, config: true });
    }
    if (sources.length > limits.maxFiles) throw new RunnerValidationError("backup file count exceeds its bound");
    const entries: BackupManifestEntry[] = [];
    const payloads: Array<{ source: SourceFile; bytes: Buffer; entry: BackupManifestEntry }> = [];
    let total = 0;
    for (const source of sources.sort((left, right) => left.archivePath.localeCompare(right.archivePath))) {
      const raw = backupRequiredFile(fs, source.source, `${source.category} source`, source.config ? MAX_BACKUP_CONFIG_BYTES : limits.maxBytes);
      const sanitized = source.config ? sanitizeConfig(raw, MAX_BACKUP_CONFIG_BYTES) : { bytes: raw, redacted: false };
      total += sanitized.bytes.byteLength;
      if (total > limits.maxBytes) throw new RunnerValidationError("backup bytes exceed their bound");
      const entry: BackupManifestEntry = {
        category: source.category,
        archivePath: source.archivePath,
        restorePath: source.restorePath,
        bytes: sanitized.bytes.byteLength,
        sha256: sha256(sanitized.bytes),
        ...(sanitized.redacted ? { redacted: true as const } : {}),
      };
      entries.push(entry);
      payloads.push({ source, bytes: sanitized.bytes, entry });
    }
    const manifest: BackupManifest = {
      format: "lightphysics-backup",
      version: BACKUP_SCHEMA_VERSION,
      entries,
      omitted: omitted.sort((left, right) => left.reason.localeCompare(right.reason)),
      totals: { files: entries.length, bytes: total },
    };
    const manifestFile = manifestBytes(manifest, limits.maxManifestBytes);
    ensureDirectory(fs, destination, "backup destination");
    const manifestPath = safeOutputPath(fs, destination, "manifest.json", "backup manifest path");
    const overwrite = input.overwrite === true;
    if (existingPath(fs, manifestPath) && !overwrite) throw new BackupConflictError("backup destination already contains a manifest");
    const targets = payloads.map((payload) => ({
      payload,
      target: safeOutputPath(fs, destination, payload.entry.archivePath, "backup archive path"),
    }));
    if (!overwrite && targets.some(({ target }) => existingPath(fs, target) !== undefined)) {
      throw new BackupConflictError("backup destination already contains an archive file");
    }
    writeBytes(fs, manifestPath, manifestFile, overwrite, "backup manifest");
    for (const { payload, target } of targets) {
      if (payload.source.config) writeBytes(fs, target, payload.bytes, overwrite, "backup archive file");
      else copyVerified(fs, payload.source.source, target, payload.bytes, overwrite, "backup archive file", copy);
    }
    return { ok: true, destination, manifestPath, manifest, manifestSha256: sha256(manifestFile) };
  }

  verify(input: VerifyBackupInput): BackupVerification {
    const fs = fsFor(input, this.defaultFs);
    const destination = absoluteRoot(input.destination, "backup destination");
    const issues: string[] = [];
    let manifest: BackupManifest | undefined;
    try {
      manifest = backupManifestValid(parseManifest<BackupManifest>(fs, path.join(destination, "manifest.json"), MAX_BACKUP_MANIFEST_BYTES, "lightphysics-backup"));
    } catch (error) {
      issues.push(error instanceof Error ? error.message : "backup manifest is invalid");
    }
    let filesChecked = 0;
    let bytesChecked = 0;
    if (manifest) {
      for (const entry of manifest.entries) {
        try {
          const archive = safeOutputPath(fs, destination, entry.archivePath, "backup archive path");
          const bytes = readRegularFile(fs, archive, "backup archive file", MAX_BACKUP_BYTES);
          if (bytes.byteLength !== entry.bytes || sha256(bytes) !== entry.sha256) throw new BackupIntegrityError("backup file hash or size does not match the manifest");
          filesChecked += 1;
          bytesChecked += bytes.byteLength;
        } catch (error) {
          issues.push(error instanceof Error ? error.message : "backup archive file is invalid");
        }
      }
    }
    const ok = issues.length === 0 && manifest !== undefined && filesChecked === manifest.entries.length && bytesChecked === manifest.totals.bytes;
    return Object.freeze({ ok, valid: ok, destination, filesChecked, bytesChecked, issues: Object.freeze(issues) });
  }

  restore(input: RestoreBackupInput): RestoreBackupResult {
    const fs = fsFor(input, this.defaultFs);
    const backup = absoluteRoot(input.destination, "backup destination");
    const destinationRoot = absoluteRoot(input.destinationRoot, "restore destination");
    const verification = this.verify({ destination: backup, fs });
    if (!verification.ok) throw new BackupIntegrityError(`backup verification failed: ${verification.issues.join("; ")}`);
    const manifest = backupManifestValid(parseManifest<BackupManifest>(fs, path.join(backup, "manifest.json"), MAX_BACKUP_MANIFEST_BYTES, "lightphysics-backup"));
    ensureDirectory(fs, destinationRoot, "restore destination");
    const overwrite = input.overwrite === true;
    const restores: Array<{ readonly entry: BackupManifestEntry; readonly content: Buffer; readonly target: string }> = [];
    for (const entry of manifest.entries) {
      const source = safeOutputPath(fs, backup, entry.archivePath, "backup archive path");
      const content = readRegularFile(fs, source, "backup archive file", MAX_BACKUP_BYTES);
      const target = safeOutputPath(fs, destinationRoot, entry.restorePath, "restore destination path");
      if (existingPath(fs, target) && !overwrite) throw new BackupConflictError("restore destination already contains a file; pass overwrite explicitly");
      restores.push({ entry, content, target });
    }
    let bytes = 0;
    for (const restore of restores) {
      writeBytes(fs, restore.target, restore.content, overwrite, "restore file");
      bytes += restore.content.byteLength;
    }
    return { ok: true, destinationRoot, restoredFiles: Object.freeze(restores.map(({ entry }) => entry.restorePath)), bytes };
  }

  createBackup(input: BackupRequest): BackupResult {
    return this.create(input);
  }

  verifyBackup(input: VerifyBackupInput): BackupVerification {
    return this.verify(input);
  }

  restoreBackup(input: RestoreBackupInput): RestoreBackupResult {
    return this.restore(input);
  }
}

export function createBackup(input: BackupRequest): BackupResult {
  return new BackupManager(input).create(input);
}

export function verifyBackup(input: VerifyBackupInput): BackupVerification {
  return new BackupManager(input).verify(input);
}

export function restoreBackup(input: RestoreBackupInput): RestoreBackupResult {
  return new BackupManager(input).restore(input);
}
