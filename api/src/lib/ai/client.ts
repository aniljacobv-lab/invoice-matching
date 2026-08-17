// ─────────────────────────────────────────────────────────────────────────────
// Shared AI client for the AP workbench.
//
// This is the only place in the app that reaches a model. fuzzyMatch.ts,
// triage.ts, nlQuery.ts and itemNormalize.ts call askStructured() and know
// nothing about which vendor answered — which is what made adding Bedrock,
// Vertex, OpenAI, Azure and Gemini a change to this directory alone.
//
// Design rules every AI feature follows:
//
//  1. AI NEVER posts money. Every model output is a *proposal* carrying a
//     confidence and a stated reason; a human confirms it.
//  2. Degrade, never crash. With no provider configured the endpoints return
//     { available: false } and the UI hides the panels. Deterministic matching
//     is unaffected on every code path.
//  3. Deterministic pre-filter, AI ranker. Cheap indexed code narrows the work;
//     the model only makes the judgement call code cannot.
//  4. Cache by content signature. The same question asked twice costs once.
//  5. Route per capability, fail over on transport errors only.
// ─────────────────────────────────────────────────────────────────────────────
import { config } from '../../config.js';
import type { Capability } from './providers/types.js';
import {
  dispatch, parseTarget, platformStatuses, anyProviderAvailable, resetProviders,
  type RouteTarget, type AttemptLog,
} from './providers/registry.js';

export interface AiStatus {
  available: boolean;
  /** Model serving the default capability, for a compact UI badge. */
  model: string;
  reason?: string;
}

export function aiStatus(): AiStatus {
  const primary = routeFor('fuzzy-match')[0];
  if (!config.app.ai.enabled) {
    return { available: false, model: primary?.model ?? 'none', reason: 'AI disabled in app.config.json (ai.enabled = false)' };
  }
  if (!anyProviderAvailable()) {
    const hints = platformStatuses().filter((s) => !s.available).map((s) => `${s.platform}: ${s.reason}`);
    return {
      available: false,
      model: primary?.model ?? 'none',
      reason: `No AI provider is configured. ${hints[0] ?? ''} — set ANTHROPIC_API_KEY (or OPENAI_API_KEY / GOOGLE_API_KEY, or AWS/GCP credentials for Bedrock/Vertex).`,
    };
  }
  return { available: true, model: primary ? `${primary.platform}:${primary.model}` : 'unrouted' };
}

/** Full multi-platform detail for the status endpoint and the settings UI. */
export function aiPlatformDetail() {
  const caps: Capability[] = ['fuzzy-match', 'triage', 'nl-query', 'line-align'];
  return {
    platforms: platformStatuses(),
    routes: caps.map((cap) => ({
      capability: cap,
      chain: routeFor(cap).map((t) => `${t.platform}:${t.model}`),
      // A chain is only usable if at least one entry has credentials.
      usable: routeFor(cap).some((t) => platformStatuses().find((s) => s.platform === t.platform)?.available),
    })),
  };
}

export class AiUnavailableError extends Error {
  readonly code = 'ai_unavailable';
  constructor(reason: string) { super(reason); }
}

/**
 * Resolve a capability to its ordered provider chain.
 *
 * Config may give a single string or an array. A bare model id with no platform
 * prefix means anthropic, so the pre-multi-provider config shape still works.
 */
export function routeFor(cap: Capability): RouteTarget[] {
  const raw = config.app.ai.routes?.[cap] ?? config.app.ai.model;
  const list = Array.isArray(raw) ? raw : [raw];
  return list.filter(Boolean).map((s) => parseTarget(String(s)));
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
  if (cache.size > 2000) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].expires - b[1].expires).slice(0, 500);
    for (const [k] of oldest) cache.delete(k);
  }
}
export function cacheStats() { return { entries: cache.size, ttlMinutes: config.app.ai.cacheTtlMinutes }; }
export function clearAiCache() { cache.clear(); resetProviders(); }

// ─── Usage accounting, per platform ──────────────────────────────────────────
interface UsageBucket { calls: number; inputTokens: number; outputTokens: number; errors: number; failovers: number }
const usage = { calls: 0, inputTokens: 0, outputTokens: 0, cacheHits: 0, errors: 0, failovers: 0 };
const byPlatform = new Map<string, UsageBucket>();

function bump(platform: string, mut: (b: UsageBucket) => void) {
  const b = byPlatform.get(platform) ?? { calls: 0, inputTokens: 0, outputTokens: 0, errors: 0, failovers: 0 };
  mut(b);
  byPlatform.set(platform, b);
}

export function aiUsage() {
  return { ...usage, byPlatform: Object.fromEntries(byPlatform) };
}

// ─── Core call ───────────────────────────────────────────────────────────────

export interface AskOptions {
  system: string;
  user: string;
  /** JSON Schema the reply must satisfy. Normalized per-provider before dispatch. */
  schema: Record<string, unknown>;
  /** Which capability this is, for routing. Defaults to fuzzy-match's chain. */
  capability?: Capability;
  /** Stable signature for caching. Omit to bypass the cache. */
  cacheKey?: string;
  maxTokens?: number;
}

/**
 * Ask for a structured answer, routed by capability with failover.
 *
 * Structured output is enforced by the provider — a forced tool call on Anthropic,
 * strict json_schema on OpenAI, responseSchema on Gemini — rather than by asking
 * for JSON in the prompt and parsing prose that may arrive in a markdown fence.
 */
export async function askStructured<T>(opts: AskOptions): Promise<T> {
  if (!config.app.ai.enabled || !anyProviderAvailable()) {
    throw new AiUnavailableError(aiStatus().reason ?? 'AI unavailable');
  }

  if (opts.cacheKey) {
    const hit = cacheGet<T>(opts.cacheKey);
    if (hit) { usage.cacheHits++; return hit; }
  }

  const capability = opts.capability ?? 'fuzzy-match';
  const chain = routeFor(capability);

  try {
    const res = await dispatch(chain, {
      system: opts.system,
      user: opts.user,
      schema: opts.schema,
      maxTokens: opts.maxTokens ?? config.app.ai.maxTokens,
    });

    usage.calls++;
    usage.inputTokens += res.inputTokens;
    usage.outputTokens += res.outputTokens;
    const failedOver = countFailovers(res.attempts);
    usage.failovers += failedOver;
    bump(res.platform, (b) => {
      b.calls++; b.inputTokens += res.inputTokens; b.outputTokens += res.outputTokens; b.failovers += failedOver;
    });

    if (opts.cacheKey) cacheSet(opts.cacheKey, res.value);
    return res.value as T;
  } catch (e) {
    usage.errors++;
    bump(chain[0]?.platform ?? 'unknown', (b) => { b.errors++; });
    throw e;
  }
}

/** Attempts that failed before the one that succeeded. */
function countFailovers(attempts: AttemptLog[]): number {
  const winner = attempts.findIndex((a) => a.ok);
  return winner <= 0 ? 0 : winner;
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
