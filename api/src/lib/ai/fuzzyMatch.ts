// ─────────────────────────────────────────────────────────────────────────────
// AI-assisted fuzzy matching for documents the deterministic engine could not pair.
//
// The exact-key matcher joins ASN.refInvoiceNum == Invoice.invoiceCore on
// (vendor, store). That is correct and should stay first — but it is brittle:
// a store number transposed at the vendor, a REF*IV carrying the delivery ticket
// instead of the invoice core, or a re-issued invoice with a new suffix all
// produce a false "no ASN" exception on paperwork that plainly belongs together.
//
// Shape of this module:
//
//   1. shortlistCandidates()  — pure, deterministic, no API call. Scores every
//      counterparty document on evidence a human would actually use: same
//      vendor, near store, near date, similar dollars, overlapping UPCs. Returns
//      the top N. This is what keeps the model bill small and the latency sane —
//      we send ~12 candidates, never 1,862.
//
//   2. rankCandidates()  — Claude weighs the shortlist and returns a ranked
//      proposal with confidence and a written reason. The model sees only
//      evidence, and is instructed to answer "no match" freely.
//
// The output is a PROPOSAL. Nothing here mutates the ledger; AP confirms.
// ─────────────────────────────────────────────────────────────────────────────
import type { Invoice, AdvanceShipNotice, PurchaseOrder } from '../../types.js';
import { askStructured, signature } from './client.js';
import { config } from '../../config.js';

export interface CandidateEvidence {
  id: string;                 // asnNum or poNum
  kind: 'ASN' | 'PO';
  vendorId: string;
  store: string;
  refInvoiceNum?: string;
  date: string | null;
  qty: number;
  amount: number | null;
  lineCount: number;
  /** Deterministic 0-100 prescreen score; explains why it made the shortlist. */
  prescreen: number;
  signals: string[];
}

export interface FuzzyProposal {
  candidateId: string;
  confidence: number;         // 0-100
  verdict: 'MATCH' | 'LIKELY' | 'NO_MATCH';
  reason: string;
  discrepancies: string[];
  suggestedAction: string;
}

export interface FuzzyMatchResult {
  invoiceNum: string;
  candidates: CandidateEvidence[];
  proposals: FuzzyProposal[];
  best: FuzzyProposal | null;
  aiUsed: boolean;
  note?: string;
}

// ─── 1. Deterministic prescreen ──────────────────────────────────────────────

const dayDiff = (a: string | null, b: string | null): number | null => {
  if (!a || !b) return null;
  const d = (Date.parse(a) - Date.parse(b)) / 86_400_000;
  return Number.isFinite(d) ? Math.round(d) : null;
};

/** Longest common suffix/prefix affinity between two identifiers. */
function idAffinity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.85;
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  return Math.min(0.8, (pre + suf) / Math.max(a.length, b.length));
}

/** Store codes differ in padding across transports ("04822" vs "4822"). */
const normStore = (s: string): string => (s ?? '').replace(/\D/g, '').replace(/^0+/, '');

export function shortlistCandidates(
  invoice: Invoice,
  asns: AdvanceShipNotice[],
  pos: PurchaseOrder[],
  limit = config.app.ai.maxCandidates,
): CandidateEvidence[] {
  const invUpcs = new Set(invoice.lines.map((l) => l.upcNorm).filter(Boolean));
  const invStore = normStore(invoice.storeOrDc);
  const out: CandidateEvidence[] = [];

  for (const a of asns) {
    const signals: string[] = [];
    let score = 0;

    const sameVendor = a.vendorId === invoice.vendorId;
    const asnUpcSet = new Set(a.packs.flatMap((p) => p.items.map((i) => i.upcNorm)).filter(Boolean));
    const upcOverlap = [...asnUpcSet].filter((u) => invUpcs.has(u)).length;

    // Hard gate. Date proximity alone is not evidence — on any given day dozens of
    // unrelated shipments are within a few days of any given invoice. Without this
    // the shortlist fills with noise, which both wastes tokens and hands the model
    // plausible-looking wrong answers to choose between. A candidate must share
    // either the vendor or actual items to be worth evaluating at all.
    if (!sameVendor && upcOverlap === 0) continue;

    if (sameVendor) { score += 25; signals.push('same vendor'); }

    const asnStore = normStore(a.storeOrDc);
    if (asnStore && asnStore === invStore) { score += 25; signals.push('same store'); }
    else if (asnStore && invStore && (asnStore.endsWith(invStore) || invStore.endsWith(asnStore))) {
      score += 12; signals.push(`store padding differs (${a.storeOrDc} vs ${invoice.storeOrDc})`);
    }

    const aff = idAffinity(a.refInvoiceNum || a.asnNum, invoice.invoiceCore);
    if (aff > 0.5) { score += Math.round(aff * 25); signals.push(`reference id affinity ${(aff * 100).toFixed(0)}%`); }

    const dd = dayDiff(invoice.invoiceDate, a.shipDate);
    if (dd != null && Math.abs(dd) <= 7) {
      score += Math.max(0, 15 - Math.abs(dd) * 2);
      signals.push(`invoice dated ${dd === 0 ? 'same day as' : `${Math.abs(dd)}d ${dd > 0 ? 'after' : 'before'}`} ship`);
    }

    if (upcOverlap > 0) {
      const pct = upcOverlap / Math.max(1, Math.min(asnUpcSet.size, invUpcs.size));
      score += Math.round(pct * 30);
      signals.push(`${upcOverlap} shared UPC${upcOverlap === 1 ? '' : 's'} (${(pct * 100).toFixed(0)}% of the smaller doc)`);
    }

    const qtyGap = Math.abs(a.totalQty - invoice.totalQty) / Math.max(1, Math.max(a.totalQty, invoice.totalQty));
    if (qtyGap < 0.25) { score += Math.round((1 - qtyGap) * 12); signals.push(`qty within ${(qtyGap * 100).toFixed(0)}%`); }

    // Floor: vendor match alone (25) is not enough to spend a model call on.
    // Something beyond identity has to corroborate.
    if (score <= 30) continue;
    out.push({
      id: a.asnNum, kind: 'ASN', vendorId: a.vendorId, store: a.storeOrDc,
      refInvoiceNum: a.refInvoiceNum, date: a.shipDate,
      qty: a.totalQty, amount: null, lineCount: a.lineCount,
      prescreen: Math.min(100, score), signals,
    });
  }

  for (const p of pos) {
    const signals: string[] = [];
    let score = 0;
    if (p.vendorId === invoice.vendorId) { score += 25; signals.push('same vendor'); }
    if (normStore(p.storeOrDc) === invStore && invStore) { score += 20; signals.push('same destination'); }
    const poUpcs = new Set(p.lines.map((l) => l.upcNorm).filter(Boolean));
    const overlap = [...poUpcs].filter((u) => invUpcs.has(u)).length;
    if (overlap > 0) { score += Math.min(30, overlap * 6); signals.push(`${overlap} shared UPCs`); }
    const amtGap = Math.abs(p.totalAmt - Math.abs(invoice.invoiceAmt)) / Math.max(1, p.totalAmt);
    if (amtGap < 0.2) { score += Math.round((1 - amtGap) * 15); signals.push(`PO total within ${(amtGap * 100).toFixed(0)}%`); }
    const dd = dayDiff(invoice.invoiceDate, p.poDate);
    if (dd != null && dd >= 0 && dd <= 30) { score += Math.max(0, 10 - Math.floor(dd / 4)); signals.push(`invoiced ${dd}d after PO`); }
    if (score <= 20) continue;
    out.push({
      id: p.poNum, kind: 'PO', vendorId: p.vendorId, store: p.storeOrDc,
      date: p.poDate, qty: p.totalQty, amount: p.totalAmt, lineCount: p.lineCount,
      prescreen: Math.min(100, score), signals,
    });
  }

  return out.sort((a, b) => b.prescreen - a.prescreen).slice(0, limit);
}

// ─── 2. AI ranking ───────────────────────────────────────────────────────────

const SYSTEM = `You are an accounts-payable matching analyst for a retail EDI pipeline
(Family Dollar receiving PepsiCo DSD deliveries and Quaker DC shipments).

An invoice failed exact-key matching. You are given the invoice and a shortlist of
candidate shipping/order documents that a deterministic prescreen flagged as
plausible. Decide which candidate, if any, documents the same physical delivery.

How to weigh evidence:
- Shared UPCs are the strongest signal: the same items in the same delivery.
- Vendor must agree. A vendor mismatch is close to disqualifying.
- Store codes vary in zero-padding across transports; "04822" and "4822" are the
  same store. A genuinely different store number is disqualifying.
- Invoices normally post 0-3 days after the ship date. A large gap is suspicious.
- Reference-number affinity is suggestive but weak on its own — vendors reuse
  number ranges, so two unrelated documents can look similar.
- Quantity and dollar proximity corroborate; they never establish a match alone.

Calibration matters more than helpfulness here. A wrong match causes a duplicate
payment, which is far more costly than an exception that stays open one more day.
Return NO_MATCH freely — it is the correct answer most of the time. Only use
MATCH when the item-level evidence genuinely supports it. Never invent a
candidate id that was not in the list.`;

const SCHEMA = {
  type: 'object',
  properties: {
    proposals: {
      type: 'array',
      description: 'One entry per candidate you assessed, best first. May be empty.',
      items: {
        type: 'object',
        properties: {
          candidateId: { type: 'string', description: 'Exactly as given in the candidate list.' },
          confidence: { type: 'number', description: '0-100. Below 60 means do not surface to AP.' },
          verdict: { type: 'string', enum: ['MATCH', 'LIKELY', 'NO_MATCH'] },
          reason: { type: 'string', description: 'One or two sentences citing the specific evidence.' },
          discrepancies: { type: 'array', items: { type: 'string' }, description: 'What still does not line up.' },
          suggestedAction: { type: 'string', description: 'Concrete next step for the AP clerk.' },
        },
        required: ['candidateId', 'confidence', 'verdict', 'reason', 'discrepancies', 'suggestedAction'],
      },
    },
  },
  required: ['proposals'],
} as const;

function invoiceBrief(inv: Invoice) {
  return {
    invoiceNum: inv.invoiceNum,
    invoiceCore: inv.invoiceCore,
    docType: inv.docType,
    vendorId: inv.vendorId,
    vendorName: inv.vendorName,
    store: inv.storeOrDc,
    invoiceDate: inv.invoiceDate,
    amount: inv.invoiceAmt,
    totalQty: inv.totalQty,
    lineCount: inv.lineCount,
    topItems: inv.lines.slice(0, 15).map((l) => ({ upc: l.upcNorm, desc: l.description, qty: l.qty, amt: l.amount })),
  };
}

export async function fuzzyMatchInvoice(
  invoice: Invoice,
  asns: AdvanceShipNotice[],
  pos: PurchaseOrder[],
): Promise<FuzzyMatchResult> {
  const candidates = shortlistCandidates(invoice, asns, pos);

  if (candidates.length === 0) {
    return {
      invoiceNum: invoice.invoiceNum, candidates: [], proposals: [], best: null, aiUsed: false,
      note: 'No counterparty document shares enough evidence to be worth evaluating. This invoice is genuinely unmatched in the loaded data set, not merely mis-keyed.',
    };
  }

  const payload = {
    invoice: invoiceBrief(invoice),
    candidates: candidates.map((c) => ({
      id: c.id, kind: c.kind, vendorId: c.vendorId, store: c.store,
      refInvoiceNum: c.refInvoiceNum, date: c.date, qty: c.qty,
      amount: c.amount, lineCount: c.lineCount,
      prescreenScore: c.prescreen, prescreenSignals: c.signals,
    })),
  };

  const out = await askStructured<{ proposals: FuzzyProposal[] }>({
    system: SYSTEM,
    user: `Assess these candidates against the invoice.\n\n${JSON.stringify(payload, null, 2)}`,
    schema: SCHEMA as unknown as Record<string, unknown>,
    cacheKey: signature('fuzzy', invoice.invoiceNum, candidates.map((c) => `${c.id}:${c.prescreen}`)),
  });

  const valid = new Set(candidates.map((c) => c.id));
  // Guard against a hallucinated id pointing AP at a document that was never offered.
  const proposals = (out.proposals ?? [])
    .filter((p) => valid.has(p.candidateId))
    .sort((a, b) => b.confidence - a.confidence);

  const best = proposals.find(
    (p) => p.verdict !== 'NO_MATCH' && p.confidence >= config.app.ai.minConfidence,
  ) ?? null;

  return { invoiceNum: invoice.invoiceNum, candidates, proposals, best, aiUsed: true };
}
