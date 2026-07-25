/**
 * Ingest trigger route — the HTTP surface for the queue's ingest path.
 *
 * POST /ingest/scrape {url} validates the URL, confirms the ingest path is
 * usable (emitter configured + a plugin ruleset matches), and enqueues the
 * URL into the scrape queue. Everything downstream — raw page fetch, plugin
 * extraction, spine emit, retry/failure semantics — is the queue's existing,
 * tested processViaIngest machinery; nothing is duplicated here.
 *
 * The URL itself is the queue's dedup key: repeat triggers for the same URL
 * coalesce onto the pending item (deduplicated: true, same itemId).
 */

import express, { type Router } from 'express';
import { getScrapeQueue, type ScrapeQueue } from '../services/scrapeQueue.js';
import { sanitizeForLog } from '../utils/security.js';

/**
 * Build the router. The queue is resolved lazily per request (default: the
 * singleton) so the route always sees the registry/emitter that index.ts
 * threads in during plugin bootstrap.
 */
export function createIngestRouter(getQueue: () => ScrapeQueue = getScrapeQueue): Router {
  const router = express.Router();

  router.post('/ingest/scrape', (req, res) => {
    const { url } = req.body ?? {};

    if (!url || typeof url !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'URL is required',
      });
    }

    try {
      new URL(url);
    } catch {
      return res.status(400).json({
        success: false,
        message: 'Invalid URL format',
      });
    }

    const queue = getQueue();

    if (!queue.isIngestConfigured()) {
      return res.status(503).json({
        success: false,
        message: 'Ingest not configured (INGEST_BASE_URL unset)',
      });
    }

    if (!queue.hasRulesetForUrl(url)) {
      return res.status(422).json({
        success: false,
        message: 'No plugin ruleset matches this URL',
      });
    }

    const result = queue.enqueue(url, { url });

    // result.id embeds the URL (it is the dedup key), so it is user-tainted
    // and must be sanitized wherever it is logged; position is a number.
    console.log(`[INGEST API] ${result.deduplicated ? 'Coalesced' : 'Enqueued'} ingest scrape for ${sanitizeForLog(url)} (item ${sanitizeForLog(result.id)}, position ${result.position})`); // lgtm[js/log-injection]

    // Outcome observability for smoke runs: the queue and emitter already log
    // processing detail; these lines tie completion/failure back to the
    // trigger by item id + URL.
    result.promise
      .then(() => {
        console.log(`[INGEST API] Ingest scrape completed for ${sanitizeForLog(url)} (item ${sanitizeForLog(result.id)})`); // lgtm[js/log-injection]
      })
      .catch((error: Error) => {
        console.error(`[INGEST API] Ingest scrape failed for ${sanitizeForLog(url)} (item ${sanitizeForLog(result.id)}): ${sanitizeForLog(error.message)}`); // lgtm[js/log-injection]
      });

    return res.status(202).json({
      success: true,
      itemId: result.id,
      deduplicated: result.deduplicated,
      position: result.position,
    });
  });

  return router;
}

export default createIngestRouter();
