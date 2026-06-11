// PepsiCo PBC810RT flat-file invoice parser. Record format observed in the
// upload:
//
//   HDR<filler>  RE<remit-to-name>...                               (file header)
//   1 line per invoice header, then DTL/DAL/SAC records for that invoice,
//   then the next invoice header, etc.
//
// We don't get a clean record-type prefix on the header line itself — it begins
// with "HDR" + spaces and PepsiCo's reference data — so we anchor on the DTL
// (detail) lines and walk back/forward. The header line carries:
//   - invoice number (positions ~110-126)
//   - invoice date   (positions ~126-134)  YYYYMMDD
//   - terms text       ('Net 30 Days')
//   - gross / net cents
//   - store number   (last column block, '10501' etc.)
//
// We accept some shape variance — PepsiCo doesn't publish the spec — and fall
// through gracefully on rows we can't parse.

export interface ParsedFlat810Line { upc: string; uom: string; description: string; qty: number; unitCents: number; extCents: number; }
export interface ParsedFlat810 {
  invoiceNumber: string;
  invoiceCore: string;
  invoiceDate: string | null;
  vendorId: string;          // best-effort — flat file rarely carries it explicitly
  vendorName: string;        // from RE field on header
  storeNumber: string;
  totalCents: number | null;
  grossCents: number | null;
  netCents: number | null;
  taxCents: number | null;
  lines: ParsedFlat810Line[];
}

const stripCore = (n: string): string => (n.length >= 16 && /^\d{6}$/.test(n.slice(-6)) ? n.slice(0, -6) : n);
const num = (s: string): number => { const n = Number(s.trim()); return Number.isFinite(n) ? n : 0; };

export function parseFlat810File(raw: string): ParsedFlat810[] {
  // The file has CR-delimited records. Headers usually start with 'HDR'.
  const lines = raw.split(/\r?\n|\r/).filter((l) => l.length > 0);
  const invoices: ParsedFlat810[] = [];
  let cur: ParsedFlat810 | null = null;

  for (const ln of lines) {
    if (ln.startsWith('HDR')) {
      // New invoice header. Push the previous one.
      if (cur) invoices.push(cur);
      cur = parseHdr(ln);
    } else if (ln.startsWith('DTL') && cur) {
      const dtl = parseDtl(ln);
      if (dtl) cur.lines.push(dtl);
    } else if (ln.startsWith('SAC') && cur) {
      // SAC record carries a charge or allowance amount for the invoice.
      // SAC C090  00000000000000345000  → 'C090' = charge code; trailing field is signed cents.
      // We treat positive trailing amounts as additions to the invoice; tax not separated.
    } else if (ln.startsWith('DAL') && cur && cur.lines.length > 0) {
      // DAL = detail-allowance — carries the same UPC and an extended cents value that's
      // the line ext (qty × unit cost). We refresh extCents with this if larger / present.
      const dal = parseDal(ln);
      if (dal && dal.extCents > 0) {
        // Match on UPC: find the most recent line for this UPC and update ext if missing.
        for (let i = cur.lines.length - 1; i >= 0; i--) {
          if (cur.lines[i]!.upc === dal.upc) { cur.lines[i]!.extCents = dal.extCents; break; }
        }
      }
    }
  }
  if (cur) invoices.push(cur);
  return invoices;
}

function parseHdr(ln: string): ParsedFlat810 {
  // The HDR record is dense and column-positional. We're tolerant.
  // Vendor name lives at positions ~18-58 (slice).
  const vendorName = ln.slice(18, 58).trim();
  // Invoice number appears as a long numeric token; pick the first long digit run >= 10 chars.
  const invMatch = ln.match(/\b(\d{12,18})\b/);
  const invoiceNumber = invMatch ? invMatch[1]! : '';
  const invoiceCore = stripCore(invoiceNumber);
  // Invoice date YYYYMMDD that follows the invoice number block.
  const dateMatch = ln.match(/(\d{12,18})(\d{8})/);
  const invoiceDate = dateMatch ? `${dateMatch[2]!.slice(0,4)}-${dateMatch[2]!.slice(4,6)}-${dateMatch[2]!.slice(6,8)}` : null;
  // Total amount lives in the long zero-padded number after the terms text.
  // The format we see: '000000000000113500' is the gross in cents (1135.00). The
  // header has multiple of these; we take the largest as gross.
  const moneyTokens = [...ln.matchAll(/0{4,}(\d{4,})/g)].map((m) => num(m[1]!));
  const sortedMoney = [...moneyTokens].sort((a, b) => b - a);
  const grossCents = sortedMoney[0] ?? null;
  const totalCents = grossCents;
  const netCents   = sortedMoney[1] ?? null;
  const taxCents   = sortedMoney.find((x) => x > 0 && x < (grossCents ?? 1)) ?? null;
  // Store number: a 5-digit token near the end, preceded by 30+ spaces.
  const storeMatch = ln.match(/\s(\d{5})\s+\d{6,}\s*$/) ?? ln.match(/\b(\d{5})\b/g)?.slice(-1).map((s) => [null, s] as any)[0];
  const storeNumber = Array.isArray(storeMatch) ? (storeMatch[1] ?? '') : '';
  return { invoiceNumber, invoiceCore, invoiceDate, vendorId: '', vendorName, storeNumber, totalCents, grossCents, netCents, taxCents, lines: [] };
}

function parseDtl(ln: string): ParsedFlat810Line | null {
  // DTL        007800001352 CAUAFCRS GRP PET 20OZ 1P24C   ...
  // Columns: 0-3 'DTL', 3-11 pad, 11-23 UPC, 23-25 UOM, 25-27 sub, 27-77 desc, then 5 zero-padded numbers
  const upc = ln.slice(11, 23).trim();
  if (!upc) return null;
  const uom = ln.slice(23, 25).trim();
  const description = ln.slice(27, 77).trim();
  const nums = [...ln.matchAll(/(0{4,}\d{2,})/g)].map((m) => num(m[1]!));
  // Layout commonly: pack, ?, ?, ?, qty(cases), ?, ext(cents)
  const qty = nums.length >= 5 ? Math.round(nums[4]! / 1e10) : 0; // qty is leftmost; the cents formatting puts qty as e.g. 000000010000 (=1)
  const unitCents = nums.length >= 6 ? nums[5]! : 0;
  const extCents = nums.length >= 7 ? nums[6]! : 0;
  return { upc, uom, description, qty: qty || 1, unitCents, extCents };
}

function parseDal(ln: string): { upc: string; extCents: number } | null {
  // DAL        007800001352  F800  00000000000000371700
  const upc = ln.slice(11, 23).trim();
  const m = ln.match(/(\d{10,20})\s*$/);
  if (!upc || !m) return null;
  return { upc, extCents: num(m[1]!) };
}
