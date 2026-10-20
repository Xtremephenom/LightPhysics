import { z } from "zod";
import type { ForgeAdapter } from "./adapter.ts";

export const QualificationStatusSchema = z.enum(["QUALIFIED", "UNQUALIFIED", "NOT_RUN", "FAILED"]);
export type QualificationStatus = z.infer<typeof QualificationStatusSchema>;
export const QualificationRecordSchema = z.object({
  status: QualificationStatusSchema, adapter_id: z.string().min(1), machine_profile: z.string().min(1),
  versions: z.record(z.string(), z.string()), date: z.string().datetime({ offset: true }), checks: z.array(z.object({ name: z.string(), passed: z.boolean(), detail: z.string().optional() }).strict()),
}).strict();
export type QualificationRecord = z.infer<typeof QualificationRecordSchema>;

export async function runQualification(adapter: ForgeAdapter, options: { machine_profile?: string; versions?: Record<string, string>; run?: () => Promise<QualificationRecord> } = {}): Promise<QualificationRecord> {
  const base = { adapter_id: adapter.id, machine_profile: options.machine_profile ?? "unknown", versions: options.versions ?? {}, date: new Date().toISOString() };
  if (!options.run) return QualificationRecordSchema.parse({ ...base, status: "NOT_RUN", checks: [] });
  try {
    const record = await options.run();
    const normalized = QualificationRecordSchema.parse({ ...record, adapter_id: record.adapter_id || adapter.id, machine_profile: record.machine_profile || base.machine_profile });
    if (normalized.status === "QUALIFIED" && (normalized.machine_profile === "unknown" || normalized.checks.length === 0 || normalized.checks.some((check) => !check.passed))) {
      return { ...normalized, status: "UNQUALIFIED" };
    }
    return normalized;
  } catch (error) {
    return QualificationRecordSchema.parse({ ...base, status: "FAILED", checks: [{ name: "harness", passed: false, detail: error instanceof Error ? error.message : String(error) }] });
  }
}

export class QualificationHarness {
  private readonly machine_profile: string;
  private readonly versions: Record<string, string>;
  constructor(machine_profile = "unknown", versions: Record<string, string> = {}) { this.machine_profile = machine_profile; this.versions = versions; }
  async run(adapter: ForgeAdapter, checks: readonly (() => Promise<{ name: string; passed: boolean; detail?: string }>)[] = []): Promise<QualificationRecord> {
    if (checks.length === 0) return runQualification(adapter, { machine_profile: this.machine_profile, versions: this.versions });
    const results: Array<{ name: string; passed: boolean; detail?: string }> = []; for (const check of checks) { try { results.push(await check()); } catch (error) { results.push({ name: "check", passed: false, detail: error instanceof Error ? error.message : String(error) }); } }
    const passed = results.length > 0 && results.every((check) => check.passed); const status = passed && this.machine_profile !== "unknown" ? "QUALIFIED" : passed ? "UNQUALIFIED" : "FAILED";
    return QualificationRecordSchema.parse({ status, adapter_id: adapter.id, machine_profile: this.machine_profile, versions: this.versions, date: new Date().toISOString(), checks: results });
  }
}
