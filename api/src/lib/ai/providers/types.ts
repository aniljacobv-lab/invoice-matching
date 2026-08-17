// ─────────────────────────────────────────────────────────────────────────────
// Provider-neutral contract for a single structured model call.
//
// Every AI feature in this app asks the same thing: "given this system prompt and
// this user payload, return an object matching this JSON Schema." That contract is
// narrow enough to implement on every major platform, which is why swapping
// providers does not require touching fuzzyMatch.ts, triage.ts, nlQuery.ts or
// itemNormalize.ts at all.
//
// What deliberately is NOT in this interface: streaming, multi-turn conversation,
// vision, and tool loops. This app needs none of them, and a narrow interface is
// what keeps the adapters honest and testable.
// ─────────────────────────────────────────────────────────────────────────────

/** Where a model is hosted. Several of these serve the same underlying models. */
export type Platform =
  | 'anthropic'        // api.anthropic.com
  | 'bedrock'          // Claude via AWS Bedrock
  | 'vertex'           // Claude via Google Cloud Vertex AI
  | 'openai'           // api.openai.com
  | 'azure-openai'     // OpenAI models via an Azure resource
  | 'google';          // Gemini via the Google Gen AI API

/** The four AI capabilities, each independently routable to its own model. */
export type Capability = 'fuzzy-match' | 'triage' | 'nl-query' | 'line-align';

export interface CompletionRequest {
  system: string;
  user: string;
  /** JSON Schema the reply must satisfy. Normalized per-provider before dispatch. */
  schema: Record<string, unknown>;
  maxTokens: number;
  /** Provider-specific model id, e.g. 'claude-sonnet-5' or 'gpt-5'. */
  model: string;
}

export interface CompletionResponse {
  value: unknown;
  model: string;
  platform: Platform;
  inputTokens: number;
  outputTokens: number;
}

export interface ProviderStatus {
  platform: Platform;
  available: boolean;
  /** Why it is unavailable — missing key, missing SDK, missing region. */
  reason?: string;
  /** True when the npm package backing this provider is not installed. */
  sdkMissing?: boolean;
}

export interface Provider {
  readonly platform: Platform;
  status(): ProviderStatus;
  complete(req: CompletionRequest): Promise<CompletionResponse>;
}

/**
 * Errors worth retrying on a different provider: transport failures, rate limits,
 * timeouts, provider-side 5xx.
 *
 * A schema-validation failure is deliberately NOT retryable. If a model returns
 * something that does not match the schema, the same request will usually fail the
 * same way on the next provider, and silently shopping the request around hides a
 * real prompt or schema bug behind extra latency and cost.
 */
export class RetryableProviderError extends Error {
  readonly retryable = true;
  constructor(message: string, readonly platform: Platform, readonly underlying?: unknown) {
    super(message);
    this.name = 'RetryableProviderError';
  }
}

/** A provider that cannot serve a request at all — no key, SDK not installed. */
export class ProviderUnavailableError extends Error {
  readonly retryable = true;
  constructor(message: string, readonly platform: Platform) {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}

/** The model answered, but not in the shape we asked for. Do not fail over. */
export class SchemaViolationError extends Error {
  readonly retryable = false;
  constructor(message: string, readonly platform: Platform) {
    super(message);
    this.name = 'SchemaViolationError';
  }
}

/** Classify an unknown SDK error as retryable or not. */
export function isRetryable(e: unknown): boolean {
  if (e instanceof SchemaViolationError) return false;
  if (e instanceof RetryableProviderError || e instanceof ProviderUnavailableError) return true;
  const status = (e as { status?: number })?.status;
  if (typeof status === 'number') {
    // 408 timeout, 409 conflict, 429 rate limit, 5xx server. 4xx otherwise means
    // the request itself is wrong — a bad key or a model id this account cannot
    // reach — and retrying elsewhere would mask a configuration error.
    return status === 408 || status === 409 || status === 429 || status >= 500;
  }
  const code = (e as { code?: string })?.code ?? '';
  return ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'ENOTFOUND'].includes(code);
}
