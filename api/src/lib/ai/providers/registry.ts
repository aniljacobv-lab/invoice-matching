// ─────────────────────────────────────────────────────────────────────────────
// Provider registry: per-capability routing plus ordered failover.
//
// Two independent ideas live here.
//
// ROUTING. The four capabilities have genuinely different economics, so they get
// independently configurable models:
//
//   fuzzy-match   Low volume, high stakes. A wrong match causes a duplicate
//                 payment, so this warrants the strongest model available.
//   triage        High volume — 1,300 open exceptions. This is where model cost
//                 actually accumulates, and where a cheaper model is defensible
//                 because a human reads every line before acting.
//   nl-query      Interactive; latency matters more than depth. The model only
//                 emits a small filter object, which is then executed by ordinary
//                 code, so a smaller model is fine.
//   line-align    Moderate volume, moderate stakes.
//
// FAILOVER. Each route carries an ordered chain. On a retryable error — rate
// limit, timeout, 5xx — the next entry is tried. On a schema violation we stop
// immediately: that is a prompt or schema bug, and quietly shopping it to another
// vendor would burn money to hide it.
//
// A chain entry naming an unconfigured provider is skipped, not fatal. That means
// you can ship one config listing every platform and it degrades to whatever the
// deployment actually has credentials for.
// ─────────────────────────────────────────────────────────────────────────────
import type { Provider, Platform, Capability, CompletionRequest, CompletionResponse, ProviderStatus } from './types.js';
import { isRetryable } from './types.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAiProvider } from './openai.js';
import { GoogleProvider } from './google.js';

export interface RouteTarget { platform: Platform; model: string }
export interface ResolvedRoute { capability: Capability; chain: RouteTarget[] }

export interface AttemptLog {
  platform: Platform;
  model: string;
  ok: boolean;
  error?: string;
  retryable?: boolean;
}

export interface DispatchResult extends CompletionResponse {
  attempts: AttemptLog[];
}

const PROVIDERS = new Map<Platform, Provider>();

function providerFor(platform: Platform): Provider {
  const hit = PROVIDERS.get(platform);
  if (hit) return hit;
  let p: Provider;
  switch (platform) {
    case 'anthropic':
    case 'bedrock':
    case 'vertex':
      p = new AnthropicProvider({ platform });
      break;
    case 'openai':
    case 'azure-openai':
      p = new OpenAiProvider(platform);
      break;
    case 'google':
      p = new GoogleProvider();
      break;
    default:
      throw new Error(`unknown platform: ${platform}`);
  }
  PROVIDERS.set(platform, p);
  return p;
}

export const ALL_PLATFORMS: Platform[] = ['anthropic', 'bedrock', 'vertex', 'openai', 'azure-openai', 'google'];

/** Availability of every known platform, for the status endpoint. */
export function platformStatuses(): ProviderStatus[] {
  return ALL_PLATFORMS.map((p) => {
    try { return providerFor(p).status(); }
    catch (e) { return { platform: p, available: false, reason: e instanceof Error ? e.message : String(e) }; }
  });
}

export function anyProviderAvailable(): boolean {
  return platformStatuses().some((s) => s.available);
}

/**
 * Parse a route entry. Accepts "platform:model" ("openai:gpt-5") or a bare model
 * id, which defaults to the anthropic platform for backward compatibility with
 * the single-provider config this replaced.
 */
export function parseTarget(spec: string): RouteTarget {
  const i = spec.indexOf(':');
  if (i === -1) return { platform: 'anthropic', model: spec };
  const platform = spec.slice(0, i) as Platform;
  const model = spec.slice(i + 1);
  if (!ALL_PLATFORMS.includes(platform)) return { platform: 'anthropic', model: spec };
  return { platform, model };
}

/**
 * Dispatch one structured completion along a route chain.
 *
 * Returns the first success along with a log of every attempt, so the UI can show
 * which platform actually answered rather than implying the primary always did.
 */
export async function dispatch(
  chain: RouteTarget[],
  req: Omit<CompletionRequest, 'model'>,
): Promise<DispatchResult> {
  const attempts: AttemptLog[] = [];
  if (chain.length === 0) throw new Error('route has no targets configured');

  let lastError: unknown = null;

  for (const target of chain) {
    let provider: Provider;
    try { provider = providerFor(target.platform); }
    catch (e) {
      attempts.push({ platform: target.platform, model: target.model, ok: false, error: (e as Error).message, retryable: true });
      lastError = e; continue;
    }

    const st = provider.status();
    if (!st.available) {
      // Not configured on this deployment — skip quietly and keep going.
      attempts.push({ platform: target.platform, model: target.model, ok: false, error: st.reason, retryable: true });
      continue;
    }

    try {
      const res = await provider.complete({ ...req, model: target.model });
      attempts.push({ platform: target.platform, model: target.model, ok: true });
      return { ...res, attempts };
    } catch (e) {
      const retryable = isRetryable(e);
      attempts.push({
        platform: target.platform, model: target.model, ok: false,
        error: e instanceof Error ? e.message : String(e), retryable,
      });
      lastError = e;
      // A schema violation will recur identically elsewhere. Surface it now.
      if (!retryable) throw e;
    }
  }

  const summary = attempts
    .map((a) => `${a.platform}/${a.model}: ${a.error ?? 'failed'}`)
    .join(' | ');
  const err = new Error(`every provider in the chain failed — ${summary}`);
  (err as { cause?: unknown }).cause = lastError;
  throw err;
}

/** Reset cached clients. Used when credentials change via .env hot reload. */
export function resetProviders(): void { PROVIDERS.clear(); }
