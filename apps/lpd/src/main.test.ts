import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import { LpdStartupError, runLpd } from "./main.js";

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

describe("lpd executable wrapper", () => {
  it("prints help without starting a server", async () => {
    const stdout = capture();
    await expect(runLpd(["--", "--help"], { stdout: stdout.stream })).resolves.toBe(0);
    expect(stdout.value()).toContain("Usage: lpd");
  });

  it("rejects a missing bearer token with an actionable typed error", async () => {
    await expect(runLpd([], { env: { LP_PORT: "4317" } })).rejects.toMatchObject({
      name: "LpdStartupError",
      code: "MissingToken",
      suggestedNext: expect.stringContaining("LP_TOKEN"),
    } satisfies Partial<LpdStartupError>);
  });
});
