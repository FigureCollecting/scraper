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
    '10,000 picks with every class backlogged land within 1 percentage point of %s',
    (_name, w) => {
      const s = new LaneScheduler(w);
      const counts = run(s, ALL, 10_000);
      const total = sumOver(w, LANE_CLASSES);
      for (const c of LANE_CLASSES) {
        expect(Math.abs(counts[c] / 10_000 - w[c] / total)).toBeLessThanOrEqual(0.01);
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

  it('ignores a class name it does not know', () => {
    const s = new LaneScheduler(DEFAULT);
    expect(s.pick(['bogus' as LaneClass])).toBeUndefined();
    expect(s.pick(['bogus' as LaneClass, 'gap'])).toBe('gap');
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
  it('after being empty it gets at most its weight share plus 1 in every window after it returns', () => {
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
        else if (r > 0.97) s.charge(LANE_CLASSES[Math.floor(rand() * 4)]); // a charge the pick did not choose (shadow)
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

  it('measured shares match the target over classes that had work', () => {
    const s = new LaneScheduler(DEFAULT);
    run(s, ['new', 'gap', 'other'], 7_000);
    const target = targetLaneShares(DEFAULT, ['new', 'gap', 'other'], 'all');
    const got = s.shares('all');
    for (const c of LANE_CLASSES) expect(Math.abs((got[c] ?? 0) - (target[c] ?? 0))).toBeLessThanOrEqual(0.01);
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

  it('a class left out gets weight 0 (served only when every other class is empty)', () => {
    expect(parseLaneWeights(`${MFC}=new:40,company:40,gap:20`).get(MFC)).toEqual(W(40, 40, 20, 0));
  });

  it('accepts 0 and 100 and leading zeros', () => {
    expect(parseLaneWeights(`${MFC}=new:100,company:0,gap:007`).get(MFC)).toEqual(W(100, 0, 7, 0));
  });

  it.each([
    ['no "="', 'myfigurecollection.net:new:40'],
    ['an empty host', '=new:40'],
    ['a url, not a host', 'https://myfigurecollection.net=new:40'],
    ['a host with a path', 'myfigurecollection.net/x=new:40'],
    ['a host with a bad label', '-bad-.net=new:40'],
    ['an unknown class', 'a.example=new:40,bogus:10'],
    ['a class named twice', 'a.example=new:40,new:20'],
    ['a letter in the weight', 'a.example=new:4O'],
    ['a negative weight', 'a.example=new:-5'],
    ['a fractional weight', 'a.example=new:2.5'],
    ['an exponent', 'a.example=new:1e2'],
    ['a hex weight', 'a.example=new:0x10'],
    ['a weight above 100', 'a.example=new:101'],
    ['a huge weight', 'a.example=new:99999999999999999999'],
    ['a class without a weight', 'a.example=new'],
    ['an empty weight', 'a.example=new:'],
    ['an empty class', 'a.example=:40'],
    ['every weight 0', 'a.example=new:0,company:0'],
    ['no classes at all', 'a.example='],
  ])('drops an entry with %s, with a WARN naming it, and keeps the good hosts', (_name, bad) => {
    const hosts = parseLaneWeights(`${bad};good.example=new:1,gap:1`);
    expect([...hosts.keys()]).toEqual(['good.example']);
    expect(hosts.get('good.example')).toEqual(W(1, 0, 1, 0));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('SCRAPE_LANE_WEIGHTS');
    expect(warn.mock.calls[0][1]).toEqual(expect.objectContaining({ entry: bad.trim() }));
  });

  it('a host named twice keeps the last entry, with a WARN', () => {
    const hosts = parseLaneWeights(`${MFC}=new:1;www.${MFC}=gap:3`);
    expect(hosts.get(MFC)).toEqual(W(0, 0, 3, 0));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('SCRAPE_LANE_WEIGHTS');
    expect(warn.mock.calls[0][1]).toEqual({ host: MFC });
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
