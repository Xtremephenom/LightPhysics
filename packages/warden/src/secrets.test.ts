import assert from "node:assert/strict";
import { test } from "node:test";
import {
  InMemorySecretStore,
  MAX_SECRET_NAME_BYTES,
  MAX_SECRET_VALUE_BYTES,
  RedactionRegistry,
  SecretValidationError,
} from "./secrets.ts";

function deterministicBytes(seed: number) {
  return (size: number): Uint8Array =>
    Uint8Array.from({ length: size }, (_, index) => (seed + index) % 256);
}

test("InMemorySecretStore stores exact values behind opaque references and deletes them", () => {
  const store = new InMemorySecretStore({
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    randomBytes: deterministicBytes(7),
  });
  const value = "  exact\nvalue\u{1F512}  ";
  const ref = store.set("provider credential", value);

  assert.notEqual(ref, value);
  assert.match(ref, /^sec_[A-Za-z0-9_-]+$/);
  assert.equal(store.resolve(ref), value);
  assert.deepEqual(store.list(), [
    {
      ref,
      name: "provider credential",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ]);
  assert.equal(store.delete(ref), true);
  assert.equal(store.resolve(ref), undefined);
  assert.equal(store.delete(ref), false);
  assert.deepEqual(store.list(), []);
});

test("store metadata and errors never expose secret values", () => {
  const value = "sk-test-very-secret-value-123456";
  const store = new InMemorySecretStore({ randomBytes: deterministicBytes(20) });
  const ref = store.set("openai credential", value);
  const serialized = JSON.stringify(store.list());
  assert.doesNotMatch(serialized, new RegExp(value));
  assert.doesNotMatch(JSON.stringify({ ref, metadata: store.list() }), new RegExp(value));

  assert.throws(
    () => store.set(`Bearer ${"A".repeat(20)}`, value),
    (error: unknown) => {
      assert.ok(error instanceof SecretValidationError);
      assert.doesNotMatch(error.message, new RegExp(value));
      assert.doesNotMatch(error.message, /Bearer/);
      return true;
    },
  );
  assert.equal(store.resolve(ref), value);
});

test("store rejects empty, NUL, oversized, and secret-shaped input without echoing it", () => {
  const store = new InMemorySecretStore();
  const invalidInputs: Array<[string, string]> = [
    ["", "value"],
    ["   ", "value"],
    ["bad\u0000name", "value"],
    ["good-name", ""],
    ["good\u0000name", "value"],
    ["good-name", "bad\u0000value"],
    ["x".repeat(MAX_SECRET_NAME_BYTES + 1), "value"],
    ["good-name", "x".repeat(MAX_SECRET_VALUE_BYTES + 1)],
    ["sk-test-abcdefghijklmnop", "value"],
  ];
  for (const [name, value] of invalidInputs) {
    assert.throws(
      () => store.set(name, value),
      (error: unknown) => {
        assert.ok(error instanceof SecretValidationError);
        assert.doesNotMatch(error.message, /bad|sk-test|abcdefghijklmnop|Bearer|x{20}/i);
        return true;
      },
    );
  }
  assert.equal(store.size, 0);
});

test("RedactionRegistry handles multiple, repeated, and overlapping values", () => {
  const registry = new RedactionRegistry();
  registry.register("alpha");
  registry.register("aba");
  registry.register("bab");
  registry.register("alpha");

  const result = registry.redact("alpha alpha | ababab");
  assert.equal(result, "[REDACTED] [REDACTED] | [REDACTED][REDACTED]");
  assert.doesNotMatch(result, /alpha|aba|bab/);
  assert.equal(registry.size, 3);
});

test("redaction bounds and errors do not expose raw values", () => {
  const privateValue = "private-value-123";
  const registry = new RedactionRegistry({ maxSecretBytes: 32, maxTextBytes: 32, maxSecrets: 1 });
  registry.register(privateValue);
  assert.equal(
    registry.redact("prefix private-value-123 suffix"),
    "prefix [REDACTED] suffix",
  );

  assert.throws(
    () => registry.register("another-secret"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /another-secret|private-value-123/);
      return true;
    },
  );
  assert.throws(
    () => registry.redact("x".repeat(33)),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /x{20}|private-value-123/);
      return true;
    },
  );
  assert.throws(() => registry.register(""), /may not be empty/);
  assert.throws(() => registry.register("nul\u0000secret"), /NUL/);
  assert.doesNotMatch(JSON.stringify(registry), /private-value-123/);
});
