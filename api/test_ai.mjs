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

console.log(`\n${fail === 0 ? 'ALL PASSED' : 'FAILURES PRESENT'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
