#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ELECTRON_FOOTPRINT_DEFAULTS,
  ELECTRON_FOOTPRINT_ERROR_CODES as METRIC_ERROR_CODES,
  hasUsableElectronMetrics,
} from "../apps/electron/src/footprint.mjs";
import {
  ELECTRON_FOOTPRINT_READY_PREFIX,
  ELECTRON_FOOTPRINT_RESULT_PREFIX,
  ELECTRON_VERSION,
  ELECTRON_SMOKE_ERROR_CODES,
  launchElectron,
  resolveElectronExecutable,
  startDaemon,
  stopChild,
  waitForExit,
} from "./electron-smoke.mjs";
import { validateLoopbackGuiUrl } from "../apps/electron/src/security.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultTimeoutMs = 30_000;
const defaultMaxOutputBytes = 64 * 1024;
const shutdownTimeoutMs = 3_000;
const footprintAuth = "phase0-electron-footprint-auth";

export const ELECTRON_FOOTPRINT_ERROR_CODES = Object.freeze({
  INVALID_ARGUMENT: "INVALID_ARGUMENT",
  ELECTRON_NOT_FOUND: "ELECTRON_NOT_FOUND",
  ELECTRON_VERSION_MISMATCH: "ELECTRON_VERSION_MISMATCH",
  DAEMON_START_FAILED: "DAEMON_START_FAILED",
  DAEMON_START_TIMEOUT: "DAEMON_START_TIMEOUT",
  ELECTRON_START_FAILED: "ELECTRON_START_FAILED",
  ELECTRON_START_TIMEOUT: "ELECTRON_START_TIMEOUT",
  DISPLAY_UNAVAILABLE: "DISPLAY_UNAVAILABLE",
  RENDERER_CHECK_FAILED: "RENDERER_CHECK_FAILED",
  METRICS_UNAVAILABLE: "METRICS_UNAVAILABLE",
  FOOTPRINT_RESULT_INVALID: "FOOTPRINT_RESULT_INVALID",
  PROCESS_SHUTDOWN_TIMEOUT: "PROCESS_SHUTDOWN_TIMEOUT",
});

export class ElectronFootprintError extends Error {
  constructor(code, message, suggestedNext, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ElectronFootprintError";
    this.code = code;
    this.suggestedNext = suggestedNext;
  }
}

export const usage = `Usage: corepack pnpm run measure:electron-footprint -- [options]

Opt-in measurement: starts an authenticated loopback lpd, launches the already
installed pinned Electron executable, validates the real Studio Floor, and
records bounded cold-start plus Electron main/renderer idle memory samples.
The command never installs or downloads Electron and is not part of the offline
test suite. Reports contain no token, absolute path, URL, or page content.

Options:
  -o, --output <path>          Write JSON to a file; default is stdout
      --sample-count <count>   Idle samples (default: ${ELECTRON_FOOTPRINT_DEFAULTS.sampleCount})
      --sample-interval-ms <n> Delay between samples (default: ${ELECTRON_FOOTPRINT_DEFAULTS.sampleIntervalMs})
      --timeout-ms <n>         Bounded daemon/Electron timeout (default: ${defaultTimeoutMs})
      --max-output-bytes <n>   Per-stream child output bound (default: ${defaultMaxOutputBytes})
      --stdout                 Write JSON to stdout
  -h, --help                   Show this help
`;

function parseBoundedInteger(value, label, minimum, maximum) {
  if (!/^\d+$/.test(value)) {
    throw new ElectronFootprintError(
      ELECTRON_FOOTPRINT_ERROR_CODES.INVALID_ARGUMENT,
      `${label} must be an integer between ${minimum} and ${maximum}`,
      `Pass ${label} with a bounded integer value.`,
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ElectronFootprintError(
      ELECTRON_FOOTPRINT_ERROR_CODES.INVALID_ARGUMENT,
      `${label} must be an integer between ${minimum} and ${maximum}`,
      `Pass ${label} with a bounded integer value.`,
    );
  }
  return parsed;
}

function readOptionValue(argv, index, argument, name, allowDash = false) {
  if (argument.startsWith(`${name}=`)) return { value: argument.slice(name.length + 1), nextIndex: index };
  const value = argv[index + 1];
  if (!value || (value.startsWith("-") && !(allowDash && value === "-"))) {
    throw new ElectronFootprintError(
      ELECTRON_FOOTPRINT_ERROR_CODES.INVALID_ARGUMENT,
      `${name} requires a value`,
      `Pass ${name} with a bounded value.`,
    );
  }
  return { value, nextIndex: index + 1 };
}

export function parseArguments(argv = []) {
  const options = {
    outputPath: null,
    sampleCount: ELECTRON_FOOTPRINT_DEFAULTS.sampleCount,
    sampleIntervalMs: ELECTRON_FOOTPRINT_DEFAULTS.sampleIntervalMs,
    timeoutMs: defaultTimeoutMs,
    maxOutputBytes: defaultMaxOutputBytes,
    help: false,
  };
  const argumentsList = [...argv];
  while (argumentsList[0] === "--") argumentsList.shift();
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--stdout") {
      options.outputPath = null;
      continue;
    }
    if (argument === "-o" || argument === "--output" || argument.startsWith("--output=")) {
      const read = argument.startsWith("--output=")
        ? { value: argument.slice("--output=".length), nextIndex: index }
        : readOptionValue(argumentsList, index, argument, argument, true);
      if (!read.value) {
        throw new ElectronFootprintError(
          ELECTRON_FOOTPRINT_ERROR_CODES.INVALID_ARGUMENT,
          `${argument} requires a path or - for stdout`,
          "Pass --output PATH or --output -.",
        );
      }
      options.outputPath = read.value === "-" ? null : read.value;
      index = read.nextIndex;
      continue;
    }
    const numeric = [
      ["--sample-count", 1, 60, "sampleCount"],
      ["--sample-interval-ms", 1, 60_000, "sampleIntervalMs"],
      ["--timeout-ms", 100, 120_000, "timeoutMs"],
      ["--max-output-bytes", 1_048, 4 * 1024 * 1024, "maxOutputBytes"],
    ].find(([name]) => argument === name || argument.startsWith(`${name}=`));
    if (numeric) {
      const [name, minimum, maximum, key] = numeric;
      const read = readOptionValue(argumentsList, index, argument, name);
      options[key] = parseBoundedInteger(read.value, name, minimum, maximum);
      index = read.nextIndex;
      continue;
    }
    throw new ElectronFootprintError(
      ELECTRON_FOOTPRINT_ERROR_CODES.INVALID_ARGUMENT,
      `Unknown Electron footprint option: ${argument}`,
      "Use --help to see the bounded opt-in measurement options.",
    );
  }
  return options;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactFootprintText(value, secrets = [], workspaceRoot = root) {
  let redacted = String(value);
  for (const secret of secrets) {
    if (secret) redacted = redacted.replaceAll(secret, "[redacted]");
  }
  const rootVariants = [
    workspaceRoot,
    workspaceRoot.replaceAll("\\", "/"),
    workspaceRoot.replaceAll("/", "\\"),
  ];
  for (const variant of rootVariants) {
    if (variant) redacted = redacted.replace(new RegExp(escapeRegExp(variant), "gi"), "<workspace>");
  }
  redacted = redacted.replace(/https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?[^\s"'`]*/gi, "<loopback-url>");
  redacted = redacted.replace(/[A-Za-z]:[\\/][^\s"'`<>]+/g, "<path>");
  redacted = redacted.replace(/(^|[\s("'`])\/(?:Users|home|mnt|private|tmp|var|workspace)\/[^\s"'`<>]+/g, "$1<path>");
  return redacted.slice(0, 2_000);
}

function displayText(text) {
  return /(?:no usable display|cannot open display|display server|display is not set|failed to connect to (?:the )?(?:x|wayland)|x server|wayland display|DISPLAY=)/i.test(text);
}

export function classifyElectronFailure(error, output = "") {
  const code = error && typeof error === "object" ? error.code : undefined;
  if (code === ELECTRON_SMOKE_ERROR_CODES.ELECTRON_NOT_FOUND) return ELECTRON_FOOTPRINT_ERROR_CODES.ELECTRON_NOT_FOUND;
  if (code === ELECTRON_SMOKE_ERROR_CODES.ELECTRON_VERSION_MISMATCH) return ELECTRON_FOOTPRINT_ERROR_CODES.ELECTRON_VERSION_MISMATCH;
  if (code === ELECTRON_SMOKE_ERROR_CODES.DAEMON_START_TIMEOUT) return ELECTRON_FOOTPRINT_ERROR_CODES.DAEMON_START_TIMEOUT;
  if (code === ELECTRON_SMOKE_ERROR_CODES.DAEMON_START_FAILED) return ELECTRON_FOOTPRINT_ERROR_CODES.DAEMON_START_FAILED;
  if (code === ELECTRON_SMOKE_ERROR_CODES.RENDERER_CHECK_FAILED) return ELECTRON_FOOTPRINT_ERROR_CODES.RENDERER_CHECK_FAILED;
  if (code === ELECTRON_SMOKE_ERROR_CODES.PROCESS_SHUTDOWN_TIMEOUT) return ELECTRON_FOOTPRINT_ERROR_CODES.PROCESS_SHUTDOWN_TIMEOUT;
  if (code === METRIC_ERROR_CODES.METRICS_UNAVAILABLE || /app\.getAppMetrics|metrics/i.test(String(error?.message ?? ""))) {
    return ELECTRON_FOOTPRINT_ERROR_CODES.METRICS_UNAVAILABLE;
  }
  const text = `${String(error?.message ?? "")} ${String(output)}`;
  if (displayText(text)) return ELECTRON_FOOTPRINT_ERROR_CODES.DISPLAY_UNAVAILABLE;
  if (code === ELECTRON_SMOKE_ERROR_CODES.ELECTRON_START_TIMEOUT || /did not report|timed out|timeout/i.test(text)) {
    return ELECTRON_FOOTPRINT_ERROR_CODES.ELECTRON_START_TIMEOUT;
  }
  return ELECTRON_FOOTPRINT_ERROR_CODES.ELECTRON_START_FAILED;
}

export function classifyFootprintResult(result) {
  if (!result || typeof result !== "object") {
    return {
      ok: false,
      code: ELECTRON_FOOTPRINT_ERROR_CODES.FOOTPRINT_RESULT_INVALID,
      message: "Electron did not return a footprint result",
    };
  }
  if (result.classification !== "ready") {
    return {
      ok: false,
      code: ELECTRON_FOOTPRINT_ERROR_CODES.RENDERER_CHECK_FAILED,
      message: "Electron footprint result did not confirm the loaded Studio Floor",
    };
  }
  if (!hasUsableElectronMetrics(result.metrics)) {
    return {
      ok: false,
      code: ELECTRON_FOOTPRINT_ERROR_CODES.METRICS_UNAVAILABLE,
      message: "Electron footprint result did not include main and renderer working-set metrics",
    };
  }
  return { ok: true, code: null, message: null };
}

function suggestedNext(code) {
  switch (code) {
    case ELECTRON_FOOTPRINT_ERROR_CODES.ELECTRON_NOT_FOUND:
      return "Run corepack pnpm install --frozen-lockfile and provision the pinned Electron executable; this command never downloads it.";
    case ELECTRON_FOOTPRINT_ERROR_CODES.DISPLAY_UNAVAILABLE:
      return "Retry from a Windows/Linux/macOS display session with the pinned Electron executable available.";
    case ELECTRON_FOOTPRINT_ERROR_CODES.METRICS_UNAVAILABLE:
      return "Retry on the pinned Electron runtime where Browser and Tab process metrics are exposed.";
    case ELECTRON_FOOTPRINT_ERROR_CODES.DAEMON_START_TIMEOUT:
    case ELECTRON_FOOTPRINT_ERROR_CODES.DAEMON_START_FAILED:
      return "Check authenticated lpd startup and loopback TCP availability, then retry with bounded options.";
    case ELECTRON_FOOTPRINT_ERROR_CODES.ELECTRON_START_TIMEOUT:
      return "Check display support and retry with a bounded --timeout-ms value.";
    default:
      return "Inspect the typed prerequisite error and retry the opt-in measurement.";
  }
}

function normalizeError(error, output = "") {
  if (error instanceof ElectronFootprintError) return error;
  const code = classifyElectronFailure(error, output);
  const normalized = new ElectronFootprintError(
    code,
    redactFootprintText(error instanceof Error ? error.message : String(error), [footprintAuth]),
    suggestedNext(code),
    error,
  );
  if (output) normalized.output = output;
  return normalized;
}

function qualificationNotes() {
  return [
    "Measured values are host-specific observations; this report does not claim the architecture budget is met.",
    "Cold start is measured from the direct pinned Electron spawn request until the existing real Studio Floor passes renderer validation.",
    "Idle memory uses bounded Electron app.getAppMetrics() samples after renderer readiness and while lpd receives no workload requests.",
    "Main means Electron Browser process and renderer means Electron Tab process; private bytes are reported only when Electron exposes them.",
    "Repeat on the reference hardware/profile before making a qualification decision.",
    "Packaging, visual/accessibility, Linux secret-store behavior, and cross-platform memory remain unrun.",
  ];
}

function baseReport(electronVersion = ELECTRON_VERSION) {
  return {
    schema_version: 1,
    platform: {
      os: process.platform,
      arch: process.arch,
      release: os.release(),
    },
    host_profile: {
      os: process.platform,
      arch: process.arch,
      release: os.release(),
      display: "required; availability classified by result",
    },
    runtime: {
      name: "node",
      version: process.version,
    },
    electron: {
      version: electronVersion,
      executable: "pinned project Electron executable",
    },
    command: {
      executable: "pinned Electron executable",
      args: [
        "apps/electron/src/main.mjs",
        "--footprint-url",
        "<validated-loopback-url>",
        "--footprint-sample-count=<bounded>",
        "--footprint-sample-interval-ms=<bounded>",
      ],
      working_directory: "workspace-root",
      shell: false,
      daemon_environment: {
        LP_BIND: "127.0.0.1",
        LP_IN_CONTAINER: "0",
        LP_LOG_FORMAT: "json",
        LP_LOG_LEVEL: "error",
        LP_PORT: "<ephemeral-loopback-port>",
        LP_TOKEN: "[redacted]",
      },
      electron_environment: {
        LP_TOKEN: "not passed",
      },
    },
    listen: {
      bind: "127.0.0.1",
      port: "ephemeral",
    },
    qualification: {
      status: "NOT_QUALIFIED",
      architecture_budget_claimed: false,
      budget_reference: {
        gui_idle_ram: "<= 400 MB (reference only; not evaluated here)",
        gui_cold_start: "no Phase 0 qualification threshold evaluated here",
      },
      notes: qualificationNotes(),
    },
  };
}

function failureReport(error) {
  const report = baseReport();
  report.status = "FAILED";
  report.measurement = {
    cold_start_ms: null,
    idle_memory: null,
  };
  report.error = {
    code: error.code ?? ELECTRON_FOOTPRINT_ERROR_CODES.ELECTRON_START_FAILED,
    name: error.name,
    message: redactFootprintText(error.message, [footprintAuth]),
  };
  return report;
}

function measuredReport({ electronVersion, config, electron }) {
  const report = baseReport(electronVersion);
  report.host_profile.display = "available for this opt-in run";
  const result = electron.result;
  report.command.args = [
    "apps/electron/src/main.mjs",
    "--footprint-url",
    "<validated-loopback-url>",
    `--footprint-sample-count=${config.sampleCount}`,
    `--footprint-sample-interval-ms=${config.sampleIntervalMs}`,
  ];
  report.status = "MEASURED";
  report.measurement = {
    cold_start_ms: electron.coldStartMs,
    cold_start_bound_ms: config.timeoutMs,
    renderer: {
      state: "ready",
      validation: "real Studio Floor markers, same-origin loopback URL, and strict local CSP",
    },
    idle_memory: {
      state: "idle",
      sample_count: result.sample_count,
      sample_interval_ms: result.sample_interval_ms,
      window_ms: result.sample_interval_ms * Math.max(0, result.sample_count - 1),
      source: result.metrics.source,
      unit: result.metrics.unit,
      main: result.metrics.main,
      renderer: result.metrics.renderer,
      total: result.metrics.total,
    },
    readiness: "renderer-ready-marker",
    reported_port: "ephemeral-loopback-port",
  };
  return report;
}

export async function measureElectronFootprint(options = {}) {
  const config = {
    sampleCount: options.sampleCount ?? ELECTRON_FOOTPRINT_DEFAULTS.sampleCount,
    sampleIntervalMs: options.sampleIntervalMs ?? ELECTRON_FOOTPRINT_DEFAULTS.sampleIntervalMs,
    timeoutMs: options.timeoutMs ?? defaultTimeoutMs,
    maxOutputBytes: options.maxOutputBytes ?? defaultMaxOutputBytes,
  };
  let daemon;
  let electron;
  try {
    const resolved = await resolveElectronExecutable(options.rootDir ?? root);
    daemon = await startDaemon({ timeoutMs: config.timeoutMs, maxOutputBytes: config.maxOutputBytes });
    const guiUrl = validateLoopbackGuiUrl(`http://127.0.0.1:${daemon.port}/`);
    electron = await launchElectron({
      guiUrl,
      timeoutMs: config.timeoutMs,
      maxOutputBytes: config.maxOutputBytes,
      executable: resolved.executable,
      mode: "footprint",
      sampleCount: config.sampleCount,
      sampleIntervalMs: config.sampleIntervalMs,
    });
    const classification = classifyFootprintResult(electron.result);
    if (!classification.ok) {
      throw new ElectronFootprintError(classification.code, classification.message, suggestedNext(classification.code));
    }
    if (!Number.isFinite(electron.coldStartMs)) {
      throw new ElectronFootprintError(
        ELECTRON_FOOTPRINT_ERROR_CODES.ELECTRON_START_TIMEOUT,
        "Electron did not expose a bounded renderer-ready cold-start timestamp",
        suggestedNext(ELECTRON_FOOTPRINT_ERROR_CODES.ELECTRON_START_TIMEOUT),
      );
    }
    const exited = await waitForExit(electron.child, shutdownTimeoutMs);
    if (!exited) {
      throw new ElectronFootprintError(
        ELECTRON_FOOTPRINT_ERROR_CODES.PROCESS_SHUTDOWN_TIMEOUT,
        "Electron reported the footprint result but did not quit within the shutdown bound",
        suggestedNext(ELECTRON_FOOTPRINT_ERROR_CODES.PROCESS_SHUTDOWN_TIMEOUT),
      );
    }
    if (electron.child.exitCode !== 0) {
      throw new ElectronFootprintError(
        ELECTRON_FOOTPRINT_ERROR_CODES.ELECTRON_START_FAILED,
        `Electron footprint process exited with code ${electron.child.exitCode ?? "unknown"}`,
        suggestedNext(ELECTRON_FOOTPRINT_ERROR_CODES.ELECTRON_START_FAILED),
      );
    }
    return measuredReport({ electronVersion: resolved.version, config, electron });
  } catch (error) {
    const output = error && typeof error === "object" && "output" in error ? String(error.output) : "";
    throw normalizeError(error, output);
  } finally {
    if (electron?.child) await stopChild(electron.child);
    if (daemon?.child) await stopChild(daemon.child);
  }
}

export function serializeReport(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}

async function writeReport(outputPath, reportText) {
  if (!outputPath) {
    process.stdout.write(reportText);
    return;
  }
  const destination = path.resolve(outputPath);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, reportText, "utf8");
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    const report = failureReport(normalizeError(error));
    await writeReport(null, serializeReport(report));
    console.error(`electron-footprint: FAIL [${report.error.code}] ${report.error.message}`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(usage);
    return 0;
  }

  let report;
  let errorOutput = "";
  try {
    report = await measureElectronFootprint(options);
  } catch (error) {
    errorOutput = error && typeof error === "object" && "output" in error ? String(error.output) : "";
    report = failureReport(normalizeError(error, errorOutput));
  }
  try {
    await writeReport(options.outputPath, serializeReport(report));
  } catch (error) {
    console.error(`electron-footprint: could not write report (${redactFootprintText(error instanceof Error ? error.message : String(error), [footprintAuth])})`);
    return 1;
  }
  if (report.status === "FAILED") {
    console.error(`electron-footprint: FAIL [${report.error.code}] ${report.error.message}`);
    console.error(`electron-footprint: next step: ${suggestedNext(report.error.code)}`);
    if (errorOutput) console.error(`electron-footprint: bounded child output:\n${redactFootprintText(errorOutput, [footprintAuth])}`);
    return 1;
  }
  console.error(`electron-footprint: Electron ${report.electron.version} measured ${report.measurement.idle_memory.sample_count} bounded idle samples`);
  console.error("electron-footprint: qualification NOT_QUALIFIED; architecture budget claim false");
  return 0;
}

const invokedAsScript = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false;

if (invokedAsScript) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  }, (error) => {
    const typed = normalizeError(error, error?.output);
    console.error(`electron-footprint: FAIL [${typed.code}] ${typed.message}`);
    process.exitCode = 1;
  });
}
