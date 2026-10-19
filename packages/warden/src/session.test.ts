import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ApprovalRequiredError,
  BudgetExceededError,
  PermissionDeniedError,
  SessionExpiredError,
  SessionRevokedError,
  UnauthorizedError,
  WardenValidationError,
} from "./policy.ts";
import { WardenSessionManager } from "./session.ts";

function deterministicRuntime(): {
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

test("creates deterministic scoped sessions and never returns the token in views", () => {
  const runtime = deterministicRuntime();
  const manager = new WardenSessionManager({
    clock: runtime.clock,
    randomBytes: runtime.randomBytes,
    policy: { modes: { read: "auto" } },
    defaultTtlMs: 10_000,
  });
  const created = manager.createSession({
    kind: "agent",
    project: "project-one",
    roles: ["builder"],
    permissions: ["read"],
  });

  assert.match(created.token, /^[A-Za-z0-9_-]{40,60}$/);
  assert.equal(created.session.id, created.sessionId);
  assert.equal(created.session.project, "project-one");
  assert.deepEqual(created.session.allowedPermissions, ["read"]);
  assert.equal("token" in created.session, false);
  assert.equal(manager.validateToken(created.token).id, created.session.id);
  assert.equal(manager.validateSession(created.session.id).id, created.session.id);
  assert.equal(manager.validateSession(created.token).id, created.session.id);
});

test("enforces permission and project scope, then expiry and revocation", () => {
  const runtime = deterministicRuntime();
  const manager = new WardenSessionManager({
    clock: runtime.clock,
    randomBytes: runtime.randomBytes,
    policy: { defaultMode: "auto" },
    budgetLimit: 100,
  });
  const created = manager.createSession({
    kind: "gui",
    project: "project-one",
    permissions: ["read", "write_project"],
    ttlMs: 2_000,
  });

  assert.equal(manager.authorize(created.token, { permission: "read", project: "project-one" }).decision, "allowed");
  assert.throws(
    () => manager.authorize(created.token, { permission: "read", project: "project-two" }),
    (error: unknown) => error instanceof PermissionDeniedError && error.code === "PermissionDenied",
  );
  assert.throws(
    () => manager.authorize(created.token, { permission: "engine_exec", project: "project-one" }),
    PermissionDeniedError,
  );

  runtime.advance(2_000);
  assert.throws(() => manager.validateToken(created.token), SessionExpiredError);

  const second = manager.createSession({ kind: "gui", permissions: ["read"] });
  assert.equal(manager.revokeToken(second.token), true);
  assert.equal(manager.revoke(second.session.id), false);
  assert.throws(() => manager.validateToken(second.token), SessionRevokedError);
});

test("authorizes by session id with the same scope, policy, and budget rules without accepting a token", () => {
  const runtime = deterministicRuntime();
  const manager = new WardenSessionManager({
    clock: runtime.clock,
    randomBytes: runtime.randomBytes,
    policy: { defaultMode: "auto" },
    budgetLimit: 10,
  });
  const created = manager.createSession({
    kind: "gui",
    project: "project-one",
    permissions: ["read", "spend"],
  });

  assert.equal(
    manager.authorizeSession(created.sessionId, { permission: "read", project: "project-one" }).decision,
    "allowed",
  );
  assert.equal(
    manager.authorizeSession(created.sessionId, { permission: "spend", project: "project-one", spendEstimate: 6 }).decision,
    "allowed",
  );
  assert.throws(
    () => manager.authorizeSession(created.sessionId, { permission: "read", project: "project-two" }),
    PermissionDeniedError,
  );
  assert.throws(
    () => manager.authorizeSession(created.sessionId, { permission: "spend", project: "project-one", spendEstimate: 5 }),
    BudgetExceededError,
  );
  assert.throws(
    () => manager.authorizeSession(created.token, { permission: "read" }),
    (error: unknown) => error instanceof UnauthorizedError && !error.message.includes(created.token),
  );
  assert.throws(
    () => manager.authorizeSession(created.sessionId, { permission: "read", token: created.token } as never),
    WardenValidationError,
  );
});

test("session-id authorization rejects expired and revoked sessions", () => {
  const runtime = deterministicRuntime();
  const manager = new WardenSessionManager({
    clock: runtime.clock,
    randomBytes: runtime.randomBytes,
    policy: { defaultMode: "auto" },
  });
  const expiring = manager.createSession({ kind: "agent", permissions: ["read"], ttlMs: 2_000 });
  runtime.advance(2_000);
  assert.throws(
    () => manager.authorizeSession(expiring.sessionId, { permission: "read" }),
    SessionExpiredError,
  );

  const revoked = manager.createSession({ kind: "agent", permissions: ["read"] });
  assert.equal(manager.revokeSession(revoked.sessionId), true);
  assert.throws(
    () => manager.authorizeSession(revoked.sessionId, { permission: "read" }),
    SessionRevokedError,
  );
});

test("approve is denied for all agent-like sessions even with auto policy", () => {
  const runtime = deterministicRuntime();
  const manager = new WardenSessionManager({
    clock: runtime.clock,
    randomBytes: runtime.randomBytes,
    policy: { defaultMode: "auto" },
  });
  for (const kind of ["agent", "cli", "studio-agent"] as const) {
    const session = manager.createSession({ kind, permissions: ["approve"] });
    assert.throws(
      () => manager.authorize(session.token, { permission: "approve" }),
      (error: unknown) => error instanceof PermissionDeniedError && error.code === "PermissionDenied",
    );
  }
  const gui = manager.createSession({ kind: "gui", permissions: ["approve"] });
  assert.equal(manager.authorize(gui.token, { permission: "approve" }).decision, "allowed");
});

test("ask returns an approval-required decision and exception-style authorization throws", () => {
  const runtime = deterministicRuntime();
  const manager = new WardenSessionManager({
    clock: runtime.clock,
    randomBytes: runtime.randomBytes,
    policy: { defaultMode: "ask" },
  });
  const session = manager.createSession({ kind: "gui", permissions: ["release"] });
  assert.equal(manager.authorize(session.token, { permission: "release" }).decision, "approval_required");
  assert.throws(
    () => manager.authorizeOrThrow(session.token, { permission: "release" }),
    ApprovalRequiredError,
  );
});

test("spend authorization trips and recovers the bounded budget without token leakage", () => {
  const runtime = deterministicRuntime();
  const manager = new WardenSessionManager({
    clock: runtime.clock,
    randomBytes: runtime.randomBytes,
    policy: { defaultMode: "auto" },
    budgetLimit: 10,
  });
  const session = manager.createSession({ kind: "agent", permissions: ["spend"] });
  assert.equal(manager.authorize(session.token, { permission: "spend", spendEstimate: 6 }).decision, "allowed");
  assert.deepEqual(manager.budgetStatus(), { limit: 10, used: 6, remaining: 4, tripped: false });
  assert.throws(
    () => manager.authorize(session.token, { permission: "spend", spendEstimate: 5 }),
    (error: unknown) => error instanceof BudgetExceededError
      && error.code === "BudgetExceeded"
      && !error.message.includes(session.token),
  );
  assert.deepEqual(manager.budgetStatus(), { limit: 10, used: 6, remaining: 4, tripped: true });
  assert.equal(manager.authorize(session.token, { permission: "spend", spendEstimate: 4 }).decision, "allowed");
  assert.deepEqual(manager.budgetStatus(), { limit: 10, used: 10, remaining: 0, tripped: false });
});

test("rejects malformed bounded input and invalid credentials without echoing bearer tokens", () => {
  const runtime = deterministicRuntime();
  const manager = new WardenSessionManager({
    clock: runtime.clock,
    randomBytes: runtime.randomBytes,
    policy: { defaultMode: "auto" },
  });
  assert.throws(() => manager.createSession({ kind: "agent", ttlMs: 0 }), WardenValidationError);
  assert.throws(() => manager.createSession({ kind: "agent", project: "bad project" }), WardenValidationError);
  assert.throws(() => manager.createSession({ kind: "agent", roles: ["builder", "builder"] }), WardenValidationError);

  const credential = "not-a-real-bearer-token";
  assert.throws(
    () => manager.validateToken(credential),
    (error: unknown) => error instanceof UnauthorizedError && !error.message.includes(credential),
  );
});
