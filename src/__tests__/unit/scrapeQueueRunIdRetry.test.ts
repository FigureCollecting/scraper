/**
 * CHALLENGER: (1) a run-A item that FAILS its first attempt and is retried while run B is active logs run A's id on
 * BOTH attempts; (2) a queue file written by develop's REAL code (CHALLENGER_DEV_DB, made by develop 1f8187ca's
 * openQueueStore) is upgraded and processed by this queue inside run B with no run_id and no crash.
 * Fake timers only.
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

const HOSTS = ['store.test', 'shop-b.example.test'];
let lines: string[] = [];
let log: Logger;
const quiet = createLogger({ sink: () => undefined, env: {} });
const inRun = <T>(n: string, fn: (r: JobRun) => T | Promise<T>): Promise<T> => runJob(n, fn, { logger: quiet, env: {} });
function registry() {
  const r = createExtractionRegistry();
  r.registerSite({ siteId: 'c', name: 'c', domains: HOSTS, rateLimit: { domain: HOSTS[0], baseDelayMs: 1, minDelayMs: 1, maxDelayMs: 10, backoffMultiplier: 1.5, recoveryDivisor: 1.5, successThreshold: 3 }, requiresBrowser: false, allowedCookies: [] });
  const rs: ExtractionRuleset = { siteId: 'c', version: '1.0.0', extract: (_h: string, u: string) => ({ source: { site: 'c', itemId: u, url: u, extractedAt: '2026-10-29T00:00:00Z', rulesetVersion: '1.0.0' }, fields: { name: u }, warnings: [] }), validate: () => ({ valid: true, errors: [], warnings: [] }) };
  r.registerRuleset(rs);
  return r;
}
let tracing: Tracing;
let queue: ScrapeQueue | undefined;
const send = jest.fn();
const scraping = { scrapePage: jest.fn(), scrapePageStealth: jest.fn() };
async function until(done: () => boolean) { for (let i = 0; i < 800 && !done(); i++) await jest.advanceTimersByTimeAsync(25); if (!done()) throw new Error('not met'); }
beforeAll(() => { tracing = startTracing('challenger-q', { env: {}, exporter: keepingExporter() }); });
afterAll(async () => { await tracing.shutdown(); });
beforeEach(() => {
  jest.useFakeTimers();
  process.env.SCRAPER_HOST_HARD_FLOOR_MS = '1'; process.env.SCRAPER_HOST_BASE_DELAY_MS = '1';
  resetScrapeQueue(); lines = [];
  log = createLogger({ service: 'scraper', version: 't', sink: l => lines.push(l), env: {} });
  send.mockReset().mockResolvedValue(okWriteStats());
});
afterEach(() => { queue?.stop(); queue?.clear(); queue?.closeQueueStore(); queue = undefined; resetScrapeQueue(); jest.useRealTimers(); });
const fetchRuns = () => lines.map(l => JSON.parse(l) as Record<string, unknown>).filter(l => l['event'] === 'fetch').map(l => [l['item'], l['attempt'], l['run_id'] ?? 'none']);
function wire(q: ScrapeQueue) { q.setPluginRegistry(registry()); q.setIngestEmitter({ send }); q.setScrapingService(scraping); return q; }

it('a retried item keeps the enqueuing run on its second attempt, processed while another run is active', async () => {
  let n = 0;
  scraping.scrapePage.mockImplementation(async (u: string) => {
    n += 1;
    log.info({ event: 'fetch', item: u.split('/').pop(), attempt: n }, 'fetch');
    if (n === 1) { const e = new Error('ECONNRESET socket hang up'); (e as NodeJS.ErrnoException).code = 'ECONNRESET'; throw e; }
    return { html: '<html>ok</html>', url: u, title: 'T', statusCode: 200 };
  });
  queue = wire(new ScrapeQueue(false));
  const a = await inRun('run-a', r => ({ runId: r.runId, p: queue!.enqueue(`https://${HOSTS[0]}/item/r1`, { url: `https://${HOSTS[0]}/item/r1` }).promise }));
  a.p.catch(() => undefined);
  const runB = await inRun('run-b', async r => { await until(() => n >= 2 && send.mock.calls.length >= 1); return r.runId; });
  expect(runB).not.toBe(a.runId);
  expect(fetchRuns()).toEqual([['r1', 1, a.runId], ['r1', 2, a.runId]]);
});

const devDb = process.env.CHALLENGER_DEV_DB;
(devDb ? it : it.skip)('processes rows from a file develop 1f8187ca wrote, inside run B, with no run_id and no crash', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'challenger-devdb-'));
  for (const f of fs.readdirSync(devDb!)) fs.copyFileSync(path.join(devDb!, f), path.join(dir, f));
  scraping.scrapePage.mockImplementation(async (u: string) => { log.info({ event: 'fetch', item: u.split('/').pop(), attempt: 1 }, 'fetch'); return { html: '<html>ok</html>', url: u, title: 'T', statusCode: 200 }; });
  queue = wire(new ScrapeQueue(false));
  const store = openQueueStore({ dir });
  expect(store.reason).toBe('ok');
  queue.setQueueStore(store);
  const runB = await inRun('run-b', async r => { const res = queue!.restoreFromStore(); expect(res).toBeDefined(); await until(() => send.mock.calls.length >= 2); return r.runId; });
  expect(runB).toMatch(/^[0-9a-f]{32}$/);
  const got = fetchRuns();
  expect(got.length).toBeGreaterThanOrEqual(2);
  expect(got.every(([, , run]) => run === 'none')).toBe(true);
  fs.rmSync(dir, { recursive: true, force: true });
});
