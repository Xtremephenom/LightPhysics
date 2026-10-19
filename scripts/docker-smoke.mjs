#!/usr/bin/env node
import { spawn } from "node:child_process";
import http from "node:http";

const IMAGE = "lightphysics:runtime";
const CONTAINER_PORT = 4317;
const configuredPort = process.env.LP_SMOKE_PORT?.trim() ?? "0";
let hostPort = configuredPort === "0" ? null : Number(configuredPort);
const START_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;
const root = process.cwd();
const token = (process.env.LP_SMOKE_TOKEN ?? process.env.LP_TOKEN)?.trim();
const containerName = `lightphysics-smoke-${process.pid}-${Date.now().toString(36)}`;

function assertPort() {
  const numericPort = Number(configuredPort);
  if (!/^\d+$/.test(configuredPort) || !Number.isInteger(numericPort) || numericPort < 0 || numericPort > 65_535) {
    throw new Error("LP_SMOKE_PORT must be 0 (Docker chooses) or an integer between 1 and 65535");
  }
}

function redact(value) {
  return token ? value.split(token).join("[redacted]") : value;
}

function runDocker(args, { allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      cwd: root,
      env: { ...process.env, ...(token ? { LP_TOKEN: token } : {}) },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => {
      if (allowFailure) resolve({ code: 1, stdout: "", stderr: error.message });
      else reject(error);
    });
    child.once("exit", (code, signal) => {
      const result = {
        code: signal ? 1 : code ?? 1,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      };
      if (!allowFailure && result.code !== 0) {
        reject(new Error(redact(result.stderr || "Docker command failed")));
      } else {
        resolve(result);
      }
    });
  });
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function inspectHealth() {
  const result = await runDocker([
    "inspect",
    `--format={{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}`,
    containerName,
  ], { allowFailure: true });
  if (result.code !== 0) return { status: "missing", health: "missing" };
  const [status, health = "none"] = result.stdout.split("|");
  return { status, health };
}

async function waitForHealthy() {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = await inspectHealth();
    if (state.health === "healthy") return;
    if (state.status === "exited" || state.status === "dead" || state.status === "missing") {
      throw new Error(`container did not become healthy (${state.status}/${state.health})`);
    }
    if (state.health === "unhealthy") {
      throw new Error("container healthcheck reported unhealthy");
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error("timed out waiting for the container healthcheck");
}

async function resolvePublishedPort() {
  if (hostPort !== null) return hostPort;
  const result = await runDocker(["port", containerName, `${CONTAINER_PORT}/tcp`]);
  const match = /:(\d+)\s*$/m.exec(result.stdout);
  const published = match ? Number(match[1]) : NaN;
  if (!Number.isInteger(published) || published < 1 || published > 65_535) {
    throw new Error("Docker did not report a valid loopback host port");
  }
  hostPort = published;
  return published;
}

async function rpc(tokenValue) {
  const requestBody = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "system.info",
    params: {},
  });
  return await new Promise((resolve, reject) => {
    const request = http.request({
      hostname: "127.0.0.1",
      port: hostPort,
      path: "/rpc",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(requestBody),
        // The daemon validates Host against its container listen port. Keep
        // that internal authority while connecting through a loopback-only
        // host-port mapping (which may be overridden for a busy host port).
        Host: `127.0.0.1:${CONTAINER_PORT}`,
        ...(tokenValue ? { authorization: `Bearer ${tokenValue}` } : {}),
      },
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.once("end", () => {
        try {
          resolve({ status: response.statusCode ?? 0, body: JSON.parse(body) });
        } catch {
          reject(new Error("daemon returned invalid JSON"));
        }
      });
    });
    request.setTimeout(2_000, () => request.destroy(new Error("request timed out")));
    request.once("error", reject);
    request.end(requestBody);
  });
}

async function verifyAuthenticatedInfo() {
  const unauthenticated = await rpc(undefined);
  if (unauthenticated.status !== 401) {
    throw new Error(`expected unauthenticated system.info to return 401, got ${unauthenticated.status}`);
  }
  const authenticated = await rpc(token);
  if (authenticated.status !== 200 || authenticated.body?.result?.name !== "lpd") {
    throw new Error("authenticated system.info did not return the lpd result");
  }
}

async function cleanup() {
  const stopped = await runDocker(["stop", "--time", "5", containerName], { allowFailure: true });
  const stopError = stopped.code !== 0 && !/no such container|is not running/i.test(stopped.stderr);
  const removed = await runDocker(["rm", "--force", containerName], { allowFailure: true });
  const removeError = removed.code !== 0 && !/no such container/i.test(removed.stderr);
  if (stopError || removeError) {
    const details = [stopped.stderr, removed.stderr].filter(Boolean).join("; ");
    throw new Error(`container cleanup failed${details ? `: ${redact(details)}` : ""}`);
  }
}

async function main() {
  assertPort();
  if (!token) {
    console.error("docker-smoke: supply a smoke token with LP_TOKEN (or LP_SMOKE_TOKEN)");
    return 2;
  }

  // Set this before docker run: Docker can create a stopped/Created container
  // and still return an error (for example, when the host port is occupied).
  // cleanup() is idempotent and removes that container too.
  let needsCleanup = true;
  try {
    await runDocker([
      "run",
      "--detach",
      "--init",
      "--name",
      containerName,
      "--env",
      "LP_TOKEN",
      "--publish",
       `127.0.0.1:${configuredPort}:${CONTAINER_PORT}`,
       IMAGE,
     ]);
    await waitForHealthy();
    await resolvePublishedPort();
    await verifyAuthenticatedInfo();
    console.log(`docker-smoke: authenticated system.info passed (host port ${hostPort})`);
    return 0;
  } finally {
    if (needsCleanup) await cleanup();
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(`docker-smoke: ${redact(error instanceof Error ? error.message : String(error))}`);
  process.exitCode = 1;
}
