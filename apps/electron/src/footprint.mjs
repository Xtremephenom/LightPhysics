export const ELECTRON_FOOTPRINT_DEFAULTS = Object.freeze({
  sampleCount: 5,
  sampleIntervalMs: 100,
});

export const ELECTRON_FOOTPRINT_ERROR_CODES = Object.freeze({
  INVALID_ARGUMENT: "INVALID_ARGUMENT",
  METRICS_UNAVAILABLE: "METRICS_UNAVAILABLE",
});

export class ElectronFootprintOptionError extends Error {
  constructor(message) {
    super(message);
    this.name = "ElectronFootprintOptionError";
    this.code = ELECTRON_FOOTPRINT_ERROR_CODES.INVALID_ARGUMENT;
  }
}

function parseBoundedInteger(value, label, minimum, maximum) {
  if (!/^\d+$/.test(value)) {
    throw new ElectronFootprintOptionError(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ElectronFootprintOptionError(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function readOptionValue(argv, index, argument, inlinePrefix) {
  if (argument.startsWith(`${inlinePrefix}=`)) {
    return { value: argument.slice(inlinePrefix.length + 1), nextIndex: index };
  }
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new ElectronFootprintOptionError(`${inlinePrefix} requires a numeric value`);
  }
  return { value, nextIndex: index + 1 };
}

/**
 * Parse only the footprint flags. Electron adds its own Chromium arguments,
 * so unrelated argv entries are deliberately ignored here.
 */
export function parseFootprintOptions(argv = []) {
  const options = { ...ELECTRON_FOOTPRINT_DEFAULTS };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--footprint-sample-count" || argument.startsWith("--footprint-sample-count=")) {
      const read = readOptionValue(argv, index, argument, "--footprint-sample-count");
      options.sampleCount = parseBoundedInteger(read.value, "--footprint-sample-count", 1, 60);
      index = read.nextIndex;
      continue;
    }
    if (argument === "--footprint-sample-interval-ms" || argument.startsWith("--footprint-sample-interval-ms=")) {
      const read = readOptionValue(argv, index, argument, "--footprint-sample-interval-ms");
      options.sampleIntervalMs = parseBoundedInteger(read.value, "--footprint-sample-interval-ms", 1, 60_000);
      index = read.nextIndex;
    }
  }
  return options;
}

function bytesFromKilobytes(value) {
  if (!Number.isSafeInteger(value) || value < 0) return null;
  const bytes = value * 1024;
  return Number.isSafeInteger(bytes) ? bytes : null;
}

function sum(values) {
  if (values.length === 0) return null;
  const total = values.reduce((current, value) => current + value, 0);
  return Number.isSafeInteger(total) ? total : null;
}

function summarize(values) {
  const valid = values.filter((value) => Number.isSafeInteger(value) && value >= 0);
  if (valid.length === 0) return null;
  const total = valid.reduce((current, value) => current + value, 0);
  return {
    sample_count: valid.length,
    min_bytes: Math.min(...valid),
    max_bytes: Math.max(...valid),
    mean_bytes: Math.round(total / valid.length),
  };
}

function summarizeCount(values) {
  const valid = values.filter((value) => Number.isSafeInteger(value) && value >= 0);
  if (valid.length === 0) return null;
  const total = valid.reduce((current, value) => current + value, 0);
  return {
    sample_count: valid.length,
    min: Math.min(...valid),
    max: Math.max(...valid),
    mean: Math.round(total / valid.length),
  };
}

function emptyGroup() {
  return {
    process_count: 0,
    working_set_bytes: null,
    private_bytes: null,
  };
}

function aggregateSnapshot(metrics) {
  if (!Array.isArray(metrics)) throw new TypeError("Electron app.getAppMetrics() did not return an array");
  const groups = {
    main: [],
    renderer: [],
  };
  for (const metric of metrics) {
    if (metric?.type === "Browser") groups.main.push(metric);
    else if (metric?.type === "Tab") groups.renderer.push(metric);
  }

  const result = {};
  for (const [name, group] of Object.entries(groups)) {
    const workingSet = group.map((metric) => bytesFromKilobytes(metric?.memory?.workingSetSize)).filter((value) => value !== null);
    const privateBytes = group.map((metric) => bytesFromKilobytes(metric?.memory?.privateBytes)).filter((value) => value !== null);
    result[name] = group.length === 0
      ? emptyGroup()
      : {
        process_count: group.length,
        working_set_bytes: sum(workingSet),
        private_bytes: sum(privateBytes),
      };
  }
  result.total = {
    process_count: result.main.process_count + result.renderer.process_count,
    working_set_bytes: [result.main.working_set_bytes, result.renderer.working_set_bytes]
      .every((value) => value !== null)
      ? result.main.working_set_bytes + result.renderer.working_set_bytes
      : null,
    private_bytes: [result.main.private_bytes, result.renderer.private_bytes]
      .every((value) => value !== null)
      ? result.main.private_bytes + result.renderer.private_bytes
      : null,
  };
  return result;
}

function aggregateGroup(snapshots, name) {
  return {
    process_count: summarizeCount(snapshots.map((snapshot) => snapshot[name].process_count)),
    working_set_bytes: summarize(snapshots.map((snapshot) => snapshot[name].working_set_bytes)),
    private_bytes: summarize(snapshots.map((snapshot) => snapshot[name].private_bytes)),
  };
}

/**
 * Convert Electron's app.getAppMetrics() snapshots (memory values are KiB in
 * Electron's API) into redaction-safe aggregate byte metrics. PIDs, names,
 * paths, URLs, and page text are intentionally discarded.
 */
export function aggregateElectronMetrics(samples) {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new TypeError("Electron footprint metrics require at least one sample");
  }
  const snapshots = samples.map(aggregateSnapshot);
  return {
    source: "electron.app.getAppMetrics",
    unit: "bytes",
    sample_count: snapshots.length,
    main: aggregateGroup(snapshots, "main"),
    renderer: aggregateGroup(snapshots, "renderer"),
    total: aggregateGroup(snapshots, "total"),
  };
}

export function hasUsableElectronMetrics(metrics) {
  return Boolean(
    metrics
      && metrics.main?.working_set_bytes?.sample_count > 0
      && metrics.renderer?.working_set_bytes?.sample_count > 0,
  );
}
