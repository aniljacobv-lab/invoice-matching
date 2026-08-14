import type {
  PurchaseOrder, AdvanceShipNotice, Invoice, MatchResult, MatchException,
  Vendor, Severity, MatchStatus, Flow,
} from '../types.js';

// ─────────────────────────────────────────────────────────────────────────────
// 3-way match engine. Port of pkg_edi_match.match_dsd + match_dc + refresh_exceptions.
//
// DSD flow (PepsiCo direct-store delivery):
//   ASN.refInvoiceNum  ==  Invoice.invoiceCore   (paired on vendor + store)
//   No inbound 850 — the carton is the order.
//   Variances are line-level qty diffs.
//
// DC flow (Quaker through FD DC):
//   PO.poNum  ==  ASN.poNum  ==  Invoice.poNum
//   3-way match on qty + $.
//
// Anything that doesn't fit becomes an exception in the same status enum the
// SQL uses: INV_NO_ASN, ASN_NO_INV, QTY_VAR, AMT_VAR, PO_NO_RCPT.
// ─────────────────────────────────────────────────────────────────────────────

export interface MatchInput {
  pos: PurchaseOrder[];
  asns: AdvanceShipNotice[];
  invoices: Invoice[];
  vendors: Vendor[];
}
export interface MatchOutput {
  results: MatchResult[];
  exceptions: MatchException[];
  posProcessed: number;
  asnsProcessed: number;
  invsProcessed: number;
  durationMs: number;
}

const AMT_TOL = 0.01;
const now = () => new Date().toISOString();

export function runFullMatch(input: MatchInput): MatchOutput {
  const start = Date.now();
  let matchIdSeq = 1, excIdSeq = 1;
  const results: MatchResult[] = [];
  const exceptions: MatchException[] = [];

  // index ASNs by (vendor, store, invoice-key)  +  (vendor, poNum) for DC flow
  const asnByInvKey = new Map<string, AdvanceShipNotice[]>();
  const asnByPo     = new Map<string, AdvanceShipNotice[]>();
  for (const a of input.asns) {
    const k1 = key(a.vendorId, a.storeOrDc, a.refInvoiceNum || a.asnNum);
    push(asnByInvKey, k1, a);
    if (a.poNum) push(asnByPo, key(a.vendorId, a.poNum), a);
  }
  const invByCore = new Map<string, Invoice[]>();
  const invByPo   = new Map<string, Invoice[]>();
  for (const i of input.invoices) {
    push(invByCore, key(i.vendorId, i.storeOrDc, i.invoiceCore), i);
    if (i.poNum) push(invByPo, key(i.vendorId, i.poNum), i);
  }

  const seenInv = new Set<string>();
  const seenAsn = new Set<string>();
  const seenPo  = new Set<string>();

  // ── DSD pass: ASN ↔ Invoice (no PO) ──────────────────────────────────────
  for (const a of input.asns.filter((x) => x.flow === 'DSD' || x.flow === 'UNK')) {
    const k = key(a.vendorId, a.storeOrDc, a.refInvoiceNum || a.asnNum);
    const invs = invByCore.get(k) ?? [];
    if (invs.length === 0) {
      // ASN with no invoice
      const m = mkResult({
        matchIdSeq: matchIdSeq++, flow: 'DSD', vendorId: a.vendorId, storeOrDc: a.storeOrDc,
        asnNum: a.asnNum, asnQty: a.totalQty, asnLines: a.lineCount,
        shipDate: a.shipDate, status: 'ASN_NO_INV',
        exceptionNote: 'ASN delivered, awaiting invoice',
      });
      results.push(m); seenAsn.add(a.asnNum);
    } else {
      for (const i of invs) {
        const qtyVar = (i.totalQty ?? 0) - (a.totalQty ?? 0);
        const status: MatchStatus = a.totalQty === i.totalQty ? '2WAY' : 'QTY_VAR';
        results.push(mkResult({
          matchIdSeq: matchIdSeq++, flow: 'DSD', vendorId: a.vendorId, storeOrDc: a.storeOrDc,
          asnNum: a.asnNum, invoiceNum: i.invoiceNum, invoiceCore: i.invoiceCore,
          asnQty: a.totalQty, invQty: i.totalQty, qtyVarAsnInv: qtyVar,
          asnLines: a.lineCount, invLines: i.lineCount,
          invAmtGross: i.invoiceAmt, invAmtNet: i.invoiceAmt,
          shipDate: a.shipDate, invoiceDate: i.invoiceDate, status,
          matchScore: status === '2WAY' ? 100 : Math.max(0, 100 - Math.round(Math.abs(qtyVar) / Math.max(1, a.totalQty) * 100)),
          exceptionNote: status === 'QTY_VAR' ? `ASN qty ${a.totalQty} vs Invoice qty ${i.totalQty} (Δ ${qtyVar})` : null,
        }));
        seenAsn.add(a.asnNum); seenInv.add(i.invoiceNum);
      }
    }
  }

  // ── DSD pass: orphan invoices (no ASN) ───────────────────────────────────
  for (const i of input.invoices.filter((x) => x.flow === 'DSD' || x.flow === 'UNK')) {
    if (seenInv.has(i.invoiceNum)) continue;
    // A credit memo reverses an earlier invoice. There was never a shipment, so
    // there is no ASN to find and flagging it INV_NO_ASN is a false positive.
    // 566 of the 1,862 sample documents are credit memos — roughly a third of the
    // entire exception queue was this single misclassification.
    const isCredit = i.docType === 'CREDIT';
    results.push(mkResult({
      matchIdSeq: matchIdSeq++, flow: 'DSD', vendorId: i.vendorId, storeOrDc: i.storeOrDc,
      invoiceNum: i.invoiceNum, invoiceCore: i.invoiceCore,
      invQty: i.totalQty, invLines: i.lineCount,
      invAmtGross: i.invoiceAmt, invAmtNet: i.invoiceAmt,
      invoiceDate: i.invoiceDate,
      status: isCredit ? 'CREDIT_MEMO' : 'INV_NO_ASN',
      matchScore: isCredit ? 100 : 0,
      exceptionNote: isCredit
        ? `Credit memo${i.originalInvoiceNum ? ` reversing invoice ${i.originalInvoiceNum}` : ''} — no ASN expected`
        : 'Invoice received with no ASN — pay-on-invoice exception',
    }));
    seenInv.add(i.invoiceNum);
  }

  // ── DC pass: PO ↔ ASN ↔ Invoice ─────────────────────────────────────────
  for (const p of input.pos.filter((x) => x.flow === 'DC')) {
    const ak = key(p.vendorId, p.poNum);
    const a = (asnByPo.get(ak) ?? [])[0] ?? null;
    const i = (invByPo.get(ak) ?? [])[0] ?? null;
    let status: MatchStatus;
    let note: string | null = null;
    let score = 100;
    if (!a && !i) { status = 'PO_NO_RCPT'; note = 'PO sent, no ASN/invoice yet'; score = 0; }
    else if (!a) { status = 'INV_NO_ASN'; note = 'Invoice without ASN'; score = 0; }
    else if (!i) { status = 'ASN_NO_INV'; note = 'ASN without invoice'; score = 0; }
    else {
      const qtyClean = (p.totalQty === (a.totalQty ?? 0)) && (a.totalQty === (i.totalQty ?? 0));
      const amtClean = Math.abs(p.totalAmt - i.invoiceAmt) < AMT_TOL;
      if (qtyClean && amtClean) { status = '3WAY'; }
      else if (!qtyClean) { status = 'QTY_VAR'; note = `PO qty ${p.totalQty} / ASN ${a.totalQty} / Inv ${i.totalQty}`; score = Math.max(0, 100 - Math.round(Math.abs(p.totalQty - i.totalQty) / Math.max(1, p.totalQty) * 50)); }
      else { status = 'AMT_VAR'; note = `$ variance $${(i.invoiceAmt - p.totalAmt).toFixed(2)}`; score = Math.max(0, 100 - Math.round(Math.abs(p.totalAmt - i.invoiceAmt) / Math.max(1, p.totalAmt) * 50)); }
    }
    results.push(mkResult({
      matchIdSeq: matchIdSeq++, flow: 'DC', vendorId: p.vendorId, storeOrDc: p.storeOrDc,
      poNum: p.poNum, asnNum: a?.asnNum ?? null, invoiceNum: i?.invoiceNum ?? null, invoiceCore: i?.invoiceCore ?? null,
      poQty: p.totalQty, asnQty: a?.totalQty ?? null, invQty: i?.totalQty ?? null,
      poAmt: p.totalAmt, invAmtGross: i?.invoiceAmt ?? null, invAmtNet: i?.invoiceAmt ?? null,
      qtyVarAsnInv: i && a ? (i.totalQty - a.totalQty) : null,
      qtyVarPoAsn: a ? (a.totalQty - p.totalQty) : null,
      amtVarPoInv: i ? (i.invoiceAmt - p.totalAmt) : null,
      asnLines: a?.lineCount ?? null, invLines: i?.lineCount ?? null,
      shipDate: a?.shipDate ?? null, invoiceDate: i?.invoiceDate ?? null,
      status, matchScore: score, exceptionNote: note,
    }));
    seenPo.add(p.poNum);
  }

  // ── Refresh exceptions ───────────────────────────────────────────────────
  for (const r of results) {
    if (r.matchStatus === '3WAY' || r.matchStatus === '2WAY' || r.matchStatus === 'CREDIT_MEMO') continue;
    const severity = severityOf(r.matchStatus);
    const action   = recommendedAction(r.matchStatus);
    const amount   = Math.abs(r.invAmtGross ?? r.poAmt ?? 0);
    exceptions.push({
      excId: excIdSeq++, matchId: r.matchId, flow: r.flow,
      vendorId: r.vendorId, storeOrDc: r.storeOrDc,
      poNum: r.poNum, asnNum: r.asnNum, invoiceNum: r.invoiceNum,
      excType: r.matchStatus, severity, excAmount: amount,
      recommendedAction: action,
      status: 'OPEN', assignedTo: null, resolvedAt: null, resolvedBy: null,
      resolutionNote: null, createdAt: r.matchedAt, ageDays: 0,
    });
  }

  return {
    results, exceptions,
    posProcessed: input.pos.length, asnsProcessed: input.asns.length, invsProcessed: input.invoices.length,
    durationMs: Date.now() - start,
  };
}

function severityOf(s: MatchStatus): Severity {
  if (s === 'CREDIT_MEMO') return 'LOW';
  if (s === 'QTY_VAR' || s === 'AMT_VAR' || s === 'INV_NO_ASN') return 'HIGH';
  if (s === 'ASN_NO_INV') return 'MED';
  if (s === 'PO_NO_RCPT') return 'LOW';
  return 'MED';
}
function recommendedAction(s: MatchStatus): string {
  switch (s) {
    case 'QTY_VAR':    return 'Issue debit memo for shorted qty / vendor credit for over-ship';
    case 'AMT_VAR':    return 'Reconcile invoice price against PO contract; issue price-protect claim';
    case 'INV_NO_ASN': return 'Request ASN from vendor; pay-on-invoice until 3-way enabled';
    case 'ASN_NO_INV': return 'Hold receipt; await invoice; flag if >5 days from ship date';
    case 'PO_NO_RCPT': return 'Confirm shipment; expedite ASN if past start-ship date';
    case 'CREDIT_MEMO': return 'Apply credit against the referenced invoice; no ASN required';
    default:           return 'Review with AP';
  }
}

interface ResultIn {
  matchIdSeq: number; flow: Flow; vendorId: string; storeOrDc: string;
  poNum?: string | null; asnNum?: string | null; invoiceNum?: string | null; invoiceCore?: string | null;
  poQty?: number | null; asnQty?: number | null; invQty?: number | null;
  poAmt?: number | null; invAmtGross?: number | null; invAmtNet?: number | null;
  qtyVarAsnInv?: number | null; qtyVarPoAsn?: number | null; amtVarPoInv?: number | null;
  asnLines?: number | null; invLines?: number | null;
  shipDate?: string | null; invoiceDate?: string | null;
  status: MatchStatus; matchScore?: number; exceptionNote?: string | null;
}
function mkResult(i: ResultIn): MatchResult {
  return {
    matchId: i.matchIdSeq, flow: i.flow, vendorId: i.vendorId, storeOrDc: i.storeOrDc,
    poNum: i.poNum ?? null, asnNum: i.asnNum ?? null, invoiceNum: i.invoiceNum ?? null, invoiceCore: i.invoiceCore ?? null,
    poQty: i.poQty ?? null, asnQty: i.asnQty ?? null, invQty: i.invQty ?? null,
    poAmt: i.poAmt ?? null, invAmtGross: i.invAmtGross ?? null, invAmtNet: i.invAmtNet ?? null,
    qtyVarAsnInv: i.qtyVarAsnInv ?? null, qtyVarPoAsn: i.qtyVarPoAsn ?? null, amtVarPoInv: i.amtVarPoInv ?? null,
    matchStatus: i.status, matchScore: i.matchScore ?? (i.status === '3WAY' || i.status === '2WAY' ? 100 : 0),
    asnLines: i.asnLines ?? null, invLines: i.invLines ?? null,
    exceptionNote: i.exceptionNote ?? null,
    shipDate: i.shipDate ?? null, invoiceDate: i.invoiceDate ?? null,
    matchedAt: now(), runId: 0,
  };
}
function key(...parts: (string | null | undefined)[]): string { return parts.map((p) => p ?? '').join('|'); }
function push<K, V>(m: Map<K, V[]>, k: K, v: V) { const a = m.get(k); if (a) a.push(v); else m.set(k, [v]); }
