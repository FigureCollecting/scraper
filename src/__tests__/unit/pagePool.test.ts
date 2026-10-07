/**
 * QB-U24 — the backfill page pool's pure parts (src/crawler/pagePool.ts) and its three crawler knobs.
 *
 * The pool keeps `ledger.recent.pagePool = {visited: [[from, to, at], ...]}`: the pages ABOVE the cursor a
 * cut-short pass fully attempted, each mark expiring after CRAWLER_PAGE_POOL_VISITED_TTL_H. A pass's page
 * set is the L lowest unvisited pages at or above the cursor (none above a known or candidate end), and
 * POOL-SELECT orders it: lower page = more recent, never two adjacent pages in a row, no monotone 3-run
 * while an order without one exists. Pure: no clock, no I/O.
 */
import { dropExposedMarks, lowestUnvisited, MAX_MARK_SPAN, nextPage, passPageSet, readVisited, writeVisited } from '../../crawler/pagePool';
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
    expect(readVisited(undefined, 10, NOW, TTL)).toEqual({ visited: new Map(), malformed: false });
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
    expect(readVisited({ visited: [[12, 12, 'yesterday']] }, 10, NOW, TTL)).toEqual({ visited: new Map(), malformed: false });
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
  ])('malformed (%s): ignored whole, flagged for a WARN', (_label, raw) => {
    expect(readVisited(raw, 1, NOW, TTL)).toEqual({ visited: new Map(), malformed: true });
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
    dropExposedMarks(visited, 10);
    expect([...visited.keys()]).toEqual([13, 14]);
  });

  it('a run right above the cursor is exposed (the cursor page is unvisited)', () => {
    const visited = v(11, 12);
    dropExposedMarks(visited, 10);
    expect([...visited.keys()]).toEqual([12]);
  });

  it('a page at the cursor sits on visited ground (everything below the cursor is visited)', () => {
    const visited = v(10, 11);
    dropExposedMarks(visited, 10);
    expect([...visited.keys()]).toEqual([10, 11]);
  });

  it('only the bottom of a run goes, even when the run is long (one pass of drift moves less than a page)', () => {
    const visited = v(30, 31, 32, 33);
    dropExposedMarks(visited, 20);
    expect([...visited.keys()]).toEqual([31, 32, 33]);
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
