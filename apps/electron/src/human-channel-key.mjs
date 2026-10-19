import { Buffer } from "node:buffer";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

/** Bounds for values crossing the Electron main-process key-store boundary. */
export const MAX_HUMAN_CHANNEL_PRIVATE_KEY_DER_BYTES = 8_192;
export const MAX_HUMAN_CHANNEL_ENCRYPTED_BYTES = 16_384;
export const MAX_HUMAN_CHANNEL_USER_DATA_PATH_LENGTH = 4_096;
export const MAX_HUMAN_CHANNEL_FILE_NAME_LENGTH = 255;
export const DEFAULT_HUMAN_CHANNEL_KEY_FILE_NAME = "human-channel-key.bin";

export const ELECTRON_HUMAN_CHANNEL_KEY_ERROR_CODES = Object.freeze({
  INVALID_ARGUMENT: "ELECTRON_HUMAN_CHANNEL_KEY_INVALID_ARGUMENT",
  ENCRYPTION_UNAVAILABLE: "ELECTRON_HUMAN_CHANNEL_KEY_ENCRYPTION_UNAVAILABLE",
  STORAGE_UNAVAILABLE: "ELECTRON_HUMAN_CHANNEL_KEY_STORAGE_UNAVAILABLE",
  CIPHERTEXT_INVALID: "ELECTRON_HUMAN_CHANNEL_KEY_CIPHERTEXT_INVALID",
});

const ERROR_MESSAGES = Object.freeze({
  [ELECTRON_HUMAN_CHANNEL_KEY_ERROR_CODES.INVALID_ARGUMENT]:
    "The Electron Human Channel key store input is invalid",
  [ELECTRON_HUMAN_CHANNEL_KEY_ERROR_CODES.ENCRYPTION_UNAVAILABLE]:
    "Electron safeStorage encryption is unavailable",
  [ELECTRON_HUMAN_CHANNEL_KEY_ERROR_CODES.STORAGE_UNAVAILABLE]:
    "The Electron Human Channel key state is unavailable",
  [ELECTRON_HUMAN_CHANNEL_KEY_ERROR_CODES.CIPHERTEXT_INVALID]:
    "The Electron Human Channel key state is invalid",
});

/**
 * Stable, detail-free errors for the main-process safeStorage adapter.
 * This module deliberately has no GUI approval or listener path: it only
 * implements the synchronous HumanChannelKeyStore seam for Electron main.
 */
export class ElectronHumanChannelKeyError extends Error {
  constructor(code) {
    super(ERROR_MESSAGES[code] ?? ERROR_MESSAGES[ELECTRON_HUMAN_CHANNEL_KEY_ERROR_CODES.STORAGE_UNAVAILABLE]);
    this.name = "ElectronHumanChannelKeyError";
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function failure(code) {
  throw new ElectronHumanChannelKeyError(code);
}

function isMissing(error) {
  return error && typeof error === "object" && error.code === "ENOENT";
}

function validateSafeStorage(value) {
  let valid = false;
  try {
    valid = value !== null && typeof value === "object"
      && typeof value.isEncryptionAvailable === "function"
      && typeof value.encryptString === "function"
      && typeof value.decryptString === "function";
  } catch {
    valid = false;
  }
  if (!valid) {
    failure(ELECTRON_HUMAN_CHANNEL_KEY_ERROR_CODES.INVALID_ARGUMENT);
  }
  return value;
}

function validatePathPart(value, maximum, allowEmpty = false) {
  if (typeof value !== "string"
    || (!allowEmpty && value.length === 0)
    || value.length > maximum
    || value.includes("\0")) {
    failure(ELECTRON_HUMAN_CHANNEL_KEY_ERROR_CODES.INVALID_ARGUMENT);
  }
  return value;
}

function validateFileName(value) {
  validatePathPart(value, MAX_HUMAN_CHANNEL_FILE_NAME_LENGTH);
  if (value === "." || value === ".." || value.includes("/") || value.includes("\\")
    || path.basename(value) !== value) {
    failure(ELECTRON_HUMAN_CHANNEL_KEY_ERROR_CODES.INVALID_ARGUMENT);
  }
  return value;
}

function validatePrivateDer(value) {
  if (!(value instanceof Uint8Array)
    || value.byteLength === 0
    || value.byteLength > MAX_HUMAN_CHANNEL_PRIVATE_KEY_DER_BYTES) {
    failure(ELECTRON_HUMAN_CHANNEL_KEY_ERROR_CODES.INVALID_ARGUMENT);
  }
  return Uint8Array.from(value);
}

function encryptionAvailable(safeStorage) {
  try {
    if (safeStorage.isEncryptionAvailable() !== true) {
      failure(ELECTRON_HUMAN_CHANNEL_KEY_ERROR_CODES.ENCRYPTION_UNAVAILABLE);
    }
  } catch (error) {
    if (error instanceof ElectronHumanChannelKeyError
      && error.code === ELECTRON_HUMAN_CHANNEL_KEY_ERROR_CODES.ENCRYPTION_UNAVAILABLE) throw error;
    failure(ELECTRON_HUMAN_CHANNEL_KEY_ERROR_CODES.ENCRYPTION_UNAVAILABLE);
  }
}

function strictBase64UrlDecode(value) {
  if (typeof value !== "string"
    || value.length === 0
    || value.length % 4 === 1
    || !/^[A-Za-z0-9_-]+$/.test(value)) {
    failure(ELECTRON_HUMAN_CHANNEL_KEY_ERROR_CODES.CIPHERTEXT_INVALID);
  }
  let decoded;
  try {
    decoded = Buffer.from(value, "base64url");
  } catch {
    failure(ELECTRON_HUMAN_CHANNEL_KEY_ERROR_CODES.CIPHERTEXT_INVALID);
  }
  if (decoded.byteLength === 0
    || decoded.byteLength > MAX_HUMAN_CHANNEL_PRIVATE_KEY_DER_BYTES
    || decoded.toString("base64url") !== value) {
    failure(ELECTRON_HUMAN_CHANNEL_KEY_ERROR_CODES.CIPHERTEXT_INVALID);
  }
  return Uint8Array.from(decoded);
}

function readEncryptedFile(filePath) {
  let descriptor;
  try {
    const target = fs.lstatSync(filePath);
    if (!target.isFile()) failure(ELECTRON_HUMAN_CHANNEL_KEY_ERROR_CODES.STORAGE_UNAVAILABLE);
    descriptor = fs.openSync(filePath, "r");
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.size === 0 || opened.size > MAX_HUMAN_CHANNEL_ENCRYPTED_BYTES) {
      failure(ELECTRON_HUMAN_CHANNEL_KEY_ERROR_CODES.CIPHERTEXT_INVALID);
    }
    const encrypted = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < encrypted.byteLength) {
      const read = fs.readSync(descriptor, encrypted, offset, encrypted.byteLength - offset, offset);
      if (read <= 0) failure(ELECTRON_HUMAN_CHANNEL_KEY_ERROR_CODES.CIPHERTEXT_INVALID);
      offset += read;
    }
    return encrypted;
  } catch (error) {
    if (error instanceof ElectronHumanChannelKeyError) throw error;
    if (isMissing(error)) return undefined;
    failure(ELECTRON_HUMAN_CHANNEL_KEY_ERROR_CODES.STORAGE_UNAVAILABLE);
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // The operation's stable error has already been selected, if needed.
      }
    }
  }
}

function writeEncryptedFile(filePath, userDataPath, encrypted) {
  let temporaryPath;
  let descriptor;
  try {
    fs.mkdirSync(userDataPath, { recursive: true });
    const existing = (() => {
      try {
        return fs.lstatSync(filePath);
      } catch (error) {
        if (isMissing(error)) return undefined;
        throw error;
      }
    })();
    if (existing && !existing.isFile()) failure(ELECTRON_HUMAN_CHANNEL_KEY_ERROR_CODES.STORAGE_UNAVAILABLE);

    temporaryPath = path.join(
      userDataPath,
      `.${path.basename(filePath)}.${randomBytes(12).toString("hex")}.tmp`,
    );
    descriptor = fs.openSync(temporaryPath, "wx", 0o600);
    let offset = 0;
    while (offset < encrypted.byteLength) {
      const written = fs.writeSync(descriptor, encrypted, offset, encrypted.byteLength - offset, offset);
      if (written <= 0) failure(ELECTRON_HUMAN_CHANNEL_KEY_ERROR_CODES.STORAGE_UNAVAILABLE);
      offset += written;
    }
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    try {
      fs.renameSync(temporaryPath, filePath);
    } catch (error) {
      // Windows does not replace an existing file with renameSync. The target
      // was checked above and remains a regular file in this fallback.
      if (!existing || (error?.code !== "EEXIST" && error?.code !== "EPERM")) throw error;
      fs.unlinkSync(filePath);
      fs.renameSync(temporaryPath, filePath);
    }
    temporaryPath = undefined;
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // File modes are advisory on platforms that do not support chmod.
    }
  } catch (error) {
    if (error instanceof ElectronHumanChannelKeyError) throw error;
    failure(ELECTRON_HUMAN_CHANNEL_KEY_ERROR_CODES.STORAGE_UNAVAILABLE);
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Cleanup must not expose an OS error.
      }
    }
    if (temporaryPath !== undefined) {
      try {
        fs.unlinkSync(temporaryPath);
      } catch {
        // Best-effort cleanup of a private temporary file.
      }
    }
  }
}

/**
 * Build the Electron main-process implementation of HumanChannelKeyStore.
 * No Electron module is imported, and no renderer/preload, IPC, GUI approval,
 * or listener path is implemented here; callers inject Electron safeStorage.
 */
export function createElectronHumanChannelKeyStore(options = {}) {
  if (options === null || typeof options !== "object") {
    failure(ELECTRON_HUMAN_CHANNEL_KEY_ERROR_CODES.INVALID_ARGUMENT);
  }
  const {
    safeStorage,
    userDataPath,
    fileName = DEFAULT_HUMAN_CHANNEL_KEY_FILE_NAME,
  } = options;
  validateSafeStorage(safeStorage);
  validatePathPart(userDataPath, MAX_HUMAN_CHANNEL_USER_DATA_PATH_LENGTH);
  validateFileName(fileName);
  const filePath = path.join(userDataPath, fileName);

  return Object.freeze({
    loadPrivateKeyDer() {
      encryptionAvailable(safeStorage);
      const encrypted = readEncryptedFile(filePath);
      if (encrypted === undefined) return undefined;
      let decrypted;
      try {
        decrypted = safeStorage.decryptString(encrypted);
      } catch {
        failure(ELECTRON_HUMAN_CHANNEL_KEY_ERROR_CODES.CIPHERTEXT_INVALID);
      }
      return strictBase64UrlDecode(decrypted);
    },

    savePrivateKeyDer(der) {
      const copiedDer = validatePrivateDer(der);
      encryptionAvailable(safeStorage);
      const plaintext = Buffer.from(copiedDer).toString("base64url");
      let encrypted;
      try {
        encrypted = safeStorage.encryptString(plaintext);
      } catch {
        failure(ELECTRON_HUMAN_CHANNEL_KEY_ERROR_CODES.STORAGE_UNAVAILABLE);
      }
      if (!(encrypted instanceof Uint8Array)
        || encrypted.byteLength === 0
        || encrypted.byteLength > MAX_HUMAN_CHANNEL_ENCRYPTED_BYTES) {
        failure(ELECTRON_HUMAN_CHANNEL_KEY_ERROR_CODES.STORAGE_UNAVAILABLE);
      }
      writeEncryptedFile(filePath, userDataPath, Buffer.from(encrypted));
    },
  });
}
