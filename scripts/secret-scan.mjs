#!/usr/bin/env node
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ignoredDirectories = new Set([
  ".git",
  "node_modules",
  ".pnpm-store",
  "coverage",
  "dist",
  "docs/pack",
  "master_promptpack_nottobeshipped",
]);
const ignoredFiles = new Set([".env.example"]);
const findings = [];
const textExtensions = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".css",
  ".dockerfile",
  ".html",
  ".ini",
  ".json",
  ".md",
  ".mjs",
  ".sh",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);

const keyPattern = new RegExp("sk-" + "[A-Za-z0-9]{20,}");
const regexSlash = String.fromCharCode(92);
const bearerPattern = new RegExp("Bearer" + regexSlash + "s+" + "[A-Za-z0-9._~-]{20,}", "i");
const privateKeyPattern = new RegExp("-----BEGIN " + "(?:RSA |EC |OPENSSH )?PRIVATE KEY-----");
const assignmentPattern = new RegExp("(?:api[_-]?key|access[_-]?token|secret|password|client[_-]?secret)" + regexSlash + "s*[:=]" + regexSlash + "s*[\\\"']?([^" + regexSlash + "s\\\"'#,]{12,})", "i");
const safeValues = new Set(["UNKNOWN", "unknown", "placeholder", "example", "changeme", "redacted", "neutral"]);

function relative(filePath) {
  return path.relative(root, filePath).split(path.sep).join("/");
}

function shouldIgnore(relativePath) {
  return relativePath.split("/").some((part, index, parts) => ignoredDirectories.has(part) || ignoredDirectories.has(parts.slice(0, index + 1).join("/")));
}

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const rel = relative(absolute);
    if (shouldIgnore(rel) || ignoredFiles.has(rel)) continue;
    if (entry.isDirectory()) {
      await visit(absolute);
      continue;
    }
    if (!entry.isFile()) continue;
    const extension = path.extname(entry.name).toLowerCase();
    if (!textExtensions.has(extension) && entry.name !== "Makefile" && entry.name !== "Dockerfile") continue;
    if ((await stat(absolute)).size > 2_000_000) continue;
    const contents = await readFile(absolute, "utf8");
    if (contents.includes("\u0000")) continue;
    for (const [lineNumber, line] of contents.split(/\r?\n/).entries()) {
      const direct = line.match(keyPattern) || line.match(bearerPattern) || line.match(privateKeyPattern);
      const assigned = line.match(assignmentPattern);
      const assignedValue = assigned?.[1]?.trim();
      if (direct) findings.push(`${rel}:${lineNumber + 1}: key-like value`);
      else if (assigned && assignedValue && !safeValues.has(assignedValue) && !assignedValue.startsWith("<") && !assignedValue.startsWith("${")) {
        findings.push(`${rel}:${lineNumber + 1}: secret-like assignment`);
      }
    }
  }
}

try {
  await visit(root);
  if (findings.length > 0) {
    console.error("secret-scan: possible secrets found:");
    for (const finding of findings) console.error(`  ${finding}`);
    process.exitCode = 1;
  } else {
    console.log("secret-scan: clean (.env.example is checked structurally by env-sync)");
  }
} catch (error) {
  console.error(`secret-scan: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
