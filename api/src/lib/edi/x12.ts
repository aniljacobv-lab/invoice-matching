// ─────────────────────────────────────────────────────────────────────────────
// ANSI X12 EDI parser  ·  4030 envelope (ISA/GS/ST..SE/GE/IEA).
//
// Handles the three message types FD/PepsiCo exchange:
//   810  Invoice         (BIG header, IT1 lines, PID, SAC charges, TDS totals)
//   850  Purchase Order  (BEG header, PO1 lines, PID, TDS)
//   856  Advance Ship Notice (BSN header, HL hierarchy, LIN/SN1 lines)
//
// Conservative parser — segment terminator / element separator / sub-element
// separator are read from the ISA segment itself, so it works with any of the
// common ANSI-X12 conventions (~ / \n / * / >).
// ─────────────────────────────────────────────────────────────────────────────

export type X12Segment = { tag: string; elements: string[] };

export interface X12Document { isa: X12Segment | null; segments: X12Segment[]; sep: string; term: string; sub: string; }

/**
 * Split a full EDI payload into its constituent transaction-set documents (ST..SE),
 * so a single file containing 1000 invoices yields 1000 docs.
 */
export function splitTransactions(raw: string): { type: string; segments: X12Segment[] }[] {
  const all = parseFile(raw);
  const out: { type: string; segments: X12Segment[] }[] = [];
  let cur: X12Segment[] | null = null;
  let type = '';
  for (const seg of all.segments) {
    if (seg.tag === 'ST') {
      cur = []; type = seg.elements[1] ?? '';   // ST*810*0001 → '810'
    }
    if (cur) cur.push(seg);
    if (seg.tag === 'SE' && cur) { out.push({ type, segments: cur }); cur = null; }
  }
  return out;
}

export function parseFile(raw: string): X12Document {
  // First 106 chars of an X12 file = ISA segment (fixed-length). The element
  // separator is at position 3, the sub-element separator at 104, and the
  // segment terminator at 105.
  const t = raw.startsWith('ISA') ? raw : raw.replace(/^[\s﻿]+/, '');
  const sep = t[3] ?? '*';
  const sub = t[104] ?? '>';
  const term = t[105] ?? '~';
  // Strip newlines/whitespace between segments — some senders pretty-print.
  const compact = t.replace(/\r?\n/g, '');
  const segments: X12Segment[] = [];
  let isa: X12Segment | null = null;
  for (const raw of compact.split(term)) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const els = trimmed.split(sep);
    const seg: X12Segment = { tag: els[0]!, elements: els };
    if (seg.tag === 'ISA') isa = seg;
    segments.push(seg);
  }
  return { isa, segments, sep, term, sub };
}

// ─── Convenience accessors ────────────────────────────────────────────────────

/** Get the i-th element of `seg` (0-based, where 0 is the tag itself). */
export const el = (seg: X12Segment, i: number): string => (seg.elements[i] ?? '');

/** Find the first segment with the given tag in a list. */
export const findSeg = (segs: X12Segment[], tag: string): X12Segment | null => segs.find((s) => s.tag === tag) ?? null;

/** Find ALL segments with the given tag. */
export const findAll = (segs: X12Segment[], tag: string): X12Segment[] => segs.filter((s) => s.tag === tag);

/** Convert "20260422" to ISO "2026-04-22". */
export function ediDate(s: string): string | null {
  if (!s || s.length < 8) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

/** Convert "1234" (cents) to 12.34. PepsiCo's 810 IT1 stores money this way. */
export function ediCents(s: string): number | null {
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.round(n) / 100;
}

/** "12.34" or "1234" — pick. Number with implicit decimal handling. */
export function ediNum(s: string): number | null {
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Scan a segment's trailing (qualifier, value) pairs and return the value for the
 * first qualifier in `wanted`.
 *
 * X12 product-identifier segments (IT1, PO1, LIN) carry a variable-length run of
 * paired elements, so the value's index is NOT fixed. `IT1**1*CA*70****UA*007800001352`
 * puts the UPC at index 9, while `PO1*...*2.41*PE*SK*1209176*ST*21280*UA*003000057139`
 * puts it at index 11. Reading a hardcoded index yields the qualifier itself ("UA")
 * or an unrelated vendor SKU — which is exactly the bug this replaces.
 *
 * @param start index of the first qualifier element in the pair run
 */
export function qualifiedValue(seg: X12Segment, start: number, wanted: string[]): string {
  for (let i = start; i < seg.elements.length - 1; i += 2) {
    const q = seg.elements[i];
    if (q && wanted.includes(q)) return seg.elements[i + 1] ?? '';
  }
  // Fall back to an unaligned scan — some senders emit an odd number of leading
  // elements, which shifts every subsequent pair by one.
  for (let i = start; i < seg.elements.length - 1; i++) {
    const q = seg.elements[i];
    if (q && wanted.includes(q)) return seg.elements[i + 1] ?? '';
  }
  return '';
}

/** Product-identifier qualifiers that carry a consumer UPC / GTIN / EAN. */
export const UPC_QUALIFIERS = ['UA', 'UP', 'UK', 'EN', 'UI', 'IB'];

/** Qualifiers for a vendor/buyer internal SKU — useful as a secondary join key. */
export const SKU_QUALIFIERS = ['SK', 'VN', 'VP', 'BP', 'IN'];

/**
 * Normalize a UPC for comparison: digits only, leading zeros stripped.
 * FD sends 12-digit UPC-A, PepsiCo pads to 14-digit GTIN, and the 850 sometimes
 * carries an 11-digit form — all three describe the same item.
 */
export function normalizeUpc(s: string): string {
  const digits = (s ?? '').replace(/\D/g, '');
  const stripped = digits.replace(/^0+/, '');
  return stripped || digits;
}
