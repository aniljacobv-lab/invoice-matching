import { useEffect, useMemo, useState } from 'react';
import {
  api, type SummaryResponse, type ExceptionRow, type Severity, type ExceptionStatus, type MatchStatus,
} from '../lib/api';

interface Props { onOpenInvoice: (invoiceNum: string) => void; }

const usd = (n: number | null | undefined) => (n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 }));
const usdExact = (n: number | null | undefined) => (n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const num = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString('en-US'));
const pct = (n: number | null | undefined) => (n == null ? '—' : `${Number(n).toFixed(1)}%`);

const sevPill = (sev: Severity) => sev === 'HIGH' ? 'bg-red-50 text-red-700' : sev === 'MED' ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-700';
const flowPill = (flow: string) => flow === 'DSD' ? 'bg-violet-50 text-violet-700' : 'bg-sky-50 text-sky-700';
const statusFg = (s: MatchStatus): string => s === '3WAY' ? 'text-emerald-700'
  : s === '2WAY' ? 'text-teal-700'
  : s === 'QTY_VAR' ? 'text-amber-700'
  : s === 'AMT_VAR' ? 'text-orange-700'
  : s === 'INV_NO_ASN' ? 'text-red-700'
  : s === 'ASN_NO_INV' ? 'text-blue-700'
  : 'text-amber-800';
const statusBg = (s: MatchStatus): string => s === '3WAY' ? 'bg-emerald-50'
  : s === '2WAY' ? 'bg-teal-50'
  : s === 'QTY_VAR' || s === 'AMT_VAR' ? 'bg-amber-50'
  : s === 'INV_NO_ASN' ? 'bg-red-50'
  : s === 'ASN_NO_INV' ? 'bg-blue-50'
  : 'bg-amber-50';

export function EdiMatchPage({ onOpenInvoice }: Props) {
  const [data, setData] = useState<SummaryResponse | null>(null);
  const [exceptions, setExceptions] = useState<ExceptionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [vendorFilter, setVendorFilter] = useState<string>('');
  const [sevFilter, setSevFilter] = useState<'ALL' | Severity>('ALL');
  const [daysFilter, setDaysFilter] = useState<number | null>(null);
  const [pickedExc, setPickedExc] = useState<ExceptionRow | null>(null);
  const [resolveNote, setResolveNote] = useState('');

  async function load() {
    setLoading(true);
    try {
      const [s, e] = await Promise.all([
        api.summary(),
        api.exceptions({ vendor: vendorFilter || undefined, severity: sevFilter, days: daysFilter ?? undefined, status: 'OPEN' }),
      ]);
      setData(s); setExceptions(e);
    } finally { setLoading(false); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [vendorFilter, sevFilter, daysFilter]);
  async function runFull() { setRunning(true); try { await api.runFull(); await load(); } finally { setRunning(false); } }
  async function resolve(status: ExceptionStatus) {
    if (!pickedExc) return;
    await api.closeException(pickedExc.exc_id, status, resolveNote || undefined);
    setPickedExc(null); setResolveNote(''); await load();
  }

  const sortedVendors = useMemo(() => data?.vendors.slice().sort((a, b) => b.invs - a.invs) ?? [], [data]);

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-slate-200 bg-white px-8 py-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold tracking-tight text-slate-900">EDI 3-way match</h2>
            <p className="mt-0.5 text-sm text-slate-500">Reconciles 850 PO ↔ 856 ASN ↔ 810 Invoice across PepsiCo DSD and Quaker DC flows.</p>
          </div>
          <button onClick={runFull} disabled={running} className="fd-btn fd-btn-primary">{running ? 'Running…' : 'Run match'}</button>
        </div>
        {data && (
          <p className="mt-2 text-[11px] text-slate-400">
            Last run {data.summary.last_run ? new Date(data.summary.last_run).toLocaleString() : '—'} · {data.filesProcessed.filter((f) => f.count > 0).length} EDI files ingested
          </p>
        )}
      </header>

      <div className="flex-1 overflow-y-auto p-8">
        {loading && <p className="text-sm text-slate-400">Loading…</p>}
        {!loading && data && (
          <div className="mx-auto max-w-7xl space-y-6">
            {/* KPI GRID */}
            <section className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-6">
              <Kpi label="POs sent" value={num(data.summary.pos_sent)} sub={usd(data.summary.po_amt)} />
              <Kpi label="ASNs received" value={num(data.summary.asns_received)} sub={`${num(data.summary.cartons)} cartons`} />
              <Kpi label="Invoices" value={num(data.summary.invs_received)} sub={`${num(data.summary.inv_lines)} lines`} />
              <Kpi label="Gross billed" value={usd(data.summary.inv_gross)} sub={`Net ${usd(data.summary.inv_net)}`} />
              <Kpi label="Match rate" value={pct(data.summary.match_rate)} sub={'clean 3-way / 2-way'} tone="text-emerald-600" />
              <Kpi label="Open exceptions" value={num(data.summary.exceptions_open)} sub="needs review" tone="text-red-600" />
            </section>

            {/* STATUS BREAKDOWN */}
            <section className="fd-card p-5">
              <h3 className="fd-section-title mb-3">Match status breakdown</h3>
              <div className="grid grid-cols-2 gap-2 md:grid-cols-4 lg:grid-cols-7">
                {data.statuses.map((s) => (
                  <div key={s.code} className={`rounded-lg border border-slate-200 p-3 ${statusBg(s.code)}`}>
                    <div className={`text-2xl font-bold tabular-nums ${statusFg(s.code)}`}>{num(s.count)}</div>
                    <div className="text-[11px] text-slate-600">{s.label}</div>
                    <div className="text-[10px] text-slate-400">{pct(s.pct)}</div>
                  </div>
                ))}
              </div>
            </section>

            {/* VENDOR TABLE */}
            <section className="fd-card overflow-hidden">
              <div className="border-b border-slate-100 p-4">
                <h3 className="fd-section-title">Vendor performance</h3>
              </div>
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs text-slate-500">
                  <tr>
                    <th className="px-3 py-2">Vendor</th>
                    <th className="px-3 py-2">Flow</th>
                    <th className="px-3 py-2 text-right">POs</th>
                    <th className="px-3 py-2 text-right">PO $</th>
                    <th className="px-3 py-2 text-right">ASNs</th>
                    <th className="px-3 py-2 text-right">Cartons</th>
                    <th className="px-3 py-2 text-right">Invoices</th>
                    <th className="px-3 py-2 text-right">Gross</th>
                    <th className="px-3 py-2 text-right">Net</th>
                    <th className="px-3 py-2 text-right">Match %</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {sortedVendors.map((v) => (
                    <tr key={v.id} className="hover:bg-slate-50/60 cursor-pointer" onClick={() => setVendorFilter(v.id === vendorFilter ? '' : v.id)}>
                      <td className="px-3 py-2"><span className="block font-medium text-slate-700">{v.name}</span><span className="text-[10px] text-slate-400">{v.id}</span></td>
                      <td className="px-3 py-2"><span className={`fd-pill ${flowPill(v.flow)}`}>{v.flow}</span></td>
                      <td className="px-3 py-2 text-right tabular-nums">{num(v.pos)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{usd(v.po_amt)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{num(v.asns)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{num(v.cartons)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{num(v.invs)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{usdExact(v.gross)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{usdExact(v.net)}</td>
                      <td className={`px-3 py-2 text-right tabular-nums font-medium ${v.rate >= 95 ? 'text-emerald-700' : v.rate >= 50 ? 'text-amber-700' : 'text-red-700'}`}>{pct(v.rate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {vendorFilter && <div className="border-t border-slate-100 p-2 text-center text-xs text-slate-500">Exceptions below filtered to vendor <span className="font-mono">{vendorFilter}</span> · <button onClick={() => setVendorFilter('')} className="text-fd-red">clear</button></div>}
            </section>

            {/* EXCEPTIONS */}
            <section className="fd-card p-5">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <h3 className="fd-section-title">Exceptions queue ({exceptions.length})</h3>
                <div className="flex items-center gap-2">
                  <div className="fd-seg">
                    {(['ALL', 'HIGH', 'MED', 'LOW'] as const).map((k) => (
                      <button key={k} onClick={() => setSevFilter(k)} className={`fd-seg-item ${sevFilter === k ? 'fd-seg-item-active' : ''}`}>{k}</button>
                    ))}
                  </div>
                  <select className="fd-input w-32 text-xs" value={daysFilter ?? ''} onChange={(e) => setDaysFilter(e.target.value ? Number(e.target.value) : null)}>
                    <option value="">All time</option><option value="1">1 day</option><option value="7">7 days</option><option value="30">30 days</option>
                  </select>
                </div>
              </div>
              <div className="overflow-hidden rounded-lg border border-slate-200">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 text-left text-slate-500">
                    <tr>
                      <th className="px-3 py-2">Sev</th>
                      <th className="px-3 py-2">Type</th>
                      <th className="px-3 py-2">Flow</th>
                      <th className="px-3 py-2">Vendor</th>
                      <th className="px-3 py-2">Store</th>
                      <th className="px-3 py-2">PO</th>
                      <th className="px-3 py-2">ASN</th>
                      <th className="px-3 py-2">Invoice</th>
                      <th className="px-3 py-2 text-right">Amount</th>
                      <th className="px-3 py-2 text-right">Age</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {exceptions.slice(0, 200).map((e) => (
                      <tr key={e.exc_id} onClick={() => setPickedExc(e)} className="cursor-pointer hover:bg-slate-50/60">
                        <td className="px-3 py-1.5"><span className={`fd-pill ${sevPill(e.severity)}`}>{e.severity}</span></td>
                        <td className={`px-3 py-1.5 font-medium ${statusFg(e.exc_type)}`}>{e.exc_type}</td>
                        <td className="px-3 py-1.5"><span className={`fd-pill ${flowPill(e.flow.includes('DC') ? 'DC' : 'DSD')}`}>{e.flow}</span></td>
                        <td className="px-3 py-1.5 text-slate-600">{e.vendor_id}</td>
                        <td className="px-3 py-1.5 text-slate-600">{e.store}</td>
                        <td className="px-3 py-1.5 text-slate-500">{e.po_num}</td>
                        <td className="px-3 py-1.5 text-slate-500">{e.asn_num}</td>
                        <td className="px-3 py-1.5">
                          {e.invoice_num !== '—' ? (
                            <button onClick={(ev) => { ev.stopPropagation(); onOpenInvoice(e.invoice_num); }} className="text-blue-700 hover:underline">{e.invoice_num}</button>
                          ) : <span className="text-slate-400">—</span>}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{usdExact(e.exc_amount)}</td>
                        <td className="px-3 py-1.5 text-right text-slate-500">{e.age_days}d</td>
                      </tr>
                    ))}
                    {exceptions.length === 0 && <tr><td colSpan={10} className="px-3 py-4 text-center text-slate-400">No exceptions match these filters.</td></tr>}
                  </tbody>
                </table>
              </div>
              {exceptions.length > 200 && <p className="mt-2 text-[11px] text-slate-400">Showing first 200 of {exceptions.length}. Tighten filters to narrow.</p>}
            </section>

            {/* SOURCE FILES (audit trail) */}
            <section className="fd-card p-5">
              <h3 className="fd-section-title mb-3">EDI files ingested</h3>
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-left text-slate-500"><tr><th className="px-3 py-2">File</th><th className="px-3 py-2">Type</th><th className="px-3 py-2 text-right">Records</th></tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {data.filesProcessed.map((f) => (
                    <tr key={f.file}><td className="px-3 py-1.5 font-mono text-slate-700">{f.file}</td><td className="px-3 py-1.5 text-slate-600">{f.type}</td><td className="px-3 py-1.5 text-right tabular-nums">{num(f.count)}</td></tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>
        )}
      </div>

      {/* Exception detail drawer */}
      {pickedExc && (
        <div className="fixed inset-0 z-50 flex items-end justify-end bg-black/30" onClick={() => setPickedExc(null)}>
          <div className="h-full w-full max-w-xl overflow-y-auto bg-white p-6 shadow-pop" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between gap-2">
              <h3 className="text-lg font-semibold text-slate-900">Exception #{pickedExc.exc_id}</h3>
              <button onClick={() => setPickedExc(null)} className="text-slate-400 hover:text-slate-700">✕</button>
            </div>
            <div className="space-y-2 text-sm">
              <div className="flex items-center gap-2"><span className={`fd-pill ${sevPill(pickedExc.severity)}`}>{pickedExc.severity}</span><span className={`font-medium ${statusFg(pickedExc.exc_type)}`}>{pickedExc.exc_type}</span><span className={`fd-pill ${flowPill(pickedExc.flow.includes('DC') ? 'DC' : 'DSD')}`}>{pickedExc.flow}</span></div>
              <Row label="Vendor" value={pickedExc.vendor_id} />
              <Row label="Store/DC" value={pickedExc.store} />
              <Row label="PO #" value={pickedExc.po_num} />
              <Row label="ASN #" value={pickedExc.asn_num} />
              <Row label="Invoice #" value={pickedExc.invoice_num} />
              <Row label="Exception $" value={usdExact(pickedExc.exc_amount)} />
              <Row label="Age" value={`${pickedExc.age_days} days`} />
            </div>
            <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"><span className="font-medium">Recommended action:</span> {pickedExc.recommended_action}</div>
            <textarea value={resolveNote} onChange={(e) => setResolveNote(e.target.value)} placeholder="Resolution note for the audit trail…" className="fd-input mt-3 min-h-[60px] w-full text-sm" />
            <div className="mt-3 flex flex-wrap gap-2">
              <button onClick={() => resolve('RESOLVED')} className="fd-btn fd-btn-primary">Mark resolved</button>
              <button onClick={() => resolve('ASSIGNED')} className="fd-btn fd-btn-ghost">Assign to me</button>
              <button onClick={() => resolve('WRITTEN_OFF')} className="fd-btn fd-btn-ghost text-red-700">Write off</button>
            </div>
            {pickedExc.invoice_num !== '—' && (
              <button onClick={() => { onOpenInvoice(pickedExc.invoice_num); setPickedExc(null); }} className="mt-4 text-xs text-blue-700 hover:underline">View underlying invoice →</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: string }) {
  return (
    <div className="fd-card p-4">
      <div className={`text-2xl font-bold tabular-nums ${tone ?? 'text-slate-800'}`}>{value}</div>
      <div className="mt-0.5 text-[11px] font-medium uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-0.5 text-[11px] text-slate-500">{sub}</div>
    </div>
  );
}
function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex items-baseline justify-between border-b border-slate-100 py-1"><span className="text-[11px] uppercase tracking-wide text-slate-400">{label}</span><span className="font-mono text-slate-700">{value}</span></div>;
}
