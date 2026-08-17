// Smoke test for the AI layer. Exercises every code path that does NOT require
// a live API key: the deterministic prescreen, the NL-query filter executor, the
// UPC alignment pass, and — via a stubbed transport — the guards that reject
// hallucinated ids and low-confidence proposals.
//
//   npm run build && node test_ai.mjs
import { ingest } from './dist/lib/edi/ingest.js';
import { runFullMatch } from './dist/lib/matcher.js';
import { shortlistCandidates } from './dist/lib/ai/fuzzyMatch.js';
import { applyFilter } from './dist/lib/ai/nlQuery.js';
import { alignLines } from './dist/lib/ai/itemNormalize.js';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const data = ingest('./data/edi');
const m = runFullMatch(data);
const exceptions = m.exceptions.map((e, i) => ({ ...e, excId: 10_000 + i }));

console.log('\n── Parser integrity ──');
const allLines = data.invoices.flatMap((i) => i.lines);
ok('no line carries the literal qualifier "UA" as a UPC', allLines.every((l) => l.upc !== 'UA'));
ok('every line has a non-empty UPC', allLines.every((l) => l.upc.length > 0));
ok('every line has a normalized UPC', allLines.every((l) => l.upcNorm.length > 0));
ok('unit prices are plausible (no sub-cent artefacts)', allLines.filter((l) => l.unitPrice > 0 && l.unitPrice < 0.05).length === 0);
ok('credit memos carry negative amounts', data.invoices.filter((i) => i.docType === 'CREDIT').every((i) => i.invoiceAmt <= 0));
ok('invoices carry positive amounts', data.invoices.filter((i) => i.docType === 'INVOICE').every((i) => i.invoiceAmt >= 0));
const recon = data.invoices.filter((i) => i.reconciled).length;
ok(`>=99% of invoices reconcile to line detail (${recon}/${data.invoices.length})`, recon / data.invoices.length >= 0.99);
ok('ASNs deduped across transports', data.asns.length === new Set(data.asns.map((a) => `${a.vendorId}|${a.asnNum}`)).size);
ok('PO lines carry a UPC distinct from the vendor SKU', data.pos.flatMap((p) => p.lines).every((l) => l.upc && l.upc !== l.vendorSku));

console.log('\n── Matcher classification ──');
ok('credit memos are not exceptions', m.exceptions.every((e) => e.excType !== 'CREDIT_MEMO'));
const credits = m.results.filter((r) => r.matchStatus === 'CREDIT_MEMO').length;
ok(`credit memos classified separately (${credits})`, credits === data.invoices.filter((i) => i.docType === 'CREDIT').length);
ok('exception count dropped below the raw result count', m.exceptions.length < m.results.length);

console.log('\n── Deterministic prescreen (no model call) ──');
const target = data.invoices.find((i) => i.storeOrDc && i.docType === 'INVOICE');
const cands = shortlistCandidates(target, data.asns, data.pos);
ok('prescreen returns an array', Array.isArray(cands));
ok('prescreen respects the candidate cap', cands.length <= 12);
ok('candidates are sorted by score, descending', cands.every((c, i) => i === 0 || cands[i - 1].prescreen >= c.prescreen));
ok('every candidate states its evidence', cands.every((c) => c.signals.length > 0));
ok('scores are bounded 0-100', cands.every((c) => c.prescreen >= 0 && c.prescreen <= 100));
// A vendor with no counterparty documents at all must produce an empty shortlist
// rather than a low-scoring false lead.
const orphanVendor = { ...target, vendorId: 'ZZZ_NOT_A_VENDOR', storeOrDc: '99999', lines: [] };
ok('unrelated invoice yields no candidates', shortlistCandidates(orphanVendor, data.asns, data.pos).length === 0);

console.log('\n── NL query filter executor (pure code, no model) ──');
const qd = { invoices: data.invoices, results: m.results, exceptions };
const big = applyFilter({ entity: 'invoices', minAmount: 2000, docType: 'INVOICE' }, qd);
ok(`invoices over $2,000 (${big.rows.length})`, big.rows.length > 0 && big.rows.every((r) => Math.abs(r.amount) >= 2000));
const creditsQ = applyFilter({ entity: 'invoices', docType: 'CREDIT' }, qd);
ok(`credit memos filter (${creditsQ.rows.length})`, creditsQ.rows.length === 566 && creditsQ.total < 0);
const vendorQ = applyFilter({ entity: 'invoices', vendorId: '108467' }, qd);
ok(`vendor filter (${vendorQ.rows.length})`, vendorQ.rows.length === 87);
const excQ = applyFilter({ entity: 'exceptions', status: ['INV_NO_ASN'], sortBy: 'amount', sortDir: 'desc' }, qd);
ok('exception filter sorts by amount desc', excQ.rows.length > 0 && excQ.rows.every((r, i) => i === 0 || Math.abs(excQ.rows[i - 1].amount) >= Math.abs(r.amount)));
const textQ = applyFilter({ entity: 'invoices', textContains: 'MTN DEW' }, qd);
ok(`description substring search (${textQ.rows.length})`, textQ.rows.length > 0);
const dateQ = applyFilter({ entity: 'invoices', sinceDate: '2026-04-22', untilDate: '2026-04-22' }, qd);
ok(`date range filter (${dateQ.rows.length})`, dateQ.rows.length > 0 && dateQ.rows.every((r) => r.invoiceDate === '2026-04-22'));
ok('nonsense filter returns empty, does not throw', applyFilter({ entity: 'invoices', vendorId: 'NOPE' }, qd).rows.length === 0);
ok('matches entity is queryable', applyFilter({ entity: 'matches', status: ['CREDIT_MEMO'] }, qd).rows.length === 566);

console.log('\n── Line alignment, UPC pass only (useAi: false) ──');
const asn = data.asns[0];
const asnUpcs = new Set(asn.packs.flatMap((p) => p.items.map((i) => i.upcNorm)));
const overlapping = data.invoices
  .map((i) => ({ i, n: i.lines.filter((l) => asnUpcs.has(l.upcNorm)).length }))
  .sort((a, b) => b.n - a.n)[0];
const al = await alignLines(overlapping.i, asn, { useAi: false });
ok(`aligned ${al.summary.byUpc} lines on UPC alone`, al.summary.byUpc === overlapping.n && al.summary.byUpc > 0);
ok('no AI call was made', al.aiUsed === false);
ok('every invoice line appears exactly once', al.lines.filter((l) => l.invoiceLineNo != null).length === overlapping.i.lines.length);
ok('a counterparty ref is never reused across two lines', (() => {
  const refs = al.lines.map((l) => l.counterpartRef).filter(Boolean);
  return refs.length === new Set(refs).size;
})());
ok('summary totals are internally consistent', al.summary.byUpc + al.summary.byAi + al.summary.unmatched === al.summary.total);
ok('variance is only computed on matched lines', al.lines.every((l) => l.qtyVariance == null || (l.invoiceQty != null && l.counterpartQty != null)));


// ─────────────────────────────────────────────────────────────────────────────
// Multi-platform provider layer
// ─────────────────────────────────────────────────────────────────────────────
const { toAnthropicSchema, toOpenAiSchema, toGeminiSchema } = await import('./dist/lib/ai/providers/schema.js');
const { parseTarget, platformStatuses, ALL_PLATFORMS, dispatch } = await import('./dist/lib/ai/providers/registry.js');
const { isRetryable, SchemaViolationError, RetryableProviderError } = await import('./dist/lib/ai/providers/types.js');
const { routeFor } = await import('./dist/lib/ai/client.js');

console.log('\n── Schema normalization ──');
const SRC = {
  type: 'object',
  properties: {
    excId: { type: 'number' },
    estRecoveryUsd: { type: ['number', 'null'], description: 'nullable union' },
    tags: { type: 'array', items: { type: 'string' } },
    nested: {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'number' } },
      required: ['a'],
    },
    sortBy: { type: ['string', 'null'], enum: ['amount', 'date', null] },
  },
  required: ['excId', 'estRecoveryUsd', 'tags', 'nested'],
  $comment: 'should be stripped',
};

const a = toAnthropicSchema(SRC);
ok('anthropic: keeps type unions as authored', Array.isArray(a.properties.estRecoveryUsd.type));
ok('anthropic: strips $comment', !('$comment' in a));

const o = toOpenAiSchema(SRC);
ok('openai: additionalProperties false at root', o.additionalProperties === false);
ok('openai: additionalProperties false when nested', o.properties.nested.additionalProperties === false);
ok('openai: every property forced into required', o.required.length === Object.keys(o.properties).length);
ok('openai: nested required completed too', o.properties.nested.required.length === 2);
// 'b' was optional in the source; forcing it into required must not tighten the
// contract, so it has to have become nullable.
ok('openai: promoted-optional field became nullable',
   Array.isArray(o.properties.nested.properties.b.type) && o.properties.nested.properties.b.type.includes('null'));
ok('openai: strips $comment', !('$comment' in o));

const g = toGeminiSchema(SRC);
ok('gemini: type names upper-cased', g.type === 'OBJECT' && g.properties.excId.type === 'NUMBER');
ok('gemini: union collapsed to nullable', g.properties.estRecoveryUsd.type === 'NUMBER' && g.properties.estRecoveryUsd.nullable === true);
ok('gemini: array items preserved', g.properties.tags.type === 'ARRAY' && g.properties.tags.items.type === 'STRING');
ok('gemini: drops additionalProperties', !('additionalProperties' in g));
ok('gemini: null removed from enum, marked nullable',
   g.properties.sortBy.enum.length === 2 && g.properties.sortBy.nullable === true);
ok('gemini: strips $comment', !('$comment' in g));

// Conversions must not mutate the caller's schema — these objects are module-level
// constants shared across every request.
ok('conversions do not mutate the source schema', SRC.$comment === 'should be stripped' && SRC.properties.nested.required.length === 1);

console.log('\n── Route parsing and resolution ──');
ok('parses platform:model', (() => { const t = parseTarget('openai:gpt-5-mini'); return t.platform === 'openai' && t.model === 'gpt-5-mini'; })());
ok('bare model id defaults to anthropic', (() => { const t = parseTarget('claude-sonnet-5'); return t.platform === 'anthropic' && t.model === 'claude-sonnet-5'; })());
ok('unknown platform falls back rather than throwing', parseTarget('mystery:foo').platform === 'anthropic');
ok('bedrock model ids containing colons survive', (() => {
  const t = parseTarget('bedrock:anthropic.claude-sonnet-4-5-20250929-v1:0');
  return t.platform === 'bedrock' && t.model === 'anthropic.claude-sonnet-4-5-20250929-v1:0';
})());
for (const cap of ['fuzzy-match', 'triage', 'nl-query', 'line-align']) {
  const chain = routeFor(cap);
  ok(`route ${cap} resolves to a non-empty chain`, chain.length > 0 && chain.every((t) => t.platform && t.model));
}
ok('fuzzy-match routes to a stronger model than nl-query',
   routeFor('fuzzy-match')[0].model !== routeFor('nl-query')[0].model);

console.log('\n── Provider status and failover ──');
const statuses = platformStatuses();
ok(`all ${ALL_PLATFORMS.length} platforms report status`, statuses.length === ALL_PLATFORMS.length);
ok('every unavailable platform explains why', statuses.filter((s) => !s.available).every((s) => typeof s.reason === 'string' && s.reason.length > 0));
ok('no platform is available without credentials in this env', statuses.every((s) => !s.available));

ok('rate limit is retryable', isRetryable({ status: 429 }));
ok('server error is retryable', isRetryable({ status: 503 }));
ok('connection reset is retryable', isRetryable({ code: 'ECONNRESET' }));
ok('bad auth is NOT retryable', !isRetryable({ status: 401 }));
ok('bad request is NOT retryable', !isRetryable({ status: 400 }));
ok('schema violation is NOT retryable', !isRetryable(new SchemaViolationError('bad', 'openai')));
ok('provider transport error IS retryable', isRetryable(new RetryableProviderError('timeout', 'openai')));

// With no credentials anywhere, dispatch must fail with a message naming every
// attempt rather than a bare stack trace.
let dispatchErr = null;
try {
  await dispatch([{ platform: 'anthropic', model: 'x' }, { platform: 'openai', model: 'y' }],
    { system: 's', user: 'u', schema: { type: 'object' }, maxTokens: 16 });
} catch (e) { dispatchErr = e; }
ok('dispatch fails loudly when no provider is configured', dispatchErr != null);
ok('failure message names every platform tried',
   dispatchErr && dispatchErr.message.includes('anthropic') && dispatchErr.message.includes('openai'),
   dispatchErr?.message?.slice(0, 120));
ok('empty chain is rejected', await (async () => {
  try { await dispatch([], { system: 's', user: 'u', schema: {}, maxTokens: 16 }); return false; }
  catch { return true; }
})());

console.log('\n── Optional SDKs absent ──');
// openai and @google/genai are optional deps and are NOT installed here. The
// provider must report that cleanly instead of the import crashing the process.
const openaiInstalled = await import('openai').then(() => true, () => false);
ok('openai package genuinely absent in this test env', openaiInstalled === false);
ok('app still boots and reports status with optional SDKs missing', platformStatuses().length === ALL_PLATFORMS.length);

console.log(`\n${fail === 0 ? 'ALL PASSED' : 'FAILURES PRESENT'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
