import { describe, expect, it } from "vitest";
import { createServer } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { loadConfig } from "@lightphysics/config";
import { LpCommandError, pidFilePath, runLp } from "./main.js";

function capture(): { stream: Writable; value: () => string } {
  const chunks: string[] = [];
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    }),
    value: () => chunks.join(""),
  };
}

describe("lp executable wrapper", () => {
  it("supports the package-manager argument separator for --version", async () => {
    const stdout = capture();
    await expect(runLp(["--", "--version"], { stdout: stdout.stream })).resolves.toBe(0);
    expect(stdout.value()).toBe("0.1.0\n");
  });

  it("fails daemon start before spawning when LP_TOKEN is absent", async () => {
    await expect(runLp(["daemon", "start"], { env: { LP_HOME: "phase0-wrapper-test" } })).rejects.toMatchObject({
      name: "LpCommandError",
      code: "MissingToken",
      message: expect.stringContaining("LP_TOKEN"),
    } satisfies Partial<LpCommandError>);
  });

  it("places only the PID file under the configured run directory", () => {
    const config = loadConfig({ LP_HOME: "phase0-wrapper-test", LP_PORT: "4317" });
    expect(pidFilePath(config)).toMatch(/[\\/]phase0-wrapper-test[\\/]run[\\/]lpd\.pid$/);
  });

  it("starts and stops lpd with a token-free PID file", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "lightphysics-wrapper-"));
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => resolve());
    });
    const address = probe.address();
    if (!address || typeof address === "string") throw new Error("probe did not expose a port");
    const env = {
      ...process.env,
      LP_HOME: home,
      LP_PORT: String(address.port),
      LP_TOKEN: "test-token",
    };
    await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));

    try {
      const startOut = capture();
      await expect(runLp(["daemon", "start"], { env, stdout: startOut.stream })).resolves.toBe(0);
      const config = loadConfig(env);
      const pidPath = pidFilePath(config);
      const pidContents = await readFile(pidPath, "utf8");
      expect(pidContents).toMatch(/^\d+\n$/);
      expect(pidContents).not.toContain(env.LP_TOKEN);

      const statusOut = capture();
      await expect(runLp(["daemon", "status", "--json"], { env, stdout: statusOut.stream })).resolves.toBe(0);
      expect(JSON.parse(statusOut.value())).toMatchObject({ ok: true, status: "running" });

      const stopOut = capture();
      await expect(runLp(["daemon", "stop"], { env, stdout: stopOut.stream })).resolves.toBe(0);
      await expect(readFile(pidPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      try {
        await runLp(["daemon", "stop"], { env, stdout: capture().stream });
      } catch {
        // The assertion above reports the primary lifecycle failure.
      }
      await rm(home, { recursive: true, force: true });
    }
  });
});
