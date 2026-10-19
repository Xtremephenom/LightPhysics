import { app, dialog, safeStorage } from "electron";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElectronHumanChannelMainBootstrap } from "./human-channel-listener.mjs";

const INPUT = Object.freeze({
  subject_hash: "c".repeat(64),
  decision: "approve",
  reason: "verified Electron Human Channel runtime",
});

function cleanup(userDataPath) {
  if (userDataPath !== undefined) rmSync(userDataPath, { recursive: true, force: true });
}

app.whenReady().then(() => {
  let userDataPath;
  try {
    userDataPath = mkdtempSync(path.join(os.tmpdir(), "lightphysics-electron-human-channel-"));
    const confirmationDialog = {
      showMessageBoxSync: () => 1,
    };
    const createBootstrap = () => createElectronHumanChannelMainBootstrap({
      safeStorage,
      userDataPath,
      dialog: confirmationDialog,
    });

    if (safeStorage.isEncryptionAvailable() !== true) {
      throw new Error("Electron safeStorage is unavailable on this runtime");
    }
    const first = createBootstrap();
    if (first.qualified !== true || first.qualification !== "electron-js-adapter") {
      throw new Error("Electron Human Channel adapter was not qualified");
    }
    first.listener.enroll();
    const receipt = first.listener.recordDecision({ source: "main", input: INPUT });
    if (receipt.verified !== true || "signature" in receipt) {
      throw new Error("Electron Human Channel receipt was not bounded");
    }

    const restored = createBootstrap();
    if (restored.status.enrolled !== true || restored.status.replayedNonceCount !== 1) {
      throw new Error("Electron Human Channel replay state was not restored");
    }
    console.log("electron-human-channel: qualified=true safeStorage=true replay_persisted=true");
    console.log("electron-human-channel: PASS");
    cleanup(userDataPath);
    app.exit(0);
  } catch (error) {
    console.error(`electron-human-channel: FAIL ${error?.code ?? "RUNTIME_ERROR"} ${error instanceof Error ? error.message : String(error)}`);
    cleanup(userDataPath);
    app.exit(1);
  }
});
