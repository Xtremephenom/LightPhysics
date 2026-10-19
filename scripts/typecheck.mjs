#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pnpmExec = process.env.npm_execpath && /pnpm/i.test(process.env.npm_execpath);
const packageManager = pnpmExec
  ? { command: process.env.npm_execpath, prefix: [] }
  : { command: process.platform === "win32" ? "corepack.cmd" : "corepack", prefix: ["pnpm"] };

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit", windowsHide: true });
    child.once("error", (error) => {
      console.error(`typecheck: could not start ${command}: ${error.message}`);
      resolve(1);
    });
    child.once("exit", (code, signal) => resolve(signal ? 1 : code ?? 1));
  });
}

if (pnpmExec) {
  const rootCheck = await run(packageManager.command, [...packageManager.prefix, "exec", "tsc", "--noEmit", "-p", "tsconfig.base.json"]);
  const workspaceCheck = await run(packageManager.command, [...packageManager.prefix, "-r", "--if-present", "typecheck"]);
  process.exitCode = rootCheck || workspaceCheck ? 1 : 0;
} else {
  console.log("typecheck: workspace compiler checks require pnpm; checking the bootstrap TypeScript syntax directly");
  process.exitCode = await run(process.execPath, ["--experimental-strip-types", "--check", "tests/bootstrap.test.ts"]);
}
