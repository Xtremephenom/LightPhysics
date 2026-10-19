import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { verify as nodeVerify } from "node:crypto";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  createElectronHumanChannelMainBootstrap,
  createMainHumanChannelListener,
  ELECTRON_HUMAN_CHANNEL_LISTENER_ERROR_CODES as LISTENER_CODES,
  ElectronHumanChannelListenerError,
} from "../src/human-channel-listener.mjs";
import {
  ELECTRON_HUMAN_CHANNEL_CONTROLLER_ERROR_CODES as CONTROLLER_CODES,
  ElectronHumanChannelControllerError,
} from "../src/human-channel-controller.mjs";
import { createElectronWardenAdapter } from "../src/human-channel-adapter.mjs";
import { createElectronHumanChannelKeyStore } from "../src/human-channel-key.mjs";
import { HumanChannel } from "../../../packages/warden/src/human-channel.ts";
import {
  HumanChannelDeviceSigner,
} from "../../../packages/warden/src/human-device-key.ts";

const INPUT = Object.freeze({
  subject_hash: "b".repeat(64),
  decision: "approve",
  reason: "release the verified build",
});

function reversibleSafeStorage({ available = true } = {}) {
  const marker = Buffer.from([0x4c, 0x50, 0x4b, 0x02]);
  return {
    isEncryptionAvailable: () => available,
    encryptString(value) {
      return Buffer.concat([marker, Buffer.from(value, "utf8")]);
    },
    decryptString(value) {
      return Buffer.from(value).subarray(marker.length).toString("utf8");
    },
  };
}

function setupListener(confirmEnrollment = () => ({ confirm: true })) {
  const deviceSigner = new HumanChannelDeviceSigner({
    loadPrivateKeyDer: () => undefined,
    savePrivateKeyDer: () => undefined,
  });
  const channel = new HumanChannel({
    signer: deviceSigner.signer,
    clock: () => new Date("2026-01-02T03:04:05.000Z"),
    nonce: (() => {
      let count = 0;
      return () => `listener-nonce-${count += 1}`;
    })(),
  });
  return {
    channel,
    listener: createMainHumanChannelListener({ channel, deviceSigner, confirmEnrollment }),
  };
}

function assertCode(callback, expected, ErrorType) {
  assert.throws(callback, (error) => error instanceof ErrorType
    && error.code === expected
    && error.message.length < 128
    && !("cause" in error));
}

function bootstrap({ response = 1, available = true } = {}) {
  const userDataPath = mkdtempSync(path.join(os.tmpdir(), "lightphysics-listener-"));
  const dialog = {
    calls: [],
    showMessageBoxSync(parentWindow, details) {
      this.calls.push({ parentWindow, details });
      return response;
    },
  };
  const result = createElectronHumanChannelMainBootstrap({
    safeStorage: reversibleSafeStorage({ available }),
    userDataPath,
    dialog,
    parentWindow: { id: "main-window" },
    createWardenAdapter: ({ keyStore }) => {
      const deviceSigner = new HumanChannelDeviceSigner(keyStore);
      const channel = new HumanChannel({
        signer: deviceSigner.signer,
        clock: () => new Date("2026-01-02T03:04:05.000Z"),
        nonce: () => "bootstrap-nonce-1",
      });
      return { channel, deviceSigner };
    },
  });
  return { result, dialog, cleanup: () => rmSync(userDataPath, { recursive: true, force: true }) };
}

function nativeBootstrap({ response = 1, userDataPath = undefined } = {}) {
  const ownedPath = userDataPath ?? mkdtempSync(path.join(os.tmpdir(), "lightphysics-native-listener-"));
  const dialog = {
    calls: [],
    showMessageBoxSync(parentWindow, details) {
      this.calls.push({ parentWindow, details });
      return response;
    },
  };
  const result = createElectronHumanChannelMainBootstrap({
    safeStorage: reversibleSafeStorage(),
    userDataPath: ownedPath,
    dialog,
    parentWindow: { id: "main-window" },
  });
  return { result, dialog, userDataPath: ownedPath, cleanup: () => rmSync(ownedPath, { recursive: true, force: true }) };
}

test("bootstrap fails closed when Electron safeStorage is unavailable", () => {
  let adapterCalled = false;
  assertCode(() => createElectronHumanChannelMainBootstrap({
    safeStorage: reversibleSafeStorage({ available: false }),
    userDataPath: "listener-test-user-data",
    dialog: { showMessageBoxSync: () => 1 },
    createWardenAdapter: () => {
      adapterCalled = true;
      return undefined;
    },
  }), LISTENER_CODES.SAFE_STORAGE_UNAVAILABLE, ElectronHumanChannelListenerError);
  assert.equal(adapterCalled, false);
});

test("native main-process confirmation cancellation prevents enrollment", () => {
  const { result, dialog, cleanup } = bootstrap({ response: 0 });
  try {
    assert.equal(result.qualified, false);
    assert.equal(result.qualification, "adapter-seam");
    assert.deepEqual(result.status, { enrolled: false, replayedNonceCount: 0, replayStateLimit: 4096 });
    assertCode(() => result.listener.enroll(), CONTROLLER_CODES.ENROLLMENT_REQUIRED, ElectronHumanChannelControllerError);
    assert.equal(dialog.calls.length, 1);
    assert.equal(dialog.calls[0].details.buttons.join(","), "Cancel,Enroll");
  } finally {
    cleanup();
  }
});

test("explicit native enrollment signs only in main and returns a safe verified receipt", () => {
  const { result, dialog, cleanup } = bootstrap({ response: 1 });
  try {
    const enrolled = result.listener.enroll();
    assert.equal(enrolled.enrolled, true);
    assert.equal(dialog.calls[0].details.defaultId, 0);
    const receipt = result.listener.recordDecision({ source: "main", input: INPUT });
    assert.deepEqual(receipt, {
      ...INPUT,
      nonce: "bootstrap-nonce-1",
      timestamp: "2026-01-02T03:04:05.000Z",
      verified: true,
    });
    assert.equal("signature" in receipt, false);
    assert.equal(JSON.stringify(receipt).includes("PRIVATE KEY"), false);
    assert.equal(JSON.stringify(result.listener).includes("signer"), false);
    assert.equal("approve" in result.listener, false);
    assert.equal("grant" in result.listener, false);
  } finally {
    cleanup();
  }
});

test("the packaged JavaScript adapter qualifies and restores bounded replay state", () => {
  const first = nativeBootstrap();
  try {
    assert.equal(first.result.qualified, true);
    assert.equal(first.result.qualification, "electron-js-adapter");
    first.result.listener.enroll();
    const receipt = first.result.listener.recordDecision({ source: "main", input: INPUT });
    assert.equal(receipt.verified, true);
    assert.equal("signature" in receipt, false);
    assert.equal(JSON.stringify(first.result.listener).includes("PRIVATE KEY"), false);

    const second = nativeBootstrap({ userDataPath: first.userDataPath });
    try {
      assert.equal(second.result.qualified, true);
      assert.equal(second.result.status.enrolled, true);
      assert.equal(second.result.status.replayedNonceCount, 1);
      assert.equal(second.result.status.publicKeyFingerprint.length, 64);
    } finally {
      // The second bootstrap shares the first path and must not own cleanup.
    }
  } finally {
    first.cleanup();
  }
});

test("the JavaScript adapter preserves canonical Ed25519 verification across restart", () => {
  const userDataPath = mkdtempSync(path.join(os.tmpdir(), "lightphysics-native-adapter-"));
  try {
    const safeStorage = reversibleSafeStorage();
    const makeAdapter = () => createElectronWardenAdapter({
      keyStore: createElectronHumanChannelKeyStore({ safeStorage, userDataPath }),
      safeStorage,
      userDataPath,
    });
    const first = makeAdapter();
    first.channel.enrollPublicKey(first.deviceSigner.publicKey, { confirm: true });
    const signed = first.channel.signApproval(INPUT);
    assert.equal(nodeVerify(
      null,
      Buffer.from(JSON.stringify({
        subject_hash: signed.subject_hash,
        decision: signed.decision,
        reason: signed.reason,
        nonce: signed.nonce,
        timestamp: signed.timestamp,
      }), "utf8"),
      { key: Buffer.from(first.deviceSigner.publicKey), format: "der", type: "spki" },
      Buffer.from(signed.signature, "base64url"),
    ), true);
    assert.equal(first.channel.verifySignedApproval(signed).verified, true);

    const second = makeAdapter();
    assert.throws(
      () => second.channel.verifySignedApproval(signed),
      (error) => error?.code === "HumanChannelReplayError",
    );
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test("replay and tamper failures retain static controller codes", () => {
  const { listener, channel } = setupListener();
  listener.enroll();
  const signed = channel.signApproval(INPUT);
  assert.equal(listener.verifyEvidence({ source: "main", evidence: signed }).verified, true);
  assertCode(
    () => listener.verifyEvidence({ source: "main", evidence: signed }),
    CONTROLLER_CODES.REPLAY,
    ElectronHumanChannelControllerError,
  );
  assertCode(
    () => listener.verifyEvidence({
      source: "main",
      evidence: { ...signed, reason: "tampered" },
    }),
    CONTROLLER_CODES.INVALID_EVIDENCE,
    ElectronHumanChannelControllerError,
  );
  assert.equal(listener.verifyEvidence, listener.verifyEvidence);
});

test("listener accepts only main-origin decisions and bounded approval input", () => {
  const { listener } = setupListener();
  listener.enroll();
  assertCode(
    () => listener.recordDecision({ source: "renderer", input: INPUT }),
    CONTROLLER_CODES.ORIGIN_REJECTED,
    ElectronHumanChannelControllerError,
  );
  assertCode(
    () => listener.recordDecision({ source: "main", input: { ...INPUT, reason: "x".repeat(2_049) } }),
    CONTROLLER_CODES.INVALID_REQUEST,
    ElectronHumanChannelControllerError,
  );
  assertCode(
    () => listener.recordDecision({ source: "main", input: { ...INPUT, extra: true } }),
    CONTROLLER_CODES.INVALID_REQUEST,
    ElectronHumanChannelControllerError,
  );
  assert.deepEqual(Object.keys(listener).sort(), ["enroll", "recordDecision", "status", "verifyEvidence"]);
});

test("preload exposes only bounded status/enrollment requests", () => {
  const preload = readFileSync(new URL("../src/preload.mjs", import.meta.url), "utf8");
  const preloadCode = preload.replace(/\/\/.*$/gm, "");
  assert.match(preload, /getHumanChannelStatus/);
  assert.match(preload, /requestHumanChannelEnrollment/);
  assert.doesNotMatch(preloadCode, /signer|signature|privateKey|approve|grant/i);
  assert.doesNotMatch(preloadCode, /contextBridge\.exposeInMainWorld\([^)]*ipcRenderer/);
});
