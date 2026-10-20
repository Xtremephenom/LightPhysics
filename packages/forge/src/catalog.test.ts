import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadCatalog } from "./catalog.ts";

const record = (id: string, kind: string, extra: Record<string, unknown> = {}) => ({
  kind,
  schema_version: 1,
  id,
  display_name: id,
  capabilities: ["image.generate"],
  fixture: true,
  hardware: { vram_gb_min: 0, ram_gb_min: 0, disk_gb: 0, label_on_ref_hw: "green", notes: "fixture" },
  license: { id: "MIT", commercial_use: true, source: "fixture", verified_at: "2026-10-20", ledger_id: "ledger:fixture-license" },
  fidelity_map: { sketch: { supported: true }, draft: { supported: true }, final: { supported: true } },
  qualification: { status: "UNQUALIFIED", machine_profile: "unknown", verified_at: "2026-10-20", ledger_id: "ledger:fixture-qualification", scope: "contract" },
  verified_at: "2026-10-20",
  ledger_id: "ledger:fixture-record",
  ...extra,
});

describe("Forge catalog loader", () => {
  it("loads deterministic records and indexes typed ids", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lightphysics-forge-catalog-"));
    try {
      await mkdir(path.join(root, "providers"));
      await mkdir(path.join(root, "models"));
      await writeFile(path.join(root, "providers", "fixture-provider.json"), JSON.stringify(record("fixture-provider", "provider")));
      await writeFile(path.join(root, "models", "fixture-model.json"), JSON.stringify(record("fixture-model", "model", { provider: "fixture-provider" })));
      const catalog = await loadCatalog(root);
      expect(catalog.records).toHaveLength(2);
      expect(catalog.byId.get("model:fixture-model")?.id).toBe("fixture-model");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects unknown providers and commercially unknown licenses", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lightphysics-forge-catalog-"));
    try {
      await mkdir(path.join(root, "models"));
      await writeFile(path.join(root, "models", "fixture-model.json"), JSON.stringify(record("fixture-model", "model", {
        provider: "missing",
        license: { id: "unknown", commercial_use: true, source: "fixture", verified_at: "2026-10-20", ledger_id: "ledger:fixture-license" },
      })));
      await expect(loadCatalog(root)).rejects.toThrow(/unknown licenses are non-commercial/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
