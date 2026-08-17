import { useEffect, useState } from 'react';
import {
  api,
  type AiStatus, type FuzzyMatchResponse, type TriageResponse,
  type NlQueryResponse, type AlignResponse, type TriagedException,
} from '../lib/api';

// ─────────────────────────────────────────────────────────────────────────────
// AI panels for the AP workbench.
//
// Shared contract with the API: any endpoint can return { available: false,
// reason } when ANTHROPIC_API_KEY is not configured. Every panel here renders
// that as a calm explanatory note, never an error — the deterministic matcher is
// still fully working and the operator should not be led to think otherwise.
//
// Model output is always labelled as a proposal and always shows its confidence
// and reasoning. Nothing in this file writes to the ledger.
// ─────────────────────────────────────────────────────────────────────────────

const usd = (n: number | null | undefined) =>
  n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function AiBadge({ status }: { status: AiStatus | null }) {
  if (!status) return null;
  if (!status.available) {
    return <span className="fd-pill bg-slate-100 text-slate-500" title={status.reason}>AI off</span>;
  }
  const live = status.platforms?.filter((p) => p.available) ?? [];
  const title = live.length
    ? `Serving: ${status.model}\nConfigured platforms: ${live.map((p) => p.platform).join(', ')}`
    : `Serving: ${status.model}`;
  return (
    <span className="fd-pill bg-violet-50 text-violet-700" title={title}>
      AI on · {status.model}
      {live.length > 1 && <span className="ml-1 text-violet-500">+{live.length - 1}</span>}
    </span>
  );
}

/**
 * Which platforms are wired up and how each capability is routed.
 * Renders whether or not AI is available — when nothing is configured this is
 * the fastest way for an operator to see exactly which credential is missing.
 */
export function AiPlatformPanel({ status }: { status: AiStatus | null }) {
  const [open, setOpen] = useState(false);
  if (!status?.platforms?.length) return null;
  const live = status.platforms.filter((p) => p.available);

  return (
    <section className="fd-card p-5">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center justify-between gap-3 text-left">
        <div>
          <h3 className="fd-section-title">AI platforms &amp; routing</h3>
          <p className="mt-0.5 text-[11px] text-slate-500">
            {live.length === 0
              ? 'No platform configured — AI features are off, matching is unaffected'
              : `${live.length} of ${status.platforms.length} platforms configured · ${live.map((p) => p.platform).join(', ')}`}
          </p>
        </div>
        <span className="text-slate-400">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div>
            <h4 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-slate-400">Platforms</h4>
            <div className="space-y-1">
              {status.platforms.map((p) => (
                <div key={p.platform} className="flex items-start gap-2 text-xs">
                  <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${p.available ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                  <div className="min-w-0">
                    <span className={p.available ? 'font-medium text-slate-700' : 'text-slate-500'}>{p.platform}</span>
                    {!p.available && <span className="block text-[10px] text-slate-400">{p.reason}</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div>
            <h4 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-slate-400">Routing &amp; failover</h4>
            <div className="space-y-2">
              {status.routes?.map((r) => (
                <div key={r.capability} className="text-xs">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-slate-700">{r.capability}</span>
                    {!r.usable && <span className="fd-pill bg-amber-50 text-amber-700">no credentials</span>}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] text-slate-500">
                    {r.chain.map((c, i) => (
                      <span key={c} className="flex items-center gap-1">
                        {i > 0 && <span className="text-slate-300">→</span>}
                        <code className={i === 0 ? 'rounded bg-slate-100 px-1 text-slate-700' : 'rounded bg-slate-50 px-1'}>{c}</code>
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {!!status.usage?.calls && (
            <div className="md:col-span-2 border-t border-slate-100 pt-3 text-[11px] text-slate-500">
              {status.usage.calls} calls · {(status.usage.inputTokens + status.usage.outputTokens).toLocaleString('en-US')} tokens ·{' '}
              {status.usage.cacheHits} cache hits
              {status.usage.failovers > 0 && <span className="text-amber-700"> · {status.usage.failovers} failovers</span>}
              {status.usage.byPlatform && Object.entries(status.usage.byPlatform).map(([p, u]) => (
                <span key={p} className="ml-2 rounded bg-slate-50 px-1.5 py-0.5">{p}: {u.calls}</span>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function Unavailable({ reason }: { reason?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-xs text-slate-600">
      <p className="font-medium text-slate-700">AI features are switched off</p>
      <p className="mt-1">{reason ?? 'No API key configured.'}</p>
      <p className="mt-2 text-slate-500">
        Deterministic matching, the exception queue and every figure on this page are unaffected —
        they never call a model. Set <code className="rounded bg-slate-200 px-1">ANTHROPIC_API_KEY</code> to
        enable match proposals, triage and natural-language search.
      </p>
    </div>
  );
}

function ConfidenceBar({ value }: { value: number }) {
  const tone = value >= 80 ? 'bg-emerald-500' : value >= 60 ? 'bg-amber-500' : 'bg-slate-400';
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-slate-200">
        <div className={`h-full ${tone}`} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
      </div>
      <span className="tabular-nums text-[11px] text-slate-500">{value}%</span>
    </div>
  );
}

// ─── Natural-language query ──────────────────────────────────────────────────

const EXAMPLES = [
  'PepsiCo invoices over $2,000 with no ASN',
  'Which stores have the most open exceptions?',
  'Show credit memos issued this week',
  'Exceptions older than 3 days worth more than $500',
];

export function AiQueryPanel({ status }: { status: AiStatus | null }) {
  const [q, setQ] = useState('');
  const [res, setRes] = useState<NlQueryResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function ask(question: string) {
    if (!question.trim()) return;
    setBusy(true); setErr(null);
    try { setRes(await api.aiQuery(question)); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  if (status && !status.available) {
    return <section className="fd-card p-5"><h3 className="fd-section-title mb-3">Ask about this data</h3><Unavailable reason={status.reason} /></section>;
  }

  const cols = res?.rows?.length ? Object.keys(res.rows[0]!) : [];

  return (
    <section className="fd-card p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="fd-section-title">Ask about this data</h3>
        <AiBadge status={status} />
      </div>

      <form onSubmit={(e) => { e.preventDefault(); ask(q); }} className="flex gap-2">
        <input
          value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="e.g. PepsiCo invoices over $2,000 with no ASN"
          className="fd-input flex-1 text-sm"
        />
        <button type="submit" disabled={busy || !q.trim()} className="fd-btn fd-btn-primary shrink-0">
          {busy ? 'Asking…' : 'Ask'}
        </button>
      </form>

      <div className="mt-2 flex flex-wrap gap-1.5">
        {EXAMPLES.map((x) => (
          <button key={x} onClick={() => { setQ(x); ask(x); }}
            className="rounded-full border border-slate-200 px-2.5 py-1 text-[11px] text-slate-600 hover:border-slate-300 hover:bg-slate-50">
            {x}
          </button>
        ))}
      </div>

      {err && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{err}</p>}

      {res && res.available === false && <div className="mt-3"><Unavailable reason={res.reason} /></div>}

      {res?.available && (
        <div className="mt-4 space-y-3">
          <div className="rounded-lg border border-violet-200 bg-violet-50 px-3 py-2">
            <p className="text-sm font-medium text-violet-900">{res.answer}</p>
            <p className="mt-1 text-[11px] text-violet-700">Interpreted as: {res.interpretation}</p>
          </div>

          {!!res.caveats?.length && (
            <ul className="list-inside list-disc space-y-0.5 text-[11px] text-amber-700">
              {res.caveats.map((c, i) => <li key={i}>{c}</li>)}
            </ul>
          )}

          <details className="text-[11px] text-slate-500">
            <summary className="cursor-pointer select-none hover:text-slate-700">Filter applied</summary>
            <pre className="mt-1 overflow-x-auto rounded bg-slate-50 p-2 font-mono text-[10px] text-slate-600">
              {JSON.stringify(res.filter, null, 2)}
            </pre>
          </details>

          {!!res.rows?.length && (
            <div className="overflow-x-auto rounded-lg border border-slate-200">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-left text-slate-500">
                  <tr>{cols.map((c) => <th key={c} className="whitespace-nowrap px-3 py-2">{c}</th>)}</tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {res.rows.slice(0, 50).map((r, i) => (
                    <tr key={i} className="hover:bg-slate-50/60">
                      {cols.map((c) => (
                        <td key={c} className="whitespace-nowrap px-3 py-1.5 text-slate-700">
                          {typeof r[c] === 'number' ? (r[c] as number).toLocaleString('en-US') : String(r[c] ?? '—')}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// ─── Exception triage ────────────────────────────────────────────────────────

export function AiTriagePanel({
  status, vendor, severity, onOpenInvoice,
}: {
  status: AiStatus | null; vendor?: string; severity?: string;
  onOpenInvoice?: (n: string) => void;
}) {
  const [res, setRes] = useState<TriageResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    setBusy(true); setErr(null);
    try { setRes(await api.aiTriage({ limit: 25, vendor, severity: severity === 'ALL' ? undefined : severity })); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  if (status && !status.available) {
    return <section className="fd-card p-5"><h3 className="fd-section-title mb-3">AI triage</h3><Unavailable reason={status.reason} /></section>;
  }

  return (
    <section className="fd-card p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="fd-section-title">AI triage</h3>
          <p className="mt-0.5 text-[11px] text-slate-500">
            Ranks the queue by recoverable dollars and names the systemic causes. Proposals only — nothing is closed automatically.
          </p>
        </div>
        <button onClick={run} disabled={busy} className="fd-btn fd-btn-primary">
          {busy ? 'Analysing…' : res ? 'Re-run triage' : 'Triage top 25'}
        </button>
      </div>

      {err && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{err}</p>}
      {res && res.available === false && <Unavailable reason={res.reason} />}

      {res?.available && (
        <div className="space-y-4">
          {!!res.themes?.length && (
            <div className="space-y-2">
              <h4 className="text-[11px] font-medium uppercase tracking-wide text-slate-400">Systemic themes</h4>
              {res.themes.map((t, i) => (
                <div key={i} className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-sm font-medium text-blue-900">{t.theme}</span>
                    <span className="tabular-nums text-xs text-blue-700">
                      {t.excIds.length} exception{t.excIds.length === 1 ? '' : 's'} · {usd(t.impactUsd)}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-blue-800">{t.recommendation}</p>
                </div>
              ))}
            </div>
          )}

          {!!res.triaged?.length && (
            <div>
              <h4 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-slate-400">
                Prioritised · {res.triaged.length} of {res.queueSize} open
              </h4>
              <div className="space-y-2">
                {res.triaged.map((t) => <TriageCard key={t.excId} t={t} onOpenInvoice={onOpenInvoice} />)}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function TriageCard({ t, onOpenInvoice }: { t: TriagedException; onOpenInvoice?: (n: string) => void }) {
  const tone = t.priority >= 75 ? 'border-red-200 bg-red-50' : t.priority >= 45 ? 'border-amber-200 bg-amber-50' : 'border-slate-200 bg-white';
  return (
    <div className={`rounded-lg border p-3 ${tone}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="rounded bg-slate-900 px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-white">P{t.priority}</span>
          <span className="text-xs font-medium text-slate-700">Exception #{t.excId}</span>
          {t.tags.map((tag) => (
            <span key={tag} className="fd-pill bg-slate-100 text-slate-600">{tag}</span>
          ))}
        </div>
        <div className="flex items-center gap-3">
          {t.estRecoveryUsd != null && (
            <span className="tabular-nums text-xs font-medium text-emerald-700">{usd(t.estRecoveryUsd)} recoverable</span>
          )}
          <ConfidenceBar value={t.confidence} />
        </div>
      </div>
      <p className="mt-1.5 text-xs text-slate-700"><span className="font-medium">Cause:</span> {t.rootCause}</p>
      <p className="mt-1 text-xs text-slate-700"><span className="font-medium">Next:</span> {t.nextAction}</p>
      {onOpenInvoice && (
        <button onClick={() => onOpenInvoice(String(t.excId))} className="mt-1.5 hidden text-[11px] text-blue-700 hover:underline">
          Open
        </button>
      )}
    </div>
  );
}

// ─── Fuzzy match proposals (invoice detail) ──────────────────────────────────

export function AiFuzzyMatchPanel({ invoiceNum }: { invoiceNum: string }) {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [res, setRes] = useState<FuzzyMatchResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { api.aiStatus().then(setStatus).catch(() => setStatus(null)); }, []);

  async function run() {
    setBusy(true); setErr(null);
    try { setRes(await api.aiFuzzyMatch(invoiceNum)); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  return (
    <section className="fd-card p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="fd-section-title">Find a matching shipment</h3>
          <p className="mt-0.5 text-[11px] text-slate-500">
            Exact-key matching failed. A deterministic prescreen shortlists candidates; the model ranks them and explains why.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <AiBadge status={status} />
          <button onClick={run} disabled={busy || (status ? !status.available : false)} className="fd-btn fd-btn-primary">
            {busy ? 'Searching…' : 'Propose a match'}
          </button>
        </div>
      </div>

      {status && !status.available && <Unavailable reason={status.reason} />}
      {err && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{err}</p>}
      {res && res.available === false && <Unavailable reason={res.reason} />}

      {res?.available && (
        <div className="space-y-3">
          {res.note && <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">{res.note}</p>}

          {res.best ? (
            <div className="rounded-lg border-2 border-emerald-300 bg-emerald-50 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-semibold text-emerald-900">
                  Proposed: {res.best.candidateId}
                  <span className="ml-2 fd-pill bg-emerald-100 text-emerald-800">{res.best.verdict}</span>
                </span>
                <ConfidenceBar value={res.best.confidence} />
              </div>
              <p className="mt-1.5 text-xs text-emerald-900">{res.best.reason}</p>
              {!!res.best.discrepancies.length && (
                <ul className="mt-1.5 list-inside list-disc text-[11px] text-amber-800">
                  {res.best.discrepancies.map((d, i) => <li key={i}>{d}</li>)}
                </ul>
              )}
              <p className="mt-2 rounded bg-white/70 px-2 py-1 text-[11px] text-slate-700">
                <span className="font-medium">Suggested:</span> {res.best.suggestedAction}
              </p>
              <p className="mt-2 text-[10px] uppercase tracking-wide text-emerald-700">
                Proposal only · confirm before posting
              </p>
            </div>
          ) : (
            res.proposals && (
              <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                No candidate cleared the confidence threshold. This invoice looks genuinely unmatched rather than mis-keyed.
              </p>
            )
          )}

          {!!res.candidates?.length && (
            <details className="text-xs">
              <summary className="cursor-pointer select-none text-slate-500 hover:text-slate-700">
                Candidates considered ({res.candidates.length}) — deterministic prescreen
              </summary>
              <div className="mt-2 space-y-1.5">
                {res.candidates.map((c) => {
                  const p = res.proposals?.find((x) => x.candidateId === c.id);
                  return (
                    <div key={c.id} className="rounded border border-slate-200 p-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-mono text-slate-700">{c.kind} {c.id}</span>
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] text-slate-400">prescreen {c.prescreen}</span>
                          {p && <span className={`fd-pill ${p.verdict === 'NO_MATCH' ? 'bg-slate-100 text-slate-600' : 'bg-emerald-50 text-emerald-700'}`}>{p.verdict} {p.confidence}%</span>}
                        </div>
                      </div>
                      <p className="mt-1 text-[11px] text-slate-500">{c.signals.join(' · ')}</p>
                      {p && <p className="mt-1 text-[11px] text-slate-600">{p.reason}</p>}
                    </div>
                  );
                })}
              </div>
            </details>
          )}
        </div>
      )}
    </section>
  );
}

// ─── Line alignment (invoice detail) ─────────────────────────────────────────

export function AiAlignPanel({ invoiceNum, counterpartId }: { invoiceNum: string; counterpartId?: string }) {
  const [res, setRes] = useState<AlignResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    setBusy(true); setErr(null);
    try { setRes(await api.aiAlign(invoiceNum, counterpartId)); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  const methodPill = (m: string) =>
    m === 'UPC' ? 'bg-emerald-50 text-emerald-700'
      : m === 'AI_DESCRIPTION' ? 'bg-violet-50 text-violet-700'
        : 'bg-slate-100 text-slate-500';

  return (
    <section className="fd-card p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="fd-section-title">Line-level alignment</h3>
          <p className="mt-0.5 text-[11px] text-slate-500">
            UPC join first; the model only sees lines that could not be matched on item number.
          </p>
        </div>
        <button onClick={run} disabled={busy} className="fd-btn fd-btn-ghost">
          {busy ? 'Aligning…' : 'Align lines'}
        </button>
      </div>

      {err && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{err}</p>}
      {res?.available === false && <Unavailable reason={res.reason} />}
      {res?.error === 'no_counterpart' && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">{res.message}</p>
      )}

      {res?.summary && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <Stat label="Matched on UPC" value={res.summary.byUpc} tone="text-emerald-700" />
            <Stat label="Matched by AI" value={res.summary.byAi} tone="text-violet-700" />
            <Stat label="Unmatched" value={res.summary.unmatched} tone="text-slate-600" />
            <Stat label="Variance" value={usd(res.summary.varianceUsd)} tone={res.summary.varianceUsd ? 'text-red-700' : 'text-slate-600'} />
          </div>
          <p className="text-[11px] text-slate-500">
            {res.summary.shortShipped} line{res.summary.shortShipped === 1 ? '' : 's'} billed above shipped ·{' '}
            {res.summary.overShipped} shipped above billed · net qty Δ {res.summary.netQtyVariance}
          </p>

          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-left text-slate-500">
                <tr>
                  <th className="px-3 py-2">#</th>
                  <th className="px-3 py-2">Description</th>
                  <th className="px-3 py-2">Ref</th>
                  <th className="px-3 py-2 text-right">Inv qty</th>
                  <th className="px-3 py-2 text-right">Ship qty</th>
                  <th className="px-3 py-2 text-right">Δ</th>
                  <th className="px-3 py-2">Method</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {res.lines?.map((l, i) => (
                  <tr key={i} className={l.qtyVariance ? 'bg-amber-50/50' : ''}>
                    <td className="px-3 py-1.5 text-slate-400">{l.invoiceLineNo ?? '—'}</td>
                    <td className="px-3 py-1.5 text-slate-700">
                      {l.description}
                      {l.note && <span className="block text-[10px] text-slate-400">{l.note}</span>}
                    </td>
                    <td className="px-3 py-1.5 font-mono text-[10px] text-slate-500">{l.counterpartRef ?? '—'}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{l.invoiceQty ?? '—'}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{l.counterpartQty ?? '—'}</td>
                    <td className={`px-3 py-1.5 text-right tabular-nums font-medium ${l.qtyVariance ? 'text-red-700' : 'text-slate-400'}`}>
                      {l.qtyVariance ?? '—'}
                    </td>
                    <td className="px-3 py-1.5">
                      <span className={`fd-pill ${methodPill(l.method)}`}>
                        {l.method === 'AI_DESCRIPTION' ? `AI ${l.confidence}%` : l.method}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 p-2.5">
      <div className={`text-lg font-bold tabular-nums ${tone ?? 'text-slate-800'}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-slate-400">{label}</div>
    </div>
  );
}
