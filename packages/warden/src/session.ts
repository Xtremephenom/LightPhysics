import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import {
  AGENT_LIKE_SESSION_KINDS,
  ApprovalRequiredError,
  BudgetCircuitBreaker,
  DEFAULT_BUDGET_LIMIT,
  PermissionDeniedError,
  PERMISSION_CLASSES,
  WardenPolicy,
  type BudgetSnapshot,
  type PermissionClass,
  type PolicyDecision,
  type PolicyOptions,
  type SessionKind,
  SessionExpiredError,
  SessionRevokedError,
  UnauthorizedError,
  WardenError,
  WardenValidationError,
  isPermissionClass,
  isSessionKind,
} from "./policy.ts";

export const DEFAULT_SESSION_TTL_MS = 15 * 60 * 1_000;
export const MIN_SESSION_TTL_MS = 1_000;
export const MAX_SESSION_TTL_MS = 24 * 60 * 60 * 1_000;
export const MAX_SESSION_IDENTIFIER_BYTES = 128;
export const MAX_ROLE_BYTES = 64;
export const MAX_ROLES = 32;
export const MAX_SESSIONS = 1_024;
export const TOKEN_RANDOM_BYTES = 32;
export const MAX_TOKEN_BYTES = 128;
export const MAX_SPEND_ESTIMATE = 1_000_000_000;

export type WardenClock = () => Date | number;
export type WardenRandomBytes = (size: number) => Uint8Array;

export interface CreateSessionInput {
  readonly kind: SessionKind;
  readonly project?: string;
  readonly roles?: readonly string[];
  readonly permissions?: readonly PermissionClass[];
  readonly allowedPermissions?: readonly PermissionClass[];
  /** Alias kept for callers that use the longer vocabulary. */
  readonly allowedPermissionClasses?: readonly PermissionClass[];
  readonly ttlMs?: number;
}

export interface SessionView {
  readonly id: string;
  readonly kind: SessionKind;
  readonly project?: string;
  readonly roles: readonly string[];
  readonly allowedPermissions: readonly PermissionClass[];
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revokedAt?: string;
}

export interface CreatedSession {
  /** The bearer token is intentionally returned only at creation time. */
  readonly token: string;
  readonly session: SessionView;
  readonly sessionId: string;
}

export interface AuthorizationRequest {
  readonly permission: PermissionClass;
  readonly project?: string;
  readonly spendEstimate?: number;
  readonly estimatedSpend?: number;
}

export interface AuthorizationRequestWithToken extends AuthorizationRequest {
  readonly token: string;
}

export interface SessionManagerOptions {
  readonly policy?: WardenPolicy | PolicyOptions;
  readonly clock?: WardenClock;
  readonly randomBytes?: WardenRandomBytes;
  readonly defaultTtlMs?: number;
  readonly maxSessions?: number;
  readonly budget?: BudgetCircuitBreaker | { readonly limit: number };
  readonly budgetLimit?: number;
}

interface SessionRecord {
  readonly id: string;
  readonly kind: SessionKind;
  readonly project: string | undefined;
  readonly roles: readonly string[];
  readonly allowedPermissions: readonly PermissionClass[];
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly tokenDigest: string;
  revokedAtMs: number | undefined;
}

const permissionSet = new Set<string>(PERMISSION_CLASSES);
const agentLikeSessionKindSet = new Set<string>(AGENT_LIKE_SESSION_KINDS);
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const rolePattern = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,63}$/;
const controlCharacterPattern = /[\u0000-\u001F\u007F]/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function validateIdentifier(
  value: unknown,
  field: string,
  maximumBytes = MAX_SESSION_IDENTIFIER_BYTES,
): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || byteLength(value) > maximumBytes
    || controlCharacterPattern.test(value)
    || !identifierPattern.test(value)
  ) {
    throw new WardenValidationError(`${field} is outside its supported bound`);
  }
  return value;
}

function validateRole(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || byteLength(value) > MAX_ROLE_BYTES
    || controlCharacterPattern.test(value)
    || !rolePattern.test(value)
  ) {
    throw new WardenValidationError("role is outside its supported bound");
  }
  return value;
}

function validatePositiveInteger(value: unknown, field: string, maximum: number): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 1
    || value > maximum
  ) {
    throw new WardenValidationError(`${field} is outside its supported bound`);
  }
  return value;
}

function validateTtl(value: unknown, field = "session ttlMs"): number {
  return validatePositiveInteger(value, field, MAX_SESSION_TTL_MS);
}

function clockMilliseconds(clock: WardenClock): number {
  const value = clock();
  const milliseconds = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(milliseconds) || !Number.isSafeInteger(milliseconds)) {
    throw new WardenValidationError("clock must return a valid finite time");
  }
  if (milliseconds < -8_640_000_000_000_000 || milliseconds > 8_640_000_000_000_000) {
    throw new WardenValidationError("clock returned a time outside its supported bound");
  }
  return milliseconds;
}

function isoTime(milliseconds: number): string {
  const date = new Date(milliseconds);
  if (!Number.isFinite(date.getTime())) throw new WardenValidationError("clock returned an invalid time");
  return date.toISOString();
}

function normalizeRoles(value: unknown): readonly string[] {
  if (value === undefined) return Object.freeze([] as string[]);
  if (!Array.isArray(value) || value.length > MAX_ROLES) {
    throw new WardenValidationError("roles exceed their supported bound");
  }
  const roles: string[] = [];
  const seen = new Set<string>();
  for (const roleValue of value) {
    const role = validateRole(roleValue);
    if (seen.has(role)) throw new WardenValidationError("roles must not contain duplicates");
    seen.add(role);
    roles.push(role);
  }
  return Object.freeze(roles);
}

function normalizePermissions(
  input: CreateSessionInput,
): readonly PermissionClass[] {
  const candidates = [
    input.permissions,
    input.allowedPermissions,
    input.allowedPermissionClasses,
  ].filter((value): value is readonly PermissionClass[] => value !== undefined);
  if (candidates.length > 1) {
    throw new WardenValidationError("use only one allowed permission list");
  }
  const value = candidates[0] ?? [];
  if (!Array.isArray(value) || value.length > PERMISSION_CLASSES.length) {
    throw new WardenValidationError("allowed permissions exceed their supported bound");
  }
  const permissions: PermissionClass[] = [];
  const seen = new Set<string>();
  for (const permissionValue of value) {
    if (!isPermissionClass(permissionValue) || !permissionSet.has(permissionValue)) {
      throw new WardenValidationError("allowed permissions contain an unsupported class");
    }
    if (seen.has(permissionValue)) throw new WardenValidationError("allowed permissions must not contain duplicates");
    seen.add(permissionValue);
    permissions.push(permissionValue);
  }
  return Object.freeze(permissions);
}

function normalizeEstimate(request: AuthorizationRequest): number {
  const candidates = [request.spendEstimate, request.estimatedSpend]
    .filter((value): value is number => value !== undefined);
  if (candidates.length > 1) {
    throw new WardenValidationError("use only one spend estimate");
  }
  const estimate = candidates[0] ?? 0;
  if (
    typeof estimate !== "number"
    || !Number.isFinite(estimate)
    || estimate < 0
    || estimate > MAX_SPEND_ESTIMATE
  ) {
    throw new WardenValidationError("spend estimate is outside its supported bound");
  }
  return estimate;
}

function digestToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function defaultClock(): Date {
  return new Date();
}

function defaultRandomBytes(size: number): Uint8Array {
  return nodeRandomBytes(size);
}

function genericCredentialError(): WardenError {
  return new UnauthorizedError();
}

function viewOf(record: SessionRecord): SessionView {
  return Object.freeze({
    id: record.id,
    kind: record.kind,
    ...(record.project === undefined ? {} : { project: record.project }),
    roles: record.roles,
    allowedPermissions: record.allowedPermissions,
    createdAt: isoTime(record.createdAtMs),
    expiresAt: isoTime(record.expiresAtMs),
    ...(record.revokedAtMs === undefined ? {} : { revokedAt: isoTime(record.revokedAtMs) }),
  });
}

/** Offline in-memory session store and authorization boundary. */
export class WardenSessionManager {
  private readonly policy: WardenPolicy;
  private readonly clock: WardenClock;
  private readonly randomBytes: WardenRandomBytes;
  private readonly defaultTtlMs: number;
  private readonly maxSessions: number;
  readonly budget: BudgetCircuitBreaker;
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly tokens = new Map<string, SessionRecord>();
  private nextSessionNumber = 1;

  constructor(options: SessionManagerOptions = {}) {
    if (!isPlainObject(options)) throw new WardenValidationError("session manager options must be an object");
    const candidate = options as SessionManagerOptions;
    this.policy = candidate.policy instanceof WardenPolicy
      ? candidate.policy
      : new WardenPolicy(candidate.policy ?? {});
    this.clock = candidate.clock ?? defaultClock;
    this.randomBytes = candidate.randomBytes ?? defaultRandomBytes;
    this.defaultTtlMs = candidate.defaultTtlMs === undefined
      ? DEFAULT_SESSION_TTL_MS
      : validateTtl(candidate.defaultTtlMs, "default session ttlMs");
    this.maxSessions = candidate.maxSessions === undefined
      ? MAX_SESSIONS
      : validatePositiveInteger(candidate.maxSessions, "maxSessions", MAX_SESSIONS);

    if (candidate.budget !== undefined && candidate.budgetLimit !== undefined) {
      throw new WardenValidationError("configure budget or budgetLimit, not both");
    }
    if (candidate.budget instanceof BudgetCircuitBreaker) {
      this.budget = candidate.budget;
    } else if (candidate.budget !== undefined) {
      this.budget = new BudgetCircuitBreaker(candidate.budget);
    } else {
      this.budget = new BudgetCircuitBreaker(candidate.budgetLimit ?? DEFAULT_BUDGET_LIMIT);
    }
  }

  createSession(input: CreateSessionInput): CreatedSession {
    if (!isPlainObject(input)) throw new WardenValidationError("session input must be an object");
    if (!isSessionKind(input.kind)) throw new WardenValidationError("session kind is not supported");
    const project = input.project === undefined
      ? undefined
      : validateIdentifier(input.project, "project");
    const roles = normalizeRoles(input.roles);
    const allowedPermissions = normalizePermissions(input);
    const ttlMs = input.ttlMs === undefined ? this.defaultTtlMs : validateTtl(input.ttlMs);
    const createdAtMs = clockMilliseconds(this.clock);
    const expiresAtMs = createdAtMs + ttlMs;
    if (!Number.isSafeInteger(expiresAtMs)) throw new WardenValidationError("session expiry is outside its supported bound");

    this.removeStaleSessions();
    if (this.sessions.size >= this.maxSessions) {
      throw new WardenValidationError("the in-memory session limit has been reached");
    }

    const id = this.newSessionId();
    const generated = this.newToken();
    const record: SessionRecord = {
      id,
      kind: input.kind,
      project,
      roles,
      allowedPermissions,
      createdAtMs,
      expiresAtMs,
      tokenDigest: generated.digest,
      revokedAtMs: undefined,
    };
    this.sessions.set(id, record);
    this.tokens.set(generated.digest, record);
    const session = viewOf(record);
    return Object.freeze({ token: generated.token, session, sessionId: id });
  }

  create(input: CreateSessionInput): CreatedSession {
    return this.createSession(input);
  }

  validateToken(token: string): SessionView {
    const record = this.findByToken(token);
    this.assertLive(record);
    return viewOf(record);
  }

  /** Validate either a session id or a bearer token without returning secrets. */
  validateSession(sessionIdOrToken: string): SessionView {
    const byId = typeof sessionIdOrToken === "string"
      ? this.sessions.get(sessionIdOrToken)
      : undefined;
    const record = byId ?? this.findByToken(sessionIdOrToken);
    this.assertLive(record);
    return viewOf(record);
  }

  getSession(sessionId: string): SessionView | undefined {
    if (typeof sessionId !== "string") return undefined;
    const record = this.sessions.get(sessionId);
    return record === undefined ? undefined : viewOf(record);
  }

  listSessions(): readonly SessionView[] {
    return Object.freeze([...this.sessions.values()].map(viewOf));
  }

  revokeSession(sessionId: string): boolean {
    if (typeof sessionId !== "string") throw new WardenValidationError("session id is outside its supported bound");
    const record = this.sessions.get(sessionId);
    if (record === undefined) throw genericCredentialError();
    return this.revokeRecord(record);
  }

  revokeToken(token: string): boolean {
    const record = this.findByTokenWithoutStatus(token);
    if (record === undefined) throw genericCredentialError();
    return this.revokeRecord(record);
  }

  /** Convenience form accepting either the opaque session id or bearer token. */
  revoke(sessionIdOrToken: string): boolean {
    if (typeof sessionIdOrToken !== "string") throw new WardenValidationError("session credential is invalid");
    const byId = this.sessions.get(sessionIdOrToken);
    if (byId !== undefined) return this.revokeRecord(byId);
    return this.revokeToken(sessionIdOrToken);
  }

  authorize(token: string, request: AuthorizationRequest): PolicyDecision;
  authorize(request: AuthorizationRequestWithToken): PolicyDecision;
  authorize(token: string, permission: PermissionClass, project?: string, spendEstimate?: number): PolicyDecision;
  authorize(
    tokenOrRequest: string | AuthorizationRequestWithToken,
    requestOrPermission?: AuthorizationRequest | PermissionClass,
    project?: string,
    spendEstimate?: number,
  ): PolicyDecision {
    const normalized = this.normalizeAuthorization(
      tokenOrRequest,
      requestOrPermission,
      project,
      spendEstimate,
    );
    const session = this.findByToken(normalized.token);
    this.assertLive(session);

    return this.authorizeRecord(session, normalized.request, normalized.estimate);
  }

  /**
   * Authorize an opaque session id without accepting or returning a bearer
   * token. Session ids are deliberately resolved only through the session map;
   * a bearer token passed here is therefore treated as an invalid session id.
   */
  authorizeSession(sessionId: string, request: AuthorizationRequest): PolicyDecision {
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw genericCredentialError();
    }
    if (isPlainObject(request) && "token" in request) {
      throw new WardenValidationError("session authorization cannot include a bearer token");
    }
    const normalized = this.normalizeAuthorizationRequest(request);
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw genericCredentialError();
    this.assertLive(session);

    return this.authorizeRecord(session, normalized.request, normalized.estimate);
  }

  private authorizeRecord(
    session: SessionRecord,
    request: AuthorizationRequest,
    estimate: number,
  ): PolicyDecision {
    const normalized = { request, estimate };

    if (session.project !== undefined && normalized.request.project !== session.project) {
      throw new PermissionDeniedError(normalized.request.permission, "The request is outside the session project scope");
    }
    if (!session.allowedPermissions.includes(normalized.request.permission)) {
      throw new PermissionDeniedError(normalized.request.permission);
    }
    if (
      normalized.request.permission === "approve"
      && agentLikeSessionKindSet.has(session.kind)
    ) {
      throw new PermissionDeniedError("approve", "Only the Human Channel can approve actions");
    }

    const decision = this.policy.evaluate(normalized.request.permission, { sessionKind: session.kind });
    if (decision.decision === "approval_required") return decision;
    if (normalized.request.permission === "spend") {
      this.budget.accept(normalized.estimate);
    } else if (normalized.estimate !== 0) {
      throw new WardenValidationError("spend estimate is only valid for spend permission");
    }
    return decision;
  }

  authorizeRequest(request: AuthorizationRequestWithToken): PolicyDecision {
    return this.authorize(request);
  }

  /** Throw ApprovalRequiredError for callers that use exception-style gates. */
  authorizeOrThrow(
    token: string,
    request: AuthorizationRequest,
  ): Exclude<PolicyDecision, { readonly decision: "approval_required" }> {
    const decision = this.authorize(token, request);
    if (decision.decision === "approval_required") {
      throw new ApprovalRequiredError(request.permission);
    }
    return decision;
  }

  /** Throw ApprovalRequiredError for an opaque session-id authorization gate. */
  authorizeSessionOrThrow(
    sessionId: string,
    request: AuthorizationRequest,
  ): Exclude<PolicyDecision, { readonly decision: "approval_required" }> {
    const decision = this.authorizeSession(sessionId, request);
    if (decision.decision === "approval_required") {
      throw new ApprovalRequiredError(request.permission);
    }
    return decision;
  }

  assertAuthorized(
    token: string,
    request: AuthorizationRequest,
  ): Exclude<PolicyDecision, { readonly decision: "approval_required" }> {
    return this.authorizeOrThrow(token, request);
  }

  budgetStatus(): BudgetSnapshot {
    return this.budget.snapshot();
  }

  get policyModes(): Readonly<Record<PermissionClass, import("./policy.ts").PolicyMode>> {
    return this.policy.modes;
  }

  private normalizeAuthorization(
    tokenOrRequest: string | AuthorizationRequestWithToken,
    requestOrPermission: AuthorizationRequest | PermissionClass | undefined,
    project: string | undefined,
    spendEstimate: number | undefined,
  ): { readonly token: string; readonly request: AuthorizationRequest; readonly estimate: number } {
    let token: unknown;
    let request: AuthorizationRequest;
    if (typeof tokenOrRequest === "string") {
      token = tokenOrRequest;
      if (typeof requestOrPermission === "string") {
        request = {
          permission: requestOrPermission,
          ...(project === undefined ? {} : { project }),
          ...(spendEstimate === undefined ? {} : { spendEstimate }),
        };
      } else if (isPlainObject(requestOrPermission)) {
        request = requestOrPermission;
        if (project !== undefined || spendEstimate !== undefined) {
          throw new WardenValidationError("authorization request has conflicting arguments");
        }
      } else {
        throw new WardenValidationError("authorization request is required");
      }
    } else if (isPlainObject(tokenOrRequest)) {
      token = tokenOrRequest.token;
      request = tokenOrRequest;
      if (project !== undefined || spendEstimate !== undefined || requestOrPermission !== undefined) {
        throw new WardenValidationError("authorization request has conflicting arguments");
      }
    } else {
      throw new WardenValidationError("authorization credential is invalid");
    }
    if (typeof token !== "string" || token.length === 0 || byteLength(token) > MAX_TOKEN_BYTES) {
      throw genericCredentialError();
    }
    const normalizedRequest = this.normalizeAuthorizationRequest(request);
    return { token, request: normalizedRequest.request, estimate: normalizedRequest.estimate };
  }

  private normalizeAuthorizationRequest(
    request: AuthorizationRequest,
  ): { readonly request: AuthorizationRequest; readonly estimate: number } {
    if (!isPlainObject(request) || !isPermissionClass(request.permission)) {
      throw new WardenValidationError("authorization permission is invalid");
    }
    const normalizedProject = request.project === undefined
      ? undefined
      : validateIdentifier(request.project, "project");
    const normalizedRequest: AuthorizationRequest = {
      permission: request.permission,
      ...(normalizedProject === undefined ? {} : { project: normalizedProject }),
      ...(request.spendEstimate === undefined ? {} : { spendEstimate: request.spendEstimate }),
      ...(request.estimatedSpend === undefined ? {} : { estimatedSpend: request.estimatedSpend }),
    };
    if (normalizedRequest.permission !== "spend" && (normalizedRequest.spendEstimate !== undefined || normalizedRequest.estimatedSpend !== undefined)) {
      throw new WardenValidationError("spend estimate is only valid for spend permission");
    }
    return { request: normalizedRequest, estimate: normalizeEstimate(normalizedRequest) };
  }

  private findByToken(token: string): SessionRecord {
    const record = this.findByTokenWithoutStatus(token);
    if (record === undefined) throw genericCredentialError();
    return record;
  }

  private findByTokenWithoutStatus(token: unknown): SessionRecord | undefined {
    if (typeof token !== "string" || token.length === 0 || byteLength(token) > MAX_TOKEN_BYTES) return undefined;
    return this.tokens.get(digestToken(token));
  }

  private assertLive(record: SessionRecord): void {
    if (record.revokedAtMs !== undefined) throw new SessionRevokedError();
    if (clockMilliseconds(this.clock) >= record.expiresAtMs) throw new SessionExpiredError();
  }

  private revokeRecord(record: SessionRecord): boolean {
    if (record.revokedAtMs !== undefined) return false;
    record.revokedAtMs = clockMilliseconds(this.clock);
    return true;
  }

  private newSessionId(): string {
    const id = `session-${this.nextSessionNumber}`;
    this.nextSessionNumber += 1;
    if (byteLength(id) > MAX_SESSION_IDENTIFIER_BYTES) {
      throw new WardenValidationError("session id space is exhausted");
    }
    return id;
  }

  private newToken(): { readonly token: string; readonly digest: string } {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      let bytes: Uint8Array;
      try {
        bytes = this.randomBytes(TOKEN_RANDOM_BYTES);
      } catch {
        throw new WardenValidationError("random-byte generation failed");
      }
      if (!(bytes instanceof Uint8Array) || bytes.length !== TOKEN_RANDOM_BYTES) {
        throw new WardenValidationError("random-byte source returned an invalid value");
      }
      const token = Buffer.from(bytes).toString("base64url");
      const digest = digestToken(token);
      if (!this.tokens.has(digest)) return { token, digest };
    }
    throw new WardenValidationError("random-byte source produced a duplicate token");
  }

  private removeStaleSessions(): void {
    const now = clockMilliseconds(this.clock);
    for (const [id, record] of this.sessions) {
      if (record.revokedAtMs !== undefined || record.expiresAtMs <= now) {
        this.sessions.delete(id);
        this.tokens.delete(record.tokenDigest);
      }
    }
  }
}

export const SessionManager = WardenSessionManager;
export const WardenSessions = WardenSessionManager;

export function createSessionManager(options: SessionManagerOptions = {}): WardenSessionManager {
  return new WardenSessionManager(options);
}
