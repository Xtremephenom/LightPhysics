#!/usr/bin/env node

import { existsSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const FIXTURE_DIR = path.join(ROOT, "fixtures", "mini-game");
export const GODOT_SMOKE_MARKER = "LIGHTPHYSICS_GODOT_SMOKE_PASS";
export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

export const GODOT_SMOKE_ERROR_CODES = Object.freeze({
  ARGUMENT_INVALID: "ARGUMENT_INVALID",
  FIXTURE_INVALID: "FIXTURE_INVALID",
  GODOT_NOT_FOUND: "GODOT_NOT_FOUND",
  GODOT_START_FAILED: "GODOT_START_FAILED",
  GODOT_SMOKE_FAILED: "GODOT_SMOKE_FAILED",
});

const MODE_ALIASES = Object.freeze({
  boot: "boot",
  import: "import",
  "check-good": "check-valid",
  "check-invalid": "check-invalid",
  "check-only-bad": "check-invalid",
  "check-only-good": "check-valid",
  "check-valid": "check-valid",
  "check-bad": "check-invalid",
  "check-only-valid": "check-valid",
});

const MODE_SCRIPTS = Object.freeze({
  boot: "smoke-entry.gd",
  "check-valid": "check-valid.gd",
  "check-invalid": "check-invalid.gd",
});

const REQUIRED_FIXTURE_FILES = Object.freeze([
  "project.godot",
  MODE_SCRIPTS.boot,
  MODE_SCRIPTS["check-valid"],
  MODE_SCRIPTS["check-invalid"],
]);

export class GodotSmokeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "GodotSmokeError";
    this.code = code;
    this.details = details;
  }
}

function invalidArgument(message, details = {}) {
  return new GodotSmokeError(GODOT_SMOKE_ERROR_CODES.ARGUMENT_INVALID, message, details);
}

function normalizeMode(mode) {
  const normalized = typeof mode === "string" ? MODE_ALIASES[mode.trim()] : undefined;
  if (!normalized) throw invalidArgument(`unknown Godot smoke mode ${JSON.stringify(mode)}`);
  return normalized;
}

function normalizePositiveInteger(value, label, fallback) {
  const candidate = value ?? fallback;
  if (!Number.isInteger(candidate) || candidate < 1) {
    throw invalidArgument(`${label} must be a positive integer`, { label, value: candidate });
  }
  return candidate;
}

export function getProjectLocalGodotPaths({ rootDir = ROOT, platform = process.platform } = {}) {
  const executableNames = platform === "win32" ? ["godot.exe", "godot"] : ["godot", "godot.exe"];
  return executableNames.map((name) => path.resolve(rootDir, "tools", "godot", name));
}

export function resolveGodotPath({ godotPath, env = process.env, rootDir = ROOT, platform = process.platform } = {}) {
  const explicit = typeof godotPath === "string" ? godotPath.trim() : "";
  if (explicit) return explicit;

  const configured = typeof env?.LP_GODOT === "string" ? env.LP_GODOT.trim() : "";
  if (configured) return configured;

  const localCandidates = getProjectLocalGodotPaths({ rootDir, platform });
  for (const candidate of localCandidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // The next documented project-local candidate may exist.
    }
  }

  throw new GodotSmokeError(
    GODOT_SMOKE_ERROR_CODES.GODOT_NOT_FOUND,
    "Godot was not found. Pass --godot PATH, set LP_GODOT, or place the executable at tools/godot/godot (or godot.exe); this runner never downloads or installs Godot.",
    { localCandidates },
  );
}

export function buildGodotArgs(modeOrOptions = "boot", maybeFixtureDir = FIXTURE_DIR) {
  const options = typeof modeOrOptions === "string"
    ? { mode: modeOrOptions, fixtureDir: maybeFixtureDir }
    : (modeOrOptions ?? {});
  const mode = normalizeMode(options.mode);
  const fixtureDir = path.resolve(options.fixtureDir ?? FIXTURE_DIR);
  const args = ["--headless", "--path", fixtureDir];
  if (mode === "import") return [...args, "--import", "--quit"];
  if (mode !== "boot") args.push("--check-only");
  args.push("--script", `res://${MODE_SCRIPTS[mode]}`);
  return args;
}

export function hasSuccessMarker(stdout) {
  return String(stdout ?? "").split(/\r?\n/).some((line) => line.trim() === GODOT_SMOKE_MARKER);
}

function resultCode(result) {
  if (Number.isInteger(result?.code)) return result.code;
  if (Number.isInteger(result?.exitCode)) return result.exitCode;
  return null;
}

function failedClassification(mode, classification, message, expectedExit) {
  return {
    mode,
    ok: false,
    classification,
    expectedExit,
    message,
  };
}

function passedClassification(mode, classification, message, expectedExit) {
  return {
    mode,
    ok: true,
    classification,
    expectedExit,
    message,
  };
}

export function classifyGodotResult(modeOrResult, maybeResult) {
  const result = typeof modeOrResult === "string"
    ? { ...(maybeResult ?? {}), mode: modeOrResult }
    : (modeOrResult ?? {});
  const mode = normalizeMode(result.mode ?? result.phase);
  const code = resultCode(result);
  const signal = result.signal ?? null;

  if (result.timedOut === true) {
    return failedClassification(mode, "timeout", `${mode} timed out before completing`, mode === "check-invalid" ? "nonzero" : "zero");
  }
  if (signal) {
    return failedClassification(mode, "terminated", `${mode} was terminated by ${signal}`, mode === "check-invalid" ? "nonzero" : "zero");
  }
  if (code === null) {
    return failedClassification(mode, "missing-exit-code", `${mode} did not report an exit code`, mode === "check-invalid" ? "nonzero" : "zero");
  }

  if (mode === "boot") {
    if (code === 0 && hasSuccessMarker(result.stdout)) {
      return passedClassification(mode, "boot-marker", "headless boot exited 0 and emitted the success marker", "zero");
    }
    if (code !== 0) return failedClassification(mode, "nonzero-exit", `headless boot exited with code ${code}`, "zero");
    return failedClassification(mode, "marker-missing", `headless boot exited 0 but did not emit ${GODOT_SMOKE_MARKER}`, "zero");
  }

  if (mode === "import") {
    return code === 0
      ? passedClassification(mode, "import-success", "headless import exited 0", "zero")
      : failedClassification(mode, "unexpected-nonzero", `headless import exited with code ${code}`, "zero");
  }

  if (mode === "check-valid") {
    return code === 0
      ? passedClassification(mode, "check-only-success", "valid script --check-only exited 0", "zero")
      : failedClassification(mode, "unexpected-nonzero", `valid script --check-only exited with code ${code}`, "zero");
  }

  return code !== 0
    ? passedClassification(mode, "check-only-failure", `invalid script --check-only exited nonzero (${code})`, "nonzero")
    : failedClassification(mode, "unexpected-success", "invalid script --check-only exited 0; the negative fixture is no longer invalid", "nonzero");
}

async function readFixtureFiles(fixtureDir) {
  const contents = new Map();
  for (const fileName of REQUIRED_FIXTURE_FILES) {
    try {
      const filePath = path.join(fixtureDir, fileName);
      const fileStats = await stat(filePath);
      if (!fileStats.isFile() || fileStats.size === 0) {
        throw new Error("not a non-empty file");
      }
      contents.set(fileName, await readFile(filePath, "utf8"));
    } catch (error) {
      throw new GodotSmokeError(
        GODOT_SMOKE_ERROR_CODES.FIXTURE_INVALID,
        `Godot fixture is invalid: ${fileName} is missing, unreadable, or empty under ${fixtureDir}. Restore the checked-in fixture files before running the smoke test.`,
        { fixtureDir, fileName, cause: error },
      );
    }
  }
  return contents;
}

export async function validateFixture(fixtureDir = FIXTURE_DIR) {
  const resolvedFixtureDir = path.resolve(fixtureDir);
  try {
    const directoryStats = await stat(resolvedFixtureDir);
    if (!directoryStats.isDirectory()) throw new Error("fixture path is not a directory");
  } catch (error) {
    throw new GodotSmokeError(
      GODOT_SMOKE_ERROR_CODES.FIXTURE_INVALID,
      `Godot fixture directory is invalid: ${resolvedFixtureDir} does not exist as a directory. Restore fixtures/mini-game before running the smoke test.`,
      { fixtureDir: resolvedFixtureDir, cause: error },
    );
  }

  const contents = await readFixtureFiles(resolvedFixtureDir);
  const project = contents.get("project.godot") ?? "";
  const boot = contents.get(MODE_SCRIPTS.boot) ?? "";
  const valid = contents.get(MODE_SCRIPTS["check-valid"]) ?? "";
  const invalid = contents.get(MODE_SCRIPTS["check-invalid"]) ?? "";
  const problems = [];

  if (!/^config_version\s*=\s*5\s*$/m.test(project) || !project.includes("[application]")) {
    problems.push("project.godot is not a Godot 4 project configuration");
  }
  if (!boot.includes(GODOT_SMOKE_MARKER) || !/\bquit\s*\(/.test(boot)) {
    problems.push(`smoke-entry.gd must print ${GODOT_SMOKE_MARKER} and quit`);
  }
  if (!/^extends\s+Node\s*$/m.test(valid)) problems.push("check-valid.gd must extend Node");
  if (!invalid.includes("INTENTIONALLY_INVALID_GDSCRIPT_FIXTURE")) {
    problems.push("check-invalid.gd must retain its intentional-invalid marker");
  }
  if (problems.length > 0) {
    throw new GodotSmokeError(
      GODOT_SMOKE_ERROR_CODES.FIXTURE_INVALID,
      `Godot fixture is invalid: ${problems.join("; ")}. Restore the checked-in files under fixtures/mini-game.`,
      { fixtureDir: resolvedFixtureDir, problems },
    );
  }

  return { directory: resolvedFixtureDir, files: [...REQUIRED_FIXTURE_FILES] };
}

function boundedCapture(maxBytes) {
  let byteLength = 0;
  let value = "";
  let truncated = false;
  return {
    append(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (buffer.length === 0) return;
      const remaining = maxBytes - byteLength;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      const accepted = buffer.subarray(0, remaining);
      value += accepted.toString("utf8");
      byteLength += accepted.length;
      if (accepted.length < buffer.length) truncated = true;
    },
    read() {
      return { value, truncated };
    },
  };
}

function startError(executable, error) {
  const missing = error?.code === "ENOENT";
  const code = missing ? GODOT_SMOKE_ERROR_CODES.GODOT_NOT_FOUND : GODOT_SMOKE_ERROR_CODES.GODOT_START_FAILED;
  const message = missing
    ? `Godot executable ${JSON.stringify(executable)} could not be started because it was not found. Pass --godot PATH or set LP_GODOT to an installed executable.`
    : `Godot executable ${JSON.stringify(executable)} could not be started: ${error instanceof Error ? error.message : String(error)}`;
  return new GodotSmokeError(code, message, { executable, cause: error });
}

export function runGodotCommand(executable, args, {
  cwd = ROOT,
  env = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
} = {}) {
  if (typeof executable !== "string" || executable.trim() === "") {
    throw invalidArgument("Godot executable must be a non-empty path or command name");
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw invalidArgument("Godot arguments must be an array of strings");
  }
  const boundedTimeoutMs = normalizePositiveInteger(timeoutMs, "timeoutMs", DEFAULT_TIMEOUT_MS);
  const boundedOutputBytes = normalizePositiveInteger(maxOutputBytes, "maxOutputBytes", DEFAULT_MAX_OUTPUT_BYTES);

  return new Promise((resolve, reject) => {
    const stdout = boundedCapture(boundedOutputBytes);
    const stderr = boundedCapture(boundedOutputBytes);
    let child;
    try {
      child = spawn(executable, args, {
        cwd,
        env: { ...env },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      reject(startError(executable, error));
      return;
    }

    const startedAt = Date.now();
    let timedOut = false;
    let settled = false;
    let timeoutHandle;
    let forceKillHandle;

    const clearTimers = () => {
      clearTimeout(timeoutHandle);
      clearTimeout(forceKillHandle);
    };
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimers();
      const stdoutResult = stdout.read();
      const stderrResult = stderr.read();
      resolve({
        args: [...args],
        code: Number.isInteger(code) ? code : null,
        durationMs: Date.now() - startedAt,
        outputTruncated: stdoutResult.truncated || stderrResult.truncated,
        signal: signal ?? null,
        stderr: stderrResult.value,
        stderrTruncated: stderrResult.truncated,
        stdout: stdoutResult.value,
        stdoutTruncated: stdoutResult.truncated,
        timedOut,
      });
    };
    const failToStart = (error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      reject(startError(executable, error));
    };

    child.stdout?.on("data", (chunk) => stdout.append(chunk));
    child.stderr?.on("data", (chunk) => stderr.append(chunk));
    child.once("error", failToStart);
    child.once("close", finish);
    timeoutHandle = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      try {
        if (process.platform === "win32") child.kill();
        else child.kill("SIGTERM");
      } catch {
        // The process may have exited between the timeout and the signal.
      }
      forceKillHandle = setTimeout(() => {
        if (settled) return;
        try {
          if (process.platform === "win32") child.kill();
          else child.kill("SIGKILL");
        } catch {
          // The process may have exited while the forceful shutdown was pending.
        }
      }, Math.min(1_000, Math.max(100, Math.floor(boundedTimeoutMs / 4))));
    }, boundedTimeoutMs);
  });
}

function outputSnippet(label, output) {
  const text = String(output ?? "").trim();
  if (!text) return "";
  const limit = 2_000;
  return `${label}: ${text.length > limit ? `${text.slice(0, limit)}…` : text}`;
}

export async function runGodotSmoke({
  godotPath,
  env = process.env,
  fixtureDir = FIXTURE_DIR,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
} = {}) {
  const fixture = await validateFixture(fixtureDir);
  const executable = resolveGodotPath({ godotPath, env, rootDir: ROOT });
  const results = [];

  for (const mode of ["boot", "check-valid", "check-invalid"]) {
    const args = buildGodotArgs({ mode, fixtureDir: fixture.directory });
    const processResult = await runGodotCommand(executable, args, {
      cwd: ROOT,
      env,
      maxOutputBytes,
      timeoutMs,
    });
    const classification = classifyGodotResult({ ...processResult, mode });
    const result = { ...processResult, ...classification, args };
    results.push(result);
    if (!classification.ok) {
      const failureCode = mode === "check-invalid" || classification.classification === "marker-missing"
        ? GODOT_SMOKE_ERROR_CODES.FIXTURE_INVALID
        : GODOT_SMOKE_ERROR_CODES.GODOT_SMOKE_FAILED;
      const details = [outputSnippet("stdout", processResult.stdout), outputSnippet("stderr", processResult.stderr)]
        .filter(Boolean)
        .join("; ");
      throw new GodotSmokeError(
        failureCode,
        `${mode} failed: ${classification.message}${details ? ` (${details})` : ""}`,
        { fixtureDir: fixture.directory, executable, mode, result },
      );
    }
  }

  return {
    executable,
    fixtureDir: fixture.directory,
    marker: GODOT_SMOKE_MARKER,
    results,
  };
}

export async function runGodotImportSmoke({
  godotPath,
  env = process.env,
  fixtureDir = FIXTURE_DIR,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
} = {}) {
  const fixture = await validateFixture(fixtureDir);
  const executable = resolveGodotPath({ godotPath, env, rootDir: ROOT });
  const mode = "import";
  const args = buildGodotArgs({ mode, fixtureDir: fixture.directory });
  const processResult = await runGodotCommand(executable, args, {
    cwd: ROOT,
    env,
    maxOutputBytes,
    timeoutMs,
  });
  const classification = classifyGodotResult({ ...processResult, mode });
  if (!classification.ok) {
    const details = [outputSnippet("stdout", processResult.stdout), outputSnippet("stderr", processResult.stderr)]
      .filter(Boolean)
      .join("; ");
    throw new GodotSmokeError(
      GODOT_SMOKE_ERROR_CODES.GODOT_SMOKE_FAILED,
      `import failed: ${classification.message}${details ? ` (${details})` : ""}`,
      { fixtureDir: fixture.directory, executable, mode, result: { ...processResult, ...classification, args } },
    );
  }
  return {
    executable,
    fixtureDir: fixture.directory,
    marker: null,
    result: { ...processResult, ...classification, args },
  };
}

function parseOptionValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw invalidArgument(`${option} requires a value`);
  return value;
}

export function parseCliArgs(argv = []) {
  if (!Array.isArray(argv)) throw invalidArgument("CLI arguments must be an array");
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--import") {
      options.import = true;
      continue;
    }
    if (argument === "--godot") {
      options.godotPath = parseOptionValue(argv, index, "--godot");
      index += 1;
      continue;
    }
    if (argument.startsWith("--godot=")) {
      options.godotPath = argument.slice("--godot=".length).trim();
      if (!options.godotPath) throw invalidArgument("--godot requires a value");
      continue;
    }
    if (argument === "--timeout-ms" || argument === "--max-output-bytes") {
      const value = parseOptionValue(argv, index, argument);
      const numericValue = Number(value);
      if (!Number.isInteger(numericValue) || numericValue < 1) throw invalidArgument(`${argument} must be a positive integer`);
      options[argument === "--timeout-ms" ? "timeoutMs" : "maxOutputBytes"] = numericValue;
      index += 1;
      continue;
    }
    if (argument.startsWith("--timeout-ms=") || argument.startsWith("--max-output-bytes=")) {
      const separator = argument.indexOf("=");
      const option = argument.slice(0, separator);
      const numericValue = Number(argument.slice(separator + 1));
      if (!Number.isInteger(numericValue) || numericValue < 1) throw invalidArgument(`${option} must be a positive integer`);
      options[option === "--timeout-ms" ? "timeoutMs" : "maxOutputBytes"] = numericValue;
      continue;
    }
    throw invalidArgument(`unknown option ${JSON.stringify(argument)}; use --help for usage`);
  }
  return options;
}

export const CLI_USAGE = `Usage: node scripts/godot-smoke.mjs [options]

Options:
  --godot PATH              Godot executable path or command name
  --import                  run headless project import and quit instead of the fixture boot/check suite
  --timeout-ms N            Per-command timeout (default: ${DEFAULT_TIMEOUT_MS})
  --max-output-bytes N      Per-stream output cap (default: ${DEFAULT_MAX_OUTPUT_BYTES})
  --help                    Show this help

Godot resolution order: --godot PATH, LP_GODOT, tools/godot/godot (or godot.exe).
No network access or tool installation is performed.`;

export async function main(argv = process.argv.slice(2), env = process.env) {
  try {
    const options = parseCliArgs(argv);
    if (options.help) {
      console.log(CLI_USAGE);
      return 0;
    }
    if (options.import) {
      const report = await runGodotImportSmoke({ ...options, env });
      console.log(`godot-smoke: ${report.result.mode}: PASS — ${report.result.message}`);
      return 0;
    }
    const report = await runGodotSmoke({ ...options, env });
    for (const result of report.results) console.log(`godot-smoke: ${result.mode}: PASS — ${result.message}`);
    console.log("godot-smoke: PASS — headless boot/quit and valid/invalid --check-only cases");
    return 0;
  } catch (error) {
    if (error instanceof GodotSmokeError) {
      console.error(`godot-smoke: ${error.code}: ${error.message}`);
    } else {
      console.error(`godot-smoke: UNEXPECTED_ERROR: ${error instanceof Error ? error.message : String(error)}`);
    }
    return 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const modulePath = path.resolve(fileURLToPath(import.meta.url));
if (invokedPath === modulePath) process.exitCode = await main();
