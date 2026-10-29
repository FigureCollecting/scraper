/**
 * LG-RUNID: a queued item is processed under the run it was enqueued in, beside its trace (LG-QUEUE-1).
 *
 * fc-shared 1.9.0 stamps run_id (the run's trace id) on every line of a server/job run and its items. The queue
 * restores each item's stored traceparent with withTraceparent, which restores ONLY the run it is handed: without the
 * stored run, every line written while the item is processed loses run_id. The queue keeps currentRunId() with the item,
 * in memory and in queue_items.run_id, and hands it back on every restore. An item never takes the run of whatever is
 * active when it is processed, and a stored value that is not a run id is no run.
 *
 * Real pieces: fc-shared tracing (AsyncLocalStorage context), runJob and the server/log logger, the durable queue store
 * on a temp dir. The ruleset writes one log line per item while the item is extracted (plugin code inside the item's
 * processing). The ingest call is a local fake; the clock is jest's (no real timers); nothing leaves the process.
 */
jest.mock('../../services/genericScraper', () => ({
  BrowserPool: {
    getStealthBrowser: jest.fn(),
    getBrowser: jest.fn(),
    returnBrowser: jest.fn(),
    getPoolSize: jest.fn().mockReturnValue(2),
    getPoolCapacity: jest.fn().mockReturnValue(3),
    reset: jest.fn(),
  },
}));
jest.mock('../../services/webhookClient', () => ({
  notifyItemSuccess: jest.fn().mockResolvedValue(true),
  notifyItemFailed: jest.fn().mockResolvedValue(true),
  notifyItemSkipped: jest.fn().mockResolvedValue(true),
}));

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { context, trace } from '@opentelemetry/api';
import type { ExtractionRuleset } from '@figurecollecting/scraper-plugin-contract';
import { runJob, type JobRun } from '@figurecollecting/fc-shared/server/job';
import { createLogger, type Logger } from '@figurecollecting/fc-shared/server/log';
import { startTracing, type Tracing } from '@figurecollecting/fc-shared/server/tracing';
import { ScrapeQueue, resetScrapeQueue } from '../../services/scrapeQueue';
import { createExtractionRegistry, type ExtractionRegistryImpl } from '../../services/extractionRegistry';
import { QUEUE_DB_FILE, openQueueStore, type ScrapeQueueStore } from '../../services/queueStore';
import { okWriteStats } from '../helpers/ingestWriteStats';
import { keepingExporter, type Line } from '../helpers/jobTelemetry';

const HOSTS = ['shop-a.example.test', 'shop-b.example.test', 'shop-c.example.test', 'shop-d.example.test'];
const url = (host: string, id: string): string => `https://${host}/item/${id}`;
const HEX32 = /^[0-9a-f]{32}$/;

// ---------------------------------------------------------------------------------------------
// One log line per item, written while the item is extracted, through an fc-shared logger.
// ---------------------------------------------------------------------------------------------
let lines: string[] = [];
let log: Logger;

function makeRegistry(): ExtractionRegistryImpl {
  const ruleset: ExtractionRuleset = {
    siteId: 'runid-shop',
    version: '1.0.0',
    extract: (_html: string, pageUrl: string) => {
      const itemId = pageUrl.split('/').pop() ?? '';
      log.info({ event: 'item.extract', item_id: itemId }, 'extracting');
      return {
        source: { site: 'runid-shop', itemId, url: pageUrl, extractedAt: '2026-10-29T00:00:00Z', rulesetVersion: '1.0.0' },
        fields: { name: itemId },
        warnings: [],
      };
    },
    validate: () => ({ valid: true, errors: [], warnings: [] }),
  };
  const registry = createExtractionRegistry();
  registry.registerSite({
    siteId: 'runid-shop',
    name: 'Run Id Shop',
    domains: HOSTS,
    rateLimit: { domain: HOSTS[0], baseDelayMs: 1, minDelayMs: 1, maxDelayMs: 10, backoffMultiplier: 1.5, recoveryDivisor: 1.5, successThreshold: 3 },
    requiresBrowser: false,
    allowedCookies: [],
  });
  registry.registerRuleset(ruleset);
  return registry;
}

/** Each item's extract lines as their run_id ('none' for a line with none), by item id. */
function runIdsByItem(): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const line of lines.map(l => JSON.parse(l) as Line)) {
    if (line['event'] !== 'item.extract') continue;
    (out[String(line['item_id'])] ??= []).push(line['run_id'] ?? 'none');
  }
  return out;
}

/** The trace id each item's extract line carried. */
function traceIdsByItem(): Record<string, unknown> {
  return Object.fromEntries(
    lines
      .map(l => JSON.parse(l) as Line)
      .filter(l => l['event'] === 'item.extract')
      .map(l => [String(l['item_id']), l['trace_id']]),
  );
}

// ---------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------
const scraping = { scrapePage: jest.fn(), scrapePageStealth: jest.fn() };
let send: jest.Mock;
let tracing: Tracing;
let queue: ScrapeQueue | undefined;
let dirs: string[] = [];
let stores: ScrapeQueueStore[] = [];
/** runJob's own job.start / job.end lines go here, not into `lines`. */
const quiet = createLogger({ sink: () => undefined, env: {} });

function wire(q: ScrapeQueue): ScrapeQueue {
  q.setPluginRegistry(makeRegistry());
  q.setIngestEmitter({ send });
  q.setScrapingService(scraping);
  return q;
}

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'scrape-queue-runid-'));
  dirs.push(d);
  return d;
}

function openStore(dir: string): ScrapeQueueStore {
  const s = openQueueStore({ dir });
  stores.push(s);
  return s;
}

const inRun = <T>(name: string, fn: (run: JobRun) => T | Promise<T>): Promise<T> => runJob(name, fn, { logger: quiet, env: {} });

/** Advance jest's clock until `done()` holds; fails the test rather than hang. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !done(); i++) await jest.advanceTimersByTimeAsync(25);
  if (!done()) throw new Error('condition not met on the fake clock');
}

/** Advance jest's clock until every promise has settled. */
async function settle(promises: Array<Promise<unknown>>): Promise<void> {
  let settled = false;
  void Promise.allSettled(promises).then(() => {
    settled = true;
  });
  await until(() => settled);
}

beforeAll(() => {
  tracing = startTracing('scraper-queue-runid-test', { env: {}, exporter: keepingExporter() });
});

afterAll(async () => {
  await tracing.shutdown();
});

beforeEach(() => {
  jest.useFakeTimers();
  // Host pacing down to 1 ms, so the loop dispatches back to back on the fake clock.
  process.env.SCRAPER_HOST_HARD_FLOOR_MS = '1';
  process.env.SCRAPER_HOST_BASE_DELAY_MS = '1';
  resetScrapeQueue();
  lines = [];
  log = createLogger({ service: 'scraper', version: 'test', sink: line => lines.push(line), env: {} });
  send = jest.fn().mockResolvedValue(okWriteStats());
  scraping.scrapePage.mockImplementation(async (pageUrl: string) => ({ html: '<html><body>item</body></html>', url: pageUrl, title: 'Item', statusCode: 200 }));
});

afterEach(() => {
  queue?.stop();
  queue?.clear();
  queue?.closeQueueStore();
  queue = undefined;
  resetScrapeQueue();
  for (const s of stores) {
    try {
      s.close();
    } catch {
      /* closed */
    }
  }
  stores = [];
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
  delete process.env.SCRAPER_HOST_HARD_FLOOR_MS;
  delete process.env.SCRAPER_HOST_BASE_DELAY_MS;
  jest.useRealTimers();
});

describe('ScrapeQueue: an item is processed under the run that enqueued it (LG-RUNID)', () => {
  it("logs an item's lines with the run_id of the run that enqueued it, after that run has ended", async () => {
    queue = wire(new ScrapeQueue(false));
    const a = await inRun('run-a', run => ({ runId: run.runId, promise: queue!.enqueue(url(HOSTS[0], 'a1'), { url: url(HOSTS[0], 'a1') }).promise }));
    await settle([a.promise]);

    expect(a.runId).toMatch(HEX32);
    expect(runIdsByItem()).toEqual({ a1: [a.runId] });
  });

  it("keeps the run of an item enqueued inside one of the run's items (run.item)", async () => {
    queue = wire(new ScrapeQueue(false));
    // The item hands back the enqueue result, not its promise, so the run does not wait for the scrape.
    const a = await inRun('run-a', async run => ({
      runId: run.runId,
      enqueued: await run.item(() => queue!.enqueue(url(HOSTS[0], 'i1'), { url: url(HOSTS[0], 'i1') })),
    }));
    await settle([a.enqueued.promise]);

    expect(runIdsByItem()).toEqual({ i1: [a.runId] });
  });

  it("logs an item enqueued outside any run with no run_id, while a run's item goes through the same loop", async () => {
    queue = wire(new ScrapeQueue(false));
    const a = await inRun('run-a', run => ({ runId: run.runId, promise: queue!.enqueue(url(HOSTS[0], 'a1'), { url: url(HOSTS[0], 'a1') }).promise }));
    const n1 = queue.enqueue(url(HOSTS[1], 'n1'), { url: url(HOSTS[1], 'n1') });
    await settle([a.promise, n1.promise]);

    expect(runIdsByItem()).toEqual({ a1: [a.runId], n1: ['none'] });
  });

  it("logs run A's items with A's run_id when they are processed while run B is active, a dedup enqueue by B included", async () => {
    queue = wire(new ScrapeQueue(false));
    // a1 goes on the wire at once; a2 (same host) waits on the host's pacing.
    const a = await inRun('run-a', run => ({
      runId: run.runId,
      promises: [
        queue!.enqueue(url(HOSTS[0], 'a1'), { url: url(HOSTS[0], 'a1') }).promise,
        queue!.enqueue(url(HOSTS[0], 'a2'), { url: url(HOSTS[0], 'a2') }).promise,
      ],
    }));
    const runB = await inRun('run-b', async run => {
      const b1 = queue!.enqueue(url(HOSTS[1], 'b1'), { url: url(HOSTS[1], 'b1') });
      const again = queue!.enqueue(url(HOSTS[0], 'a2'), { url: url(HOSTS[0], 'a2') }); // B asks for A's item too
      expect(again.deduplicated).toBe(true);
      // Run B stays active while the loop processes all three.
      await settle([...a.promises, b1.promise, again.promise]);
      return run.runId;
    });

    expect(a.runId).not.toBe(runB);
    expect(runIdsByItem()).toEqual({ a1: [a.runId], a2: [a.runId], b1: [runB] });
  });

  it("restores each item's run from the durable store after a restart, processed while another run is active", async () => {
    const dir = tmpDir();
    // Process one: enqueue (one in run A, one in no run), never dispatch (test mode), shut down.
    const before = new ScrapeQueue(true);
    before.setQueueStore(openStore(dir));
    const runA = await inRun('run-a', run => {
      before.enqueue(url(HOSTS[0], 'a1'), { url: url(HOSTS[0], 'a1') }).promise.catch(() => undefined);
      return run.runId;
    });
    before.enqueue(url(HOSTS[1], 'n1'), { url: url(HOSTS[1], 'n1') }).promise.catch(() => undefined);
    before.stop();
    before.closeQueueStore();

    // Process two: restore and dispatch inside run B.
    queue = wire(new ScrapeQueue(false));
    queue.setQueueStore(openStore(dir));
    const runB = await inRun('run-b', async run => {
      expect(queue!.restoreFromStore().pending).toBe(2);
      await until(() => send.mock.calls.length === 2);
      return run.runId;
    });

    expect(runA).not.toBe(runB);
    expect(runIdsByItem()).toEqual({ a1: [runA], n1: ['none'] });
  });

  it('logs rows with no run (NULL, pre-migration) or a stored value that is not a run id with no run_id, never a crash', async () => {
    const dir = tmpDir();
    const id32 = '4bf92f3577b34da6a3ce929d0e0e4736';
    const TP = `00-${id32}-00f067aa0ba902b7-01`;
    // Values no build writes, in what a damaged or hand-edited file might hold.
    const MALFORMED: Array<[string, string]> = [
      ['garbage', "'not-a-run'"],
      ['empty', "''"],
      ['blank', "'   '"],
      ['upper-case', `'${id32.toUpperCase()}'`],
      ['all-zero', `'${'0'.repeat(32)}'`],
      ['short', `'${id32.slice(1)}'`],
      ['injection', `'${id32}' || char(13, 10) || 'x-injected: 1'`],
      ['overlong', `'${id32}' || '${'0'.repeat(4_096)}'`],
      ['integer', '42'],
      ['real', '1.5'],
      ['blob', "x'00ff'"],
    ];
    const ids = ['null-run', ...MALFORMED.map(([id]) => id)];
    const store = openStore(dir);
    ids.forEach((id, i) => {
      const u = url(HOSTS[i % HOSTS.length], id);
      store.put({ id, mfcId: u, url: u, priority: 'WARM', attempts: 0, maxRetries: 3, enqueuedAt: 1_000 + i, state: 'pending', traceparent: TP });
    });
    store.close();
    const db = new DatabaseSync(path.join(dir, QUEUE_DB_FILE));
    for (const [id, sql] of MALFORMED) db.prepare(`UPDATE queue_items SET run_id = ${sql} WHERE id = ?`).run(id);
    db.close();

    queue = wire(new ScrapeQueue(false));
    queue.setQueueStore(openStore(dir));
    // Restored and processed inside run B: a row with no run must not fall back to B's.
    const runB = await inRun('run-b', async run => {
      expect(queue!.restoreFromStore().pending).toBe(ids.length);
      await until(() => send.mock.calls.length === ids.length);
      return run.runId;
    });

    expect(runB).toMatch(HEX32);
    expect(runIdsByItem()).toEqual(Object.fromEntries(ids.map(id => [id, ['none']])));
    // The trace still comes back: only the run is missing.
    expect(traceIdsByItem()).toEqual(Object.fromEntries(ids.map(id => [id, id32])));
  });

  it('keeps a stored run whose stored traceparent is malformed: the item gets a new root trace and its own run', async () => {
    const dir = tmpDir();
    const RUN = '0af7651916cd43dd8448eb211c80319c';
    const store = openStore(dir);
    const u = url(HOSTS[2], 'bad-tp');
    store.put({ id: 'bad-tp', mfcId: u, url: u, priority: 'WARM', attempts: 0, maxRetries: 3, enqueuedAt: 1_000, state: 'pending', traceparent: 'not-a-traceparent', runId: RUN });
    store.close();

    queue = wire(new ScrapeQueue(false));
    queue.setQueueStore(openStore(dir));
    // Restored inside a span, so a fallback to the active trace would show.
    const boot = trace.getTracer('test').startSpan('boot');
    context.with(trace.setSpan(context.active(), boot), () => queue!.restoreFromStore());
    boot.end();
    await until(() => send.mock.calls.length === 1);

    expect(runIdsByItem()).toEqual({ 'bad-tp': [RUN] });
    const traceId = traceIdsByItem()['bad-tp'];
    expect(traceId).toMatch(HEX32);
    expect(traceId).not.toBe(boot.spanContext().traceId);
    expect(traceId).not.toBe(RUN);
  });
});
