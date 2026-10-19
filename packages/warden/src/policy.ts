/**
 * The Warden policy vocabulary is intentionally small.  This module has no
 * persistence, I/O, or application imports so it can be used by an offline
 * in-memory session core.
 */

export const PERMISSION_CLASSES = [
  "read",
  "write_project",
  "engine_exec",
  "spend",
  "network_egress",
  "install",
  "release",
  "approve",
] as const;

export type PermissionClass = (typeof PERMISSION_CLASSES)[number];

export const POLICY_MODES = ["auto", "ask", "deny"] as const;
export type PolicyMode = (typeof POLICY_MODES)[number];

export const SESSION_KINDS = ["agent", "gui", "cli", "studio-agent"] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];

export const AGENT_LIKE_SESSION_KINDS = ["agent", "cli", "studio-agent"] as const;

export const DEFAULT_BUDGET_LIMIT = 1_000;
export const MAX_BUDGET_VALUE = 1_000_000_000;

export type WardenErrorCode =
  | "WardenValidationError"
  | "Unauthorized"
  | "SessionExpired"
  | "SessionRevoked"
  | "PermissionDenied"
  | "ApprovalRequired"
  | "BudgetExceeded";

export class WardenError extends Error {
  readonly code: WardenErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: WardenErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = code;
    this.code = code;
    this.details = details;
  }
}

export class WardenValidationError extends WardenError {
  constructor(message = "Invalid Warden input") {
    super("WardenValidationError", message);
  }
}

export class UnauthorizedError extends WardenError {
  constructor() {
    super("Unauthorized", "The Warden session is not valid");
  }
}

export class SessionExpiredError extends WardenError {
  constructor() {
    super("SessionExpired", "The Warden session has expired");
  }
}

export class SessionRevokedError extends WardenError {
  constructor() {
    super("SessionRevoked", "The Warden session has been revoked");
  }
}

export class PermissionDeniedError extends WardenError {
  constructor(
    permission: PermissionClass,
    reason = "The session is not permitted to perform this action",
  ) {
    super("PermissionDenied", reason, { permission });
  }
}

export class ApprovalRequiredError extends WardenError {
  constructor(permission: PermissionClass) {
    super("ApprovalRequired", "Human approval is required for this action", {
      permission,
    });
  }
}

export class BudgetExceededError extends WardenError {
  constructor(limit: number, used: number, remaining: number) {
    super("BudgetExceeded", "The configured spend budget would be exceeded", {
      limit,
      used,
      remaining,
    });
  }
}

export interface PolicyOptions {
  readonly defaultMode?: PolicyMode;
  readonly modes?: Partial<Record<PermissionClass, PolicyMode>>;
  /** Alias useful when loading a policy from a plain object. */
  readonly modeByPermission?: Partial<Record<PermissionClass, PolicyMode>>;
}

export interface PolicyEvaluationOptions {
  readonly sessionKind?: SessionKind;
}

export interface AllowedDecision {
  readonly decision: "allowed";
  readonly outcome: "allowed";
  readonly allowed: true;
  readonly approvalRequired: false;
  readonly permission: PermissionClass;
  readonly mode: "auto";
}

export interface ApprovalRequiredDecision {
  readonly decision: "approval_required";
  readonly outcome: "approval_required";
  readonly allowed: false;
  readonly approvalRequired: true;
  readonly permission: PermissionClass;
  readonly mode: "ask";
}

export type PolicyDecision = AllowedDecision | ApprovalRequiredDecision;

const permissionSet = new Set<string>(PERMISSION_CLASSES);
const modeSet = new Set<string>(POLICY_MODES);
const sessionKindSet = new Set<string>(SESSION_KINDS);
const agentLikeSessionKindSet = new Set<string>(AGENT_LIKE_SESSION_KINDS);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validatePermission(value: unknown): PermissionClass {
  if (typeof value !== "string" || !permissionSet.has(value)) {
    throw new WardenValidationError("permission must be one of the Warden permission classes");
  }
  return value as PermissionClass;
}

function validateMode(value: unknown): PolicyMode {
  if (typeof value !== "string" || !modeSet.has(value)) {
    throw new WardenValidationError("policy mode must be auto, ask, or deny");
  }
  return value as PolicyMode;
}

function validateSessionKind(value: unknown): SessionKind {
  if (typeof value !== "string" || !sessionKindSet.has(value)) {
    throw new WardenValidationError("session kind is not supported");
  }
  return value as SessionKind;
}

function validateModeMap(
  value: Partial<Record<PermissionClass, PolicyMode>> | undefined,
): Partial<Record<PermissionClass, PolicyMode>> {
  if (value === undefined) return {};
  if (!isPlainObject(value)) throw new WardenValidationError("policy modes must be an object");

  const output: Partial<Record<PermissionClass, PolicyMode>> = {};
  for (const [permission, mode] of Object.entries(value)) {
    if (!permissionSet.has(permission)) {
      throw new WardenValidationError("policy modes contain an unsupported permission");
    }
    output[permission as PermissionClass] = validateMode(mode);
  }
  return output;
}

function validateBudgetValue(value: unknown, field: string): number {
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || value < 0
    || value > MAX_BUDGET_VALUE
  ) {
    throw new WardenValidationError(`${field} is outside its supported bound`);
  }
  return value;
}

/**
 * A bounded in-memory spend circuit breaker.  A failed check does not consume
 * budget; a later request that fits can therefore recover without mutating
 * any external state.
 */
export class BudgetCircuitBreaker {
  readonly limit: number;
  private spent = 0;
  private wasTripped = false;

  constructor(options: number | { readonly limit: number }) {
    const limit = typeof options === "number" ? options : options?.limit;
    this.limit = validateBudgetValue(limit, "budget limit");
  }

  get used(): number {
    return this.spent;
  }

  get remaining(): number {
    return this.limit - this.spent;
  }

  get tripped(): boolean {
    return this.wasTripped;
  }

  snapshot(): BudgetSnapshot {
    return Object.freeze({
      limit: this.limit,
      used: this.spent,
      remaining: this.remaining,
      tripped: this.wasTripped,
    });
  }

  canAccept(estimate: number): boolean {
    const amount = validateBudgetValue(estimate, "spend estimate");
    return this.spent + amount <= this.limit;
  }

  /** Record an accepted estimate, or throw without consuming any budget. */
  accept(estimate: number): BudgetSnapshot {
    const amount = validateBudgetValue(estimate, "spend estimate");
    if (this.spent + amount > this.limit) {
      this.wasTripped = true;
      throw new BudgetExceededError(this.limit, this.spent, this.remaining);
    }
    this.spent += amount;
    this.wasTripped = false;
    return this.snapshot();
  }

  tryAccept(estimate: number): BudgetSnapshot {
    return this.accept(estimate);
  }

  /** Reset the in-memory breaker for a new bounded accounting window. */
  reset(): BudgetSnapshot {
    this.spent = 0;
    this.wasTripped = false;
    return this.snapshot();
  }
}

export interface BudgetSnapshot {
  readonly limit: number;
  readonly used: number;
  readonly remaining: number;
  readonly tripped: boolean;
}

function makeAllowedDecision(permission: PermissionClass): AllowedDecision {
  return Object.freeze({
    decision: "allowed",
    outcome: "allowed",
    allowed: true,
    approvalRequired: false,
    permission,
    mode: "auto",
  });
}

function makeApprovalDecision(permission: PermissionClass): ApprovalRequiredDecision {
  return Object.freeze({
    decision: "approval_required",
    outcome: "approval_required",
    allowed: false,
    approvalRequired: true,
    permission,
    mode: "ask",
  });
}

/** Pure policy evaluation: it stores no sessions and performs no I/O. */
export class WardenPolicy {
  readonly modes: Readonly<Record<PermissionClass, PolicyMode>>;

  constructor(options: PolicyOptions = {}) {
    if (!isPlainObject(options)) throw new WardenValidationError("policy options must be an object");
    const candidate = options as PolicyOptions;
    const defaultMode = candidate.defaultMode === undefined
      ? "deny"
      : validateMode(candidate.defaultMode);
    const modes = {
      ...validateModeMap(candidate.modes),
      ...validateModeMap(candidate.modeByPermission),
    };
    const complete = {} as Record<PermissionClass, PolicyMode>;
    for (const permission of PERMISSION_CLASSES) {
      complete[permission] = modes[permission] ?? defaultMode;
    }
    this.modes = Object.freeze(complete);
  }

  mode(permission: PermissionClass): PolicyMode {
    const normalized = validatePermission(permission);
    return this.modes[normalized];
  }

  evaluate(
    permission: PermissionClass,
    options: PolicyEvaluationOptions = {},
  ): PolicyDecision {
    const normalized = validatePermission(permission);
    const sessionKind = options.sessionKind === undefined
      ? undefined
      : validateSessionKind(options.sessionKind);

    // Only the Human Channel can approve.  This check is deliberately before
    // policy mode evaluation so auto cannot grant agent approval authority.
    if (
      normalized === "approve"
      && sessionKind !== undefined
      && agentLikeSessionKindSet.has(sessionKind)
    ) {
      throw new PermissionDeniedError("approve", "Only the Human Channel can approve actions");
    }

    const mode = this.modes[normalized];
    if (mode === "auto") return makeAllowedDecision(normalized);
    if (mode === "ask") return makeApprovalDecision(normalized);
    throw new PermissionDeniedError(normalized);
  }

  authorize(
    permission: PermissionClass,
    options: PolicyEvaluationOptions = {},
  ): PolicyDecision {
    return this.evaluate(permission, options);
  }

  /** Convert an approval-required decision into its typed error. */
  enforce(
    permission: PermissionClass,
    options: PolicyEvaluationOptions = {},
  ): AllowedDecision {
    const decision = this.evaluate(permission, options);
    if (decision.decision === "approval_required") {
      throw new ApprovalRequiredError(permission);
    }
    return decision;
  }

  assertAllowed(
    permission: PermissionClass,
    options: PolicyEvaluationOptions = {},
  ): AllowedDecision {
    return this.enforce(permission, options);
  }
}

export const Policy = WardenPolicy;
export const PermissionPolicy = WardenPolicy;

export function evaluatePolicy(
  permission: PermissionClass,
  options: PolicyOptions & PolicyEvaluationOptions = {},
): PolicyDecision {
  return new WardenPolicy(options).evaluate(permission, options);
}

export function isPermissionClass(value: unknown): value is PermissionClass {
  return typeof value === "string" && permissionSet.has(value);
}

export function isPolicyMode(value: unknown): value is PolicyMode {
  return typeof value === "string" && modeSet.has(value);
}

export function isSessionKind(value: unknown): value is SessionKind {
  return typeof value === "string" && sessionKindSet.has(value);
}
