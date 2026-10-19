#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const warnings = [];

function exactVersion(value, label) {
  if (!/^\d+\.\d+\.\d+$/.test(value)) failures.push(`${label} must be an exact x.y.z version; got ${JSON.stringify(value)}`);
}

async function workspaceManifests() {
  const manifests = [{ path: path.join(root, "package.json"), label: "package.json" }];
  for (const parent of ["apps", "packages", "workers", "tools"]) {
    const directory = path.join(root, parent);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(directory, entry.name, "package.json");
      try {
        await readFile(manifestPath, "utf8");
        manifests.push({ path: manifestPath, label: `${parent}/${entry.name}/package.json` });
      } catch {
        // A workspace directory without a package manifest is not a package yet.
      }
    }
  }
  return manifests;
}

try {
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const nodeVersion = (await readFile(path.join(root, ".node-version"), "utf8")).trim();
  const pythonVersion = (await readFile(path.join(root, ".python-version"), "utf8")).trim();
  const tools = JSON.parse(await readFile(path.join(root, "tools.lock.json"), "utf8"));
  const dockerfile = await readFile(path.join(root, "Dockerfile"), "utf8");
  const lockfile = await readFile(path.join(root, "pnpm-lock.yaml"), "utf8");
  exactVersion(nodeVersion, ".node-version");
  exactVersion(pythonVersion, ".python-version");
  if (packageJson.packageManager !== "pnpm@12.14.0") failures.push("package.json#packageManager must be pnpm@12.14.0");
  if (packageJson.engines?.node !== nodeVersion) failures.push("package.json#engines.node must equal .node-version");
  if (packageJson.engines?.pnpm !== "12.14.0") failures.push("package.json#engines.pnpm must equal 12.14.0");
  if (tools.runtimes?.node?.version !== nodeVersion) failures.push("tools.lock.json Node runtime disagrees with .node-version");
  if (tools.runtimes?.pnpm?.version !== "12.14.0") failures.push("tools.lock.json pnpm runtime disagrees with package.json");
  if (!lockfile.includes("lockfileVersion: '9.0'")) failures.push("pnpm-lock.yaml must use the pnpm 9 lockfile format");
  const baseMatch = /^ARG BASE_IMAGE=([^\r\n]+)$/m.exec(dockerfile);
  if (!baseMatch) failures.push("Dockerfile must declare ARG BASE_IMAGE");
  else {
    const base = baseMatch[1].trim();
    if (base.includes(":latest") || !/@sha256:[0-9a-f]{64}$/i.test(base)) failures.push("Dockerfile BASE_IMAGE must use a non-latest sha256 digest");
    if (!base.includes(`node:${nodeVersion}`)) failures.push("Dockerfile BASE_IMAGE Node tag must match .node-version");
    if (tools.docker?.base_image?.digest && !base.endsWith(tools.docker.base_image.digest)) failures.push("Dockerfile BASE_IMAGE digest disagrees with tools.lock.json");
  }
  for (const manifestFile of await workspaceManifests()) {
    const manifestJson = manifestFile.path === path.join(root, "package.json")
      ? packageJson
      : JSON.parse(await readFile(manifestFile.path, "utf8"));
    const dependencyMaps = [
      manifestJson.dependencies,
      manifestJson.devDependencies,
      manifestJson.optionalDependencies,
      manifestJson.peerDependencies,
    ].filter(Boolean);
    for (const dependencyMap of dependencyMaps) {
      for (const [name, version] of Object.entries(dependencyMap)) {
        const workspaceReference = typeof version === "string" && version.startsWith("workspace:");
        if (!workspaceReference && (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version))) {
          failures.push(`${manifestFile.label}: ${name} must use an exact dependency version or workspace protocol`);
        }
      }
    }
  }
  for (const [name, tool] of Object.entries(tools.tools ?? {})) {
    if (tool.version === "UNKNOWN" || String(tool.version).includes("UNKNOWN")) warnings.push(`${name}: version is UNKNOWN`);
  }
  if (warnings.length > 0) for (const warning of warnings) console.warn(`pin-check: warning: ${warning}`);
  if (failures.length > 0) {
    console.error("pin-check: failed");
    for (const failure of failures) console.error(`  ${failure}`);
    process.exitCode = 1;
  } else {
    console.log("pin-check: runtime, package-manager, lockfile, and Docker base pins agree");
  }
} catch (error) {
  console.error(`pin-check: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
