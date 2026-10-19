import { app, BrowserWindow, dialog, ipcMain, safeStorage } from "electron";
import { fileURLToPath } from "node:url";
import {
  aggregateElectronMetrics,
  hasUsableElectronMetrics,
  parseFootprintOptions,
} from "./footprint.mjs";
import {
  ElectronShellError,
  RENDERER_MARKERS,
  SHELL_ERROR_CODES,
  classifyRendererObservation,
  isAllowedGuiNavigation,
  isLoopbackGuiUrl,
  resolveGuiTarget,
} from "./security.mjs";
import { createMainHumanChannelController } from "./human-channel-controller.mjs";
import { createElectronHumanChannelMainBootstrap } from "./human-channel-listener.mjs";

const preloadPath = fileURLToPath(new URL("./preload.mjs", import.meta.url));
const smokeResultPrefix = "electron-shell: smoke-result ";
const footprintReadyPrefix = "electron-shell: footprint-ready ";
const footprintResultPrefix = "electron-shell: footprint-result ";
const humanChannelStatusChannel = "lightphysics:security-control-status";
const humanChannelEnrollmentChannel = "lightphysics:security-control-enroll";

// These references are intentionally private to the Electron main module. The
// renderer receives only the narrow status/enrollment request seam below; it
// never receives the controller or any approval capability.
let humanChannelMainController;
let humanChannelMainListener;
let humanChannelControlWindow;
let humanChannelControlInstalled = false;
let humanChannelSetupFailed = false;

function unavailableHumanChannelStatus() {
  return Object.freeze({ available: false, state: "unavailable" });
}

function boundedHumanChannelStatus() {
  if (humanChannelMainListener === undefined || humanChannelSetupFailed) {
    return unavailableHumanChannelStatus();
  }
  try {
    return Object.freeze({ available: true, ...humanChannelMainListener.status() });
  } catch {
    return unavailableHumanChannelStatus();
  }
}

function assertHumanChannelSender(event) {
  if (humanChannelControlWindow === undefined || event.sender !== humanChannelControlWindow.webContents) {
    throw new Error("Human Channel control request rejected");
  }
}

function boundedControlFailure(error) {
  const code = typeof error?.code === "string" && error.code.length < 128
    ? error.code
    : "ELECTRON_HUMAN_CHANNEL_UNAVAILABLE";
  return Object.freeze({ ok: false, code, status: boundedHumanChannelStatus() });
}

/**
 * Install the narrow renderer-facing request seam. It exposes only bounded
 * status and a native-dialog enrollment request; the listener, signer, key,
 * signed evidence, and approval/grant operations remain main-process-only.
 */
function installHumanChannelMainControl(window) {
  if (humanChannelControlInstalled) return;
  humanChannelControlWindow = window;
  try {
    installHumanChannelMainListener({ parentWindow: window });
  } catch {
    humanChannelSetupFailed = true;
  }

  ipcMain.handle(humanChannelStatusChannel, (event) => {
    assertHumanChannelSender(event);
    return boundedHumanChannelStatus();
  });
  ipcMain.handle(humanChannelEnrollmentChannel, (event) => {
    assertHumanChannelSender(event);
    if (humanChannelMainListener === undefined || humanChannelSetupFailed) {
      return boundedControlFailure(undefined);
    }
    try {
      humanChannelMainListener.enroll();
      return Object.freeze({ ok: true, status: boundedHumanChannelStatus() });
    } catch (error) {
      return boundedControlFailure(error);
    }
  });
  humanChannelControlInstalled = true;
}

/**
 * Main-process bootstrap seam for the already-created Warden channel and
 * device signer. Enrollment confirmation is supplied by the main process;
 * this function never returns key material, a signer, or a signed approval.
 */
export function installHumanChannelMainController(dependencies) {
  if (humanChannelMainController !== undefined) throw new Error("Human Channel main controller is already installed");
  humanChannelMainController = createMainHumanChannelController(dependencies);
  return humanChannelMainController.status();
}

/**
 * Optional main-process bootstrap for the Electron listener seam. The
 * listener factory supplies the built-in JavaScript Warden-compatible adapter
 * for the packaged path; custom injected adapters remain explicitly marked as
 * an unqualified test seam. Nothing from this listener is placed on the
 * renderer or an approval IPC route.
 */
export function installHumanChannelMainListener(options) {
  if (humanChannelMainListener !== undefined) {
    throw new Error("Human Channel main listener is already installed");
  }
  const bootstrap = createElectronHumanChannelMainBootstrap({
    ...options,
    safeStorage: options?.safeStorage ?? safeStorage,
    dialog: options?.dialog ?? dialog,
    userDataPath: options?.userDataPath ?? app.getPath("userData"),
    parentWindow: options?.parentWindow,
  });
  humanChannelMainListener = bootstrap.listener;
  return Object.freeze({
    qualified: bootstrap.qualified,
    qualification: bootstrap.qualification,
    status: bootstrap.status,
  });
}

function createShellWindow(target) {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    show: true,
    backgroundColor: "#0d0f14",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: preloadPath,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    },
  });

  const denyExternalNavigation = (event, navigationUrl) => {
    if (!isAllowedGuiNavigation(navigationUrl, target.url)) event.preventDefault();
  };
  window.webContents.on("will-navigate", denyExternalNavigation);
  window.webContents.on("will-redirect", denyExternalNavigation);
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  return window;
}

async function observeRenderer(window, target) {
  const observation = await window.webContents.executeJavaScript(`(async () => {
    const selectors = Object.fromEntries(${JSON.stringify(RENDERER_MARKERS.selectors)}.map((selector) => [selector, Boolean(document.querySelector(selector))]));
    const texts = Object.fromEntries(${JSON.stringify(RENDERER_MARKERS.selectors)}.map((selector) => [selector, document.querySelector(selector)?.textContent?.replace(/\\s+/g, " ").trim() ?? ""]));
    const response = await fetch(window.location.href, { cache: "no-store" });
    return {
      title: document.title,
      url: window.location.href,
      sameOrigin: window.location.origin === new URL(window.location.href).origin,
      csp: response.headers.get("content-security-policy"),
      selectors,
      texts,
    };
  })()`, true);
  return {
    ...observation,
    loopback: isLoopbackGuiUrl(observation?.url),
    sameOrigin: observation?.sameOrigin === true && isAllowedGuiNavigation(observation?.url, target.url),
  };
}

async function runSmoke(window, target) {
  const observation = await observeRenderer(window, target);
  const classification = classifyRendererObservation(observation, target.url);
  if (!classification.ok) {
    throw new ElectronShellError(
      SHELL_ERROR_CODES.RENDERER_CHECK_FAILED,
      `Rendered Studio Floor checks failed: ${classification.failures.join("; ")}`,
      "Inspect the existing lpd-served GUI markers and strict local CSP.",
    );
  }
  // Keep the machine-readable result deliberately small: it contains only
  // renderer markers and security observations, never page content or secrets.
  console.log(`${smokeResultPrefix}${JSON.stringify({
    title: observation.title,
    url: observation.url,
    sameOrigin: observation.sameOrigin,
    loopback: observation.loopback,
    csp: observation.csp,
    selectors: observation.selectors,
    texts: observation.texts,
    classification: classification.classification,
  })}`);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function runFootprint(window, target) {
  const options = parseFootprintOptions(process.argv);
  const observation = await observeRenderer(window, target);
  const classification = classifyRendererObservation(observation, target.url);
  if (!classification.ok) {
    throw new ElectronShellError(
      SHELL_ERROR_CODES.RENDERER_CHECK_FAILED,
      `Rendered Studio Floor checks failed: ${classification.failures.join("; ")}`,
      "Inspect the existing lpd-served GUI markers and strict local CSP.",
    );
  }

  // This readiness line is separate from the final result so the harness can
  // measure cold start to a loaded Studio Floor before idle sampling begins.
  // It contains no URL, page text, or process identifiers.
  console.log(`${footprintReadyPrefix}${JSON.stringify({
    classification: classification.classification,
    sameOrigin: observation.sameOrigin === true,
    loopback: observation.loopback === true,
  })}`);

  const samples = [];
  for (let index = 0; index < options.sampleCount; index += 1) {
    if (index > 0) await sleep(options.sampleIntervalMs);
    try {
      samples.push(app.getAppMetrics());
    } catch (error) {
      throw new ElectronShellError(
        SHELL_ERROR_CODES.METRICS_UNAVAILABLE,
        `Electron app.getAppMetrics() failed: ${error instanceof Error ? error.message : String(error)}`,
        "Retry the opt-in footprint on the pinned Electron runtime.",
      );
    }
  }
  const metrics = aggregateElectronMetrics(samples);
  if (!hasUsableElectronMetrics(metrics)) {
    throw new ElectronShellError(
      SHELL_ERROR_CODES.METRICS_UNAVAILABLE,
      "Electron app.getAppMetrics() did not expose both Browser and Tab working-set readings",
      "Retry on a display session where the Electron main and Studio Floor renderer processes remain available.",
    );
  }
  console.log(`${footprintResultPrefix}${JSON.stringify({
    classification: classification.classification,
    sample_count: options.sampleCount,
    sample_interval_ms: options.sampleIntervalMs,
    metrics,
  })}`);
}

function formatError(error) {
  if (error instanceof ElectronShellError) {
    return `${error.name} [${error.code}]: ${error.message}. ${error.suggestedNext}`;
  }
  return error instanceof Error ? error.message : String(error);
}

async function start() {
  const target = resolveGuiTarget({ argv: process.argv, env: process.env });
  const window = createShellWindow(target);
  installHumanChannelMainControl(window);
  try {
    await window.loadURL(target.url.toString());
    if (target.footprint) await runFootprint(window, target);
    else if (target.smoke) await runSmoke(window, target);
    return window;
  } catch (error) {
    throw error instanceof ElectronShellError
      ? error
      : new ElectronShellError(
        SHELL_ERROR_CODES.INVALID_GUI_URL,
        `The validated GUI could not be loaded: ${formatError(error)}`,
        "Verify that authenticated lpd is serving the loopback Studio Floor URL.",
        error,
      );
  } finally {
    if (target.smoke) window.close();
  }
}

app.whenReady().then(async () => {
  try {
    const window = await start();
    const target = resolveGuiTarget({ argv: process.argv, env: process.env });
    if (target.smoke) {
      app.quit();
      return;
    }
    window.on("closed", () => undefined);
  } catch (error) {
    console.error(`electron-shell: FAIL ${formatError(error)}`);
    app.exit(1);
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  // The renderer has no quit or navigation capability. Main-process lifecycle
  // remains the sole owner of the desktop window.
});
