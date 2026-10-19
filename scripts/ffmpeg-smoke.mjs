#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const FFMPEG_VERSION = "9.0.2";
export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
export const MAX_TIMEOUT_MS = 120_000;
export const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export const FFMPEG_SMOKE_ERROR_CODES = Object.freeze({
  INVALID_ARGUMENT: "INVALID_ARGUMENT",
  FFMPEG_NOT_FOUND: "FFMPEG_NOT_FOUND",
  FFMPEG_START_FAILED: "FFMPEG_START_FAILED",
  FFMPEG_VERSION_CHECK_FAILED: "FFMPEG_VERSION_CHECK_FAILED",
  FFMPEG_VERSION_MISMATCH: "FFMPEG_VERSION_MISMATCH",
  FFMPEG_SMOKE_FAILED: "FFMPEG_SMOKE_FAILED",
});

export class FfmpegSmokeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "FfmpegSmokeError";
    this.code = code;
    this.details = details;
  }
}

function invalidArgument(message, details = {}) {
  return new FfmpegSmokeError(FFMPEG_SMOKE_ERROR_CODES.INVALID_ARGUMENT, message, details);
}

function normalizeBoundedInteger(value, label, fallback, maximum) {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > maximum) {
    throw invalidArgument(`${label} must be between 1 and ${maximum}`, { label, value: candidate, maximum });
  }
  return candidate;
}

function resultCode(result) {
  if (Number.isInteger(result?.code)) return result.code;
  if (Number.isInteger(result?.exitCode)) return result.exitCode;
  return null;
}

function resultOutput(result) {
  if (typeof result === "string") return result;
  return `${String(result?.stdout ?? "")}\n${String(result?.stderr ?? "")}`;
}

export function buildVersionArgs() {
  return ["-hide_banner", "-version"];
}

export function buildSmokeArgs() {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-f",
    "lavfi",
    "-i",
    "color=c=black:s=2x2:r=1:d=0.1",
    "-frames:v",
    "1",
    "-f",
    "null",
    "-",
  ];
}

export const buildFfmpegArgs = buildSmokeArgs;

export function parseFfmpegVersion(output) {
  const match = /(?:^|\r?\n)ffmpeg version\s+n?(\d+\.\d+\.\d+)\b/im.exec(String(output ?? ""));
  return match?.[1] ?? null;
}

export function classifyFfmpegVersion(resultOrOutput) {
  const result = typeof resultOrOutput === "string" ? { code: 0, stdout: resultOrOutput } : (resultOrOutput ?? {});
  const expectedExit = "zero";
  if (result.timedOut === true) {
    return {
      ok: false,
      classification: "timeout",
      expectedExit,
      version: null,
      message: `FFmpeg version check timed out after ${result.timeoutMs ?? "the configured"} ms`,
    };
  }
  if (result.signal) {
    return {
      ok: false,
      classification: "terminated",
      expectedExit,
      version: null,
      message: `FFmpeg version check was terminated by ${result.signal}`,
    };
  }
  const code = resultCode(result);
  if (code === null) {
    return {
      ok: false,
      classification: "missing-exit-code",
      expectedExit,
      version: null,
      message: "FFmpeg version check did not report an exit code",
    };
  }
  if (code !== 0) {
    return {
      ok: false,
      classification: "nonzero-exit",
      expectedExit,
      version: parseFfmpegVersion(resultOutput(result)),
      message: `FFmpeg version check exited with code ${code}`,
    };
  }
  const version = parseFfmpegVersion(resultOutput(result));
  if (version !== FFMPEG_VERSION) {
    return {
      ok: false,
      classification: "version-mismatch",
      expectedExit,
      version,
      message: version === null
        ? `FFmpeg version output did not contain ${FFMPEG_VERSION}`
        : `FFmpeg reported ${version}; expected ${FFMPEG_VERSION}`,
    };
  }
  return {
    ok: true,
    classification: "version-match",
    expectedExit,
    version,
    message: `FFmpeg reported version ${FFMPEG_VERSION}`,
  };
}

export function classifyFfmpegResult(result = {}) {
  const expectedExit = "zero";
  if (result.timedOut === true) {
    return {
      ok: false,
      classification: "timeout",
      expectedExit,
      message: "FFmpeg lavfi processing timed out",
    };
  }
  if (result.signal) {
    return {
      ok: false,
      classification: "terminated",
      expectedExit,
      message: `FFmpeg lavfi processing was terminated by ${result.signal}`,
    };
  }
  const code = resultCode(result);
  if (code === null) {
    return {
      ok: false,
      classification: "missing-exit-code",
      expectedExit,
      message: "FFmpeg lavfi processing did not report an exit code",
    };
  }
  if (code !== 0) {
    return {
      ok: false,
      classification: "nonzero-exit",
      expectedExit,
      message: `FFmpeg lavfi processing exited with code ${code}`,
    };
  }
  return {
    ok: true,
    classification: "processing-success",
    expectedExit,
    message: "FFmpeg processed the deterministic lavfi color frame into the null muxer",
  };
}

function boundedCapture(maxBytes) {
  let bytes = 0;
  let value = "";
  let truncated = false;
  return {
    append(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (buffer.length === 0) return;
      const remaining = maxBytes - bytes;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      const accepted = buffer.subarray(0, remaining);
      value += accepted.toString("utf8");
      bytes += accepted.length;
      if (accepted.length < buffer.length) truncated = true;
    },
    read() {
      return { value, truncated };
    },
  };
}

function startError(executable, error) {
  const missing = error?.code === "ENOENT";
  return new FfmpegSmokeError(
    missing ? FFMPEG_SMOKE_ERROR_CODES.FFMPEG_NOT_FOUND : FFMPEG_SMOKE_ERROR_CODES.FFMPEG_START_FAILED,
    missing
      ? `FFmpeg executable ${JSON.stringify(executable)} was not found; pass --ffmpeg PATH to an installed FFmpeg 9.0.2 executable`
      : `FFmpeg executable ${JSON.stringify(executable)} could not be started: ${error instanceof Error ? error.message : String(error)}`,
    { executable, cause: error },
  );
}

export function runFfmpegCommand(executable, args, {
  cwd = ROOT,
  env = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
} = {}) {
  if (typeof executable !== "string" || executable.trim() === "") {
    throw invalidArgument("FFmpeg executable must be a non-empty path or command name");
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw invalidArgument("FFmpeg arguments must be an array of strings");
  }
  const boundedTimeoutMs = normalizeBoundedInteger(timeoutMs, "timeoutMs", DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const boundedOutputBytes = normalizeBoundedInteger(maxOutputBytes, "maxOutputBytes", DEFAULT_MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES);

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

    let settled = false;
    let timedOut = false;
    let timeoutHandle;
    let forceKillHandle;
    const startedAt = Date.now();
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
        timeoutMs: boundedTimeoutMs,
        maxOutputBytes: boundedOutputBytes,
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
        child.kill(process.platform === "win32" ? undefined : "SIGTERM");
      } catch {
        // The process may have exited between the timeout and the signal.
      }
      forceKillHandle = setTimeout(() => {
        if (settled) return;
        try {
          child.kill(process.platform === "win32" ? undefined : "SIGKILL");
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

function failureDetails(result) {
  return [outputSnippet("stdout", result.stdout), outputSnippet("stderr", result.stderr)].filter(Boolean).join("; ");
}

export async function runFfmpegSmoke({
  ffmpegPath,
  env = process.env,
  cwd = ROOT,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
} = {}) {
  if (typeof ffmpegPath !== "string" || ffmpegPath.trim() === "") {
    throw invalidArgument("--ffmpeg PATH is required; the smoke never searches for or installs FFmpeg");
  }
  const versionProcess = await runFfmpegCommand(ffmpegPath, buildVersionArgs(), {
    cwd,
    env,
    timeoutMs,
    maxOutputBytes,
  });
  const version = classifyFfmpegVersion(versionProcess);
  if (!version.ok) {
    const code = version.classification === "version-mismatch"
      ? FFMPEG_SMOKE_ERROR_CODES.FFMPEG_VERSION_MISMATCH
      : FFMPEG_SMOKE_ERROR_CODES.FFMPEG_VERSION_CHECK_FAILED;
    const details = failureDetails(versionProcess);
    throw new FfmpegSmokeError(
      code,
      `FFmpeg version check failed: ${version.message}${details ? ` (${details})` : ""}`,
      { executable: ffmpegPath, version, process: versionProcess },
    );
  }

  const processResult = await runFfmpegCommand(ffmpegPath, buildSmokeArgs(), {
    cwd,
    env,
    timeoutMs,
    maxOutputBytes,
  });
  const processing = classifyFfmpegResult(processResult);
  if (!processing.ok) {
    const details = failureDetails(processResult);
    throw new FfmpegSmokeError(
      FFMPEG_SMOKE_ERROR_CODES.FFMPEG_SMOKE_FAILED,
      `FFmpeg deterministic smoke failed: ${processing.message}${details ? ` (${details})` : ""}`,
      { executable: ffmpegPath, processing, process: processResult },
    );
  }

  return {
    executable: ffmpegPath,
    version: version.version,
    versionResult: { ...versionProcess, ...version },
    processingResult: { ...processResult, ...processing },
  };
}

function parseOptionValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw invalidArgument(`${option} requires a value`);
  return value;
}

function parseBoundedOption(value, option, label, maximum) {
  if (!/^\d+$/.test(value)) throw invalidArgument(`${option} must be a positive integer`);
  return normalizeBoundedInteger(Number(value), label, undefined, maximum);
}

export function parseCliArgs(argv = []) {
  if (!Array.isArray(argv)) throw invalidArgument("FFmpeg smoke arguments must be an array");
  const result = {
    help: false,
    ffmpegPath: undefined,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
  };
  const argumentsList = [...argv];
  while (argumentsList[0] === "--") argumentsList.shift();
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--help" || argument === "-h") {
      result.help = true;
      continue;
    }
    if (argument === "--ffmpeg") {
      result.ffmpegPath = parseOptionValue(argumentsList, index, argument);
      index += 1;
      continue;
    }
    if (argument.startsWith("--ffmpeg=")) {
      result.ffmpegPath = argument.slice("--ffmpeg=".length).trim();
      if (!result.ffmpegPath) throw invalidArgument("--ffmpeg requires a value");
      continue;
    }
    if (argument === "--timeout-ms" || argument === "--max-output-bytes") {
      const value = parseOptionValue(argumentsList, index, argument);
      result[argument === "--timeout-ms" ? "timeoutMs" : "maxOutputBytes"] = parseBoundedOption(
        value,
        argument,
        argument === "--timeout-ms" ? "timeoutMs" : "maxOutputBytes",
        argument === "--timeout-ms" ? MAX_TIMEOUT_MS : MAX_OUTPUT_BYTES,
      );
      index += 1;
      continue;
    }
    if (argument.startsWith("--timeout-ms=") || argument.startsWith("--max-output-bytes=")) {
      const separator = argument.indexOf("=");
      const option = argument.slice(0, separator);
      const value = argument.slice(separator + 1);
      if (!value) throw invalidArgument(`${option} requires a value`);
      result[option === "--timeout-ms" ? "timeoutMs" : "maxOutputBytes"] = parseBoundedOption(
        value,
        option,
        option === "--timeout-ms" ? "timeoutMs" : "maxOutputBytes",
        option === "--timeout-ms" ? MAX_TIMEOUT_MS : MAX_OUTPUT_BYTES,
      );
      continue;
    }
    throw invalidArgument(`unknown FFmpeg smoke option ${JSON.stringify(argument)}; use --help for usage`);
  }
  if (result.help) return result;
  if (!result.ffmpegPath) throw invalidArgument("--ffmpeg PATH is required; the smoke never searches for or installs FFmpeg");
  return result;
}

export const CLI_USAGE = `Usage: node scripts/ffmpeg-smoke.mjs --ffmpeg PATH [options]

Options:
  --ffmpeg PATH          explicit FFmpeg 9.0.2 executable path (required)
  --timeout-ms N         per-command timeout, 1-${MAX_TIMEOUT_MS} ms (default: ${DEFAULT_TIMEOUT_MS})
  --max-output-bytes N   per-stream output cap, 1-${MAX_OUTPUT_BYTES} bytes (default: ${DEFAULT_MAX_OUTPUT_BYTES})
  --help                 show this help

The smoke performs no network access: it verifies the version, then processes one 2x2 lavfi color frame into the null muxer.`;

export async function main(argv = process.argv.slice(2)) {
  try {
    const options = parseCliArgs(argv);
    if (options.help) {
      console.log(CLI_USAGE);
      return 0;
    }
    const report = await runFfmpegSmoke(options);
    console.log(`ffmpeg-smoke: version: PASS — ${report.versionResult.message}`);
    console.log(`ffmpeg-smoke: processing: PASS — ${report.processingResult.message}`);
    console.log("ffmpeg-smoke: PASS — deterministic lavfi color-to-null processing");
    return 0;
  } catch (error) {
    if (error instanceof FfmpegSmokeError) {
      console.error(`ffmpeg-smoke: FAIL [${error.code}] ${error.message}`);
    } else {
      console.error(`ffmpeg-smoke: FAIL [UNEXPECTED_ERROR] ${error instanceof Error ? error.message : String(error)}`);
    }
    return 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const modulePath = path.resolve(fileURLToPath(import.meta.url));
if (invokedPath === modulePath) process.exitCode = await main();
