import { createElectronHumanChannelKeyStore } from "./human-channel-key.mjs";
import { createElectronWardenAdapter } from "./human-channel-adapter.mjs";
import {
  createMainHumanChannelController,
  ELECTRON_HUMAN_CHANNEL_CONTROLLER_ERROR_CODES,
} from "./human-channel-controller.mjs";

/**
 * This is a main-process seam, not an Electron transport.  The returned
 * listener is intentionally only held by main.mjs; no method in this module
 * is suitable for contextBridge, IPC, HTTP, or CLI exposure.
 */
export const ELECTRON_HUMAN_CHANNEL_LISTENER_ERROR_CODES = Object.freeze({
  INVALID_ARGUMENT: "ELECTRON_HUMAN_CHANNEL_LISTENER_INVALID_ARGUMENT",
  SAFE_STORAGE_UNAVAILABLE: "ELECTRON_HUMAN_CHANNEL_LISTENER_SAFE_STORAGE_UNAVAILABLE",
  CONFIRMATION_UNAVAILABLE: "ELECTRON_HUMAN_CHANNEL_LISTENER_CONFIRMATION_UNAVAILABLE",
  ADAPTER_UNQUALIFIED: "ELECTRON_HUMAN_CHANNEL_LISTENER_ADAPTER_UNQUALIFIED",
});

const ERROR_MESSAGES = Object.freeze({
  [ELECTRON_HUMAN_CHANNEL_LISTENER_ERROR_CODES.INVALID_ARGUMENT]:
    "The Electron Human Channel listener input is invalid",
  [ELECTRON_HUMAN_CHANNEL_LISTENER_ERROR_CODES.SAFE_STORAGE_UNAVAILABLE]:
    "Electron safeStorage is unavailable",
  [ELECTRON_HUMAN_CHANNEL_LISTENER_ERROR_CODES.CONFIRMATION_UNAVAILABLE]:
    "Human Channel enrollment confirmation is unavailable",
  [ELECTRON_HUMAN_CHANNEL_LISTENER_ERROR_CODES.ADAPTER_UNQUALIFIED]:
    "The Warden Human Channel adapter is not qualified for Electron",
});

export class ElectronHumanChannelListenerError extends Error {
  constructor(code) {
    super(ERROR_MESSAGES[code] ?? ERROR_MESSAGES[ELECTRON_HUMAN_CHANNEL_LISTENER_ERROR_CODES.ADAPTER_UNQUALIFIED]);
    this.name = "ElectronHumanChannelListenerError";
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function fail(code) {
  throw new ElectronHumanChannelListenerError(code);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainOptions(options) {
  if (!isPlainObject(options)) fail(ELECTRON_HUMAN_CHANNEL_LISTENER_ERROR_CODES.INVALID_ARGUMENT);
}

function assertSafeStorage(safeStorage) {
  if (safeStorage === null || typeof safeStorage !== "object"
    || typeof safeStorage.isEncryptionAvailable !== "function"
    || typeof safeStorage.encryptString !== "function"
    || typeof safeStorage.decryptString !== "function") {
    fail(ELECTRON_HUMAN_CHANNEL_LISTENER_ERROR_CODES.INVALID_ARGUMENT);
  }
  try {
    if (safeStorage.isEncryptionAvailable() !== true) {
      fail(ELECTRON_HUMAN_CHANNEL_LISTENER_ERROR_CODES.SAFE_STORAGE_UNAVAILABLE);
    }
  } catch (error) {
    if (error instanceof ElectronHumanChannelListenerError) throw error;
    fail(ELECTRON_HUMAN_CHANNEL_LISTENER_ERROR_CODES.SAFE_STORAGE_UNAVAILABLE);
  }
}

function staticConfirmation(dialog, parentWindow) {
  if (dialog === null || typeof dialog !== "object"
    || typeof dialog.showMessageBoxSync !== "function") {
    fail(ELECTRON_HUMAN_CHANNEL_LISTENER_ERROR_CODES.INVALID_ARGUMENT);
  }
  return ({ publicKeyFingerprint }) => {
    let response;
    try {
      response = dialog.showMessageBoxSync(parentWindow, {
        type: "question",
        title: "Confirm Human Channel device",
        message: "Enroll this Electron device for Human Channel approvals?",
        detail: `Device fingerprint: ${publicKeyFingerprint}`,
        buttons: ["Cancel", "Enroll"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
    } catch {
      fail(ELECTRON_HUMAN_CHANNEL_LISTENER_ERROR_CODES.CONFIRMATION_UNAVAILABLE);
    }
    if (response !== 1) return false;
    // The native dialog is the only confirmation source. Do not forward its
    // response object, window, or any key material into the Warden seam.
    return Object.freeze({ confirm: true });
  };
}

function adapterDependencies(value) {
  if (!isPlainObject(value)
    || value.channel === null || typeof value.channel !== "object"
    || value.deviceSigner === null || typeof value.deviceSigner !== "object") {
    fail(ELECTRON_HUMAN_CHANNEL_LISTENER_ERROR_CODES.ADAPTER_UNQUALIFIED);
  }
  return value;
}

/**
 * Pure listener factory. It is the only object that can invoke the controller
 * from this module, and it keeps the Warden channel and signer in a closure.
 */
export function createMainHumanChannelListener(options) {
  assertPlainOptions(options);
  if (typeof options.confirmEnrollment !== "function") {
    fail(ELECTRON_HUMAN_CHANNEL_LISTENER_ERROR_CODES.INVALID_ARGUMENT);
  }
  const controller = createMainHumanChannelController({
    channel: options.channel,
    deviceSigner: options.deviceSigner,
    confirmEnrollment: options.confirmEnrollment,
  });

  return Object.freeze({
    status: () => controller.status(),
    enroll: () => controller.enroll(),
    recordDecision: (request) => controller.recordMainDecision(request),
    verifyEvidence: (request) => controller.verifyMainEvidence(request),
  });
}

/**
 * Electron bootstrap. The packaged path uses the built-in JavaScript adapter;
 * an injected adapter remains an explicit, unqualified test seam and is never
 * used by the real main-process bootstrap.
 */
export function createElectronHumanChannelMainBootstrap(options) {
  assertPlainOptions(options);
  assertSafeStorage(options.safeStorage);
  if (typeof options.userDataPath !== "string" || options.userDataPath.length === 0) {
    fail(ELECTRON_HUMAN_CHANNEL_LISTENER_ERROR_CODES.INVALID_ARGUMENT);
  }
  const confirmEnrollment = staticConfirmation(options.dialog, options.parentWindow);

  const keyStore = createElectronHumanChannelKeyStore({
    safeStorage: options.safeStorage,
    userDataPath: options.userDataPath,
    fileName: options.fileName,
  });
  let adapter;
  const injected = typeof options.createWardenAdapter === "function";
  try {
    adapter = injected
      ? options.createWardenAdapter(Object.freeze({ keyStore }))
      : createElectronWardenAdapter({
        keyStore,
        safeStorage: options.safeStorage,
        userDataPath: options.userDataPath,
        stateFileName: options.stateFileName,
      });
  } catch {
    fail(ELECTRON_HUMAN_CHANNEL_LISTENER_ERROR_CODES.ADAPTER_UNQUALIFIED);
  }
  const dependencies = adapterDependencies(adapter);
  const listener = createMainHumanChannelListener({
    ...dependencies,
    confirmEnrollment,
  });

  return Object.freeze({
    qualified: !injected,
    qualification: injected ? "adapter-seam" : "electron-js-adapter",
    status: listener.status(),
    listener,
  });
}

// The controller's codes remain the canonical values for replay, tamper,
// origin, and bounded request failures. This export makes the dependency
// relationship discoverable without copying the Warden implementation.
export { ELECTRON_HUMAN_CHANNEL_CONTROLLER_ERROR_CODES };
