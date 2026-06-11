import { useState } from 'react';
import { EdiMatchPage } from './pages/EdiMatchPage';
import { InvoiceDetailPage } from './pages/InvoiceDetailPage';

type View = { kind: 'home' } | { kind: 'invoice'; invoiceNum: string };

const InvoiceIcon = (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/></svg>);

export default function App() {
  const [view, setView] = useState<View>({ kind: 'home' });
  return (
    <div className="flex h-full" style={{ background: 'var(--app-bg)' }}>
      <aside className="flex w-60 shrink-0 flex-col border-r border-slate-200 bg-white">
        <div className="flex items-center gap-2.5 px-5 py-5">
          <span className="grid h-9 w-9 place-items-center rounded-lg text-sm font-bold text-white shadow-sm" style={{ background: 'var(--brand-primary)' }}>P360</span>
          <div className="leading-tight">
            <div className="text-sm font-semibold text-slate-800">Invoice Matching</div>
            <div className="text-[11px] text-slate-400">EDI 3-Way · AP Workbench</div>
          </div>
        </div>
        <nav className="flex-1 space-y-1 px-3">
          <button onClick={() => setView({ kind: 'home' })} className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition ${view.kind === 'home' ? 'bg-blue-50 text-blue-700' : 'text-slate-600 hover:bg-slate-50'}`}>
            <span className={view.kind === 'home' ? 'text-blue-700' : 'text-slate-400'}>{InvoiceIcon}</span>EDI Match
          </button>
        </nav>
        <div className="border-t border-slate-100 p-4 text-[11px] text-slate-400">
          <div>Family Dollar × PepsiCo · DSD + DC</div>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <main className="flex-1 overflow-hidden">
          {view.kind === 'home' && <EdiMatchPage onOpenInvoice={(invoiceNum) => setView({ kind: 'invoice', invoiceNum })} />}
          {view.kind === 'invoice' && <InvoiceDetailPage invoiceNum={view.invoiceNum} onClose={() => setView({ kind: 'home' })} />}
        </main>
      </div>
    </div>
  );
}
