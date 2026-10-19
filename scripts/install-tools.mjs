#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync, inflateRawSync } from "node:zlib";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_LOCK_PATH = path.resolve(SCRIPT_DIRECTORY, "..", "tools.lock.json");

export const DEFAULT_LIMITS = Object.freeze({
  maxArchiveBytes: 64 * 1024 * 1024,
  maxEntries: 4_096,
  maxEntryUncompressedBytes: 128 * 1024 * 1024,
  maxTotalUncompressedBytes: 512 * 1024 * 1024,
});

const ZIP_SIGNATURES = Object.freeze({
  centralDirectory: 0x02014b50,
  endOfCentralDirectory: 0x06054b50,
  localFile: 0x04034b50,
});
const ZIP_ALLOWED_FLAGS = 0x0808;
const ZIP_DEFLATE_OPTION_FLAGS = 0x0002 | 0x0004;
const ZIP_DIRECTORY_MODE = 0x4000;
const ZIP_REGULAR_MODE = 0x8000;
const ZIP_SYMLINK_MODE = 0xa000;
const ZIP_REPARSE_POINT = 0x0400;
const ZIP_EOCD_SIZE = 22;
const ZIP_EOCD_MAX_COMMENT = 0xffff;
const ZIP_CENTRAL_HEADER_SIZE = 46;
const ZIP_LOCAL_HEADER_SIZE = 30;
const TAR_BLOCK_SIZE = 512;
const TAR_HEADER_SIZE = TAR_BLOCK_SIZE;
const TAR_END_BLOCK_COUNT = 2;
const TAR_MAGIC_OFFSET = 257;
const TAR_MAGIC_LENGTH = 6;
const TAR_XZ_MAGIC = Object.freeze([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]);
const XZ_TIMEOUT_MS = 30_000;
export const MAX_REMOTE_REDIRECTS = 3;
const REMOTE_FETCH_TIMEOUT_MS = 30_000;
const REDIRECT_STATUS_MIN = 300;
const REDIRECT_STATUS_MAX = 399;

const CP437_EXTENDED =
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export class ToolInstallerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ToolInstallerError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ToolInstallerError(code, message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isUnknown(value) {
  if (typeof value !== "string" || value.trim() === "") return true;
  return /(?:^|-)UNKNOWN$/i.test(value.trim());
}

function assertPositiveLimit(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail("INVALID_ARGUMENT", `${name} must be a positive integer`);
  }
}

function getLimits(overrides = {}) {
  if (!isRecord(overrides)) fail("INVALID_ARGUMENT", "archive limits must be an object");
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  for (const name of Object.keys(DEFAULT_LIMITS)) assertPositiveLimit(limits[name], name);
  return limits;
}

function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  fail("INVALID_ARGUMENT", "archive data must be a Buffer or Uint8Array");
}

function readUInt16(buffer, offset) {
  if (offset < 0 || offset + 2 > buffer.length) fail("INVALID_ZIP", "ZIP header is truncated");
  return buffer.readUInt16LE(offset);
}

function readUInt32(buffer, offset) {
  if (offset < 0 || offset + 4 > buffer.length) fail("INVALID_ZIP", "ZIP header is truncated");
  return buffer.readUInt32LE(offset);
}

function ensureRange(buffer, offset, length, code = "INVALID_ZIP") {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > buffer.length) {
    fail(code, "ZIP entry exceeds the archive boundary");
  }
}

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

export function sha256Hex(value) {
  return createHash("sha256").update(asBuffer(value)).digest("hex");
}

function decodeZipName(rawName, utf8) {
  if (rawName.includes(0)) fail("ZIP_ENTRY_UNSAFE_PATH", "ZIP entry names cannot contain NUL bytes");
  if (utf8) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(rawName);
    } catch {
      fail("INVALID_ZIP", "ZIP entry name is not valid UTF-8");
    }
  }
  let decoded = "";
  for (const byte of rawName) decoded += byte < 0x80 ? String.fromCharCode(byte) : CP437_EXTENDED[byte - 0x80] ?? "�";
  return decoded;
}

function normalizeEntryName(name, unsafePathCode = "ZIP_ENTRY_UNSAFE_PATH") {
  const archiveLabel = unsafePathCode === "TAR_ENTRY_UNSAFE_PATH" ? "TAR" : "ZIP";
  if (typeof name !== "string" || name.length === 0 || name.includes("\u0000")) {
    fail(unsafePathCode, `${archiveLabel} entry name is empty or contains NUL bytes`);
  }
  const slashName = name.replaceAll("\\", "/");
  if (slashName.startsWith("/") || /^[A-Za-z]:/.test(slashName) || slashName.startsWith("//")) {
    fail(unsafePathCode, `${archiveLabel} entry path is absolute or drive-qualified`);
  }
  const rawParts = slashName.split("/");
  if (rawParts.some((part) => part === "..")) fail(unsafePathCode, `${archiveLabel} entry path contains traversal`);
  const parts = rawParts.filter((part) => part !== "" && part !== ".");
  if (parts.length === 0) fail(unsafePathCode, `${archiveLabel} entry path resolves to the archive root`);
  return {
    canonicalName: parts.join("/"),
    directory: slashName.endsWith("/"),
    parts,
  };
}

function normalizeTarLinkTarget(entryName, linkName) {
  if (typeof linkName !== "string" || linkName.length === 0 || linkName.includes("\u0000")) {
    fail("TAR_ENTRY_UNSAFE_PATH", "TAR symlink target is empty or contains NUL bytes");
  }
  const slashName = linkName.replaceAll("\\", "/");
  if (slashName.startsWith("/") || /^[A-Za-z]:/.test(slashName) || slashName.startsWith("//")) {
    fail("TAR_ENTRY_UNSAFE_PATH", "TAR symlink target is absolute or drive-qualified");
  }
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(entryName), slashName));
  if (target === "." || target === ".." || target.startsWith("../")) {
    fail("TAR_ENTRY_UNSAFE_PATH", "TAR symlink target escapes the archive root");
  }
  return target;
}

function ensureTarRange(buffer, offset, length) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > buffer.length) {
    fail("INVALID_TAR", "TAR entry exceeds the archive boundary");
  }
}

function isZeroBlock(buffer, offset) {
  ensureTarRange(buffer, offset, TAR_BLOCK_SIZE);
  for (let index = offset; index < offset + TAR_BLOCK_SIZE; index += 1) {
    if (buffer[index] !== 0) return false;
  }
  return true;
}

function decodeTarString(buffer, offset, length, label, errorCode = "INVALID_TAR") {
  ensureTarRange(buffer, offset, length);
  const raw = buffer.subarray(offset, offset + length);
  const terminator = raw.indexOf(0);
  const value = terminator < 0 ? raw : raw.subarray(0, terminator);
  const paddingStart = terminator < 0 ? raw.length : terminator + 1;
  for (let index = paddingStart; index < raw.length; index += 1) {
    if (raw[index] !== 0) fail(errorCode, `${label} field has non-zero data after its terminator`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    fail(errorCode, `${label} field is not valid UTF-8`);
  }
}

function parseTarOctal(buffer, offset, length, label) {
  ensureTarRange(buffer, offset, length);
  const raw = buffer.subarray(offset, offset + length);
  let end = raw.length;
  while (end > 0 && (raw[end - 1] === 0 || raw[end - 1] === 0x20)) end -= 1;
  let start = 0;
  while (start < end && raw[start] === 0x20) start += 1;
  if (start === end) return 0;
  for (let index = start; index < end; index += 1) {
    if (raw[index] < 0x30 || raw[index] > 0x37) fail("INVALID_TAR", `${label} field is not valid octal`);
  }
  const value = Number.parseInt(raw.subarray(start, end).toString("ascii"), 8);
  if (!Number.isSafeInteger(value)) fail("INVALID_TAR", `${label} field is too large`);
  return value;
}

function tarHeaderChecksum(header) {
  const expected = parseTarOctal(header, 148, 8, "TAR checksum");
  let actual = 0;
  for (let index = 0; index < TAR_HEADER_SIZE; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  if (actual !== expected) fail("TAR_CHECKSUM_MISMATCH", "TAR header checksum does not match");
}

function hasValidTarChecksum(header) {
  try {
    tarHeaderChecksum(header);
    return true;
  } catch {
    return false;
  }
}

function isSupportedTarMagic(header) {
  const magic = header.subarray(TAR_MAGIC_OFFSET, TAR_MAGIC_OFFSET + TAR_MAGIC_LENGTH);
  const oldStyle = magic.every((byte) => byte === 0);
  const ustarNul = magic.equals(Buffer.from("ustar\0", "ascii"));
  const ustarSpace = magic.equals(Buffer.from("ustar ", "ascii"));
  return oldStyle || ustarNul || ustarSpace;
}

function looksLikeRawTar(buffer) {
  if (buffer.length < TAR_END_BLOCK_COUNT * TAR_BLOCK_SIZE || buffer.length % TAR_BLOCK_SIZE !== 0) return false;
  if (isZeroBlock(buffer, 0) && isZeroBlock(buffer, TAR_BLOCK_SIZE)) return true;
  const header = buffer.subarray(0, TAR_HEADER_SIZE);
  return isSupportedTarMagic(header) || hasValidTarChecksum(header);
}

export function detectArchiveFormat(archive) {
  const buffer = asBuffer(archive);
  if (buffer.length >= 4) {
    const signature = buffer.readUInt32LE(0);
    if (signature === ZIP_SIGNATURES.localFile || signature === ZIP_SIGNATURES.endOfCentralDirectory) return "zip";
  }
  if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) return "tar.gz";
  if (buffer.length >= TAR_XZ_MAGIC.length && TAR_XZ_MAGIC.every((byte, index) => buffer[index] === byte)) return "tar.xz";
  if (looksLikeRawTar(buffer)) return "tar";
  fail("UNSUPPORTED_ARCHIVE", "archive format is not supported; expected ZIP, tar.gz, or tar.xz");
}

function tarOutputLimit(limits) {
  const overhead = (limits.maxEntries + TAR_END_BLOCK_COUNT) * TAR_BLOCK_SIZE;
  const maximum = limits.maxTotalUncompressedBytes + overhead;
  if (!Number.isSafeInteger(maximum)) fail("INVALID_ARGUMENT", "TAR output limits are too large");
  return maximum;
}

function checkTarCollisions(entries) {
  const fileNames = new Set(entries.filter((entry) => !entry.directory).map((entry) => entry.canonicalName));
  for (const entry of entries) {
    const parts = entry.canonicalName.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      if (fileNames.has(parts.slice(0, index).join("/"))) fail("DUPLICATE_TAR_ENTRY", "TAR file and directory entries collide");
    }
  }
}

export function parseTarArchive(archive, options = {}) {
  const limits = getLimits(options.limits);
  const buffer = asBuffer(archive);
  const maxTarBytes = options.maxTarBytes ?? limits.maxArchiveBytes;
  assertPositiveLimit(maxTarBytes, "maxTarBytes");
  if (buffer.length > maxTarBytes) fail("ARCHIVE_TOO_LARGE", "TAR archive exceeds the configured size limit");
  if (buffer.length < TAR_END_BLOCK_COUNT * TAR_BLOCK_SIZE || buffer.length % TAR_BLOCK_SIZE !== 0) {
    fail("INVALID_TAR", "TAR archive is not block-aligned or has no end records");
  }

  const entries = [];
  const names = new Set();
  let totalUncompressedBytes = 0;
  let cursor = 0;
  let recordCount = 0;
  let pendingLongName = null;
  let pendingLongLink = null;
  let ended = false;
  while (cursor < buffer.length) {
    ensureTarRange(buffer, cursor, TAR_HEADER_SIZE);
    if (isZeroBlock(buffer, cursor)) {
      if (cursor + TAR_BLOCK_SIZE >= buffer.length || !isZeroBlock(buffer, cursor + TAR_BLOCK_SIZE)) {
        fail("INVALID_TAR", "TAR archive has an incomplete end-of-archive record");
      }
      for (let index = cursor + TAR_END_BLOCK_COUNT * TAR_BLOCK_SIZE; index < buffer.length; index += 1) {
        if (buffer[index] !== 0) fail("INVALID_TAR", "TAR archive has data after its end records");
      }
      ended = true;
      break;
    }
    if (recordCount >= limits.maxEntries) fail("TAR_ENTRY_LIMIT", "TAR archive exceeds the configured entry-count limit");
    recordCount += 1;

    const header = buffer.subarray(cursor, cursor + TAR_HEADER_SIZE);
    tarHeaderChecksum(header);
    if (!isSupportedTarMagic(header)) fail("UNSUPPORTED_TAR", "TAR header format is not supported");

    const typeFlag = header[156];
    const isRegular = typeFlag === 0 || typeFlag === 0x30;
    const isDirectory = typeFlag === 0x35;
    const isSymlink = typeFlag === 0x32;
    const isLongName = typeFlag === 0x4c;
    const isLongLink = typeFlag === 0x4b;
    const mode = parseTarOctal(header, 100, 8, "TAR mode");
    const size = parseTarOctal(header, 124, 12, "TAR size");
    if (size > limits.maxEntryUncompressedBytes) fail("TAR_SIZE_LIMIT", "TAR entry exceeds the configured size limit");
    const dataStart = cursor + TAR_HEADER_SIZE;
    const paddedSize = size === 0 ? 0 : Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
    ensureTarRange(buffer, dataStart, paddedSize);
    if (isLongName || isLongLink) {
      const value = decodeTarString(buffer, dataStart, size, isLongName ? "TAR long name" : "TAR long link", "TAR_ENTRY_UNSAFE_PATH");
      if (isLongName) {
        if (pendingLongName !== null) fail("INVALID_TAR", "TAR long-name metadata was not followed by an entry");
        pendingLongName = value;
      } else {
        if (pendingLongLink !== null) fail("INVALID_TAR", "TAR long-link metadata was not followed by an entry");
        pendingLongLink = value;
      }
      cursor = dataStart + paddedSize;
      continue;
    }
    if (!isRegular && !isDirectory && !isSymlink) {
      fail("UNSUPPORTED_TAR_ENTRY", "TAR hardlink, special, and metadata entries are not supported");
    }

    if ((isDirectory || isSymlink) && size !== 0) fail("INVALID_TAR", "TAR directory and symlink entries cannot contain data");
    if (size > limits.maxTotalUncompressedBytes - totalUncompressedBytes) {
      fail("TAR_SIZE_LIMIT", "TAR contents exceed the configured size limit");
    }

    const name = pendingLongName ?? decodeTarString(header, 0, 100, "TAR name", "TAR_ENTRY_UNSAFE_PATH");
    const prefix = decodeTarString(header, 345, 155, "TAR prefix", "TAR_ENTRY_UNSAFE_PATH");
    const linkName = pendingLongLink ?? decodeTarString(header, 157, 100, "TAR link");
    pendingLongName = null;
    pendingLongLink = null;
    const normalized = normalizeEntryName(prefix === "" ? name : `${prefix}/${name}`, "TAR_ENTRY_UNSAFE_PATH");
    if (isRegular && normalized.directory) fail("INVALID_TAR", "TAR regular-file entries cannot end with a slash");
    if (!isSymlink && linkName !== "") fail("UNSUPPORTED_TAR_ENTRY", "TAR link metadata is not supported");
    const linkTarget = isSymlink ? normalizeTarLinkTarget(normalized.canonicalName, linkName) : null;

    if (names.has(normalized.canonicalName)) fail("DUPLICATE_TAR_ENTRY", "TAR contains duplicate entry names");
    names.add(normalized.canonicalName);
    totalUncompressedBytes += size;
    entries.push({
      ...normalized,
      directory: isDirectory,
      symlink: isSymlink,
      linkTarget,
      pathErrorCode: "TAR_ENTRY_UNSAFE_PATH",
      executable: isRegular && (mode & 0o111) !== 0,
      size,
      dataStart,
      dataEnd: dataStart + size,
    });
    cursor = dataStart + paddedSize;
  }
  if (!ended) fail("INVALID_TAR", "TAR archive end-of-archive records are missing");
  if (pendingLongName !== null || pendingLongLink !== null) fail("INVALID_TAR", "TAR long-name metadata was not followed by an entry");
  checkTarCollisions(entries);
  return {
    archiveBytes: buffer.length,
    entries,
    totalUncompressedBytes,
  };
}

function findEndOfCentralDirectory(buffer) {
  const firstCandidate = Math.max(0, buffer.length - ZIP_EOCD_SIZE - ZIP_EOCD_MAX_COMMENT);
  for (let offset = buffer.length - ZIP_EOCD_SIZE; offset >= firstCandidate; offset -= 1) {
    if (offset < 0 || readUInt32(buffer, offset) !== ZIP_SIGNATURES.endOfCentralDirectory) continue;
    const commentLength = readUInt16(buffer, offset + 20);
    if (offset + ZIP_EOCD_SIZE + commentLength === buffer.length) return offset;
  }
  return -1;
}

function rejectZip64(value, label) {
  if (value === 0xffff || value === 0xffffffff) fail("UNSUPPORTED_ZIP64", `ZIP64 ${label} is not supported`);
}

function inspectEntryType(versionMadeBy, externalAttributes) {
  const madeByUnix = versionMadeBy >>> 8 === 3;
  const unixMode = (externalAttributes >>> 16) & 0xffff;
  const unixType = unixMode & 0xf000;
  const dosType = externalAttributes & 0xf000;
  if (unixType === ZIP_SYMLINK_MODE || dosType === ZIP_SYMLINK_MODE || (externalAttributes & ZIP_REPARSE_POINT) !== 0) {
    fail("UNSUPPORTED_ZIP_ENTRY", "ZIP symlink and reparse-point entries are not supported");
  }
  if (versionMadeBy >>> 8 === 3 && unixType !== 0 && unixType !== ZIP_DIRECTORY_MODE && unixType !== ZIP_REGULAR_MODE) {
    fail("UNSUPPORTED_ZIP_ENTRY", "ZIP special-file entries are not supported");
  }
  const directory = unixType === ZIP_DIRECTORY_MODE;
  return { directory, executable: madeByUnix && !directory && (unixMode & 0o111) !== 0 };
}

function parseCentralEntry(buffer, offset, centralEnd) {
  ensureRange(buffer, offset, ZIP_CENTRAL_HEADER_SIZE);
  if (readUInt32(buffer, offset) !== ZIP_SIGNATURES.centralDirectory) fail("INVALID_ZIP", "ZIP central directory is malformed");
  const versionMadeBy = readUInt16(buffer, offset + 4);
  const flags = readUInt16(buffer, offset + 8);
  const method = readUInt16(buffer, offset + 10);
  const crc = readUInt32(buffer, offset + 16);
  const compressedSize = readUInt32(buffer, offset + 20);
  const uncompressedSize = readUInt32(buffer, offset + 24);
  const nameLength = readUInt16(buffer, offset + 28);
  const extraLength = readUInt16(buffer, offset + 30);
  const commentLength = readUInt16(buffer, offset + 32);
  const diskNumber = readUInt16(buffer, offset + 34);
  const externalAttributes = readUInt32(buffer, offset + 38);
  const localOffset = readUInt32(buffer, offset + 42);
  rejectZip64(compressedSize, "entry sizes");
  rejectZip64(uncompressedSize, "entry sizes");
  rejectZip64(localOffset, "local offsets");
  if ((flags & (0x0001 | 0x0040 | 0x2000)) !== 0) fail("ENCRYPTED_ZIP_ENTRY", "encrypted ZIP entries are not supported");
  if ((flags & ZIP_DEFLATE_OPTION_FLAGS) !== 0 && method !== 8) {
    fail("UNSUPPORTED_ZIP_ENTRY", "ZIP deflate compression-option flags require deflate compression");
  }
  const allowedFlags = ZIP_ALLOWED_FLAGS | (method === 8 ? ZIP_DEFLATE_OPTION_FLAGS : 0);
  if ((flags & ~allowedFlags) !== 0) fail("UNSUPPORTED_ZIP_ENTRY", "ZIP entry flags are not supported");
  if (method !== 0 && method !== 8) fail("UNSUPPORTED_COMPRESSION", "ZIP entry compression method is not supported");
  if (diskNumber !== 0) fail("UNSUPPORTED_ZIP_ENTRY", "multi-volume ZIP entries are not supported");
  const headerLength = ZIP_CENTRAL_HEADER_SIZE + nameLength + extraLength + commentLength;
  ensureRange(buffer, offset, headerLength);
  if (offset + headerLength > centralEnd) fail("INVALID_ZIP", "ZIP central directory entry exceeds its boundary");
  const rawName = buffer.subarray(offset + ZIP_CENTRAL_HEADER_SIZE, offset + ZIP_CENTRAL_HEADER_SIZE + nameLength);
  const name = decodeZipName(rawName, (flags & 0x0800) !== 0);
  const normalized = normalizeEntryName(name);
  const type = inspectEntryType(versionMadeBy, externalAttributes);
  return {
    ...normalized,
    directory: normalized.directory || type.directory,
    flags,
    method,
    crc,
    compressedSize,
    uncompressedSize,
    localOffset,
    nextOffset: offset + headerLength,
    executable: type.executable,
  };
}

function attachLocalData(buffer, entry, centralOffset) {
  ensureRange(buffer, entry.localOffset, ZIP_LOCAL_HEADER_SIZE);
  if (readUInt32(buffer, entry.localOffset) !== ZIP_SIGNATURES.localFile) fail("INVALID_ZIP", "ZIP local file header is malformed");
  const localFlags = readUInt16(buffer, entry.localOffset + 6);
  const localMethod = readUInt16(buffer, entry.localOffset + 8);
  const localCrc = readUInt32(buffer, entry.localOffset + 14);
  const localCompressedSize = readUInt32(buffer, entry.localOffset + 18);
  const localUncompressedSize = readUInt32(buffer, entry.localOffset + 22);
  const localNameLength = readUInt16(buffer, entry.localOffset + 26);
  const localExtraLength = readUInt16(buffer, entry.localOffset + 28);
  if (localFlags !== entry.flags || localMethod !== entry.method) fail("INVALID_ZIP", "ZIP local and central headers disagree");
  rejectZip64(localCompressedSize, "local sizes");
  rejectZip64(localUncompressedSize, "local sizes");
  const dataStart = entry.localOffset + ZIP_LOCAL_HEADER_SIZE + localNameLength + localExtraLength;
  ensureRange(buffer, entry.localOffset + ZIP_LOCAL_HEADER_SIZE, localNameLength + localExtraLength);
  const localRawName = buffer.subarray(entry.localOffset + ZIP_LOCAL_HEADER_SIZE, entry.localOffset + ZIP_LOCAL_HEADER_SIZE + localNameLength);
  const localName = decodeZipName(localRawName, (entry.flags & 0x0800) !== 0);
  const localNormalized = normalizeEntryName(localName);
  if (localNormalized.canonicalName !== entry.canonicalName || localNormalized.directory !== entry.directory && !entry.directory) {
    fail("INVALID_ZIP", "ZIP local and central entry names disagree");
  }
  if ((entry.flags & 0x0008) === 0 && (localCrc !== entry.crc || localCompressedSize !== entry.compressedSize || localUncompressedSize !== entry.uncompressedSize)) {
    fail("INVALID_ZIP", "ZIP local and central entry sizes disagree");
  }
  if (dataStart > centralOffset || entry.compressedSize > centralOffset - dataStart) fail("INVALID_ZIP", "ZIP entry data overlaps the central directory");
  return { ...entry, dataStart, dataEnd: dataStart + entry.compressedSize };
}

function checkEntryRanges(entries) {
  const ranges = entries
    .filter((entry) => entry.compressedSize > 0)
    .map((entry) => ({ start: entry.dataStart, end: entry.dataEnd }))
    .sort((left, right) => left.start - right.start);
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index - 1].end > ranges[index].start) fail("INVALID_ZIP", "ZIP entry data overlaps another entry");
  }
}

export function parseZipArchive(archive, options = {}) {
  const limits = getLimits(options.limits);
  const buffer = asBuffer(archive);
  if (buffer.length > limits.maxArchiveBytes) fail("ARCHIVE_TOO_LARGE", "archive exceeds the configured size limit");
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== ZIP_SIGNATURES.localFile && buffer.readUInt32LE(0) !== ZIP_SIGNATURES.endOfCentralDirectory) {
    fail("UNSUPPORTED_ARCHIVE", "only ZIP archives are supported; provide a ZIP artifact");
  }
  const eocdOffset = findEndOfCentralDirectory(buffer);
  if (eocdOffset < 0) fail("INVALID_ZIP", "ZIP end-of-central-directory record is missing");
  const diskNumber = readUInt16(buffer, eocdOffset + 4);
  const centralDisk = readUInt16(buffer, eocdOffset + 6);
  const entriesOnDisk = readUInt16(buffer, eocdOffset + 8);
  const totalEntries = readUInt16(buffer, eocdOffset + 10);
  const centralSize = readUInt32(buffer, eocdOffset + 12);
  const centralOffset = readUInt32(buffer, eocdOffset + 16);
  rejectZip64(entriesOnDisk, "entry count");
  rejectZip64(totalEntries, "entry count");
  rejectZip64(centralSize, "central directory size");
  rejectZip64(centralOffset, "central directory offset");
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== totalEntries) fail("UNSUPPORTED_ZIP_ENTRY", "multi-volume ZIP archives are not supported");
  if (totalEntries > limits.maxEntries) fail("ZIP_ENTRY_LIMIT", "archive exceeds the configured entry-count limit");
  ensureRange(buffer, centralOffset, centralSize);
  const centralEnd = centralOffset + centralSize;
  if (centralEnd > eocdOffset) fail("INVALID_ZIP", "ZIP central directory is outside the archive layout");
  const entries = [];
  let cursor = centralOffset;
  let totalUncompressedBytes = 0;
  const names = new Set();
  for (let index = 0; index < totalEntries; index += 1) {
    const entry = parseCentralEntry(buffer, cursor, centralEnd);
    if (names.has(entry.canonicalName)) fail("DUPLICATE_ZIP_ENTRY", "ZIP contains duplicate entry names");
    names.add(entry.canonicalName);
    if (entry.uncompressedSize > limits.maxEntryUncompressedBytes) fail("ZIP_SIZE_LIMIT", "ZIP entry exceeds the configured size limit");
    totalUncompressedBytes += entry.uncompressedSize;
    if (totalUncompressedBytes > limits.maxTotalUncompressedBytes) fail("ZIP_SIZE_LIMIT", "ZIP contents exceed the configured size limit");
    entries.push(entry);
    cursor = entry.nextOffset;
  }
  if (cursor !== centralEnd) fail("INVALID_ZIP", "ZIP central directory has trailing records");
  const withData = entries.map((entry) => attachLocalData(buffer, entry, centralOffset));
  checkEntryRanges(withData);
  const fileNames = new Set(withData.filter((entry) => !entry.directory).map((entry) => entry.canonicalName));
  for (const entry of withData) {
    const parts = entry.canonicalName.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      if (fileNames.has(parts.slice(0, index).join("/"))) fail("DUPLICATE_ZIP_ENTRY", "ZIP file and directory entries collide");
    }
    if (entry.directory && (entry.compressedSize !== 0 || entry.uncompressedSize !== 0)) fail("INVALID_ZIP", "ZIP directory entries cannot contain data");
  }
  return {
    archiveBytes: buffer.length,
    entries: withData,
    totalUncompressedBytes,
  };
}

function inflateEntry(buffer, entry, limits) {
  const compressed = buffer.subarray(entry.dataStart, entry.dataEnd);
  let output;
  if (entry.method === 0) {
    if (entry.compressedSize !== entry.uncompressedSize) fail("INVALID_ZIP", "stored ZIP entry sizes disagree");
    output = compressed;
  } else if (entry.method === 8) {
    try {
      output = inflateRawSync(compressed, { maxOutputLength: Math.max(1, limits.maxEntryUncompressedBytes) });
    } catch {
      fail("INVALID_ZIP", "deflated ZIP entry could not be decompressed");
    }
  } else {
    fail("UNSUPPORTED_COMPRESSION", "ZIP entry compression method is not supported");
  }
  if (output.length !== entry.uncompressedSize) fail("INVALID_ZIP", "ZIP entry decompressed size disagrees");
  if (crc32(output) !== entry.crc) fail("ZIP_CRC_MISMATCH", "ZIP entry CRC-32 does not match");
  return output;
}

function gzipTar(buffer, limits) {
  const maximum = tarOutputLimit(limits);
  let output;
  try {
    output = gunzipSync(buffer, { maxOutputLength: maximum });
  } catch (error) {
    if (error?.code === "ERR_BUFFER_TOO_LARGE" || /maxOutputLength|too large/i.test(error?.message ?? "")) {
      fail("ARCHIVE_TOO_LARGE", "decompressed TAR archive exceeds the configured size limit");
    }
    fail("INVALID_TAR_GZIP", "gzip-compressed TAR archive could not be decompressed");
  }
  if (output.length > maximum) fail("ARCHIVE_TOO_LARGE", "decompressed TAR archive exceeds the configured size limit");
  return output;
}

function xzOutputBuffer(value, maximum) {
  let output;
  try {
    output = asBuffer(value);
  } catch (error) {
    if (error instanceof ToolInstallerError) throw error;
    fail("INVALID_XZ", "xz decompressor returned invalid data");
  }
  if (output.length > maximum) fail("ARCHIVE_TOO_LARGE", "decompressed TAR archive exceeds the configured size limit");
  return output;
}

function runLocalXz(buffer, maximum) {
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let timer;
    const chunks = [];
    let total = 0;
    const finish = (error, output) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (error) reject(error);
      else resolve(output);
    };
    try {
      child = spawn("xz", ["--decompress", "--stdout", "--format=xz"], {
        env: { ...process.env, XZ_DEFAULTS: "", XZ_OPT: "" },
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      finish(new ToolInstallerError("XZ_UNAVAILABLE", "local xz executable is unavailable"));
      return;
    }
    timer = setTimeout(() => {
      child.kill();
      finish(new ToolInstallerError("XZ_TIMEOUT", "local xz decompression timed out"));
    }, XZ_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      const output = asBuffer(chunk);
      total += output.length;
      if (total > maximum) {
        child.kill();
        finish(new ToolInstallerError("ARCHIVE_TOO_LARGE", "decompressed TAR archive exceeds the configured size limit"));
        return;
      }
      chunks.push(output);
    });
    child.stderr.resume();
    child.once("error", (error) => {
      if (error?.code === "ENOENT" || error?.code === "EACCES" || error?.code === "EPERM") finish(new ToolInstallerError("XZ_UNAVAILABLE", "local xz executable is unavailable"));
      else finish(new ToolInstallerError("XZ_DECOMPRESS_FAILED", "local xz decompression could not be started"));
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      if (code !== 0 || signal !== null) {
        finish(new ToolInstallerError("INVALID_XZ", "xz could not decompress the archive"));
        return;
      }
      finish(null, Buffer.concat(chunks, total));
    });
    child.stdin.once("error", () => finish(new ToolInstallerError("XZ_DECOMPRESS_FAILED", "archive data could not be sent to xz")));
    try {
      child.stdin.end(buffer);
    } catch {
      finish(new ToolInstallerError("XZ_DECOMPRESS_FAILED", "archive data could not be sent to xz"));
    }
  });
}

async function xzTar(buffer, limits, options) {
  const maximum = tarOutputLimit(limits);
  const injected = options.xzDecompressor ?? options.xzDecompress ?? options.decompressXz;
  if (injected !== undefined) {
    if (typeof injected !== "function") fail("INVALID_ARGUMENT", "xz decompressor seam must be a function");
    try {
      return xzOutputBuffer(await injected(buffer, { limits, maxOutputBytes: maximum }), maximum);
    } catch (error) {
      if (error instanceof ToolInstallerError) throw error;
      fail("INVALID_XZ", "injected xz decompression failed");
    }
  }
  return xzOutputBuffer(await runLocalXz(buffer, maximum), maximum);
}

async function parseVerifiedArchive(buffer, limits, options) {
  const format = detectArchiveFormat(buffer);
  if (format === "zip") return { format, buffer, parsed: parseZipArchive(buffer, { limits }) };
  if (format === "tar") return { format, buffer, parsed: parseTarArchive(buffer, { limits }) };
  const tarBuffer = format === "tar.gz" ? gzipTar(buffer, limits) : await xzTar(buffer, limits, options);
  return {
    format,
    buffer: tarBuffer,
    parsed: parseTarArchive(tarBuffer, { limits, maxTarBytes: tarOutputLimit(limits) }),
  };
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function assertNoSymlinksInPath(target) {
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  const remainder = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (const part of remainder) {
    current = path.join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) fail("DESTINATION_INVALID", "destination contains a symbolic link");
    } catch (error) {
      if (error instanceof ToolInstallerError) throw error;
      if (error?.code === "ENOENT") return;
      fail("DESTINATION_INVALID", "destination could not be inspected");
    }
  }
}

async function safeDestinationPath(destination) {
  if (typeof destination !== "string" || destination.trim() === "") fail("INVALID_ARGUMENT", "destination is required");
  const absolute = path.resolve(destination);
  if (absolute === path.parse(absolute).root) fail("DESTINATION_INVALID", "destination must not be a filesystem root");
  await assertNoSymlinksInPath(path.dirname(absolute));
  try {
    const info = await lstat(absolute);
    if (info.isSymbolicLink() || !info.isDirectory()) fail("DESTINATION_INVALID", "destination must be a directory and not a symbolic link");
    if ((await readdir(absolute)).length !== 0) fail("DESTINATION_NOT_EMPTY", "destination must be empty");
  } catch (error) {
    if (error instanceof ToolInstallerError) throw error;
    if (error?.code !== "ENOENT") fail("DESTINATION_INVALID", "destination could not be inspected");
  }
  return absolute;
}

async function extractParsedArchive(buffer, parsed, destination, limits, format) {
  await mkdir(destination, { recursive: true });
  await assertNoSymlinksInPath(destination);
  const symlinks = [];
  for (const entry of parsed.entries) {
    const outputPath = path.resolve(destination, ...entry.parts);
    if (!isWithin(destination, outputPath)) fail(entry.pathErrorCode ?? (format === "tar" ? "TAR_ENTRY_UNSAFE_PATH" : "ZIP_ENTRY_UNSAFE_PATH"), "archive entry escaped the destination");
    await assertNoSymlinksInPath(outputPath);
    if (entry.directory) {
      try {
        await mkdir(outputPath, { recursive: true });
      } catch {
        fail("EXTRACTION_FAILED", "could not create an extracted directory");
      }
      continue;
    }
    if (entry.symlink) {
      symlinks.push({ entry, outputPath });
      continue;
    }
    const output = format === "tar" ? buffer.subarray(entry.dataStart, entry.dataEnd) : inflateEntry(buffer, entry, limits);
    try {
      await mkdir(path.dirname(outputPath), { recursive: true });
      await assertNoSymlinksInPath(path.dirname(outputPath));
      await writeFile(outputPath, output, { flag: "wx", mode: entry.executable ? 0o755 : 0o644 });
    } catch (error) {
      if (error instanceof ToolInstallerError) throw error;
      fail("EXTRACTION_FAILED", "could not write an extracted file");
    }
  }
  const symlinksByName = new Map(symlinks.map((item) => [item.entry.canonicalName, item]));
  const resolvingSymlinks = new Set();
  const resolvedSymlinks = new Set();
  const resolveSymlinkTarget = async (item) => {
    const { entry } = item;
    if (resolvedSymlinks.has(entry.canonicalName)) return;
    if (resolvingSymlinks.has(entry.canonicalName)) fail("TAR_SYMLINK_CYCLE", `TAR symlink cycle includes ${entry.canonicalName}`);
    resolvingSymlinks.add(entry.canonicalName);
    const targetParts = entry.linkTarget.split("/");
    for (let index = 1; index < targetParts.length; index += 1) {
      const component = targetParts.slice(0, index).join("/");
      if (symlinksByName.has(component)) fail("TAR_SYMLINK_TARGET_INVALID", `TAR symlink target traverses another symlink: ${entry.canonicalName} -> ${entry.linkTarget}`);
    }
    const targetItem = symlinksByName.get(entry.linkTarget);
    if (targetItem) {
      await resolveSymlinkTarget(targetItem);
    } else {
      const targetPath = path.resolve(destination, ...targetParts);
      if (!isWithin(destination, targetPath)) fail("TAR_ENTRY_UNSAFE_PATH", "TAR symlink target escaped the destination");
      await assertNoSymlinksInPath(targetPath);
      let targetInfo;
      try {
        targetInfo = await lstat(targetPath);
      } catch {
        fail("TAR_SYMLINK_TARGET_MISSING", `TAR symlink target does not exist: ${entry.canonicalName} -> ${entry.linkTarget}`);
      }
      if (targetInfo.isSymbolicLink() || (!targetInfo.isFile() && !targetInfo.isDirectory())) {
        fail("TAR_SYMLINK_TARGET_INVALID", `TAR symlink target is not a regular extracted path: ${entry.canonicalName} -> ${entry.linkTarget}`);
      }
    }
    resolvingSymlinks.delete(entry.canonicalName);
    resolvedSymlinks.add(entry.canonicalName);
  };
  for (const item of symlinks) await resolveSymlinkTarget(item);
  for (const { entry, outputPath } of symlinks) {
    const targetPath = path.resolve(destination, ...entry.linkTarget.split("/"));
    if (!isWithin(destination, targetPath)) fail("TAR_ENTRY_UNSAFE_PATH", "TAR symlink target escaped the destination");
    await assertNoSymlinksInPath(path.dirname(outputPath));
    try {
      await symlink(path.relative(path.dirname(outputPath), targetPath), outputPath);
    } catch {
      fail("EXTRACTION_FAILED", "could not create a safe TAR symlink");
    }
  }
  return {
    fileCount: parsed.entries.filter((entry) => !entry.directory).length,
    directoryCount: parsed.entries.filter((entry) => entry.directory).length,
  };
}

async function archiveInputToBuffer(archive) {
  if (typeof archive === "string") {
    try {
      return await readFile(archive);
    } catch {
      fail("LOCAL_ARCHIVE_READ_FAILED", "local archive could not be read");
    }
  }
  return asBuffer(archive);
}

function validateExpectedSha256(value) {
  if (isUnknown(value)) fail("LOCK_UNKNOWN", "lock entry SHA-256 is UNKNOWN and cannot be installed");
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value.trim())) fail("LOCK_INVALID_VALUE", "lock entry SHA-256 must be 64 hexadecimal characters");
  return value.trim().toLowerCase();
}

export async function installVerifiedArchive(archive, options = {}) {
  if (!isRecord(options)) fail("INVALID_ARGUMENT", "archive install options must be an object");
  const limits = getLimits(options.limits);
  const expectedSha256 = validateExpectedSha256(options.sha256);
  const buffer = await archiveInputToBuffer(archive);
  if (buffer.length > limits.maxArchiveBytes) fail("ARCHIVE_TOO_LARGE", "archive exceeds the configured size limit");
  const actualSha256 = sha256Hex(buffer);
  if (actualSha256 !== expectedSha256) fail("HASH_MISMATCH", "archive SHA-256 does not match the lock entry");
  const prepared = await parseVerifiedArchive(buffer, limits, options);
  const destination = await safeDestinationPath(options.destination);
  const parent = path.dirname(destination);
  try {
    await mkdir(parent, { recursive: true });
    await assertNoSymlinksInPath(parent);
  } catch (error) {
    if (error instanceof ToolInstallerError) throw error;
    fail("DESTINATION_INVALID", "destination parent could not be prepared");
  }
  let stage;
  try {
    stage = await mkdtemp(path.join(parent, ".lp-tool-stage-"));
  } catch {
    fail("DESTINATION_INVALID", "temporary installation directory could not be created");
  }
  try {
    const extracted = await extractParsedArchive(prepared.buffer, prepared.parsed, stage, limits, prepared.format === "zip" ? "zip" : "tar");
    let destinationExists = false;
    try {
      const info = await lstat(destination);
      destinationExists = true;
      if (info.isSymbolicLink() || !info.isDirectory()) fail("DESTINATION_INVALID", "destination must be a directory and not a symbolic link");
      if ((await readdir(destination)).length !== 0) fail("DESTINATION_NOT_EMPTY", "destination must be empty");
    } catch (error) {
      if (error instanceof ToolInstallerError) throw error;
      if (error?.code !== "ENOENT") fail("DESTINATION_INVALID", "destination could not be inspected");
    }
    if (destinationExists) await rmdir(destination);
    await rename(stage, destination);
    return {
      archiveSha256: actualSha256,
      destination,
      fileCount: extracted.fileCount,
      directoryCount: extracted.directoryCount,
    };
  } catch (error) {
    if (error instanceof ToolInstallerError) throw error;
    fail("EXTRACTION_FAILED", "verified archive could not be installed");
  } finally {
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function extractZipArchive(archive, destination, options = {}) {
  if (!isRecord(options) || options.sha256 === undefined) fail("INVALID_ARGUMENT", "sha256 is required before ZIP extraction");
  return installVerifiedArchive(archive, { ...options, destination });
}

export async function extractTarArchive(archive, destination, options = {}) {
  if (!isRecord(options) || options.sha256 === undefined) fail("INVALID_ARGUMENT", "sha256 is required before TAR extraction");
  return installVerifiedArchive(archive, { ...options, destination });
}

export async function readToolsLock(lockPath = DEFAULT_LOCK_PATH) {
  let raw;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch {
    fail("LOCK_READ_FAILED", "tools.lock.json could not be read");
  }
  let lock;
  try {
    lock = JSON.parse(raw);
  } catch {
    fail("LOCK_INVALID", "tools.lock.json is not valid JSON");
  }
  if (!isRecord(lock) || !isRecord(lock.tools)) fail("LOCK_INVALID", "tools.lock.json has no valid tools map");
  return lock;
}

function assertKnownLockValue(value, label) {
  if (isUnknown(value)) fail("LOCK_UNKNOWN", `lock entry ${label} is UNKNOWN and cannot be installed`);
  if (typeof value !== "string") fail("LOCK_INVALID_VALUE", `lock entry ${label} must be a string`);
  return value.trim();
}

export function selectToolLockEntry(lock, { tool, platform, component } = {}) {
  if (!isRecord(lock) || !isRecord(lock.tools)) fail("LOCK_INVALID", "tools.lock.json has no valid tools map");
  if (typeof tool !== "string" || tool.trim() === "" || typeof platform !== "string" || platform.trim() === "") {
    fail("INVALID_ARGUMENT", "tool and platform are required");
  }
  const toolRecord = lock.tools[tool];
  if (!isRecord(toolRecord)) fail("LOCK_TOOL_NOT_FOUND", "requested tool is not present in tools.lock.json");
  const version = assertKnownLockValue(toolRecord.version, "version");
  let platformMap;
  if (component !== undefined) {
    if (typeof component !== "string" || component.trim() === "") fail("INVALID_ARGUMENT", "component must be non-empty");
    platformMap = toolRecord[component];
  } else {
    platformMap = toolRecord.platforms;
    if (!isRecord(platformMap) && isRecord(toolRecord[platform])) platformMap = toolRecord;
  }
  if (!isRecord(platformMap)) fail("LOCK_PLATFORM_NOT_FOUND", "requested tool component map is not present");
  const artifact = platformMap[platform];
  if (!isRecord(artifact)) fail("LOCK_PLATFORM_NOT_FOUND", "requested tool platform is not present");
  const url = assertKnownLockValue(artifact.url, "URL");
  const sha256 = validateExpectedSha256(artifact.sha256);
  return {
    tool,
    platform,
    component: component ?? null,
    version,
    url,
    sha256,
  };
}

function assertHttpsUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("INSECURE_URL", "remote artifact URL must be HTTPS");
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") fail("INSECURE_URL", "remote artifact URL must be HTTPS without embedded credentials");
  return parsed.href;
}

async function responseToBuffer(response, limits) {
  const declaredLength = Number(response.headers?.get?.("content-length"));
  if (Number.isSafeInteger(declaredLength) && declaredLength > limits.maxArchiveBytes) fail("ARCHIVE_TOO_LARGE", "remote archive exceeds the configured size limit");
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        const chunk = asBuffer(result.value);
        total += chunk.length;
        if (total > limits.maxArchiveBytes) {
          await reader.cancel();
          fail("ARCHIVE_TOO_LARGE", "remote archive exceeds the configured size limit");
        }
        chunks.push(chunk);
      }
    } catch (error) {
      if (error instanceof ToolInstallerError) throw error;
      fail("REMOTE_FETCH_FAILED", "remote archive response could not be read");
    }
    return Buffer.concat(chunks, total);
  }
  try {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > limits.maxArchiveBytes) fail("ARCHIVE_TOO_LARGE", "remote archive exceeds the configured size limit");
    return buffer;
  } catch (error) {
    if (error instanceof ToolInstallerError) throw error;
    fail("REMOTE_FETCH_FAILED", "remote archive response could not be read");
  }
}

function isRedirectResponse(response) {
  return Number.isInteger(response?.status) && response.status >= REDIRECT_STATUS_MIN && response.status <= REDIRECT_STATUS_MAX;
}

function resolveRedirectLocation(response, currentUrl) {
  let location;
  try {
    location = response.headers?.get?.("location");
  } catch {
    fail("REDIRECT_LOCATION_INVALID", "remote redirect location could not be read");
  }
  if (typeof location !== "string" || location.trim() === "") fail("REDIRECT_LOCATION_MISSING", "remote redirect did not provide a location");
  let resolved;
  try {
    resolved = new URL(location, currentUrl).href;
  } catch {
    fail("REDIRECT_LOCATION_INVALID", "remote redirect location is invalid");
  }
  return assertHttpsUrl(resolved);
}

async function fetchRemoteResponse(fetchImpl, url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REMOTE_FETCH_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { redirect: "manual", signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) fail("REMOTE_FETCH_TIMEOUT", "remote artifact request timed out");
    fail("REMOTE_FETCH_FAILED", "remote artifact request failed");
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchRemoteArtifact(url, options = {}) {
  const limits = getLimits(options.limits);
  let currentUrl = assertHttpsUrl(url);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") fail("REMOTE_FETCH_FAILED", "this Node runtime has no fetch implementation");
  const visitedUrls = new Set([currentUrl]);
  let redirectCount = 0;
  while (true) {
    const response = await fetchRemoteResponse(fetchImpl, currentUrl);
    if (response?.url) assertHttpsUrl(response.url);
    if (isRedirectResponse(response)) {
      if (redirectCount >= MAX_REMOTE_REDIRECTS) fail("REDIRECT_LIMIT", "remote artifact exceeded the redirect limit");
      const nextUrl = resolveRedirectLocation(response, currentUrl);
      if (visitedUrls.has(nextUrl)) fail("REDIRECT_LOOP", "remote artifact redirect loop detected");
      visitedUrls.add(nextUrl);
      currentUrl = nextUrl;
      redirectCount += 1;
      continue;
    }
    if (!response?.ok) fail("REMOTE_FETCH_FAILED", "remote artifact request failed");
    return responseToBuffer(response, limits);
  }
}

async function loadArtifact(entry, options, limits) {
  const hasArchive = options.archive !== undefined;
  const hasArchivePath = options.archivePath !== undefined;
  if (hasArchive && hasArchivePath) fail("INVALID_ARGUMENT", "provide one local archive source");
  if (hasArchive) {
    const buffer = asBuffer(options.archive);
    if (buffer.length > limits.maxArchiveBytes) fail("ARCHIVE_TOO_LARGE", "archive exceeds the configured size limit");
    return buffer;
  }
  if (hasArchivePath) {
    if (typeof options.archivePath !== "string" || options.archivePath.trim() === "") fail("INVALID_ARGUMENT", "local archive path must be non-empty");
    try {
      const buffer = await readFile(options.archivePath);
      if (buffer.length > limits.maxArchiveBytes) fail("ARCHIVE_TOO_LARGE", "archive exceeds the configured size limit");
      return buffer;
    } catch (error) {
      if (error instanceof ToolInstallerError) throw error;
      fail("LOCAL_ARCHIVE_READ_FAILED", "local archive could not be read");
    }
  }
  return fetchRemoteArtifact(entry.url, { limits, fetchImpl: options.fetchImpl });
}

export async function installTool(options = {}) {
  if (!isRecord(options)) fail("INVALID_ARGUMENT", "tool install options must be an object");
  const limits = getLimits(options.limits);
  const lock = await readToolsLock(options.lockPath ?? DEFAULT_LOCK_PATH);
  const entry = selectToolLockEntry(lock, options);
  const archive = await loadArtifact(entry, options, limits);
  const result = await installVerifiedArchive(archive, {
    destination: options.destination,
    limits,
    sha256: entry.sha256,
    xzDecompressor: options.xzDecompressor,
    xzDecompress: options.xzDecompress,
  });
  return { ...result, component: entry.component, platform: entry.platform, tool: entry.tool, version: entry.version };
}

export const USAGE = `Usage: node scripts/install-tools.mjs --tool NAME --platform PLATFORM --destination DIR [options]

Options:
  --lock PATH         lock file (default: tools.lock.json)
  --component NAME    component map such as Godot's editor
  --archive PATH      use a local verified ZIP, tar.gz, or tar.xz fixture instead of contacting the network
  --max-archive-bytes N  lower the archive-size limit for a bounded run
  --help              show this help

Only HTTPS remote URLs and ZIP (stored/deflated), tar.gz, and tar.xz archives are supported. Remote fetches follow at most ${MAX_REMOTE_REDIRECTS} HTTPS redirects and reject loops, credentials, and non-HTTPS locations.
tar.xz uses a fixed local xz executable when available; otherwise it fails with XZ_UNAVAILABLE.
UNKNOWN lock values are never installable.`;

function takeArgument(argv, index, option) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) fail("INVALID_ARGUMENT", `${option} requires a value`);
  return value;
}

export function parseArguments(argv = process.argv.slice(2)) {
  const options = { help: false, lockPath: undefined, tool: undefined, platform: undefined, component: undefined, destination: undefined, archivePath: undefined, maxArchiveBytes: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (argument === "--lock") {
      options.lockPath = takeArgument(argv, index, argument);
      index += 1;
    } else if (argument === "--tool") {
      options.tool = takeArgument(argv, index, argument);
      index += 1;
    } else if (argument === "--platform") {
      options.platform = takeArgument(argv, index, argument);
      index += 1;
    } else if (argument === "--component") {
      options.component = takeArgument(argv, index, argument);
      index += 1;
    } else if (argument === "--destination") {
      options.destination = takeArgument(argv, index, argument);
      index += 1;
    } else if (argument === "--archive" || argument === "--fixture") {
      options.archivePath = takeArgument(argv, index, argument);
      index += 1;
    } else if (argument === "--max-archive-bytes") {
      const value = Number(takeArgument(argv, index, argument));
      if (!Number.isSafeInteger(value) || value <= 0) fail("INVALID_ARGUMENT", "--max-archive-bytes must be a positive integer");
      options.maxArchiveBytes = value;
      index += 1;
    } else {
      fail("INVALID_ARGUMENT", "unknown command-line option");
    }
  }
  if (options.help) return options;
  if (!options.tool || !options.platform || !options.destination) fail("INVALID_ARGUMENT", "--tool, --platform, and --destination are required");
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArguments(argv);
    if (options.help) {
      console.log(USAGE);
      return 0;
    }
    const limits = options.maxArchiveBytes === undefined ? undefined : { maxArchiveBytes: options.maxArchiveBytes };
    const result = await installTool({ ...options, limits });
    console.log(`installed ${result.tool}/${result.platform}: ${result.fileCount} file(s)`);
    return 0;
  } catch (error) {
    if (error instanceof ToolInstallerError) {
      console.error(`install-tools: [${error.code}] ${error.message}`);
    } else {
      console.error("install-tools: [INTERNAL_ERROR] installation failed");
    }
    return 2;
  }
}

const isMain = process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) process.exitCode = await main();
