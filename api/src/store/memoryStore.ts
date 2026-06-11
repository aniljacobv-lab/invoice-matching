import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Vendor, PurchaseOrder, GoodsReceipt, Invoice, MatchResult } from '../types.js';
import { config } from '../config.js';

// ----------------------------------------------------------------------------
// In-memory store. Seeds from api/data/*.json on startup. A production build
// swaps this for Postgres (schema in docs); the public interface stays.
// ----------------------------------------------------------------------------
export class MemoryStore {
  private vendors: Vendor[] = [];
  private pos: PurchaseOrder[] = [];
  private grs: GoodsReceipt[] = [];
  private invoices: Invoice[] = [];
  private matches = new Map<number, MatchResult>();   // invoiceId -> last match

  private dataPath(name: string): string {
    return resolve(process.cwd(), config.dataDir, name);
  }

  async init(): Promise<void> {
    this.vendors = this.loadJson<Vendor[]>('vendors.json') ?? [];
    this.pos = this.loadJson<PurchaseOrder[]>('purchase-orders.json') ?? [];
    this.grs = this.loadJson<GoodsReceipt[]>('goods-receipts.json') ?? [];
    this.invoices = this.loadJson<Invoice[]>('invoices.json') ?? [];
    // Hydrate vendorName from vendorId if missing
    const byVendorId = new Map(this.vendors.map((v) => [v.vendorId, v.vendorName]));
    for (const p of this.pos) p.vendorName = p.vendorName ?? byVendorId.get(p.vendorId) ?? '';
    for (const i of this.invoices) i.vendorName = i.vendorName ?? byVendorId.get(i.vendorId) ?? '';
  }
  private loadJson<T>(name: string): T | null {
    const p = this.dataPath(name);
    if (!existsSync(p)) return null;
    try { return JSON.parse(readFileSync(p, 'utf8')) as T; } catch { return null; }
  }

  // --- reads ---
  listVendors(): Vendor[] { return [...this.vendors]; }
  listPurchaseOrders(): PurchaseOrder[] { return this.pos.map((p) => ({ ...p, lines: p.lines.map((l) => ({ ...l })) })); }
  getPurchaseOrder(poId: number): PurchaseOrder | null { const p = this.pos.find((x) => x.poId === poId); return p ? { ...p, lines: p.lines.map((l) => ({ ...l })) } : null; }
  getPoByNumber(poNumber: string): PurchaseOrder | null { const p = this.pos.find((x) => x.poNumber === poNumber); return p ? { ...p, lines: p.lines.map((l) => ({ ...l })) } : null; }
  listGoodsReceipts(poId?: number): GoodsReceipt[] { return this.grs.filter((g) => poId == null || g.poId === poId).map((g) => ({ ...g, lines: g.lines.map((l) => ({ ...l })) })); }
  listInvoices(filter?: { status?: string }): Invoice[] {
    let xs = [...this.invoices];
    if (filter?.status) xs = xs.filter((i) => i.status === filter.status);
    return xs.map((i) => ({ ...i, lines: i.lines.map((l) => ({ ...l })) }));
  }
  getInvoice(invoiceId: number): Invoice | null { const i = this.invoices.find((x) => x.invoiceId === invoiceId); return i ? { ...i, lines: i.lines.map((l) => ({ ...l })) } : null; }

  // --- match storage ---
  setMatch(m: MatchResult): void { this.matches.set(m.invoiceId, m); }
  getMatch(invoiceId: number): MatchResult | null { return this.matches.get(invoiceId) ?? null; }
  listMatches(): MatchResult[] { return [...this.matches.values()]; }

  // --- mutate invoice ---
  setInvoiceStatus(invoiceId: number, status: Invoice['status'], notes?: string | null): Invoice | null {
    const i = this.invoices.find((x) => x.invoiceId === invoiceId);
    if (!i) return null;
    i.status = status;
    if (notes !== undefined) i.notes = notes;
    return { ...i, lines: i.lines.map((l) => ({ ...l })) };
  }
}
