import { describe, expect, it } from "vitest";
import { createLogger, redact } from "./index.js";

describe("structured logging", () => {
  it("emits JSON and redacts sensitive keys and registered values", () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: "debug",
      sink: (line) => lines.push(line),
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      secrets: ["canary-secret"],
    });
    logger.info("request canary-secret", {
      authorization: "Bearer canary-secret",
      nested: { value: "canary-secret" },
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("canary-secret");
    expect(lines[0]).toContain("[REDACTED]");
    expect(JSON.parse(lines[0]!)).toMatchObject({
      level: "info",
      msg: "request [REDACTED]",
      authorization: "[REDACTED]",
    });
  });

  it("supports child bindings and level filtering", () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "warn", sink: (line) => lines.push(line) });
    logger.info("hidden");
    logger.child({ component: "test" }).warn("visible");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      component: "test",
      msg: "visible",
    });
  });

  it("handles circular values without leaking them or throwing", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const result = redact(circular);
    expect(result).toEqual({ self: "[Circular]" });
  });
});
