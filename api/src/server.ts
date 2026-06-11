import { readFileSync, watch, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { MemoryStore } from './store/memoryStore.js';
import { matchRoutes } from './routes/match.js';

function findWebDist(): string | null {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const candidates = [
    resolve(here, '../../web/dist'),
    resolve(process.cwd(), '../web/dist'),
    resolve(process.cwd(), 'web/dist'),
    resolve(process.cwd(), 'public'),
  ];
  for (const c of candidates) if (existsSync(join(c, 'index.html'))) return c;
  return null;
}
function reloadEnv(log: (m: string) => void) {
  try {
    const path = resolve(process.cwd(), '.env');
    const text = readFileSync(path, 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const key = m[1]!;
      let val = m[2]!.trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      process.env[key] = val;
    }
    log('reloaded .env');
  } catch { /* ignore */ }
}

async function main() {
  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });

  const ds = new MemoryStore();
  await ds.init();

  app.get('/health', async () => ({ ok: true, vendors: ds.listVendors().length, invoices: ds.listInvoices().length }));

  await app.register(async (api) => {
    api.get('/health', async () => ({ ok: true }));
    api.get('/config', async () => ({ matching: config.app.matching, approvals: config.app.approvals }));
    await matchRoutes(api, ds);
  }, { prefix: '/api' });

  const webDist = findWebDist();
  if (webDist) {
    app.log.info(`serving static SPA from ${webDist}`);
    await app.register(fastifyStatic, { root: webDist, prefix: '/', wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/health')) {
        return reply.type('text/html').send(readFileSync(join(webDist, 'index.html'), 'utf8'));
      }
      return reply.code(404).send({ error: 'not_found' });
    });
  } else {
    app.log.info('no web bundle — API-only mode');
  }

  try {
    const envPath = resolve(process.cwd(), '.env');
    let t: NodeJS.Timeout | null = null;
    watch(envPath, () => { if (t) clearTimeout(t); t = setTimeout(() => reloadEnv((m) => app.log.info(m)), 200); });
  } catch { /* ignore */ }

  process.on('SIGINT', async () => { await app.close(); process.exit(0); });
  process.on('SIGTERM', async () => { await app.close(); process.exit(0); });
  await app.listen({ port: config.port, host: config.host });
}
main().catch((err) => { console.error(err); process.exit(1); });
