import type { FastifyInstance } from 'fastify';
import type { MemoryStore } from '../store/memoryStore.js';
import { aiStatus, aiUsage, cacheStats, clearAiCache, aiPlatformDetail, AiUnavailableError } from '../lib/ai/client.js';
import { fuzzyMatchInvoice, shortlistCandidates } from '../lib/ai/fuzzyMatch.js';
import { triageExceptions } from '../lib/ai/triage.js';
import { nlQuery } from '../lib/ai/nlQuery.js';
import { alignLines } from '../lib/ai/itemNormalize.js';
import { config } from '../config.js';

// ─────────────────────────────────────────────────────────────────────────────
// AI endpoints, mounted under /api/ai/*.
//
// Every route degrades rather than fails: with no ANTHROPIC_API_KEY they return
// 200 with { available: false, reason } so the UI can render an explanatory
// panel instead of an error toast. The deterministic matcher is never affected.
//
// Nothing here mutates the ledger. These endpoints return proposals only —
// closing an exception still goes through POST /match/v1/exceptions/:id/close
// with a named human resolver.
// ─────────────────────────────────────────────────────────────────────────────

export async function aiRoutes(app: FastifyInstance, ds: MemoryStore) {
  const unavailable = (reply: any, e: unknown) => {
    if (e instanceof AiUnavailableError) {
      return reply.code(200).send({ available: false, reason: e.message });
    }
    app.log.error({ err: e }, 'ai route failed');
    const msg = e instanceof Error ? e.message : String(e);
    return reply.code(502).send({ available: true, error: 'ai_call_failed', message: msg });
  };

  // ──── GET /ai/status ─────────────────────────────────────────────────────
  app.get('/ai/status', async () => ({
    ...aiStatus(),
    ...aiPlatformDetail(),
    usage: aiUsage(),
    cache: cacheStats(),
    settings: {
      maxCandidates: config.app.ai.maxCandidates,
      minConfidence: config.app.ai.minConfidence,
      maxTokens: config.app.ai.maxTokens,
    },
    capabilities: ['fuzzy-match', 'exception-triage', 'nl-query', 'line-alignment'],
  }));

  app.post('/ai/cache/clear', async () => { clearAiCache(); return { cleared: true }; });

  // ──── GET /ai/candidates/:invoiceNum ─────────────────────────────────────
  // Deterministic shortlist only — no API call, no key required. Useful on its
  // own, and it shows exactly what the model would be given.
  app.get('/ai/candidates/:invoiceNum', async (req, reply) => {
    const num = String((req.params as any).invoiceNum);
    const inv = ds.getInvoice(num);
    if (!inv) return reply.code(404).send({ error: 'not_found' });
    return {
      invoiceNum: num,
      candidates: shortlistCandidates(inv, ds.listASNs(), ds.listPOs()),
      note: 'Deterministic prescreen. No model call was made.',
    };
  });

  // ──── POST /ai/fuzzy-match/:invoiceNum ───────────────────────────────────
  app.post('/ai/fuzzy-match/:invoiceNum', async (req, reply) => {
    const num = String((req.params as any).invoiceNum);
    const inv = ds.getInvoice(num);
    if (!inv) return reply.code(404).send({ error: 'not_found' });
    try {
      const out = await fuzzyMatchInvoice(inv, ds.listASNs(), ds.listPOs());
      return { available: true, ...out };
    } catch (e) { return unavailable(reply, e); }
  });

  // ──── POST /ai/triage ────────────────────────────────────────────────────
  app.post('/ai/triage', async (req, reply) => {
    const body = (req.body as any) ?? {};
    const limit = Math.min(Number(body.limit ?? 25), 60);
    const exceptions = ds.listExceptions({
      status: 'OPEN',
      vendor: body.vendor ? String(body.vendor) : undefined,
      severity: body.severity ? String(body.severity).toUpperCase() : undefined,
    });
    try {
      const out = await triageExceptions(
        { exceptions, results: ds.listResults(), invoices: ds.listInvoices(), vendors: ds.listVendors() },
        limit,
      );
      return { available: true, queueSize: exceptions.length, ...out };
    } catch (e) { return unavailable(reply, e); }
  });

  // ──── POST /ai/query ─────────────────────────────────────────────────────
  app.post('/ai/query', async (req, reply) => {
    const q = String(((req.body as any) ?? {}).question ?? '').trim();
    if (!q) return reply.code(400).send({ error: 'bad_request', message: 'question is required' });
    if (q.length > 1000) return reply.code(400).send({ error: 'bad_request', message: 'question too long' });
    try {
      const out = await nlQuery(
        q,
        { invoices: ds.listInvoices(), results: ds.listResults(), exceptions: ds.listExceptions({ status: 'OPEN' }) },
        new Date().toISOString().slice(0, 10),
      );
      return { available: true, ...out };
    } catch (e) { return unavailable(reply, e); }
  });

  // ──── POST /ai/align/:invoiceNum ─────────────────────────────────────────
  // Line-level alignment against an ASN or PO. `?counterpart=` picks the doc;
  // otherwise we use whatever the matcher already linked.
  app.post('/ai/align/:invoiceNum', async (req, reply) => {
    const num = String((req.params as any).invoiceNum);
    const wanted = (req.query as any)?.counterpart ? String((req.query as any).counterpart) : null;
    const inv = ds.getInvoice(num);
    if (!inv) return reply.code(404).send({ error: 'not_found' });

    const counterpart =
      (wanted ? (ds.getASN(wanted) ?? ds.getPO(wanted)) : null) ??
      ds.listASNs().find((a) => a.refInvoiceNum === inv.invoiceCore && a.vendorId === inv.vendorId) ??
      (inv.poNum ? ds.getPO(inv.poNum) : null);

    if (!counterpart) {
      return reply.code(409).send({
        error: 'no_counterpart',
        message: 'No ASN or PO is linked to this invoice. Run fuzzy matching first to propose one, then pass ?counterpart=<id>.',
      });
    }
    try {
      const out = await alignLines(inv, counterpart);
      return { available: true, ...out };
    } catch (e) { return unavailable(reply, e); }
  });
}
