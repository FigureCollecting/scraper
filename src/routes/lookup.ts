/**
 * GET /lookup?q=<query>&mode=<listed|orderable> — the cross-store buy-decision search endpoint.
 * Fans the query across every store with a bySearch axis and returns per-store candidates plus the
 * coverage envelope (unsupported / orderableOnly / failed). `mode` defaults to `listed` (superset,
 * incl. sold-out); `orderable` filters to in-stock. The Lookup is injected so the route is testable.
 */
import { Router, type Request, type Response } from 'express';
import type { Lookup, LookupMode } from '../driver/assembleLookup.js';

export function createLookupRoute(lookup: Lookup): Router {
  const router = Router();

  router.get('/lookup', async (req: Request, res: Response) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!q) {
      res.status(400).json({ error: "query parameter 'q' is required" });
      return;
    }
    const mode: LookupMode = req.query.mode === 'orderable' ? 'orderable' : 'listed';
    try {
      res.json(await lookup.lookup(q, { mode }));
    } catch (error) {
      res.status(502).json({ error: 'lookup failed', detail: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}
