import { Buffer } from "node:buffer";

/**
 * The Electron boundary deliberately has no IPC, HTTP, CLI, or renderer
 * adapter.  The object returned by createMainHumanChannelController is kept by
 * main.mjs; callers receive only bounded status/verification receipts.
 */
export const ELECTRON_HUMAN_CHANNEL_CONTROLLER_ERROR_CODES = Object.freeze({
  INVALID_REQUEST: "ELECTRON_HUMAN_CHANNEL_INVALID_REQUEST",
  ORIGIN_REJECTED: "ELECTRON_HUMAN_CHANNEL_ORIGIN_REJECTED",
  ENROLLMENT_REQUIRED: "ELECTRON_HUMAN_CHANNEL_ENROLLMENT_REQUIRED",
  ENROLLMENT_CONFLICT: "ELECTRON_HUMAN_CHANNEL_ENROLLMENT_CONFLICT",
  NOT_ENROLLED: "ELECTRON_HUMAN_CHANNEL_NOT_ENROLLED",
  INVALID_EVIDENCE: "ELECTRON_HUMAN_CHANNEL_INVALID_EVIDENCE",
  REPLAY: "ELECTRON_HUMAN_CHANNEL_REPLAY",
  UNAVAILABLE: "ELECTRON_HUMAN_CHANNEL_UNAVAILABLE",
});

const ERROR_MESSAGES = Object.freeze({
  [ELECTRON_HUMAN_CHANNEL_CONTROLLER_ERROR_CODES.INVALID_REQUEST]: "The Human Channel request is invalid",
  [ELECTRON_HUMAN_CHANNEL_CONTROLLER_ERROR_CODES.ORIGIN_REJECTED]: "The Human Channel request origin is not allowed",
  [ELECTRON_HUMAN_CHANNEL_CONTROLLER_ERROR_CODES.ENROLLMENT_REQUIRED]: "Explicit Human Channel enrollment confirmation is required",
  [ELECTRON_HUMAN_CHANNEL_CONTROLLER_ERROR_CODES.ENROLLMENT_CONFLICT]: "The Human Channel device key conflicts with enrollment",
  [ELECTRON_HUMAN_CHANNEL_CONTROLLER_ERROR_CODES.NOT_ENROLLED]: "The Human Channel device is not enrolled",
  [ELECTRON_HUMAN_CHANNEL_CONTROLLER_ERROR_CODES.INVALID_EVIDENCE]: "The Human Channel evidence is invalid",
  [ELECTRON_HUMAN_CHANNEL_CONTROLLER_ERROR_CODES.REPLAY]: "The Human Channel evidence has already been used",
  [ELECTRON_HUMAN_CHANNEL_CONTROLLER_ERROR_CODES.UNAVAILABLE]: "The Human Channel is unavailable",
});

export const MAX_ELECTRON_HUMAN_CHANNEL_REQUEST_BYTES = 16_384;
export const MAX_ELECTRON_HUMAN_CHANNEL_REASON_BYTES = 2_048;
export const MAX_ELECTRON_HUMAN_CHANNEL_PUBLIC_KEY_BYTES = 8_192;
export const MAX_ELECTRON_HUMAN_CHANNEL_NONCE_BYTES = 128;

export class ElectronHumanChannelControllerError extends Error {
  constructor(code) {
    super(ERROR_MESSAGES[code] ?? ERROR_MESSAGES[ELECTRON_HUMAN_CHANNEL_CONTROLLER_ERROR_CODES.UNAVAILABLE]);
    this.name = "ElectronHumanChannelControllerError";
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function fail(code) {
  throw new ElectronHumanChannelControllerError(code);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isObjectLike(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function boundedRequest(value) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    fail(ELECTRON_HUMAN_CHANNEL_CONTROLLER_ERROR_CODES.INVALID_REQUEST);
  }
  if (typeof serialized !== "string"
    || Buffer.byteLength(serialized, "utf8") > MAX_ELECTRON_HUMAN_CHANNEL_REQUEST_BYTES) {
    fail(ELECTRON_HUMAN_CHANNEL_CONTROLLER_ERROR_CODES.INVALID_REQUEST);
  }
  return value;
}

function validateApprovalInput(value) {
  if (!isPlainObject(value) || !hasExactKeys(value, ["subject_hash", "decision", "reason"])) {
    fail(ELECTRON_HUMAN_CHANNEL_CONTROLLER_ERROR_CODES.INVALID_REQUEST);
  }
  if (typeof value.subject_hash !== "string" || !/^[0-9a-f]{64}$/.test(value.subject_hash)) {
    fail(ELECTRON_HUMAN_CHANNEL_CONTROLLER_ERROR_CODES.INVALID_REQUEST);
  }
  if (value.decision !== "approve" && value.decision !== "reject") {
    fail(ELECTRON_HUMAN_CHANNEL_CONTROLLER_ERROR_CODES.INVALID_REQUEST);
  }
  if (typeof value.reason !== "string"
    || value.reason.length === 0
    || value.reason.trim().length === 0
    || value.reason.includes("\u0000")
    || Buffer.byteLength(value.reason, "utf8") > MAX_ELECTRON_HUMAN_CHANNEL_REASON_BYTES) {
    fail(ELECTRON_HUMAN_CHANNEL_CONTROLLER_ERROR_CODES.INVALID_REQUEST);
  }
  return Object.freeze({
    subject_hash: value.subject_hash,
    decision: value.decision,
    reason: value.reason,
  });
}

function validateMainRequest(value, field) {
  boundedRequest(value);
  if (!isPlainObject(value) || !hasExactKeys(value, ["source", field])) {
    fail(ELECTRON_HUMAN_CHANNEL_CONTROLLER_ERROR_CODES.INVALID_REQUEST);
  }
  if (value.source !== "main") fail(ELECTRON_HUMAN_CHANNEL_CONTROLLER_ERROR_CODES.ORIGIN_REJECTED);
  return value[field];
}

function isCanonicalTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function explicitConfirmation(value) {
  return value === true
    || (isPlainObject(value) && (value.confirm === true || value.confirmed === true || value.explicit === true));
}

function safeStatus(channel) {
  let status;
  try {
    status = channel.status();
  } catch {
    fail(ELECTRON_HUMAN_CHANNEL_CONTROLLER_ERROR_CODES.UNAVAILABLE);
  }
  if (!isPlainObject(status) || typeof status.enrolled !== "boolean"
    || !Number.isSafeInteger(status.replayedNonceCount)
    || !Number.isSafeInteger(status.replayStateLimit)
    || status.replayedNonceCount < 0
    || status.replayStateLimit < 1
    || status.replayedNonceCount > status.replayStateLimit) {
    fail(ELECTRON_HUMAN_CHANNEL_CONTROLLER_ERROR_CODES.UNAVAILABLE);
  }
  const result = {
    enrolled: status.enrolled,
    replayedNonceCount: status.replayedNonceCount,
    replayStateLimit: status.replayStateLimit,
  };
  if (status.enrolled === true) {
    if (status.algorithm !== "Ed25519"
      || typeof status.publicKeyFingerprint !== "string"
      || !/^[0-9a-f]{64}$/.test(status.publicKeyFingerprint)
      || !isCanonicalTimestamp(status.enrolledAt)) {
      fail(ELECTRON_HUMAN_CHANNEL_CONTROLLER_ERROR_CODES.UNAVAILABLE);
    }
    result.algorithm = "Ed25519";
    result.publicKeyFingerprint = status.publicKeyFingerprint;
    result.enrolledAt = status.enrolledAt;
  }
  return Object.freeze(result);
}

function safeVerified(value) {
  if (!isPlainObject(value)
    || value.verified !== true
    || typeof value.subject_hash !== "string"
    || !/^[0-9a-f]{64}$/.test(value.subject_hash)
    || (value.decision !== "approve" && value.decision !== "reject")
    || typeof value.reason !== "string"
    || value.reason.length === 0
    || value.reason.trim().length === 0
    || value.reason.includes("\u0000")
    || Buffer.byteLength(value.reason, "utf8") > MAX_ELECTRON_HUMAN_CHANNEL_REASON_BYTES
    || typeof value.nonce !== "string"
    || value.nonce.length === 0
    || Buffer.byteLength(value.nonce, "utf8") > MAX_ELECTRON_HUMAN_CHANNEL_NONCE_BYTES
    || !/^[A-Za-z0-9_-]+$/.test(value.nonce)
    || !isCanonicalTimestamp(value.timestamp)) {
    fail(ELECTRON_HUMAN_CHANNEL_CONTROLLER_ERROR_CODES.INVALID_EVIDENCE);
  }
  return Object.freeze({
    subject_hash: value.subject_hash,
    decision: value.decision,
    reason: value.reason,
    nonce: value.nonce,
    timestamp: value.timestamp,
    verified: true,
  });
}

function mapChannelError(error) {
  switch (error?.code ?? error?.name) {
    case "HumanChannelNotEnrolledError": return ELECTRON_HUMAN_CHANNEL_CONTROLLER_ERROR_CODES.NOT_ENROLLED;
    case "HumanChannelEnrollmentConflictError": return ELECTRON_HUMAN_CHANNEL_CONTROLLER_ERROR_CODES.ENROLLMENT_CONFLICT;
    case "HumanChannelInvalidEvidenceError": return ELECTRON_HUMAN_CHANNEL_CONTROLLER_ERROR_CODES.INVALID_EVIDENCE;
    case "HumanChannelReplayError": return ELECTRON_HUMAN_CHANNEL_CONTROLLER_ERROR_CODES.REPLAY;
    case "HumanChannelValidationError": return ELECTRON_HUMAN_CHANNEL_CONTROLLER_ERROR_CODES.INVALID_REQUEST;
    default: return ELECTRON_HUMAN_CHANNEL_CONTROLLER_ERROR_CODES.UNAVAILABLE;
  }
}

function assertDependencies(options) {
  if (!isPlainObject(options)
    || !isObjectLike(options.channel)
    || typeof options.channel.status !== "function"
    || typeof options.channel.enrollPublicKey !== "function"
    || typeof options.channel.signApproval !== "function"
    || typeof options.channel.verifySignedApproval !== "function"
    || !isObjectLike(options.deviceSigner)
    || !(options.deviceSigner.publicKey instanceof Uint8Array)
    || options.deviceSigner.publicKey.byteLength === 0
    || options.deviceSigner.publicKey.byteLength > MAX_ELECTRON_HUMAN_CHANNEL_PUBLIC_KEY_BYTES
    || typeof options.deviceSigner.publicKeyFingerprint !== "string"
    || !/^[0-9a-f]{64}$/.test(options.deviceSigner.publicKeyFingerprint)
    || !isPlainObject(options.deviceSigner.signer)
    || typeof options.deviceSigner.signer.sign !== "function"
    || typeof options.confirmEnrollment !== "function") {
    fail(ELECTRON_HUMAN_CHANNEL_CONTROLLER_ERROR_CODES.UNAVAILABLE);
  }
}

/**
 * Adapt the existing Warden HumanChannel and HumanChannelDeviceSigner to the
 * Electron main-process boundary. The signer and channel stay in closures;
 * neither is part of the returned object or any receipt.
 */
export function createMainHumanChannelController(options) {
  assertDependencies(options);
  const { channel, deviceSigner, confirmEnrollment } = options;
  const publicKey = Uint8Array.from(deviceSigner.publicKey);

  const status = () => safeStatus(channel);

  const enroll = () => {
    const before = status();
    if (before.enrolled) return before;
    let confirmation;
    try {
      confirmation = confirmEnrollment(Object.freeze({
        publicKeyFingerprint: deviceSigner.publicKeyFingerprint,
      }));
    } catch {
      fail(ELECTRON_HUMAN_CHANNEL_CONTROLLER_ERROR_CODES.ENROLLMENT_REQUIRED);
    }
    if (!explicitConfirmation(confirmation)) fail(ELECTRON_HUMAN_CHANNEL_CONTROLLER_ERROR_CODES.ENROLLMENT_REQUIRED);
    try {
      channel.enrollPublicKey(publicKey, confirmation);
      return safeStatus(channel);
    } catch (error) {
      fail(mapChannelError(error));
    }
  };

  const recordMainDecision = (request) => {
    const input = validateApprovalInput(validateMainRequest(request, "input"));
    if (!status().enrolled) fail(ELECTRON_HUMAN_CHANNEL_CONTROLLER_ERROR_CODES.NOT_ENROLLED);
    try {
      // The signed object exists only in this main-process stack frame. The
      // caller receives a verified payload with no signature field.
      const signed = channel.signApproval(input);
      return safeVerified(channel.verifySignedApproval(signed));
    } catch (error) {
      fail(mapChannelError(error));
    }
  };

  const verifyMainEvidence = (request) => {
    const evidence = validateMainRequest(request, "evidence");
    if (!status().enrolled) fail(ELECTRON_HUMAN_CHANNEL_CONTROLLER_ERROR_CODES.NOT_ENROLLED);
    try {
      return safeVerified(channel.verifySignedApproval(evidence));
    } catch (error) {
      fail(mapChannelError(error));
    }
  };

  return Object.freeze({
    enroll,
    status,
    recordMainDecision,
    verifyMainEvidence,
  });
}
