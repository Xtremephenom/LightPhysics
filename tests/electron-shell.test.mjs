import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ELECTRON_HUMAN_CHANNEL_KEY_ERROR_CODES,
  MAX_HUMAN_CHANNEL_ENCRYPTED_BYTES,
  MAX_HUMAN_CHANNEL_FILE_NAME_LENGTH,
  MAX_HUMAN_CHANNEL_PRIVATE_KEY_DER_BYTES,
  MAX_HUMAN_CHANNEL_USER_DATA_PATH_LENGTH,
  createElectronHumanChannelKeyStore,
} from "../apps/electron/src/human-channel-key.mjs";
import {
  RENDERER_MARKERS,
  SHELL_ERROR_CODES,
  STRICT_LOCAL_CSP,
  classifyRendererObservation,
  isAllowedGuiNavigation,
  isLoopbackGuiUrl,
  resolveGuiTarget,
  validateLoopbackGuiUrl,
} from "../apps/electron/src/security.mjs";
import {
  ELECTRON_SMOKE_ERROR_CODES,
  buildDaemonArgs,
  buildElectronArgs,
  buildElectronEnvironment,
  classifyElectronRendererResult,
  parseCliArgs,
  parseListeningPort,
  parseSmokeResult,
} from "../scripts/electron-smoke.mjs";

function validObservation() {
  const selectors = Object.fromEntries(RENDERER_MARKERS.selectors.map((selector) => [selector, true]));
  const texts = Object.fromEntries(RENDERER_MARKERS.selectors.map((selector) => [selector, "stable marker"]));
  for (const marker of RENDERER_MARKERS.texts) texts[marker.selector] += ` ${marker.includes}`;
  return {
    title: RENDERER_MARKERS.title,
    url: "http://127.0.0.1:4317/",
    sameOrigin: true,
    loopback: true,
    csp: STRICT_LOCAL_CSP,
    selectors,
    texts,
  };
}

test("GUI URL validation accepts literal loopback origins and rejects external or credential-bearing URLs", () => {
  for (const value of [
    "http://127.0.0.1:4317/",
    "http://localhost:4317/",
    "http://[::1]:4317/",
  ]) {
    assert.equal(validateLoopbackGuiUrl(value).protocol, "http:");
    assert.equal(isLoopbackGuiUrl(value), true);
  }
  for (const value of [
    "https://127.0.0.1:4317/",
    "http://192.0.2.10:4317/",
    "http://127.0.0.1:4317@remote.example/",
    "file:///tmp/studio-floor",
    "javascript:alert(1)",
  ]) {
    assert.throws(() => validateLoopbackGuiUrl(value), { code: SHELL_ERROR_CODES.INVALID_GUI_URL });
    assert.equal(isLoopbackGuiUrl(value), false);
  }
  assert.equal(isAllowedGuiNavigation("http://127.0.0.1:4317/#studio-floor", "http://127.0.0.1:4317/"), true);
  assert.equal(isAllowedGuiNavigation("http://127.0.0.1:4318/", "http://127.0.0.1:4317/"), false);
  assert.equal(isAllowedGuiNavigation("http://localhost:4317/", "http://127.0.0.1:4317/"), false);
});

test("GUI target resolution accepts LP_GUI_URL or the smoke argument and fails closed when absent", () => {
  assert.deepEqual(resolveGuiTarget({ env: { LP_GUI_URL: "http://127.0.0.1:4317/" } }), {
    url: new URL("http://127.0.0.1:4317/"),
    smoke: false,
    source: "environment",
  });
  assert.deepEqual(resolveGuiTarget({ argv: ["electron", "main.mjs", "--smoke-url", "http://127.0.0.1:4321/"] }), {
    url: new URL("http://127.0.0.1:4321/"),
    smoke: true,
    source: "smoke-argument",
  });
  assert.throws(
    () => resolveGuiTarget({ env: {} }),
    { code: SHELL_ERROR_CODES.GUI_URL_REQUIRED },
  );
});

test("renderer marker classification checks title, stable selectors/text, same-origin URL, and strict CSP", () => {
  const observation = validObservation();
  assert.deepEqual(classifyRendererObservation(observation, observation.url), {
    ok: true,
    classification: "ready",
    failures: [],
  });
  assert.deepEqual(classifyElectronRendererResult(observation, observation.url), {
    ok: true,
    classification: "ready",
    failures: [],
  });

  const missingMarker = validObservation();
  missingMarker.selectors[".statusbar"] = false;
  assert.equal(classifyRendererObservation(missingMarker, missingMarker.url).classification, "marker-missing");

  const wrongSecurity = validObservation();
  wrongSecurity.csp = "default-src 'self'";
  wrongSecurity.url = "http://127.0.0.1:4318/";
  assert.equal(classifyRendererObservation(wrongSecurity, "http://127.0.0.1:4317/").ok, false);
  assert.equal(classifyRendererObservation(wrongSecurity, "http://127.0.0.1:4317/").classification, "renderer-check-failed");
});

test("Electron smoke process and argument helpers stay direct, bounded, and secret-free", () => {
  const daemonArgs = buildDaemonArgs(path.join("apps", "lpd", "src", "main.ts"));
  assert.deepEqual(daemonArgs.slice(0, 1), ["--experimental-strip-types"]);
  assert.equal(daemonArgs[1].endsWith(path.join("apps", "lpd", "src", "main.ts")), true);

  const electronArgs = buildElectronArgs(
    path.join("apps", "electron", "src", "main.mjs"),
    "http://127.0.0.1:4317/",
  );
  assert.equal(electronArgs[1], "--smoke-url");
  assert.equal(electronArgs[2], "http://127.0.0.1:4317/");

  assert.deepEqual(parseCliArgs(["--timeout-ms", "2500", "--max-output-bytes=2048"]), {
    help: false,
    timeoutMs: 2500,
    maxOutputBytes: 2048,
  });
  assert.equal(parseCliArgs(["--", "--help"]).help, true);
  assert.throws(() => parseCliArgs(["--shell"]), { code: ELECTRON_SMOKE_ERROR_CODES.INVALID_ARGUMENT });
  assert.equal(parseListeningPort("lpd listening on 127.0.0.1:41321\n"), 41321);
  assert.equal(parseListeningPort("lpd listening on 0.0.0.0:4317\n"), null);

  const authKey = "phase0-test-auth";
  const childEnv = buildElectronEnvironment({ LP_TOKEN: authKey, API_KEY: authKey, SAFE_VALUE: "kept", LP_GUI_URL: "http://127.0.0.1:4317/" });
  assert.equal(childEnv.LP_TOKEN, undefined);
  assert.equal(childEnv.API_KEY, undefined);
  assert.equal(childEnv.SAFE_VALUE, "kept");
  assert.equal(childEnv.LP_GUI_URL, undefined);

  const result = parseSmokeResult(`noise\nelectron-shell: smoke-result ${JSON.stringify({ ok: true })}\n`);
  assert.deepEqual(result, { ok: true });
  assert.equal(parseSmokeResult("no result"), null);
});

function reversibleSafeStorage({ available = true } = {}) {
  const marker = Buffer.from([0x4c, 0x50, 0x4b, 0x01]);
  return {
    isEncryptionAvailable: () => available,
    encryptString(value) {
      const input = Buffer.from(value, "utf8");
      return Buffer.concat([marker, Buffer.from(Uint8Array.from(input, (byte) => byte ^ 0xa5))]);
    },
    decryptString(value) {
      const input = Buffer.from(value);
      assert.deepEqual(input.subarray(0, marker.length), marker);
      return Buffer.from(Uint8Array.from(input.subarray(marker.length), (byte) => byte ^ 0xa5)).toString("utf8");
    },
  };
}

function withTempUserData(callback) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "lightphysics-key-"));
  try {
    return callback(userDataPath);
  } finally {
    fs.rmSync(userDataPath, { recursive: true, force: true });
  }
}

test("Electron Human Channel key store treats missing state as empty and round-trips copied bytes", () => {
  withTempUserData((userDataPath) => {
    const safeStorage = reversibleSafeStorage();
    const store = createElectronHumanChannelKeyStore({ safeStorage, userDataPath, fileName: "key.bin" });
    assert.equal(store.loadPrivateKeyDer(), undefined);

    const source = Uint8Array.from([0, 1, 2, 3, 254, 255]);
    store.savePrivateKeyDer(source);
    source.fill(0);
    const loaded = store.loadPrivateKeyDer();
    assert.deepEqual(loaded, Uint8Array.from([0, 1, 2, 3, 254, 255]));
    assert.notStrictEqual(loaded, source);
    loaded[0] = 99;
    assert.equal(store.loadPrivateKeyDer()[0], 0);
  });
});

test("Electron Human Channel key store writes ciphertext only and rejects unavailable encryption", () => {
  withTempUserData((userDataPath) => {
    const der = Uint8Array.from([0x30, 0x82, 0xde, 0xad, 0xbe, 0xef]);
    const safeStorage = reversibleSafeStorage();
    const store = createElectronHumanChannelKeyStore({ safeStorage, userDataPath, fileName: "cipher.bin" });
    store.savePrivateKeyDer(der);
    const ciphertext = fs.readFileSync(path.join(userDataPath, "cipher.bin"));
    const plaintext = Buffer.from(der).toString("base64url");
    assert.equal(ciphertext.includes(Buffer.from(der)), false);
    assert.equal(ciphertext.includes(Buffer.from(plaintext)), false);

    const unavailable = createElectronHumanChannelKeyStore({
      safeStorage: reversibleSafeStorage({ available: false }),
      userDataPath: path.join(userDataPath, "unavailable"),
    });
    assert.throws(() => unavailable.loadPrivateKeyDer(), {
      code: ELECTRON_HUMAN_CHANNEL_KEY_ERROR_CODES.ENCRYPTION_UNAVAILABLE,
    });
    assert.throws(() => unavailable.savePrivateKeyDer(der), {
      code: ELECTRON_HUMAN_CHANNEL_KEY_ERROR_CODES.ENCRYPTION_UNAVAILABLE,
    });
  });
});

test("Electron Human Channel key store rejects malformed ciphertext, decrypted base64, and bounded inputs", () => {
  withTempUserData((userDataPath) => {
    const safeStorage = reversibleSafeStorage();
    const fileName = "key.bin";
    const store = createElectronHumanChannelKeyStore({ safeStorage, userDataPath, fileName });
    const filePath = path.join(userDataPath, fileName);
    fs.writeFileSync(filePath, Buffer.alloc(MAX_HUMAN_CHANNEL_ENCRYPTED_BYTES + 1, 7));
    assert.throws(() => store.loadPrivateKeyDer(), {
      code: ELECTRON_HUMAN_CHANNEL_KEY_ERROR_CODES.CIPHERTEXT_INVALID,
    });

    fs.writeFileSync(filePath, Buffer.from([0x4c, 0x50, 0x4b, 0x01, 0xff]));
    assert.throws(() => store.loadPrivateKeyDer(), {
      code: ELECTRON_HUMAN_CHANNEL_KEY_ERROR_CODES.CIPHERTEXT_INVALID,
    });

    const invalidPlaintextStore = createElectronHumanChannelKeyStore({
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: () => Uint8Array.from([1]),
        decryptString: () => "not-base64!",
      },
      userDataPath: path.join(userDataPath, "invalid-plaintext"),
    });
    invalidPlaintextStore.savePrivateKeyDer(Uint8Array.from([1]));
    assert.throws(() => invalidPlaintextStore.loadPrivateKeyDer(), {
      code: ELECTRON_HUMAN_CHANNEL_KEY_ERROR_CODES.CIPHERTEXT_INVALID,
    });

    assert.throws(() => store.savePrivateKeyDer(new Uint8Array()), {
      code: ELECTRON_HUMAN_CHANNEL_KEY_ERROR_CODES.INVALID_ARGUMENT,
    });
    assert.throws(() => store.savePrivateKeyDer(new Uint8Array(MAX_HUMAN_CHANNEL_PRIVATE_KEY_DER_BYTES + 1)), {
      code: ELECTRON_HUMAN_CHANNEL_KEY_ERROR_CODES.INVALID_ARGUMENT,
    });
    assert.throws(() => createElectronHumanChannelKeyStore({ safeStorage, userDataPath: "x\0y" }), {
      code: ELECTRON_HUMAN_CHANNEL_KEY_ERROR_CODES.INVALID_ARGUMENT,
    });
    assert.throws(() => createElectronHumanChannelKeyStore({
      safeStorage,
      userDataPath: "x".repeat(MAX_HUMAN_CHANNEL_USER_DATA_PATH_LENGTH + 1),
    }), {
      code: ELECTRON_HUMAN_CHANNEL_KEY_ERROR_CODES.INVALID_ARGUMENT,
    });
    assert.throws(() => createElectronHumanChannelKeyStore({ safeStorage, userDataPath, fileName: "nested/key" }), {
      code: ELECTRON_HUMAN_CHANNEL_KEY_ERROR_CODES.INVALID_ARGUMENT,
    });
    assert.throws(() => createElectronHumanChannelKeyStore({
      safeStorage,
      userDataPath,
      fileName: "x".repeat(MAX_HUMAN_CHANNEL_FILE_NAME_LENGTH + 1),
    }), {
      code: ELECTRON_HUMAN_CHANNEL_KEY_ERROR_CODES.INVALID_ARGUMENT,
    });
  });
});

test("Electron Human Channel key store rejects non-regular files and symlinks without leaking details", () => {
  withTempUserData((userDataPath) => {
    const safeStorage = reversibleSafeStorage();
    const store = createElectronHumanChannelKeyStore({ safeStorage, userDataPath, fileName: "key.bin" });
    const filePath = path.join(userDataPath, "key.bin");
    fs.mkdirSync(filePath);
    assert.throws(() => store.loadPrivateKeyDer(), {
      code: ELECTRON_HUMAN_CHANNEL_KEY_ERROR_CODES.STORAGE_UNAVAILABLE,
    });
    fs.rmSync(filePath, { recursive: true });

    try {
      fs.symlinkSync(path.join(userDataPath, "elsewhere"), filePath);
    } catch (error) {
      if (error?.code === "EPERM") return;
      throw error;
    }
    assert.throws(() => store.loadPrivateKeyDer(), {
      code: ELECTRON_HUMAN_CHANNEL_KEY_ERROR_CODES.STORAGE_UNAVAILABLE,
    });
    assert.throws(() => store.savePrivateKeyDer(Uint8Array.from([1, 2, 3])), {
      code: ELECTRON_HUMAN_CHANNEL_KEY_ERROR_CODES.STORAGE_UNAVAILABLE,
    });
  });
});

test("Electron Human Channel key store exposes static errors without secret or path leakage", () => {
  withTempUserData((userDataPath) => {
    const privateDerSample = Uint8Array.from([0xde, 0xad, 0xbe, 0xef]);
    const store = createElectronHumanChannelKeyStore({
      safeStorage: reversibleSafeStorage({ available: false }),
      userDataPath,
      fileName: "secret-name.bin",
    });
    assert.throws(() => store.savePrivateKeyDer(privateDerSample), (error) => {
      assert.equal(error.code, ELECTRON_HUMAN_CHANNEL_KEY_ERROR_CODES.ENCRYPTION_UNAVAILABLE);
      assert.equal(error.name, "ElectronHumanChannelKeyError");
      assert.equal(error.message.includes(userDataPath), false);
      assert.equal(error.message.includes("deadbeef"), false);
      assert.equal(error.message.includes("secret-name.bin"), false);
      assert.equal("cause" in error, false);
      return true;
    });
  });
});
