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
const textExtensions = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".css",
  ".dockerfile",
  ".gitattributes",
  ".gitignore",
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

const fragments = ["/" + "home/", "/" + "Users/", "/" + "mnt/"];
const backslash = String.fromCharCode(92);
const drivePattern = new RegExp("(?:^|[^A-Za-z0-9])" + "[A-Z]" + ":" + "[" + backslash + "/]", "i");
const uncPattern = new RegExp(backslash + backslash + "[A-Za-z0-9._-]+" + backslash + "[^" + backslash + String.fromCharCode(13) + String.fromCharCode(10) + "]+", "i");
const findings = [];

function relative(filePath) {
  return path.relative(root, filePath).split(path.sep).join("/");
}

function shouldIgnore(relativePath) {
  return relativePath === "" || relativePath.split("/").some((part, index, parts) => {
    const prefix = parts.slice(0, index + 1).join("/");
    return ignoredDirectories.has(part) || ignoredDirectories.has(prefix);
  });
}

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const rel = relative(absolute);
    if (shouldIgnore(rel)) continue;
    if (entry.isDirectory()) {
      await visit(absolute);
      continue;
    }
    if (!entry.isFile()) continue;
    const extension = path.extname(entry.name).toLowerCase();
    if (!textExtensions.has(extension) && entry.name !== "Makefile" && entry.name !== "Dockerfile") continue;
    const fileStat = await stat(absolute);
    if (fileStat.size > 2_000_000) continue;
    const contents = await readFile(absolute, "utf8");
    if (contents.includes("\u0000")) continue;
    for (const [lineNumber, line] of contents.split(/\r?\n/).entries()) {
      const matched = fragments.find((fragment) => line.includes(fragment)) || (drivePattern.test(line) ? "drive-letter path" : null) || (uncPattern.test(line) ? "UNC path" : null);
      if (matched) findings.push(`${rel}:${lineNumber + 1}: ${matched}`);
    }
  }
}

try {
  await visit(root);
  if (findings.length > 0) {
    console.error("path-scan: machine-absolute paths found:");
    for (const finding of findings) console.error(`  ${finding}`);
    process.exitCode = 1;
  } else {
    console.log("path-scan: clean (reference prompt-pack paths are excluded by policy)");
  }
} catch (error) {
  console.error(`path-scan: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
