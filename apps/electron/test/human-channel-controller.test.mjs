import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createMainHumanChannelController,
  ELECTRON_HUMAN_CHANNEL_CONTROLLER_ERROR_CODES as CODES,
  ElectronHumanChannelControllerError,
} from "../src/human-channel-controller.mjs";
import { HumanChannel } from "../../../packages/warden/src/human-channel.ts";
import {
  HumanChannelDeviceSigner,
  InMemoryHumanChannelKeyStore,
} from "../../../packages/warden/src/human-device-key.ts";

const INPUT = Object.freeze({
  subject_hash: "a".repeat(64),
  decision: "approve",
  reason: "release the verified build",
});

function setup(confirmEnrollment = () => ({ confirm: true })) {
  const deviceSigner = new HumanChannelDeviceSigner(new InMemoryHumanChannelKeyStore());
  const channel = new HumanChannel({
    signer: deviceSigner.signer,
    clock: () => new Date("2026-01-02T03:04:05.000Z"),
    nonce: (() => {
      let count = 0;
      return () => `controller-nonce-${count += 1}`;
    })(),
  });
  return {
    channel,
    deviceSigner,
    controller: createMainHumanChannelController({
      channel,
      deviceSigner,
      confirmEnrollment,
    }),
  };
}

function assertCode(callback, code) {
  assert.throws(callback, (error) => error instanceof ElectronHumanChannelControllerError
    && error.code === code
    && error.message.length < 128
    && !("cause" in error));
}

test("controller owns only main-process dependencies and requires explicit enrollment", () => {
  const { controller } = setup(() => false);
  assert.deepEqual(Object.keys(controller).sort(), ["enroll", "recordMainDecision", "status", "verifyMainEvidence"]);
  assert.deepEqual(controller.status(), { enrolled: false, replayedNonceCount: 0, replayStateLimit: 4096 });
  assertCode(() => controller.enroll(), CODES.ENROLLMENT_REQUIRED);
  assert.equal(JSON.stringify(controller).includes("PRIVATE"), false);
  assert.equal(JSON.stringify(controller).includes("signer"), false);
});

test("explicit enrollment and main signing/verification return no raw signature", () => {
  const { controller, deviceSigner } = setup();
  const enrolled = controller.enroll();
  assert.equal(enrolled.enrolled, true);
  assert.equal(enrolled.publicKeyFingerprint, deviceSigner.publicKeyFingerprint);
  const receipt = controller.recordMainDecision({ source: "main", input: INPUT });
  assert.deepEqual(receipt, {
    ...INPUT,
    nonce: "controller-nonce-1",
    timestamp: "2026-01-02T03:04:05.000Z",
    verified: true,
  });
  assert.equal("signature" in receipt, false);
  assert.equal(JSON.stringify(receipt).includes("PRIVATE KEY"), false);
});

test("forged, replayed, tampered, and renderer-origin evidence fail visibly", () => {
  const { controller, channel } = setup();
  controller.enroll();
  const signed = channel.signApproval(INPUT);
  assert.equal(controller.verifyMainEvidence({ source: "main", evidence: signed }).verified, true);
  assertCode(() => controller.verifyMainEvidence({ source: "main", evidence: signed }), CODES.REPLAY);
  assertCode(() => controller.verifyMainEvidence({ source: "renderer", evidence: signed }), CODES.ORIGIN_REJECTED);
  assertCode(() => controller.verifyMainEvidence({
    source: "main",
    evidence: { ...signed, reason: "tampered" },
  }), CODES.INVALID_EVIDENCE);
  assertCode(() => controller.verifyMainEvidence({
    source: "main",
    evidence: { ...signed, signature: "A".repeat(86) },
  }), CODES.INVALID_EVIDENCE);
});

test("approval requests are exact, bounded, and do not expose a grant facade", () => {
  const { controller } = setup();
  controller.enroll();
  assertCode(() => controller.recordMainDecision({ source: "main", input: { ...INPUT, extra: true } }), CODES.INVALID_REQUEST);
  assertCode(() => controller.recordMainDecision({ source: "main", input: { ...INPUT, reason: "x".repeat(2_049) } }), CODES.INVALID_REQUEST);
  assertCode(() => controller.recordMainDecision({ source: "main", input: { ...INPUT, reason: "x".repeat(20_000) } }), CODES.INVALID_REQUEST);
  assertCode(() => controller.recordMainDecision({ source: "renderer", input: INPUT }), CODES.ORIGIN_REJECTED);
  assert.equal("grant" in controller, false);
  assert.equal("approve" in controller, false);
  assert.equal("privateKey" in controller, false);
  assert.equal("signer" in controller, false);
});

test("the renderer bridge exposes only bounded status/enrollment requests", () => {
  const preload = readFileSync(new URL("../src/preload.mjs", import.meta.url), "utf8");
  const main = readFileSync(new URL("../src/main.mjs", import.meta.url), "utf8");
  const preloadCode = preload.replace(/\/\/.*$/gm, "");
  assert.match(preload, /getHumanChannelStatus/);
  assert.match(preload, /requestHumanChannelEnrollment/);
  assert.doesNotMatch(preloadCode, /signer|signature|privateKey|approve|grant/i);
  assert.doesNotMatch(preloadCode, /contextBridge\.exposeInMainWorld\([^)]*ipcRenderer/);
  assert.doesNotMatch(main, /ipcRenderer|app\.on\(["']http|express/);
  assert.match(main, /ipcMain\.handle\(humanChannelStatusChannel/);
  assert.match(main, /ipcMain\.handle\(humanChannelEnrollmentChannel/);
  assert.doesNotMatch(main, /ipcMain\.handle\([^)]*(approval|grant|recordDecision)/i);
  assert.match(main, /humanChannelMainController/);
});
