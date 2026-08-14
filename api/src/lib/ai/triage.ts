// ─────────────────────────────────────────────────────────────────────────────
// AI exception triage.
//
// The deterministic engine assigns severity from the status code alone, via a
// switch statement: every QTY_VAR is HIGH, every PO_NO_RCPT is LOW. That gives
// AP a queue of 1,302 rows all wearing the same three labels, sorted by nothing
// in particular. It cannot distinguish a $12 short-ship from a $40,000 one, or a
// chronic vendor from a one-off.
//
// This module keeps the deterministic severity (it is auditable and never
// changes under you) and adds a ranked, reasoned layer on top:
//   - a dollar-weighted, age-weighted priority score
//   - a root-cause hypothesis in plain language
//   - a concrete next action naming the document and the counterparty
//   - a recovery estimate, so AP works what is actually collectable
//
// Batching: exceptions are grouped by signature so one call covers many rows.
// ─────────────────────────────────────────────────────────────────────────────
import type { MatchException, MatchResult, Invoice, Vendor } from '../../types.js';
import { askStructured, signature } from './client.js';

export interface TriagedException {
  excId: number;
  priority: number;              // 0-100, higher = work first
  rootCause: string;
  nextAction: string;
  estRecoveryUsd: number | null;
  confidence: number;
  tags: string[];
}

export interface TriageResult {
  triaged: TriagedException[];
  themes: { theme: string; excIds: number[]; impactUsd: number; recommendation: string }[];
  aiUsed: boolean;
}

const SYSTEM = `You triage accounts-payable match exceptions for a retail EDI pipeline
(Family Dollar; PepsiCo direct-store delivery plus Quaker DC shipments).

You are given a batch of open exceptions with their deterministic status codes,
dollar amounts, ages, and vendor context. Two jobs:

1. Per exception: assign a 0-100 priority, state the most likely root cause, and
   give the AP clerk one concrete next action. Priority should reflect recoverable
   dollars, age against payment terms, and whether the issue is actionable at all —
   not just the size of the number. A $50,000 exception that is a known systemic
   gap outranks nothing if no one can act on it this week; say so instead.

2. Across the batch: identify themes. If 400 exceptions share one cause — a vendor
   that never sends ASNs, a store whose codes are malformed — that is one
   conversation with one counterparty, not 400 tickets. Name it, total the dollars,
   and recommend the systemic fix.

Status codes:
  INV_NO_ASN  invoice arrived with no advance ship notice — cannot 3-way match
  ASN_NO_INV  goods shipped, invoice not yet received
  QTY_VAR     quantity disagreement between documents
  AMT_VAR     dollar disagreement against PO contract price
  PO_NO_RCPT  PO issued, nothing received against it

Ground every claim in the data you were given. Do not speculate about causes the
data cannot support, and do not invent exception ids.`;

const SCHEMA = {
  type: 'object',
  properties: {
    triaged: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          excId: { type: 'number' },
          priority: { type: 'number', description: '0-100, higher means work it first' },
          rootCause: { type: 'string', description: 'Most likely cause, in one sentence.' },
          nextAction: { type: 'string', description: 'One concrete step naming the document and counterparty.' },
          estRecoveryUsd: { type: ['number', 'null'], description: 'Realistically recoverable dollars, or null if not a recovery.' },
          confidence: { type: 'number', description: '0-100 confidence in the root cause.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Short labels, e.g. "vendor-onboarding", "price-protect".' },
        },
        required: ['excId', 'priority', 'rootCause', 'nextAction', 'estRecoveryUsd', 'confidence', 'tags'],
      },
    },
    themes: {
      type: 'array',
      description: 'Cross-cutting patterns worth one systemic fix.',
      items: {
        type: 'object',
        properties: {
          theme: { type: 'string' },
          excIds: { type: 'array', items: { type: 'number' } },
          impactUsd: { type: 'number' },
          recommendation: { type: 'string' },
        },
        required: ['theme', 'excIds', 'impactUsd', 'recommendation'],
      },
    },
  },
  required: ['triaged', 'themes'],
} as const;

export interface TriageInput {
  exceptions: MatchException[];
  results: MatchResult[];
  invoices: Invoice[];
  vendors: Vendor[];
}

/**
 * Triage a batch of exceptions. Cap the batch — 40 rows is roughly the point
 * where per-row reasoning quality starts to flatten against token cost.
 */
export async function triageExceptions(input: TriageInput, limit = 40): Promise<TriageResult> {
  // Deterministic pre-sort: biggest dollars and oldest first, so when we do cap
  // the batch we cap it on the tail that matters least.
  const batch = [...input.exceptions]
    .sort((a, b) => (Math.abs(b.excAmount) - Math.abs(a.excAmount)) || (b.ageDays - a.ageDays))
    .slice(0, limit);

  if (batch.length === 0) return { triaged: [], themes: [], aiUsed: false };

  const resultById = new Map(input.results.map((r) => [r.matchId, r]));
  const invByNum = new Map(input.invoices.map((i) => [i.invoiceNum, i]));

  // Vendor-level context lets the model spot "this vendor never sends ASNs"
  // rather than treating each of that vendor's rows as an independent mystery.
  const vendorStats = input.vendors.map((v) => {
    const vExc = input.exceptions.filter((e) => e.vendorId === v.vendorId);
    const vRes = input.results.filter((r) => r.vendorId === v.vendorId);
    return {
      vendorId: v.vendorId, name: v.vendorName, flow: v.flow,
      openExceptions: vExc.length,
      totalDocs: vRes.length,
      exceptionDollars: Math.round(vExc.reduce((a, e) => a + Math.abs(e.excAmount), 0)),
      topStatus: mode(vExc.map((e) => e.excType)),
    };
  });

  const rows = batch.map((e) => {
    const r = resultById.get(e.matchId);
    const inv = e.invoiceNum ? invByNum.get(e.invoiceNum) : undefined;
    return {
      excId: e.excId,
      type: e.excType,
      deterministicSeverity: e.severity,
      flow: e.flow,
      vendorId: e.vendorId,
      store: e.storeOrDc,
      invoiceNum: e.invoiceNum,
      asnNum: e.asnNum,
      poNum: e.poNum,
      amountUsd: Math.round(e.excAmount * 100) / 100,
      ageDays: e.ageDays,
      paymentTermsDays: inv?.paymentTermsDays ?? null,
      invoiceDate: inv?.invoiceDate ?? null,
      lineCount: inv?.lineCount ?? null,
      matcherNote: r?.exceptionNote ?? null,
      qtyVariance: r?.qtyVarAsnInv ?? null,
      amtVariance: r?.amtVarPoInv ?? null,
    };
  });

  const totals = {
    openExceptionsInQueue: input.exceptions.length,
    shownInThisBatch: batch.length,
    totalOpenDollars: Math.round(input.exceptions.reduce((a, e) => a + Math.abs(e.excAmount), 0)),
    byType: countBy(input.exceptions.map((e) => e.excType)),
  };

  const out = await askStructured<TriageResult>({
    system: SYSTEM,
    user: `Queue totals:\n${JSON.stringify(totals, null, 2)}\n\nVendor context:\n${JSON.stringify(vendorStats, null, 2)}\n\nExceptions to triage:\n${JSON.stringify(rows, null, 2)}`,
    schema: SCHEMA as unknown as Record<string, unknown>,
    cacheKey: signature('triage', rows.map((r) => `${r.excId}:${r.amountUsd}:${r.ageDays}`)),
    maxTokens: 8192,
  });

  const valid = new Set(batch.map((e) => e.excId));
  return {
    triaged: (out.triaged ?? []).filter((t) => valid.has(t.excId)).sort((a, b) => b.priority - a.priority),
    themes: out.themes ?? [],
    aiUsed: true,
  };
}

function countBy(xs: string[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const x of xs) m[x] = (m[x] ?? 0) + 1;
  return m;
}
function mode(xs: string[]): string | null {
  if (!xs.length) return null;
  const c = countBy(xs);
  return Object.entries(c).sort((a, b) => b[1] - a[1])[0]![0];
}
