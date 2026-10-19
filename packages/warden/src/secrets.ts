import { randomBytes as nodeRandomBytes } from "node:crypto";

/** Maximum UTF-8 encoded size of a metadata name. */
export const MAX_SECRET_NAME_BYTES = 256;
/** Maximum UTF-8 encoded size of one secret value. */
export const MAX_SECRET_VALUE_BYTES = 64 * 1024;
/** Maximum UTF-8 encoded size of text accepted by the redactor. */
export const MAX_REDACTION_TEXT_BYTES = 256 * 1024;
/** Maximum number of values held by one redaction registry. */
export const MAX_REGISTERED_SECRETS = 256;

const MAX_REDACTION_MATCHES = 1_000_000;
const SECRET_LIKE_NAME = /(?:-----BEGIN[\s\S]*PRIVATE KEY-----|\b(?:sk|rk|pk|ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9][A-Za-z0-9._-]{11,}|\bAKIA[0-9A-Z]{16}\b|\bBearer\s+[A-Za-z0-9._~+/=-]{12,})/i;
const REPLACEMENT_CANDIDATES = [
  "[REDACTED]",
  "[REDACTED_SECRET]",
  "<redacted>",
  "[REMOVED]",
  "",
] as const;

/** An opaque handle returned by an in-memory secret store. */
export type SecretReference = string & { readonly __secretReference: "opaque" };
export type SecretRef = SecretReference;

export type SecretClock = () => Date | string | number;
export type SecretRandomBytes = (size: number) => Uint8Array;

export interface SecretMetadata {
  readonly ref: SecretReference;
  readonly name: string;
  readonly createdAt: string;
}

export interface InMemorySecretStoreOptions {
  /** Clock seam. Values are normalized to immutable ISO strings in metadata. */
  readonly now?: SecretClock;
  /** Alias for `now`, useful for callers that name the seam a clock. */
  readonly clock?: SecretClock;
  /** Randomness seam used only to create opaque references. */
  readonly randomBytes?: SecretRandomBytes;
  /** Optional smaller upper bound for names in embedding/test configurations. */
  readonly maxNameBytes?: number;
  /** Optional smaller upper bound for values in embedding/test configurations. */
  readonly maxValueBytes?: number;
}

export interface RedactionRegistryOptions {
  readonly maxSecretBytes?: number;
  readonly maxTextBytes?: number;
  readonly maxSecrets?: number;
}

export type SecretErrorCode =
  | "SecretValidationError"
  | "SecretReferenceError"
  | "SecretStoreError"
  | "RedactionError";

/** Errors intentionally contain only static field names and bounds. */
export class SecretError extends Error {
  readonly code: SecretErrorCode;

  constructor(code: SecretErrorCode, message: string) {
    super(message);
    this.name = code;
    this.code = code;
  }
}

export class SecretValidationError extends SecretError {
  constructor(message: string) {
    super("SecretValidationError", message);
  }
}

export class SecretReferenceError extends SecretError {
  constructor(message: string) {
    super("SecretReferenceError", message);
  }
}

export class SecretStoreError extends SecretError {
  constructor(message: string) {
    super("SecretStoreError", message);
  }
}

export class RedactionError extends SecretError {
  constructor(message: string) {
    super("RedactionError", message);
  }
}

interface StoredSecret {
  readonly name: string;
  readonly value: string;
  readonly createdAt: string;
}

interface RedactionMatch {
  readonly start: number;
  readonly end: number;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function validateLimit(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > fallback) {
    throw new SecretValidationError(`${field} bound is invalid`);
  }
  return value;
}

function validateText(
  value: unknown,
  field: "secret name" | "secret value" | "redaction text",
  limit: number,
  requireNonEmpty: boolean,
  rejectNul: boolean,
): string {
  if (typeof value !== "string") {
    throw new SecretValidationError(`${field} must be a string`);
  }
  if (requireNonEmpty && value.length === 0) {
    throw new SecretValidationError(`${field} may not be empty`);
  }
  if (rejectNul && value.includes("\u0000")) {
    throw new SecretValidationError(`${field} may not contain a NUL character`);
  }
  if (byteLength(value) > limit) {
    throw new SecretValidationError(`${field} exceeds ${limit} UTF-8 bytes`);
  }
  return value;
}

function validateSecretName(value: unknown, limit: number): string {
  const name = validateText(value, "secret name", limit, true, true);
  if (name.trim().length === 0) {
    throw new SecretValidationError("secret name may not be blank");
  }
  if (SECRET_LIKE_NAME.test(name)) {
    throw new SecretValidationError("secret name looks like a secret value");
  }
  return name;
}

function timestamp(clock: SecretClock): string {
  let candidate: Date | string | number;
  try {
    candidate = clock();
  } catch {
    throw new SecretStoreError("secret store clock is unavailable");
  }

  const milliseconds = candidate instanceof Date
    ? candidate.getTime()
    : typeof candidate === "number"
      ? candidate
      : typeof candidate === "string"
        ? Date.parse(candidate)
        : Number.NaN;
  if (!Number.isFinite(milliseconds)) {
    throw new SecretStoreError("secret store clock returned an invalid timestamp");
  }
  return new Date(milliseconds).toISOString();
}

function defaultRandomBytes(size: number): Uint8Array {
  return nodeRandomBytes(size);
}

function isReferenceInput(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\u0000");
}

/**
 * A process-local secret holder. It intentionally has no persistence, OS
 * integration, logging, serialization, or network behavior.
 */
export class InMemorySecretStore {
  private readonly records = new Map<SecretReference, StoredSecret>();
  private readonly clock: SecretClock;
  private readonly randomBytes: SecretRandomBytes;
  private readonly maxNameBytes: number;
  private readonly maxValueBytes: number;

  constructor(options: InMemorySecretStoreOptions = {}) {
    this.clock = options.now ?? options.clock ?? (() => new Date());
    this.randomBytes = options.randomBytes ?? defaultRandomBytes;
    this.maxNameBytes = validateLimit(options.maxNameBytes, MAX_SECRET_NAME_BYTES, "secret name");
    this.maxValueBytes = validateLimit(options.maxValueBytes, MAX_SECRET_VALUE_BYTES, "secret value");
  }

  /** Store an exact value and return only a new opaque reference. */
  set(name: string, value: string): SecretReference {
    const safeName = validateSecretName(name, this.maxNameBytes);
    const safeValue = validateText(value, "secret value", this.maxValueBytes, true, true);
    // A metadata name equal to its value would make list() disclose the value.
    if (safeName === safeValue) {
      throw new SecretValidationError("secret name may not equal its secret value");
    }

    const ref = this.createReference();
    const createdAt = timestamp(this.clock);
    this.records.set(ref, { name: safeName, value: safeValue, createdAt });
    return ref;
  }

  /** Resolve a reference for an internal consumer; unknown refs resolve safely to undefined. */
  resolve(ref: SecretReference | string): string | undefined {
    if (!isReferenceInput(ref)) return undefined;
    return this.records.get(ref as SecretReference)?.value;
  }

  /** Delete a reference without returning, logging, or exposing its value. */
  delete(ref: SecretReference | string): boolean {
    if (!isReferenceInput(ref)) return false;
    return this.records.delete(ref as SecretReference);
  }

  /** Return fresh, immutable metadata objects with no secret values. */
  list(): readonly SecretMetadata[] {
    const metadata = [...this.records.entries()].map(([ref, record]) =>
      Object.freeze({
        ref,
        name: record.name,
        createdAt: record.createdAt,
      }),
    );
    return Object.freeze(metadata);
  }

  get size(): number {
    return this.records.size;
  }

  private createReference(): SecretReference {
    let bytes: Uint8Array;
    try {
      bytes = this.randomBytes(32);
    } catch {
      throw new SecretStoreError("secret store randomness is unavailable");
    }
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
      throw new SecretStoreError("secret store randomness returned invalid bytes");
    }

    const encoded = Buffer.from(bytes).toString("base64url");
    let candidate = `sec_${encoded}`;
    let collision = 0;
    while (this.records.has(candidate as SecretReference)) {
      collision += 1;
      candidate = `sec_${encoded}_${collision.toString(36)}`;
    }
    return candidate as SecretReference;
  }
}

/**
 * In-memory value redaction for bounded text. Matches are selected by start
 * position and longest value first, so repeated and overlapping values cannot
 * leave the shorter/overlapping secret visible.
 */
export class RedactionRegistry {
  private readonly secrets = new Set<string>();
  private readonly maxSecretBytes: number;
  private readonly maxTextBytes: number;
  private readonly maxSecrets: number;

  constructor(options: RedactionRegistryOptions = {}) {
    this.maxSecretBytes = validateLimit(options.maxSecretBytes, MAX_SECRET_VALUE_BYTES, "secret value");
    this.maxTextBytes = validateLimit(options.maxTextBytes, MAX_REDACTION_TEXT_BYTES, "redaction text");
    this.maxSecrets = validateLimit(options.maxSecrets, MAX_REGISTERED_SECRETS, "redaction registry");
  }

  /** Register an exact value without returning or retaining caller-visible metadata for it. */
  register(value: string): void {
    const candidateValue = validateText(value, "secret value", this.maxSecretBytes, true, true);
    if (!this.secrets.has(candidateValue) && this.secrets.size >= this.maxSecrets) {
      throw new RedactionError("redaction registry is full");
    }
    this.secrets.add(candidateValue);
  }

  registerSecret(value: string): void {
    this.register(value);
  }

  get size(): number {
    return this.secrets.size;
  }

  redact(text: string): string {
    const input = validateText(text, "redaction text", this.maxTextBytes, false, false);
    if (input.length === 0 || this.secrets.size === 0) return input;

    const matches: RedactionMatch[] = [];
    for (const secret of this.secrets) {
      let offset = 0;
      while (offset <= input.length - secret.length) {
        const start = input.indexOf(secret, offset);
        if (start < 0) break;
        matches.push({ start, end: start + secret.length });
        if (matches.length > MAX_REDACTION_MATCHES) {
          throw new RedactionError("redaction text contains too many secret matches");
        }
        // Advance one code unit so same-value overlaps are also considered.
        offset = start + 1;
      }
    }
    if (matches.length === 0) return input;

    matches.sort((left, right) =>
      left.start - right.start ||
      right.end - left.end,
    );
    const replacement = this.safeReplacement();
    let output = "";
    let cursor = 0;
    for (const match of matches) {
      if (match.start < cursor) continue;
      output += input.slice(cursor, match.start);
      output += replacement;
      cursor = match.end;
    }
    return output + input.slice(cursor);
  }

  redactText(text: string): string {
    return this.redact(text);
  }

  private safeReplacement(): string {
    for (const candidate of REPLACEMENT_CANDIDATES) {
      if (![...this.secrets].some((secret) => candidate.includes(secret))) {
        return candidate;
      }
    }
    return "";
  }
}
