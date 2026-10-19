import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  assertCoreClientParity,
  Dispatcher,
  InProcessClient,
  MethodRegistry,
  RemoteClient,
  type CoreFetch,
} from "./index.js";

describe("Core client transports", () => {
  it("produce identical responses for one scripted scenario", async () => {
    function makeDispatcher(): Dispatcher {
      let writes = 0;
      const registry = new MethodRegistry();
      registry.register({
        method: "ledger.read",
        params: z.object({}).strict(),
        result: z.object({ writes: z.number() }),
        handler: () => ({ writes }),
      });
      registry.register({
        method: "ledger.write",
        mutating: true,
        params: z.object({ value: z.string() }).strict(),
        result: z.object({ writes: z.number(), value: z.string() }),
        handler: ({ value }) => ({ writes: ++writes, value }),
      });
      return new Dispatcher(registry);
    }

    const inProcessDispatcher = makeDispatcher();
    const remoteDispatcher = makeDispatcher();
    const requests = [
      { jsonrpc: "2.0" as const, id: 1, method: "ledger.read", params: {} },
      {
        jsonrpc: "2.0" as const,
        id: 2,
        method: "ledger.write",
        params: { value: "first" },
        context: {
          session_id: "session-parity",
          trace_id: "trace-parity",
          idempotency_key: "write-parity",
        },
      },
      { jsonrpc: "2.0" as const, id: 3, method: "ledger.read", params: {} },
    ];
    const calls: Array<{ url: string; init: Parameters<CoreFetch>[1] }> = [];
    const fetch: CoreFetch = async (url, init) => {
      calls.push({ url, init });
      const response = await remoteDispatcher.dispatch(JSON.parse(init.body) as unknown);
      return {
        status: response === null ? 204 : 200,
        ok: true,
        text: async () => response === null ? "" : JSON.stringify(response),
      };
    };

    const result = await assertCoreClientParity(
      new InProcessClient(inProcessDispatcher),
      new RemoteClient({ url: "http://core.test/rpc", token: "parity-token", fetch }),
      requests,
    );

    expect(result.equal).toBe(true);
    expect(result.inProcess).toEqual(result.remote);
    expect(calls).toHaveLength(requests.length);
    expect(calls[0]?.url).toBe("http://core.test/rpc");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.headers.authorization).toBe("Bearer parity-token");
    expect(calls[0]?.init.headers["content-type"]).toBe("application/json");
  });

  it("surfaces network and malformed-response failures without a live daemon", async () => {
    const request = { jsonrpc: "2.0" as const, id: 1, method: "system.ping" };
    const network = new RemoteClient({
      url: "http://core.test/rpc",
      fetch: async () => {
        throw new Error("connection refused");
      },
    });
    await expect(network.call(request)).rejects.toMatchObject({
      name: "RemoteClientError",
      kind: "network",
    });

    const malformed = new RemoteClient({
      url: "http://core.test/rpc",
      fetch: async () => ({ status: 200, ok: true, text: async () => "not-json" }),
    });
    await expect(malformed.call(request)).rejects.toMatchObject({
      name: "RemoteClientError",
      kind: "malformed-response",
      status: 200,
    });
  });
});
