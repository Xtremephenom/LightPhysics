import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  GODOT_SMOKE_ERROR_CODES,
  GODOT_SMOKE_MARKER,
  GodotSmokeError,
  buildGodotArgs,
  classifyGodotResult,
  parseCliArgs,
  resolveGodotPath,
} from "../scripts/godot-smoke.mjs";

test("Godot smoke arguments keep boot and syntax checks headless and scoped to the fixture", () => {
  const fixtureDir = path.join(os.tmpdir(), "lightphysics-mini-game");
  assert.deepEqual(buildGodotArgs("boot", fixtureDir), [
    "--headless",
    "--path",
    path.resolve(fixtureDir),
    "--script",
    "res://smoke-entry.gd",
  ]);

  const goodArgs = buildGodotArgs({ mode: "check-valid", fixtureDir });
  assert.deepEqual(goodArgs, [
    "--headless",
    "--path",
    path.resolve(fixtureDir),
    "--check-only",
    "--script",
    "res://check-valid.gd",
  ]);

  const badArgs = buildGodotArgs({ mode: "check-invalid", fixtureDir });
  assert.deepEqual(badArgs, [
    "--headless",
    "--path",
    path.resolve(fixtureDir),
    "--check-only",
    "--script",
    "res://check-invalid.gd",
  ]);
  assert.deepEqual(buildGodotArgs({ mode: "import", fixtureDir }), [
    "--headless",
    "--path",
    path.resolve(fixtureDir),
    "--import",
    "--quit",
  ]);
  assert.notDeepEqual(goodArgs, badArgs);
});

test("CLI parsing accepts an explicit executable and bounded-run options", () => {
  assert.deepEqual(parseCliArgs([
    "--godot",
    "godot",
    "--timeout-ms=2500",
    "--max-output-bytes",
    "2048",
  ]), {
    godotPath: "godot",
    timeoutMs: 2500,
    maxOutputBytes: 2048,
  });
  assert.deepEqual(parseCliArgs(["--import", "--godot", "godot"]), {
    import: true,
    godotPath: "godot",
  });
});

test("Godot resolution honors explicit, environment, and project-local precedence", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "lightphysics-godot-resolution-"));
  try {
    const localPath = path.join(rootDir, "tools", "godot", "godot");
    await mkdir(path.dirname(localPath), { recursive: true });
    await writeFile(localPath, "local fixture executable placeholder");
    assert.equal(resolveGodotPath({ godotPath: "explicit-godot", env: { LP_GODOT: "environment-godot" }, rootDir }), "explicit-godot");
    assert.equal(resolveGodotPath({ env: { LP_GODOT: "environment-godot" }, rootDir }), "environment-godot");
    assert.equal(resolveGodotPath({ env: {}, rootDir }), localPath);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("missing Godot is a typed, actionable error", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "lightphysics-godot-missing-"));
  try {
    assert.throws(
      () => resolveGodotPath({ env: {}, rootDir }),
      (error) => error instanceof GodotSmokeError
        && error.code === GODOT_SMOKE_ERROR_CODES.GODOT_NOT_FOUND
        && error.message.includes("--godot PATH")
        && error.message.includes("never downloads"),
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("result classification requires the boot marker and distinguishes both check-only outcomes", () => {
  assert.deepEqual(
    classifyGodotResult("boot", { code: 0, stdout: `noise\n${GODOT_SMOKE_MARKER}\n` }),
    {
      mode: "boot",
      ok: true,
      classification: "boot-marker",
      expectedExit: "zero",
      message: "headless boot exited 0 and emitted the success marker",
    },
  );
  assert.equal(classifyGodotResult("boot", { code: 0, stdout: "noise" }).classification, "marker-missing");
  assert.equal(classifyGodotResult("check-valid", { code: 0 }).ok, true);
  assert.equal(classifyGodotResult("check-valid", { code: 1 }).ok, false);
  assert.equal(classifyGodotResult("check-invalid", { code: 1 }).ok, true);
  assert.equal(classifyGodotResult("check-invalid", { code: 0 }).classification, "unexpected-success");
  assert.equal(classifyGodotResult("check-invalid", { code: 1, timedOut: true }).ok, false);
  assert.deepEqual(classifyGodotResult("import", { code: 0 }), {
    mode: "import",
    ok: true,
    classification: "import-success",
    expectedExit: "zero",
    message: "headless import exited 0",
  });
  assert.equal(classifyGodotResult("import", { code: 1 }).ok, false);
});
