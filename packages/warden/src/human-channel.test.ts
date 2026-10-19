import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, generateKeyPairSync, sign as nodeSign } from "node:crypto";
import { test } from "node:test";
import {
  EnrollmentConflictError,
  HumanChannel,
  HumanChannelInvalidEvidenceError,
  HumanChannelNotEnrolledError,
  HumanChannelPersistenceError,
  HumanChannelReplayError,
  HumanChannelValidationError,
  JsonFileHumanChannelStateStore,
  type ApprovalInput,
  type HumanChannelPersistedState,
  type HumanChannelStateStore,
} from "./human-channel.ts";

const SUBJECT_HASH = "a".repeat(64);
const INPUT: ApprovalInput = {
  subject_hash: SUBJECT_HASH,
  decision: "approve",
  reason: "release the verified build",
};

function setup(options: {
  readonly clock?: () => Date;
  readonly nonce?: () => string;
  readonly useDefaultNonce?: boolean;
  readonly maxReplayNonces?: number;
} = {}) {
  const keyPair = generateKeyPairSync("ed25519");
  const nonce = options.useDefaultNonce === true
    ? undefined
    : options.nonce ?? (() => "fixed-nonce-1");
  const channel = new HumanChannel({
    signer: (payload) => nodeSign(null, payload, keyPair.privateKey),
    clock: options.clock ?? (() => new Date("2026-01-02T03:04:05.000Z")),
    ...(nonce === undefined ? {} : { nonce }),
    ...(options.maxReplayNonces === undefined ? {} : { maxReplayNonces: options.maxReplayNonces }),
  });
  return { channel, keyPair };
}

function memoryStore(initial?: HumanChannelPersistedState, save?: (state: HumanChannelPersistedState) => void) {
  let state = initial;
  return {
    load: () => state,
    save: (next: HumanChannelPersistedState) => {
      if (save !== undefined) save(next);
      state = next;
    },
  };
}

test("TOFU enrollment requires confirmation and is idempotent for the same key", () => {
  const { channel, keyPair } = setup();
  assert.throws(
    () => channel.enrollPublicKey(keyPair.publicKey),
    (error: unknown) => error instanceof HumanChannelValidationError,
  );
  const first = channel.enrollPublicKey(keyPair.publicKey, { confirm: true });
  const second = channel.enrollPublicKey(keyPair.publicKey);
  assert.deepEqual(second, first);
  assert.equal(first.enrolled, true);
  assert.equal(first.algorithm, "Ed25519");
  assert.equal(first.publicKeyFingerprint?.length, 64);
  assert.equal("signature" in first, false);
});

test("a different key is rejected as a typed enrollment conflict", () => {
  const { channel, keyPair } = setup();
  const other = generateKeyPairSync("ed25519");
  channel.enroll(keyPair.publicKey, true);
  assert.throws(
    () => channel.enrollPublicKey(other.publicKey, true),
    (error: unknown) => error instanceof EnrollmentConflictError
      && !error.message.includes("BEGIN")
      && !error.message.includes("PRIVATE"),
  );
});

test("injected clock, nonce, and signer produce verifiable deterministic evidence", () => {
  const { channel, keyPair } = setup();
  channel.enrollPublicKey(keyPair.publicKey, true);
  const signed = channel.signApproval(INPUT);
  assert.deepEqual(signed, {
    ...INPUT,
    nonce: "fixed-nonce-1",
    timestamp: "2026-01-02T03:04:05.000Z",
    signature: signed.signature,
  });
  assert.equal(channel.verifySignedApproval(signed).verified, true);
  assert.equal(channel.status().replayedNonceCount, 1);
});

test("altered payload and altered signature fail without consuming replay state", () => {
  const { channel, keyPair } = setup();
  channel.enrollPublicKey(keyPair.publicKey, true);
  const signed = channel.signApproval(INPUT);

  assert.throws(
    () => channel.verify({ ...signed, reason: "different evidence" }),
    (error: unknown) => error instanceof HumanChannelInvalidEvidenceError,
  );
  assert.throws(
    () => channel.verify({
      ...signed,
      signature: `${signed.signature.startsWith("A") ? "B" : "A"}${signed.signature.slice(1)}`,
    }),
    (error: unknown) => error instanceof HumanChannelInvalidEvidenceError,
  );
  assert.equal(channel.status().replayedNonceCount, 0);
  assert.equal(channel.verify(signed).subject_hash, SUBJECT_HASH);
});

test("a valid nonce can only be verified once", () => {
  const { channel, keyPair } = setup();
  channel.enrollPublicKey(keyPair.publicKey, true);
  const signed = channel.signApproval(INPUT);
  channel.verify(signed);
  assert.throws(
    () => channel.verify(signed),
    (error: unknown) => error instanceof HumanChannelReplayError,
  );
  assert.equal(channel.status().replayedNonceCount, 1);
});

test("malformed hash, reason, nonce, timestamp, and signature are invalid evidence", () => {
  const { channel, keyPair } = setup();
  channel.enrollPublicKey(keyPair.publicKey, true);
  const signed = channel.signApproval(INPUT);
  const malformed = [
    { ...signed, subject_hash: SUBJECT_HASH.toUpperCase() },
    { ...signed, reason: "bad\u0000reason" },
    { ...signed, nonce: "bad nonce" },
    { ...signed, timestamp: "2026-01-02T03:04:05Z" },
    { ...signed, signature: "not-a-signature" },
  ];
  for (const candidate of malformed) {
    assert.throws(
      () => channel.verify(candidate),
      (error: unknown) => error instanceof HumanChannelInvalidEvidenceError,
    );
  }
  assert.equal(channel.status().replayedNonceCount, 0);
});

test("signing and verifying require enrollment", () => {
  const { channel } = setup();
  assert.throws(
    () => channel.signApproval(INPUT),
    (error: unknown) => error instanceof HumanChannelNotEnrolledError,
  );
  assert.throws(
    () => channel.verify({
      ...INPUT,
      nonce: "fixed-nonce-1",
      timestamp: "2026-01-02T03:04:05.000Z",
      signature: "A".repeat(86),
    }),
    (error: unknown) => error instanceof HumanChannelNotEnrolledError,
  );
});

test("default nonce generation is bounded and replay state stays bounded", () => {
  const { channel, keyPair } = setup({ useDefaultNonce: true, maxReplayNonces: 1 });
  channel.enrollPublicKey(keyPair.publicKey, true);
  const signed = channel.signApproval(INPUT);
  assert.ok(signed.nonce.length > 0);
  channel.verify(signed);
  assert.equal(channel.status().replayedNonceCount, 1);
  assert.equal(channel.status().replayStateLimit, 1);
});

test("safe status serialization exposes no key, signer, or raw signature", () => {
  const { channel, keyPair } = setup();
  channel.enrollPublicKey(keyPair.publicKey, true);
  const signed = channel.signApproval(INPUT);
  const serialized = JSON.stringify(channel.status());
  assert.equal(serialized.includes("PRIVATE KEY"), false);
  assert.equal(serialized.includes(signed.signature), false);
  assert.equal(serialized.includes("signer"), false);
  assert.equal(Object.keys(channel.status()).includes("publicKey"), false);
});

test("the same store restores enrollment and rejects a persisted nonce after restart", () => {
  const keyPair = generateKeyPairSync("ed25519");
  const store = memoryStore();
  const first = new HumanChannel({
    signer: (payload) => nodeSign(null, payload, keyPair.privateKey),
    clock: () => new Date("2026-01-02T03:04:05.000Z"),
    nonce: () => "restart-nonce",
    stateStore: store,
  });
  first.enrollPublicKey(keyPair.publicKey, true);
  const signed = first.signApproval(INPUT);
  first.verify(signed);

  const second = new HumanChannel({
    signer: (payload) => nodeSign(null, payload, keyPair.privateKey),
    clock: () => new Date("2026-01-02T03:04:05.000Z"),
    nonce: () => "different-nonce",
    stateStore: store,
  });
  assert.equal(second.status().enrolled, true);
  assert.equal(second.status().replayedNonceCount, 1);
  assert.throws(() => second.verify(signed), (error: unknown) => error instanceof HumanChannelReplayError);
});

test("initial enrollment save failure leaves the channel unenrolled", () => {
  const { keyPair } = setup();
  const channel = new HumanChannel({
    signer: (payload) => nodeSign(null, payload, keyPair.privateKey),
    stateStore: memoryStore(undefined, () => { throw new Error("private persistence detail"); }),
  });
  assert.throws(
    () => channel.enrollPublicKey(keyPair.publicKey, true),
    (error: unknown) => error instanceof HumanChannelPersistenceError
      && error.message === "The Human Channel persisted state is unavailable"
      && !error.message.includes("private persistence detail"),
  );
  assert.equal(channel.status().enrolled, false);
  assert.throws(() => channel.signApproval(INPUT), (error: unknown) => error instanceof HumanChannelNotEnrolledError);
});

test("nonce save failure consumes the nonce in the current process", () => {
  const { keyPair } = setup({ nonce: () => "save-failure-nonce" });
  let saves = 0;
  const store = memoryStore(undefined, () => {
    saves += 1;
    if (saves > 1) throw new Error("save implementation detail");
  });
  const channel = new HumanChannel({
    signer: (payload) => nodeSign(null, payload, keyPair.privateKey),
    clock: () => new Date("2026-01-02T03:04:05.000Z"),
    nonce: () => "save-failure-nonce",
    stateStore: store,
  });
  channel.enrollPublicKey(keyPair.publicKey, true);
  const signed = channel.signApproval(INPUT);
  assert.throws(() => channel.verify(signed), (error: unknown) => error instanceof HumanChannelPersistenceError);
  assert.equal(channel.status().replayedNonceCount, 1);
  assert.throws(() => channel.verify(signed), (error: unknown) => error instanceof HumanChannelReplayError);
});

test("malformed persisted state fails closed without exposing state input", () => {
  const { keyPair } = setup();
  const publicKeyDer = keyPair.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  const publicKeyFingerprint = createHash("sha256")
    .update(keyPair.publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");
  const privateKeyDer = keyPair.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url");
  const otherKeyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const otherPublicKeyDer = otherKeyPair.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  const otherPublicKeyFingerprint = createHash("sha256")
    .update(otherKeyPair.publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");
  const validState: HumanChannelPersistedState = {
    schemaVersion: 1,
    publicKeyDer,
    publicKeyFingerprint,
    enrolledAt: "2026-01-02T03:04:05.000Z",
    usedNonces: [],
  };
  const invalidStates: unknown[] = [
    { nope: "malformed private-looking state" },
    {
      ...validState,
      privateKey: "BEGIN PRIVATE KEY secret",
    },
    {
      ...validState,
      schemaVersion: 2,
    },
    {
      ...validState,
      publicKeyFingerprint: "0".repeat(64),
    },
    {
      ...validState,
      publicKeyDer: otherPublicKeyDer,
      publicKeyFingerprint: otherPublicKeyFingerprint,
    },
    {
      ...validState,
      publicKeyDer: privateKeyDer,
    },
  ];
  for (const value of invalidStates) {
    const store = { load: () => value, save: () => undefined } as unknown as HumanChannelStateStore;
    assert.throws(
      () => new HumanChannel({ signer: () => new Uint8Array(64), stateStore: store }),
      (error: unknown) => error instanceof HumanChannelPersistenceError
        && error.message === "The Human Channel persisted state is unavailable"
        && !error.message.includes("private-looking")
        && !error.message.includes("BEGIN PRIVATE"),
    );
  }
});

test("file state is canonical, bounded, and contains no private or approval material", () => {
  const directory = mkdtempSync(join(tmpdir(), "human-channel-"));
  try {
    const statePath = join(directory, "state.json");
    const store = new JsonFileHumanChannelStateStore(statePath);
    const { channel, keyPair } = setup({ nonce: () => "file-round-trip-nonce" });
    const persistentChannel = new HumanChannel({
      signer: (payload) => nodeSign(null, payload, keyPair.privateKey),
      clock: () => new Date("2026-01-02T03:04:05.000Z"),
      nonce: () => "file-round-trip-nonce",
      stateStore: store,
    });
    persistentChannel.enrollPublicKey(keyPair.publicKey, true);
    const signed = persistentChannel.signApproval(INPUT);
    persistentChannel.verify(signed);
    const json = readFileSync(statePath, "utf8");
    assert.equal(json, JSON.stringify(JSON.parse(json)));
    assert.ok(Buffer.byteLength(json, "utf8") < 1_048_576);
    assert.equal(json.includes("PRIVATE KEY"), false);
    assert.equal(json.includes("signer"), false);
    assert.equal(json.includes(INPUT.reason), false);
    assert.equal(json.includes(signed.signature), false);
    assert.equal(json.includes("bearer"), false);
    assert.deepEqual(Object.keys(JSON.parse(json)), [
      "schemaVersion",
      "publicKeyDer",
      "publicKeyFingerprint",
      "enrolledAt",
      "usedNonces",
    ]);
    assert.equal(channel.status().enrolled, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("file store rejects malformed, oversized, and non-regular state files", () => {
  const directory = mkdtempSync(join(tmpdir(), "human-channel-"));
  try {
    const malformedPath = join(directory, "malformed.json");
    writeFileSync(malformedPath, "not-json", "utf8");
    const malformedStore = new JsonFileHumanChannelStateStore(malformedPath);
    assert.throws(() => malformedStore.load(), (error: unknown) => error instanceof HumanChannelPersistenceError);

    const oversizedPath = join(directory, "oversized.json");
    writeFileSync(oversizedPath, "x".repeat(1_048_577), "utf8");
    const oversizedStore = new JsonFileHumanChannelStateStore(oversizedPath);
    assert.throws(() => oversizedStore.load(), (error: unknown) => error instanceof HumanChannelPersistenceError);

    const directoryPath = join(directory, "directory.json");
    // The constructor itself rejects an existing non-regular state path.
    const fsDirectory = join(directory, "state-directory");
    writeFileSync(directoryPath, "{}", "utf8");
    mkdirSync(fsDirectory);
    assert.throws(
      () => new JsonFileHumanChannelStateStore(fsDirectory),
      (error: unknown) => error instanceof HumanChannelPersistenceError,
    );
    // Symlink creation is unavailable on some Windows configurations.
    const symlinkPath = join(directory, "symlink.json");
    try {
      symlinkSync(directoryPath, symlinkPath);
      assert.throws(
        () => new JsonFileHumanChannelStateStore(symlinkPath),
        (error: unknown) => error instanceof HumanChannelPersistenceError,
      );
    } catch (error: unknown) {
      if ((error as { readonly code?: unknown }).code !== "EPERM") throw error;
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
