import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath: string): string {
  return readFileSync(path.join(root, relativePath), "utf8");
}

test("the root pins the requested Node and pnpm versions", () => {
  const packageJson = JSON.parse(read("package.json")) as {
    packageManager: string;
    engines: { node: string; pnpm: string };
  };
  assert.equal(packageJson.packageManager, "pnpm@12.14.0");
  assert.equal(packageJson.engines.node, "24.18.0");
  assert.equal(packageJson.engines.pnpm, "12.14.0");
  assert.equal(read(".node-version").trim(), packageJson.engines.node);
});

test("the workspace has a frozen lockfile and strict compiler settings", () => {
  assert.match(read("pnpm-lock.yaml"), /lockfileVersion: '9\.0'/);
  const tsconfig = JSON.parse(read("tsconfig.base.json")) as { compilerOptions: { strict: boolean; noEmit: boolean } };
  assert.equal(tsconfig.compilerOptions.strict, true);
  assert.equal(tsconfig.compilerOptions.noEmit, true);
});

test("the Dockerfile has all four bootstrap stages", () => {
  const dockerfile = read("Dockerfile");
  for (const stage of ["base", "deps", "test", "runtime"]) {
    assert.equal(dockerfile.includes("AS " + stage), true);
  }
  assert.doesNotMatch(dockerfile, /:latest\b/);
});

test("the Docker deps stage copies every workspace manifest before installing dependencies", () => {
  const dockerfile = read("Dockerfile");
  const depsStart = dockerfile.indexOf("FROM base AS deps");
  const testStart = dockerfile.indexOf("FROM deps AS test");
  assert.ok(depsStart >= 0 && testStart > depsStart);

  const depsStage = dockerfile.slice(depsStart, testStart);
  const installStart = depsStage.search(/\bpnpm\s+install\b/);
  assert.ok(installStart >= 0, "the deps stage must install dependencies");
  const copiedManifests = new Set(
    [...depsStage.slice(0, installStart).matchAll(/^COPY --chown=lp:lp (\S+) \1\r?$/gm)].map((match) => match[1]),
  );

  for (const directory of ["apps", "packages"]) {
    for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = `${directory}/${entry.name}/package.json`;
      if (!existsSync(path.join(root, manifest))) continue;
      assert.ok(copiedManifests.has(manifest), `${manifest} must be copied before the first deps-stage pnpm install`);
    }
  }
});

test("the offline test runner includes catalog-lint before workspace and root tests", () => {
  const runner = read("scripts/test.mjs");
  assert.match(runner, /\["catalog-lint",\s*"scripts\/catalog-lint\.mjs"\]/);
  assert.ok(runner.indexOf('"catalog-lint"') < runner.indexOf('"root-tests"'));
});

test("the Docker test stage provisions pinned Chromium before running the real browser journey", () => {
  const dockerfile = read("Dockerfile");
  const depsStart = dockerfile.indexOf("FROM base AS deps");
  const testStart = dockerfile.indexOf("FROM deps AS test");
  const runtimeStart = dockerfile.indexOf("FROM base AS runtime");
  assert.ok(depsStart >= 0 && testStart > depsStart && runtimeStart > testStart);

  const depsStage = dockerfile.slice(depsStart, testStart);
  const testStage = dockerfile.slice(testStart, runtimeStart);
  assert.match(dockerfile, /PLAYWRIGHT_BROWSERS_PATH=\/opt\/ms-playwright/);
  assert.match(depsStage, /pnpm exec playwright install chromium/);
  assert.match(depsStage, /chromium-1248\/chrome-linux64\/chrome/);
  assert.match(testStage, /RUN pnpm run test\b/);
  assert.match(testStage, /CMD \["sh", "-c", "pnpm run test && pnpm run test:e2e"\]/);
  assert.doesNotMatch(testStage, /playwright install/);

  const aptPackages = read("docker/apt-packages.txt");
  for (const packageName of ["libnss3", "libgbm1", "libatk1.0-0", "fonts-liberation", "xvfb", "xauth"]) {
    assert.match(aptPackages, new RegExp(`^${packageName}$`, "m"));
  }
});

test("the runtime image starts authenticated lpd with container-safe defaults", () => {
  const dockerfile = read("Dockerfile");
  const runtime = dockerfile.slice(dockerfile.indexOf("FROM base AS runtime"));
  assert.match(runtime, /LP_IN_CONTAINER=1/);
  assert.match(runtime, /LP_BIND=0\.0\.0\.0/);
  assert.doesNotMatch(runtime, /LP_TOKEN\s*=/);
  assert.match(runtime, /HEALTHCHECK[\s\S]*lp-healthcheck/);
  assert.match(runtime, /CMD \["pnpm", "run", "lpd"\]/);
  assert.doesNotMatch(runtime, /node", "--version/);

  const healthcheck = read("docker/healthcheck.sh");
  assert.match(healthcheck, /LP_TOKEN/);
  assert.match(healthcheck, /doctor --json --quick/);
  assert.match(healthcheck, />\/dev\/null 2>&1/);
  assert.doesNotMatch(healthcheck, /echo.*LP_TOKEN|printf.*LP_TOKEN/);
});

test("Docker smoke commands use a runtime token and loopback-only publication", () => {
  const packageJson = JSON.parse(read("package.json")) as {
    scripts: Record<string, string>;
  };
  assert.match(packageJson.scripts["docker-smoke"] ?? "", /docker-smoke\.mjs/);
  assert.match(packageJson.scripts["docker-run"] ?? "", /docker-run\.mjs/);
  const smoke = read("scripts/docker-smoke.mjs");
  const run = read("scripts/docker-run.mjs");
  assert.match(smoke, /LP_TOKEN/);
  assert.match(smoke, /127\.0\.0\.1:\$\{configuredPort\}:\$\{CONTAINER_PORT\}/);
  assert.match(run, /LP_TOKEN/);
  assert.match(run, /127\.0\.0\.1:4317:4317/);
});

test("the committed rebuild proof installs workspace dependencies before imports", () => {
  const script = read("scripts/verify-rebuild.sh");
  assert.match(script, /corepack pnpm install --frozen-lockfile/);
  assert.match(script, /corepack pnpm run test/);
});

test("the environment example declares the network guard and no provider value", () => {
  const env = read(".env.example");
  assert.match(env, /^LP_TEST_NETWORK_GUARD=1$/m);
  assert.match(env, /^LP_KEY_PROVIDER_EXAMPLE=$/m);
});
