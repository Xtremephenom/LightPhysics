#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { ELECTRON_FOOTPRINT_DEFAULTS } from "../apps/electron/src/footprint.mjs";
import {
  classifyRendererObservation,
  validateLoopbackGuiUrl,
} from "../apps/electron/src/security.mjs";

export const ELECTRON_VERSION = "44.9.0";
export const ELECTRON_SMOKE_ERROR_CODES = Object.freeze({
  INVALID_ARGUMENT: "INVALID_ARGUMENT",
  ELECTRON_NOT_FOUND: "ELECTRON_NOT_FOUND",
  ELECTRON_VERSION_MISMATCH: "ELECTRON_VERSION_MISMATCH",
  DAEMON_START_FAILED: "DAEMON_START_FAILED",
  DAEMON_START_TIMEOUT: "DAEMON_START_TIMEOUT",
  ELECTRON_START_FAILED: "ELECTRON_START_FAILED",
  ELECTRON_START_TIMEOUT: "ELECTRON_START_TIMEOUT",
  RENDERER_CHECK_FAILED: "RENDERER_CHECK_FAILED",
  PROCESS_SHUTDOWN_TIMEOUT: "PROCESS_SHUTDOWN_TIMEOUT",
});

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const daemonEntry = path.join(root, "apps", "lpd", "src", "main.ts");
const electronEntry = path.join(root, "apps", "electron", "src", "main.mjs");
const smokeAuth = "phase0-electron-smoke-auth";
const defaultTimeoutMs = 15_000;
const defaultMaxOutputBytes = 64 * 1024;
const shutdownTimeoutMs = 3_000;
const smokeResultPrefix = "electron-shell: smoke-result ";
export const ELECTRON_FOOTPRINT_READY_PREFIX = "electron-shell: footprint-ready ";
export const ELECTRON_FOOTPRINT_RESULT_PREFIX = "electron-shell: footprint-result ";

export class ElectronSmokeError extends Error {
  constructor(code, message, suggestedNext, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ElectronSmokeError";
    this.code = code;
    this.suggestedNext = suggestedNext;
  }
}

function usage() {
  return `Usage: pnpm run test:electron [-- --timeout-ms N --max-output-bytes N]\n\n` +
    "Opt-in smoke: starts an authenticated loopback lpd, launches the pinned " +
    "Electron package, checks the rendered Studio Floor, and shuts both down.\n";
}

function parsePositiveInteger(value, label, maximum) {
  if (!/^\d+$/.test(value)) {
    throw new ElectronSmokeError(
      ELECTRON_SMOKE_ERROR_CODES.INVALID_ARGUMENT,
      `${label} must be a positive integer`,
      `Pass --${label.replaceAll("_", "-")} with a bounded integer value.`,
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new ElectronSmokeError(
      ELECTRON_SMOKE_ERROR_CODES.INVALID_ARGUMENT,
      `${label} must be between 1 and ${maximum}`,
      `Pass a ${label} value within the supported bound.`,
    );
  }
  return parsed;
}

export function parseCliArgs(argv = []) {
  const result = {
    help: false,
    timeoutMs: defaultTimeoutMs,
    maxOutputBytes: defaultMaxOutputBytes,
  };
  const argumentsList = [...argv];
  while (argumentsList[0] === "--") argumentsList.shift();
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--help" || argument === "-h") {
      result.help = true;
      continue;
    }
    const timeoutMatch = /^(?:--timeout-ms=|--timeout-ms$)/.exec(argument);
    if (timeoutMatch) {
      const value = argument.includes("=") ? argument.slice(argument.indexOf("=") + 1) : argumentsList[++index];
      if (!value) throw new ElectronSmokeError(ELECTRON_SMOKE_ERROR_CODES.INVALID_ARGUMENT, "--timeout-ms requires a value", "Pass --timeout-ms N.");
      result.timeoutMs = parsePositiveInteger(value, "timeout_ms", 120_000);
      continue;
    }
    const outputMatch = /^(?:--max-output-bytes=|--max-output-bytes$)/.exec(argument);
    if (outputMatch) {
      const value = argument.includes("=") ? argument.slice(argument.indexOf("=") + 1) : argumentsList[++index];
      if (!value) throw new ElectronSmokeError(ELECTRON_SMOKE_ERROR_CODES.INVALID_ARGUMENT, "--max-output-bytes requires a value", "Pass --max-output-bytes N.");
      result.maxOutputBytes = parsePositiveInteger(value, "max_output_bytes", 4 * 1024 * 1024);
      continue;
    }
    throw new ElectronSmokeError(
      ELECTRON_SMOKE_ERROR_CODES.INVALID_ARGUMENT,
      `Unknown electron smoke option: ${argument}`,
      "Use --help to see the bounded smoke options.",
    );
  }
  return result;
}

export function buildDaemonArgs(entry = daemonEntry) {
  return ["--experimental-strip-types", path.resolve(entry)];
}

export function buildElectronArgs(entry = electronEntry, guiUrl, options = {}) {
  const validated = validateLoopbackGuiUrl(guiUrl);
  const mode = options.mode ?? "smoke";
  if (mode !== "smoke" && mode !== "footprint") {
    throw new ElectronSmokeError(
      ELECTRON_SMOKE_ERROR_CODES.INVALID_ARGUMENT,
      `Unknown Electron launch mode: ${mode}`,
      "Use the smoke or footprint launch mode.",
    );
  }
  const args = [path.resolve(entry), mode === "footprint" ? "--footprint-url" : "--smoke-url", validated.toString()];
  if (mode === "footprint") {
    args.push(
      `--footprint-sample-count=${options.sampleCount ?? ELECTRON_FOOTPRINT_DEFAULTS.sampleCount}`,
      `--footprint-sample-interval-ms=${options.sampleIntervalMs ?? ELECTRON_FOOTPRINT_DEFAULTS.sampleIntervalMs}`,
    );
  }
  return args;
}

export function buildDaemonEnvironment(baseEnv = process.env) {
  return {
    ...baseEnv,
    LP_BIND: "127.0.0.1",
    LP_IN_CONTAINER: "0",
    LP_LOG_FORMAT: "json",
    LP_LOG_LEVEL: "error",
    LP_PORT: "0",
    LP_TOKEN: smokeAuth,
  };
}

export function buildElectronEnvironment(baseEnv = process.env) {
  const environment = { ...baseEnv };
  for (const name of Object.keys(environment)) {
    if (name === "LP_TOKEN" || /(?:TOKEN|SECRET|PASSWORD|API_KEY)/i.test(name)) delete environment[name];
  }
  delete environment.LP_GUI_URL;
  return environment;
}

export function parseListeningPort(output) {
  const match = /^lpd listening on (?:\[?127\.0\.0\.1\]?|\[?::1\]?):([0-9]+)\s*$/m.exec(output);
  if (!match) return null;
  const port = Number(match[1]);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : null;
}

export function parseSmokeResult(output) {
  return parseElectronResult(output, smokeResultPrefix);
}

export function parseElectronResult(output, prefix) {
  const lines = output.split(/\r?\n/).filter((line) => line.startsWith(prefix));
  if (lines.length === 0) return null;
  const payload = lines.at(-1).slice(prefix.length);
  try {
    const result = JSON.parse(payload);
    return result && typeof result === "object" ? result : null;
  } catch {
    return null;
  }
}

export function classifyElectronRendererResult(result, expectedUrl) {
  return classifyRendererObservation(result, expectedUrl);
}

function isExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function appendBounded(state, chunk, maxOutputBytes) {
  const text = String(chunk);
  if (state.bytes >= maxOutputBytes) {
    state.truncated = true;
    return;
  }
  const remaining = maxOutputBytes - state.bytes;
  const bytes = Buffer.byteLength(text);
  if (bytes <= remaining) {
    state.text += text;
    state.bytes += bytes;
    return;
  }
  state.text += Buffer.from(text).subarray(0, remaining).toString("utf8");
  state.bytes = maxOutputBytes;
  state.truncated = true;
}

function attachOutput(child, maxOutputBytes, onChunk) {
  const state = {
    stdout: { text: "", bytes: 0, truncated: false },
    stderr: { text: "", bytes: 0, truncated: false },
  };
  const attach = (stream, target, callback) => {
    if (!stream) return;
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      appendBounded(state[target], chunk, maxOutputBytes);
      callback?.(String(chunk));
    });
  };
  attach(child.stdout, "stdout", onChunk);
  attach(child.stderr, "stderr");
  return state;
}

function outputText(state) {
  return `${state.stdout.text}${state.stderr.text}`;
}

function closeProbe(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export async function stopChild(child) {
  if (!child || isExited(child)) return true;
  try {
    child.kill("SIGTERM");
  } catch {
    // The process may have exited between the state check and the signal.
  }
  if (await waitForExit(child, shutdownTimeoutMs)) return true;
  try {
    child.kill(process.platform === "win32" ? undefined : "SIGKILL");
  } catch {
    // The process may have exited while graceful shutdown was pending.
  }
  return waitForExit(child, shutdownTimeoutMs);
}

export function waitForExit(child, timeoutMs) {
  if (isExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const onError = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
    child.once("error", onError);
    if (isExited(child)) finish(true);
  });
}

async function reserveLoopbackPort() {
  const probe = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", resolve);
    });
    const address = probe.address();
    if (!address || typeof address !== "object" || address.port < 1) {
      throw new ElectronSmokeError(
        ELECTRON_SMOKE_ERROR_CODES.DAEMON_START_FAILED,
        "The operating system did not provide an ephemeral loopback port",
        "Retry the smoke on a host with TCP loopback available.",
      );
    }
    return address.port;
  } finally {
    if (probe.listening) await closeProbe(probe);
  }
}

export async function startDaemon({ timeoutMs, maxOutputBytes }) {
  const port = await reserveLoopbackPort();
  let child;
  try {
    child = spawn(process.execPath, buildDaemonArgs(), {
      cwd: root,
      env: { ...buildDaemonEnvironment(), LP_PORT: String(port) },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    throw new ElectronSmokeError(
      ELECTRON_SMOKE_ERROR_CODES.DAEMON_START_FAILED,
      `Could not spawn lpd: ${error instanceof Error ? error.message : String(error)}`,
      "Run the smoke from the repository with the pinned Node runtime installed.",
      error,
    );
  }

  let output;
  try {
    output = attachOutput(child, maxOutputBytes);
    const reportedPort = await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off("error", onError);
        child.off("exit", onExit);
        callback();
      };
      const onError = (error) => finish(() => reject(new ElectronSmokeError(
        ELECTRON_SMOKE_ERROR_CODES.DAEMON_START_FAILED,
        `lpd could not start: ${error.message}`,
        "Run corepack pnpm run gui-smoke to isolate the daemon prerequisite.",
        error,
      )));
      const onExit = (code, signal) => finish(() => reject(new ElectronSmokeError(
        ELECTRON_SMOKE_ERROR_CODES.DAEMON_START_FAILED,
        `lpd exited before readiness${signal ? ` via ${signal}` : ` with code ${code ?? "unknown"}`}`,
        "Check the authenticated lpd prerequisite and the Node runtime version.",
      )));
      const onReady = () => {
        const selectedPort = parseListeningPort(outputText(output));
        if (!selectedPort) return;
        finish(() => resolve(selectedPort));
      };
      child.stdout?.on("data", onReady);
      const timer = setTimeout(() => finish(() => reject(new ElectronSmokeError(
        ELECTRON_SMOKE_ERROR_CODES.DAEMON_START_TIMEOUT,
        `lpd did not report readiness within ${timeoutMs} ms`,
        "Run corepack pnpm run gui-smoke and verify that loopback TCP is available.",
      ))), timeoutMs);
      child.once("error", onError);
      child.once("exit", onExit);
      if (parseListeningPort(outputText(output))) onReady();
    });
    if (reportedPort !== port) {
      throw new ElectronSmokeError(
        ELECTRON_SMOKE_ERROR_CODES.DAEMON_START_FAILED,
        `lpd reported port ${reportedPort}, but the reserved port was ${port}`,
        "Retry the smoke; another local process may be racing for the ephemeral port.",
      );
    }
    return { child, port: reportedPort, output };
  } catch (error) {
    if (error && typeof error === "object") error.output = outputText(output);
    await stopChild(child);
    throw error;
  }
}

export async function resolveElectronExecutable(rootDir = root) {
  const requireFrom = createRequire(path.join(rootDir, "apps", "electron", "package.json"));
  let packageEntry;
  try {
    packageEntry = requireFrom.resolve("electron");
  } catch (error) {
    throw new ElectronSmokeError(
      ELECTRON_SMOKE_ERROR_CODES.ELECTRON_NOT_FOUND,
      "The pinned Electron package is unavailable; the opt-in smoke does not install or download it",
      "Run corepack pnpm install --frozen-lockfile, then retry pnpm run test:electron on a machine with display support.",
      error,
    );
  }

  const packageRoot = path.dirname(packageEntry);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  } catch (error) {
    throw new ElectronSmokeError(
      ELECTRON_SMOKE_ERROR_CODES.ELECTRON_NOT_FOUND,
      "The Electron package was resolved but its package manifest could not be read",
      "Reinstall with corepack pnpm install --frozen-lockfile; the smoke never downloads Electron.",
      error,
    );
  }
  if (manifest.version !== ELECTRON_VERSION) {
    throw new ElectronSmokeError(
      ELECTRON_SMOKE_ERROR_CODES.ELECTRON_VERSION_MISMATCH,
      `Electron package version ${String(manifest.version)} does not match the pinned ${ELECTRON_VERSION}`,
      "Remove the mismatched install and run corepack pnpm install --frozen-lockfile.",
    );
  }
  const executableName = process.platform === "win32" ? "electron.exe" : "electron";
  const executable = path.join(packageRoot, "dist", executableName);
  try {
    await access(executable);
  } catch (error) {
    throw new ElectronSmokeError(
      ELECTRON_SMOKE_ERROR_CODES.ELECTRON_NOT_FOUND,
      "The pinned Electron package is present but its executable is unavailable",
      "Run corepack pnpm install --frozen-lockfile; do not use the smoke to install Electron.",
      error,
    );
  }
  return { executable, version: manifest.version };
}

export async function launchElectron({
  guiUrl,
  timeoutMs,
  maxOutputBytes,
  executable,
  mode = "smoke",
  sampleCount,
  sampleIntervalMs,
}) {
  let child;
  const startedAt = performance.now();
  try {
    child = spawn(executable, buildElectronArgs(electronEntry, guiUrl, {
      mode,
      sampleCount,
      sampleIntervalMs,
    }), {
      cwd: root,
      env: buildElectronEnvironment(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    throw new ElectronSmokeError(
      ELECTRON_SMOKE_ERROR_CODES.ELECTRON_START_FAILED,
      `Could not spawn Electron: ${error instanceof Error ? error.message : String(error)}`,
      "Verify the installed Electron package and display support on this machine.",
      error,
    );
  }

  const output = attachOutput(child, maxOutputBytes);
  const resultPrefix = mode === "footprint" ? ELECTRON_FOOTPRINT_RESULT_PREFIX : smokeResultPrefix;
  const readyPrefix = mode === "footprint" ? ELECTRON_FOOTPRINT_READY_PREFIX : null;
  let readyResult = null;
  let readyAt = null;
  try {
    const result = await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off("error", onError);
        child.off("exit", onExit);
        callback();
      };
      const onData = () => {
        const currentOutput = outputText(output);
        if (!readyResult && readyPrefix) {
          const parsedReady = parseElectronResult(currentOutput, readyPrefix);
          if (parsedReady) {
            readyResult = parsedReady;
            readyAt = performance.now();
          }
        }
        const parsed = parseElectronResult(currentOutput, resultPrefix);
        if (parsed) finish(() => resolve(parsed));
      };
      const onError = (error) => finish(() => reject(new ElectronSmokeError(
        ELECTRON_SMOKE_ERROR_CODES.ELECTRON_START_FAILED,
        `Electron could not start: ${error.message}`,
        "Verify the pinned executable and that a display session is available.",
        error,
      )));
      const onExit = (code, signal) => finish(() => reject(new ElectronSmokeError(
        ELECTRON_SMOKE_ERROR_CODES.ELECTRON_START_FAILED,
        `Electron exited before the Studio Floor ${mode} result${signal ? ` via ${signal}` : ` with code ${code ?? "unknown"}`}`,
        "Run the opt-in smoke on a machine with the Electron package and display support.",
      )));
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      const timer = setTimeout(() => finish(() => reject(new ElectronSmokeError(
        ELECTRON_SMOKE_ERROR_CODES.ELECTRON_START_TIMEOUT,
        `Electron did not report a rendered Studio Floor within ${timeoutMs} ms`,
        "Check display support and retry with a bounded --timeout-ms value.",
      ))), timeoutMs);
      child.once("error", onError);
      child.once("exit", onExit);
      onData();
    });
    return {
      child,
      output,
      result,
      readyResult,
      coldStartMs: readyAt === null ? null : Math.round((readyAt - startedAt) * 1_000) / 1_000,
    };
  } catch (error) {
    if (error && typeof error === "object") error.output = outputText(output);
    await stopChild(child);
    throw error;
  }
}

function redactOutput(text) {
  return text
    .replaceAll(smokeAuth, "[redacted]")
    .replaceAll(root, "<workspace>")
    .slice(0, 2_000);
}

export async function runElectronSmoke(options = {}) {
  const config = options.config ?? parseCliArgs(options.argv ?? []);
  if (config.help) return { help: usage() };

  const resolved = await resolveElectronExecutable(options.rootDir ?? root);
  const daemon = await startDaemon({ timeoutMs: config.timeoutMs, maxOutputBytes: config.maxOutputBytes });
  let electron;
  try {
    const guiUrl = validateLoopbackGuiUrl(`http://127.0.0.1:${daemon.port}/`);
    electron = await launchElectron({
      guiUrl,
      timeoutMs: config.timeoutMs,
      maxOutputBytes: config.maxOutputBytes,
      executable: resolved.executable,
    });
    const classification = classifyElectronRendererResult(electron.result, guiUrl);
    if (!classification.ok) {
      throw new ElectronSmokeError(
        ELECTRON_SMOKE_ERROR_CODES.RENDERER_CHECK_FAILED,
        `Rendered Studio Floor checks failed: ${classification.failures.join("; ")}`,
        "Inspect the existing lpd-served GUI markers and strict local CSP before rerunning the smoke.",
      );
    }
    const exited = await waitForExit(electron.child, shutdownTimeoutMs);
    if (!exited) {
      throw new ElectronSmokeError(
        ELECTRON_SMOKE_ERROR_CODES.PROCESS_SHUTDOWN_TIMEOUT,
        "Electron reported the smoke result but did not quit within the shutdown bound",
        "Check the Electron main-process smoke quit path on the current display platform.",
      );
    }
    if (electron.child.exitCode !== 0) {
      throw new ElectronSmokeError(
        ELECTRON_SMOKE_ERROR_CODES.ELECTRON_START_FAILED,
        `Electron smoke process exited with code ${electron.child.exitCode ?? "unknown"}`,
        "Inspect Electron stderr and rerun on a supported display session.",
      );
    }
    return { port: daemon.port, electronVersion: resolved.version, result: electron.result };
  } finally {
    if (electron?.child) await stopChild(electron.child);
    await stopChild(daemon.child);
  }
}

function isMainModule() {
  const entry = process.argv[1];
  return entry !== undefined && path.resolve(entry) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  let config;
  try {
    config = parseCliArgs(process.argv.slice(2));
    if (config.help) {
      console.log(usage());
    } else {
      console.log("electron-smoke: opt-in Electron Studio Floor smoke");
      const outcome = await runElectronSmoke({ config });
      console.log(`electron-smoke: Electron ${outcome.electronVersion} rendered the loopback Studio Floor`);
      console.log("electron-smoke: title, Studio Floor/status-bar markers, same-origin URL, and strict local CSP: PASS");
      console.log("electron-smoke: lpd and Electron exited cleanly");
      console.log("electron-smoke: PASS");
    }
  } catch (error) {
    const typed = error instanceof ElectronSmokeError ? error : new ElectronSmokeError(
      ELECTRON_SMOKE_ERROR_CODES.ELECTRON_START_FAILED,
      error instanceof Error ? error.message : String(error),
      "Inspect the typed prerequisite error and retry the opt-in smoke.",
      error,
    );
    const output = error && typeof error === "object" && "output" in error ? String(error.output) : "";
    console.error(`electron-smoke: FAIL [${typed.code}] ${typed.message}`);
    console.error(`electron-smoke: next step: ${typed.suggestedNext}`);
    if (output) console.error(`electron-smoke: bounded child output:\n${redactOutput(output)}`);
    process.exitCode = 1;
  }
}
