import { z } from "zod";

/**
 * Phase 2's public capability vocabulary. These ids are persisted in recipes,
 * routing files, and ledger records, so adding a provider must not add a new
 * id without changing this contract.
 */
export const FORGE_CAPABILITY_IDS = [
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

export const CAPABILITY_IDS = FORGE_CAPABILITY_IDS;
export const CapabilityIdSchema = z.enum(FORGE_CAPABILITY_IDS);
export const ForgeCapabilityIdSchema = CapabilityIdSchema;
export type CapabilityId = z.infer<typeof CapabilityIdSchema>;
export type ForgeCapabilityId = CapabilityId;

export const FidelitySchema = z.enum(["sketch", "draft", "final"]);
export type Fidelity = z.infer<typeof FidelitySchema>;

/** Project privacy policy. Hosted allow-lists are capability ids, never URLs. */
export const DataPolicySchema = z.union([
  z.literal("local_only"),
  z.literal("hosted_ok"),
  z.object({ hosted_ok_for: z.array(CapabilityIdSchema).min(1).max(FORGE_CAPABILITY_IDS.length) }).strict(),
]);
export type DataPolicy = z.infer<typeof DataPolicySchema>;

export const ForgeJsonValueSchema = z.unknown().superRefine((value, context) => {
  const maxDepth = 16;
  const maxItems = 256;
  const maxBytes = 64 * 1024;
  const sensitiveKey = /(?:secret|token|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|credential|authorization|cookie|session[_-]?secret)/i;
  const secretValue = /(?:-----BEGIN[\s\S]*PRIVATE KEY-----|\b(?:sk|rk|pk|ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9][A-Za-z0-9._-]{11,}|\bAKIA[0-9A-Z]{16}\b|\bBearer\s+[A-Za-z0-9._~+/=-]{12,})/i;
  const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
  const visit = (candidate: unknown, depth: number, ancestors: WeakSet<object>): string | undefined => {
    if (depth > maxDepth) return "maximum JSON depth exceeded";
    if (candidate === null || typeof candidate === "boolean") return undefined;
    if (typeof candidate === "string") {
      if (bytes(candidate) > maxBytes) return "JSON string exceeds the byte bound";
      if (secretValue.test(candidate)) return "secret-like JSON value is not allowed";
      return undefined;
    }
    if (typeof candidate === "number") return Number.isFinite(candidate) ? undefined : "JSON numbers must be finite";
    if (typeof candidate !== "object" || candidate === undefined) return "only JSON values are supported";
    if (ancestors.has(candidate)) return "cyclic JSON values are not supported";
    ancestors.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        if (candidate.length > maxItems) return "JSON array contains too many items";
        for (const item of candidate) {
          const issue = visit(item, depth + 1, ancestors);
          if (issue) return issue;
        }
      } else {
        const prototype = Object.getPrototypeOf(candidate);
        if (prototype !== Object.prototype && prototype !== null) return "only plain JSON objects are supported";
        const object = candidate as Record<string, unknown>;
        const keys = Object.keys(object);
        if (keys.length > maxItems) return "JSON object contains too many keys";
        for (const key of keys) {
          if (key === "__proto__" || key === "constructor" || key === "prototype") return `reserved JSON key ${key} is not allowed`;
          if (sensitiveKey.test(key)) return "secret-like JSON field is not allowed";
          const issue = visit(object[key], depth + 1, ancestors);
          if (issue) return issue;
        }
      }
      return undefined;
    } finally {
      ancestors.delete(candidate);
    }
  };
  let issue = visit(value, 0, new WeakSet<object>());
  if (!issue) {
    try {
      const serialized = JSON.stringify(value);
      if (serialized === undefined || bytes(serialized) > maxBytes) issue = "JSON value exceeds the byte bound";
    } catch {
      issue = "only JSON values are supported";
    }
  }
  if (issue) context.addIssue({ code: z.ZodIssueCode.custom, message: issue });
});
export type ForgeJsonValue = z.infer<typeof ForgeJsonValueSchema>;
export const FORGE_MAX_JSON_BYTES = 64 * 1024;
export const FORGE_MAX_JSON_DEPTH = 16;
export const FORGE_MAX_JSON_ITEMS = 256;

const IdSchema = z.string().min(1).max(256);
const TextSchema = z.string().min(1).max(16_384);
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const TimestampSchema = z.string().datetime({ offset: true });
const NonNegativeNumberSchema = z.number().finite().nonnegative();
const NonNegativeIntSchema = z.number().int().nonnegative();

export const StyleLockInjectionMetadataSchema = z.object({
  version: IdSchema,
  anchors: z.array(IdSchema).max(64),
  palette: z.array(z.string().min(1).max(256)).max(128),
  shape_rules: z.array(z.string().min(1).max(2_048)).max(128),
  negatives: z.array(z.string().min(1).max(2_048)).max(128),
  prompt_prefix: z.string().max(16_384).optional(),
  capability: CapabilityIdSchema.optional(),
}).strict();
export const StyleLockInjectionSchema = StyleLockInjectionMetadataSchema;
export type StyleLockInjectionMetadata = z.infer<typeof StyleLockInjectionMetadataSchema>;
export type StyleLockInjection = StyleLockInjectionMetadata;

export const ReferenceSchema = z.object({
  artifact: IdSchema,
  role: z.enum(["style", "identity", "pose", "layout", "content"]),
}).strict();

const SizeSchema = z.object({
  width: z.number().int().positive().max(16_384),
  height: z.number().int().positive().max(16_384),
}).strict();

export const ForgeResourceRequestSchema = z.object({
  vram_peak_mb: NonNegativeIntSchema.max(1_048_576),
  ram_peak_mb: NonNegativeIntSchema.max(4_194_304),
  exclusive: z.boolean(),
}).strict();
export const ResourceRequestSchema = ForgeResourceRequestSchema;

const CommonCapabilityRequestShape = {
  capability: CapabilityIdSchema,
  prompt: TextSchema.optional(),
  negative: TextSchema.optional(),
  text: TextSchema.optional(),
  input: ForgeJsonValueSchema.optional(),
  size: SizeSchema.optional(),
  count: z.number().int().min(1).max(32).optional(),
  seed: z.number().int().optional(),
  refs: z.array(ReferenceSchema).max(32).optional(),
  fidelity: FidelitySchema.optional(),
  constraints: ForgeJsonValueSchema.optional(),
  provider_params: ForgeJsonValueSchema.optional(),
  style_lock: z.union([z.literal("auto"), StyleLockInjectionMetadataSchema]).optional(),
  resource_request: ForgeResourceRequestSchema.optional(),
};

/** One normalized request shape is shared by every taxonomy member. */
export const ForgeCapabilityRequestSchema = z.object(CommonCapabilityRequestShape).strict();
export const ForgeRequestSchema = ForgeCapabilityRequestSchema;
export const CapabilityRequestSchema = ForgeCapabilityRequestSchema;
export type ForgeCapabilityRequest = z.infer<typeof ForgeCapabilityRequestSchema>;
export type ForgeRequest = ForgeCapabilityRequest;

export const CapabilityRequestSchemas = Object.fromEntries(
  FORGE_CAPABILITY_IDS.map((id) => [id, ForgeCapabilityRequestSchema.extend({ capability: z.literal(id) })]),
) as unknown as { [K in CapabilityId]: typeof ForgeCapabilityRequestSchema };
export const ForgeCapabilityRequestSchemas = CapabilityRequestSchemas;
export const FORGE_CAPABILITY_REQUEST_SCHEMA_NAMES = Object.fromEntries(
  FORGE_CAPABILITY_IDS.map((id) => [`ForgeCapabilityRequest__${id}`, id]),
) as { [K in `ForgeCapabilityRequest__${CapabilityId}`]: CapabilityId };

export const PerceptionMeasuredSchema = z.record(z.string().min(1).max(128), NonNegativeNumberSchema);
export const PerceptionAiDescriptionSchema = z.object({
  summary: z.string().max(4_096),
  tags: z.array(z.string().min(1).max(256)).max(128),
}).strict();
export const PerceptionSchema = z.object({
  summary: z.string().max(4_096),
  tags: z.array(z.string().min(1).max(256)).max(128),
  flags: z.array(z.string().min(1).max(256)).max(128),
  measured: PerceptionMeasuredSchema,
  ai_described: PerceptionAiDescriptionSchema.optional(),
  source: z.enum(["local-vision", "byok-vision", "analysis", "none"]),
}).strict();
export type Perception = z.infer<typeof PerceptionSchema>;

/** Provenance deliberately contains digests and identifiers, never prompts or credentials. */
export const ForgeProvenanceSchema = z.object({
  provider_id: IdSchema.optional(),
  provider: IdSchema.optional(),
  model_id: IdSchema.optional(),
  model: IdSchema.optional(),
  model_version: IdSchema.optional(),
  model_hash: HashSchema.optional(),
  request_hash: HashSchema,
  parameters_hash: HashSchema.optional(),
  endpoint_host: z.string().min(1).max(253).optional(),
  started_at: TimestampSchema.optional(),
  completed_at: TimestampSchema.optional(),
  latency_ms: NonNegativeNumberSchema.max(86_400_000).optional(),
  cost_actual_id: IdSchema.optional(),
  style_lock: StyleLockInjectionMetadataSchema.pick({ version: true }).optional(),
  downshift: z.string().min(1).max(1_024).optional(),
}).strict();
export const ProvenanceSchema = ForgeProvenanceSchema;
export type ForgeProvenance = z.infer<typeof ForgeProvenanceSchema>;

export const ArtifactSchema = z.object({
  id: IdSchema,
  uri: z.string().min(1).max(2_048),
  kind: z.string().min(1).max(128),
  mime: z.string().min(1).max(256).optional(),
  bytes: NonNegativeIntSchema.max(Number.MAX_SAFE_INTEGER).optional(),
  sha256: HashSchema.optional(),
  preview: z.string().max(2_048).optional(),
  perception: PerceptionSchema.optional(),
  recipe_id: IdSchema.optional(),
  provenance_id: IdSchema.optional(),
  state: z.enum(["exploration", "candidate", "approved", "integrated", "shipped", "rejected"]),
}).strict();
export type Artifact = z.infer<typeof ArtifactSchema>;

export const CostActualSchema = z.object({
  id: IdSchema.optional(),
  amount: NonNegativeNumberSchema,
  currency: z.string().regex(/^[A-Z]{3}$/),
  provider_id: IdSchema.optional(),
  provider: IdSchema.optional(),
  capability: CapabilityIdSchema.optional(),
  at: TimestampSchema,
}).strict();
export const ForgeCostActualSchema = CostActualSchema;
export type CostActual = z.infer<typeof CostActualSchema>;

export const ForgeResultSchema = z.object({
  job_id: IdSchema,
  status: z.enum(["done", "succeeded", "failed", "running", "cancelled"]),
  artifacts: z.array(ArtifactSchema).max(64),
  cost: z.union([NonNegativeNumberSchema, CostActualSchema]).optional(),
  timing: z.object({
    started_at: TimestampSchema.optional(),
    completed_at: TimestampSchema.optional(),
    latency_ms: NonNegativeNumberSchema.max(86_400_000).optional(),
  }).strict(),
  provenance: ForgeProvenanceSchema.optional(),
  warnings: z.array(z.string().min(1).max(2_048)).max(128),
  next_actions: z.array(z.string().min(1).max(2_048)).max(128),
  error_code: z.string().min(1).max(128).optional(),
}).strict();
export type ForgeResult = z.infer<typeof ForgeResultSchema>;

export const ForgeCapabilityResponseSchema = z.object({
  capability: CapabilityIdSchema,
  result: ForgeResultSchema,
}).strict();
export const ForgeResponseSchema = ForgeCapabilityResponseSchema;
export const CapabilityResponseSchema = ForgeCapabilityResponseSchema;
export const CapabilityResultSchema = ForgeResultSchema;
export type ForgeCapabilityResponse = z.infer<typeof ForgeCapabilityResponseSchema>;
export type ForgeResponse = ForgeCapabilityResponse;

export const CapabilityResponseSchemas = Object.fromEntries(
  FORGE_CAPABILITY_IDS.map((id) => [id, ForgeCapabilityResponseSchema.extend({ capability: z.literal(id) })]),
) as unknown as { [K in CapabilityId]: typeof ForgeCapabilityResponseSchema };
export const ForgeCapabilityResponseSchemas = CapabilityResponseSchemas;
export const FORGE_CAPABILITY_RESPONSE_SCHEMA_NAMES = Object.fromEntries(
  FORGE_CAPABILITY_IDS.map((id) => [`ForgeCapabilityResponse__${id}`, id]),
) as { [K in `ForgeCapabilityResponse__${CapabilityId}`]: CapabilityId };

export const ProviderAdapterKindSchema = z.enum(["openai-compatible", "anthropic", "gemini", "comfyui-workflow", "python-worker", "hosted-http", "library", "mock"]);
export const ProviderCatalogRecordSchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(256),
  adapter_kind: ProviderAdapterKindSchema,
  capabilities: z.array(CapabilityIdSchema).min(1).max(FORGE_CAPABILITY_IDS.length),
  local: z.boolean(),
  hosted: z.boolean(),
  endpoint_host: z.string().min(1).max(253).optional(),
  verified_at: TimestampSchema.optional(),
  ledger_id: IdSchema.optional(),
}).strict();
export const ProviderRecordSchema = ProviderCatalogRecordSchema;
export type ProviderCatalogRecord = z.infer<typeof ProviderCatalogRecordSchema>;

export const LicenseSchema = z.object({
  id: IdSchema,
  commercial_use: z.union([z.boolean(), z.enum(["yes", "no", "unknown"])]),
  restrictions: z.array(z.string().min(1).max(2_048)).max(64),
  verified_at: TimestampSchema.optional(),
  source: z.string().url().max(2_048).optional(),
  ledger_id: IdSchema.optional(),
  text_sha256: HashSchema.optional(),
}).strict();
export type License = z.infer<typeof LicenseSchema>;

export const HardwareRequirementsSchema = z.object({
  vram_gb_min: NonNegativeNumberSchema.max(4_096),
  ram_gb_min: NonNegativeNumberSchema.max(4_096),
  disk_gb: NonNegativeNumberSchema.max(1_000_000),
  notes: z.string().max(2_048).optional(),
  label_on_ref_hw: z.enum(["comfortable", "compromise", "needs_stronger", "hosted_only"]),
}).strict();

export const ModelQualificationStatusSchema = z.enum(["QUALIFIED", "UNQUALIFIED", "NOT_RUN", "FAILED"]);
export const ModelQualificationSchema = z.object({
  status: ModelQualificationStatusSchema,
  machine_profile: IdSchema,
  verified_at: TimestampSchema,
  ledger_id: IdSchema.optional(),
  golden: z.string().max(2_048).optional(),
  versions: z.record(z.string().min(1).max(128), z.string().min(1).max(256)),
}).strict();
export const QualificationRecordSchema = z.object({
  status: ModelQualificationStatusSchema,
  adapter_id: IdSchema,
  machine_profile: IdSchema,
  versions: z.record(z.string().min(1).max(128), z.string().min(1).max(256)),
  date: TimestampSchema,
  checks: z.array(z.object({ name: IdSchema, passed: z.boolean(), detail: z.string().max(2_048).optional() }).strict()).max(128),
  verified_at: TimestampSchema.optional(),
  ledger_id: IdSchema.optional(),
}).strict();
export type QualificationRecord = z.infer<typeof QualificationRecordSchema>;

export const ModelCatalogRecordSchema = z.object({
  id: IdSchema,
  provider_id: IdSchema,
  name: z.string().min(1).max(256),
  version: IdSchema,
  capabilities: z.array(CapabilityIdSchema).min(1).max(FORGE_CAPABILITY_IDS.length),
  runtime: z.object({ kind: ProviderAdapterKindSchema, workflow: z.string().max(2_048).optional(), min_version: z.string().max(128).optional() }).strict(),
  hardware: HardwareRequirementsSchema,
  license: LicenseSchema,
  fidelity_map: z.record(z.string().min(1).max(16), ForgeJsonValueSchema),
  determinism: z.enum(["seeded", "unseeded", "unknown"]),
  qualification: ModelQualificationSchema,
  cost: ForgeJsonValueSchema,
}).strict();
export const ModelRecordSchema = ModelCatalogRecordSchema;
export type ModelCatalogRecord = z.infer<typeof ModelCatalogRecordSchema>;

export const AdapterDescriptionSchema = z.object({
  id: IdSchema,
  kind: z.enum(["local", "hosted", "mock"]),
  capabilities: z.array(CapabilityIdSchema).min(1).max(FORGE_CAPABILITY_IDS.length),
  model_id: IdSchema.optional(),
  model: IdSchema.optional(),
  version: IdSchema.optional(),
}).strict();
export const AdapterHealthResponseSchema = z.object({
  healthy: z.boolean(),
  status: z.enum(["ok", "degraded", "unavailable"]),
  detail: z.string().max(2_048).optional(),
}).strict();
export const AdapterEstimateResponseSchema = z.object({
  cost: NonNegativeNumberSchema,
  amount: NonNegativeNumberSchema.optional(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  latency_ms: NonNegativeNumberSchema.max(86_400_000).optional(),
  resources: ForgeResourceRequestSchema.optional(),
}).strict();
export const AdapterRunResponseSchema = ForgeResultSchema;
export const AdapterQualifyResponseSchema = QualificationRecordSchema;
export const AdapterHealthSchema = AdapterHealthResponseSchema;
export const AdapterEstimateSchema = AdapterEstimateResponseSchema;
export const AdapterRunSchema = AdapterRunResponseSchema;
export const AdapterQualifySchema = AdapterQualifyResponseSchema;
export const HealthResultSchema = AdapterHealthResponseSchema;
export const EstimateSchema = AdapterEstimateResponseSchema;
export const RunResultSchema = AdapterRunResponseSchema;
export const QualifyResultSchema = AdapterQualifyResponseSchema;

export const RoutingConstraintSchema = z.object({
  max_cost: NonNegativeNumberSchema.optional(),
  local_only: z.boolean().optional(),
  min_quality: z.string().min(1).max(128).optional(),
  max_latency_ms: NonNegativeNumberSchema.max(86_400_000).optional(),
}).strict();
export const RouteTargetSchema = z.object({ provider_id: IdSchema, model_id: IdSchema.optional() }).strict();
export const RoutingRuleSchema = z.object({
  capability: CapabilityIdSchema,
  ordered: z.array(RouteTargetSchema).min(1).max(64),
  constraints: RoutingConstraintSchema,
}).strict();
export const RoutingConfigSchema = z.object({
  data_policy: DataPolicySchema,
  rules: z.array(RoutingRuleSchema).max(FORGE_CAPABILITY_IDS.length),
}).strict();
export const RoutingDecisionSchema = z.object({
  capability: CapabilityIdSchema,
  provider_id: IdSchema,
  model_id: IdSchema.optional(),
  attempts: z.array(IdSchema).max(64),
  fallback_reason: z.enum(["none", "resource_unavailable", "timeout", "rate_limit", "unavailable", "policy_refusal", "malformed"]).optional(),
}).strict();

/** Egress is intentionally a digest-only audit record: no prompt or secret fields exist. */
export const EgressRecordSchema = z.object({
  request_hash: HashSchema,
  provider_id: IdSchema.optional(),
  provider: IdSchema.optional(),
  capability: CapabilityIdSchema.optional(),
  at: TimestampSchema.optional(),
  bytes_sent: NonNegativeIntSchema.max(FORGE_MAX_JSON_BYTES).optional(),
}).strict();
export const EgressLogSchema = z.object({ records: z.array(EgressRecordSchema).max(256) }).strict();
export type EgressRecord = z.infer<typeof EgressRecordSchema>;

export const CostEstimateSchema = z.object({
  id: IdSchema.optional(),
  amount: NonNegativeNumberSchema,
  currency: z.string().regex(/^[A-Z]{3}$/),
  requires_confirmation: z.boolean(),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  project_id: IdSchema,
  capability: CapabilityIdSchema.optional(),
  provider_id: IdSchema.optional(),
}).strict();
export const ForgeCostEstimateSchema = CostEstimateSchema;
export const CostCapsSchema = z.object({
  confirm_threshold: NonNegativeNumberSchema,
  daily_cap: NonNegativeNumberSchema,
  project_cap: NonNegativeNumberSchema,
  currency: z.string().regex(/^[A-Z]{3}$/),
}).strict();
export const ForgeCostCapsSchema = CostCapsSchema;
export type CostEstimate = z.infer<typeof CostEstimateSchema>;
export type CostCaps = z.infer<typeof CostCapsSchema>;

export const HardwareLabelSchema = z.enum(["comfortable", "compromise", "needs_stronger", "hosted_only"]);
export type HardwareLabel = z.infer<typeof HardwareLabelSchema>;
export const HardwareProfileSchema = z.object({
  id: IdSchema,
  source: z.enum(["mock", "nvidia-smi", "nvml", "unknown"]),
  gpu_name: z.string().max(256).optional(),
  vram_mb: NonNegativeIntSchema.max(4_194_304),
  ram_mb: NonNegativeIntSchema.max(4_194_304),
  disk_free_mb: NonNegativeIntSchema.max(1_000_000_000),
  cpu_cores: z.number().int().positive().max(4_096),
  os: z.string().min(1).max(128),
  driver: z.string().max(256).optional(),
}).strict();
export type HardwareProfile = z.infer<typeof HardwareProfileSchema>;
export const HardwareModelLabelSchema = z.object({ model_id: IdSchema, label: HardwareLabelSchema, reason: z.string().max(1_024).optional() }).strict();
export const HardwareProfileLabelSchema = HardwareModelLabelSchema;

export const ModelAcquisitionStatusSchema = z.enum(["requested", "downloading", "verified", "rejected", "failed", "cancelled"]);
export const ModelAcquisitionRequestSchema = z.object({
  model_id: IdSchema,
  url: z.string().url().max(2_048),
  filename: z.string().min(1).max(512).regex(/\.(?:safetensors|gguf)$/i),
  expected_sha256: HashSchema,
  expected_bytes: NonNegativeIntSchema.max(Number.MAX_SAFE_INTEGER),
  disk_free_bytes: NonNegativeIntSchema.max(Number.MAX_SAFE_INTEGER),
  consent: z.boolean(),
  resume_from_bytes: NonNegativeIntSchema.max(Number.MAX_SAFE_INTEGER).optional(),
}).strict();
export const ModelAcquisitionRecordSchema = z.object({
  id: IdSchema.optional(),
  model_id: IdSchema.optional(),
  filename: z.string().min(1).max(512).regex(/\.(?:safetensors|gguf)$/i),
  status: ModelAcquisitionStatusSchema,
  expected_sha256: HashSchema.optional(),
  actual_sha256: HashSchema.optional(),
  sha256: HashSchema.optional(),
  bytes: NonNegativeIntSchema.max(Number.MAX_SAFE_INTEGER).optional(),
  resumed: z.boolean(),
  license_text_sha256: HashSchema.optional(),
  started_at: TimestampSchema.optional(),
  completed_at: TimestampSchema.optional(),
  error_code: z.enum(["ValidationError", "ChecksumMismatch", "DiskInsufficient", "PolicyRefusal", "ProviderError"]).optional(),
}).strict();
export const AcquisitionRequestSchema = ModelAcquisitionRequestSchema;
export const AcquisitionRecordSchema = ModelAcquisitionRecordSchema;
export type ModelAcquisitionRecord = z.infer<typeof ModelAcquisitionRecordSchema>;

export const FORGE_SCHEMA_REGISTRY = {
  ForgeJsonValueSchema,
  CapabilityIdSchema,
  ForgeCapabilityIdSchema,
  FidelitySchema,
  DataPolicySchema,
  StyleLockInjectionMetadataSchema,
  StyleLockInjectionSchema,
  ReferenceSchema,
  ForgeResourceRequestSchema,
  ForgeCapabilityRequestSchema,
  ForgeRequestSchema,
  PerceptionMeasuredSchema,
  PerceptionAiDescriptionSchema,
  PerceptionSchema,
  ForgeProvenanceSchema,
  ProvenanceSchema,
  ArtifactSchema,
  CostActualSchema,
  ForgeCostActualSchema,
  ForgeResultSchema,
  ForgeCapabilityResponseSchema,
  ForgeResponseSchema,
  ProviderAdapterKindSchema,
  ProviderCatalogRecordSchema,
  ProviderRecordSchema,
  LicenseSchema,
  HardwareRequirementsSchema,
  ModelQualificationStatusSchema,
  ModelQualificationSchema,
  QualificationRecordSchema,
  ModelCatalogRecordSchema,
  ModelRecordSchema,
  AdapterDescriptionSchema,
  AdapterHealthResponseSchema,
  AdapterEstimateResponseSchema,
  AdapterRunResponseSchema,
  AdapterQualifyResponseSchema,
  AdapterHealthSchema,
  AdapterEstimateSchema,
  AdapterRunSchema,
  AdapterQualifySchema,
  HealthResultSchema,
  EstimateSchema,
  RunResultSchema,
  QualifyResultSchema,
  RoutingConstraintSchema,
  RouteTargetSchema,
  RoutingRuleSchema,
  RoutingConfigSchema,
  RoutingDecisionSchema,
  EgressRecordSchema,
  EgressLogSchema,
  CostEstimateSchema,
  ForgeCostEstimateSchema,
  CostCapsSchema,
  ForgeCostCapsSchema,
  HardwareLabelSchema,
  HardwareProfileSchema,
  HardwareModelLabelSchema,
  HardwareProfileLabelSchema,
  ModelAcquisitionStatusSchema,
  ModelAcquisitionRequestSchema,
  ModelAcquisitionRecordSchema,
  AcquisitionRequestSchema,
  AcquisitionRecordSchema,
  ...Object.fromEntries(
    FORGE_CAPABILITY_IDS.map((id) => [`ForgeCapabilityRequest__${id}`, CapabilityRequestSchemas[id]]),
  ),
  ...Object.fromEntries(
    FORGE_CAPABILITY_IDS.map((id) => [`ForgeCapabilityResponse__${id}`, CapabilityResponseSchemas[id]]),
  ),
} as const;

export type ForgeSchemaName = keyof typeof FORGE_SCHEMA_REGISTRY;
