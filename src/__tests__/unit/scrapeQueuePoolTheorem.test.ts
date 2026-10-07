/**
 * QB-U19: the starvation theorem of POOL-SELECT v1.1 THROUGH THE REAL QUEUE (design.pool_select_v1_1
 * .starvation_theorem.pinned_by: "QB-U19 repeats (1) through the real queue (parked rows included,
 * failures through the real retry path, raises through a dedup enqueue at a higher priority) with a
 * fake clock").
 *
 * A real ScrapeQueue on a real SQLite store with a per-host working-set cap of 8 (so most of the class
 * sits PARKED on disk), one store host paced at 1 s, SCRAPE_POOL_SELECT=all, fake timers. Items arrive in
 * bursts of CONTIGUOUS ids (the most anti-sequence skips), fail retryably through the queue's own retry
 * path (a 500 = 'network': re-queued at once with its class entry kept, its attempt written back; three
 * failures give up), some are enqueued COLD and raised to WARM later by a dedup enqueue (they enter the
 * WARM class at the raise), and the process restarts several times (new queue, new store handle, new
 * PoolDispatch: skip marks and history gone; rows, attempts and class entries restored from disk).
 *
 * The ADVERSARIAL runs set the age cap equal to the hard cap (so R2 never draws) and an rng that steers
 * every R3 pick to the newest item (each attempt draws 0.999, 0, 0: no uniform pick, bucket 0, rank 0);
 * the SEEDED runs keep R2 live (age cap H/2) with the derived stream. For every item x the bound
 * A(a) + B(a) + 2 + r holds (ClassModel), every R1 pick is the oldest hard-aged item or names it as its
 * one skip (so a raised row is never taken by R1 ahead of an item that entered the class before its
 * raise, except as that skip, which recheck h1 showed the specified algorithm does), and every pick saw
 * the whole class: resident and parked rows.
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
import type { ScrapeQueueStore } from '../../services/queueStore';
import { PoolDispatch, setPoolDispatch } from '../../services/poolDispatch';
import type { Rng } from '../../services/poolSelect';
import { refMulberry32 } from '../helpers/poolSim';
import { ClassModel, type ClassModelResult } from '../helpers/poolClassModel';
import { openPoolStore, poolTmpDir, wirePoolQueue, type TransportCall } from '../helpers/poolQueueHarness';

const T0 = 1_800_000_000_000;
const HOST = 'k.test';
const SITES = [{ siteId: 'k', domain: HOST, baseDelayMs: 1000 }];
const H_HOURS = 0.05; // 180 s = 180 picks at the 1 s floor
const H_MS = H_HOURS * 3_600_000;

const report = (line: string) => {
  if (process.env.POOL_SIM_REPORT === '1') process.stdout.write(`${line}\n`);
};

/** Every R3 attempt draws (0.999, 0, 0): no uniform pick, bucket 0, rank 0 = the newest. R1 draws nothing. */
function adversary(): Rng {
  let i = 0;
  return () => (i++ % 3 === 0 ? 0.999 : 0);
}

interface Event {
  t: number; // ms after T0
  kind: 'arrive' | 'raise' | 'restart';
  key?: string;
  priority?: 'WARM' | 'COLD';
}

interface Scenario {
  events: Event[];
  fails: Map<string, number>;
  ids: Map<string, number>;
}

/**
 * Bursts of contiguous ids (gaps up to maxGapMs), 0-3 planned failures, ~12 % raised from COLD, `restarts`
 * restarts. Dedup keys are 'x000123' by default; `numericKeys` makes them the id itself, all digits, as
 * MFC's are (an all-digit key takes POOL-SELECT's padded sort key, R1's skip mark included).
 */
function scenario(seed: number, bursts: number, restarts: number, maxGapMs = 40_000, numericKeys = false): Scenario {
  const gen = refMulberry32(seed);
  const events: Event[] = [];
  const fails = new Map<string, number>();
  const ids = new Map<string, number>();
  let id = 100_000;
  let seq = 0;
  let t = 0;
  for (let b = 0; b < bursts; b++) {
    t += Math.floor(gen() * maxGapMs);
    id += 50 + Math.floor(gen() * 3_000);
    const size = 5 + Math.floor(gen() * 26);
    for (let j = 0; j < size; j++) {
      const key = numericKeys ? String(id + j) : `x${String(seq).padStart(6, '0')}`;
      seq++;
      ids.set(key, id + j);
      const u = gen();
      fails.set(key, u < 0.6 ? 0 : u < 0.85 ? 1 : u < 0.95 ? 2 : 3);
      if (gen() < 0.12) {
        events.push({ t, kind: 'arrive', key, priority: 'COLD' });
        events.push({ t: t + 5_000 + Math.floor(gen() * 300_000), kind: 'raise', key, priority: 'WARM' });
      } else {
        events.push({ t, kind: 'arrive', key, priority: 'WARM' });
      }
    }
  }
  const span = t;
  for (let r = 0; r < restarts; r++) events.push({ t: 120_000 + Math.floor(gen() * Math.max(1, span)), kind: 'restart' });
  events.sort((x, y) => x.t - y.t || (x.kind === 'restart' ? -1 : y.kind === 'restart' ? 1 : 0));
  return { events, fails, ids };
}

let dirs: string[] = [];
let live: Array<{ queue: ScrapeQueue; store: ScrapeQueueStore }> = [];

afterEach(() => {
  for (const { queue, store } of live) {
    queue.stop();
    try {
      store.close();
    } catch {
      /* closed */
    }
    queue.clear();
  }
  live = [];
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
  delete process.env.SCRAPE_QUEUE_MAX_RESIDENT_PER_HOST;
  setPoolDispatch(null);
  resetScrapeQueue();
});

jest.setTimeout(180_000);

async function runThroughQueue(opts: { seed: number; adversarial: boolean; bursts: number; restarts: number; maxGapMs?: number; numericKeys?: boolean }): Promise<ClassModelResult & { leftover: number; storeLeft: number; items: number; seconds: number }> {
  process.env.SCRAPE_QUEUE_MAX_RESIDENT_PER_HOST = '8';
  jest.useFakeTimers();
  jest.setSystemTime(T0);
  const sc = scenario(opts.seed, opts.bursts, opts.restarts, opts.maxGapMs, opts.numericKeys);
  const model = new ClassModel(`${HOST}|WARM`, H_MS);
  const dir = poolTmpDir('pool-theorem-');
  dirs.push(dir);
  const urlOf = (key: string) => `https://${HOST}/item/${sc.ids.get(key)}`;
  const keyOfUrl = new Map<string, string>();
  for (const key of sc.ids.keys()) keyOfUrl.set(urlOf(key), key);
  const calls: TransportCall[] = [];
  const caps = opts.adversarial ? { ageCaps: `${HOST}=${H_HOURS}`, hardCaps: `${HOST}=${H_HOURS}` } : { ageCaps: `${HOST}=${H_HOURS / 2}`, hardCaps: `${HOST}=${H_HOURS}` };
  let generation = 0;
  const boot = (): { queue: ScrapeQueue; store: ScrapeQueueStore } => {
    const store = openPoolStore(dir);
    const queue = wirePoolQueue({ store, sites: SITES, calls, statusFor: (u) => model.attempt(keyOfUrl.get(u) as string) });
    queue.setPoolDispatch(new PoolDispatch({
      select: 'all',
      ...caps,
      seed: opts.seed + generation++,
      ...(opts.adversarial ? { rngFor: () => adversary() } : {}),
      onPick: (e) => model.onPick(e),
    }));
    const proc = { queue, store };
    live.push(proc);
    return proc;
  };
  let proc = boot();
  let next = 0;
  const hardStop = T0 + 3_600_000 * 3;
  while (Date.now() < hardStop) {
    const now = Date.now() - T0;
    while (next < sc.events.length && sc.events[next].t <= now) {
      const ev = sc.events[next++];
      if (ev.kind === 'restart') {
        proc.queue.stop();
        proc.queue.releaseLeasesForShutdown();
        proc.store.close();
        proc.queue.clear();
        proc = boot();
        model.restart(Date.now());
        proc.queue.restoreFromStore(Date.now());
        continue;
      }
      // The model learns of each class entry BEFORE the enqueue: an idle queue dispatches at once.
      const key = ev.key as string;
      if (ev.kind === 'arrive') {
        model.add(key, urlOf(key), sc.fails.get(key) as number);
        if (ev.priority === 'WARM') model.enter(key, Date.now(), false);
        proc.queue.enqueue(key, { url: urlOf(key), priority: ev.priority });
      } else {
        const it = model.items.get(key)!;
        if (it.done) {
          // Dispatched and finished while still COLD: the enqueue is a fresh row, not a raise.
          model.add(key, urlOf(key), 0);
          model.enter(key, Date.now(), false);
        } else {
          model.enter(key, Date.now(), true);
        }
        proc.queue.enqueue(key, { url: urlOf(key), priority: 'WARM' });
      }
    }
    if (next >= sc.events.length && [...model.items.values()].every((i) => i.done)) break;
    await jest.advanceTimersByTimeAsync(250);
  }
  // Let the last attempt settle (its completion removes the row).
  await jest.advanceTimersByTimeAsync(1000);
  const res = model.result();
  const out = {
    ...res,
    leftover: [...model.items.values()].filter((i) => !i.done).length,
    storeLeft: (() => { const c = proc.store.counts(); return c.pending + c.leased + c.parked; })(),
    items: model.items.size,
    seconds: (Date.now() - T0) / 1000,
  };
  report(
    `theorem ${opts.adversarial ? 'adversarial' : 'seeded'} seed=${opts.seed}: items=${out.items} picks=${res.picks} fakeSeconds=${out.seconds} ` +
      `checked=${res.theoremChecked} violations=${res.theoremViolations.length} maxRatio=${res.maxRatio.toFixed(3)} maxRatioAllowance=${res.maxRatioCap.toFixed(3)} ` +
      `r1Violations=${res.r1Violations.length} poolSizeMismatches=${res.poolSizeMismatches.length} raisedR1=${res.raisedR1Picks} raisedSkip=${res.raisedSkipPicks} ` +
      `skipPicks=${res.skipPicks} forced=${res.forcedPicks} restartsInWindows=${res.restartsInWindows} maxWaitS=${Math.max(...res.waitsMs) / 1000} rules=${JSON.stringify(res.rules)}`,
  );
  jest.useRealTimers();
  return out;
}

function expectTheorem(r: Awaited<ReturnType<typeof runThroughQueue>>): void {
  expect(r.poolSizeMismatches).toEqual([]);
  expect(r.r1Violations).toEqual([]);
  expect(r.theoremViolations).toEqual([]);
  expect(r.maxRatio).toBeLessThanOrEqual(1);
  // Every item fully dispatched: nothing left in the model, nothing left on disk.
  expect(r.leftover).toBe(0);
  expect(r.storeLeft).toBe(0);
  // Non-vacuous: many items reached a + H, R1 ran, skips happened, raised rows were taken by R1.
  expect(r.theoremChecked).toBeGreaterThan(50);
  expect(r.stages.R1 ?? 0).toBeGreaterThan(50);
  expect(r.skipPicks).toBeGreaterThan(0);
}

describe('starvation theorem through the real queue: A(a) + B(a) + 2 + r for every item', () => {
  it.each([101, 202])('adversarial rng, R2 off, parked rows, retries, raises and restarts (scenario seed %i)', async (seed) => {
    const r = await runThroughQueue({ seed, adversarial: true, bursts: 24, restarts: 3 });
    expectTheorem(r);
    expect(r.raisedR1Picks).toBeGreaterThan(0);
    expect(r.restartsInWindows).toBeGreaterThan(0);
    expect(r.stages.R2 ?? 0).toBe(0);
  });

  it.each([101, 202])('adversarial rng with all-digit dedup keys, as MFC\'s are (scenario seed %i)', async (seed) => {
    const r = await runThroughQueue({ seed, adversarial: true, bursts: 24, restarts: 3, numericKeys: true });
    expectTheorem(r);
    expect(r.raisedR1Picks).toBeGreaterThan(0);
  });

  it.each([303, 404])('seeded rng, R2 live (age cap H/2), denser bursts so items still reach a + H (scenario seed %i)', async (seed) => {
    const r = await runThroughQueue({ seed, adversarial: false, bursts: 40, restarts: 3, maxGapMs: 12_000 });
    expectTheorem(r);
    expect(r.stages.R2 ?? 0).toBeGreaterThan(0);
  });
});
