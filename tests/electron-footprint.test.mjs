import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  ELECTRON_FOOTPRINT_ERROR_CODES,
  classifyElectronFailure,
  classifyFootprintResult,
  parseArguments,
  redactFootprintText,
} from "../scripts/electron-footprint.mjs";
import {
  ELECTRON_SMOKE_ERROR_CODES,
  buildElectronArgs,
} from "../scripts/electron-smoke.mjs";
import { resolveGuiTarget } from "../apps/electron/src/security.mjs";
import {
  aggregateElectronMetrics,
  hasUsableElectronMetrics,
  parseFootprintOptions,
} from "../apps/electron/src/footprint.mjs";

test("Electron footprint argument construction stays bounded and direct", () => {
  assert.deepEqual(parseArguments([
    "--output",
    "report.json",
    "--sample-count=3",
    "--sample-interval-ms",
    "25",
    "--timeout-ms",
    "5000",
    "--max-output-bytes",
    "2048",
  ]), {
    outputPath: "report.json",
    sampleCount: 3,
    sampleIntervalMs: 25,
    timeoutMs: 5000,
    maxOutputBytes: 2048,
    help: false,
  });
  assert.deepEqual(parseFootprintOptions([
    "--footprint-url",
    "http://127.0.0.1:4317/",
    "--footprint-sample-count",
    "4",
    "--footprint-sample-interval-ms=50",
  ]), {
    sampleCount: 4,
    sampleIntervalMs: 50,
  });
  assert.deepEqual(
    buildElectronArgs(
      path.join("apps", "electron", "src", "main.mjs"),
      "http://127.0.0.1:4317/",
      { mode: "footprint", sampleCount: 4, sampleIntervalMs: 50 },
    ),
    [
      path.resolve("apps", "electron", "src", "main.mjs"),
      "--footprint-url",
      "http://127.0.0.1:4317/",
      "--footprint-sample-count=4",
      "--footprint-sample-interval-ms=50",
    ],
  );
  assert.throws(() => parseArguments(["--sample-count", "0"]), /between 1 and 60/);
  assert.equal(parseArguments(["--output", "-"]).outputPath, null);
  assert.throws(() => buildElectronArgs("main.mjs", "https://127.0.0.1:4317/"), { code: "INVALID_GUI_URL" });
  assert.deepEqual(resolveGuiTarget({
    argv: ["electron", "main.mjs", "--footprint-url", "http://127.0.0.1:4317/"],
    env: {},
  }), {
    url: new URL("http://127.0.0.1:4317/"),
    smoke: true,
    footprint: true,
    source: "footprint-argument",
  });
});

test("Electron app metrics aggregate Browser and Tab memory in bytes without process identity", () => {
  const report = aggregateElectronMetrics([
    [
      { type: "Browser", pid: 10, name: "main", memory: { workingSetSize: 100, privateBytes: 60 } },
      { type: "Tab", pid: 11, name: "renderer", memory: { workingSetSize: 200, privateBytes: 120 } },
      { type: "GPU", pid: 12, memory: { workingSetSize: 300, privateBytes: 180 } },
    ],
    [
      { type: "Browser", pid: 20, name: "main", memory: { workingSetSize: 110, privateBytes: 70 } },
      { type: "Tab", pid: 21, name: "renderer", memory: { workingSetSize: 210 } },
    ],
  ]);
  assert.equal(report.source, "electron.app.getAppMetrics");
  assert.deepEqual(report.main.working_set_bytes, {
    sample_count: 2,
    min_bytes: 102_400,
    max_bytes: 112_640,
    mean_bytes: 107_520,
  });
  assert.deepEqual(report.main.private_bytes, {
    sample_count: 2,
    min_bytes: 61_440,
    max_bytes: 71_680,
    mean_bytes: 66_560,
  });
  assert.deepEqual(report.renderer.working_set_bytes, {
    sample_count: 2,
    min_bytes: 204_800,
    max_bytes: 215_040,
    mean_bytes: 209_920,
  });
  assert.deepEqual(report.renderer.private_bytes, {
    sample_count: 1,
    min_bytes: 122_880,
    max_bytes: 122_880,
    mean_bytes: 122_880,
  });
  assert.deepEqual(report.total.working_set_bytes, {
    sample_count: 2,
    min_bytes: 307_200,
    max_bytes: 327_680,
    mean_bytes: 317_440,
  });
  assert.deepEqual(report.total.private_bytes, {
    sample_count: 1,
    min_bytes: 184_320,
    max_bytes: 184_320,
    mean_bytes: 184_320,
  });
  assert.equal(hasUsableElectronMetrics(report), true);
  assert.equal(JSON.stringify(report).includes("pid"), false);
  assert.equal(JSON.stringify(report).includes("renderer"), true);
});

test("Electron footprint redaction removes token, URL, and machine paths", () => {
  const token = "phase0-electron-footprint-auth";
  const windowsRoot = ["D:", "LightPhysics"].join("\\");
  const redacted = redactFootprintText(
    `token=${token} url=http://127.0.0.1:4317/ at ${windowsRoot}\\apps\\electron\\src\\main.mjs`,
    [token],
    windowsRoot,
  );
  assert.equal(redacted.includes(token), false);
  assert.equal(redacted.includes("127.0.0.1:4317"), false);
  assert.equal(redacted.includes(windowsRoot), false);
  assert.equal(redacted.includes("<workspace>"), true);
  assert.equal(redacted.includes("<loopback-url>"), true);
});

test("Electron footprint failure classification remains typed and visible", () => {
  assert.equal(
    classifyElectronFailure({ code: ELECTRON_SMOKE_ERROR_CODES.ELECTRON_NOT_FOUND }),
    ELECTRON_FOOTPRINT_ERROR_CODES.ELECTRON_NOT_FOUND,
  );
  assert.equal(
    classifyElectronFailure(new Error("The display server could not be opened")),
    ELECTRON_FOOTPRINT_ERROR_CODES.DISPLAY_UNAVAILABLE,
  );
  assert.equal(
    classifyElectronFailure(new Error("Electron app.getAppMetrics() failed")),
    ELECTRON_FOOTPRINT_ERROR_CODES.METRICS_UNAVAILABLE,
  );
  assert.equal(classifyFootprintResult(null).code, ELECTRON_FOOTPRINT_ERROR_CODES.FOOTPRINT_RESULT_INVALID);
  assert.equal(classifyFootprintResult({ classification: "ready", metrics: {} }).code, ELECTRON_FOOTPRINT_ERROR_CODES.METRICS_UNAVAILABLE);
  assert.deepEqual(classifyFootprintResult({ classification: "ready", metrics: {
    main: { working_set_bytes: { sample_count: 1 } },
    renderer: { working_set_bytes: { sample_count: 1 } },
  }}), { ok: true, code: null, message: null });
});
