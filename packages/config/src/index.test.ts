import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOOPBACK_BIND,
  DEFAULT_PORT,
  ConfigError,
  generateEnvExample,
  loadConfig,
  resolveHome,
} from "./index.js";

describe("config loader", () => {
  it("uses safe loopback defaults and a platform-relative home", () => {
    const config = loadConfig({});
    expect(config.bind).toBe(DEFAULT_LOOPBACK_BIND);
    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.inContainer).toBe(false);
    expect(config.logLevel).toBe("info");
    expect(config.logFormat).toBe("json");
    expect(config.home.length).toBeGreaterThan(0);
  });

  it("parses explicit daemon settings without exposing unrelated env values", () => {
    const config = loadConfig({
      LP_HOME: "./.lp-test-home",
      LP_PORT: "4400",
      LP_IN_CONTAINER: "false",
      LP_LOG_LEVEL: "debug",
      LP_LOG_FORMAT: "text",
    });
    expect(config.port).toBe(4400);
    expect(config.logFormat).toBe("pretty");
    expect(config.home).toContain(".lp-test-home");
    expect(config).not.toHaveProperty("LP_KEY_PROVIDER");
  });

  it("allows the non-loopback bind only in explicit container mode", () => {
    expect(() => loadConfig({ LP_BIND: "0.0.0.0" })).toThrow(ConfigError);
    expect(loadConfig({ LP_BIND: "0.0.0.0", LP_IN_CONTAINER: "1" }).bind).toBe(
      "0.0.0.0",
    );
  });

  it("rejects malformed ports and generates a secret-free env example", () => {
    expect(() => loadConfig({ LP_PORT: "70000" })).toThrow(ConfigError);
    const example = generateEnvExample();
    expect(example).toContain("LP_HOME=");
    expect(example).toContain("LP_LOG_FORMAT=json");
    expect(example).not.toMatch(/LP_KEY|token|secret|sk-[A-Za-z0-9]/i);
  });

  it("resolves configured homes with node:path", () => {
    expect(resolveHome("relative-home")).toMatch(/relative-home$/);
  });
});
