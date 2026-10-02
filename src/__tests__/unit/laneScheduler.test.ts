/**
 * LaneScheduler (QB-U2): weighted fair queueing by stride scheduling across the work classes of one
 * host, plus the SCRAPE_LANE_MODE / SCRAPE_LANE_WEIGHTS parsing. Self-contained: no I/O, no queue.
 *
 * The properties are exercised over many weight sets drawn from a SEEDED generator, so every run
 * sees the same cases and a failure names the seed and weights that broke it.
 */

import { logger } from '../../utils/logger';
import {
  LANE_CLASSES,
  LaneScheduler,
  laneClassOf,
  laneShares,
  laneWeightsForHost,
  parseLaneMode,
  parseLaneWeights,
  resolveLaneConfig,
  targetLaneShares,
  type LaneClass,
  type LaneWeights,
} from '../../services/laneScheduler';

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

/** mulberry32: a tiny deterministic PRNG, so the "random" cases are the same on every run. */
const prng = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const W = (n: number, company: number, gap: number, other: number): LaneWeights => ({
  new: n,
  company,
  gap,
  other,
});

const DEFAULT = W(40, 40, 20, 10);
const ALL: LaneClass[] = [...LANE_CLASSES];

const zeroCounts = (): Record<LaneClass, number> => ({ new: 0, company: 0, gap: 0, other: 0 });

/** One dispatch: pick among `active`, charge the pick. */
const step = (s: LaneScheduler, active: Iterable<LaneClass>): LaneClass | undefined => {
  const c = s.pick(active);
  if (c !== undefined) s.charge(c);
  return c;
};

const run = (s: LaneScheduler, active: LaneClass[], n: number): Record<LaneClass, number> => {
  const counts = zeroCounts();
  for (let i = 0; i < n; i++) {
    const c = step(s, active);
    if (c !== undefined) counts[c]++;
  }
  return counts;
};

const sumOver = (w: LaneWeights, classes: readonly LaneClass[]): number =>
  classes.reduce((acc, c) => acc + w[c], 0);

/** Integer weights 0..100 with at least two positive classes (so there is a split to measure). */
const randomWeights = (rand: () => number): LaneWeights => {
  for (;;) {
    const w = W(
      Math.floor(rand() * 101),
      Math.floor(rand() * 101),
      Math.floor(rand() * 101),
      Math.floor(rand() * 101),
    );
    if (LANE_CLASSES.filter((c) => w[c] > 0).length >= 2) return w;
  }
};

const WEIGHT_SETS: LaneWeights[] = (() => {
  const rand = prng(20260929);
  const sets: LaneWeights[] = [
    DEFAULT,
    W(40, 40, 20, 0),
    W(1, 1, 1, 1),
    W(100, 1, 1, 1),
    W(97, 89, 83, 79), // coprime-ish: the least common multiple is large
    W(3, 0, 7, 0),
  ];
  while (sets.length < 60) sets.push(randomWeights(rand));
  return sets;
})();

const label = (w: LaneWeights): string => `${w.new}/${w.company}/${w.gap}/${w.other}`;

// ---------------------------------------------------------------------------------------------
// scheduling properties
// ---------------------------------------------------------------------------------------------

describe('LaneScheduler: backlogged shares', () => {
  it.each(WEIGHT_SETS.map((w) => [label(w), w] as const))(
    '10,000 picks with every class backlogged land within 0.5 percentage points of %s',
    (_name, w) => {
      const s = new LaneScheduler(w);
      const counts = run(s, ALL, 10_000);
      const total = sumOver(w, LANE_CLASSES);
      for (const c of LANE_CLASSES) {
        expect(Math.abs(counts[c] / 10_000 - w[c] / total)).toBeLessThanOrEqual(0.005);
      }
    },
  );

  it('serves the default weights as the exact 4:4:2:1 cycle, starting with every class once', () => {
    const s = new LaneScheduler(DEFAULT);
    const first = Array.from({ length: 22 }, () => step(s, ALL));
    expect(first.slice(0, 11)).toEqual([
      'new', 'company', 'gap', 'other', 'new', 'company', 'new', 'company', 'gap', 'new', 'company',
    ]);
    // the second cycle repeats the first: the passes are back where they started
    expect(first.slice(11)).toEqual(first.slice(0, 11));
  });
});

describe('LaneScheduler: work conservation', () => {
  it('never returns a class without work, and always returns one when any class has work', () => {
    const rand = prng(7);
    for (const w of WEIGHT_SETS) {
      const s = new LaneScheduler(w);
      for (let i = 0; i < 2_000; i++) {
        const active = LANE_CLASSES.filter(() => rand() < 0.5);
        const c = step(s, active);
        if (active.length === 0) expect(c).toBeUndefined();
        else expect(active).toContain(c);
      }
    }
  });

  it('a pick alone charges nothing: repeated picks without a charge return the same class', () => {
    const s = new LaneScheduler(DEFAULT);
    run(s, ALL, 37);
    const first = s.pick(ALL);
    for (let i = 0; i < 10; i++) expect(s.pick(ALL)).toBe(first);
  });

  it('counts a name outside the vocabulary as other, so no work is ever invisible', () => {
    expect(laneClassOf('gap')).toBe('gap');
    expect(laneClassOf('GAP')).toBe('other');
    expect(laneClassOf('bogus')).toBe('other');
    expect(laneClassOf(null)).toBe('other');
    expect(laneClassOf(undefined)).toBe('other');
    const s = new LaneScheduler(DEFAULT);
    expect(s.pick(['bogus' as LaneClass])).toBe('other');
    expect(s.charge('bogus' as LaneClass)).toEqual({ cls: 'other', otherIdle: false });
    expect(s.tally().all.other).toBe(1);
  });

  it("hands an emptied class's share to the others in proportion, within 50 picks", () => {
    const rand = prng(50);
    for (const w of WEIGHT_SETS) {
      for (const gone of LANE_CLASSES) {
        const rest = ALL.filter((c) => c !== gone);
        const restTotal = sumOver(w, rest);
        if (w[gone] === 0 || restTotal === 0) continue;
        const s = new LaneScheduler(w);
        run(s, ALL, 1_000 + Math.floor(rand() * 200)); // an arbitrary phase of the cycle
        const counts = run(s, rest, 50);
        expect(counts[gone]).toBe(0);
        for (const c of rest) {
          // Stride scheduling's error is at most one pick per class, and the other classes' errors
          // can shift a class's share of a fixed window by at most one more pick.
          const expected = (50 * w[c]) / restTotal;
          expect({ w: label(w), gone, c, off: Math.abs(counts[c] - expected) <= 2 }).toEqual({
            w: label(w),
            gone,
            c,
            off: true,
          });
        }
      }
    }
  });
});

describe('LaneScheduler: a returning class gets no saved-up burst', () => {
  it('while every other class keeps its work through the absence, counted from its return it gets at most its weight share plus 1 in the first n picks, for every n', () => {
    const rand = prng(1);
    for (const w of WEIGHT_SETS) {
      for (const back of LANE_CLASSES) {
        if (w[back] === 0) continue;
        const others = ALL.filter((c) => c !== back);
        if (sumOver(w, others) === 0) continue;
        const s = new LaneScheduler(w);
        run(s, ALL, Math.floor(rand() * 300));
        run(s, others, 500); // `back` is empty for 500 picks: a naive stride would owe it all of them
        const total = sumOver(w, LANE_CLASSES);
        let got = 0;
        for (let n = 1; n <= 300; n++) {
          if (step(s, ALL) === back) got++;
          const share = (n * w[back]) / total;
          expect({ w: label(w), back, n, ok: got <= share + 1 }).toEqual({
            w: label(w),
            back,
            n,
            ok: true,
          });
        }
        // and it is not punished either: after 300 picks it has its share, give or take 2
        expect(got).toBeGreaterThanOrEqual((300 * w[back]) / total - 2);
      }
    }
  });

  /** The most `back` gets above its weight share in any of the first 300 picks after `history`, all backlogged. */
  const firstNExcess = (s: LaneScheduler, w: LaneWeights, back: LaneClass): number => {
    const share = w[back] / sumOver(w, LANE_CLASSES);
    let got = 0;
    let worst = -Infinity;
    for (let n = 1; n <= 300; n++) {
      if (step(s, ALL) === back) got++;
      worst = Math.max(worst, got - n * share);
    }
    return worst;
  };

  it('the bound needs only every other class to have work on the pick before the return: what they did earlier does not matter', () => {
    // Why it holds for every history: each pick the returning class takes needs its pass to be the
    // lowest, and it starts at or above the weight-averaged pass of the others (they all kept their
    // work into the return, so the virtual time averages all of them). Adding up, by weight, how far
    // the others' passes must have moved gives at most share * (n - 1) + 1 picks in the first n.
    // Here the others come and go at random through the history and the absence, except on its
    // last pick, where all of them have work.
    const rand = prng(2);
    for (let t = 0; t < 400; t++) {
      const w = t % 4 === 0 ? DEFAULT : randomWeights(rand);
      const back = LANE_CLASSES[Math.floor(rand() * 4)];
      if (w[back] === 0 || sumOver(w, ALL.filter((c) => c !== back)) === 0) continue;
      const s = new LaneScheduler(w);
      const hist = Math.floor(rand() * 300);
      const absent = 1 + Math.floor(rand() * (rand() < 0.5 ? 20 : 300));
      for (let i = 0; i < hist + absent; i++) {
        const last = i === hist + absent - 1;
        step(s, LANE_CLASSES.filter((c) => (c === back ? i < hist && rand() < 0.75 : last || rand() < 0.6)));
      }
      expect({ t, w: label(w), back, ok: firstNExcess(s, w, back) <= 1 }).toEqual({ t, w: label(w), back, ok: true });
    }
  });

  it.each([
    [W(16, 88, 5, 85), 'company', [['new', 'gap', 'other'], ['new', 'gap', 'other'], ['other']], 1.1546],
    [W(72, 6, 74, 78), 'gap', [['company', 'other'], ['new', 'other'], []], 1.0957],
    [W(97, 89, 32, 41), 'company', [['new', 'gap', 'other'], ['new', 'gap'], ['new', 'other'], []], 1.0541],
    [DEFAULT, 'new', [['gap', 'other'], ['company', 'other'], []], 1.3636],
    [W(100, 1, 1, 1), 'new', [['new', 'other'], ['new', 'gap', 'other'], ['new', 'company', 'gap'], ['new', 'company'], []], 2.9126],
  ] as Array<[LaneWeights, LaneClass, LaneClass[][], number]>)(
    'when another class comes back with it, share plus 1 can be exceeded (a pinned construction, not a ceiling): %j %s',
    (w, back, history, excess) => {
      // Each history ends on a pick where some other class had no work, so that class comes back
      // WITH the returning one, carrying stride debt from earlier; the returning class runs ahead of
      // it while it pays that debt off. No ceiling is proven for this case: these pin what short
      // histories reach today (5 picks at 100/1/1/1 reach share + 2.91).
      const s = new LaneScheduler(w);
      for (const active of history) step(s, active);
      expect(firstNExcess(s, w, back)).toBeCloseTo(excess, 4);
    },
  );

  it('a seeded sample of random histories, pinned as a regression check and not a bound: worst under share plus 2, under share plus 3 with charges the pick did not choose', () => {
    // Every class's presence is random before and during the absence, so other classes often come
    // back with the returning one; the absence lasts 1 to 600 picks. The second variant charges a
    // random class instead of the pick on 1 pick in 5. The constructions above show that other
    // histories read more than this sample does.
    for (const offPick of [false, true]) {
      const rand = prng(offPick ? 778 : 777);
      let worst = -Infinity;
      for (let t = 0; t < 1_000; t++) {
        const w = t % 4 === 0 ? DEFAULT : randomWeights(rand);
        const back = LANE_CLASSES[Math.floor(rand() * 4)];
        if (w[back] === 0 || sumOver(w, ALL.filter((c) => c !== back)) === 0) continue;
        const s = new LaneScheduler(w);
        const hist = Math.floor(rand() * 400);
        const absent = 1 + Math.floor(rand() * (rand() < 0.5 ? 20 : 600));
        for (let i = 0; i < hist + absent; i++) {
          const active = LANE_CLASSES.filter((c) => rand() < 0.75 && (i < hist || c !== back));
          const c = s.pick(active);
          if (offPick && rand() < 0.2) s.charge(LANE_CLASSES[Math.floor(rand() * 4)]);
          else if (c !== undefined) s.charge(c);
        }
        worst = Math.max(worst, firstNExcess(s, w, back));
      }
      expect({ offPick, under: worst < (offPick ? 3 : 2) }).toEqual({ offPick, under: true });
    }
  });

  it('a class that was ahead when it emptied does not jump the queue on return', () => {
    const s = new LaneScheduler(W(1, 1, 0, 0));
    // new is picked (tie on order), then company is backlogged alone for a long time
    expect(step(s, ['new', 'company'])).toBe('new');
    run(s, ['company'], 100);
    // new comes back: it shares the host 1:1 from here, never 100 in a row
    const back = run(s, ['new', 'company'], 20);
    expect(back).toEqual({ ...zeroCounts(), new: 10, company: 10 });
  });
});

/** Run each phase of `n` dispatches with the given classes having work; the picks, undefined = none had work. */
const script = (s: LaneScheduler, ...phases: Array<[number, LaneClass[]]>): Array<LaneClass | undefined> =>
  phases.flatMap(([n, active]) => Array.from({ length: n }, () => step(s, active)));

const NCG: LaneClass[] = ['new', 'company', 'gap'];

// Hand-derived pick sequences for scripted presence patterns. They pin the re-entry and normalize
// rules exactly: a rule that forgives a debt, raises a returning class above the others' level,
// hands an idle class credit, or loses a debt when every class is empty changes at least one pick.
describe('LaneScheduler: golden pick sequences', () => {
  it.each([
    [1, ['new'], ['company', 'new', 'company', 'new', 'company', 'new', 'company', 'gap', 'new']],
    [3, ['new', 'company', 'new'], ['company', 'new', 'company', 'new', 'company', 'gap', 'new', 'company', 'new']],
  ] as const)(
    'a debt is not forgiven: gap, charged and then empty for %i pick(s), waits until the others catch up',
    (gone, whileGone, after) => {
      // 4/4/1: strides 1/4, 1/4 and 1 of the span. Just after its pick gap is 3/4 of a span ahead;
      // it comes back at max(its own pass, the others' weighted average), so it keeps that debt.
      const s = new LaneScheduler(W(4, 4, 1, 0));
      expect(script(s, [3, NCG], [gone, ['new', 'company']], [9, NCG])).toEqual([
        'new', 'company', 'gap', ...whileGone, ...after,
      ]);
    },
  );

  it('a class that comes back while the others are level re-enters level with them (the order breaks the tie)', () => {
    const s = new LaneScheduler(W(1, 1, 1, 0));
    // company and gap take one pick each and are level again; new then arrives and ties them
    expect(script(s, [2, ['company', 'gap']], [3, NCG])).toEqual(['company', 'gap', 'new', 'company', 'gap']);
  });

  it.each([W(1, 1, 1, 0), W(2, 1, 1, 0), DEFAULT])(
    "the virtual time averages only the classes that kept their work, never the returning class's own pass (%j)",
    (w) => {
      // new is picked, then sits out one pick while company (which kept its work) is charged. The
      // virtual time is company's pass alone, so new comes back level with company and wins the tie.
      // Folding new's own pass into the average would put it behind company.
      const s = new LaneScheduler(w);
      expect(script(s, [1, ['new', 'company']], [1, ['company', 'gap']], [1, ['new', 'company']])).toEqual([
        'new', 'company', 'new',
      ]);
    },
  );

  it('a class that comes back beside ONE class that kept its work, as another leaves, re-enters level with it', () => {
    // 40/40/20/10: company is charged beside gap; then gap leaves as new comes back. company alone
    // kept its work, so the virtual time is company's pass: new re-enters level with company, wins
    // the tie by order, and the two alternate. Left at its old pass, new would take two in a row.
    const s = new LaneScheduler(DEFAULT);
    expect(script(s, [1, ['company', 'gap']], [4, ['new', 'company']])).toEqual([
      'company', 'new', 'company', 'new', 'company',
    ]);
  });

  it('no saved-up burst beside a single class that kept its work: at 100/1/100/0 the returning class takes 1 pick, not 101', () => {
    // company (weight 1) is charged beside gap, so it is a whole span ahead; then gap leaves as new
    // (weight 100) comes back. new re-enters at company's pass, takes one pick, and company is next.
    // Left at its old pass, new would take 101 picks before company got one.
    const s = new LaneScheduler(W(100, 1, 100, 0));
    expect(script(s, [1, ['company', 'gap']], [3, ['new', 'company']])).toEqual(['company', 'new', 'company', 'new']);
  });

  it('ties go to new, company, gap, other whatever order the caller lists the classes in', () => {
    const permutations = (xs: readonly LaneClass[]): LaneClass[][] =>
      xs.length <= 1 ? [[...xs]] : xs.flatMap((x, i) => permutations(xs.filter((_, j) => j !== i)).map((p) => [x, ...p]));
    const orders = permutations(LANE_CLASSES);
    expect(orders).toHaveLength(24);
    for (const order of orders) {
      const s = new LaneScheduler(W(1, 1, 1, 1));
      expect(script(s, [8, order])).toEqual([...ALL, ...ALL]);
    }
    expect(new LaneScheduler(DEFAULT).pick(['gap', 'company', 'new'])).toBe('new');
  });

  it('a class that sat idle while the others ran earns no credit when every class returns together', () => {
    const s = new LaneScheduler(W(1, 1, 1, 0));
    script(s, [10, ['company', 'gap']]); // new idle for 10 picks: a burst of 5 would be "owed" without the lift
    expect(script(s, [1, []], [6, NCG])).toEqual([undefined, 'new', 'company', 'gap', 'new', 'company', 'gap']);
  });

  it('a debt survives a moment when every class is empty', () => {
    const s = new LaneScheduler(W(1, 1, 1, 0));
    // new took its turn while all three had work; nobody has work for a pick; all three come back
    expect(script(s, [1, NCG], [1, []], [6, NCG])).toEqual([
      'new', undefined, 'company', 'gap', 'new', 'company', 'gap', 'new',
    ]);
  });

  it('a class served while it was alone owes nothing when the others return', () => {
    const s = new LaneScheduler(W(1, 1, 1, 0));
    // work-conserving: new used a slot nobody else wanted, so it is not behind when they come back
    expect(script(s, [1, ['new']], [1, []], [6, NCG])).toEqual([
      'new', undefined, 'new', 'company', 'gap', 'new', 'company', 'gap',
    ]);
  });

  it('a charge the pick did not choose moves the charged class, not the picked one', () => {
    const s = new LaneScheduler(W(1, 1, 1, 0));
    expect(s.pick(NCG)).toBe('new');
    s.charge('gap'); // the dispatch sent a gap item: gap waits a round, new is still first
    expect(script(s, [5, NCG])).toEqual(['new', 'company', 'new', 'company', 'gap']);
  });

  it('passes are whole numbers: a class that comes back beside a single class is exactly level with it', () => {
    // 4/4/1/10. Step 2: company comes back at the weighted average of new (a stride ahead) and other
    // (0), which rounds up to a whole unit; other is lowest. Step 3: gap comes back beside other
    // alone, so its virtual time is exactly other's pass and the order (gap first) breaks the tie.
    // With fractional passes, 10 * pass / 10 carries a float error here and hands the pick to other.
    const s = new LaneScheduler(W(4, 4, 1, 10));
    expect(script(s, [1, ['new', 'gap', 'other']], [1, ['new', 'company', 'other']], [1, ['gap', 'other']])).toEqual([
      'new', 'other', 'gap',
    ]);
  });

  it('the virtual time rounds up, so a returning class never lands below the exact average', () => {
    // 1/1/1/1: gap (step 2) and company (step 6) each come back at an average a third of a unit
    // past a whole number. Rounded up, company sits one unit behind new at step 7. Always rounded
    // down, company comes back ahead of new and takes step 7. Rounding to the nearest unit is not
    // ruled out here (its first rounding shifts the later averages and the picks agree); the next
    // case rules it out.
    const s = new LaneScheduler(W(1, 1, 1, 1));
    expect(script(s, [1, ['new', 'company', 'other']], [1, ALL], [2, NCG], [1, ['new', 'gap', 'other']], [2, ALL])).toEqual([
      'new', 'company', 'gap', 'new', 'gap', 'other', 'new',
    ]);
  });

  it('a third of a unit is rounded up too, not to the nearest unit', () => {
    // 3/1/1/1: new's stride is a third of the others'. At step 5 new comes back beside company, gap
    // and other at an average a third of a unit past a whole number. Rounded up, new sits one unit
    // behind gap after other's pick, so gap takes step 6; rounded to the nearest unit (down, for a
    // third) or always down, new ties gap and wins step 6 by order.
    const s = new LaneScheduler(W(3, 1, 1, 1));
    expect(script(s, [1, ALL], [1, ['new', 'gap']], [1, ALL], [1, ['company', 'gap', 'other']], [2, ALL])).toEqual([
      'new', 'gap', 'new', 'company', 'other', 'gap',
    ]);
  });

  it('serves 97/89/83/79 as an exact cycle: every 348 picks hold exactly 97/89/83/79, and the cycle repeats', () => {
    // pairwise coprime weights: the least common multiple is their product, 56,606,581, and every
    // stride is a whole number, so the passes are level again after each cycle
    const s = new LaneScheduler(W(97, 89, 83, 79));
    const first = script(s, [348, ALL]);
    const count = (seq: Array<LaneClass | undefined>, c: LaneClass): number => seq.filter((x) => x === c).length;
    expect(LANE_CLASSES.map((c) => count(first, c))).toEqual([97, 89, 83, 79]);
    for (let cycle = 0; cycle < 3; cycle++) expect(script(s, [348, ALL])).toEqual(first);
  });
});

/**
 * `back` has work on every pick except those `leftOut` names; the other classes of `base` are
 * backlogged. Returns what `back` got over what it should have got on the picks where it had work.
 */
const flickerRatio = (
  w: LaneWeights,
  back: LaneClass,
  leftOut: (n: number) => boolean,
  picks = 22_000,
  base: readonly LaneClass[] = ALL,
): number => {
  const s = new LaneScheduler(w);
  let got = 0;
  let fair = 0;
  for (let n = 0; n < picks; n++) {
    const active = leftOut(n) ? base.filter((c) => c !== back) : [...base];
    fair += targetLaneShares(w, active, 'all')[back] ?? 0;
    if (step(s, active) === back) got++;
  }
  return got / fair;
};

/** Left out on 1 pick in `k`. */
const oneIn = (k: number) => (n: number): boolean => n % k === 0;

describe('LaneScheduler: a class reported empty for single picks', () => {
  it.each(LANE_CLASSES.flatMap((c) => [3, 4, 5, 10].map((k) => [c, k] as const)))(
    'at 40/40/20/10, %s reported empty on 1 pick in %i still gets at least 3/4 of its fair share',
    (back, k) => {
      expect(flickerRatio(DEFAULT, back, oneIn(k))).toBeGreaterThanOrEqual(0.75);
    },
  );

  // The filler tier has its own scaled span: at a bare span of 1 a unit is a whole stride, and the
  // last filler in the order (other) then gets nothing when it is left out 1 pick in 3 or 4.
  it.each((['company', 'gap', 'other'] as const).flatMap((c) => [3, 4, 10].map((k) => [c, k] as const)))(
    'at 5/0/0/0 with new empty, the weight-0 filler %s reported empty on 1 pick in %i still gets at least 3/4 of its fair share',
    (back, k) => {
      const fillers: LaneClass[] = ['company', 'gap', 'other'];
      expect(flickerRatio(W(5, 0, 0, 0), back, oneIn(k), 22_000, fillers)).toBeGreaterThanOrEqual(0.75);
    },
  );

  it('the hazard the queue wiring must avoid: a class left out of withWork while it has work can get nothing', () => {
    // It re-enters at the others' average, never below the lowest pass, so it keeps losing its place.
    // These pin TODAY's re-entry rule: a rule that removes the hazard turns them red, and should then
    // replace them with the service it gives.
    for (const back of ['company', 'gap', 'other'] as const) expect(flickerRatio(DEFAULT, back, oneIn(2), 2_200)).toBe(0);
    expect(flickerRatio(W(1, 1, 1, 1), 'gap', oneIn(3), 2_200)).toBe(0);
    expect(flickerRatio(W(100, 1, 1, 1), 'new', oneIn(3), 2_200)).toBe(0); // even the heaviest class
    // not only 1 pick in k: other repeated omission patterns can do it too
    const twoInThree = (n: number): boolean => n % 3 < 2;
    const twoInFive = (n: number): boolean => n % 5 < 2;
    for (const back of ['company', 'gap'] as const) expect(flickerRatio(DEFAULT, back, twoInThree, 2_200)).toBe(0);
    expect(flickerRatio(DEFAULT, 'other', twoInFive)).toBeLessThan(0.02); // under 2 % of its share
  });
});

describe('LaneScheduler: weight 0', () => {
  it('a weight-0 class is never served while any positive-weight class has work', () => {
    const s = new LaneScheduler(W(40, 40, 20, 0));
    const counts = run(s, ALL, 10_000);
    expect(counts.other).toBe(0);
    const rand = prng(3);
    for (let i = 0; i < 5_000; i++) {
      const active = LANE_CLASSES.filter(() => rand() < 0.5);
      const c = step(s, active);
      if (active.some((a) => a !== 'other')) expect(c).not.toBe('other');
    }
  });

  it('a weight-0 class is served when every other class is empty', () => {
    const s = new LaneScheduler(W(40, 40, 20, 0));
    run(s, ALL, 100);
    expect(run(s, ['other'], 5)).toEqual({ ...zeroCounts(), other: 5 });
  });

  it('a positive class that comes back takes the slot from the weight-0 filler at once', () => {
    const s = new LaneScheduler(W(40, 40, 20, 0));
    run(s, ['other'], 50);
    expect(step(s, ['other', 'gap'])).toBe('gap');
  });

  it('several weight-0 classes alone share the slot evenly', () => {
    const s = new LaneScheduler(W(5, 0, 0, 0));
    expect(run(s, ['company', 'gap', 'other'], 30)).toEqual({ new: 0, company: 10, gap: 10, other: 10 });
  });

  it('serving a weight-0 filler does not disturb the positive classes when they return', () => {
    const s = new LaneScheduler(W(40, 40, 20, 0));
    run(s, ['other'], 1_000);
    const counts = run(s, ALL, 1_000);
    expect(counts).toEqual({ new: 400, company: 400, gap: 200, other: 0 });
  });

  it("a charge to a name outside the vocabulary moves other's pass in other's own tier, also when other is a weight-0 filler", () => {
    const s = new LaneScheduler(W(40, 0, 0, 0)); // company, gap and other are all fillers
    expect(s.pick(['company', 'gap', 'other'])).toBe('company');
    expect(s.charge('bogus' as LaneClass)).toEqual({ cls: 'other', otherIdle: false });
    // other, not company, took that turn: company and gap go next, then the three are level again
    expect(script(s, [3, ['company', 'gap', 'other']])).toEqual(['company', 'gap', 'company']);
  });
});

describe('LaneScheduler: determinism', () => {
  it('two schedulers fed the same sequence make the same picks', () => {
    const feed = (s: LaneScheduler, seed: number): Array<LaneClass | undefined> => {
      const rand = prng(seed);
      const out: Array<LaneClass | undefined> = [];
      for (let i = 0; i < 5_000; i++) {
        const active = LANE_CLASSES.filter(() => rand() < 0.6);
        const c = s.pick(active);
        out.push(c);
        const r = rand();
        if (c !== undefined && r < 0.9) s.charge(c); // charged dispatch
        else if (r > 0.97) s.charge(LANE_CLASSES[Math.floor(rand() * 4)]); // a charge the pick did not choose
        // else: a pick that cost no network request (cooldown fast-fail) is not charged
      }
      return out;
    };
    for (const w of WEIGHT_SETS.slice(0, 10)) {
      expect(feed(new LaneScheduler(w), 11)).toEqual(feed(new LaneScheduler(w), 11));
    }
  });
});

describe('LaneScheduler: constructor', () => {
  it.each([
    ['a negative weight', W(-1, 40, 20, 10)],
    ['a fractional weight', W(2.5, 40, 20, 10)],
    ['a weight above 100', W(101, 40, 20, 10)],
    ['a NaN weight', W(Number.NaN, 40, 20, 10)],
    ['no positive weight', W(0, 0, 0, 0)],
  ])('rejects %s', (_name, w) => {
    expect(() => new LaneScheduler(w)).toThrow(RangeError);
  });

  it('rejects a weights object missing a class', () => {
    expect(() => new LaneScheduler({ new: 1, company: 1, gap: 1 } as unknown as LaneWeights)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------------------------
// share measurement: the review's 'other' note
// ---------------------------------------------------------------------------------------------

describe('share bases: Ross\'s three classes only while other has no work', () => {
  const twoPhases = (): LaneScheduler => {
    const s = new LaneScheduler(DEFAULT);
    run(s, ['new', 'company', 'gap'], 5_500); // other idle
    run(s, ALL, 5_500); // other backlogged: 40/40/20/10 = 36.4/36.4/18.2/9.1
    return s;
  };

  it('the ross-three basis reads 40/40/20 even though other had work for half the picks', () => {
    const s = twoPhases();
    const shares = s.shares('ross-three');
    expect(Object.keys(shares).sort()).toEqual(['company', 'gap', 'new']);
    expect(shares.new).toBeCloseTo(0.4, 2);
    expect(shares.company).toBeCloseTo(0.4, 2);
    expect(shares.gap).toBeCloseTo(0.2, 2);
  });

  it('the ross-three basis leaves out every pick made while other had work, even ones that change the mix', () => {
    const s = new LaneScheduler(DEFAULT);
    run(s, ['new', 'company', 'gap'], 5_500); // other idle: 2200/2200/1100
    run(s, ['new', 'other'], 5_000); // other busy, company and gap dry: new 4000, other 1000
    const shares = s.shares('ross-three');
    expect(shares.new).toBeCloseTo(0.4, 2); // not (2200 + 4000) / 9500
    expect(shares.company).toBeCloseTo(0.4, 2);
    expect(shares.gap).toBeCloseTo(0.2, 2);
  });

  it('the all basis mixes both phases, which is why a 40/40/20 target must not be read from it', () => {
    const s = twoPhases();
    const shares = s.shares(); // default basis: all four classes, every charged pick
    expect(shares.new).toBeCloseTo((2_200 + 2_000) / 11_000, 2);
    expect(shares.other).toBeCloseTo(500 / 11_000, 2);
    expect(Math.abs((shares.new ?? 0) - 0.4)).toBeGreaterThan(0.01);
  });

  it('the tally counts every charge, and separately the charges made while other had no work', () => {
    const s = twoPhases();
    const t = s.tally();
    expect(LANE_CLASSES.reduce((a, c) => a + t.all[c], 0)).toBe(11_000);
    expect(LANE_CLASSES.reduce((a, c) => a + t.whileOtherIdle[c], 0)).toBe(5_500);
    // a copy: mutating it does not reach the scheduler
    t.all.new = -1;
    expect(s.tally().all.new).toBeGreaterThan(0);
  });

  it('charge reports whether other had work, so a caller can bucket the same split itself', () => {
    const s = new LaneScheduler(DEFAULT);
    s.pick(['new']);
    expect(s.charge('new')).toEqual({ cls: 'new', otherIdle: true });
    s.pick(['new', 'other']);
    expect(s.charge('new')).toEqual({ cls: 'new', otherIdle: false });
  });

  it('once other goes idle again, charges count as made while other was idle again', () => {
    const s = new LaneScheduler(DEFAULT);
    s.pick(['new', 'other']);
    expect(s.charge('new')).toEqual({ cls: 'new', otherIdle: false });
    s.pick(['new']);
    expect(s.charge('new')).toEqual({ cls: 'new', otherIdle: true });
    expect(s.tally().whileOtherIdle.new).toBe(1);
  });

  it('after a backlog of other drains, the ross-three basis counts every later pick and reads 40/40/20', () => {
    // At deploy, rows queued before lanes existed count as other and drain during the shadow period.
    const s = new LaneScheduler(DEFAULT);
    run(s, ALL, 1_100); // the backlog: other has work
    run(s, NCG, 5_500); // drained: other idle from here on
    const t = s.tally();
    expect(t.all.other).toBe(100);
    expect(LANE_CLASSES.reduce((a, c) => a + t.whileOtherIdle[c], 0)).toBe(5_500);
    const shares = s.shares('ross-three');
    expect(shares.new).toBeCloseTo(0.4, 2);
    expect(shares.company).toBeCloseTo(0.4, 2);
    expect(shares.gap).toBeCloseTo(0.2, 2);
  });

  it('a charge to other itself is never counted as made while other was idle', () => {
    const s = new LaneScheduler(DEFAULT);
    s.pick(['new']); // a stale set: other had work after all, since it was dispatched
    expect(s.charge('other')).toEqual({ cls: 'other', otherIdle: false });
    expect(s.charge('bogus' as LaneClass)).toEqual({ cls: 'other', otherIdle: false });
    expect(s.tally().whileOtherIdle.other).toBe(0);
    expect(s.tally().all.other).toBe(2);
  });

  it('a weight-0 other with work blanks the ross-three basis too, although it takes no share', () => {
    const s = new LaneScheduler(W(40, 40, 20, 0));
    const counts = run(s, ALL, 1_000); // other has work on every pick, but only as a filler
    expect(counts.other).toBe(0);
    expect(LANE_CLASSES.reduce((a, c) => a + s.tally().whileOtherIdle[c], 0)).toBe(0);
    expect(s.shares('ross-three')).toEqual({ new: 0, company: 0, gap: 0 });
  });

  it('before any pick, a charge assumes other is idle (the basis comes from the last pick)', () => {
    expect(new LaneScheduler(DEFAULT).charge('new')).toEqual({ cls: 'new', otherIdle: true });
  });

  it('laneShares of an empty tally is all zeros, never NaN', () => {
    const s = new LaneScheduler(DEFAULT);
    expect(laneShares(s.tally(), 'all')).toEqual({ new: 0, company: 0, gap: 0, other: 0 });
    expect(laneShares(s.tally(), 'ross-three')).toEqual({ new: 0, company: 0, gap: 0 });
  });

  it('targetLaneShares gives the share each class with work should get, on either basis', () => {
    expect(targetLaneShares(DEFAULT, ALL, 'all')).toEqual({
      new: 40 / 110, company: 40 / 110, gap: 20 / 110, other: 10 / 110,
    });
    expect(targetLaneShares(DEFAULT, ALL, 'ross-three')).toEqual({ new: 0.4, company: 0.4, gap: 0.2 });
    // company dry: its share goes to the others in proportion
    expect(targetLaneShares(DEFAULT, ['new', 'gap', 'other'], 'all')).toEqual({
      new: 40 / 70, company: 0, gap: 20 / 70, other: 10 / 70,
    });
    expect(targetLaneShares(DEFAULT, ['new', 'gap'], 'ross-three')).toEqual({ new: 2 / 3, company: 0, gap: 1 / 3 });
    // only weight-0 classes have work: they split the slot evenly
    expect(targetLaneShares(W(40, 0, 0, 0), ['company', 'gap'], 'all')).toEqual({
      new: 0, company: 0.5, gap: 0.5, other: 0,
    });
    // a weight-0 class beside a positive one gets nothing
    expect(targetLaneShares(W(40, 0, 20, 0), ['new', 'company'], 'all')).toEqual({
      new: 1, company: 0, gap: 0, other: 0,
    });
    // nothing has work
    expect(targetLaneShares(DEFAULT, [], 'ross-three')).toEqual({ new: 0, company: 0, gap: 0 });
  });

  it('targetLaneShares counts a name outside the vocabulary as other, as pick does', () => {
    expect(targetLaneShares(DEFAULT, ['bogus' as LaneClass], 'all')).toEqual({ new: 0, company: 0, gap: 0, other: 1 });
    expect(targetLaneShares(DEFAULT, ['new', 'bogus' as LaneClass], 'all')).toEqual({
      new: 40 / 50, company: 0, gap: 0, other: 10 / 50,
    });
    expect(targetLaneShares(DEFAULT, ['bogus' as LaneClass], 'ross-three')).toEqual({ new: 0, company: 0, gap: 0 });
  });

  it('measured shares match the target over classes that had work', () => {
    const s = new LaneScheduler(DEFAULT);
    run(s, ['new', 'gap', 'other'], 7_000);
    const target = targetLaneShares(DEFAULT, ['new', 'gap', 'other'], 'all');
    const got = s.shares('all');
    for (const c of LANE_CLASSES) expect(Math.abs((got[c] ?? 0) - (target[c] ?? 0))).toBeLessThanOrEqual(0.01);
  });

  it('targetLaneShares is no benchmark while the classes with work change pick by pick: a repeating pattern drifts 17.5 points', () => {
    // At 40/40/20/10 each class has work on 2 picks of every 4, in a fixed rotation. A class that
    // leaves before it is served loses its place (see the flicker hazard above): new takes both of
    // its picks in every 4 and other none, far from the per-pick targets summed over the run.
    const pattern: LaneClass[][] = [['gap', 'other'], ['company', 'gap'], ['new', 'company'], ['new', 'other']];
    const s = new LaneScheduler(DEFAULT);
    const target = zeroCounts();
    const picks: Array<LaneClass | undefined> = [];
    for (let n = 0; n < 4_000; n++) {
      const active = pattern[n % 4];
      const t = targetLaneShares(DEFAULT, active, 'all');
      for (const c of LANE_CLASSES) target[c] += t[c] ?? 0;
      picks.push(step(s, active));
    }
    expect(picks.slice(0, 8)).toEqual(['gap', 'company', 'new', 'new', 'gap', 'company', 'new', 'new']);
    expect(s.tally().all).toEqual({ new: 2_000, company: 1_000, gap: 1_000, other: 0 });
    const got = s.shares('all');
    expect((got.new ?? 0) - target.new / 4_000).toBeCloseTo(0.175, 6);
    expect((got.other ?? 0) - target.other / 4_000).toBeCloseTo(-0.4 / 3, 6);
  });
});

// ---------------------------------------------------------------------------------------------
// env parsing
// ---------------------------------------------------------------------------------------------

describe('parseLaneMode', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  it.each([
    [undefined, 'off'],
    ['', 'off'],
    ['   ', 'off'],
  ])('unset or blank (%p) is off, silently', (raw, mode) => {
    expect(parseLaneMode(raw)).toBe(mode);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ['off', 'off'],
    ['shadow', 'shadow'],
    ['on', 'on'],
    [' Shadow ', 'shadow'],
    ['ON', 'on'],
  ])('%p is %p', (raw, mode) => {
    expect(parseLaneMode(raw)).toBe(mode);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(['yes', '1', 'true', 'on,shadow', 'enabled'])('%p is refused with a WARN and falls back to off', (raw) => {
    expect(parseLaneMode(raw)).toBe('off');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('SCRAPE_LANE_MODE');
    expect(warn.mock.calls[0][1]).toEqual({ value: raw });
  });
});

describe('parseLaneWeights', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  const MFC = 'myfigurecollection.net';

  it.each([undefined, '', '   ', ' ; ;; '])('unset or empty (%p) declares no host, silently', (raw) => {
    expect(parseLaneWeights(raw).size).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it("parses Ross's example", () => {
    const hosts = parseLaneWeights('myfigurecollection.net=new:40,company:40,gap:20,other:10');
    expect([...hosts.keys()]).toEqual([MFC]);
    expect(hosts.get(MFC)).toEqual(DEFAULT);
    expect(warn).not.toHaveBeenCalled();
  });

  it('takes several hosts separated by ";", normalizes the host, and tolerates spaces and case', () => {
    const hosts = parseLaneWeights(' WWW.MyFigureCollection.net = NEW:40 , Company:40, gap:20 ; example.org=gap:1 ;');
    expect(hosts.get(MFC)).toEqual(W(40, 40, 20, 0));
    expect(hosts.get('example.org')).toEqual(W(0, 0, 1, 0));
    expect(warn).not.toHaveBeenCalled();
  });

  it('tolerates spaces on either side of the colon', () => {
    expect(parseLaneWeights('a.example=new : 40, company: 40 ,gap :20').get('a.example')).toEqual(W(40, 40, 20, 0));
    expect(warn).not.toHaveBeenCalled();
  });

  it('a class left out gets weight 0 (served only when every other class is empty)', () => {
    expect(parseLaneWeights(`${MFC}=new:40,company:40,gap:20`).get(MFC)).toEqual(W(40, 40, 20, 0));
  });

  it('accepts 0 and 100 and leading zeros', () => {
    expect(parseLaneWeights(`${MFC}=new:100,company:0,gap:007`).get(MFC)).toEqual(W(100, 0, 7, 0));
  });

  it('accepts a 63-character host label and skips empty class:weight pairs', () => {
    const host = `${'a'.repeat(63)}.example`;
    expect(parseLaneWeights(`${host}=new:40,,gap:20,`).get(host)).toEqual(W(40, 0, 20, 0));
    expect(warn).not.toHaveBeenCalled();
  });

  it('accepts a single-label host such as localhost', () => {
    expect(parseLaneWeights('localhost=new:1').get('localhost')).toEqual(W(1, 0, 0, 0));
    expect(warn).not.toHaveBeenCalled();
  });

  // Every refused entry names the guard that refused it, so each row proves the guard in its title.
  const NO_EQ = 'it has no "="';
  const NOT_PLAIN = 'the text before "=" is not a plain host name';
  const NOT_READ = "so it is not read as any host's entry and changes no host's dispatch";
  const EXPECTED = 'expected host=class:weight,...';
  const KEEPS_TODAY = "that host keeps today's dispatch";
  const REPLACES = 'names a host twice; this entry replaces the earlier one';
  const WEIGHT = (c: LaneClass): string => `weight for ${c} must be a whole number 0-100`;
  const UNKNOWN = (c: string): string => `unknown class "${c}" (expected new|company|gap|other)`;
  const NO_WEIGHT = (pair: string): string => `"${pair}" has no weight (expected class:weight)`;

  it.each([
    ['no "="', 'myfigurecollection.net:new:40', NO_EQ, EXPECTED],
    ['no "=", only the name of the good host itself', 'good.example', NO_EQ, EXPECTED],
    ['an empty host', '=new:40', NOT_PLAIN, 'not a plain host name'],
    ['a url, not a host', 'https://myfigurecollection.net=new:40', NOT_PLAIN, 'not a plain host name'],
    ['a host with a path', 'myfigurecollection.net/x=new:40', NOT_PLAIN, 'not a plain host name'],
    ['a host with a port', 'a.example:443=new:1', NOT_PLAIN, 'not a plain host name'],
    ['a host with a bad label', '-bad-.net=new:40', NOT_PLAIN, 'not a plain host name'],
    ['a label that starts with a hyphen', '-bad.example=new:1', NOT_PLAIN, 'not a plain host name'],
    ['a label that ends with a hyphen', 'bad-.example=new:1', NOT_PLAIN, 'not a plain host name'],
    ['a trailing dot', 'a.example.=new:1', NOT_PLAIN, 'not a plain host name'],
    ['a host label over 63 characters', `${'a'.repeat(64)}.example=new:40`, NOT_PLAIN, 'not a plain host name'],
    ['an underscore in the host', 'a_b.example=new:40', NOT_PLAIN, 'not a plain host name'],
  ])('drops an entry with %s, with a WARN that it is no host\'s entry and so changes none; the good hosts still apply', (_name, bad, guard, reason) => {
    const hosts = parseLaneWeights(`${bad};good.example=new:1,gap:1`);
    expect([...hosts.keys()]).toEqual(['good.example']);
    expect(hosts.get('good.example')).toEqual(W(1, 0, 1, 0));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('SCRAPE_LANE_WEIGHTS');
    expect(warn.mock.calls[0][0]).toContain(`${guard}, ${NOT_READ}`);
    expect(warn.mock.calls[0][1]).toEqual({ entry: bad, reason });
  });

  it.each([
    ['an unknown class', 'new:40,bogus:10', UNKNOWN('bogus')],
    ['a class named twice', 'new:40,new:20', 'class "new" is named twice'],
    ['a letter in the weight', 'new:4O', WEIGHT('new')],
    ['a negative weight', 'new:-5', WEIGHT('new')],
    ['a fractional weight', 'new:2.5', WEIGHT('new')],
    ['an exponent', 'new:1e2', WEIGHT('new')],
    ['a hex weight', 'new:0x10', WEIGHT('new')],
    ['a plus sign', 'new:+40', WEIGHT('new')],
    ['a weight above 100', 'new:101', WEIGHT('new')],
    ['a huge weight', 'new:99999999999999999999', WEIGHT('new')],
    ['a class without a weight', 'new', NO_WEIGHT('new')],
    ['a class without a weight beside a good pair', 'new:40,gap', NO_WEIGHT('gap')],
    ['an empty weight', 'new:', WEIGHT('new')],
    ['an empty weight beside a good pair', 'new:40,gap:', WEIGHT('gap')],
    ['an empty class', ':40', UNKNOWN('')],
    ['a stray colon in a weight', 'new:4:0', WEIGHT('new')],
    ['a stray "=" in the class list', 'new:1=2', WEIGHT('new')],
    ['every weight 0', 'new:0,company:0', 'no class has a positive weight'],
    ['no classes at all', '', 'no class has a positive weight'],
  ])('drops an entry with %s, with a WARN naming it and why, and keeps the good hosts', (_name, spec, reason) => {
    const bad = `a.example=${spec}`;
    const hosts = parseLaneWeights(`${bad};good.example=new:1,gap:1`);
    expect([...hosts.keys()]).toEqual(['good.example']);
    expect(hosts.get('good.example')).toEqual(W(1, 0, 1, 0));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('SCRAPE_LANE_WEIGHTS');
    expect(warn.mock.calls[0][0]).toContain(KEEPS_TODAY);
    expect(warn.mock.calls[0][1]).toEqual({ entry: bad, host: 'a.example', reason });
  });

  it('strips www. only as the first label of the host, and only once', () => {
    expect([...parseLaneWeights('shop.www.example=new:1;wwwexample.org=gap:1;www.www.example=new:1').keys()]).toEqual([
      'shop.www.example',
      'wwwexample.org',
      'www.example',
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a host named twice in well-formed entries keeps the last one, with a WARN', () => {
    const hosts = parseLaneWeights(`${MFC}=new:1;www.${MFC}=gap:3`);
    expect(hosts.get(MFC)).toEqual(W(0, 0, 3, 0));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('SCRAPE_LANE_WEIGHTS');
    expect(warn.mock.calls[0][0]).toContain(REPLACES);
    expect(warn.mock.calls[0][1]).toEqual({ host: MFC });
  });

  // A host is laned by one whole entry or not at all: one malformed entry for it unlanes it, in any order.
  const GOOD = `${MFC}=new:40,company:40,gap:20,other:10`;
  const TYPO = `${MFC}=new:40,company:4O,gap:20`;

  it.each([
    ['a good entry, then a malformed one', [GOOD, TYPO]],
    ['a good entry, then a malformed one written with www.', [GOOD, `www.${TYPO}`]],
    ['a malformed entry, then a good one', [TYPO, GOOD]],
    ['a malformed entry between two good ones', [GOOD, TYPO, GOOD]],
    ['a malformed entry written with www., then a good one', [`www.${TYPO}`, GOOD]],
  ])('a host with %s is unlaned, as its WARN says, and the other hosts still apply', (_name, entries) => {
    const hosts = parseLaneWeights([...entries, 'good.example=gap:1'].join(';'));
    expect([...hosts.keys()]).toEqual(['good.example']);
    const texts = warn.mock.calls.map((call) => String(call[0]));
    expect(texts.filter((t) => t.includes(KEEPS_TODAY))).toHaveLength(1);
    expect(texts.some((t) => t.includes('names a host twice'))).toBe(false);
  });

  it('a host named twice and then refused: the replace WARN is true when given, and the refusal unlanes the host', () => {
    expect(parseLaneWeights(`${GOOD};${MFC}=new:1;${TYPO}`).has(MFC)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toContain(REPLACES);
    expect(warn.mock.calls[0][1]).toEqual({ host: MFC });
    expect(warn.mock.calls[1][0]).toContain(`${KEEPS_TODAY}, whatever its other entries say`);
    expect(warn.mock.calls[1][1]).toEqual({ entry: TYPO, host: MFC, reason: WEIGHT('company') });
  });

  it('a malformed entry after a good one for the same host drops the good one too, with one WARN', () => {
    expect(parseLaneWeights(`${GOOD};${TYPO}`).has(MFC)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toEqual({ entry: TYPO, host: MFC, reason: WEIGHT('company') });
  });

  it('a good entry after a malformed one for the same host is ignored too, with a WARN naming it', () => {
    expect(parseLaneWeights(`${TYPO};www.${GOOD}`).has(MFC)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toContain(KEEPS_TODAY);
    expect(warn.mock.calls[0][1]).toEqual({ entry: TYPO, host: MFC, reason: WEIGHT('company') });
    expect(warn.mock.calls[1][0]).toContain('SCRAPE_LANE_WEIGHTS');
    expect(warn.mock.calls[1][0]).toContain('an earlier entry for that host was refused');
    expect(warn.mock.calls[1][1]).toEqual({ entry: `www.${GOOD}`, host: MFC });
  });

  it('a second malformed entry for a refused host gets the refused-host WARN, not a second refusal', () => {
    const typo2 = `${MFC}=gap:x`;
    expect(parseLaneWeights(`${TYPO};${typo2}`).has(MFC)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1][0]).toContain('an earlier entry for that host was refused');
    expect(warn.mock.calls[1][1]).toEqual({ entry: typo2, host: MFC });
  });

  it('an entry that names no host cannot unlane one: a good entry for the host it meant still applies', () => {
    const hosts = parseLaneWeights(`${MFC}:new:40;https://${MFC}=new:1;${GOOD}`);
    expect(hosts.get(MFC)).toEqual(DEFAULT);
    expect(warn).toHaveBeenCalledTimes(2);
    for (const call of warn.mock.calls) expect(call[0]).toContain(NOT_READ);
  });

  it.each([
    ['before', MFC, [MFC, GOOD]],
    ['after', MFC, [GOOD, MFC]],
    ['written with www. and capitals, before', `WWW.MyFigureCollection.NET`, [`WWW.MyFigureCollection.NET`, GOOD]],
  ])('a bare host name with no "=" %s a good entry for that host cannot unlane it, with one WARN saying it is no host\'s entry', (_where, bare, entries) => {
    const hosts = parseLaneWeights(entries.join(';'));
    expect([...hosts.keys()]).toEqual([MFC]);
    expect(hosts.get(MFC)).toEqual(DEFAULT);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(`${NO_EQ}, ${NOT_READ}`);
    expect(warn.mock.calls[0][1]).toEqual({ entry: bare, reason: EXPECTED });
  });

  it('the parsed weights are frozen', () => {
    const w = parseLaneWeights(`${MFC}=new:1`).get(MFC) as Record<string, number>;
    expect(Object.isFrozen(w)).toBe(true);
  });
});

describe('resolveLaneConfig / laneWeightsForHost: fail-safe', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  const MFC = 'myfigurecollection.net';
  const WEIGHTS = `${MFC}=new:40,company:40,gap:20,other:10`;

  it('defaults to off with no hosts when nothing is set', () => {
    const cfg = resolveLaneConfig({});
    expect(cfg.mode).toBe('off');
    expect(cfg.hosts.size).toBe(0);
    expect(laneWeightsForHost(cfg, MFC)).toBeUndefined();
  });

  it('reads the process env when no env is passed', () => {
    const saved = { mode: process.env.SCRAPE_LANE_MODE, weights: process.env.SCRAPE_LANE_WEIGHTS };
    process.env.SCRAPE_LANE_MODE = 'shadow';
    process.env.SCRAPE_LANE_WEIGHTS = WEIGHTS;
    try {
      const cfg = resolveLaneConfig();
      expect(cfg.mode).toBe('shadow');
      expect(laneWeightsForHost(cfg, MFC)).toEqual(DEFAULT);
    } finally {
      if (saved.mode === undefined) delete process.env.SCRAPE_LANE_MODE;
      else process.env.SCRAPE_LANE_MODE = saved.mode;
      if (saved.weights === undefined) delete process.env.SCRAPE_LANE_WEIGHTS;
      else process.env.SCRAPE_LANE_WEIGHTS = saved.weights;
    }
  });

  it('mode off lanes no host, even with weights declared', () => {
    const cfg = resolveLaneConfig({ SCRAPE_LANE_MODE: 'off', SCRAPE_LANE_WEIGHTS: WEIGHTS });
    expect(cfg.hosts.get(MFC)).toEqual(DEFAULT);
    expect(laneWeightsForHost(cfg, MFC)).toBeUndefined();
  });

  it.each(['shadow', 'on'])('mode %s lanes a declared host, matched the way the queue keys hosts', (mode) => {
    const cfg = resolveLaneConfig({ SCRAPE_LANE_MODE: mode, SCRAPE_LANE_WEIGHTS: WEIGHTS });
    expect(laneWeightsForHost(cfg, MFC)).toEqual(DEFAULT);
    expect(laneWeightsForHost(cfg, 'WWW.MyFigureCollection.net')).toEqual(DEFAULT);
    expect(laneWeightsForHost(cfg, 'static.myfigurecollection.net')).toBeUndefined();
  });

  it('a malformed mode is off: the host keeps today\'s dispatch, never a faster one', () => {
    const cfg = resolveLaneConfig({ SCRAPE_LANE_MODE: 'turbo', SCRAPE_LANE_WEIGHTS: WEIGHTS });
    expect(cfg.mode).toBe('off');
    expect(laneWeightsForHost(cfg, MFC)).toBeUndefined();
  });

  it('a malformed weights entry leaves its host unlaned (today\'s dispatch), never half-configured', () => {
    const cfg = resolveLaneConfig({ SCRAPE_LANE_MODE: 'on', SCRAPE_LANE_WEIGHTS: `${MFC}=new:40,company:4O,gap:20` });
    expect(laneWeightsForHost(cfg, MFC)).toBeUndefined();
  });

  it.each([
    ['after', `${WEIGHTS};${MFC}=new:40,company:4O,gap:20`],
    ['before', `${MFC}=new:40,company:4O,gap:20;${WEIGHTS}`],
  ])('a malformed entry %s a good one for the same host leaves the host unlaned, as its WARN says', (_where, weights) => {
    const cfg = resolveLaneConfig({ SCRAPE_LANE_MODE: 'on', SCRAPE_LANE_WEIGHTS: weights });
    expect(warn.mock.calls[0][0]).toContain("that host keeps today's dispatch");
    expect(laneWeightsForHost(cfg, MFC)).toBeUndefined();
  });

  it('every weight set the parser accepts builds a scheduler that never deadlocks', () => {
    const rand = prng(99);
    for (let i = 0; i < 300; i++) {
      const parts = LANE_CLASSES.filter(() => rand() < 0.7).map((c) => `${c}:${Math.floor(rand() * 3) * 50}`);
      const w = parseLaneWeights(`h.example=${parts.join(',')}`).get('h.example');
      if (w === undefined) continue; // dropped: the host stays unlaned
      const s = new LaneScheduler(w);
      for (let k = 0; k < 50; k++) {
        const active = LANE_CLASSES.filter(() => rand() < 0.5);
        const c = step(s, active);
        if (active.length > 0) expect(active).toContain(c);
      }
    }
  });
});
