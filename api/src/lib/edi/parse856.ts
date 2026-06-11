// X12 856 (Advance Ship Notice) parser. Hierarchy is HL-driven:
//   BSN*<purpose>*<asn_num>*<date>*<time>
//   HL*<id>*<parent>*S  ← Shipment
//     TD1*CTN<count>*<count>      ← carton count
//     REF*IA*<vendor_id>
//     REF*IV*<invoice_ref>
//     REF*BM*<bol>
//     N1*ST*<store-name>*92*<store_num>
//     N1*SF*<ship-from>*92*<vendor_id>
//     HL*<id>*<parent>*P          ← Pack (carton GM/SSCC)
//       MAN*GM*<sscc>
//       HL*<id>*<parent>*I        ← Item
//         LIN****UP*<upc>
//         SN1**<qty>*<uom>
//
import { splitTransactions, el, findSeg, findAll, ediDate, ediNum, type X12Segment } from './x12.js';

export interface Parsed856Item { upc: string; qty: number; uom: string; }
export interface Parsed856Pack { sscc: string; items: Parsed856Item[]; }
export interface Parsed856 {
  asnNumber: string;
  refInvoiceNum: string;   // REF*IV
  vendorId: string;        // REF*IA
  bolNumber: string;       // REF*BM
  shipDate: string | null;
  deliveryDate: string | null;
  storeNumber: string;
  vendorName: string;
  packs: Parsed856Pack[];
  totalQty: number;
  itemCount: number;
  cartonCount: number;
}

export function parse856File(raw: string): Parsed856[] {
  const docs = splitTransactions(raw).filter((d) => d.type === '856');
  return docs.map(parseOne856).filter((x): x is Parsed856 => x != null);
}

function parseOne856(doc: { type: string; segments: X12Segment[] }): Parsed856 | null {
  const segs = doc.segments;
  const bsn = findSeg(segs, 'BSN'); if (!bsn) return null;
  const asnNumber = el(bsn, 2);
  const shipDate = ediDate(el(bsn, 3));
  const refs = findAll(segs, 'REF');
  const refInvoiceNum = refs.find((r) => el(r, 1) === 'IV') ? el(refs.find((r) => el(r, 1) === 'IV')!, 2) : '';
  const vendorId = refs.find((r) => el(r, 1) === 'IA') ? el(refs.find((r) => el(r, 1) === 'IA')!, 2) : '';
  const bolNumber = refs.find((r) => el(r, 1) === 'BM') ? el(refs.find((r) => el(r, 1) === 'BM')!, 2) : '';
  const dtm = findAll(segs, 'DTM').find((d) => el(d, 1) === '011');   // 011 = "shipped"
  const deliveryDate = dtm ? ediDate(el(dtm, 2)) : null;
  const n1s = findAll(segs, 'N1');
  const st = n1s.find((n) => el(n, 1) === 'ST');
  const sf = n1s.find((n) => el(n, 1) === 'SF');
  const storeNumber = st ? el(st, 4) : '';
  const vendorName = sf ? el(sf, 2) : '';

  // Walk HL hierarchy, tracking which Pack we're under.
  const packs: Parsed856Pack[] = [];
  let curPack: Parsed856Pack | null = null;
  let curItem: Parsed856Item | null = null;
  for (const s of segs) {
    if (s.tag === 'HL') {
      const level = el(s, 3);
      if (level === 'P') {
        if (curItem && curPack) curPack.items.push(curItem); curItem = null;
        curPack = { sscc: '', items: [] };
        packs.push(curPack);
      } else if (level === 'I') {
        if (curItem && curPack) curPack.items.push(curItem);
        curItem = { upc: '', qty: 0, uom: 'CA' };
      }
    } else if (s.tag === 'MAN' && curPack && el(s, 1) === 'GM') {
      curPack.sscc = el(s, 2);
    } else if (s.tag === 'LIN' && curItem) {
      // LIN****UP*<upc>  — qualifier index varies
      for (let i = 2; i < s.elements.length - 1; i++) {
        if (s.elements[i] === 'UP') { curItem.upc = s.elements[i + 1] ?? ''; break; }
      }
    } else if (s.tag === 'SN1' && curItem) {
      curItem.qty = ediNum(el(s, 2)) ?? 0;
      curItem.uom = el(s, 3) || 'CA';
    }
  }
  if (curItem && curPack) curPack.items.push(curItem);

  const totalQty = packs.reduce((a, p) => a + p.items.reduce((b, it) => b + it.qty, 0), 0);
  const itemCount = packs.reduce((a, p) => a + p.items.length, 0);
  const cartonCount = packs.length;
  return { asnNumber, refInvoiceNum, vendorId, bolNumber, shipDate, deliveryDate, storeNumber, vendorName, packs, totalQty, itemCount, cartonCount };
}
