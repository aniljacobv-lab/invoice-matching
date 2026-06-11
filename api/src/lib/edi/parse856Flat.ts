// PepsiCo PDT856_PBC856 CSV flat-file ASN parser.
// Format observed:
//   "96033","1808615065","H",...,"04822","00100120008303963879",,,,"8","20260424","Y"   ← Header line per pack
//   "96033","1808615065","D",...,"04822","00100120008303963879","012000809941","10","CA",,"20260424",  ← Detail lines
//
// Cols:
//   0 vendor_id, 1 asn_number, 2 H|D, 3 inv_ref, 4 ship_date, 5 delivery_date,
//   6 (blank), 7 store_number, 8 sscc, 9 upc(D)/blank(H), 10 qty(D)/?, 11 uom,
//   12 (blank), 13 process_date, 14 confirm(H)
//
import type { Parsed856, Parsed856Pack, Parsed856Item } from './parse856.js';

function dsplit(s: string): string[] {
  // simple CSV split — assumes "" wrapped fields, no commas inside
  return s.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
}
const fmtDate = (s: string): string | null => (/^\d{8}$/.test(s) ? `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}` : null);

export function parseFlat856File(raw: string): Parsed856[] {
  const byAsn = new Map<string, Parsed856>();
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cols = dsplit(line);
    const [vendorId, asn, kind, _invRef, shipDate, deliveryDate, _u, store, sscc, upc, qtyStr, uom] = cols;
    if (!asn) continue;
    let parsed = byAsn.get(asn!);
    if (!parsed) {
      parsed = {
        asnNumber: asn!, refInvoiceNum: asn!, vendorId: vendorId ?? '', bolNumber: '',
        shipDate: fmtDate(shipDate ?? ''), deliveryDate: fmtDate(deliveryDate ?? ''),
        storeNumber: store ?? '', vendorName: '', packs: [], totalQty: 0, itemCount: 0, cartonCount: 0,
      };
      byAsn.set(asn!, parsed);
    }
    if (kind === 'H') {
      // new pack
      let pack: Parsed856Pack | undefined = parsed.packs.find((p) => p.sscc === sscc);
      if (!pack) { pack = { sscc: sscc ?? '', items: [] }; parsed.packs.push(pack); }
    } else if (kind === 'D' && upc) {
      let pack: Parsed856Pack | undefined = parsed.packs.find((p) => p.sscc === sscc);
      if (!pack) { pack = { sscc: sscc ?? '', items: [] }; parsed.packs.push(pack); }
      const item: Parsed856Item = { upc, qty: Number(qtyStr ?? '0') || 0, uom: uom || 'CA' };
      pack.items.push(item);
    }
  }
  // recompute totals
  for (const a of byAsn.values()) {
    a.cartonCount = a.packs.length;
    a.itemCount = a.packs.reduce((n, p) => n + p.items.length, 0);
    a.totalQty = a.packs.reduce((n, p) => n + p.items.reduce((m, i) => m + i.qty, 0), 0);
  }
  return [...byAsn.values()];
}
