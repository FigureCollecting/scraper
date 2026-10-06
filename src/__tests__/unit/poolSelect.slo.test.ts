/**
 * POOL-SELECT queue SLO and distribution checks (QB-U18).
 *
 * Queue scenarios port challenger-r2 agingfix.py / agingsim.py and challenger poolsim.py: initial
 * backlog 3,000, 14 days at 350 picks/h, ageCap 12 h, hard cap H 24 h, pAged 0.9; steady = inflow
 * 1.0 per pick, draining = 0.8, growing = 1.17 (reported only). Items carry tap-like increasing ids
 * (spacing 1..47), so anti-sequence is live, as it will be on MFC. SLO: steady and draining p99 wait
 * <= ageCap + 2 h, max <= 2 x ageCap, forcedPicks 0, and agedShare within 3 pp of 0.69 at steady
 * (review 2 measured 0.686 at pAged 0.9). A steady run with 10 % retryable failures, the growing run
 * and steady/draining at the realised 305 picks/h are reported and must stay inside the starvation
 * theorem's bound for every item.
 *
 * Also: the tiered rank share (residuesim.py's three hole runs as the lowest tier under stocked higher
 * tiers), an implicit pool of 120k id ranges that is never materialised, and deterministic ties.
 */

import { DEFAULT_ID_PARAMS, mulberry32, select, type Candidate, type History, type Params } from '../../services/poolSelect';
import { formatQueueResult, refMulberry32, refRankCmp, runQueueScenario, type QueueResult, type QueueScenario } from '../helpers/poolSim';

const report = (line: string) => {
  if (process.env.POOL_SIM_REPORT === '1') process.stdout.write(`${line}\n`);
};

const base: Omit<QueueScenario, 'name' | 'inflowPerPick' | 'picksPerHour'> = {
  initialBacklog: 3000,
  days: 14,
  ageCapH: 12,
  hardCapH: 24,
  pAged: 0.9,
  ids: 'tap',
  seed: 1,
};

function scenario(name: string, inflowPerPick: number, picksPerHour: number, extra: Partial<QueueScenario> = {}): QueueResult {
  const started = Date.now();
  const r = runQueueScenario({ ...base, name, inflowPerPick, picksPerHour, ...extra });
  report(`${formatQueueResult(r)} runtime=${((Date.now() - started) / 1000).toFixed(1)} s`);
  expect(r.brokenPicks).toBe(0);
  expect(r.picks).toBe(picksPerHour * 24 * base.days);
  expect(r.theoremViolations).toBe(0);
  return r;
}

describe('queue SLO at 350 picks/h (agingfix.py scenarios)', () => {
  it('steady (inflow 1.0): p99 <= 14 h, max <= 24 h, agedShare 0.69 +- 3 pp, forcedPicks 0', () => {
    const r = scenario('steady 350/h', 1.0, 350);
    expect(r.p99H).toBeLessThanOrEqual(14);
    expect(r.maxH).toBeLessThanOrEqual(24);
    expect(Math.abs(r.agedShare - 0.69)).toBeLessThanOrEqual(0.03);
    expect(r.forcedPicks).toBe(0);
    expect(r.r1Share).toBe(0);
  }, 120_000);

  it('draining (inflow 0.8): p99 <= 14 h, max <= 24 h, forcedPicks 0', () => {
    const r = scenario('draining 350/h', 0.8, 350);
    expect(r.p99H).toBeLessThanOrEqual(14);
    expect(r.maxH).toBeLessThanOrEqual(24);
    expect(r.forcedPicks).toBe(0);
  }, 120_000);

  it('steady with 10 % retryable failures: reported, inside the theorem bound for every item', () => {
    const r = scenario('steady 350/h, 10 % retryable failures', 1.0, 350, { failRate: 0.1 });
    expect(r.theoremChecked).toBeGreaterThan(0);
    expect(r.maxTheoremRatio).toBeLessThanOrEqual(1);
  }, 180_000);

  it('growing (inflow 1.17): reported only, inside the theorem bound for every item', () => {
    const r = scenario('growing 350/h', 1.17, 350);
    expect(r.maxTheoremRatio).toBeLessThanOrEqual(1);
  }, 180_000);
});

describe('queue at the realised MFC rate, 305 picks/h (reported)', () => {
  it('steady and draining: inside the theorem bound', () => {
    const steady = scenario('steady 305/h', 1.0, 305);
    const draining = scenario('draining 305/h', 0.8, 305);
    expect(steady.maxTheoremRatio).toBeLessThanOrEqual(1);
    expect(draining.maxTheoremRatio).toBeLessThanOrEqual(1);
  }, 180_000);
});

describe('tiered rank: the lowest tier gets the share its bucket weights and the uniform floor give', () => {
  it('holes (residuesim.py three runs, 3,000 ids) as tier 3 under stocked tiers 0 and 1, within 2 pp', () => {
    const g = refMulberry32(7);
    const holes = new Set<number>();
    for (const [lo, hi] of [
      [3801130, 3802130],
      [3780000, 3780600],
      [3790000, 3791400],
    ]) {
      for (let id = lo; id < hi; id++) holes.add(id);
    }
    const pool: Candidate[] = [];
    const used = new Set<number>(holes);
    const addTier = (tier: number, count: number) => {
      while (count > 0) {
        const id = 1 + Math.floor(g() * 3_804_755);
        if (used.has(id)) continue;
        used.add(id);
        pool.push({ key: `t${tier}-${id}`, tier, recency: id, numId: id });
        count--;
      }
    };
    addTier(0, 1144); // target ids (Ross's collection)
    addTier(1, 500); // unseen Top-list ids
    for (const id of holes) pool.push({ key: `t3-${id}`, tier: 3, recency: id, numId: id });
    for (let i = pool.length - 1; i > 0; i--) {
      // Fisher-Yates: the input order must not matter.
      const j = Math.floor(g() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }

    const n = pool.length;
    const firstHole = 1144 + 500;
    // Theory, computed here: P(rank r) under R3 = w(b)/sum(w) / |b|; holes are ranks [firstHole, n).
    const starts: number[] = [];
    for (let b = 0; 25 * (2 ** b - 1) < n; b++) starts.push(25 * (2 ** b - 1));
    starts.push(n);
    const w = starts.slice(0, -1).map((_, b) => 0.5 ** b);
    const W = w.reduce((a, b) => a + b, 0);
    let r3Share = 0;
    for (let b = 0; b < w.length; b++) {
      const lo = starts[b];
      const hi = Math.min(starts[b + 1], n);
      const overlap = Math.max(0, hi - Math.max(lo, firstHole));
      r3Share += (w[b] / W) * (overlap / (hi - lo));
    }
    const theory = 0.9 * r3Share + 0.1 * (holes.size / n);

    const rng = mulberry32(31);
    const picks = 20_000;
    let holePicks = 0;
    for (let i = 0; i < picks; i++) {
      const p = select({ kind: 'explicit', candidates: pool }, DEFAULT_ID_PARAMS, { rng, nowMs: 0, history: {} });
      expect(p).not.toBeNull();
      if (p!.candidate.tier === 3) holePicks++;
    }
    const share = holePicks / picks;
    report(`tiered rank: hole tier share ${share.toFixed(4)} vs theory ${theory.toFixed(4)} (n=${n}, holes=${holes.size})`);
    expect(Math.abs(share - theory)).toBeLessThan(0.02);
    expect(theory).toBeGreaterThan(0.07);
    expect(theory).toBeLessThan(0.08);
  }, 60_000);
});

describe('implicit pool of 120k id ranges', () => {
  it('picks without materialising: bounded rankToCandidate calls and heap growth', () => {
    const n = 120_000;
    let calls = 0;
    const rankToCandidate = (rank: number): Candidate => {
      calls++;
      const id = 3_800_000 - rank;
      return { key: String(id), tier: 0, recency: id, numId: id };
    };
    const rng = mulberry32(5);
    let history: History = {};
    // One call first: the heap delta of a single pick stays far below one candidate per range.
    const before = process.memoryUsage().heapUsed;
    const first = select({ kind: 'implicit', n, rankToCandidate }, DEFAULT_ID_PARAMS, { rng, nowMs: 0, history });
    const grown = process.memoryUsage().heapUsed - before;
    expect(first).not.toBeNull();
    expect(grown).toBeLessThan(1_000_000);
    expect(calls).toBeLessThanOrEqual(DEFAULT_ID_PARAMS.maxRedraws + 1);
    history = { prev: first!.candidate.numId };
    const picks = 10_000;
    for (let i = 1; i < picks; i++) {
      const p = select({ kind: 'implicit', n, rankToCandidate }, DEFAULT_ID_PARAMS, { rng, nowMs: 0, history });
      history = { prev: p!.candidate.numId, prev2: history.prev };
    }
    report(`implicit 120k: ${calls} rankToCandidate calls for ${picks} picks (${(calls / picks).toFixed(3)} per pick), first-pick heap delta ${grown} bytes`);
    expect(calls).toBeLessThan(picks * 2);
  });
});

describe('ties are deterministic', () => {
  it('a pool of full ties in tier and recency gives the same picks in any input order', () => {
    const params: Params = { ...DEFAULT_ID_PARAMS, ageCapMs: 50, hardCapMs: 120 };
    const pool: Candidate[] = Array.from({ length: 60 }, (_, i) => ({
      key: `k${(i * 37) % 60}`,
      tier: 0,
      recency: 5,
      numId: 1000 + ((i * 37) % 60),
      classEnteredAtMs: 10 * (i % 3), // ties in entry time too
    }));
    const orders = [pool, [...pool].reverse(), [...pool].sort(refRankCmp)];
    const runs = orders.map((candidates) => {
      const rng = mulberry32(9);
      let history: History = {};
      const out: string[] = [];
      for (let t = 0; t < 2000; t++) {
        const p = select({ kind: 'explicit', candidates }, params, { rng, nowMs: t, history });
        expect(p).not.toBeNull();
        out.push(`${p!.candidate.key}:${p!.rule}:${p!.markSkip ?? ''}`);
        history = { prev: p!.candidate.numId, prev2: history.prev };
      }
      return out;
    });
    expect(runs[1]).toEqual(runs[0]);
    expect(runs[2]).toEqual(runs[0]);
    expect(new Set(runs[0].map((s) => s.split(':')[1])).size).toBeGreaterThanOrEqual(3);
  });
});
