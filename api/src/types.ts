// EDI domain — mirrors pkg_edi_match.sql Section 3 staging+result tables.
// 'DC' = warehouse / cross-dock supply (PO-driven, 3-way capable).
// 'DSD' = direct store delivery (vendor → store, often no inbound PO).

export type Flow = 'DC' | 'DSD' | 'UNK';

export interface Vendor {
  vendorId: string;
  vendorName: string;
  flow: Flow;
}

// 850 — Purchase Order
export interface POLine {
  lineNo: number;
  upc: string;
  description: string;
  qty: number;
  uom: string;
  unitPrice: number;
}
export interface PurchaseOrder {
  poNum: string;
  vendorId: string;
  vendorName: string;
  storeOrDc: string;
  flow: Flow;
  poDate: string | null;
  totalQty: number;
  totalAmt: number;
  lineCount: number;
  lines: POLine[];
  srcFile: string;
}

// 856 — Advance Ship Notice
export interface ASNLine { upc: string; qty: number; uom: string; sscc?: string; }
export interface ASNPack { sscc: string; items: ASNLine[]; }
export interface AdvanceShipNotice {
  asnNum: string;
  refInvoiceNum: string;     // REF*IV — DSD invoices link back via this
  vendorId: string;
  storeOrDc: string;
  poNum: string | null;
  flow: Flow;
  shipDate: string | null;
  deliveryDate: string | null;
  cartonCount: number;
  totalQty: number;
  lineCount: number;
  packs: ASNPack[];
  bolNumber?: string;
  srcFile: string;
}

// 810 — Invoice
export interface InvoiceLine {
  lineNo: number;
  upc: string;
  description: string;
  qty: number;
  uom: string;
  unitPrice: number;
  amount: number;
}
export interface Invoice {
  invoiceNum: string;
  invoiceCore: string;       // PepsiCo: 10-char core without YYMMDD suffix
  vendorId: string;
  vendorName: string;
  storeOrDc: string;
  poNum: string | null;
  flow: Flow;
  invoiceDate: string | null;
  paymentTermsDays: number | null;
  grossAmt: number;
  netAmt: number;
  totalQty: number;
  lineCount: number;
  lines: InvoiceLine[];
  srcFile: string;
}

// ---- match result + exception (mirrors SQL Section 3) ------------------
export type MatchStatus = '3WAY' | '2WAY' | 'QTY_VAR' | 'AMT_VAR' | 'INV_NO_ASN' | 'ASN_NO_INV' | 'PO_NO_RCPT';
export type Severity = 'HIGH' | 'MED' | 'LOW';
export type ExceptionStatus = 'OPEN' | 'ASSIGNED' | 'RESOLVED' | 'WRITTEN_OFF';

export interface MatchResult {
  matchId: number;
  flow: Flow;
  vendorId: string;
  storeOrDc: string;
  poNum: string | null;
  asnNum: string | null;
  invoiceNum: string | null;
  invoiceCore: string | null;
  poQty: number | null;
  asnQty: number | null;
  invQty: number | null;
  poAmt: number | null;
  invAmtGross: number | null;
  invAmtNet: number | null;
  qtyVarAsnInv: number | null;
  qtyVarPoAsn: number | null;
  amtVarPoInv: number | null;
  matchStatus: MatchStatus;
  matchScore: number;       // 0-100
  asnLines: number | null;
  invLines: number | null;
  exceptionNote: string | null;
  shipDate: string | null;
  invoiceDate: string | null;
  matchedAt: string;
  runId: number;
}

export interface MatchException {
  excId: number;
  matchId: number;
  flow: Flow;
  vendorId: string;
  storeOrDc: string;
  poNum: string | null;
  asnNum: string | null;
  invoiceNum: string | null;
  excType: MatchStatus;     // mirrors match_status non-3WAY
  severity: Severity;
  excAmount: number;
  recommendedAction: string;
  status: ExceptionStatus;
  assignedTo: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
  createdAt: string;
  ageDays: number;
}

export interface RunLog {
  runId: number;
  runType: 'DSD' | 'DC' | 'FULL';
  startedAt: string;
  endedAt: string | null;
  posProcessed: number;
  asnsProcessed: number;
  invsProcessed: number;
  matchesCreated: number;
  exceptionsOpen: number;
  status: 'RUNNING' | 'OK' | 'ERROR';
  errorMsg: string | null;
}
