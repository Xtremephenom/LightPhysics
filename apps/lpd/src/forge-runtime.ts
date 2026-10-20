import { createHash } from "node:crypto";
import {
  BudgetExceededError,
  ApprovalRequiredError,
  CancelledError,
  ConflictError,
  InternalError,
  MethodRegistry,
  NotImplementedError,
  PermissionDeniedError,
  ProviderError,
  ResourceUnavailableError,
  UnauthorizedError,
  UnqualifiedError,
  ValidationError,
  type CoreMethodContext,
} from "@lightphysics/core-api";
import {
  ForgeError,
  MockAdapter,
  routeRequest,
  requestHash,
  type ForgeAdapter,
  type RouteResult,
  type RoutingOptions,
  type RunOptions,
} from "@lightphysics/forge";
import { Ledger, type LedgerRecord } from "@lightphysics/ledger";
import {
  ForgeRequestSchema,
  ForgeResultSchema,
  type DataPolicy,
  type ForgeRequest,
  type ForgeResult,
} from "@lightphysics/schemas";
import {
  ApprovalRequiredError as WardenApprovalRequiredError,
  BudgetExceededError as WardenBudgetExceededError,
  PermissionDeniedError as WardenPermissionDeniedError,
  SessionExpiredError,
  SessionRevokedError,
  UnauthorizedError as WardenUnauthorizedError,
  WardenError,
  WardenSessionManager,
  WardenValidationError,
} from "@lightphysics/warden";
import { SpendController, type SpendEstimate } from "@lightphysics/forge";

/** The small composition seam kept at the daemon boundary. */
export type ForgeRouter = (
  request: ForgeRequest,
  adapters: readonly ForgeAdapter[],
  options?: RoutingOptions,
  runOptions?: RunOptions,
) => Promise<RouteResult>;

export interface ForgeRuntimeOptions {
  /** Ordered adapters. The first eligible adapter is the primary route. */
  readonly adapters?: readonly ForgeAdapter[];
  /** A router can be replaced by tests or a future catalog-backed router. */
  readonly router?: ForgeRouter;
  readonly ledger?: Ledger;
  readonly warden?: WardenSessionManager;
  readonly spend?: SpendController;
  readonly dataPolicy?: DataPolicy;
  readonly projectId?: string;
  readonly now?: () => Date;
}

export interface ForgeRuntime {
  readonly adapters: readonly ForgeAdapter[];
  readonly spend: SpendController;
  create(request: ForgeRequest, context: CoreMethodContext): Promise<ForgeResult>;
  register(registry: MethodRegistry): void;
}

const DEFAULT_PROJECT = "default";

function hostedAllowed(policy: DataPolicy | undefined, capability: ForgeRequest["capability"]): boolean {
  if (!policy || policy === "hosted_ok") return true;
  if (policy === "local_only") return false;
  return policy.hosted_ok_for.includes(capability);
}

function eligibleAdapters(
  request: ForgeRequest,
  adapters: readonly ForgeAdapter[],
  policy: DataPolicy | undefined,
): readonly ForgeAdapter[] {
  return adapters.filter((adapter) => {
    const description = adapter.describe();
    return description.capabilities.includes(request.capability)
      && (description.kind !== "hosted" || hostedAllowed(policy, request.capability));
  });
}

function boundedDetails(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const output: Record<string, unknown> = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (key === "prompt" || /secret|token|password|credential|authorization|cookie/i.test(key)) continue;
    if (typeof candidate === "string" && candidate.length <= 256) output[key] = candidate;
    else if (typeof candidate === "number" && Number.isFinite(candidate)) output[key] = candidate;
    else if (typeof candidate === "boolean") output[key] = candidate;
  }
  return Object.keys(output).length === 0 ? undefined : output;
}

function forgeErrorToCore(error: unknown): Error {
  if (error instanceof ValidationError || error instanceof ConflictError) return error;
  if (error instanceof ForgeError) {
    const details = {
      forge_code: error.code,
      ...(boundedDetails(error.details) ?? {}),
    };
    switch (error.code) {
      case "ValidationError":
        return new ValidationError(error.message, { details });
      case "ResourceUnavailable":
        return new ResourceUnavailableError(error.message, { details });
      case "BudgetExceeded":
      case "CircuitOpen":
        return new BudgetExceededError(error.message, { details });
      case "Unqualified":
        return new UnqualifiedError(error.message, { details });
      case "NotImplemented":
        return new NotImplementedError(error.message, { details });
      case "Cancelled":
        return new CancelledError(error.message, { details });
      case "ChecksumMismatch":
      case "DiskInsufficient":
      case "Timeout":
      case "RateLimit":
      case "MalformedResponse":
      case "PolicyRefusal":
      case "OutOfMemory":
      case "Authentication":
      case "ProviderError":
        return new ProviderError(error.message, {
          details,
          retryable: error.retryable,
          ...(error.retryable ? { suggestedNext: "retry or use the next configured Forge route" } : {}),
        });
      default:
        return new ProviderError("The Forge provider failed", { details });
    }
  }
  return new InternalError("The daemon encountered an internal Forge error", {
    details: { thrown: error instanceof Error ? error.name : typeof error },
  });
}

function wardenErrorToCore(error: unknown): Error {
  if (error instanceof WardenPermissionDeniedError) {
    return new PermissionDeniedError("The Warden session is not permitted to perform this Forge action", {
      details: { permission: error.details?.permission },
    });
  }
  if (error instanceof WardenApprovalRequiredError) {
    return new ApprovalRequiredError(error.message, {
      details: { permission: error.details?.permission },
    });
  }
  if (error instanceof WardenBudgetExceededError) {
    return new BudgetExceededError(error.message, { details: error.details });
  }
  if (error instanceof WardenUnauthorizedError || error instanceof SessionExpiredError || error instanceof SessionRevokedError) {
    return new UnauthorizedError("The Warden session is not valid");
  }
  if (error instanceof WardenValidationError) return new ValidationError(error.message);
  if (error instanceof WardenError) return new InternalError("The daemon encountered an internal Warden error", {
    details: { warden_code: error.code },
  });
  return new InternalError("The daemon encountered an internal Warden error", {
    details: { thrown: error instanceof Error ? error.name : typeof error },
  });
}

/**
 * Keep authorization records deterministic and digest-only. In particular,
 * context.idempotency_key is used for the identity hash but is never written.
 */
function appendWardenDecision(
  ledger: Ledger,
  context: CoreMethodContext,
  permission: "spend" | "write_project",
  outcome: string,
  code: string,
): void {
  const method = "forge.create";
  const sessionId = typeof context.session_id === "string" ? context.session_id : "";
  const traceId = typeof context.trace_id === "string" ? context.trace_id : "";
  const identity = JSON.stringify({ method, permission, session_id: sessionId, trace_id: traceId });
  const id = `warden-forge-${createHash("sha256").update(identity, "utf8").digest("hex")}`;
  const payload = { event_kind: "warden.permission_decision", method, permission, outcome, code,
    ...(sessionId ? { session_id: sessionId } : {}), ...(traceId ? { trace_id: traceId } : {}) };
  try {
    ledger.appendAudit(id, payload);
  } catch {
    try {
      if (ledger.getAudit(id)?.payloadJson === JSON.stringify(payload)) return;
    } catch {
      // Normalize the storage boundary below.
    }
    throw new InternalError("The daemon could not record the Warden permission decision", {
      details: { reason: "audit_unavailable" },
    });
  }
}

function authorize(
  warden: WardenSessionManager,
  ledger: Ledger | undefined,
  context: CoreMethodContext,
  permission: "spend" | "write_project",
  project: string,
  spendEstimate?: number,
): void {
  const sessionId = context.session_id;
  let mapped: Error | undefined;
  let outcome = "allowed";
  let code = "Allowed";
  try {
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new ValidationError("Warden authorization requires context.session_id");
    }
    warden.authorizeSessionOrThrow(sessionId, {
      permission,
      project,
      ...(spendEstimate === undefined ? {} : { spendEstimate }),
    });
  } catch (error) {
    mapped = error instanceof Error && "code" in error && typeof (error as { code?: unknown }).code === "string"
      && error instanceof ValidationError
      ? error
      : error instanceof Error && "code" in error && (error as { code?: unknown }).code === "ValidationError"
        ? new ValidationError(error.message)
        : wardenErrorToCore(error);
    code = error instanceof WardenError ? error.code : mapped instanceof Error && "code" in mapped ? String((mapped as { code: unknown }).code) : "AuthorizationFailed";
    outcome = mapped instanceof PermissionDeniedError ? "permission_denied"
      : mapped instanceof BudgetExceededError ? "budget_exceeded"
        : code === "ApprovalRequired" ? "approval_required" : "failed";
  }
  if (ledger) appendWardenDecision(ledger, context, permission, outcome, code);
  if (mapped) throw mapped;
}

function actualCost(result: ForgeResult): { amount: number; currency: string; at?: string } {
  if (typeof result.cost === "number") return { amount: result.cost, currency: "USD" };
  if (result.cost) return { amount: result.cost.amount, currency: result.cost.currency, at: result.cost.at };
  return { amount: 0, currency: "USD" };
}

function resultWithRuntimeMetadata(
  result: ForgeResult,
  request: ForgeRequest,
  provider: string,
  attempts: readonly string[],
): ForgeResult {
  const hash = requestHash(request as never);
  const recipeId = `recipe-${hash}`;
  const provenanceId = `provenance-${hash}`;
  const artifacts = result.artifacts.map((artifact, index) => ({
    ...artifact,
    id: artifact.id || `artifact-${hash.slice(0, 12)}-${index + 1}`,
    recipe_id: recipeId,
    provenance_id: provenanceId,
    state: "exploration" as const,
  }));
  return ForgeResultSchema.parse({
    ...result,
    artifacts,
    provenance: {
      provider_id: provider,
      provider,
      request_hash: hash,
      ...(typeof result.provenance?.model_id === "string" ? { model_id: result.provenance.model_id } : {}),
      ...(typeof result.provenance?.model === "string" ? { model: result.provenance.model } : {}),
      ...(typeof result.provenance?.model_version === "string" ? { model_version: result.provenance.model_version } : {}),
      ...(typeof result.provenance?.latency_ms === "number" ? { latency_ms: result.provenance.latency_ms } : {}),
      ...(request.style_lock && request.style_lock !== "auto" ? { style_lock: { version: request.style_lock.version } } : {}),
    },
    warnings: [...result.warnings],
    next_actions: [...result.next_actions],
    status: result.status,
  });
}

function appendForgeLedger(
  ledger: Ledger,
  request: ForgeRequest,
  result: ForgeResult,
  provider: string,
  attempts: readonly string[],
): readonly LedgerRecord[] {
  const hash = requestHash(request as never);
  const recipeId = `recipe-${hash}`;
  const provenanceId = `provenance-${hash}`;
  const records: LedgerRecord[] = [];
  for (const artifact of result.artifacts) {
    records.push(ledger.appendArtifact(`forge-artifact-${artifact.id}`, {
      event_kind: "forge.artifact",
      artifact_id: artifact.id,
      uri: artifact.uri,
      kind: artifact.kind,
      ...(artifact.mime ? { mime: artifact.mime } : {}),
      ...(artifact.sha256 ? { sha256: artifact.sha256 } : {}),
      state: "exploration",
      recipe_id: recipeId,
      provenance_id: provenanceId,
      request_hash: hash,
    }));
  }
  records.push(ledger.appendAudit(`forge-provenance-${hash}`, {
    event_kind: "forge.provenance",
    capability: request.capability,
    provider,
    attempts: [...attempts],
    recipe_id: recipeId,
    provenance_id: provenanceId,
    request_hash: hash,
  }));
  records.push(ledger.appendAudit(`forge-create-${hash}`, {
    event_kind: "forge.create",
    capability: request.capability,
    provider,
    outcome: result.status,
    state: "exploration",
    request_hash: hash,
  }));
  return records;
}

export function createForgeRuntime(options: ForgeRuntimeOptions = {}): ForgeRuntime {
  const adapters = options.adapters ?? [new MockAdapter() as unknown as ForgeAdapter];
  const spend = options.spend ?? new SpendController();
  const router = options.router ?? routeRequest as unknown as ForgeRouter;
  const policy = options.dataPolicy;
  const projectId = options.projectId ?? DEFAULT_PROJECT;
  const now = options.now ?? (() => new Date());

  const create = async (rawRequest: ForgeRequest, context: CoreMethodContext): Promise<ForgeResult> => {
    const request = ForgeRequestSchema.parse(rawRequest);
    const eligible = eligibleAdapters(request, adapters, policy);
    if (eligible.length === 0) {
      throw new ResourceUnavailableError("No eligible Forge adapter supports this capability or privacy policy", {
        details: { capability: request.capability, data_policy: policy ?? "hosted_ok" },
      });
    }

    let estimate: SpendEstimate;
    try {
      const primary = eligible[0];
      if (!primary) {
        throw new ResourceUnavailableError("No eligible Forge adapter supports this capability or privacy policy");
      }
      const raw = primary.estimate(request as never);
      estimate = spend.estimate(raw.cost, projectId);
    } catch (error) {
      throw forgeErrorToCore(error);
    }
    if (options.warden) {
      authorize(options.warden, options.ledger, context, "write_project", projectId);
      authorize(options.warden, options.ledger, context, "spend", projectId, estimate.amount);
    }
    try {
      spend.confirm(estimate, projectId);
    } catch (error) {
      throw forgeErrorToCore(error);
    }

    let routed: RouteResult;
    try {
      routed = await router(request, adapters, {
        data_policy: policy,
        egress: [],
        rewritePolicyRefusal: (candidate) => ({
          ...candidate,
          prompt: candidate.prompt ? `${candidate.prompt}\nProvide a policy-compliant alternative.` : "Provide a policy-compliant alternative.",
        }),
        stricterRetry: (candidate) => ({
          ...candidate,
          provider_params: { ...(typeof candidate.provider_params === "object" && candidate.provider_params !== null && !Array.isArray(candidate.provider_params) ? candidate.provider_params : {}), strict: true },
        }),
      }, {});
    } catch (error) {
      // routeRequest intentionally collapses an exhausted retry chain into
      // ResourceUnavailable. At this boundary an eligible adapter existed,
      // so preserve the provider-failure taxonomy for Core callers.
      if (error instanceof ForgeError && error.code === "ResourceUnavailable" && eligible.length > 0) {
        throw new ProviderError("All eligible Forge providers failed", {
          details: { forge_code: error.code, ...(boundedDetails(error.details) ?? {}) },
        });
      }
      throw forgeErrorToCore(error);
    }
    const result = resultWithRuntimeMetadata(routed.result as unknown as ForgeResult, request, routed.provider, routed.attempts);
    const cost = actualCost(result);
    try {
      spend.recordActual({
        amount: cost.amount,
        currency: cost.currency,
        provider: routed.provider,
        capability: request.capability,
        ...(cost.at ? { at: cost.at } : { at: now().toISOString() }),
      }, projectId);
    } catch (error) {
      throw forgeErrorToCore(error);
    }
    if (options.ledger) {
      try {
        appendForgeLedger(options.ledger, request, result, routed.provider, routed.attempts);
      } catch (error) {
        throw new InternalError("The daemon could not record Forge provenance", {
          details: { reason: "ledger_unavailable" },
          cause: error,
        });
      }
    }
    return result;
  };

  return {
    adapters,
    spend,
    create,
    register(registry) {
      registry.register({
        method: "forge.create",
        mutating: true,
        params: ForgeRequestSchema,
        result: ForgeResultSchema,
        handler: (params, context) => create(params as ForgeRequest, context),
      });
    },
  };
}
