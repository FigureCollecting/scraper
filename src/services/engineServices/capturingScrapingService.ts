/**
 * The pooled browser surface backed by the SHARED raw-capture sink — the same construction the
 * ingest queue uses (scrapeQueue: `createScrapingService(getRawCaptureSink())`). Extracted so the
 * /lookup + /resolve mount provably shares it: a bare `createScrapingService()` defaults to a
 * NoopCaptureSink, which SILENTLY drops the wire+dom captures of every navigation made through it
 * (the resolve leg's primary detail fetches and browser-lane follow-ups all ride this surface, and
 * their raw-store provenance would just never appear).
 */
import { createScrapingService, type EngineScrapingService } from './scrapingService.js';
import { getRawCaptureSink } from '../s3ObjectStore.js';

/**
 * Returned as the ENGINE-widened service (not the bare contract `ScrapingService`) so the /lookup +
 * /catalog browser transport can hand it the dispatcher's egress/readiness wiring — `proxyServer`
 * (residential egress) and `waitFor` (client-rendered readiness) — under the type system rather
 * than as untyped extra properties.
 */
export function createCapturingScrapingService(): EngineScrapingService {
  return createScrapingService(getRawCaptureSink());
}
