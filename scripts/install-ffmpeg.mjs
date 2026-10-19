#!/usr/bin/env node

import { lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DEFAULT_LOCK_PATH,
  installTool,
  readToolsLock,
  selectToolLockEntry,
  ToolInstallerError,
} from "./install-tools.mjs";

export const FFMPEG_INSTALL_LIMITS = Object.freeze({
  maxArchiveBytes: 256 * 1024 * 1024,
  maxEntryUncompressedBytes: 512 * 1024 * 1024,
  maxTotalUncompressedBytes: 1024 * 1024 * 1024,
  maxEntries: 4_096,
});

export class FfmpegInstallError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "FfmpegInstallError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new FfmpegInstallError(code, message, details);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredLockPath(value, label, { allowTrailingSlash = false } = {}) {
  if (typeof value !== "string" || value.trim() === "") fail("LOCK_INVALID_VALUE", `FFmpeg lock entry ${label} must be known`);
  if (/(?:^|-)UNKNOWN$/i.test(value.trim())) fail("LOCK_UNKNOWN", `FFmpeg lock entry ${label} must be known`);
  const candidate = value.trim().replaceAll("\\", "/");
  const withoutTrailingSlash = allowTrailingSlash ? candidate.replace(/\/+$/, "") : candidate;
  if (
    withoutTrailingSlash === "" ||
    withoutTrailingSlash.includes("\u0000") ||
    withoutTrailingSlash.startsWith("/") ||
    withoutTrailingSlash.startsWith("//") ||
    /^[A-Za-z]:/.test(withoutTrailingSlash)
  ) {
    fail("LOCK_INVALID_VALUE", `FFmpeg lock entry ${label} must be a relative archive path`);
  }
  const parts = withoutTrailingSlash.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    fail("LOCK_INVALID_VALUE", `FFmpeg lock entry ${label} contains an unsafe archive path`);
  }
  return parts.join("/");
}

export function selectFfmpegLockEntry(lock, platform) {
  if (typeof platform !== "string" || platform.trim() === "") {
    fail("INVALID_ARGUMENT", "FFmpeg platform is required");
  }
  const selected = selectToolLockEntry(lock, { tool: "ffmpeg", platform });
  const artifact = lock?.tools?.ffmpeg?.platforms?.[platform];
  if (!isRecord(artifact)) fail("LOCK_PLATFORM_NOT_FOUND", "FFmpeg platform entry is not present");

  return {
    ...selected,
    archiveRoot: requiredLockPath(artifact.archive_root, "archive_root", { allowTrailingSlash: true }),
    binary: requiredLockPath(artifact.binary, "binary"),
  };
}

export function installedFfmpegPath(destination, entry) {
  if (typeof destination !== "string" || destination.trim() === "") {
    fail("INVALID_ARGUMENT", "FFmpeg destination is required");
  }
  if (!isRecord(entry)) fail("INVALID_ARGUMENT", "FFmpeg lock entry is required");
  const archiveRoot = requiredLockPath(entry.archiveRoot, "archive_root", { allowTrailingSlash: true });
  const binary = requiredLockPath(entry.binary, "binary");
  return path.resolve(destination, ...archiveRoot.split("/"), ...binary.split("/"));
}

export async function installFfmpeg({
  lockPath = DEFAULT_LOCK_PATH,
  platform,
  destination,
  installToolImpl = installTool,
} = {}) {
  if (typeof lockPath !== "string" || lockPath.trim() === "") fail("INVALID_ARGUMENT", "FFmpeg lock path is required");
  if (typeof platform !== "string" || platform.trim() === "") fail("INVALID_ARGUMENT", "FFmpeg platform is required");
  if (typeof destination !== "string" || destination.trim() === "") fail("INVALID_ARGUMENT", "FFmpeg destination is required");
  if (typeof installToolImpl !== "function") fail("INVALID_ARGUMENT", "FFmpeg installer must be a function");

  const lock = await readToolsLock(lockPath);
  const entry = selectFfmpegLockEntry(lock, platform);
  const installation = await installToolImpl({
    lockPath,
    tool: "ffmpeg",
    platform,
    destination,
    limits: FFMPEG_INSTALL_LIMITS,
  });
  const installedDestination = installation?.destination ?? destination;
  const binaryPath = installedFfmpegPath(installedDestination, entry);
  let info;
  try {
    info = await lstat(binaryPath);
  } catch (error) {
    fail("BINARY_NOT_FOUND", `installed FFmpeg binary was not found at ${binaryPath}`, { binaryPath, cause: error });
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    fail("BINARY_INVALID", `installed FFmpeg binary is not a regular file: ${binaryPath}`, { binaryPath });
  }
  return binaryPath;
}

function takeArgument(argv, index, option) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) fail("INVALID_ARGUMENT", `${option} requires a value`);
  return value;
}

export function parseCliArgs(argv = process.argv.slice(2)) {
  if (!Array.isArray(argv)) fail("INVALID_ARGUMENT", "FFmpeg installer arguments must be an array");
  const options = { help: false, lockPath: DEFAULT_LOCK_PATH, platform: undefined, destination: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (argument === "--lock" || argument === "--platform" || argument === "--destination") {
      const value = takeArgument(argv, index, argument);
      if (argument === "--lock") options.lockPath = value;
      if (argument === "--platform") options.platform = value;
      if (argument === "--destination") options.destination = value;
      index += 1;
    } else if (argument.startsWith("--lock=") || argument.startsWith("--platform=") || argument.startsWith("--destination=")) {
      const separator = argument.indexOf("=");
      const option = argument.slice(0, separator);
      const value = argument.slice(separator + 1);
      if (!value) fail("INVALID_ARGUMENT", `${option} requires a value`);
      if (option === "--lock") options.lockPath = value;
      if (option === "--platform") options.platform = value;
      if (option === "--destination") options.destination = value;
    } else {
      fail("INVALID_ARGUMENT", `unknown command-line option ${JSON.stringify(argument)}`);
    }
  }
  if (options.help) return options;
  if (!options.platform || !options.destination) fail("INVALID_ARGUMENT", "--platform and --destination are required");
  return options;
}

export const CLI_USAGE = `Usage: node scripts/install-ffmpeg.mjs --platform PLATFORM --destination DIR [options]

Options:
  --platform PLATFORM  lock platform (linux-x64 or win-x64)
  --destination DIR    empty directory in which to install the verified archive
  --lock PATH           lock file (default: tools.lock.json)
  --help               show this help

The wrapper installs only the pinned ffmpeg lock entry with bounded archive limits and prints the installed binary path.`;

export async function main(argv = process.argv.slice(2)) {
  try {
    const options = parseCliArgs(argv);
    if (options.help) {
      console.log(CLI_USAGE);
      return 0;
    }
    console.log(await installFfmpeg(options));
    return 0;
  } catch (error) {
    if (error instanceof FfmpegInstallError || error instanceof ToolInstallerError) {
      console.error(`install-ffmpeg: [${error.code}] ${error.message}`);
    } else {
      console.error("install-ffmpeg: [INTERNAL_ERROR] installation failed");
    }
    return 2;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const modulePath = path.resolve(fileURLToPath(import.meta.url));
if (pathToFileURL(invokedPath).href === import.meta.url) process.exitCode = await main();
