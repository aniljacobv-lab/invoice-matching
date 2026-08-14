// X12 850 (Purchase Order) parser. The samples we have come in two flavors:
//   1) Standard X12 ISA/GS/ST*850/BEG/REF/N1/PO1/SE
//   2) Family Dollar internal flat file (record-type prefixed columns)
// This module handles the X12 form. Flat file goes to parse850Flat.ts.
//
//   BEG*<purpose>*<type>*<po_num>**<order_date>...
//   REF*VR*<vendor_id>
//   N1*ST*<dest-name>*92*<store_num>
//   PO1*<line_no>*<qty>*<uom>*<unit_price>*PE*SK*<vendor_sku>*ST*<n>*UA*<upc>
//   PID*F****<description>
//   CTT*<lines>
//
// The PO1 product-identifier run is variable length: the UPC sits at element 11
// in the FD/Quaker samples, while element 7 holds the *vendor SKU*. Reading a
// fixed index 7 (the previous behaviour) meant PO lines carried a SKU in the
// `upc` field while 810 lines carried the literal string "UA" — so a UPC join
// between a PO and an invoice could never succeed. Both now use qualifier scans.
//
import {
  splitTransactions, el, findSeg, findAll, ediDate, ediNum,
  qualifiedValue, normalizeUpc, UPC_QUALIFIERS, SKU_QUALIFIERS, type X12Segment,
} from './x12.js';

export interface Parsed850Line {
  lineNo: number; qty: number; uom: string; unitPrice: number | null;
  upc: string; upcNorm: string; vendorSku: string; description: string;
}
export interface Parsed850 {
  poNumber: string;
  poDate: string | null;
  vendorId: string;
  storeNumber: string;
  totalQty: number;
  totalAmt: number;
  lineCount: number | null;
  lines: Parsed850Line[];
}

export function parse850File(raw: string): Parsed850[] {
  const docs = splitTransactions(raw).filter((d) => d.type === '850');
  return docs.map(parseOne850).filter((x): x is Parsed850 => x != null);
}

function parseOne850(doc: { type: string; segments: X12Segment[] }): Parsed850 | null {
  const segs = doc.segments;
  const beg = findSeg(segs, 'BEG'); if (!beg) return null;
  const poNumber = el(beg, 3);
  const poDate = ediDate(el(beg, 5));
  const refVr = findAll(segs, 'REF').find((r) => el(r, 1) === 'VR');
  const vendorId = refVr ? el(refVr, 2) : '';
  const st = findAll(segs, 'N1').find((n) => el(n, 1) === 'ST');
  const storeNumber = st ? el(st, 4) : '';
  const ctt = findSeg(segs, 'CTT');
  const lineCount = ctt ? ediNum(el(ctt, 1)) : null;

  const lines: Parsed850Line[] = [];
  let cur: Parsed850Line | null = null;
  for (const s of segs) {
    if (s.tag === 'PO1') {
      if (cur) lines.push(cur);
      const upc = qualifiedValue(s, 6, UPC_QUALIFIERS);
      cur = {
        lineNo: ediNum(el(s, 1)) ?? lines.length + 1,
        qty: ediNum(el(s, 2)) ?? 0,
        uom: el(s, 3),
        unitPrice: ediNum(el(s, 4)),
        upc,
        upcNorm: normalizeUpc(upc),
        vendorSku: qualifiedValue(s, 6, SKU_QUALIFIERS),
        description: '',
      };
    } else if (s.tag === 'PID' && cur) {
      cur.description = el(s, 5);
    }
  }
  if (cur) lines.push(cur);

  const totalQty = lines.reduce((a, l) => a + l.qty, 0);
  const totalAmt = lines.reduce((a, l) => a + (l.unitPrice ?? 0) * l.qty, 0);
  return { poNumber, poDate, vendorId, storeNumber, totalQty, totalAmt, lineCount, lines };
}
