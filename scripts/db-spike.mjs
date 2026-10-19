#!/usr/bin/env node

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

export const SQLITE_VEC_VERSION = "v0.1.9";
export const VECTOR_QUERY = Object.freeze([0.9, 0.1, 0]);
export const VECTOR_ROWS = Object.freeze([
  Object.freeze({ id: "north", rowid: 1n, values: Object.freeze([1, 0, 0]) }),
  Object.freeze({ id: "east", rowid: 2n, values: Object.freeze([0, 1, 0]) }),
  Object.freeze({ id: "up", rowid: 3n, values: Object.freeze([0, 0, 1]) }),
]);

export const VECTOR_REASON_CODES = Object.freeze({
  PACKAGE_UNAVAILABLE: "SQLITE_VEC_PACKAGE_UNAVAILABLE",
  PLATFORM_PACKAGE_UNAVAILABLE: "SQLITE_VEC_PLATFORM_PACKAGE_UNAVAILABLE",
  LOAD_FAILED: "SQLITE_VEC_LOAD_FAILED",
  VERSION_QUERY_FAILED: "SQLITE_VEC_VERSION_QUERY_FAILED",
  VERSION_MISMATCH: "SQLITE_VEC_VERSION_MISMATCH",
  KNN_FAILED: "SQLITE_VEC_KNN_FAILED",
});

const VECTOR_REASON_TEXT = Object.freeze({
  [VECTOR_REASON_CODES.PACKAGE_UNAVAILABLE]: "the pinned sqlite-vec package is unavailable",
  [VECTOR_REASON_CODES.PLATFORM_PACKAGE_UNAVAILABLE]: "the sqlite-vec platform package is unavailable",
  [VECTOR_REASON_CODES.LOAD_FAILED]: "the sqlite-vec extension could not be loaded",
  [VECTOR_REASON_CODES.VERSION_QUERY_FAILED]: "vec_version() could not be queried",
  [VECTOR_REASON_CODES.VERSION_MISMATCH]: "the loaded extension did not report sqlite-vec v0.1.9",
  [VECTOR_REASON_CODES.KNN_FAILED]: "the sqlite-vec KNN probe did not return the expected row",
});

function distanceSquared(left, right) {
  return left.reduce((sum, value, index) => sum + (value - right[index]) ** 2, 0);
}

export function nearestVector(vectors, query) {
  return vectors
    .map((vector) => ({ id: vector.id, distance: distanceSquared(vector.values, query) }))
    .sort((left, right) => left.distance - right.distance || left.id.localeCompare(right.id))[0];
}

function fallbackVectorResult(reasonCode) {
  const nearest = nearestVector(VECTOR_ROWS, VECTOR_QUERY);
  return {
    status: "UNQUALIFIED",
    mode: "FALLBACK",
    engine: "deterministic brute-force cosine-independent distance",
    nearest: nearest.id,
    distance: nearest.distance,
    reason_code: reasonCode,
    reason: VECTOR_REASON_TEXT[reasonCode] ?? "sqlite-vec qualification is unavailable",
  };
}

export function classifyVectorResult({ version, nearest }) {
  if (version !== SQLITE_VEC_VERSION) {
    return fallbackVectorResult(VECTOR_REASON_CODES.VERSION_MISMATCH);
  }
  if (!nearest || nearest.id !== "north" || !Number.isFinite(Number(nearest.distance))) {
    return fallbackVectorResult(VECTOR_REASON_CODES.KNN_FAILED);
  }
  return {
    status: "QUALIFIED",
    mode: "SQLITE_VEC",
    engine: "sqlite-vec",
    version,
    nearest: String(nearest.id),
    nearest_rowid: String(nearest.rowid),
    distance: Number(nearest.distance),
  };
}

function extensionFailure(database, reasonCode) {
  database.enableLoadExtension(false);
  return { ok: false, reason_code: reasonCode };
}

/**
 * Resolve sqlite-vec only through its pinned package exports. The package
 * chooses the fixed platform artifact; no caller-controlled path is accepted.
 */
export async function loadSqliteVecExtension(database) {
  let sqliteVec;
  try {
    sqliteVec = await import("sqlite-vec");
  } catch {
    return extensionFailure(database, VECTOR_REASON_CODES.PACKAGE_UNAVAILABLE);
  }

  let extensionPath;
  try {
    if (typeof sqliteVec.getLoadablePath !== "function") {
      return extensionFailure(database, VECTOR_REASON_CODES.PLATFORM_PACKAGE_UNAVAILABLE);
    }
    extensionPath = sqliteVec.getLoadablePath();
  } catch {
    return extensionFailure(database, VECTOR_REASON_CODES.PLATFORM_PACKAGE_UNAVAILABLE);
  }

  if (typeof extensionPath !== "string" || extensionPath.length === 0) {
    return extensionFailure(database, VECTOR_REASON_CODES.PLATFORM_PACKAGE_UNAVAILABLE);
  }

  try {
    database.loadExtension(extensionPath);
  } catch {
    return extensionFailure(database, VECTOR_REASON_CODES.LOAD_FAILED);
  } finally {
    // Close the extension boundary immediately after the one fixed load.
    database.enableLoadExtension(false);
  }

  let version;
  try {
    version = String(database.prepare("SELECT vec_version() AS version").get()?.version ?? "");
  } catch {
    return { ok: false, reason_code: VECTOR_REASON_CODES.VERSION_QUERY_FAILED };
  }
  if (version !== SQLITE_VEC_VERSION) {
    return { ok: false, reason_code: VECTOR_REASON_CODES.VERSION_MISMATCH };
  }
  return { ok: true, version };
}

export async function runVectorProbe(database, { loadExtension = loadSqliteVecExtension } = {}) {
  let extension;
  try {
    extension = await loadExtension(database);
  } catch {
    return fallbackVectorResult(VECTOR_REASON_CODES.LOAD_FAILED);
  }
  if (!extension?.ok) return fallbackVectorResult(extension?.reason_code ?? VECTOR_REASON_CODES.LOAD_FAILED);

  try {
    database.exec("CREATE VIRTUAL TABLE vectors USING vec0(embedding float[3], +id TEXT)");
    const insert = database.prepare("INSERT INTO vectors(rowid, embedding, id) VALUES (?, ?, ?)");
    for (const vector of VECTOR_ROWS) insert.run(vector.rowid, JSON.stringify(vector.values), vector.id);
    const nearest = database
      .prepare("SELECT rowid, distance, id FROM vectors WHERE embedding MATCH ? AND k = ? ORDER BY distance")
      .get(JSON.stringify(VECTOR_QUERY), 1);
    return classifyVectorResult({
      version: extension.version,
      nearest: nearest
        ? { id: String(nearest.id), rowid: nearest.rowid, distance: Number(nearest.distance) }
        : null,
    });
  } catch {
    return fallbackVectorResult(VECTOR_REASON_CODES.KNN_FAILED);
  }
}

/**
 * Phase 0 proves file-backed WAL + FTS5 and attempts the pinned sqlite-vec
 * extension. Unsupported package/platform combinations remain visible as an
 * UNQUALIFIED fallback rather than being reported as a qualification.
 */
export async function runDatabaseSpike() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lightphysics-db-spike-"));
  const databasePath = path.join(directory, "spike.sqlite");
  let database;
  try {
    database = new DatabaseSync(databasePath, { allowExtension: true });
    const journal = database.prepare("PRAGMA journal_mode = WAL").get();
    const journalMode = String(journal?.journal_mode ?? journal?.journalMode ?? "").toLowerCase();
    database.exec([
      "CREATE VIRTUAL TABLE documents USING fts5(content)",
      "INSERT INTO documents(content) VALUES ('light beam lighthouse')",
      "INSERT INTO documents(content) VALUES ('quiet ocean wind')",
    ].join(";"));
    const ftsRow = database
      .prepare("SELECT content FROM documents WHERE documents MATCH ? ORDER BY rank LIMIT 1")
      .get("light") ?? {};
    const vector = await runVectorProbe(database);
    if (journalMode !== "wal") throw new Error(`SQLite WAL probe returned ${journalMode || "no mode"}`);
    if (ftsRow.content !== "light beam lighthouse") throw new Error("SQLite FTS5 probe returned the wrong row");
    if (vector.nearest !== "north") throw new Error("vector probe returned the wrong nearest neighbor");
    return {
      status: "PASS",
      node: process.version,
      sqlite: "node:sqlite",
      journal_mode: journalMode,
      fts5: { query: "light", match: ftsRow.content },
      vector,
    };
  } finally {
    database?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

const invokedAsScript = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false;

if (invokedAsScript) {
  try {
    const result = await runDatabaseSpike();
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(`db-spike: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
