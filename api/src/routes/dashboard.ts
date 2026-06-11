import type { FastifyInstance } from 'fastify';
import type { MemoryStore } from '../store/memoryStore.js';
import { matchInvoice, requiredApprovalTier } from '../lib/matching.js';
import { config } from '../config.js';

export async function dashboardRoutes(app: FastifyInstance, ds: MemoryStore) {
  app.get('/dashboard', async () => {
    const invoices = ds.listInvoices();
    const counts: Record<string, number> = { PENDING_MATCH: 0, MATCHED: 0, EXCEPTION: 0, APPROVED: 0, REJECTED: 0, PAID: 0 };
    let dollarsAtRisk = 0, dollarsPendingPay = 0;
    const recent: any[] = [];

    for (const inv of invoices) {
      counts[inv.status] = (counts[inv.status] ?? 0) + 1;
      // Compute / refresh match impact for visible totals.
      const po = inv.poNumber ? ds.getPoByNumber(inv.poNumber) : null;
      const grs = po ? ds.listGoodsReceipts(po.poId) : [];
      const r = matchInvoice({ invoice: inv, po, grs, mode: config.app.matching.matchMode });
      ds.setMatch(r);
      if (r.computedStatus === 'EXCEPTION') dollarsAtRisk += r.totalDollarImpact;
      if (inv.status === 'APPROVED' || inv.status === 'MATCHED') dollarsPendingPay += inv.totalUsd;
      recent.push({
        invoiceId: inv.invoiceId, invoiceNumber: inv.invoiceNumber, vendorName: inv.vendorName,
        poNumber: inv.poNumber, status: inv.status, totalUsd: inv.totalUsd, receivedDate: inv.receivedDate,
        exceptionImpact: r.totalDollarImpact, exceptionLines: r.exceptionLines, requiredTier: requiredApprovalTier(r.totalDollarImpact),
      });
    }
    recent.sort((a, b) => b.receivedDate.localeCompare(a.receivedDate));

    return {
      totals: { invoices: invoices.length, dollarsAtRisk: Math.round(dollarsAtRisk * 100) / 100, dollarsPendingPay: Math.round(dollarsPendingPay * 100) / 100 },
      statusCounts: counts,
      recent: recent.slice(0, 10),
      generatedAt: new Date().toISOString(),
    };
  });
}
