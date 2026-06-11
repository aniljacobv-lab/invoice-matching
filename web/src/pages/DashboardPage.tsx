import { useEffect, useState } from 'react';
import { api, type Dashboard, type InvoiceStatus } from '../lib/api';

interface Props { onOpen: (id: number) => void; }

const STATUS_STYLE: Record<InvoiceStatus, string> = {
  PENDING_MATCH: 'bg-slate-100 text-slate-600',
  MATCHED: 'bg-green-50 text-green-700',
  EXCEPTION: 'bg-amber-50 text-amber-700',
  APPROVED: 'bg-blue-50 text-blue-700',
  REJECTED: 'bg-red-50 text-red-700',
  PAID: 'bg-slate-200 text-slate-700',
};
const usd = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function DashboardPage({ onOpen }: Props) {
  const [d, setD] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  async function load() { setLoading(true); try { setD(await api.dashboard()); } finally { setLoading(false); } }
  useEffect(() => { load(); }, []);
  async function matchAll() { setRunning(true); try { await api.matchAll(); await load(); } finally { setRunning(false); } }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-8 py-5">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">Home</h2>
          <p className="mt-0.5 text-sm text-slate-500">Invoice matching health — exceptions, dollars at risk, pending approvals.</p>
        </div>
        <button onClick={matchAll} disabled={running} className="fd-btn fd-btn-primary">{running ? 'Running…' : 'Run matching engine'}</button>
      </header>
      <div className="flex-1 overflow-y-auto p-8">
        {loading && <p className="text-sm text-slate-400">Loading…</p>}
        {!loading && !d && <p className="text-sm text-slate-400">Couldn't load dashboard.</p>}
        {!loading && d && (
          <div className="mx-auto max-w-5xl space-y-6">
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              <div className="fd-card p-4"><div className="text-2xl font-bold text-amber-600">{d.statusCounts.EXCEPTION}</div><div className="mt-0.5 text-xs text-slate-500">Exceptions</div></div>
              <div className="fd-card p-4"><div className="text-2xl font-bold text-red-600">{usd(d.totals.dollarsAtRisk)}</div><div className="mt-0.5 text-xs text-slate-500">$ at risk</div></div>
              <div className="fd-card p-4"><div className="text-2xl font-bold text-blue-600">{d.statusCounts.MATCHED + d.statusCounts.APPROVED}</div><div className="mt-0.5 text-xs text-slate-500">Ready to pay</div></div>
              <div className="fd-card p-4"><div className="text-2xl font-bold text-slate-800">{usd(d.totals.dollarsPendingPay)}</div><div className="mt-0.5 text-xs text-slate-500">$ pending pay</div></div>
            </div>

            <section className="fd-card p-5">
              <h3 className="fd-section-title mb-3">Status pipeline</h3>
              <div className="flex flex-wrap gap-2">
                {(Object.keys(d.statusCounts) as InvoiceStatus[]).map((s) => (
                  <span key={s} className={`fd-pill ${STATUS_STYLE[s]}`}>{s} · {d.statusCounts[s]}</span>
                ))}
              </div>
            </section>

            <section className="fd-card p-5">
              <h3 className="fd-section-title mb-3">Recent invoices</h3>
              {d.recent.length === 0 ? <p className="text-xs text-slate-400">No invoices yet.</p> : (
                <div className="overflow-hidden rounded-lg border border-slate-200">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-left text-xs text-slate-500">
                      <tr><th className="px-3 py-2">Invoice #</th><th className="px-3 py-2">Vendor</th><th className="px-3 py-2">PO</th><th className="px-3 py-2 text-right">Total</th><th className="px-3 py-2 text-right">$ exception</th><th className="px-3 py-2">Status</th><th className="px-3 py-2 text-right">Tier</th></tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {d.recent.map((r) => (
                        <tr key={r.invoiceId} className="cursor-pointer hover:bg-slate-50/60" onClick={() => onOpen(r.invoiceId)}>
                          <td className="px-3 py-2 font-medium text-slate-700">{r.invoiceNumber}</td>
                          <td className="px-3 py-2 text-slate-500">{r.vendorName}</td>
                          <td className="px-3 py-2 text-slate-500">{r.poNumber ?? '—'}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{usd(r.totalUsd)}</td>
                          <td className={`px-3 py-2 text-right tabular-nums ${r.exceptionImpact > 0 ? 'text-red-600 font-medium' : 'text-slate-300'}`}>{r.exceptionImpact > 0 ? usd(r.exceptionImpact) : '—'}</td>
                          <td className="px-3 py-2"><span className={`fd-pill ${STATUS_STYLE[r.status]}`}>{r.status}</span></td>
                          <td className="px-3 py-2 text-right text-slate-500">Tier {r.requiredTier}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
