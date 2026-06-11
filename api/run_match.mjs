// Optional local smoke test for the EDI ingest + matcher.
// Build first (npm run build) then:  node run_match.mjs
//
// Prints file-by-file ingest counts, vendor breakdown, and exception
// totals so you can confirm parsers handle the data correctly.
import { ingest } from './dist/lib/edi/ingest.js';
import { runFullMatch } from './dist/lib/matcher.js';

const t0 = Date.now();
const r = ingest('./data/edi');
console.log(`ingest: ${Date.now() - t0}ms`);
for (const f of r.filesProcessed) console.log(`  ${f.file.padEnd(58)} ${f.type.padEnd(34)} count=${f.count}`);
console.log(`\nVendors: ${r.vendors.length} · POs: ${r.pos.length} · ASNs: ${r.asns.length} · Invoices: ${r.invoices.length}`);
const m = runFullMatch(r);
console.log(`match: ${m.durationMs}ms · ${m.results.length} results · ${m.exceptions.length} exceptions`);

const byStatus = new Map(); for (const x of m.results) byStatus.set(x.matchStatus, (byStatus.get(x.matchStatus) ?? 0) + 1);
console.log('\nStatus breakdown:'); for (const [k, v] of byStatus) console.log(`  ${k.padEnd(12)} ${v}`);
