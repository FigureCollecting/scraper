/**
 * The cross-store buy-decision search endpoint, two shapes over one Lookup:
 *   - GET  /lookup?q=<query>&mode=  — DISCOVERY: free-text fanned across every bySearch store.
 *   - POST /lookup {IdentityQuery, mode?} — RECORD-MODE: a typed identity (JAN/name/studio/…) whose
 *     per-store query is composed server-side (JAN-exact where supported, else name/ER).
 * Both return per-store candidates + the coverage envelope (unsupported / orderableOnly / failed).
 * `mode` defaults to `listed` (superset, incl. sold-out); `orderable` filters to in-stock. Injected.
 */
import { Router, type Request, type Response } from 'express';
import type { Lookup, LookupMode } from '../driver/assembleLookup.js';
import type { IdentityQuery } from '@figurecollecting/scraper-plugin-contract';

const parseMode = (m: unknown): LookupMode => (m === 'orderable' ? 'orderable' : 'listed');

export function createLookupRoute(lookup: Lookup): Router {
  const router = Router();

  router.get('/lookup', async (req: Request, res: Response) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!q) {
      res.status(400).json({ error: "query parameter 'q' is required" });
      return;
    }
    try {
      res.json(await lookup.lookup(q, { mode: parseMode(req.query.mode) }));
    } catch (error) {
      res.status(502).json({ error: 'lookup failed', detail: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/lookup', async (req: Request, res: Response) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
    // gtin14 is frequently sent as a JSON number — accept a finite number (14 digits is within the
    // safe-integer range) rather than silently dropping it to the name-only fallback.
    const gtin = (v: unknown): string | undefined => (typeof v === 'number' && Number.isFinite(v) ? String(v) : str(v));
    const identity: IdentityQuery = {
      gtin14: gtin(b.gtin14), studio: str(b.studio), character: str(b.character), series: str(b.series),
      scale: str(b.scale), figureType: str(b.figureType), version: str(b.version), name: str(b.name),
    };
    // Require a query with real recall: a JAN, a name, or studio PAIRED with character/series. Studio
    // (a manufacturer) alone would fan a near-empty query to every store — rejected.
    const usable = !!(identity.gtin14 || identity.name || (identity.studio && (identity.character || identity.series)));
    if (!usable) {
      res.status(400).json({ error: 'a record-mode lookup needs a gtin14, a name, or studio + character/series' });
      return;
    }
    try {
      res.json(await lookup.lookupByIdentity(identity, { mode: parseMode(b.mode) }));
    } catch (error) {
      res.status(502).json({ error: 'lookup failed', detail: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}
