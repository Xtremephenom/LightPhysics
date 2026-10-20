import { z } from "zod";

export const ForgeErrorCodeSchema = z.enum([
  "ValidationError", "ResourceUnavailable", "Timeout", "RateLimit",
  "MalformedResponse", "PolicyRefusal", "OutOfMemory", "ProviderError",
  "Cancelled", "Unqualified", "NotImplemented", "Authentication",
  "BudgetExceeded", "CircuitOpen", "ChecksumMismatch", "DiskInsufficient",
]);
export type ForgeErrorCode = z.infer<typeof ForgeErrorCodeSchema>;

export class ForgeError extends Error {
  readonly code: ForgeErrorCode;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(code: ForgeErrorCode, message: string, options: { retryable?: boolean; details?: unknown } = {}) {
    super(message);
    this.name = code;
    this.code = code;
    this.retryable = options.retryable ?? ["ResourceUnavailable", "Timeout", "RateLimit", "MalformedResponse"].includes(code);
    this.details = options.details;
  }
}

export class ProviderError extends ForgeError {
  readonly provider: string;
  readonly status: number | undefined;
  constructor(provider: string, message: string, options: { code?: ForgeErrorCode; status?: number; retryable?: boolean; details?: unknown } = {}) {
    super(options.code ?? "ProviderError", message, options);
    this.name = "ProviderError";
    this.provider = provider;
    this.status = options.status;
  }
}

export class NotImplementedError extends ForgeError {
  constructor(feature: string) { super("NotImplemented", `${feature} is not implemented`, { retryable: false }); }
}
export class UnqualifiedError extends ForgeError {
  constructor(feature: string) { super("Unqualified", `${feature} is not qualified on this machine`, { retryable: false }); }
}

export function asForgeError(error: unknown, provider = "unknown"): ForgeError {
  if (error instanceof ForgeError) return error;
  return new ProviderError(provider, error instanceof Error ? error.message : String(error));
}
