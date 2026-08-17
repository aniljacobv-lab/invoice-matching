// ─────────────────────────────────────────────────────────────────────────────
// Line-level item alignment.
//
// Header-total matching answers "did we get billed the right total?". It cannot
// answer "which item was short-shipped?" — and that is the question that produces
// a debit memo. To get there you have to align individual lines across documents.
//
// UPC is the correct join key and now that the parsers are fixed it works for
// most lines. But it will not close the gap on its own:
//   - GTIN padding differs by transport (handled deterministically via upcNorm);
//   - vendors reissue items under a new UPC mid-quarter while the description is
//     unchanged;
//   - pack configuration changes ("12P2C" -> "24P1C") make the same product a
//     different item number;
//   - the DC flow's PO carries a vendor SKU where the invoice carries a UPC.
//
// So: deterministic UPC pass first, then Claude on the leftovers only. In the
// loaded data that means the model sees a handful of unmatched descriptions
// rather than all 45,222 invoice lines.
// ─────────────────────────────────────────────────────────────────────────────
import type { Invoice, AdvanceShipNotice, PurchaseOrder } from '../../types.js';
import { askStructured, signature } from './client.js';

export interface AlignedLine {
  invoiceLineNo: number | null;
  counterpartRef: string | null;   // UPC or SKU on the counterparty document
  description: string;
  invoiceQty: number | null;
  counterpartQty: number | null;
  qtyVariance: number | null;
  amount: number | null;
  method: 'UPC' | 'AI_DESCRIPTION' | 'UNMATCHED';
  confidence: number;
  note?: string;
}

export interface AlignmentResult {
  invoiceNum: string;
  counterpartId: string;
  counterpartKind: 'ASN' | 'PO';
  lines: AlignedLine[];
  summary: {
    total: number; byUpc: number; byAi: number; unmatched: number;
    shortShipped: number; overShipped: number; netQtyVariance: number;
    varianceUsd: number;
  };
  aiUsed: boolean;
}

interface CounterLine { ref: string; upcNorm: string; description: string; qty: number }

function counterpartLines(c: AdvanceShipNotice | PurchaseOrder): CounterLine[] {
  if ('packs' in c) {
    const merged = new Map<string, CounterLine>();
    for (const p of c.packs) {
      for (const it of p.items) {
        // One item can span several cartons; sum rather than overwrite.
        const k = it.upcNorm || it.upc;
        const prev = merged.get(k);
        if (prev) prev.qty += it.qty;
        else merged.set(k, { ref: it.upc, upcNorm: it.upcNorm, description: '', qty: it.qty });
      }
    }
    return [...merged.values()];
  }
  return c.lines.map((l) => ({ ref: l.upc || l.vendorSku, upcNorm: l.upcNorm, description: l.description, qty: l.qty }));
}

const SYSTEM = `You align invoice line items against a shipping notice or purchase order
for a retail grocery/beverage supply chain (PepsiCo and Quaker products into Family Dollar).

The UPC join already ran. What is left could not be matched on item number. Decide
which of the remaining lines describe the same physical product.

Descriptions are heavily abbreviated retail item strings, e.g.
  "PEPSI COL CAN 12OZ 12P2C FM"  = Pepsi Cola, 12oz can, 12-pack x 2 cases, Food Merchandising
  "BRSK IC T STRWBMLN PET 1L 1P15" = Brisk Iced Tea Strawberry Melon, 1L PET bottle, 1 pack of 15
  "DT PEPSI COLA CAN 12OZ 12P2CFM" = Diet Pepsi Cola

Read them as: BRAND / SUB-BRAND / FLAVOR / CONTAINER / SIZE / PACK-CONFIG.

Match only when brand AND flavor AND size agree. Specifically:
  - Diet, Zero Sugar and regular are DIFFERENT products. Never merge them.
  - Different flavors of the same brand are different products.
  - A pack-configuration difference with everything else identical IS the same
    product repacked — match it, and say so in the note.
  - A size difference (12OZ vs 20OZ) is a different product.

If you are not confident, leave it unmatched. An unmatched line prompts a human to
look; a wrong match silently produces a debit memo against the wrong item.`;

const SCHEMA = {
  type: 'object',
  properties: {
    matches: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          invoiceLineNo: { type: 'number' },
          counterpartRef: { type: 'string', description: 'The ref value from the counterparty list, verbatim.' },
          confidence: { type: 'number', description: '0-100' },
          note: { type: 'string', description: 'Why these are the same product, or what differs.' },
        },
        required: ['invoiceLineNo', 'counterpartRef', 'confidence', 'note'],
      },
    },
  },
  required: ['matches'],
} as const;

export async function alignLines(
  invoice: Invoice,
  counterpart: AdvanceShipNotice | PurchaseOrder,
  opts: { useAi?: boolean; minConfidence?: number } = {},
): Promise<AlignmentResult> {
  const useAi = opts.useAi !== false;
  const minConfidence = opts.minConfidence ?? 70;
  const cLines = counterpartLines(counterpart);
  const kind: 'ASN' | 'PO' = 'packs' in counterpart ? 'ASN' : 'PO';
  const counterpartId = 'asnNum' in counterpart ? counterpart.asnNum : counterpart.poNum;

  const byUpc = new Map<string, CounterLine>();
  for (const c of cLines) if (c.upcNorm) byUpc.set(c.upcNorm, c);

  const aligned: AlignedLine[] = [];
  const usedRefs = new Set<string>();

  // ── Pass 1: exact normalized UPC ─────────────────────────────────────────
  const leftovers: typeof invoice.lines = [];
  for (const l of invoice.lines) {
    const hit = l.upcNorm ? byUpc.get(l.upcNorm) : undefined;
    if (hit && !usedRefs.has(hit.ref)) {
      usedRefs.add(hit.ref);
      aligned.push({
        invoiceLineNo: l.lineNo, counterpartRef: hit.ref, description: l.description,
        invoiceQty: l.qty, counterpartQty: hit.qty, qtyVariance: l.qty - hit.qty,
        amount: l.amount, method: 'UPC', confidence: 100,
      });
    } else {
      leftovers.push(l);
    }
  }

  const unusedCounter = cLines.filter((c) => !usedRefs.has(c.ref));
  let aiUsed = false;

  // ── Pass 2: AI on descriptions, only for what is genuinely left ──────────
  if (useAi && leftovers.length > 0 && unusedCounter.length > 0) {
    try {
      const out = await askStructured<{ matches: { invoiceLineNo: number; counterpartRef: string; confidence: number; note: string }[] }>({
        system: SYSTEM,
        user: `Invoice ${invoice.invoiceNum} lines not matched by UPC:\n${JSON.stringify(
          leftovers.map((l) => ({ lineNo: l.lineNo, upc: l.upcNorm, description: l.description, qty: l.qty, uom: l.uom })), null, 2,
        )}\n\nUnmatched lines on ${kind} ${counterpartId}:\n${JSON.stringify(
          unusedCounter.map((c) => ({ ref: c.ref, upc: c.upcNorm, description: c.description || '(no description transmitted)', qty: c.qty })), null, 2,
        )}`,
        capability: 'line-align',
    schema: SCHEMA as unknown as Record<string, unknown>,
        cacheKey: signature('align', invoice.invoiceNum, counterpartId, leftovers.map((l) => l.lineNo)),
        maxTokens: 4096,
      });
      aiUsed = true;

      const validRefs = new Map(unusedCounter.map((c) => [c.ref, c]));
      const validLines = new Map(leftovers.map((l) => [l.lineNo, l]));
      for (const m of out.matches ?? []) {
        const c = validRefs.get(m.counterpartRef);
        const l = validLines.get(m.invoiceLineNo);
        // Reject hallucinated refs, already-consumed counterparts, and low confidence.
        if (!c || !l || usedRefs.has(c.ref) || m.confidence < minConfidence) continue;
        usedRefs.add(c.ref);
        validLines.delete(m.invoiceLineNo);
        aligned.push({
          invoiceLineNo: l.lineNo, counterpartRef: c.ref, description: l.description,
          invoiceQty: l.qty, counterpartQty: c.qty, qtyVariance: l.qty - c.qty,
          amount: l.amount, method: 'AI_DESCRIPTION', confidence: m.confidence, note: m.note,
        });
      }
      for (const l of validLines.values()) {
        aligned.push({
          invoiceLineNo: l.lineNo, counterpartRef: null, description: l.description,
          invoiceQty: l.qty, counterpartQty: null, qtyVariance: null,
          amount: l.amount, method: 'UNMATCHED', confidence: 0,
        });
      }
    } catch {
      // AI failed or is unavailable — fall back to reporting leftovers as unmatched.
      for (const l of leftovers) {
        aligned.push({
          invoiceLineNo: l.lineNo, counterpartRef: null, description: l.description,
          invoiceQty: l.qty, counterpartQty: null, qtyVariance: null,
          amount: l.amount, method: 'UNMATCHED', confidence: 0,
        });
      }
    }
  } else {
    for (const l of leftovers) {
      aligned.push({
        invoiceLineNo: l.lineNo, counterpartRef: null, description: l.description,
        invoiceQty: l.qty, counterpartQty: null, qtyVariance: null,
        amount: l.amount, method: 'UNMATCHED', confidence: 0,
      });
    }
  }

  // Counterparty lines with nothing on the invoice: shipped but not billed.
  for (const c of cLines) {
    if (usedRefs.has(c.ref)) continue;
    aligned.push({
      invoiceLineNo: null, counterpartRef: c.ref, description: c.description || `UPC ${c.ref}`,
      invoiceQty: null, counterpartQty: c.qty, qtyVariance: null,
      amount: null, method: 'UNMATCHED', confidence: 0,
      note: 'On the shipment but not on the invoice',
    });
  }

  aligned.sort((a, b) => (a.invoiceLineNo ?? 9e9) - (b.invoiceLineNo ?? 9e9));

  const matched = aligned.filter((l) => l.qtyVariance != null);
  const unitPriceOf = (l: AlignedLine) => {
    const inv = invoice.lines.find((x) => x.lineNo === l.invoiceLineNo);
    return inv && inv.qty > 0 ? inv.amount / inv.qty : 0;
  };

  return {
    invoiceNum: invoice.invoiceNum, counterpartId, counterpartKind: kind, lines: aligned,
    summary: {
      total: aligned.length,
      byUpc: aligned.filter((l) => l.method === 'UPC').length,
      byAi: aligned.filter((l) => l.method === 'AI_DESCRIPTION').length,
      unmatched: aligned.filter((l) => l.method === 'UNMATCHED').length,
      shortShipped: matched.filter((l) => (l.qtyVariance ?? 0) > 0).length,
      overShipped: matched.filter((l) => (l.qtyVariance ?? 0) < 0).length,
      netQtyVariance: matched.reduce((a, l) => a + (l.qtyVariance ?? 0), 0),
      varianceUsd: Math.round(matched.reduce((a, l) => a + (l.qtyVariance ?? 0) * unitPriceOf(l), 0) * 100) / 100,
    },
    aiUsed,
  };
}
