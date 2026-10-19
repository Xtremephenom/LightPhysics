import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  parseCompactVersion,
  probeLocalTool,
  type ToolDefinition,
  type ToolSpawner,
} from "./tools.js";

function fakeSpawner(output: string, exitCode = 0): {
  spawn: ToolSpawner;
  seen: () => { command: string; args: readonly string[]; shell: boolean } | undefined;
  killed: () => boolean;
} {
  let invocation: { command: string; args: readonly string[]; shell: boolean } | undefined;
  let killed = false;
  const spawn: ToolSpawner = (command, args, options) => {
    invocation = { command, args, shell: options.shell === true };
    const child = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const kill = vi.fn(() => {
      killed = true;
      return true;
    });
    Object.defineProperties(child, {
      stdout: { value: stdout },
      stderr: { value: stderr },
      kill: { value: kill },
    });
    queueMicrotask(() => {
      stdout.end(output);
      stderr.end();
      child.emit("close", exitCode);
    });
    return child;
  };
  return {
    spawn,
    seen: () => invocation,
    killed: () => killed,
  };
}

describe("local tool probes", () => {
  it("parses compact versions without returning surrounding output", () => {
    expect(parseCompactVersion("Blender 4.3.3\nBuild: private-output")).toBe("4.3.3");
    expect(parseCompactVersion("Godot Engine v4.4.1.stable.official")).toBe("v4.4.1");
    expect(parseCompactVersion("no version here")).toBeNull();
  });

  it("uses fixed argv without a shell and parses a successful probe", async () => {
    const fake = fakeSpawner("uv 0.8.14\n");
    const definition: ToolDefinition = {
      name: "uv",
      commands: [{ command: "uv", args: ["--version"] }],
    };
    await expect(probeLocalTool(definition, { spawn: fake.spawn })).resolves.toEqual({
      status: "available",
      version: "0.8.14",
    });
    expect(fake.seen()).toEqual({ command: "uv", args: ["--version"], shell: false });
    expect(fake.killed()).toBe(false);
  });

  it("treats ENOENT as an honest missing result", async () => {
    const definition: ToolDefinition = {
      name: "uv",
      commands: [{ command: "lightphysics-tool-does-not-exist-9f7c", args: ["--version"] }],
    };
    await expect(probeLocalTool(definition, { timeoutMs: 100 })).resolves.toEqual({
      status: "missing",
      version: null,
    });
  });

  it("terminates a hung child at the probe timeout", async () => {
    const definition: ToolDefinition = {
      name: "uv",
      commands: [{ command: "uv", args: ["--version"] }],
    };
    // A fake child that never closes exercises the bounded timeout path.
    const hangingSpawn: ToolSpawner = (command, args, options) => {
      const child = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      Object.defineProperties(child, {
        stdout: { value: stdout },
        stderr: { value: stderr },
        kill: { value: vi.fn(() => true) },
      });
      expect(command).toBe("uv");
      expect(args).toEqual(["--version"]);
      expect(options.shell).toBe(false);
      return child;
    };
    await expect(probeLocalTool(definition, { spawn: hangingSpawn, timeoutMs: 10 })).resolves.toEqual({
      status: "timeout",
      version: null,
    });
  });
});
