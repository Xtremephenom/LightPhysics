import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  parseArguments,
  redactText,
  serializeReport,
  summarizeMetric,
} from "../scripts/footprint.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts", "footprint.mjs");
const token = "phase0-footprint-test-token";

test("footprint argument parsing keeps output optional and bounded", () => {
  assert.deepEqual(parseArguments([
    "--output",
    "report.json",
    "--sample-count",
    "3",
    "--sample-interval-ms",
    "25",
    "--start-timeout-ms",
    "5000",
  ]), {
    outputPath: "report.json",
    sampleCount: 3,
    sampleIntervalMs: 25,
    startTimeoutMs: 5000,
    help: false,
  });
  assert.equal(parseArguments(["--output", "-"]).outputPath, null);
  assert.throws(() => parseArguments(["--sample-count", "0"]), /between 1 and 60/);
  assert.throws(() => parseArguments(["--shell"]), /Unknown option/);
});

test("report helpers summarize measurements and redact sensitive paths", () => {
  assert.deepEqual(summarizeMetric([1024, 2048, 3072]), {
    sample_count: 3,
    min_bytes: 1024,
    max_bytes: 3072,
    mean_bytes: 2048,
  });
  assert.equal(summarizeMetric([null, null]), null);
  const windowsRoot = ["D:", "LightPhysics"].join("\\");
  const text = redactText(
    `token=${token} at ${windowsRoot}\\apps\\lpd\\src\\main.ts`,
    [token],
    windowsRoot,
  );
  assert.equal(text.includes(token), false);
  assert.equal(text.includes(windowsRoot), false);
  assert.equal(text.includes("<workspace>"), true);
});

test("footprint command starts the wrapper and emits a redacted measured report", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lightphysics-footprint-test-"));
  const output = path.join(directory, "report.json");
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, "--output", output, "--sample-count", "2", "--sample-interval-ms", "10"], {
        cwd: root,
        env: process.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stderr = "";
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal, stderr }));
    });
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.code, 0, result.stderr);
    const text = await readFile(output, "utf8");
    const report = JSON.parse(text);
    assert.equal(report.schema_version, 1);
    assert.match(report.status, /^MEASURED(?:_WITH_LIMITATIONS)?$/);
    assert.equal(report.qualification.status, "NOT_QUALIFIED");
    assert.equal(report.qualification.architecture_budget_claimed, false);
    assert.equal(report.command.args[1], "apps/lpd/src/main.ts");
    assert.equal(report.command.environment.LP_TOKEN, "[redacted]");
    assert.equal(report.measurement.idle_memory.sample_count, 2);
    assert.equal(typeof report.measurement.cold_start_ms, "number");
    assert.equal(text.includes(token), false);
    assert.equal(text.includes(root), false);
    assert.match(serializeReport(report), /architecture budget is met/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
