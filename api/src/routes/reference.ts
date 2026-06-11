import type { FastifyInstance } from 'fastify';
import type { MemoryStore } from '../store/memoryStore.js';

export async function referenceRoutes(app: FastifyInstance, ds: MemoryStore) {
  app.get('/vendors', async () => ({ vendors: ds.listVendors() }));
  app.get('/pos', async () => ({ pos: ds.listPurchaseOrders() }));
  app.get('/pos/:id', async (req, reply) => {
    const po = ds.getPurchaseOrder(Number((req.params as any).id));
    if (!po) return reply.code(404).send({ error: 'not_found' });
    return { po, receipts: ds.listGoodsReceipts(po.poId) };
  });
  app.get('/goods-receipts', async (req) => {
    const poId = (req.query as any)?.poId ? Number((req.query as any).poId) : undefined;
    return { receipts: ds.listGoodsReceipts(poId) };
  });
}
