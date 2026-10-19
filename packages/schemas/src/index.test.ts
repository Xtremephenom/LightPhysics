import { describe, expect, it } from "vitest";
import {
  CallContextSchema,
  CoreEventSchema,
  JobCancelParamsSchema,
  JobCreateParamsSchema,
  JobGetParamsSchema,
  JsonRpcRequestSchema,
  JsonRpcResponseSchema,
  SystemInfoResponseSchema,
  SystemPingResponseSchema,
  TypedErrorEnvelopeSchema,
} from "./index.js";

describe("schema contracts", () => {
  it("accepts a JSON-RPC request and a typed success response", () => {
    const request = JsonRpcRequestSchema.parse({
      jsonrpc: "2.0",
      id: 1,
      method: "system.ping",
      params: {},
    });
    expect(request.method).toBe("system.ping");

    const response = SystemPingResponseSchema.parse({
      jsonrpc: "2.0",
      id: 1,
      result: { ok: true, service: "lpd" },
    });
    expect(response).toMatchObject({ id: 1 });
  });

  it("accepts a typed JSON-RPC error without a stack", () => {
    const envelope = TypedErrorEnvelopeSchema.parse({
      error: {
        code: "ValidationError",
        message: "bad params",
        retryable: false,
        suggested_next: "Fix the request",
      },
    });
    expect(envelope.error.retryable).toBe(false);

    expect(
      JsonRpcResponseSchema.parse({
        jsonrpc: "2.0",
        id: 1,
        error: {
          code: -32602,
          message: "Invalid params",
          data: envelope.error,
        },
      }),
    ).toBeTruthy();
  });

  it("validates the strict call context and keeps it optional for old calls", () => {
    expect(
      CallContextSchema.parse({
        session_id: "session-1",
        trace_id: "trace-1",
        role: "designer",
        work_order: "wo-1",
        idempotency_key: "request-1",
      }),
    ).toMatchObject({ session_id: "session-1", trace_id: "trace-1" });

    expect(() =>
      CallContextSchema.parse({
        session_id: "session-1",
        trace_id: "trace-1",
        extra: true,
      }),
    ).toThrow();
    expect(() =>
      CallContextSchema.parse({ session_id: "", trace_id: "trace-1" }),
    ).toThrow();

    expect(
      JsonRpcRequestSchema.parse({
        jsonrpc: "2.0",
        id: 2,
        method: "system.info",
      }),
    ).not.toHaveProperty("context");
  });

  it("accepts a compact core event and rejects unknown event fields", () => {
    expect(
      CoreEventSchema.parse({
        event_id: "core-event-1",
        event_name: "core.call.completed",
        timestamp: "2026-01-01T00:00:00.000Z",
        request_id: 1,
        method: "system.info",
        context: { session_id: "session-1", trace_id: "trace-1" },
        data: { ok: true },
      }),
    ).toMatchObject({ event_name: "core.call.completed", data: { ok: true } });

    expect(() =>
      CoreEventSchema.parse({
        event_id: "core-event-1",
        event_name: "core.call.completed",
        timestamp: "2026-01-01T00:00:00.000Z",
        unexpected: "field",
      }),
    ).toThrow();
  });

  it("keeps system.info and system.ping response contracts distinct", () => {
    expect(() =>
      SystemInfoResponseSchema.parse({
        jsonrpc: "2.0",
        id: 1,
        result: { ok: true },
      }),
    ).toThrow();
    expect(() =>
      SystemPingResponseSchema.parse({
        jsonrpc: "2.0",
        id: 1,
        result: {
          name: "lpd",
          version: "0.1.0",
          nodeVersion: "v22.0.0",
          platform: "linux",
          pid: 1,
          uptimeSeconds: 0,
        },
      }),
    ).toThrow();
  });

  it("defines the bounded Runner job method contracts without accepting secrets", () => {
    expect(JobCreateParamsSchema.parse({
      id: "job-1",
      type: "render",
      payload: { scene: "test" },
      resources: { vramMb: 256, ramMb: 512 },
    })).toMatchObject({ id: "job-1", type: "render" });
    expect(JobGetParamsSchema.parse({ id: "job-1" })).toEqual({ id: "job-1" });
    expect(JobCancelParamsSchema.parse({ id: "job-1", reason: "stop" })).toEqual({ id: "job-1", reason: "stop" });
    expect(() => JobCreateParamsSchema.parse({ payload: { providerToken: "secret-value" } })).toThrow();
    expect(() => JobCreateParamsSchema.parse({ payload: "x".repeat(64 * 1024 + 1) })).toThrow();
    expect(() => JobCreateParamsSchema.parse({ id: "" })).toThrow();
  });
});
