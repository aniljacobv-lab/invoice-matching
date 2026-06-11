import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface MatchingConfig {
  priceTolPct: number;       // +/- percent of unit cost
  qtyTolPct: number;         // +/- percent of ordered qty
  absDollarTol: number;      // absolute $ tolerance ceiling
  matchMode: 'TWO_WAY' | 'THREE_WAY';
}
export interface ApprovalThreshold { tier: number; exceptionUsd: number; }
export interface ApprovalsConfig {
  autoApproveCleanMatch: boolean;
  thresholds: ApprovalThreshold[];
}
export interface AppConfig {
  matching: MatchingConfig;
  approvals: ApprovalsConfig;
  ai: { model: string; maxTokens: number };
}

const DEFAULTS: AppConfig = {
  matching: { priceTolPct: 2.0, qtyTolPct: 5.0, absDollarTol: 25.0, matchMode: 'THREE_WAY' },
  approvals: { autoApproveCleanMatch: false, thresholds: [
    { tier: 2, exceptionUsd: 1000 }, { tier: 3, exceptionUsd: 10000 }, { tier: 4, exceptionUsd: 50000 },
  ] },
  ai: { model: 'claude-sonnet-4-6', maxTokens: 1024 },
};

function loadAppConfig(): AppConfig {
  try {
    const raw = JSON.parse(readFileSync(resolve(process.cwd(), 'config', 'app.config.json'), 'utf8'));
    return { ...DEFAULTS, ...raw,
      matching: { ...DEFAULTS.matching, ...(raw.matching ?? {}) },
      approvals: { ...DEFAULTS.approvals, ...(raw.approvals ?? {}) },
      ai: { ...DEFAULTS.ai, ...(raw.ai ?? {}) },
    };
  } catch { return DEFAULTS; }
}
const app = loadAppConfig();
const numEnv = (k: string, d: number) => (process.env[k] != null && process.env[k] !== '' ? Number(process.env[k]) : d);
app.matching.priceTolPct = numEnv('MATCH_PRICE_TOL_PCT', app.matching.priceTolPct);
app.matching.qtyTolPct   = numEnv('MATCH_QTY_TOL_PCT', app.matching.qtyTolPct);
app.matching.absDollarTol = numEnv('MATCH_ABS_TOL_USD', app.matching.absDollarTol);

export const config = {
  port: Number(process.env.PORT ?? 3001),
  host: process.env.HOST ?? '0.0.0.0',
  dataDir: process.env.DATA_DIR ?? 'data',
  anthropic: { apiKey: process.env.ANTHROPIC_API_KEY ?? '', model: app.ai.model },
  app,
} as const;
export type Config = typeof config;
