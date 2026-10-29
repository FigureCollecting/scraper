/**
 * LG-RUNID: an item parked on enqueue keeps the run it was enqueued in when it is paged in under another run.
 *
 * With SCRAPE_QUEUE_MAX_RESIDENT=1 the enqueues over the cap go straight to disk as parked rows. A new queue then
 * restores them inside run B and pages them in; each item logs run A's run_id, and an item enqueued outside any run
 * logs none. The test first checks that rows really parked, so the park branch is what is exercised.
 *
 * Real pieces: fc-shared tracing, runJob and the server/log logger, the durable queue store on a temp dir. The
 * scraping service and ingest call are local fakes; the clock is jest's (no real timers); nothing leaves the process.
 */
jest.mock('../../services/genericScraper', () => ({
  BrowserPool: { getStealthBrowser: jest.fn(), getBrowser: jest.fn(), returnBrowser: jest.fn(), getPoolSize: jest.fn().mockReturnValue(2), getPoolCapacity: jest.fn().mockReturnValue(3), reset: jest.fn() },
}));
jest.mock('../../services/webhookClient', () => ({ notifyItemSuccess: jest.fn().mockResolvedValue(true), notifyItemFailed: jest.fn().mockResolvedValue(true), notifyItemSkipped: jest.fn().mockResolvedValue(true) }));
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ExtractionRuleset } from '@figurecollecting/scraper-plugin-contract';
import { runJob, type JobRun } from '@figurecollecting/fc-shared/server/job';
import { createLogger, type Logger } from '@figurecollecting/fc-shared/server/log';
import { startTracing, type Tracing } from '@figurecollecting/fc-shared/server/tracing';
import { ScrapeQueue, resetScrapeQueue } from '../../services/scrapeQueue';
import { createExtractionRegistry } from '../../services/extractionRegistry';
import { openQueueStore } from '../../services/queueStore';
import { okWriteStats } from '../helpers/ingestWriteStats';
import { keepingExporter } from '../helpers/jobTelemetry';

const HOSTS = ['p1.example.test', 'p2.example.test', 'p3.example.test', 'p4.example.test'];
let lines: string[] = [];
let log: Logger;
const quiet = createLogger({ sink: () => undefined, env: {} });
const inRun = <T>(n: string, fn: (r: JobRun) => T | Promise<T>): Promise<T> => runJob(n, fn, { logger: quiet, env: {} });
let tracing: Tracing;
const send = jest.fn();
const scraping = { scrapePage: jest.fn(), scrapePageStealth: jest.fn() };
async function until(done: () => boolean) { for (let i = 0; i < 800 && !done(); i++) await jest.advanceTimersByTimeAsync(25); if (!done()) throw new Error('not met'); }
beforeAll(() => { tracing = startTracing('runid-park', { env: {}, exporter: keepingExporter() }); });
afterAll(async () => { await tracing.shutdown(); });

it('parked-on-enqueue items keep their own run (or none) when paged in under run B', async () => {
  jest.useFakeTimers();
  process.env.SCRAPER_HOST_HARD_FLOOR_MS = '1'; process.env.SCRAPER_HOST_BASE_DELAY_MS = '1';
  process.env.SCRAPE_QUEUE_MAX_RESIDENT = '1';
  resetScrapeQueue();
  log = createLogger({ service: 'scraper', version: 't', sink: l => lines.push(l), env: {} });
  send.mockResolvedValue(okWriteStats());
  scraping.scrapePage.mockImplementation(async (u: string) => { log.info({ event: 'fetch', item: u.split('/').pop() }, 'fetch'); return { html: '<html>ok</html>', url: u, title: 'T', statusCode: 200 }; });
  const r = createExtractionRegistry();
  r.registerSite({ siteId: 'c', name: 'c', domains: HOSTS, rateLimit: { domain: HOSTS[0], baseDelayMs: 1, minDelayMs: 1, maxDelayMs: 10, backoffMultiplier: 1.5, recoveryDivisor: 1.5, successThreshold: 3 }, requiresBrowser: false, allowedCookies: [] });
  const rs: ExtractionRuleset = { siteId: 'c', version: '1.0.0', extract: (_h: string, u: string) => ({ source: { site: 'c', itemId: u, url: u, extractedAt: '2026-10-29T00:00:00Z', rulesetVersion: '1.0.0' }, fields: { name: u }, warnings: [] }), validate: () => ({ valid: true, errors: [], warnings: [] }) };
  r.registerRuleset(rs);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runid-park-'));
  const queue = new ScrapeQueue(true); // test mode: nothing dispatches while we enqueue
  queue.setPluginRegistry(r); queue.setIngestEmitter({ send }); queue.setScrapingService(scraping);
  const store = openQueueStore({ dir });
  queue.setQueueStore(store);
  try {
    const runA = await inRun('run-a', run => {
      for (const id of ['a1', 'a2', 'a3']) queue.enqueue(`https://${HOSTS[Number(id[1]) - 1]}/item/${id}`, { url: `https://${HOSTS[Number(id[1]) - 1]}/item/${id}` }).promise.catch(() => undefined);
      return run.runId;
    });
    queue.enqueue(`https://${HOSTS[3]}/item/n1`, { url: `https://${HOSTS[3]}/item/n1` }).promise.catch(() => undefined);
    expect(store.counts().parked).toBeGreaterThanOrEqual(2); // the park branch really ran
    queue.stop(); queue.closeQueueStore();
    resetScrapeQueue();
    const q2 = new ScrapeQueue(false);
    q2.setPluginRegistry(r); q2.setIngestEmitter({ send }); q2.setScrapingService(scraping);
    q2.setQueueStore(openQueueStore({ dir }));
    const runB = await inRun('run-b', async run => { q2.restoreFromStore(); await until(() => send.mock.calls.length >= 4); return run.runId; });
    q2.stop(); q2.clear(); q2.closeQueueStore();
    const got = Object.fromEntries(lines.map(l => JSON.parse(l) as Record<string, unknown>).filter(l => l['event'] === 'fetch').map(l => [l['item'], l['run_id'] ?? 'none']));
    expect(runA).not.toBe(runB);
    expect(got).toEqual({ a1: runA, a2: runA, a3: runA, n1: 'none' });
  } finally {
    delete process.env.SCRAPE_QUEUE_MAX_RESIDENT; delete process.env.SCRAPER_HOST_HARD_FLOOR_MS; delete process.env.SCRAPER_HOST_BASE_DELAY_MS;
    resetScrapeQueue(); jest.useRealTimers(); fs.rmSync(dir, { recursive: true, force: true });
  }
});
