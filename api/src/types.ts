// Shared domain types for the Invoice Matching POC.

export interface Vendor {
  vendorId: number;
  vendorName: string;
  contact?: string;
  taxId?: string;
  paymentTermsDays?: number;
}

export interface POLine {
  lineNo: number;
  sku: number;
  description: string;
  qty: number;
  unitCost: number;
}
export interface PurchaseOrder {
  poId: number;
  poNumber: string;
  vendorId: number;
  vendorName: string;
  orderDate: string;
  expectedDeliveryDate: string;
  status: 'OPEN' | 'PARTIAL' | 'CLOSED' | 'CANCELLED';
  lines: POLine[];
  totalUsd: number;
}

export interface GRLine { lineNo: number; sku: number; qtyReceived: number; }
export interface GoodsReceipt {
  grId: number;
  grNumber: string;
  poId: number;
  receivedDate: string;
  lines: GRLine[];
}

export interface InvoiceLine {
  lineNo: number;
  sku: number;
  description: string;
  qty: number;
  unitPrice: number;
  amount: number;
}
export type InvoiceStatus =
  | 'PENDING_MATCH'       // newly arrived, no match attempt yet
  | 'MATCHED'             // 2-way or 3-way clean within tolerance
  | 'EXCEPTION'           // discrepancies present, needs review
  | 'APPROVED'            // exceptions resolved / accepted
  | 'REJECTED'            // returned to vendor
  | 'PAID';               // booked for payment
export interface Invoice {
  invoiceId: number;
  invoiceNumber: string;
  vendorId: number;
  vendorName: string;
  poNumber: string | null;   // declared on invoice; may be wrong/missing
  invoiceDate: string;
  receivedDate: string;
  dueDate: string;
  totalUsd: number;
  status: InvoiceStatus;
  lines: InvoiceLine[];
  notes?: string | null;
}

// ---- match result ----
export type DiscrepancyKind =
  | 'PRICE_DIFF' | 'QTY_OVER' | 'QTY_UNDER' | 'NOT_RECEIVED' | 'PARTIAL_RECEIPT'
  | 'SKU_NOT_ON_PO' | 'VENDOR_MISMATCH' | 'PO_NOT_FOUND' | 'AMOUNT_DIFF';
export interface LineMatch {
  invoiceLineNo: number;
  sku: number;
  description: string;
  poLineNo: number | null;
  grLineNo: number | null;
  invoiceQty: number; invoiceUnitPrice: number; invoiceAmount: number;
  poQty: number | null; poUnitCost: number | null; poAmount: number | null;
  grQtyReceived: number | null;
  discrepancies: { kind: DiscrepancyKind; message: string; dollarImpact: number }[];
}
export interface MatchResult {
  invoiceId: number;
  invoiceNumber: string;
  poId: number | null;
  poNumber: string | null;
  grId: number | null;
  vendorOk: boolean;
  totalsOk: boolean;
  mode: 'TWO_WAY' | 'THREE_WAY';
  cleanLines: number;
  exceptionLines: number;
  totalDollarImpact: number;       // sum of |dollarImpact|
  computedStatus: InvoiceStatus;
  lines: LineMatch[];
  topDiscrepancyKinds: DiscrepancyKind[];
  matchedAt: string;
}
