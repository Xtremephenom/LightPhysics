import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes as nodeRandomBytes,
  timingSafeEqual,
  verify as nodeVerify,
  type KeyObject,
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

/** Decisions that a human may make at this boundary. */
export const APPROVAL_DECISIONS = ["approve", "reject"] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

/** Bounds are deliberately small because this is an in-memory core boundary. */
export const MAX_APPROVAL_REASON_BYTES = 2_048;
export const MAX_APPROVAL_NONCE_BYTES = 128;
export const APPROVAL_NONCE_RANDOM_BYTES = 24;
export const MAX_REPLAY_NONCES = 4_096;
export const ED25519_SIGNATURE_BYTES = 64;
export const MAX_PUBLIC_KEY_BYTES = 8_192;
export const MAX_HUMAN_CHANNEL_STATE_PATH_BYTES = 4_096;
export const MAX_HUMAN_CHANNEL_STATE_BYTES = 1_048_576;
export const HUMAN_CHANNEL_STATE_SCHEMA_VERSION = 1;

const SUBJECT_HASH_PATTERN = /^[0-9a-f]{64}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]+$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const APPROVAL_INPUT_KEYS = ["subject_hash", "decision", "reason"] as const;
const APPROVAL_PAYLOAD_KEYS = ["subject_hash", "decision", "reason", "nonce", "timestamp"] as const;
const SIGNED_APPROVAL_KEYS = [...APPROVAL_PAYLOAD_KEYS, "signature"] as const;

export type HumanChannelClock = () => Date | string | number;
export type HumanChannelRandomBytes = (size: number) => Uint8Array;
export type HumanChannelNonceGenerator = () => string | Uint8Array;
export type HumanChannelSigner = (payload: Uint8Array) => Uint8Array;
export type PublicKeyInput = KeyObject | string | Uint8Array;

export interface ApprovalInput {
  readonly subject_hash: string;
  readonly decision: ApprovalDecision;
  readonly reason: string;
}

export type HumanApprovalInput = ApprovalInput;

export interface ApprovalPayload extends ApprovalInput {
  readonly nonce: string;
  readonly timestamp: string;
}

export interface SignedApproval extends ApprovalPayload {
  readonly signature: string;
}

export interface VerifiedApproval extends ApprovalPayload {
  readonly verified: true;
}

export interface HumanChannelStatus {
  readonly enrolled: boolean;
  readonly algorithm?: "Ed25519";
  /** SHA-256 of the enrolled public key's DER SubjectPublicKeyInfo bytes. */
  readonly publicKeyFingerprint?: string;
  readonly enrolledAt?: string;
  readonly replayedNonceCount: number;
  readonly replayStateLimit: number;
}

export type EnrollmentConfirmation =
  | true
  | { readonly confirm: true }
  | { readonly confirmed: true }
  | { readonly explicit: true };

export interface HumanChannelSignerObject {
  readonly sign: HumanChannelSigner;
}

/** The only state that may cross the Human Channel persistence boundary. */
export interface HumanChannelPersistedState {
  readonly schemaVersion: 1;
  readonly publicKeyDer: string;
  readonly publicKeyFingerprint: string;
  readonly enrolledAt: string;
  readonly usedNonces: readonly string[];
}

/** Synchronous by design: construction must restore state before use. */
export interface HumanChannelStateStore {
  readonly load: () => HumanChannelPersistedState | undefined;
  readonly save: (state: HumanChannelPersistedState) => void;
}

export interface HumanChannelOptions {
  /** The only operation allowed to use signing material is this injected seam. */
  readonly signer: HumanChannelSigner | HumanChannelSignerObject;
  readonly clock?: HumanChannelClock;
  readonly now?: HumanChannelClock;
  readonly nonce?: HumanChannelNonceGenerator;
  readonly nonceGenerator?: HumanChannelNonceGenerator;
  readonly randomBytes?: HumanChannelRandomBytes;
  readonly maxReplayNonces?: number;
  readonly stateStore?: HumanChannelStateStore;
}

export type HumanChannelErrorCode =
  | "HumanChannelValidationError"
  | "HumanChannelNotEnrolledError"
  | "HumanChannelEnrollmentConflictError"
  | "HumanChannelInvalidEvidenceError"
  | "HumanChannelReplayError"
  | "HumanChannelPersistenceError";

/** Base class for errors at the Human Channel boundary. Messages are static. */
export class HumanChannelError extends Error {
  readonly code: HumanChannelErrorCode;

  constructor(code: HumanChannelErrorCode, message: string) {
    super(message);
    this.name = code;
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class HumanChannelValidationError extends HumanChannelError {
  constructor(message = "Invalid Human Channel input") {
    super("HumanChannelValidationError", message);
  }
}

export class HumanChannelNotEnrolledError extends HumanChannelError {
  constructor() {
    super("HumanChannelNotEnrolledError", "The Human Channel has no enrolled device key");
  }
}

export class HumanChannelEnrollmentConflictError extends HumanChannelError {
  constructor() {
    super("HumanChannelEnrollmentConflictError", "The Human Channel already has a different enrolled device key");
  }
}

export class HumanChannelInvalidEvidenceError extends HumanChannelError {
  constructor() {
    super("HumanChannelInvalidEvidenceError", "The signed approval evidence is invalid");
  }
}

export class HumanChannelReplayError extends HumanChannelError {
  constructor() {
    super("HumanChannelReplayError", "The signed approval nonce has already been used");
  }
}

export class HumanChannelPersistenceError extends HumanChannelError {
  constructor() {
    super("HumanChannelPersistenceError", "The Human Channel persisted state is unavailable");
  }
}

// Short aliases make the typed boundary convenient without changing the safe
// error names or messages above.
export {
  HumanChannelValidationError as ApprovalValidationError,
  HumanChannelNotEnrolledError as NotEnrolledError,
  HumanChannelEnrollmentConflictError as EnrollmentConflictError,
  HumanChannelInvalidEvidenceError as InvalidSignatureError,
  HumanChannelReplayError as ReplayError,
};

interface NormalizedPublicKey {
  readonly key: KeyObject;
  readonly der: Buffer;
  readonly fingerprint: string;
}

interface RestoredHumanChannelState {
  readonly key: NormalizedPublicKey;
  readonly enrolledAt: string;
  readonly usedNonces: readonly string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function validateApprovalInput(value: unknown): ApprovalInput {
  if (!isPlainObject(value) || !hasExactKeys(value, APPROVAL_INPUT_KEYS)) {
    throw new HumanChannelValidationError("approval input must contain only its supported fields");
  }
  const subjectHash = value.subject_hash;
  if (typeof subjectHash !== "string" || !SUBJECT_HASH_PATTERN.test(subjectHash)) {
    throw new HumanChannelValidationError("subject_hash must be a lowercase SHA-256 hash");
  }

  const decision = value.decision;
  if (typeof decision !== "string" || !APPROVAL_DECISIONS.includes(decision as ApprovalDecision)) {
    throw new HumanChannelValidationError("approval decision is not supported");
  }

  const reason = value.reason;
  if (
    typeof reason !== "string"
    || reason.length === 0
    || reason.trim().length === 0
    || reason.includes("\u0000")
    || byteLength(reason) > MAX_APPROVAL_REASON_BYTES
  ) {
    throw new HumanChannelValidationError("approval reason is outside its supported bound");
  }

  return { subject_hash: subjectHash, decision: decision as ApprovalDecision, reason };
}

function validateNonce(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || byteLength(value) > MAX_APPROVAL_NONCE_BYTES
    || !NONCE_PATTERN.test(value)
  ) {
    throw new HumanChannelValidationError("approval nonce is outside its supported bound");
  }
  return value;
}

function validateTimestamp(value: unknown): string {
  if (typeof value !== "string" || !ISO_TIMESTAMP_PATTERN.test(value)) {
    throw new HumanChannelValidationError("approval timestamp must be canonical ISO-8601");
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new HumanChannelValidationError("approval timestamp must be canonical ISO-8601");
  }
  return value;
}

function validateApprovalPayload(value: unknown): ApprovalPayload {
  if (!isPlainObject(value) || !hasExactKeys(value, APPROVAL_PAYLOAD_KEYS)) {
    throw new HumanChannelValidationError("approval payload must contain only its supported fields");
  }
  const input = validateApprovalInput({
    subject_hash: value.subject_hash,
    decision: value.decision,
    reason: value.reason,
  });
  const nonce = validateNonce(value.nonce);
  const timestamp = validateTimestamp(value.timestamp);
  return { ...input, nonce, timestamp };
}

function validateSignature(value: unknown): string {
  if (typeof value !== "string" || !SIGNATURE_PATTERN.test(value)) {
    throw new HumanChannelValidationError("approval signature is outside its supported bound");
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, "base64url");
  } catch {
    throw new HumanChannelValidationError("approval signature is outside its supported bound");
  }
  if (
    decoded.length !== ED25519_SIGNATURE_BYTES
    || decoded.toString("base64url") !== value
  ) {
    throw new HumanChannelValidationError("approval signature is outside its supported bound");
  }
  return value;
}

function validateSignedApproval(value: unknown): SignedApproval {
  if (!isPlainObject(value) || !hasExactKeys(value, SIGNED_APPROVAL_KEYS)) {
    throw new HumanChannelValidationError("signed approval must contain only its supported fields");
  }
  const payload = validateApprovalPayload({
    subject_hash: value.subject_hash,
    decision: value.decision,
    reason: value.reason,
    nonce: value.nonce,
    timestamp: value.timestamp,
  });
  return { ...payload, signature: validateSignature(value.signature) };
}

function canonicalPayloadBytes(payload: ApprovalPayload): Buffer {
  // Fixed property order, no whitespace, and UTF-8 bytes make the signed
  // representation independent of caller object insertion order.
  return Buffer.from(JSON.stringify({
    subject_hash: payload.subject_hash,
    decision: payload.decision,
    reason: payload.reason,
    nonce: payload.nonce,
    timestamp: payload.timestamp,
  }), "utf8");
}

/** Return the exact UTF-8 bytes that are signed and verified. */
export function canonicalizeApprovalPayload(value: ApprovalPayload): Uint8Array {
  return canonicalPayloadBytes(validateApprovalPayload(value));
}

export function canonicalizeSignedApproval(value: SignedApproval): Uint8Array {
  const signed = validateSignedApproval(value);
  return canonicalPayloadBytes({
    subject_hash: signed.subject_hash,
    decision: signed.decision,
    reason: signed.reason,
    nonce: signed.nonce,
    timestamp: signed.timestamp,
  });
}

function normalizeClock(clock: HumanChannelClock): string {
  let value: Date | string | number;
  try {
    value = clock();
  } catch {
    throw new HumanChannelValidationError("Human Channel clock is unavailable");
  }

  const milliseconds = value instanceof Date
    ? value.getTime()
    : typeof value === "number"
      ? value
      : typeof value === "string"
        ? Date.parse(value)
        : Number.NaN;
  if (!Number.isFinite(milliseconds)) {
    throw new HumanChannelValidationError("Human Channel clock returned an invalid time");
  }
  let timestamp: string;
  try {
    timestamp = new Date(milliseconds).toISOString();
  } catch {
    throw new HumanChannelValidationError("Human Channel clock returned an invalid time");
  }
  return validateTimestamp(timestamp);
}

function normalizeNonceGenerator(
  generator: HumanChannelNonceGenerator,
): string {
  let value: string | Uint8Array;
  try {
    value = generator();
  } catch {
    throw new HumanChannelValidationError("Human Channel nonce generation is unavailable");
  }
  if (value instanceof Uint8Array) {
    if (value.byteLength === 0 || value.byteLength > MAX_APPROVAL_NONCE_BYTES) {
      throw new HumanChannelValidationError("approval nonce is outside its supported bound");
    }
    return validateNonce(Buffer.from(value).toString("base64url"));
  }
  return validateNonce(value);
}

function normalizePublicKey(input: unknown): NormalizedPublicKey {
  let key: KeyObject;
  try {
    if (typeof input === "string") {
      if (byteLength(input) > MAX_PUBLIC_KEY_BYTES) {
        throw new Error("oversized key input");
      }
      if (input.includes("PRIVATE KEY")) {
        throw new Error("private key input");
      }
      key = createPublicKey(input);
    } else if (input instanceof Uint8Array) {
      const der = Buffer.from(input);
      if (der.byteLength > MAX_PUBLIC_KEY_BYTES) {
        throw new Error("oversized key input");
      }
      // A private DER key is never accepted as an enrollment key. The result
      // of this probe is intentionally discarded and never appears in errors.
      try {
        createPrivateKey({ key: der, format: "der", type: "pkcs8" });
        throw new Error("private key input");
      } catch (error: unknown) {
        if (error instanceof Error && error.message === "private key input") throw error;
      }
      key = createPublicKey({ key: der, format: "der", type: "spki" });
    } else if (isKeyObject(input)) {
      if (input.type !== "public") throw new Error("non-public key input");
      // Node's createPublicKey accepts private KeyObjects to derive a public
      // key, but an enrolled device key must be supplied as public material.
      key = input;
    } else {
      throw new Error("unsupported key input");
    }
  } catch {
    throw new HumanChannelValidationError("enrollment requires an Ed25519 public key");
  }

  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") {
    throw new HumanChannelValidationError("enrollment requires an Ed25519 public key");
  }

  let der: Buffer;
  try {
    der = key.export({ type: "spki", format: "der" });
  } catch {
    throw new HumanChannelValidationError("enrollment requires an Ed25519 public key");
  }
  const fingerprint = createHash("sha256").update(der).digest("hex");
  return { key, der, fingerprint };
}

function isKeyObject(value: unknown): value is KeyObject {
  return value !== null
    && typeof value === "object"
    && typeof (value as { readonly type?: unknown }).type === "string"
    && typeof (value as { readonly asymmetricKeyType?: unknown }).asymmetricKeyType === "string"
    && typeof (value as { readonly export?: unknown }).export === "function";
}

function sameKey(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function isExplicitlyConfirmed(value: unknown): boolean {
  if (value === true) return true;
  if (!isPlainObject(value)) return false;
  return value.confirm === true || value.confirmed === true || value.explicit === true;
}

function validateReplayLimit(value: unknown): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 1
    || value > MAX_REPLAY_NONCES
  ) {
    throw new HumanChannelValidationError("replay state limit is outside its supported bound");
  }
  return value;
}

function decodeBase64url(value: unknown, maxBytes: number): Buffer {
  if (typeof value !== "string" || value.length === 0 || byteLength(value) > maxBytes * 2) {
    throw new Error("invalid base64url");
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, "base64url");
  } catch {
    throw new Error("invalid base64url");
  }
  if (decoded.length === 0 || decoded.length > maxBytes || decoded.toString("base64url") !== value) {
    throw new Error("invalid base64url");
  }
  return decoded;
}

function hasExpectedPersistedStateKeys(value: Record<string, unknown>): boolean {
  return hasExactKeys(value, [
    "schemaVersion",
    "publicKeyDer",
    "publicKeyFingerprint",
    "enrolledAt",
    "usedNonces",
  ]);
}

function normalizePersistedState(
  value: unknown,
  replayStateLimit: number,
): RestoredHumanChannelState {
  if (!isPlainObject(value) || !hasExpectedPersistedStateKeys(value)) throw new Error("invalid state");
  if (value.schemaVersion !== HUMAN_CHANNEL_STATE_SCHEMA_VERSION) throw new Error("invalid state");

  const der = decodeBase64url(value.publicKeyDer, MAX_PUBLIC_KEY_BYTES);
  const key = normalizePublicKey(der);
  if (
    typeof value.publicKeyFingerprint !== "string"
    || !SUBJECT_HASH_PATTERN.test(value.publicKeyFingerprint)
    || value.publicKeyFingerprint !== key.fingerprint
  ) {
    throw new Error("invalid state");
  }
  const enrolledAt = validateTimestamp(value.enrolledAt);
  if (!Array.isArray(value.usedNonces) || value.usedNonces.length > replayStateLimit) {
    throw new Error("invalid state");
  }
  const usedNonces: string[] = [];
  const seen = new Set<string>();
  for (const nonce of value.usedNonces) {
    const normalized = validateNonce(nonce);
    if (seen.has(normalized)) throw new Error("invalid state");
    seen.add(normalized);
    usedNonces.push(normalized);
  }
  if (!sameKey(key.der, der)) throw new Error("invalid state");
  return { key, enrolledAt, usedNonces: Object.freeze(usedNonces) };
}

function persistedState(
  key: NormalizedPublicKey,
  enrolledAt: string,
  usedNonces: Iterable<string>,
): HumanChannelPersistedState {
  return Object.freeze({
    schemaVersion: HUMAN_CHANNEL_STATE_SCHEMA_VERSION,
    publicKeyDer: key.der.toString("base64url"),
    publicKeyFingerprint: key.fingerprint,
    enrolledAt,
    usedNonces: Object.freeze([...usedNonces]),
  });
}

function serializePersistedState(state: HumanChannelPersistedState): string {
  // Validate before serializing so this class cannot be used to write an
  // expanded or otherwise unsafe shape through the production store.
  normalizePersistedState(state, MAX_REPLAY_NONCES);
  const serialized = JSON.stringify({
    schemaVersion: state.schemaVersion,
    publicKeyDer: state.publicKeyDer,
    publicKeyFingerprint: state.publicKeyFingerprint,
    enrolledAt: state.enrolledAt,
    usedNonces: [...state.usedNonces],
  });
  if (byteLength(serialized) > MAX_HUMAN_CHANNEL_STATE_BYTES) throw new Error("state is oversized");
  return serialized;
}

function validateStatePath(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.includes("\u0000")
    || byteLength(value) > MAX_HUMAN_CHANNEL_STATE_PATH_BYTES
  ) {
    throw new HumanChannelPersistenceError();
  }
  return value;
}

function persistenceFailure(): never {
  throw new HumanChannelPersistenceError();
}

/** Bounded, canonical JSON persistence backed only by Node built-ins. */
export class JsonFileHumanChannelStateStore implements HumanChannelStateStore {
  private readonly statePath: string;

  constructor(path: string) {
    this.statePath = validateStatePath(path);
    try {
      mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 });
      this.rejectNonRegularStateFile();
    } catch {
      persistenceFailure();
    }
  }

  load(): HumanChannelPersistedState | undefined {
    try {
      this.rejectNonRegularStateFile();
      let stats;
      try {
        stats = lstatSync(this.statePath);
      } catch (error: unknown) {
        if (isMissingFileError(error)) return undefined;
        throw error;
      }
      if (stats.size > MAX_HUMAN_CHANNEL_STATE_BYTES) throw new Error("state is oversized");
      const bytes = readFileSync(this.statePath);
      if (bytes.byteLength > MAX_HUMAN_CHANNEL_STATE_BYTES) throw new Error("state is oversized");
      const parsed: unknown = JSON.parse(bytes.toString("utf8"));
      normalizePersistedState(parsed, MAX_REPLAY_NONCES);
      return parsed as HumanChannelPersistedState;
    } catch {
      persistenceFailure();
    }
  }

  save(state: HumanChannelPersistedState): void {
    let serialized: string;
    try {
      serialized = serializePersistedState(state);
      mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 });
      this.rejectNonRegularStateFile();
    } catch {
      persistenceFailure();
    }

    let temporaryPath: string | undefined;
    try {
      temporaryPath = join(
        dirname(this.statePath),
        `.${basename(this.statePath)}.tmp-${nodeRandomBytes(16).toString("hex")}`,
      );
      writeFileSync(temporaryPath, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
      chmodSync(temporaryPath, 0o600);
      const descriptor = openSync(temporaryPath, "r+");
      try {
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      renameSync(temporaryPath, this.statePath);
    } catch {
      try {
        if (temporaryPath !== undefined) unlinkSync(temporaryPath);
      } catch {
        // Cleanup is best effort; the public error remains static.
      }
      persistenceFailure();
    }
  }

  private rejectNonRegularStateFile(): void {
    try {
      const stats = lstatSync(this.statePath);
      if (!stats.isFile()) throw new Error("state path is not regular");
    } catch (error: unknown) {
      if (isMissingFileError(error)) return;
      throw error;
    }
  }
}

function isMissingFileError(error: unknown): boolean {
  return error !== null
    && typeof error === "object"
    && (error as { readonly code?: unknown }).code === "ENOENT";
}

function defaultRandomBytes(size: number): Uint8Array {
  return nodeRandomBytes(size);
}

/**
 * Human Channel boundary. It has no session/token API, policy evaluator, GUI,
 * keychain, socket, or automatic approval path; persistence is opt-in and
 * stores only public enrollment and replay metadata.
 */
export class HumanChannel {
  private readonly signer: HumanChannelSigner | HumanChannelSignerObject;
  private readonly clock: HumanChannelClock;
  private readonly nonceGenerator: HumanChannelNonceGenerator | undefined;
  private readonly randomBytes: HumanChannelRandomBytes;
  private readonly replayStateLimit: number;
  private readonly stateStore: HumanChannelStateStore | undefined;
  private readonly replayedNonces = new Set<string>();
  private enrolledKey: NormalizedPublicKey | undefined;
  private enrolledAt: string | undefined;

  constructor(options: HumanChannelOptions) {
    if (!isPlainObject(options)) {
      throw new HumanChannelValidationError("Human Channel options must be an object");
    }
    if (
      (typeof options.signer !== "function")
      && (!isPlainObject(options.signer) || typeof options.signer.sign !== "function")
    ) {
      throw new HumanChannelValidationError("Human Channel requires an injected signer");
    }
    if (options.clock !== undefined && options.now !== undefined) {
      throw new HumanChannelValidationError("configure clock or now, not both");
    }
    if (options.nonce !== undefined && options.nonceGenerator !== undefined) {
      throw new HumanChannelValidationError("configure nonce or nonceGenerator, not both");
    }
    if (options.nonce !== undefined && typeof options.nonce !== "function") {
      throw new HumanChannelValidationError("nonce generator is invalid");
    }
    if (options.nonceGenerator !== undefined && typeof options.nonceGenerator !== "function") {
      throw new HumanChannelValidationError("nonce generator is invalid");
    }
    if (options.randomBytes !== undefined && typeof options.randomBytes !== "function") {
      throw new HumanChannelValidationError("random-byte source is invalid");
    }
    if (
      options.stateStore !== undefined
      && (options.stateStore === null
        || typeof options.stateStore !== "object"
        || typeof options.stateStore.load !== "function"
        || typeof options.stateStore.save !== "function")
    ) {
      throw new HumanChannelValidationError("Human Channel state store is invalid");
    }

    this.signer = options.signer;
    this.clock = options.clock ?? options.now ?? (() => new Date());
    this.nonceGenerator = options.nonce ?? options.nonceGenerator;
    this.randomBytes = options.randomBytes ?? defaultRandomBytes;
    this.replayStateLimit = options.maxReplayNonces === undefined
      ? MAX_REPLAY_NONCES
      : validateReplayLimit(options.maxReplayNonces);
    this.stateStore = options.stateStore;
    this.restorePersistedState();
  }

  /** Enroll the first Ed25519 public key, requiring an explicit confirmation. */
  enrollPublicKey(
    publicKey: PublicKeyInput,
    confirmation?: EnrollmentConfirmation,
  ): HumanChannelStatus {
    const candidate = normalizePublicKey(publicKey);
    if (this.enrolledKey !== undefined) {
      if (!sameKey(this.enrolledKey.der, candidate.der)) {
        throw new HumanChannelEnrollmentConflictError();
      }
      return this.status();
    }
    if (!isExplicitlyConfirmed(confirmation)) {
      throw new HumanChannelValidationError("explicit enrollment confirmation is required");
    }

    // Normalize all enrollment state before publishing it, so a broken clock
    // cannot leave a half-enrolled channel behind.
    const enrolledAt = normalizeClock(this.clock);
    this.savePersistedState(candidate, enrolledAt, []);
    this.enrolledKey = candidate;
    this.enrolledAt = enrolledAt;
    return this.status();
  }

  enroll(publicKey: PublicKeyInput, confirmation?: EnrollmentConfirmation): HumanChannelStatus {
    return this.enrollPublicKey(publicKey, confirmation);
  }

  /** Return only enrollment identity and bounded replay counters. */
  status(): HumanChannelStatus {
    const replayedNonceCount = this.replayedNonces.size;
    if (this.enrolledKey === undefined || this.enrolledAt === undefined) {
      return Object.freeze({
        enrolled: false,
        replayedNonceCount,
        replayStateLimit: this.replayStateLimit,
      });
    }
    return Object.freeze({
      enrolled: true,
      algorithm: "Ed25519" as const,
      publicKeyFingerprint: this.enrolledKey.fingerprint,
      enrolledAt: this.enrolledAt,
      replayedNonceCount,
      replayStateLimit: this.replayStateLimit,
    });
  }

  enrollmentStatus(): HumanChannelStatus {
    return this.status();
  }

  getStatus(): HumanChannelStatus {
    return this.status();
  }

  signApproval(input: ApprovalInput): SignedApproval {
    this.requireEnrollment();
    const normalizedInput = validateApprovalInput(input);
    const timestamp = normalizeClock(this.clock);
    const nonce = this.nonceGenerator === undefined
      ? this.generateRandomNonce()
      : normalizeNonceGenerator(this.nonceGenerator);
    const payload: ApprovalPayload = { ...normalizedInput, nonce, timestamp };
    const bytes = canonicalPayloadBytes(payload);

    let signature: Uint8Array;
    try {
      signature = typeof this.signer === "function"
        ? this.signer(Uint8Array.from(bytes))
        : this.signer.sign(Uint8Array.from(bytes));
    } catch {
      throw new HumanChannelValidationError("approval signer failed");
    }
    if (!(signature instanceof Uint8Array) || signature.byteLength !== ED25519_SIGNATURE_BYTES) {
      throw new HumanChannelValidationError("approval signer returned an invalid signature");
    }

    return Object.freeze({
      ...payload,
      signature: Buffer.from(signature).toString("base64url"),
    });
  }

  sign(input: ApprovalInput): SignedApproval {
    return this.signApproval(input);
  }

  verifySignedApproval(value: SignedApproval): VerifiedApproval {
    const enrolled = this.requireEnrollment();
    let approval: SignedApproval;
    try {
      approval = validateSignedApproval(value);
    } catch {
      throw new HumanChannelInvalidEvidenceError();
    }

    const payload: ApprovalPayload = {
      subject_hash: approval.subject_hash,
      decision: approval.decision,
      reason: approval.reason,
      nonce: approval.nonce,
      timestamp: approval.timestamp,
    };
    const bytes = canonicalPayloadBytes(payload);
    let signature: Buffer;
    try {
      signature = Buffer.from(approval.signature, "base64url");
    } catch {
      throw new HumanChannelInvalidEvidenceError();
    }

    let valid = false;
    try {
      valid = nodeVerify(null, bytes, enrolled.key, signature);
    } catch {
      throw new HumanChannelInvalidEvidenceError();
    }
    if (!valid) throw new HumanChannelInvalidEvidenceError();
    if (this.replayedNonces.has(approval.nonce)) throw new HumanChannelReplayError();
    if (this.replayedNonces.size >= this.replayStateLimit) {
      throw new HumanChannelValidationError("replay state limit has been reached");
    }
    this.replayedNonces.add(approval.nonce);
    try {
      this.savePersistedState(enrolled, this.enrolledAt as string, this.replayedNonces);
    } catch (error: unknown) {
      // The nonce is deliberately retained in memory even when persistence
      // fails, preventing a retry in this process.
      throw error;
    }

    return Object.freeze({ ...payload, verified: true as const });
  }

  verify(value: SignedApproval): VerifiedApproval {
    return this.verifySignedApproval(value);
  }

  private requireEnrollment(): NormalizedPublicKey {
    if (this.enrolledKey === undefined) throw new HumanChannelNotEnrolledError();
    return this.enrolledKey;
  }

  private restorePersistedState(): void {
    if (this.stateStore === undefined) return;
    let persisted: HumanChannelPersistedState | undefined;
    try {
      persisted = this.stateStore.load();
    } catch {
      persistenceFailure();
    }
    if (persisted === undefined) return;

    let restored: RestoredHumanChannelState;
    try {
      restored = normalizePersistedState(persisted, this.replayStateLimit);
    } catch {
      persistenceFailure();
    }
    this.enrolledKey = restored.key;
    this.enrolledAt = restored.enrolledAt;
    for (const nonce of restored.usedNonces) this.replayedNonces.add(nonce);
  }

  private savePersistedState(
    key: NormalizedPublicKey,
    enrolledAt: string,
    usedNonces: Iterable<string>,
  ): void {
    if (this.stateStore === undefined) return;
    const state = persistedState(key, enrolledAt, usedNonces);
    try {
      this.stateStore.save(state);
    } catch {
      persistenceFailure();
    }
  }

  private generateRandomNonce(): string {
    let bytes: Uint8Array;
    try {
      bytes = this.randomBytes(APPROVAL_NONCE_RANDOM_BYTES);
    } catch {
      throw new HumanChannelValidationError("Human Channel nonce generation is unavailable");
    }
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== APPROVAL_NONCE_RANDOM_BYTES) {
      throw new HumanChannelValidationError("Human Channel nonce generation returned invalid bytes");
    }
    return normalizeNonceGenerator(() => bytes);
  }
}

export const HumanApprovalChannel = HumanChannel;
