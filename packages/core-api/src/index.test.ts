import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ConflictError,
  Dispatcher,
  InMemoryIdempotencyStore,
  MethodRegistry,
  NotImplementedError,
  ValidationError,
  type CoreEvent,
} from "./index.js";

describe("core API registry and dispatcher", () => {
  it("registers schema-first methods and dispatches typed results", async () => {
    const registry = new MethodRegistry();
    registry.register({
      method: "system.ping",
      params: z.object({}).strict(),
      result: z.object({ ok: z.boolean() }),
      handler: () => ({ ok: true }),
    });
    const dispatcher = new Dispatcher(registry);
    await expect(
      dispatcher.dispatch({
        jsonrpc: "2.0",
        id: 7,
        method: "system.ping",
        params: {},
      }),
    ).resolves.toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: { ok: true },
    });
  });

  it("returns typed validation and method-not-found errors", async () => {
    const registry = new MethodRegistry();
    registry.register({
      method: "system.echo",
      params: z.object({ value: z.string() }),
      result: z.string(),
      handler: ({ value }) => value,
    });
    const dispatcher = new Dispatcher(registry);

    const invalid = await dispatcher.dispatch({
      jsonrpc: "2.0",
      id: 1,
      method: "system.echo",
      params: { value: 4 },
    });
    expect(invalid).toMatchObject({
      error: {
        data: { code: "ValidationError", retryable: false },
      },
    });

    const missing = await dispatcher.dispatch({
      jsonrpc: "2.0",
      id: 2,
      method: "system.missing",
      params: {},
    });
    expect(missing).toMatchObject({
      error: { data: { code: "MethodNotFound" } },
    });
  });

  it("observes unknown methods without exposing params and keeps notification semantics", async () => {
    const registry = new MethodRegistry();
    const observations: unknown[] = [];
    const dispatcher = new Dispatcher(registry, {
      onUnknownMethod: (observation) => { observations.push(observation); },
    });
    const params = { signature: "private", reason: "do not copy" };

    await expect(dispatcher.dispatch({
      jsonrpc: "2.0",
      id: 20,
      method: "approval.submit",
      params,
      context: { session_id: "session-1", trace_id: "trace-1" },
    })).resolves.toMatchObject({ error: { data: { code: "MethodNotFound" } } });
    await expect(dispatcher.dispatch({
      jsonrpc: "2.0",
      method: "approval.submit",
      params,
    })).resolves.toBeNull();

    expect(observations).toEqual([
      {
        method: "approval.submit",
        id: 20,
        context: { session_id: "session-1", trace_id: "trace-1" },
      },
      { method: "approval.submit" },
    ]);
    expect(JSON.stringify(observations)).not.toContain("private");
    expect(JSON.stringify(observations)).not.toContain("do not copy");
  });

  it("turns an unknown-method observer failure into a safe Internal error", async () => {
    const dispatcher = new Dispatcher(new MethodRegistry(), {
      onUnknownMethod: () => { throw new Error("private storage path"); },
    });
    await expect(dispatcher.dispatch({
      jsonrpc: "2.0",
      id: 21,
      method: "approval",
      params: { secret: "hidden" },
    })).resolves.toMatchObject({
      error: {
        code: -32603,
        data: {
          code: "Internal",
          details: { reason: "unknown_method_observer_failed" },
        },
      },
    });
    await expect(dispatcher.dispatch({
      jsonrpc: "2.0",
      method: "approval",
    })).resolves.toBeNull();
  });

  it("observes ordinary unknown methods for the composition root to classify", async () => {
    const observed: string[] = [];
    const dispatcher = new Dispatcher(new MethodRegistry(), {
      onUnknownMethod: ({ method }) => { observed.push(method); },
    });
    await dispatcher.dispatch({ jsonrpc: "2.0", id: 22, method: "system.missing" });
    expect(observed).toEqual(["system.missing"]);
  });

  it("enforces duplicate registration and typed thrown errors", async () => {
    const registry = new MethodRegistry();
    registry.register({
      method: "system.fail",
      result: z.string(),
      handler: () => {
        throw new NotImplementedError("Not available in Phase 0", {
          suggestedNext: "Use the walking skeleton methods",
        });
      },
    });
    expect(() =>
      registry.register({ method: "system.fail", handler: () => "x" }),
    ).toThrow(ConflictError);

    const result = await new Dispatcher(registry).dispatch({
      jsonrpc: "2.0",
      id: 1,
      method: "system.fail",
    });
    expect(result).toMatchObject({
      error: {
        data: {
          code: "NotImplemented",
          suggested_next: "Use the walking skeleton methods",
        },
      },
    });
  });

  it("does not return a response for notifications", async () => {
    const registry = new MethodRegistry();
    registry.register({
      method: "system.noop",
      params: z.object({}).strict(),
      handler: () => undefined,
    });
    await expect(
      new Dispatcher(registry).dispatch({
        jsonrpc: "2.0",
        method: "system.noop",
        params: {},
      }),
    ).resolves.toBeNull();
  });

  it("exports a validation error class for composition roots", () => {
    expect(new ValidationError("bad").code).toBe("ValidationError");
  });

  it("validates supplied call context and requires it for mutating methods", async () => {
    const registry = new MethodRegistry();
    registry.register({
      method: "system.read",
      result: z.object({ session: z.string() }),
      handler: (_params, context) => ({ session: String(context.session_id ?? "none") }),
    });
    registry.register({
      method: "system.write",
      mutating: true,
      params: z.object({ value: z.number() }).strict(),
      result: z.object({ value: z.number() }),
      handler: ({ value }) => ({ value }),
    });
    const dispatcher = new Dispatcher(registry);

    const invalidContext = await dispatcher.dispatch({
      jsonrpc: "2.0",
      id: 1,
      method: "system.read",
      context: { session_id: "session-1", trace_id: "trace-1", unexpected: true },
    });
    expect(invalidContext).toMatchObject({ error: { data: { code: "ValidationError" } } });

    const missingMutationContext = await dispatcher.dispatch({
      jsonrpc: "2.0",
      id: 2,
      method: "system.write",
      params: { value: 3 },
    });
    expect(missingMutationContext).toMatchObject({
      error: { data: { code: "ValidationError" } },
    });

    const missingKey = await dispatcher.dispatch({
      jsonrpc: "2.0",
      id: 3,
      method: "system.write",
      params: { value: 3 },
      context: { session_id: "session-1", trace_id: "trace-1" },
    });
    expect(missingKey).toMatchObject({ error: { data: { code: "ValidationError" } } });

    await expect(
      dispatcher.dispatch({
        jsonrpc: "2.0",
        id: 4,
        method: "system.read",
        context: { session_id: "session-1", trace_id: "trace-1" },
      }),
    ).resolves.toEqual({
      jsonrpc: "2.0",
      id: 4,
      result: { session: "session-1" },
    });
  });

  it("replays successful mutating calls and conflicts on key reuse", async () => {
    let executions = 0;
    const registry = new MethodRegistry();
    registry.register({
      method: "system.write",
      mutating: true,
      params: z.object({ value: z.number() }).strict(),
      result: z.object({ value: z.number(), execution: z.number() }),
      handler: ({ value }) => ({ value, execution: ++executions }),
    });
    const dispatcher = new Dispatcher(registry, {
      idempotencyStore: new InMemoryIdempotencyStore({ maxEntries: 4 }),
    });
    const request = {
      jsonrpc: "2.0" as const,
      id: 10,
      method: "system.write",
      params: { value: 7 },
      context: {
        session_id: "session-1",
        trace_id: "trace-1",
        idempotency_key: "write-1",
      },
    };

    const first = await dispatcher.dispatch(request);
    const replay = await dispatcher.dispatch(request);
    expect(first).toEqual({
      jsonrpc: "2.0",
      id: 10,
      result: { value: 7, execution: 1 },
    });
    expect(replay).toBe(first);
    expect(executions).toBe(1);

    const conflict = await dispatcher.dispatch({
      ...request,
      id: 11,
      params: { value: 8 },
    });
    expect(conflict).toMatchObject({ error: { data: { code: "Conflict" } } });
    expect(executions).toBe(1);
  });

  it("does not cache a failed mutating call", async () => {
    let executions = 0;
    const registry = new MethodRegistry();
    registry.register({
      method: "system.write",
      mutating: true,
      result: z.object({ execution: z.number() }),
      handler: () => {
        executions += 1;
        if (executions === 1) throw new NotImplementedError("not ready");
        return { execution: executions };
      },
    });
    const dispatcher = new Dispatcher(registry);
    const request = {
      jsonrpc: "2.0" as const,
      id: 14,
      method: "system.write",
      context: {
        session_id: "session-1",
        trace_id: "trace-1",
        idempotency_key: "write-failure-1",
      },
    };

    await expect(dispatcher.dispatch(request)).resolves.toMatchObject({
      error: { data: { code: "NotImplemented" } },
    });
    await expect(dispatcher.dispatch(request)).resolves.toEqual({
      jsonrpc: "2.0",
      id: 14,
      result: { execution: 2 },
    });
    expect(executions).toBe(2);
  });

  it("deduplicates concurrent replays while the first handler is running", async () => {
    let executions = 0;
    const registry = new MethodRegistry();
    registry.register({
      method: "system.write",
      mutating: true,
      result: z.object({ execution: z.number() }),
      handler: async () => {
        executions += 1;
        await Promise.resolve();
        return { execution: executions };
      },
    });
    const dispatcher = new Dispatcher(registry);
    const request = {
      jsonrpc: "2.0" as const,
      id: 15,
      method: "system.write",
      context: {
        session_id: "session-1",
        trace_id: "trace-1",
        idempotency_key: "write-concurrent-1",
      },
    };

    const [first, replay] = await Promise.all([
      dispatcher.dispatch(request),
      dispatcher.dispatch({ ...request, id: 16 }),
    ]);
    expect(first).toEqual({
      jsonrpc: "2.0",
      id: 15,
      result: { execution: 1 },
    });
    expect(replay).toEqual({
      jsonrpc: "2.0",
      id: 16,
      result: { execution: 1 },
    });
    expect(executions).toBe(1);
  });

  it("deduplicates mutating notifications and preserves the current response id on replay", async () => {
    let executions = 0;
    const registry = new MethodRegistry();
    registry.register({
      method: "system.write",
      mutating: true,
      result: z.object({ execution: z.number() }),
      handler: async () => {
        executions += 1;
        await Promise.resolve();
        return { execution: executions };
      },
    });
    const dispatcher = new Dispatcher(registry);
    const notification = {
      jsonrpc: "2.0" as const,
      method: "system.write",
      context: {
        session_id: "session-notification",
        trace_id: "trace-notification",
        idempotency_key: "write-notification-1",
      },
    };

    await expect(Promise.all([
      dispatcher.dispatch(notification),
      dispatcher.dispatch(notification),
    ])).resolves.toEqual([null, null]);
    expect(executions).toBe(1);

    await expect(dispatcher.dispatch({ ...notification, id: 17 })).resolves.toEqual({
      jsonrpc: "2.0",
      id: 17,
      result: { execution: 1 },
    });
    expect(executions).toBe(1);
  });

  it("publishes safe completion events and supports unsubscribe", async () => {
    const registry = new MethodRegistry();
    registry.register({
      method: "system.read",
      result: z.object({ ok: z.literal(true) }),
      handler: () => ({ ok: true as const }),
    });
    const events: CoreEvent[] = [];
    const dispatcher = new Dispatcher(registry, {
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    const unsubscribe = dispatcher.subscribe((event) => events.push(event));

    await dispatcher.dispatch({
      jsonrpc: "2.0",
      id: 12,
      method: "system.read",
      context: { session_id: "session-1", trace_id: "trace-1" },
    });
    expect(events).toEqual([
      {
        event_id: "core-event-1",
        event_name: "core.call.completed",
        timestamp: "2026-01-01T00:00:00.000Z",
        request_id: 12,
        method: "system.read",
        context: { session_id: "session-1", trace_id: "trace-1" },
        data: { ok: true },
      },
    ]);

    unsubscribe();
    await dispatcher.dispatch({ jsonrpc: "2.0", id: 13, method: "system.read" });
    expect(events).toHaveLength(1);
  });
});
