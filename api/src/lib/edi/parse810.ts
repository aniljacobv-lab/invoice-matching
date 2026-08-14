// ─────────────────────────────────────────────────────────────────────────────
// X12 810 (Invoice) parser. Targets the PepsiCo dialect we have samples of.
//
//   BIG*<inv_date>*<invoice_num>*****<doc_type>***<orig_invoice_num>
//                                     ↑ DI = debit/invoice, CR = credit memo
//   REF*VR*<vendor_id>
//   N1*RI*<remit-to-name>*1*<vendor_id>
//   N1*ST*<store-name>*92*<store_num>
//   ITD*01*3*****30*****Net 30 Days    ← payment terms
//   IT1**<qty>*<uom>*<price>****UA*<upc>
//   PID*F****<description>
//   SAC*A*F800***<ext_cents>***<unit_dollars>
//   TDS*<tds01>*<tds02>**<tds04>
//   CTT*<line_count>
//
// ── Money in this dialect (verified against all 1,862 sample invoices) ───────
// There are TWO document shapes and they price lines differently:
//
//   A. SAC-priced (972 docs). Each IT1 is followed by SAC*A*F800 where element 5
//      is the extended line amount in CENTS and element 8 is the unit price in
//      DOLLARS. IT1[4] is NOT the price here (it reads 70 / 45 / 30 against real
//      unit prices of $37.17 / $32.85 / $15.04) — it is some other basis and is
//      preserved as `unitPriceRaw` rather than trusted.
//      TDS04 == sum(SAC[5]) in 1862/1862 documents, so TDS04 is authoritative.
//
//   B. IT1-priced (890 docs, 566 of them credit memos). No SAC lines at all.
//      IT1[4] IS the unit price, in decimal dollars ("32.83"). TDS04 is 0 and
//      TDS01 carries the total; sum(qty x IT1[4]) == TDS01 in 777/890 documents,
//      the remaining 113 differing by deposits/taxes carried in header SAC.
//
// So the invoice amount that reconciles to line detail is TDS04 for shape A and
// TDS01 for shape B. TDS02 is neither: it is consistently larger than both and
// satisfies TDS01 == TDS02 - TDS04 on shape A. It is captured as
// `amountSubjectToTerms` and deliberately NOT used for variance math.
// ─────────────────────────────────────────────────────────────────────────────
import {
  splitTransactions, el, findSeg, findAll, ediDate, ediNum, ediCents,
  qualifiedValue, normalizeUpc, UPC_QUALIFIERS, type X12Segment,
} from './x12.js';

export type DocType = 'INVOICE' | 'CREDIT';
export type AmountBasis = 'SAC_LINES' | 'IT1_PRICE' | 'HEADER_ONLY';

export interface Parsed810Line {
  lineNo: number;
  qty: number;
  uom: string;
  unitPrice: number | null;    // dollars — SAC[8] on shape A, IT1[4] on shape B
  unitPriceRaw: string;        // IT1[4] verbatim, for traceability
  upc: string;                 // as transmitted
  upcNorm: string;             // digits only, leading zeros stripped
  description: string;
  ext: number | null;          // extended line amount in dollars
}

export interface Parsed810 {
  invoiceNumber: string;           // BIG[2]
  invoiceCore: string;             // BIG[2] with a trailing YYMMDD stripped
  invoiceDate: string | null;      // BIG[1]
  docType: DocType;                // BIG[7]: CR => credit memo
  originalInvoiceNum: string;      // BIG[10] — invoice a credit memo reverses
  vendorId: string;                // REF*VR
  vendorName: string;              // N1*RI name
  storeNumber: string;             // N1*ST id (92 qualifier)
  paymentTermsDays: number | null;
  lineExtSum: number;              // sum of line extensions, dollars
  amountSubjectToTerms: number | null;  // TDS02 — captured, not used for matching
  tdsTotal: number | null;         // TDS01
  tdsLineTotal: number | null;     // TDS04
  headerCharges: number;           // header-level SAC, signed (A adds, C deducts)
  invoiceAmt: number;              // the authoritative amount for matching
  amountBasis: AmountBasis;        // which rule produced invoiceAmt
  reconciled: boolean;             // invoiceAmt agrees with line detail
  lineCount: number | null;
  lines: Parsed810Line[];
}

const CENT = 0.005; // half-cent tolerance for float comparison

const stripCore = (n: string): string => {
  // PepsiCo invoice format: <core><YYMMDD>. e.g. 1808009132260422 -> 1808009132
  if (n.length >= 16 && /^\d{6}$/.test(n.slice(-6))) return n.slice(0, n.length - 6);
  return n;
};

export function parse810File(raw: string): Parsed810[] {
  const docs = splitTransactions(raw).filter((d) => d.type === '810');
  return docs.map(parseOne810).filter((x): x is Parsed810 => x != null);
}

function parseOne810(doc: { type: string; segments: X12Segment[] }): Parsed810 | null {
  const segs = doc.segments;
  const big = findSeg(segs, 'BIG');
  if (!big) return null;

  const invoiceDate = ediDate(el(big, 1));
  const invoiceNumber = el(big, 2);
  const invoiceCore = stripCore(invoiceNumber);
  const docType: DocType = el(big, 7) === 'CR' ? 'CREDIT' : 'INVOICE';
  const originalInvoiceNum = el(big, 10);

  const refVr = findAll(segs, 'REF').find((r) => el(r, 1) === 'VR');
  const vendorId = refVr ? el(refVr, 2) : '';
  const n1s = findAll(segs, 'N1');
  const ri = n1s.find((n) => el(n, 1) === 'RI');
  const st = n1s.find((n) => el(n, 1) === 'ST');
  const vendorName = ri ? el(ri, 2) : '';
  const storeNumber = st ? el(st, 4) : '';

  const itd = findSeg(segs, 'ITD');
  const paymentTermsDays = itd ? ediNum(el(itd, 7)) : null;

  const tds = findSeg(segs, 'TDS');
  const tdsTotal = tds ? ediCents(el(tds, 1)) : null;
  const amountSubjectToTerms = tds ? ediCents(el(tds, 2)) : null;
  const tdsLineTotal = tds ? ediCents(el(tds, 4)) : null;

  const ctt = findSeg(segs, 'CTT');
  const lineCount = ctt ? ediNum(el(ctt, 1)) : null;

  // ── Walk segments, pairing each IT1 with the PID + SAC that follow it ──────
  const lines: Parsed810Line[] = [];
  let cur: Parsed810Line | null = null;
  let sawLineSac = false;
  let headerCharges = 0;
  let lineNo = 0;

  const flush = () => { if (cur) { lines.push(cur); cur = null; } };

  for (const s of segs) {
    if (s.tag === 'IT1') {
      flush();
      lineNo++;
      const rawPrice = el(s, 4);
      const upc = qualifiedValue(s, 6, UPC_QUALIFIERS);
      cur = {
        lineNo,
        qty: ediNum(el(s, 2)) ?? 0,
        uom: el(s, 3),
        unitPrice: null,          // resolved below, once we know the doc shape
        unitPriceRaw: rawPrice,
        // The qualifier run starts at element 6 in IT1. Reading a fixed index
        // here is what previously produced upc === 'UA' on every single line.
        upc,
        upcNorm: normalizeUpc(upc),
        description: '',
        ext: null,
      };
    } else if (s.tag === 'PID' && cur) {
      cur.description = el(s, 5);
    } else if (s.tag === 'SAC') {
      const isLineCharge = el(s, 2) === 'F800';
      if (isLineCharge && cur) {
        // SAC*A*F800***<ext_cents>***<unit_dollars>
        cur.ext = ediCents(el(s, 5));
        cur.unitPrice = ediNum(el(s, 8));
        sawLineSac = true;
      } else if (!isLineCharge) {
        // Header-level allowance/charge. 'A' = charge (adds), 'C' = allowance (deducts).
        const amt = ediCents(el(s, 5)) ?? 0;
        headerCharges += el(s, 1) === 'C' ? -amt : amt;
      }
    }
  }
  flush();

  // ── Resolve prices for IT1-priced documents (no SAC line detail) ───────────
  if (!sawLineSac) {
    for (const l of lines) {
      const p = ediNum(l.unitPriceRaw);
      l.unitPrice = p;
      l.ext = p != null ? round2(p * l.qty) : null;
    }
  }

  const lineExtSum = round2(lines.reduce((a, l) => a + (l.ext ?? 0), 0));

  // ── Pick the authoritative amount ─────────────────────────────────────────
  let invoiceAmt: number;
  let amountBasis: AmountBasis;
  if (sawLineSac && tdsLineTotal != null) {
    invoiceAmt = tdsLineTotal;             // verified equal to lineExtSum, 1862/1862
    amountBasis = 'SAC_LINES';
  } else if (!sawLineSac && lines.length > 0) {
    invoiceAmt = tdsTotal ?? lineExtSum;   // TDS01 carries deposits the lines omit
    amountBasis = 'IT1_PRICE';
  } else {
    invoiceAmt = tdsTotal ?? tdsLineTotal ?? 0;
    amountBasis = 'HEADER_ONLY';
  }

  // Credit memos are negative money. The EDI transmits magnitudes; sign them here
  // so totals, aging and variance math do not silently double-count reversals.
  if (docType === 'CREDIT') invoiceAmt = -Math.abs(invoiceAmt);

  const reconciled = amountBasis === 'HEADER_ONLY'
    ? false
    : Math.abs(Math.abs(invoiceAmt) - lineExtSum) <= Math.abs(headerCharges) + CENT;

  return {
    invoiceNumber, invoiceCore, invoiceDate, docType, originalInvoiceNum,
    vendorId, vendorName, storeNumber, paymentTermsDays,
    lineExtSum, amountSubjectToTerms, tdsTotal, tdsLineTotal, headerCharges,
    invoiceAmt, amountBasis, reconciled,
    lineCount, lines,
  };
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
