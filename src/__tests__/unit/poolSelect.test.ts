/**
 * POOL-SELECT v1.1 (QB-U18): the pure pick module behind queue dispatch (QB-U19), the crawler's
 * id-range supply (QB-U20a/b) and backfill page order (QB-U24). These tests pin the seeded streams,
 * the anti-sequence rule, the rank order, the bucket draw, R1 hard aging, R2 soft aging, implicit
 * pools, determinism, and the anti-sequence guarantee (zero violations on R2/R3 picks while an
 * acceptable candidate exists) over 20 seeds x 400k picks on a contiguous 200-id pool and on a
 * 5-page pool. Oracles (reference PRNG, FNV-1a, anti-sequence, rank order) live in
 * ../helpers/poolSim.ts and are written independently of the module.
 */

import {
  DEFAULT_ID_PARAMS,
  DEFAULT_PAGE_PARAMS,
  deriveStream,
  fnv1a32,
  mulberry32,
  passesAntiSequence,
  select,
  type Candidate,
  type History,
  type Params,
  type Pick,
  type Pool,
  type Rng,
} from '../../services/poolSelect';
import { antiSeqOk, refFnv1a32, refMulberry32, refRankCmp } from '../helpers/poolSim';

/** An rng that returns exactly these draws, and throws if asked for more. */
function seq(...draws: number[]): Rng {
  let i = 0;
  return () => {
    if (i >= draws.length) throw new Error(`rng exhausted after ${draws.length} draws`);
    return draws[i++];
  };
}

/** An rng that must never be called. */
const noDraws: Rng = () => {
  throw new Error('rng must not be called');
};

function cand(key: string, extra: Partial<Candidate> = {}): Candidate {
  return { key, tier: 0, recency: 0, ...extra };
}

function explicit(candidates: Candidate[]): Pool {
  return { kind: 'explicit', candidates };
}

function run(pool: Pool, params: Params, rng: Rng, history: History = {}, nowMs = 0): Pick | null {
  return select(pool, params, { rng, nowMs, history });
}

/** No uniform floor, no aging: R3 bucket draws only. */
const R3_ONLY: Params = { ...DEFAULT_ID_PARAMS, uniformFloor: 0 };

describe('mulberry32', () => {
  it('matches the published mulberry32 for several seeds, always in [0, 1)', () => {
    for (const seed of [0, 1, 42, 123456789, 0xffffffff]) {
      const got = mulberry32(seed);
      const want = refMulberry32(seed);
      for (let i = 0; i < 1000; i++) {
        const g = got();
        expect(g).toBe(want());
        expect(g).toBeGreaterThanOrEqual(0);
        expect(g).toBeLessThan(1);
      }
    }
  });

  it('pins the first draws of seeds 0 and 1', () => {
    const a = mulberry32(0);
    expect([a(), a(), a()]).toEqual([0.26642920868471265, 0.0003297457005828619, 0.2232720274478197]);
    const b = mulberry32(1);
    expect([b(), b(), b()]).toEqual([0.6270739405881613, 0.002735721180215478, 0.5274470399599522]);
  });

  it('gives two independent streams for the same seed', () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    a();
    a();
    const fresh = refMulberry32(7);
    expect(b()).toBe(fresh());
  });

  it.each([-1, 1.5, 2 ** 32, Number.NaN, Infinity])('rejects the non-uint32 seed %p', (seed) => {
    expect(() => mulberry32(seed)).toThrow(RangeError);
  });
});

describe('fnv1a32', () => {
  it('matches the published FNV-1a 32 vectors', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('a')).toBe(0xe40c292c);
    expect(fnv1a32('foobar')).toBe(0xbf9cf968);
  });

  it('hashes the UTF-8 bytes of non-ASCII text', () => {
    for (const text of ['é', '日本', 'myfigurecollection.net|pick', 'ä|ö|ü']) {
      expect(fnv1a32(text)).toBe(refFnv1a32(text));
    }
    expect(fnv1a32('é')).not.toBe(fnv1a32('e'));
  });
});

describe('deriveStream', () => {
  it('is mulberry32 of FNV-1a 32 over the seed and labels joined by |', () => {
    const got = deriveStream(42, 'myfigurecollection.net', 'pick');
    const want = refMulberry32(refFnv1a32('42|myfigurecollection.net|pick'));
    for (let i = 0; i < 50; i++) expect(got()).toBe(want());
    const bare = deriveStream(42);
    const wantBare = refMulberry32(refFnv1a32('42'));
    for (let i = 0; i < 5; i++) expect(bare()).toBe(wantBare());
  });

  it('separates streams by seed, label and label order', () => {
    const first = (r: Rng) => [r(), r(), r()];
    const pick = first(deriveStream(42, 'host', 'pick'));
    expect(first(deriveStream(42, 'host', 'jitter'))).not.toEqual(pick);
    expect(first(deriveStream(43, 'host', 'pick'))).not.toEqual(pick);
    expect(first(deriveStream(42, 'pick', 'host'))).not.toEqual(pick);
    expect(first(deriveStream(42, 'host', 'pick'))).toEqual(pick);
  });

  it.each([-1, 0.5, 2 ** 32, Number.NaN])('rejects the non-uint32 seed %p', (seed) => {
    expect(() => deriveStream(seed, 'host', 'pick')).toThrow(RangeError);
  });
});

describe('passesAntiSequence', () => {
  const ID = DEFAULT_ID_PARAMS; // minIdDistance 3, runStep 50
  const cases: Array<[string, number | undefined, History, boolean]> = [
    ['no numId always passes', undefined, { prev: 100, prev2: 99 }, true],
    ['no prev: nothing to compare', 100, {}, true],
    ['no prev even with a prev2', 100, { prev2: 99 }, true],
    ['distance 3 above is too close', 103, { prev: 100 }, false],
    ['distance 4 above passes', 104, { prev: 100 }, true],
    ['distance 3 below is too close', 97, { prev: 100 }, false],
    ['distance 4 below passes', 96, { prev: 100 }, true],
    ['same id is too close', 100, { prev: 100, prev2: 10 }, false],
    ['ascending run, both steps 50', 150, { prev2: 50, prev: 100 }, false],
    ['ascending run, first step 51', 150, { prev2: 49, prev: 100 }, true],
    ['ascending run, second step 51', 151, { prev2: 50, prev: 100 }, true],
    ['descending run, both steps 50', 50, { prev2: 150, prev: 100 }, false],
    ['descending run, first step 51', 50, { prev2: 151, prev: 100 }, true],
    ['descending run, second step 51', 49, { prev2: 150, prev: 100 }, true],
    ['direction change up then down', 90, { prev2: 95, prev: 100 }, true],
    ['direction change down then up', 110, { prev2: 105, prev: 100 }, true],
    ['flat first step is not a run (up)', 110, { prev2: 100, prev: 100 }, true],
    ['flat first step is not a run (down)', 90, { prev2: 100, prev: 100 }, true],
  ];
  it.each(cases)('%s', (_name, id, history, want) => {
    expect(passesAntiSequence(id, history, ID)).toBe(want);
  });

  it('applies page parameters: never adjacent pages, no monotone 3-run at any step', () => {
    const P = DEFAULT_PAGE_PARAMS; // minIdDistance 1, runStep Infinity
    expect(passesAntiSequence(5, { prev: 4 }, P)).toBe(false);
    expect(passesAntiSequence(6, { prev: 4 }, P)).toBe(true);
    expect(passesAntiSequence(900, { prev2: 1, prev: 3 }, P)).toBe(false);
    expect(passesAntiSequence(1, { prev2: 900, prev: 3 }, P)).toBe(false);
    expect(passesAntiSequence(1, { prev2: 2, prev: 4 }, P)).toBe(true);
  });

  it('agrees with the antiseq.py oracle on 200k random triples', () => {
    const r = refMulberry32(99);
    const small = () => Math.floor(r() * 120);
    for (let i = 0; i < 200_000; i++) {
      const params = i % 2 === 0 ? DEFAULT_ID_PARAMS : { minIdDistance: Math.floor(r() * 4), runStep: Math.floor(r() * 40) };
      const id = r() < 0.05 ? undefined : small();
      const prev = r() < 0.05 ? undefined : small();
      const prev2 = r() < 0.2 ? undefined : small();
      expect(passesAntiSequence(id, { prev, prev2 }, params)).toBe(antiSeqOk(id, prev, prev2, params.minIdDistance, params.runStep));
    }
  });
});

describe('parameters', () => {
  it('pins DEFAULT_ID_PARAMS and DEFAULT_PAGE_PARAMS', () => {
    expect(DEFAULT_ID_PARAMS).toEqual({
      headSize: 25,
      growth: 2,
      bucketDecay: 0.5,
      uniformFloor: 0.1,
      minIdDistance: 3,
      runStep: 50,
      maxRedraws: 8,
      pAged: 0.9,
    });
    expect(DEFAULT_PAGE_PARAMS).toEqual({
      headSize: 2,
      growth: 2,
      bucketDecay: 0.5,
      uniformFloor: 0.1,
      minIdDistance: 1,
      runStep: Infinity,
      maxRedraws: 8,
      pAged: 0,
    });
    expect(Object.isFrozen(DEFAULT_ID_PARAMS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_PAGE_PARAMS)).toBe(true);
  });

  const bad: Array<[string, Partial<Params>]> = [
    ['headSize 0', { headSize: 0 }],
    ['headSize NaN', { headSize: Number.NaN }],
    ['headSize Infinity', { headSize: Infinity }],
    ['growth 1', { growth: 1 }],
    ['growth Infinity', { growth: Infinity }],
    ['growth NaN', { growth: Number.NaN }],
    ['bucketDecay 0', { bucketDecay: 0 }],
    ['bucketDecay 1.01', { bucketDecay: 1.01 }],
    ['uniformFloor -0.01', { uniformFloor: -0.01 }],
    ['uniformFloor 1.01', { uniformFloor: 1.01 }],
    ['pAged -0.01', { pAged: -0.01 }],
    ['pAged 1.01', { pAged: 1.01 }],
    ['minIdDistance -1', { minIdDistance: -1 }],
    ['minIdDistance NaN', { minIdDistance: Number.NaN }],
    ['runStep -1', { runStep: -1 }],
    ['maxRedraws 1.5', { maxRedraws: 1.5 }],
    ['maxRedraws -1', { maxRedraws: -1 }],
    ['ageCapMs -1', { ageCapMs: -1 }],
    ['ageCapMs NaN', { ageCapMs: Number.NaN }],
    ['hardCapMs -1', { hardCapMs: -1 }],
  ];
  it.each(bad)('rejects %s', (_name, patch) => {
    const pool = explicit([cand('a')]);
    expect(() => run(pool, { ...DEFAULT_ID_PARAMS, ...patch }, seq(0.5, 0, 0))).toThrow(RangeError);
    // Rejected even on an empty pool, so a bad knob surfaces before the first item arrives.
    expect(() => run(explicit([]), { ...DEFAULT_ID_PARAMS, ...patch }, noDraws)).toThrow(RangeError);
  });

  const good: Array<[string, Partial<Params>]> = [
    ['uniformFloor 0 and pAged 0', { uniformFloor: 0, pAged: 0 }],
    ['uniformFloor 1 and pAged 1', { uniformFloor: 1, pAged: 1 }],
    ['bucketDecay 1', { bucketDecay: 1 }],
    ['minIdDistance 0, runStep 0, maxRedraws 0', { minIdDistance: 0, runStep: 0, maxRedraws: 0 }],
    ['runStep Infinity, minIdDistance Infinity', { runStep: Infinity, minIdDistance: Infinity }],
    ['caps 0', { ageCapMs: 0, hardCapMs: 0 }],
    ['caps Infinity', { ageCapMs: Infinity, hardCapMs: Infinity }],
  ];
  it.each(good)('accepts %s', (_name, patch) => {
    const pick = run(explicit([cand('a'), cand('b')]), { ...DEFAULT_ID_PARAMS, ...patch }, refMulberry32(3));
    expect(pick).not.toBeNull();
  });

  it('rejects aging parameters on an implicit pool, and a bad implicit size', () => {
    const rankToCandidate = (rank: number) => cand(`r${rank}`);
    const implicit = (n: number): Pool => ({ kind: 'implicit', n, rankToCandidate });
    expect(() => run(implicit(10), { ...DEFAULT_ID_PARAMS, ageCapMs: 1000 }, noDraws)).toThrow(RangeError);
    expect(() => run(implicit(10), { ...DEFAULT_ID_PARAMS, hardCapMs: 1000 }, noDraws)).toThrow(RangeError);
    for (const n of [-1, 1.5, Number.NaN, Infinity]) {
      expect(() => run(implicit(n), DEFAULT_ID_PARAMS, noDraws)).toThrow(RangeError);
    }
  });

  it.each([Number.NaN, Infinity, -Infinity])('rejects nowMs %p', (nowMs) => {
    expect(() => run(explicit([cand('a')]), DEFAULT_ID_PARAMS, noDraws, {}, nowMs)).toThrow(RangeError);
  });
});

describe('empty and single-candidate pools', () => {
  it('returns null for an empty pool, explicit or implicit, without drawing', () => {
    expect(run(explicit([]), DEFAULT_ID_PARAMS, noDraws)).toBeNull();
    const rankToCandidate = jest.fn((rank: number) => cand(`r${rank}`));
    expect(run({ kind: 'implicit', n: 0, rankToCandidate }, DEFAULT_ID_PARAMS, noDraws)).toBeNull();
    expect(rankToCandidate).not.toHaveBeenCalled();
  });

  it('returns the only candidate on every path', () => {
    const only = cand('only', { numId: 101, classEnteredAtMs: 0 });
    // Acceptable: an R3 draw.
    expect(run(explicit([only]), DEFAULT_ID_PARAMS, seq(0.5, 0.3, 0.7))).toMatchObject({ candidate: only, rank: 0, rule: 'R3', redraws: 0 });
    // Too close to prev: every draw fails, the scan finds nothing, the fallback returns it.
    const fb = run(explicit([only]), DEFAULT_ID_PARAMS, refMulberry32(1), { prev: 100 });
    expect(fb).toMatchObject({ candidate: only, rank: 0, rule: 'fallback', stage: 'R3', redraws: 8 });
    // Hard-aged and too close: forced, marked.
    const r1 = run(explicit([only]), { ...DEFAULT_ID_PARAMS, hardCapMs: 10 }, noDraws, { prev: 100 }, 10);
    expect(r1).toMatchObject({ candidate: only, rule: 'R1-forced', stage: 'R1', markSkip: 'only' });
  });
});

describe('rank order (tier asc, recency desc, key asc)', () => {
  const pool: Candidate[] = [
    cand('m', { tier: 1, recency: 5 }),
    cand('a', { tier: 0, recency: 1 }),
    cand('B', { tier: 0, recency: 9 }),
    cand('b', { tier: 0, recency: 9 }),
    cand('10', { tier: 2, recency: 3 }),
    cand('9', { tier: 2, recency: 3 }),
    cand('z', { tier: 1, recency: 7 }),
    cand('c', { tier: 0, recency: -4 }),
  ];
  const sorted = [...pool].sort(refRankCmp);

  it('a forced uniform draw at rank r returns the r-th candidate of the reference order', () => {
    expect(sorted.map((c) => c.key)).toEqual(['B', 'b', 'a', 'c', 'z', 'm', '10', '9']);
    for (let r = 0; r < pool.length; r++) {
      const pick = run(explicit(pool), DEFAULT_ID_PARAMS, seq(0, (r + 0.5) / pool.length));
      expect(pick).toMatchObject({ rank: r, rule: 'uniform', stage: 'R3', redraws: 0 });
      expect(pick?.candidate).toBe(sorted[r]);
    }
  });

  it('gives the same picks whatever the input order (ties deterministic)', () => {
    const shuffled = [...pool].reverse();
    const a = refMulberry32(11);
    const b = refMulberry32(11);
    for (let i = 0; i < 2000; i++) {
      const pa = run(explicit(sorted), DEFAULT_ID_PARAMS, a);
      const pb = run(explicit(shuffled), DEFAULT_ID_PARAMS, b);
      expect(pa).not.toBeNull();
      expect(pb?.candidate.key).toBe(pa?.candidate.key);
      expect(pb?.rank).toBe(pa?.rank);
    }
  });
});

describe('R3 bucket draw', () => {
  const flat: Params = { ...R3_ONLY, bucketDecay: 1 };
  const many = (n: number) => Array.from({ length: n }, (_, i) => cand(`k${String(i).padStart(6, '0')}`, { recency: n - i }));

  it('buckets are [25(2^b - 1), 25(2^(b+1) - 1)) and the last one is cut at n', () => {
    const pool = explicit(many(400));
    const spans = [
      [0, 24],
      [25, 74],
      [75, 174],
      [175, 374],
      [375, 399],
    ];
    spans.forEach(([lo, hi], b) => {
      const u = (b + 0.5) / spans.length; // decay 1: five equal weights
      expect(run(pool, flat, seq(0.5, u, 0))?.rank).toBe(lo);
      expect(run(pool, flat, seq(0.5, u, 0.999999))?.rank).toBe(hi);
    });
  });

  it('a draw exactly on a bucket weight boundary belongs to the next bucket', () => {
    const pool = explicit(many(75)); // two buckets, weights 1 and 1, total 2
    expect(run(pool, flat, seq(0.5, 0.5, 0))?.rank).toBe(25);
    expect(run(pool, flat, seq(0.5, 0.4999999, 0.999999))?.rank).toBe(24);
  });

  it('skips empty buckets and weighs only non-empty ones', () => {
    // headSize 0.5, growth 1.5: bucket starts 0, 1, 1, 2 -> bucket 1 is empty; n = 2 keeps
    // bucket 0 = [0,1) (weight 1) and bucket 2 = [1,2) (weight 0.25), total 1.25.
    const params: Params = { ...R3_ONLY, headSize: 0.5, growth: 1.5 };
    const pool = explicit(many(2));
    expect(run(pool, params, seq(0.5, 0.8, 0))?.rank).toBe(1);
    expect(run(pool, params, seq(0.5, 0.79, 0))?.rank).toBe(0);
    const rng = refMulberry32(5);
    let tail = 0;
    const picks = 20_000;
    for (let i = 0; i < picks; i++) if (run(pool, params, rng)?.rank === 1) tail++;
    expect(Math.abs(tail / picks - 0.2)).toBeLessThan(0.01);
  });

  it('a draw of exactly 1 stays inside the pool', () => {
    const pool = explicit(many(400));
    expect(run(pool, R3_ONLY, seq(0.5, 1, 1))?.rank).toBe(399);
    expect(run(pool, DEFAULT_ID_PARAMS, seq(0, 1))).toMatchObject({ rank: 399, rule: 'uniform' });
  });

  it('static pool of 1,000 over 10k picks: bucket shares within 2 pp of theory, uniform share within 1 pp of 10 %', () => {
    const n = 1000;
    const pool = explicit(many(n));
    // Theory, computed here: buckets [0,25) [25,75) [75,175) [175,375) [375,775) [775,1000).
    const starts = [0, 25, 75, 175, 375, 775, n];
    const weights = starts.slice(0, -1).map((_, b) => 0.5 ** b);
    const total = weights.reduce((a, b) => a + b, 0);
    const theoryR3 = weights.map((w) => w / total);
    const theoryAll = theoryR3.map((p, b) => 0.9 * p + (0.1 * (starts[b + 1] - starts[b])) / n);
    const counts = new Array(theoryR3.length).fill(0);
    const countsR3 = new Array(theoryR3.length).fill(0);
    let uniform = 0;
    let r3 = 0;
    const rng = mulberry32(2026);
    const picks = 10_000;
    for (let i = 0; i < picks; i++) {
      const p = run(pool, DEFAULT_ID_PARAMS, rng);
      expect(p).not.toBeNull();
      const b = starts.findIndex((s, j) => p!.rank >= s && p!.rank < starts[j + 1]);
      counts[b]++;
      if (p!.rule === 'uniform') uniform++;
      else {
        r3++;
        countsR3[b]++;
      }
    }
    expect(Math.abs(uniform / picks - 0.1)).toBeLessThan(0.01);
    expect(Math.abs(countsR3[0] / r3 - theoryR3[0])).toBeLessThan(0.02);
    expect(Math.abs(counts[0] / picks - theoryAll[0])).toBeLessThan(0.02);
    counts.forEach((c, b) => expect(Math.abs(c / picks - theoryAll[b])).toBeLessThan(0.02));
  });
});

describe('R3 anti-sequence: redraw, scan, fallback', () => {
  // ids by rank: 110, 104, 103, 102, 98, 50 (recency = id, so rank 0 = 110).
  const ids = [110, 104, 103, 102, 98, 50];
  const pool = explicit(ids.map((id) => cand(`i${id}`, { numId: id, recency: id })));
  const atRank = (r: number) => (r + 0.5) / ids.length; // a uniform draw landing on rank r

  it('redraws when the first draw is too close to prev', () => {
    // prev 100: 98, 102, 103 are within 3; 104 and 110 pass.
    const pick = run(pool, DEFAULT_ID_PARAMS, seq(0, atRank(3), 0, atRank(1)), { prev: 100 });
    expect(pick).toMatchObject({ rank: 1, rule: 'uniform', redraws: 1 });
  });

  it('after maxRedraws failures scans in rank order for the first acceptable candidate', () => {
    const draws: number[] = [];
    for (let i = 0; i <= DEFAULT_ID_PARAMS.maxRedraws; i++) draws.push(0, atRank(3));
    // History 95 -> 100: ascending run, so 104 and 110 (steps <= 50) fail too; 50 passes (down).
    const pick = run(pool, DEFAULT_ID_PARAMS, seq(...draws), { prev2: 95, prev: 100 });
    expect(pick).toMatchObject({ rank: 5, rule: 'scan', stage: 'R3', redraws: 8 });
  });

  it('maxRedraws 0 scans after one draw', () => {
    const pick = run(pool, { ...DEFAULT_ID_PARAMS, maxRedraws: 0 }, seq(0, atRank(3)), { prev: 100 });
    expect(pick).toMatchObject({ rank: 0, rule: 'scan', redraws: 0 });
  });

  it('with no acceptable candidate falls back to the largest |id - prev|, ties to the lower rank', () => {
    const near = [103, 101, 99, 97];
    const byRecency = explicit(near.map((id) => cand(`n${id}`, { numId: id, recency: id })));
    expect(run(byRecency, DEFAULT_ID_PARAMS, refMulberry32(4), { prev: 100 })).toMatchObject({
      candidate: { numId: 103 },
      rank: 0,
      rule: 'fallback',
    });
    const reversed = explicit(near.map((id) => cand(`n${id}`, { numId: id, recency: -id })));
    expect(run(reversed, DEFAULT_ID_PARAMS, refMulberry32(4), { prev: 100 })).toMatchObject({
      candidate: { numId: 97 },
      rank: 0,
      rule: 'fallback',
    });
    // Strictly larger wins over an earlier smaller one.
    const mixed = explicit([101, 103, 99].map((id, i) => cand(`m${id}`, { numId: id, recency: -i })));
    expect(run(mixed, DEFAULT_ID_PARAMS, refMulberry32(4), { prev: 100 })).toMatchObject({ candidate: { numId: 103 }, rank: 1 });
  });

  it('a candidate without numId is always acceptable', () => {
    const p = explicit([cand('ided', { numId: 101, recency: 2 }), cand('plain', { recency: 1 })]);
    const draws: number[] = [];
    for (let i = 0; i <= 8; i++) draws.push(0, 0.1); // uniform, rank 0 every time
    expect(run(p, DEFAULT_ID_PARAMS, seq(...draws), { prev: 100 })).toMatchObject({ candidate: { key: 'plain' }, rule: 'scan' });
  });
});

describe('R1 hard aging', () => {
  const H = 1000;
  const params: Params = { ...DEFAULT_ID_PARAMS, ageCapMs: 500, hardCapMs: H };
  const now = 10_000;

  it('picks the oldest hard-aged item when it passes, drawing nothing', () => {
    const pool = explicit([
      cand('young', { numId: 500, recency: 9, classEnteredAtMs: now - 10 }),
      cand('old', { numId: 300, recency: 1, classEnteredAtMs: now - 5000 }),
      cand('older', { numId: 200, recency: 2, classEnteredAtMs: now - 6000 }),
    ]);
    const pick = run(pool, params, noDraws, { prev: 100 }, now);
    expect(pick).toMatchObject({ candidate: { key: 'older' }, rule: 'R1', stage: 'R1', redraws: 0 });
    expect(pick?.markSkip).toBeUndefined();
    expect(pick?.rank).toBe(1); // rank in the (tier, recency desc, key) order: young, older, old
  });

  it('dispatches a skipped oldest item that still fails: R1-forced', () => {
    const pool = explicit([
      cand('o', { numId: 101, classEnteredAtMs: now - 5000, skipped: true }),
      cand('p', { numId: 900, classEnteredAtMs: now - 4000 }),
    ]);
    expect(run(pool, params, noDraws, { prev: 100 }, now)).toMatchObject({ candidate: { key: 'o' }, rule: 'R1-forced' });
  });

  it('marks an unskipped failing oldest item and dispatches the OLDEST acceptable hard-aged item', () => {
    const pool = explicit([
      cand('o', { numId: 101, recency: 1, classEnteredAtMs: now - 9000 }),
      cand('newerOk', { numId: 900, recency: 9, classEnteredAtMs: now - 2000 }),
      cand('olderOk', { numId: 700, recency: 2, classEnteredAtMs: now - 3000 }),
      cand('tooClose', { numId: 102, recency: 3, classEnteredAtMs: now - 8000 }),
      cand('softOnly', { numId: 5000, recency: 4, classEnteredAtMs: now - 900 }),
    ]);
    const pick = run(pool, params, noDraws, { prev: 100 }, now);
    expect(pick).toMatchObject({ candidate: { key: 'olderOk' }, rule: 'R1', markSkip: 'o' });
  });

  it('dispatches the marked oldest item itself when no hard-aged item passes', () => {
    const pool = explicit([
      cand('o', { numId: 101, classEnteredAtMs: now - 9000 }),
      cand('p', { numId: 99, classEnteredAtMs: now - 8000 }),
      cand('fresh', { numId: 5000, classEnteredAtMs: now }),
    ]);
    expect(run(pool, params, noDraws, { prev: 100 }, now)).toMatchObject({ candidate: { key: 'o' }, rule: 'R1-forced', markSkip: 'o' });
  });

  it('ages at exactly hardCapMs and not a millisecond before', () => {
    const pool = explicit([cand('fresh', { numId: 5000, recency: 9 }), cand('o', { numId: 300, recency: 1, classEnteredAtMs: 0 })]);
    expect(run(pool, { ...params, ageCapMs: undefined }, noDraws, {}, H)).toMatchObject({ candidate: { key: 'o' }, rule: 'R1' });
    const notYet = run(pool, { ...params, ageCapMs: undefined }, seq(0.5, 0, 0), {}, H - 1);
    expect(notYet).toMatchObject({ candidate: { key: 'fresh' }, rule: 'R3' });
  });

  it('never ages a candidate without classEnteredAtMs', () => {
    const pool = explicit([cand('fresh', { recency: 9 }), cand('undated', { recency: 1 })]);
    expect(run(pool, params, seq(0.5, 0, 0), {}, 1e12)).toMatchObject({ candidate: { key: 'fresh' }, stage: 'R3' });
  });

  it('breaks a classEnteredAtMs tie by key, whatever the input order', () => {
    const a = cand('b-item', { numId: 300, classEnteredAtMs: 0 });
    const b = cand('a-item', { numId: 600, classEnteredAtMs: 0 });
    expect(run(explicit([a, b]), params, noDraws, {}, now)?.candidate.key).toBe('a-item');
    expect(run(explicit([b, a]), params, noDraws, {}, now)?.candidate.key).toBe('a-item');
    // The skip pick breaks its tie the same way.
    const o = cand('o', { numId: 101, classEnteredAtMs: -1 });
    expect(run(explicit([o, a, b]), params, noDraws, { prev: 100 }, now)).toMatchObject({ candidate: { key: 'a-item' }, markSkip: 'o' });
    expect(run(explicit([b, a, o]), params, noDraws, { prev: 100 }, now)).toMatchObject({ candidate: { key: 'a-item' }, markSkip: 'o' });
  });

  it('runs before R2 and R3', () => {
    const pool = explicit([
      cand('fresh', { numId: 9000, recency: 99, classEnteredAtMs: now }),
      cand('soft', { numId: 5000, recency: 50, classEnteredAtMs: now - 600 }),
      cand('hard', { numId: 1000, recency: 1, classEnteredAtMs: now - H }),
    ]);
    expect(run(pool, params, noDraws, {}, now)?.candidate.key).toBe('hard');
  });
});

describe('R2 soft aging', () => {
  const params: Params = { ...DEFAULT_ID_PARAMS, ageCapMs: 500 };
  const now = 10_000;
  // Rank order: f0 f1 (fresh) then a0 a1 a2 (aged, recency 5,4,3); age order a2 (oldest), a0, a1.
  const pool = explicit([
    cand('f0', { numId: 9000, recency: 99, classEnteredAtMs: now }),
    cand('f1', { numId: 8000, recency: 98, classEnteredAtMs: now - 100 }),
    cand('a0', { numId: 3000, recency: 5, classEnteredAtMs: now - 800 }),
    cand('a1', { numId: 2000, recency: 4, classEnteredAtMs: now - 600 }),
    cand('a2', { numId: 1000, recency: 3, classEnteredAtMs: now - 900 }),
  ]);
  const inA = (i: number) => (i + 0.5) / 3; // uniform index i into A (rank order a0, a1, a2)

  it('with probability pAged draws uniformly from the aged set (in rank order)', () => {
    for (let i = 0; i < 3; i++) {
      expect(run(pool, params, seq(0.5, inA(i)), {}, now)).toMatchObject({ candidate: { key: `a${i}` }, rule: 'R2', stage: 'R2', redraws: 0 });
    }
  });

  it('a coin equal to pAged falls through to R3', () => {
    expect(run(pool, params, seq(0.9, 0.5, 0, 0), {}, now)).toMatchObject({ candidate: { key: 'f0' }, rule: 'R3', stage: 'R3' });
    expect(run(pool, params, seq(0.8999999, inA(1)), {}, now)).toMatchObject({ candidate: { key: 'a1' }, rule: 'R2' });
  });

  it('pAged 0 never draws from the aged set; pAged 1 always does', () => {
    expect(run(pool, { ...params, pAged: 0 }, seq(0, 0.5, 0, 0), {}, now)?.stage).toBe('R3');
    expect(run(pool, { ...params, pAged: 1 }, seq(0.9999999, inA(2)), {}, now)?.candidate.key).toBe('a2');
  });

  it('redraws on an anti-sequence failure', () => {
    expect(run(pool, params, seq(0.5, inA(1), inA(0)), { prev: 2002 }, now)).toMatchObject({ candidate: { key: 'a0' }, rule: 'R2', redraws: 1 });
  });

  it('after maxRedraws failures scans the aged set oldest first', () => {
    // prev2 2950 -> prev 2990: a0 (3000) is too close; draws all hit a0. Oldest first: a2 (1000) passes.
    const draws = [0.5, ...new Array(9).fill(inA(0))];
    expect(run(pool, params, seq(...draws), { prev2: 2950, prev: 2990 }, now)).toMatchObject({
      candidate: { key: 'a2' },
      rule: 'scan',
      stage: 'R2',
      redraws: 8,
    });
  });

  it('when no aged item is acceptable, scans the whole pool in rank order (anti-sequence holds while any candidate passes)', () => {
    const tight = explicit([
      cand('f0', { numId: 9000, recency: 99, classEnteredAtMs: now }),
      cand('a0', { numId: 101, recency: 5, classEnteredAtMs: now - 800 }),
      cand('a1', { numId: 99, recency: 4, classEnteredAtMs: now - 600 }),
    ]);
    const draws = [0.5, ...new Array(9).fill(0.1)];
    expect(run(tight, params, seq(...draws), { prev: 100 }, now)).toMatchObject({ candidate: { key: 'f0' }, rule: 'scan', stage: 'R2' });
  });

  it('when nothing in the pool is acceptable, falls back to the largest |id - prev| in the aged set, ties to the oldest', () => {
    const none = explicit([
      cand('f0', { numId: 100, recency: 99, classEnteredAtMs: now }),
      cand('a0', { numId: 102, recency: 5, classEnteredAtMs: now - 800 }),
      cand('a1', { numId: 98, recency: 4, classEnteredAtMs: now - 900 }),
      cand('a2', { numId: 101, recency: 3, classEnteredAtMs: now - 950 }),
    ]);
    const draws = [0.5, ...new Array(9).fill(0.1)];
    // a0 and a1 tie at distance 2; a1 is older.
    expect(run(none, params, seq(...draws), { prev: 100 }, now)).toMatchObject({ candidate: { key: 'a1' }, rule: 'fallback', stage: 'R2' });
    // A strictly larger distance wins over an older smaller one.
    const far = explicit([
      cand('a0', { numId: 103, recency: 5, classEnteredAtMs: now - 800 }),
      cand('a1', { numId: 99, recency: 4, classEnteredAtMs: now - 900 }),
    ]);
    expect(run(far, params, seq(...[0.5, ...new Array(9).fill(0.1)]), { prev: 100 }, now)).toMatchObject({ candidate: { key: 'a0' }, rule: 'fallback' });
  });

  it('ages at exactly ageCapMs; undated candidates are never aged', () => {
    const edge = explicit([
      cand('fresh', { numId: 9000, recency: 9, classEnteredAtMs: now }),
      cand('edge', { numId: 1000, recency: 1, classEnteredAtMs: now - 500 }),
      cand('undated', { numId: 5000, recency: 0 }),
    ]);
    expect(run(edge, params, seq(0.5, 0.5), {}, now)).toMatchObject({ candidate: { key: 'edge' }, rule: 'R2' });
    expect(run(edge, params, seq(0.5, 0, 0), {}, now - 1)).toMatchObject({ candidate: { key: 'fresh' }, stage: 'R3' });
  });

  it('works with only a hard cap set when nothing is hard-aged yet (R2 needs ageCapMs)', () => {
    const hardOnly: Params = { ...DEFAULT_ID_PARAMS, hardCapMs: 5000 };
    expect(run(pool, hardOnly, seq(0.5, 0, 0), {}, now)).toMatchObject({ candidate: { key: 'f0' }, stage: 'R3' });
  });
});

describe('implicit pools', () => {
  it('picks from 120k id ranges without materialising them', () => {
    const n = 120_000;
    const top = 400_000;
    let calls = 0;
    const seen = new Set<number>();
    const rankToCandidate = (rank: number): Candidate => {
      calls++;
      if (!Number.isInteger(rank) || rank < 0 || rank >= n) throw new Error(`rank ${rank} out of range`);
      seen.add(rank);
      const id = top - rank;
      return { key: String(id), tier: 0, recency: id, numId: id };
    };
    const rng = mulberry32(77);
    let history: History = {};
    const picks = 2000;
    for (let i = 0; i < picks; i++) {
      const p = select({ kind: 'implicit', n, rankToCandidate }, DEFAULT_ID_PARAMS, { rng, nowMs: 0, history });
      expect(p).not.toBeNull();
      history = { prev: p!.candidate.numId, prev2: history.prev };
    }
    // Each pick costs at most maxRedraws + 1 lookups unless it scans; nothing near n per pick.
    expect(calls).toBeLessThanOrEqual(picks * (DEFAULT_ID_PARAMS.maxRedraws + 1));
    expect(calls).toBeGreaterThanOrEqual(picks);
    expect(seen.size).toBeLessThan(picks * 2);
  });

  it('scans lazily: stops at the first acceptable rank', () => {
    const rankToCandidate = jest.fn((rank: number): Candidate => ({ key: `r${rank}`, tier: 0, recency: -rank, numId: 100 + rank }));
    const draws: number[] = [];
    for (let i = 0; i <= 8; i++) draws.push(0, 0); // uniform draw of rank 0 (id 100, too close)
    const p = select({ kind: 'implicit', n: 1_000_000, rankToCandidate }, DEFAULT_ID_PARAMS, { rng: seq(...draws), nowMs: 0, history: { prev: 101 } });
    // Ranks 0..4 (ids 100..104) are within 3 of 101; rank 5 (id 105) passes.
    expect(p).toMatchObject({ rank: 5, rule: 'scan', candidate: { key: 'r5' } });
    expect(rankToCandidate).toHaveBeenCalledTimes(9 + 6);
  });

  it('falls back over the whole implicit pool when nothing passes', () => {
    const rankToCandidate = (rank: number): Candidate => ({ key: `r${rank}`, tier: 0, recency: -rank, numId: 99 + rank });
    const p = select({ kind: 'implicit', n: 5, rankToCandidate }, DEFAULT_ID_PARAMS, { rng: refMulberry32(8), nowMs: 0, history: { prev: 101 } });
    // ids 99..103, prev 101: all within 3; largest distance 2 at ids 99 (rank 0) and 103 (rank 4).
    expect(p).toMatchObject({ rank: 0, rule: 'fallback', candidate: { numId: 99 } });
  });
});

describe('determinism', () => {
  function sequenceOf(seed: number, picks: number): string[] {
    const pool: Candidate[] = Array.from({ length: 300 }, (_, i) => cand(`k${String(i).padStart(4, '0')}`, { numId: 1000 + i, recency: i, classEnteredAtMs: i * 10 }));
    const params: Params = { ...DEFAULT_ID_PARAMS, ageCapMs: 2000, hardCapMs: 2900 };
    const rng = deriveStream(seed, 'myfigurecollection.net', 'pick');
    let history: History = {};
    const out: string[] = [];
    for (let i = 0; i < picks; i++) {
      const p = select({ kind: 'explicit', candidates: pool }, params, { rng, nowMs: i, history });
      out.push(p === null ? 'null' : `${p.candidate.key}:${p.rule}:${p.redraws}`);
      if (p !== null) history = { prev: p.candidate.numId, prev2: history.prev };
    }
    return out;
  }

  it('the same seed gives the identical pick sequence; another seed does not', () => {
    const a = sequenceOf(12345, 5000);
    expect(sequenceOf(12345, 5000)).toEqual(a);
    expect(a).not.toContain('null');
    expect(new Set(a.map((s) => s.split(':')[0])).size).toBeGreaterThan(200);
    expect(sequenceOf(12346, 5000)).not.toEqual(a);
  });
});

describe('anti-sequence guarantee: zero violations on R2/R3 picks while an acceptable candidate exists', () => {
  /** Counts picks (not R1) that break anti-sequence although some pool member passes. */
  function drainTrials(opts: {
    seed: number;
    trials: number;
    build: (trial: number, gen: Rng) => Candidate[];
    params: Params;
    resetHistory: boolean;
    nowFor?: (step: number) => number;
  }) {
    const gen = refMulberry32(opts.seed ^ 0x9e3779b9);
    const rng = deriveStream(opts.seed, 'antiseq');
    const rules: Record<string, number> = {};
    let violations = 0;
    let picks = 0;
    let noneAcceptable = 0;
    let broken = 0;
    let history: History = {};
    const { minIdDistance, runStep } = opts.params;
    for (let trial = 0; trial < opts.trials && broken === 0; trial++) {
      const pool = opts.build(trial, gen).sort(refRankCmp);
      if (opts.resetHistory) history = {};
      for (let step = 0; pool.length > 0; step++) {
        const p = select({ kind: 'explicit', candidates: pool }, opts.params, { rng, nowMs: opts.nowFor ? opts.nowFor(step) : 0, history });
        if (p === null || pool[p.rank] !== p.candidate) {
          broken++; // null, or not the pool member at the returned rank
          break;
        }
        rules[p.rule] = (rules[p.rule] ?? 0) + 1;
        picks++;
        if (p.stage !== 'R1' && !antiSeqOk(p.candidate.numId, history.prev, history.prev2, minIdDistance, runStep)) {
          if (pool.some((c) => antiSeqOk(c.numId, history.prev, history.prev2, minIdDistance, runStep))) violations++;
          else noneAcceptable++;
        }
        history = { prev: p.candidate.numId, prev2: history.prev };
        pool.splice(p.rank, 1);
      }
    }
    return { violations, picks, rules, noneAcceptable, broken };
  }

  it('contiguous 200-id pool (antiseq.py), with aging so R2 picks occur: 20 seeds x 400k picks', () => {
    const params: Params = { ...DEFAULT_ID_PARAMS, ageCapMs: 150 };
    const total: Record<string, number> = {};
    let violations = 0;
    let picks = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const r = drainTrials({
        seed,
        trials: 2000,
        params,
        resetHistory: true,
        // ids 1000..1199, recency = id (top bucket = the 25 highest, contiguous); entry times spread
        // over 200 ms so the aged set fills as the trial runs (now = 100 + step).
        build: (_t, gen) => Array.from({ length: 200 }, (_, i) => cand(`i${1000 + i}`, { numId: 1000 + i, recency: 1000 + i, classEnteredAtMs: Math.floor(gen() * 200) })),
        nowFor: (step) => 100 + step,
      });
      expect(r.broken).toBe(0);
      violations += r.violations;
      picks += r.picks;
      for (const [k, v] of Object.entries(r.rules)) total[k] = (total[k] ?? 0) + v;
    }
    expect(picks).toBe(20 * 400_000);
    expect(violations).toBe(0);
    expect(total.R2).toBeGreaterThan(100_000);
    expect(total.R3).toBeGreaterThan(100_000);
    expect(total.uniform).toBeGreaterThan(10_000);
    expect(total.scan).toBeGreaterThan(0);
  }, 300_000);

  it('5-page pool c..c+4 with DEFAULT_PAGE_PARAMS: 20 seeds x 400k picks, history carried across passes', () => {
    let violations = 0;
    let picks = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const r = drainTrials({
        seed,
        trials: 80_000,
        params: DEFAULT_PAGE_PARAMS,
        resetHistory: false,
        build: (trial) => Array.from({ length: 5 }, (_, i) => {
          const page = 2 + trial * 5 + i;
          return cand(`p${page}`, { numId: page, recency: -page });
        }),
      });
      expect(r.broken).toBe(0);
      violations += r.violations;
      picks += r.picks;
    }
    expect(picks).toBe(20 * 400_000);
    expect(violations).toBe(0);
  }, 300_000);

  it('for 5 pages c..c+4 an acceptable full order exists: c+2, c, c+4, c+1, c+3', () => {
    for (const c of [1, 2, 7, 100]) {
      const order = [c + 2, c, c + 4, c + 1, c + 3];
      let history: History = {};
      for (const page of order) {
        expect(passesAntiSequence(page, history, DEFAULT_PAGE_PARAMS)).toBe(true);
        expect(antiSeqOk(page, history.prev, history.prev2, 1, Infinity)).toBe(true);
        history = { prev: page, prev2: history.prev };
      }
    }
  });
});
