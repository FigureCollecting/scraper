/**
 * Test-only harness for QB-U19 (queue dispatch through POOL-SELECT): a real ScrapeQueue on a real
 * SQLite queue store in a temp dir, a fake record transport (the queue's scraping service) that logs
 * every call with the fake clock's time, and a registry of stores with declared floors. No network.
 *
 * The caller installs jest fake timers before building a queue and advances them; every dispatch
 * runs through the queue's own scan, pacing, lease, retry and page-in paths.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ScrapeQueue } from '../../services/scrapeQueue';
import { createExtractionRegistry, type ExtractionRegistryImpl } from '../../services/extractionRegistry';
import { openQueueStore, type ScrapeQueueStore } from '../../services/queueStore';
import { okWriteStats } from './ingestWriteStats';

export interface SiteSpec {
  siteId: string;
  domain: string;
  baseDelayMs: number;
}

export function poolRegistry(sites: readonly SiteSpec[]): ExtractionRegistryImpl {
  const r = createExtractionRegistry();
  for (const s of sites) {
    r.registerSite({
      siteId: s.siteId,
      name: s.siteId,
      domains: [s.domain],
      rateLimit: { domain: s.domain, baseDelayMs: s.baseDelayMs, minDelayMs: 1000, maxDelayMs: 180000, backoffMultiplier: 2, recoveryDivisor: 1.5, successThreshold: 4 },
      requiresBrowser: false,
      allowedCookies: [],
    });
    r.registerRuleset({
      siteId: s.siteId,
      version: '1.0.0',
      extract: (_h: string, url: string) => ({
        source: { site: s.siteId, itemId: new URL(url).pathname.split('/').pop() as string, url, extractedAt: '2026-10-07T00:00:00.000Z', rulesetVersion: '1.0.0' },
        fields: { name: 'x' },
        warnings: [],
      }),
      validate: () => ({ valid: true, errors: [], warnings: [] }),
    });
  }
  return r;
}

/** A temp dir for one SQLite queue store; /dev/shm when present (no fsync cost), else the OS temp dir. */
export function poolTmpDir(prefix: string): string {
  const base = fs.existsSync('/dev/shm') ? '/dev/shm' : os.tmpdir();
  return fs.mkdtempSync(path.join(base, prefix));
}

export interface TransportCall {
  t: number;
  url: string;
  status: number;
}

/**
 * The record transport: answers 500 (a retryable 'network' failure through the queue's real retry
 * path) while `failuresLeft(url)` is above zero, else 200. Every call is logged at the fake clock.
 */
export function fakeScraping(calls: TransportCall[], failuresLeft: Map<string, number> = new Map(), statusFor?: (url: string) => number) {
  const page = jest.fn().mockImplementation((url: string) => {
    const left = failuresLeft.get(url) ?? 0;
    const status = statusFor !== undefined ? statusFor(url) : left > 0 ? 500 : 200;
    if (left > 0) failuresLeft.set(url, left - 1);
    calls.push({ t: Date.now(), url, status });
    return Promise.resolve({ html: '<html>ok</html>', url, title: 'Item', statusCode: status });
  });
  return { scrapePage: page, scrapePageStealth: page };
}

export function wirePoolQueue(opts: {
  store: ScrapeQueueStore;
  sites: readonly SiteSpec[];
  calls: TransportCall[];
  failuresLeft?: Map<string, number>;
  /** Decides each call's status instead of failuresLeft (500 = a retryable failure). */
  statusFor?: (url: string) => number;
}): ScrapeQueue {
  const queue = new ScrapeQueue(false);
  queue.setPluginRegistry(poolRegistry(opts.sites));
  queue.setIngestEmitter({ send: jest.fn().mockResolvedValue(okWriteStats()) });
  queue.setScrapingService(fakeScraping(opts.calls, opts.failuresLeft, opts.statusFor));
  queue.setImageCaptureHook({ capture: async () => undefined, drain: async () => undefined, stats: () => ({ enabled: false }) as any });
  queue.setQueueStore(opts.store);
  return queue;
}

export function openPoolStore(dir: string): ScrapeQueueStore {
  return openQueueStore({ dir });
}
