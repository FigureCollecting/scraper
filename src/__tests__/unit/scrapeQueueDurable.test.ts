/**
 * TDD (red first) — ScrapeQueue durability: the queue survives a restart.
 *
 * WHY: `hotQueue`/`warmQueue`/`coldQueue` + `pendingItems` are heap objects, so every restart drops
 * them — a planned repin, a rollout, an OOM kill, a crash. The crawler advances its backfill cursor
 * AFTER enqueueing, so those items are COVERAGE HOLES: nothing ever asks for them again. A rollout
 * on 2026-09-08 lost ~130 in-flight items; every repin drops the current crawler batch (~500).
 *
 * These tests pin the queue's side of the contract — the store's own contract is pinned separately
 * in queueStore.test.ts:
 *   - an enqueue is written through, and a dispatch takes a lease
 *   - a completed / given-up item's row goes away; a retry writes back its attempt count
 *   - restore() puts pending AND expired-lease rows back into the tiers with their attempt counts
 *   - SIGTERM releases leases, so a PLANNED rollout loses nothing
 *   - cookies are NEVER persisted (session-bound items stay memory-only)
 *   - the bounded working set parks overflow on disk and pages it back in
 *   - the [SCRAPE QUEUE] log lines and the queue's existing stats fields are unchanged
 */
const mockNotifyItemSuccess = jest.fn().mockResolvedValue(true);
const mockNotifyItemFailed = jest.fn().mockResolvedValue(true);
const mockNotifyItemSkipped = jest.fn().mockResolvedValue(true);

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
  notifyItemSuccess: (...args: any[]) => mockNotifyItemSuccess(...args),
  notifyItemFailed: (...args: any[]) => mockNotifyItemFailed(...args),
  notifyItemSkipped: (...args: any[]) => mockNotifyItemSkipped(...args),
}));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ScrapeQueue, resetScrapeQueue } from '../../services/scrapeQueue';
import { createExtractionRegistry, ExtractionRegistryImpl } from '../../services/extractionRegistry';
import { createQueueStore, openQueueStore, type ScrapeQueueStore } from '../../services/queueStore';
import { ChallengeCooldown } from '../../services/challengeCooldown';
import { okWriteStats } from '../helpers/ingestWriteStats';

const HOST = 'store.test';
const urlFor = (id: string) => `https://${HOST}/item/${id}`;

let dirs: string[] = [];
let stores: ScrapeQueueStore[] = [];
let queue: ScrapeQueue | undefined;

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'scrape-queue-durable-'));
  dirs.push(d);
  return d;
}

function openStore(dir: string): ScrapeQueueStore {
  const s = openQueueStore({ dir });
  stores.push(s);
  return s;
}

function makeRegistry(baseDelayMs = 100): ExtractionRegistryImpl {
  const registry = createExtractionRegistry();
  registry.registerSite({
    siteId: 'store',
    name: 'store',
    domains: [HOST],
    rateLimit: {
      domain: HOST,
      baseDelayMs,
      minDelayMs: 100,
      maxDelayMs: 60000,
      backoffMultiplier: 1.5,
      recoveryDivisor: 1.5,
      successThreshold: 3,
    },
    requiresBrowser: false,
    allowedCookies: [],
  });
  registry.registerRuleset({
    siteId: 'store',
    version: '1.0.0',
    extract: (_html: string, url: string) => ({
      source: {
        site: 'store',
        itemId: new URL(url).pathname.split('/').pop() as string,
        url,
        extractedAt: '2026-09-11T00:00:00.000Z',
        rulesetVersion: '1.0.0',
      },
      fields: { name: 'Figure' },
      warnings: [],
    }),
    validate: () => ({ valid: true, errors: [], warnings: [] }),
  });
  return registry;
}

function scrapingStub(impl?: (url: string) => Promise<any>) {
  const fn = jest.fn().mockImplementation(
    impl ?? ((url: string) => Promise.resolve({ html: '<html></html>', url, title: 'Item', statusCode: 200 }))
  );
  return { scrapePage: fn, scrapePageStealth: fn };
}

afterEach(() => {
  if (queue) {
    queue.stop();
    queue.clear();
    queue = undefined;
  }
  resetScrapeQueue();
  for (const s of stores) {
    try {
      s.close();
    } catch {
      /* already closed */
    }
  }
  stores = [];
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
  delete process.env.SCRAPE_QUEUE_DIR;
  delete process.env.SCRAPE_QUEUE_MAX_RESIDENT;
  delete process.env.SCRAPE_QUEUE_MAX_RESIDENT_PER_HOST;
  delete process.env.SCRAPE_QUEUE_LEASE_MS;
});

describe('ScrapeQueue — write-through', () => {
  it('persists an enqueued item', () => {
    const store = openStore(tmpDir());
    queue = new ScrapeQueue(true);
    queue.setQueueStore(store);

    queue.enqueue('a1', { url: urlFor('a1'), priority: 'WARM' });

    expect(store.counts()).toEqual({ pending: 1, leased: 0, parked: 0 });
    expect(store.restore(Date.now()).pending[0]).toMatchObject({ url: urlFor('a1'), priority: 'WARM' });
  });

  it('NEVER persists a cookie-bearing (session-bound) item', () => {
    const store = openStore(tmpDir());
    queue = new ScrapeQueue(true);
    queue.setQueueStore(store);

    queue.enqueue('secret', {
      url: urlFor('secret'),
      cookies: { cf_clearance: 'super-secret-value' },
      sessionId: 'sess-1',
    });

    // The item IS queued in memory (behaviour unchanged) but nothing about it reaches the disk:
    // its waiting HTTP caller dies with the pod, and a cookie must never be written down.
    expect(queue.getStats().total).toBe(1);
    expect(store.counts()).toEqual({ pending: 0, leased: 0, parked: 0 });
  });

  it('writes a bulk enqueue through in ONE batch', () => {
    const store = openStore(tmpDir());
    const spy = jest.spyOn(store, 'batch');
    queue = new ScrapeQueue(true);
    queue.setQueueStore(store);

    queue.enqueueBulk(Array.from({ length: 50 }, (_, i) => ({ mfcId: `b${i}`, url: urlFor(`b${i}`) })));

    expect(store.counts().pending).toBe(50);
    // The crawler enqueues 50 per store; one commit, not fifty.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('drops the row when an item is cancelled', () => {
    const store = openStore(tmpDir());
    queue = new ScrapeQueue(true);
    queue.setQueueStore(store);
    queue.enqueue('a1', { url: urlFor('a1') });

    expect(queue.cancel('a1')).toBe(true);
    expect(store.counts().pending).toBe(0);
  });

  it('clears every row on clear()', () => {
    const store = openStore(tmpDir());
    queue = new ScrapeQueue(true);
    queue.setQueueStore(store);
    queue.enqueue('a1', { url: urlFor('a1') });
    queue.enqueue('a2', { url: urlFor('a2') });

    queue.clear();
    expect(store.counts()).toEqual({ pending: 0, leased: 0, parked: 0 });
  });

  it('records a priority upgrade so a restored item keeps it', () => {
    const store = openStore(tmpDir());
    queue = new ScrapeQueue(true);
    queue.setQueueStore(store);
    queue.enqueue('a1', { url: urlFor('a1'), priority: 'COLD' });
    queue.enqueue('a1', { url: urlFor('a1'), priority: 'HOT' });

    expect(store.restore(Date.now()).pending[0].priority).toBe('HOT');
  });
});

describe('ScrapeQueue — dispatch, completion and retry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ advanceTimers: true });
    resetScrapeQueue();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  async function flush(ms: number, iterations = 3) {
    for (let i = 0; i < iterations; i++) {
      jest.advanceTimersByTime(ms / iterations);
      await jest.advanceTimersByTimeAsync(50);
    }
  }

  it('takes a lease on dispatch and removes the row on success', async () => {
    const store = openStore(tmpDir());
    const scraping = scrapingStub();
    queue = new ScrapeQueue(false);
    queue.setQueueStore(store);
    queue.setPluginRegistry(makeRegistry());
    queue.setIngestEmitter({ send: jest.fn().mockResolvedValue(okWriteStats()) });
    queue.setScrapingService(scraping);

    queue.enqueue('a1', { url: urlFor('a1') });
    // Dispatch is synchronous inside enqueue (startProcessing → processNext → getNextProcessableItem),
    // so the row is already LEASED — that is the crash-safety marker the next process reaps.
    expect(store.counts()).toEqual({ pending: 0, leased: 1, parked: 0 });

    await flush(200);

    expect(scraping.scrapePage).toHaveBeenCalledTimes(1);
    // Completed → the row is gone. A restart after this must NOT re-scrape it.
    expect(store.counts()).toEqual({ pending: 0, leased: 0, parked: 0 });
  });

  it('writes the attempt count back on a retryable failure', async () => {
    const store = openStore(tmpDir());
    const scraping = scrapingStub(() => Promise.reject(new Error('NETWORK timeout reaching host')));
    queue = new ScrapeQueue(false);
    queue.setQueueStore(store);
    queue.setPluginRegistry(makeRegistry());
    queue.setIngestEmitter({ send: jest.fn().mockResolvedValue(okWriteStats()) });
    queue.setScrapingService(scraping);

    queue.enqueue('a1', { url: urlFor('a1'), maxRetries: 3 });
    await flush(400);

    const restored = store.restore(Date.now());
    expect(restored.pending).toHaveLength(1);
    // The re-drive after a restart must not start this item's attempt budget over.
    expect(restored.pending[0].attempts).toBeGreaterThanOrEqual(1);
    expect(restored.pending[0].lastErrorClass).toBeDefined();
  });

  it('drops the row when the queue gives up', async () => {
    const store = openStore(tmpDir());
    // auth_required is never retried: one attempt, then terminal.
    const scraping = scrapingStub(() => Promise.reject(new Error('AUTH required for this item')));
    queue = new ScrapeQueue(false);
    queue.setQueueStore(store);
    queue.setPluginRegistry(makeRegistry());
    queue.setIngestEmitter({ send: jest.fn().mockResolvedValue(okWriteStats()) });
    queue.setScrapingService(scraping);

    queue.enqueue('a1', { url: urlFor('a1') });
    await flush(400);

    expect(queue.getStats().failed).toBe(1);
    // The fetch_failure ledger already books a terminal failure; this store is not a history.
    expect(store.counts()).toEqual({ pending: 0, leased: 0, parked: 0 });
  });
});

describe('ScrapeQueue — startup reconciliation', () => {
  it('reloads pending rows into the tiers with their attempt counts', () => {
    const dir = tmpDir();
    const first = openStore(dir);
    first.put({
      id: 'a1-1', mfcId: 'a1', url: urlFor('a1'), priority: 'HOT',
      attempts: 2, maxRetries: 3, enqueuedAt: 1_000, state: 'pending', lastErrorClass: 'timeout',
    });
    first.put({
      id: 'a2-1', mfcId: 'a2', url: urlFor('a2'), priority: 'COLD',
      attempts: 0, maxRetries: 3, enqueuedAt: 2_000, state: 'pending',
    });
    first.close();

    const second = openStore(dir);
    queue = new ScrapeQueue(true);
    queue.setQueueStore(second);
    const summary = queue.restoreFromStore(9_000);

    expect(summary).toMatchObject({ pending: 2, leasedExpired: 0, cooldowns: 0 });
    const stats = queue.getStats();
    expect(stats.total).toBe(2);
    expect(stats.hot).toBe(1);
    expect(stats.cold).toBe(1);
    expect(queue.isPending('a1')).toBe(true);
  });

  it('carries the attempt BUDGET across the restart — a restored item does not start over', async () => {
    jest.useFakeTimers({ advanceTimers: true });
    try {
      const store = openStore(tmpDir());
      // Restored with its budget already spent: the very next failure must be terminal.
      store.put({
        id: 'a1-1', mfcId: 'a1', url: urlFor('a1'), priority: 'WARM',
        attempts: 3, maxRetries: 3, enqueuedAt: Date.now(), state: 'pending', lastErrorClass: 'network',
      });
      const scraping = scrapingStub(() => Promise.reject(new Error('NETWORK unreachable')));
      queue = new ScrapeQueue(false);
      queue.setQueueStore(store);
      queue.setPluginRegistry(makeRegistry());
      queue.setIngestEmitter({ send: jest.fn().mockResolvedValue(okWriteStats()) });
      queue.setScrapingService(scraping);
      queue.restoreFromStore(Date.now());

      for (let i = 0; i < 3; i++) {
        jest.advanceTimersByTime(200);
        await jest.advanceTimersByTimeAsync(50);
      }

      // ONE attempt, then terminal — a reset counter would have allowed four.
      expect(scraping.scrapePage).toHaveBeenCalledTimes(1);
      expect(queue.getStats().failed).toBe(1);
      const lines = (console.log as unknown as jest.Mock).mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.includes('Gave up on a1 after 4 attempts'))).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('reloads a row whose lease expired (a crash mid-navigation)', () => {
    const dir = tmpDir();
    const first = openStore(dir);
    first.put({
      id: 'a1-1', mfcId: 'a1', url: urlFor('a1'), priority: 'WARM',
      attempts: 1, maxRetries: 3, enqueuedAt: 1_000, state: 'pending',
    });
    first.lease('a1-1', 2_000);
    first.close();

    const second = openStore(dir);
    queue = new ScrapeQueue(true);
    queue.setQueueStore(second);
    const summary = queue.restoreFromStore(9_000);

    expect(summary).toMatchObject({ pending: 0, leasedExpired: 1 });
    expect(queue.getStats().total).toBe(1);
    expect(queue.isPending('a1')).toBe(true);
  });

  it('reloads unexpired cooldowns so a restart does not hammer a cooling host', () => {
    const dir = tmpDir();
    const store = openStore(dir);
    store.saveCooldown({ host: HOST, until: 900_000, reason: 'challenge page', openedAt: 1_000 });

    const cooldown = new ChallengeCooldown({ now: () => 50_000 });
    queue = new ScrapeQueue(true);
    queue.setQueueStore(store);
    queue.setChallengeCooldown(cooldown);
    const summary = queue.restoreFromStore(50_000);

    expect(summary.cooldowns).toBe(1);
    expect(cooldown.isOpen(HOST)).toBe(true);
  });

  it('logs a one-line summary naming the path', () => {
    const dir = tmpDir();
    const store = openStore(dir);
    store.put({
      id: 'a1-1', mfcId: 'a1', url: urlFor('a1'), priority: 'WARM',
      attempts: 0, maxRetries: 3, enqueuedAt: 1_000, state: 'pending',
    });
    queue = new ScrapeQueue(true);
    queue.setQueueStore(store);
    queue.restoreFromStore(9_000);

    const lines = (console.log as unknown as jest.Mock).mock.calls.map((c) => String(c[0]));
    const restored = lines.filter((l) => l.includes('[SCRAPE QUEUE] restored'));
    expect(restored).toHaveLength(1);
    expect(restored[0]).toContain('restored 1 pending, 0 leased-expired, 0 cooldowns from');
    expect(restored[0]).toContain(store.path);
  });

  it('is a silent no-op when the store is the in-memory fallback', () => {
    queue = new ScrapeQueue(true);
    const summary = queue.restoreFromStore(9_000);

    expect(summary).toMatchObject({ pending: 0, leasedExpired: 0, cooldowns: 0 });
    const lines = (console.log as unknown as jest.Mock).mock.calls.map((c) => String(c[0]));
    expect(lines.filter((l) => l.includes('[SCRAPE QUEUE] restored'))).toHaveLength(0);
  });
});

describe('ScrapeQueue — graceful shutdown', () => {
  it('releases leases on SIGTERM so a planned rollout loses nothing', () => {
    const dir = tmpDir();
    const first = openStore(dir);
    first.put({
      id: 'a1-1', mfcId: 'a1', url: urlFor('a1'), priority: 'WARM',
      attempts: 0, maxRetries: 3, enqueuedAt: 1_000, state: 'pending',
    });
    first.lease('a1-1', Date.now() + 600_000);

    queue = new ScrapeQueue(true);
    queue.setQueueStore(first);
    expect(queue.releaseLeasesForShutdown()).toBe(1);
    first.close();

    // The next start finds it PENDING — not an unexpired lease it has to wait out.
    const second = openStore(dir);
    const restored = second.restore(Date.now());
    expect(restored.pending.map((i) => i.id)).toEqual(['a1-1']);
    expect(restored.stillLeased).toBe(0);
  });

  it('is a safe no-op with the in-memory fallback', () => {
    queue = new ScrapeQueue(true);
    expect(queue.releaseLeasesForShutdown()).toBe(0);
  });
});

describe('ScrapeQueue — bounded working set', () => {
  it('parks overflow beyond the resident cap on disk, not in the heap', () => {
    process.env.SCRAPE_QUEUE_MAX_RESIDENT = '3';
    const store = openStore(tmpDir());
    queue = new ScrapeQueue(true);
    queue.setQueueStore(store);

    for (let i = 0; i < 6; i++) queue.enqueue(`a${i}`, { url: urlFor(`a${i}`) });

    // Three resident, three on disk — depth is a disk number above the cap.
    expect(queue.getStats().total).toBe(3);
    expect(store.counts()).toEqual({ pending: 3, leased: 0, parked: 3 });
    // Every item is still accounted for: nothing was dropped to stay under the cap.
    expect(queue.getStats().parked).toBe(3);
  });

  it('caps the resident items for ONE host so it cannot crowd out other hosts', () => {
    process.env.SCRAPE_QUEUE_MAX_RESIDENT = '100';
    process.env.SCRAPE_QUEUE_MAX_RESIDENT_PER_HOST = '2';
    const store = openStore(tmpDir());
    queue = new ScrapeQueue(true);
    queue.setQueueStore(store);

    for (let i = 0; i < 5; i++) queue.enqueue(`a${i}`, { url: `https://busy.test/item/a${i}` });
    queue.enqueue('b0', { url: 'https://quiet.test/item/b0' });

    const stats = queue.getStats();
    // 2 from the busy host + the quiet host's one — the burst did not consume the working set.
    expect(stats.total).toBe(3);
    expect(store.counts().parked).toBe(3);
  });

  it('pages parked items back in as the resident set drains', () => {
    process.env.SCRAPE_QUEUE_MAX_RESIDENT = '2';
    const store = openStore(tmpDir());
    queue = new ScrapeQueue(true);
    queue.setQueueStore(store);

    for (let i = 0; i < 5; i++) queue.enqueue(`a${i}`, { url: urlFor(`a${i}`) });
    expect(queue.getStats().total).toBe(2);

    queue.cancel('a0');
    queue.cancel('a1');
    expect(queue.refillWorkingSet(Date.now())).toBe(2);
    expect(queue.getStats().total).toBe(2);
    expect(queue.isPending('a2')).toBe(true);
  });

  it('dedupes against a PARKED item rather than queueing it twice', () => {
    process.env.SCRAPE_QUEUE_MAX_RESIDENT = '1';
    const store = openStore(tmpDir());
    queue = new ScrapeQueue(true);
    queue.setQueueStore(store);

    queue.enqueue('a0', { url: urlFor('a0') });
    queue.enqueue('a1', { url: urlFor('a1') }); // parked
    expect(store.counts().parked).toBe(1);

    const again = queue.enqueue('a1', { url: urlFor('a1') });

    expect(again.deduplicated).toBe(true);
    // One row, promoted for the caller who is now waiting on it — not a second row.
    expect(store.counts()).toMatchObject({ parked: 0 });
    expect(store.hasKey('a1')).toBe(true);
    expect(queue.isPending('a1')).toBe(true);
  });

  it('NEVER parks when the store is the in-memory fallback (parking without disk would delete items)', () => {
    process.env.SCRAPE_QUEUE_MAX_RESIDENT = '2';
    queue = new ScrapeQueue(true);

    for (let i = 0; i < 5; i++) queue.enqueue(`a${i}`, { url: urlFor(`a${i}`) });

    expect(queue.getStats().total).toBe(5);
    expect(queue.getStats().parked).toBe(0);
  });

  it('keeps today\'s behaviour below the default cap (no parking at normal depth)', () => {
    const store = openStore(tmpDir());
    queue = new ScrapeQueue(true);
    queue.setQueueStore(store);

    for (let i = 0; i < 200; i++) queue.enqueue(`a${i}`, { url: urlFor(`a${i}`) });

    // Live depth is normally < 500 and the default cap is 1000, so nothing parks today.
    expect(queue.getStats().total).toBe(200);
    expect(store.counts().parked).toBe(0);
  });
});

describe('ScrapeQueue — observability contract', () => {
  it('publishes a queueStore view for /health/detailed', () => {
    const store = openStore(tmpDir());
    queue = new ScrapeQueue(true);
    queue.setQueueStore(store);
    queue.restoreFromStore(1_000);
    queue.enqueue('a1', { url: urlFor('a1') });

    const view = queue.getQueueStoreView();
    expect(view).toMatchObject({
      durable: true, reason: 'ok', pending: 1, leased: 0, quarantinedPath: null, lostAtStartup: 0,
    });
    expect(view.path).toBe(store.path);
    expect(view.restoredAt).toEqual(expect.any(String));
  });

  it('carries the store reason through to the health view', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'scrape-queue.db'), 'not a database');
    const store = createQueueStore({ dir });
    stores.push(store);
    queue = new ScrapeQueue(true);
    queue.setQueueStore(store);

    // A recovered store is STILL durable — the reason is what tells the operator it happened.
    expect(queue.getQueueStoreView()).toMatchObject({ durable: true, reason: 'open_failed_recovered' });
    expect(queue.getQueueStoreView().quarantinedPath).toMatch(/corrupt-/);
  });

  it('reports the fallback honestly rather than pretending to be durable', () => {
    queue = new ScrapeQueue(true);

    expect(queue.getQueueStoreView()).toMatchObject({
      durable: false,
      reason: 'disabled',
      path: null,
      quarantinedPath: null,
      lostAtStartup: 0,
      restoredAt: null,
      pending: 0,
      leased: 0,
    });
  });

  it('leaves the existing [SCRAPE QUEUE] log lines and stats fields untouched', () => {
    const store = openStore(tmpDir());
    queue = new ScrapeQueue(true);
    queue.setQueueStore(store);
    queue.enqueue('a1', { url: urlFor('a1'), priority: 'WARM' });

    const lines = (console.log as unknown as jest.Mock).mock.calls.map((c) => String(c[0]));
    // The fleet health checks grep this exact shape.
    expect(lines.some((l) => /^\[SCRAPE QUEUE\] Enqueued .* at priority WARM \(queue size: 1\)$/.test(l))).toBe(true);

    const stats = queue.getStats();
    // hot + warm + cold still sums to total: `parked` is ADDITIVE, never folded into the old fields.
    expect(stats.hot + stats.warm + stats.cold).toBe(stats.total);
    expect(stats).toMatchObject({ hot: 0, warm: 1, cold: 0, total: 1, processing: 0, completed: 0, failed: 0 });
    expect(stats.byStatus).toBeDefined();
  });
});

/**
 * The `kill -9` / OOM path. A planned SIGTERM releases its leases (above), but a hard kill cannot:
 * the row stays marked in-flight and NOTHING releases it but its own expiry. The reaper inside
 * refillWorkingSet is the only thing that ever re-drives that item, so it has to be exercised
 * through the queue, not just through the store.
 */
describe('ScrapeQueue — reaping a lease no process holds', () => {
  it('re-drives an item whose lease expired while nobody was holding it', () => {
    const dir = tmpDir();
    const first = openStore(dir);
    first.put({
      id: 'a1-1', mfcId: 'a1', url: urlFor('a1'), priority: 'WARM',
      attempts: 1, maxRetries: 3, enqueuedAt: 1_000, state: 'pending',
    });
    first.lease('a1-1', 5_000);
    first.close(); // hard kill — no shutdown bookkeeping ran

    const second = openStore(dir);
    queue = new ScrapeQueue(true);
    queue.setQueueStore(second);
    // Restore leaves an UNEXPIRED lease alone, so nothing comes back yet.
    expect(queue.restoreFromStore(2_000)).toMatchObject({ pending: 0, leasedExpired: 0, stillLeased: 1 });
    expect(queue.getStats().total).toBe(0);

    // Once the lease expires, the reaper puts it back — with its attempt count intact.
    expect(queue.refillWorkingSet(600_000)).toBe(1);
    expect(queue.getStats().total).toBe(1);
    expect(queue.isPending('a1')).toBe(true);
  });

  it('does not re-adopt an item that is already resident', () => {
    const dir = tmpDir();
    const store = openStore(dir);
    queue = new ScrapeQueue(true);
    queue.setQueueStore(store);
    queue.enqueue('a1', { url: urlFor('a1') });
    store.lease(store.restore(1_000).pending[0].id, 5_000);

    // The row reads as an expired lease, but the live item never left the tier: adopting it again
    // would put a SECOND QueueItem for the same key in the queue.
    expect(queue.refillWorkingSet(600_000)).toBe(0);
    expect(queue.getStats().total).toBe(1);
  });

  it('throttles the reaper to one sweep per interval', () => {
    const store = openStore(tmpDir());
    const spy = jest.spyOn(store, 'reapExpiredLeases');
    queue = new ScrapeQueue(true);
    queue.setQueueStore(store);

    queue.refillWorkingSet(1_000_000);
    queue.refillWorkingSet(1_000_100); // well inside the interval
    queue.refillWorkingSet(1_100_000); // past it

    // One query a minute, not one per dispatch — this runs before every scan.
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('ScrapeQueue — working-set caps with resident items', () => {
  it('skips a host that is at its cap when paging, and pages a different host', () => {
    process.env.SCRAPE_QUEUE_MAX_RESIDENT = '10';
    process.env.SCRAPE_QUEUE_MAX_RESIDENT_PER_HOST = '2';
    const store = openStore(tmpDir());
    queue = new ScrapeQueue(true);
    queue.setQueueStore(store);

    // busy.test fills its per-host cap; the rest of its burst parks.
    for (let i = 0; i < 4; i++) queue.enqueue(`b${i}`, { url: `https://busy.test/item/b${i}` });
    expect(queue.getStats()).toMatchObject({ total: 2, parked: 2 });

    // A refill must NOT pull busy.test's backlog back in — it is already at its cap — even though
    // the overall working set has room.
    expect(queue.refillWorkingSet(Date.now())).toBe(0);
    expect(queue.getStats()).toMatchObject({ total: 2, parked: 2 });

    // A different host still gets in, which is the whole point of the per-host cap.
    queue.enqueue('q0', { url: 'https://quiet.test/item/q0' });
    expect(queue.getStats()).toMatchObject({ total: 3, parked: 2 });
  });

  it('never parks an item whose url will not parse (a host we cannot name is not a host at cap)', () => {
    process.env.SCRAPE_QUEUE_MAX_RESIDENT = '10';
    process.env.SCRAPE_QUEUE_MAX_RESIDENT_PER_HOST = '1';
    const store = openStore(tmpDir());
    queue = new ScrapeQueue(true);
    queue.setQueueStore(store);

    queue.enqueue('a0', { url: urlFor('a0') });
    queue.enqueue('weird', { url: 'not-a-url' });

    expect(queue.getStats()).toMatchObject({ total: 2, parked: 0 });
  });

  it('settles a parked item\'s promise when the queue is cleared', async () => {
    process.env.SCRAPE_QUEUE_MAX_RESIDENT = '1';
    const store = openStore(tmpDir());
    // testMode FALSE so clear() actually rejects, as it does in production. The first dispatch is
    // made to hang, which holds the processing lock and lets the tier fill behind it.
    queue = new ScrapeQueue(false);
    queue.setQueueStore(store);
    queue.setPluginRegistry(makeRegistry());
    queue.setIngestEmitter({ send: jest.fn().mockResolvedValue(okWriteStats()) });
    queue.setScrapingService(scrapingStub(() => new Promise(() => {})));

    queue.enqueue('a0', { url: urlFor('a0') }); // dispatched, leaves the tier, never returns
    queue.enqueue('a1', { url: urlFor('a1') }); // resident (tier = 1 = the cap)
    const parked = queue.enqueue('a2', { url: urlFor('a2') }); // over the cap → disk
    expect(store.counts().parked).toBe(1);

    // A parked item has no QueueItem in the heap — only the caller's handlers — so clear() has to
    // settle it from `parkedResolvers` or the caller waits forever on work that no longer exists.
    const settled = expect(parked.promise).rejects.toThrow('Queue cleared');
    queue.clear();
    await settled;
  });
});

/**
 * END-TO-END for the cooldown leg. The unit tests in challengeCooldownPersistence.test.ts construct
 * a register with an explicit sink, so they pass whether or not anything WIRES one in production.
 * This closes that gap: opening a cooldown through the register the queue actually consults must
 * reach the store, or "cooldowns survive a restart" is true only in tests.
 */
describe('ScrapeQueue — cooldowns are written through, not just read back', () => {
  it('a cooldown opened after the store is wired lands on disk and comes back next boot', () => {
    const dir = tmpDir();
    const first = openStore(dir);
    const cooldown = new ChallengeCooldown({ now: () => 1_000, windowMs: 600_000 });
    queue = new ScrapeQueue(true);
    queue.setChallengeCooldown(cooldown);
    queue.setQueueStore(first);

    cooldown.open('anitoysgk.com', 'challenge page');
    first.close();

    // A fresh process: the window is still open, so the host must NOT be fetched.
    const second = openStore(dir);
    const restored = second.restore(300_000);
    expect(restored.cooldowns.map((c) => c.host)).toEqual(['anitoysgk.com']);
    expect(restored.cooldowns[0].until).toBe(601_000);
  });

  it('clearing a cooldown removes it from the store too', () => {
    const dir = tmpDir();
    const store = openStore(dir);
    const cooldown = new ChallengeCooldown({ now: () => 1_000, windowMs: 600_000 });
    queue = new ScrapeQueue(true);
    queue.setChallengeCooldown(cooldown);
    queue.setQueueStore(store);

    cooldown.open('a.example', 'challenge page');
    cooldown.clear('a.example');

    // A host that has since served a clean fetch must not be held off after a restart.
    expect(store.restore(300_000).cooldowns).toEqual([]);
  });

  it('does not attach a non-durable store as the cooldown sink', () => {
    const cooldown = new ChallengeCooldown({ now: () => 1_000 });
    queue = new ScrapeQueue(true);
    queue.setChallengeCooldown(cooldown);
    queue.setQueueStore(null);

    // No disk behind it: writing through would be a no-op anyway, and attaching one would leave the
    // register holding a reference to a store the queue no longer uses.
    expect(() => cooldown.open('a.example', 'challenge page')).not.toThrow();
    expect(cooldown.isOpen('a.example')).toBe(true);
  });
});
