/**
 * Deterministic, measurement-free resource admission decisions.
 *
 * This module deliberately accepts mock hardware profiles only.  It does not
 * inspect NVML, nvidia-smi, the host filesystem, or process memory.  Hardware
 * qualification belongs to a later phase; these decisions are the scheduler
 * contract that can be tested before that information exists.
 */

export type GovernorAction = "admit" | "queue" | "deny" | "preempt" | "downshift";

export type PriorityClass =
  | "batch"
  | "low"
  | "normal"
  | "user-visible"
  | "final"
  | "interactive"
  | "critical";

export type PriorityInput = PriorityClass | number | undefined;

export interface NormalizedPriority {
  readonly class: PriorityClass;
  readonly weight: number;
}

export const PRIORITY_WEIGHTS: Readonly<Record<PriorityClass, number>> = Object.freeze({
  batch: 10,
  low: 10,
  normal: 30,
  "user-visible": 60,
  final: 60,
  interactive: 80,
  critical: 100,
});

export interface ResourceRequestInput {
  /** Canonical names used by this package. */
  readonly vramMb?: number;
  readonly ramMb?: number;
  readonly diskMb?: number;
  /** Names used by the architecture documents and future Core payloads. */
  readonly vramPeakMb?: number;
  readonly ramPeakMb?: number;
  readonly vram_peak_mb?: number;
  readonly ram_peak_mb?: number;
  readonly disk_mb?: number;
  readonly exclusive?: boolean;
  readonly downshifts?: readonly ResourceRequestInput[] | ResourceRequestInput;
  readonly downshift?: readonly ResourceRequestInput[] | ResourceRequestInput;
}

export interface ResourceRequest {
  readonly vramMb: number;
  readonly ramMb: number;
  readonly diskMb: number;
  readonly exclusive: boolean;
  readonly downshifts: readonly ResourceRequest[];
}

export interface ResourceUsage {
  readonly vramMb: number;
  readonly ramMb: number;
  readonly diskMb: number;
  readonly activeJobs: number;
}

export interface MockHardwareProfile {
  readonly id: string;
  readonly kind: "mock";
  readonly source: "mock";
  readonly vramMb: number;
  readonly ramMb: number;
  readonly diskMb: number;
  readonly maxConcurrentJobs: number;
}

export type HardwareProfile = MockHardwareProfile;

export interface GovernorJob {
  readonly jobId?: string;
  readonly id?: string;
  readonly request?: ResourceRequestInput;
  readonly resources?: ResourceRequestInput;
  readonly priority?: PriorityInput | NormalizedPriority;
  /** A job can be preempted only after its worker reports this boundary. */
  readonly safeBoundary?: boolean;
  readonly preemptible?: boolean;
  readonly createdAt?: string;
}

export interface NormalizedGovernorJob {
  readonly jobId: string;
  readonly request: ResourceRequest;
  readonly priority: NormalizedPriority;
  readonly safeBoundary: boolean;
  readonly preemptible: boolean;
  readonly createdAt: string;
}

export interface GovernorDecision {
  readonly action: GovernorAction;
  readonly reason:
    | "fits"
    | "resources_busy"
    | "request_exceeds_profile"
    | "downshift_available"
    | "preemption_safe_boundary"
    | "concurrency_limit"
    | "invalid_request";
  readonly profile: MockHardwareProfile;
  readonly jobId: string;
  readonly priority: NormalizedPriority;
  readonly requested: ResourceRequest;
  readonly selectedRequest: ResourceRequest | undefined;
  readonly downshift: ResourceRequest | undefined;
  readonly preemptJobIds: readonly string[];
  readonly usage: ResourceUsage;
  readonly available: ResourceUsage;
  /** True for a preempt decision: a supervisor must stop only at these jobs' safe boundaries. */
  readonly safeBoundaryRequired: boolean;
}

export interface GovernorDecisionContext {
  readonly running?: readonly GovernorJob[];
  readonly queued?: readonly GovernorJob[];
}

export interface ResourceGovernorOptions {
  readonly profile?: MockHardwareProfile;
}

export interface GovernorSnapshot {
  readonly profile: MockHardwareProfile;
  readonly running: readonly NormalizedGovernorJob[];
  readonly queued: readonly NormalizedGovernorJob[];
  readonly usage: ResourceUsage;
  readonly available: ResourceUsage;
}

export class GovernorValidationError extends Error {
  readonly code = "GovernorValidationError" as const;

  constructor(message: string) {
    super(message);
    this.name = this.code;
  }
}

export class GovernorConflictError extends Error {
  readonly code = "GovernorConflict" as const;

  constructor(message: string) {
    super(message);
    this.name = this.code;
  }
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new GovernorValidationError(`${field} must be a non-negative integer number of MB`);
  }
  return value;
}

function uniqueNumber(
  input: ResourceRequestInput,
  canonical: keyof Pick<ResourceRequestInput, "vramMb" | "ramMb" | "diskMb">,
  aliases: readonly (keyof ResourceRequestInput)[],
  field: string,
): number {
  const values = [input[canonical], ...aliases.map((alias) => input[alias])].filter(
    (value): value is number => value !== undefined,
  );
  if (values.length > 1 && values.some((value) => value !== values[0])) {
    throw new GovernorValidationError(`${field} has conflicting aliases`);
  }
  return positiveInteger(values[0] ?? 0, field);
}

function uniqueAlternatives(input: ResourceRequestInput): readonly ResourceRequestInput[] {
  const values = [input.downshifts, input.downshift].filter((value) => value !== undefined);
  const candidates = values.map((value) => Array.isArray(value) ? value : [value]);
  if (candidates.length === 2) {
    try {
      if (JSON.stringify(candidates[0]) !== JSON.stringify(candidates[1])) {
        throw new GovernorValidationError("downshift and downshifts have conflicting aliases");
      }
    } catch (error) {
      if (error instanceof GovernorValidationError) throw error;
      throw new GovernorValidationError("downshift alternatives must be JSON values");
    }
  }
  return candidates[0] ?? [];
}

/** Normalize the snake_case and camelCase resource vocabulary at the boundary. */
export function normalizeResourceRequest(input: ResourceRequestInput = {}, depth = 0): ResourceRequest {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new GovernorValidationError("resource request must be an object");
  }
  if (depth > 16) throw new GovernorValidationError("resource downshift nesting exceeds 16 levels");
  if (input.exclusive !== undefined && typeof input.exclusive !== "boolean") {
    throw new GovernorValidationError("resource request exclusive must be boolean");
  }
  const alternatives = uniqueAlternatives(input);
  return {
    vramMb: uniqueNumber(input, "vramMb", ["vramPeakMb", "vram_peak_mb"], "vramMb"),
    ramMb: uniqueNumber(input, "ramMb", ["ramPeakMb", "ram_peak_mb"], "ramMb"),
    diskMb: uniqueNumber(input, "diskMb", ["disk_mb"], "diskMb"),
    exclusive: input.exclusive ?? false,
    downshifts: alternatives.map((candidate) => normalizeResourceRequest(candidate, depth + 1)),
  };
}

export function normalizePriority(priority: PriorityInput | NormalizedPriority): NormalizedPriority {
  if (priority === undefined) return { class: "normal", weight: PRIORITY_WEIGHTS.normal };
  if (priority !== null && typeof priority === "object") {
    if (!(priority.class in PRIORITY_WEIGHTS) || !Number.isSafeInteger(priority.weight) || priority.weight < 0 || priority.weight > 100) {
      throw new GovernorValidationError("normalized priority is invalid");
    }
    return { class: priority.class, weight: priority.weight };
  }
  if (typeof priority !== "string" && typeof priority !== "number") {
    throw new GovernorValidationError("priority must be a named class or integer");
  }
  if (typeof priority === "number") {
    if (!Number.isSafeInteger(priority) || priority < 0 || priority > 100) {
      throw new GovernorValidationError("numeric priority must be an integer from 0 through 100");
    }
    const priorityClass: PriorityClass =
      priority >= PRIORITY_WEIGHTS.critical
        ? "critical"
        : priority >= PRIORITY_WEIGHTS.interactive
          ? "interactive"
          : priority >= PRIORITY_WEIGHTS["user-visible"]
            ? "user-visible"
            : priority <= PRIORITY_WEIGHTS.batch
              ? "batch"
              : "normal";
    return { class: priorityClass, weight: priority };
  }
  if (!(priority in PRIORITY_WEIGHTS)) {
    throw new GovernorValidationError(`unknown priority class ${priority}`);
  }
  return { class: priority, weight: PRIORITY_WEIGHTS[priority] };
}

function normalizeProfile(profile: MockHardwareProfile): MockHardwareProfile {
  if (profile.kind !== "mock" || profile.source !== "mock") {
    throw new GovernorValidationError("Resource Governor accepts mock hardware profiles only");
  }
  if (typeof profile.id !== "string" || profile.id.trim().length === 0) throw new GovernorValidationError("profile id is required");
  return Object.freeze({
    id: profile.id,
    kind: "mock",
    source: "mock",
    vramMb: positiveInteger(profile.vramMb, "profile.vramMb"),
    ramMb: positiveInteger(profile.ramMb, "profile.ramMb"),
    diskMb: positiveInteger(profile.diskMb, "profile.diskMb"),
    maxConcurrentJobs: positiveInteger(profile.maxConcurrentJobs, "profile.maxConcurrentJobs"),
  });
}

export const REFERENCE_4GB_PROFILE: MockHardwareProfile = Object.freeze({
  id: "reference-4gb-vram",
  kind: "mock",
  source: "mock",
  vramMb: 4_096,
  ramMb: 16_384,
  diskMb: 32_768,
  maxConcurrentJobs: 2,
});

export const MOCK_HARDWARE_PROFILES: Readonly<Record<string, MockHardwareProfile>> = Object.freeze({
  "reference-4gb-vram": REFERENCE_4GB_PROFILE,
  "reference-4gb": REFERENCE_4GB_PROFILE,
  "4gb-reference": REFERENCE_4GB_PROFILE,
  "cpu-only": Object.freeze({
    id: "cpu-only",
    kind: "mock",
    source: "mock",
    vramMb: 0,
    ramMb: 16_384,
    diskMb: 32_768,
    maxConcurrentJobs: 2,
  }),
  "small-gpu": Object.freeze({
    id: "small-gpu",
    kind: "mock",
    source: "mock",
    vramMb: 8_192,
    ramMb: 32_768,
    diskMb: 65_536,
    maxConcurrentJobs: 3,
  }),
});

/** Alias that makes the reference-profile intent explicit at call sites. */
export const REFERENCE_HARDWARE_PROFILE_4GB = REFERENCE_4GB_PROFILE;
export const REFERENCE_PROFILE_4GB = REFERENCE_4GB_PROFILE;
export const FOUR_GB_REFERENCE_PROFILE = REFERENCE_4GB_PROFILE;
export const MOCK_4GB_PROFILE = REFERENCE_4GB_PROFILE;

export function getMockHardwareProfile(profileId: string): MockHardwareProfile {
  const profile = MOCK_HARDWARE_PROFILES[profileId];
  if (!profile) throw new GovernorValidationError(`unknown mock hardware profile ${profileId}`);
  return profile;
}

function jobIdFor(job: GovernorJob): string {
  const id = job.jobId ?? job.id;
  if (typeof id !== "string" || id.trim().length === 0) throw new GovernorValidationError("governor job id is required");
  return id;
}

function normalizedJob(job: GovernorJob): NormalizedGovernorJob {
  const request = normalizeResourceRequest(job.request ?? job.resources ?? {});
  const createdAt = job.createdAt ?? "";
  return {
    jobId: jobIdFor(job),
    request,
    priority: normalizePriority(job.priority),
    safeBoundary: job.safeBoundary ?? false,
    preemptible: job.preemptible ?? true,
    createdAt,
  };
}

function vector(request: ResourceRequest): Omit<ResourceUsage, "activeJobs"> {
  return { vramMb: request.vramMb, ramMb: request.ramMb, diskMb: request.diskMb };
}

function sumUsage(running: readonly NormalizedGovernorJob[]): ResourceUsage {
  return running.reduce(
    (usage, job) => ({
      vramMb: usage.vramMb + job.request.vramMb,
      ramMb: usage.ramMb + job.request.ramMb,
      diskMb: usage.diskMb + job.request.diskMb,
      activeJobs: usage.activeJobs + 1,
    }),
    { vramMb: 0, ramMb: 0, diskMb: 0, activeJobs: 0 },
  );
}

function availableUsage(profile: MockHardwareProfile, usage: ResourceUsage): ResourceUsage {
  return {
    vramMb: Math.max(0, profile.vramMb - usage.vramMb),
    ramMb: Math.max(0, profile.ramMb - usage.ramMb),
    diskMb: Math.max(0, profile.diskMb - usage.diskMb),
    activeJobs: Math.max(0, profile.maxConcurrentJobs - usage.activeJobs),
  };
}

function fitsCapacity(
  profile: MockHardwareProfile,
  request: ResourceRequest,
): boolean {
  return (
    request.vramMb <= profile.vramMb &&
    request.ramMb <= profile.ramMb &&
    request.diskMb <= profile.diskMb
  );
}

function fitsNow(
  profile: MockHardwareProfile,
  request: ResourceRequest,
  running: readonly NormalizedGovernorJob[],
  usage: ResourceUsage,
): boolean {
  const hasExclusiveJob = running.some((job) => job.request.exclusive);
  return (
    fitsCapacity(profile, request) &&
    usage.vramMb + request.vramMb <= profile.vramMb &&
    usage.ramMb + request.ramMb <= profile.ramMb &&
    usage.diskMb + request.diskMb <= profile.diskMb &&
    usage.activeJobs + 1 <= profile.maxConcurrentJobs &&
    !request.exclusive && !hasExclusiveJob ||
    fitsCapacity(profile, request) &&
    request.exclusive &&
    running.length === 0 &&
    profile.maxConcurrentJobs >= 1
  );
}

function fitsAfterRemoving(
  profile: MockHardwareProfile,
  request: ResourceRequest,
  running: readonly NormalizedGovernorJob[],
  removeIds: ReadonlySet<string>,
): boolean {
  const remaining = running.filter((job) => !removeIds.has(job.jobId));
  return fitsNow(profile, request, remaining, sumUsage(remaining));
}

function canFitProfile(profile: MockHardwareProfile, request: ResourceRequest): boolean {
  return fitsCapacity(profile, request);
}

function chooseDownshift(
  profile: MockHardwareProfile,
  requested: ResourceRequest,
  running: readonly NormalizedGovernorJob[],
  usage: ResourceUsage,
): ResourceRequest | undefined {
  if (canFitProfile(profile, requested) && fitsNow(profile, requested, running, usage)) return undefined;
  for (const alternative of requested.downshifts) {
    if (fitsNow(profile, alternative, running, usage)) return alternative;
  }
  return undefined;
}

function findPreemptionVictims(
  profile: MockHardwareProfile,
  request: ResourceRequest,
  candidate: NormalizedGovernorJob,
  running: readonly NormalizedGovernorJob[],
): readonly string[] {
  if (!canFitProfile(profile, request)) return [];
  const candidates = running
    .filter(
      (job) =>
        job.preemptible &&
        job.safeBoundary &&
        job.priority.weight < candidate.priority.weight,
    )
    .sort(
      (left, right) =>
        left.priority.weight - right.priority.weight ||
        right.request.vramMb - left.request.vramMb ||
        right.request.ramMb - left.request.ramMb ||
        left.jobId.localeCompare(right.jobId),
    );
  const victims: string[] = [];
  const victimIds = new Set<string>();
  for (const job of candidates) {
    victims.push(job.jobId);
    victimIds.add(job.jobId);
    if (fitsAfterRemoving(profile, request, running, victimIds)) return victims;
  }
  return [];
}

function decision(
  profile: MockHardwareProfile,
  candidate: NormalizedGovernorJob,
  action: GovernorAction,
  reason: GovernorDecision["reason"],
  running: readonly NormalizedGovernorJob[],
  selectedRequest: ResourceRequest | undefined,
  downshift: ResourceRequest | undefined,
  preemptJobIds: readonly string[] = [],
): GovernorDecision {
  const usage = sumUsage(running);
  return Object.freeze({
    action,
    reason,
    profile,
    jobId: candidate.jobId,
    priority: candidate.priority,
    requested: candidate.request,
    selectedRequest,
    downshift,
    preemptJobIds,
    usage,
    available: availableUsage(profile, usage),
    safeBoundaryRequired: action === "preempt",
  });
}

/**
 * Pure admission decision.  Running jobs are inputs, so repeated calls with
 * the same profile/context produce byte-for-byte equivalent decisions.
 */
export function decideAdmission(
  profileInput: MockHardwareProfile,
  jobInput: GovernorJob,
  context: GovernorDecisionContext = {},
): GovernorDecision {
  const profile = normalizeProfile(profileInput);
  const candidate = normalizedJob(jobInput);
  const running = (context.running ?? []).map(normalizedJob);
  const usage = sumUsage(running);
  const requestedFitsProfile = canFitProfile(profile, candidate.request);

  if (fitsNow(profile, candidate.request, running, usage)) {
    return decision(profile, candidate, "admit", "fits", running, candidate.request, undefined);
  }

  const downshift = chooseDownshift(profile, candidate.request, running, usage);
  if (downshift) {
    return decision(profile, candidate, "downshift", "downshift_available", running, downshift, downshift);
  }

  if (requestedFitsProfile) {
    const victims = findPreemptionVictims(profile, candidate.request, candidate, running);
    if (victims.length > 0) {
      return decision(
        profile,
        candidate,
        "preempt",
        "preemption_safe_boundary",
        running,
        candidate.request,
        undefined,
        victims,
      );
    }
    const concurrencyBlocked = usage.activeJobs >= profile.maxConcurrentJobs;
    return decision(
      profile,
      candidate,
      "queue",
      concurrencyBlocked ? "concurrency_limit" : "resources_busy",
      running,
      undefined,
      undefined,
    );
  }

  return decision(
    profile,
    candidate,
    "deny",
    "request_exceeds_profile",
    running,
    undefined,
    undefined,
  );
}

function sortQueued(left: NormalizedGovernorJob, right: NormalizedGovernorJob): number {
  return (
    right.priority.weight - left.priority.weight ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.jobId.localeCompare(right.jobId)
  );
}

/**
 * Small scheduler seam for later supervisor/Core layers.  It accounts for
 * resources but never kills a process: a `preempt` result must be explicitly
 * committed after the worker reports a safe boundary.
 */
export class ResourceGovernor {
  readonly profile: MockHardwareProfile;
  private readonly runningJobs = new Map<string, NormalizedGovernorJob>();
  private readonly queuedJobs = new Map<string, NormalizedGovernorJob>();

  constructor(options: ResourceGovernorOptions | MockHardwareProfile = {}) {
    const profile = "id" in options ? options : options.profile ?? REFERENCE_4GB_PROFILE;
    this.profile = normalizeProfile(profile);
  }

  evaluate(job: GovernorJob): GovernorDecision {
    return decideAdmission(this.profile, job, {
      running: [...this.runningJobs.values()],
      queued: [...this.queuedJobs.values()],
    });
  }

  /** Submit a job; admission/downshift is accounted immediately, queue is retained. */
  submit(job: GovernorJob): GovernorDecision {
    const normalized = normalizedJob(job);
    if (this.runningJobs.has(normalized.jobId) || this.queuedJobs.has(normalized.jobId)) {
      throw new GovernorConflictError(`job ${normalized.jobId} is already known to the governor`);
    }
    const result = decideAdmission(this.profile, normalized, {
      running: [...this.runningJobs.values()],
      queued: [...this.queuedJobs.values()],
    });
    if (result.action === "admit" || result.action === "downshift") {
      this.runningJobs.set(normalized.jobId, {
        ...normalized,
        request: result.selectedRequest ?? normalized.request,
      });
    } else if (result.action === "queue" || result.action === "preempt") {
      this.queuedJobs.set(normalized.jobId, normalized);
    }
    return result;
  }

  admit(job: GovernorJob): GovernorDecision {
    return this.submit(job);
  }

  release(jobId: string): boolean {
    return this.runningJobs.delete(jobId) || this.queuedJobs.delete(jobId);
  }

  markSafeBoundary(jobId: string, safeBoundary = true): void {
    const current = this.runningJobs.get(jobId);
    if (!current) throw new GovernorConflictError(`running job ${jobId} is not known`);
    this.runningJobs.set(jobId, { ...current, safeBoundary });
  }

  /**
   * Apply a previously returned preemption decision only when every victim is
   * still at a safe boundary.  No process operation is attempted here.
   */
  commitPreemption(jobId: string): GovernorDecision {
    const queued = this.queuedJobs.get(jobId);
    if (!queued) throw new GovernorConflictError(`queued job ${jobId} is not known`);
    const result = this.evaluate(queued);
    if (result.action !== "preempt") {
      if (result.action === "admit" || result.action === "downshift") {
        this.queuedJobs.delete(jobId);
        this.runningJobs.set(jobId, {
          ...queued,
          request: result.selectedRequest ?? queued.request,
        });
      }
      return result;
    }
    const victims = result.preemptJobIds.map((victimId) => this.runningJobs.get(victimId));
    if (victims.some((victim) => !victim || !victim.safeBoundary)) {
      return decision(
        this.profile,
        queued,
        "queue",
        "resources_busy",
        [...this.runningJobs.values()],
        undefined,
        undefined,
      );
    }
    for (const victimId of result.preemptJobIds) this.runningJobs.delete(victimId);
    this.queuedJobs.delete(jobId);
    this.runningJobs.set(jobId, {
      ...queued,
      request: result.selectedRequest ?? queued.request,
    });
    return decision(
      this.profile,
      queued,
      result.downshift ? "downshift" : "admit",
      result.downshift ? "downshift_available" : "fits",
      [...this.runningJobs.values()],
      result.selectedRequest,
      result.downshift,
      result.preemptJobIds,
    );
  }

  /** Attempt queued work in deterministic priority/FIFO order. */
  drain(): readonly GovernorDecision[] {
    const decisions: GovernorDecision[] = [];
    const queued = [...this.queuedJobs.values()].sort(sortQueued);
    for (const job of queued) {
      if (!this.queuedJobs.has(job.jobId)) continue;
      const result = this.evaluate(job);
      decisions.push(result);
      if (result.action === "admit" || result.action === "downshift") {
        this.queuedJobs.delete(job.jobId);
        this.runningJobs.set(job.jobId, {
          ...job,
          request: result.selectedRequest ?? job.request,
        });
      }
    }
    return decisions;
  }

  snapshot(): GovernorSnapshot {
    const running = [...this.runningJobs.values()];
    const queued = [...this.queuedJobs.values()].sort(sortQueued);
    const usage = sumUsage(running);
    return Object.freeze({
      profile: this.profile,
      running,
      queued,
      usage,
      available: availableUsage(this.profile, usage),
    });
  }
}

export { ResourceGovernor as Governor };
