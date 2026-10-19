import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ApprovalRequiredError,
  BudgetCircuitBreaker,
  BudgetExceededError,
  PERMISSION_CLASSES,
  PermissionDeniedError,
  WardenPolicy,
  WardenValidationError,
} from "./policy.ts";

test("evaluates all eight permission classes in all three policy modes", () => {
  for (const permission of PERMISSION_CLASSES) {
    const auto = new WardenPolicy({ modes: { [permission]: "auto" } }).evaluate(permission);
    assert.equal(auto.decision, "allowed");
    assert.equal(auto.allowed, true);

    const ask = new WardenPolicy({ modes: { [permission]: "ask" } }).evaluate(permission);
    assert.equal(ask.decision, "approval_required");
    assert.equal(ask.approvalRequired, true);

    assert.throws(
      () => new WardenPolicy({ modes: { [permission]: "deny" } }).evaluate(permission),
      (error: unknown) => error instanceof PermissionDeniedError && error.code === "PermissionDenied",
    );
  }
});

test("enforce turns ask into a typed approval error without leaking inputs", () => {
  const policy = new WardenPolicy({ defaultMode: "ask" });
  assert.throws(
    () => policy.enforce("release"),
    (error: unknown) => error instanceof ApprovalRequiredError
      && error.code === "ApprovalRequired"
      && !error.message.includes("release"),
  );
});

test("approve is never granted to agent-like session kinds", () => {
  for (const kind of ["agent", "cli", "studio-agent"] as const) {
    const policy = new WardenPolicy({ defaultMode: "auto" });
    assert.throws(
      () => policy.evaluate("approve", { sessionKind: kind }),
      (error: unknown) => error instanceof PermissionDeniedError && error.code === "PermissionDenied",
    );
  }
  assert.equal(
    new WardenPolicy({ defaultMode: "auto" }).evaluate("approve", { sessionKind: "gui" }).decision,
    "allowed",
  );
});

test("budget circuit breaker rejects without consuming and recovers", () => {
  const budget = new BudgetCircuitBreaker({ limit: 10 });
  assert.deepEqual(budget.accept(6), {
    limit: 10,
    used: 6,
    remaining: 4,
    tripped: false,
  });
  assert.throws(
    () => budget.accept(5),
    (error: unknown) => error instanceof BudgetExceededError && error.code === "BudgetExceeded",
  );
  assert.deepEqual(budget.snapshot(), {
    limit: 10,
    used: 6,
    remaining: 4,
    tripped: true,
  });
  assert.deepEqual(budget.accept(4), {
    limit: 10,
    used: 10,
    remaining: 0,
    tripped: false,
  });
  assert.throws(() => new BudgetCircuitBreaker({ limit: Number.POSITIVE_INFINITY }), WardenValidationError);
});
