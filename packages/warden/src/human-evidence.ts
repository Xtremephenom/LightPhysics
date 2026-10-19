import { createHash } from "node:crypto";
import {
  HumanChannel,
  HumanChannelInvalidEvidenceError,
  HumanChannelReplayError,
  type ApprovalDecision,
  type SignedApproval,
} from "./human-channel.ts";

/** The only evidence kind this integration is permitted to append. */
export const HUMAN_EVIDENCE_KIND = "human" as const;
export const HUMAN_EVIDENCE_SCHEMA_VERSION = 1 as const;
/** The reason bound is enforced by HumanChannel; this is an independent payload bound. */
export const MAX_HUMAN_EVIDENCE_BYTES = 16_384;

export type HumanEvidencePayload = Readonly<{
  readonly kind: typeof HUMAN_EVIDENCE_KIND;
  readonly schema_version: typeof HUMAN_EVIDENCE_SCHEMA_VERSION;
  readonly subject_hash: string;
  readonly decision: ApprovalDecision;
  readonly reason: string;
  readonly nonce: string;
  readonly timestamp: string;
  readonly signature: string;
  readonly public_key_fingerprint: string;
}>;

/**
 * Deliberately minimal structural boundary. Ledger implements these methods
 * without Warden depending on Ledger's package or types.
 */
export interface HumanEvidenceSink {
  appendEvidence(id: string, payload: HumanEvidencePayload): unknown;
  getEvidence(id: string): unknown;
}

/** Only safe, non-storage details cross the Warden evidence boundary. */
export interface HumanEvidenceReceipt {
  readonly id: string;
  readonly payload: HumanEvidencePayload;
  readonly replayed: boolean;
}

export type HumanEvidenceErrorCode =
  | "HumanEvidenceSinkValidationError"
  | "HumanEvidenceConflictError"
  | "HumanEvidencePersistenceError";

/** Base class for errors at the Human Channel evidence boundary. */
export class HumanEvidenceError extends Error {
  readonly code: HumanEvidenceErrorCode;

  constructor(code: HumanEvidenceErrorCode, message: string) {
    super(message);
    this.name = code;
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class HumanEvidenceSinkValidationError extends HumanEvidenceError {
  constructor() {
    super("HumanEvidenceSinkValidationError", "The Human Channel evidence sink is invalid");
  }
}

export class HumanEvidenceConflictError extends HumanEvidenceError {
  constructor() {
    super("HumanEvidenceConflictError", "Human evidence already exists with different content");
  }
}

export class HumanEvidencePersistenceError extends HumanEvidenceError {
  constructor() {
    super("HumanEvidencePersistenceError", "Human evidence could not be persisted");
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validSink(value: unknown): value is HumanEvidenceSink {
  try {
    return value !== null
      && typeof value === "object"
      && typeof (value as HumanEvidenceSink).appendEvidence === "function"
      && typeof (value as HumanEvidenceSink).getEvidence === "function";
  } catch {
    return false;
  }
}

function snapshotApproval(value: SignedApproval): SignedApproval {
  // Never verify one accessor result and then persist a different one. Only
  // plain data fields are accepted, and the snapshot is reused throughout.
  try {
    if (!isPlainObject(value)) throw new Error();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.values(descriptors).some((field) => !field.enumerable || !("value" in field))) {
      throw new Error();
    }
    return Object.freeze(Object.fromEntries(
      Object.entries(descriptors).map(([key, field]) => [key, field.value]),
    )) as unknown as SignedApproval;
  } catch {
    throw new HumanChannelInvalidEvidenceError();
  }
}

function canonicalEvidenceBytes(payload: HumanEvidencePayload): Buffer {
  // This order is part of the evidence id contract. It intentionally includes
  // the signature and signer fingerprint, unlike the bytes signed by the
  // Human Channel, so a different signed evidence object cannot collide here.
  return Buffer.from(JSON.stringify({
    kind: payload.kind,
    schema_version: payload.schema_version,
    subject_hash: payload.subject_hash,
    decision: payload.decision,
    reason: payload.reason,
    nonce: payload.nonce,
    timestamp: payload.timestamp,
    signature: payload.signature,
    public_key_fingerprint: payload.public_key_fingerprint,
  }), "utf8");
}

function evidenceId(payload: HumanEvidencePayload): string {
  return `human-${createHash("sha256").update(canonicalEvidenceBytes(payload)).digest("hex")}`;
}

function safePayload(
  channel: HumanChannel,
  approval: Pick<SignedApproval, "subject_hash" | "decision" | "reason" | "nonce" | "timestamp" | "signature">,
): HumanEvidencePayload {
  const status = channel.status();
  const fingerprint = status.publicKeyFingerprint;
  if (!status.enrolled || typeof fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(fingerprint)) {
    // A successful channel verification can only reach this branch if the
    // channel implementation is inconsistent. Keep that failure non-sensitive.
    throw new HumanEvidencePersistenceError();
  }
  const payload: HumanEvidencePayload = {
    kind: HUMAN_EVIDENCE_KIND,
    schema_version: HUMAN_EVIDENCE_SCHEMA_VERSION,
    subject_hash: approval.subject_hash,
    decision: approval.decision,
    reason: approval.reason,
    nonce: approval.nonce,
    timestamp: approval.timestamp,
    signature: approval.signature,
    public_key_fingerprint: fingerprint,
  };
  if (canonicalEvidenceBytes(payload).byteLength > MAX_HUMAN_EVIDENCE_BYTES) {
    throw new HumanEvidencePersistenceError();
  }
  return Object.freeze(payload);
}

function payloadMatches(value: unknown, expected: HumanEvidencePayload): boolean {
  if (!isPlainObject(value) || Object.keys(value).length !== 9) return false;
  return value.kind === expected.kind
    && value.schema_version === expected.schema_version
    && value.subject_hash === expected.subject_hash
    && value.decision === expected.decision
    && value.reason === expected.reason
    && value.nonce === expected.nonce
    && value.timestamp === expected.timestamp
    && value.signature === expected.signature
    && value.public_key_fingerprint === expected.public_key_fingerprint;
}

function storedPayload(value: unknown): unknown {
  return isPlainObject(value) && Object.prototype.hasOwnProperty.call(value, "payload")
    ? value.payload
    : undefined;
}

function receipt(id: string, payload: HumanEvidencePayload, replayed: boolean): HumanEvidenceReceipt {
  return Object.freeze({ id, payload, replayed });
}

function existingEvidence(
  sink: HumanEvidenceSink,
  id: string,
  payload: HumanEvidencePayload,
): HumanEvidenceReceipt | undefined {
  let existing: unknown;
  try {
    existing = sink.getEvidence(id);
    if (existing === null || existing === undefined) return undefined;
    if (!payloadMatches(storedPayload(existing), payload)) throw new HumanEvidenceConflictError();
  } catch (error) {
    if (error instanceof HumanEvidenceConflictError) throw error;
    throw new HumanEvidencePersistenceError();
  }
  return receipt(id, payload, true);
}

/**
 * Verify one Human Channel approval and persist it as bounded `kind: "human"`
 * evidence. Verification consumes the channel nonce before persistence. This
 * is intentional fail-closed behavior: a sink failure cannot be retried as a
 * second authorization. A committed exact replay is recovered by id and
 * returned without appending again.
 */
export function appendHumanEvidence(
  channel: HumanChannel,
  sink: HumanEvidenceSink,
  approval: SignedApproval,
): HumanEvidenceReceipt {
  if (!(channel instanceof HumanChannel) || !validSink(sink)) {
    throw new HumanEvidenceSinkValidationError();
  }
  const signed = snapshotApproval(approval);

  let payload: HumanEvidencePayload;
  try {
    const verified = channel.verifySignedApproval(signed);
    payload = safePayload(channel, { ...verified, signature: signed.signature });
  } catch (error) {
    if (!(error instanceof HumanChannelReplayError)) throw error;

    // The channel deliberately rejects a used nonce. For an exact replay only,
    // recover the existing committed record; altered/reused evidence is never
    // appended and keeps the original replay error visible.
    const replayPayload = safePayload(channel, signed);
    const id = evidenceId(replayPayload);
    const existing = existingEvidence(sink, id, replayPayload);
    if (existing !== undefined) return existing;
    throw error;
  }

  const id = evidenceId(payload);
  const alreadyStored = existingEvidence(sink, id, payload);
  if (alreadyStored !== undefined) return alreadyStored;

  try {
    sink.appendEvidence(id, payload);
  } catch {
    // A storage call may have committed before throwing. Read back the same
    // deterministic id and accept only the exact bounded payload.
    const committed = existingEvidence(sink, id, payload);
    if (committed !== undefined) return committed;
    throw new HumanEvidencePersistenceError();
  }
  return receipt(id, payload, false);
}
