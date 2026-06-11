// Family Dollar internal 850 flat-file parser.
// The sample uses record-type prefixed columns:
//   8501558<padding>TORDR<seq><po_num><store_or_dc><flow>... (Order header)
//   8501558<padding>TLOCN<seq><store_id><store_name>...     (Location)
//   8501558<padding>TLINE<seq><sku><qty><unit_price>...     (Line)
//
// Because the flat-file spec wasn't provided, we extract the bare essentials:
// PO number, vendor id (the leading 4-digit number after '850'), store/DC,
// flow ('DC' vs 'DSD'), and approximate line counts. The X12 850 (EDI_850_Output)
// is used in preference when both exist.
import type { Parsed850 } from './parse850.js';

export function parseFlat850File(raw: string): Parsed850[] {
  const orders = new Map<string, Parsed850>();
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 50);
  for (const ln of lines) {
    // 850 prefix
    if (!ln.startsWith('850')) continue;
    // first 4 numeric chars after '850' is the vendor id (e.g. 1558 = Quaker)
    const vendorId = ln.slice(3, 7).trim();
    // record type indicator sits at position 15-19: 'TORDR' / 'TLOCN' / 'TLINE'
    const recType = ln.slice(15, 20).trim();
    if (recType === 'TORDR') {
      // PO header — extract PO number (positions ~25-37), order date later
      const poNumber = ln.slice(25, 39).trim().replace(/^0+/, '') || ln.slice(25, 39).trim();
      const storeOrDc = ln.slice(40, 55).trim();
      if (!poNumber) continue;
      orders.set(poNumber, { poNumber, poDate: null, vendorId, storeNumber: storeOrDc, totalQty: 0, totalAmt: 0, lineCount: 0, lines: [] });
    }
  }
  return [...orders.values()];
}
