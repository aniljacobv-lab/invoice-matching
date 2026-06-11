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
