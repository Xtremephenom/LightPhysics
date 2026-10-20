import { z } from "zod";

/** Stable IDs are persisted in recipes and must not be renamed casually. */
export const CAPABILITY_IDS = [
  "reason.plan", "reason.code", "vision.inspect", "vision.ocr", "vision.detect",
  "embed.text", "embed.image", "image.generate", "image.edit", "image.inpaint",
  "image.outpaint", "image.variation", "image.upscale", "image.restore", "image.bgremove",
  "image.segment", "image.depth_normal", "texture.seamless", "texture.pbr",
  "model3d.from_text", "model3d.from_image", "model3d.refine", "model3d.retopo",
  "model3d.uv_bake", "rig.auto", "anim.generate", "anim.retarget", "anim.from_video",
  "audio.sfx", "audio.ambience", "audio.separate_stems", "music.generate", "music.extend_loop",
  "speech.tts", "speech.clone(restricted)", "speech.stt", "lipsync.visemes",
  "video.generate", "video.process", "asset.search",
] as const;
export const CapabilityIdSchema = z.enum(CAPABILITY_IDS);
export type CapabilityId = z.infer<typeof CapabilityIdSchema>;

export const FidelitySchema = z.enum(["sketch", "draft", "final"]);
export type Fidelity = z.infer<typeof FidelitySchema>;
export const DataPolicySchema = z.union([z.literal("local_only"), z.literal("hosted_ok"), z.object({ hosted_ok_for: z.array(CapabilityIdSchema).min(1) }).strict()]);
export type DataPolicy = z.infer<typeof DataPolicySchema>;
const JsonScalar = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
const JsonValue: z.ZodType<unknown> = z.lazy(() => z.union([JsonScalar, z.array(JsonValue).max(128), z.record(z.string().max(128), JsonValue).superRefine((v, c) => { if (Object.keys(v).length > 128) c.addIssue({ code: "custom", message: "too many keys" }); })]));

export const ReferenceSchema = z.object({ artifact: z.string().min(1), role: z.enum(["style", "identity", "pose", "layout", "content"]) }).strict();
export const StyleLockInjectionSchema = z.object({ version: z.string().min(1), anchors: z.array(z.string()).default([]), palette: z.array(z.string()).default([]), shape_rules: z.array(z.string()).default([]), negatives: z.array(z.string()).default([]), prompt_prefix: z.string().optional() }).strict();
export type StyleLockInjection = z.infer<typeof StyleLockInjectionSchema>;

const CommonRequest = {
  prompt: z.string().max(16_384).optional(), negative: z.string().max(16_384).optional(),
  text: z.string().max(16_384).optional(), input: JsonValue.optional(),
  size: z.object({ width: z.number().int().positive().max(16_384), height: z.number().int().positive().max(16_384) }).strict().optional(),
  count: z.number().int().min(1).max(32).optional(), seed: z.number().int().optional(),
  refs: z.array(ReferenceSchema).max(32).optional(), fidelity: FidelitySchema.optional(),
  constraints: z.record(z.string().max(128), JsonValue).optional(), provider_params: z.record(z.string().max(128), JsonValue).optional(),
  style_lock: z.union([z.literal("auto"), StyleLockInjectionSchema]).optional(),
  resource_request: z.object({ vram_peak_mb: z.number().int().nonnegative(), ram_peak_mb: z.number().int().nonnegative(), exclusive: z.boolean().default(false) }).strict().optional(),
};

/** A single normalized boundary schema covers every taxonomy member. */
export const ForgeRequestSchema = z.object({ capability: CapabilityIdSchema, ...CommonRequest }).strict();
export type ForgeRequest = z.infer<typeof ForgeRequestSchema>;
export const CapabilityRequestSchemas: Readonly<Record<CapabilityId, typeof ForgeRequestSchema>> = Object.fromEntries(CAPABILITY_IDS.map((id) => [id, ForgeRequestSchema])) as Record<CapabilityId, typeof ForgeRequestSchema>;

export const ArtifactSchema = z.object({
  id: z.string().min(1), uri: z.string().min(1), kind: z.string().min(1), mime: z.string().min(1).optional(), bytes: z.number().int().nonnegative().optional(), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), preview: z.string().optional(),
  perception: z.unknown().optional(), recipe_id: z.string().optional(), provenance_id: z.string().optional(), state: z.enum(["exploration", "candidate", "promoted"]).default("exploration"),
}).strict();
export const ForgeResultSchema = z.object({ job_id: z.string().min(1), status: z.enum(["done", "failed", "running", "cancelled"]), artifacts: z.array(ArtifactSchema).max(64), cost: z.number().finite().nonnegative().default(0), timing: z.object({ started_at: z.string().optional(), completed_at: z.string().optional(), latency_ms: z.number().finite().nonnegative().optional() }).default({}), warnings: z.array(z.string()).default([]), next_actions: z.array(z.string()).default([]), provenance: z.record(z.string(), JsonValue).optional(), error: z.unknown().optional() }).strict();
export type ForgeResult = z.infer<typeof ForgeResultSchema>;
export const CapabilityResultSchema = ForgeResultSchema;

export function normalizeRequest(value: unknown): ForgeRequest {
  return ForgeRequestSchema.parse(value);
}
