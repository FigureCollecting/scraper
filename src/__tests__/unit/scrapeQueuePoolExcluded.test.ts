/**
 * QB-U19: a host EXCLUDED from pool dispatch ('all,-myfigurecollection.net', the QB-U32 mode) is not
 * slowed by the pooled hosts beside it.
 *
 * Two couplings are pinned, each through a real ScrapeQueue on a real SQLite store, fake timers and a
 * fake transport (no network):
 *  - the WORKING SET: with the global resident cap binding, a pooled host's pick of one of its parked
 *    rows frees no resident place, so under one shared page-in budget the FIFO host's places went to
 *    the pooled hosts and its throughput collapsed. The FIFO hosts' cap counts FIFO rows; a pooled host
 *    reads its parked rows itself and takes no part in the shared page-in (one anchor row keeps it
 *    reachable).
 *  - the DISPATCH SCAN: the queue sends one item at a time, and among hosts that are all ready the scan
 *    takes the first row in tier order. A pooled host sends its newer rows and kept its oldest at the
 *    front, so with the dispatch slot saturated (a fetch takes 1.5 s) it won every scan and the FIFO host
 *    starved, whatever the caps. A pooled dispatch now vacates the head's place, as FIFO would.
 *
 * Each scenario runs once under 'off' and once under 'all,-myfigurecollection.net' and compares the MFC
 * dispatch log: identical where the working set does not tie MFC to the other hosts' rows, and never
 * later (no fewer dispatches, the same items) where 'off' itself ties MFC to them.
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
import { resetScrapeQueue } from '../../services/scrapeQueue';
import { PoolDispatch, POOL_SELECT_ENV, setPoolDispatch } from '../../services/poolDispatch';
import { openPoolStore, poolTmpDir, wirePoolQueue, type SiteSpec, type TransportCall } from '../helpers/poolQueueHarness';

const T0 = 1_000_000;
const MFC = 'myfigurecollection.net';
const EXCLUDED = `all,-${MFC}`;

interface Scenario {
  /** SCRAPE_QUEUE_MAX_RESIDENT / _PER_HOST. */
  global: number;
  perHost: number;
  /** Pooled hosts h1.test..hN.test, 2 s floor each; MFC keeps its 7 s floor. */
  pooledHosts: number;
  /** Backlog at boot: this many rows per pooled host, and this many MFC rows, interleaved. */
  rowsPerHost: number;
  mfcRows: number;
  /** One more MFC row every this many ms (0: none). */
  mfcEveryMs: number;
  /** One more row per pooled host every this many ms. */
  arrivalEveryMs: number;
  /** How long one fetch takes (0: the transport answers at once). */
  fetchMs: number;
  minutes: number;
}

interface Run {
  /** [ms after boot, MFC item id] for every MFC transport call. */
  mfc: Array<[number, string]>;
  pooledCalls: number;
}

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

jest.setTimeout(120_000);

async function run(knob: string, sc: Scenario): Promise<Run> {
  process.env[POOL_SELECT_ENV] = knob;
  process.env.SCRAPE_QUEUE_MAX_RESIDENT = String(sc.global);
  process.env.SCRAPE_QUEUE_MAX_RESIDENT_PER_HOST = String(sc.perHost);
  setPoolDispatch(new PoolDispatch({ seed: 7 }));
  jest.useFakeTimers();
  jest.setSystemTime(T0);
  const sites: SiteSpec[] = [{ siteId: 'mfc', domain: MFC, baseDelayMs: 7000 }];
  for (let h = 1; h <= sc.pooledHosts; h++) sites.push({ siteId: `h${h}`, domain: `h${h}.test`, baseDelayMs: 2000 });
  const dir = poolTmpDir('pool-excluded-');
  dirs.push(dir);
  const store = openPoolStore(dir);
  const calls: TransportCall[] = [];
  const queue = wirePoolQueue({ store, sites, calls });
  if (sc.fetchMs > 0) {
    const page = jest.fn().mockImplementation(
      (u: string) =>
        new Promise((resolve) => {
          calls.push({ t: Date.now(), url: u, status: 200 });
          setTimeout(() => resolve({ html: '<html>ok</html>', url: u, title: 'Item', statusCode: 200 }), sc.fetchMs);
        }),
    );
    queue.setScrapingService({ scrapePage: page, scrapePageStealth: page } as never);
  }
  const log = console.log as unknown as jest.Mock;
  log.mockImplementation(() => {});
  const mfcUrl = (n: number) => `https://${MFC}/item/${1000 + n}`;
  try {
    let mfcSeq = 0;
    for (let i = 0; i < Math.max(sc.rowsPerHost, sc.mfcRows); i++) {
      if (i < sc.mfcRows) queue.enqueue(`m${mfcSeq}`, { url: mfcUrl(mfcSeq++), priority: 'WARM' });
      for (let h = 1; h <= sc.pooledHosts && i < sc.rowsPerHost; h++) queue.enqueue(`h${h}-${i}`, { url: `https://h${h}.test/p/${5000 + i * 7}`, priority: 'WARM' });
    }
    let arrivals = 0;
    for (let ms = 500; ms <= sc.minutes * 60_000; ms += 500) {
      await jest.advanceTimersByTimeAsync(500);
      if (sc.mfcEveryMs > 0 && ms % sc.mfcEveryMs === 0) queue.enqueue(`m${mfcSeq}`, { url: mfcUrl(mfcSeq++), priority: 'WARM' });
      if (ms % sc.arrivalEveryMs === 0) {
        arrivals++;
        for (let h = 1; h <= sc.pooledHosts; h++) queue.enqueue(`h${h}-n${arrivals}`, { url: `https://h${h}.test/p/${90_000 + arrivals * 13}`, priority: 'WARM' });
      }
    }
    return {
      mfc: calls.filter((c) => c.url.includes(MFC)).map((c): [number, string] => [c.t - T0, c.url.split('/').pop() as string]),
      pooledCalls: calls.filter((c) => !c.url.includes(MFC)).length,
    };
  } finally {
    queue.stop();
    queue.clear();
    store.close();
    log.mockReset();
    jest.useRealTimers();
  }
}

describe("the excluded host keeps its FIFO dispatch beside pooled hosts ('all,-myfigurecollection.net')", () => {
  it('the GLOBAL cap binds (12 / 4), MFC and five pooled hosts backlogged: MFC dispatches exactly as under off', async () => {
    const sc: Scenario = { global: 12, perHost: 4, pooledHosts: 5, rowsPerHost: 150, mfcRows: 150, mfcEveryMs: 0, arrivalEveryMs: 2000, fetchMs: 0, minutes: 5 };
    const off = await run('off', sc);
    const ex = await run(EXCLUDED, sc);
    expect(off.mfc.length).toBeGreaterThan(40);
    expect(ex.pooledCalls).toBeGreaterThan(500);
    expect(ex.mfc).toEqual(off.mfc);
  });

  it('the working set is full of pooled rows (100 / 25) and MFC trickles in, one row per 10 s: MFC dispatches exactly as under off', async () => {
    const sc: Scenario = { global: 100, perHost: 25, pooledHosts: 10, rowsPerHost: 20, mfcRows: 0, mfcEveryMs: 10_000, arrivalEveryMs: 2000, fetchMs: 0, minutes: 5 };
    const off = await run('off', sc);
    const ex = await run(EXCLUDED, sc);
    expect(off.mfc.length).toBeGreaterThan(25);
    expect(ex.pooledCalls).toBeGreaterThan(1000);
    expect(ex.mfc).toEqual(off.mfc);
  });

  it('the dispatch slot is saturated (a fetch takes 1.5 s) and NO cap binds: MFC dispatches exactly as under off', async () => {
    const sc: Scenario = { global: 100_000, perHost: 100_000, pooledHosts: 6, rowsPerHost: 60, mfcRows: 60, mfcEveryMs: 0, arrivalEveryMs: 10_000, fetchMs: 1500, minutes: 5 };
    const off = await run('off', sc);
    const ex = await run(EXCLUDED, sc);
    expect(off.mfc.length).toBeGreaterThan(25);
    expect(ex.pooledCalls).toBeGreaterThan(150);
    expect(ex.mfc).toEqual(off.mfc);
  });

  it('the slot is saturated AND the global cap binds (40 / 10): every MFC dispatch comes no later than under off, the same items in the same order', async () => {
    const sc: Scenario = { global: 40, perHost: 10, pooledHosts: 6, rowsPerHost: 40, mfcRows: 40, mfcEveryMs: 0, arrivalEveryMs: 10_000, fetchMs: 1500, minutes: 10 };
    const off = await run('off', sc);
    const ex = await run(EXCLUDED, sc);
    // Under off the other hosts' rows hold MFC's places in the shared working set; excluded, they do not.
    expect(off.mfc.length).toBe(40);
    expect(ex.mfc.map(([, id]) => id)).toEqual(off.mfc.map(([, id]) => id));
    const late = off.mfc.filter(([t], k) => ex.mfc[k][0] > t);
    expect(late).toEqual([]);
    expect(ex.pooledCalls).toBeGreaterThan(300);
  });
});
