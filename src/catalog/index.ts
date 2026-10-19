import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { z } from 'zod';

export interface CatalogProduct { id: string; title: string; description: string | null }
export interface CatalogResult { retrievedAt: string; products: CatalogProduct[] }
export class CatalogError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
// Separate database: no access to dispute state. Reservations are never refunded.
export class CatalogBudget {
  private db: DatabaseSync;
  constructor(path: string, allowance: number) {
    if (!Number.isSafeInteger(allowance) || allowance < 0 || allowance > 100) throw new Error('Invalid catalog allowance');
    this.db = new DatabaseSync(path);
    this.db.exec('CREATE TABLE IF NOT EXISTS budget (id INTEGER PRIMARY KEY CHECK(id=1), spent INTEGER NOT NULL, busy INTEGER NOT NULL, stopped INTEGER NOT NULL)');
    this.db.exec('INSERT OR IGNORE INTO budget VALUES (1,0,0,0)');
    this.allowance = allowance;
  }
  private allowance: number;
  reserve() {
    const result = this.db.prepare('UPDATE budget SET spent=spent+1,busy=1 WHERE id=1 AND busy=0 AND stopped=0 AND spent < ?').run(this.allowance);
    if (!result.changes) throw new CatalogError(429, 'Catalog budget exhausted, busy or stopped.');
  }
  finish(stop: boolean) { this.db.prepare('UPDATE budget SET busy=0,stopped=MAX(stopped,?) WHERE id=1').run(stop ? 1 : 0); }
  close() { this.db.close(); }
}
const ResponseSchema = z.object({ products: z.array(z.object({
  id: z.string().min(1).max(300), title: z.string().min(1).max(1000),
  description: z.string().max(20000).nullish(),
})).max(30), next_page_token: z.string().nullish() });
const Query = z.object({ query: z.string().trim().min(2).max(160).regex(/^[\p{L}\p{N} .,'()&+\-]+$/u) }).strict();
export interface CatalogService { search(query: string): Promise<CatalogResult> }
export const disabledCatalog: CatalogService = { async search() { throw new CatalogError(503, 'Catalog lookup is disabled pending a verified free-only limit and replacement key.'); } };

// Injected transport keeps tests offline. Production activation is intentionally not wired yet.
export function channel3Catalog(options: { enabled: boolean; freeOnlyVerified: boolean; key: string; budget: CatalogBudget; transport: typeof fetch }): CatalogService {
  return { async search(query) {
    if (!options.enabled || !options.freeOnlyVerified || !options.key) return disabledCatalog.search(query);
    if (!Query.safeParse({ query }).success) throw new CatalogError(400, 'Enter a public product name or model only.');
    options.budget.reserve();
    let stop = false;
    try {
      const response = await options.transport('https://api.trychannel3.com/v1/search', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': options.key },
        body: JSON.stringify({ query, limit: 5, config: { mode: 'default' } }),
        signal: AbortSignal.timeout(10000), redirect: 'error',
      });
      if (!response.ok) { stop = true; throw new CatalogError(503, 'Catalog provider unavailable; lookup stopped.'); }
      const parsed = ResponseSchema.safeParse(await response.json());
      if (!parsed.success) { stop = true; throw new CatalogError(502, 'Catalog returned an invalid response.'); }
      // Deliberately omit offers, prices, URLs, images and pagination. No stale purchase links or image requests.
      return { retrievedAt: new Date().toISOString(), products: parsed.data.products.slice(0, 5).map(p => ({ id: p.id, title: p.title, description: p.description ?? null })) };
    } catch (error) {
      stop = true;
      if (error instanceof CatalogError) throw error;
      throw new CatalogError(503, 'Catalog request failed; lookup stopped.');
    } finally { options.budget.finish(stop); }
  } };
}
export function catalogRouter(service: CatalogService = disabledCatalog, authenticated = false) {
  const router = new Hono();
  router.post('/search', async c => {
    c.header('Cache-Control', 'no-store');
    if (!authenticated) return c.json({ message: 'Catalog lookup requires operator authentication.' }, 403);
    const parsed = Query.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ message: 'Enter a public product name or model only; no case or customer data.' }, 400);
    try { return c.json(await service.search(parsed.data.query)); }
    catch (error) {
      const known = error instanceof CatalogError;
      return c.json({ message: known ? error.message : 'Catalog unavailable.' }, (known ? error.status : 503) as 400 | 429 | 502 | 503);
    }
  });
  return router;
}
