#!/usr/bin/env node

import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const daemonEntry = path.join(root, "apps", "lpd", "src", "main.ts");
const smokeAuth = "phase0-gui-smoke-token";
const startTimeoutMs = 5_000;
const requestTimeoutMs = 5_000;
const shutdownTimeoutMs = 2_500;
const strictCsp = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
const assetPaths = ["/", "/app.js", "/styles.css"];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function closeProbe(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function reserveEphemeralPort() {
  const probe = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", resolve);
    });
    const address = probe.address();
    assert(address && typeof address === "object" && address.port > 0, "could not reserve an ephemeral loopback port");
    return address.port;
  } finally {
    if (probe.listening) await closeProbe(probe);
  }
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
      resolve(exited);
    };
    const onExit = () => finish(true);
    child.once("exit", onExit);
    if (hasExited(child)) finish(true);
  });
}

async function stopDaemon(child) {
  if (hasExited(child)) return;
  try {
    child.kill("SIGTERM");
  } catch {
    // The process may have exited between the state check and the signal.
  }
  if (await waitForExit(child, shutdownTimeoutMs)) return;
  try {
    if (process.platform === "win32") child.kill();
    else child.kill("SIGKILL");
  } catch {
    // The process may have exited while the graceful shutdown was pending.
  }
  await waitForExit(child, shutdownTimeoutMs);
}

async function startDaemon() {
  const port = await reserveEphemeralPort();
  const child = spawn(process.execPath, ["--experimental-strip-types", daemonEntry], {
    cwd: root,
    env: {
      ...process.env,
      LP_BIND: "127.0.0.1",
      LP_IN_CONTAINER: "0",
      LP_LOG_FORMAT: "json",
      LP_LOG_LEVEL: "error",
      LP_PORT: String(port),
      LP_TOKEN: smokeAuth,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stderr?.resume();

  const ready = new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const timer = setTimeout(() => finishReject(new Error("lpd did not become ready in time")), startTimeoutMs);
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
      output += String(chunk);
      const match = /^lpd listening on \[?127\.0\.0\.1\]?:([0-9]+)\s*$/m.exec(output);
      if (!match) return;
      const port = Number(match[1]);
      if (Number.isInteger(port) && port > 0 && port <= 65_535) finishResolve(port);
      else finishReject(new Error("lpd reported an invalid loopback port"));
    };
    const onError = () => finishReject(new Error("lpd could not be started"));
    const onExit = () => finishReject(new Error("lpd exited before becoming ready"));
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });

  return { child, port, ready };
}

async function fetchText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(requestTimeoutMs) });
  return {
    body: await response.text(),
    contentSecurityPolicy: response.headers.get("content-security-policy"),
    contentType: response.headers.get("content-type"),
    status: response.status,
  };
}

async function postRpc(url, authorization) {
  const headers = {
    "content-type": "application/json",
    origin: url,
  };
  if (authorization) headers.authorization = `Bearer ${authorization}`;
  const response = await fetch(`${url}/rpc`, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(requestTimeoutMs),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "system.info",
      params: {},
    }),
  });
  let body;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { body, status: response.status };
}

function assertNoRemoteUrls(asset, assetPath) {
  const remoteUrl = /(?:https?:)?\/\/(?:[a-z0-9-]+\.)+[a-z]{2,}(?::[0-9]+)?(?:[/?#]|$)/i;
  assert(!remoteUrl.test(asset.body), `${assetPath} contains a remote URL`);
}

async function main() {
  console.log("gui-smoke: browser-resource smoke");
  const daemon = await startDaemon();
  let port;
  try {
    port = await daemon.ready;
    const url = `http://127.0.0.1:${port}`;
    const assets = new Map();
    for (const assetPath of assetPaths) {
      const asset = await fetchText(`${url}${assetPath}`);
      assert(asset.status === 200, `${assetPath} did not return HTTP 200`);
      assert(asset.contentSecurityPolicy === strictCsp, `${assetPath} did not return the strict local CSP`);
      assertNoRemoteUrls(asset, assetPath);
      assets.set(assetPath, asset);
    }

    const shell = assets.get("/");
    const shellMarkers = [
      "LightPhysics",
      "Studio Floor",
      'class="sidebar"',
      'class="inspector"',
      'class="statusbar"',
      'id="footer-status"',
      "Daemon offline",
      "Phase 0 · Walking skeleton",
      "Mode A · External agent ready",
      'id="token-form"',
    ];
    for (const marker of shellMarkers) assert(shell.body.includes(marker), `shell marker missing: ${marker}`);

    const app = assets.get("/app.js");
    const appMarkers = [
      'fetch("/rpc"',
      'rpc("system.info")',
      "authorization",
      "elements.daemonVersion",
      "elements.footerStatus",
      "Daemon connected",
    ];
    for (const marker of appMarkers) assert(app.body.includes(marker), `status update marker missing: ${marker}`);

    const unauthorized = await postRpc(url);
    assert(unauthorized.status === 401, "system.info accepted a request without bearer authentication");
    const authorized = await postRpc(url, smokeAuth);
    assert(authorized.status === 200, "authenticated system.info did not return HTTP 200");
    assert(authorized.body?.result?.name === "lpd", "authenticated system.info returned the wrong service");
    assert(authorized.body?.result?.product === "LightPhysics", "authenticated system.info returned the wrong product");
    assert(authorized.body?.result?.bind === "127.0.0.1", "system.info did not report loopback binding");
    assert(authorized.body?.result?.port === port, "system.info did not report the ephemeral daemon port");

    console.log("gui-smoke: daemon ready (loopback, ephemeral port)");
    console.log("gui-smoke: Studio Floor assets fetched over HTTP");
    console.log("gui-smoke: shell/status-bar markers: PASS");
    console.log("gui-smoke: strict CSP and no remote CDN: PASS");
    console.log("gui-smoke: authenticated system.info path: PASS");
    console.log("gui-smoke: PASS");
  } finally {
    await stopDaemon(daemon.child);
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`gui-smoke: FAIL — ${message.replaceAll(smokeAuth, "[redacted]")}`);
  process.exitCode = 1;
}
