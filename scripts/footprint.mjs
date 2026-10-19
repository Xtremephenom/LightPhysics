#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const daemonEntry = "apps/lpd/src/main.ts";
const testToken = "phase0-footprint-test-token";
const defaultSampleCount = 5;
const defaultSampleIntervalMs = 100;
const defaultStartTimeoutMs = 10_000;
const shutdownTimeoutMs = 2_500;
const maxCapturedOutput = 16_384;

const usage = `Usage: node scripts/footprint.mjs [options]

Starts lpd through its existing wrapper on a temporary loopback port and
records cold-start and idle child-process memory measurements.

Options:
  -o, --output <path>          Write JSON to a file; default is stdout
      --sample-count <count>   Idle memory samples (default: ${defaultSampleCount})
      --sample-interval-ms <n> Delay between idle samples (default: ${defaultSampleIntervalMs})
      --start-timeout-ms <n>   Readiness timeout (default: ${defaultStartTimeoutMs})
      --stdout                 Write JSON to stdout
  -h, --help                   Show this help
`;

export class FootprintArgumentError extends Error {
  constructor(message) {
    super(message);
    this.name = "FootprintArgumentError";
  }
}

function parseBoundedInteger(value, name, minimum, maximum) {
  if (!/^\d+$/.test(value)) {
    throw new FootprintArgumentError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new FootprintArgumentError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

export function parseArguments(argv = process.argv.slice(2)) {
  const options = {
    outputPath: null,
    sampleCount: defaultSampleCount,
    sampleIntervalMs: defaultSampleIntervalMs,
    startTimeoutMs: defaultStartTimeoutMs,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--stdout") {
      options.outputPath = null;
      continue;
    }
    if (argument === "-h" || argument === "--help") {
      options.help = true;
      continue;
    }
    if (argument === "-o" || argument === "--output") {
      const value = argv[index + 1];
      if (!value || (value.startsWith("-") && value !== "-")) {
        throw new FootprintArgumentError(`${argument} requires a path or - for stdout`);
      }
      options.outputPath = value === "-" ? null : value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--output=")) {
      const value = argument.slice("--output=".length);
      if (!value) throw new FootprintArgumentError("--output requires a path or - for stdout");
      options.outputPath = value === "-" ? null : value;
      continue;
    }
    if (argument === "--sample-count" || argument === "--sample-interval-ms" || argument === "--start-timeout-ms") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) throw new FootprintArgumentError(`${argument} requires a numeric value`);
      const bounds = argument === "--sample-count"
        ? [1, 60]
        : argument === "--sample-interval-ms"
          ? [1, 60_000]
          : [100, 120_000];
      const name = argument === "--sample-count"
        ? "--sample-count"
        : argument === "--sample-interval-ms"
          ? "--sample-interval-ms"
          : "--start-timeout-ms";
      const parsed = parseBoundedInteger(value, name, bounds[0], bounds[1]);
      if (argument === "--sample-count") options.sampleCount = parsed;
      else if (argument === "--sample-interval-ms") options.sampleIntervalMs = parsed;
      else options.startTimeoutMs = parsed;
      index += 1;
      continue;
    }
    if (!argument.startsWith("-") && options.outputPath === null) {
      options.outputPath = argument;
      continue;
    }
    throw new FootprintArgumentError(`Unknown option: ${argument}`);
  }

  return options;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactText(value, secrets = [], workspaceRoot = root) {
  let redacted = String(value);
  for (const secret of secrets) {
    if (!secret) continue;
    redacted = redacted.replaceAll(secret, "[redacted]");
  }
  const rootVariants = [
    workspaceRoot,
    workspaceRoot.replaceAll("\\", "/"),
    workspaceRoot.replaceAll("/", "\\"),
  ];
  for (const variant of rootVariants) {
    if (variant) redacted = redacted.replace(new RegExp(escapeRegExp(variant), "gi"), "<workspace>");
  }
  redacted = redacted.replace(/[A-Za-z]:[\\/][^\s"'`<>]+/g, "<path>");
  redacted = redacted.replace(/(^|[\s("'`])\/(?:Users|home|mnt|private|tmp|var|workspace)\/[^\s"'`<>]+/g, "$1<path>");
  return redacted;
}

function roundMilliseconds(value) {
  return Math.round(value * 1_000) / 1_000;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function appendCaptured(current, chunk) {
  if (current.length >= maxCapturedOutput) return current;
  return `${current}${String(chunk)}`.slice(0, maxCapturedOutput);
}

function waitForExit(child, timeoutMs) {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => finish(false), timeoutMs);
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
    child.once("exit", onExit);
    child.once("error", onError);
    if (hasExited(child)) finish(true);
  });
}

async function stopDaemon(child) {
  if (!child || hasExited(child)) return;
  try {
    child.kill("SIGTERM");
  } catch {
    // The child may have exited between the state check and the signal.
  }
  if (await waitForExit(child, shutdownTimeoutMs)) return;
  try {
    child.kill(process.platform === "win32" ? undefined : "SIGKILL");
  } catch {
    // The child may have exited while graceful shutdown was pending.
  }
  await waitForExit(child, shutdownTimeoutMs);
}

function closeProbe(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export async function reserveEphemeralPort() {
  const probe = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", resolve);
    });
    const address = probe.address();
    if (!address || typeof address !== "object" || !Number.isInteger(address.port) || address.port < 1) {
      throw new Error("the operating system did not provide an ephemeral loopback port");
    }
    return address.port;
  } finally {
    if (probe.listening) await closeProbe(probe);
  }
}

function waitForReady(child, expectedPort, timeoutMs) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let settled = false;
    const timer = setTimeout(() => finishReject(new Error("lpd did not report readiness before the timeout")), timeoutMs);
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
      callback();
    };
    const finishResolve = (port) => finish(() => resolve(port));
    const finishReject = (error) => finish(() => reject(error));
    const onData = (chunk) => {
      stdout = appendCaptured(stdout, chunk);
      const match = /^lpd listening on \[?127\.0\.0\.1\]?:([0-9]+)\s*$/m.exec(stdout);
      if (!match) return;
      const port = Number(match[1]);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        finishReject(new Error("lpd reported an invalid loopback port"));
      } else if (port !== expectedPort) {
        finishReject(new Error("lpd reported a port different from the reserved loopback port"));
      } else {
        finishResolve(port);
      }
    };
    const onError = () => finishReject(new Error("the lpd wrapper could not be started"));
    const onExit = () => finishReject(new Error("lpd exited before reporting readiness"));
    if (!child.stdout) {
      finishReject(new Error("the lpd wrapper did not expose stdout for readiness"));
      return;
    }
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function spawnDaemon(port, temporaryHome, timeoutMs) {
  const environment = {
    ...process.env,
    LP_BIND: "127.0.0.1",
    LP_IN_CONTAINER: "0",
    LP_LOG_FORMAT: "json",
    LP_LOG_LEVEL: "error",
    LP_PORT: String(port),
    LP_HOME: temporaryHome,
    LP_TOKEN: testToken,
  };
  const child = spawn(process.execPath, ["--experimental-strip-types", daemonEntry], {
    cwd: root,
    env: environment,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => {
    stderr = appendCaptured(stderr, chunk);
  });
  child.stderr?.resume();
  // Keep an error listener attached after readiness so a late spawn error is
  // never turned into an unhandled process error.
  child.on("error", () => undefined);
  return {
    child,
    environment,
    stderr: () => stderr,
    ready: waitForReady(child, port, timeoutMs),
  };
}

function parseKilobytes(text, field) {
  const match = new RegExp(`^${field}:\\s+(\\d+)\\s+kB$`, "m").exec(text);
  if (!match) return null;
  const kilobytes = Number(match[1]);
  return Number.isSafeInteger(kilobytes) ? kilobytes * 1024 : null;
}

function parseCsvRow(line) {
  const fields = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      fields.push(field);
      field = "";
    } else {
      field += character;
    }
  }
  fields.push(field);
  return fields;
}

function runQuietCommand(command, args) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    try {
      child = spawn(command, args, {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      finish({ code: 1, stdout, stderr: error instanceof Error ? error.message : String(error) });
      return;
    }
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout = appendCaptured(stdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = appendCaptured(stderr, chunk);
    });
    child.once("error", (error) => finish({ code: 1, stdout, stderr: error.message }));
    child.once("exit", (code, signal) => finish({
      code: signal ? 1 : code ?? 1,
      stdout,
      stderr,
    }));
  });
}

async function readLinuxMemory(pid) {
  const status = await readFile(`/proc/${pid}/status`, "utf8");
  const rssBytes = parseKilobytes(status, "VmRSS");
  if (rssBytes === null) throw new Error("Linux procfs did not expose VmRSS");
  return {
    rssBytes,
    workingSetBytes: rssBytes,
    source: "procfs",
    note: "Linux reports resident memory through procfs; working set is represented by the same resident-set reading.",
  };
}

async function readWindowsMemory(pid) {
  const result = await runQuietCommand("tasklist.exe", ["/FO", "CSV", "/NH", "/FI", `PID eq ${pid}`]);
  const row = result.stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => line.startsWith('"'));
  if (!row) throw new Error("tasklist did not return a working-set row");
  const fields = parseCsvRow(row);
  const kilobytes = Number((fields[4] ?? "").replace(/[^0-9]/g, ""));
  if (!Number.isSafeInteger(kilobytes) || kilobytes < 0) throw new Error("tasklist returned an invalid working-set value");
  return {
    rssBytes: null,
    workingSetBytes: kilobytes * 1024,
    source: "tasklist",
    note: "Windows working set is measured through tasklist; a separate RSS value is not exposed by this portable probe.",
  };
}

async function readPosixMemory(pid) {
  const result = await runQuietCommand("ps", ["-o", "rss=", "-p", String(pid)]);
  if (result.code !== 0) throw new Error("ps did not return a resident-set value");
  const kilobytes = Number(result.stdout.trim().split(/\s+/)[0]);
  if (!Number.isSafeInteger(kilobytes) || kilobytes < 0) throw new Error("ps returned an invalid resident-set value");
  return {
    rssBytes: kilobytes * 1024,
    workingSetBytes: kilobytes * 1024,
    source: "ps",
    note: "This platform exposes resident memory through ps; working set is represented by the same resident-set reading.",
  };
}

export async function readProcessMemory(pid) {
  try {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("invalid child process id");
    if (process.platform === "linux") return await readLinuxMemory(pid);
    if (process.platform === "win32") return await readWindowsMemory(pid);
    return await readPosixMemory(pid);
  } catch (error) {
    return {
      rssBytes: null,
      workingSetBytes: null,
      source: "unavailable",
      note: error instanceof Error ? error.message : "memory probe unavailable",
    };
  }
}

export function summarizeMetric(values) {
  const valid = values.filter((value) => Number.isSafeInteger(value) && value >= 0);
  if (valid.length === 0) return null;
  const total = valid.reduce((sum, value) => sum + value, 0);
  return {
    sample_count: valid.length,
    min_bytes: Math.min(...valid),
    max_bytes: Math.max(...valid),
    mean_bytes: Math.round(total / valid.length),
  };
}

export async function sampleIdleMemory(pid, options = {}) {
  const sampleCount = options.sampleCount ?? defaultSampleCount;
  const sampleIntervalMs = options.sampleIntervalMs ?? defaultSampleIntervalMs;
  const readings = [];
  for (let index = 0; index < sampleCount; index += 1) {
    if (index > 0) await sleep(sampleIntervalMs);
    readings.push(await readProcessMemory(pid));
  }
  const notes = [...new Set(readings.map((reading) => reading.note).filter(Boolean))];
  const sources = [...new Set(readings.map((reading) => reading.source))];
  return {
    state: "idle",
    sample_count: readings.length,
    sample_interval_ms: sampleIntervalMs,
    window_ms: sampleIntervalMs * Math.max(0, readings.length - 1),
    rss_bytes: summarizeMetric(readings.map((reading) => reading.rssBytes)),
    working_set_bytes: summarizeMetric(readings.map((reading) => reading.workingSetBytes)),
    source: sources.length === 1 ? sources[0] : sources,
    ...(notes.length > 0 ? { notes } : {}),
  };
}

function qualificationNotes() {
  return [
    "Measured values are host-specific observations; this report does not claim the architecture budget is met.",
    "Cold start is measured from the child spawn request until the existing lpd wrapper reports its loopback listener.",
    "Idle memory is sampled while the authenticated daemon is listening and receives no workload requests.",
    "Repeat on the reference hardware/profile before making a qualification decision.",
  ];
}

function baseReport() {
  return {
    schema_version: 1,
    platform: {
      os: process.platform,
      arch: process.arch,
      release: os.release(),
    },
    runtime: {
      name: "node",
      version: process.version,
    },
    command: {
      executable: "node",
      args: ["--experimental-strip-types", daemonEntry],
      working_directory: "workspace-root",
      wrapper: "existing lpd executable wrapper",
      environment: {
        LP_BIND: "127.0.0.1",
        LP_IN_CONTAINER: "0",
        LP_LOG_FORMAT: "json",
        LP_LOG_LEVEL: "error",
        LP_PORT: "<ephemeral-loopback-port>",
        LP_HOME: "<temporary-test-home>",
        LP_TOKEN: "[redacted]",
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
        lpd_idle_ram: "<= 250 MB (reference only; not evaluated here)",
        lpd_cold_start: "<= 3 s (reference only; not evaluated here)",
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
    name: error instanceof Error ? error.name : "Error",
    message: redactText(error instanceof Error ? error.message : String(error), [testToken]),
  };
  return report;
}

export async function measureFootprint(options = {}) {
  const normalized = {
    sampleCount: options.sampleCount ?? defaultSampleCount,
    sampleIntervalMs: options.sampleIntervalMs ?? defaultSampleIntervalMs,
    startTimeoutMs: options.startTimeoutMs ?? defaultStartTimeoutMs,
  };
  let child;
  let temporaryHome;
  try {
    temporaryHome = await mkdtemp(path.join(os.tmpdir(), "lightphysics-footprint-"));
    const port = await reserveEphemeralPort();
    const startedAt = performance.now();
    const daemon = spawnDaemon(port, temporaryHome, normalized.startTimeoutMs);
    child = daemon.child;
    let readyPort;
    try {
      readyPort = await daemon.ready;
    } catch (error) {
      const wrapperError = daemon.stderr();
      if (wrapperError.trim()) {
        const detail = redactText(wrapperError.trim(), [testToken]);
        throw new Error(`${error instanceof Error ? error.message : String(error)} (${detail.slice(0, 500)})`);
      }
      throw error;
    }
    const coldStartMs = roundMilliseconds(performance.now() - startedAt);
    child.stdout?.resume();
    const idleMemory = await sampleIdleMemory(child.pid, normalized);
    const report = baseReport();
    report.status = idleMemory.rss_bytes || idleMemory.working_set_bytes
      ? "MEASURED"
      : "MEASURED_WITH_LIMITATIONS";
    report.measurement = {
      cold_start_ms: coldStartMs,
      idle_memory: idleMemory,
      readiness: "wrapper-listener-line",
      reported_port: readyPort === port ? "ephemeral-loopback-port" : "unexpected",
    };
    if (idleMemory.rss_bytes === null || idleMemory.working_set_bytes === null) {
      report.qualification.notes.push("One or more requested memory metrics were unavailable on this platform; see idle_memory for the measured source and notes.");
    }
    return report;
  } finally {
    await stopDaemon(child);
    if (temporaryHome) await rm(temporaryHome, { recursive: true, force: true });
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
    const report = failureReport(error);
    await writeReport(null, serializeReport(report));
    console.error(`footprint: ${report.error.message}`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(usage);
    return 0;
  }

  let report;
  try {
    report = await measureFootprint(options);
  } catch (error) {
    report = failureReport(error);
  }
  try {
    await writeReport(options.outputPath, serializeReport(report));
  } catch (error) {
    console.error(`footprint: could not write report (${redactText(error instanceof Error ? error.message : String(error), [testToken])})`);
    return 1;
  }
  if (report.status === "FAILED") {
    console.error(`footprint: FAILED — ${report.error.message}`);
    return 1;
  }
  return 0;
}

const invokedAsScript = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false;

if (invokedAsScript) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  }, (error) => {
    console.error(`footprint: ${redactText(error instanceof Error ? error.message : String(error), [testToken])}`);
    process.exitCode = 1;
  });
}
