import { useEffect, useState } from 'react';
import { api, type Invoice, type InvoiceStatus, type MatchResult, type LineMatch } from '../lib/api';

interface Props { invoiceId: number; onClose: () => void; }

const STATUS_STYLE: Record<InvoiceStatus, string> = {
  PENDING_MATCH: 'bg-slate-100 text-slate-600', MATCHED: 'bg-green-50 text-green-700',
  EXCEPTION: 'bg-amber-50 text-amber-700', APPROVED: 'bg-blue-50 text-blue-700',
  REJECTED: 'bg-red-50 text-red-700', PAID: 'bg-slate-200 text-slate-700',
};
const usd = (n: number | null | undefined) => n == null ? '—' : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num = (n: number | null | undefined) => n == null ? '—' : n.toLocaleString();

const KIND_LABEL: Record<string, string> = {
  PRICE_DIFF: 'Price', QTY_OVER: 'Over qty', QTY_UNDER: 'Under qty',
  NOT_RECEIVED: 'Not received', PARTIAL_RECEIPT: 'Partial receipt',
  SKU_NOT_ON_PO: 'SKU not on PO', VENDOR_MISMATCH: 'Vendor mismatch',
  PO_NOT_FOUND: 'PO not found', AMOUNT_DIFF: 'Math error',
};

export function InvoiceDetailPage({ invoiceId, onClose }: Props) {
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [match, setMatch] = useState<MatchResult | null>(null);
  const [requiredTier, setRequiredTier] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function load() {
    const r = await api.getInvoice(invoiceId);
    setInvoice(r.invoice); setMatch(r.match);
  }
  useEffect(() => { load(); }, [invoiceId]);

  async function runMatch() {
    setBusy(true); setNote(null);
    try { const r = await api.matchInvoice(invoiceId); setMatch(r.match); setRequiredTier(r.requiredTier); await load(); }
    catch (e: any) { setNote(String(e?.message ?? e)); }
    finally { setBusy(false); }
  }
  async function approve() { setBusy(true); try { await api.setInvoiceStatus(invoiceId, 'APPROVED', 'Approved with exceptions reviewed'); await load(); } finally { setBusy(false); } }
  async function reject() { setBusy(true); try { await api.setInvoiceStatus(invoiceId, 'REJECTED', 'Returned to vendor'); await load(); } finally { setBusy(false); } }

  if (!invoice) return <div className="p-8 text-sm text-slate-400">Loading invoice…</div>;

  return (
    <div className="flex h-full flex-col">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/95 px-8 py-4 backdrop-blur">
        <button onClick={onClose} className="mb-2 inline-flex items-center text-[11px] font-medium uppercase tracking-wide text-slate-400 hover:text-slate-700">&larr;&nbsp;Back to Invoices</button>
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-xl font-semibold tracking-tight text-slate-900">{invoice.invoiceNumber}</h2>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
              <span className={`fd-pill ${STATUS_STYLE[invoice.status]}`}>{invoice.status}</span>
              <span>{invoice.vendorName}</span>
              <span>·</span>
              <span>PO {invoice.poNumber ?? '—'}</span>
              <span>·</span>
              <span>Received {invoice.receivedDate}</span>
              <span>·</span>
              <span>Due {invoice.dueDate}</span>
              <span>·</span>
              <span className="font-medium text-slate-700">{usd(invoice.totalUsd)}</span>
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <button onClick={runMatch} disabled={busy} className="fd-btn fd-btn-primary">{busy ? 'Working…' : (match ? 'Re-run matching' : 'Run matching')}</button>
            {match && invoice.status === 'EXCEPTION' && <button onClick={approve} disabled={busy} className="fd-btn fd-btn-ghost text-green-700">Approve with exceptions</button>}
            {match && invoice.status !== 'PAID' && invoice.status !== 'REJECTED' && <button onClick={reject} disabled={busy} className="fd-btn fd-btn-ghost text-red-700">Reject</button>}
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-8">
        <div className="mx-auto max-w-5xl space-y-5">
          {note && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{note}</div>}
          {invoice.notes && <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs italic text-slate-600">{invoice.notes}</div>}

          {match ? (
            <section className="fd-card p-5">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="fd-section-title">Match summary</h3>
                <span className="text-xs text-slate-500">{match.mode === 'THREE_WAY' ? '3-way match (PO + GR + invoice)' : '2-way match (PO + invoice)'}</span>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
                <Kpi label="Clean lines" value={match.cleanLines} tone="text-green-700" />
                <Kpi label="Exception lines" value={match.exceptionLines} tone={match.exceptionLines > 0 ? 'text-amber-700' : 'text-slate-500'} />
                <Kpi label="$ at risk" value={usd(match.totalDollarImpact)} tone={match.totalDollarImpact > 0 ? 'text-red-600' : 'text-slate-500'} />
                <Kpi label="Required tier" value={requiredTier != null ? `Tier ${requiredTier}` : '—'} tone="text-blue-700" />
              </div>
              {match.topDiscrepancyKinds.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {match.topDiscrepancyKinds.map((k) => <span key={k} className="fd-pill bg-amber-50 text-amber-700">{KIND_LABEL[k] ?? k}</span>)}
                </div>
              )}
              <p className="mt-2 text-[11px] text-slate-400">Vendor ID check: {match.vendorOk ? '✓ matches PO' : '✗ vendor mismatch'} · Total check: {match.totalsOk ? '✓ within tolerance' : '✗ totals differ'}</p>
            </section>
          ) : (
            <section className="fd-card p-5">
              <h3 className="fd-section-title mb-2">No match run yet</h3>
              <p className="text-xs text-slate-500">Click "Run matching" to compare this invoice against its PO {invoice.poNumber ? `(${invoice.poNumber})` : ''} and any goods receipts.</p>
            </section>
          )}

          <section className="fd-card p-5">
            <h3 className="fd-section-title mb-3">Line-level breakdown</h3>
            <div className="overflow-hidden rounded-lg border border-slate-200">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-left text-slate-500">
                  <tr>
                    <th className="px-3 py-2">SKU · Description</th>
                    <th className="px-3 py-2 text-right">Inv qty</th>
                    <th className="px-3 py-2 text-right">PO qty</th>
                    <th className="px-3 py-2 text-right">Received</th>
                    <th className="px-3 py-2 text-right">Inv unit</th>
                    <th className="px-3 py-2 text-right">PO unit</th>
                    <th className="px-3 py-2 text-right">Inv amount</th>
                    <th className="px-3 py-2">Issues</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {(match?.lines ?? invoice.lines.map((il) => ({
                    invoiceLineNo: il.lineNo, sku: il.sku, description: il.description,
                    poLineNo: null, grLineNo: null,
                    invoiceQty: il.qty, invoiceUnitPrice: il.unitPrice, invoiceAmount: il.amount,
                    poQty: null, poUnitCost: null, poAmount: null, grQtyReceived: null, discrepancies: [],
                  }) as LineMatch)).map((l) => (
                    <tr key={`${l.invoiceLineNo}-${l.sku}`} className={l.discrepancies.length ? 'bg-amber-50/40' : ''}>
                      <td className="px-3 py-2"><span className="block font-medium text-slate-700">{l.description}</span><span className="text-[10px] text-slate-400">SKU {l.sku}</span></td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-700">{num(l.invoiceQty)}</td>
                      <td className={`px-3 py-2 text-right tabular-nums ${l.poQty != null && l.poQty !== l.invoiceQty ? 'text-amber-700' : 'text-slate-500'}`}>{num(l.poQty)}</td>
                      <td className={`px-3 py-2 text-right tabular-nums ${l.grQtyReceived != null && l.grQtyReceived < l.invoiceQty ? 'text-red-600' : 'text-slate-500'}`}>{num(l.grQtyReceived)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-700">{usd(l.invoiceUnitPrice)}</td>
                      <td className={`px-3 py-2 text-right tabular-nums ${l.poUnitCost != null && Math.abs(l.poUnitCost - l.invoiceUnitPrice) > 0.005 ? 'text-amber-700' : 'text-slate-500'}`}>{usd(l.poUnitCost)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{usd(l.invoiceAmount)}</td>
                      <td className="px-3 py-2">
                        {l.discrepancies.length === 0 ? <span className="text-green-700">✓ clean</span> : (
                          <div className="space-y-1">
                            {l.discrepancies.map((d, i) => (
                              <div key={i}>
                                <span className="fd-pill bg-amber-100 text-amber-800">{KIND_LABEL[d.kind] ?? d.kind}</span>
                                <span className="ml-1.5 text-slate-600">{d.message}</span>
                                {d.dollarImpact !== 0 && <span className="ml-1 text-[11px] text-red-600">({d.dollarImpact >= 0 ? '+' : ''}{usd(Math.abs(d.dollarImpact))})</span>}
                              </div>
                            ))}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function Kpi({ label, value, tone }: { label: string; value: string | number; tone: string }) {
  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className={`text-xl font-bold ${tone}`}>{value}</div>
      <div className="mt-0.5 text-[11px] text-slate-500">{label}</div>
    </div>
  );
}
