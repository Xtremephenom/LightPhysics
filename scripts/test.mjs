#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fast = process.argv.includes("--fast");
const checks = [
  ["path-scan", "scripts/path-scan.mjs"],
  ["secret-scan", "scripts/secret-scan.mjs"],
  ["env-sync", "scripts/env-sync.mjs", "--check"],
  ["ledger-lint", "scripts/ledger-lint.mjs"],
  ["adr-lint", "scripts/adr-lint.mjs"],
  ["state-lint", "scripts/state-lint.mjs"],
  ["pin-check", "scripts/pin-check.mjs"],
  ["db-spike", "scripts/db-spike.mjs"],
  ["config-lint", "scripts/config-lint.mjs"],
  ["catalog-lint", "scripts/catalog-lint.mjs"],
  ["gui-smoke", "scripts/gui-smoke.mjs"],
];

function run(label, script, ...args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: root,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", (error) => {
      console.error(`${label}: could not start: ${error.message}`);
      resolve(1);
    });
    child.once("exit", (code, signal) => {
      if (signal) {
        console.error(`${label}: terminated by ${signal}`);
        resolve(1);
      } else resolve(code ?? 1);
    });
  });
}

function runPackageManager(label, ...args) {
  const pnpmExec = process.env.npm_execpath && /pnpm/i.test(process.env.npm_execpath);
  const command = pnpmExec
    ? process.env.npm_execpath
    : process.platform === "win32"
      ? "corepack.cmd"
      : "corepack";
  const prefix = pnpmExec ? [] : ["pnpm"];
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, [...prefix, ...args], {
        cwd: root,
        stdio: "inherit",
        windowsHide: true,
      });
    } catch (error) {
      console.error(`${label}: could not start: ${error instanceof Error ? error.message : String(error)}`);
      resolve(1);
      return;
    }
    child.once("error", (error) => {
      console.error(`${label}: could not start: ${error.message}`);
      resolve(1);
    });
    child.once("exit", (code, signal) => resolve(signal ? 1 : code ?? 1));
  });
}

let failures = 0;
for (const [label, script, ...args] of checks) failures += await run(label, script, ...args);
if (process.env.npm_execpath && /pnpm/i.test(process.env.npm_execpath)) {
  failures += await runPackageManager("root-typecheck", "exec", "tsc", "--noEmit", "-p", "tsconfig.base.json");
  failures += await runPackageManager("workspace-typecheck", "-r", "--if-present", "typecheck");
  failures += await runPackageManager("workspace-tests", "-r", "--if-present", "test");
} else {
  console.log("workspace checks: SKIPPED (run through pnpm to use the installed workspace toolchain)");
}
failures += await run(
  "root-tests",
  "--experimental-strip-types",
  "--test",
  "tests/bootstrap.test.ts",
  "tests/db-spike.test.mjs",
  "tests/footprint.test.mjs",
  "tests/godot-smoke.test.mjs",
  "tests/electron-shell.test.mjs",
  "tests/electron-footprint.test.mjs",
  "tests/install-tools.test.mjs",
  "tests/ffmpeg-smoke.test.mjs",
  "tests/forge-consult-demo.test.mjs",
);

if (failures > 0) {
  console.error(`test: ${failures} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log(`test: offline bootstrap checks passed${fast ? " (fast)" : ""}`);
}
