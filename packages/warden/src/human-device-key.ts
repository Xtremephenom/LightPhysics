import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as nodeSign,
  type KeyObject,
} from "node:crypto";
import type { HumanChannelSigner, HumanChannelSignerObject } from "./human-channel.ts";

/** The maximum private-key DER payload accepted at this boundary. */
export const MAX_HUMAN_CHANNEL_PRIVATE_KEY_DER_BYTES = 8_192;

/** Synchronous OS-keychain seam. This interface does not provide keychain storage itself. */
export interface HumanChannelKeyStore {
  loadPrivateKeyDer(): Uint8Array | undefined;
  savePrivateKeyDer(der: Uint8Array): void;
}

export type HumanChannelKeyErrorCode =
  | "HumanChannelKeyError"
  | "HumanChannelKeyPersistenceError"
  | "HumanChannelKeyValidationError";

/** Base error for the device-key boundary. Messages never contain input or causes. */
export class HumanChannelKeyError extends Error {
  readonly code: HumanChannelKeyErrorCode;

  constructor(code: HumanChannelKeyErrorCode, message: string) {
    super(message);
    this.name = code;
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class HumanChannelKeyPersistenceError extends HumanChannelKeyError {
  constructor() {
    super("HumanChannelKeyPersistenceError", "The Human Channel device key is unavailable");
  }
}

export class HumanChannelKeyValidationError extends HumanChannelKeyError {
  constructor() {
    super("HumanChannelKeyValidationError", "The Human Channel device key is invalid");
  }
}

function isKeyStore(value: unknown): value is HumanChannelKeyStore {
  try {
    return value !== null
      && typeof value === "object"
      && typeof (value as HumanChannelKeyStore).loadPrivateKeyDer === "function"
      && typeof (value as HumanChannelKeyStore).savePrivateKeyDer === "function";
  } catch {
    return false;
  }
}

function boundedPrivateKeyDer(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)
    || value.byteLength === 0
    || value.byteLength > MAX_HUMAN_CHANNEL_PRIVATE_KEY_DER_BYTES) {
    throw new HumanChannelKeyValidationError();
  }
  return Uint8Array.from(value);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength
    && left.every((byte, index) => byte === right[index]);
}

interface ParsedPrivateKey {
  readonly key: KeyObject;
  readonly publicKeyDer: Uint8Array;
}

function parseEd25519PrivateKey(value: unknown): ParsedPrivateKey {
  const der = boundedPrivateKeyDer(value);
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({ key: Buffer.from(der), format: "der", type: "pkcs8" });
  } catch {
    throw new HumanChannelKeyValidationError();
  }

  if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") {
    throw new HumanChannelKeyValidationError();
  }

  let canonicalPrivateDer: Buffer;
  let publicKeyDer: Buffer;
  try {
    canonicalPrivateDer = privateKey.export({ type: "pkcs8", format: "der" });
    const publicKey = createPublicKey(privateKey);
    if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519") {
      throw new Error();
    }
    publicKeyDer = publicKey.export({ type: "spki", format: "der" });
  } catch {
    throw new HumanChannelKeyValidationError();
  }

  // Requiring the exported PKCS#8 bytes to match rejects trailing bytes and
  // alternate encodings that Node can parse but this boundary cannot preserve.
  if (!sameBytes(der, canonicalPrivateDer)
    || publicKeyDer.byteLength === 0
    || publicKeyDer.byteLength > MAX_HUMAN_CHANNEL_PRIVATE_KEY_DER_BYTES) {
    throw new HumanChannelKeyValidationError();
  }
  return { key: privateKey, publicKeyDer: Uint8Array.from(publicKeyDer) };
}

function persistenceFailure(): never {
  throw new HumanChannelKeyPersistenceError();
}

/**
 * Labeled in-memory test implementation of HumanChannelKeyStore.
 * It is deliberately not an OS-keychain or filesystem implementation.
 */
export class InMemoryHumanChannelKeyStore implements HumanChannelKeyStore {
  #privateKeyDer: Uint8Array | undefined;

  constructor(initialPrivateKeyDer?: Uint8Array) {
    if (initialPrivateKeyDer !== undefined) {
      this.#privateKeyDer = boundedPrivateKeyDer(initialPrivateKeyDer);
    }
  }

  loadPrivateKeyDer(): Uint8Array | undefined {
    return this.#privateKeyDer === undefined ? undefined : Uint8Array.from(this.#privateKeyDer);
  }

  savePrivateKeyDer(der: Uint8Array): void {
    this.#privateKeyDer = boundedPrivateKeyDer(der);
  }
}

/** Public, non-secret view of a device signer. */
export interface HumanChannelDeviceSignerView {
  readonly publicKey: Uint8Array;
  readonly publicKeyFingerprint: string;
  readonly signer: HumanChannelSignerObject;
}

/**
 * Ed25519 signer backed by a synchronous key-store seam. Only the private
 * KeyObject is retained internally; no private DER or PEM leaves this class.
 */
export class HumanChannelDeviceSigner implements HumanChannelDeviceSignerView {
  #privateKey: KeyObject;
  #publicKeyDer: Uint8Array;
  #publicKeyFingerprint: string;
  readonly signer: HumanChannelSignerObject;

  constructor(store: HumanChannelKeyStore) {
    if (!isKeyStore(store)) throw new HumanChannelKeyValidationError();

    let loaded: Uint8Array | undefined;
    try {
      loaded = store.loadPrivateKeyDer();
    } catch {
      persistenceFailure();
    }

    let parsed: ParsedPrivateKey;
    if (loaded === undefined) {
      let generated: { privateKey: KeyObject; publicKey: KeyObject };
      try {
        generated = generateKeyPairSync("ed25519");
      } catch {
        throw new HumanChannelKeyPersistenceError();
      }
      let privateDer: Buffer;
      try {
        privateDer = generated.privateKey.export({ type: "pkcs8", format: "der" });
      } catch {
        throw new HumanChannelKeyPersistenceError();
      }
      const bounded = boundedPrivateKeyDer(privateDer);
      // The store receives a fresh copy and never receives a public key or
      // KeyObject. The signer parses its own generated bytes below.
      try {
        store.savePrivateKeyDer(Uint8Array.from(bounded));
      } catch {
        // Do not trust a store implementation's error text; it may contain
        // backend details or the attempted key material.
        persistenceFailure();
      }
      parsed = parseEd25519PrivateKey(bounded);
    } else {
      parsed = parseEd25519PrivateKey(loaded);
    }

    this.#privateKey = parsed.key;
    this.#publicKeyDer = parsed.publicKeyDer;
    this.#publicKeyFingerprint = createHash("sha256")
      .update(Buffer.from(this.#publicKeyDer))
      .digest("hex");
    this.signer = Object.freeze({ sign: this.sign.bind(this) });
  }

  get publicKey(): Uint8Array {
    return Uint8Array.from(this.#publicKeyDer);
  }

  get publicKeyFingerprint(): string {
    return this.#publicKeyFingerprint;
  }

  sign(payload: Uint8Array): Uint8Array {
    if (!(payload instanceof Uint8Array)) throw new HumanChannelKeyValidationError();
    let signature: Buffer;
    try {
      signature = nodeSign(null, Buffer.from(payload), this.#privateKey);
    } catch {
      throw new HumanChannelKeyValidationError();
    }
    if (signature.byteLength !== 64) throw new HumanChannelKeyValidationError();
    return Uint8Array.from(signature);
  }
}

export type HumanChannelDeviceSignerFunction = HumanChannelSigner;
