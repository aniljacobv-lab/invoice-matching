// ─────────────────────────────────────────────────────────────────────────────
// Natural-language query over the match data.
//
// "PepsiCo invoices over $2k with no ASN in the last week" — Claude translates
// that into a structured filter, the filter runs as ordinary indexed TypeScript
// against the store, and the answer comes back with the filter shown.
//
// The model produces a filter object, NOT code and NOT SQL. That is deliberate:
//   - the executable surface is a fixed set of named fields with typed operators,
//     so a bad or adversarial query can only ever return the wrong rows, never
//     read something it shouldn't or mutate anything;
//   - the applied filter is echoed to the UI, so the user can see exactly what
//     was asked on their behalf and correct it rather than trusting a black box.
// ─────────────────────────────────────────────────────────────────────────────
import type { Invoice, MatchResult, MatchException, MatchStatus } from '../../types.js';
import { askStructured, signature } from './client.js';

export type Entity = 'invoices' | 'exceptions' | 'matches';

export interface QueryFilter {
  entity: Entity;
  vendorId?: string | null;
  store?: string | null;
  status?: MatchStatus[] | null;
  severity?: ('HIGH' | 'MED' | 'LOW')[] | null;
  docType?: 'INVOICE' | 'CREDIT' | null;
  minAmount?: number | null;
  maxAmount?: number | null;
  sinceDate?: string | null;      // ISO yyyy-mm-dd, inclusive
  untilDate?: string | null;
  minAgeDays?: number | null;
  textContains?: string | null;   // matches item descriptions
  sortBy?: 'amount' | 'date' | 'age' | 'qty' | null;
  sortDir?: 'asc' | 'desc' | null;
  limit?: number | null;
}

export interface NlQueryResult {
  question: string;
  interpretation: string;
  filter: QueryFilter;
  rowCount: number;
  totalAmount: number;
  rows: Record<string, unknown>[];
  answer: string;
  caveats: string[];
}

const SYSTEM = `You turn a plain-English question about accounts-payable EDI data into a
structured filter. You do not answer from memory — the filter you produce is executed
against the live data set and the real rows come back.

Entities:
  invoices    810 documents. Fields: vendorId, store, docType (INVOICE|CREDIT),
              invoiceAmt (credit memos are NEGATIVE), invoiceDate, totalQty, lines.
  exceptions  open match exceptions. Fields: excType, severity, excAmount, ageDays, vendorId, store.
  matches     match results. Fields: matchStatus, matchScore, vendorId, store, amounts.

Status codes: 3WAY, 2WAY, QTY_VAR, AMT_VAR, INV_NO_ASN, ASN_NO_INV, PO_NO_RCPT, CREDIT_MEMO.

Vendors in this data set: 96033, 108464, 108465, 108466, 108467 are PepsiCo Beverages
(direct store delivery); 1558 is Quaker / PepsiCo Foods (DC supply). If the user says
"PepsiCo" without a number they most likely mean the DSD vendors — say so in your
interpretation rather than silently choosing.

Set only the fields the question actually constrains; leave the rest null. Prefer a
slightly broader filter over a narrow one that might miss rows, and note in "caveats"
anything you had to assume — especially date ranges relative to "today" and any
ambiguity about whether credit memos should be included.`;

const SCHEMA = {
  type: 'object',
  properties: {
    interpretation: { type: 'string', description: 'One sentence restating the question as you understood it.' },
    filter: {
      type: 'object',
      properties: {
        entity: { type: 'string', enum: ['invoices', 'exceptions', 'matches'] },
        vendorId: { type: ['string', 'null'] },
        store: { type: ['string', 'null'] },
        status: { type: ['array', 'null'], items: { type: 'string' } },
        severity: { type: ['array', 'null'], items: { type: 'string', enum: ['HIGH', 'MED', 'LOW'] } },
        docType: { type: ['string', 'null'], enum: ['INVOICE', 'CREDIT', null] },
        minAmount: { type: ['number', 'null'] },
        maxAmount: { type: ['number', 'null'] },
        sinceDate: { type: ['string', 'null'], description: 'ISO yyyy-mm-dd inclusive' },
        untilDate: { type: ['string', 'null'] },
        minAgeDays: { type: ['number', 'null'] },
        textContains: { type: ['string', 'null'], description: 'Substring match on item descriptions' },
        sortBy: { type: ['string', 'null'], enum: ['amount', 'date', 'age', 'qty', null] },
        sortDir: { type: ['string', 'null'], enum: ['asc', 'desc', null] },
        limit: { type: ['number', 'null'] },
      },
      required: ['entity'],
    },
    caveats: { type: 'array', items: { type: 'string' } },
  },
  required: ['interpretation', 'filter', 'caveats'],
} as const;

export interface QueryData {
  invoices: Invoice[];
  results: MatchResult[];
  exceptions: MatchException[];
}

export async function nlQuery(question: string, data: QueryData, today: string): Promise<NlQueryResult> {
  const plan = await askStructured<{ interpretation: string; filter: QueryFilter; caveats: string[] }>({
    system: SYSTEM,
    user: `Today's date is ${today}.\n\nQuestion: ${question}`,
    capability: 'nl-query',
    schema: SCHEMA as unknown as Record<string, unknown>,
    cacheKey: signature('nlq', question, today),
  });

  const { rows, total } = applyFilter(plan.filter, data);
  const limit = clamp(plan.filter.limit ?? 50, 1, 500);
  const shown = rows.slice(0, limit);

  return {
    question,
    interpretation: plan.interpretation,
    filter: plan.filter,
    rowCount: rows.length,
    totalAmount: Math.round(total * 100) / 100,
    rows: shown,
    answer: describe(plan.filter, rows.length, total, limit),
    caveats: plan.caveats ?? [],
  };
}

// ─── Filter execution — plain code, no model involvement ─────────────────────

export function applyFilter(f: QueryFilter, data: QueryData): { rows: Record<string, unknown>[]; total: number } {
  const inRange = (v: number | null | undefined) =>
    (f.minAmount == null || (v ?? 0) >= f.minAmount) && (f.maxAmount == null || (v ?? 0) <= f.maxAmount);
  const inDates = (d: string | null | undefined) => {
    if (!d) return f.sinceDate == null && f.untilDate == null;
    if (f.sinceDate && d < f.sinceDate) return false;
    if (f.untilDate && d > f.untilDate) return false;
    return true;
  };

  if (f.entity === 'invoices') {
    let rows = data.invoices.filter((i) => {
      if (f.vendorId && i.vendorId !== f.vendorId) return false;
      if (f.store && i.storeOrDc !== f.store) return false;
      if (f.docType && i.docType !== f.docType) return false;
      // Amount filters compare magnitude so "over $2,000" catches a -$2,500 credit.
      if (!inRange(Math.abs(i.invoiceAmt))) return false;
      if (!inDates(i.invoiceDate)) return false;
      if (f.textContains) {
        const needle = f.textContains.toLowerCase();
        if (!i.lines.some((l) => l.description.toLowerCase().includes(needle))) return false;
      }
      return true;
    });
    rows = sortRows(rows, f, { amount: (x) => Math.abs(x.invoiceAmt), date: (x) => x.invoiceDate ?? '', qty: (x) => x.totalQty, age: (x) => x.invoiceDate ?? '' });
    return {
      rows: rows.map((i) => ({
        invoiceNum: i.invoiceNum, docType: i.docType, vendorId: i.vendorId, vendorName: i.vendorName,
        store: i.storeOrDc, invoiceDate: i.invoiceDate, amount: i.invoiceAmt,
        totalQty: i.totalQty, lineCount: i.lineCount, reconciled: i.reconciled,
      })),
      total: rows.reduce((a, i) => a + i.invoiceAmt, 0),
    };
  }

  if (f.entity === 'exceptions') {
    let rows = data.exceptions.filter((e) => {
      if (f.vendorId && e.vendorId !== f.vendorId) return false;
      if (f.store && e.storeOrDc !== f.store) return false;
      if (f.status?.length && !f.status.includes(e.excType)) return false;
      if (f.severity?.length && !f.severity.includes(e.severity)) return false;
      if (!inRange(Math.abs(e.excAmount))) return false;
      if (f.minAgeDays != null && e.ageDays < f.minAgeDays) return false;
      return true;
    });
    rows = sortRows(rows, f, { amount: (x) => Math.abs(x.excAmount), age: (x) => x.ageDays, date: (x) => x.createdAt, qty: (x) => x.ageDays });
    return {
      rows: rows.map((e) => ({
        excId: e.excId, type: e.excType, severity: e.severity, vendorId: e.vendorId,
        store: e.storeOrDc, invoiceNum: e.invoiceNum, asnNum: e.asnNum, poNum: e.poNum,
        amount: e.excAmount, ageDays: e.ageDays, status: e.status, action: e.recommendedAction,
      })),
      total: rows.reduce((a, e) => a + Math.abs(e.excAmount), 0),
    };
  }

  let rows = data.results.filter((r) => {
    if (f.vendorId && r.vendorId !== f.vendorId) return false;
    if (f.store && r.storeOrDc !== f.store) return false;
    if (f.status?.length && !f.status.includes(r.matchStatus)) return false;
    if (!inRange(Math.abs(r.invAmtNet ?? r.poAmt ?? 0))) return false;
    if (!inDates(r.invoiceDate)) return false;
    return true;
  });
  rows = sortRows(rows, f, { amount: (x) => Math.abs(x.invAmtNet ?? x.poAmt ?? 0), date: (x) => x.invoiceDate ?? '', qty: (x) => x.invQty ?? 0, age: (x) => x.matchedAt });
  return {
    rows: rows.map((r) => ({
      matchId: r.matchId, status: r.matchStatus, score: r.matchScore, flow: r.flow,
      vendorId: r.vendorId, store: r.storeOrDc, invoiceNum: r.invoiceNum,
      asnNum: r.asnNum, poNum: r.poNum, amount: r.invAmtNet ?? r.poAmt, note: r.exceptionNote,
    })),
    total: rows.reduce((a, r) => a + Math.abs(r.invAmtNet ?? r.poAmt ?? 0), 0),
  };
}

function sortRows<T>(rows: T[], f: QueryFilter, keys: Partial<Record<string, (x: T) => number | string>>): T[] {
  const k = f.sortBy ? keys[f.sortBy] : undefined;
  if (!k) return rows;
  const dir = f.sortDir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = k(a), bv = k(b);
    if (av === bv) return 0;
    return (av < bv ? -1 : 1) * dir;
  });
}

function describe(f: QueryFilter, n: number, total: number, limit: number): string {
  const money = `$${Math.abs(total).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const noun = f.entity === 'invoices' ? 'invoice' : f.entity === 'exceptions' ? 'exception' : 'match';
  if (n === 0) return `No ${noun}s match that filter.`;
  const head = `${n.toLocaleString('en-US')} ${noun}${n === 1 ? '' : 's'} totalling ${money}${total < 0 ? ' (net credit)' : ''}.`;
  return n > limit ? `${head} Showing the first ${limit}.` : head;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
