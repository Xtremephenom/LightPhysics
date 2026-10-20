import { z } from "zod";
import { FORGE_SCHEMA_REGISTRY } from "./forge.ts";
export * from "./forge.ts";

/** JSON-RPC permits string, number, or null identifiers. Notifications omit id. */
export const JsonRpcIdSchema = z.union([
  z.string().min(1),
  z.number().finite(),
  z.null(),
]);
export type JsonRpcId = z.infer<typeof JsonRpcIdSchema>;

/**
 * Context carried by a Core call. The object is intentionally strict so a
 * caller cannot silently smuggle transport- or domain-specific fields into
 * the shared envelope.
 */
export const CallContextSchema = z
  .object({
    session_id: z.string().min(1),
    trace_id: z.string().min(1),
    role: z.string().min(1).optional(),
    work_order: z.string().min(1).optional(),
    idempotency_key: z.string().min(1).optional(),
  })
  .strict();
export type CallContext = z.infer<typeof CallContextSchema>;

/** Compatibility names for callers that prefer an explicitly Core-scoped name. */
export const CoreCallContextSchema = CallContextSchema;
export type CoreCallContext = CallContext;

/**
 * The error names are deliberately strings rather than numeric transport codes.
 * They are stable application contracts and are carried in JSON-RPC `data`.
 */
export const CoreErrorCodeSchema = z.enum([
  "ValidationError",
  "NotFound",
  "Conflict",
  "PermissionDenied",
  "ApprovalRequired",
  "BudgetExceeded",
  "ResourceUnavailable",
  "ProviderError",
  "Unqualified",
  "EngineError",
  "StaleEvidence",
  "Cancelled",
  "NotImplemented",
  "Internal",
  "Unauthorized",
  "OriginRejected",
  "MethodNotFound",
]);
export type CoreErrorCode = z.infer<typeof CoreErrorCodeSchema>;

/** The application-level, typed error payload. It contains no stack by design. */
export const TypedErrorSchema = z
  .object({
    code: CoreErrorCodeSchema,
    message: z.string().min(1),
    retryable: z.boolean(),
    suggested_next: z.string().min(1).optional(),
    details: z.unknown().optional(),
  })
  .strict();
export type TypedError = z.infer<typeof TypedErrorSchema>;

/** A stand-alone error envelope suitable for HTTP or another non-RPC transport. */
export const TypedErrorEnvelopeSchema = z
  .object({ error: TypedErrorSchema })
  .strict();
export type TypedErrorEnvelope = z.infer<typeof TypedErrorEnvelopeSchema>;

/**
 * Callers use both names in practice: some transports wrap the typed error in
 * `{ error }`, while JSON-RPC carries the typed object directly in `data`.
 * Accepting both keeps the schema useful at either boundary.
 */
export const ErrorEnvelopeSchema = z.union([
  TypedErrorSchema,
  TypedErrorEnvelopeSchema,
]);
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;
export const RpcErrorEnvelopeSchema = TypedErrorEnvelopeSchema;

export const JsonRpcRequestSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: JsonRpcIdSchema.optional(),
    method: z.string().min(1),
    params: z.unknown().optional(),
    context: CallContextSchema.optional(),
  })
  .strict();
export type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>;

/**
 * Compact, domain-neutral events emitted by Core. Event data is deliberately
 * opaque to this package; dispatchers should keep it small and avoid copying
 * request parameters, results, credentials, or thrown errors into it.
 */
export const CoreEventDataSchema = z.record(z.string(), z.unknown());
export type CoreEventData = z.infer<typeof CoreEventDataSchema>;

export const CoreEventSchema = z
  .object({
    event_id: z.string().min(1),
    event_name: z.string().min(1),
    timestamp: z.string().datetime({ offset: true }),
    request_id: JsonRpcIdSchema.optional(),
    method: z.string().min(1).optional(),
    context: CallContextSchema.optional(),
    data: CoreEventDataSchema.optional(),
  })
  .strict();
export type CoreEvent = z.infer<typeof CoreEventSchema>;

export const JsonRpcErrorSchema = z
  .object({
    /** Standard JSON-RPC transport code. The typed application code is in data. */
    code: z.number().int(),
    message: z.string().min(1),
    data: z
      .union([TypedErrorSchema, TypedErrorEnvelopeSchema])
      .optional(),
  })
  .strict();
export type JsonRpcError = z.infer<typeof JsonRpcErrorSchema>;

export const JsonRpcSuccessResponseSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: JsonRpcIdSchema,
    result: z.unknown(),
  })
  .strict();
export type JsonRpcSuccessResponse = z.infer<
  typeof JsonRpcSuccessResponseSchema
>;

export const JsonRpcErrorResponseSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: JsonRpcIdSchema,
    error: JsonRpcErrorSchema,
  })
  .strict();
export type JsonRpcErrorResponse = z.infer<typeof JsonRpcErrorResponseSchema>;

export const JsonRpcResponseSchema = z.union([
  JsonRpcSuccessResponseSchema,
  JsonRpcErrorResponseSchema,
]);
export type JsonRpcResponse = z.infer<typeof JsonRpcResponseSchema>;

const EmptyParamsSchema = z.object({}).strict();

/**
 * Core job payloads are JSON only, bounded, and reject the same secret-like
 * keys/values as the Runner journal.  Keeping this check at the API boundary
 * means callers get a typed validation failure before storage is opened.
 */
export const CORE_MAX_JOB_PAYLOAD_BYTES = 64 * 1024;
export const CORE_MAX_JSON_DEPTH = 24;
export const CORE_MAX_JSON_ITEMS = 1_024;
export const CORE_MAX_IDENTIFIER_BYTES = 256;
export const CORE_MAX_TEXT_BYTES = 4 * 1024;

const coreSensitiveKey = /(?:secret|token|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|credential|authorization|cookie|session[_-]?secret)/i;
const coreSecretValue = /(?:-----BEGIN[\s\S]*PRIVATE KEY-----|\b(?:sk|rk|pk|ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9][A-Za-z0-9._-]{11,}|\bAKIA[0-9A-Z]{16}\b|\bBearer\s+[A-Za-z0-9._~+/=-]{12,})/i;

function coreBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function validateCoreJson(value: unknown, path: (string | number)[] = [], depth = 0, ancestors = new WeakSet<object>()): string | undefined {
  if (depth > CORE_MAX_JSON_DEPTH) return "maximum nesting depth exceeded";
  if (value === null || typeof value === "boolean") return undefined;
  if (typeof value === "string") {
    if (coreBytes(value) > CORE_MAX_JOB_PAYLOAD_BYTES) return "string exceeds the payload bound";
    if (coreSecretValue.test(value)) return "secret-like value is not allowed";
    return undefined;
  }
  if (typeof value === "number") return Number.isFinite(value) ? undefined : "numbers must be finite";
  if (typeof value !== "object" || value === undefined) return "only JSON values are supported";
  if (typeof value === "function" || typeof value === "bigint") return "only JSON values are supported";
  if (ancestors.has(value)) return "cyclic values are not supported";
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > CORE_MAX_JSON_ITEMS) return "array contains too many items";
      for (let index = 0; index < value.length; index += 1) {
        const issue = validateCoreJson(value[index], [...path, index], depth + 1, ancestors);
        if (issue) return issue;
      }
      return undefined;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return "only plain JSON objects are supported";
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object);
    if (keys.length > CORE_MAX_JSON_ITEMS) return "object contains too many keys";
    for (const key of keys) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") return `reserved object key ${key} is not allowed`;
      if (coreSensitiveKey.test(key)) return "secret-like field is not allowed";
      const issue = validateCoreJson(object[key], [...path, key], depth + 1, ancestors);
      if (issue) return issue;
    }
    return undefined;
  } finally {
    ancestors.delete(value);
  }
}

export const CoreJsonValueSchema = z.unknown().superRefine((value, context) => {
  let issue = validateCoreJson(value);
  if (!issue) {
    try {
      const serialized = JSON.stringify(value);
      if (serialized === undefined || coreBytes(serialized) > CORE_MAX_JOB_PAYLOAD_BYTES) {
        issue = "JSON payload exceeds the payload bound";
      }
    } catch {
      issue = "only JSON values are supported";
    }
  }
  if (issue) context.addIssue({ code: z.ZodIssueCode.custom, message: issue });
});
export type CoreJsonValue = z.infer<typeof CoreJsonValueSchema>;

const CoreIdentifierSchema = z.string().min(1).max(CORE_MAX_IDENTIFIER_BYTES);
const CoreTextSchema = z.string().min(1).max(CORE_MAX_TEXT_BYTES);
const ResourceNumberSchema = z.number().int().nonnegative().max(2_147_483_647);
const PriorityClassSchema = z.enum([
  "batch",
  "low",
  "normal",
  "user-visible",
  "final",
  "interactive",
  "critical",
]);
const PriorityInputSchema = z.union([PriorityClassSchema, z.number().int().min(0).max(100)]);
const BoundedResourceAlternativesSchema = z.array(CoreJsonValueSchema).max(16) as z.ZodType<readonly unknown[]>;
const ResourceAlternativesInputSchema = z.union([BoundedResourceAlternativesSchema, CoreJsonValueSchema]);

/** Canonical normalized resource vocabulary returned on a public Job. */
export interface ResourceRequest {
  readonly vramMb: number;
  readonly ramMb: number;
  readonly diskMb: number;
  readonly exclusive: boolean;
  readonly downshifts: readonly ResourceRequest[];
}
const ResourceRequestAlternativesSchema = z.array(CoreJsonValueSchema).max(16) as unknown as z.ZodType<readonly ResourceRequest[]>;
export const ResourceRequestSchema = z.object({
  vramMb: ResourceNumberSchema,
  ramMb: ResourceNumberSchema,
  diskMb: ResourceNumberSchema,
  exclusive: z.boolean(),
  /** Downshift alternatives are bounded JSON and normalized by Runner. */
  downshifts: ResourceRequestAlternativesSchema,
}).strict() as unknown as z.ZodType<ResourceRequest>;

/** Accepted resource vocabulary for job.create, including architecture aliases. */
export const ResourceRequestInputSchema = z.object({
  vramMb: ResourceNumberSchema.optional(),
  ramMb: ResourceNumberSchema.optional(),
  diskMb: ResourceNumberSchema.optional(),
  vramPeakMb: ResourceNumberSchema.optional(),
  ramPeakMb: ResourceNumberSchema.optional(),
  vram_peak_mb: ResourceNumberSchema.optional(),
  ram_peak_mb: ResourceNumberSchema.optional(),
  disk_mb: ResourceNumberSchema.optional(),
  exclusive: z.boolean().optional(),
  downshifts: ResourceAlternativesInputSchema.optional(),
  downshift: ResourceAlternativesInputSchema.optional(),
}).strict();
export type ResourceRequestInput = z.infer<typeof ResourceRequestInputSchema>;

export const JobStateSchema = z.enum([
  "queued",
  "running",
  "waiting_provider",
  "waiting_human",
  "succeeded",
  "failed",
  "cancelled",
  "orphaned",
]);
export type JobState = z.infer<typeof JobStateSchema>;

export const JobErrorDetailsSchema = z.object({
  code: CoreIdentifierSchema,
  message: CoreTextSchema,
  retryable: z.boolean(),
  details: CoreJsonValueSchema.optional(),
}).strict();
export type JobErrorDetails = z.infer<typeof JobErrorDetailsSchema>;

/** Public, secret-free Runner record shared by all three job methods. */
export const JobSchema = z.object({
  id: CoreIdentifierSchema,
  type: CoreIdentifierSchema,
  state: JobStateSchema,
  payload: CoreJsonValueSchema,
  result: CoreJsonValueSchema.optional(),
  resources: ResourceRequestSchema,
  priority: z.number().int().min(0).max(100),
  priorityClass: CoreIdentifierSchema,
  resumable: z.boolean(),
  attempts: z.number().int().nonnegative(),
  cancelRequested: z.boolean(),
  cancelReason: CoreTextSchema.optional(),
  error: JobErrorDetailsSchema.optional(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  startedAt: z.string().datetime({ offset: true }).optional(),
  lastStartedAt: z.string().datetime({ offset: true }).optional(),
  finishedAt: z.string().datetime({ offset: true }).optional(),
  orphanedAt: z.string().datetime({ offset: true }).optional(),
}).strict();
export type Job = z.infer<typeof JobSchema>;

export const JobCreateParamsSchema = z.object({
  id: CoreIdentifierSchema.optional(),
  type: CoreIdentifierSchema.optional(),
  kind: CoreIdentifierSchema.optional(),
  payload: CoreJsonValueSchema.optional(),
  input: CoreJsonValueSchema.optional(),
  resources: ResourceRequestInputSchema.optional(),
  resourceRequest: ResourceRequestInputSchema.optional(),
  priority: PriorityInputSchema.optional(),
  resumable: z.boolean().optional(),
}).strict();
export type JobCreateParams = z.infer<typeof JobCreateParamsSchema>;
export const JobCreateResultSchema = JobSchema;
export type JobCreateResult = Job;

export const JobGetParamsSchema = z.object({ id: CoreIdentifierSchema }).strict();
export type JobGetParams = z.infer<typeof JobGetParamsSchema>;
export const JobGetResultSchema = JobSchema;
export type JobGetResult = Job;

export const JobCancelParamsSchema = z.object({
  id: CoreIdentifierSchema,
  reason: CoreTextSchema.optional(),
}).strict();
export type JobCancelParams = z.infer<typeof JobCancelParamsSchema>;
export const JobCancelResultSchema = JobSchema;
export type JobCancelResult = Job;

/** Project-memory contracts used by the local Studio Floor and CLI parity path. */
const MemoryPathSchema = z.string().min(1).max(4_096);
const MemoryIdSchema = z.string().min(1).max(256);
const MemoryTextSchema = z.string().max(4_096);

export const ProjectReindexParamsSchema = EmptyParamsSchema;
export type ProjectReindexParams = z.infer<typeof ProjectReindexParamsSchema>;
export const ProjectReindexResultSchema = z.object({
  databasePath: MemoryPathSchema,
  documents: z.number().int().nonnegative().max(100_000),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
export type ProjectReindexResult = z.infer<typeof ProjectReindexResultSchema>;

export const ProjectResumeDecisionSchema = z.object({
  id: MemoryIdSchema,
  title: MemoryTextSchema,
  status: z.enum(["proposed", "approved-by-human", "superseded"]),
  context: MemoryTextSchema,
  outcome: MemoryTextSchema,
  evidenceId: MemoryIdSchema.optional(),
  path: MemoryPathSchema,
}).strict();

export const ProjectResumeWorkOrderSchema = z.object({
  id: MemoryIdSchema,
  title: MemoryTextSchema,
  status: z.enum(["backlog", "ready", "in-progress", "blocked", "done"]),
  priority: z.number().int().min(1).max(9),
  acceptance: MemoryTextSchema,
  path: MemoryPathSchema,
}).strict();

export const ProjectResumeResultSchema = z.object({
  stage: MemoryTextSchema,
  gateGaps: z.array(MemoryTextSchema).max(256),
  topWorkOrders: z.array(ProjectResumeWorkOrderSchema).max(64),
  pendingHumanDecisions: z.array(ProjectResumeDecisionSchema).max(64),
  staleEvidence: z.array(MemoryPathSchema).max(256),
  spend: z.object({
    used: z.number().finite(),
    budget: z.number().finite(),
    currency: z.string().min(1).max(16),
  }).strict(),
  readiness: z.array(MemoryTextSchema).max(256),
  nextActions: z.array(MemoryTextSchema).max(256),
  tokenEstimate: z.number().int().nonnegative().max(2_500),
  byteLength: z.number().int().nonnegative().max(10_000),
}).strict();
export type ProjectResumeResult = z.infer<typeof ProjectResumeResultSchema>;

export const ProjectResumeParamsSchema = EmptyParamsSchema;
export type ProjectResumeParams = z.infer<typeof ProjectResumeParamsSchema>;

export const SystemPingParamsSchema = EmptyParamsSchema;
export type SystemPingParams = z.infer<typeof SystemPingParamsSchema>;

/**
 * Ping intentionally has a small stable core. The extra fields make a health
 * response useful to humans while remaining backwards-compatible with a
 * client that only consumes `ok`.
 */
export const SystemPingResultSchema = z
  .object({
    ok: z.literal(true).optional(),
    pong: z.literal(true).optional(),
    status: z.string().optional(),
    service: z.string().optional(),
    version: z.string().optional(),
    timestamp: z.string().datetime({ offset: true }).optional(),
  })
  .passthrough()
  .refine((value) => value.ok === true || value.pong === true, {
    message: "system.ping must report ok or pong",
  });
export type SystemPingResult = z.infer<typeof SystemPingResultSchema>;

export const SystemInfoParamsSchema = EmptyParamsSchema;
export type SystemInfoParams = z.infer<typeof SystemInfoParamsSchema>;

export const SystemInfoResultSchema = z
  .object({
    name: z.string().min(1),
    product: z.string().min(1).optional(),
    version: z.string().min(1),
    apiVersion: z.string().min(1).optional(),
    nodeVersion: z.string().min(1),
    /** `node` is retained as a compact alias for CLI consumers. */
    node: z.string().min(1).optional(),
    platform: z.string().min(1),
    arch: z.string().min(1).optional(),
    pid: z.number().int().nonnegative(),
    uptimeSeconds: z.number().nonnegative(),
    bind: z.string().min(1).optional(),
    port: z.number().int().nonnegative().optional(),
  })
  .passthrough();
export type SystemInfoResult = z.infer<typeof SystemInfoResultSchema>;

export const SystemPingRequestSchema = JsonRpcRequestSchema.extend({
  method: z.literal("system.ping"),
  params: SystemPingParamsSchema.optional(),
});
export type SystemPingRequest = z.infer<typeof SystemPingRequestSchema>;

export const SystemInfoRequestSchema = JsonRpcRequestSchema.extend({
  method: z.literal("system.info"),
  params: SystemInfoParamsSchema.optional(),
});
export type SystemInfoRequest = z.infer<typeof SystemInfoRequestSchema>;

export const SystemPingResponseSchema = z.union([
  JsonRpcSuccessResponseSchema.extend({ result: SystemPingResultSchema }),
  JsonRpcErrorResponseSchema,
]);
export type SystemPingResponse = z.infer<typeof SystemPingResponseSchema>;

export const SystemInfoResponseSchema = z.union([
  JsonRpcSuccessResponseSchema.extend({ result: SystemInfoResultSchema }),
  JsonRpcErrorResponseSchema,
]);
export type SystemInfoResponse = z.infer<typeof SystemInfoResponseSchema>;

export const SYSTEM_METHODS = ["system.ping", "system.info"] as const;
export type SystemMethod = (typeof SYSTEM_METHODS)[number];

/**
 * Every public Core API Zod contract has one explicit registry entry. The
 * registry is the source list for the checked-in JSON-Schema goldens; adding a
 * contract without adding its golden therefore fails the schemas contract
 * test instead of silently shrinking the published surface.
 */
export const CORE_API_SCHEMA_REGISTRY = {
  JsonRpcIdSchema,
  CallContextSchema,
  CoreCallContextSchema,
  CoreErrorCodeSchema,
  TypedErrorSchema,
  TypedErrorEnvelopeSchema,
  ErrorEnvelopeSchema,
  RpcErrorEnvelopeSchema,
  JsonRpcRequestSchema,
  CoreEventDataSchema,
  CoreEventSchema,
  JsonRpcErrorSchema,
  JsonRpcSuccessResponseSchema,
  JsonRpcErrorResponseSchema,
  JsonRpcResponseSchema,
  CoreJsonValueSchema,
  ResourceRequestSchema,
  ResourceRequestInputSchema,
  JobStateSchema,
  JobErrorDetailsSchema,
  JobSchema,
  JobCreateParamsSchema,
  JobCreateResultSchema,
  JobGetParamsSchema,
  JobGetResultSchema,
  JobCancelParamsSchema,
  JobCancelResultSchema,
  ProjectReindexParamsSchema,
  ProjectReindexResultSchema,
  ProjectResumeDecisionSchema,
  ProjectResumeWorkOrderSchema,
  ProjectResumeResultSchema,
  ProjectResumeParamsSchema,
  SystemPingParamsSchema,
  SystemPingResultSchema,
  SystemInfoParamsSchema,
  SystemInfoResultSchema,
  SystemPingRequestSchema,
  SystemPingResponseSchema,
  SystemInfoRequestSchema,
  SystemInfoResponseSchema,
  ...FORGE_SCHEMA_REGISTRY,
} as const;

export type CoreApiSchemaName = keyof typeof CORE_API_SCHEMA_REGISTRY;
