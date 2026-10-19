import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as nodeSign } from "node:crypto";
import { test } from "node:test";
import {
  HumanChannel,
  HumanChannelInvalidEvidenceError,
  HumanChannelReplayError,
  MAX_APPROVAL_REASON_BYTES,
  type ApprovalDecision,
  type SignedApproval,
} from "./human-channel.ts";
import {
  appendHumanEvidence,
  HumanEvidenceConflictError,
  HumanEvidencePersistenceError,
  HumanEvidenceSinkValidationError,
  MAX_HUMAN_EVIDENCE_BYTES,
  type HumanEvidencePayload,
  type HumanEvidenceSink,
} from "./human-evidence.ts";

function setup() {
  const keyPair = generateKeyPairSync("ed25519");
  const channel = new HumanChannel({
    signer: { sign: (payload) => nodeSign(null, payload, keyPair.privateKey) },
    clock: () => new Date("2026-01-02T03:04:05.000Z"),
    nonce: () => "human-evidence-nonce",
  });
  channel.enrollPublicKey(keyPair.publicKey, true);
  const sign = (decision: ApprovalDecision = "approve", reason = "verified build reviewed") => channel.signApproval({
    subject_hash: "a".repeat(64),
    decision,
    reason,
  });
  return { channel, keyPair, sign };
}

class MemorySink implements HumanEvidenceSink {
  readonly records = new Map<string, { readonly payload: HumanEvidencePayload }>();
  appendCount = 0;

  appendEvidence(id: string, payload: HumanEvidencePayload): unknown {
    this.appendCount += 1;
    assert.equal(this.records.has(id), false);
    const record = { payload };
    this.records.set(id, record);
    return record;
  }

  getEvidence(id: string): unknown {
    return this.records.get(id) ?? null;
  }
}

for (const decision of ["approve", "reject"] as const) {
  test(`${decision} becomes bounded, typed human evidence with only verified fields`, () => {
    const { channel, sign } = setup();
    const sink = new MemorySink();
    const signed = sign(decision);
    const result = appendHumanEvidence(channel, sink, signed);
    const expected: HumanEvidencePayload = {
      kind: "human",
      schema_version: 1,
      subject_hash: signed.subject_hash,
      decision,
      reason: signed.reason,
      nonce: signed.nonce,
      timestamp: signed.timestamp,
      signature: signed.signature,
      public_key_fingerprint: channel.status().publicKeyFingerprint!,
    };
    assert.deepEqual(result.payload, expected);
    assert.equal(result.id, `human-${createHash("sha256").update(JSON.stringify(expected)).digest("hex")}`);
    assert.deepEqual(sink.getEvidence(result.id), { payload: expected });
    assert.equal(result.replayed, false);
    assert.ok(Buffer.byteLength(JSON.stringify(result.payload), "utf8") <= MAX_HUMAN_EVIDENCE_BYTES);
    assert.equal(Object.isFrozen(result.payload), true);
    assert.equal(channel.status().replayedNonceCount, 1);
  });
}

test("exact signed replay returns existing evidence without another append", () => {
  const { channel, sign } = setup();
  const sink = new MemorySink();
  const signed = sign();
  const first = appendHumanEvidence(channel, sink, signed);
  // Property insertion order is not part of the evidence identity.
  const reordered = Object.fromEntries(Object.entries(signed).reverse()) as unknown as SignedApproval;
  const replay = appendHumanEvidence(channel, sink, reordered);
  assert.deepEqual(replay, { ...first, replayed: true });
  assert.equal(sink.appendCount, 1);
  assert.equal(sink.records.size, 1);
  assert.throws(() => channel.verify(signed), HumanChannelReplayError);
});

test("tampered and malformed evidence never reaches the sink or consumes its nonce", () => {
  const { channel, sign } = setup();
  const signed = sign();
  const sink: HumanEvidenceSink = {
    appendEvidence: () => assert.fail("invalid evidence must not append"),
    getEvidence: () => assert.fail("invalid evidence must not read storage"),
  };
  const malformed: unknown[] = [
    { ...signed, decision: "reject" },
    { ...signed, reason: "altered reason" },
    { ...signed, subject_hash: "b".repeat(64) },
    { ...signed, nonce: "another-nonce" },
    { ...signed, timestamp: "2026-01-03T03:04:05.000Z" },
    { ...signed, signature: "A".repeat(86) },
    { ...signed, signer: { privateKey: "untrusted-secret-field" } },
    { ...signed, reason: "bad\u0000reason" },
  ];
  for (const candidate of malformed) {
    assert.throws(() => appendHumanEvidence(channel, sink, candidate as SignedApproval), HumanChannelInvalidEvidenceError);
  }
  assert.equal(channel.status().replayedNonceCount, 0);
});

test("different valid evidence reusing a consumed nonce stays rejected", () => {
  const { channel, sign } = setup();
  const sink = new MemorySink();
  const approved = sign();
  const rejected = sign("reject", "review changed");
  const first = appendHumanEvidence(channel, sink, approved);
  assert.throws(() => appendHumanEvidence(channel, sink, rejected), HumanChannelReplayError);
  assert.throws(() => appendHumanEvidence(channel, sink, { ...approved, reason: "tampered" }), HumanChannelInvalidEvidenceError);
  assert.equal(sink.appendCount, 1);
  assert.deepEqual(sink.getEvidence(first.id), { payload: first.payload });
});

test("a nonce consumed outside persistence cannot append on replay", () => {
  const { channel, sign } = setup();
  const signed = sign();
  channel.verify(signed);
  const sink = new MemorySink();
  assert.throws(() => appendHumanEvidence(channel, sink, signed), HumanChannelReplayError);
  assert.equal(sink.appendCount, 0);
});

test("invalid sinks fail before consuming a nonce", () => {
  const { channel, sign } = setup();
  const signed = sign();
  for (const candidate of [null, undefined, {}, { appendEvidence: () => null }, { getEvidence: () => null }]) {
    assert.throws(() => appendHumanEvidence(channel, candidate as unknown as HumanEvidenceSink, signed), HumanEvidenceSinkValidationError);
  }
  assert.equal(channel.status().replayedNonceCount, 0);
  assert.equal(appendHumanEvidence(channel, new MemorySink(), signed).replayed, false);
});

test("sink append failure consumes the nonce and cannot be retried as a new append", () => {
  const { channel, sign } = setup();
  const signed = sign();
  let attempts = 0;
  const sink: HumanEvidenceSink = {
    appendEvidence: () => { attempts += 1; throw new Error("untrusted storage detail"); },
    getEvidence: () => null,
  };
  assert.throws(() => appendHumanEvidence(channel, sink, signed), HumanEvidencePersistenceError);
  assert.equal(channel.status().replayedNonceCount, 1);
  assert.throws(() => appendHumanEvidence(channel, sink, signed), HumanChannelReplayError);
  assert.equal(attempts, 1);
});

test("sink read failure consumes the nonce without attempting an append", () => {
  const { channel, sign } = setup();
  const signed = sign();
  const sink: HumanEvidenceSink = {
    appendEvidence: () => assert.fail("a failed read must not append"),
    getEvidence: () => { throw new Error("untrusted read detail"); },
  };
  assert.throws(() => appendHumanEvidence(channel, sink, signed), HumanEvidencePersistenceError);
  assert.equal(channel.status().replayedNonceCount, 1);
  assert.throws(() => appendHumanEvidence(channel, new MemorySink(), signed), HumanChannelReplayError);
});

test("conflicting existing evidence fails visibly and never appends", () => {
  const { channel, sign } = setup();
  const signed = sign();
  const sink: HumanEvidenceSink = {
    appendEvidence: () => assert.fail("a conflict must not append"),
    getEvidence: () => ({ payload: { kind: "human", reason: "different content" } }),
  };
  assert.throws(() => appendHumanEvidence(channel, sink, signed), HumanEvidenceConflictError);
  assert.equal(channel.status().replayedNonceCount, 1);
  assert.throws(() => appendHumanEvidence(channel, sink, signed), HumanEvidenceConflictError);
});

test("an exact committed append that throws is recovered without duplication", () => {
  const { channel, sign } = setup();
  const sink = new MemorySink();
  const signed = sign();
  const append = sink.appendEvidence.bind(sink);
  sink.appendEvidence = (id, payload) => { append(id, payload); throw new Error("commit acknowledgement lost"); };
  const result = appendHumanEvidence(channel, sink, signed);
  assert.equal(result.replayed, true);
  assert.equal(appendHumanEvidence(channel, sink, signed).id, result.id);
  assert.equal(sink.appendCount, 1);
});

test("reason bounds apply in UTF-8 bytes even to correctly signed oversized evidence", () => {
  const { channel, sign, keyPair } = setup();
  const sink = new MemorySink();
  const valid = sign("approve", "é".repeat(MAX_APPROVAL_REASON_BYTES / 2));
  const oversized = {
    subject_hash: valid.subject_hash,
    decision: valid.decision,
    reason: `${valid.reason}é`,
    nonce: valid.nonce,
    timestamp: valid.timestamp,
  };
  const signed = {
    ...oversized,
    signature: nodeSign(null, Buffer.from(JSON.stringify(oversized), "utf8"), keyPair.privateKey).toString("base64url"),
  };
  assert.throws(() => appendHumanEvidence(channel, sink, signed), HumanChannelInvalidEvidenceError);
  assert.equal(sink.appendCount, 0);
  assert.equal(channel.status().replayedNonceCount, 0);
  assert.equal(appendHumanEvidence(channel, sink, valid).payload.reason, valid.reason);
});

test("results and errors never leak signer/private-key or arbitrary sink details", () => {
  const { channel, keyPair, sign } = setup();
  const privatePem = keyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const signed = sign();
  const storageDetail = "untrusted-sink-secret-marker";
  const sink: HumanEvidenceSink = {
    appendEvidence: () => { throw new Error(`${storageDetail}\n${privatePem}`, { cause: privatePem }); },
    getEvidence: () => null,
  };
  assert.throws(() => appendHumanEvidence(channel, sink, signed), (error: unknown) => {
    assert.ok(error instanceof HumanEvidencePersistenceError);
    assert.equal(error.cause, undefined);
    assert.doesNotMatch(`${error}\n${JSON.stringify(error)}`, /PRIVATE KEY|untrusted-sink-secret-marker/);
    return true;
  });
  const other = setup();
  const result = appendHumanEvidence(other.channel, new MemorySink(), other.sign());
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE KEY|privateKey|signer|bearer|stack|job_payload/);
  assert.deepEqual(Object.keys(result).sort(), ["id", "payload", "replayed"]);
});

test("accessor-backed approval fields are rejected without reading secret values", () => {
  const { channel, sign } = setup();
  const signed = sign();
  const candidate = { ...signed };
  Object.defineProperty(candidate, "signature", { enumerable: true, get: () => assert.fail("must not invoke an accessor") });
  assert.throws(() => appendHumanEvidence(channel, new MemorySink(), candidate), HumanChannelInvalidEvidenceError);
  assert.equal(channel.status().replayedNonceCount, 0);
});
