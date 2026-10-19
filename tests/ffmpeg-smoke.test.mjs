import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  FFMPEG_SMOKE_ERROR_CODES,
  FfmpegSmokeError,
  buildSmokeArgs,
  buildVersionArgs,
  classifyFfmpegResult,
  classifyFfmpegVersion,
  parseCliArgs,
  parseFfmpegVersion,
  runFfmpegCommand,
  runFfmpegSmoke,
} from "../scripts/ffmpeg-smoke.mjs";

test("FFmpeg smoke builds a deterministic lavfi-to-null argv", () => {
  assert.deepEqual(buildVersionArgs(), ["-hide_banner", "-version"]);
  assert.deepEqual(buildSmokeArgs(), [
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
  ]);
  assert.deepEqual(parseCliArgs([
    "--ffmpeg",
    "/opt/ffmpeg/bin/ffmpeg",
    "--timeout-ms=2500",
    "--max-output-bytes",
    "2048",
  ]), {
    help: false,
    ffmpegPath: "/opt/ffmpeg/bin/ffmpeg",
    timeoutMs: 2_500,
    maxOutputBytes: 2_048,
  });
});

test("FFmpeg version parsing accepts the pinned release-branch build and classifies mismatches", () => {
  const output = "ffmpeg version n9.0.2-28-g669f5ab083 Copyright (c) the FFmpeg developers";
  assert.equal(parseFfmpegVersion(output), "9.0.2");
  assert.deepEqual(classifyFfmpegVersion({ code: 0, stdout: output }), {
    ok: true,
    classification: "version-match",
    expectedExit: "zero",
    version: "9.0.2",
    message: "FFmpeg reported version 9.0.2",
  });
  assert.equal(classifyFfmpegVersion({ code: 0, stdout: "ffmpeg version n8.0.0" }).classification, "version-mismatch");
  assert.equal(classifyFfmpegVersion({ code: 1, stderr: "version failed" }).classification, "nonzero-exit");
  assert.equal(classifyFfmpegResult({ timedOut: true }).classification, "timeout");
  assert.equal(classifyFfmpegResult({ code: 1 }).ok, false);
});

test("missing FFmpeg is reported as a typed prerequisite failure", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lightphysics-ffmpeg-missing-"));
  try {
    await assert.rejects(
      runFfmpegSmoke({ ffmpegPath: path.join(directory, "ffmpeg") }),
      (error) => error instanceof FfmpegSmokeError
        && error.code === FFMPEG_SMOKE_ERROR_CODES.FFMPEG_NOT_FOUND
        && error.message.includes("--ffmpeg PATH"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("FFmpeg command execution bounds output and terminates a hung child", async () => {
  const result = await runFfmpegCommand(process.execPath, [
    "-e",
    "process.stdout.write('x'.repeat(1024 * 1024)); setInterval(() => {}, 1000)",
  ], {
    timeoutMs: 500,
    maxOutputBytes: 128,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.outputTruncated, true);
  assert.equal(result.stdout.length <= 128, true);
});
