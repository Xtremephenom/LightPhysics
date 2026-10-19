import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deflateRawSync, gzipSync } from "node:zlib";
import {
  USAGE,
  ToolInstallerError,
  MAX_REMOTE_REDIRECTS,
  detectArchiveFormat,
  fetchRemoteArtifact,
  installTool,
  installVerifiedArchive,
  parseTarArchive,
  parseZipArchive,
  parseArguments,
  selectToolLockEntry,
  sha256Hex,
} from "../scripts/install-tools.mjs";

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
}

function makeZip(entries) {
  const localRecords = [];
  const centralRecords = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.data ?? "");
    const method = entry.method ?? 0;
    const flags = entry.flags ?? 0;
    const compressed = method === 8 ? deflateRawSync(data) : data;
    const checksum = crc32(data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    localRecords.push(Buffer.concat([local, compressed]));

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    const unixMode = entry.mode ?? (entry.directory ? 0o755 : 0o644);
    central.writeUInt32LE((unixMode << 16) | (entry.directory ? 0x10 : 0), 38);
    central.writeUInt32LE(localOffset, 42);
    name.copy(central, 46);
    centralRecords.push(central);
    localOffset += localRecords.at(-1).length;
  }
  const centralOffset = localOffset;
  const central = Buffer.concat(centralRecords);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([...localRecords, central, end]);
}

function writeTarOctal(buffer, offset, length, value) {
  const encoded = value.toString(8).padStart(length - 1, "0");
  buffer.write(`${encoded}\0`, offset, length, "ascii");
}

function writeTarField(buffer, offset, length, value) {
  const encoded = Buffer.from(value ?? "", "utf8");
  if (encoded.length > length) throw new Error(`fixture field is too long: ${value}`);
  encoded.copy(buffer, offset);
}

function tarChecksum(header) {
  let checksum = 0;
  for (let index = 0; index < header.length; index += 1) checksum += index >= 148 && index < 156 ? 0x20 : header[index];
  return checksum;
}

function makeTar(entries, { trailingBlocks = 2 } = {}) {
  const records = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.data ?? "");
    const header = Buffer.alloc(512);
    writeTarField(header, 0, 100, entry.name);
    writeTarOctal(header, 100, 8, entry.mode ?? (entry.type === "5" ? 0o755 : 0o644));
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, entry.size ?? data.length);
    writeTarOctal(header, 136, 12, 0);
    header[156] = (entry.type ?? "0").charCodeAt(0);
    writeTarField(header, 157, 100, entry.linkName);
    Buffer.from("ustar\0", "ascii").copy(header, 257);
    Buffer.from("00", "ascii").copy(header, 263);
    writeTarField(header, 265, 32, "root/root");
    writeTarField(header, 297, 32, "root/root");
    header.fill(0x20, 148, 156);
    writeTarOctal(header, 148, 8, tarChecksum(header));
    records.push(header);
    if (data.length > 0) {
      const paddedLength = Math.ceil(data.length / 512) * 512;
      const padded = Buffer.alloc(paddedLength);
      data.copy(padded);
      records.push(padded);
    }
  }
  records.push(Buffer.alloc(512 * trailingBlocks));
  return Buffer.concat(records);
}

async function missing(filePath) {
  await assert.rejects(lstat(filePath), { code: "ENOENT" });
}

function assertInstallerCode(error, code) {
  assert.equal(error instanceof ToolInstallerError, true);
  assert.equal(error.code, code);
  return true;
}

function makeRemoteResponse({ status = 200, url, location, body = Buffer.alloc(0), contentLength } = {}) {
  const headers = new Headers();
  if (location !== undefined) headers.set("location", location);
  if (contentLength !== undefined) headers.set("content-length", String(contentLength));
  const response = {
    status,
    ok: status >= 200 && status < 300,
    headers,
    arrayBuffer: async () => Uint8Array.from(Buffer.from(body)).buffer,
  };
  if (url !== undefined) response.url = url;
  return response;
}

function makeFetchSequence(responses) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const response = responses[calls.length - 1];
    if (!response) throw new Error("unexpected fake fetch call");
    return response;
  };
  return { calls, fetchImpl };
}

test("remote fetch follows one valid HTTPS redirect with manual bounded traversal", async () => {
  const startUrl = "https://github.com/example/project/releases/download/v1/tool.zip";
  const assetUrl = "https://release-assets.githubusercontent.com/example/tool.zip";
  const archive = Buffer.from("offline redirect fixture");
  const fake = makeFetchSequence([
    makeRemoteResponse({ status: 302, url: startUrl, location: assetUrl }),
    makeRemoteResponse({ status: 200, url: assetUrl, body: archive }),
  ]);

  assert.deepEqual(await fetchRemoteArtifact(startUrl, { fetchImpl: fake.fetchImpl }), archive);
  assert.deepEqual(fake.calls.map((call) => call.url), [startUrl, assetUrl]);
  assert.equal(fake.calls.every((call) => call.options.redirect === "manual"), true);
});

test("remote fetch rejects an HTTP redirect before making a second request", async () => {
  const startUrl = "https://example.invalid/archive.zip";
  const fake = makeFetchSequence([
    makeRemoteResponse({ status: 302, url: startUrl, location: "http://example.invalid/archive.zip" }),
  ]);

  await assert.rejects(
    fetchRemoteArtifact(startUrl, { fetchImpl: fake.fetchImpl }),
    (error) => assertInstallerCode(error, "INSECURE_URL"),
  );
  assert.equal(fake.calls.length, 1);
});

test("remote fetch rejects missing and malformed redirect locations", async () => {
  const startUrl = "https://example.invalid/archive.zip";
  for (const [location, code] of [[undefined, "REDIRECT_LOCATION_MISSING"], ["https://[invalid", "REDIRECT_LOCATION_INVALID"]]) {
    const fake = makeFetchSequence([makeRemoteResponse({ status: 302, url: startUrl, location })]);
    await assert.rejects(
      fetchRemoteArtifact(startUrl, { fetchImpl: fake.fetchImpl }),
      (error) => assertInstallerCode(error, code),
    );
  }
});

test("remote fetch rejects redirect loops and too many redirects", async () => {
  const firstUrl = "https://example.invalid/first.zip";
  const secondUrl = "https://example.invalid/second.zip";
  const loop = makeFetchSequence([
    makeRemoteResponse({ status: 302, url: firstUrl, location: secondUrl }),
    makeRemoteResponse({ status: 302, url: secondUrl, location: firstUrl }),
  ]);
  await assert.rejects(
    fetchRemoteArtifact(firstUrl, { fetchImpl: loop.fetchImpl }),
    (error) => assertInstallerCode(error, "REDIRECT_LOOP"),
  );

  const chain = Array.from({ length: MAX_REMOTE_REDIRECTS + 1 }, (_, index) => {
    const currentUrl = `https://example.invalid/chain-${index}.zip`;
    const nextUrl = `https://example.invalid/chain-${index + 1}.zip`;
    return makeRemoteResponse({ status: 302, url: currentUrl, location: nextUrl });
  });
  const tooMany = makeFetchSequence(chain);
  await assert.rejects(
    fetchRemoteArtifact("https://example.invalid/chain-0.zip", { fetchImpl: tooMany.fetchImpl }),
    (error) => assertInstallerCode(error, "REDIRECT_LIMIT"),
  );
  assert.equal(tooMany.calls.length, MAX_REMOTE_REDIRECTS + 1);
});

test("remote fetch validates the final URL and keeps the response-size bound", async () => {
  const insecureFinal = makeFetchSequence([
    makeRemoteResponse({ status: 200, url: "http://example.invalid/archive.zip", body: "ignored" }),
  ]);
  await assert.rejects(
    fetchRemoteArtifact("https://example.invalid/archive.zip", { fetchImpl: insecureFinal.fetchImpl }),
    (error) => assertInstallerCode(error, "INSECURE_URL"),
  );

  const oversized = makeFetchSequence([
    makeRemoteResponse({ status: 200, url: "https://example.invalid/archive.zip", body: "too large", contentLength: 9 }),
  ]);
  await assert.rejects(
    fetchRemoteArtifact("https://example.invalid/archive.zip", { fetchImpl: oversized.fetchImpl, limits: { maxArchiveBytes: 4 } }),
    (error) => assertInstallerCode(error, "ARCHIVE_TOO_LARGE"),
  );
});

test("stored and deflated ZIP entries extract after archive verification", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lightphysics-tools-"));
  try {
    const archive = makeZip([
      { name: "stored.txt", data: "stored payload" },
      { name: "nested/deflated.txt", data: "deflated payload", method: 8, flags: 0x0002 },
    ]);
    const archivePath = path.join(directory, "fixture.zip");
    const lockPath = path.join(directory, "tools.lock.json");
    await writeFile(archivePath, archive);
    await writeFile(lockPath, JSON.stringify({
      tools: {
        fixture: {
          version: "1.0.0",
          platforms: {
            "linux-x64": {
              url: "https://example.invalid/fixture.zip",
              sha256: sha256Hex(archive),
            },
          },
        },
      },
    }));
    const destination = path.join(directory, "installed");
    const result = await installTool({ lockPath, tool: "fixture", platform: "linux-x64", archivePath, destination });
    assert.equal(result.fileCount, 2);
    assert.equal(await readFile(path.join(destination, "stored.txt"), "utf8"), "stored payload");
    assert.equal(await readFile(path.join(destination, "nested", "deflated.txt"), "utf8"), "deflated payload");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ZIP and TAR executable bits are preserved without restoring unsafe mode bits", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lightphysics-tools-"));
  try {
    const zip = makeZip([{ name: "bin/tool", data: "zip executable", mode: 0o777 }]);
    const tar = makeTar([{ name: "bin/tool", data: "tar executable", mode: 0o777 }]);
    assert.equal(parseZipArchive(zip).entries[0].executable, true);
    assert.equal(parseTarArchive(tar).entries[0].executable, true);

    const zipDestination = path.join(directory, "zip-installed");
    const tarDestination = path.join(directory, "tar-installed");
    await installVerifiedArchive(zip, { destination: zipDestination, sha256: sha256Hex(zip) });
    await installVerifiedArchive(tar, { destination: tarDestination, sha256: sha256Hex(tar) });
    if (process.platform !== "win32") {
      assert.equal((await stat(path.join(zipDestination, "bin", "tool"))).mode & 0o022, 0);
      assert.equal((await stat(path.join(tarDestination, "bin", "tool"))).mode & 0o022, 0);
      assert.notEqual((await stat(path.join(zipDestination, "bin", "tool"))).mode & 0o111, 0);
      assert.notEqual((await stat(path.join(tarDestination, "bin", "tool"))).mode & 0o111, 0);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ZIP deflate compression-option flags are rejected for stored entries", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lightphysics-tools-"));
  try {
    for (const flags of [0x0002, 0x0004]) {
      const archive = makeZip([{ name: "stored.txt", data: "stored payload", flags }]);
      const destination = path.join(directory, `installed-${flags.toString(16)}`);
      await assert.rejects(
        installVerifiedArchive(archive, { destination, sha256: sha256Hex(archive) }),
        (error) => assertInstallerCode(error, "UNSUPPORTED_ZIP_ENTRY"),
      );
      await missing(destination);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a tampered archive is rejected before a destination is created", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lightphysics-tools-"));
  try {
    const archive = makeZip([{ name: "tool.txt", data: "original" }]);
    const tampered = Buffer.from(archive);
    tampered[0] ^= 0xff;
    const destination = path.join(directory, "installed");
    await assert.rejects(
      installVerifiedArchive(tampered, { destination, sha256: sha256Hex(archive) }),
      (error) => assertInstallerCode(error, "HASH_MISMATCH"),
    );
    await missing(destination);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("UNKNOWN lock values refuse local fixture installation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lightphysics-tools-"));
  try {
    const archive = makeZip([{ name: "tool.txt", data: "fixture" }]);
    const lockPath = path.join(directory, "tools.lock.json");
    await writeFile(lockPath, JSON.stringify({
      tools: {
        fixture: {
          version: "UNKNOWN",
          platforms: {
            "linux-x64": {
              url: "https://example.invalid/fixture.zip",
              sha256: sha256Hex(archive),
            },
          },
        },
      },
    }));
    await assert.rejects(
      installTool({
        lockPath,
        tool: "fixture",
        platform: "linux-x64",
        archive,
        destination: path.join(directory, "installed"),
      }),
      (error) => assertInstallerCode(error, "LOCK_UNKNOWN"),
    );
    await missing(path.join(directory, "installed"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("known artifact URLs may contain an unknown architecture label", () => {
  const entry = selectToolLockEntry({
    tools: {
      fixture: {
        version: "1.0.0",
        platforms: {
          "linux-x64": {
            url: "https://example.invalid/fixture-x86_64-unknown-linux-gnu.tar.gz",
            sha256: "a".repeat(64),
          },
        },
      },
    },
  }, { tool: "fixture", platform: "linux-x64" });
  assert.equal(entry.url.endsWith("-unknown-linux-gnu.tar.gz"), true);
});

test("ZIP traversal entries are rejected without writing outside the destination", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lightphysics-tools-"));
  try {
    const archive = makeZip([{ name: "../escape.txt", data: "must not extract" }]);
    const destination = path.join(directory, "installed");
    await assert.rejects(
      installVerifiedArchive(archive, { destination, sha256: sha256Hex(archive) }),
      (error) => assertInstallerCode(error, "ZIP_ENTRY_UNSAFE_PATH"),
    );
    await missing(destination);
    await missing(path.join(directory, "escape.txt"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("gzip-compressed TAR entries extract after archive verification", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lightphysics-tools-"));
  try {
    const archive = gzipSync(makeTar([
      { name: "uv/", type: "5" },
      { name: "uv/uv", data: "uv fixture" },
      { name: "uv/README.txt", data: "tar.gz fixture" },
    ]));
    const archivePath = path.join(directory, "fixture.tar.gz");
    const lockPath = path.join(directory, "tools.lock.json");
    await writeFile(archivePath, archive);
    await writeFile(lockPath, JSON.stringify({
      tools: {
        fixture: {
          version: "1.0.0",
          platforms: {
            "linux-x64": {
              url: "https://example.invalid/fixture.tar.gz",
              sha256: sha256Hex(archive),
            },
          },
        },
      },
    }));
    const destination = path.join(directory, "installed");
    const result = await installTool({ lockPath, tool: "fixture", platform: "linux-x64", archivePath, destination });
    assert.equal(detectArchiveFormat(archive), "tar.gz");
    assert.equal(result.fileCount, 2);
    assert.equal(result.directoryCount, 1);
    assert.equal(await readFile(path.join(destination, "uv", "uv"), "utf8"), "uv fixture");
    assert.equal(await readFile(path.join(destination, "uv", "README.txt"), "utf8"), "tar.gz fixture");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("xz TAR parsing uses the injected decompressor seam without a global xz dependency", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lightphysics-tools-"));
  try {
    const archive = Buffer.concat([Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]), Buffer.from("deterministic fixture")]);
    const tar = makeTar([{ name: "blender/blender", data: "xz fixture" }]);
    let called = false;
    const destination = path.join(directory, "installed");
    const result = await installVerifiedArchive(archive, {
      destination,
      sha256: sha256Hex(archive),
      xzDecompressor: async (input, context) => {
        called = true;
        assert.deepEqual(input, archive);
        assert.equal(context.maxOutputBytes > tar.length, true);
        return tar;
      },
    });
    assert.equal(detectArchiveFormat(archive), "tar.xz");
    assert.equal(called, true);
    assert.equal(result.fileCount, 1);
    assert.equal(await readFile(path.join(destination, "blender", "blender"), "utf8"), "xz fixture");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("safe TAR symlinks resolve inside the staged archive and are created after regular files", async () => {
  const archive = makeTar([
    { name: "bin/", type: "5" },
    { name: "bin/target", data: "symlink target", mode: 0o755 },
    { name: "bin/link", type: "2", linkName: "target" },
  ]);
  const parsed = parseTarArchive(archive);
  assert.equal(parsed.entries.at(-1)?.symlink, true);
  assert.equal(parsed.entries.at(-1)?.linkTarget, "bin/target");

  const unsafe = makeTar([
    { name: "bin/", type: "5" },
    { name: "bin/link", type: "2", linkName: "../../escape" },
  ]);
  await assert.rejects(
    Promise.resolve().then(() => parseTarArchive(unsafe)),
    (error) => assertInstallerCode(error, "TAR_ENTRY_UNSAFE_PATH"),
  );

  if (process.platform === "win32") return;
  const directory = await mkdtemp(path.join(os.tmpdir(), "lightphysics-tools-"));
  try {
    const destination = path.join(directory, "installed");
    await installVerifiedArchive(archive, { destination, sha256: sha256Hex(archive) });
    const link = await lstat(path.join(destination, "bin", "link"));
    assert.equal(link.isSymbolicLink(), true);
    assert.equal(await readFile(path.join(destination, "bin", "link"), "utf8"), "symlink target");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("GNU TAR long-name metadata is consumed only for the following entry", async () => {
  const archive = makeTar([
    { name: "././@LongLink", type: "L", data: "bin/long-name\u0000" },
    { name: "fallback", data: "long-name payload" },
  ]);
  const parsed = parseTarArchive(archive);
  assert.deepEqual(parsed.entries.map((entry) => entry.canonicalName), ["bin/long-name"]);

  const directory = await mkdtemp(path.join(os.tmpdir(), "lightphysics-tools-"));
  try {
    const destination = path.join(directory, "installed");
    await installVerifiedArchive(archive, { destination, sha256: sha256Hex(archive) });
    assert.equal(await readFile(path.join(destination, "bin", "long-name"), "utf8"), "long-name payload");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  for (const type of ["L", "K"]) {
    const orphan = makeTar([{ name: "././@LongLink", type, data: "orphan\u0000" }]);
    await assert.rejects(
      Promise.resolve().then(() => parseTarArchive(orphan)),
      (error) => assertInstallerCode(error, "INVALID_TAR"),
    );
  }
});

test("TAR path normalization rejects traversal, absolute, drive, and UNC paths", async () => {
  const names = ["../escape.txt", "/absolute.txt", "C:\\escape.txt", "\\\\server\\share\\escape.txt"];
  for (const name of names) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "lightphysics-tools-"));
    try {
      const archive = makeTar([{ name, data: "must not extract" }]);
      await assert.rejects(
        installVerifiedArchive(archive, { destination: path.join(directory, "installed"), sha256: sha256Hex(archive) }),
        (error) => assertInstallerCode(error, "TAR_ENTRY_UNSAFE_PATH"),
      );
      await missing(path.join(directory, "installed"));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  const nulArchive = makeTar([{ name: "safe\u0000unsafe.txt", data: "must not extract" }]);
  await assert.rejects(
    installVerifiedArchive(nulArchive, { destination: path.join(os.tmpdir(), "lightphysics-nul-installed"), sha256: sha256Hex(nulArchive) }),
    (error) => assertInstallerCode(error, "TAR_ENTRY_UNSAFE_PATH"),
  );
});

test("TAR hardlink, special, and metadata entries are rejected", async () => {
  for (const type of ["1", "3", "4", "6", "7", "x", "g"]) {
    const archive = makeTar([{ name: `entry-${type}`, type, linkName: type === "1" || type === "2" ? "target" : undefined }]);
    await assert.rejects(
      installVerifiedArchive(archive, { destination: path.join(os.tmpdir(), `lightphysics-unused-${type}`), sha256: sha256Hex(archive) }),
      (error) => assertInstallerCode(error, "UNSUPPORTED_TAR_ENTRY"),
    );
  }
});

test("TAR checksums, configured sizes, and file-directory collisions fail before extraction", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lightphysics-tools-"));
  try {
    const badChecksum = makeTar([{ name: "checksum.txt", data: "payload" }]);
    badChecksum[0] ^= 0x01;
    await assert.rejects(
      installVerifiedArchive(badChecksum, { destination: path.join(directory, "checksum"), sha256: sha256Hex(badChecksum) }),
      (error) => assertInstallerCode(error, "TAR_CHECKSUM_MISMATCH"),
    );

    const oversized = makeTar([{ name: "large.txt", data: "1234" }]);
    await assert.rejects(
      installVerifiedArchive(oversized, {
        destination: path.join(directory, "oversized"),
        sha256: sha256Hex(oversized),
        limits: { maxEntryUncompressedBytes: 3 },
      }),
      (error) => assertInstallerCode(error, "TAR_SIZE_LIMIT"),
    );

    const collision = makeTar([
      { name: "tool", data: "file" },
      { name: "tool/bin", data: "nested file" },
    ]);
    await assert.rejects(
      installVerifiedArchive(collision, { destination: path.join(directory, "collision"), sha256: sha256Hex(collision) }),
      (error) => assertInstallerCode(error, "DUPLICATE_TAR_ENTRY"),
    );
    const incompleteEnd = makeTar([{ name: "incomplete.txt", data: "payload" }], { trailingBlocks: 1 });
    await assert.rejects(
      installVerifiedArchive(incompleteEnd, { destination: path.join(directory, "incomplete"), sha256: sha256Hex(incompleteEnd) }),
      (error) => assertInstallerCode(error, "INVALID_TAR"),
    );
    const trailingData = Buffer.concat([makeTar([{ name: "trailing.txt", data: "payload" }]), Buffer.alloc(512, 1)]);
    await assert.rejects(
      installVerifiedArchive(trailingData, { destination: path.join(directory, "trailing"), sha256: sha256Hex(trailingData) }),
      (error) => assertInstallerCode(error, "INVALID_TAR"),
    );
    await missing(path.join(directory, "checksum"));
    await missing(path.join(directory, "oversized"));
    await missing(path.join(directory, "collision"));
    await missing(path.join(directory, "incomplete"));
    await missing(path.join(directory, "trailing"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI help and archive argument wording name supported formats", () => {
  assert.equal(parseArguments(["--help"]).help, true);
  assert.match(USAGE, /ZIP, tar\.gz, or tar\.xz/);
  assert.match(USAGE, /local xz executable/);
});
