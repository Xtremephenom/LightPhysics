import { ForgeRequestSchema, type DataPolicy, type ForgeRequest, type ForgeResult } from "./capabilities.ts";
import { asForgeError, ForgeError } from "./errors.ts";
import { requestHash, type ForgeAdapter, type RunOptions } from "./adapter.ts";

export interface EgressRecord { request_hash: string; provider: string; }
export interface RoutingOptions { data_policy?: DataPolicy | undefined; rewritePolicyRefusal?: ((request: ForgeRequest) => ForgeRequest) | undefined; stricterRetry?: ((request: ForgeRequest) => ForgeRequest) | undefined; egress?: EgressRecord[] | undefined; }
export interface RouteResult { result: ForgeResult; provider: string; attempts: string[]; egress: readonly EgressRecord[]; }
function hostedAllowed(policy: DataPolicy | undefined, capability: ForgeRequest["capability"]): boolean { if (!policy || policy === "hosted_ok") return true; if (policy === "local_only") return false; return policy.hosted_ok_for.includes(capability); }
function retryable(code: string): boolean { return ["ResourceUnavailable", "Timeout", "RateLimit", "ProviderError"].includes(code); }

export async function routeRequest(request: ForgeRequest, adapters: readonly ForgeAdapter[], options: RoutingOptions = {}, runOptions: RunOptions = {}): Promise<RouteResult> {
  const normalized = ForgeRequestSchema.parse(request); const hash = requestHash(normalized); const egress = options.egress ?? []; const attempts: string[] = []; let rewritten = false;
  for (const adapter of adapters) {
    const description = adapter.describe(); if (description.kind === "hosted" && !hostedAllowed(options.data_policy, normalized.capability)) continue; if (!description.capabilities.includes(normalized.capability)) continue;
    attempts.push(adapter.id); if (description.kind === "hosted") egress.push({ request_hash: hash, provider: adapter.id });
    let candidate = normalized; let strict = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try { return { result: await adapter.run(candidate, runOptions), provider: adapter.id, attempts, egress: [...egress] }; }
      catch (unknownError) { const error = asForgeError(unknownError, adapter.id); if (error.code === "PolicyRefusal" && !rewritten && options.rewritePolicyRefusal) { rewritten = true; candidate = ForgeRequestSchema.parse(options.rewritePolicyRefusal(candidate)); continue; } if (error.code === "MalformedResponse" && !strict && options.stricterRetry) { strict = true; candidate = ForgeRequestSchema.parse(options.stricterRetry(candidate)); continue; } if (retryable(error.code)) break; throw new ForgeError(error.code, `${adapter.id}: ${error.message}`, { details: { attempts, egress }, retryable: error.retryable }); }
    }
  }
  throw new ForgeError("ResourceUnavailable", "no eligible Forge adapter succeeded", { details: { attempts, egress } });
}
