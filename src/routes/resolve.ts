/**
 * POST /resolve { site, ids: [...] } — the byId CONFIRM endpoint. Fetches each id's detail page and
 * runs the store ruleset's extract() → full ExtractedData (incl fields.gtin14), returning per-id
 * results + `failed`/`unsupported`. The matcher's pass-2 bridge: turns a record-mode lookup's
 * `resolveTargets` (or a picked candidate) into confirmed records. Never emits to the spine. Injected.
 */
import { Router, type Request, type Response } from 'express';
import type { Resolve } from '../driver/assembleResolve.js';

/** Cap ids per call: each id is a pooled browser detail fetch, shared with /lookup + the crawl queue. */
const MAX_IDS = 25;

export function createResolveRoute(resolve: Resolve): Router {
  const router = Router();

  router.post('/resolve', async (req: Request, res: Response) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const site = typeof b.site === 'string' ? b.site.trim() : '';
    const ids = Array.isArray(b.ids)
      ? b.ids.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim())
      : [];
    if (!site || ids.length === 0) {
      res.status(400).json({ error: 'resolve needs { site, ids: [non-empty string, ...] }' });
      return;
    }
    if (ids.length > MAX_IDS) {
      res.status(400).json({ error: `too many ids (max ${MAX_IDS} per call)` });
      return;
    }
    try {
      res.json(await resolve.resolve(site, ids));
    } catch (error) {
      res.status(502).json({ error: 'resolve failed', detail: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}
