// Thin fetch wrapper. Talks to the API at /api/* (Vite proxies dev → :3001).

export type InvoiceStatus = 'PENDING_MATCH' | 'MATCHED' | 'EXCEPTION' | 'APPROVED' | 'REJECTED' | 'PAID';
export type DiscrepancyKind = 'PRICE_DIFF' | 'QTY_OVER' | 'QTY_UNDER' | 'NOT_RECEIVED' | 'PARTIAL_RECEIPT' | 'SKU_NOT_ON_PO' | 'VENDOR_MISMATCH' | 'PO_NOT_FOUND' | 'AMOUNT_DIFF';

export interface Vendor { vendorId: number; vendorName: string; contact?: string; taxId?: string; paymentTermsDays?: number; }
export interface POLine { lineNo: number; sku: number; description: string; qty: number; unitCost: number; }
export interface PurchaseOrder { poId: number; poNumber: string; vendorId: number; vendorName: string; orderDate: string; expectedDeliveryDate: string; status: string; lines: POLine[]; totalUsd: number; }
export interface GRLine { lineNo: number; sku: number; qtyReceived: number; }
export interface GoodsReceipt { grId: number; grNumber: string; poId: number; receivedDate: string; lines: GRLine[]; }
export interface InvoiceLine { lineNo: number; sku: number; description: string; qty: number; unitPrice: number; amount: number; }
export interface Invoice { invoiceId: number; invoiceNumber: string; vendorId: number; vendorName: string; poNumber: string | null; invoiceDate: string; receivedDate: string; dueDate: string; totalUsd: number; status: InvoiceStatus; lines: InvoiceLine[]; notes?: string | null; }
export interface LineMatch {
  invoiceLineNo: number; sku: number; description: string;
  poLineNo: number | null; grLineNo: number | null;
  invoiceQty: number; invoiceUnitPrice: number; invoiceAmount: number;
  poQty: number | null; poUnitCost: number | null; poAmount: number | null;
  grQtyReceived: number | null;
  discrepancies: { kind: DiscrepancyKind; message: string; dollarImpact: number }[];
}
export interface MatchResult {
  invoiceId: number; invoiceNumber: string;
  poId: number | null; poNumber: string | null; grId: number | null;
  vendorOk: boolean; totalsOk: boolean; mode: 'TWO_WAY' | 'THREE_WAY';
  cleanLines: number; exceptionLines: number; totalDollarImpact: number;
  computedStatus: InvoiceStatus; lines: LineMatch[]; topDiscrepancyKinds: DiscrepancyKind[]; matchedAt: string;
}
export interface Dashboard {
  totals: { invoices: number; dollarsAtRisk: number; dollarsPendingPay: number };
  statusCounts: Record<InvoiceStatus, number>;
  recent: { invoiceId: number; invoiceNumber: string; vendorName: string; poNumber: string | null; status: InvoiceStatus; totalUsd: number; receivedDate: string; exceptionImpact: number; exceptionLines: number; requiredTier: number }[];
  generatedAt: string;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { 'X-User': 'anil@invoice-matching.local', ...((init?.headers as Record<string, string> | undefined) ?? {}) };
  if (init?.body != null) headers['Content-Type'] = 'application/json';
  const r = await fetch(`/api${path}`, { ...init, headers });
  if (!r.ok) { const text = await r.text(); throw new Error(`${r.status} ${r.statusText}: ${text}`); }
  return r.json() as Promise<T>;
}

export const api = {
  dashboard: () => req<Dashboard>('/dashboard'),
  listInvoices: (status?: InvoiceStatus) => req<{ invoices: Invoice[] }>(status ? `/invoices?status=${status}` : '/invoices').then((r) => r.invoices),
  getInvoice: (id: number) => req<{ invoice: Invoice; match: MatchResult | null }>(`/invoices/${id}`),
  matchInvoice: (id: number) => req<{ match: MatchResult; requiredTier: number }>(`/invoices/${id}/match`, { method: 'POST' }),
  setInvoiceStatus: (id: number, status: InvoiceStatus, notes?: string | null) =>
    req<Invoice>(`/invoices/${id}/status`, { method: 'POST', body: JSON.stringify({ status, notes: notes ?? null }) }),
  matchAll: () => req<{ processed: number; matched: number; exceptions: number }>('/invoices/match-all', { method: 'POST' }),
  listVendors: () => req<{ vendors: Vendor[] }>('/vendors').then((r) => r.vendors),
  listPOs: () => req<{ pos: PurchaseOrder[] }>('/pos').then((r) => r.pos),
  getPO: (id: number) => req<{ po: PurchaseOrder; receipts: GoodsReceipt[] }>(`/pos/${id}`),
};
