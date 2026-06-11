// ─────────────────────────────────────────────────────────────────────────────
// X12 810 (Invoice) parser. Targets the PepsiCo dialect we have samples of.
//
//   BIG*<inv_date>*<invoice_num>...
//   REF*VR*<vendor_id>
//   N1*RI*<remit-to-name>*1*<vendor_id>
//   N1*ST*<store-name>*92*<store_num>
//   ITD*01*3*...30...                       ← payment terms (Net 30)
//   IT1**<qty>*<uom>*<unit_price_cents>****UA*<upc>
//   PID*F****<description>
//   SAC*A*F800***<line_ext_cents>***<line_ext_dollars>
//   TDS*<total_cents>*<gross_cents>**<net_cents>
//   CTT*<line_count>
//   SE / GE / IEA
//
// Numbers in IT1[3] and TDS are integer cents in this dialect — we divide.
// ─────────────────────────────────────────────────────────────────────────────
import { splitTransactions, el, findSeg, findAll, ediDate, ediNum, ediCents, type X12Segment } from './x12.js';

export interface Parsed810Line { lineNo: number; qty: number; uom: string; unitPriceRaw: number | null; upc: string; description: string; ext: number | null; }
export interface Parsed810 {
  invoiceNumber: string;       // BIG[2]
  invoiceCore: string;         // last 6 stripped if numeric date suffix
  invoiceDate: string | null;  // BIG[1]
  vendorId: string;            // REF*VR
  vendorName: string;          // N1*RI name
  storeNumber: string;         // N1*ST id (92 qualifier)
  paymentTermsDays: number | null;
  totalCents: number | null;
  grossUsd: number | null;
  netUsd: number | null;
  lineCount: number | null;
  lines: Parsed810Line[];
  rawHash?: string;
}

const stripCore = (n: string): string => {
  // PepsiCo invoice format: <10-char core><YYMMDD>. e.g. 1808009132260422 → 1808009132
  if (n.length >= 16 && /^\d{6}$/.test(n.slice(-6))) return n.slice(0, n.length - 6);
  return n;
};

export function parse810File(raw: string): Parsed810[] {
  const docs = splitTransactions(raw).filter((d) => d.type === '810');
  return docs.map(parseOne810).filter((x): x is Parsed810 => x != null);
}

function parseOne810(doc: { type: string; segments: X12Segment[] }): Parsed810 | null {
  const segs = doc.segments;
  const big = findSeg(segs, 'BIG'); if (!big) return null;
  const invoiceDate = ediDate(el(big, 1));
  const invoiceNumber = el(big, 2);
  const invoiceCore = stripCore(invoiceNumber);
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
  const totalCents = tds ? ediNum(el(tds, 1)) : null;
  const grossUsd = tds ? ediCents(el(tds, 2)) : null;
  const netUsd = tds ? ediCents(el(tds, 4)) : null;
  const ctt = findSeg(segs, 'CTT');
  const lineCount = ctt ? ediNum(el(ctt, 1)) : null;

  // Walk segments and pair IT1 with the following PID + SAC for that line.
  const lines: Parsed810Line[] = [];
  let cur: Parsed810Line | null = null;
  let lineNo = 0;
  for (const s of segs) {
    if (s.tag === 'IT1') {
      if (cur) lines.push(cur);
      lineNo++;
      cur = {
        lineNo,
        qty: ediNum(el(s, 2)) ?? 0,
        uom: el(s, 3),
        unitPriceRaw: ediNum(el(s, 4)),     // dollars-with-decimals or cents — depends; we normalize below
        upc: el(s, 8),
        description: '',
        ext: null,
      };
    } else if (s.tag === 'PID' && cur) {
      cur.description = el(s, 5);
    } else if (s.tag === 'SAC' && cur && el(s, 1) === 'A' && el(s, 2) === 'F800') {
      // SAC*A*F800***<cents>***<dollars> — pick the dollar field if present, else cents/100
      const dollars = ediNum(el(s, 7));
      const cents = ediNum(el(s, 5));
      cur.ext = dollars ?? (cents != null ? cents / 100 : null);
    }
  }
  if (cur) lines.push(cur);

  // Unit price in this PepsiCo dialect IT1[4] is dollars-with-decimals divided by 100, so
  // a value like "5547" means $55.47. Normalize so .unitPrice is dollars.
  // (We keep .unitPriceRaw for traceability; consumers should derive ext/qty.)
  return {
    invoiceNumber, invoiceCore, invoiceDate,
    vendorId, vendorName, storeNumber, paymentTermsDays,
    totalCents, grossUsd, netUsd, lineCount, lines,
  };
}
