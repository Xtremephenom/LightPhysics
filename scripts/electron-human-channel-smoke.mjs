#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveElectronExecutable } from "./electron-smoke.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "apps", "electron", "src", "human-channel-runtime-smoke.mjs");
const timeoutMs = 15_000;
const maxOutputBytes = 32 * 1024;

function boundedOutput(state, chunk) {
  if (state.bytes >= maxOutputBytes) return;
  const text = String(chunk);
  const remaining = maxOutputBytes - state.bytes;
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= remaining) {
    state.text += text;
    state.bytes += bytes;
    return;
  }
  state.text += Buffer.from(text).subarray(0, remaining).toString("utf8");
  state.bytes = maxOutputBytes;
}

function scrubEnvironment() {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name === "LP_TOKEN" || /(?:TOKEN|SECRET|PASSWORD|API_KEY)/i.test(name)) delete environment[name];
  }
  delete environment.LP_GUI_URL;
  return environment;
}

async function run() {
  const resolved = await resolveElectronExecutable();
  const output = { text: "", bytes: 0 };
  const child = spawn(resolved.executable, [entry], {
    cwd: root,
    env: scrubEnvironment(),
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout?.on("data", (chunk) => boundedOutput(output, chunk));
  child.stderr?.on("data", (chunk) => boundedOutput(output, chunk));

  const outcome = await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("error", onError);
      child.off("exit", onExit);
      callback();
    };
    const onError = (error) => finish(() => reject(error));
    const onExit = (code, signal) => finish(() => resolve({ code, signal }));
    const timer = setTimeout(() => finish(() => reject(new Error("Electron Human Channel smoke timed out"))), timeoutMs);
    child.once("error", onError);
    child.once("exit", onExit);
  });

  if (outcome.code !== 0) {
    throw new Error(`Electron Human Channel smoke exited with ${outcome.signal ?? `code ${outcome.code}`}:\n${output.text}`);
  }
  if (!output.text.includes("electron-human-channel: PASS")) {
    throw new Error(`Electron Human Channel smoke did not report PASS:\n${output.text}`);
  }
  console.log(`electron-human-channel-smoke: Electron ${resolved.version} used native safeStorage and persisted replay state`);
  console.log("electron-human-channel-smoke: PASS");
}

try {
  await run();
} catch (error) {
  console.error(`electron-human-channel-smoke: FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
