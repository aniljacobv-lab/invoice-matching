import { useEffect, useState } from 'react';
import { api, type Invoice, type AdvanceShipNotice, type PurchaseOrder, type MatchResult, type MatchStatus } from '../lib/api';
import { AiFuzzyMatchPanel, AiAlignPanel } from '../components/AiPanels';

interface Props { invoiceNum: string; onClose: () => void; }
const usd = (n: number | null | undefined) => n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (n: number | null | undefined) => n == null ? '—' : n.toLocaleString('en-US');
const statusFg = (s: MatchStatus | null): string => !s ? 'text-slate-500'
  : s === '3WAY' ? 'text-emerald-700'
  : s === '2WAY' ? 'text-teal-700'
  : s === 'INV_NO_ASN' || s === 'AMT_VAR' ? 'text-red-700'
  : s === 'CREDIT_MEMO' ? 'text-slate-600'
  : 'text-amber-700';

export function InvoiceDetailPage({ invoiceNum, onClose }: Props) {
  const [data, setData] = useState<{ invoice: Invoice; asn: AdvanceShipNotice | null; po: PurchaseOrder | null; match: MatchResult | null } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api.invoiceDetail(invoiceNum).then(setData).finally(() => setLoading(false));
  }, [invoiceNum]);

  if (loading) return <div className="p-8 text-sm text-slate-400">Loading invoice…</div>;
  if (!data) return <div className="p-8 text-sm text-red-600">Invoice not found.</div>;
  const { invoice, asn, po, match } = data;

  // Build a unified line view keyed by UPC
  const byUpc = new Map<string, { invoice?: typeof invoice.lines[0]; po?: typeof po extends { lines: (infer L)[] } ? L : never; asn?: { qty: number } }>();
  // Keyed on the NORMALIZED upc: the same item arrives as a 12-digit UPC-A on the
  // 810 and a zero-padded 14-digit GTIN on the 856, which would otherwise split
  // one product across two rows and read as a phantom variance.
  for (const l of invoice.lines) byUpc.set(l.upcNorm || l.upc, { invoice: l });
  if (po) for (const l of po.lines) {
    const k = l.upcNorm || l.upc;
    const cur = byUpc.get(k) ?? {}; (cur as any).po = l; byUpc.set(k, cur);
  }
  if (asn) for (const p of asn.packs) for (const it of p.items) {
    const k = it.upcNorm || it.upc;
    const cur = byUpc.get(k) ?? {}; (cur as any).asn = { qty: ((cur as any).asn?.qty ?? 0) + it.qty }; byUpc.set(k, cur);
  }

  return (
    <div className="flex h-full flex-col">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/95 px-8 py-4 backdrop-blur">
        <button onClick={onClose} className="mb-2 inline-flex items-center text-[11px] font-medium uppercase tracking-wide text-slate-400 hover:text-slate-700">&larr;&nbsp;Back to match dashboard</button>
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-xl font-semibold tracking-tight text-slate-900">Invoice {invoice.invoiceNum}</h2>
            <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
              {match && <span className={`fd-pill bg-slate-100 ${statusFg(match.matchStatus)}`}>{match.matchStatus}</span>}
              <span>{invoice.vendorName} <span className="text-slate-400">({invoice.vendorId})</span></span>
              <span>·</span><span>Store {invoice.storeOrDc}</span>
              <span>·</span><span>{invoice.invoiceDate ?? 'No date'}</span>
              <span>·</span><span className="font-medium text-slate-700">{usd(invoice.invoiceAmt)}</span>
              {invoice.docType === 'CREDIT' && (
                <span className="fd-pill bg-slate-100 text-slate-700">
                  Credit memo{invoice.originalInvoiceNum ? ` · reverses ${invoice.originalInvoiceNum}` : ''}
                </span>
              )}
              {!invoice.reconciled && (
                <span className="fd-pill bg-amber-50 text-amber-800" title={`Header total does not equal the sum of line extensions (${usd(invoice.lineExtSum)}).`}>
                  Unreconciled
                </span>
              )}
              {invoice.poNum && <><span>·</span><span>PO {invoice.poNum}</span></>}
            </p>
          </div>
        </div>
      </header>
      <div className="flex-1 overflow-y-auto p-8">
        <div className="mx-auto max-w-5xl space-y-5">
          {/* Match summary cards */}
          <section className="grid grid-cols-3 gap-3">
            <Card label="Invoice 810" value={invoice.invoiceNum} sub={`${invoice.lineCount} lines · ${num(invoice.totalQty)} units`} tone="bg-blue-50" />
            <Card label="ASN 856" value={asn?.asnNum ?? 'MISSING'} sub={asn ? `${asn.cartonCount} cartons · ${num(asn.totalQty)} units · ship ${asn.shipDate ?? '—'}` : 'No ASN linked — pay-on-invoice flow'} tone={asn ? 'bg-violet-50' : 'bg-red-50'} />
            <Card label="PO 850" value={po?.poNum ?? 'MISSING'} sub={po ? `${po.lineCount} lines · ${num(po.totalQty)} units · ${usd(po.totalAmt)}` : 'DSD invoice — no inbound PO'} tone={po ? 'bg-sky-50' : 'bg-slate-50'} />
          </section>

          {match?.exceptionNote && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"><span className="font-medium">Match note:</span> {match.exceptionNote}</div>
          )}

          {/* Line-by-line comparison */}
          <section className="fd-card overflow-hidden">
            <div className="border-b border-slate-100 p-4"><h3 className="fd-section-title">Line-level comparison (keyed by UPC)</h3></div>
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-left text-slate-500">
                <tr>
                  <th className="px-3 py-2">UPC / Description</th>
                  <th className="px-3 py-2 text-right">Inv qty</th>
                  <th className="px-3 py-2 text-right">ASN qty</th>
                  <th className="px-3 py-2 text-right">PO qty</th>
                  <th className="px-3 py-2 text-right">Inv unit</th>
                  <th className="px-3 py-2 text-right">PO unit</th>
                  <th className="px-3 py-2 text-right">Inv ext</th>
                  <th className="px-3 py-2">Issue</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {[...byUpc.entries()].map(([upc, row]) => {
                  const il: any = row.invoice; const pl: any = (row as any).po; const an: any = (row as any).asn;
                  const issues: string[] = [];
                  if (il && pl && Math.abs((il.unitPrice ?? 0) - (pl.unitPrice ?? 0)) > 0.005) issues.push(`price Δ $${((il.unitPrice ?? 0) - (pl.unitPrice ?? 0)).toFixed(2)}`);
                  if (il && pl && il.qty !== pl.qty) issues.push(`qty Δ ${il.qty - pl.qty}`);
                  if (il && an && il.qty !== an.qty) issues.push(`vs ASN ${il.qty - an.qty}`);
                  if (il && !pl && po) issues.push('not on PO');
                  if (il && !an && asn) issues.push('not on ASN');
                  return (
                    <tr key={upc} className={issues.length ? 'bg-amber-50/40' : ''}>
                      <td className="px-3 py-1.5"><span className="block text-slate-700">{il?.description ?? pl?.description ?? '—'}</span><span className="font-mono text-[10px] text-slate-400">{upc}</span></td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{num(il?.qty)}</td>
                      <td className={`px-3 py-1.5 text-right tabular-nums ${an && il && an.qty !== il.qty ? 'text-amber-700' : 'text-slate-500'}`}>{num(an?.qty)}</td>
                      <td className={`px-3 py-1.5 text-right tabular-nums ${pl && il && pl.qty !== il.qty ? 'text-amber-700' : 'text-slate-500'}`}>{num(pl?.qty)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{usd(il?.unitPrice)}</td>
                      <td className={`px-3 py-1.5 text-right tabular-nums ${pl && il && Math.abs(pl.unitPrice - il.unitPrice) > 0.005 ? 'text-amber-700' : 'text-slate-500'}`}>{usd(pl?.unitPrice)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{usd(il?.amount)}</td>
                      <td className="px-3 py-1.5 text-xs text-amber-700">{issues.length === 0 ? <span className="text-emerald-700">✓</span> : issues.join(' · ')}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>

          {/* AI: propose a shipment when nothing was linked deterministically */}
          {!asn && !po && <AiFuzzyMatchPanel invoiceNum={invoice.invoiceNum} />}

          {/* AI: line-level alignment against whichever document is linked */}
          {(asn || po) && <AiAlignPanel invoiceNum={invoice.invoiceNum} counterpartId={asn?.asnNum ?? po?.poNum} />}

          <section className="fd-card p-5">
            <h3 className="fd-section-title mb-2">Source EDI</h3>
            <ul className="text-xs text-slate-500 space-y-0.5">
              <li>Invoice from <span className="font-mono">{invoice.srcFile}</span> · core <span className="font-mono">{invoice.invoiceCore}</span> · terms Net {invoice.paymentTermsDays ?? '—'}</li>
              {asn && <li>ASN from <span className="font-mono">{asn.srcFile}</span> · BOL {(asn as any).bolNumber ?? '—'} · ship {asn.shipDate ?? '—'} → delivery {asn.deliveryDate ?? '—'}</li>}
              {po && <li>PO from <span className="font-mono">{po.srcFile}</span> · vendor {po.vendorId}</li>}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}

function Card({ label, value, sub, tone }: { label: string; value: string; sub: string; tone: string }) {
  return (
    <div className={`rounded-xl border border-slate-200 p-4 ${tone}`}>
      <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 truncate font-mono text-base font-semibold text-slate-800">{value}</div>
      <div className="mt-0.5 text-[11px] text-slate-500">{sub}</div>
    </div>
  );
}
