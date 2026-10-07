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
import type { Rng } from '../../services/poolSelect';
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
    const pageIn = jest.spyOn(r.store, 'pageIn');
    r.queue.enqueue('h1', { url: url(7), priority: 'HOT' });
    // It parked, and the enqueue's refill paged it in as the host's HOT anchor.
    expect(pageIn.mock.results.flatMap((res) => res.value as Array<{ mfcId: string }>).map((row) => row.mfcId)).toEqual(['h1']);
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
    // The pick was made in the WARM class (its anti-sequence history and skip marks), not the head's COLD one.
    expect(r.picks.find((p) => p.key === 'w1')?.classKey).toBe(`${HOST}|WARM`);
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

  it('counts the picks of a trailing-dot spelling under the host itself', async () => {
    const r = rig({ select: 'all', seed: 1 });
    r.queue.enqueue('k1', { url: `https://${HOST}./item/100`, priority: 'WARM' });
    await jest.advanceTimersByTimeAsync(10);
    expect(r.picks.map((p) => p.host)).toEqual([`${HOST}.`]);
    expect(r.queue.getPoolView(Date.now()).hosts.map((h) => [h.host, h.picks60m])).toEqual([[HOST, 1]]);
  });

  it('agedCount counts PARKED COLD rows past the age cap too', () => {
    const r = rig({ select: 'all', seed: 1, ageCaps: `${HOST}=1` });
    r.store.put(parkedRow('cold', 5, 2 * H, 'COLD'));
    r.store.put(parkedRow('warm', 6, 2 * H, 'WARM'));
    r.store.put(parkedRow('young', 7, 1000, 'COLD'));
    expect(r.queue.getPoolView(T0).hosts.find((h) => h.host === HOST)?.agedCount).toBe(2);
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

/** Every R3 attempt draws (0.999, 0, 0): no uniform pick, bucket 0, rank 0 = the newest row. */
function newestFirst(): Rng {
  let i = 0;
  return () => (i++ % 3 === 0 ? 0.999 : 0);
}

/** A rig whose pool always picks the newest row (R1/R2 do not apply to young rows). */
function newestRig(opts: { select?: string; dir?: string } = {}): Rig {
  const r = rig({ select: opts.select ?? 'all', dir: opts.dir });
  r.pool = new PoolDispatch({ select: opts.select ?? 'all', seed: 1, rngFor: () => newestFirst(), onPick: (e) => r.picks.push(e) });
  r.queue.setPoolDispatch(r.pool);
  return r;
}

/** Resident and parked depth of one host, over its lanes. */
const depth = (q: ScrapeQueue, host: string) =>
  Object.values(q.getLaneCounts(host)).reduce((a, c) => ({ resident: a.resident + c.resident, parked: a.parked + c.parked }), { resident: 0, parked: 0 });

const tierKeys = (q: ScrapeQueue, tier: 'warmQueue' | 'coldQueue' = 'warmQueue') =>
  (q as unknown as Record<string, Array<{ mfcId: string }>>)[tier].map((i) => i.mfcId);

const parkedRow = (key: string, id: number, age: number, priority: QueuePriority = 'WARM', host = HOST) =>
  ({ id: `${key}-1`, mfcId: key, url: url(id, host), priority, attempts: 0, maxRetries: 3, enqueuedAt: T0 - age, state: 'parked' as const });

function seededDir(rows: Array<ReturnType<typeof parkedRow> | (Omit<ReturnType<typeof parkedRow>, 'state'> & { state: 'pending' })>): string {
  const dir = poolTmpDir('pool-ws-');
  dirs.push(dir);
  const seed = openPoolStore(dir);
  for (const row of rows) seed.put(row);
  seed.close();
  return dir;
}

describe('pooled hosts in the working set and the dispatch scan (the excluded host keeps its places)', () => {
  it("the shared page-in leaves a pooled host's parked rows on disk: ONE anchor row, its top page-in row; a FIFO host pages in as before", () => {
    const dir = seededDir([
      parkedRow('pc', 50, 5000, 'COLD'),
      parkedRow('p1', 100, 3000),
      parkedRow('p2', 200, 2000),
      parkedRow('o1', 7, 4000, 'WARM', 'other.test'),
      parkedRow('o2', 9, 1000, 'WARM', 'other.test'),
    ]);
    const r = rig({ select: 'all,-other.test', dir });
    expect(r.queue.restoreFromStore(T0)).toMatchObject({ pending: 0, parked: 5 });
    expect(r.queue.refillWorkingSet(T0)).toBe(3);
    expect(depth(r.queue, HOST)).toEqual({ resident: 1, parked: 2 });
    expect(depth(r.queue, 'other.test')).toEqual({ resident: 2, parked: 0 });
    // The anchor is the host's first row in page-in order: WARM before COLD, then the oldest.
    expect(tierKeys(r.queue).filter((k) => k.startsWith('p'))).toEqual(['p1']);
    expect(r.queue.getStats().parked).toBe(2);
    // Reachable now: a second refill takes nothing more of it.
    expect(r.queue.refillWorkingSet(T0 + 1)).toBe(0);
    expect(depth(r.queue, HOST)).toEqual({ resident: 1, parked: 2 });
  });

  it('a pooled host with no resident row gets its anchor even while FIFO rows fill the working set', () => {
    process.env.SCRAPE_QUEUE_MAX_RESIDENT = '2';
    const r = rig({ select: 'all,-other.test' });
    r.queue.enqueue('o0', { url: url(1, 'other.test'), priority: 'WARM' }); // on the wire
    r.queue.enqueue('o1', { url: url(2, 'other.test'), priority: 'WARM' });
    r.queue.enqueue('o2', { url: url(3, 'other.test'), priority: 'WARM' });
    r.queue.enqueue('p1', { url: url(100), priority: 'WARM' });
    r.queue.enqueue('p2', { url: url(200), priority: 'WARM' });
    expect(depth(r.queue, HOST)).toEqual({ resident: 0, parked: 2 });
    r.queue.refillWorkingSet(Date.now());
    expect(depth(r.queue, HOST)).toEqual({ resident: 1, parked: 1 });
    expect(depth(r.queue, 'other.test')).toEqual({ resident: 2, parked: 0 });
  });

  it('a pooled host whose only resident row is held by its paused session gets its anchor (past the per-host cap)', () => {
    process.env.SCRAPE_QUEUE_MAX_RESIDENT_PER_HOST = '1';
    const r = rig({ select: 'all' });
    const internals = r.queue as unknown as { sessionManager: { isSessionPaused(id: string): boolean } };
    jest.spyOn(internals.sessionManager, 'isSessionPaused').mockImplementation((id: string) => id === 'paused');
    r.queue.enqueue('k0', { url: url(1), priority: 'WARM' }); // on the wire
    r.queue.enqueue('held', { url: url(500), priority: 'COLD', cookies: { a: 'b' }, sessionId: 'paused' });
    r.queue.enqueue('p1', { url: url(100), priority: 'WARM' });
    r.queue.enqueue('p2', { url: url(200), priority: 'WARM' });
    expect(depth(r.queue, HOST)).toEqual({ resident: 1, parked: 2 });
    r.queue.refillWorkingSet(Date.now());
    expect(depth(r.queue, HOST)).toEqual({ resident: 2, parked: 1 });
    expect(tierKeys(r.queue)).toEqual(['p1']);
  });

  it('a resident row ABOVE the parked rows\' tier held by its paused session does not count: the host gets its anchor', () => {
    process.env.SCRAPE_QUEUE_MAX_RESIDENT_PER_HOST = '1';
    const r = rig({ select: 'all' });
    const internals = r.queue as unknown as { sessionManager: { isSessionPaused(id: string): boolean } };
    jest.spyOn(internals.sessionManager, 'isSessionPaused').mockImplementation((id: string) => id === 'paused');
    r.queue.enqueue('k0', { url: url(1), priority: 'WARM' }); // on the wire
    r.queue.enqueue('held', { url: url(500), priority: 'WARM', cookies: { a: 'b' }, sessionId: 'paused' });
    r.queue.enqueue('p1', { url: url(100), priority: 'WARM' });
    r.queue.enqueue('p2', { url: url(200), priority: 'WARM' });
    r.queue.refillWorkingSet(Date.now());
    expect(depth(r.queue, HOST)).toEqual({ resident: 2, parked: 1 });
    // A row with cookies queues HOT: the scan cannot dispatch it, so it reaches the host at no tier.
    expect((r.queue as unknown as Record<string, Array<{ mfcId: string }>>).hotQueue.map((i) => i.mfcId)).toEqual(['held']);
    expect(tierKeys(r.queue)).toEqual(['p1']);
  });

  it.each([
    ['all,-other.test', { resident: 1, parked: 0 }],
    ['off', { resident: 0, parked: 1 }],
  ])("a full working set parks a FIFO host's enqueue only when FIFO rows fill it; a pooled host's always (%s)", (knob, fifo) => {
    process.env.SCRAPE_QUEUE_MAX_RESIDENT = '2';
    const r = rig({ select: knob });
    r.queue.enqueue('p0', { url: url(1), priority: 'WARM' }); // on the wire
    r.queue.enqueue('p1', { url: url(100), priority: 'WARM' });
    r.queue.enqueue('p2', { url: url(200), priority: 'WARM' });
    r.queue.enqueue('o1', { url: url(5, 'other.test'), priority: 'WARM' });
    expect(depth(r.queue, 'other.test')).toEqual(fifo);
    r.queue.enqueue('p3', { url: url(300), priority: 'WARM' });
    expect(depth(r.queue, HOST)).toEqual({ resident: 2, parked: 1 });
  });

  it('a row whose URL has no host is a FIFO row for the cap (the knob never asks about it)', () => {
    process.env.SCRAPE_QUEUE_MAX_RESIDENT = '2';
    const r = rig({ select: 'all' });
    r.queue.enqueue('p0', { url: url(1), priority: 'WARM' }); // on the wire
    r.queue.enqueue('p1', { url: url(100), priority: 'WARM' });
    r.queue.enqueue('p2', { url: url(200), priority: 'WARM' });
    expect(() => r.queue.enqueue('bad', { url: 'not a url', priority: 'WARM' })).not.toThrow();
    expect(r.queue.getStats()).toMatchObject({ warm: 3, parked: 0 });
  });

  it('the refill reads disk only for a pooled host that has rows parked', () => {
    const r = rig({ select: 'all' });
    r.queue.enqueue('p0', { url: url(1), priority: 'WARM' }); // pool.test: on the wire, nothing parked
    r.store.put(parkedRow('o1', 7, 1000, 'WARM', 'other.test'));
    r.queue.setQueueStore(r.store); // re-read the parked counts
    const pageIn = jest.spyOn(r.store, 'pageIn');
    r.queue.refillWorkingSet(Date.now());
    expect(pageIn.mock.calls.map(([, opts]) => opts?.host).filter((h) => h !== undefined)).toEqual(['other.test']);
    expect(depth(r.queue, 'other.test')).toEqual({ resident: 1, parked: 0 });
  });

  /** pool.test sent at T0 and other.test at T0 + 500: at T0 + 1000 only pool.test is ready. */
  async function twoHostsPaced(r: Rig): Promise<void> {
    r.queue.enqueue('a0', { url: url(1), priority: 'WARM' });
    await jest.advanceTimersByTimeAsync(500);
    r.queue.enqueue('x0', { url: url(1, 'other.test'), priority: 'WARM' });
    await jest.advanceTimersByTimeAsync(10);
    expect(keysOf(r.calls, HOST).length + keysOf(r.calls, 'other.test').length).toBe(2);
  }

  it("a pooled RESIDENT pick takes the head's place in the tier, and the head the pick's (FIFO's places)", async () => {
    const r = newestRig();
    await twoHostsPaced(r);
    r.queue.enqueue('a', { url: url(100), priority: 'WARM' });
    r.queue.enqueue('x', { url: url(7, 'other.test'), priority: 'WARM' });
    jest.setSystemTime(Date.now() + 1);
    r.queue.enqueue('b', { url: url(300), priority: 'WARM' });
    jest.setSystemTime(Date.now() + 1);
    r.queue.enqueue('c', { url: url(900), priority: 'WARM' });
    expect(tierKeys(r.queue)).toEqual(['a', 'x', 'b', 'c']);
    await jest.advanceTimersByTimeAsync(600); // T0 + ~1110: pool.test sent once more, other.test still paced
    expect(r.picks.filter((p) => p.host === HOST).map((p) => p.key)).toEqual(['a0', 'c']);
    expect(tierKeys(r.queue)).toEqual(['x', 'b', 'a']);
  });

  it('after a pooled pick of a PARKED WARM row the head moves to the back of its tier', async () => {
    process.env.SCRAPE_QUEUE_MAX_RESIDENT_PER_HOST = '2';
    const r = newestRig();
    await twoHostsPaced(r);
    r.queue.enqueue('a', { url: url(100), priority: 'WARM' });
    r.queue.enqueue('x', { url: url(7, 'other.test'), priority: 'WARM' });
    jest.setSystemTime(Date.now() + 1);
    r.queue.enqueue('b', { url: url(300), priority: 'WARM' });
    jest.setSystemTime(Date.now() + 1);
    r.queue.enqueue('d', { url: url(900), priority: 'WARM' });
    expect(r.store.listParked(HOST, 'WARM').map((p) => p.mfcId)).toEqual(['d']);
    await jest.advanceTimersByTimeAsync(600);
    expect(keysOf(r.calls, HOST)).toEqual([1, 900]);
    expect(tierKeys(r.queue)).toEqual(['x', 'b', 'a']);
    expect(depth(r.queue, HOST)).toEqual({ resident: 2, parked: 0 });
  });

  it('a PARKED HOT row of a pooled host is paged in and goes as HOT (FIFO, no pick): the WARM rows keep their places', async () => {
    process.env.SCRAPE_QUEUE_MAX_RESIDENT_PER_HOST = '2';
    const r = newestRig();
    await twoHostsPaced(r);
    r.queue.enqueue('a', { url: url(100), priority: 'WARM' });
    r.queue.enqueue('x', { url: url(7, 'other.test'), priority: 'WARM' });
    jest.setSystemTime(Date.now() + 1);
    r.queue.enqueue('b', { url: url(300), priority: 'WARM' });
    jest.setSystemTime(Date.now() + 1);
    const pageIn = jest.spyOn(r.store, 'pageIn');
    r.queue.enqueue('d', { url: url(900), priority: 'HOT' });
    // It parked (over the per-host cap), and the enqueue's refill paged it in as the host's HOT anchor.
    expect(pageIn.mock.calls.filter(([, opts]) => opts?.host === HOST).map(([, opts]) => opts?.priorities)).toEqual([['HOT']]);
    expect(r.store.listParked(HOST, 'HOT')).toEqual([]);
    await jest.advanceTimersByTimeAsync(600);
    expect(keysOf(r.calls, HOST)).toEqual([1, 900]);
    expect(r.picks.map((p) => p.key)).not.toContain('d');
    expect(tierKeys(r.queue)).toEqual(['a', 'x', 'b']);
    expect(depth(r.queue, HOST)).toEqual({ resident: 2, parked: 0 });
  });

  // HOT always first, tiers in order (closeout i2 BLOCKER): a pooled host's parked rows of a tier ABOVE
  // every dispatchable resident row it has are reached only through an anchor of that tier. Without one,
  // a HOT row waited for the host's COLD head, behind every other host's WARM rows.
  /** pool.test: one row on the wire, one resident `resident` row, then `parked` rows over both caps (1 / 1). */
  function residentThenParked(resident: QueuePriority, parked: Array<[string, QueuePriority]>): Rig {
    process.env.SCRAPE_QUEUE_MAX_RESIDENT = '1';
    process.env.SCRAPE_QUEUE_MAX_RESIDENT_PER_HOST = '1';
    const r = rig({ select: 'all' });
    r.queue.enqueue('wire', { url: url(1), priority: 'WARM' }); // on the wire
    r.queue.enqueue('res', { url: url(50), priority: resident });
    parked.forEach(([key, priority], k) => r.queue.enqueue(key, { url: url(100 + k), priority }));
    return r;
  }

  it.each([
    ['COLD', 'HOT', 'hotQueue'],
    ['WARM', 'HOT', 'hotQueue'],
    ['COLD', 'WARM', 'warmQueue'],
  ] as const)('resident %s, parked %s: the refill anchors the parked row in its own tier, whatever the caps', (resident, parked, tier) => {
    const r = residentThenParked(resident, [['lowc', 'COLD'], ['up1', parked], ['up22', parked]]);
    r.queue.refillWorkingSet(Date.now());
    expect(depth(r.queue, HOST)).toEqual({ resident: 2, parked: 2 });
    expect((r.queue as unknown as Record<string, Array<{ mfcId: string }>>)[tier].map((i) => i.mfcId)).toContain('up1');
    // Reachable in that tier now: a second refill takes nothing more.
    r.queue.refillWorkingSet(Date.now() + 1);
    expect(depth(r.queue, HOST)).toEqual({ resident: 2, parked: 2 });
  });

  it.each([
    ['HOT', 'WARM'],
    ['HOT', 'HOT'],
    ['WARM', 'WARM'],
    ['WARM', 'COLD'],
  ] as const)('resident %s, parked %s: no anchor (the scan reaches the host at that tier or above)', (resident, parked) => {
    const r = residentThenParked(resident, [['p1', parked]]);
    r.queue.refillWorkingSet(Date.now());
    expect(depth(r.queue, HOST)).toEqual({ resident: 1, parked: 1 });
  });

  it('a pooled host reachable at HOT costs the refill no disk read for an anchor', () => {
    const r = residentThenParked('HOT', [['p1', 'COLD']]);
    const pageIn = jest.spyOn(r.store, 'pageIn');
    r.queue.refillWorkingSet(Date.now());
    expect(pageIn.mock.calls.filter(([, opts]) => opts?.host !== undefined)).toEqual([]);
    expect(depth(r.queue, HOST)).toEqual({ resident: 1, parked: 1 });
  });

  // The working-set bound (closeout i2 SHOULD): the FIFO hosts' cap counts their RESIDENT rows only,
  // never a pooled host's parked ones.
  it("a FIFO host fills its places up to the cap, and no further, while a pooled host has rows parked", () => {
    process.env.SCRAPE_QUEUE_MAX_RESIDENT = '4';
    const r = rig({ select: 'all,-other.test' });
    for (let i = 0; i < 12; i++) r.queue.enqueue(`p${i}`, { url: url(100 + i), priority: 'WARM' });
    for (let i = 0; i < 12; i++) r.queue.enqueue(`o${i}`, { url: url(100 + i, 'other.test'), priority: 'WARM' });
    r.queue.refillWorkingSet(Date.now());
    expect(depth(r.queue, HOST).parked).toBeGreaterThan(0);
    expect(depth(r.queue, 'other.test')).toEqual({ resident: 4, parked: 8 });
  });
});

describe('pooled claims and candidates: lines a mutant could change unseen', () => {
  it('a parked row claimed by a pick is in flight: a second enqueue of it dedups (one fetch)', async () => {
    process.env.SCRAPE_QUEUE_MAX_RESIDENT_PER_HOST = '1';
    const dir = seededDir([{ ...parkedRow('r1', 100, 2000), state: 'pending' as const }, parkedRow('p1', 900, 500)]);
    const r = newestRig({ dir });
    let release: () => void = () => {};
    const page = jest.fn().mockImplementation(
      (u: string) =>
        new Promise((resolve) => {
          r.calls.push({ t: Date.now(), url: u, status: 200 });
          release = () => resolve({ html: '<html>ok</html>', url: u, title: 'Item', statusCode: 200 });
        }),
    );
    r.queue.setScrapingService({ scrapePage: page, scrapePageStealth: page } as never);
    r.queue.restoreFromStore(T0);
    await jest.advanceTimersByTimeAsync(10);
    expect(r.picks[0]?.key).toBe('p1');
    expect(r.queue.enqueue('p1', { url: url(900), priority: 'WARM' }).deduplicated).toBe(true);
    for (let i = 0; i < 6; i++) {
      release();
      await jest.advanceTimersByTimeAsync(1000);
    }
    expect(r.calls.filter((c) => c.url === url(900))).toHaveLength(1);
  });

  it("after a pooled claim with the GLOBAL cap binding, getStats().parked is the store's while the row is on the wire", async () => {
    process.env.SCRAPE_QUEUE_MAX_RESIDENT = '1';
    const dir = seededDir([{ ...parkedRow('r1', 100, 3000), state: 'pending' as const }, parkedRow('p1', 500, 2000), parkedRow('p2', 900, 500)]);
    const r = newestRig({ dir });
    // The fetch never answers: no later scan re-reads the count.
    const page = jest.fn().mockImplementation(() => new Promise(() => {}));
    r.queue.setScrapingService({ scrapePage: page, scrapePageStealth: page } as never);
    r.queue.restoreFromStore(T0);
    await jest.advanceTimersByTimeAsync(10);
    expect(page).toHaveBeenCalledTimes(1);
    expect(r.picks[0]?.key).toBe('p2');
    expect(r.store.counts().parked).toBe(1);
    expect(r.queue.getStats().parked).toBe(1);
    expect(depth(r.queue, HOST).parked).toBe(1);
  });

  it("a pooled claim takes the row's waiting callers with it (no parked resolvers left behind)", async () => {
    process.env.SCRAPE_QUEUE_MAX_RESIDENT_PER_HOST = '1';
    const r = newestRig();
    r.queue.enqueue('a', { url: url(100), priority: 'WARM' });
    await jest.advanceTimersByTimeAsync(10);
    r.queue.enqueue('b', { url: url(400), priority: 'WARM' });
    jest.setSystemTime(Date.now() + 1);
    const waiting = r.queue.enqueue('c', { url: url(900), priority: 'WARM' });
    expect(r.store.listParked(HOST, 'WARM').map((p) => p.mfcId)).toEqual(['c']);
    await advance(3_000);
    expect(keysOf(r.calls)).toEqual([100, 900, 400]);
    await expect(waiting.promise).resolves.toBeDefined();
    expect((r.queue as unknown as { parkedResolvers: Map<string, unknown> }).parkedResolvers.size).toBe(0);
  });

  it('a row whose session is COOLING is not a candidate', async () => {
    const r = newestRig();
    const internals = r.queue as unknown as { sessionManager: { isInCooldown(id: string): { inCooldown: boolean } } };
    jest.spyOn(internals.sessionManager, 'isInCooldown').mockImplementation((id: string) => ({ inCooldown: id === 'cool' }) as never);
    r.queue.enqueue('k0', { url: url(1), priority: 'COLD' });
    r.queue.enqueue('held', { url: url(500), priority: 'COLD', cookies: { a: 'b' }, sessionId: 'cool' });
    r.queue.enqueue('k2', { url: url(300), priority: 'COLD' });
    await advance(12_000);
    expect(r.picks.map((p) => p.key)).toEqual(['k0', 'k2']);
    expect(keysOf(r.calls)).toEqual([1, 300]);
  });

  it('two HOT rows PARKED: the older goes first (HOT stays FIFO)', async () => {
    process.env.SCRAPE_QUEUE_MAX_RESIDENT_PER_HOST = '1';
    const dir = seededDir([
      { ...parkedRow('w1', 100, 9000), state: 'pending' as const },
      parkedRow('w2', 300, 8000),
      parkedRow('h1', 700, 5000, 'HOT'),
      parkedRow('h2', 800, 1000, 'HOT'),
    ]);
    const r = newestRig({ dir });
    r.queue.restoreFromStore(T0);
    await advance(4_000);
    expect(keysOf(r.calls).slice(0, 2)).toEqual([700, 800]);
  });

  it('the anti-sequence id is an all-digit LAST path segment only ("x101" has none)', async () => {
    const r = newestRig();
    r.queue.enqueue('k100', { url: url(100), priority: 'WARM' }); // sent at once: the class's last id is 100
    r.queue.enqueue('far', { url: `https://${HOST}/item/900`, priority: 'WARM' });
    jest.setSystemTime(Date.now() + 1);
    r.queue.enqueue('near', { url: `https://${HOST}/item/x101`, priority: 'WARM' });
    await advance(1_500);
    // 'near' is the newest and has no id, so nothing holds it back; read as 101 it would sit within 3 of 100.
    expect(r.picks.map((p) => p.key)).toEqual(['k100', 'near']);
  });

  it("a row whose URL has no host does not stop the queue under 'all,-host'", async () => {
    const r = newestRig({ select: 'all,-other.test' });
    r.queue.enqueue('bad', { url: 'not a url', priority: 'WARM' });
    r.queue.enqueue('good', { url: url(5), priority: 'WARM' });
    await advance(3_000);
    expect(keysOf(r.calls)).toEqual([5]);
  });
});
