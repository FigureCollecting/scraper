/**
 * POOL-SELECT starvation theorem (QB-U18). Fix a class K ordered by (classEnteredAt, key). Let x
 * enter K at a, B(a) = older K items not completed at a, A(a) = their remaining dispatch attempts
 * (<= 4 B(a) at maxRetries 3). Under R1 with hard cap H and one skip per item, x is dispatched within
 * A(a) + B(a) + 2 + r K-picks made after a + H, for ANY rng, r = restarts in that interval (a restart
 * clears every skip mark).
 *
 * The harness (../helpers/poolSim.ts) checks the bound for EVERY item, with A(a) counted as the
 * dispatches that really remain (scheduled failures + 1 - spent), which is never more than the
 * theorem's allowance, so the check is the stronger one. Every pick is also compared with a
 * reference R1 written from theorem_retry.py, which is what "R1 never dispatches a raised row ahead
 * of x" rests on; raised rows are additionally checked directly.
 */

import { DEFAULT_ID_PARAMS, deriveStream, type Params, type Rng } from '../../services/poolSelect';
import {
  adversarialRng,
  formatQueueResult,
  refMulberry32,
  runClassSim,
  runQueueScenario,
  type ClassSimResult,
  type SimItemSpec,
} from '../helpers/poolSim';

const report = (line: string) => {
  if (process.env.POOL_SIM_REPORT === '1') process.stdout.write(`${line}\n`);
};

/** R1 never draws: any call fails the test. */
const noDraws: Rng = () => {
  throw new Error('R1 must not draw from the rng');
};

function r1Params(H: number): Params {
  return { ...DEFAULT_ID_PARAMS, hardCapMs: H };
}

function expectClean(sim: ClassSimResult) {
  expect(sim.brokenPicks).toBe(0);
  expect(sim.r1MismatchSamples).toEqual([]);
  expect(sim.r1Mismatches).toBe(0);
  expect(sim.theoremViolations).toEqual([]);
  expect(sim.raisedAheadViolations).toBe(0);
  expect(sim.left).toBe(0);
}

describe('fixed vectors from challenger-r3 theorem_retry.py', () => {
  const H = 50;
  // Python's picks_until_x (R1 keyed on age, retries keep the entry time, empty history).
  const python: Record<string, number> = {
    '10/0/true': 11,
    '10/0/false': 11,
    '10/1/true': 17,
    '10/1/false': 21,
    '10/3/true': 32,
    '10/3/false': 39,
    '100/0/true': 101,
    '100/0/false': 101,
    '100/1/true': 198,
    '100/1/false': 201,
    '100/3/true': 392,
    '100/3/false': 399,
    '3000/0/true': 3001,
    '3000/0/false': 3001,
    '3000/1/true': 5998,
    '3000/1/false': 6001,
    '3000/3/true': 11992,
    '3000/3/false': 11999,
  };

  const vectors: Array<[number, number, boolean]> = [];
  for (const B of [10, 100, 3000]) for (const fails of [0, 1, 3]) for (const contiguous of [true, false]) vectors.push([B, fails, contiguous]);

  it.each(vectors)('B %p, %p retries per older item, contiguous ids %p: same count as Python, inside A + B + 2', (B, fails, contiguous) => {
    const items: SimItemSpec[] = [];
    for (let i = 0; i < B; i++) items.push({ key: `o${i}`, ceaTick: i, recency: i, numId: contiguous ? 1000 + i : 1000 + 97 * i, fails });
    items.push({ key: 'x', ceaTick: B, recency: B, numId: contiguous ? 1000 + B : 1000 + 97 * B });
    // Everything is hard-aged at the first pick, as in the Python run.
    const sim = runClassSim({ params: r1Params(H), items, firstPickTick: B + H, rng: noDraws, checkR1: true });
    expectClean(sim);
    const x = sim.records.find((r) => r.key === 'x')!;
    expect(x.picksAfter).toBe(python[`${B}/${fails}/${contiguous}`]);
    expect(x.B).toBe(B);
    expect(x.Areal).toBe(B * (fails + 1));
    expect(x.bound).toBe(B * (fails + 1) + B + 2);
    expect(x.picksAfter!).toBeLessThanOrEqual(x.bound!);
    report(`theorem vector B=${B} retries=${fails} contiguous=${contiguous}: picks until x=${x.picksAfter} bound A+B+2=${x.bound} (rev 2 bound 2(B+1)=${2 * (B + 1)})`);
  });

  it.each([
    [10, 0],
    [10, 50],
    [100, 500],
  ])('B %p with %p rows raised into K after a: raised rows sit behind x (class-entry keying)', (B, R) => {
    const items: SimItemSpec[] = [];
    for (let i = 0; i < B; i++) items.push({ key: `o${i}`, ceaTick: 100 + i, recency: 100 + i, numId: 5000 + 97 * i });
    items.push({ key: 'x', ceaTick: 100 + B, recency: 100 + B, numId: 5000 + 97 * B });
    // Enqueued long ago (old recency), raised into K after a: classEnteredAt = the raise time.
    for (let j = 0; j < R; j++) items.push({ key: `r${j}`, ceaTick: 101 + B + j, recency: j, numId: 90_000 + 97 * j, raised: true });
    const sim = runClassSim({ params: r1Params(H), items, firstPickTick: 101 + B + R + H, rng: noDraws, checkR1: true });
    expectClean(sim);
    const x = sim.records.find((r) => r.key === 'x')!;
    // Python keyed on enqueue time dispatched the raised rows first: 61 picks at (10, 50), 302 at (100, 500).
    expect(x.picksAfter).toBe(B + 1);
    expect(x.picksAfter!).toBeLessThanOrEqual(x.bound!);
    report(`raise vector B=${B} raised=${R}: picks until x=${x.picksAfter} bound=${x.bound} (python enqueue-keyed: ${R === 0 ? 11 : R === 50 ? 61 : 302})`);
  });
});

describe('hand-built worst case: the bound is reached exactly', () => {
  // o1 fails 3 times; every older item fails anti-sequence when it becomes the oldest, and a newer
  // hard-aged item is there to take each skip pick. History starts at prev 999.
  const H = 10;
  const items: SimItemSpec[] = [
    { key: 'o1', ceaTick: 0, recency: 0, numId: 1000, fails: 3 },
    { key: 'x', ceaTick: 1, recency: 1, numId: 1001 },
    { key: 'y1', ceaTick: 2, recency: 2, numId: 5000 },
    { key: 'y2', ceaTick: 3, recency: 3, numId: 1004 },
    { key: 'y3', ceaTick: 4, recency: 4, numId: 9000 },
  ];

  it('without a restart: x waits A + B + 2 = 4 + 1 + 2 = 7 picks after a + H', () => {
    const sim = runClassSim({ params: r1Params(H), items, firstPickTick: 4 + H, rng: noDraws, checkR1: true, initialHistory: { prev: 999 }, logPicks: true });
    expectClean(sim);
    expect(sim.pickLog.map((p) => `${p.key}:${p.rule}${p.markSkip ? `:skip(${p.markSkip})` : ''}`)).toEqual([
      'y1:R1:skip(o1)',
      'o1:R1',
      'o1:R1-forced',
      'o1:R1-forced',
      'o1:R1-forced',
      'y2:R1:skip(x)',
      'x:R1-forced',
      'y3:R1',
    ]);
    const x = sim.records.find((r) => r.key === 'x')!;
    expect(x).toMatchObject({ B: 1, Areal: 4, Acap: 4, restarts: 0, bound: 7, picksAfter: 7 });
    const o1 = sim.records.find((r) => r.key === 'o1')!;
    expect(o1).toMatchObject({ B: 0, Areal: 0, bound: 2, picksAfter: 2 });
  });

  it('a restart while x is marked re-arms its skip: 8 = 7 + r picks', () => {
    const sim = runClassSim({ params: r1Params(H), items, firstPickTick: 4 + H, restarts: [20], rng: noDraws, checkR1: true, initialHistory: { prev: 999 }, logPicks: true });
    expectClean(sim);
    expect(sim.pickLog.map((p) => `${p.key}:${p.rule}${p.markSkip ? `:skip(${p.markSkip})` : ''}`)).toEqual([
      'y1:R1:skip(o1)',
      'o1:R1',
      'o1:R1-forced',
      'o1:R1-forced',
      'o1:R1-forced',
      'y2:R1:skip(x)',
      'y3:R1:skip(x)',
      'x:R1',
    ]);
    const x = sim.records.find((r) => r.key === 'x')!;
    expect(x).toMatchObject({ restarts: 1, bound: 8, picksAfter: 8 });
  });
});

/**
 * A seeded scenario: bursts and singles arriving over a few hundred ticks, contiguous ids (the most
 * anti-sequence skips) in two thirds of them, retryable failures (each item failing 0-3 times,
 * re-queued at once with its classEnteredAt), priority raises (rows entering K at the raise time with
 * an OLD recency), restarts, then a drain until every item is done.
 */
function scenario(seed: number): { items: SimItemSpec[]; restarts: number[]; params: Params; H: number } {
  const g = refMulberry32(Math.imul(seed, 2654435761) >>> 0);
  const H = 30 + Math.floor(g() * 90);
  const arrivalTicks = 150 + Math.floor(g() * 350);
  const singleP = 0.3 + g() * 0.6;
  const burstP = 0.005 + g() * 0.025;
  const contiguous = g() < 0.67;
  const items: SimItemSpec[] = [];
  let n = 0;
  for (let t = 0; t < arrivalTicks; t++) {
    let k = g() < singleP ? 1 : 0;
    if (g() < burstP) k += 10 + Math.floor(g() * 70);
    for (let j = 0; j < k; j++) {
      const i = n++;
      const raised = g() < 0.1;
      const roll = g();
      const fails = roll < 0.6 ? 0 : roll < 0.75 ? 1 : roll < 0.85 ? 2 : 3;
      items.push({
        key: `s${String(i).padStart(6, '0')}`,
        ceaTick: t,
        recency: raised ? t - 10 * H - Math.floor(g() * 1000) : t,
        numId: contiguous ? 10_000 + i : 10_000 + i * 97 + Math.floor(g() * 40),
        fails,
        raised,
      });
    }
  }
  const restarts: number[] = [];
  for (let t = 0; t < arrivalTicks * 4; t++) if (g() < 0.004) restarts.push(t);
  return { items, restarts, H, params: { ...DEFAULT_ID_PARAMS, ageCapMs: Math.floor(H / 2), hardCapMs: H } };
}

describe('200 seeded adversarial scenarios: the bound holds for every item, for any rng', () => {
  it('adversarial rng (steers R2/R3 away from the oldest), then a seeded rng on the same scenarios', () => {
    const totals = { items: 0, checked: 0, picks: 0, r1: 0, forced: 0, skips: 0, raisedR1: 0, raisedSkip: 0, maxRatio: 0, restartsHit: 0 };
    for (let seed = 1; seed <= 200; seed++) {
      const sc = scenario(seed);
      for (const mode of ['adversarial', 'seeded'] as const) {
        const adv = mode === 'adversarial' ? adversarialRng() : undefined;
        const sim = runClassSim({
          params: sc.params,
          items: sc.items,
          restarts: sc.restarts,
          rng: adv ?? deriveStream(seed, 'starvation', 'pick'),
          checkR1: true,
        });
        expectClean(sim);
        if (adv !== undefined) {
          expect(sim.adversaryMisses).toBe(0);
          expect(sim.stageCounts.R2 ?? 0).toBe(0);
        }
        totals.items += sim.records.length;
        totals.checked += sim.theoremChecked;
        totals.picks += sim.picks;
        totals.r1 += sim.stageCounts.R1 ?? 0;
        totals.forced += sim.ruleCounts['R1-forced'] ?? 0;
        totals.skips += sim.skipPicks;
        totals.raisedR1 += sim.raisedR1Picks;
        totals.raisedSkip += sim.raisedSkipPicks;
        totals.maxRatio = Math.max(totals.maxRatio, sim.maxTheoremRatio);
        totals.restartsHit += sim.records.filter((r) => (r.restarts ?? 0) > 0).length;
      }
    }
    // The scenarios really exercise R1: many items reach a + H, skips and forced picks happen.
    expect(totals.checked).toBeGreaterThan(20_000);
    expect(totals.r1).toBeGreaterThan(50_000);
    expect(totals.skips).toBeGreaterThan(1000);
    expect(totals.forced).toBeGreaterThan(100);
    expect(totals.raisedR1).toBeGreaterThan(1000);
    expect(totals.restartsHit).toBeGreaterThan(100);
    expect(totals.maxRatio).toBeLessThanOrEqual(1);
    report(`starvation 200 scenarios x 2 rngs: ${JSON.stringify(totals)}`);
  }, 300_000);
});

/**
 * The overloaded queue run of the SLO harness (agingfix.py set-up: backlog 3,000, 14 days at 350
 * picks/h, ageCap 12 h, H 24 h, pAged 0.9, tap-like ids): growing, inflow 1.17x. No order bounds the
 * wait of a queue whose load exceeds its capacity, so its waits are reported only; what must hold is
 * the theorem bound, for every item, through the hard-aged regime it spends most of its time in.
 */
describe('overloaded queue (reported): the bound holds for every item', () => {
  it('growing (inflow 1.17)', () => {
    const started = Date.now();
    const r = runQueueScenario({
      name: 'growing 350/h',
      initialBacklog: 3000,
      inflowPerPick: 1.17,
      days: 14,
      picksPerHour: 350,
      ageCapH: 12,
      hardCapH: 24,
      pAged: 0.9,
      ids: 'tap',
      seed: 1,
    });
    report(`${formatQueueResult(r)} runtime=${((Date.now() - started) / 1000).toFixed(1)} s`);
    expect(r.brokenPicks).toBe(0);
    expect(r.picks).toBe(350 * 24 * 14);
    expect(r.theoremChecked).toBeGreaterThan(10_000);
    expect(r.forcedPicks).toBeGreaterThan(0); // the hard-aged regime is really reached
    expect(r.theoremViolations).toBe(0);
    expect(r.maxTheoremRatio).toBeLessThanOrEqual(1);
  }, 180_000);
});
