import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 750;
const DEFAULT_MAX_OUTPUT_BYTES = 8_192;

export type LocalToolName = "node" | "uv" | "godot" | "blender" | "ffmpeg";

export type LocalToolProbeStatus =
  | "available"
  | "missing"
  | "timeout"
  | "unqualified"
  | "error";

export interface LocalToolProbe {
  status: LocalToolProbeStatus;
  version: string | null;
}

export interface LocalToolProbes {
  node: LocalToolProbe;
  uv: LocalToolProbe;
  godot: LocalToolProbe;
  blender: LocalToolProbe;
  ffmpeg: LocalToolProbe;
}

export interface ToolCommand {
  command: string;
  args: readonly string[];
}

export interface ToolDefinition {
  name: LocalToolName;
  commands: readonly ToolCommand[];
}

export interface ProbeLocalToolOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
  spawn?: ToolSpawner;
}

export type ToolSpawner = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcessWithoutNullStreams;

const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  { name: "node", commands: [{ command: process.execPath, args: ["--version"] }] },
  { name: "uv", commands: [{ command: "uv", args: ["--version"] }] },
  {
    name: "godot",
    commands: [
      { command: "godot", args: ["--version"] },
      { command: "godot4", args: ["--version"] },
    ],
  },
  { name: "blender", commands: [{ command: "blender", args: ["--version"] }] },
  { name: "ffmpeg", commands: [{ command: "ffmpeg", args: ["-version"] }] },
];

function emptyProbe(status: LocalToolProbeStatus): LocalToolProbe {
  return { status, version: null };
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function normalizedLimit(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value > 0
    ? Math.floor(value)
    : fallback;
}

export function parseCompactVersion(text: string): string | null {
  // Version output is intentionally reduced to a numeric version token. This
  // prevents paths, build metadata, and arbitrary tool output from reaching the
  // doctor report.
  const match = text
    .split(/\r?\n/, 4)
    .join(" ")
    .match(/(?:^|[^\d])(?<version>v?\d+\.\d+(?:\.\d+)?)(?=$|[^\d])/i);
  return match?.groups?.version ?? null;
}

interface ProcessResult {
  status: "success" | LocalToolProbeStatus;
  output: string;
}

function stopChild(child: ChildProcessWithoutNullStreams): void {
  try {
    child.kill();
  } catch {
    // The probe result remains bounded and honest even if the child exited
    // between the timeout/output-limit check and kill().
  }
}

function runToolCommand(
  command: ToolCommand,
  options: Required<Pick<ProbeLocalToolOptions, "timeoutMs" | "maxOutputBytes">> & {
    env: NodeJS.ProcessEnv;
    spawn: ToolSpawner;
  },
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = options.spawn(command.command, [...command.args], {
        env: options.env,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({
        status: errorCode(error) === "ENOENT" ? "missing" : "error",
        output: "",
      });
      return;
    }

    let output = "";
    let outputBytes = 0;
    let settled = false;
    let timedOut = false;
    let overflowed = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (result: ProcessResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    const collect = (chunk: string | Buffer): void => {
      if (settled || overflowed) return;
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      outputBytes += Buffer.byteLength(text, "utf8");
      if (outputBytes > options.maxOutputBytes) {
        overflowed = true;
        stopChild(child);
        finish({ status: "error", output: "" });
        return;
      }
      output += text;
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", (error: unknown) => {
      finish({
        status: errorCode(error) === "ENOENT" ? "missing" : "error",
        output: "",
      });
    });
    child.once("close", (code: number | null) => {
      if (timedOut) {
        finish({ status: "timeout", output: "" });
      } else if (overflowed) {
        finish({ status: "error", output: "" });
      } else if (code === 0) {
        finish({ status: "success", output });
      } else {
        finish({ status: "error", output: "" });
      }
    });

    timer = setTimeout(() => {
      timedOut = true;
      stopChild(child);
      finish({ status: "timeout", output: "" });
    }, options.timeoutMs);
  });
}

export async function probeLocalTool(
  definition: ToolDefinition,
  options: ProbeLocalToolOptions = {},
): Promise<LocalToolProbe> {
  const probeOptions = {
    timeoutMs: normalizedLimit(options.timeoutMs, DEFAULT_TIMEOUT_MS),
    maxOutputBytes: normalizedLimit(options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES),
    env: options.env ?? process.env,
    spawn: options.spawn ?? ((command, args, spawnOptions) =>
      spawn(command, args, spawnOptions) as ChildProcessWithoutNullStreams),
  };

  for (const command of definition.commands) {
    const result = await runToolCommand(command, probeOptions);
    if (result.status === "missing") continue;
    if (result.status !== "success") return emptyProbe(result.status);
    const version = parseCompactVersion(result.output);
    return version ? { status: "available", version } : emptyProbe("unqualified");
  }
  return emptyProbe("missing");
}

export async function probeLocalTools(options: ProbeLocalToolOptions = {}): Promise<LocalToolProbes> {
  const probes = await Promise.all(
    TOOL_DEFINITIONS.map((definition) => probeLocalTool(definition, options)),
  );
  return {
    node: probes[0] ?? emptyProbe("error"),
    uv: probes[1] ?? emptyProbe("error"),
    godot: probes[2] ?? emptyProbe("error"),
    blender: probes[3] ?? emptyProbe("error"),
    ffmpeg: probes[4] ?? emptyProbe("error"),
  };
}
