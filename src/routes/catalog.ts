/**
 * GET /catalog?store=<siteId>&page=<n> — one page of a store's newest-first catalog listing (the
 * crawler's enumeration feed; see assembleCatalog). Maps the runtime's discriminated result onto
 * HTTP: 200 `{ siteId, page, url, items:[{itemId,url?,collectUrl?}], collectUrls, hasMore, nextPage?,
 * count }` · 400 bad input · 422 `unsupported` (no listing axis / parser) · 503 `cooldown` with
 * `Retry-After` (the host is cooling from a CF challenge) · 502 `catalog failed`. Never a 500. Injected.
 *
 * GET /catalog?store=<siteId>&range=1&from=<id>&count=<n> — the ID-RANGE axis of the same feed: a
 * SYNTHESIZED window of `count` ids walking DOWN from `from` for a store whose ids are sequential
 * (`retrieval.byRange`). 200 `{ siteId, from, items, collectUrls, hasMore, nextFrom?, count }` ·
 * 400 bad input · 422 `unsupported` (no byRange / no byId) · 503 `cooldown` with `Retry-After` (the
 * item host is cooling from a CF challenge) · 502 `catalog failed`. `range` and `page` are mutually
 * exclusive; `from` is required with `range` and ignored without it.
 */
import { Router, type Request, type Response } from 'express';
import type { Catalog } from '../driver/assembleCatalog.js';

/** A positive integer from the raw query value; undefined when absent; null when present but invalid. */
const parsePositiveInt = (p: unknown): number | undefined | null => {
  if (p === undefined) return undefined;
  const raw = typeof p === 'string' ? p.trim() : '';
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
};

export function createCatalogRoute(catalog: Catalog): Router {
  const router = Router();

  router.get('/catalog', async (req: Request, res: Response) => {
    const store = typeof req.query.store === 'string' ? req.query.store.trim() : '';
    if (!store) {
      res.status(400).json({ error: "query parameter 'store' is required" });
      return;
    }
    const page = parsePositiveInt(req.query.page);
    if (page === null) {
      res.status(400).json({ error: "query parameter 'page' must be a positive integer" });
      return;
    }
    // The id-range axis is opted into EXPLICITLY (range=1) so a stray `from` can never turn a listing
    // walk into an id walk, and the two paging models can never be mixed in one request.
    const range = req.query.range;
    if (range !== undefined) {
      if (range !== '1') {
        res.status(400).json({ error: "query parameter 'range' must be '1' when present" });
        return;
      }
      if (page !== undefined) {
        res.status(400).json({ error: "query parameters 'range' and 'page' are mutually exclusive" });
        return;
      }
      const from = parsePositiveInt(req.query.from);
      if (from === undefined || from === null) {
        res.status(400).json({ error: "query parameter 'from' is required with 'range' and must be a positive integer" });
        return;
      }
      const count = parsePositiveInt(req.query.count);
      if (count === null) {
        res.status(400).json({ error: "query parameter 'count' must be a positive integer" });
        return;
      }
      try {
        const result = catalog.idRange(store, from, count);
        switch (result.status) {
          case 'ok': {
            const { status: _status, ...body } = result;
            res.json(body);
            return;
          }
          case 'unsupported':
            res.status(422).json({ error: 'unsupported', siteId: result.siteId, reason: result.reason });
            return;
          case 'cooldown':
            res.set('Retry-After', String(Math.ceil(result.remainingMs / 1000)));
            res.status(503).json({ error: 'cooldown', siteId: result.siteId, host: result.host, remainingMs: result.remainingMs });
            return;
          case 'failed':
            res.status(502).json({ error: 'catalog failed', siteId: result.siteId, reason: result.reason });
            return;
          default:
            res.status(502).json({ error: 'catalog failed', siteId: store, reason: 'unrecognised catalog result' });
            return;
        }
      } catch (error) {
        res.status(502).json({ error: 'catalog failed', siteId: store, reason: error instanceof Error ? error.message : String(error) });
        return;
      }
    }
    try {
      const result = await catalog.catalog(store, page);
      switch (result.status) {
        case 'ok': {
          const { status: _status, ...body } = result;
          res.json(body);
          return;
        }
        case 'unsupported':
          res.status(422).json({ error: 'unsupported', siteId: result.siteId, reason: result.reason });
          return;
        case 'cooldown':
          res.set('Retry-After', String(Math.ceil(result.remainingMs / 1000)));
          res.status(503).json({ error: 'cooldown', siteId: result.siteId, host: result.host, remainingMs: result.remainingMs });
          return;
        case 'failed':
          res.status(502).json({ error: 'catalog failed', siteId: result.siteId, reason: result.reason });
          return;
        default:
          // An unrecognised status is a failure, never a hang or a 500.
          res.status(502).json({ error: 'catalog failed', siteId: store, reason: 'unrecognised catalog result' });
      }
    } catch (error) {
      res.status(502).json({ error: 'catalog failed', siteId: store, reason: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}
