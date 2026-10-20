import { describe, expect, it } from "vitest";
import { request } from "node:http";
import { generateKeyPairSync, sign as nodeSign } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { loadConfig } from "@lightphysics/config";
import {
  assertCoreClientParity,
  InProcessClient,
  RemoteClient,
  type CoreClientRequest,
} from "@lightphysics/core-api";
import { Ledger } from "@lightphysics/ledger";
import { MockAdapter, ForgeError, type ForgeAdapter } from "@lightphysics/forge";
import { JobJournal, type SupervisorChild, type SupervisorKillRequest } from "@lightphysics/runner";
import { initProject } from "@lightphysics/memory";
import {
  appendHumanEvidence,
  HumanChannel,
  SessionRevokedError,
  WardenSessionManager,
} from "@lightphysics/warden";
import { WebSocket } from "ws";
import {
  createServer,
  serverAddress,
  startServer,
  type LpdServer,
} from "./index.js";

function rpc(
  server: LpdServer,
  payload: unknown,
  options: { token?: string; origin?: string; host?: string; forwardedFor?: string } = {},
): Promise<{ status: number; body: any }> {
  const address = serverAddress(server);
  if (!address) throw new Error("server is not listening");
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port: address.port,
      path: "/rpc",
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.origin ? { origin: options.origin } : {}),
        ...(options.host ? { host: options.host } : {}),
        ...(options.forwardedFor ? { "x-forwarded-for": options.forwardedFor } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null });
      });
    });
    req.on("error", reject);
    req.end(JSON.stringify(payload));
  });
}

function httpGet(
  server: LpdServer,
  pathName: string,
): Promise<{ status: number; body: string; contentType?: string }> {
  const address = serverAddress(server);
  if (!address) throw new Error("server is not listening");
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port: address.port,
      path: pathName,
      method: "GET",
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => resolve({
        status: res.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
        ...(res.headers["content-type"] ? { contentType: res.headers["content-type"] } : {}),
      }));
    });
    req.on("error", reject);
    req.end();
  });
}

function websocketRpc(
  server: LpdServer,
  payload: unknown,
  token: string,
): Promise<unknown> {
  const address = serverAddress(server);
  if (!address) throw new Error("server is not listening");
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/rpc`, {
      headers: {
        authorization: `Bearer ${token}`,
        origin: `http://127.0.0.1:${address.port}`,
      },
    });
    socket.once("error", reject);
    socket.once("open", () => socket.send(JSON.stringify(payload)));
    socket.once("message", (data) => {
      resolve(JSON.parse(data.toString()) as unknown);
      socket.close();
    });
  });
}

function websocketUpgrade(
  server: LpdServer,
  options: { token?: string; origin?: string; host?: string } = {},
): Promise<{ status: number; body: string; retryAfter?: string }> {
  const address = serverAddress(server);
  if (!address) throw new Error("server is not listening");
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port: address.port,
      path: "/rpc",
      method: "GET",
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGVzdC13ZWJzb2NrZXQta2V5",
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.origin ? { origin: options.origin } : {}),
        ...(options.host ? { host: options.host } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => resolve({
        status: res.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
        ...(typeof res.headers["retry-after"] === "string"
          ? { retryAfter: res.headers["retry-after"] }
          : {}),
      }));
    });
    req.on("upgrade", (response, socket) => {
      socket.destroy();
      resolve({ status: response.statusCode ?? 0, body: "" });
    });
    req.on("error", reject);
    req.end();
  });
}

function deterministicWardenRuntime(): {
  readonly clock: () => number;
  readonly advance: (milliseconds: number) => void;
  readonly randomBytes: (size: number) => Uint8Array;
} {
  let now = Date.parse("2026-01-01T00:00:00.000Z");
  let seed = 0;
  return {
    clock: () => now,
    advance: (milliseconds) => { now += milliseconds; },
    randomBytes: (size) => {
      seed += 1;
      return new Uint8Array(size).fill(seed);
    },
  };
}

class FakeProcessChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid: number;

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  kill(): boolean {
    return true;
  }

  finish(signal: NodeJS.Signals): void {
    this.emit("exit", null, signal);
    this.emit("close", null, signal);
  }
}

function asSupervisorChild(child: FakeProcessChild): SupervisorChild {
  return child as unknown as SupervisorChild;
}

describe("lpd HTTP walking skeleton", () => {
  let server: LpdServer;

  it("serves ping and info through the reusable server API", async () => {
    server = await startServer({
      config: loadConfig({ LP_PORT: "4317" }),
      port: 0,
      token: "test-token",
    });
    const ping = await rpc(
      server,
      { jsonrpc: "2.0", id: 1, method: "system.ping", params: {} },
      { token: "test-token", origin: `http://127.0.0.1:${server.listenPort}` },
    );
    expect(ping.status).toBe(200);
    expect(ping.body.result).toMatchObject({ ok: true, service: "lpd" });

    const info = await rpc(
      server,
      { jsonrpc: "2.0", id: 2, method: "system.info", params: {} },
      { token: "test-token" },
    );
    expect(info.body.result).toMatchObject({
      name: "lpd",
      product: "LightPhysics",
      nodeVersion: process.version,
    });
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it("serves bounded project resume and rebuildable memory reindex methods", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "lightphysics-lpd-memory-"));
    await initProject(root);
    const localServer = await startServer({
      projectRoot: root,
      port: 0,
      token: "memory-token",
    });
    try {
      const resume = await rpc(localServer, {
        jsonrpc: "2.0",
        id: 1,
        method: "project.resume",
        params: {},
      }, { token: "memory-token" });
      expect(resume.status).toBe(200);
      expect(resume.body.result).toMatchObject({
        stage: "pre-production",
        pendingHumanDecisions: [],
        tokenEstimate: expect.any(Number),
      });

      const reindex = await rpc(localServer, {
        jsonrpc: "2.0",
        id: 2,
        method: "project.reindex",
        params: {},
        context: {
          session_id: "memory-session",
          trace_id: "memory-trace",
          idempotency_key: "memory-reindex-1",
        },
      }, { token: "memory-token" });
      expect(reindex.status).toBe(200);
      expect(reindex.body.result).toMatchObject({
        documents: expect.any(Number),
        fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(existsSync(path.join(root, "lp", "index.sqlite"))).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => localServer.close((error) => error ? reject(error) : resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("serves the same JSON-RPC contract over an authenticated WebSocket", async () => {
    server = await startServer({ port: 0, token: "test-token" });
    const response = await websocketRpc(
      server,
      { jsonrpc: "2.0", id: 3, method: "system.ping", params: {} },
      "test-token",
    );
    expect(response).toMatchObject({
      jsonrpc: "2.0",
      id: 3,
      result: { ok: true, service: "lpd" },
    });
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it("keeps approval-forgery methods absent and audits them over HTTP, authenticated WebSocket, and in-process dispatch", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "lightphysics-lpd-no-approval-test-"));
    const ledger = new Ledger({ home });
    const runtime = deterministicWardenRuntime();
    const warden = new WardenSessionManager({
      clock: runtime.clock,
      randomBytes: runtime.randomBytes,
      policy: { defaultMode: "auto" },
    });
    const agents = (["agent", "cli", "studio-agent"] as const).map((kind) =>
      warden.createSession({ kind, permissions: ["read", "write_project", "approve"] }));
    const keyPair = generateKeyPairSync("ed25519");
    const channel = new HumanChannel({
      signer: (payload) => nodeSign(null, payload, keyPair.privateKey),
      clock: () => new Date("2026-01-02T03:04:05.000Z"),
      nonce: () => "verified-human-fixture",
    });
    channel.enrollPublicKey(keyPair.publicKey, true);
    const signed = channel.signApproval({ subject_hash: "a".repeat(64), decision: "approve", reason: "reviewed fixture" });
    // The structural sink works with the real Ledger, while its authority is
    // still available only to the trusted, explicitly injected Human Channel.
    const verified = appendHumanEvidence(channel, ledger, signed);
    expect(ledger.getEvidence(verified.id)?.payload).toEqual(verified.payload);
    expect(appendHumanEvidence(channel, ledger, signed)).toEqual({ ...verified, replayed: true });
    const recordsBefore = ledger.listRecords();
    let expectedAuditCount = 0;
    let localServer: LpdServer | undefined;

    try {
      localServer = await startServer({
        config: loadConfig({ LP_HOME: home, LP_PORT: "4317" }),
        port: 0,
        token: "approval-negative-test-token",
        warden,
        ledger,
      });
      const methods = ["approval.approve", "approval.submit", "gate.approve"];
      const candidates = [
        { label: "forged", params: { ...signed, reason: "agent-forged approval", signature: "A".repeat(86) } },
        { label: "signed-replay", params: signed },
      ];
      let requestId = 70;
      expect(localServer.registry.names().filter((method) => /approval|approve/.test(method))).toEqual([]);
      for (const method of methods) {
        expect(localServer.registry.has(method)).toBe(false);
        for (const agent of agents) {
          for (const candidate of candidates) {
            const attempt = {
              jsonrpc: "2.0",
              id: requestId++,
              method,
              params: candidate.params,
              context: {
                session_id: agent.sessionId,
                trace_id: `trace-${agent.session.kind}-${candidate.label}-${method}`,
                idempotency_key: `idem-${agent.session.kind}-${candidate.label}-${method}`,
              },
            };
            const expected = {
              jsonrpc: "2.0",
              id: attempt.id,
              error: { code: -32601, data: { code: "MethodNotFound", retryable: false } },
            };
            const httpResponse = await rpc(localServer, attempt, { token: "approval-negative-test-token" });
            expect(httpResponse.status).toBe(200);
            expect(httpResponse.body).toMatchObject(expected);
            expect(await websocketRpc(localServer, attempt, "approval-negative-test-token")).toMatchObject(expected);
            expect(await localServer.dispatcher.dispatch(attempt)).toMatchObject(expected);
            expectedAuditCount += 1;
            expect(ledger.listRecords()).toHaveLength(recordsBefore.length + expectedAuditCount);
            expect(ledger.listEvidence()).toHaveLength(1);
            expect(ledger.listApprovals()).toEqual([]);
            expect(ledger.listAudits()).toHaveLength(expectedAuditCount);
          }
        }
      }
      const audits = ledger.listAudits();
      expect(audits).toHaveLength(18);
      expect(audits.every((record) => (
        (record.payload as Record<string, unknown>).event_kind === "warden.approval_attempt"
        && (record.payload as Record<string, unknown>).outcome === "rejected"
        && (record.payload as Record<string, unknown>).code === "MethodNotFound"
      ))).toBe(true);
      const serializedAudits = JSON.stringify(audits);
      for (const agent of agents) expect(serializedAudits).not.toContain(agent.token);
      expect(serializedAudits).not.toContain("reviewed fixture");
      expect(serializedAudits).not.toContain("agent-forged approval");
      expect(serializedAudits).not.toContain("A".repeat(86));
      expect(serializedAudits).not.toContain("idem-");
      expect(existsSync(path.join(home, "db", "runner.sqlite"))).toBe(false);
      expect(ledger.verifyChain()).toMatchObject({ ok: true, checkedRecords: 19 });
    } finally {
      if (localServer?.listening) {
        const closingServer = localServer;
        await new Promise<void>((resolve, reject) => closingServer.close((error) => error ? reject(error) : resolve()));
      }
      ledger.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("audits approval notifications, ignores ordinary unknown methods, and blocks Runner mutation on audit failure", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "lightphysics-lpd-approval-audit-edge-test-"));
    const runtime = deterministicWardenRuntime();
    const warden = new WardenSessionManager({
      clock: runtime.clock,
      randomBytes: runtime.randomBytes,
      policy: { defaultMode: "auto" },
    });
    const agent = warden.createSession({ kind: "agent", permissions: ["approve"] });
    const ledger = new Ledger({ home, now: () => "2026-01-01T00:00:00.000Z" });
    let localServer: LpdServer | undefined;
    try {
      localServer = await startServer({
        config: loadConfig({ LP_HOME: home, LP_PORT: "4317" }),
        port: 0,
        token: "approval-edge-token",
        warden,
        ledger,
      });
      const ordinary = await rpc(localServer, {
        jsonrpc: "2.0",
        id: 80,
        method: "system.missing",
        params: { reason: "ordinary" },
      }, { token: "approval-edge-token" });
      expect(ordinary.body.error.data.code).toBe("MethodNotFound");
      expect(ledger.listAudits()).toEqual([]);

      const notification = {
        jsonrpc: "2.0" as const,
        method: "lp_approval.request.v1",
        params: { signature: "private", reason: "forged", idempotency_key: "secret" },
        context: {
          session_id: agent.sessionId,
          trace_id: "safe-approval-trace",
          idempotency_key: "private-idempotency-key",
        },
      };
      await expect(rpc(localServer, notification, { token: "approval-edge-token" })).resolves.toMatchObject({
        status: 204,
        body: null,
      });
      await expect(rpc(localServer, notification, { token: "approval-edge-token" })).resolves.toMatchObject({
        status: 204,
        body: null,
      });
      expect(ledger.listAudits()).toHaveLength(1);
      const auditJson = JSON.stringify(ledger.listAudits());
      expect(auditJson).toContain("safe-approval-trace");
      expect(auditJson).toContain(agent.sessionId);
      expect(auditJson).not.toContain("private");
      expect(auditJson).not.toContain("forged");
      expect(auditJson).not.toContain("secret");
    } finally {
      if (localServer?.listening) {
        await new Promise<void>((resolve, reject) => localServer?.close((error) => error ? reject(error) : resolve()));
      }
      ledger.close();
    }

    const failingJournal = new JobJournal({ home });
    const failingLedger = {
      appendAudit: () => { throw new Error("private storage failure"); },
      getAudit: () => null,
    } as unknown as Ledger;
    let failingServer: LpdServer | undefined;
    try {
      failingServer = await startServer({
        config: loadConfig({ LP_HOME: home, LP_PORT: "4317" }),
        port: 0,
        token: "approval-edge-token",
        journal: failingJournal,
        warden,
        ledger: failingLedger,
      });
      const response = await rpc(failingServer, {
        jsonrpc: "2.0",
        id: 81,
        method: "gate.approve",
        params: { signature: "private", reason: "forged" },
        context: {
          session_id: agent.sessionId,
          trace_id: "failure-trace",
          idempotency_key: "failure-idempotency-key",
        },
      }, { token: "approval-edge-token" });
      expect(response.body.error.data).toMatchObject({
        code: "Internal",
        details: { reason: "audit_unavailable" },
      });
      expect(failingJournal.getJob("approval-failure-job")).toBeUndefined();
    } finally {
      if (failingServer?.listening) {
        await new Promise<void>((resolve, reject) => failingServer?.close((error) => error ? reject(error) : resolve()));
      }
      failingJournal.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects missing/wrong bearer tokens and non-loopback origins", async () => {
    server = await startServer({ port: 0, token: "test-token" });
    const missing = await rpc(server, {
      jsonrpc: "2.0",
      id: 1,
      method: "system.ping",
      params: {},
    });
    expect(missing.status).toBe(401);

    const wrongOrigin = await rpc(
      server,
      { jsonrpc: "2.0", id: 2, method: "system.ping", params: {} },
      { token: "test-token", origin: "https://not-local.example" },
    );
    expect(wrongOrigin.status).toBe(403);
    const wrongHost = await rpc(
      server,
      { jsonrpc: "2.0", id: 3, method: "system.ping", params: {} },
      { token: "test-token", host: "attacker.example" },
    );
    expect(wrongHost.status).toBe(403);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it("rejects DNS-rebinding Host and Origin attempts even with a valid bearer", async () => {
    server = await startServer({ port: 0, token: "dns-rebinding-token" });
    try {
      const attempts = [
        { host: "rebound.attacker.example", origin: `http://127.0.0.1:${server.listenPort}` },
        { host: `127.0.0.1:${server.listenPort}`, origin: "http://rebound.attacker.example" },
        { host: `127.0.0.1:${server.listenPort + 1}`, origin: `http://127.0.0.1:${server.listenPort}` },
      ];
      for (const [index, headers] of attempts.entries()) {
        const response = await rpc(server, {
          jsonrpc: "2.0",
          id: index + 1,
          method: "system.ping",
          params: {},
        }, { token: "dns-rebinding-token", ...headers });
        expect(response.status).toBe(403);
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("rate-limits bounded HTTP and WebSocket auth failures without leaking credentials or paths", async () => {
    let now = 10_000;
    server = await startServer({
      port: 0,
      token: "the-real-secret",
      authFailureRateLimit: {
        maxFailures: 2,
        windowMs: 1_000,
        maxEntries: 2,
        clock: () => now,
      },
    });
    try {
      const missing = await rpc(server, {
        jsonrpc: "2.0", id: 1, method: "system.ping", params: {},
      }, { forwardedFor: "198.51.100.10" });
      expect(missing.status).toBe(401);

      const wrong = await rpc(server, {
        jsonrpc: "2.0", id: 2, method: "system.ping", params: {},
      }, {
        token: "wrong-secret",
        host: "127.0.0.1",
        origin: `http://127.0.0.1:${server.listenPort}`,
        forwardedFor: "198.51.100.11",
      });
      expect(wrong.status).toBe(401);

      const blockedHttp = await rpc(server, {
        jsonrpc: "2.0", id: 3, method: "system.ping", params: {},
      }, {
        token: "wrong-secret",
        host: "127.0.0.1",
        origin: `http://127.0.0.1:${server.listenPort}`,
        forwardedFor: "198.51.100.12",
      });
      expect(blockedHttp.status).toBe(429);
      expect(blockedHttp.body.error).toMatchObject({
        code: -32001,
        message: "Too many authentication failures; try again later",
      });
      expect(blockedHttp.body.error.data).toMatchObject({ code: "Unauthorized", retryable: true });
      expect(JSON.stringify(blockedHttp.body)).not.toContain("wrong-secret");
      expect(JSON.stringify(blockedHttp.body)).not.toContain("/rpc");

      const blockedWs = await websocketUpgrade(server, { token: "wrong-secret" });
      expect(blockedWs.status).toBe(429);
      expect(blockedWs.retryAfter).toBe("1");
      expect(blockedWs.body).toBe("Too many authentication failures; try again later\n");
      expect(blockedWs.body).not.toContain("wrong-secret");
      expect(blockedWs.body).not.toContain("/rpc");

      // A valid credential is never held behind an invalid-attempt record.
      const successful = await rpc(server, {
        jsonrpc: "2.0", id: 4, method: "system.ping", params: {},
      }, { token: "the-real-secret" });
      expect(successful.status).toBe(200);
      expect(successful.body.result).toMatchObject({ ok: true, service: "lpd" });

      const secondFailure = await rpc(server, {
        jsonrpc: "2.0", id: 5, method: "system.ping", params: {},
      });
      expect(secondFailure.status).toBe(401);
      now += 1_000;
      const resetFailure = await rpc(server, {
        jsonrpc: "2.0", id: 6, method: "system.ping", params: {},
      });
      expect(resetFailure.status).toBe(401);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("keeps the default bind loopback-only", () => {
    const local = createServer({ token: "test-token" });
    expect(local.listenBind).toBe("127.0.0.1");
    local.close();
  });

  it("serves the browser GUI shell without exposing RPC data", async () => {
    server = await startServer({ port: 0, token: "test-token" });
    const page = await httpGet(server, "/");
    expect(page.status).toBe(200);
    expect(page.contentType).toContain("text/html");
    expect(page.body).toContain("LightPhysics");
    expect(page.body).toContain("Enter the bearer token");

    const script = await httpGet(server, "/app.js");
    expect(script.status).toBe(200);
    expect(script.contentType).toContain("text/javascript");
    expect(script.body).toContain("authorization");

    const missing = await httpGet(server, "/not-a-gui-asset");
    expect(missing.status).toBe(404);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it("exposes the minimal Runner job lifecycle with Core context and replay rules", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "lightphysics-lpd-job-test-"));
    try {
      server = await startServer({
        config: loadConfig({ LP_HOME: home, LP_PORT: "4317" }),
        port: 0,
        token: "test-token",
      });
      expect(server.registry.list()).toEqual(expect.arrayContaining([
        { method: "job.cancel", mutating: true },
        { method: "job.create", mutating: true },
        { method: "job.get" },
      ]));

      const create = {
        jsonrpc: "2.0" as const,
        id: 10,
        method: "job.create",
        params: { id: "integration-job", type: "demo", payload: { hello: "world" } },
        context: { session_id: "session-1", trace_id: "trace-1", idempotency_key: "create-1" },
      };
      await expect(rpc(server, { ...create, context: undefined }, { token: "test-token" })).resolves.toMatchObject({
        body: { error: { data: { code: "ValidationError" } } },
      });
      const created = await rpc(server, create, { token: "test-token" });
      expect(created.status).toBe(200);
      expect(created.body.result).toMatchObject({ id: "integration-job", state: "queued", type: "demo" });

      const replay = await rpc(server, { ...create, id: 11 }, { token: "test-token" });
      expect(replay.body.result).toEqual(created.body.result);
      expect(replay.body.id).toBe(11);

      const fetched = await rpc(server, {
        jsonrpc: "2.0",
        id: 12,
        method: "job.get",
        params: { id: "integration-job" },
      }, { token: "test-token" });
      expect(fetched.body.result).toEqual(created.body.result);

      const cancel = {
        jsonrpc: "2.0" as const,
        id: 13,
        method: "job.cancel",
        params: { id: "integration-job", reason: "done" },
        context: { session_id: "session-1", trace_id: "trace-2", idempotency_key: "cancel-1" },
      };
      const missingCancelContext = await rpc(server, { ...cancel, context: undefined }, { token: "test-token" });
      expect(missingCancelContext.body.error.data.code).toBe("ValidationError");
      const cancelled = await rpc(server, cancel, { token: "test-token" });
      expect(cancelled.body.result).toMatchObject({ id: "integration-job", state: "cancelled", cancelRequested: true, cancelReason: "done" });

      const missing = await rpc(server, {
        jsonrpc: "2.0",
        id: 14,
        method: "job.get",
        params: { id: "missing-job" },
      }, { token: "test-token" });
      expect(missing.body.error.data.code).toBe("NotFound");
    } finally {
      if (server?.listening) {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("gates built-in job methods with optional Warden session authorization", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "lightphysics-lpd-warden-test-"));
    const runtime = deterministicWardenRuntime();
    const warden = new WardenSessionManager({
      clock: runtime.clock,
      randomBytes: runtime.randomBytes,
      policy: { defaultMode: "auto" },
    });
    const journal = new JobJournal({ home });
    const writer = warden.createSession({
      kind: "gui",
      permissions: ["read", "write_project"],
    });
    const reader = warden.createSession({ kind: "agent", permissions: ["read"] });
    const askWarden = new WardenSessionManager({
      clock: runtime.clock,
      randomBytes: runtime.randomBytes,
      policy: { defaultMode: "ask" },
    });
    const askWriter = askWarden.createSession({ kind: "gui", permissions: ["write_project"] });
    const expiringWriter = warden.createSession({
      kind: "gui",
      permissions: ["write_project"],
      ttlMs: 1_000,
    });
    const revokedReader = warden.createSession({ kind: "gui", permissions: ["read"] });

    const context = (sessionId: string, traceId: string, idempotencyKey?: string) => ({
      session_id: sessionId,
      trace_id: traceId,
      ...(idempotencyKey === undefined ? {} : { idempotency_key: idempotencyKey }),
    });

    try {
      server = await startServer({
        config: loadConfig({ LP_HOME: home, LP_PORT: "4317" }),
        port: 0,
        token: "test-token",
        journal,
        warden,
      });

      const created = await rpc(server, {
        jsonrpc: "2.0",
        id: 40,
        method: "job.create",
        params: { id: "warden-job", type: "demo", payload: { hello: "warden" } },
        context: context(writer.sessionId, "warden-create", "warden-create-1"),
      }, { token: "test-token" });
      expect(created.body.result).toMatchObject({ id: "warden-job", state: "queued" });

      const fetched = await rpc(server, {
        jsonrpc: "2.0",
        id: 41,
        method: "job.get",
        params: { id: "warden-job" },
        context: context(writer.sessionId, "warden-get"),
      }, { token: "test-token" });
      expect(fetched.body.result).toEqual(created.body.result);

      const cancelled = await rpc(server, {
        jsonrpc: "2.0",
        id: 42,
        method: "job.cancel",
        params: { id: "warden-job", reason: "warden test" },
        context: context(writer.sessionId, "warden-cancel", "warden-cancel-1"),
      }, { token: "test-token" });
      expect(cancelled.body.result).toMatchObject({ id: "warden-job", state: "cancelled" });

      const deniedCreate = await rpc(server, {
        jsonrpc: "2.0",
        id: 43,
        method: "job.create",
        params: { id: "warden-denied-job" },
        context: context(reader.sessionId, "reader-create", "reader-create-1"),
      }, { token: "test-token" });
      expect(deniedCreate.body.error.data.code).toBe("PermissionDenied");
      expect(journal.getJob("warden-denied-job")).toBeUndefined();

      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      server = await startServer({
        config: loadConfig({ LP_HOME: home, LP_PORT: "4317" }),
        port: 0,
        token: "test-token",
        journal,
        warden: askWarden,
      });
      const approvalRequired = await rpc(server, {
        jsonrpc: "2.0",
        id: 44,
        method: "job.create",
        params: { id: "warden-approval-job" },
        context: context(askWriter.sessionId, "ask-create", "ask-create-1"),
      }, { token: "test-token" });
      expect(approvalRequired.body.error.data.code).toBe("ApprovalRequired");
      expect(journal.getJob("warden-approval-job")).toBeUndefined();

      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      server = await startServer({
        config: loadConfig({ LP_HOME: home, LP_PORT: "4317" }),
        port: 0,
        token: "test-token",
        journal,
        warden,
      });
      runtime.advance(1_000);
      const expired = await rpc(server, {
        jsonrpc: "2.0",
        id: 45,
        method: "job.create",
        params: { id: "warden-expired-job" },
        context: context(expiringWriter.sessionId, "expired-create", "expired-create-1"),
      }, { token: "test-token" });
      expect(expired.body.error.data.code).toBe("Unauthorized");
      expect(journal.getJob("warden-expired-job")).toBeUndefined();

      expect(warden.revokeSession(revokedReader.sessionId)).toBe(true);
      const revoked = await rpc(server, {
        jsonrpc: "2.0",
        id: 46,
        method: "job.get",
        params: { id: "warden-job" },
        context: context(revokedReader.sessionId, "revoked-get"),
      }, { token: "test-token" });
      expect(revoked.body.error.data.code).toBe("Unauthorized");
    } finally {
      if (server?.listening) {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
      journal.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("revokes active Warden sessions through the production server kill-all lifecycle", async () => {
    const runtime = deterministicWardenRuntime();
    const warden = new WardenSessionManager({
      clock: runtime.clock,
      randomBytes: runtime.randomBytes,
      policy: { defaultMode: "auto" },
    });
    const active = warden.createSession({ kind: "agent", permissions: ["read"] });
    const child = new FakeProcessChild(401);
    const killRequests: SupervisorKillRequest[] = [];
    const journal = new JobJournal(":memory:");
    const localServer = await startServer({
      port: 0,
      token: "kill-all-test-token",
      warden,
      journal,
      supervisorOptions: {
        platform: "linux",
        killer: (request) => {
          killRequests.push(request);
          child.finish(request.signal);
          return { ok: true, method: request.method, reason: "requested" };
        },
      },
    });

    try {
      localServer.supervisor.track("production-tree", asSupervisorChild(child), { processGroup: true });
      const result = await localServer.killAll({ timeoutMs: 100 });

      expect(result.confirmed).toBe(1);
      expect(result.tokenRevocation).toEqual({ available: true, status: "revoked" });
      expect(killRequests).toHaveLength(1);
      expect(() => warden.authorizeSessionOrThrow(active.sessionId, { permission: "read" }))
        .toThrow(SessionRevokedError);
    } finally {
      await new Promise<void>((resolve, reject) => localServer.close((error) => error ? reject(error) : resolve()));
      journal.close();
    }
  });

  it("does not create the Runner database for ping/info-only servers", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "lightphysics-lpd-no-runner-test-"));
    try {
      server = await startServer({
        config: loadConfig({ LP_HOME: home, LP_PORT: "4317" }),
        port: 0,
        token: "test-token",
      });
      await rpc(server, { jsonrpc: "2.0", id: 20, method: "system.ping", params: {} }, { token: "test-token" });
      await rpc(server, { jsonrpc: "2.0", id: 21, method: "system.info", params: {} }, { token: "test-token" });
      expect(existsSync(path.join(home, "db", "runner.sqlite"))).toBe(false);
      expect(existsSync(path.join(home, "db", "ledger.sqlite"))).toBe(false);
    } finally {
      if (server?.listening) {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("accepts an injected journal without taking ownership of its lifecycle", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "lightphysics-lpd-injected-runner-test-"));
    const journal = new JobJournal({ home });
    try {
      server = await startServer({ config: loadConfig({ LP_HOME: home, LP_PORT: "4317" }), port: 0, token: "test-token", journal });
      await rpc(server, {
        jsonrpc: "2.0",
        id: 30,
        method: "job.create",
        params: { id: "injected-job" },
        context: { session_id: "session-2", trace_id: "trace-2", idempotency_key: "create-injected" },
      }, { token: "test-token" });
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      expect(journal.requireJob("injected-job").state).toBe("queued");
    } finally {
      journal.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("writes bounded Warden decision audits without recording tokens or job payloads", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "lightphysics-lpd-warden-audit-test-"));
    const runtime = deterministicWardenRuntime();
    const warden = new WardenSessionManager({
      clock: runtime.clock,
      randomBytes: runtime.randomBytes,
      policy: { defaultMode: "auto" },
    });
    const askWarden = new WardenSessionManager({
      clock: runtime.clock,
      randomBytes: runtime.randomBytes,
      policy: { defaultMode: "ask" },
    });
    const journal = new JobJournal({ home });
    const ledger = new Ledger({ home, now: () => "2026-01-01T00:00:00.000Z" });
    const writer = warden.createSession({ kind: "gui", permissions: ["read", "write_project"] });
    const reader = warden.createSession({ kind: "agent", permissions: ["read"] });
    const askWriter = askWarden.createSession({ kind: "gui", permissions: ["write_project"] });
    const expiringWriter = warden.createSession({
      kind: "gui",
      permissions: ["write_project"],
      ttlMs: 1_000,
    });
    const revokedReader = warden.createSession({ kind: "gui", permissions: ["read"] });
    const context = (sessionId: string, traceId: string, idempotencyKey?: string) => ({
      session_id: sessionId,
      trace_id: traceId,
      ...(idempotencyKey === undefined ? {} : { idempotency_key: idempotencyKey }),
    });
    let server: LpdServer | undefined;

    const closeServer = async (): Promise<void> => {
      if (!server?.listening) return;
      await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
      server = undefined;
    };

    try {
      server = await startServer({
        config: loadConfig({ LP_HOME: home, LP_PORT: "4317" }),
        port: 0,
        token: "test-token",
        journal,
        warden,
        ledger,
      });
      const created = await rpc(server, {
        jsonrpc: "2.0",
        id: 50,
        method: "job.create",
        params: { id: "audited-job", type: "demo", payload: { marker: "audit-job-payload" } },
        context: context(writer.sessionId, "audit-create", "audit-create-1"),
      }, { token: "test-token" });
      expect(created.body.result).toMatchObject({ id: "audited-job", state: "queued" });

      const replay = await rpc(server, {
        jsonrpc: "2.0",
        id: 51,
        method: "job.create",
        params: { id: "audited-job", type: "demo", payload: { marker: "audit-job-payload" } },
        context: context(writer.sessionId, "audit-create", "audit-create-1"),
      }, { token: "test-token" });
      expect(replay.body.result).toEqual(created.body.result);
      expect(ledger.listAudits()).toHaveLength(1);

      const fetched = await rpc(server, {
        jsonrpc: "2.0",
        id: 52,
        method: "job.get",
        params: { id: "audited-job" },
        context: context(writer.sessionId, writer.token),
      }, { token: "test-token" });
      expect(fetched.body.result).toEqual(created.body.result);

      const cancelled = await rpc(server, {
        jsonrpc: "2.0",
        id: 53,
        method: "job.cancel",
        params: { id: "audited-job", reason: "audit test" },
        context: context(writer.sessionId, "audit-cancel", "audit-cancel-1"),
      }, { token: "test-token" });
      expect(cancelled.body.result).toMatchObject({ id: "audited-job", state: "cancelled" });

      const denied = await rpc(server, {
        jsonrpc: "2.0",
        id: 54,
        method: "job.create",
        params: { id: "audit-denied-job", payload: { marker: "audit-job-payload" } },
        context: context(reader.sessionId, "audit-denied", "audit-denied-1"),
      }, { token: "test-token" });
      expect(denied.body.error.data.code).toBe("PermissionDenied");
      expect(journal.getJob("audit-denied-job")).toBeUndefined();

      await closeServer();
      server = await startServer({
        config: loadConfig({ LP_HOME: home, LP_PORT: "4317" }),
        port: 0,
        token: "test-token",
        journal,
        warden: askWarden,
        ledger,
      });
      const approvalRequired = await rpc(server, {
        jsonrpc: "2.0",
        id: 55,
        method: "job.create",
        params: { id: "audit-approval-job" },
        context: context(askWriter.sessionId, "audit-approval", "audit-approval-1"),
      }, { token: "test-token" });
      expect(approvalRequired.body.error.data.code).toBe("ApprovalRequired");
      expect(journal.getJob("audit-approval-job")).toBeUndefined();

      await closeServer();
      server = await startServer({
        config: loadConfig({ LP_HOME: home, LP_PORT: "4317" }),
        port: 0,
        token: "test-token",
        journal,
        warden,
        ledger,
      });
      runtime.advance(1_000);
      const expired = await rpc(server, {
        jsonrpc: "2.0",
        id: 56,
        method: "job.create",
        params: { id: "audit-expired-job" },
        context: context(expiringWriter.sessionId, "audit-expired", "audit-expired-1"),
      }, { token: "test-token" });
      expect(expired.body.error.data.code).toBe("Unauthorized");
      expect(journal.getJob("audit-expired-job")).toBeUndefined();

      expect(warden.revokeSession(revokedReader.sessionId)).toBe(true);
      const revoked = await rpc(server, {
        jsonrpc: "2.0",
        id: 57,
        method: "job.get",
        params: { id: "audited-job" },
        context: context(revokedReader.sessionId, "audit-revoked"),
      }, { token: "test-token" });
      expect(revoked.body.error.data.code).toBe("Unauthorized");

      const audits = ledger.listAudits();
      expect(audits).toHaveLength(7);
      const payloads = audits.map((record) => record.payload as Record<string, unknown>);
      expect(new Set(payloads.map((payload) => payload.outcome))).toEqual(new Set([
        "allowed",
        "permission_denied",
        "approval_required",
        "expired",
        "revoked",
      ]));
      expect(payloads).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event_kind: "warden.permission_decision",
          method: "job.create",
          permission: "write_project",
          session_id: writer.sessionId,
          trace_id: "audit-create",
          outcome: "allowed",
          code: "Allowed",
        }),
        expect.objectContaining({
          method: "job.get",
          permission: "read",
          session_id: revokedReader.sessionId,
          trace_id: "audit-revoked",
          outcome: "revoked",
          code: "SessionRevoked",
        }),
      ]));
      const serializedAudits = JSON.stringify(audits);
      expect(serializedAudits).not.toContain(writer.token);
      expect(serializedAudits).not.toContain("audit-job-payload");
      expect(audits.every((record) => Buffer.byteLength(record.payloadJson, "utf8") < 1_024)).toBe(true);
      await closeServer();
      expect(ledger.db.isOpen).toBe(true);
    } finally {
      await closeServer();
      journal.close();
      ledger.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("surfaces Ledger audit failures before an authorized Runner mutation", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "lightphysics-lpd-audit-failure-test-"));
    const runtime = deterministicWardenRuntime();
    const warden = new WardenSessionManager({
      clock: runtime.clock,
      randomBytes: runtime.randomBytes,
      policy: { defaultMode: "auto" },
    });
    const journal = new JobJournal({ home });
    const writer = warden.createSession({ kind: "gui", permissions: ["write_project"] });
    const failingLedger = {
      appendAudit: () => { throw new Error("storage path must not cross the API boundary"); },
      getAudit: () => null,
    } as unknown as Ledger;
    try {
      server = await startServer({
        config: loadConfig({ LP_HOME: home, LP_PORT: "4317" }),
        port: 0,
        token: "test-token",
        journal,
        warden,
        ledger: failingLedger,
      });
      const response = await rpc(server, {
        jsonrpc: "2.0",
        id: 58,
        method: "job.create",
        params: { id: "audit-failure-job" },
        context: {
          session_id: writer.sessionId,
          trace_id: "audit-failure",
          idempotency_key: "audit-failure-1",
        },
      }, { token: "test-token" });
      expect(response.body.error.data.code).toBe("Internal");
      expect(journal.getJob("audit-failure-job")).toBeUndefined();
    } finally {
      if (server?.listening) {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
      journal.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("demonstrates P1-E12 parity across independent in-process and HTTP kernels", async () => {
    type Kernel = {
      readonly home: string;
      readonly server: LpdServer;
      readonly journal: JobJournal;
      readonly ledger: Ledger;
      readonly writerSessionId: string;
      readonly readerSessionId: string;
    };

    const fixedTimestamp = "2026-01-01T00:00:00.000Z";
    const makeKernel = async (): Promise<Kernel> => {
      const home = mkdtempSync(path.join(os.tmpdir(), "lightphysics-lpd-parity-test-"));
      const runtime = deterministicWardenRuntime();
      const warden = new WardenSessionManager({
        clock: runtime.clock,
        randomBytes: runtime.randomBytes,
        policy: { defaultMode: "auto" },
      });
      const writer = warden.createSession({ kind: "gui", permissions: ["read", "write_project"] });
      const reader = warden.createSession({ kind: "agent", permissions: ["read"] });
      const journal = new JobJournal({ home, clock: () => new Date(fixedTimestamp) });
      const ledger = new Ledger({ home, now: () => fixedTimestamp });
      const server = await startServer({
        config: loadConfig({ LP_HOME: home, LP_PORT: "4317" }),
        port: 0,
        token: "p1-e12-http-token",
        journal,
        warden,
        ledger,
      });
      return {
        home,
        server,
        journal,
        ledger,
        writerSessionId: writer.sessionId,
        readerSessionId: reader.sessionId,
      };
    };

    const closeKernel = async (kernel: Kernel): Promise<void> => {
      if (kernel.server.listening) {
        await new Promise<void>((resolve, reject) => {
          kernel.server.close((error) => error ? reject(error) : resolve());
        });
      }
      kernel.journal.close();
      kernel.ledger.close();
      rmSync(kernel.home, { recursive: true, force: true });
    };

    const inProcessKernel = await makeKernel();
    const remoteKernel = await makeKernel();
    const scenario = (kernel: Kernel): readonly CoreClientRequest[] => {
      const context = (sessionId: string, traceId: string, idempotencyKey?: string) => ({
        session_id: sessionId,
        trace_id: traceId,
        ...(idempotencyKey === undefined ? {} : { idempotency_key: idempotencyKey }),
      });
      return [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "job.create",
          params: { id: "p1-e12-job", type: "parity", payload: { deterministic: true } },
          context: context(kernel.writerSessionId, "p1-e12-create", "p1-e12-create-1"),
        },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "job.create",
          params: { id: "p1-e12-job", type: "parity", payload: { deterministic: true } },
          context: context(kernel.writerSessionId, "p1-e12-create", "p1-e12-create-1"),
        },
        {
          jsonrpc: "2.0",
          id: 3,
          method: "job.get",
          params: { id: "p1-e12-job" },
          context: context(kernel.readerSessionId, "p1-e12-read"),
        },
        {
          jsonrpc: "2.0",
          id: 4,
          method: "job.create",
          params: { id: "p1-e12-denied-job", type: "parity", payload: { deterministic: true } },
          context: context(kernel.readerSessionId, "p1-e12-denied", "p1-e12-denied-1"),
        },
        {
          jsonrpc: "2.0",
          id: 5,
          method: "job.cancel",
          params: { id: "p1-e12-job", reason: "parity complete" },
          context: context(kernel.writerSessionId, "p1-e12-cancel", "p1-e12-cancel-1"),
        },
        {
          jsonrpc: "2.0",
          id: 6,
          method: "job.get",
          params: { id: "p1-e12-job" },
          context: context(kernel.readerSessionId, "p1-e12-read-after-cancel"),
        },
      ];
    };

    try {
      const address = serverAddress(remoteKernel.server);
      if (!address) throw new Error("remote parity server is not listening");
      const parity = await assertCoreClientParity(
        new InProcessClient(inProcessKernel.server.dispatcher),
        new RemoteClient({
          url: `http://127.0.0.1:${address.port}${"/rpc"}`,
          token: "p1-e12-http-token",
        }),
        scenario(inProcessKernel),
      );

      expect(parity.equal).toBe(true);
      expect(parity.inProcess).toEqual(parity.remote);
      expect(parity.inProcess[0]).toMatchObject({ result: { id: "p1-e12-job", state: "queued" } });
      expect(parity.inProcess[1]).toMatchObject({ id: 2, result: { id: "p1-e12-job", state: "queued" } });
      expect(parity.inProcess[2]).toMatchObject({ result: { id: "p1-e12-job", state: "queued" } });
      expect(parity.inProcess[3]).toMatchObject({ error: { data: { code: "PermissionDenied" } } });
      expect(parity.inProcess[4]).toMatchObject({ result: { id: "p1-e12-job", state: "cancelled" } });
      expect(parity.inProcess[5]).toMatchObject({ result: { id: "p1-e12-job", state: "cancelled" } });

      expect(inProcessKernel.journal.requireJob("p1-e12-job")).toEqual(
        remoteKernel.journal.requireJob("p1-e12-job"),
      );
      expect(inProcessKernel.journal.getJob("p1-e12-denied-job")).toBeUndefined();
      expect(remoteKernel.journal.getJob("p1-e12-denied-job")).toBeUndefined();
      expect(inProcessKernel.ledger.listAudits()).toEqual(remoteKernel.ledger.listAudits());
      expect(inProcessKernel.ledger.listAudits()).toHaveLength(5);
      expect(inProcessKernel.ledger.listAudits().map((record) => record.payload)).toEqual(expect.arrayContaining([
        expect.objectContaining({ method: "job.create", outcome: "allowed" }),
        expect.objectContaining({ method: "job.create", outcome: "permission_denied" }),
        expect.objectContaining({ method: "job.cancel", outcome: "allowed" }),
      ]));
      const inProcessChain = inProcessKernel.ledger.verifyChain();
      const remoteChain = remoteKernel.ledger.verifyChain();
      expect(inProcessChain).toEqual(remoteChain);
      expect(inProcessChain).toMatchObject({ ok: true, status: "verified", checkedRecords: 5 });
    } finally {
      await closeKernel(inProcessKernel);
      await closeKernel(remoteKernel);
    }
  });

  it("wires forge.create through HTTP and in-process clients with identical Ledger outcomes", async () => {
    type ForgeKernel = { home: string; server: LpdServer; ledger: Ledger; close: () => Promise<void> };
    const makeKernel = async (): Promise<ForgeKernel> => {
      const home = mkdtempSync(path.join(os.tmpdir(), "lightphysics-lpd-forge-parity-"));
      const ledger = new Ledger({ home, now: () => "2026-01-01T00:00:00.000Z" });
      const server = await startServer({
        config: loadConfig({ LP_HOME: home, LP_PORT: "4317" }),
        port: 0,
        token: "forge-token",
        ledger,
        forge: { adapters: [new MockAdapter()], ledger },
      });
      return {
        home,
        server,
        ledger,
        close: async () => {
          await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
          ledger.close();
          rmSync(home, { recursive: true, force: true });
        },
      };
    };
    const inProcess = await makeKernel();
    const remote = await makeKernel();
    const request = (id: number): CoreClientRequest => ({
      jsonrpc: "2.0",
      id,
      method: "forge.create",
      params: { capability: "image.generate", prompt: "a hidden prompt", fidelity: "sketch", seed: 7 },
      context: { session_id: "forge-session", trace_id: "forge-trace", idempotency_key: "forge-create-1" },
    });
    try {
      const address = serverAddress(remote.server);
      if (!address) throw new Error("forge parity server is not listening");
      const parity = await assertCoreClientParity(
        new InProcessClient(inProcess.server.dispatcher),
        new RemoteClient({ url: `http://127.0.0.1:${address.port}/rpc`, token: "forge-token" }),
        [request(1)],
      );
      expect(parity.equal).toBe(true);
      expect(parity.inProcess[0]).toMatchObject({ result: {
        status: "done",
        artifacts: [{ state: "exploration", recipe_id: expect.stringMatching(/^recipe-[0-9a-f]{64}$/) }],
        provenance: { request_hash: expect.stringMatching(/^[0-9a-f]{64}$/) },
      } });
      expect(inProcess.ledger.listArtifacts()).toEqual(remote.ledger.listArtifacts());
      expect(inProcess.ledger.listAudits()).toEqual(remote.ledger.listAudits());
      expect(inProcess.ledger.verifyChain()).toEqual(remote.ledger.verifyChain());
      expect(inProcess.ledger.verifyChain()).toMatchObject({ ok: true, checkedRecords: 3 });
      const serialized = JSON.stringify(inProcess.ledger.listRecords());
      expect(serialized).not.toContain("hidden prompt");
    } finally {
      await inProcess.close();
      await remote.close();
    }
  });

  it("replays forge.create idempotently without rerunning the provider or appending Ledger records", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "lightphysics-lpd-forge-replay-"));
    const ledger = new Ledger({ home, now: () => "2026-01-01T00:00:00.000Z" });
    let runs = 0;
    const adapter = new MockAdapter();
    const counting = {
      id: adapter.id,
      describe: () => adapter.describe(),
      health: () => adapter.health(),
      estimate: (request: Parameters<ForgeAdapter["estimate"]>[0]) => adapter.estimate(request),
      run: async (...args: Parameters<ForgeAdapter["run"]>) => {
        runs += 1;
        return adapter.run(...args);
      },
      qualify: () => adapter.qualify(),
    } as unknown as ForgeAdapter;
    const localServer = await startServer({ port: 0, token: "forge-token", ledger, forgeAdapters: [counting] });
    try {
      const base = {
        jsonrpc: "2.0" as const,
        method: "forge.create",
        params: { capability: "image.generate", prompt: "replay prompt" },
        context: { session_id: "replay-session", trace_id: "replay-trace", idempotency_key: "replay-1" },
      };
      const first = await rpc(localServer, { ...base, id: 1 }, { token: "forge-token" });
      const replay = await rpc(localServer, { ...base, id: 2 }, { token: "forge-token" });
      expect(replay.body.result).toEqual(first.body.result);
      expect(runs).toBe(1);
      expect(ledger.listRecords()).toHaveLength(3);
    } finally {
      await new Promise<void>((resolve, reject) => localServer.close((error) => error ? reject(error) : resolve()));
      ledger.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("blocks hosted Forge routes under local_only and maps provider failures visibly", async () => {
    const hosted = new MockAdapter({ id: "hosted-mock" });
    const hostedAdapter = {
      id: hosted.id,
      describe: () => ({ ...hosted.describe(), kind: "hosted" as const }),
      health: () => hosted.health(),
      estimate: (request: Parameters<ForgeAdapter["estimate"]>[0]) => hosted.estimate(request),
      run: (...args: Parameters<ForgeAdapter["run"]>) => hosted.run(...args),
      qualify: () => hosted.qualify(),
    } as unknown as ForgeAdapter;
    const blocked = await startServer({ port: 0, token: "forge-token", forge: {
      adapters: [hostedAdapter], dataPolicy: "local_only",
    } });
    try {
      const response = await rpc(blocked, {
        jsonrpc: "2.0", id: 1, method: "forge.create",
        params: { capability: "image.generate", prompt: "private" },
        context: { session_id: "s", trace_id: "t", idempotency_key: "local-only-1" },
      }, { token: "forge-token" });
      expect(response.body.error.data.code).toBe("ResourceUnavailable");
    } finally {
      await new Promise<void>((resolve, reject) => blocked.close((error) => error ? reject(error) : resolve()));
    }

    const failing = new MockAdapter({ failure: "timeout" });
    const providerServer = await startServer({ port: 0, token: "forge-token", forgeAdapters: [failing] });
    try {
      const response = await rpc(providerServer, {
        jsonrpc: "2.0", id: 2, method: "forge.create",
        params: { capability: "image.generate", prompt: "failure" },
        context: { session_id: "s", trace_id: "t2", idempotency_key: "timeout-1" },
      }, { token: "forge-token" });
      expect(response.body.error.data.code).toBe("ProviderError");
    } finally {
      await new Promise<void>((resolve, reject) => providerServer.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("requires Warden write_project and spend authorization and surfaces budget rejection", async () => {
    const runtime = deterministicWardenRuntime();
    const warden = new WardenSessionManager({ clock: runtime.clock, randomBytes: runtime.randomBytes, policy: { defaultMode: "auto" } });
    const reader = warden.createSession({ kind: "agent", permissions: ["read"] });
    const writer = warden.createSession({ kind: "agent", permissions: ["write_project"] });
    const localServer = await startServer({ port: 0, token: "forge-token", warden });
    try {
      const denied = await rpc(localServer, {
        jsonrpc: "2.0", id: 1, method: "forge.create",
        params: { capability: "image.generate" },
        context: { session_id: reader.sessionId, trace_id: "reader", idempotency_key: "warden-1" },
      }, { token: "forge-token" });
      expect(denied.body.error.data.code).toBe("PermissionDenied");

      const spendDenied = await rpc(localServer, {
        jsonrpc: "2.0", id: 2, method: "forge.create",
        params: { capability: "image.generate" },
        context: { session_id: writer.sessionId, trace_id: "writer", idempotency_key: "warden-2" },
      }, { token: "forge-token" });
      expect(spendDenied.body.error.data.code).toBe("PermissionDenied");
    } finally {
      await new Promise<void>((resolve, reject) => localServer.close((error) => error ? reject(error) : resolve()));
    }

    const paidBase = new MockAdapter();
    const paid = {
      id: paidBase.id,
      describe: () => paidBase.describe(),
      health: () => paidBase.health(),
      estimate: () => ({ cost: 1, currency: "USD" }),
      run: (...args: Parameters<ForgeAdapter["run"]>) => paidBase.run(...args),
      qualify: () => paidBase.qualify(),
    } as unknown as ForgeAdapter;
    const budgetWarden = new WardenSessionManager({
      clock: runtime.clock,
      randomBytes: runtime.randomBytes,
      policy: { defaultMode: "auto" },
      budgetLimit: 0,
    });
    const budgetSession = budgetWarden.createSession({ kind: "agent", permissions: ["write_project", "spend"] });
    const budgetServer = await startServer({ port: 0, token: "forge-token", warden: budgetWarden, forgeAdapters: [paid] });
    try {
      const result = await rpc(budgetServer, {
        jsonrpc: "2.0", id: 3, method: "forge.create",
        params: { capability: "image.generate" },
        context: { session_id: budgetSession.sessionId, trace_id: "budget", idempotency_key: "budget-1" },
      }, { token: "forge-token" });
      expect(result.body.error.data.code).toBe("BudgetExceeded");
    } finally {
      await new Promise<void>((resolve, reject) => budgetServer.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("maps an explicit unqualified adapter path to the Core error taxonomy", async () => {
    const adapter = {
      id: "unqualified",
      describe: () => ({ id: "unqualified", kind: "local" as const, capabilities: ["image.generate" as const], model: "test", version: "1" }),
      health: async () => ({ healthy: true, status: "ok" as const }),
      estimate: () => ({ cost: 0, currency: "USD" }),
      run: async () => { throw new ForgeError("Unqualified", "model has not been qualified"); },
      qualify: async () => ({ status: "UNQUALIFIED" as const, adapter_id: "unqualified", machine_profile: "test", versions: {}, date: "2026-01-01T00:00:00.000Z", checks: [] }),
    } as unknown as ForgeAdapter;
    const localServer = await startServer({ port: 0, token: "forge-token", forgeAdapters: [adapter] });
    try {
      const result = await rpc(localServer, {
        jsonrpc: "2.0", id: 4, method: "forge.create", params: { capability: "image.generate" },
        context: { session_id: "s", trace_id: "u", idempotency_key: "unqualified-1" },
      }, { token: "forge-token" });
      expect(result.body.error.data.code).toBe("Unqualified");
    } finally {
      await new Promise<void>((resolve, reject) => localServer.close((error) => error ? reject(error) : resolve()));
    }
  });
});
