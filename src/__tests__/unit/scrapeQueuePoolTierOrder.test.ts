/**
 * QB-U19 closeout i2: HOT always first and tiers in order for a POOLED host beside other hosts' rows, and
 * the working-set bound with pooled rows parked.
 *
 * A pooled host is not paged in by the shared page-in (it reads its parked rows at each pick), so its
 * parked rows of a tier above every dispatchable resident row it holds were reached only through that
 * lower head: a HOT row parked under the global cap waited for the host's COLD head, behind every other
 * host's WARM rows, and parked WARM rows behind other hosts' COLD rows. Each case runs the same
 * arrivals under 'off' and under pooling, through a real ScrapeQueue on a real SQLite store, fake timers
 * and a fake transport whose fetch takes 1.5 s (the dispatch slot saturated), and asserts the pooled
 * host's HOT / WARM rows go no later than under 'off'.
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
import { resetScrapeQueue, type ScrapeQueue } from '../../services/scrapeQueue';
import { PoolDispatch, POOL_SELECT_ENV, setPoolDispatch } from '../../services/poolDispatch';
import { openPoolStore, poolTmpDir, wirePoolQueue, type SiteSpec, type TransportCall } from '../helpers/poolQueueHarness';

const T0 = 1_000_000;
const MFC = 'myfigurecollection.net';

let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
  delete process.env[POOL_SELECT_ENV];
  delete process.env.SCRAPE_QUEUE_MAX_RESIDENT;
  delete process.env.SCRAPE_QUEUE_MAX_RESIDENT_PER_HOST;
  setPoolDispatch(null);
  resetScrapeQueue();
  jest.useRealTimers();
});

jest.setTimeout(180_000);

interface Rig {
  queue: ScrapeQueue;
  calls: TransportCall[];
  done: () => void;
}

function wire(knob: string, global: number, perHost: number, sites: SiteSpec[], fetchMs: number): Rig {
  process.env[POOL_SELECT_ENV] = knob;
  process.env.SCRAPE_QUEUE_MAX_RESIDENT = String(global);
  process.env.SCRAPE_QUEUE_MAX_RESIDENT_PER_HOST = String(perHost);
  setPoolDispatch(new PoolDispatch({ seed: 7 }));
  jest.useFakeTimers();
  jest.setSystemTime(T0);
  const dir = poolTmpDir('pool-tier-order-');
  dirs.push(dir);
  const store = openPoolStore(dir);
  const calls: TransportCall[] = [];
  const queue = wirePoolQueue({ store, sites, calls });
  if (fetchMs > 0) {
    const page = jest.fn().mockImplementation(
      (u: string) =>
        new Promise((resolve) => {
          calls.push({ t: Date.now(), url: u, status: 200 });
          setTimeout(() => resolve({ html: '<html>ok</html>', url: u, title: 'Item', statusCode: 200 }), fetchMs);
        }),
    );
    queue.setScrapingService({ scrapePage: page, scrapePageStealth: page } as never);
  }
  const log = console.log as unknown as jest.Mock;
  log.mockImplementation(() => {});
  return {
    queue,
    calls,
    done: () => {
      queue.stop();
      queue.clear();
      store.close();
      log.mockReset();
      jest.useRealTimers();
    },
  };
}

/** Resident rows over the three tiers (the working set). */
const residentAll = (q: ScrapeQueue): number =>
  ['hotQueue', 'warmQueue', 'coldQueue'].reduce((n, k) => n + (q as unknown as Record<string, unknown[]>)[k].length, 0);
const residentOf = (q: ScrapeQueue, host: string): number => Object.values(q.getLaneCounts(host)).reduce((n, c) => n + c.resident, 0);

/**
 * p.test (pooled) holds 3 resident COLD rows; four pooled q hosts hold 60 WARM rows each and MFC 30; the
 * global cap (10) is full, so a HOT row of p.test enqueued at 10 s parks. Returns its delay after the
 * enqueue (null: never sent in a minute) and how many other transport calls started in between.
 */
async function hotDelay(knob: string, fetchMs: number): Promise<{ delay: number | null; before: number }> {
  const sites: SiteSpec[] = [
    { siteId: 'p', domain: 'p.test', baseDelayMs: 2000 },
    { siteId: 'mfc', domain: MFC, baseDelayMs: 7000 },
  ];
  for (let h = 1; h <= 4; h++) sites.push({ siteId: `q${h}`, domain: `q${h}.test`, baseDelayMs: 2000 });
  const r = wire(knob, 10, 1000, sites, fetchMs);
  try {
    for (let i = 0; i < 3; i++) r.queue.enqueue(`p-c${i}`, { url: `https://p.test/p/${100 + i}`, priority: 'COLD' });
    for (let i = 0; i < 30; i++) r.queue.enqueue(`${10000 + i}`, { url: `https://${MFC}/item/${10000 + i}`, priority: 'WARM' });
    for (let i = 0; i < 60; i++) for (let h = 1; h <= 4; h++) r.queue.enqueue(`q${h}-${i}`, { url: `https://q${h}.test/p/${1000 + i}`, priority: 'WARM' });
    for (let ms = 500; ms <= 10_000; ms += 500) await jest.advanceTimersByTimeAsync(500);
    r.queue.enqueue('p-hot', { url: 'https://p.test/p/9999', priority: 'HOT' });
    for (let ms = 500; ms <= 60_000; ms += 500) await jest.advanceTimersByTimeAsync(500);
    const at = r.calls.findIndex((c) => c.url.endsWith('/9999'));
    if (at < 0) return { delay: null, before: r.calls.filter((c) => c.t >= T0 + 10_000).length };
    return { delay: r.calls[at].t - T0 - 10_000, before: r.calls.slice(0, at).filter((c) => c.t >= T0 + 10_000).length };
  } finally {
    r.done();
  }
}

/**
 * p.test (pooled) holds one resident COLD row behind 48 older COLD rows of four other hosts (global cap 50
 * full), and 20 WARM rows arrive and park. Returns the instants (s) of p.test's WARM dispatches in 2 min.
 */
async function warmDispatches(knob: string): Promise<number[]> {
  const sites: SiteSpec[] = [{ siteId: 'p', domain: 'p.test', baseDelayMs: 2000 }];
  for (let h = 1; h <= 4; h++) sites.push({ siteId: `q${h}`, domain: `q${h}.test`, baseDelayMs: 2000 });
  const r = wire(knob, 50, 1000, sites, 1500);
  try {
    for (let i = 0; i < 12; i++) for (let h = 1; h <= 4; h++) r.queue.enqueue(`q${h}-${i}`, { url: `https://q${h}.test/p/${1000 + i}`, priority: 'COLD' });
    r.queue.enqueue('p-c0', { url: 'https://p.test/p/100', priority: 'COLD' });
    for (let i = 12; i < 60; i++) for (let h = 1; h <= 4; h++) r.queue.enqueue(`q${h}-${i}`, { url: `https://q${h}.test/p/${1000 + i}`, priority: 'COLD' });
    for (let i = 0; i < 20; i++) r.queue.enqueue(`p-w${i}`, { url: `https://p.test/p/${500 + i}`, priority: 'WARM' });
    for (let ms = 500; ms <= 2 * 60_000; ms += 500) await jest.advanceTimersByTimeAsync(500);
    return r.calls.filter((c) => /p\.test\/p\/5\d\d$/.test(c.url)).map((c) => (c.t - T0) / 1000);
  } finally {
    r.done();
  }
}

describe('HOT always first for a pooled host (a HOT row parked under the global cap, its host holding a resident COLD row)', () => {
  // Which instant the dispatch slot frees at depends on the run's history (which items went before), so
  // the property pinned is HOT's: under pooling the HOT row is the NEXT transport call after its enqueue,
  // within one fetch. (Measured, not asserted: off sends it after 2 ms at 1.5 s and after 5.4 s, one call
  // later, at 0.7 s; before this fix pooling never sent it within the minute.)
  it.each([1500, 700])('fetch %i ms: the HOT row is the next dispatch after its enqueue, within one fetch', async (fetchMs) => {
    for (const knob of [`all,-${MFC}`, 'all', 'p.test']) {
      const { delay, before } = await hotDelay(knob, fetchMs);
      expect({ knob, delay, before }).toEqual({ knob, delay: expect.any(Number), before: 0 });
      expect(delay as number).toBeLessThanOrEqual(fetchMs);
    }
  });
});

describe("tiers in order for a pooled host (its WARM rows parked behind its COLD head and other hosts' COLD rows)", () => {
  it('its WARM rows go no later, and no fewer, than under off', async () => {
    const off = await warmDispatches('off');
    expect(off.length).toBe(20);
    for (const knob of ['p.test', 'all', 'all,-q1.test,-q2.test,-q3.test,-q4.test']) {
      const pooled = await warmDispatches(knob);
      expect({ knob, n: pooled.length }).toEqual({ knob, n: off.length });
      expect({ knob, first: pooled[0] }).toEqual({ knob, first: expect.any(Number) });
      expect(pooled[0]).toBeLessThanOrEqual(off[0]);
    }
  });
});

describe('the working-set bound with pooled rows parked (README: FIFO rows <= the cap; the set <= 2 x the cap + anchors)', () => {
  it("under churn: MFC (FIFO) never holds more than the cap, pooled hosts never more than the cap plus one anchor per host and tier", async () => {
    const cap = 20;
    const pooledHosts = 8;
    const sites: SiteSpec[] = [{ siteId: 'mfc', domain: MFC, baseDelayMs: 7000 }];
    for (let h = 1; h <= pooledHosts; h++) sites.push({ siteId: `h${h}`, domain: `h${h}.test`, baseDelayMs: 2000 });
    const r = wire(`all,-${MFC}`, cap, 100_000, sites, 0);
    const hosts = Array.from({ length: pooledHosts }, (_, k) => `h${k + 1}.test`);
    let maxFifo = 0;
    let maxPooled = 0;
    let maxTotal = 0;
    let parkedSeen = 0;
    const sample = () => {
      const fifo = residentOf(r.queue, MFC);
      const pooled = hosts.reduce((n, h) => n + residentOf(r.queue, h), 0);
      maxFifo = Math.max(maxFifo, fifo);
      maxPooled = Math.max(maxPooled, pooled);
      maxTotal = Math.max(maxTotal, residentAll(r.queue));
      parkedSeen = Math.max(parkedSeen, r.queue.getStats().parked);
    };
    try {
      for (let i = 0; i < 80; i++) {
        r.queue.enqueue(`m${i}`, { url: `https://${MFC}/item/${1000 + i}`, priority: i % 3 === 0 ? 'COLD' : 'WARM' });
        for (let h = 1; h <= pooledHosts; h++) r.queue.enqueue(`h${h}-${i}`, { url: `https://h${h}.test/p/${5000 + i}`, priority: i % 2 === 0 ? 'COLD' : 'WARM' });
        sample();
      }
      for (let ms = 500, k = 0; ms <= 5 * 60_000; ms += 500) {
        await jest.advanceTimersByTimeAsync(500);
        if (ms % 3000 === 0) {
          k++;
          for (let h = 1; h <= pooledHosts; h++) r.queue.enqueue(`h${h}-n${k}`, { url: `https://h${h}.test/p/${90_000 + k}`, priority: k % 2 ? 'WARM' : 'COLD' });
          r.queue.enqueue(`m-n${k}`, { url: `https://${MFC}/item/${50_000 + k}`, priority: 'WARM' });
        }
        sample();
      }
    } finally {
      r.done();
    }
    expect(parkedSeen).toBeGreaterThan(500);
    expect(maxFifo).toBe(cap);
    expect(maxPooled).toBeLessThanOrEqual(cap + 3 * pooledHosts);
    expect(maxTotal).toBeLessThanOrEqual(2 * cap + 3 * pooledHosts);
  });
});
