/**
 * QB-U19: the queue SLO THROUGH THE REAL QUEUE (refill simulation): steady and draining load, then the
 * 10 % retryable-failure scenario, with POOL-SELECT dispatch at the shipped caps (age 12 h, hard 24 h,
 * pAged 0.9) on a real SQLite store whose working set holds 100 rows per host, so most of the backlog is
 * PARKED and every dispatch exercises page-in and parked picks.
 *
 * Scale: QB-U18's poolsim scenarios (backlog 3,000 at 350 picks/h) at one tenth: backlog 300 at 36
 * picks/h (the store's floor is 100 s), so the backlog is ~8.3 h of work as there (3,000 / 350 = 8.6 h)
 * and the age caps bind the same way. Steady = one arrival per pick, draining = 0.8; ids tap-like
 * (increasing, spacing 1..47), so anti-sequence is live. Each run then stops arrivals and drains: every
 * item enqueued (over 1,000 per run) is dispatched to completion and the store ends empty.
 *
 * SLO (design.pool_select_v1_1.slo_from_R2): steady and draining p99 wait <= age cap + 2 h, max <= 2 x age
 * cap, forcedPicks 0, measured over the scenario window. The 10 % failure run is REPORTED (inflow then
 * exceeds capacity, as in QB-U18) and must stay inside the starvation theorem's bound for every item.
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
import { refMulberry32 } from '../helpers/poolSim';
import { ClassModel, quantileOf } from '../helpers/poolClassModel';
import { openPoolStore, poolTmpDir, wirePoolQueue, type TransportCall } from '../helpers/poolQueueHarness';

const T0 = 1_800_000_000_000;
const HOST = 's.test';
const HOUR = 3_600_000;
const PICKS_PER_HOUR = Number(process.env.POOL_SLO_RATE ?? 36);
const FLOOR_MS = HOUR / PICKS_PER_HOUR;
const BACKLOG = Number(process.env.POOL_SLO_BACKLOG ?? 300);
const DAYS = Number(process.env.POOL_SLO_DAYS ?? 7);

const report = (line: string) => {
  if (process.env.POOL_SIM_REPORT === '1') process.stdout.write(`${line}\n`);
};

let dirs: string[] = [];
let live: Array<{ queue: ScrapeQueue; store: ScrapeQueueStore }> = [];

afterEach(() => {
  for (const { queue, store } of live) {
    queue.stop();
    queue.clear();
    try {
      store.close();
    } catch {
      /* closed */
    }
  }
  live = [];
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
  delete process.env.SCRAPE_QUEUE_MAX_RESIDENT_PER_HOST;
  setPoolDispatch(null);
  resetScrapeQueue();
});

jest.setTimeout(300_000);

interface SloResult {
  name: string;
  enqueued: number;
  windowPicks: number;
  p50H: number;
  p99H: number;
  maxH: number;
  agedShare: number;
  forcedPicks: number;
  theoremChecked: number;
  theoremViolations: number;
  maxRatio: number;
  poolSizeMismatches: number;
  r1Violations: number;
  maxPool: number;
  leftover: number;
  storeLeft: number;
  completed: number;
  rules: Record<string, number>;
}

async function runSlo(name: string, inflowPerPick: number, failRate = 0, seed = 1): Promise<SloResult> {
  process.env.SCRAPE_QUEUE_MAX_RESIDENT_PER_HOST = '100';
  jest.useFakeTimers();
  jest.setSystemTime(T0);
  const model = new ClassModel(`${HOST}|WARM`, 24 * HOUR);
  const gen = refMulberry32(seed ^ 0x5bd1e995);
  const dir = poolTmpDir('pool-slo-');
  dirs.push(dir);
  const calls: TransportCall[] = [];
  const keyOfUrl = new Map<string, string>();
  const store = openPoolStore(dir);
  const queue = wirePoolQueue({
    store,
    sites: [{ siteId: 's', domain: HOST, baseDelayMs: FLOOR_MS }],
    calls,
    statusFor: (u) => model.attempt(keyOfUrl.get(u) as string),
  });
  const windowWaits: number[] = [];
  let windowPicks = 0;
  let aged = 0;
  let forced = 0;
  let maxPool = 0;
  const windowEnd = T0 + DAYS * 24 * HOUR;
  queue.setPoolDispatch(new PoolDispatch({
    select: 'all',
    seed: seed + 17,
    onPick: (e) => {
      model.onPick(e);
      maxPool = Math.max(maxPool, e.poolSize);
      if (e.nowMs <= windowEnd) {
        windowPicks++;
        windowWaits.push(e.waitMs);
        if (e.stage === 'R2') aged++;
        if (e.rule === 'R1-forced') forced++;
      }
    },
  }));
  live.push({ queue, store });

  let seq = 0;
  let id = 1_000_000;
  const add = () => {
    id += 1 + Math.floor(gen() * 47);
    let fails = 0;
    while (fails < 3 && gen() < failRate) fails++;
    const key = `s${String(seq++).padStart(8, '0')}`;
    const u = `https://${HOST}/item/${id}`;
    keyOfUrl.set(u, key);
    model.add(key, u, fails);
    // The model learns of the class entry BEFORE the enqueue: an idle queue dispatches at once.
    model.enter(key, Date.now(), false);
    queue.enqueue(key, { url: u, priority: 'WARM' });
  };
  // The initial backlog arrives one pick interval apart before the first pick, oldest first, as
  // agingfix.py's does (ticks -(n0 - 1)..0): a backlog that built up at the service rate, not a burst.
  jest.setSystemTime(T0 - (BACKLOG - 1) * FLOOR_MS);
  for (let i = 0; i < BACKLOG; i++) {
    add();
    if (i < BACKLOG - 1) jest.setSystemTime(Date.now() + FLOOR_MS);
  }
  let frac = 0;
  // Steady / draining window: one floor per step, arrivals through a fractional accumulator.
  while (Date.now() < windowEnd) {
    await jest.advanceTimersByTimeAsync(FLOOR_MS);
    frac += inflowPerPick;
    while (frac >= 1) {
      add();
      frac -= 1;
    }
  }
  // Then arrivals stop and the queue drains: every item enqueued must be dispatched to completion.
  const drainStop = Date.now() + 200 * 24 * HOUR;
  while (Date.now() < drainStop && model.pending().length > 0) {
    await jest.advanceTimersByTimeAsync(FLOOR_MS * 50);
  }
  // Let the last attempt settle (its completion removes the row).
  await jest.advanceTimersByTimeAsync(FLOOR_MS);
  const res = model.result();
  const counts = store.counts();
  const stats = queue.getStats();
  const h = (ms: number) => ms / HOUR;
  const out: SloResult = {
    name,
    enqueued: seq,
    windowPicks,
    p50H: h(quantileOf(windowWaits, 0.5)),
    p99H: h(quantileOf(windowWaits, 0.99)),
    maxH: h(Math.max(...windowWaits)),
    agedShare: aged / Math.max(1, windowPicks),
    forcedPicks: forced,
    theoremChecked: res.theoremChecked,
    theoremViolations: res.theoremViolations.length,
    maxRatio: res.maxRatio,
    poolSizeMismatches: res.poolSizeMismatches.length,
    r1Violations: res.r1Violations.length,
    maxPool,
    leftover: model.pending().length,
    storeLeft: counts.pending + counts.leased + counts.parked,
    completed: stats.completed + stats.failed,
    rules: res.rules,
  };
  report(
    `slo ${name}: enqueued=${out.enqueued} windowPicks=${out.windowPicks} wait p50=${out.p50H.toFixed(1)} h p99=${out.p99H.toFixed(1)} h max=${out.maxH.toFixed(1)} h ` +
      `agedShare=${out.agedShare.toFixed(3)} forced=${out.forcedPicks} maxPool=${out.maxPool} theorem checked=${out.theoremChecked} violations=${out.theoremViolations} ` +
      `maxRatio=${out.maxRatio.toFixed(3)} r1Violations=${out.r1Violations} poolSizeMismatches=${out.poolSizeMismatches} completedOrGivenUp=${out.completed} ` +
      `left=${out.leftover}/${out.storeLeft} rules=${JSON.stringify(out.rules)}`,
  );
  jest.useRealTimers();
  return out;
}

function expectFullyDispatched(r: SloResult): void {
  expect(r.enqueued).toBeGreaterThan(1000);
  expect(r.leftover).toBe(0);
  expect(r.storeLeft).toBe(0);
  expect(r.completed).toBe(r.enqueued);
  expect(r.poolSizeMismatches).toBe(0);
  expect(r.r1Violations).toBe(0);
  expect(r.theoremViolations).toBe(0);
  expect(r.maxPool).toBeGreaterThan(100); // the pool held parked rows, not only the 100 resident
}

describe(`queue SLO through the real queue (backlog ${BACKLOG}, ${PICKS_PER_HOUR} picks/h, ${DAYS} days, caps 12 h / 24 h)`, () => {
  it('steady (one arrival per pick): p99 <= 14 h, max <= 24 h, forcedPicks 0; every item dispatched', async () => {
    const r = await runSlo('steady', 1.0);
    expectFullyDispatched(r);
    expect(r.p99H).toBeLessThanOrEqual(14);
    expect(r.maxH).toBeLessThanOrEqual(24);
    expect(r.forcedPicks).toBe(0);
    expect(r.agedShare).toBeGreaterThan(0.4);
  });

  it('draining (0.8 arrivals per pick): p99 <= 14 h, max <= 24 h, forcedPicks 0; every item dispatched', async () => {
    const r = await runSlo('draining', 0.8);
    expectFullyDispatched(r);
    expect(r.p99H).toBeLessThanOrEqual(14);
    expect(r.maxH).toBeLessThanOrEqual(24);
    expect(r.forcedPicks).toBe(0);
  });

  it('steady with 10 % retryable failures (real retry path): reported, inside the theorem bound for every item', async () => {
    const r = await runSlo('steady, 10 % retryable failures', 1.0, 0.1);
    expectFullyDispatched(r);
    expect(r.theoremChecked).toBeGreaterThan(100);
    expect(r.maxRatio).toBeLessThanOrEqual(1);
  });
});
