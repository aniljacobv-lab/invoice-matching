import { useEffect, useMemo, useState } from 'react';
import { api, type Invoice, type InvoiceStatus } from '../lib/api';

interface Props { onOpen: (id: number) => void; }
const STATUS_STYLE: Record<InvoiceStatus, string> = {
  PENDING_MATCH: 'bg-slate-100 text-slate-600',
  MATCHED: 'bg-green-50 text-green-700', EXCEPTION: 'bg-amber-50 text-amber-700',
  APPROVED: 'bg-blue-50 text-blue-700', REJECTED: 'bg-red-50 text-red-700', PAID: 'bg-slate-200 text-slate-700',
};
const usd = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function InvoiceListPage({ onOpen }: Props) {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'ALL' | InvoiceStatus>('ALL');
  const [loading, setLoading] = useState(true);
  useEffect(() => { setLoading(true); api.listInvoices().then(setInvoices).finally(() => setLoading(false)); }, []);

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    return invoices.filter((i) => {
      if (filter !== 'ALL' && i.status !== filter) return false;
      if (!s) return true;
      return i.invoiceNumber.toLowerCase().includes(s) || i.vendorName.toLowerCase().includes(s) || (i.poNumber ?? '').toLowerCase().includes(s);
    });
  }, [invoices, search, filter]);

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-slate-200 bg-white px-8 py-5">
        <h2 className="text-xl font-semibold text-slate-900">Invoices</h2>
        <p className="mt-0.5 text-sm text-slate-500">All received invoices. Click any row to see line-level matching detail.</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input className="fd-input w-80" placeholder="Search by invoice #, vendor, or PO…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <select className="fd-input w-48" value={filter} onChange={(e) => setFilter(e.target.value as any)}>
            <option value="ALL">All statuses</option>
            <option value="PENDING_MATCH">Pending match</option>
            <option value="EXCEPTION">Exception</option>
            <option value="MATCHED">Matched</option>
            <option value="APPROVED">Approved</option>
            <option value="REJECTED">Rejected</option>
            <option value="PAID">Paid</option>
          </select>
          <span className="ml-auto text-xs text-slate-400">{filtered.length} of {invoices.length}</span>
        </div>
      </header>
      <div className="flex-1 overflow-y-auto p-8">
        {loading ? <p className="text-sm text-slate-400">Loading…</p> : (
          <div className="mx-auto max-w-6xl">
            <div className="fd-card overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs text-slate-500">
                  <tr><th className="px-3 py-2">Invoice #</th><th className="px-3 py-2">Vendor</th><th className="px-3 py-2">PO</th><th className="px-3 py-2">Received</th><th className="px-3 py-2">Due</th><th className="px-3 py-2 text-right">Total</th><th className="px-3 py-2">Status</th></tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filtered.map((i) => (
                    <tr key={i.invoiceId} className="cursor-pointer hover:bg-slate-50/60" onClick={() => onOpen(i.invoiceId)}>
                      <td className="px-3 py-2 font-medium text-slate-700">{i.invoiceNumber}</td>
                      <td className="px-3 py-2 text-slate-500">{i.vendorName}</td>
                      <td className="px-3 py-2 text-slate-500">{i.poNumber ?? '—'}</td>
                      <td className="px-3 py-2 text-slate-500">{i.receivedDate}</td>
                      <td className="px-3 py-2 text-slate-500">{i.dueDate}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{usd(i.totalUsd)}</td>
                      <td className="px-3 py-2"><span className={`fd-pill ${STATUS_STYLE[i.status]}`}>{i.status}</span></td>
                    </tr>
                  ))}
                  {filtered.length === 0 && <tr><td colSpan={7} className="px-3 py-4 text-center text-xs text-slate-400">No invoices match.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
