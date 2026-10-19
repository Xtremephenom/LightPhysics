import { Buffer } from "node:buffer";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as nodeSign,
  timingSafeEqual,
  verify as nodeVerify,
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * The packaged Electron entrypoint cannot import the source-only TypeScript
 * Warden package. This is the deliberately small JS runtime adapter for the
 * same HumanChannel and HumanChannelDeviceSigner seams. Private key material
 * remains in a KeyObject; the main-process listener is the only production
 * surface that can consume the adapter and it strips signed evidence.
 */
export const ELECTRON_HUMAN_CHANNEL_ADAPTER_ERROR_CODES = Object.freeze({
  VALIDATION: "HumanChannelValidationError",
  NOT_ENROLLED: "HumanChannelNotEnrolledError",
  ENROLLMENT_CONFLICT: "HumanChannelEnrollmentConflictError",
  INVALID_EVIDENCE: "HumanChannelInvalidEvidenceError",
  REPLAY: "HumanChannelReplayError",
  PERSISTENCE: "HumanChannelPersistenceError",
  KEY_VALIDATION: "HumanChannelKeyValidationError",
  KEY_PERSISTENCE: "HumanChannelKeyPersistenceError",
});

const MAX_REASON_BYTES = 2_048;
const MAX_NONCE_BYTES = 128;
const NONCE_RANDOM_BYTES = 24;
const MAX_REPLAY_NONCES = 4_096;
const MAX_PUBLIC_KEY_BYTES = 8_192;
const MAX_STATE_BYTES = 1_048_576;
const MAX_PATH_BYTES = 4_096;
const STATE_SCHEMA_VERSION = 1;
const SUBJECT_HASH = /^[0-9a-f]{64}$/;
const NONCE = /^[A-Za-z0-9_-]+$/;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

class AdapterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = code;
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function fail(code, message) {
  throw new AdapterError(code, message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, keys) {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function validateTimestamp(value) {
  if (typeof value !== "string" || !TIMESTAMP.test(value)) {
    fail(ELECTRON_HUMAN_CHANNEL_ADAPTER_ERROR_CODES.VALIDATION, "Invalid Human Channel timestamp");
  }
  try {
    if (new Date(value).toISOString() !== value) throw new Error();
  } catch {
    fail(ELECTRON_HUMAN_CHANNEL_ADAPTER_ERROR_CODES.VALIDATION, "Invalid Human Channel timestamp");
  }
  return value;
}

function nowTimestamp() {
  return new Date().toISOString();
}

function validateInput(value) {
  if (!isPlainObject(value) || !exactKeys(value, ["subject_hash", "decision", "reason"])) {
    fail(ELECTRON_HUMAN_CHANNEL_ADAPTER_ERROR_CODES.VALIDATION, "Invalid Human Channel approval input");
  }
  if (typeof value.subject_hash !== "string" || !SUBJECT_HASH.test(value.subject_hash)) {
    fail(ELECTRON_HUMAN_CHANNEL_ADAPTER_ERROR_CODES.VALIDATION, "Invalid Human Channel approval input");
  }
  if (value.decision !== "approve" && value.decision !== "reject") {
    fail(ELECTRON_HUMAN_CHANNEL_ADAPTER_ERROR_CODES.VALIDATION, "Invalid Human Channel approval input");
  }
  if (typeof value.reason !== "string"
    || value.reason.length === 0
    || value.reason.trim().length === 0
    || value.reason.includes("\u0000")
    || Buffer.byteLength(value.reason, "utf8") > MAX_REASON_BYTES) {
    fail(ELECTRON_HUMAN_CHANNEL_ADAPTER_ERROR_CODES.VALIDATION, "Invalid Human Channel approval input");
  }
  return { subject_hash: value.subject_hash, decision: value.decision, reason: value.reason };
}

function validateNonce(value) {
  if (typeof value !== "string" || value.length === 0
    || Buffer.byteLength(value, "utf8") > MAX_NONCE_BYTES || !NONCE.test(value)) {
    fail(ELECTRON_HUMAN_CHANNEL_ADAPTER_ERROR_CODES.VALIDATION, "Invalid Human Channel nonce");
  }
  return value;
}

function canonicalPayload(payload) {
  return Buffer.from(JSON.stringify({
    subject_hash: payload.subject_hash,
    decision: payload.decision,
    reason: payload.reason,
    nonce: payload.nonce,
    timestamp: payload.timestamp,
  }), "utf8");
}

function normalizePublicKey(value) {
  let key;
  try {
    if (value instanceof Uint8Array) {
      const der = Buffer.from(value);
      if (der.length === 0 || der.length > MAX_PUBLIC_KEY_BYTES) throw new Error();
      let privateKey = false;
      try {
        createPrivateKey({ key: der, format: "der", type: "pkcs8" });
        privateKey = true;
      } catch { /* public SPKI material is expected to fail this probe */ }
      if (privateKey) throw new Error();
      key = createPublicKey({ key: der, format: "der", type: "spki" });
    } else if (value && typeof value === "object" && value.type === "public") {
      key = value;
    } else {
      throw new Error();
    }
    if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") throw new Error();
    const der = key.export({ type: "spki", format: "der" });
    if (der.length === 0 || der.length > MAX_PUBLIC_KEY_BYTES) throw new Error();
    return { key, der, fingerprint: createHash("sha256").update(der).digest("hex") };
  } catch {
    fail(ELECTRON_HUMAN_CHANNEL_ADAPTER_ERROR_CODES.VALIDATION, "Enrollment requires an Ed25519 public key");
  }
}

function parsePrivateKey(value) {
  if (!(value instanceof Uint8Array) || value.length === 0 || value.length > MAX_PUBLIC_KEY_BYTES) {
    fail(ELECTRON_HUMAN_CHANNEL_ADAPTER_ERROR_CODES.KEY_VALIDATION, "The Human Channel device key is invalid");
  }
  const der = Buffer.from(value);
  let key;
  let canonical;
  let publicKeyDer;
  try {
    key = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
    canonical = key.export({ type: "pkcs8", format: "der" });
    const publicKey = createPublicKey(key);
    publicKeyDer = publicKey.export({ type: "spki", format: "der" });
    if (key.type !== "private" || key.asymmetricKeyType !== "ed25519"
      || !Buffer.from(canonical).equals(der) || publicKeyDer.length > MAX_PUBLIC_KEY_BYTES) throw new Error();
  } catch {
    fail(ELECTRON_HUMAN_CHANNEL_ADAPTER_ERROR_CODES.KEY_VALIDATION, "The Human Channel device key is invalid");
  }
  return { key, publicKeyDer, fingerprint: createHash("sha256").update(publicKeyDer).digest("hex") };
}

function createDeviceSigner(keyStore) {
  if (keyStore === null || typeof keyStore !== "object"
    || typeof keyStore.loadPrivateKeyDer !== "function"
    || typeof keyStore.savePrivateKeyDer !== "function") {
    fail(ELECTRON_HUMAN_CHANNEL_ADAPTER_ERROR_CODES.KEY_VALIDATION, "The Human Channel device key is invalid");
  }
  let loaded;
  try {
    loaded = keyStore.loadPrivateKeyDer();
  } catch {
    fail(ELECTRON_HUMAN_CHANNEL_ADAPTER_ERROR_CODES.KEY_PERSISTENCE, "The Human Channel device key is unavailable");
  }
  if (loaded === undefined) {
    let generated;
    try {
      generated = generateKeyPairSync("ed25519");
      loaded = Uint8Array.from(generated.privateKey.export({ type: "pkcs8", format: "der" }));
      keyStore.savePrivateKeyDer(Uint8Array.from(loaded));
    } catch {
      fail(ELECTRON_HUMAN_CHANNEL_ADAPTER_ERROR_CODES.KEY_PERSISTENCE, "The Human Channel device key is unavailable");
    }
  }
  const parsed = parsePrivateKey(loaded);
  const signer = {
    sign(payload) {
      if (!(payload instanceof Uint8Array)) {
        fail(ELECTRON_HUMAN_CHANNEL_ADAPTER_ERROR_CODES.KEY_VALIDATION, "The Human Channel device key is invalid");
      }
      try {
        return Uint8Array.from(nodeSign(null, Buffer.from(payload), parsed.key));
      } catch {
        fail(ELECTRON_HUMAN_CHANNEL_ADAPTER_ERROR_CODES.KEY_VALIDATION, "The Human Channel device key is invalid");
      }
    },
  };
  return Object.freeze({
    get publicKey() { return Uint8Array.from(parsed.publicKeyDer); },
    publicKeyFingerprint: parsed.fingerprint,
    signer: Object.freeze(signer),
  });
}

function persistedState(key, enrolledAt, nonces) {
  return Object.freeze({
    schemaVersion: STATE_SCHEMA_VERSION,
    publicKeyDer: key.der.toString("base64url"),
    publicKeyFingerprint: key.fingerprint,
    enrolledAt,
    usedNonces: Object.freeze([...nonces]),
  });
}

function restoreState(value, limit) {
  if (!isPlainObject(value) || !exactKeys(value, ["schemaVersion", "publicKeyDer", "publicKeyFingerprint", "enrolledAt", "usedNonces"])
    || value.schemaVersion !== STATE_SCHEMA_VERSION || !Array.isArray(value.usedNonces)
    || value.usedNonces.length > limit || typeof value.publicKeyDer !== "string"
    || !/^[A-Za-z0-9_-]+$/.test(value.publicKeyDer)) {
    fail(ELECTRON_HUMAN_CHANNEL_ADAPTER_ERROR_CODES.PERSISTENCE, "The Human Channel persisted state is unavailable");
  }
  let der;
  try {
    der = Buffer.from(value.publicKeyDer, "base64url");
    if (der.length === 0 || der.toString("base64url") !== value.publicKeyDer) throw new Error();
  } catch {
    fail(ELECTRON_HUMAN_CHANNEL_ADAPTER_ERROR_CODES.PERSISTENCE, "The Human Channel persisted state is unavailable");
  }
  let key;
  try {
    key = normalizePublicKey(der);
  } catch {
    fail(ELECTRON_HUMAN_CHANNEL_ADAPTER_ERROR_CODES.PERSISTENCE, "The Human Channel persisted state is unavailable");
  }
  if (value.publicKeyFingerprint !== key.fingerprint || typeof value.publicKeyFingerprint !== "string"
    || !SUBJECT_HASH.test(value.publicKeyFingerprint)) {
    fail(ELECTRON_HUMAN_CHANNEL_ADAPTER_ERROR_CODES.PERSISTENCE, "The Human Channel persisted state is unavailable");
  }
  try {
    validateTimestamp(value.enrolledAt);
  } catch {
    fail(ELECTRON_HUMAN_CHANNEL_ADAPTER_ERROR_CODES.PERSISTENCE, "The Human Channel persisted state is unavailable");
  }
  const seen = new Set();
  for (const nonce of value.usedNonces) {
    try {
      validateNonce(nonce);
    } catch {
      fail(ELECTRON_HUMAN_CHANNEL_ADAPTER_ERROR_CODES.PERSISTENCE, "The Human Channel persisted state is unavailable");
    }
    if (seen.has(nonce)) fail(ELECTRON_HUMAN_CHANNEL_ADAPTER_ERROR_CODES.PERSISTENCE, "The Human Channel persisted state is unavailable");
    seen.add(nonce);
  }
  return { key, enrolledAt: value.enrolledAt, usedNonces: [...seen] };
}

function createChannel({ signer, stateStore, clock = nowTimestamp, nonce }) {
  const replayedNonces = new Set();
  const replayStateLimit = MAX_REPLAY_NONCES;
  let enrolledKey;
  let enrolledAt;

  const save = (key, at, nonces) => {
    if (!stateStore) return;
    try {
      stateStore.save(persistedState(key, at, nonces));
    } catch (error) {
      if (error?.code === ELECTRON_HUMAN_CHANNEL_ADAPTER_ERROR_CODES.PERSISTENCE) throw error;
      fail(ELECTRON_HUMAN_CHANNEL_ADAPTER_ERROR_CODES.PERSISTENCE, "The Human Channel persisted state is unavailable");
    }
  };
  if (stateStore) {
    let restored;
    try { restored = stateStore.load(); } catch { fail(ELECTRON_HUMAN_CHANNEL_ADAPTER_ERROR_CODES.PERSISTENCE, "The Human Channel persisted state is unavailable"); }
    if (restored !== undefined) {
      const normalized = restoreState(restored, replayStateLimit);
      enrolledKey = normalized.key;
      enrolledAt = normalized.enrolledAt;
      for (const used of normalized.usedNonces) replayedNonces.add(used);
    }
  }

  const status = () => Object.freeze(enrolledKey === undefined
    ? { enrolled: false, replayedNonceCount: replayedNonces.size, replayStateLimit }
    : {
      enrolled: true,
      algorithm: "Ed25519",
      publicKeyFingerprint: enrolledKey.fingerprint,
      enrolledAt,
      replayedNonceCount: replayedNonces.size,
      replayStateLimit,
    });

  const channel = {
    status,
    enrollPublicKey(publicKey, confirmation) {
      const candidate = normalizePublicKey(publicKey);
      if (enrolledKey) {
        if (candidate.der.length !== enrolledKey.der.length || !timingSafeEqual(candidate.der, enrolledKey.der)) {
          fail(ELECTRON_HUMAN_CHANNEL_ADAPTER_ERROR_CODES.ENROLLMENT_CONFLICT, "The Human Channel already has a different enrolled device key");
        }
        return status();
      }
      if (!(confirmation === true || (isPlainObject(confirmation)
        && (confirmation.confirm === true || confirmation.confirmed === true || confirmation.explicit === true)))) {
        fail(ELECTRON_HUMAN_CHANNEL_ADAPTER_ERROR_CODES.VALIDATION, "Explicit enrollment confirmation is required");
      }
      const at = validateTimestamp(clock());
      save(candidate, at, []);
      enrolledKey = candidate;
      enrolledAt = at;
      return status();
    },
    signApproval(input) {
      if (!enrolledKey) fail(ELECTRON_HUMAN_CHANNEL_ADAPTER_ERROR_CODES.NOT_ENROLLED, "The Human Channel has no enrolled device key");
      const normalized = validateInput(input);
      const timestamp = validateTimestamp(clock());
      const generated = nonce ? nonce() : randomBytes(NONCE_RANDOM_BYTES).toString("base64url");
      const payload = { ...normalized, nonce: validateNonce(generated), timestamp };
      let signature;
      try { signature = signer.sign(Uint8Array.from(canonicalPayload(payload))); } catch {
        fail(ELECTRON_HUMAN_CHANNEL_ADAPTER_ERROR_CODES.VALIDATION, "The Human Channel approval signer failed");
      }
      if (!(signature instanceof Uint8Array) || signature.length !== 64) {
        fail(ELECTRON_HUMAN_CHANNEL_ADAPTER_ERROR_CODES.VALIDATION, "The Human Channel approval signer failed");
      }
      return Object.freeze({ ...payload, signature: Buffer.from(signature).toString("base64url") });
    },
    verifySignedApproval(value) {
      if (!enrolledKey) fail(ELECTRON_HUMAN_CHANNEL_ADAPTER_ERROR_CODES.NOT_ENROLLED, "The Human Channel has no enrolled device key");
      if (!isPlainObject(value) || !exactKeys(value, ["subject_hash", "decision", "reason", "nonce", "timestamp", "signature"])) {
        fail(ELECTRON_HUMAN_CHANNEL_ADAPTER_ERROR_CODES.INVALID_EVIDENCE, "The signed approval evidence is invalid");
      }
      let input;
      try {
        input = validateInput({ subject_hash: value.subject_hash, decision: value.decision, reason: value.reason });
        const payload = { ...input, nonce: validateNonce(value.nonce), timestamp: validateTimestamp(value.timestamp) };
        if (typeof value.signature !== "string" || !SIGNATURE.test(value.signature)) throw new Error();
        const signature = Buffer.from(value.signature, "base64url");
        if (signature.length !== 64 || signature.toString("base64url") !== value.signature
          || !nodeVerify(null, canonicalPayload(payload), enrolledKey.key, signature)) throw new Error();
        if (replayedNonces.has(payload.nonce)) fail(ELECTRON_HUMAN_CHANNEL_ADAPTER_ERROR_CODES.REPLAY, "The Human Channel evidence has already been used");
        if (replayedNonces.size >= replayStateLimit) fail(ELECTRON_HUMAN_CHANNEL_ADAPTER_ERROR_CODES.VALIDATION, "The Human Channel replay state limit has been reached");
        replayedNonces.add(payload.nonce);
        try { save(enrolledKey, enrolledAt, replayedNonces); } catch (error) { throw error; }
        return Object.freeze({ ...payload, verified: true });
      } catch (error) {
        if (error?.code === ELECTRON_HUMAN_CHANNEL_ADAPTER_ERROR_CODES.REPLAY
          || error?.code === ELECTRON_HUMAN_CHANNEL_ADAPTER_ERROR_CODES.PERSISTENCE) throw error;
        fail(ELECTRON_HUMAN_CHANNEL_ADAPTER_ERROR_CODES.INVALID_EVIDENCE, "The signed approval evidence is invalid");
      }
    },
  };
  return Object.freeze(channel);
}

function validateStatePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")
    || Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES) {
    fail(ELECTRON_HUMAN_CHANNEL_ADAPTER_ERROR_CODES.PERSISTENCE, "The Human Channel persisted state is unavailable");
  }
  return value;
}

function stateFileRead(filePath, safeStorage) {
  let encrypted;
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_STATE_BYTES) throw new Error();
    encrypted = fs.readFileSync(filePath);
    if (encrypted.byteLength === 0 || encrypted.byteLength > MAX_STATE_BYTES) throw new Error();
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    fail(ELECTRON_HUMAN_CHANNEL_ADAPTER_ERROR_CODES.PERSISTENCE, "The Human Channel persisted state is unavailable");
  }
  try {
    const plaintext = safeStorage.decryptString(encrypted);
    if (typeof plaintext !== "string" || Buffer.byteLength(plaintext, "utf8") > MAX_STATE_BYTES) throw new Error();
    return JSON.parse(plaintext);
  } catch {
    fail(ELECTRON_HUMAN_CHANNEL_ADAPTER_ERROR_CODES.PERSISTENCE, "The Human Channel persisted state is unavailable");
  }
}

function createStateStore({ safeStorage, userDataPath, fileName = "human-channel-state.bin" }) {
  validateStatePath(userDataPath);
  if (typeof fileName !== "string" || fileName.length === 0 || fileName.length > 255
    || fileName === "." || fileName === ".." || path.basename(fileName) !== fileName) {
    fail(ELECTRON_HUMAN_CHANNEL_ADAPTER_ERROR_CODES.PERSISTENCE, "The Human Channel persisted state is unavailable");
  }
  const filePath = path.join(userDataPath, fileName);
  return Object.freeze({
    load: () => stateFileRead(filePath, safeStorage),
    save(state) {
      restoreState(state, MAX_REPLAY_NONCES);
      const serialized = JSON.stringify({
        schemaVersion: state.schemaVersion,
        publicKeyDer: state.publicKeyDer,
        publicKeyFingerprint: state.publicKeyFingerprint,
        enrolledAt: state.enrolledAt,
        usedNonces: [...state.usedNonces],
      });
      if (Buffer.byteLength(serialized, "utf8") > MAX_STATE_BYTES) {
        fail(ELECTRON_HUMAN_CHANNEL_ADAPTER_ERROR_CODES.PERSISTENCE, "The Human Channel persisted state is unavailable");
      }
      let temporary;
      try {
        fs.mkdirSync(userDataPath, { recursive: true });
        temporary = path.join(userDataPath, `.${path.basename(filePath)}.${randomBytes(12).toString("hex")}.tmp`);
        const encrypted = safeStorage.encryptString(serialized);
        if (!(encrypted instanceof Uint8Array) || encrypted.length === 0 || encrypted.length > MAX_STATE_BYTES) throw new Error();
        fs.writeFileSync(temporary, Buffer.from(encrypted), { flag: "wx", mode: 0o600 });
        const descriptor = fs.openSync(temporary, "r+");
        try {
          fs.fsyncSync(descriptor);
        } finally {
          fs.closeSync(descriptor);
        }
        const existing = (() => {
          try {
            const stat = fs.lstatSync(filePath);
            if (!stat.isFile()) throw new Error();
            return stat;
          } catch (error) {
            if (error?.code === "ENOENT") return undefined;
            throw error;
          }
        })();
        try {
          fs.renameSync(temporary, filePath);
        } catch (error) {
          // Windows cannot replace an existing regular file with renameSync.
          // The lstat above prevents this fallback from replacing a link.
          if (!existing || (error?.code !== "EEXIST" && error?.code !== "EPERM")) throw error;
          fs.unlinkSync(filePath);
          fs.renameSync(temporary, filePath);
        }
        temporary = undefined;
        try { fs.chmodSync(filePath, 0o600); } catch { /* advisory on some platforms */ }
      } catch {
        fail(ELECTRON_HUMAN_CHANNEL_ADAPTER_ERROR_CODES.PERSISTENCE, "The Human Channel persisted state is unavailable");
      } finally {
        if (temporary) {
          try { fs.unlinkSync(temporary); } catch { /* best effort */ }
        }
      }
    },
  });
}

/** Create the qualified adapter used by the real Electron main process. */
export function createElectronWardenAdapter({ keyStore, safeStorage, userDataPath, stateFileName } = {}) {
  const deviceSigner = createDeviceSigner(keyStore);
  const stateStore = createStateStore({ safeStorage, userDataPath, fileName: stateFileName });
  const channel = createChannel({ signer: deviceSigner.signer, stateStore });
  return Object.freeze({ channel, deviceSigner });
}
