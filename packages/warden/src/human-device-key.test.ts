import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  verify as nodeVerify,
} from "node:crypto";
import { test } from "node:test";
import {
  HumanChannel,
  type ApprovalInput,
} from "./human-channel.ts";
import {
  HumanChannelDeviceSigner,
  HumanChannelKeyPersistenceError,
  HumanChannelKeyValidationError,
  InMemoryHumanChannelKeyStore,
  MAX_HUMAN_CHANNEL_PRIVATE_KEY_DER_BYTES,
} from "./human-device-key.ts";

const INPUT: ApprovalInput = {
  subject_hash: "a".repeat(64),
  decision: "approve",
  reason: "release the verified build",
};

function privateDer(): Uint8Array {
  return Uint8Array.from(generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "der" }));
}

function publicDer(): Uint8Array {
  return Uint8Array.from(generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }));
}

function rsaDer(): Uint8Array {
  return Uint8Array.from(generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
    type: "pkcs8",
    format: "der",
  }));
}

test("first construction generates and saves only a bounded private DER", () => {
  const store = new InMemoryHumanChannelKeyStore();
  const signer = new HumanChannelDeviceSigner(store);
  const saved = store.loadPrivateKeyDer();

  assert.ok(saved instanceof Uint8Array);
  assert.ok(saved.byteLength > 0);
  assert.ok(saved.byteLength <= MAX_HUMAN_CHANNEL_PRIVATE_KEY_DER_BYTES);
  assert.equal(signer.publicKeyFingerprint.length, 64);
  assert.equal(signer.publicKey.byteLength > 0, true);
  assert.equal(JSON.stringify(signer).includes("PRIVATE KEY"), false);
});

test("a new signer restores the same public fingerprint from the store", () => {
  const store = new InMemoryHumanChannelKeyStore();
  const first = new HumanChannelDeviceSigner(store);
  const second = new HumanChannelDeviceSigner(store);

  assert.equal(second.publicKeyFingerprint, first.publicKeyFingerprint);
  assert.deepEqual(second.publicKey, first.publicKey);
});

test("the signer seam signs and verifies through the existing Human Channel", () => {
  const deviceSigner = new HumanChannelDeviceSigner(new InMemoryHumanChannelKeyStore());
  const channel = new HumanChannel({
    signer: deviceSigner.signer,
    clock: () => new Date("2026-01-02T03:04:05.000Z"),
    nonce: () => "device-key-test-nonce",
  });

  const status = channel.enrollPublicKey(deviceSigner.publicKey, true);
  const signed = channel.signApproval(INPUT);
  const signature = Buffer.from(signed.signature, "base64url");
  assert.equal(status.publicKeyFingerprint, deviceSigner.publicKeyFingerprint);
  assert.equal(signature.byteLength, 64);
  assert.equal(channel.verifySignedApproval(signed).verified, true);
  assert.equal(
    nodeVerify(
      null,
      Buffer.from(JSON.stringify({
        subject_hash: signed.subject_hash,
        decision: signed.decision,
        reason: signed.reason,
        nonce: signed.nonce,
        timestamp: signed.timestamp,
      }), "utf8"),
      { key: Buffer.from(deviceSigner.publicKey), format: "der", type: "spki" },
      signature,
    ),
    true,
  );
});

test("the in-memory test store copies bytes on save and load", () => {
  const expected = privateDer();
  const input = Uint8Array.from(expected);
  const store = new InMemoryHumanChannelKeyStore();
  store.savePrivateKeyDer(input);
  input.fill(0);

  const loaded = store.loadPrivateKeyDer();
  assert.deepEqual(loaded, expected);
  loaded?.fill(0);
  assert.deepEqual(store.loadPrivateKeyDer(), expected);
});

test("RSA, public, garbage, and private-looking malformed material are rejected safely", () => {
  const candidates = [
    rsaDer(),
    publicDer(),
    Uint8Array.from([0xde, 0xad, 0xbe, 0xef]),
    Uint8Array.from(Buffer.from([
      "-----BEGIN ",
      "PRIVATE ",
      "KEY-----secret-----END ",
      "PRIVATE ",
      "KEY-----",
    ].join(""), "utf8")),
  ];

  for (const candidate of candidates) {
    const store = { loadPrivateKeyDer: () => candidate, savePrivateKeyDer: () => undefined };
    assert.throws(
      () => new HumanChannelDeviceSigner(store),
      (error: unknown) => error instanceof HumanChannelKeyValidationError
        && error.message === "The Human Channel device key is invalid"
        && !error.message.includes("PRIVATE")
        && !error.message.includes("secret"),
    );
  }
});

test("store load and save failures become static persistence errors", () => {
  const loadFailure = {
    loadPrivateKeyDer: () => { throw new Error("private load detail"); },
    savePrivateKeyDer: () => undefined,
  };
  assert.throws(
    () => new HumanChannelDeviceSigner(loadFailure),
    (error: unknown) => error instanceof HumanChannelKeyPersistenceError
      && error.message === "The Human Channel device key is unavailable"
      && !error.message.includes("private load detail"),
  );

  const saveFailure = {
    loadPrivateKeyDer: () => undefined,
    savePrivateKeyDer: () => { throw new Error("private save detail"); },
  };
  assert.throws(
    () => new HumanChannelDeviceSigner(saveFailure),
    (error: unknown) => error instanceof HumanChannelKeyPersistenceError
      && error.message === "The Human Channel device key is unavailable"
      && !error.message.includes("private save detail"),
  );
});

test("invalid and oversized store inputs are bounded without leaking bytes", () => {
  const oversized = new Uint8Array(MAX_HUMAN_CHANNEL_PRIVATE_KEY_DER_BYTES + 1).fill(7);
  const store = new InMemoryHumanChannelKeyStore();
  assert.throws(
    () => store.savePrivateKeyDer(oversized),
    (error: unknown) => error instanceof HumanChannelKeyValidationError,
  );
  assert.throws(
    () => new InMemoryHumanChannelKeyStore(new Uint8Array()),
    (error: unknown) => error instanceof HumanChannelKeyValidationError,
  );

  const malformed = Uint8Array.from(Buffer.from(["-----BEGIN ", "PRIVATE ", "KEY-----secret"].join(""), "utf8"));
  const malformedStore = {
    loadPrivateKeyDer: () => malformed,
    savePrivateKeyDer: () => undefined,
  };
  let caught: unknown;
  try {
    new HumanChannelDeviceSigner(malformedStore);
  } catch (error: unknown) {
    caught = error;
  }
  const serialized = JSON.stringify(caught);
  assert.equal(serialized.includes("secret"), false);
  assert.equal(serialized.includes("PRIVATE KEY"), false);
  assert.equal(serialized.includes(Buffer.from(malformed).toString("base64")), false);
});

test("public fingerprint is SHA-256 of the public SPKI DER and public views are copied", () => {
  const signer = new HumanChannelDeviceSigner(new InMemoryHumanChannelKeyStore());
  const publicKey = signer.publicKey;
  const expected = createHash("sha256").update(Buffer.from(publicKey)).digest("hex");
  publicKey.fill(0);

  assert.equal(signer.publicKeyFingerprint, expected);
  assert.notDeepEqual(signer.publicKey, publicKey);
  assert.deepEqual(JSON.parse(JSON.stringify({
    publicKeyFingerprint: signer.publicKeyFingerprint,
    signer: signer.signer,
  })), {
    publicKeyFingerprint: expected,
    signer: {},
  });
});
