import http from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { URL } from "node:url";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  getBearerToken,
  isLoopbackBind,
  loadConfig,
  type LightPhysicsConfig,
} from "@lightphysics/config";
import {
  ApprovalRequiredError as CoreApprovalRequiredError,
  BudgetExceededError as CoreBudgetExceededError,
  ConflictError,
  CoreError,
  Dispatcher,
  InternalError,
  MethodRegistry,
  NotFoundError,
  OriginRejectedError,
  PermissionDeniedError as CorePermissionDeniedError,
  UnauthorizedError,
  ValidationError,
  type CoreMethodContext,
  type UnknownMethodObservation,
} from "@lightphysics/core-api";
import { createLogger, type Logger } from "@lightphysics/logging";
import {
  JobJournal,
  RunnerError,
  Supervisor,
  type SupervisorKillAllResult,
  type SupervisorOptions,
} from "@lightphysics/runner";
import {
  MemoryConflictError,
  MemoryValidationError,
  projectResume,
  reindexProject,
} from "@lightphysics/memory";
import type { Ledger } from "@lightphysics/ledger";
import {
  JobCancelParamsSchema,
  JobCancelResultSchema,
  JobCreateParamsSchema,
  JobCreateResultSchema,
  JobGetParamsSchema,
  JobGetResultSchema,
  JsonRpcResponseSchema,
  ProjectReindexParamsSchema,
  ProjectReindexResultSchema,
  ProjectResumeParamsSchema,
  ProjectResumeResultSchema,
  SystemInfoParamsSchema,
  SystemInfoResultSchema,
  SystemPingParamsSchema,
  SystemPingResultSchema,
  TypedErrorEnvelopeSchema,
  TypedErrorSchema,
  type JsonRpcResponse,
  type SystemInfoResult,
  type SystemPingResult,
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
  type PermissionClass,
} from "@lightphysics/warden";
import { z } from "zod";
import {
  createForgeRuntime,
  type ForgeRouter,
  type ForgeRuntimeOptions,
} from "./forge-runtime.ts";
import type { ForgeAdapter } from "@lightphysics/forge";

export const LPD_VERSION = "0.1.0";
export const LPD_DEFAULT_PATH = "/rpc";
const MAX_REQUEST_BYTES = 1_048_576;
const GUI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "gui");
const GUI_ASSETS: Readonly<Record<string, { file: string; contentType: string }>> = {
  "/": { file: "index.html", contentType: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", contentType: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", contentType: "text/javascript; charset=utf-8" },
  "/styles.css": { file: "styles.css", contentType: "text/css; charset=utf-8" },
};
const GUI_HEADERS = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

export interface ServerOptions {
  config?: LightPhysicsConfig;
  env?: NodeJS.ProcessEnv;
  token?: string;
  authToken?: string;
  /** Defaults to true. Only tests or an explicitly embedded trusted caller should disable it. */
  requireAuth?: boolean;
  /** Bounded in-memory limiter for invalid HTTP/WS bearer attempts. */
  authFailureRateLimit?: AuthFailureRateLimitOptions;
  /** Compatibility alias for embedders that call this the auth rate limit. */
  authRateLimit?: AuthFailureRateLimitOptions;
  bind?: string;
  port?: number;
  logger?: Logger;
  registry?: MethodRegistry;
  dispatcher?: Dispatcher;
  /** Optional deterministic Runner seam. Without it the journal is lazy and LP_HOME-backed. */
  journal?: JobJournal;
  /** Compatibility alias for embedders that name the dependency explicitly. */
  jobJournal?: JobJournal;
  /** Optional deterministic process-supervisor seams; Warden revocation is server-owned. */
  supervisorOptions?: Omit<SupervisorOptions, "tokenRevocation">;
  /** Optional Warden session-id authorization for the built-in job methods. */
  warden?: WardenSessionManager;
  /** Optional caller-owned Ledger sink for bounded Warden decision audits. */
  ledger?: Ledger;
  /** Source-of-truth game repository for project-memory methods. */
  projectRoot?: string;
  version?: string;
  context?: CoreMethodContext;
  /** Optional Phase 2 Forge composition seams. */
  forge?: ForgeRuntimeOptions;
  forgeAdapters?: readonly ForgeAdapter[];
  forgeRouter?: ForgeRouter;
  forgeDataPolicy?: ForgeRuntimeOptions["dataPolicy"];
  forgeSpend?: ForgeRuntimeOptions["spend"];
  forgeProjectId?: string;
}

export interface AuthFailureRateLimitOptions {
  /** Invalid attempts allowed per client during one window. Defaults to 5. */
  maxFailures?: number;
  /** Duration of the failure window in milliseconds. Defaults to 60 seconds. */
  windowMs?: number;
  /** Maximum number of client identities retained in memory. Defaults to 1024. */
  maxEntries?: number;
  /** Injectable wall clock in milliseconds for deterministic tests. */
  clock?: () => number;
  /** Alias for clock, useful for callers that use Date.now-style terminology. */
  now?: () => number;
}

export interface LpdServer extends http.Server {
  readonly config: LightPhysicsConfig;
  readonly authToken: string;
  readonly registry: MethodRegistry;
  readonly dispatcher: Dispatcher;
  readonly logger: Logger;
  readonly webSocketServer: WebSocketServer;
  readonly requireAuth: boolean;
  /** Effective listen values; port 0 is replaced with the actual port after listen. */
  listenBind: string;
  listenPort: number;
  readonly projectRoot: string;
  readonly supervisor: Supervisor;
  /** Stop all tracked process trees, then revoke active Warden sessions. */
  killAll(options?: { readonly timeoutMs?: number }): Promise<SupervisorKillAllResult>;
}

export interface LpdAddress {
  host: string;
  port: number;
}

function validatePort(port: number): number {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new ValidationError("The daemon port must be an integer between 0 and 65535");
  }
  return port;
}

function validateBind(bind: string, config: LightPhysicsConfig): string {
  const normalized = bind.trim();
  if (!normalized) throw new ValidationError("The daemon bind address is required");
  if (!config.inContainer && !isLoopbackBind(normalized)) {
    throw new ValidationError(
      "The daemon binds to loopback outside a container",
    );
  }
  return normalized;
}

function validateProjectRoot(value: string | undefined): string {
  const root = value ?? process.cwd();
  if (typeof root !== "string" || root.length === 0 || root.includes("\0")) {
    throw new ValidationError("The project root is invalid");
  }
  return path.resolve(root);
}

function actualPort(server: http.Server, fallback: number): number {
  const address = server.address();
  return address && typeof address === "object" ? address.port : fallback;
}

function loopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function parseHostHeader(hostHeader: string): { hostname: string; port?: number | undefined } | null {
  try {
    const parsed = new URL(`http://${hostHeader}`);
    const port = parsed.port ? Number(parsed.port) : undefined;
    return { hostname: parsed.hostname, port };
  } catch {
    return null;
  }
}

function validHost(req: IncomingMessage, server: LpdServer): boolean {
  const hostHeader = req.headers.host;
  // HTTP/1.0 clients can omit Host. They cannot be used for DNS rebinding, so
  // allow the absence while rejecting any explicit non-loopback host.
  if (!hostHeader) return true;
  const parsed = parseHostHeader(hostHeader);
  if (!parsed || !loopbackHostname(parsed.hostname)) return false;
  if (parsed.port === undefined) return true;
  return parsed.port === actualPort(server, server.listenPort);
}

function validOrigin(req: IncomingMessage, server: LpdServer): boolean {
  const originHeader = req.headers.origin;
  if (!originHeader) return true;
  const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
  if (!origin || origin === "null") return false;
  try {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    if (parsed.username || parsed.password || !loopbackHostname(parsed.hostname)) {
      return false;
    }
    if (!parsed.port) return true;
    return Number(parsed.port) === actualPort(server, server.listenPort);
  } catch {
    return false;
  }
}

function tokensMatch(expected: string, received: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const receivedBytes = Buffer.from(received);
  return (
    expectedBytes.length === receivedBytes.length &&
    timingSafeEqual(expectedBytes, receivedBytes)
  );
}

function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header || Array.isArray(header)) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1];
}

const DEFAULT_AUTH_FAILURES = 5;
const DEFAULT_AUTH_FAILURE_WINDOW_MS = 60_000;
const DEFAULT_AUTH_FAILURE_ENTRIES = 1_024;
const MAX_AUTH_FAILURES = 100_000;
const MAX_AUTH_FAILURE_WINDOW_MS = 86_400_000;
const MAX_AUTH_FAILURE_ENTRIES = 100_000;

interface AuthFailureState {
  failures: number;
  startedAt: number;
  lastSeenAt: number;
}

interface AuthFailureResult {
  limited: boolean;
  retryAfterMs: number;
}

function positiveIntegerOption(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new ValidationError(`${name} must be an integer between 1 and ${maximum}`);
  }
  return resolved;
}

/**
 * Tracks failures only; successful authentication removes the client entry.
 * The key is the peer address from Node's socket, never a caller-controlled
 * forwarding header. Both expiry and an entry cap keep this state bounded.
 */
class AuthFailureRateLimiter {
  private readonly failures: number;
  private readonly windowMs: number;
  private readonly maxEntries: number;
  private readonly clock: () => number;
  private readonly entries = new Map<string, AuthFailureState>();

  constructor(options: AuthFailureRateLimitOptions = {}) {
    this.failures = positiveIntegerOption(
      options.maxFailures,
      DEFAULT_AUTH_FAILURES,
      MAX_AUTH_FAILURES,
      "auth failure limit",
    );
    this.windowMs = positiveIntegerOption(
      options.windowMs,
      DEFAULT_AUTH_FAILURE_WINDOW_MS,
      MAX_AUTH_FAILURE_WINDOW_MS,
      "auth failure window",
    );
    this.maxEntries = positiveIntegerOption(
      options.maxEntries,
      DEFAULT_AUTH_FAILURE_ENTRIES,
      MAX_AUTH_FAILURE_ENTRIES,
      "auth failure entry limit",
    );
    const clock = options.clock ?? options.now ?? Date.now;
    if (typeof clock !== "function") {
      throw new ValidationError("auth failure clock must be a function");
    }
    this.clock = clock;
  }

  private currentTime(): number {
    const now = this.clock();
    if (!Number.isFinite(now)) throw new ValidationError("auth failure clock must return a finite number");
    return now;
  }

  private prune(now: number): void {
    for (const [identity, state] of this.entries) {
      if (now >= state.startedAt + this.windowMs) this.entries.delete(identity);
    }
  }

  private evictOldest(): void {
    let oldestIdentity: string | undefined;
    let oldestSeen = Number.POSITIVE_INFINITY;
    for (const [identity, state] of this.entries) {
      if (state.lastSeenAt < oldestSeen) {
        oldestIdentity = identity;
        oldestSeen = state.lastSeenAt;
      }
    }
    if (oldestIdentity !== undefined) this.entries.delete(oldestIdentity);
  }

  recordFailure(identity: string): AuthFailureResult {
    const now = this.currentTime();
    this.prune(now);
    let state = this.entries.get(identity);
    if (state === undefined) {
      if (this.entries.size >= this.maxEntries) this.evictOldest();
      state = { failures: 0, startedAt: now, lastSeenAt: now };
      this.entries.set(identity, state);
    }
    if (state.failures >= this.failures) {
      return {
        limited: true,
        retryAfterMs: Math.max(1, state.startedAt + this.windowMs - now),
      };
    }
    state.failures += 1;
    state.lastSeenAt = now;
    return { limited: false, retryAfterMs: state.startedAt + this.windowMs - now };
  }

  clear(identity: string): void {
    this.entries.delete(identity);
  }
}

function clientIdentity(req: IncomingMessage): string {
  // remoteAddress is assigned by Node from the actual peer socket. In
  // particular, X-Forwarded-For and Forwarded are deliberately ignored.
  const address = req.socket.remoteAddress;
  if (!address) return "unknown";
  return address.toLowerCase().replace(/^::ffff:/, "");
}

function authenticationRejection(
  req: IncomingMessage,
  server: LpdServer,
  limiter: AuthFailureRateLimiter | undefined,
): { error: UnauthorizedError; retryAfter?: string } | undefined {
  if (!server.requireAuth) return undefined;
  const identity = clientIdentity(req);
  const received = bearerToken(req);
  if (received && tokensMatch(server.authToken, received)) {
    limiter?.clear(identity);
    return undefined;
  }
  const result = limiter?.recordFailure(identity);
  if (result?.limited) {
    return {
      error: new UnauthorizedError(
        "Too many authentication failures; try again later",
        { retryable: true, httpStatus: 429 },
      ),
      retryAfter: String(Math.max(1, Math.ceil(result.retryAfterMs / 1_000))),
    };
  }
  return { error: new UnauthorizedError("Bearer authentication is required") };
}

function jsonResponse(
  res: ServerResponse,
  status: number,
  value: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

async function serveGuiAsset(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const asset = GUI_ASSETS[pathname];
  if (!asset) return false;
  if (req.method !== "GET" && req.method !== "HEAD") {
    jsonResponse(
      res,
      405,
      httpErrorEnvelope(new ValidationError("Only GET and HEAD are supported for GUI assets")),
      { allow: "GET, HEAD" },
    );
    return true;
  }
  try {
    const body = await readFile(path.join(GUI_ROOT, asset.file));
    res.writeHead(200, {
      ...GUI_HEADERS,
      "content-type": asset.contentType,
      "content-length": body.byteLength,
    });
    if (req.method === "HEAD") res.end();
    else res.end(body);
  } catch {
    jsonResponse(res, 500, httpErrorEnvelope(new CoreError("Internal", "The GUI asset is unavailable")));
  }
  return true;
}

function rpcTransportError(
  id: null,
  error: CoreError,
  code: number,
): JsonRpcResponse {
  return JsonRpcResponseSchema.parse({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message: error.message,
      data: TypedErrorSchema.parse({
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        ...(error.suggestedNext ? { suggested_next: error.suggestedNext } : {}),
      }),
    },
  });
}

function httpErrorEnvelope(error: CoreError): unknown {
  return TypedErrorEnvelopeSchema.parse({
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.suggestedNext ? { suggested_next: error.suggestedNext } : {}),
    },
  });
}

function rejectUpgrade(
  socket: Duplex,
  status: number,
  message: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  const body = `${message}\n`;
  const reason = status === 401
    ? "Unauthorized"
    : status === 403
      ? "Forbidden"
      : status === 429
        ? "Too Many Requests"
        : "Not Found";
  const headers = Object.entries(extraHeaders)
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join("");
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\n` +
    "Connection: close\r\n" +
    "Content-Type: text/plain; charset=utf-8\r\n" +
    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
    headers +
    `\r\n${body}`,
  );
  socket.destroy();
}

function websocketSend(socket: WebSocket, value: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}

async function handleWebSocketMessage(
  socket: WebSocket,
  data: RawData,
  dispatcher: Dispatcher,
): Promise<void> {
  let request: unknown;
  try {
    request = JSON.parse(data.toString()) as unknown;
  } catch {
    const error = new ValidationError("RPC message must contain valid JSON");
    websocketSend(socket, rpcTransportError(null, error, -32700));
    return;
  }
  const response = await dispatcher.dispatch(request);
  if (response !== null) websocketSend(socket, response);
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      total += Buffer.byteLength(chunk);
      if (total > MAX_REQUEST_BYTES) {
        reject(new ValidationError("RPC request body is too large"));
        req.destroy();
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    req.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.once("error", reject);
  });
}

function systemRegistry(
  config: LightPhysicsConfig,
  version: string,
  getPort: () => number,
  getBind: () => string = () => config.bind,
): MethodRegistry {
  const registry = new MethodRegistry();
  registry.register<z.infer<typeof SystemPingParamsSchema>, SystemPingResult>({
    method: "system.ping",
    params: SystemPingParamsSchema,
    result: SystemPingResultSchema,
    handler: () => ({
      ok: true,
      status: "ok",
      service: "lpd",
      version,
      timestamp: new Date().toISOString(),
    }),
  });
  registry.register<z.infer<typeof SystemInfoParamsSchema>, SystemInfoResult>({
    method: "system.info",
    params: SystemInfoParamsSchema,
    result: SystemInfoResultSchema,
    handler: () => ({
      name: "lpd",
      product: "LightPhysics",
      version,
      apiVersion: "0.1",
      nodeVersion: process.version,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      uptimeSeconds: process.uptime(),
      bind: getBind(),
      port: getPort(),
    }),
  });
  return registry;
}

function runnerErrorToCore(error: unknown): CoreError {
  if (!(error instanceof RunnerError)) {
    const code = error instanceof Error && "code" in error
      ? (error as Error & { code?: unknown }).code
      : undefined;
    if (code === "GovernorValidationError") {
      return new ValidationError(error instanceof Error ? error.message : "Invalid Runner resource request");
    }
    if (code === "GovernorConflict") {
      return new ConflictError(error instanceof Error ? error.message : "Runner resource request conflicts with existing work");
    }
    return new InternalError("The daemon encountered an internal Runner error", {
      details: { thrown: error instanceof Error ? error.name : typeof error },
    });
  }
  switch (error.code) {
    case "RunnerNotFound":
      return new NotFoundError(error.message, { details: error.details });
    case "RunnerValidationError":
    case "SensitiveDataRejected":
      return new ValidationError(error.message, { details: error.details });
    case "RunnerConflict":
    case "IllegalJobTransition":
      return new ConflictError(error.message, { details: error.details });
    case "RunnerClosed":
    case "RunnerStorageError":
    case "JobNotResumable":
    case "CancellationNotRequested":
      return new InternalError("The daemon could not complete the Runner operation", {
        details: { runner_code: error.code },
      });
    default:
      return new InternalError("The daemon could not complete the Runner operation", {
        details: { runner_code: error.code },
      });
  }
}

function memoryErrorToCore(error: unknown): CoreError {
  if (error instanceof MemoryConflictError) {
    return new ConflictError("The project memory record conflicts with existing source-of-truth data");
  }
  if (error instanceof MemoryValidationError) {
    return new ValidationError("The project memory operation is invalid");
  }
  return new InternalError("The daemon could not complete the project memory operation", {
    details: { thrown: error instanceof Error ? error.name : typeof error },
  });
}

function boundedWardenMessage(error: WardenError, fallback: string): string {
  const message = error.message.trim();
  if (!message) return fallback;
  return message.length > 256 ? message.slice(0, 256) : message;
}

function wardenDetails(
  error: WardenError,
  allowedKeys: readonly string[],
): Readonly<Record<string, unknown>> | undefined {
  if (!error.details) return undefined;
  const details: Record<string, unknown> = {};
  for (const key of allowedKeys) {
    const value = error.details[key];
    if (typeof value === "string" && value.length <= 64) details[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) details[key] = value;
  }
  return Object.keys(details).length === 0 ? undefined : details;
}

function wardenErrorToCore(error: unknown): CoreError {
  if (error instanceof WardenPermissionDeniedError) {
    return new CorePermissionDeniedError(boundedWardenMessage(
      error,
      "The Warden session is not permitted to perform this action",
    ), { details: wardenDetails(error, ["permission"]) });
  }
  if (error instanceof WardenApprovalRequiredError) {
    return new CoreApprovalRequiredError(boundedWardenMessage(
      error,
      "Human approval is required for this action",
    ), { details: wardenDetails(error, ["permission"]) });
  }
  if (error instanceof WardenBudgetExceededError) {
    return new CoreBudgetExceededError(boundedWardenMessage(
      error,
      "The configured spend budget would be exceeded",
    ), { details: wardenDetails(error, ["limit", "used", "remaining"]) });
  }
  if (
    error instanceof WardenUnauthorizedError
    || error instanceof SessionExpiredError
    || error instanceof SessionRevokedError
  ) {
    return new UnauthorizedError("The Warden session is not valid");
  }
  if (error instanceof WardenValidationError) {
    return new ValidationError(boundedWardenMessage(error, "Invalid Warden authorization request"));
  }
  if (error instanceof WardenError) {
    return new InternalError("The daemon encountered an internal Warden error", {
      details: { warden_code: (error as WardenError).code },
    });
  }
  return new InternalError("The daemon encountered an internal Warden error", {
    details: { thrown: error instanceof Error ? error.name : typeof error },
  });
}

const MAX_AUDIT_FIELD_BYTES = 128;

type WardenAuditOutcome =
  | "allowed"
  | "permission_denied"
  | "approval_required"
  | "expired"
  | "revoked"
  | "unauthorized"
  | "validation_error"
  | "budget_exceeded"
  | "failed";

interface WardenAuditDecision {
  readonly outcome: WardenAuditOutcome;
  readonly code: string;
}

function boundedAuditField(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const bytes = Buffer.from(value, "utf8");
  const bounded = bytes.byteLength <= MAX_AUDIT_FIELD_BYTES
    ? value
    : bytes.subarray(0, MAX_AUDIT_FIELD_BYTES).toString("utf8").replace(/\uFFFD$/, "");
  const sanitized = bounded.replace(/[\u0000-\u001F\u007F]/g, "?");
  return sanitized.length === 0 ? undefined : sanitized;
}

function auditSessionId(
  warden: WardenSessionManager,
  value: unknown,
): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  // Only persist a value Warden recognizes as an opaque session id. An
  // unrecognized value may be a bearer token supplied in the wrong field.
  try {
    const session = warden.getSession(value);
    return session?.id === value ? boundedAuditField(value) : undefined;
  } catch {
    return undefined;
  }
}

function auditTraceId(
  warden: WardenSessionManager,
  value: unknown,
): string | undefined {
  if (typeof value !== "string" || /^Bearer\s+\S+$/i.test(value)) return undefined;
  const bounded = boundedAuditField(value);
  if (bounded === undefined) return undefined;
  // Trace context is caller supplied. Do not persist a Warden bearer even if
  // it was misplaced into trace_id; expired and revoked credentials are still
  // recognized by validateToken for this redaction check.
  try {
    warden.validateToken(value);
    return undefined;
  } catch (error) {
    if (error instanceof SessionExpiredError || error instanceof SessionRevokedError) {
      return undefined;
    }
  }
  return bounded;
}

function auditDecisionForError(error: unknown, mapped: CoreError): WardenAuditDecision {
  if (error instanceof SessionExpiredError) return { outcome: "expired", code: error.code };
  if (error instanceof SessionRevokedError) return { outcome: "revoked", code: error.code };
  if (error instanceof WardenPermissionDeniedError) {
    return { outcome: "permission_denied", code: error.code };
  }
  if (error instanceof WardenApprovalRequiredError) {
    return { outcome: "approval_required", code: error.code };
  }
  if (error instanceof WardenUnauthorizedError) {
    return { outcome: "unauthorized", code: error.code };
  }
  if (error instanceof WardenBudgetExceededError) {
    return { outcome: "budget_exceeded", code: error.code };
  }
  if (error instanceof WardenValidationError) {
    return { outcome: "validation_error", code: error.code };
  }
  if (error instanceof WardenError) return { outcome: "failed", code: error.code };
  switch (mapped.code) {
    case "PermissionDenied":
      return { outcome: "permission_denied", code: mapped.code };
    case "ApprovalRequired":
      return { outcome: "approval_required", code: mapped.code };
    case "Unauthorized":
      return { outcome: "unauthorized", code: mapped.code };
    case "ValidationError":
      return { outcome: "validation_error", code: mapped.code };
    case "BudgetExceeded":
      return { outcome: "budget_exceeded", code: mapped.code };
    default:
      return { outcome: "failed", code: mapped.code };
  }
}

function auditPayloadJson(payload: Readonly<Record<string, string>>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(payload).sort()));
}

const APPROVAL_ATTEMPT_METHOD = /^(?:approval|approve|lp_approval|gate\.approve|approval\.submit)(?:[._-][a-z0-9_.-]{1,63})?$/i;

function isApprovalAttemptMethod(method: string): boolean {
  return Buffer.byteLength(method, "utf8") <= MAX_AUDIT_FIELD_BYTES
    && APPROVAL_ATTEMPT_METHOD.test(method);
}

function approvalAuditTraceId(
  warden: WardenSessionManager | undefined,
  value: unknown,
): string | undefined {
  // Without Warden there is no credential registry against which a caller
  // supplied trace can be checked, so omitting it is safer than persisting a
  // misplaced bearer token as if it were a trace id.
  return warden === undefined ? undefined : auditTraceId(warden, value);
}

function appendApprovalAttemptAudit(
  ledger: Ledger,
  warden: WardenSessionManager | undefined,
  observation: UnknownMethodObservation,
): void {
  if (!isApprovalAttemptMethod(observation.method)) return;

  const method = boundedAuditField(observation.method);
  if (method === undefined) return;
  const context = observation.context;
  const sessionId = warden === undefined
    ? undefined
    : auditSessionId(warden, context?.session_id);
  const traceId = approvalAuditTraceId(warden, context?.trace_id);
  // The identity is hashed and is never persisted as payload. It deliberately
  // uses only the parsed request envelope, since unknown-method observers do
  // not receive params.
  const identity = JSON.stringify(context === undefined
    ? {
        method: observation.method,
        request_id: observation.id === undefined ? "notification" : observation.id,
      }
    : {
        method: observation.method,
        session_id: context.session_id,
        trace_id: context.trace_id,
        idempotency_key: context.idempotency_key ?? "",
      });
  const auditId = `warden-approval-attempt-${createHash("sha256").update(identity, "utf8").digest("hex")}`;
  const payload: Record<string, string> = {
    event_kind: "warden.approval_attempt",
    method,
    outcome: "rejected",
    code: "MethodNotFound",
    ...(sessionId === undefined ? {} : { session_id: sessionId }),
    ...(traceId === undefined ? {} : { trace_id: traceId }),
  };

  try {
    ledger.appendAudit(auditId, payload);
    return;
  } catch {
    // A committed retry is safe only when the existing payload is byte-for-byte
    // the same bounded event. Any other storage result is unavailable.
    try {
      const existing = ledger.getAudit(auditId);
      if (existing?.payloadJson === auditPayloadJson(payload)) return;
    } catch {
      // Normalize all storage details below.
    }
    throw new InternalError("The daemon could not record the audit", {
      details: { reason: "audit_unavailable" },
    });
  }
}

function appendWardenAudit(
  ledger: Ledger,
  warden: WardenSessionManager,
  method: string,
  permission: PermissionClass,
  context: CoreMethodContext,
  decision: WardenAuditDecision,
): void {
  const rawSessionId = typeof context.session_id === "string" ? context.session_id : undefined;
  const rawTraceId = typeof context.trace_id === "string" ? context.trace_id : undefined;
  const rawIdempotencyKey = typeof context.idempotency_key === "string" ? context.idempotency_key : undefined;
  const sessionId = auditSessionId(warden, rawSessionId);
  const traceId = auditTraceId(warden, rawTraceId);
  const identity = JSON.stringify({
    method,
    permission,
    session_id: rawSessionId ?? "",
    trace_id: rawTraceId ?? "",
    idempotency_key: rawIdempotencyKey ?? "",
  });
  const auditId = `warden-decision-${createHash("sha256").update(identity, "utf8").digest("hex")}`;
  const payload: Record<string, string> = {
    event_kind: "warden.permission_decision",
    method,
    permission,
    outcome: decision.outcome,
    code: decision.code,
    ...(sessionId === undefined ? {} : { session_id: sessionId }),
    ...(traceId === undefined ? {} : { trace_id: traceId }),
  };

  try {
    ledger.appendAudit(auditId, payload);
    return;
  } catch {
    // A deterministic identity makes a retry after a committed append safe.
    // Only an exact payload match is accepted; all other Ledger failures stay
    // visible as a typed error and cannot be mistaken for an authorized call.
    try {
      const existing = ledger.getAudit(auditId);
      if (existing?.payloadJson === auditPayloadJson(payload)) return;
    } catch {
      // Normalize all Ledger failures below without exposing storage details.
    }
    throw new InternalError("The daemon could not record the Warden permission decision", {
      details: { reason: "audit_unavailable" },
    });
  }
}

function authorizeJob(
  warden: WardenSessionManager,
  ledger: Ledger | undefined,
  method: string,
  context: CoreMethodContext,
  permission: PermissionClass,
): void {
  let authorizationError: CoreError | undefined;
  let authorizationCause: unknown;
  try {
    const sessionId = context.session_id;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new ValidationError("Warden authorization requires context.session_id");
    }
    warden.authorizeSessionOrThrow(sessionId, { permission });
  } catch (error) {
    authorizationCause = error;
    authorizationError = error instanceof CoreError ? error : wardenErrorToCore(error);
  }

  if (ledger) {
    appendWardenAudit(
      ledger,
      warden,
      method,
      permission,
      context,
      authorizationError === undefined
        ? { outcome: "allowed", code: "Allowed" }
        : auditDecisionForError(authorizationCause, authorizationError),
    );
  }
  if (authorizationError) throw authorizationError;
}

function registerJobMethods(
  registry: MethodRegistry,
  getJournal: () => JobJournal,
  warden?: WardenSessionManager,
  ledger?: Ledger,
): void {
  registry.register({
    method: "job.create",
    mutating: true,
    params: JobCreateParamsSchema,
    result: JobCreateResultSchema,
    handler: (params, context) => {
      if (warden) authorizeJob(warden, ledger, "job.create", context, "write_project");
      try {
        return getJournal().createJob(params as Parameters<JobJournal["createJob"]>[0]);
      } catch (error) {
        throw runnerErrorToCore(error);
      }
    },
  });
  registry.register({
    method: "job.get",
    params: JobGetParamsSchema,
    result: JobGetResultSchema,
    handler: (params, context) => {
      if (warden) authorizeJob(warden, ledger, "job.get", context, "read");
      try {
        return getJournal().requireJob((params as { id: string }).id);
      } catch (error) {
        throw runnerErrorToCore(error);
      }
    },
  });
  registry.register({
    method: "job.cancel",
    mutating: true,
    params: JobCancelParamsSchema,
    result: JobCancelResultSchema,
    handler: (params, context) => {
      if (warden) authorizeJob(warden, ledger, "job.cancel", context, "write_project");
      try {
        const value = params as { id: string; reason?: string };
        return getJournal().cancel(value.id, value.reason);
      } catch (error) {
        throw runnerErrorToCore(error);
      }
    },
  });
}

function registerProjectMethods(
  registry: MethodRegistry,
  getProjectRoot: () => string,
  warden?: WardenSessionManager,
  ledger?: Ledger,
): void {
  registry.register({
    method: "project.reindex",
    mutating: true,
    params: ProjectReindexParamsSchema,
    result: ProjectReindexResultSchema,
    handler: async (_params, context) => {
      if (warden) authorizeJob(warden, ledger, "project.reindex", context, "write_project");
      try {
        return ProjectReindexResultSchema.parse(await reindexProject(getProjectRoot()));
      } catch (error) {
        throw memoryErrorToCore(error);
      }
    },
  });
  registry.register({
    method: "project.resume",
    params: ProjectResumeParamsSchema,
    result: ProjectResumeResultSchema,
    handler: async (_params, context) => {
      if (warden) authorizeJob(warden, ledger, "project.resume", context, "read");
      try {
        return ProjectResumeResultSchema.parse(await projectResume(getProjectRoot()));
      } catch (error) {
        throw memoryErrorToCore(error);
      }
    },
  });
}

function makeAuthToken(options: ServerOptions): { token: string; required: boolean } {
  const required = options.requireAuth ?? true;
  if (!required) return { token: "", required: false };
  const configured = options.token ?? options.authToken ?? getBearerToken(options.env);
  // A generated token makes an accidentally exposed daemon unusable while
  // keeping the reusable API safe by default. startServer returns it on the
  // server handle for embedding callers; it is never logged or put in info.
  return {
    token: configured && configured.length > 0
      ? configured
      : randomBytes(32).toString("hex"),
    required: true,
  };
}

function revokeWardenSessions(warden: WardenSessionManager): boolean {
  // Session views never contain bearer tokens. Revoke through Warden's
  // existing per-session boundary so Runner remains Warden-independent.
  for (const session of warden.listSessions()) warden.revokeSession(session.id);
  return true;
}

export function createServer(options: ServerOptions = {}): LpdServer {
  const config = options.config ?? loadConfig(options.env);
  const projectRoot = validateProjectRoot(options.projectRoot);
  const logger = options.logger ?? createLogger({
    level: config.logLevel,
    format: config.logFormat,
  });
  const auth = makeAuthToken(options);
  if (typeof logger.registerSecret === "function") logger.registerSecret(auth.token);
  const requestedBind = options.bind ?? config.bind;
  const requestedPort = options.port ?? config.port;
  const bind = validateBind(requestedBind, config);
  const port = validatePort(requestedPort);
  const version = options.version ?? LPD_VERSION;
  const authFailureRateLimiter = auth.required
    ? new AuthFailureRateLimiter(options.authFailureRateLimit ?? options.authRateLimit)
    : undefined;

  let journal = options.journal ?? options.jobJournal;
  const ownsJournal = journal === undefined;
  const getJournal = (): JobJournal => {
    journal ??= new JobJournal({ home: config.home });
    return journal;
  };

  const warden = options.warden;
  const supervisor = new Supervisor({
    ...options.supervisorOptions,
    ...(warden === undefined
      ? {}
      : { tokenRevocation: () => revokeWardenSessions(warden) }),
  });

  let server!: LpdServer;
  const registry = options.registry ?? systemRegistry(
    config,
    version,
    () => actualPort(server, port),
    () => server.listenBind,
  );
  if (!options.registry) {
    registerJobMethods(registry, getJournal, options.warden, options.ledger);
    registerProjectMethods(registry, () => projectRoot, options.warden, options.ledger);
    const forgeLedger = options.forge?.ledger ?? options.ledger;
    const forgeWarden = options.forge?.warden ?? options.warden;
    const forgeOptions: ForgeRuntimeOptions = {
      ...(options.forge ?? {}),
      ...(options.forgeAdapters === undefined ? {} : { adapters: options.forgeAdapters }),
      ...(options.forgeRouter === undefined ? {} : { router: options.forgeRouter }),
      ...(options.forgeDataPolicy === undefined ? {} : { dataPolicy: options.forgeDataPolicy }),
      ...(options.forgeSpend === undefined ? {} : { spend: options.forgeSpend }),
      ...(options.forgeProjectId === undefined ? {} : { projectId: options.forgeProjectId }),
      ...(forgeLedger === undefined ? {} : { ledger: forgeLedger }),
      ...(forgeWarden === undefined ? {} : { warden: forgeWarden }),
    };
    createForgeRuntime(forgeOptions).register(registry);
  }
  const dispatcher = options.dispatcher ?? new Dispatcher(registry, {
    context: {
      ...(options.context ?? {}),
      config,
      logger,
    },
    ...(options.ledger === undefined
      ? {}
      : {
          onUnknownMethod: (observation: UnknownMethodObservation) => {
            appendApprovalAttemptAudit(options.ledger as Ledger, options.warden, observation);
          },
        }),
  });

  const requestHandler = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    if (!validHost(req, server) || !validOrigin(req, server)) {
      const error = new OriginRejectedError("Host or Origin is not allowed");
      jsonResponse(res, error.httpStatus, rpcTransportError(null, error, -32002));
      return;
    }
    if (requestUrl.pathname !== LPD_DEFAULT_PATH) {
      if (await serveGuiAsset(req, res, requestUrl.pathname)) return;
      jsonResponse(res, 404, httpErrorEnvelope(new CoreError("NotFound", "Not found")));
      return;
    }
    if (req.method !== "POST") {
      jsonResponse(
        res,
        405,
        httpErrorEnvelope(new ValidationError("Only POST /rpc is supported")),
        { allow: "POST" },
      );
      return;
    }
    const authentication = authenticationRejection(req, server, authFailureRateLimiter);
    if (authentication) {
      jsonResponse(
        res,
        authentication.error.httpStatus,
        rpcTransportError(null, authentication.error, -32001),
        {
          "www-authenticate": "Bearer",
          ...(authentication.retryAfter === undefined ? {} : { "retry-after": authentication.retryAfter }),
        },
      );
      return;
    }

    let request: unknown;
    try {
      const body = await readBody(req);
      request = JSON.parse(body) as unknown;
    } catch (error) {
      const typed = error instanceof CoreError
        ? error
        : new ValidationError("RPC request must contain valid JSON");
      jsonResponse(res, typed.httpStatus, rpcTransportError(null, typed, -32700));
      return;
    }

    const response = await dispatcher.dispatch(request);
    if (response === null) {
      res.writeHead(204, { "cache-control": "no-store" });
      res.end();
      return;
    }
    jsonResponse(res, 200, response);
  };

  server = http.createServer((req, res) => {
    void requestHandler(req, res).catch((error: unknown) => {
      logger.error("RPC request failed", { error });
      if (!res.headersSent) {
        const typed = new CoreError("Internal", "The daemon encountered an internal error");
        jsonResponse(res, 500, rpcTransportError(null, typed, -32603));
      } else {
        res.destroy();
      }
    });
  }) as LpdServer;

  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_REQUEST_BYTES,
  });
  webSocketServer.on("connection", (socket) => {
    socket.on("message", (data) => {
      void handleWebSocketMessage(socket, data, dispatcher).catch(() => {
        const error = new CoreError("Internal", "The daemon encountered an internal error");
        websocketSend(socket, rpcTransportError(null, error, -32603));
      });
    });
  });
  server.on("upgrade", (req, socket, head) => {
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    if (requestUrl.pathname !== LPD_DEFAULT_PATH) {
      rejectUpgrade(socket, 404, "Not found");
      return;
    }
    if (!validHost(req, server) || !validOrigin(req, server)) {
      rejectUpgrade(socket, 403, "Host or Origin is not allowed");
      return;
    }
    const authentication = authenticationRejection(req, server, authFailureRateLimiter);
    if (authentication) {
      rejectUpgrade(
        socket,
        authentication.error.httpStatus,
        authentication.error.httpStatus === 429
          ? "Too many authentication failures; try again later"
          : "Bearer authentication is required",
        authentication.retryAfter === undefined ? {} : { "Retry-After": authentication.retryAfter },
      );
      return;
    }
    webSocketServer.handleUpgrade(req, socket, head, (client) => {
      webSocketServer.emit("connection", client, req);
    });
  });
  server.once("close", () => {
    for (const client of webSocketServer.clients) client.close(1001, "daemon closed");
    webSocketServer.close();
    if (ownsJournal && journal) journal.close();
  });

  Object.assign(server, {
    config,
    authToken: auth.token,
    registry,
    dispatcher,
    logger,
    webSocketServer,
    requireAuth: auth.required,
    listenBind: bind,
    listenPort: port,
    projectRoot,
    supervisor,
    killAll: (killOptions?: { readonly timeoutMs?: number }) => supervisor.killAll(killOptions),
  });
  return server;
}

export interface StartServerOptions extends ServerOptions {
  signal?: AbortSignal;
}

function isLpdServer(value: unknown): value is LpdServer {
  return value instanceof http.Server;
}

export async function startServer(options?: StartServerOptions): Promise<LpdServer>;
export async function startServer(
  server: LpdServer,
  options?: Omit<StartServerOptions, "config" | "token" | "authToken" | "logger" | "registry" | "dispatcher">,
): Promise<LpdServer>;
export async function startServer(
  first: LpdServer | StartServerOptions = {},
  second: Omit<StartServerOptions, "config" | "token" | "authToken" | "logger" | "registry" | "dispatcher"> = {},
): Promise<LpdServer> {
  const server = isLpdServer(first) ? first : createServer(first);
  const options = isLpdServer(first) ? second : first;
  if (server.listening) return server;
  if (options.bind !== undefined) {
    server.listenBind = validateBind(options.bind, server.config);
  }
  if (options.port !== undefined) server.listenPort = validatePort(options.port);
  if (options.signal?.aborted) throw new Error("Server start was aborted");

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      const address = server.address();
      if (address && typeof address === "object") server.listenPort = address.port;
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    if (options.signal) {
      options.signal.addEventListener(
        "abort",
        () => server.close(),
        { once: true },
      );
    }
    server.listen(server.listenPort, server.listenBind);
  });
  return server;
}

export function serverAddress(server: LpdServer): LpdAddress | null {
  const address = server.address();
  if (!address) return null;
  if (typeof address === "string") return { host: address, port: server.listenPort };
  const info = address as AddressInfo;
  return { host: info.address, port: info.port };
}

export function createSystemRegistry(
  config = loadConfig(),
  version = LPD_VERSION,
): MethodRegistry {
  const port = config.port;
  return systemRegistry(config, version, () => port);
}
