// ─────────────────────────────────────────────────────────────────────────────
// Shared Anthropic client for the AP workbench.
//
// Design rules every AI feature in this app follows:
//
//  1. AI NEVER posts money. Every model output is a *proposal* carrying a
//     confidence and a stated reason; a human confirms it. Nothing here writes
//     to the exception ledger.
//  2. Degrade, never crash. With no ANTHROPIC_API_KEY the endpoints return
//     `{ available: false }` and the UI hides the panels. The deterministic
//     matcher is unaffected either way.
//  3. Deterministic pre-filter, AI ranker. We never hand the model 1,862
//     invoices and ask it to find the needle. Cheap indexed code narrows to a
//     shortlist; the model does the judgement call the code can't.
//  4. Cache by content signature. The same exception asked twice costs once.
// ─────────────────────────────────────────────────────────────────────────────
import Anthropic from '@anthropic-ai/sdk';
import { config, currentApiKey, aiEnabled } from '../../config.js';

export interface AiStatus {
  available: boolean;
  model: string;
  reason?: string;
}

export function aiStatus(): AiStatus {
  if (!config.app.ai.enabled) return { available: false, model: config.app.ai.model, reason: 'AI disabled in app.config.json (ai.enabled = false)' };
  if (!currentApiKey()) return { available: false, model: config.app.ai.model, reason: 'ANTHROPIC_API_KEY is not set — add it in the Render Environment tab, or to a local .env' };
  return { available: true, model: config.app.ai.model };
}

let client: Anthropic | null = null;
let clientKey = '';
function getClient(): Anthropic {
  const key = currentApiKey();
  if (!client || clientKey !== key) {
    client = new Anthropic({ apiKey: key, maxRetries: 2 });
    clientKey = key;
  }
  return client;
}

export class AiUnavailableError extends Error {
  readonly code = 'ai_unavailable';
  constructor(reason: string) { super(reason); }
}

// ─── Response cache ──────────────────────────────────────────────────────────
interface CacheEntry { value: unknown; expires: number }
const cache = new Map<string, CacheEntry>();

function cacheGet<T>(key: string): T | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expires < Date.now()) { cache.delete(key); return null; }
  return hit.value as T;
}
function cacheSet(key: string, value: unknown): void {
  cache.set(key, { value, expires: Date.now() + config.app.ai.cacheTtlMinutes * 60_000 });
  // Bound growth — this store is per-process and never persisted.
  if (cache.size > 2000) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].expires - b[1].expires).slice(0, 500);
    for (const [k] of oldest) cache.delete(k);
  }
}
export function cacheStats() { return { entries: cache.size, ttlMinutes: config.app.ai.cacheTtlMinutes }; }
export function clearAiCache() { cache.clear(); }

// ─── Usage accounting ────────────────────────────────────────────────────────
const usage = { calls: 0, inputTokens: 0, outputTokens: 0, cacheHits: 0, errors: 0 };
export function aiUsage() { return { ...usage }; }

// ─── Core call ───────────────────────────────────────────────────────────────

export interface AskOptions {
  system: string;
  user: string;
  /** JSON Schema the reply must satisfy. Enforced via a forced tool call. */
  schema: Record<string, unknown>;
  /** Stable signature for caching. Omit to bypass the cache. */
  cacheKey?: string;
  maxTokens?: number;
}

/**
 * Ask Claude for a structured answer.
 *
 * Uses a forced tool call rather than "reply in JSON" prompting: the schema is
 * enforced by the API, so we get a validated object instead of parsing prose
 * that may arrive wrapped in a markdown fence.
 */
export async function askStructured<T>(opts: AskOptions): Promise<T> {
  if (!aiEnabled()) throw new AiUnavailableError(aiStatus().reason ?? 'AI unavailable');

  if (opts.cacheKey) {
    const hit = cacheGet<T>(opts.cacheKey);
    if (hit) { usage.cacheHits++; return hit; }
  }

  const toolName = 'submit_result';
  try {
    const res = await getClient().messages.create({
      model: config.app.ai.model,
      max_tokens: opts.maxTokens ?? config.app.ai.maxTokens,
      system: opts.system,
      tools: [{ name: toolName, description: 'Return the structured result.', input_schema: opts.schema as never }],
      tool_choice: { type: 'tool', name: toolName },
      messages: [{ role: 'user', content: opts.user }],
    });

    usage.calls++;
    usage.inputTokens += res.usage?.input_tokens ?? 0;
    usage.outputTokens += res.usage?.output_tokens ?? 0;

    const block = res.content.find((c) => c.type === 'tool_use');
    if (!block || block.type !== 'tool_use') throw new Error('model returned no tool_use block');
    const value = block.input as T;
    if (opts.cacheKey) cacheSet(opts.cacheKey, value);
    return value;
  } catch (e) {
    usage.errors++;
    throw e;
  }
}

/** Short stable hash for cache keys. Not cryptographic — collision-tolerant. */
export function signature(...parts: unknown[]): string {
  const s = JSON.stringify(parts);
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    h1 = Math.imul(h1 ^ s.charCodeAt(i), 0x01000193);
    h2 = Math.imul(h2 + s.charCodeAt(i), 0x85ebca6b);
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
}
