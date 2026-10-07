/**
 * QB-U19: queue dispatch through POOL-SELECT, per class (host + tier), behind SCRAPE_POOL_SELECT.
 *
 * A real ScrapeQueue on a real SQLite store, a fake record transport, fake timers. What is pinned here:
 * class_entered_at is stamped on insert, re-stamped by a raise (a dedup enqueue at a higher priority,
 * of a resident or a PARKED row) and kept by a retry, a same-priority dedup enqueue and a restart;
 * pooled picks replay from the seed; HOT stays FIFO and first (a parked HOT row included); a hard-aged
 * PARKED row is paged in and dispatched by R1; pooled picks still pass the host floor and the shared
 * host clock; skip marks go on completion, give-up, cancel and clear; off never calls the pool; and the
 * per-host pool block (/health/detailed) with its modes, counters and agedCount.
 */
jest.mock('../../services/genericScraper', () => ({
  BrowserPool: { getStealthBrowser: jest.fn(), getBrowser: jest.fn(), returnBrowser: jest.fn(), getPoolSize: jest.fn().mockReturnValue(2), getPoolCapacity: jest.fn().mockReturnValue(3), reset: jest.fn() },
}));
jest.mock('../../services/webhookClient', () => ({
  notifyItemSuccess: jest.fn().mockResolvedValue(true),
  notifyItemFailed: jest.fn().mockResolvedValue(true),
  notifyItemSkipped: jest.fn().mockResolvedValue(true),
}));

import * as fs from 'fs';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { ScrapeQueue, resetScrapeQueue, type QueuePriority } from '../../services/scrapeQueue';
import { QUEUE_DB_FILE, type ScrapeQueueStore } from '../../services/queueStore';
import { PoolDispatch, POOL_SELECT_ENV, setPoolDispatch, type PoolPickEvent } from '../../services/poolDispatch';
import { HostClock, parseHostClockScope, setHostClock } from '../../services/hostClock';
import { openPoolStore, poolTmpDir, wirePoolQueue, type SiteSpec, type TransportCall } from '../helpers/poolQueueHarness';

const T0 = 1_800_000_000_000;
const H = 3_600_000;
const HOST = 'pool.test';
const SITES: SiteSpec[] = [
  { siteId: 'pool', domain: HOST, baseDelayMs: 1000 },
  { siteId: 'other', domain: 'other.test', baseDelayMs: 1000 },
];
const url = (id: number, host = HOST) => `https://${host}/item/${id}`;

let dirs: string[] = [];
let stores: ScrapeQueueStore[] = [];
let queues: ScrapeQueue[] = [];

afterEach(() => {
  for (const q of queues) {
    q.stop();
    q.clear();
  }
  queues = [];
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
  delete process.env[POOL_SELECT_ENV];
  delete process.env.SCRAPE_QUEUE_MAX_RESIDENT;
  delete process.env.SCRAPE_QUEUE_MAX_RESIDENT_PER_HOST;
  setPoolDispatch(null);
  resetScrapeQueue();
});

interface Rig {
  queue: ScrapeQueue;
  store: ScrapeQueueStore;
  dir: string;
  calls: TransportCall[];
  picks: PoolPickEvent[];
  pool: PoolDispatch;
}

function rig(opts: { select?: string; seed?: number; ageCaps?: string; dir?: string; failures?: Array<[string, number]> } = {}): Rig {
  const dir = opts.dir ?? poolTmpDir('pool-dispatch-');
  if (!dirs.includes(dir)) dirs.push(dir);
  const store = openPoolStore(dir);
  stores.push(store);
  const calls: TransportCall[] = [];
  const picks: PoolPickEvent[] = [];
  const pool = new PoolDispatch({ select: opts.select ?? 'all', seed: opts.seed ?? 1, ageCaps: opts.ageCaps, onPick: (e) => picks.push(e) });
  const queue = wirePoolQueue({ store, sites: SITES, calls, failuresLeft: new Map(opts.failures ?? []) });
  queue.setPoolDispatch(pool);
  queues.push(queue);
  return { queue, store, dir, calls, picks, pool };
}

const ceaOnDisk = (dir: string, key: string): unknown => {
  const db = new DatabaseSync(path.join(dir, QUEUE_DB_FILE), { readOnly: true });
  try {
    const row = db.prepare('SELECT class_entered_at AS c FROM queue_items WHERE mfc_id = ?').get(key) as unknown as { c: unknown } | undefined;
    return row?.c;
  } finally {
    db.close();
  }
};

const keysOf = (calls: TransportCall[], host = HOST) => calls.filter((c) => new URL(c.url).hostname === host).map((c) => Number(new URL(c.url).pathname.split('/').pop()));

async function advance(ms: number, step = 500): Promise<void> {
  for (let t = 0; t < ms; t += step) await jest.advanceTimersByTimeAsync(step);
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(T0);
});

describe('class_entered_at on the queue', () => {
  it('is stamped on insert, re-stamped by a raise, kept by a same-priority dedup and by a retry', async () => {
    const r = rig({ select: 'off', failures: [[url(3), 1]] });
    // The first enqueue is dispatched at once and holds the host's floor, so the rest wait.
    r.queue.enqueue('k0', { url: url(100), priority: 'WARM' });
    r.queue.enqueue('k1', { url: url(1), priority: 'COLD' });
    r.queue.enqueue('k2', { url: url(2), priority: 'WARM' });
    r.queue.enqueue('k3', { url: url(3), priority: 'WARM' });
    expect(ceaOnDisk(r.dir, 'k1')).toBe(T0);
    expect(ceaOnDisk(r.dir, 'k2')).toBe(T0);
    jest.setSystemTime(T0 + 500);
    r.queue.enqueue('k2', { url: url(2), priority: 'WARM' }); // dedup, same priority
    expect(ceaOnDisk(r.dir, 'k2')).toBe(T0);
    r.queue.enqueue('k1', { url: url(1), priority: 'WARM' }); // dedup at a higher priority: a raise
    expect(ceaOnDisk(r.dir, 'k1')).toBe(T0 + 500);
    await advance(10_000);
    // k3 failed once (500) and was retried: its stamp did not move.
    expect(r.calls.filter((c) => c.url === url(3)).map((c) => c.status)).toEqual([500, 200]);
    expect(ceaOnDisk(r.dir, 'k3')).toBeUndefined(); // completed: the row is gone
  });

  it('a retry keeps the stamp on disk while the item waits', async () => {
    const r = rig({ select: 'off', failures: [[url(1), 1]] });
    jest.setSystemTime(T0);
    r.queue.enqueue('k1', { url: url(1), priority: 'WARM' });
    r.queue.enqueue('k2', { url: url(2), priority: 'WARM' });
    await jest.advanceTimersByTimeAsync(10); // k1 dispatched (500) and re-queued; k2 waits for the floor
    expect(r.calls.map((c) => c.status)).toEqual([500]);
    expect(ceaOnDisk(r.dir, 'k1')).toBe(T0);
  });

  it('a raise of a PARKED row claims it and re-stamps it', () => {
    process.env.SCRAPE_QUEUE_MAX_RESIDENT_PER_HOST = '1';
    const r = rig({ select: 'off' });
    r.queue.enqueue('k0', { url: url(100), priority: 'WARM' });
    r.queue.enqueue('k1', { url: url(1), priority: 'WARM' });
    r.queue.enqueue('k2', { url: url(2), priority: 'COLD' });
    expect(r.store.listParked(HOST, 'COLD').map((p) => p.mfcId)).toEqual(['k2']);
    jest.setSystemTime(T0 + 9_000);
    r.queue.enqueue('k2', { url: url(2), priority: 'WARM' });
    expect(ceaOnDisk(r.dir, 'k2')).toBe(T0 + 9_000);
  });

  it('a restart restores the class entry: the pool ages the raised row from the raise, not the first enqueue', async () => {
    const dir = poolTmpDir('pool-restart-');
    dirs.push(dir);
    const first = rig({ select: 'off', dir });
    first.queue.enqueue('k0', { url: url(100), priority: 'WARM' });
    first.queue.enqueue('k1', { url: url(1), priority: 'COLD' });
    await jest.advanceTimersByTimeAsync(0); // k0 (dispatched at once) completes; k1 waits for the floor
    jest.setSystemTime(T0 + 2 * H);
    first.queue.enqueue('k1', { url: url(1), priority: 'WARM' });
    first.queue.stop();
    first.queue.releaseLeasesForShutdown();
    first.store.close();
    first.queue.clear();
    jest.setSystemTime(T0 + 3 * H);
    const second = rig({ select: 'all', dir });
    second.queue.restoreFromStore(Date.now());
    await jest.advanceTimersByTimeAsync(10);
    expect(second.picks.map((p) => [p.key, p.waitMs])).toEqual([['k1', 1 * H]]);
  });
});

describe('pooled picks', () => {
  async function dispatchOrder(seed: number): Promise<number[]> {
    const r = rig({ select: 'all', seed });
    for (let i = 1; i <= 40; i++) r.queue.enqueue(`k${i}`, { url: url(1000 + i), priority: 'WARM' });
    await advance(45_000);
    return keysOf(r.calls);
  }

  it('reproduce for a fixed seed, and differ for another seed; every item is dispatched once', async () => {
    const a = await dispatchOrder(11);
    jest.setSystemTime(T0);
    const b = await dispatchOrder(11);
    jest.setSystemTime(T0);
    const c = await dispatchOrder(12);
    expect(a).toHaveLength(40);
    expect(a).toEqual(b);
    expect(c).not.toEqual(a);
    expect([...a].sort((x, y) => x - y)).toEqual(Array.from({ length: 40 }, (_, i) => 1001 + i));
    // Not a walk: FIFO would be 1001, 1002, ... in order.
    expect(a).not.toEqual([...a].sort((x, y) => x - y));
  });

  it('every pooled pick is reported with its class, rule and the candidate count', async () => {
    const r = rig({ select: 'all', seed: 3 });
    r.queue.enqueue('k0', { url: url(1), priority: 'WARM' }); // dispatched at once, alone in its class
    for (let i = 1; i <= 10; i++) r.queue.enqueue(`k${i}`, { url: url(i * 100), priority: 'WARM' });
    await advance(12_000);
    expect(r.picks).toHaveLength(11);
    expect(r.picks[1]).toMatchObject({ host: HOST, classKey: `${HOST}|WARM`, poolSize: 10, retry: false });
    expect(r.picks.map((p) => p.poolSize)).toEqual([1, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  });

  it('HOT stays FIFO and first: a HOT item enqueued behind pooled WARM items goes next', async () => {
    const r = rig({ select: 'all', seed: 5 });
    for (let i = 1; i <= 10; i++) r.queue.enqueue(`w${i}`, { url: url(i * 100), priority: 'WARM' });
    await jest.advanceTimersByTimeAsync(10);
    r.queue.enqueue('h1', { url: url(7), priority: 'HOT' });
    r.queue.enqueue('h2', { url: url(8), priority: 'HOT' });
    await advance(3_000);
    expect(keysOf(r.calls).slice(1, 3)).toEqual([7, 8]);
    expect(r.picks.some((p) => p.key === 'h1' || p.key === 'h2')).toBe(false);
    expect(r.picks.length).toBeGreaterThan(0); // the WARM class was pooled
  });

  it('HOT first also for a HOT row PARKED over the per-host cap', async () => {
    process.env.SCRAPE_QUEUE_MAX_RESIDENT_PER_HOST = '3';
    const r = rig({ select: 'all', seed: 5 });
    for (let i = 1; i <= 6; i++) r.queue.enqueue(`w${i}`, { url: url(i * 100), priority: 'WARM' });
    await jest.advanceTimersByTimeAsync(10);
    r.queue.enqueue('h1', { url: url(7), priority: 'HOT' });
    expect(r.store.listParked(HOST, 'HOT').map((p) => p.mfcId)).toEqual(['h1']);
    await advance(1_500);
    expect(keysOf(r.calls)[1]).toBe(7);
  });

  it('a WARM row parked while only COLD rows of its host are resident goes before them', async () => {
    process.env.SCRAPE_QUEUE_MAX_RESIDENT_PER_HOST = '3';
    const r = rig({ select: 'all', seed: 5 });
    for (let i = 1; i <= 4; i++) r.queue.enqueue(`c${i}`, { url: url(i * 100), priority: 'COLD' });
    r.queue.enqueue('w1', { url: url(9), priority: 'WARM' });
    expect(r.store.listParked(HOST, 'WARM').map((p) => p.mfcId)).toEqual(['w1']);
    await advance(1_000);
    expect(keysOf(r.calls).slice(0, 2)).toEqual([100, 9]);
  });

  it('page-in follows the rule: a hard-aged PARKED row is paged in and dispatched by R1 ahead of younger residents', async () => {
    const dir = poolTmpDir('pool-pagein-');
    dirs.push(dir);
    const seed = openPoolStore(dir);
    seed.put({ id: 'old-1', mfcId: 'old', url: url(500), priority: 'WARM', attempts: 0, maxRetries: 3, enqueuedAt: T0 - 30 * H, state: 'parked' });
    for (let i = 1; i <= 5; i++) {
      seed.put({ id: `r-${i}`, mfcId: `r${i}`, url: url(i * 100), priority: 'WARM', attempts: 0, maxRetries: 3, enqueuedAt: T0 - i * 1000, state: 'pending' });
    }
    seed.close();
    process.env.SCRAPE_QUEUE_MAX_RESIDENT_PER_HOST = '5';
    const r = rig({ select: 'all', seed: 2, dir });
    expect(r.queue.restoreFromStore(T0)).toMatchObject({ pending: 5, parked: 1 });
    await jest.advanceTimersByTimeAsync(10);
    expect(r.picks[0]).toMatchObject({ key: 'old', rule: 'R1', stage: 'R1', poolSize: 6, waitMs: 30 * H });
    expect(keysOf(r.calls)).toEqual([500]);
    expect(r.store.counts()).toEqual({ pending: 5, leased: 0, parked: 0 });
  });

  it('a PARKED row ages from its class entry, not its first enqueue', async () => {
    const dir = poolTmpDir('pool-parked-cea-');
    dirs.push(dir);
    const seed = openPoolStore(dir);
    // 'raised' was first queued 40 h ago but entered this class 1 h ago; 'old' entered 30 h ago.
    seed.put({ id: 'raised-1', mfcId: 'raised', url: url(500), priority: 'WARM', attempts: 0, maxRetries: 3, enqueuedAt: T0 - 40 * H, classEnteredAt: T0 - 1 * H, state: 'parked' });
    seed.put({ id: 'old-1', mfcId: 'old', url: url(900), priority: 'WARM', attempts: 0, maxRetries: 3, enqueuedAt: T0 - 30 * H, state: 'parked' });
    seed.put({ id: 'r-1', mfcId: 'r1', url: url(100), priority: 'WARM', attempts: 0, maxRetries: 3, enqueuedAt: T0 - 1000, state: 'pending' });
    seed.close();
    process.env.SCRAPE_QUEUE_MAX_RESIDENT_PER_HOST = '1';
    const r = rig({ select: 'all', seed: 2, dir });
    r.queue.restoreFromStore(T0);
    await jest.advanceTimersByTimeAsync(10);
    expect(r.picks[0]).toMatchObject({ key: 'old', rule: 'R1', waitMs: 30 * H, poolSize: 3 });
  });

  it('a retry is reported as one (an item that has spent one attempt)', async () => {
    const r = rig({ select: 'all', seed: 4, failures: [[url(7), 1]] });
    r.queue.enqueue('k7', { url: url(7), priority: 'WARM' });
    await advance(2_000);
    expect(r.picks.map((p) => [p.key, p.retry])).toEqual([['k7', false], ['k7', true]]);
  });

  it('R2 draws over parked rows too: an aged parked row can be the aged pick', async () => {
    const dir = poolTmpDir('pool-r2-');
    dirs.push(dir);
    const seed = openPoolStore(dir);
    seed.put({ id: 'aged-1', mfcId: 'aged', url: url(500), priority: 'WARM', attempts: 0, maxRetries: 3, enqueuedAt: T0 - 13 * H, state: 'parked' });
    seed.put({ id: 'r-1', mfcId: 'r1', url: url(100), priority: 'WARM', attempts: 0, maxRetries: 3, enqueuedAt: T0 - 1000, state: 'pending' });
    seed.close();
    const r = rig({ select: 'all', seed: 2, dir });
    // A draw of 0 is under pAged (0.9): the R2 coin takes the aged set, and the first aged row in rank order.
    r.queue.setPoolDispatch(new PoolDispatch({ select: 'all', seed: 2, rngFor: () => () => 0, onPick: (e) => r.picks.push(e) }));
    r.queue.restoreFromStore(T0);
    await jest.advanceTimersByTimeAsync(10);
    expect(r.picks[0]).toMatchObject({ key: 'aged', rule: 'R2', stage: 'R2', poolSize: 2 });
  });

  it('pooled picks still keep the host floor between dispatches', async () => {
    const r = rig({ select: 'all', seed: 4 });
    for (let i = 1; i <= 12; i++) r.queue.enqueue(`k${i}`, { url: url(i * 100), priority: i % 2 ? 'WARM' : 'COLD' });
    await advance(20_000);
    const times = r.calls.map((c) => c.t);
    expect(times).toHaveLength(12);
    expect(r.picks).toHaveLength(12);
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(1000);
  });

  it('pooled picks pass the shared host clock (SCRAPE_HOST_CLOCK on for the host)', async () => {
    setHostClock(new HostClock(parseHostClockScope(HOST), HOST));
    const r = rig({ select: 'all', seed: 4 });
    for (let i = 1; i <= 8; i++) r.queue.enqueue(`k${i}`, { url: url(i * 100), priority: 'WARM' });
    await advance(15_000);
    const times = r.calls.map((c) => c.t);
    expect(times).toHaveLength(8);
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(1000);
    expect(r.picks).toHaveLength(8);
  });

  it('a host outside the scope stays FIFO and never reaches the pool', async () => {
    const r = rig({ select: 'all,-pool.test', seed: 4 });
    const pick = jest.spyOn(r.pool, 'pick');
    for (let i = 1; i <= 6; i++) r.queue.enqueue(`k${i}`, { url: url(i), priority: 'WARM' });
    for (let i = 1; i <= 3; i++) r.queue.enqueue(`o${i}`, { url: url(i * 100, 'other.test'), priority: 'WARM' });
    await advance(8_000);
    expect(keysOf(r.calls)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(pick.mock.calls.every(([host]) => host === 'other.test')).toBe(true);
    expect(pick).toHaveBeenCalled();
  });

  it('a pick that throws falls back to FIFO for that dispatch, with a warning, and the queue keeps going', async () => {
    const r = rig({ select: 'all', seed: 4 });
    const pick = jest.spyOn(r.pool, 'pick').mockImplementation(() => {
      throw new Error('boom\nforged');
    });
    const warn = console.warn as unknown as jest.Mock;
    warn.mockClear();
    for (let i = 1; i <= 4; i++) r.queue.enqueue(`k${i}`, { url: url(i), priority: 'WARM' });
    await advance(5_000);
    expect(keysOf(r.calls)).toEqual([1, 2, 3, 4]);
    expect(pick).toHaveBeenCalled();
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('pool pick failed'));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toContain('pool pick failed for pool.test, dispatching FIFO: boom forged');
  });

  it('a pick that throws a non-Error is named too', async () => {
    const r = rig({ select: 'all', seed: 4 });
    jest.spyOn(r.pool, 'pick').mockImplementation(() => {
      throw 'plain string';
    });
    const warn = console.warn as unknown as jest.Mock;
    warn.mockClear();
    r.queue.enqueue('k1', { url: url(1), priority: 'WARM' });
    await jest.advanceTimersByTimeAsync(10);
    expect(keysOf(r.calls)).toEqual([1]);
    expect(warn.mock.calls.map((c) => String(c[0])).some((l) => l.endsWith('dispatching FIFO: plain string'))).toBe(true);
  });

  it('a pool that answers -1 (nothing picked) leaves the dispatch to the FIFO head', async () => {
    const r = rig({ select: 'all', seed: 4 });
    jest.spyOn(r.pool, 'pick').mockReturnValue(-1);
    for (let i = 1; i <= 3; i++) r.queue.enqueue(`k${i}`, { url: url(i), priority: 'WARM' });
    await advance(3_000);
    expect(keysOf(r.calls)).toEqual([1, 2, 3]);
  });

  it('a row without a numeric id still pools (anti-sequence passes it)', async () => {
    const r = rig({ select: 'all', seed: 4 });
    r.queue.enqueue('a', { url: `https://${HOST}/item/alpha`, priority: 'WARM' });
    r.queue.enqueue('b', { url: `https://${HOST}/item/beta`, priority: 'WARM' });
    await advance(2_000);
    expect(r.picks.map((p) => p.key)).toEqual(['a', 'b']);
    expect(r.calls.map((c) => c.url)).toEqual([`https://${HOST}/item/alpha`, `https://${HOST}/item/beta`]);
  });

  it('a row held by its user session (paused) is not a candidate; the session row of an active session is', async () => {
    const r = rig({ select: 'all', seed: 4 });
    const internals = r.queue as unknown as { sessionManager: { isSessionPaused(id: string): boolean } };
    jest.spyOn(internals.sessionManager, 'isSessionPaused').mockImplementation((id: string) => id === 'paused');
    r.queue.enqueue('k0', { url: url(1), priority: 'COLD' });
    r.queue.enqueue('held', { url: url(500), priority: 'COLD', cookies: { a: 'b' }, sessionId: 'paused' });
    r.queue.enqueue('live', { url: url(900), priority: 'COLD', cookies: { a: 'b' }, sessionId: 'active' });
    r.queue.enqueue('k2', { url: url(300), priority: 'COLD' });
    await advance(12_000); // a paused row in the scan makes the blocked re-check the generic 5 s poll
    expect(keysOf(r.calls).sort((x, y) => x - y)).toEqual([1, 300, 900]);
    expect(r.picks.every((p) => p.key !== 'held')).toBe(true);
    expect(r.picks.slice(1).map((p) => p.poolSize)).toEqual([2, 1]);
  });

  it('a parked pick whose row vanished before the claim falls back to the FIFO head', async () => {
    const dir = poolTmpDir('pool-vanish-');
    dirs.push(dir);
    const seed = openPoolStore(dir);
    seed.put({ id: 'old-1', mfcId: 'old', url: url(500), priority: 'WARM', attempts: 0, maxRetries: 3, enqueuedAt: T0 - 30 * H, state: 'parked' });
    seed.put({ id: 'r-1', mfcId: 'r1', url: url(100), priority: 'WARM', attempts: 0, maxRetries: 3, enqueuedAt: T0 - 1000, state: 'pending' });
    seed.close();
    process.env.SCRAPE_QUEUE_MAX_RESIDENT_PER_HOST = '1'; // the host is at its cap: no page-in before the pick
    const r = rig({ select: 'all', seed: 2, dir });
    // The parked row is listed, then gone when the queue claims it (another handle took it).
    jest.spyOn(r.store, 'claimKey').mockReturnValue(null);
    r.queue.restoreFromStore(T0);
    await jest.advanceTimersByTimeAsync(10);
    expect(r.picks[0]).toMatchObject({ key: 'old', rule: 'R1' });
    expect(keysOf(r.calls)).toEqual([100]);
  });

  it('off never calls the pool', async () => {
    const r = rig({ select: 'off' });
    const pick = jest.spyOn(r.pool, 'pick');
    for (let i = 1; i <= 6; i++) r.queue.enqueue(`k${i}`, { url: url(i), priority: i % 2 ? 'WARM' : 'COLD' });
    await advance(8_000);
    expect(keysOf(r.calls)).toEqual([1, 3, 5, 2, 4, 6]);
    expect(pick).not.toHaveBeenCalled();
  });
});

describe('skip marks are dropped when the item leaves the queue', () => {
  it('on completion and on give-up (not on a retry)', async () => {
    const r = rig({ select: 'all', seed: 4, failures: [[url(2), 9]] });
    const forget = jest.spyOn(r.pool, 'forget');
    r.queue.enqueue('k1', { url: url(1), priority: 'WARM' });
    r.queue.enqueue('k2', { url: url(2), priority: 'WARM', maxRetries: 1 });
    await advance(5_000);
    expect(r.calls.filter((c) => c.url === url(2)).map((c) => c.status)).toEqual([500]);
    expect(forget.mock.calls.map(([k]) => k).sort()).toEqual(['k1', 'k2']);
  });

  it('on cancel, and every mark on clear', () => {
    const r = rig({ select: 'all', seed: 4 });
    const forget = jest.spyOn(r.pool, 'forget');
    const forgetAll = jest.spyOn(r.pool, 'forgetAll');
    r.queue.enqueue('k1', { url: url(1), priority: 'WARM' });
    r.queue.enqueue('k2', { url: url(2), priority: 'WARM' });
    expect(r.queue.cancel('k2')).toBe(true);
    expect(forget).toHaveBeenCalledWith('k2');
    r.queue.clear();
    expect(forgetAll).toHaveBeenCalledTimes(1);
  });
});

describe('the pool block (getPoolView -> /health/detailed)', () => {
  it('per host: mode, counters over the trailing hour, agedCount over resident AND parked rows; < 4 KB per host', async () => {
    process.env.SCRAPE_QUEUE_MAX_RESIDENT_PER_HOST = '4';
    const r = rig({ select: 'all,-other.test', seed: 6, ageCaps: `${HOST}=1` });
    for (let i = 1; i <= 10; i++) r.queue.enqueue(`k${i}`, { url: url(i * 100), priority: 'WARM' });
    r.queue.enqueue('o1', { url: url(1, 'other.test'), priority: 'WARM' });
    await jest.advanceTimersByTimeAsync(10);
    // k1 went at once; k2..k5 are resident (the per-host cap) and k6..k10 parked.
    expect(r.store.counts().parked).toBe(5);
    const view = r.queue.getPoolView(Date.now());
    const byHost = new Map(view.hosts.map((h) => [h.host, h]));
    expect(view.scope).toBe('all-except');
    expect(view.malformed).toBe(false);
    const pool = byHost.get(HOST)!;
    expect(pool.mode).toBe('pool');
    expect(pool.picks60m).toBe(1);
    expect(pool.agedCount).toBe(0);
    expect(Object.keys(pool)).toEqual([
      'host', 'mode', 'picks60m', 'topBucketShare60m', 'uniformPicks60m', 'agedPicks60m', 'agedShare60m', 'forcedPicks60m',
      'agedCount', 'p99WaitH60m', 'maxWaitH60m', 'redraws60m', 'scanFallbacks60m', 'retryPicks60m',
    ]);
    expect(byHost.get('other.test')).toMatchObject({ mode: 'fifo-excluded', picks60m: 0, agedCount: 0 });
    // 70 minutes on, the 9 still waiting are aged (age cap 1 h): resident and parked alike.
    const aged = r.queue.getPoolView(Date.now() + 70 * 60_000);
    const agedPool = aged.hosts.find((h) => h.host === HOST)!;
    expect(agedPool.agedCount).toBe(9);
    expect(agedPool.picks60m).toBe(0); // the pick left the trailing hour
    for (const h of aged.hosts) expect(Buffer.byteLength(JSON.stringify(h))).toBeLessThan(4096);
  });

  it('lists a host named in the knob even with nothing queued, and the queue\'s hosts with zeros when off', () => {
    const named = rig({ select: 'all,-myfigurecollection.net', seed: 1 });
    expect(named.queue.getPoolView(T0).hosts).toEqual([
      expect.objectContaining({ host: 'myfigurecollection.net', mode: 'fifo-excluded', picks60m: 0 }),
    ]);
    const off = rig({ select: 'off', seed: 1 });
    off.queue.enqueue('k0', { url: url(100), priority: 'WARM' });
    off.queue.enqueue('k1', { url: url(1), priority: 'WARM' });
    expect(off.queue.getPoolView(T0)).toEqual({
      scope: 'off',
      malformed: false,
      hosts: [{
        host: HOST, mode: 'fifo-off', picks60m: 0, topBucketShare60m: 0, uniformPicks60m: 0, agedPicks60m: 0, agedShare60m: 0,
        forcedPicks60m: 0, agedCount: 0, p99WaitH60m: 0, maxWaitH60m: 0, redraws60m: 0, scanFallbacks60m: 0, retryPicks60m: 0,
      }],
    });
  });

  it('skips rows whose URL has no host (resident or parked); defaults to the current time', () => {
    const r = rig({ select: 'all', seed: 1 });
    r.queue.enqueue('k0', { url: url(100), priority: 'WARM' });
    r.queue.enqueue('k1', { url: url(1), priority: 'WARM' });
    r.queue.enqueue('bad', { url: 'not a url', priority: 'WARM' });
    r.store.put({ id: 'p-1', mfcId: 'p', url: 'also not a url', priority: 'WARM', attempts: 0, maxRetries: 3, enqueuedAt: T0, state: 'parked' });
    expect(r.queue.getPoolView().hosts.map((h) => h.host)).toEqual([HOST]);
  });

  it('agedCount counts a row exactly at the age cap (age >= cap), not one a millisecond younger', () => {
    const r = rig({ select: 'all', seed: 1, ageCaps: `${HOST}=1` });
    r.queue.enqueue('k0', { url: url(100), priority: 'WARM' });
    r.queue.enqueue('k1', { url: url(1), priority: 'WARM' });
    jest.setSystemTime(T0 + 1);
    r.queue.enqueue('k2', { url: url(2), priority: 'WARM' });
    expect(r.queue.getPoolView(T0 + H).hosts[0].agedCount).toBe(1);
  });

  it('a FIFO host reads agedCount 0 whatever its rows\' age', () => {
    const r = rig({ select: 'all,-pool.test', seed: 1 });
    r.queue.enqueue('k0', { url: url(100), priority: 'WARM' });
    r.queue.enqueue('k1', { url: url(1), priority: 'WARM' });
    const view = r.queue.getPoolView(T0 + 30 * H);
    expect(view.hosts.map((h) => [h.host, h.mode, h.agedCount])).toEqual([[HOST, 'fifo-excluded', 0]]);
  });

  it('lists a host whose rows are all parked (none resident)', () => {
    const r = rig({ select: 'all', seed: 1 });
    r.store.put({ id: 'o-1', mfcId: 'o1', url: url(5, 'other.test'), priority: 'WARM', attempts: 0, maxRetries: 3, enqueuedAt: T0, state: 'parked' });
    expect(r.queue.getPoolView(T0).hosts.map((h) => [h.host, h.mode])).toEqual([['other.test', 'pool']]);
  });

  it('agedCount leaves out a row held by its user session', () => {
    const r = rig({ select: 'all', seed: 1, ageCaps: `${HOST}=1` });
    const internals = r.queue as unknown as { sessionManager: { isSessionPaused(id: string): boolean } };
    jest.spyOn(internals.sessionManager, 'isSessionPaused').mockReturnValue(true);
    r.queue.enqueue('k0', { url: url(100), priority: 'WARM' });
    r.queue.enqueue('k1', { url: url(1), priority: 'COLD' });
    r.queue.enqueue('held', { url: url(2), priority: 'COLD', cookies: { a: 'b' }, sessionId: 's' });
    expect(r.queue.getPoolView(T0 + 2 * H).hosts.map((h) => [h.host, h.agedCount])).toEqual([[HOST, 1]]);
  });

  it('a malformed knob reads malformed, scope off', () => {
    const r = rig({ select: 'all,pool.test', seed: 1 });
    expect(r.queue.getPoolView(T0)).toMatchObject({ scope: 'off', malformed: true });
  });

  it('without an injected instance the queue uses the process pool (built from the env)', async () => {
    process.env[POOL_SELECT_ENV] = 'all';
    const r = rig({ seed: 1 });
    r.queue.setPoolDispatch(null);
    for (let i = 1; i <= 3; i++) r.queue.enqueue(`k${i}`, { url: url(i * 100), priority: 'WARM' as QueuePriority });
    await advance(4_000);
    expect(r.queue.getPoolView(Date.now()).hosts.find((h) => h.host === HOST)?.picks60m).toBe(3);
  });
});
