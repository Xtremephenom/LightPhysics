import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CasHashRejectedError,
  CasPathRejectedError,
  ContentAddressedStore,
  Ledger,
  verifyLedgerFile,
} from "./index.ts";

function temporaryHome(): string {
  return mkdtempSync(path.join(os.tmpdir(), "lightphysics-ledger-test-"));
}

function withHome<T>(callback: (home: string) => T): T {
  const home = temporaryHome();
  try {
    return callback(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function dropAppendOnlyTriggers(ledger: Ledger): void {
  ledger.db.exec(`
    DROP TRIGGER ledger_records_no_update;
    DROP TRIGGER ledger_records_no_delete;
    DROP TRIGGER ledger_heads_no_update;
    DROP TRIGGER ledger_heads_no_delete;
    DROP TRIGGER artifacts_no_update;
    DROP TRIGGER artifacts_no_delete;
    DROP TRIGGER evidence_no_update;
    DROP TRIGGER evidence_no_delete;
    DROP TRIGGER approvals_no_update;
    DROP TRIGGER approvals_no_delete;
    DROP TRIGGER audit_records_no_update;
    DROP TRIGGER audit_records_no_delete;
  `);
}

function appendFour(ledger: Ledger): void {
  ledger.appendArtifact("artifact-1", { z: 1, a: "asset", sources: [{ url: "https://example.test/a" }] }, {
    timestamp: "2026-01-01T00:00:00.000Z",
  });
  ledger.appendEvidence("evidence-1", { result: "pass", references: ["artifact:artifact-1"] }, {
    timestamp: "2026-01-01T00:00:01.000Z",
  });
  ledger.appendApproval("approval-1", { decision: "accepted", subject: "artifact-1" }, {
    timestamp: "2026-01-01T00:00:02.000Z",
  });
  ledger.appendAudit("audit-1", { action: "append", subject: "approval-1" }, {
    timestamp: "2026-01-01T00:00:03.000Z",
  });
}

test("persistent Ledger opens a WAL database and applies versioned migrations", () => {
  withHome((home) => {
    const ledger = new Ledger({ home });
    const journal = ledger.db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string };
    assert.equal(String(journal.journal_mode).toLowerCase(), "wal");
    const tables = ledger.db.prepare(
      "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name",
    ).all() as Array<{ name: string }>;
    const names = new Set(tables.map((row) => row.name));
    for (const name of [
      "ledger_migrations", "ledger_meta", "ledger_records", "ledger_heads",
      "artifacts", "evidence", "approvals", "audit_records", "audit_log",
    ]) assert.equal(names.has(name), true, `missing ${name}`);
    assert.equal((ledger.db.prepare("SELECT version FROM ledger_migrations").get() as { version?: number }).version, 1);
    assert.equal((ledger.db.prepare("PRAGMA user_version").get() as { user_version?: number }).user_version, 1);
    assert.deepEqual(ledger.verify(), {
      ok: true,
      valid: true,
      status: "verified",
      checkedRecords: 0,
      head: { sequence: 0, hash: "" },
      issues: [],
    });
    ledger.close();

    const reopened = new Ledger({ home });
    assert.equal(reopened.listRecords().length, 0);
    assert.equal(reopened.verify().ok, true);
    reopened.close();
  });
});

test("persistent Ledger appends all typed record kinds in one deterministic hash chain", () => {
  withHome((home) => {
    const ledger = new Ledger({ home });
    appendFour(ledger);
    const records = ledger.listRecords();
    assert.deepEqual(records.map((record) => record.recordType), ["artifact", "evidence", "approval", "audit"]);
    assert.equal(records[0]?.payloadJson, '{"a":"asset","sources":[{"url":"https://example.test/a"}],"z":1}');
    assert.equal(records[0]?.prevHash, "");
    assert.equal(records[1]?.prevHash, records[0]?.hash);
    assert.match(records[3]?.hash ?? "", /^[0-9a-f]{64}$/);
    assert.deepEqual(records[0]?.payload, { a: "asset", sources: [{ url: "https://example.test/a" }], z: 1 });
    assert.deepEqual(ledger.getArtifact("artifact-1")?.payload, {
      a: "asset",
      sources: [{ url: "https://example.test/a" }],
      z: 1,
    });
    assert.equal(ledger.listEvidence().length, 1);
    assert.equal(ledger.listApprovals().length, 1);
    assert.equal(ledger.listAudits().length, 1);
    assert.equal(ledger.verify().ok, true);
    assert.equal(ledger.verify().checkedRecords, 4);
    assert.equal(ledger.verify().head.sequence, 4);
    ledger.close();
  });
});

test("persistent Ledger detects edited rows after trigger bypass", () => {
  withHome((home) => {
    const ledger = new Ledger({ home });
    appendFour(ledger);
    dropAppendOnlyTriggers(ledger);
    ledger.db.prepare("UPDATE ledger_records SET payload_json = ? WHERE sequence = 2").run('{"edited":true}');
    const result = ledger.verify();
    assert.equal(result.ok, false);
    assert.equal(result.issues.some((issue) => issue.code === "EditedRecord"), true);
    ledger.close();
  });
});

test("persistent Ledger detects deletion of the last record after trigger bypass", () => {
  withHome((home) => {
    const ledger = new Ledger({ home });
    appendFour(ledger);
    dropAppendOnlyTriggers(ledger);
    ledger.db.exec("PRAGMA foreign_keys = OFF; DELETE FROM audit_records WHERE sequence = 4; DELETE FROM ledger_records WHERE sequence = 4;");
    const result = ledger.verify();
    assert.equal(result.ok, false);
    assert.equal(result.issues.some((issue) => issue.code === "DeletedRecord" || issue.code === "ChainHeadMismatch"), true);
    ledger.close();
  });
});

test("persistent Ledger detects reordered records after trigger bypass", () => {
  withHome((home) => {
    const ledger = new Ledger({ home });
    appendFour(ledger);
    dropAppendOnlyTriggers(ledger);
    ledger.db.exec("PRAGMA foreign_keys = OFF;");
    ledger.db.exec("UPDATE ledger_records SET sequence = -sequence WHERE sequence IN (1, 2)");
    const result = ledger.verify();
    assert.equal(result.ok, false);
    assert.equal(result.issues.some((issue) => issue.code === "ReorderedRecord" || issue.code === "MissingSequence"), true);
    ledger.close();
  });
});

test("persistent Ledger rejects normal UPDATE and DELETE operations through SQLite triggers", () => {
  withHome((home) => {
    const ledger = new Ledger({ home });
    const record = ledger.appendArtifact("artifact-1", { value: 1 });
    assert.throws(
      () => ledger.db.prepare("UPDATE ledger_records SET payload_json = ? WHERE sequence = ?").run("{}", record.sequence),
      /append-only/i,
    );
    assert.throws(() => ledger.db.prepare("DELETE FROM ledger_records WHERE sequence = ?").run(record.sequence), /append-only/i);
    assert.throws(() => ledger.db.prepare("UPDATE artifacts SET payload_json = ? WHERE id = ?").run("{}", "artifact-1"), /append-only/i);
    assert.throws(() => ledger.db.prepare("DELETE FROM artifacts WHERE id = ?").run("artifact-1"), /append-only/i);
    ledger.close();
  });
});

test("persistent Ledger canonicalizes object keys and bounds sources/references JSON", () => {
  withHome((home) => {
    const ledger = new Ledger({ home });
    const first = ledger.appendArtifact("canonical-1", { b: 2, a: 1 }, {
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    assert.equal(first.payloadJson, '{"a":1,"b":2}');
    assert.throws(
      () => ledger.appendEvidence("too-many-refs", { references: new Array(257).fill("ref") }),
      /references.*256|too many/i,
    );
    assert.throws(
      () => ledger.appendArtifact("too-large-source", { sources: "x".repeat(65 * 1024) }),
      /sources.*65536|exceeds/i,
    );
    assert.equal(ledger.listRecords().length, 1);
    ledger.close();
  });
});

test("uses LP_HOME by default, preserves explicit null payloads, and rejects NUL ids", () => {
  withHome((home) => {
    const previousHome = process.env.LP_HOME;
    process.env.LP_HOME = home;
    try {
      const ledger = new Ledger();
      assert.equal(ledger.path, path.join(home, "db", "ledger.sqlite"));
      const nullPayload = ledger.appendAudit({ id: "null-payload", payload: null });
      assert.equal(nullPayload.payloadJson, "null");
      assert.throws(() => ledger.appendAudit("bad\u0000id", {}), /NUL/i);
      ledger.close();
    } finally {
      if (previousHome === undefined) delete process.env.LP_HOME;
      else process.env.LP_HOME = previousHome;
    }
  });
});

test("verifyLedgerFile reports missing state as unavailable without creating a fake database", () => {
  withHome((home) => {
    const result = verifyLedgerFile(path.join(home, "db", "ledger.sqlite"));
    assert.deepEqual(result, {
      ok: false,
      valid: false,
      status: "unavailable",
      code: "LedgerUnavailable",
      message: "Ledger database is not initialized",
    });
  });
});

test("content-addressed store deduplicates bytes and verifies reads by SHA-256", () => {
  withHome((home) => {
    const store = new ContentAddressedStore({ home, root: "store/sha256" });
    const first = store.put(Buffer.from("same bytes"));
    const second = store.put("same bytes");
    assert.equal(second, first);
    assert.equal(store.has(first), true);
    assert.equal(store.get(first).toString("utf8"), "same bytes");
    assert.equal(store.path(first).includes(path.join("store", "sha256")), true);
    assert.equal(store.path(first).includes(first.slice(2)), true);
  });
});

test("content-addressed store rejects traversal, absolute, UNC, device, and malformed hash inputs", () => {
  withHome((home) => {
    for (const root of ["../outside", "..\\outside", "/absolute", "C:\\outside", "\\\\server\\share", "NUL", "store/CON.txt", "store/name. "]) {
      assert.throws(() => new ContentAddressedStore({ home, root }), CasPathRejectedError);
    }
    const store = new ContentAddressedStore({ home, root: "store/sha256" });
    for (const hash of ["", "../" + "a".repeat(62), "a".repeat(63), "g".repeat(64), "/absolute/hash"]) {
      assert.throws(() => store.path(hash), CasHashRejectedError);
    }
  });
});

test("content-addressed store refuses bytes that do not match an existing name", () => {
  withHome((home) => {
    const store = new ContentAddressedStore({ home, root: "store/sha256" });
    const hash = store.put("original");
    const filePath = store.path(hash);
    rmSync(filePath, { force: true });
    writeFileSync(filePath, "tampered", "utf8");
    assert.throws(() => store.get(hash), /SHA-256|CAS entry/i);
  });
});
