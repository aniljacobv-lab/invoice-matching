import type { FastifyInstance } from 'fastify';
import type { MemoryStore } from '../store/memoryStore.js';
import { matchInvoice, requiredApprovalTier } from '../lib/matching.js';
import { config } from '../config.js';
import type { Invoice, InvoiceStatus } from '../types.js';

export async function invoiceRoutes(app: FastifyInstance, ds: MemoryStore) {
  // GET /invoices?status=
  app.get('/invoices', async (req) => {
    const q = req.query as any;
    const status = q?.status ? String(q.status) : undefined;
    return { invoices: ds.listInvoices(status ? { status } : undefined) };
  });

  // GET /invoices/:id — with its last match result if any.
  app.get('/invoices/:id', async (req, reply) => {
    const id = Number((req.params as any).id);
    const invoice = ds.getInvoice(id);
    if (!invoice) return reply.code(404).send({ error: 'not_found' });
    return { invoice, match: ds.getMatch(id) };
  });

  // POST /invoices/:id/match — run the matching engine, persist result.
  app.post('/invoices/:id/match', async (req, reply) => {
    const id = Number((req.params as any).id);
    const invoice = ds.getInvoice(id);
    if (!invoice) return reply.code(404).send({ error: 'not_found' });
    const po = invoice.poNumber ? ds.getPoByNumber(invoice.poNumber) : null;
    const grs = po ? ds.listGoodsReceipts(po.poId) : [];
    const mode = config.app.matching.matchMode;
    const result = matchInvoice({ invoice, po, grs, mode });
    ds.setMatch(result);
    // Auto-flip invoice status based on the result.
    const nextStatus: InvoiceStatus = result.computedStatus === 'MATCHED'
      ? (config.app.approvals.autoApproveCleanMatch ? 'APPROVED' : 'MATCHED')
      : 'EXCEPTION';
    ds.setInvoiceStatus(id, nextStatus);
    return { match: result, requiredTier: requiredApprovalTier(result.totalDollarImpact) };
  });

  // POST /invoices/:id/status  body: { status, notes? } — approve/reject/etc.
  app.post('/invoices/:id/status', async (req, reply) => {
    const id = Number((req.params as any).id);
    const body = (req.body as any) ?? {};
    const valid: InvoiceStatus[] = ['PENDING_MATCH', 'MATCHED', 'EXCEPTION', 'APPROVED', 'REJECTED', 'PAID'];
    if (!valid.includes(body.status)) return reply.code(400).send({ error: 'bad_request', message: `status must be one of ${valid.join(', ')}` });
    const inv = ds.setInvoiceStatus(id, body.status, body.notes ?? null);
    if (!inv) return reply.code(404).send({ error: 'not_found' });
    return inv;
  });

  // POST /invoices/match-all — run the engine across every PENDING_MATCH invoice.
  app.post('/invoices/match-all', async () => {
    const todo = ds.listInvoices().filter((i: Invoice) => i.status === 'PENDING_MATCH' || i.status === 'EXCEPTION');
    let matched = 0, exceptions = 0;
    for (const inv of todo) {
      const po = inv.poNumber ? ds.getPoByNumber(inv.poNumber) : null;
      const grs = po ? ds.listGoodsReceipts(po.poId) : [];
      const r = matchInvoice({ invoice: inv, po, grs, mode: config.app.matching.matchMode });
      ds.setMatch(r);
      const next: InvoiceStatus = r.computedStatus === 'MATCHED' ? 'MATCHED' : 'EXCEPTION';
      ds.setInvoiceStatus(inv.invoiceId, next);
      if (r.computedStatus === 'MATCHED') matched++; else exceptions++;
    }
    return { processed: todo.length, matched, exceptions };
  });
}
