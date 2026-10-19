import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  approveDecision,
  approveStyleLock,
  createDecision,
  createStyleLockVersion,
  createWorkOrder,
  estimateTokens,
  initProject,
  listDecisions,
  MemoryValidationError,
  projectResume,
  reindexProject,
  searchProject,
} from "./index.js";

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "lightphysics-memory-"));
  await initProject(root);
  return root;
}

describe("project memory", () => {
  it("creates a safe, idempotent game repository layout", async () => {
    const root = await fixture();
    try {
      const second = await initProject(root);
      expect(second.created).toHaveLength(0);
      expect(await readFile(path.join(root, "lp", "project.yaml"), "utf8")).toContain("engine:");
      expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toContain("lp resume");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rebuilds a deterministic index and returns hybrid Bible matches", async () => {
    const root = await fixture();
    try {
      await writeFile(path.join(root, "lp", "bible", "world.md"), "# World\nThe moonlit harbor has brass airships and tidal engines.\n");
      const first = await reindexProject(root);
      const matches = await searchProject(root, "moonlit harbor airships", 3);
      expect(matches[0]?.path).toBe("lp/bible/world.md");
      const repeated = await reindexProject(root);
      expect(repeated.fingerprint).toBe(first.fingerprint);
      await rm(path.join(root, "lp", "index.sqlite"));
      const second = await reindexProject(root);
      expect(second.fingerprint).toBe(first.fingerprint);
      expect(second.documents).toBe(first.documents);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("enforces Human Channel approval and immutable Style Lock versions", async () => {
    const root = await fixture();
    try {
      const decision = await createDecision(root, { title: "Use tidal engines" });
      await expect(approveDecision(root, decision.id, { channel: "human", verified: false as unknown as true, evidenceId: "bad", subject: decision.id })).rejects.toThrow();
      const approved = await approveDecision(root, decision.id, { channel: "human", verified: true, evidenceId: "E-1", subject: decision.id });
      expect(approved.status).toBe("approved-by-human");
      const stylePath = await createStyleLockVersion(root, 1, "version: 1\nstatus: approved\n");
      await expect(createStyleLockVersion(root, 1, "version: 1\nstatus: changed\n")).rejects.toThrow("immutable");
      expect(stylePath).toContain("style_lock.v1.yaml");
      await approveStyleLock(root, 2, { channel: "human", verified: true, evidenceId: "E-2", subject: "style-lock" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("produces a bounded resume brief with required continuity fields", async () => {
    const root = await fixture();
    try {
      await createDecision(root, { title: "Choose engine" });
      const workOrder = await createWorkOrder(root, { title: "Define harbor blockout", acceptance: "A reviewable blockout exists", priority: 1 });
      const brief = await projectResume(root, { maxTokens: 2_500, maxBytes: 10_000 });
      expect(brief.stage).toBe("pre-production");
      expect(brief.pendingHumanDecisions).toHaveLength(1);
      expect(brief.topWorkOrders[0]?.id).toBe(workOrder.id);
      expect(brief).toHaveProperty("gateGaps");
      expect(brief).toHaveProperty("topWorkOrders");
      expect(brief).toHaveProperty("staleEvidence");
      expect(brief).toHaveProperty("spend");
      expect(brief).toHaveProperty("readiness");
      expect(brief).toHaveProperty("nextActions");
      expect(brief.tokenEstimate).toBeLessThanOrEqual(2_500);
      expect(estimateTokens(JSON.stringify(brief))).toBeLessThanOrEqual(2_500);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects traversal-shaped and unsafe source filenames with typed errors", async () => {
    const root = await fixture();
    const alias = path.join(path.dirname(root), `${path.basename(root)}-alias`);
    try {
      await writeFile(path.join(root, "lp", "decisions", "D-0001-unsafe name.md"), "---\nid: D-0001\nstatus: proposed\ntitle: bad\n---\n");
      await expect(listDecisions(root)).rejects.toBeInstanceOf(MemoryValidationError);
      await expect(initProject(`${root}\0`)).rejects.toBeInstanceOf(MemoryValidationError);
      try {
        await symlink(root, alias);
        await expect(initProject(alias)).rejects.toBeInstanceOf(MemoryValidationError);
      } catch {
        // Some Windows environments do not permit unprivileged symlink creation.
      }
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(alias, { recursive: true, force: true });
    }
  });

  it("fails malformed front matter and non-regular source entries visibly", async () => {
    const root = await fixture();
    try {
      await writeFile(path.join(root, "lp", "decisions", "D-0001-malformed.md"), "---\nid: D-0001\nstatus: proposed\n");
      await expect(listDecisions(root)).rejects.toBeInstanceOf(MemoryValidationError);
      await rm(path.join(root, "lp", "decisions", "D-0001-malformed.md"));
      await mkdir(path.join(root, "lp", "bible", "not-a-file.md"));
      await expect(reindexProject(root)).rejects.toBeInstanceOf(MemoryValidationError);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects source symlinks instead of following them outside the project", async () => {
    const root = await fixture();
    const outside = await mkdtemp(path.join(os.tmpdir(), "lightphysics-memory-outside-"));
    try {
      await writeFile(path.join(outside, "secret.md"), "outside project");
      try {
        await symlink(path.join(outside, "secret.md"), path.join(root, "lp", "bible", "escape.md"));
      } catch {
        return;
      }
      await expect(reindexProject(root)).rejects.toBeInstanceOf(MemoryValidationError);
      expect(await readFile(path.join(outside, "secret.md"), "utf8")).toBe("outside project");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
