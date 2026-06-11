// Thin fetch wrapper. Talks to the API at /api/* (Vite proxies dev → :3001).

export type MatchStatus = '3WAY' | '2WAY' | 'QTY_VAR' | 'AMT_VAR' | 'INV_NO_ASN' | 'ASN_NO_INV' | 'PO_NO_RCPT';
export type Severity = 'HIGH' | 'MED' | 'LOW';
export type ExceptionStatus = 'OPEN' | 'ASSIGNED' | 'RESOLVED' | 'WRITTEN_OFF';
export type Flow = 'DC' | 'DSD' | 'UNK';

export interface SummaryKpis {
  pos_sent: number; asns_received: number; invs_received: number;
  cartons: number; po_lines: number; asn_lines: number; inv_lines: number;
  po_amt: number; inv_gross: number; inv_net: number;
  match_rate: number; exceptions_open: number;
  last_run: string | null;
}
export interface StatusBreakdownEntry { code: MatchStatus; label: string; count: number; pct: number; }
export interface VendorRow {
  id: string; name: string; flow: Flow;
  pos: number; po_amt: number;
  asns: number; cartons: number;
  invs: number; gross: number; net: number;
  rate: number;
}
export interface FileProcessed { file: string; type: string; count: number; }
export interface SummaryResponse {
  summary: SummaryKpis;
  statuses: StatusBreakdownEntry[];
  vendors: VendorRow[];
  filesProcessed: FileProcessed[];
}

export interface ExceptionRow {
  exc_id: number; severity: Severity; exc_type: MatchStatus; flow: string;
  vendor_id: string; store: string; po_num: string; asn_num: string; invoice_num: string;
  exc_amount: number; recommended_action: string; age_days: number;
  status: ExceptionStatus; assigned_to: string | null; resolution_note: string | null;
}

export interface InvoiceLine { lineNo: number; upc: string; description: string; qty: number; uom: string; unitPrice: number; amount: number; }
export interface Invoice {
  invoiceNum: string; invoiceCore: string; vendorId: string; vendorName: string;
  storeOrDc: string; poNum: string | null; flow: Flow;
  invoiceDate: string | null; paymentTermsDays: number | null;
  grossAmt: number; netAmt: number; totalQty: number; lineCount: number;
  lines: InvoiceLine[]; srcFile: string;
}

export interface POLine { lineNo: number; upc: string; description: string; qty: number; uom: string; unitPrice: number; }
export interface PurchaseOrder { poNum: string; vendorId: string; vendorName: string; storeOrDc: string; flow: Flow; poDate: string | null; totalQty: number; totalAmt: number; lineCount: number; lines: POLine[]; srcFile: string; }

export interface ASNItem { upc: string; qty: number; uom: string; }
export interface ASNPack { sscc: string; items: ASNItem[]; }
export interface AdvanceShipNotice { asnNum: string; refInvoiceNum: string; vendorId: string; storeOrDc: string; poNum: string | null; flow: Flow; shipDate: string | null; deliveryDate: string | null; cartonCount: number; totalQty: number; lineCount: number; packs: ASNPack[]; srcFile: string; }

export interface MatchResult { matchId: number; flow: Flow; vendorId: string; storeOrDc: string; poNum: string | null; asnNum: string | null; invoiceNum: string | null; matchStatus: MatchStatus; matchScore: number; exceptionNote: string | null; matchedAt: string; }

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { 'X-User': 'anil@invoice-matching.local', ...((init?.headers as Record<string, string> | undefined) ?? {}) };
  if (init?.body != null) headers['Content-Type'] = 'application/json';
  const r = await fetch(`/api${path}`, { ...init, headers });
  if (!r.ok) { const text = await r.text(); throw new Error(`${r.status} ${r.statusText}: ${text}`); }
  return r.json() as Promise<T>;
}

export const api = {
  summary: () => req<SummaryResponse>('/match/v1/summary'),
  exceptions: (params: { vendor?: string; severity?: string; days?: number; status?: ExceptionStatus } = {}) => {
    const q = new URLSearchParams();
    if (params.vendor) q.set('vendor', params.vendor);
    if (params.severity && params.severity !== 'ALL') q.set('severity', params.severity);
    if (params.days != null) q.set('days', String(params.days));
    if (params.status) q.set('status', params.status);
    const s = q.toString();
    return req<{ exceptions: ExceptionRow[] }>(`/match/v1/exceptions${s ? `?${s}` : ''}`).then((r) => r.exceptions);
  },
  closeException: (excId: number, status: ExceptionStatus, note?: string) =>
    req(`/match/v1/exceptions/${excId}/close`, { method: 'POST', body: JSON.stringify({ status, note: note ?? null }) }),
  runFull: () => req('/match/v1/runs/full', { method: 'POST' }),
  invoiceDetail: (invoiceNum: string) =>
    req<{ invoice: Invoice; asn: AdvanceShipNotice | null; po: PurchaseOrder | null; match: MatchResult | null }>(`/match/v1/invoices/${encodeURIComponent(invoiceNum)}`),
};
