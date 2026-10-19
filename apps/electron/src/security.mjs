const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export const STRICT_LOCAL_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

export const RENDERER_MARKERS = Object.freeze({
  title: "LightPhysics — Studio Floor",
  selectors: Object.freeze(["#studio-floor", ".statusbar", "#footer-status", "#connection-label"]),
  texts: Object.freeze([
    Object.freeze({ selector: "#footer-status", includes: "Daemon offline" }),
    Object.freeze({ selector: "#connection-label", includes: "Not connected" }),
    Object.freeze({ selector: ".statusbar", includes: "Mode A · External agent ready" }),
    Object.freeze({ selector: ".statusbar", includes: "Phase 0 · Walking skeleton" }),
  ]),
});

export const SHELL_ERROR_CODES = Object.freeze({
  GUI_URL_REQUIRED: "GUI_URL_REQUIRED",
  INVALID_GUI_URL: "INVALID_GUI_URL",
  RENDERER_CHECK_FAILED: "RENDERER_CHECK_FAILED",
  METRICS_UNAVAILABLE: "METRICS_UNAVAILABLE",
});

export class ElectronShellError extends Error {
  constructor(code, message, suggestedNext) {
    super(message);
    this.name = "ElectronShellError";
    this.code = code;
    this.suggestedNext = suggestedNext;
  }
}

function normalizeLoopbackHostname(hostname) {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "");
}

function invalidGuiUrl(message) {
  return new ElectronShellError(
    SHELL_ERROR_CODES.INVALID_GUI_URL,
    message,
    "Use LP_GUI_URL, --smoke-url, or --footprint-url with an http://localhost, http://127.0.0.1, or http://[::1] URL.",
  );
}

/**
 * Validate the only URL class the shell may load or navigate to. The check is
 * intentionally based on the literal hostname rather than a DNS lookup so a
 * public hostname cannot be smuggled into the desktop shell.
 */
export function validateLoopbackGuiUrl(value) {
  if (value instanceof URL) return validateLoopbackGuiUrl(value.toString());
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw invalidGuiUrl("The GUI URL must be a non-empty URL without surrounding whitespace");
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw invalidGuiUrl("The GUI URL is not a valid absolute URL");
  }
  if (parsed.protocol !== "http:") {
    throw invalidGuiUrl("The GUI URL must use http:// because lpd serves the local Studio Floor over HTTP");
  }
  if (parsed.username || parsed.password) {
    throw invalidGuiUrl("The GUI URL must not contain username or password credentials");
  }
  if (!LOOPBACK_HOSTS.has(normalizeLoopbackHostname(parsed.hostname))) {
    throw invalidGuiUrl("The GUI URL hostname must be localhost, 127.0.0.1, or ::1");
  }
  if (parsed.port && (!/^\d+$/.test(parsed.port) || Number(parsed.port) < 1 || Number(parsed.port) > 65_535)) {
    throw invalidGuiUrl("The GUI URL port must be between 1 and 65535");
  }
  return new URL(parsed.toString());
}

export function isLoopbackGuiUrl(value) {
  try {
    validateLoopbackGuiUrl(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Navigation is allowed only when it stays on the exact validated loopback
 * origin selected at startup. New windows are denied by the main process even
 * when their URL is local; this predicate is for same-window navigation.
 */
export function isAllowedGuiNavigation(candidate, allowed) {
  try {
    const candidateUrl = validateLoopbackGuiUrl(candidate);
    const allowedUrl = validateLoopbackGuiUrl(allowed);
    return candidateUrl.origin === allowedUrl.origin;
  } catch {
    return false;
  }
}

function readUrlArgument(argv) {
  let selected;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (
      argument !== "--gui-url"
      && argument !== "--smoke-url"
      && argument !== "--footprint-url"
      && !argument.startsWith("--gui-url=")
      && !argument.startsWith("--smoke-url=")
      && !argument.startsWith("--footprint-url=")
    ) continue;

    const isSmoke = argument === "--smoke-url" || argument.startsWith("--smoke-url=");
    const isFootprint = argument === "--footprint-url" || argument.startsWith("--footprint-url=");
    const inlineValue = argument.includes("=") ? argument.slice(argument.indexOf("=") + 1) : undefined;
    const value = inlineValue ?? argv[index + 1];
    if (inlineValue === undefined) index += 1;
    if (!value) {
      throw new ElectronShellError(
        SHELL_ERROR_CODES.INVALID_GUI_URL,
        `${isFootprint ? "--footprint-url" : isSmoke ? "--smoke-url" : "--gui-url"} requires a URL value`,
        "Pass a complete loopback URL, for example --footprint-url http://127.0.0.1:4317/.",
      );
    }
    if (selected) {
      throw new ElectronShellError(
        SHELL_ERROR_CODES.INVALID_GUI_URL,
        "Only one GUI URL source may be supplied",
        "Use either LP_GUI_URL, --gui-url, or --smoke-url, not more than one.",
      );
    }
    selected = {
      value,
      smoke: isSmoke || isFootprint,
      ...(isFootprint ? { footprint: true } : {}),
      source: isFootprint ? "footprint-argument" : isSmoke ? "smoke-argument" : "argument",
    };
  }
  return selected;
}

export function resolveGuiTarget({ argv = [], env = process.env } = {}) {
  const argument = readUrlArgument(argv);
  const configured = argument?.value ?? env.LP_GUI_URL;
  if (!configured) {
    throw new ElectronShellError(
      SHELL_ERROR_CODES.GUI_URL_REQUIRED,
      "No GUI URL was configured for the Electron shell",
        "Set LP_GUI_URL to a loopback Studio Floor URL or pass --smoke-url/--footprint-url for an opt-in harness.",
    );
  }
  return {
    url: validateLoopbackGuiUrl(configured),
    smoke: argument?.smoke === true,
    ...(argument?.footprint === true ? { footprint: true } : {}),
    source: argument?.source ?? "environment",
  };
}

function observationFailure(classification, failures) {
  return { ok: false, classification, failures };
}

export function classifyRendererObservation(observation, expectedUrl) {
  if (!observation || typeof observation !== "object") {
    return observationFailure("observation-invalid", ["Electron did not return a renderer observation"]);
  }

  let expected;
  try {
    expected = validateLoopbackGuiUrl(expectedUrl);
  } catch (error) {
    return observationFailure("expected-url-invalid", [error instanceof Error ? error.message : String(error)]);
  }

  const failures = [];
  if (observation.title !== RENDERER_MARKERS.title) failures.push(`title must be ${RENDERER_MARKERS.title}`);

  let actual;
  try {
    actual = validateLoopbackGuiUrl(observation.url);
  } catch {
    failures.push("renderer URL is not a validated loopback URL");
  }
  if (actual && actual.origin !== expected.origin) failures.push("renderer URL origin differs from the configured GUI origin");
  if (observation.sameOrigin !== true) failures.push("renderer did not report a same-origin URL");
  if (observation.loopback !== true) failures.push("renderer did not report a loopback URL");
  if (observation.csp !== STRICT_LOCAL_CSP) failures.push("renderer response did not expose the strict local CSP");

  const selectors = observation.selectors;
  for (const selector of RENDERER_MARKERS.selectors) {
    if (selectors?.[selector] !== true) failures.push(`renderer selector missing: ${selector}`);
  }

  const texts = observation.texts;
  for (const marker of RENDERER_MARKERS.texts) {
    const value = typeof texts?.[marker.selector] === "string" ? texts[marker.selector] : "";
    if (!value.includes(marker.includes)) failures.push(`renderer text missing: ${marker.includes}`);
  }

  return failures.length === 0
    ? { ok: true, classification: "ready", failures: [] }
    : observationFailure(failures.some((failure) => failure.startsWith("renderer selector")) ? "marker-missing" : "renderer-check-failed", failures);
}
