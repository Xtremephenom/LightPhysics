#!/usr/bin/env node
import { spawn } from "node:child_process";

const token = process.env.LP_TOKEN?.trim();
if (!token) {
  console.error("docker-run: LP_TOKEN is required; set it in the invoking environment");
  process.exitCode = 2;
} else {
  const child = spawn("docker", [
    "run",
    "--rm",
    "--init",
    "--env",
    "LP_TOKEN",
    "--publish",
    "127.0.0.1:4317:4317",
    "lightphysics:runtime",
  ], {
    cwd: process.cwd(),
    env: { ...process.env, LP_TOKEN: token },
    stdio: "inherit",
    windowsHide: true,
  });
  child.once("error", (error) => {
    console.error(`docker-run: ${error.message}`);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    process.exitCode = signal ? 1 : code ?? 1;
  });
}
