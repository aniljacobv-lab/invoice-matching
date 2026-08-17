// Thin fetch wrapper. Talks to the API at /api/* (Vite proxies dev → :3001).

export type MatchStatus = '3WAY' | '2WAY' | 'QTY_VAR' | 'AMT_VAR' | 'INV_NO_ASN' | 'ASN_NO_INV' | 'PO_NO_RCPT' | 'CREDIT_MEMO';
export type Severity = 'HIGH' | 'MED' | 'LOW';
export type ExceptionStatus = 'OPEN' | 'ASSIGNED' | 'RESOLVED' | 'WRITTEN_OFF';
export type Flow = 'DC' | 'DSD' | 'UNK';

export interface SummaryKpis {
  pos_sent: number; asns_received: number; invs_received: number;
  cartons: number; po_lines: number; asn_lines: number; inv_lines: number;
  po_amt: number; inv_gross: number; inv_net: number;
  match_rate: number; exceptions_open: number;
  credit_memos: number; credit_amt: number; unreconciled: number;
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

export interface InvoiceLine { lineNo: number; upc: string; upcNorm: string; description: string; qty: number; uom: string; unitPrice: number; amount: number; }
export type DocType = 'INVOICE' | 'CREDIT';
export interface Invoice {
  invoiceNum: string; invoiceCore: string; docType: DocType; originalInvoiceNum: string | null;
  vendorId: string; vendorName: string;
  storeOrDc: string; poNum: string | null; flow: Flow;
  invoiceDate: string | null; paymentTermsDays: number | null;
  invoiceAmt: number; amountBasis: 'SAC_LINES' | 'IT1_PRICE' | 'HEADER_ONLY';
  reconciled: boolean; lineExtSum: number;
  grossAmt: number; netAmt: number; totalQty: number; lineCount: number;
  lines: InvoiceLine[]; srcFile: string;
}

export interface POLine { lineNo: number; upc: string; upcNorm: string; vendorSku: string; description: string; qty: number; uom: string; unitPrice: number; }
export interface PurchaseOrder { poNum: string; vendorId: string; vendorName: string; storeOrDc: string; flow: Flow; poDate: string | null; totalQty: number; totalAmt: number; lineCount: number; lines: POLine[]; srcFile: string; }

export interface ASNItem { upc: string; upcNorm: string; qty: number; uom: string; }
export interface ASNPack { sscc: string; items: ASNItem[]; }
export interface AdvanceShipNotice { asnNum: string; refInvoiceNum: string; vendorId: string; storeOrDc: string; poNum: string | null; flow: Flow; shipDate: string | null; deliveryDate: string | null; cartonCount: number; totalQty: number; lineCount: number; packs: ASNPack[]; srcFile: string; }

export interface MatchResult { matchId: number; flow: Flow; vendorId: string; storeOrDc: string; poNum: string | null; asnNum: string | null; invoiceNum: string | null; matchStatus: MatchStatus; matchScore: number; exceptionNote: string | null; matchedAt: string; }


// ─── AI layer ────────────────────────────────────────────────────────────────
// Every AI endpoint may answer { available: false, reason } when no API key is
// configured. Callers must handle that shape rather than assuming a payload.

export type Platform = 'anthropic' | 'bedrock' | 'vertex' | 'openai' | 'azure-openai' | 'google';

export interface PlatformStatus { platform: Platform; available: boolean; reason?: string; }
export interface RouteStatus { capability: string; chain: string[]; usable: boolean; }

export interface AiStatus {
  available: boolean;
  /** "platform:model" serving the default capability. */
  model: string;
  reason?: string;
  platforms?: PlatformStatus[];
  routes?: RouteStatus[];
  usage?: {
    calls: number; inputTokens: number; outputTokens: number;
    cacheHits: number; errors: number; failovers: number;
    byPlatform?: Record<string, { calls: number; inputTokens: number; outputTokens: number; errors: number; failovers: number }>;
  };
  cache?: { entries: number; ttlMinutes: number };
  settings?: { maxCandidates: number; minConfidence: number; maxTokens: number };
  capabilities?: string[];
}

export interface CandidateEvidence {
  id: string; kind: 'ASN' | 'PO'; vendorId: string; store: string;
  refInvoiceNum?: string; date: string | null; qty: number;
  amount: number | null; lineCount: number; prescreen: number; signals: string[];
}
export interface FuzzyProposal {
  candidateId: string; confidence: number; verdict: 'MATCH' | 'LIKELY' | 'NO_MATCH';
  reason: string; discrepancies: string[]; suggestedAction: string;
}
export interface FuzzyMatchResponse {
  available: boolean; reason?: string;
  invoiceNum?: string; candidates?: CandidateEvidence[];
  proposals?: FuzzyProposal[]; best?: FuzzyProposal | null;
  aiUsed?: boolean; note?: string;
}

export interface TriagedException {
  excId: number; priority: number; rootCause: string; nextAction: string;
  estRecoveryUsd: number | null; confidence: number; tags: string[];
}
export interface TriageTheme { theme: string; excIds: number[]; impactUsd: number; recommendation: string; }
export interface TriageResponse {
  available: boolean; reason?: string;
  queueSize?: number; triaged?: TriagedException[]; themes?: TriageTheme[];
}

export interface NlQueryResponse {
  available: boolean; reason?: string;
  question?: string; interpretation?: string; filter?: Record<string, unknown>;
  rowCount?: number; totalAmount?: number; rows?: Record<string, unknown>[];
  answer?: string; caveats?: string[];
}

export interface AlignedLine {
  invoiceLineNo: number | null; counterpartRef: string | null; description: string;
  invoiceQty: number | null; counterpartQty: number | null; qtyVariance: number | null;
  amount: number | null; method: 'UPC' | 'AI_DESCRIPTION' | 'UNMATCHED';
  confidence: number; note?: string;
}
export interface AlignResponse {
  available: boolean; reason?: string; error?: string; message?: string;
  invoiceNum?: string; counterpartId?: string; counterpartKind?: 'ASN' | 'PO';
  lines?: AlignedLine[];
  summary?: {
    total: number; byUpc: number; byAi: number; unmatched: number;
    shortShipped: number; overShipped: number; netQtyVariance: number; varianceUsd: number;
  };
  aiUsed?: boolean;
}

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

  // ── AI ──
  aiStatus: () => req<AiStatus>('/ai/status'),
  aiCandidates: (invoiceNum: string) =>
    req<{ invoiceNum: string; candidates: CandidateEvidence[]; note: string }>(`/ai/candidates/${encodeURIComponent(invoiceNum)}`),
  aiFuzzyMatch: (invoiceNum: string) =>
    req<FuzzyMatchResponse>(`/ai/fuzzy-match/${encodeURIComponent(invoiceNum)}`, { method: 'POST' }),
  aiTriage: (params: { limit?: number; vendor?: string; severity?: string } = {}) =>
    req<TriageResponse>('/ai/triage', { method: 'POST', body: JSON.stringify(params) }),
  aiQuery: (question: string) =>
    req<NlQueryResponse>('/ai/query', { method: 'POST', body: JSON.stringify({ question }) }),
  aiAlign: (invoiceNum: string, counterpart?: string) =>
    req<AlignResponse>(`/ai/align/${encodeURIComponent(invoiceNum)}${counterpart ? `?counterpart=${encodeURIComponent(counterpart)}` : ''}`, { method: 'POST' }),
};
