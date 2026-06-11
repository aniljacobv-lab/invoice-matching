import type { Invoice, PurchaseOrder, GoodsReceipt, MatchResult, LineMatch, DiscrepancyKind } from '../types.js';
import { config } from '../config.js';

// ----------------------------------------------------------------------------
// 2-way / 3-way invoice matching.
//
//   2-way:  invoice <-> PO            (PO has the truth)
//   3-way:  invoice <-> PO <-> GR     (the receipt confirms what was delivered)
//
// For each invoice line we look up the matching PO line by SKU, then compute
// price + qty discrepancies against configured tolerances. 3-way additionally
// compares invoice qty to the GR's qty-received (covers short/over receipts).
// Each discrepancy carries a dollar impact so the UI can rank exceptions by
// $ at risk and route the largest to higher approval tiers.
// ----------------------------------------------------------------------------

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface MatchInput {
  invoice: Invoice;
  po: PurchaseOrder | null;        // null = invoice references PO that we can't find
  grs: GoodsReceipt[];             // 0..n receipts against that PO
  mode: 'TWO_WAY' | 'THREE_WAY';
}

export function matchInvoice(input: MatchInput): MatchResult {
  const { invoice, po, grs, mode } = input;
  const tol = config.app.matching;
  const lines: LineMatch[] = [];
  let totalImpact = 0;
  let exceptionLines = 0;

  // Aggregate GR qty per SKU across all receipts for this PO.
  const grQtyBySku = new Map<number, number>();
  const grLineNoBySku = new Map<number, number>();
  for (const gr of grs) for (const gl of gr.lines) {
    grQtyBySku.set(gl.sku, (grQtyBySku.get(gl.sku) ?? 0) + gl.qtyReceived);
    if (!grLineNoBySku.has(gl.sku)) grLineNoBySku.set(gl.sku, gl.lineNo);
  }
  const poBySku = new Map<number, { lineNo: number; qty: number; unitCost: number; description: string }>();
  if (po) for (const pl of po.lines) poBySku.set(pl.sku, { lineNo: pl.lineNo, qty: pl.qty, unitCost: pl.unitCost, description: pl.description });

  for (const il of invoice.lines) {
    const discrepancies: { kind: DiscrepancyKind; message: string; dollarImpact: number }[] = [];
    const pl = poBySku.get(il.sku);

    if (!po) {
      discrepancies.push({ kind: 'PO_NOT_FOUND', message: `Invoice references PO ${invoice.poNumber ?? '(none)'} which doesn't exist or wasn't found`, dollarImpact: il.amount });
    } else if (!pl) {
      discrepancies.push({ kind: 'SKU_NOT_ON_PO', message: `SKU ${il.sku} (${il.description}) is not on PO ${po.poNumber}`, dollarImpact: il.amount });
    } else {
      // Price tolerance check.
      const priceDelta = il.unitPrice - pl.unitCost;
      const priceTolUnit = Math.max(tol.absDollarTol / Math.max(1, il.qty), (tol.priceTolPct / 100) * pl.unitCost);
      if (Math.abs(priceDelta) > priceTolUnit) {
        discrepancies.push({
          kind: 'PRICE_DIFF',
          message: `Invoice unit $${il.unitPrice.toFixed(2)} vs PO unit $${pl.unitCost.toFixed(2)} (Δ ${priceDelta >= 0 ? '+' : ''}$${priceDelta.toFixed(2)})`,
          dollarImpact: round2(priceDelta * il.qty),
        });
      }
      // Quantity tolerance check.
      const qtyDelta = il.qty - pl.qty;
      const qtyTolUnits = (tol.qtyTolPct / 100) * pl.qty;
      if (qtyDelta > qtyTolUnits) {
        discrepancies.push({ kind: 'QTY_OVER', message: `Invoiced ${il.qty} but PO ordered ${pl.qty} (+${qtyDelta})`, dollarImpact: round2(qtyDelta * pl.unitCost) });
      } else if (qtyDelta < -qtyTolUnits) {
        discrepancies.push({ kind: 'QTY_UNDER', message: `Invoiced ${il.qty} but PO ordered ${pl.qty} (${qtyDelta})`, dollarImpact: round2(qtyDelta * pl.unitCost) });
      }
    }

    // 3-way: receipt check.
    let grQty: number | null = null;
    let grLineNo: number | null = null;
    if (mode === 'THREE_WAY' && pl) {
      grQty = grQtyBySku.get(il.sku) ?? 0;
      grLineNo = grLineNoBySku.get(il.sku) ?? null;
      if (grQty === 0) {
        discrepancies.push({ kind: 'NOT_RECEIVED', message: `Invoiced ${il.qty} units but no goods receipt exists for SKU ${il.sku}`, dollarImpact: il.amount });
      } else if (grQty < il.qty - (tol.qtyTolPct / 100) * il.qty) {
        const diff = il.qty - grQty;
        discrepancies.push({ kind: 'PARTIAL_RECEIPT', message: `Invoiced ${il.qty} but only ${grQty} received`, dollarImpact: round2(diff * il.unitPrice) });
      }
    }

    // Line amount sanity (qty * unitPrice should equal amount).
    const computedAmount = round2(il.qty * il.unitPrice);
    if (Math.abs(computedAmount - il.amount) > 0.02) {
      discrepancies.push({ kind: 'AMOUNT_DIFF', message: `Line total $${il.amount.toFixed(2)} doesn't match qty × unit ($${computedAmount.toFixed(2)})`, dollarImpact: round2(computedAmount - il.amount) });
    }

    if (discrepancies.length) exceptionLines++;
    totalImpact += discrepancies.reduce((a, d) => a + Math.abs(d.dollarImpact), 0);

    lines.push({
      invoiceLineNo: il.lineNo, sku: il.sku, description: il.description,
      poLineNo: pl?.lineNo ?? null, grLineNo,
      invoiceQty: il.qty, invoiceUnitPrice: il.unitPrice, invoiceAmount: il.amount,
      poQty: pl?.qty ?? null, poUnitCost: pl?.unitCost ?? null, poAmount: pl ? round2(pl.qty * pl.unitCost) : null,
      grQtyReceived: grQty,
      discrepancies,
    });
  }

  // Header-level checks.
  const vendorOk = !po || po.vendorId === invoice.vendorId;
  if (!vendorOk && po) {
    // attach VENDOR_MISMATCH to a synthetic first line if there isn't one already
    lines.unshift({
      invoiceLineNo: 0, sku: 0, description: '(header)',
      poLineNo: null, grLineNo: null,
      invoiceQty: 0, invoiceUnitPrice: 0, invoiceAmount: 0,
      poQty: null, poUnitCost: null, poAmount: null, grQtyReceived: null,
      discrepancies: [{ kind: 'VENDOR_MISMATCH', message: `Invoice vendor #${invoice.vendorId} (${invoice.vendorName}) ≠ PO vendor #${po.vendorId} (${po.vendorName})`, dollarImpact: invoice.totalUsd }],
    });
    exceptionLines++; totalImpact += invoice.totalUsd;
  }
  const totalsOk = po ? Math.abs(invoice.totalUsd - po.totalUsd) <= Math.max(tol.absDollarTol, 0.005 * po.totalUsd) : false;

  const cleanLines = lines.filter((l) => l.discrepancies.length === 0).length;
  const computedStatus = exceptionLines === 0 ? 'MATCHED' : 'EXCEPTION';

  // Rank the top discrepancy kinds for quick UI badges.
  const kindCount = new Map<DiscrepancyKind, number>();
  for (const l of lines) for (const d of l.discrepancies) kindCount.set(d.kind, (kindCount.get(d.kind) ?? 0) + 1);
  const topDiscrepancyKinds = [...kindCount.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);

  return {
    invoiceId: invoice.invoiceId, invoiceNumber: invoice.invoiceNumber,
    poId: po?.poId ?? null, poNumber: po?.poNumber ?? invoice.poNumber ?? null,
    grId: grs[0]?.grId ?? null,
    vendorOk, totalsOk, mode,
    cleanLines, exceptionLines,
    totalDollarImpact: round2(totalImpact),
    computedStatus,
    lines, topDiscrepancyKinds,
    matchedAt: new Date().toISOString(),
  };
}

// Pick the required approval tier from the exception $ impact.
export function requiredApprovalTier(impactUsd: number): number {
  let tier = 1;
  for (const t of config.app.approvals.thresholds) if (impactUsd >= t.exceptionUsd && t.tier > tier) tier = t.tier;
  return Math.max(1, Math.min(4, tier));
}
