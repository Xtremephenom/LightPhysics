import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect, test } from "@playwright/test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const daemonEntry = path.join(root, "apps", "lpd", "src", "main.ts");
const testToken = "test-only-studio-floor-token";
const strictCsp = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
const startTimeoutMs = 10_000;
const shutdownTimeoutMs = 2_500;

function assertPort(value) {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`lpd reported an invalid port: ${String(value)}`);
  }
  return value;
}

function isExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function reserveLoopbackPort() {
  const probe = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", resolve);
    });
    const address = probe.address();
    if (!address || typeof address !== "object") throw new Error("could not reserve a loopback port");
    return assertPort(address.port);
  } finally {
    if (probe.listening) await closeServer(probe);
  }
}

function waitForExit(child, timeoutMs) {
  if (isExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.off("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
    if (isExited(child)) finish(true);
  });
}

async function stopDaemon(child) {
  if (isExited(child)) return;
  try {
    child.kill("SIGTERM");
  } catch {
    // The process may have exited between the state check and the signal.
  }
  if (await waitForExit(child, shutdownTimeoutMs)) return;
  try {
    child.kill();
  } catch {
    // The process may have exited while the graceful shutdown was pending.
  }
  await waitForExit(child, shutdownTimeoutMs);
}

async function startDaemon() {
  // Reserve an OS-assigned loopback port before spawning so the test does not
  // depend on a fixed developer-machine port.
  const port = await reserveLoopbackPort();
  const child = spawn(process.execPath, ["--experimental-strip-types", daemonEntry], {
    cwd: root,
    env: {
      ...process.env,
      LP_BIND: "127.0.0.1",
      LP_IN_CONTAINER: "0",
      LP_LOG_FORMAT: "json",
      LP_LOG_LEVEL: "error",
      LP_PORT: String(port),
      LP_TOKEN: testToken,
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
    const finishResolve = (reportedPort) => finish(() => resolve(reportedPort));
    const finishReject = (error) => finish(() => reject(error));
    const onData = (chunk) => {
      output += String(chunk);
      const match = /^lpd listening on \[?127\.0\.0\.1\]?:([0-9]+)\s*$/m.exec(output);
      if (match) finishResolve(assertPort(Number(match[1])));
    };
    const onError = () => finishReject(new Error("lpd could not be started"));
    const onExit = () => finishReject(new Error("lpd exited before becoming ready"));
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });

  try {
    const reportedPort = await ready;
    return { child, port: reportedPort };
  } catch (error) {
    await stopDaemon(child);
    throw error;
  }
}

function isSystemInfoResponse(response, rpcUrl) {
  if (response.url() !== rpcUrl || response.request().method() !== "POST") return false;
  try {
    return response.request().postDataJSON()?.method === "system.info";
  } catch {
    return false;
  }
}

function remoteNetworkRequests(requests, origin) {
  return requests.filter((requestUrl) => {
    let parsed;
    try {
      parsed = new URL(requestUrl);
    } catch {
      return true;
    }
    if (parsed.protocol === "data:" || parsed.protocol === "about:") return false;
    return parsed.origin !== origin;
  });
}

test("Studio Floor connects through the browser to live system.info", async () => {
  const daemon = await startDaemon();
  let browser;
  let context;
  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
    const page = await context.newPage();
    const networkRequests = [];
    page.on("request", (request) => networkRequests.push(request.url()));

    const baseUrl = `http://127.0.0.1:${daemon.port}`;
    const origin = new URL(baseUrl).origin;
    const rpcUrl = `${baseUrl}/rpc`;
    const shellResponse = await page.goto(baseUrl, { waitUntil: "networkidle" });
    expect(shellResponse).not.toBeNull();
    expect(shellResponse.headers()["content-security-policy"]).toBe(strictCsp);
    await expect(page).toHaveTitle("LightPhysics — Studio Floor");
    await expect(page.locator("#connection-label")).toHaveText("Not connected");
    await expect(page.locator("#footer-status")).toHaveText("Daemon offline");
    await expect(page.locator("#daemon-version")).toHaveText("Offline");

    const unauthenticated = await page.evaluate(async () => {
      const response = await fetch("/rpc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "unauthenticated-browser-check",
          method: "system.info",
          params: {},
        }),
      });
      return { body: await response.json(), status: response.status };
    });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.body.error.data.code).toBe("Unauthorized");

    const connectResponsePromise = page.waitForResponse((response) => isSystemInfoResponse(response, rpcUrl));
    await page.locator("#token-input").fill(testToken);
    await page.locator("#token-form button[type=submit]").click();
    const connectResponse = await connectResponsePromise;
    expect(connectResponse.status()).toBe(200);
    expect(connectResponse.request().headers().authorization).toBe(`Bearer ${testToken}`);
    const liveInfo = (await connectResponse.json()).result;
    expect(liveInfo).toMatchObject({
      name: "lpd",
      product: "LightPhysics",
      version: "0.1.0",
      bind: "127.0.0.1",
      port: daemon.port,
    });
    expect(liveInfo.pid).toBeGreaterThan(0);

    await expect(page.locator("#connection-label")).toHaveText("Connected: lpd");
    await expect(page.locator("#footer-status")).toHaveText("Daemon connected");
    await expect(page.locator("#inspector-status")).toHaveText("Connected");
    await expect(page.locator("#daemon-version")).toHaveText(liveInfo.version);
    await expect(page.locator("#daemon-platform")).toHaveText(`${liveInfo.platform} · ${liveInfo.nodeVersion}`);
    await expect(page.locator("#inspector-version")).toHaveText(liveInfo.version);
    await expect(page.locator("#inspector-platform")).toHaveText(`${liveInfo.platform} · ${liveInfo.arch}`);
    await expect(page.locator("#resume-status")).not.toHaveText("Connect to load the project memory brief.");
    await expect(page.locator("#security")).toContainText("Human authority stays local");
    await expect(page.locator("#security")).toContainText("Unavailable");
    await expect(page.locator("#security-human-status")).toHaveText("Electron shell required");
    await expect(page.locator("#human-channel-enroll")).toBeDisabled();
    expect(await page.evaluate(() => Object.keys(window.lightPhysicsShell ?? {}))).toEqual([]);
    expect(await page.evaluate(() => typeof window.lightPhysicsShell?.securityControl?.recordDecision)).toBe("undefined");

    const forgedApproval = await page.evaluate(async (token) => {
      const response = await fetch("/rpc", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "renderer-forged-approval",
          method: "approval.submit",
          params: { decision: "approve" },
        }),
      });
      return { body: await response.json(), status: response.status };
    }, testToken);
    expect(forgedApproval.status).toBe(200);
    expect(forgedApproval.body.error.data.code).toBe("MethodNotFound");

    const refreshResponsePromise = page.waitForResponse((response) => isSystemInfoResponse(response, rpcUrl));
    await page.getByRole("button", { name: "Refresh daemon status" }).click();
    const refreshResponse = await refreshResponsePromise;
    expect(refreshResponse.status()).toBe(200);
    expect(refreshResponse.request().headers().authorization).toBe(`Bearer ${testToken}`);
    expect((await refreshResponse.json()).result).toMatchObject({
      name: "lpd",
      product: "LightPhysics",
      port: daemon.port,
    });
    await expect(page.locator("#connection-label")).toHaveText("Connected: lpd");
    await expect(page.locator("#footer-status")).toHaveText("Daemon connected");

    expect(remoteNetworkRequests(networkRequests, origin)).toEqual([]);
    expect(networkRequests).toContain(`${baseUrl}/styles.css`);
    expect(networkRequests).toContain(`${baseUrl}/app.js`);
  } finally {
    await context?.close();
    await browser?.close();
    await stopDaemon(daemon.child);
  }
});
