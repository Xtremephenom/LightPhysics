import {
  JsonRpcResponseSchema,
  type CallContext,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "@lightphysics/schemas";
import type { Dispatcher } from "./index.js";

/** The result returned by a Core client. Notifications intentionally have no response. */
export type CoreClientResponse = JsonRpcResponse | null;

/** JSON-RPC requests are the schema-first Core client input contract. */
export type CoreClientRequest = JsonRpcRequest;

/**
 * Transport-independent access to the Core API.
 *
 * The request overload keeps the JSON-RPC envelope visible to callers. The
 * method overload is a small convenience for facades that do not need to
 * choose an id; it creates a normal request id and returns the same envelope.
 */
export interface CoreClient {
  call(request: CoreClientRequest): Promise<CoreClientResponse>;
  call(method: string, params?: unknown, context?: CallContext): Promise<CoreClientResponse>;
}

function requestForCall(
  requestOrMethod: CoreClientRequest | string,
  params: unknown,
  context: CallContext | undefined,
  nextRequestId: () => number,
): CoreClientRequest {
  if (typeof requestOrMethod !== "string") return requestOrMethod;

  return {
    jsonrpc: "2.0",
    id: nextRequestId(),
    method: requestOrMethod,
    ...(params === undefined ? {} : { params }),
    ...(context === undefined ? {} : { context }),
  };
}

/** A Core client that invokes the existing dispatcher without a transport hop. */
export class InProcessClient implements CoreClient {
  private nextId = 1;
  readonly dispatcher: Pick<Dispatcher, "dispatch">;

  constructor(dispatcher: Pick<Dispatcher, "dispatch">) {
    this.dispatcher = dispatcher;
  }

  call(request: CoreClientRequest): Promise<CoreClientResponse>;
  call(method: string, params?: unknown, context?: CallContext): Promise<CoreClientResponse>;
  call(
    requestOrMethod: CoreClientRequest | string,
    params?: unknown,
    context?: CallContext,
  ): Promise<CoreClientResponse> {
    const request = requestForCall(requestOrMethod, params, context, () => this.nextId++);
    return this.dispatcher.dispatch(request);
  }
}

/** The narrow fetch shape keeps RemoteClient straightforward to fake offline. */
export interface CoreFetchInit {
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** The response members used by RemoteClient; `json` supports small test fakes. */
export interface CoreFetchResponse {
  readonly status: number;
  readonly ok?: boolean;
  readonly text?: () => Promise<string>;
  readonly json?: () => Promise<unknown>;
}

export type CoreFetch = (
  input: string,
  init: CoreFetchInit,
) => Promise<CoreFetchResponse>;

export type RemoteClientErrorKind = "network" | "request" | "malformed-response" | "http";

export interface RemoteClientErrorOptions {
  readonly kind: RemoteClientErrorKind;
  readonly status?: number;
  readonly cause?: unknown;
}

/** Errors raised before a valid JSON-RPC response can cross the client boundary. */
export class RemoteClientError extends Error {
  readonly kind: RemoteClientErrorKind;
  readonly status: number | undefined;

  constructor(message: string, options: RemoteClientErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "RemoteClientError";
    this.kind = options.kind;
    this.status = options.status;
  }
}

export interface RemoteClientOptions {
  readonly url: string | URL;
  readonly fetch?: CoreFetch;
  readonly token?: string;
  /** Alias for callers that name the credential by its HTTP role. */
  readonly bearerToken?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

type RemoteClientConstructorOptions = Omit<RemoteClientOptions, "url">;

function defaultFetch(): CoreFetch {
  const implementation = globalThis.fetch;
  if (typeof implementation !== "function") {
    throw new RemoteClientError("This runtime does not provide fetch", { kind: "network" });
  }
  return implementation.bind(globalThis) as unknown as CoreFetch;
}

function endpointUrl(value: string | URL): string {
  let parsed: URL;
  try {
    parsed = value instanceof URL ? new URL(value.toString()) : new URL(value);
  } catch (error) {
    throw new RemoteClientError("RemoteClient requires a valid HTTP URL", {
      kind: "request",
      cause: error,
    });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new RemoteClientError("RemoteClient requires an HTTP or HTTPS URL", {
      kind: "request",
    });
  }
  return parsed.toString();
}

function responseIsOk(response: CoreFetchResponse): boolean {
  return response.ok ?? (response.status >= 200 && response.status < 300);
}

function responseStatus(response: CoreFetchResponse): number | undefined {
  return Number.isInteger(response.status) && response.status >= 100 && response.status <= 599
    ? response.status
    : undefined;
}

function malformedResponse(message: string, status: number | undefined, cause?: unknown): RemoteClientError {
  return new RemoteClientError(message, {
    kind: "malformed-response",
    ...(status === undefined ? {} : { status }),
    ...(cause === undefined ? {} : { cause }),
  });
}

function httpResponseError(message: string, status: number | undefined, cause?: unknown): RemoteClientError {
  return new RemoteClientError(message, {
    kind: "http",
    ...(status === undefined ? {} : { status }),
    ...(cause === undefined ? {} : { cause }),
  });
}

/** A JSON-RPC HTTP client. The fetch implementation is injectable for offline parity tests. */
export class RemoteClient implements CoreClient {
  readonly url: string;
  readonly token: string | undefined;
  private readonly fetchImpl: CoreFetch;
  private readonly headers: Readonly<Record<string, string>>;
  private nextId = 1;

  constructor(options: RemoteClientOptions);
  constructor(url: string | URL, options?: RemoteClientConstructorOptions);
  constructor(
    optionsOrUrl: RemoteClientOptions | string | URL,
    constructorOptions: RemoteClientConstructorOptions = {},
  ) {
    const options = typeof optionsOrUrl === "string" || optionsOrUrl instanceof URL
      ? { ...constructorOptions, url: optionsOrUrl }
      : optionsOrUrl;
    this.url = endpointUrl(options.url);
    this.token = (options.token ?? options.bearerToken)?.trim() || undefined;
    this.fetchImpl = options.fetch ?? defaultFetch();
    this.headers = {
      accept: "application/json",
      "content-type": "application/json",
      ...(options.headers ?? {}),
      ...(this.token === undefined ? {} : { authorization: `Bearer ${this.token}` }),
    };
  }

  call(request: CoreClientRequest): Promise<CoreClientResponse>;
  call(method: string, params?: unknown, context?: CallContext): Promise<CoreClientResponse>;
  async call(
    requestOrMethod: CoreClientRequest | string,
    params?: unknown,
    context?: CallContext,
  ): Promise<CoreClientResponse> {
    const request = requestForCall(requestOrMethod, params, context, () => this.nextId++);
    let body: string;
    try {
      body = JSON.stringify(request);
    } catch (error) {
      throw new RemoteClientError("Core request could not be serialized as JSON", {
        kind: "request",
        cause: error,
      });
    }

    let response: CoreFetchResponse;
    try {
      response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: this.headers,
        body,
      });
    } catch (error) {
      if (error instanceof RemoteClientError) throw error;
      throw new RemoteClientError("Unable to reach the Core API endpoint", {
        kind: "network",
        cause: error,
      });
    }

    return this.parseResponse(response, request);
  }

  private async parseResponse(
    response: CoreFetchResponse,
    request: CoreClientRequest,
  ): Promise<CoreClientResponse> {
    if (response === null || typeof response !== "object") {
      throw malformedResponse("Remote endpoint returned an invalid response object", undefined);
    }
    const status = responseStatus(response);
    const ok = responseIsOk(response);

    if (status === undefined) {
      throw malformedResponse("Remote endpoint returned an invalid HTTP status", undefined);
    }

    let payload: unknown;
    if (typeof response.text === "function") {
      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        throw new RemoteClientError("Unable to read the Core API response", {
          kind: "network",
          status,
          cause: error,
        });
      }
      if (!text.trim()) {
        if (request.id === undefined && status === 204) return null;
        throw (ok
          ? malformedResponse("Remote endpoint returned an empty JSON-RPC response", status)
          : httpResponseError("Remote endpoint returned an empty HTTP error response", status));
      }
      try {
        payload = JSON.parse(text) as unknown;
      } catch (error) {
        throw (ok
          ? malformedResponse("Remote endpoint returned invalid JSON", status, error)
          : httpResponseError("Remote endpoint returned an invalid HTTP error response", status, error));
      }
    } else if (typeof response.json === "function") {
      try {
        payload = await response.json();
      } catch (error) {
        throw (ok
          ? malformedResponse("Remote endpoint returned invalid JSON", status, error)
          : httpResponseError("Remote endpoint returned an invalid HTTP error response", status, error));
      }
    } else {
      throw malformedResponse("Remote endpoint did not provide a readable response body", status);
    }

    if (payload === null && request.id === undefined && status === 204) return null;

    const parsed = JsonRpcResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw (ok
        ? malformedResponse("Remote endpoint returned an invalid JSON-RPC response", status)
        : httpResponseError("Remote endpoint returned an invalid HTTP error response", status));
    }

    if (request.id !== undefined && !Object.is(parsed.data.id, request.id)) {
      throw (ok
        ? malformedResponse("Remote endpoint returned a response for a different request id", status)
        : httpResponseError("Remote endpoint returned an HTTP error for a different request id", status));
    }
    return parsed.data;
  }
}

async function runScenario(
  client: CoreClient,
  scenario: readonly CoreClientRequest[],
): Promise<CoreClientResponse[]> {
  const responses: CoreClientResponse[] = [];
  for (const request of scenario) responses.push(await client.call(request));
  return responses;
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

/** Compare response sequences without depending on object insertion order. */
export function coreResponsesEqual(
  first: readonly CoreClientResponse[],
  second: readonly CoreClientResponse[],
): boolean {
  return canonicalJson(first) === canonicalJson(second);
}

export interface CoreParityResult {
  readonly inProcess: readonly CoreClientResponse[];
  readonly remote: readonly CoreClientResponse[];
  readonly equal: boolean;
}

/** Run one deterministic request script through both Core transports. */
export async function runCoreParityScenario(
  inProcess: CoreClient,
  remote: CoreClient,
  scenario: readonly CoreClientRequest[],
): Promise<CoreParityResult> {
  const inProcessResponses = await runScenario(inProcess, scenario);
  const remoteResponses = await runScenario(remote, scenario);
  return {
    inProcess: inProcessResponses,
    remote: remoteResponses,
    equal: coreResponsesEqual(inProcessResponses, remoteResponses),
  };
}

/** Test-only-friendly assertion helper that keeps the parity harness dependency-free. */
export async function assertCoreClientParity(
  inProcess: CoreClient,
  remote: CoreClient,
  scenario: readonly CoreClientRequest[],
): Promise<CoreParityResult> {
  const result = await runCoreParityScenario(inProcess, remote, scenario);
  if (!result.equal) throw new Error("Core client responses differ between transports");
  return result;
}
