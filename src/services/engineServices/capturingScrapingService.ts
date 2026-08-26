/**
 * The pooled browser surface backed by the SHARED raw-capture sink — the same construction the
 * ingest queue uses (scrapeQueue: `createScrapingService(getRawCaptureSink())`). Extracted so the
 * /lookup + /resolve mount provably shares it: a bare `createScrapingService()` defaults to a
 * NoopCaptureSink, which SILENTLY drops the wire+dom captures of every navigation made through it
 * (the resolve leg's primary detail fetches and browser-lane follow-ups all ride this surface, and
 * their raw-store provenance would just never appear).
 */
import { createScrapingService } from './scrapingService.js';
import { getRawCaptureSink } from '../s3ObjectStore.js';
import type { ScrapingService } from '@figurecollecting/scraper-plugin-contract';

export function createCapturingScrapingService(): ScrapingService {
  return createScrapingService(getRawCaptureSink());
}
