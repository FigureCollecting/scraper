/**
 * QB-U19: SCRAPE_POOL_SELECT off (unset, 'off', blank, or MALFORMED) keeps queue dispatch byte-identical
 * to develop, and 'all,-host' keeps the excluded host on that same FIFO order while every other host,
 * including one first enqueued after boot, is pooled.
 *
 * The scenario runs a real ScrapeQueue on a real SQLite store with small working-set caps (so rows
 * park and page back in), four stores with different floors, HOT/WARM/COLD items, retryable failures
 * through the real retry path, a dedup enqueue at the same priority, a priority raise through a dedup
 * enqueue of a PARKED row, www./case/trailing-dot spellings of the MFC host and a host first enqueued
 * 60 s after boot. The log holds every dispatch line and every transport call, stamped with the fake
 * clock. The fixture was written by this file on develop 049ac7ce (before QB-U19), with
 * POOL_GOLDEN_OUT=<file>. Fake timers, fake transport: no network.
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
import { resetScrapeQueue, type QueuePriority } from '../../services/scrapeQueue';
import { PoolDispatch, POOL_SELECT_ENV, setPoolDispatch } from '../../services/poolDispatch';
import { openPoolStore, poolTmpDir, wirePoolQueue, type SiteSpec, type TransportCall } from '../helpers/poolQueueHarness';

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'poolDispatch', 'fifoGolden.txt');
/** The same scenario with only the per-host working-set cap binding (global cap 1000), also written on develop 049ac7ce. */
const FIXTURE_PER_HOST = path.join(__dirname, '..', 'fixtures', 'poolDispatch', 'fifoGoldenPerHostCap.txt');
const T0 = 1_000_000;
const MFC = 'myfigurecollection.net';

const SITES: SiteSpec[] = [
  { siteId: 'mfc', domain: MFC, baseDelayMs: 7000 },
  { siteId: 'fast', domain: 'fast.test', baseDelayMs: 1000 },
  { siteId: 'slow', domain: 'www.slow.test', baseDelayMs: 20000 },
  { siteId: 'late', domain: 'late.test', baseDelayMs: 2000 },
];

type Enq = [key: string, url: string, priority: QueuePriority];

const mfc = (id: number, host = MFC) => `https://${host}/item/${id}`;
const AT_BOOT: Enq[] = [
  ...Array.from({ length: 12 }, (_, i): Enq => [`m${101 + i}`, mfc(101 + i), 'WARM']),
  ...Array.from({ length: 4 }, (_, i): Enq => [`m${201 + i}`, mfc(201 + i), 'COLD']),
  ['m301', mfc(301), 'HOT'],
  ['m120', mfc(120, 'www.myfigurecollection.net'), 'WARM'],
  ['m121', mfc(121, 'MyFigureCollection.net'), 'COLD'],
  ['m122', mfc(122, 'myfigurecollection.net.'), 'WARM'],
  ...Array.from({ length: 8 }, (_, i): Enq => [`f${1 + i}`, `https://fast.test/p/${1 + i}`, 'WARM']),
  ['f9', 'https://fast.test/p/9', 'COLD'],
  ['f10', 'https://fast.test/p/10', 'COLD'],
  ...Array.from({ length: 3 }, (_, i): Enq => [`s${1 + i}`, `https://www.slow.test/p/${1 + i}`, 'WARM']),
];
/** [seconds after boot, enqueue] — dedups, a raise of a parked COLD row, a late HOT, a host first seen at 60 s. */
const LATER: Array<[number, Enq]> = [
  [10, ['m105', mfc(105), 'WARM']],
  [30, ['m203', mfc(203), 'WARM']],
  [45, ['m303', mfc(303), 'HOT']],
  ...Array.from({ length: 6 }, (_, i): [number, Enq] => [60, [`l${1 + i}`, `https://late.test/x/${1 + i}`, 'WARM']]),
  [90, ['f11', 'https://fast.test/p/11', 'WARM']],
  [90, ['f12', 'https://fast.test/p/12', 'WARM']],
];
const FAILURES: Array<[string, number]> = [
  [mfc(107), 1],
  [mfc(110), 2],
  ['https://fast.test/p/4', 2],
  ['https://late.test/x/3', 1],
];

let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
  delete process.env[POOL_SELECT_ENV];
  delete process.env.SCRAPE_QUEUE_MAX_RESIDENT;
  delete process.env.SCRAPE_QUEUE_MAX_RESIDENT_PER_HOST;
  setPoolDispatch(null);
  resetScrapeQueue();
});

jest.setTimeout(120_000);

interface Run {
  lines: string[];
  /** The pool block 30 s in (items of every host still queued) and at the end. */
  poolMid: ReturnType<ReturnType<typeof wirePoolQueue>['getPoolView']>;
  pool: ReturnType<ReturnType<typeof wirePoolQueue>['getPoolView']>;
}

/** The scenario under one SCRAPE_POOL_SELECT value (undefined = unset). */
async function runScenario(knob: string | undefined, seed = 7, maxResident = '14'): Promise<Run> {
  if (knob === undefined) delete process.env[POOL_SELECT_ENV];
  else process.env[POOL_SELECT_ENV] = knob;
  process.env.SCRAPE_QUEUE_MAX_RESIDENT = maxResident;
  process.env.SCRAPE_QUEUE_MAX_RESIDENT_PER_HOST = '4';
  setPoolDispatch(new PoolDispatch({ seed }));
  jest.useFakeTimers();
  jest.setSystemTime(T0);
  const lines: string[] = [];
  const log = console.log as unknown as jest.Mock;
  log.mockImplementation((...args: unknown[]) => {
    // '[SCRAPE QUEUE] Processing <key> (<priority>, attempt n/m, delay=<ms>ms, pool=...)': key, priority, attempt.
    const m = /^\[SCRAPE QUEUE\] Processing (\S+) \((\w+), attempt (\d+\/\d+),/.exec(String(args[0]));
    if (m) lines.push(`dispatch ${Date.now() - T0} ${m[1]} (${m[2]} ${m[3]})`);
  });
  const dir = poolTmpDir('pool-golden-');
  dirs.push(dir);
  const store = openPoolStore(dir);
  const calls: TransportCall[] = [];
  const queue = wirePoolQueue({ store, sites: SITES, calls, failuresLeft: new Map(FAILURES) });
  try {
    for (const [key, url, priority] of AT_BOOT) queue.enqueue(key, { url, priority });
    let next = 0;
    let poolMid = queue.getPoolView(Date.now());
    for (let step = 1; step <= 800; step++) {
      await jest.advanceTimersByTimeAsync(500);
      if (step === 2) poolMid = queue.getPoolView(Date.now());
      const sec = (Date.now() - T0) / 1000;
      while (next < LATER.length && LATER[next][0] <= sec) {
        const [, [key, url, priority]] = LATER[next++];
        queue.enqueue(key, { url, priority });
      }
    }
    const view = queue.getPoolView(Date.now());
    const counts = store.counts();
    const stats = queue.getStats();
    // Transport calls merged in after the dispatch line of the same instant, in call order.
    const merged: string[] = [];
    let c = 0;
    for (const line of lines) {
      merged.push(line);
      const t = Number(line.split(' ')[1]);
      while (c < calls.length && calls[c].t - T0 <= t) {
        merged.push(`page ${calls[c].t - T0} ${calls[c].status} ${calls[c].url}`);
        c++;
      }
    }
    while (c < calls.length) merged.push(`page ${calls[c].t - T0} ${calls[c].status} ${calls[c].url}`), c++;
    merged.push(`final completed=${stats.completed} failed=${stats.failed} total=${stats.total} parked=${stats.parked} store=${JSON.stringify(counts)}`);
    return { lines: merged, poolMid, pool: view };
  } finally {
    queue.stop();
    queue.clear();
    store.close();
    log.mockReset();
    jest.useRealTimers();
  }
}

const text = (lines: string[]) => `${lines.join('\n')}\n`;
const golden = () => fs.readFileSync(FIXTURE, 'utf8');
const goldenPerHost = () => fs.readFileSync(FIXTURE_PER_HOST, 'utf8');
/** The lines of one host spelling family: dispatches of m* keys and transport calls to the MFC host. */
const mfcLines = (lines: string[]) =>
  lines.filter((l) => / m\d+ \(/.test(l) || /^page \d+ \d+ https:\/\/(www\.)?myfigurecollection\.net\.?\//i.test(l));

describe('SCRAPE_POOL_SELECT off: FIFO dispatch byte-identical to develop (golden)', () => {
  it('unset: the golden order and times', async () => {
    const run = await runScenario(undefined);
    if (process.env.POOL_GOLDEN_OUT) fs.writeFileSync(process.env.POOL_GOLDEN_OUT, text(run.lines));
    expect(run.lines.length).toBeGreaterThan(60);
    expect(run.lines.some((l) => l.startsWith('page ') && l.includes(' 500 '))).toBe(true);
    expect(text(run.lines)).toBe(golden());
  });

  it('unset, only the per-host cap binding (global cap 1000): its golden order and times', async () => {
    const run = await runScenario(undefined, 7, '1000');
    if (process.env.POOL_GOLDEN_PER_HOST_OUT) fs.writeFileSync(process.env.POOL_GOLDEN_PER_HOST_OUT, text(run.lines));
    expect(text(run.lines)).toBe(goldenPerHost());
  });

  it.each(['off', ' OFF ', ''])("'%s': the golden order and times", async (knob) => {
    expect(text((await runScenario(knob)).lines)).toBe(golden());
  });

  it.each(['-myfigurecollection.net', 'all,myfigurecollection.net', '+myfigurecollection.net', 'all,-', 'off,late.test', 'late.test,all'])(
    "malformed '%s': behaves exactly as off (golden)",
    async (knob) => {
      expect(text((await runScenario(knob)).lines)).toBe(golden());
    },
  );

  it('the pool block is present with zeros when off', async () => {
    const run = await runScenario('off');
    expect(run.poolMid.scope).toBe('off');
    expect(run.poolMid.malformed).toBe(false);
    expect(run.poolMid.hosts.map((h) => h.host).sort()).toEqual(['fast.test', MFC, 'slow.test']);
    for (const h of run.poolMid.hosts) {
      expect(h.mode).toBe('fifo-off');
      expect(h.picks60m + h.agedPicks60m + h.forcedPicks60m + h.uniformPicks60m + h.redraws60m + h.scanFallbacks60m + h.retryPicks60m + h.agedCount).toBe(0);
      expect(h.p99WaitH60m + h.maxWaitH60m + h.topBucketShare60m + h.agedShare60m).toBe(0);
    }
  });
});

/**
 * The excluded host's order is its own as long as only the PER-HOST working-set cap binds. When the
 * GLOBAL cap (SCRAPE_QUEUE_MAX_RESIDENT, default 1000) binds, hosts share one page-in budget, so the
 * instant one of the excluded host's parked rows pages in depends on the other hosts' residency, and a
 * pooled host's parked picks move it: the excluded host then dispatches the same items, the same number
 * of times, but a parked HOT row can page in earlier or later than under 'off' (as it already moves
 * under FIFO whenever another host's traffic changes).
 */
describe("SCRAPE_POOL_SELECT='all,-myfigurecollection.net'", () => {
  it.each(['all,-myfigurecollection.net', ' ALL , -WWW.MyFigureCollection.NET. '])(
    "'%s': MFC (every spelling) keeps the golden FIFO order and times; the other hosts, the late one included, are pooled",
    async (knob) => {
      const run = await runScenario(knob, 7, '1000');
      expect(text(mfcLines(run.lines))).toBe(text(mfcLines(goldenPerHost().trimEnd().split('\n'))));
      const byHost = new Map(run.pool.hosts.map((h) => [h.host, h]));
      expect(byHost.get(MFC)?.mode).toBe('fifo-excluded');
      expect(byHost.get(MFC)?.picks60m).toBe(0);
      for (const host of ['fast.test', 'slow.test', 'late.test']) {
        expect(byHost.get(host)?.mode).toBe('pool');
        expect(byHost.get(host)?.picks60m).toBeGreaterThan(0);
      }
      // The late host's first pooled pick happened after boot: it was never in a boot-time host list.
      expect(run.lines.some((l) => l.startsWith('dispatch ') && / l\d \(/.test(l))).toBe(true);
    },
  );

  it('with the GLOBAL cap binding, MFC dispatches the same items the same number of times as under off', async () => {
    const run = await runScenario('all,-myfigurecollection.net');
    const mfcDispatches = (lines: string[]) => lines.filter((l) => l.startsWith('dispatch ') && / m\d+ \(/.test(l)).map((l) => l.split(' ').slice(2).join(' ')).sort();
    expect(mfcDispatches(run.lines)).toEqual(mfcDispatches(golden().trimEnd().split('\n')));
  });

  it('the pooled hosts dispatch in a different order from FIFO for this seed (the pool is live)', async () => {
    const run = await runScenario('all,-myfigurecollection.net');
    const order = (lines: string[], prefix: RegExp) => lines.filter((l) => l.startsWith('dispatch ') && prefix.test(l)).map((l) => l.split(' ')[2]);
    const fifo = golden().trimEnd().split('\n');
    expect(order(run.lines, / f\d+ \(/)).not.toEqual(order(fifo, / f\d+ \(/));
    // Same multiset: every fast.test item is still dispatched exactly as often as under FIFO.
    expect([...order(run.lines, / f\d+ \(/)].sort()).toEqual([...order(fifo, / f\d+ \(/)].sort());
  });

  it("'all,-a,-b' excludes both hosts", async () => {
    const run = await runScenario('all,-myfigurecollection.net,-fast.test', 7, '1000');
    const byHost = new Map(run.pool.hosts.map((h) => [h.host, h.mode]));
    expect(byHost.get(MFC)).toBe('fifo-excluded');
    expect(byHost.get('fast.test')).toBe('fifo-excluded');
    expect(byHost.get('late.test')).toBe('pool');
    const fifo = goldenPerHost().trimEnd().split('\n');
    const fastLines = (lines: string[]) => lines.filter((l) => / f\d+ \(/.test(l) || l.startsWith('page ') && l.includes('fast.test'));
    expect(text(fastLines(run.lines))).toBe(text(fastLines(fifo)));
  });
});
