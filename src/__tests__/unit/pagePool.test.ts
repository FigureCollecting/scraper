/**
 * QB-U24 — the backfill page pool's pure parts (src/crawler/pagePool.ts) and its three crawler knobs.
 *
 * The pool keeps `ledger.recent.pagePool = {visited: [[from, to, at], ...]}`: the pages ABOVE the cursor a
 * cut-short pass fully attempted, each mark expiring after CRAWLER_PAGE_POOL_VISITED_TTL_H. A pass's page
 * set is the L lowest unvisited pages at or above the cursor (none above a known or candidate end), and
 * POOL-SELECT orders it: lower page = more recent, never two adjacent pages in a row, no monotone 3-run
 * while an order without one exists. Pure: no clock, no I/O.
 */
import { addDrift, dropExposedMarks, isLedgerPage, lowestUnvisited, MAX_LEDGER_PAGE, MAX_MARK_SPAN, nextPage, passPageSet, readVisited, writeVisited } from '../../crawler/pagePool';
import { deriveStream, mulberry32, passesAntiSequence, DEFAULT_PAGE_PARAMS, type History } from '../../services/poolSelect';
import { loadCrawlerConfig } from '../../crawler/config';
import { logger } from '../../utils/logger';

const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.parse('2026-10-07T04:00:00.000Z');
const ago = (h: number): string => new Date(NOW - h * HOUR_MS).toISOString();
const TTL = 72 * HOUR_MS;

/** Order a whole set the way the crawler does: one nextPage per fetch, the history carried along. */
const orderOf = (set: number[], seed: number): number[] => {
  const rng = mulberry32(seed);
  const remaining = [...set];
  const out: number[] = [];
  let history: History = {};
  while (remaining.length > 0) {
    const p = nextPage(remaining, history, rng, NOW);
    out.push(p);
    remaining.splice(remaining.indexOf(p), 1);
    history = { prev: p, prev2: history.prev };
  }
  return out;
};

/** Steps that break anti-sequence: an adjacent pair, or a strictly monotone triple. */
const violations = (order: number[]): number => {
  let n = 0;
  for (let i = 1; i < order.length; i++) {
    if (!passesAntiSequence(order[i], { prev: order[i - 1], prev2: order[i - 2] }, DEFAULT_PAGE_PARAMS)) n++;
  }
  return n;
};

describe('readVisited', () => {
  it('no pool yet: nothing visited, not malformed', () => {
    expect(readVisited(undefined, 10, NOW, TTL)).toEqual({ visited: new Map(), drift: { ids: 0, pageSize: 0 }, malformed: false });
  });

  it('keeps the pages at or above the cursor of every live mark, with the mark time', () => {
    const { visited, malformed } = readVisited({ visited: [[12, 13, ago(1)], [15, 15, ago(2)]] }, 10, NOW, TTL);
    expect(malformed).toBe(false);
    expect([...visited.entries()]).toEqual([
      [12, NOW - HOUR_MS],
      [13, NOW - HOUR_MS],
      [15, NOW - 2 * HOUR_MS],
    ]);
  });

  it('drops the pages below the cursor (an older build walked past them)', () => {
    const { visited } = readVisited({ visited: [[8, 11, ago(1)]] }, 10, NOW, TTL);
    expect([...visited.keys()]).toEqual([10, 11]);
  });

  it('a mark expires once it is TTL old (listing drift has moved its items)', () => {
    expect([...readVisited({ visited: [[12, 12, ago(72)]] }, 10, NOW, TTL).visited.keys()]).toEqual([]);
    expect([...readVisited({ visited: [[12, 12, new Date(NOW - TTL + 1).toISOString()]] }, 10, NOW, TTL).visited.keys()]).toEqual([12]);
  });

  it('an unreadable mark time counts as expired, not malformed', () => {
    expect(readVisited({ visited: [[12, 12, 'yesterday']] }, 10, NOW, TTL)).toEqual({ visited: new Map(), drift: { ids: 0, pageSize: 0 }, malformed: false });
  });

  it.each([
    ['not an object', 'x'],
    ['null', null],
    ['an array', [[12, 12, ago(1)]]],
    ['no visited list', {}],
    ['visited not a list', { visited: 'x' }],
    ['a mark that is not a triple', { visited: [[12, 12]] }],
    ['a mark with a fourth element', { visited: [[12, 12, ago(1), 'x']] }],
    ['a page that is not a positive integer', { visited: [[0, 3, ago(1)]] }],
    ['a fractional page', { visited: [[2.5, 3, ago(1)]] }],
    ['to below from', { visited: [[5, 4, ago(1)]] }],
    ['a mark time that is not a string', { visited: [[5, 5, 7]] }],
    ['a mark wider than the span cap', { visited: [[5, 5 + MAX_MARK_SPAN, ago(1)]] }],
    ['drift not an object', { visited: [], drift: 3 }],
    ['drift null', { visited: [], drift: null }],
    ['drift ids missing', { visited: [], drift: { pageSize: 10 } }],
    ['drift ids negative', { visited: [], drift: { ids: -1, pageSize: 10 } }],
    ['drift ids fractional', { visited: [], drift: { ids: 1.5, pageSize: 10 } }],
    ['drift ids a string', { visited: [], drift: { ids: '3', pageSize: 10 } }],
    ['drift page size missing', { visited: [], drift: { ids: 3 } }],
    ['drift page size negative', { visited: [], drift: { ids: 3, pageSize: -10 } }],
  ])('malformed (%s): ignored whole, flagged for a WARN', (_label, raw) => {
    expect(readVisited(raw, 1, NOW, TTL)).toEqual({ visited: new Map(), drift: { ids: 0, pageSize: 0 }, malformed: true });
  });

  it('reads the pending drift beside the marks; zero counts are well formed', () => {
    expect(readVisited({ visited: [[12, 12, ago(1)]], drift: { ids: 15, pageSize: 10 } }, 10, NOW, TTL)).toEqual({
      visited: new Map([[12, NOW - HOUR_MS]]),
      drift: { ids: 15, pageSize: 10 },
      malformed: false,
    });
    expect(readVisited({ visited: [], drift: { ids: 0, pageSize: 0 } }, 10, NOW, TTL).malformed).toBe(false);
  });

  it('a mark exactly the span cap wide is accepted', () => {
    const { visited, malformed } = readVisited({ visited: [[5, 4 + MAX_MARK_SPAN, ago(1)]] }, 1, NOW, TTL);
    expect(malformed).toBe(false);
    expect(visited.size).toBe(MAX_MARK_SPAN);
  });
});

describe('lowestUnvisited / passPageSet', () => {
  const v = (...pages: number[]) => new Map(pages.map((p) => [p, NOW]));

  it('the cursor itself when it is unvisited', () => {
    expect(lowestUnvisited(10, v(11, 12))).toBe(10);
  });

  it('skips a visited run above the cursor', () => {
    expect(lowestUnvisited(10, v(10, 11, 12, 14))).toBe(13);
  });

  it('the L lowest unvisited pages at or above the cursor, ascending', () => {
    expect(passPageSet(10, 5, v())).toEqual([10, 11, 12, 13, 14]);
    expect(passPageSet(10, 5, v(11, 13))).toEqual([10, 12, 14, 15, 16]);
  });

  it('never a page above the end (known or candidate)', () => {
    expect(passPageSet(10, 5, v(), 12)).toEqual([10, 11, 12]);
    expect(passPageSet(10, 5, v(11), 12)).toEqual([10, 12]);
    expect(passPageSet(10, 5, v(), 10)).toEqual([10]);
    expect(passPageSet(10, 5, v(), 9)).toEqual([]);
  });

  it('a set of 0 pages is empty', () => {
    expect(passPageSet(10, 0, v())).toEqual([]);
  });
});

describe('dropExposedMarks (after listing drift)', () => {
  const v = (...pages: number[]) => new Map(pages.map((p) => [p, NOW]));

  it('forgets the bottom page of every visited run that sits on an unvisited page, and nothing else', () => {
    const visited = v(12, 13, 14, 17);
    dropExposedMarks(visited, 10, 1);
    expect([...visited.keys()]).toEqual([13, 14]);
  });

  it('a run right above the cursor is exposed (the cursor page is unvisited)', () => {
    const visited = v(11, 12);
    dropExposedMarks(visited, 10, 1);
    expect([...visited.keys()]).toEqual([12]);
  });

  it('a page at the cursor sits on visited ground (everything below the cursor is visited)', () => {
    const visited = v(10, 11);
    dropExposedMarks(visited, 10, 1);
    expect([...visited.keys()]).toEqual([10, 11]);
  });

  it('a drift of at most one page: only the bottom of a run goes, even when the run is long', () => {
    const visited = v(30, 31, 32, 33);
    dropExposedMarks(visited, 20, 1);
    expect([...visited.keys()]).toEqual([31, 32, 33]);
  });

  it('a drift of `depth` pages: the bottom `depth` pages of every exposed run go (a shorter run goes whole)', () => {
    const visited = v(12, 13, 14, 15, 17, 18, 21);
    dropExposedMarks(visited, 10, 2);
    expect([...visited.keys()]).toEqual([14, 15]);
  });

  it('depth 0 (no drift) forgets nothing; a run at the cursor stays whatever the depth', () => {
    const none = v(12, 13, 17);
    dropExposedMarks(none, 10, 0);
    expect([...none.keys()]).toEqual([12, 13, 17]);
    const atCursor = v(10, 11, 12, 14, 15, 16);
    dropExposedMarks(atCursor, 10, 3);
    expect([...atCursor.keys()]).toEqual([10, 11, 12]);
  });

  it('a depth far past the run (a corrupt carried drift, e.g. 1e300) forgets the run and stops at its top', () => {
    let deletes = 0;
    class Counting<K, V> extends Map<K, V> {
      delete(key: K): boolean {
        if (++deletes > 100) throw new Error('deleted past the visited run');
        return super.delete(key);
      }
    }
    const visited = new Counting(v(12, 13, 17, 30, 31).entries());
    dropExposedMarks(visited, 10, 1e300);
    expect([...visited.keys()]).toEqual([]);
    expect(deletes).toBe(5);
  });
});

describe('writeVisited', () => {
  it('merges adjacent pages into one mark that keeps the OLDEST time, ascending, above the cursor only', () => {
    const visited = new Map([
      [14, NOW - HOUR_MS],
      [12, NOW - 3 * HOUR_MS],
      [13, NOW - 2 * HOUR_MS],
      [9, NOW],
      [17, NOW],
    ]);
    expect(writeVisited(visited, 10)).toEqual({
      visited: [
        [12, 14, ago(3)],
        [17, 17, ago(0)],
      ],
    });
  });

  it('the cursor page itself is never written (the cursor is the lowest UNVISITED page)', () => {
    expect(writeVisited(new Map([[10, NOW], [12, NOW]]), 10)).toEqual({ visited: [[12, 12, ago(0)]] });
  });

  it('nothing above the cursor: an empty list', () => {
    expect(writeVisited(new Map([[3, NOW]]), 10)).toEqual({ visited: [] });
  });

  it('round-trips through readVisited', () => {
    const visited = new Map([
      [12, NOW - HOUR_MS],
      [13, NOW - HOUR_MS],
      [20, NOW - 5 * HOUR_MS],
    ]);
    expect(readVisited(writeVisited(visited, 10), 10, NOW, TTL).visited).toEqual(visited);
  });
});

describe('addDrift', () => {
  it('no pool yet: starts one with no marks and the drift', () => {
    expect(addDrift(undefined, 10, 20)).toEqual({ visited: [], drift: { ids: 10, pageSize: 20 } });
  });

  it('adds to the pending ids, keeps the marks, and takes the latest page size', () => {
    const marks: Array<[number, number, string]> = [[22, 26, ago(1)]];
    expect(addDrift({ visited: marks, drift: { ids: 10, pageSize: 20 } }, 5, 10)).toEqual({ visited: marks, drift: { ids: 15, pageSize: 10 } });
    expect(addDrift({ visited: marks }, 5, 10)).toEqual({ visited: marks, drift: { ids: 5, pageSize: 10 } });
  });

  it('a malformed pool is returned unchanged (the backfill ignores it whole)', () => {
    const bad = { visited: 'nope' } as unknown as Parameters<typeof addDrift>[0];
    expect(addDrift(bad, 5, 10)).toBe(bad);
  });

  it('writeVisited (the backfill save) writes no drift: the pending drift is spent', () => {
    const pool = addDrift({ visited: [[22, 26, ago(1)]] }, 5, 10);
    const { visited, drift } = readVisited(pool, 10, NOW, TTL);
    expect(drift).toEqual({ ids: 5, pageSize: 10 });
    expect(writeVisited(visited, 10)).toEqual({ visited: [[22, 26, ago(1)]] });
  });
});

describe('nextPage (POOL-SELECT page params)', () => {
  it('orders five consecutive pages with no adjacent pair and no monotone run, for every seed', () => {
    let bad = 0;
    for (const c of [2, 7, 400]) {
      const set = [c, c + 1, c + 2, c + 3, c + 4];
      for (let seed = 0; seed < 2000; seed++) {
        const order = orderOf(set, seed);
        expect([...order].sort((a, b) => a - b)).toEqual(set);
        bad += violations(order);
      }
    }
    expect(bad).toBe(0);
  });

  it('an eight-page set (the largest searched whole) is ordered without a violation, for every seed', () => {
    let bad = 0;
    for (let seed = 0; seed < 1000; seed++) bad += violations(orderOf([40, 41, 42, 43, 44, 45, 46, 47], seed));
    expect(bad).toBe(0);
  });

  it('a gappy set (pages visited by an earlier cut-short pass) is ordered without a violation too', () => {
    let bad = 0;
    for (let seed = 0; seed < 2000; seed++) bad += violations(orderOf([10, 12, 13, 14, 16], seed));
    expect(bad).toBe(0);
  });

  it('is a recency pool, not a fixed shuffle: lower pages lead more often, every page can lead', () => {
    const first = new Map<number, number>();
    for (let seed = 0; seed < 4000; seed++) {
      const p = orderOf([20, 21, 22, 23, 24], seed)[0];
      first.set(p, (first.get(p) ?? 0) + 1);
    }
    expect([...first.keys()].sort((a, b) => a - b)).toEqual([20, 21, 22, 23, 24]);
    expect(first.get(20)!).toBeGreaterThan(first.get(24)!);
  });

  it('the same seed gives the same order; the store stream is (seed, store, page)', () => {
    const a = orderOf([5, 6, 7, 8, 9], 77);
    expect(orderOf([5, 6, 7, 8, 9], 77)).toEqual(a);
    const rng1 = deriveStream(42, 'orzgk', 'page');
    const rng2 = deriveStream(42, 'orzgk', 'page');
    expect(nextPage([5, 6, 7, 8, 9], {}, rng1, NOW)).toBe(nextPage([5, 6, 7, 8, 9], {}, rng2, NOW));
  });

  it('when no valid order exists it still picks every page once (two adjacent pages)', () => {
    for (let seed = 0; seed < 50; seed++) expect([...orderOf([5, 6], seed)].sort()).toEqual([5, 6]);
  });

  it('respects the history it is given: 13 is the only page neither adjacent to 11 nor continuing 14 -> 11 down', () => {
    for (let seed = 0; seed < 500; seed++) {
      expect(nextPage([9, 10, 12, 13], { prev: 11, prev2: 14 }, mulberry32(seed), NOW)).toBe(13);
    }
  });

  it('a single page is that page', () => {
    expect(nextPage([9], { prev: 8, prev2: 7 }, mulberry32(1), NOW)).toBe(9);
  });

  it('a large set (above the exhaustive-order bound) still picks pages from the set, quickly', () => {
    const set = Array.from({ length: 30 }, (_, i) => 100 + i);
    const t0 = Date.now();
    const order = orderOf(set, 3);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect([...order].sort((a, b) => a - b)).toEqual(set);
  });
});

describe('loadCrawlerConfig — the page pool knobs', () => {
  const load = (env: Record<string, string>) => loadCrawlerConfig({ CRAWLER_STORES: 'orzgk', ...env }, []);

  it.each([
    ['unset', {}],
    ['empty', { CRAWLER_PAGE_POOL: '' }],
    ['off', { CRAWLER_PAGE_POOL: 'off' }],
    ['OFF padded', { CRAWLER_PAGE_POOL: '  OFF ' }],
  ])('CRAWLER_PAGE_POOL %s = off (no store pooled), with no WARN', (_l, env) => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    expect(load(env).pagePool).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('CRAWLER_PAGE_POOL=all pools every listing store', () => {
    expect(load({ CRAWLER_PAGE_POOL: 'all' }).pagePool).toBe('all');
    expect(load({ CRAWLER_PAGE_POOL: ' ALL ' }).pagePool).toBe('all');
  });

  it('a csv names the stores, once each; a malformed entry or a keyword inside the list is dropped with a WARN', () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    expect(load({ CRAWLER_PAGE_POOL: 'orzgk, hlj,orzgk' }).pagePool).toEqual(['orzgk', 'hlj']);
    expect(warn).not.toHaveBeenCalled();
    expect(load({ CRAWLER_PAGE_POOL: 'orzgk,bad/id,all,off' }).pagePool).toEqual(['orzgk']);
    expect(warn.mock.calls.map((c) => (c[1] as { entry: string }).entry)).toEqual(['bad/id', 'all', 'off']);
    expect(String(warn.mock.calls[0][0])).toContain('CRAWLER_PAGE_POOL');
  });

  it('CRAWLER_PAGE_POOL_LOOKAHEAD defaults to the backfill pages per run and is never larger', () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    expect(load({}).pagePoolLookahead).toBe(5);
    expect(load({ CRAWLER_BACKFILL_PAGES_PER_RUN: '7' }).pagePoolLookahead).toBe(7);
    expect(load({ CRAWLER_PAGE_POOL_LOOKAHEAD: '3' }).pagePoolLookahead).toBe(3);
    expect(load({ CRAWLER_PAGE_POOL_LOOKAHEAD: '5' }).pagePoolLookahead).toBe(5);
    expect(warn).not.toHaveBeenCalled();
    expect(load({ CRAWLER_PAGE_POOL_LOOKAHEAD: '6' }).pagePoolLookahead).toBe(5);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('CRAWLER_PAGE_POOL_LOOKAHEAD'), { requested: 6, applied: 5 });
    expect(load({ CRAWLER_PAGE_POOL_LOOKAHEAD: '0' }).pagePoolLookahead).toBe(5);
    expect(load({ CRAWLER_PAGE_POOL_LOOKAHEAD: 'x' }).pagePoolLookahead).toBe(5);
  });

  it('CRAWLER_PAGE_POOL_VISITED_TTL_H defaults to 72 h; a non-positive value keeps the default', () => {
    expect(load({}).pagePoolVisitedTtlMs).toBe(72 * HOUR_MS);
    expect(load({ CRAWLER_PAGE_POOL_VISITED_TTL_H: '24' }).pagePoolVisitedTtlMs).toBe(24 * HOUR_MS);
    expect(load({ CRAWLER_PAGE_POOL_VISITED_TTL_H: '0' }).pagePoolVisitedTtlMs).toBe(72 * HOUR_MS);
  });
});

/*
 * ONE validator for every page number the pool reads from the persisted ledger (QB-U24 review i4): the visited
 * marks here, the cursor and the end candidate in the crawler. The ledger is a file a crash, a bad build or a
 * hand edit can leave holding any JSON value, and `page++` stops moving at 2^53, so an unchecked page can hang
 * a loop that blocks the pass for every store. `bounded` counts Map.set and Map.has and throws past a limit,
 * so the old runaway loops fail fast here instead of hanging jest (a timeout cannot stop a synchronous loop).
 */
const POISON: unknown[] = [0, -1, 1.5, MAX_LEDGER_PAGE + 1, 2 ** 53 - 1, 2 ** 53, 1e300, NaN, Infinity, -Infinity, '12', null, undefined, true, {}, []];
/** The test's own reading of "a ledger page": an integer in [1, MAX_LEDGER_PAGE]. */
const okPage = (v: unknown): boolean => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 100_000;
const okCount = (v: unknown): boolean => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

const bounded = <T>(limit: number, fn: () => T): { out: T; ops: number } => {
  const set = Map.prototype.set;
  const has = Map.prototype.has;
  let ops = 0;
  const tick = (): void => {
    if (++ops > limit) throw new Error(`ran past ${limit} Map operations`);
  };
  const s = jest.spyOn(Map.prototype, 'set').mockImplementation(function (this: Map<unknown, unknown>, k: unknown, v: unknown) {
    tick();
    return set.call(this, k, v);
  });
  const h = jest.spyOn(Map.prototype, 'has').mockImplementation(function (this: Map<unknown, unknown>, k: unknown) {
    tick();
    return has.call(this, k);
  });
  try {
    return { out: fn(), ops };
  } finally {
    s.mockRestore();
    h.mockRestore();
  }
};

describe('isLedgerPage: the one validator for a page read from the ledger', () => {
  it('MAX_LEDGER_PAGE is 100 000: 20 x the deepest listing a rulesets profile declares (amiami, 5000 pages of 50)', () => {
    expect(MAX_LEDGER_PAGE).toBe(100_000);
  });

  it('accepts an integer in [1, MAX_LEDGER_PAGE]', () => {
    expect([1, 2, 2731, 5000, MAX_LEDGER_PAGE - 1, MAX_LEDGER_PAGE].map((p) => isLedgerPage(p))).toEqual([true, true, true, true, true, true]);
  });

  it.each(POISON.map((v) => [String(v), v]))('rejects %s', (_label, v) => {
    expect(isLedgerPage(v)).toBe(false);
  });
});

describe('readVisited never trusts a page outside [1, MAX_LEDGER_PAGE]', () => {
  const at = ago(1);
  it.each(POISON.flatMap((v) => [
    [`from ${String(v)}`, { visited: [[v, 12, at]] }],
    [`to ${String(v)}`, { visited: [[12, v, at]] }],
    [`from and to ${String(v)}`, { visited: [[v, v, at]] }],
    [`a poisoned mark beside a good one (${String(v)})`, { visited: [[12, 13, at], [v, v, at]] }],
  ]))('%s: malformed, read in a bounded number of steps', (_label, raw) => {
    const { out } = bounded(1000, () => readVisited(raw, 1, NOW, TTL));
    expect(out).toEqual({ visited: new Map(), drift: { ids: 0, pageSize: 0 }, malformed: true });
  });

  it.each([2 ** 53, 2 ** 53 + 2, 1e300, NaN, Infinity])('drift counts must be safe integers (%s)', (n) => {
    expect(readVisited({ visited: [], drift: { ids: n, pageSize: 10 } }, 1, NOW, TTL).malformed).toBe(true);
    expect(readVisited({ visited: [], drift: { ids: 3, pageSize: n } }, 1, NOW, TTL).malformed).toBe(true);
  });

  it('the largest safe drift count is well formed', () => {
    expect(readVisited({ visited: [], drift: { ids: 2 ** 53 - 1, pageSize: 2 ** 53 - 1 } }, 1, NOW, TTL).malformed).toBe(false);
  });

  it('a mark ending at MAX_LEDGER_PAGE is accepted', () => {
    const { visited, malformed } = readVisited({ visited: [[MAX_LEDGER_PAGE - 1, MAX_LEDGER_PAGE, at]] }, 1, NOW, TTL);
    expect(malformed).toBe(false);
    expect([...visited.keys()]).toEqual([MAX_LEDGER_PAGE - 1, MAX_LEDGER_PAGE]);
  });

  /*
   * The marks a backfill save writes are disjoint, so a well-formed pool covers at most MAX_LEDGER_PAGE pages.
   * More is not ours: review i4 built 16,800 disjoint 1000-page marks (each valid alone, about 760 KB of JSON)
   * that filled a Map past V8's 2^24 limit and threw out of the pass for every store.
   */
  const marks = (n: number, width: number): unknown[] => Array.from({ length: n }, (_, i) => [i * width + 1, (i + 1) * width, at]);

  it('marks covering exactly MAX_LEDGER_PAGE pages are accepted', () => {
    const { visited, malformed } = readVisited({ visited: marks(MAX_LEDGER_PAGE / MAX_MARK_SPAN, MAX_MARK_SPAN) }, 1, NOW, TTL);
    expect(malformed).toBe(false);
    expect(visited.size).toBe(MAX_LEDGER_PAGE);
  });

  it('marks covering more than MAX_LEDGER_PAGE pages in all are malformed, before any page is read', () => {
    const over = [...marks(MAX_LEDGER_PAGE / MAX_MARK_SPAN, MAX_MARK_SPAN), [1, 1, at]];
    const { out, ops } = bounded(10, () => readVisited({ visited: over }, 1, NOW, TTL));
    expect(out.malformed).toBe(true);
    expect(ops).toBe(0);
  });

  it('the review\'s 16,800 x 1000-page pool is malformed, before any page is read (no RangeError)', () => {
    const crafted = Array.from({ length: 16_800 }, (_, i) => [1 + i * 2000, i * 2000 + 1000, at]);
    const { out, ops } = bounded(10, () => readVisited({ visited: crafted }, 1, NOW, TTL));
    expect(out.malformed).toBe(true);
    expect(ops).toBe(0);
  });
});

describe('every page loop stops at MAX_LEDGER_PAGE', () => {
  const v = (...pages: number[]) => new Map(pages.map((p) => [p, NOW]));

  it('lowestUnvisited never walks past MAX_LEDGER_PAGE (and returns at once from an unsafe cursor)', () => {
    expect(bounded(1000, () => lowestUnvisited(2 ** 53, v(2 ** 53))).out).toBe(2 ** 53);
    expect(bounded(1000, () => lowestUnvisited(1e300, v(1e300))).out).toBe(1e300);
    expect(lowestUnvisited(MAX_LEDGER_PAGE - 1, v(MAX_LEDGER_PAGE - 1, MAX_LEDGER_PAGE, MAX_LEDGER_PAGE + 1))).toBe(MAX_LEDGER_PAGE + 1);
  });

  it('passPageSet never offers a page above MAX_LEDGER_PAGE (none at all from an unsafe cursor)', () => {
    expect(passPageSet(2 ** 53, 5, v())).toEqual([]);
    expect(passPageSet(MAX_LEDGER_PAGE - 1, 5, v())).toEqual([MAX_LEDGER_PAGE - 1, MAX_LEDGER_PAGE]);
    expect(passPageSet(MAX_LEDGER_PAGE + 1, 5, v())).toEqual([]);
  });

  it('dropExposedMarks forgets a whole 7-page run at depth 1e300, and all but its top page at depth 6', () => {
    const huge = v(30, 31, 32, 33, 34, 35, 36);
    dropExposedMarks(huge, 20, 1e300);
    expect([...huge.keys()]).toEqual([]);
    const six = v(30, 31, 32, 33, 34, 35, 36);
    dropExposedMarks(six, 20, 6);
    expect([...six.keys()]).toEqual([36]);
  });
});

/*
 * Seeded fuzz over the ledger's pool shape (500 seeds): marks and drift built from good values and the poison
 * list. Property: the read finishes within MAX_LEDGER_PAGE + a few Map operations; it never accepts a poisoned
 * page or count; every page it yields is a ledger page; and the backfill's own steps on what it yields
 * (drop, cursor, page set, save) finish, offer only ledger pages, and write a pool that reads back well formed.
 */
describe('seeded fuzz over the ledger pool shape', () => {
  const gen = (rng: () => number) => {
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)];
    const small = (): number => 1 + Math.floor(rng() * 40);
    const value = (): unknown => (rng() < 0.6 ? small() : pick([...POISON, MAX_LEDGER_PAGE, MAX_LEDGER_PAGE - 3]));
    const mark = (): unknown => {
      const r = rng();
      if (r < 0.5) {
        const from = small();
        return [from, from + Math.floor(rng() * 4), rng() < 0.9 ? ago(rng() * 100) : value()];
      }
      if (r < 0.9) return [value(), value(), ago(rng() * 10)];
      return pick([value(), [value()], [value(), value(), ago(1), 'x']]);
    };
    const r = rng();
    if (r < 0.05) return value();
    const raw: Record<string, unknown> = { visited: rng() < 0.97 ? Array.from({ length: Math.floor(rng() * 7) }, mark) : value() };
    if (rng() < 0.6) raw.drift = rng() < 0.7 ? { ids: Math.floor(rng() * 40), pageSize: Math.floor(rng() * 12) } : { ids: value(), pageSize: value() };
    return raw;
  };

  const poisoned = (raw: unknown): boolean => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
    const { visited, drift } = raw as { visited?: unknown; drift?: { ids?: unknown; pageSize?: unknown } };
    const badMark = Array.isArray(visited) && visited.some((m) => Array.isArray(m) && (!okPage(m[0]) || !okPage(m[1])));
    const badDrift = typeof drift === 'object' && drift !== null && (!okCount(drift.ids) || !okCount(drift.pageSize));
    return badMark || badDrift;
  };

  it('500 seeds: bounded, never trusts a poisoned value, and the backfill steps stay in range', () => {
    let poisonedSeen = 0;
    let wellFormedSeen = 0;
    for (let seed = 0; seed < 500; seed++) {
      const rng = mulberry32(seed);
      const raw = gen(rng);
      const cursor = 1 + Math.floor(rng() * 30);
      const { out: read } = bounded(MAX_LEDGER_PAGE + 100, () => readVisited(raw, cursor, NOW, TTL));
      if (poisoned(raw)) {
        poisonedSeen++;
        expect({ seed, malformed: read.malformed }).toEqual({ seed, malformed: true });
      }
      if (!read.malformed) wellFormedSeen++;
      expect([...read.visited.keys()].every((p) => okPage(p) && p >= cursor)).toBe(true);
      expect(okCount(read.drift.ids) && okCount(read.drift.pageSize)).toBe(true);
      const { out } = bounded(MAX_LEDGER_PAGE + 100, () => {
        const visited = new Map(read.visited);
        dropExposedMarks(visited, cursor, Math.ceil(read.drift.ids / Math.max(1, read.drift.pageSize)));
        const next = lowestUnvisited(cursor, visited);
        const set = passPageSet(cursor, 5, visited);
        return { next, set, saved: writeVisited(visited, next) };
      });
      expect(okPage(out.next) || out.next === MAX_LEDGER_PAGE + 1).toBe(true);
      expect(out.set.every(okPage)).toBe(true);
      const back = readVisited(out.saved, out.next, NOW, TTL);
      expect({ seed, malformed: back.malformed }).toEqual({ seed, malformed: false });
    }
    // The fuzz reaches both sides.
    expect(poisonedSeen).toBeGreaterThan(100);
    expect(wellFormedSeen).toBeGreaterThan(100);
  });
});
