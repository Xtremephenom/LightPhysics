import type { Writable } from "node:stream";

export const LOG_LEVELS = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export type LogFormat = "json" | "pretty";
export type LogFields = Record<string, unknown>;

const LEVEL_VALUE: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

export const REDACTED = "[REDACTED]";
const SENSITIVE_KEY = /(pass(word)?|secret|token|authorization|api[-_]?key|access[-_]?key|private[-_]?key|credential|cookie|session[-_]?id)/i;

export interface LoggerOptions {
  level?: LogLevel;
  format?: LogFormat;
  /** A deterministic sink is useful for tests and embedding. It receives one line. */
  sink?: (line: string) => void;
  stream?: Writable;
  now?: () => Date;
  secrets?: Iterable<string>;
  redactions?: Iterable<string>;
  bindings?: LogFields;
}

export interface Logger {
  readonly level: LogLevel;
  readonly format: LogFormat;
  trace(message: string, fields?: LogFields): void;
  trace(fields: LogFields, message?: string): void;
  debug(message: string, fields?: LogFields): void;
  debug(fields: LogFields, message?: string): void;
  info(message: string, fields?: LogFields): void;
  info(fields: LogFields, message?: string): void;
  warn(message: string, fields?: LogFields): void;
  warn(fields: LogFields, message?: string): void;
  error(message: string, fields?: LogFields): void;
  error(fields: LogFields, message?: string): void;
  fatal(message: string, fields?: LogFields): void;
  fatal(fields: LogFields, message?: string): void;
  log(level: LogLevel, message: string, fields?: LogFields): void;
  log(level: LogLevel, fields: LogFields, message?: string): void;
  child(bindings: LogFields): Logger;
  registerSecret(secret: string): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function replaceSecrets(value: string, secrets: readonly string[]): string {
  let result = value;
  for (const secret of secrets) {
    if (secret.length > 0) result = result.split(secret).join(REDACTED);
  }
  return result;
}

/** Deeply redact sensitive keys and registered secret values. */
export function redact<T>(value: T, secrets: Iterable<string> = []): T {
  const registered = [...secrets].filter((secret) => secret.length > 0);
  const seen = new WeakSet<object>();

  const visit = (input: unknown, depth: number): unknown => {
    if (depth > 30) return "[Truncated]";
    if (typeof input === "string") return replaceSecrets(input, registered);
    if (
      input === null ||
      typeof input === "number" ||
      typeof input === "boolean" ||
      typeof input === "undefined"
    ) {
      return input;
    }
    if (typeof input === "bigint") return `${input}n`;
    if (input instanceof Error) {
      return {
        name: replaceSecrets(input.name, registered),
        message: replaceSecrets(input.message, registered),
        ...(input.stack
          ? { stack: replaceSecrets(input.stack, registered) }
          : {}),
      };
    }
    if (input instanceof Date) return input.toISOString();
    if (typeof input === "function") return `[Function ${input.name || "anonymous"}]`;
    if (typeof input !== "object") return String(input);
    if (seen.has(input)) return "[Circular]";
    seen.add(input);
    if (Array.isArray(input)) return input.map((item) => visit(item, depth + 1));

    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(input)) {
      output[key] = SENSITIVE_KEY.test(key)
        ? REDACTED
        : visit(item, depth + 1);
    }
    return output;
  };

  return visit(value, 0) as T;
}

function defaultSink(line: string): void {
  process.stdout.write(`${line}\n`);
}

class StructuredLogger implements Logger {
  readonly level: LogLevel;
  readonly format: LogFormat;
  private readonly options: LoggerOptions;
  private readonly sink: (line: string) => void;
  private readonly now: () => Date;
  private readonly secrets: Set<string>;
  private readonly bindings: LogFields;

  constructor(options: LoggerOptions = {}) {
    this.options = options;
    this.level = options.level ?? "info";
    this.format = options.format ?? "json";
    this.now = options.now ?? (() => new Date());
    this.secrets = new Set(
      [...(options.secrets ?? []), ...(options.redactions ?? [])].filter(
        (secret) => secret.length > 0,
      ),
    );
    this.bindings = { ...(options.bindings ?? {}) };
    this.sink =
      options.sink ??
      (options.stream
        ? (line: string) => options.stream?.write(`${line}\n`)
        : defaultSink);
  }

  trace(message: string, fields?: LogFields): void;
  trace(fields: LogFields, message?: string): void;
  trace(first: string | LogFields, second?: string | LogFields): void {
    this.write("trace", first, second);
  }

  debug(message: string, fields?: LogFields): void;
  debug(fields: LogFields, message?: string): void;
  debug(first: string | LogFields, second?: string | LogFields): void {
    this.write("debug", first, second);
  }

  info(message: string, fields?: LogFields): void;
  info(fields: LogFields, message?: string): void;
  info(first: string | LogFields, second?: string | LogFields): void {
    this.write("info", first, second);
  }

  warn(message: string, fields?: LogFields): void;
  warn(fields: LogFields, message?: string): void;
  warn(first: string | LogFields, second?: string | LogFields): void {
    this.write("warn", first, second);
  }

  error(message: string, fields?: LogFields): void;
  error(fields: LogFields, message?: string): void;
  error(first: string | LogFields, second?: string | LogFields): void {
    this.write("error", first, second);
  }

  fatal(message: string, fields?: LogFields): void;
  fatal(fields: LogFields, message?: string): void;
  fatal(first: string | LogFields, second?: string | LogFields): void {
    this.write("fatal", first, second);
  }

  log(level: LogLevel, message: string, fields?: LogFields): void;
  log(level: LogLevel, fields: LogFields, message?: string): void;
  log(
    level: LogLevel,
    first: string | LogFields,
    second?: string | LogFields,
  ): void {
    this.write(level, first, second);
  }

  child(bindings: LogFields): Logger {
    return new StructuredLogger({
      ...this.options,
      sink: this.sink,
      bindings: { ...this.bindings, ...bindings },
      secrets: this.secrets,
      redactions: [],
    });
  }

  registerSecret(secret: string): void {
    if (secret.length > 0) this.secrets.add(secret);
  }

  private write(
    level: LogLevel,
    first: string | LogFields,
    second?: string | LogFields,
  ): void {
    if (LEVEL_VALUE[level] < LEVEL_VALUE[this.level]) return;

    const fields: LogFields =
      typeof first === "string"
        ? isRecord(second)
          ? second
          : {}
        : first;
    const message =
      typeof first === "string"
        ? first
        : typeof second === "string"
          ? second
          : "event";
    const redactedFields = redact(
      { ...this.bindings, ...fields },
      this.secrets,
    ) as LogFields;
    const redactedMessage = redact(message, this.secrets) as string;
    const timestamp = this.now().toISOString();

    if (this.format === "pretty") {
      const suffix = Object.keys(redactedFields).length
        ? ` ${JSON.stringify(redactedFields)}`
        : "";
      this.sink(
        `${timestamp} ${level.toUpperCase()} ${redactedMessage}${suffix}`,
      );
      return;
    }

    this.sink(
      JSON.stringify({
        time: timestamp,
        level,
        msg: redactedMessage,
        ...redactedFields,
      }),
    );
  }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  return new StructuredLogger(options);
}

export const createStructuredLogger = createLogger;
