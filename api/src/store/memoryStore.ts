import { resolve } from 'node:path';
import { ingest } from '../lib/edi/ingest.js';
import { runFullMatch } from '../lib/matcher.js';
import type {
  Vendor, PurchaseOrder, AdvanceShipNotice, Invoice,
  MatchResult, MatchException, RunLog, ExceptionStatus,
} from '../types.js';

// In-memory EDI store. Boots by reading api/data/edi/*, running the matcher,
// keeping everything indexed for the REST layer.
export class MemoryStore {
  private vendors: Vendor[] = [];
  private pos: PurchaseOrder[] = [];
  private asns: AdvanceShipNotice[] = [];
  private invoices: Invoice[] = [];
  private results: MatchResult[] = [];
  private exceptions: MatchException[] = [];
  private runs: RunLog[] = [];
  private runSeq = 1;
  private excSeq = 10_000;
  private filesProcessed: { file: string; type: string; count: number }[] = [];

  async init(): Promise<void> {
    const start = Date.now();
    const dir = resolve(process.cwd(), 'data', 'edi');
    const ing = ingest(dir);
    this.vendors = ing.vendors; this.pos = ing.pos; this.asns = ing.asns;
    this.invoices = ing.invoices; this.filesProcessed = ing.filesProcessed;

    const run: RunLog = {
      runId: this.runSeq++, runType: 'FULL', startedAt: new Date().toISOString(),
      endedAt: null, posProcessed: 0, asnsProcessed: 0, invsProcessed: 0,
      matchesCreated: 0, exceptionsOpen: 0, status: 'RUNNING', errorMsg: null,
    };
    this.runs.push(run);
    try {
      const out = runFullMatch({ pos: this.pos, asns: this.asns, invoices: this.invoices, vendors: this.vendors });
      // Stamp the run id onto every result; reassign exception ids to a unique seq.
      this.results = out.results.map((r) => ({ ...r, runId: run.runId }));
      this.exceptions = out.exceptions.map((e) => ({ ...e, excId: this.excSeq++ }));
      run.posProcessed = out.posProcessed;
      run.asnsProcessed = out.asnsProcessed;
      run.invsProcessed = out.invsProcessed;
      run.matchesCreated = out.results.length;
      run.exceptionsOpen = out.exceptions.length;
      run.endedAt = new Date().toISOString();
      run.status = 'OK';
    } catch (e: any) {
      run.status = 'ERROR'; run.endedAt = new Date().toISOString(); run.errorMsg = (e?.message ?? String(e)).slice(0, 2000);
    }
    // console.info every important number so cold-start logs tell the story.
    // eslint-disable-next-line no-console
    console.info(`[edi-match] ingested ${this.vendors.length} vendors, ${this.pos.length} POs, ${this.asns.length} ASNs, ${this.invoices.length} invoices`);
    // eslint-disable-next-line no-console
    console.info(`[edi-match] matched in ${Date.now() - start}ms · ${this.results.length} results · ${this.exceptions.length} exceptions`);
  }

  // --- reads ---
  listVendors(): Vendor[] { return [...this.vendors]; }
  listPOs(): PurchaseOrder[] { return [...this.pos]; }
  getPO(poNum: string): PurchaseOrder | null { return this.pos.find((p) => p.poNum === poNum) ?? null; }
  listASNs(): AdvanceShipNotice[] { return [...this.asns]; }
  getASN(asnNum: string): AdvanceShipNotice | null { return this.asns.find((a) => a.asnNum === asnNum) ?? null; }
  listInvoices(): Invoice[] { return [...this.invoices]; }
  getInvoice(invoiceNum: string): Invoice | null { return this.invoices.find((i) => i.invoiceNum === invoiceNum) ?? null; }
  listResults(): MatchResult[] { return [...this.results]; }
  listExceptions(filter?: { vendor?: string; severity?: string; days?: number; status?: string }): MatchException[] {
    const cutoff = filter?.days != null ? Date.now() - filter.days * 86400_000 : null;
    return this.exceptions.filter((e) => {
      if (filter?.vendor && e.vendorId !== filter.vendor) return false;
      if (filter?.severity && e.severity !== filter.severity) return false;
      if (filter?.status && e.status !== filter.status) return false;
      if (cutoff != null && new Date(e.createdAt).getTime() < cutoff) return false;
      return true;
    });
  }
  getException(excId: number): MatchException | null { return this.exceptions.find((e) => e.excId === excId) ?? null; }
  listRuns(): RunLog[] { return [...this.runs]; }
  getFilesProcessed() { return [...this.filesProcessed]; }

  // --- mutations ---
  async runFull(): Promise<RunLog> {
    const run: RunLog = {
      runId: this.runSeq++, runType: 'FULL', startedAt: new Date().toISOString(),
      endedAt: null, posProcessed: 0, asnsProcessed: 0, invsProcessed: 0,
      matchesCreated: 0, exceptionsOpen: 0, status: 'RUNNING', errorMsg: null,
    };
    this.runs.push(run);
    try {
      const out = runFullMatch({ pos: this.pos, asns: this.asns, invoices: this.invoices, vendors: this.vendors });
      // Re-write results & exceptions for this run.
      this.results = out.results.map((r) => ({ ...r, runId: run.runId }));
      // Preserve resolution state for existing exceptions when possible (key on matchId).
      const oldByMatch = new Map(this.exceptions.map((e) => [e.matchId, e]));
      this.exceptions = out.exceptions.map((e) => {
        const old = oldByMatch.get(e.matchId);
        const next: MatchException = { ...e, excId: old?.excId ?? this.excSeq++ };
        if (old) { next.status = old.status; next.assignedTo = old.assignedTo; next.resolvedAt = old.resolvedAt; next.resolvedBy = old.resolvedBy; next.resolutionNote = old.resolutionNote; }
        return next;
      });
      run.posProcessed = out.posProcessed; run.asnsProcessed = out.asnsProcessed;
      run.invsProcessed = out.invsProcessed; run.matchesCreated = out.results.length;
      run.exceptionsOpen = this.exceptions.filter((e) => e.status === 'OPEN').length;
      run.endedAt = new Date().toISOString(); run.status = 'OK';
    } catch (e: any) {
      run.status = 'ERROR'; run.endedAt = new Date().toISOString(); run.errorMsg = (e?.message ?? String(e)).slice(0, 2000);
    }
    return run;
  }

  closeException(excId: number, status: ExceptionStatus, resolver: string, note: string | null): MatchException | null {
    const e = this.exceptions.find((x) => x.excId === excId);
    if (!e) return null;
    e.status = status; e.resolvedBy = resolver; e.resolutionNote = note;
    if (status === 'RESOLVED' || status === 'WRITTEN_OFF') e.resolvedAt = new Date().toISOString();
    return e;
  }
}
