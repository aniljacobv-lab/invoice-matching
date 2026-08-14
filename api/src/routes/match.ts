import type { FastifyInstance } from 'fastify';
import type { MemoryStore } from '../store/memoryStore.js';
import type { ExceptionStatus, MatchStatus } from '../types.js';

// REST API matching the ORDS contract from pkg_edi_match.sql Section 7:
//   GET  /match/v1/summary
//   GET  /match/v1/exceptions?vendor=&severity=&days=
//   POST /match/v1/exceptions/:id/close
//   POST /match/v1/runs/full
// We additionally expose the underlying data for drill-down panels:
//   GET  /vendors  /pos  /asns  /invoices  /matches  /raw

export async function matchRoutes(app: FastifyInstance, ds: MemoryStore) {
  // ──── /match/v1/summary ──────────────────────────────────────────────────
  // Aggregate counts + totals across all results, plus a per-status breakdown
  // and per-vendor table. The shape directly feeds EdiMatch.jsx KPI + status +
  // vendor panels.
  app.get('/match/v1/summary', async () => {
    const pos = ds.listPOs(), asns = ds.listASNs(), invs = ds.listInvoices();
    const results = ds.listResults(), exceptions = ds.listExceptions({ status: 'OPEN' });
    const lastRun = ds.listRuns().slice(-1)[0] ?? null;

    const statuses = ['3WAY', '2WAY', 'QTY_VAR', 'AMT_VAR', 'INV_NO_ASN', 'ASN_NO_INV', 'PO_NO_RCPT', 'CREDIT_MEMO'] as const;
    const statusBreakdown = statuses.map((code) => {
      const rows = results.filter((r) => r.matchStatus === code);
      const total = results.length || 1;
      return { code, label: labelFor(code), count: rows.length, pct: Math.round(rows.length / total * 1000) / 10 };
    });

    const vendors = ds.listVendors().map((v) => {
      const vPos    = pos.filter((x) => x.vendorId === v.vendorId);
      const vAsns   = asns.filter((x) => x.vendorId === v.vendorId);
      const vInvs   = invs.filter((x) => x.vendorId === v.vendorId);
      const vResults = results.filter((r) => r.vendorId === v.vendorId);
      // Credit memos are excluded from the denominator: they are not matchable
      // work, so counting them would inflate (or deflate) the clean-match rate.
      const scored  = vResults.filter((r) => r.matchStatus !== 'CREDIT_MEMO');
      const clean   = scored.filter((r) => r.matchStatus === '3WAY' || r.matchStatus === '2WAY').length;
      const rate    = scored.length ? Math.round(clean / scored.length * 1000) / 10 : 0;
      const poAmt   = vPos.reduce((a, x) => a + x.totalAmt, 0);
      const gross   = vInvs.reduce((a, x) => a + x.invoiceAmt, 0);
      const net     = vInvs.reduce((a, x) => a + x.invoiceAmt, 0);
      const cartons = vAsns.reduce((a, x) => a + x.cartonCount, 0);
      return {
        id: v.vendorId, name: v.vendorName, flow: v.flow,
        pos: vPos.length, po_amt: poAmt,
        asns: vAsns.length, cartons,
        invs: vInvs.length, gross, net,
        rate,
      };
    }).sort((a, b) => b.invs - a.invs);

    const scorable = results.filter((r) => r.matchStatus !== 'CREDIT_MEMO');
    const matchRate = scorable.length
      ? Math.round(scorable.filter((r) => r.matchStatus === '3WAY' || r.matchStatus === '2WAY').length / scorable.length * 1000) / 10
      : 0;

    return {
      summary: {
        pos_sent:        pos.length,
        asns_received:   asns.length,
        invs_received:   invs.length,
        cartons:         asns.reduce((a, x) => a + x.cartonCount, 0),
        po_lines:        pos.reduce((a, x) => a + x.lineCount, 0),
        asn_lines:       asns.reduce((a, x) => a + x.lineCount, 0),
        inv_lines:       invs.reduce((a, x) => a + x.lineCount, 0),
        po_amt:          pos.reduce((a, x) => a + x.totalAmt, 0),
        inv_gross:       invs.filter((x) => x.docType !== 'CREDIT').reduce((a, x) => a + x.invoiceAmt, 0),
        inv_net:         invs.reduce((a, x) => a + x.invoiceAmt, 0),
        credit_memos:    invs.filter((x) => x.docType === 'CREDIT').length,
        credit_amt:      invs.filter((x) => x.docType === 'CREDIT').reduce((a, x) => a + x.invoiceAmt, 0),
        unreconciled:    invs.filter((x) => !x.reconciled).length,
        match_rate:      matchRate,
        exceptions_open: exceptions.length,
        last_run:        lastRun?.endedAt ?? lastRun?.startedAt ?? null,
      },
      statuses: statusBreakdown,
      vendors,
      filesProcessed: ds.getFilesProcessed(),
    };
  });

  // ──── /match/v1/exceptions ───────────────────────────────────────────────
  app.get('/match/v1/exceptions', async (req) => {
    const q = req.query as any;
    const vendor = q?.vendor ? String(q.vendor) : undefined;
    const severity = q?.severity ? String(q.severity).toUpperCase() : undefined;
    const days = q?.days ? Number(q.days) : undefined;
    const status = (q?.status ? String(q.status).toUpperCase() : 'OPEN');
    const exceptions = ds.listExceptions({ vendor, severity, days, status });
    const now = Date.now();
    return {
      exceptions: exceptions.map((e) => ({
        exc_id: e.excId,
        severity: e.severity,
        exc_type: e.excType,
        flow: e.flow === 'DC' ? 'DC Supply' : 'DSD',
        vendor_id: e.vendorId,
        store: e.storeOrDc,
        po_num: e.poNum ?? '—',
        asn_num: e.asnNum ?? '—',
        invoice_num: e.invoiceNum ?? '—',
        exc_amount: e.excAmount,
        recommended_action: e.recommendedAction,
        age_days: Math.max(0, Math.floor((now - new Date(e.createdAt).getTime()) / 86400_000)),
        status: e.status,
        assigned_to: e.assignedTo,
        resolution_note: e.resolutionNote,
      })),
    };
  });

  // ──── POST /match/v1/exceptions/:id/close ────────────────────────────────
  app.post('/match/v1/exceptions/:id/close', async (req, reply) => {
    const id = Number((req.params as any).id);
    const body = (req.body as any) ?? {};
    const status = String(body.status ?? '').toUpperCase() as ExceptionStatus;
    if (!['RESOLVED', 'WRITTEN_OFF', 'ASSIGNED'].includes(status)) {
      return reply.code(400).send({ error: 'bad_request', message: `status must be RESOLVED | WRITTEN_OFF | ASSIGNED` });
    }
    const resolver = String(body.resolver ?? req.headers['x-user'] ?? 'unknown');
    const note = body.note ?? null;
    const e = ds.closeException(id, status, resolver, note);
    if (!e) return reply.code(404).send({ error: 'not_found' });
    return e;
  });

  // ──── POST /match/v1/runs/full ───────────────────────────────────────────
  app.post('/match/v1/runs/full', async (_req, reply) => {
    const run = await ds.runFull();
    return reply.code(202).send(run);
  });

  // ──── drill-down helpers (not in the ORDS contract — useful for the UI) ──
  app.get('/match/v1/vendors',  async () => ({ vendors: ds.listVendors() }));
  app.get('/match/v1/pos',      async () => ({ pos: ds.listPOs() }));
  app.get('/match/v1/asns',     async () => ({ asns: ds.listASNs() }));
  app.get('/match/v1/invoices', async () => ({ invoices: ds.listInvoices() }));
  app.get('/match/v1/runs',     async () => ({ runs: ds.listRuns() }));
  app.get('/match/v1/matches/:id', async (req, reply) => {
    const id = Number((req.params as any).id);
    const m = ds.listResults().find((x) => x.matchId === id);
    if (!m) return reply.code(404).send({ error: 'not_found' });
    return m;
  });
  app.get('/match/v1/invoices/:num', async (req, reply) => {
    const num = String((req.params as any).num);
    const inv = ds.getInvoice(num); if (!inv) return reply.code(404).send({ error: 'not_found' });
    const asn = ds.listASNs().find((a) => a.refInvoiceNum === inv.invoiceCore && a.vendorId === inv.vendorId);
    const po = inv.poNum ? ds.getPO(inv.poNum) : null;
    const match = ds.listResults().find((r) => r.invoiceNum === inv.invoiceNum) ?? null;
    return { invoice: inv, asn, po, match };
  });
}

function labelFor(code: MatchStatus): string {
  return code === '3WAY' ? '3-Way Match'
    : code === '2WAY' ? '2-Way (ASN=Inv)'
    : code === 'QTY_VAR' ? 'Qty Variance'
    : code === 'AMT_VAR' ? '$ Variance'
    : code === 'INV_NO_ASN' ? 'Invoice w/o ASN'
    : code === 'ASN_NO_INV' ? 'ASN w/o Invoice'
    : code === 'PO_NO_RCPT' ? 'PO No Receipt'
    : code === 'CREDIT_MEMO' ? 'Credit Memo'
    : code;
}
