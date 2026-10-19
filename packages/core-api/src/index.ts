import { z } from "zod";
import {
  CoreEventSchema,
  JsonRpcRequestSchema,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcSuccessResponse,
  type JsonRpcResponse,
  type JsonRpcErrorResponse,
  type CallContext,
  type CoreEvent,
  TypedErrorSchema,
  type CoreErrorCode,
} from "@lightphysics/schemas";

export type { CallContext, CoreEvent } from "@lightphysics/schemas";

export type CoreMethodContext = Readonly<Record<string, unknown>>;

/** The deliberately parameter-free observation passed for an unknown method. */
export interface UnknownMethodObservation {
  readonly method: string;
  readonly id?: JsonRpcId;
  readonly context?: CallContext;
}

export type UnknownMethodObserver = (
  observation: UnknownMethodObservation,
) => void | Promise<void>;

export interface CoreErrorOptions {
  retryable?: boolean;
  suggestedNext?: string;
  details?: unknown;
  cause?: unknown;
  httpStatus?: number;
}

/** Base class for every error that can cross the Core API boundary. */
export class CoreError extends Error {
  readonly code: CoreErrorCode;
  readonly retryable: boolean;
  readonly suggestedNext: string | undefined;
  readonly details: unknown | undefined;
  readonly httpStatus: number;

  constructor(code: CoreErrorCode, message: string, options: CoreErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = code;
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.suggestedNext = options.suggestedNext;
    this.details = options.details;
    this.httpStatus = options.httpStatus ?? statusForCode(code);
  }
}

function statusForCode(code: CoreErrorCode): number {
  switch (code) {
    case "Unauthorized":
      return 401;
    case "PermissionDenied":
    case "OriginRejected":
      return 403;
    case "NotFound":
    case "MethodNotFound":
      return 404;
    case "ValidationError":
      return 400;
    case "Conflict":
      return 409;
    default:
      return 500;
  }
}

export class ValidationError extends CoreError {
  constructor(message: string, options: CoreErrorOptions = {}) {
    super("ValidationError", message, { ...options, httpStatus: options.httpStatus ?? 400 });
  }
}
export class NotFoundError extends CoreError {
  constructor(message: string, options: CoreErrorOptions = {}) {
    super("NotFound", message, { ...options, httpStatus: options.httpStatus ?? 404 });
  }
}
export class ConflictError extends CoreError {
  constructor(message: string, options: CoreErrorOptions = {}) {
    super("Conflict", message, { ...options, httpStatus: options.httpStatus ?? 409 });
  }
}
export class PermissionDeniedError extends CoreError {
  constructor(message: string, options: CoreErrorOptions = {}) {
    super("PermissionDenied", message, { ...options, httpStatus: options.httpStatus ?? 403 });
  }
}
export class ApprovalRequiredError extends CoreError {
  constructor(message: string, options: CoreErrorOptions = {}) {
    super("ApprovalRequired", message, options);
  }
}
export class BudgetExceededError extends CoreError {
  constructor(message: string, options: CoreErrorOptions = {}) {
    super("BudgetExceeded", message, options);
  }
}
export class ResourceUnavailableError extends CoreError {
  constructor(message: string, options: CoreErrorOptions = {}) {
    super("ResourceUnavailable", message, { ...options, retryable: options.retryable ?? true });
  }
}
export class ProviderError extends CoreError {
  constructor(message: string, options: CoreErrorOptions = {}) {
    super("ProviderError", message, { ...options, retryable: options.retryable ?? true });
  }
}
export class UnqualifiedError extends CoreError {
  constructor(message: string, options: CoreErrorOptions = {}) {
    super("Unqualified", message, options);
  }
}
export class EngineError extends CoreError {
  constructor(message: string, options: CoreErrorOptions = {}) {
    super("EngineError", message, options);
  }
}
export class StaleEvidenceError extends CoreError {
  constructor(message: string, options: CoreErrorOptions = {}) {
    super("StaleEvidence", message, options);
  }
}
export class CancelledError extends CoreError {
  constructor(message: string, options: CoreErrorOptions = {}) {
    super("Cancelled", message, options);
  }
}
export class NotImplementedError extends CoreError {
  constructor(message: string, options: CoreErrorOptions = {}) {
    super("NotImplemented", message, options);
  }
}
export class InternalError extends CoreError {
  constructor(message: string, options: CoreErrorOptions = {}) {
    super("Internal", message, { ...options, httpStatus: options.httpStatus ?? 500 });
  }
}
export class UnauthorizedError extends CoreError {
  constructor(message: string, options: CoreErrorOptions = {}) {
    super("Unauthorized", message, { ...options, httpStatus: options.httpStatus ?? 401 });
  }
}
export class OriginRejectedError extends CoreError {
  constructor(message: string, options: CoreErrorOptions = {}) {
    super("OriginRejected", message, { ...options, httpStatus: options.httpStatus ?? 403 });
  }
}
export class MethodNotFoundError extends CoreError {
  constructor(message: string, options: CoreErrorOptions = {}) {
    super("MethodNotFound", message, { ...options, httpStatus: options.httpStatus ?? 404 });
  }
}

export function isCoreError(error: unknown): error is CoreError {
  return error instanceof CoreError;
}

export function toTypedError(error: CoreError): z.infer<typeof TypedErrorSchema> {
  const candidate = {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    ...(error.suggestedNext ? { suggested_next: error.suggestedNext } : {}),
    ...(error.details === undefined ? {} : { details: error.details }),
  };
  return TypedErrorSchema.parse(candidate);
}

export function toErrorEnvelope(error: CoreError): {
  error: z.infer<typeof TypedErrorSchema>;
} {
  return { error: toTypedError(error) };
}

export function asCoreError(error: unknown): CoreError {
  if (isCoreError(error)) return error;
  // Do not put an arbitrary thrown error's message in a remote response. It
  // can contain a path, a credential, or another implementation detail.
  return new InternalError("The daemon encountered an internal error", {
    details: { thrown: error instanceof Error ? error.name : typeof error },
  });
}

export interface IdempotencyRecord {
  readonly method: string;
  readonly paramsFingerprint: string;
  readonly response: JsonRpcSuccessResponse;
}

/** A bounded store for successful mutating JSON-RPC responses. */
export interface IdempotencyStore {
  get(key: string): IdempotencyRecord | undefined;
  set(key: string, record: IdempotencyRecord): void;
}

export interface InMemoryIdempotencyStoreOptions {
  maxEntries?: number;
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, IdempotencyRecord>();
  private readonly maxEntries: number;

  constructor(options: InMemoryIdempotencyStoreOptions = {}) {
    const maxEntries = options.maxEntries ?? 1_024;
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new ValidationError("The idempotency store maxEntries must be a positive integer");
    }
    this.maxEntries = maxEntries;
  }

  get(key: string): IdempotencyRecord | undefined {
    return this.entries.get(key);
  }

  set(key: string, record: IdempotencyRecord): void {
    if (!this.entries.has(key) && this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, record);
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}

export type CoreEventListener = (event: CoreEvent) => void;

export const CORE_CALL_COMPLETED_EVENT = "core.call.completed" as const;

export interface CoreMethodDefinition<Params = unknown, Result = unknown> {
  method: string;
  params?: z.ZodType<Params>;
  result?: z.ZodType<Result>;
  mutating?: boolean;
  handler: (params: Params, context: CoreMethodContext) => Result | Promise<Result>;
}

export interface RegisteredMethod {
  method: string;
  params?: z.ZodTypeAny;
  result?: z.ZodTypeAny;
  mutating?: boolean;
  handler: (params: unknown, context: CoreMethodContext) => unknown;
}

export type RegisteredMethodSummary = Readonly<{
  method: string;
  mutating?: boolean;
}>;

/** A small explicit registry keeps method ownership visible at the composition root. */
export class MethodRegistry {
  private readonly methods = new Map<string, RegisteredMethod>();

  register<Params = unknown, Result = unknown>(
    definition: CoreMethodDefinition<Params, Result>,
  ): this;
  register<Params = unknown, Result = unknown>(
    method: string,
    definition: Omit<CoreMethodDefinition<Params, Result>, "method">,
  ): this;
  register<Params = unknown, Result = unknown>(
    method: string,
    handler: CoreMethodDefinition<Params, Result>["handler"],
  ): this;
  register<Params = unknown, Result = unknown>(
    first: string | CoreMethodDefinition<Params, Result>,
    second?:
      | Omit<CoreMethodDefinition<Params, Result>, "method">
      | CoreMethodDefinition<Params, Result>["handler"],
  ): this {
    const definition = typeof first === "string"
      ? typeof second === "function"
        ? { method: first, handler: second }
        : { ...second, method: first }
      : first;
    if (!definition || typeof definition.method !== "string" || !definition.handler) {
      throw new ValidationError("A method name and handler are required");
    }
    if (!/^[a-z][a-z0-9_.-]*$/i.test(definition.method)) {
      throw new ValidationError(`Invalid method name: ${definition.method}`);
    }
    if (this.methods.has(definition.method)) {
      throw new ConflictError(`Method already registered: ${definition.method}`);
    }
    this.methods.set(definition.method, {
      method: definition.method,
      ...(definition.params ? { params: definition.params } : {}),
      ...(definition.result ? { result: definition.result } : {}),
      ...(definition.mutating === undefined ? {} : { mutating: definition.mutating }),
      handler: definition.handler as (params: unknown, context: CoreMethodContext) => unknown,
    });
    return this;
  }

  get(method: string): RegisteredMethod | undefined {
    return this.methods.get(method);
  }

  has(method: string): boolean {
    return this.methods.has(method);
  }

  list(): RegisteredMethodSummary[] {
    return [...this.methods.keys()]
      .sort()
      .map((method) => {
        const registered = this.methods.get(method);
        return {
          method,
          ...(registered?.mutating === undefined ? {} : { mutating: registered.mutating }),
        };
      });
  }

  names(): string[] {
    return this.list().map(({ method }) => method);
  }

  listMethods(): string[] {
    return this.names();
  }
}

const JSON_RPC_CODE: Record<CoreErrorCode, number> = {
  ValidationError: -32602,
  NotFound: -32004,
  Conflict: -32009,
  PermissionDenied: -32003,
  ApprovalRequired: -32010,
  BudgetExceeded: -32011,
  ResourceUnavailable: -32012,
  ProviderError: -32013,
  Unqualified: -32014,
  EngineError: -32015,
  StaleEvidence: -32016,
  Cancelled: -32017,
  NotImplemented: -32018,
  Internal: -32603,
  Unauthorized: -32001,
  OriginRejected: -32002,
  MethodNotFound: -32601,
};

export function jsonRpcCodeFor(error: CoreError): number {
  return JSON_RPC_CODE[error.code];
}

export function toJsonRpcErrorResponse(
  id: JsonRpcId,
  error: CoreError,
): JsonRpcErrorResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: jsonRpcCodeFor(error),
      message: error.message,
      data: toTypedError(error),
    },
  };
}

export const errorResponse = toJsonRpcErrorResponse;

function stableSerialize(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "undefined":
      return "undefined";
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (Number.isNaN(value)) return "number:NaN";
      if (value === Infinity) return "number:Infinity";
      if (value === -Infinity) return "number:-Infinity";
      return Object.is(value, -0) ? "number:-0" : `number:${value}`;
    case "bigint":
      return `bigint:${value.toString()}`;
    case "symbol":
      return `symbol:${String(value)}`;
    case "function":
      return "function";
    case "object": {
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
      const serialized = Array.isArray(value)
        ? `[${value.map((item) => stableSerialize(item, seen)).join(",")}]`
        : `{${Object.keys(value)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${stableSerialize((value as Record<string, unknown>)[key], seen)}`)
            .join(",")}}`;
      seen.delete(value);
      return serialized;
    }
    default:
      return "unknown";
  }
}

function idempotencyScope(context: CallContext): string {
  return JSON.stringify([context.session_id, context.idempotency_key]);
}

function responseForRequest(
  response: JsonRpcSuccessResponse,
  id: JsonRpcId,
): JsonRpcSuccessResponse {
  // Replays preserve the result, but JSON-RPC still requires the response id
  // to identify the request that is currently being answered. Keep the exact
  // cached object when the id is unchanged for a cheap common path.
  return Object.is(response.id, id) ? response : { ...response, id };
}

export interface DispatcherOptions {
  context?: CoreMethodContext;
  idempotencyStore?: IdempotencyStore;
  /** Injectable clock keeps event timestamps deterministic in focused tests. */
  now?: () => Date;
  /** Observes parsed unknown methods without exposing request parameters. */
  onUnknownMethod?: UnknownMethodObserver;
  /** Descriptive alias for embedders that prefer option-named callbacks. */
  unknownMethodObserver?: UnknownMethodObserver;
}

type InFlightOutcome =
  | { response: JsonRpcSuccessResponse }
  | { error: CoreError };

interface InFlightIdempotentCall {
  method: string;
  paramsFingerprint: string;
  outcome: Promise<InFlightOutcome>;
  resolve: (outcome: InFlightOutcome) => void;
}

export class Dispatcher {
  readonly registry: MethodRegistry;
  readonly idempotencyStore: IdempotencyStore;
  private readonly options: DispatcherOptions;
  private readonly listeners = new Set<CoreEventListener>();
  private readonly inFlight = new Map<string, InFlightIdempotentCall>();
  private eventSequence = 0;

  constructor(
    registry: MethodRegistry,
    options: DispatcherOptions = {},
  ) {
    this.registry = registry;
    this.options = options;
    this.idempotencyStore = options.idempotencyStore ?? new InMemoryIdempotencyStore();
  }

  subscribe(listener: CoreEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.unsubscribe(listener);
    };
  }

  unsubscribe(listener: CoreEventListener): boolean {
    return this.listeners.delete(listener);
  }

  private emitCompletedEvent(request: JsonRpcRequest): void {
    const event = CoreEventSchema.parse({
      event_id: `core-event-${++this.eventSequence}`,
      event_name: CORE_CALL_COMPLETED_EVENT,
      timestamp: (this.options.now?.() ?? new Date()).toISOString(),
      ...(request.id === undefined ? {} : { request_id: request.id }),
      method: request.method,
      ...(request.context === undefined ? {} : { context: request.context }),
      data: { ok: true },
    });

    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Subscribers are observers. A faulty observer cannot turn a
        // successful Core call into an error or expose its thrown value.
      }
    }
  }

  async dispatch(rawRequest: unknown): Promise<JsonRpcResponse | null> {
    const parsed = JsonRpcRequestSchema.safeParse(rawRequest);
    if (!parsed.success) {
      return toJsonRpcErrorResponse(null, new ValidationError("Invalid JSON-RPC request", {
        details: { issues: parsed.error.issues.map(({ path, code }) => ({ path, code })) },
      }));
    }

    const request = parsed.data;
    const notification = request.id === undefined;
    const id = request.id ?? null;
    const method = this.registry.get(request.method);
    if (!method) {
      try {
        await (this.options.onUnknownMethod ?? this.options.unknownMethodObserver)?.({
          method: request.method,
          ...(request.id === undefined ? {} : { id: request.id }),
          ...(request.context === undefined ? {} : { context: request.context }),
        });
      } catch (error) {
        // Observers are infrastructure hooks. Do not expose their thrown
        // values, but preserve the one static detail used by the Ledger audit
        // seam so an unavailable audit remains distinguishable to callers.
        const details = error instanceof CoreError
          && error.code === "Internal"
          && error.details
          && typeof error.details === "object"
          && !Array.isArray(error.details)
          && (error.details as Record<string, unknown>).reason === "audit_unavailable"
          ? { reason: "audit_unavailable" }
          : { reason: "unknown_method_observer_failed" };
        const observerError = new InternalError(
          details.reason === "audit_unavailable"
            ? "The daemon could not record the audit"
            : "The daemon encountered an internal error",
          { details },
        );
        return notification ? null : toJsonRpcErrorResponse(id, observerError);
      }
      return notification
        ? null
        : toJsonRpcErrorResponse(id, new MethodNotFoundError(`Method not found: ${request.method}`));
    }

    let mutationContext: CallContext | undefined;
    if (method.mutating === true) {
      const context = request.context;
      if (
        !context
        || !context.session_id
        || !context.trace_id
        || !context.idempotency_key
      ) {
        return notification
          ? null
          : toJsonRpcErrorResponse(id, new ValidationError(
              "Mutating methods require context.session_id, context.trace_id, and context.idempotency_key",
              { details: { method: request.method } },
            ));
      }
      mutationContext = context;
    }

    const params = method.params
      ? method.params.safeParse(request.params === undefined ? {} : request.params)
      : { success: true as const, data: request.params };
    if (!params.success) {
      return notification
        ? null
        : toJsonRpcErrorResponse(id, new ValidationError("Invalid method parameters", {
            details: { issues: params.error.issues.map(({ path, code }) => ({ path, code })) },
          }));
    }

    let idempotency:
      | { key: string; paramsFingerprint: string }
      | undefined;
    if (method.mutating === true && mutationContext) {
      idempotency = {
        key: idempotencyScope(mutationContext),
        paramsFingerprint: stableSerialize(params.data),
      };
      const cached = this.idempotencyStore.get(idempotency.key);
      if (cached) {
        if (
          cached.method !== request.method
          || cached.paramsFingerprint !== idempotency.paramsFingerprint
        ) {
          return notification
            ? null
            : toJsonRpcErrorResponse(id, new ConflictError(
                "Idempotency key was already used with a different method or parameters",
                { details: { reason: "idempotency_key_reuse" } },
              ));
        }
        if (notification) return null;
        this.emitCompletedEvent(request);
        return responseForRequest(cached.response, id);
      }

      const inFlight = this.inFlight.get(idempotency.key);
      if (inFlight) {
        if (
          inFlight.method !== request.method
          || inFlight.paramsFingerprint !== idempotency.paramsFingerprint
        ) {
          return notification
            ? null
            : toJsonRpcErrorResponse(id, new ConflictError(
                "Idempotency key was already used with a different method or parameters",
                { details: { reason: "idempotency_key_reuse" } },
              ));
        }
        const outcome = await inFlight.outcome;
        if ("error" in outcome) {
          return notification ? null : toJsonRpcErrorResponse(id, outcome.error);
        }
        if (notification) return null;
        this.emitCompletedEvent(request);
        return responseForRequest(outcome.response, id);
      }
    }

    let inFlight: InFlightIdempotentCall | undefined;
    if (idempotency) {
      let resolve!: (outcome: InFlightOutcome) => void;
      const outcome = new Promise<InFlightOutcome>((resolveOutcome) => {
        resolve = resolveOutcome;
      });
      inFlight = {
        method: request.method,
        paramsFingerprint: idempotency.paramsFingerprint,
        outcome,
        resolve,
      };
      this.inFlight.set(idempotency.key, inFlight);
    }

    try {
      const result = await method.handler(
        params.data,
        request.context === undefined
          ? this.options.context ?? {}
          : {
              ...(this.options.context ?? {}),
              ...request.context,
            },
      );
      const checkedResult = method.result
        ? method.result.safeParse(result)
        : { success: true as const, data: result };
      if (!checkedResult.success) {
        throw new InternalError("Method returned an invalid result", {
          details: { method: request.method },
        });
      }
      const response: JsonRpcSuccessResponse = {
        jsonrpc: "2.0",
        id,
        result: checkedResult.data,
      };
      if (idempotency) {
        this.idempotencyStore.set(idempotency.key, {
          method: request.method,
          paramsFingerprint: idempotency.paramsFingerprint,
          response,
        });
      }
      if (idempotency && inFlight) {
        this.inFlight.delete(idempotency.key);
        inFlight.resolve({ response });
      }
      if (notification) return null;
      this.emitCompletedEvent(request);
      return response;
    } catch (error) {
      const coreError = asCoreError(error);
      if (idempotency && inFlight) {
        this.inFlight.delete(idempotency.key);
        inFlight.resolve({ error: coreError });
      }
      return notification ? null : toJsonRpcErrorResponse(id, coreError);
    }
  }

  handle(rawRequest: unknown): Promise<JsonRpcResponse | null> {
    return this.dispatch(rawRequest);
  }

  dispatchRequest(rawRequest: unknown): Promise<JsonRpcResponse | null> {
    return this.dispatch(rawRequest);
  }
}

export const MethodDispatcher = Dispatcher;

export function createDispatcher(
  registry: MethodRegistry,
  options: DispatcherOptions = {},
): Dispatcher {
  return new Dispatcher(registry, options);
}

// The source package is executed directly by Node's strip-types runner in the
// local daemon and CLI. Keep the explicit `.ts` extension here so that the
// source export works both before and after a future build step.
export * from "./client.ts";
