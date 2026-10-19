import os from "node:os";
import { isIP } from "node:net";
import path from "node:path";
import { z } from "zod";

export const DEFAULT_PORT = 4317;
export const DEFAULT_LOOPBACK_BIND = "127.0.0.1";
export const DEFAULT_CONTAINER_BIND = "0.0.0.0";
export const DEFAULT_BIND = DEFAULT_LOOPBACK_BIND;
export const DEFAULT_LOG_LEVEL = "info" as const;
export const DEFAULT_LOG_FORMAT = "json" as const;

export const LogLevelSchema = z.enum([
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
]);
export type LogLevel = z.infer<typeof LogLevelSchema>;

export const LogFormatSchema = z.enum(["json", "pretty"]);
export type LogFormat = z.infer<typeof LogFormatSchema>;

export const EnvironmentVariableSchema = z.object({
  LP_HOME: z.string().optional(),
  LP_BIND: z.string().optional(),
  LP_PORT: z.string().optional(),
  LP_IN_CONTAINER: z.string().optional(),
  LP_LOG_LEVEL: z.string().optional(),
  LP_LOG_FORMAT: z.string().optional(),
});
export type EnvironmentVariables = z.infer<typeof EnvironmentVariableSchema>;

export const LightPhysicsConfigSchema = z.object({
  home: z.string().min(1),
  bind: z.string().min(1),
  port: z.number().int().min(1).max(65_535),
  inContainer: z.boolean(),
  logLevel: LogLevelSchema,
  logFormat: LogFormatSchema,
});
export type LightPhysicsConfig = z.infer<typeof LightPhysicsConfigSchema>;
export type Config = LightPhysicsConfig;

export class ConfigError extends Error {
  readonly code = "ValidationError" as const;

  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function parseBoolean(
  value: string | undefined,
  fallback = false,
): boolean {
  const normalized = nonEmpty(value)?.toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new ConfigError("LP_IN_CONTAINER must be a boolean value");
}

function parsePort(value: string | undefined): number {
  const normalized = nonEmpty(value);
  if (!normalized) return DEFAULT_PORT;
  if (!/^\d+$/.test(normalized)) {
    throw new ConfigError("LP_PORT must be an integer between 1 and 65535");
  }
  const port = Number(normalized);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ConfigError("LP_PORT must be an integer between 1 and 65535");
  }
  return port;
}

function parseLogLevel(value: string | undefined): LogLevel {
  const normalized = nonEmpty(value) ?? DEFAULT_LOG_LEVEL;
  const parsed = LogLevelSchema.safeParse(normalized);
  if (!parsed.success) {
    throw new ConfigError(
      "LP_LOG_LEVEL must be one of trace, debug, info, warn, error, or fatal",
    );
  }
  return parsed.data;
}

function parseLogFormat(value: string | undefined): LogFormat {
  const normalized = nonEmpty(value)?.toLowerCase() ?? DEFAULT_LOG_FORMAT;
  // "text" is a friendly environment spelling; the typed config calls the
  // human-readable mode "pretty".
  const canonical = normalized === "text" ? "pretty" : normalized;
  const parsed = LogFormatSchema.safeParse(canonical);
  if (!parsed.success) {
    throw new ConfigError("LP_LOG_FORMAT must be json, pretty, or text");
  }
  return parsed.data;
}

export function isLoopbackBind(bind: string): boolean {
  const normalized = bind.trim().toLowerCase();
  if (normalized === "localhost" || normalized === "::1" || normalized === "[::1]") {
    return true;
  }
  return isIP(normalized) === 4 && normalized.startsWith("127.");
}

type EnvironmentSource = Readonly<Record<string, string | undefined>>;

function defaultHome(
  platform: NodeJS.Platform = process.platform,
  environment: EnvironmentSource = process.env,
): string {
  const home = os.homedir();
  if (platform === "win32") {
    return path.join(
      environment.APPDATA || path.join(home, "AppData", "Roaming"),
      "LightPhysics",
    );
  }
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "LightPhysics");
  }
  const dataHome = nonEmpty(environment.XDG_DATA_HOME) ?? path.join(home, ".local", "share");
  return path.join(dataHome, "lightphysics");
}

export function resolveHome(
  value: string | undefined,
  platform: NodeJS.Platform = process.platform,
  environment: EnvironmentSource = process.env,
): string {
  const configured = nonEmpty(value);
  return path.resolve(configured ?? defaultHome(platform, environment));
}

function parseBind(value: string | undefined, inContainer: boolean): string {
  const bind = nonEmpty(value) ??
    (inContainer ? DEFAULT_CONTAINER_BIND : DEFAULT_LOOPBACK_BIND);
  if (!inContainer && !isLoopbackBind(bind)) {
    throw new ConfigError(
      "LP_BIND must be loopback outside a container (use LP_IN_CONTAINER=1 for a container bind)",
    );
  }
  return bind;
}

/**
 * Load only the non-secret daemon settings. The loader deliberately does not
 * print, return, or log arbitrary environment variables; credentials such as
 * provider keys are handled by later secret-aware layers.
 */
export function loadConfig(
  environment: NodeJS.ProcessEnv | EnvironmentVariables = process.env,
): LightPhysicsConfig {
  const env = EnvironmentVariableSchema.parse(environment);
  const inContainer = parseBoolean(env.LP_IN_CONTAINER, false);
  const config = {
    home: resolveHome(env.LP_HOME, process.platform, environment),
    bind: parseBind(env.LP_BIND, inContainer),
    port: parsePort(env.LP_PORT),
    inContainer,
    logLevel: parseLogLevel(env.LP_LOG_LEVEL),
    logFormat: parseLogFormat(env.LP_LOG_FORMAT),
  };
  return LightPhysicsConfigSchema.parse(config);
}

export const fromEnv = loadConfig;

/**
 * Read the optional local bearer token without making it part of the returned
 * config object. It is intentionally absent from generated env templates and
 * should only be supplied through the process environment or an embedding
 * application's secret store.
 */
export function getBearerToken(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const token = environment.LP_TOKEN?.trim();
  return token ? token : undefined;
}

export const CONFIG_ENVIRONMENT = [
  {
    name: "LP_HOME",
    description: "LightPhysics application data directory",
    default: "platform default",
    secret: false,
  },
  {
    name: "LP_BIND",
    description: "Daemon listen address; loopback by default",
    default: DEFAULT_LOOPBACK_BIND,
    secret: false,
  },
  {
    name: "LP_PORT",
    description: "Daemon HTTP port",
    default: String(DEFAULT_PORT),
    secret: false,
  },
  {
    name: "LP_IN_CONTAINER",
    description: "Allow the container bind exception",
    default: "0",
    secret: false,
  },
  {
    name: "LP_LOG_LEVEL",
    description: "Structured logger level",
    default: DEFAULT_LOG_LEVEL,
    secret: false,
  },
  {
    name: "LP_LOG_FORMAT",
    description: "Structured logger output format",
    default: DEFAULT_LOG_FORMAT,
    secret: false,
  },
] as const;

/** Generate the safe, secret-free environment template used by repo tooling. */
export function generateEnvExample(): string {
  return [
    "# LightPhysics daemon configuration",
    ...CONFIG_ENVIRONMENT.map(
      ({ name, default: defaultValue, description }) =>
        `# ${description}\n${name}=${defaultValue === "platform default" ? "" : defaultValue}`,
    ),
    "",
  ].join("\n");
}
