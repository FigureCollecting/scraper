/**
 * runCrawlerPass — the BACKFILL PAGE POOL (QB-U24; Ross 2026-10-04, fleet-wide: walks should not be simply
 * sequential). For a store named in CRAWLER_PAGE_POOL (or `all`) a backfill pass fetches the L lowest
 * unvisited pages at or above its cursor (L = CRAWLER_PAGE_POOL_LOOKAHEAD, default backfillPagesPerRun) in
 * the order POOL-SELECT picks: lower page = more recent, never two adjacent pages in a row, no monotone
 * 3-run. The RECENT read (page 1 first, stop at the first page with nothing new) is untouched. The stop
 * rules are today's: a cap or a stop ends the pass, a cut-short page stays unvisited, an end is confirmed
 * only on a later run at the same page, and a confirmed end issues ZERO backfill GETs until it is due.
 *
 * A fake engine serves a paged newest-first catalog (helpers/pagedCatalogEngine); fake clock; no network.
 */
import { runCrawlerPass, type CrawlerConfig, type CrawlerStoreSummary } from '../../crawler/crawler';
import { createEmptyLedger, createFileLedgerStore, createMemoryLedgerStore, type FsLike, type Ledger, type LedgerStore } from '../../crawler/ledger';
import { createMemoryListsStateStore } from '../../crawler/listsState';
import { MAX_LEDGER_PAGE, readVisited } from '../../crawler/pagePool';
import { DEFAULT_PAGE_PARAMS, mulberry32, passesAntiSequence } from '../../services/poolSelect';
import { fakeClock, idRun, itemUrl, makePagedEngine, type EngineReply } from '../helpers/pagedCatalogEngine';
import { logger } from '../../utils/logger';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const T0 = Date.parse('2026-10-07T02:30:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

const mkCfg = (over: Partial<CrawlerConfig> = {}): CrawlerConfig => ({
  scraperServiceUrl: 'http://scraper.test',
  mode: 'both',
  phases: ['recent', 'backfill'],
  stores: ['orzgk'],
  ledgerDir: '/unused',
  recentMaxPages: 3,
  backfillPagesPerRun: 5,
  maxRequests: 1000,
  maxEnqueuePerStore: 1000,
  maxConcurrency: 1,
  requestSpacingMs: 0,
  requestTimeoutMs: 5000,
  reobserveAfterMs: 0,
  exhaustedRecheckMs: WEEK_MS,
  storeEnqueueCaps: {},
  rangeStores: [],
  rangeIdsPerRun: 50,
  rangeFrontiers: {},
  seedSpacingMs: 0,
  reobserveMinAgeMs: 12 * HOUR_MS,
  maxReobservePerStore: 0,
  storeReobserveCaps: {},
  reobserveDryRun: false,
  rangeReanchorMs: DAY_MS,
  rangeReanchorMaxDelta: 50_000,
  rangeGapBudget: 0,
  rangeGaps: {},
  rangeGapDryRun: false,
  pagePool: [],
  pagePoolLookahead: 5,
  pagePoolVisitedTtlMs: 72 * HOUR_MS,
  ...over,
});
const POOLED = { pagePool: 'all' as const };

/** orzgk: `pages` pages of 10 ids ('o<n>' newest first); the last page answers hasMore false. */
const catalog = (pages: number) => ({ pageSize: 10, items: idRun('o', 10_000, pages * 10) });

/** A ledger whose cursor is `cursor` and whose pages below it are all known (the recent read stops at page 1). */
const ledgerAt = (engineItems: string[], cursor: number, over: Partial<Ledger['backfill']> = {}): Ledger => {
  const l = createEmptyLedger('orzgk');
  for (const id of engineItems.slice(0, (cursor - 1) * 10)) l.enqueued[id] = { at: iso(T0 - DAY_MS), collectUrl: itemUrl('orzgk', id) };
  l.backfill = { cursor, ...over };
  return l;
};

const runPass = async (
  cfg: CrawlerConfig,
  engine: ReturnType<typeof makePagedEngine>,
  ledgerStore: LedgerStore,
  at: number,
  seed = 1,
) => {
  const mark = engine.calls.length;
  const clock = fakeClock(at);
  const summary = await runCrawlerPass(cfg, {
    fetch: engine.fetch,
    ledgerStore,
    listsStore: createMemoryListsStateStore(),
    now: clock.now,
    sleep: clock.sleep,
    pagePoolSeed: seed,
  });
  const calls = engine.calls.slice(mark);
  const store = (siteId = 'orzgk'): CrawlerStoreSummary => summary.stores.find((s) => s.siteId === siteId)!;
  const gets = (siteId = 'orzgk'): number[] => calls.filter((c) => c.method === 'GET' && c.store === siteId).map((c) => c.page as number);
  return {
    summary,
    store,
    gets,
    recentGets: (siteId = 'orzgk') => gets(siteId).slice(0, store(siteId).recentPages),
    backfillGets: (siteId = 'orzgk') => gets(siteId).slice(store(siteId).recentPages),
    posts: (siteId = 'orzgk') => calls.filter((c) => c.method === 'POST' && c.store === siteId).map((c) => c.line),
  };
};

const violations = (order: number[]): number => {
  let n = 0;
  for (let i = 1; i < order.length; i++) {
    if (!passesAntiSequence(order[i], { prev: order[i - 1], prev2: order[i - 2] }, DEFAULT_PAGE_PARAMS)) n++;
  }
  return n;
};

const sorted = (xs: number[]): number[] => [...xs].sort((a, b) => a - b);

describe('the recent read is today\'s for a pooled store', () => {
  it.each([
    ['a fresh store reads pages 1, 2, 3', 0, [1, 2, 3]],
    ['nothing new on page 1 stops at page 1', 1, [1]],
    ['nothing new on page 2 stops at page 2', 2, [1, 2]],
  ])('%s, with the same GETs and POSTs as unpooled', async (_label, knownPrefixPages, expected) => {
    const out = async (cfg: CrawlerConfig) => {
      const engine = makePagedEngine({ orzgk: catalog(40) });
      const l = createEmptyLedger('orzgk');
      // Page `knownPrefixPages` is known; when it is 2, page 1 still has new ids (they arrived since).
      const known = knownPrefixPages === 2 ? engine.items('orzgk').slice(10, 20) : engine.items('orzgk').slice(0, knownPrefixPages * 10);
      for (const id of known) l.enqueued[id] = { at: iso(T0 - DAY_MS), collectUrl: itemUrl('orzgk', id) };
      const p = await runPass(cfg, engine, createMemoryLedgerStore({ orzgk: l }), T0);
      return { recent: p.recentGets(), recentPosts: p.posts().slice(0, p.store().recentNew) };
    };
    const seq = await out(mkCfg());
    const pooled = await out(mkCfg(POOLED));
    expect(seq.recent).toEqual(expected);
    expect(pooled).toEqual(seq);
  });
});

describe('a pooled backfill pass is a permutation of the sequential one', () => {
  it('the same five pages, never two adjacent pages in a row, no monotone 3-run (200 seeds x 2 cursors)', async () => {
    let bad = 0;
    for (const cursor of [2, 17]) {
      const seqEngine = makePagedEngine({ orzgk: catalog(60) });
      const seqLedgers = createMemoryLedgerStore({ orzgk: ledgerAt(seqEngine.items('orzgk'), cursor) });
      const seq = await runPass(mkCfg(), seqEngine, seqLedgers, T0);
      expect(seq.backfillGets()).toEqual([cursor, cursor + 1, cursor + 2, cursor + 3, cursor + 4]);
      for (let seed = 0; seed < 200; seed++) {
        const engine = makePagedEngine({ orzgk: catalog(60) });
        const ledgers = createMemoryLedgerStore({ orzgk: ledgerAt(engine.items('orzgk'), cursor) });
        const p = await runPass(mkCfg(POOLED), engine, ledgers, T0, seed);
        const picks = p.backfillGets();
        expect(sorted(picks)).toEqual(seq.backfillGets());
        expect(p.store().pagePicks).toEqual(picks);
        bad += violations(picks);
        expect(p.store().backfillCursor).toBe(cursor + 5);
        // Every listing GET is counted, recent and backfill alike, as the sequential pass counts them.
        expect(p.store().pagesFetched).toBe(p.gets().length);
        expect(p.store().pagesFetched).toBe(seq.store().pagesFetched);
        expect(p.store().backfillPages).toBe(5);
        expect(sorted(p.posts().map((x) => x.length))).toEqual(sorted(seq.posts().map((x) => x.length)));
        expect(new Set(p.posts())).toEqual(new Set(seq.posts()));
        expect(ledgers.files.get('orzgk')!.recent.pagePool).toEqual({ visited: [] });
      }
    }
    expect(bad).toBe(0);
  });

  it('the picks are not one fixed shuffle: several orders occur and lower pages lead more often', async () => {
    const firsts = new Map<number, number>();
    for (let seed = 0; seed < 300; seed++) {
      const engine = makePagedEngine({ orzgk: catalog(30) });
      const p = await runPass(mkCfg(POOLED), engine, createMemoryLedgerStore({ orzgk: ledgerAt(engine.items('orzgk'), 10) }), T0, seed);
      const first = p.backfillGets()[0];
      firsts.set(first, (firsts.get(first) ?? 0) + 1);
    }
    expect(firsts.size).toBeGreaterThanOrEqual(4);
    expect(firsts.get(10) ?? 0).toBeGreaterThan(firsts.get(14) ?? 0);
  });

  it('the same seed replays the same picks; the seed is logged once per pass; `all` warns nothing', async () => {
    const info = jest.spyOn(logger, 'info');
    const warn = jest.spyOn(logger, 'warn');
    const picks = async (seed: number) => {
      const engine = makePagedEngine({ orzgk: catalog(30) });
      return (await runPass(mkCfg(POOLED), engine, createMemoryLedgerStore({ orzgk: ledgerAt(engine.items('orzgk'), 10) }), T0, seed)).backfillGets();
    };
    expect(await picks(99)).toEqual(await picks(99));
    const poolLines = info.mock.calls.filter((c) => String(c[0]).includes('page pool'));
    expect(poolLines).toHaveLength(2);
    expect(poolLines[0][1]).toEqual(expect.objectContaining({ seed: 99, stores: 'all', lookahead: 5 }));
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('CRAWLER_PAGE_POOL'))).toEqual([]);
  });

  it('an unpooled store logs no pool line and its summary carries no pagePicks; a pooled name not crawled is WARNed', async () => {
    const info = jest.spyOn(logger, 'info');
    const warn = jest.spyOn(logger, 'warn');
    const engine = makePagedEngine({ orzgk: catalog(30) });
    const p = await runPass(mkCfg({ pagePool: ['hlj'] }), engine, createMemoryLedgerStore({ orzgk: ledgerAt(engine.items('orzgk'), 10) }), T0);
    expect(p.backfillGets()).toEqual([10, 11, 12, 13, 14]);
    expect('pagePicks' in p.store()).toBe(false);
    expect(info.mock.calls.filter((c) => String(c[0]).includes('page pool'))).toHaveLength(0);
    const poolWarns = warn.mock.calls.filter((c) => String(c[0]).includes('CRAWLER_PAGE_POOL'));
    expect(poolWarns).toEqual([[expect.stringContaining('not being crawled'), { siteId: 'hlj' }]]);
    warn.mockClear();
    await runPass(mkCfg({ pagePool: ['orzgk'] }), makePagedEngine({ orzgk: catalog(30) }), createMemoryLedgerStore(), T0);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('CRAWLER_PAGE_POOL'))).toEqual([]);
  });

  it('a named store is pooled and another is not, in the same pass', async () => {
    const engine = makePagedEngine({ orzgk: catalog(30), hlj: { pageSize: 10, items: idRun('h', 20_000, 300) } });
    const hlj = createEmptyLedger('hlj');
    for (const id of engine.items('hlj').slice(0, 90)) hlj.enqueued[id] = { at: iso(T0 - DAY_MS), collectUrl: itemUrl('hlj', id) };
    hlj.backfill = { cursor: 10 };
    let pooledDiffers = false;
    for (let seed = 0; seed < 20 && !pooledDiffers; seed++) {
      const e = makePagedEngine({ orzgk: catalog(30), hlj: { pageSize: 10, items: engine.items('hlj') } });
      const p = await runPass(mkCfg({ stores: ['orzgk', 'hlj'], pagePool: ['hlj'] }), e, createMemoryLedgerStore({ orzgk: ledgerAt(e.items('orzgk'), 10), hlj }), T0, seed);
      expect(p.backfillGets('orzgk')).toEqual([10, 11, 12, 13, 14]);
      expect(sorted(p.backfillGets('hlj'))).toEqual([10, 11, 12, 13, 14]);
      pooledDiffers = p.backfillGets('hlj').join() !== '10,11,12,13,14';
    }
    expect(pooledDiffers).toBe(true);
  });
});

describe('stop rules', () => {
  it('under a cap: the same number of fully attempted pages; the cut-short page stays unvisited and comes back next pass', async () => {
    // 45 POSTs: four whole pages of ten new ids, and five of the fifth.
    const cfg = (pool: boolean) => mkCfg({ maxEnqueuePerStore: 45, ...(pool ? POOLED : {}) });
    const seqEngine = makePagedEngine({ orzgk: catalog(60) });
    const seq = await runPass(cfg(false), seqEngine, createMemoryLedgerStore({ orzgk: ledgerAt(seqEngine.items('orzgk'), 20) }), T0);
    expect(seq.backfillGets()).toEqual([20, 21, 22, 23, 24]);
    expect(seq.store().backfillCursor).toBe(24);
    for (let seed = 0; seed < 100; seed++) {
      const engine = makePagedEngine({ orzgk: catalog(60) });
      const ledgers = createMemoryLedgerStore({ orzgk: ledgerAt(engine.items('orzgk'), 20) });
      const p1 = await runPass(cfg(true), engine, ledgers, T0, seed);
      const picks = p1.backfillGets();
      expect(sorted(picks)).toEqual([20, 21, 22, 23, 24]);
      const cut = picks[picks.length - 1];
      const l = ledgers.files.get('orzgk')!;
      const cursor = l.backfill.cursor!;
      const marked = (l.recent.pagePool?.visited ?? []).flatMap(([from, to]) => Array.from({ length: to - from + 1 }, (_, i) => from + i));
      // Fully attempted = every page below the cursor (from 20) plus every visited mark above it.
      expect(cursor - 20 + marked.length).toBe(4);
      // The cut-short page is the one page of the five not fully attempted, so it is the lowest unvisited.
      expect(cursor).toBe(cut);
      expect(marked).not.toContain(cut);
      expect(l.backfill.exhaustCandidateCursor).toBeUndefined();
      // Next pass: the cut-short page is fetched again and no fully attempted page is.
      const p2 = await runPass(cfg(true), engine, ledgers, T0 + HOUR_MS, seed + 1000);
      expect(p2.backfillGets()).toContain(cut);
      for (const done of picks.slice(0, -1)) expect(p2.backfillGets()).not.toContain(done);
      expect(violations(p2.backfillGets())).toBe(0);
    }
  });

  it('a stopped store ends the pass: a cooldown on the third pick keeps the first two visited and the rest unvisited', async () => {
    for (let seed = 0; seed < 50; seed++) {
      let backfillGets = 0;
      const engine = makePagedEngine({ orzgk: catalog(60) }, {
        reply: (_s, page): EngineReply | undefined =>
          page >= 30 && ++backfillGets === 3 ? { status: 503, body: { error: 'cooldown', siteId: 'orzgk', host: 'orzgk.test', remainingMs: 60_000 } } : undefined,
      });
      const ledgers = createMemoryLedgerStore({ orzgk: ledgerAt(engine.items('orzgk'), 30) });
      const p = await runPass(mkCfg(POOLED), engine, ledgers, T0, seed);
      const picks = p.backfillGets();
      expect(picks).toHaveLength(3);
      expect(p.store().skipped).toBe(1);
      expect(p.store().pagePicks).toEqual(picks);
      const l = ledgers.files.get('orzgk')!;
      const unvisited = [30, 31, 32, 33, 34].filter((x) => !picks.slice(0, 2).includes(x));
      expect(l.backfill.cursor).toBe(Math.min(...unvisited));
      const marked = (l.recent.pagePool?.visited ?? []).flatMap(([from, to]) => Array.from({ length: to - from + 1 }, (_, i) => from + i));
      expect(sorted([...marked, ...Array.from({ length: l.backfill.cursor! - 30 }, (_, i) => 30 + i)])).toEqual(sorted(picks.slice(0, 2)));
    }
  });

  it('at the catalog end: at most L - 1 extra empty pages, once; the next run reads the end page alone and confirms it; then zero', async () => {
    let maxExtra = 0;
    for (const end of [10, 12]) {
      // The catalog's last page is `end` (hasMore false); the cursor is 10.
      const seqEngine = makePagedEngine({ orzgk: catalog(end) });
      const seqLedgers = createMemoryLedgerStore({ orzgk: ledgerAt(seqEngine.items('orzgk'), 10) });
      const s1 = await runPass(mkCfg(), seqEngine, seqLedgers, T0);
      const s2 = await runPass(mkCfg(), seqEngine, seqLedgers, T0 + HOUR_MS);
      expect(s1.backfillGets()).toEqual(Array.from({ length: end - 9 }, (_, i) => 10 + i));
      expect(s2.backfillGets()).toEqual([end]);
      expect(s2.store().exhausted).toBe(true);
      for (let seed = 0; seed < 200; seed++) {
        const engine = makePagedEngine({ orzgk: catalog(end) });
        const ledgers = createMemoryLedgerStore({ orzgk: ledgerAt(engine.items('orzgk'), 10) });
        const p1 = await runPass(mkCfg(POOLED), engine, ledgers, T0, seed);
        const picks = p1.backfillGets();
        const extra = picks.filter((x) => x > end).length;
        maxExtra = Math.max(maxExtra, extra);
        expect(extra).toBeLessThanOrEqual(4);
        expect(sorted(picks.filter((x) => x <= end))).toEqual(s1.backfillGets());
        expect(p1.store().exhaustCandidate).toBe(true);
        expect(p1.store().exhausted).toBe(false);
        expect(p1.store().backfillCursor).toBe(end);
        const p2 = await runPass(mkCfg(POOLED), engine, ledgers, T0 + HOUR_MS, seed + 1);
        expect(p2.backfillGets()).toEqual([end]);
        expect(p2.store().exhausted).toBe(true);
        const p3 = await runPass(mkCfg(POOLED), engine, ledgers, T0 + 2 * HOUR_MS, seed + 2);
        expect(p3.backfillGets()).toEqual([]);
      }
    }
    expect(maxExtra).toBeGreaterThan(0);
  });

  it('an exhausted store issues ZERO backfill GETs until the re-check is due; the due re-check reads the cursor page alone', async () => {
    const engine = makePagedEngine({ orzgk: catalog(12) });
    const ledgers = createMemoryLedgerStore({ orzgk: ledgerAt(engine.items('orzgk'), 12, { exhaustedAt: iso(T0 - DAY_MS) }) });
    for (let h = 0; h < 5; h++) expect((await runPass(mkCfg(POOLED), engine, ledgers, T0 + h * DAY_MS, h)).backfillGets()).toEqual([]);
    const due = await runPass(mkCfg(POOLED), engine, ledgers, T0 + 6 * DAY_MS + HOUR_MS, 7);
    expect(due.backfillGets()).toEqual([12]);
    expect(due.store().exhausted).toBe(true);
    expect(ledgers.files.get('orzgk')!.backfill.exhaustedAt).toBe(iso(T0 + 6 * DAY_MS + HOUR_MS));
    expect((await runPass(mkCfg(POOLED), engine, ledgers, T0 + 7 * DAY_MS, 8)).backfillGets()).toEqual([]);
  });

  it('a due re-check that finds items clears the end and walks on, like the sequential pass (same pages)', async () => {
    const run = async (pool: boolean, seed: number) => {
      const engine = makePagedEngine({ orzgk: catalog(12) });
      const ledgers = createMemoryLedgerStore({ orzgk: ledgerAt(engine.items('orzgk'), 12, { exhaustedAt: iso(T0 - 8 * DAY_MS) }) });
      // The catalog grew by ten pages since the end was confirmed.
      engine.prepend('orzgk', idRun('n', 90_000, 100));
      const p = await runPass(mkCfg(pool ? POOLED : {}), engine, ledgers, T0, seed);
      return { p, l: ledgers.files.get('orzgk')! };
    };
    const seq = await run(false, 0);
    expect(seq.p.backfillGets()).toEqual([12, 13, 14, 15, 16]);
    for (let seed = 0; seed < 50; seed++) {
      const pooled = await run(true, seed);
      expect(pooled.p.backfillGets()[0]).toBe(12);
      expect(sorted(pooled.p.backfillGets())).toEqual(seq.p.backfillGets());
      expect(violations(pooled.p.backfillGets())).toBe(0);
      expect(pooled.p.store().exhausted).toBe(false);
      expect(pooled.p.store().exhaustCandidate).toBe(false);
      expect(pooled.l.backfill.cursor).toBe(17);
    }
  });

  it('a real page at a candidate end clears it (the catalog grew) and the pass walks on', async () => {
    for (let seed = 0; seed < 30; seed++) {
      const engine = makePagedEngine({ orzgk: catalog(12) });
      const ledgers = createMemoryLedgerStore({ orzgk: ledgerAt(engine.items('orzgk'), 12, { exhaustCandidateCursor: 12, exhaustCandidateAt: iso(T0 - HOUR_MS) }) });
      engine.prepend('orzgk', idRun('n', 90_000, 100));
      const p = await runPass(mkCfg(POOLED), engine, ledgers, T0, seed);
      expect(p.backfillGets()[0]).toBe(12);
      expect(sorted(p.backfillGets())).toEqual([12, 13, 14, 15, 16]);
      expect(p.store().exhaustCandidate).toBe(false);
    }
  });

  it('an end seen while a lower page is still unvisited stays a candidate; a later run that fills the gap and sees it again confirms it', async () => {
    let checked = 0;
    for (let seed = 0; seed < 200; seed++) {
      // Page 10's first id is refused transiently on the first run: page 10 is cut short and the store stops.
      let failFirst = true;
      const engine = makePagedEngine({ orzgk: catalog(12) }, {
        ingest: (url) => (failFirst && url === itemUrl('orzgk', engine.items('orzgk')[90]) ? { status: 503 } : undefined),
      });
      const ledgers = createMemoryLedgerStore({ orzgk: ledgerAt(engine.items('orzgk'), 10) });
      const p1 = await runPass(mkCfg(POOLED), engine, ledgers, T0, seed);
      const picks = p1.backfillGets();
      if (picks.indexOf(12) === -1 || picks.indexOf(12) > picks.indexOf(10)) continue;
      checked++;
      const l1 = ledgers.files.get('orzgk')!;
      expect(l1.backfill.cursor).toBe(10);
      expect(l1.backfill.exhaustCandidateCursor).toBe(12);
      expect(l1.backfill.exhaustedAt).toBeUndefined();
      const candidateAt = l1.backfill.exhaustCandidateAt;
      // A second run that is cut short at page 10 again keeps the candidate and its first sighting time.
      const p2 = await runPass(mkCfg(POOLED), engine, ledgers, T0 + HOUR_MS, seed + 1);
      const l2 = ledgers.files.get('orzgk')!;
      if (p2.backfillGets().indexOf(12) !== -1 && p2.backfillGets().indexOf(12) < p2.backfillGets().indexOf(10)) {
        expect(l2.backfill.exhaustCandidateCursor).toBe(12);
        expect(l2.backfill.exhaustCandidateAt).toBe(candidateAt);
        expect(l2.backfill.exhaustedAt).toBeUndefined();
      }
      failFirst = false;
      const p3 = await runPass(mkCfg(POOLED), engine, ledgers, T0 + 2 * HOUR_MS, seed + 2);
      expect(p3.backfillGets()).toContain(12);
      expect(p3.store().exhausted).toBe(true);
      expect(ledgers.files.get('orzgk')!.backfill.cursor).toBe(12);
      expect((await runPass(mkCfg(POOLED), engine, ledgers, T0 + 3 * HOUR_MS, seed + 3)).backfillGets()).toEqual([]);
    }
    expect(checked).toBeGreaterThan(10);
  });
});

describe('edges of the stop rules', () => {
  it('the last page cut short by the cap is NOT an end candidate: it stays unvisited and is read again', async () => {
    // Page 12 is the catalogue's last (hasMore false) and holds ten new ids; the cap allows four.
    const engine = makePagedEngine({ orzgk: catalog(12) });
    const ledgers = createMemoryLedgerStore({ orzgk: ledgerAt(engine.items('orzgk'), 12) });
    const p1 = await runPass(mkCfg({ ...POOLED, maxEnqueuePerStore: 4 }), engine, ledgers, T0, 1);
    expect(p1.backfillGets()).toEqual([12]);
    expect(p1.store().exhaustCandidate).toBe(false);
    expect(p1.store().backfillCursor).toBe(12);
    const p2 = await runPass(mkCfg({ ...POOLED, maxEnqueuePerStore: 100 }), engine, ledgers, T0 + HOUR_MS, 2);
    expect(p2.backfillGets()).toContain(12);
    expect(p2.store().exhaustCandidate).toBe(true);
    expect(p2.store().backfillCursor).toBe(12);
  });

  it('a real page at the end that is cut short clears the end, stays unvisited and ends the pass', async () => {
    // Five known ids arrived on top, so page 12 now holds five known ids and the first five of the old page
    // 12; the first of those is refused transiently, which stops the store mid-page.
    let firstNew = '';
    const engine = makePagedEngine({ orzgk: catalog(12) }, { ingest: (url) => (url === itemUrl('orzgk', firstNew) ? { status: 503 } : undefined) });
    firstNew = engine.items('orzgk')[110];
    const l = ledgerAt(engine.items('orzgk'), 12, { exhaustCandidateCursor: 12, exhaustCandidateAt: iso(T0 - HOUR_MS) });
    const extra = idRun('n', 90_000, 5);
    engine.prepend('orzgk', extra);
    for (const id of extra) l.enqueued[id] = { at: iso(T0 - DAY_MS), collectUrl: itemUrl('orzgk', id) };
    const ledgers = createMemoryLedgerStore({ orzgk: l });
    const p = await runPass(mkCfg(POOLED), engine, ledgers, T0, 1);
    expect(p.backfillGets()).toEqual([12]);
    expect(p.store().exhaustCandidate).toBe(false);
    const saved = ledgers.files.get('orzgk')!;
    expect(saved.backfill.cursor).toBe(12);
    expect(saved.recent.pagePool).toEqual({ visited: [] });
  });

  it('a due re-check cut short by the cap keeps the confirmed end as it was (the sequential rule)', async () => {
    // Page 12 is the last page (hasMore false) and its ten ids are new to the ledger; the cap allows four.
    const exhaustedAt = iso(T0 - 8 * DAY_MS);
    const engine = makePagedEngine({ orzgk: catalog(12) });
    const ledgers = createMemoryLedgerStore({ orzgk: ledgerAt(engine.items('orzgk'), 12, { exhaustedAt }) });
    const p = await runPass(mkCfg({ ...POOLED, maxEnqueuePerStore: 4 }), engine, ledgers, T0, 1);
    expect(p.backfillGets()).toEqual([12]);
    expect(p.store().exhausted).toBe(true);
    expect(ledgers.files.get('orzgk')!.backfill.exhaustedAt).toBe(exhaustedAt);
    expect(ledgers.files.get('orzgk')!.backfill.cursor).toBe(12);
  });

  it('a candidate BELOW the cursor is stale: it bounds nothing and is cleared at the first save', async () => {
    const engine = makePagedEngine({ orzgk: catalog(30) });
    const ledgers = createMemoryLedgerStore({ orzgk: ledgerAt(engine.items('orzgk'), 10, { exhaustCandidateCursor: 4, exhaustCandidateAt: iso(T0 - DAY_MS) }) });
    const p = await runPass(mkCfg(POOLED), engine, ledgers, T0, 1);
    expect(sorted(p.backfillGets())).toEqual([10, 11, 12, 13, 14]);
    expect(p.store().exhaustCandidate).toBe(false);
    expect(ledgers.files.get('orzgk')!.backfill.exhaustCandidateAt).toBeUndefined();
  });

  it('a candidate AT the cursor bounds the set to that page: it is read first, and found real the pass walks on', async () => {
    const engine = makePagedEngine({ orzgk: catalog(30) });
    const ledgers = createMemoryLedgerStore({ orzgk: ledgerAt(engine.items('orzgk'), 10, { exhaustCandidateCursor: 10, exhaustCandidateAt: iso(T0 - HOUR_MS) }) });
    const p = await runPass(mkCfg(POOLED), engine, ledgers, T0, 1);
    expect(p.backfillGets()[0]).toBe(10);
    expect(sorted(p.backfillGets())).toEqual([10, 11, 12, 13, 14]);
    expect(p.store().exhaustCandidate).toBe(false);
  });

  it('a failed ledger save stops the store after that page', async () => {
    const engine = makePagedEngine({ orzgk: catalog(30) });
    const inner = createMemoryLedgerStore({ orzgk: ledgerAt(engine.items('orzgk'), 10) });
    let saves = 0;
    const failing: LedgerStore = { load: (id) => inner.load(id), save: async (l) => { if (++saves > 1) throw new Error('disk full'); await inner.save(l); } };
    const p = await runPass(mkCfg(POOLED), engine, failing, T0, 1);
    // The recent read saved once; the first backfill page's save failed and stopped the store.
    expect(p.backfillGets()).toHaveLength(1);
    expect(p.store().errors).toBe(1);
  });

  it('with no injected seed each pass draws a fresh 32-bit crypto seed and logs it', async () => {
    const info = jest.spyOn(logger, 'info');
    const engine = makePagedEngine({ orzgk: catalog(30) });
    const clock = fakeClock(T0);
    for (let i = 0; i < 2; i++) {
      await runCrawlerPass(mkCfg(POOLED), { fetch: engine.fetch, ledgerStore: createMemoryLedgerStore({ orzgk: ledgerAt(engine.items('orzgk'), 10) }), listsStore: createMemoryListsStateStore(), now: clock.now, sleep: clock.sleep });
    }
    const seeds = info.mock.calls.filter((c) => String(c[0]).includes('page pool')).map((c) => (c[1] as { seed: number }).seed);
    expect(seeds).toHaveLength(2);
    for (const seed of seeds) expect(Number.isInteger(seed) && seed >= 0 && seed < 2 ** 32).toBe(true);
    // Two draws from 2^32 collide with probability 2^-32.
    expect(seeds[0]).not.toBe(seeds[1]);
  });
});

describe('the end rules match the sequential walk', () => {
  const emptyPage = (page: number): EngineReply => ({ status: 200, body: { siteId: 'orzgk', page, url: 'x', items: [], collectUrls: [], hasMore: false, count: 0 } });

  it.each([1, 2, 3, 4, 5, 6, 7, 8])('seed %i: an exhaustion signal BELOW a standing candidate is a new candidate, never a confirmation', async (seed) => {
    // Cursor 12 and a candidate at 15 from an earlier run; this run pages 13-15 answer empty (a status-blind
    // transient) and page 12 is real. The sequential walk records a candidate at 13 and confirms nothing.
    const engine = makePagedEngine({ orzgk: catalog(30) }, { reply: (_s, page) => (page >= 13 && page <= 15 ? emptyPage(page) : undefined) });
    const ledger = () => ledgerAt(engine.items('orzgk'), 12, { exhaustCandidateCursor: 15, exhaustCandidateAt: iso(T0 - HOUR_MS) });
    const seqLedgers = createMemoryLedgerStore({ orzgk: ledger() });
    await runPass(mkCfg(), engine, seqLedgers, T0, seed);
    expect(seqLedgers.files.get('orzgk')!.backfill).toMatchObject({ cursor: 13, exhaustCandidateCursor: 13 });
    expect(seqLedgers.files.get('orzgk')!.backfill.exhaustedAt).toBeUndefined();
    const ledgers = createMemoryLedgerStore({ orzgk: ledger() });
    const p = await runPass(mkCfg(POOLED), engine, ledgers, T0, seed);
    expect(p.store().exhausted).toBe(false);
    expect(ledgers.files.get('orzgk')!.backfill.exhaustedAt).toBeUndefined();
    expect(ledgers.files.get('orzgk')!.backfill).toMatchObject({ cursor: 13, exhaustCandidateCursor: 13 });
  });

  it.each([1, 2, 3, 4, 5, 6])('seed %i: a due re-check that finds the catalog grew by one page records the new end as a CANDIDATE, as the sequential walk does', async (seed) => {
    const run = async (pool: boolean) => {
      const engine = makePagedEngine({ orzgk: catalog(13) });
      const ledgers = createMemoryLedgerStore({ orzgk: ledgerAt(engine.items('orzgk'), 12, { exhaustedAt: iso(T0 - 8 * DAY_MS) }) });
      const p = await runPass(mkCfg(pool ? POOLED : {}), engine, ledgers, T0, seed);
      return { p, b: ledgers.files.get('orzgk')!.backfill };
    };
    const seq = await run(false);
    expect(seq.b).toMatchObject({ cursor: 13, exhaustCandidateCursor: 13 });
    expect(seq.b.exhaustedAt).toBeUndefined();
    const pooled = await run(true);
    expect(pooled.p.store().exhausted).toBe(false);
    expect(pooled.b.exhaustedAt).toBeUndefined();
    expect(pooled.b).toMatchObject({ cursor: 13, exhaustCandidateCursor: 13 });
  });

  it.each([false, true])('pooled=%p: the ids a cut-short LAST page enqueued are in the saved ledger, so the next pass never POSTs them again', async (pool) => {
    // Page 12 is the catalogue's last (hasMore false) and holds ten new ids; the cap allows four.
    const engine = makePagedEngine({ orzgk: catalog(12) });
    const ledgers = createMemoryLedgerStore({ orzgk: ledgerAt(engine.items('orzgk'), 12) });
    const p = await runPass(mkCfg({ maxEnqueuePerStore: 4, ...(pool ? POOLED : {}) }), engine, ledgers, T0, 1);
    const posted = p.posts().map((line) => line.slice(line.lastIndexOf('/') + 1));
    expect(posted).toHaveLength(4);
    const saved = ledgers.files.get('orzgk')!;
    for (const id of posted) expect(saved.enqueued[id]).toBeDefined();
  });
});

describe('ledger.recent.pagePool', () => {
  const cutShortLedger = async (seed: number) => {
    const engine = makePagedEngine({ orzgk: catalog(60) });
    const ledgers = createMemoryLedgerStore({ orzgk: ledgerAt(engine.items('orzgk'), 20) });
    await runPass(mkCfg({ maxEnqueuePerStore: 25, ...POOLED }), engine, ledgers, T0, seed);
    return { engine, ledgers };
  };

  it('an older build (the knob-off path) loads a pooled ledger through the file store, never corrupt, and resumes its cursor sequentially', async () => {
    let seed = 0;
    let made = await cutShortLedger(seed);
    // Find a pass whose fully attempted pages sit ABOVE the cursor, so the pool state is non-empty.
    while ((made.ledgers.files.get('orzgk')!.recent.pagePool?.visited ?? []).length === 0 && seed < 50) made = await cutShortLedger(++seed);
    const files = new Map<string, string>();
    const fsLike: FsLike = {
      readFile: async (p) => {
        const v = files.get(p);
        if (v === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return v;
      },
      writeFile: async (p, d) => void files.set(p, d),
      rename: async (from, to) => {
        files.set(to, files.get(from)!);
        files.delete(from);
      },
      mkdir: async () => undefined,
    };
    const fileStore = createFileLedgerStore('/ledgers', fsLike, 1);
    await fileStore.save(made.ledgers.files.get('orzgk')!);
    const loaded = await fileStore.load('orzgk');
    expect(loaded).not.toBe('corrupt');
    const before = loaded as Ledger;
    expect(before.recent.pagePool?.visited.length ?? 0).toBeGreaterThan(0);
    const off = await runPass(mkCfg({ maxEnqueuePerStore: 1000 }), made.engine, fileStore, T0 + HOUR_MS);
    expect(off.store().ledgerCorrupt).toBe(false);
    const c = before.backfill.cursor!;
    expect(off.backfillGets()).toEqual([c, c + 1, c + 2, c + 3, c + 4]);
    const after = (await fileStore.load('orzgk')) as Ledger;
    expect(after.backfill.cursor).toBe(c + 5);
    // `recent` is stored whole by the older path: the pool state survives it untouched.
    expect(after.recent.pagePool).toEqual(before.recent.pagePool);
    // Back on the pool: marks the sequential walk passed are dropped.
    await runPass(mkCfg(POOLED), made.engine, fileStore, T0 + 2 * HOUR_MS, 5);
    const again = (await fileStore.load('orzgk')) as Ledger;
    for (const [from] of again.recent.pagePool?.visited ?? []) expect(from).toBeGreaterThan(again.backfill.cursor!);
  });

  it('a malformed pool state is ignored with a WARN (never corrupt) and rewritten', async () => {
    const warn = jest.spyOn(logger, 'warn');
    const engine = makePagedEngine({ orzgk: catalog(30) });
    const l = ledgerAt(engine.items('orzgk'), 10);
    (l.recent as Record<string, unknown>).pagePool = { visited: 'garbage' };
    const ledgers = createMemoryLedgerStore({ orzgk: l });
    const p = await runPass(mkCfg(POOLED), engine, ledgers, T0, 3);
    expect(p.store().ledgerCorrupt).toBe(false);
    expect(sorted(p.backfillGets())).toEqual([10, 11, 12, 13, 14]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('corrupt ledger entries dropped'), expect.objectContaining({ siteId: 'orzgk', entries: ['pagePool'] }));
    expect(ledgers.files.get('orzgk')!.recent.pagePool).toEqual({ visited: [] });
  });

  it('a visited mark expires after CRAWLER_PAGE_POOL_VISITED_TTL_H', async () => {
    const setFor = async (markAgeH: number) => {
      const engine = makePagedEngine({ orzgk: catalog(30) });
      const l = ledgerAt(engine.items('orzgk'), 10);
      l.recent.pagePool = { visited: [[12, 12, iso(T0 - markAgeH * HOUR_MS)]] };
      return sorted((await runPass(mkCfg(POOLED), engine, createMemoryLedgerStore({ orzgk: l }), T0, 4)).backfillGets());
    };
    expect(await setFor(71)).toEqual([10, 11, 13, 14, 15]);
    expect(await setFor(73)).toEqual([10, 11, 12, 13, 14]);
  });

  it('CRAWLER_PAGE_POOL_LOOKAHEAD below the pages per run shuffles (and fetches) that many pages', async () => {
    const engine = makePagedEngine({ orzgk: catalog(30) });
    const p = await runPass(mkCfg({ ...POOLED, pagePoolLookahead: 3 }), engine, createMemoryLedgerStore({ orzgk: ledgerAt(engine.items('orzgk'), 10) }), T0, 6);
    expect(sorted(p.backfillGets())).toEqual([10, 11, 12]);
  });

  it('a lookahead above the pages per run handed straight to the crawler is still held to the pages per run', async () => {
    const engine = makePagedEngine({ orzgk: catalog(30) });
    const p = await runPass(mkCfg({ ...POOLED, pagePoolLookahead: 8 }), engine, createMemoryLedgerStore({ orzgk: ledgerAt(engine.items('orzgk'), 10) }), T0, 6);
    expect(sorted(p.backfillGets())).toEqual([10, 11, 12, 13, 14]);
  });
});

describe('listing drift (k ids prepended per pass)', () => {
  /**
   * Coverage = the share of every id that ever existed (the original catalogue plus each pass's k new ids)
   * that some pass POSTed. `cap` = the per-pass POST cap; `passes` = how long the walk runs.
   */
  const coverage = async (k: number, pool: boolean, seed: number, o: { cap: number; pageSize: number; items: number; passes: number }) => {
    const engine = makePagedEngine({ orzgk: { pageSize: o.pageSize, items: idRun('o', 100_000, o.items) } });
    const ledgers = createMemoryLedgerStore();
    const all = new Set(engine.items('orzgk'));
    let fresh = 0;
    for (let i = 0; i < o.passes; i++) {
      if (i > 0) {
        const ids = idRun('n', 500_000 + (fresh += k), k);
        engine.prepend('orzgk', ids);
        for (const id of ids) all.add(id);
      }
      await runPass(mkCfg({ maxEnqueuePerStore: o.cap, ...(pool ? POOLED : {}) }), engine, ledgers, T0 + i * HOUR_MS, seed * 100 + i);
    }
    const got = new Set(engine.posted('orzgk').map((u) => u.slice(u.lastIndexOf('/') + 1)));
    return [...all].filter((id) => got.has(id)).length / all.size;
  };

  /** Review 2's model (drift.py): every pass walks its five pages in full; twelve passes of a long catalogue. */
  it.each([2, 5, 15])('k = %i, no cap binding (the plan\'s model): pooled coverage within 1 pp of sequential', async (k) => {
    const o = { cap: 1000, pageSize: 20, items: 2000, passes: 12 };
    const seq = await coverage(k, false, 0, o);
    for (let seed = 0; seed < 10; seed++) expect(await coverage(k, true, seed, o)).toBeGreaterThanOrEqual(seq - 0.01);
  });

  /**
   * A cap that cuts every pass short, run until both walks reach the catalogue end: visited marks above an
   * unvisited page appear on every pass, and drift slides that page's unread tail onto them. Pooled
   * coverage stays within 1 pp of sequential (the sequential walk misses nothing here).
   */
  it.each([2, 5, 15])('k = %i, a cap that cuts every pass short, walked to the end: pooled coverage within 1 pp of sequential', async (k) => {
    const o = { cap: 90, pageSize: 20, items: 1000, passes: 40 };
    const seq = await coverage(k, false, 0, o);
    expect(seq).toBe(1);
    for (let seed = 0; seed < 10; seed++) expect(await coverage(k, true, seed, o)).toBeGreaterThanOrEqual(seq - 0.01);
  });

  /**
   * More than a page of new ids a pass (the hourly production pass with caps of 15-50 meets this on a busy
   * store): an unvisited page's unread tail then slides past the bottom page of the visited run above it.
   */
  it.each([25, 45])('k = %i (more than one 20-id page), a cap that cuts every pass short, walked to the end: pooled coverage within 1 pp of sequential', async (k) => {
    const o = { cap: 90, pageSize: 20, items: 1000, passes: 60 };
    const seq = await coverage(k, false, 0, o);
    expect(seq).toBe(1);
    for (let seed = 0; seed < 10; seed++) expect(await coverage(k, true, seed, o)).toBeGreaterThanOrEqual(seq - 0.01);
  });

  describe('the bottom visited page above an unvisited one is read again when the listing moved', () => {
    /** cursor 20; pages 22-23 visited an hour ago; page 21 unvisited (the run sits on it). */
    const setFor = async (o: { prepend: number; phases?: CrawlerConfig['phases']; run?: [number, number]; reply?: (store: string, page: number) => EngineReply | undefined }) => {
      const engine = makePagedEngine({ orzgk: catalog(60) }, o.reply ? { reply: o.reply } : {});
      const l = ledgerAt(engine.items('orzgk'), 20);
      const [from, to] = o.run ?? [22, 23];
      l.recent.pagePool = { visited: [[from, to, iso(T0 - HOUR_MS)]] };
      if (o.prepend > 0) engine.prepend('orzgk', idRun('n', 900_000, o.prepend));
      const p = await runPass(mkCfg({ ...POOLED, ...(o.phases ? { phases: o.phases } : {}) }), engine, createMemoryLedgerStore({ orzgk: l }), T0, 11);
      return sorted(p.backfillGets());
    };

    it('no new ids on top: the marks hold', async () => {
      expect(await setFor({ prepend: 0 })).toEqual([20, 21, 24, 25, 26]);
    });

    it('new ids on top: page 22 (bottom of the run) is read again, page 23 is not', async () => {
      expect(await setFor({ prepend: 3 })).toEqual([20, 21, 22, 24, 25]);
    });

    it('no recent read this pass (backfill-only mode): the drift is unknown, so page 22 is read again', async () => {
      expect(await setFor({ prepend: 0, phases: ['backfill'] })).toEqual([20, 21, 22, 24, 25]);
    });

    /**
     * A longer run, pages 22-26, over the unvisited page 21: k new ids on top move page 21's unread ids
     * down by k, onto the bottom ceil(k / page size) pages of the run (page size = the recent read's page 1).
     */
    it.each([
      [10, [20, 21, 22, 27, 28]],
      [11, [20, 21, 22, 23, 27]],
      [25, [20, 21, 22, 23, 24]],
    ])('k = %i new ids on top of 10-id pages: the bottom ceil(k / 10) pages of the run are read again', async (k, expected) => {
      expect(await setFor({ prepend: k as number, run: [22, 26] })).toEqual(expected);
    });

    it('the page size is the recent read\'s PAGE 1, not a shorter page it read later', async () => {
      // k = 11 on 10-id pages (new ids n900000..n899990). Pages 2 and 3 of the recent read answer three ids
      // each: page 2 the last new id and two known ones, page 3 three known ids. ceil(11 / 3) would re-read four.
      const page = (n: number, ids: string[]): EngineReply => ({
        status: 200,
        body: { siteId: 'orzgk', page: n, url: 'x', items: ids.map((id) => ({ itemId: id, collectUrl: itemUrl('orzgk', id) })), collectUrls: [], hasMore: true, nextPage: n + 1, count: ids.length },
      });
      const short = (_s: string, n: number): EngineReply | undefined =>
        n === 2 ? page(2, ['n899990', 'o10000', 'o9999']) : n === 3 ? page(3, ['o9998', 'o9997', 'o9996']) : undefined;
      expect(await setFor({ prepend: 11, run: [22, 26], reply: short })).toEqual([20, 21, 22, 23, 27]);
    });

    it('re-observed known ids are not drift: a recent read that only re-observes keeps the marks', async () => {
      // Every known id is older than reobserveAfterMs, so the recent read re-POSTs its three pages of known ids.
      const engine = makePagedEngine({ orzgk: catalog(60) });
      const l = ledgerAt(engine.items('orzgk'), 20);
      l.recent.pagePool = { visited: [[22, 23, iso(T0 - HOUR_MS)]] };
      const p = await runPass(mkCfg({ ...POOLED, reobserveAfterMs: HOUR_MS }), engine, createMemoryLedgerStore({ orzgk: l }), T0, 11);
      expect(p.store().recentNew).toBe(30);
      expect(sorted(p.backfillGets())).toEqual([20, 21, 24, 25, 26]);
    });
  });
});

/*
 * Drift seen by a pass whose backfill never saved (QB-U24 review i2). The drift a recent read sees must reach
 * the marks even when that pass's backfill never runs or never saves: a stop or a cap after the recent step,
 * a pass with no backfill phase, or a first backfill pick that fails. Otherwise the next pass counts only the
 * ids that arrived since, and the unread ids of an unvisited page slide onto a page still marked visited.
 */
describe('drift from a pass whose backfill never saved is carried to the next pass', () => {
  const cooldown: EngineReply = { status: 503, body: { error: 'cooldown', remainingMs: 60_000 } };

  /** cursor 20; pages 22-26 visited an hour ago; page 21 unvisited (the run sits on it). 10-id pages. */
  const setup = () => {
    let fail: ((page: number) => EngineReply | undefined) | undefined;
    const engine = makePagedEngine({ orzgk: catalog(60) }, { reply: (_s, page) => fail?.(page) });
    const l = ledgerAt(engine.items('orzgk'), 20);
    l.recent.pagePool = { visited: [[22, 26, iso(T0 - HOUR_MS)]] };
    const ledgers = createMemoryLedgerStore({ orzgk: l });
    return { engine, ledgers, failWith: (f?: (page: number) => EngineReply | undefined) => { fail = f; } };
  };

  /** Pass A: 10 new ids on top (one page), then the pass ends before its backfill saves anything. */
  const passA: Array<[string, Partial<CrawlerConfig>, ((page: number) => EngineReply | undefined) | undefined]> = [
    ['a cooldown on recent page 2', {}, (page) => (page === 2 ? cooldown : undefined)],
    ['a 500 on recent page 2', {}, (page) => (page === 2 ? { status: 500, body: { error: 'boom' } } : undefined)],
    // (the 5 ids the cap left are met again by pass B and counted twice: an over-count re-reads more, never less)
    ['the per-store cap reached by the recent read', { maxEnqueuePerStore: 5 }, undefined],
    ['a pass with no backfill phase', { phases: ['recent'] }, undefined],
    ['a cooldown on the first backfill pick', {}, (page) => (page >= 20 ? cooldown : undefined)],
  ];

  it.each(passA)('%s: the next pass re-reads ceil((10 + 5) / 10) = 2 bottom pages of the run, not 1', async (_name, overA, fail) => {
    const s = setup();
    s.engine.prepend('orzgk', idRun('n', 900_000, 10));
    s.failWith(fail);
    const a = await runPass(mkCfg({ ...POOLED, ...overA }), s.engine, s.ledgers, T0, 11);
    s.failWith(undefined);
    expect(a.store().recentNew).toBe(10);
    expect(a.store().backfillPages).toBe(0);
    s.engine.prepend('orzgk', idRun('n', 900_010, 5));
    const b = await runPass(mkCfg(POOLED), s.engine, s.ledgers, T0 + HOUR_MS, 12);
    expect(sorted(b.backfillGets())).toEqual([20, 21, 22, 23, 27]);
  });

  it('with no recent read in the next pass, its unknown page is added to the carried drift: 1 + 1 pages re-read', async () => {
    const s = setup();
    s.engine.prepend('orzgk', idRun('n', 900_000, 10));
    await runPass(mkCfg({ ...POOLED, phases: ['recent'] }), s.engine, s.ledgers, T0, 11);
    const b = await runPass(mkCfg({ ...POOLED, phases: ['backfill'] }), s.engine, s.ledgers, T0 + HOUR_MS, 12);
    expect(sorted(b.backfillGets())).toEqual([20, 21, 22, 23, 27]);
  });

  it('the carried drift is spent once: a backfill that saved drops nothing more on a pass with no new ids', async () => {
    const s = setup();
    s.engine.prepend('orzgk', idRun('n', 900_000, 10));
    await runPass(mkCfg({ ...POOLED, phases: ['recent'] }), s.engine, s.ledgers, T0, 11);
    // Pass B: no new ids; the carried page (22) is dropped and the two lowest unvisited pages read.
    const b = await runPass(mkCfg({ ...POOLED, pagePoolLookahead: 2 }), s.engine, s.ledgers, T0 + HOUR_MS, 12);
    expect(sorted(b.backfillGets())).toEqual([20, 21]);
    // Pass C: no new ids, so nothing is dropped: 23-26 stay visited.
    const c = await runPass(mkCfg({ ...POOLED, pagePoolLookahead: 2 }), s.engine, s.ledgers, T0 + 2 * HOUR_MS, 13);
    expect(sorted(c.backfillGets())).toEqual([22, 27]);
  });

  it('carried drift can pass the recent read\'s 3 pages: 25 + 15 ids on 10-id pages re-read the bottom 4 pages of the run', async () => {
    const s = setup();
    s.ledgers.files.get('orzgk')!.recent.pagePool = { visited: [[22, 30, iso(T0 - HOUR_MS)]] };
    s.engine.prepend('orzgk', idRun('n', 900_000, 25));
    await runPass(mkCfg({ ...POOLED, phases: ['recent'] }), s.engine, s.ledgers, T0, 11);
    s.engine.prepend('orzgk', idRun('n', 900_025, 15));
    await runPass(mkCfg({ ...POOLED, phases: ['recent'] }), s.engine, s.ledgers, T0 + HOUR_MS, 12);
    const c = await runPass(mkCfg({ ...POOLED, pagePoolLookahead: 2 }), s.engine, s.ledgers, T0 + 2 * HOUR_MS, 13);
    expect(sorted(c.backfillGets())).toEqual([20, 21]);
    expect(s.ledgers.files.get('orzgk')!.recent.pagePool).toEqual({ visited: [[26, 30, iso(T0 - HOUR_MS)]] });
  });

  /*
   * A carried drift is persisted data, so a corrupt or hand-edited ledger can hold any integer (QB-U24 review
   * i3). A drift wider than the run only forgets the run, so the pass must finish at once with the picks a
   * drift of exactly the run's five pages gives. A delete counter turns the old unbounded drop (about 4 ns a
   * page, so years at 1e300) into a fast failure instead of a hung suite.
   */
  it('a huge carried drift (ids 1e300 on 1-id pages) forgets only the run: the pass finishes with the picks of a 5-page drift', async () => {
    const picks = async (drift: { ids: number; pageSize: number }) => {
      const s = setup();
      s.ledgers.files.get('orzgk')!.recent.pagePool = { visited: [[22, 26, iso(T0 - HOUR_MS)]], drift };
      const del = Map.prototype.delete;
      let deletes = 0;
      const spy = jest.spyOn(Map.prototype, 'delete').mockImplementation(function (this: Map<unknown, unknown>, key: unknown) {
        if (++deletes > 100_000) throw new Error('dropExposedMarks ran past the visited run');
        return del.call(this, key);
      });
      try {
        const p = await runPass(mkCfg(POOLED), s.engine, s.ledgers, T0, 5);
        return { gets: p.backfillGets(), pool: s.ledgers.files.get('orzgk')!.recent.pagePool };
      } finally {
        spy.mockRestore();
      }
    };
    const huge = await picks({ ids: 1e300, pageSize: 1 });
    const fivePages = await picks({ ids: 50, pageSize: 10 });
    expect(sorted(huge.gets)).toEqual([20, 21, 22, 23, 24]);
    expect(huge).toEqual(fivePages);
  });

  it('a recent read that meets no new ids leaves the pool state as it was (no zero drift written)', async () => {
    const s = setup();
    const before = structuredClone(s.ledgers.files.get('orzgk')!.recent.pagePool);
    await runPass(mkCfg({ ...POOLED, phases: ['recent'] }), s.engine, s.ledgers, T0, 11);
    expect(s.ledgers.files.get('orzgk')!.recent.pagePool).toEqual(before);
  });

  it('an unpooled store writes no page pool state in a pass whose backfill never ran', async () => {
    const s = setup();
    delete s.ledgers.files.get('orzgk')!.recent.pagePool;
    s.engine.prepend('orzgk', idRun('n', 900_000, 10));
    await runPass(mkCfg({ phases: ['recent'] }), s.engine, s.ledgers, T0, 11);
    expect(s.ledgers.files.get('orzgk')!.recent.pagePool).toBeUndefined();
  });

  /*
   * The challenger's two-sided case (review i2), end to end: page 21 was never read, pages 22-26 were; 15 ids
   * of drift in all. (a) all 15 in one pass; (b) 10 in a pass stopped by a cooldown on the recent read's page
   * 2, then 5. Walked to the end, every id of page 21 must be POSTed, pooled or not.
   */
  describe('the challenger\'s two-sided case', () => {
    const walk = async (pool: boolean, split: boolean) => {
      const s = setup();
      const page21 = s.engine.items('orzgk').slice(200, 210);
      // pages 22-26 were fully attempted by an earlier cut-short pass (their ids are known)
      for (const id of s.engine.items('orzgk').slice(210, 260)) s.ledgers.files.get('orzgk')!.enqueued[id] = { at: iso(T0 - 2 * HOUR_MS), collectUrl: itemUrl('orzgk', id) };
      s.ledgers.files.get('orzgk')!.backfill.cursor = 21;
      s.ledgers.files.get('orzgk')!.recent.pagePool = { visited: [[22, 26, iso(T0 - 2 * HOUR_MS)]] };
      const cfg = mkCfg(pool ? POOLED : {});
      let from = 0;
      if (split) {
        s.engine.prepend('orzgk', idRun('n', 900_000, 10));
        s.failWith((page) => (page === 2 ? cooldown : undefined));
        const a = await runPass(cfg, s.engine, s.ledgers, T0, 49);
        s.failWith(undefined);
        expect(a.store().recentNew).toBe(10);
        expect(a.store().backfillPages).toBe(0);
        s.engine.prepend('orzgk', idRun('n', 900_010, 5));
        from = 1;
      } else {
        s.engine.prepend('orzgk', idRun('n', 900_000, 15));
      }
      for (let i = 0; i < 20; i++) await runPass(cfg, s.engine, s.ledgers, T0 + (from + i) * HOUR_MS, 50 + i);
      const got = new Set(s.engine.posted('orzgk').map((u) => u.slice(u.lastIndexOf('/') + 1)));
      return page21.filter((id) => !got.has(id));
    };

    it.each([false, true])('pooled=%p (a) 15 ids in ONE pass: every id of page 21 is POSTed', async (pool) => {
      expect(await walk(pool, false)).toEqual([]);
    });

    it.each([false, true])('pooled=%p (b) 10 ids in a pass stopped by a recent-read cooldown, then 5: every id of page 21 is POSTed', async (pool) => {
      expect(await walk(pool, true)).toEqual([]);
    });
  });
});

/*
 * Review i4: every page number the pooled pass reads from the ledger (the visited marks, the backfill cursor,
 * the end candidate) goes through ONE validator, pagePool.isLedgerPage: an integer in [1, MAX_LEDGER_PAGE]. A
 * value outside it is a corrupt entry: dropped, with ONE WARN per store naming every entry dropped, and the
 * pass carries on. `runBounded` counts Map.set and throws past 2e6, so the old hang (a mark at 2^53 never ends
 * readVisited's loop, and jest's timeout cannot stop a synchronous loop) fails fast instead.
 */
describe('corrupt page values in the ledger: one validator, one WARN, the pass finishes', () => {
  const corruptWarns = (warn: jest.SpyInstance) => warn.mock.calls.filter((c) => String(c[0]).includes('corrupt ledger entries dropped'));
  const oneWarn = (entries: string[]) => [[expect.any(String), { siteId: 'orzgk', entries, maxPage: MAX_LEDGER_PAGE }]];
  const runBounded = async (...args: Parameters<typeof runPass>) => {
    const set = Map.prototype.set;
    let n = 0;
    const spy = jest.spyOn(Map.prototype, 'set').mockImplementation(function (this: Map<unknown, unknown>, k: unknown, v: unknown) {
      if (++n > 2_000_000) throw new Error('pool loop ran past 2e6 Map.set calls');
      return set.call(this, k, v);
    });
    try {
      return await runPass(...args);
    } finally {
      spy.mockRestore();
    }
  };
  const at = iso(T0 - HOUR_MS);

  it.each([2 ** 53, 2 ** 53 - 1, 1e300, MAX_LEDGER_PAGE + 1])('a visited mark at %s drops the whole pool: the pass reads the cursor pages', async (v) => {
    const warn = jest.spyOn(logger, 'warn');
    const engine = makePagedEngine({ orzgk: catalog(30) });
    const l = ledgerAt(engine.items('orzgk'), 10);
    l.recent.pagePool = { visited: [[12, 13, at], [v, v, at]] };
    const ledgers = createMemoryLedgerStore({ orzgk: l });
    const p = await runBounded(mkCfg(POOLED), engine, ledgers, T0, 3);
    expect(p.store().ledgerCorrupt).toBe(false);
    expect(sorted(p.backfillGets())).toEqual([10, 11, 12, 13, 14]);
    expect(corruptWarns(warn)).toEqual(oneWarn(['pagePool']));
    expect(ledgers.files.get('orzgk')!.recent.pagePool).toEqual({ visited: [] });
  });

  it.each([2 ** 53, 1e300, MAX_LEDGER_PAGE + 1])('a backfill cursor of %s is dropped: the walk restarts at the top, one WARN', async (v) => {
    const warn = jest.spyOn(logger, 'warn');
    const engine = makePagedEngine({ orzgk: catalog(30) });
    const l = ledgerAt(engine.items('orzgk'), 10);
    l.backfill.cursor = v;
    const ledgers = createMemoryLedgerStore({ orzgk: l });
    const p = await runBounded(mkCfg(POOLED), engine, ledgers, T0, 3);
    expect(sorted(p.backfillGets())).toEqual([2, 3, 4, 5, 6]);
    expect(ledgers.files.get('orzgk')!.backfill.cursor).toBe(7);
    expect(corruptWarns(warn)).toEqual(oneWarn(['cursor']));
  });

  it.each([['null', null], ['absent', undefined]])('a cursor that is %s (a store not walked yet) is not corrupt: no WARN, the walk starts past the recent read', async (_label, v) => {
    const warn = jest.spyOn(logger, 'warn');
    const engine = makePagedEngine({ orzgk: catalog(30) });
    const l = ledgerAt(engine.items('orzgk'), 10);
    if (v === null) l.backfill.cursor = null;
    else delete (l.backfill as Partial<Ledger['backfill']>).cursor;
    const p = await runBounded(mkCfg(POOLED), engine, createMemoryLedgerStore({ orzgk: l }), T0, 3);
    expect(sorted(p.backfillGets())).toEqual([2, 3, 4, 5, 6]);
    expect(corruptWarns(warn)).toEqual([]);
  });

  it('such a cursor reaches the pool through the real file store (the ledger load accepts any positive integer)', async () => {
    const files = new Map<string, string>();
    const fsLike: FsLike = {
      readFile: async (p) => files.get(p) ?? Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
      writeFile: async (p, d) => void files.set(p, d),
      rename: async (from, to) => {
        files.set(to, files.get(from)!);
        files.delete(from);
      },
      mkdir: async () => undefined,
    };
    const fileStore = createFileLedgerStore('/ledgers', fsLike, 1);
    const engine = makePagedEngine({ orzgk: catalog(30) });
    const l = ledgerAt(engine.items('orzgk'), 10);
    l.backfill.cursor = 2 ** 53;
    await fileStore.save(l);
    expect(((await fileStore.load('orzgk')) as Ledger).backfill.cursor).toBe(2 ** 53);
    const p = await runBounded(mkCfg(POOLED), engine, fileStore, T0, 3);
    expect(sorted(p.backfillGets())).toEqual([2, 3, 4, 5, 6]);
    expect(((await fileStore.load('orzgk')) as Ledger).backfill.cursor).toBe(7);
  });

  it.each([
    ['a string', '12'],
    ['a fraction', 12.5],
    ['2^53', 2 ** 53],
    ['1e300', 1e300],
    ['above MAX_LEDGER_PAGE', MAX_LEDGER_PAGE + 1],
    ['null (NaN after JSON)', null],
  ])('an end candidate that is %s is dropped and cleared: the pass reads its five pages, one WARN', async (_label, v) => {
    const warn = jest.spyOn(logger, 'warn');
    const engine = makePagedEngine({ orzgk: catalog(30) });
    const l = ledgerAt(engine.items('orzgk'), 10, { exhaustCandidateCursor: v as number, exhaustCandidateAt: iso(T0 - DAY_MS) });
    const ledgers = createMemoryLedgerStore({ orzgk: l });
    const p = await runBounded(mkCfg(POOLED), engine, ledgers, T0, 3);
    expect(sorted(p.backfillGets())).toEqual([10, 11, 12, 13, 14]);
    expect(ledgers.files.get('orzgk')!.backfill.exhaustCandidateCursor).toBeUndefined();
    expect(ledgers.files.get('orzgk')!.backfill.exhaustCandidateAt).toBeUndefined();
    expect(corruptWarns(warn)).toEqual(oneWarn(['exhaustCandidateCursor']));
  });

  it('a stale but valid candidate below the cursor is still cleared silently (not corrupt)', async () => {
    const warn = jest.spyOn(logger, 'warn');
    const engine = makePagedEngine({ orzgk: catalog(30) });
    const l = ledgerAt(engine.items('orzgk'), 10, { exhaustCandidateCursor: 5, exhaustCandidateAt: iso(T0 - DAY_MS) });
    const ledgers = createMemoryLedgerStore({ orzgk: l });
    await runBounded(mkCfg(POOLED), engine, ledgers, T0, 3);
    expect(ledgers.files.get('orzgk')!.backfill.exhaustCandidateCursor).toBeUndefined();
    expect(corruptWarns(warn)).toEqual([]);
  });

  it('every corrupt entry in one ledger: ONE WARN naming them all', async () => {
    const warn = jest.spyOn(logger, 'warn');
    const engine = makePagedEngine({ orzgk: catalog(30) });
    const l = ledgerAt(engine.items('orzgk'), 10, { exhaustCandidateCursor: 'x' as unknown as number });
    l.backfill.cursor = 1e300;
    l.recent.pagePool = { visited: [[2 ** 53, 2 ** 53, at]] };
    const p = await runBounded(mkCfg(POOLED), engine, createMemoryLedgerStore({ orzgk: l }), T0, 3);
    expect(sorted(p.backfillGets())).toEqual([2, 3, 4, 5, 6]);
    expect(corruptWarns(warn)).toEqual(oneWarn(['cursor', 'pagePool', 'exhaustCandidateCursor']));
  });

  /*
   * Seeded fuzz (80 seeds) over the three ledger values: the cursor (good, or a positive integer the ledger load
   * lets through but the pool must not trust), the end candidate (absent, good, or any poison) and the pool's
   * marks and drift (good and poisoned values mixed). Property: every pass finishes; it asks only for ledger
   * pages; it saves a ledger-page cursor, no candidate or a ledger-page one, and a pool that reads back well
   * formed; and it warns at most once, and never for a ledger with nothing corrupt.
   */
  it('seeded fuzz (80 seeds): every pass finishes, asks for and saves only ledger pages, and warns at most once', async () => {
    const POISON: unknown[] = [0, -1, 1.5, MAX_LEDGER_PAGE + 1, 2 ** 53 - 1, 2 ** 53, 1e300, NaN, Infinity, '12', null, true];
    const BIG_INTS = [MAX_LEDGER_PAGE + 1, 2 ** 53 - 1, 2 ** 53, 1e300];
    let corruptSeeds = 0;
    for (let seed = 0; seed < 80; seed++) {
      const rng = mulberry32(seed);
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)];
      const small = (): number => 5 + Math.floor(rng() * 30);
      const value = (): unknown => (rng() < 0.6 ? small() : pick(POISON));
      const engine = makePagedEngine({ orzgk: catalog(30) });
      const l = ledgerAt(engine.items('orzgk'), 10);
      const badCursor = rng() < 0.3;
      if (badCursor) l.backfill.cursor = pick(BIG_INTS);
      const c = rng();
      const candidate = c < 0.4 ? undefined : c < 0.6 ? small() : pick(POISON);
      if (candidate !== undefined) Object.assign(l.backfill, { exhaustCandidateCursor: candidate, exhaustCandidateAt: iso(T0 - DAY_MS) });
      const marks = Array.from({ length: Math.floor(rng() * 4) }, () => {
        const from = value();
        return [from, typeof from === 'number' && rng() < 0.7 ? from + Math.floor(rng() * 3) : value(), at];
      });
      const drift = rng() < 0.5 ? undefined : { ids: rng() < 0.8 ? Math.floor(rng() * 30) : value(), pageSize: 10 };
      (l.recent as Record<string, unknown>).pagePool = { visited: marks, ...(drift ? { drift } : {}) };
      const warn = jest.spyOn(logger, 'warn');
      warn.mockClear();
      const ledgers = createMemoryLedgerStore({ orzgk: l });
      const loaded = (await ledgers.load('orzgk')) as Ledger;
      const okPage = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_LEDGER_PAGE;
      const anyCorrupt =
        (loaded.backfill.cursor !== null && !okPage(loaded.backfill.cursor)) ||
        (loaded.backfill.exhaustCandidateCursor !== undefined && !okPage(loaded.backfill.exhaustCandidateCursor)) ||
        readVisited(loaded.recent.pagePool, 1, T0, 72 * HOUR_MS).malformed;
      if (anyCorrupt) corruptSeeds++;
      const p = await runBounded(mkCfg(POOLED), engine, ledgers, T0, seed);
      const saved = ledgers.files.get('orzgk')!;
      expect({ seed, gets: p.gets().every(okPage) }).toEqual({ seed, gets: true });
      expect({ seed, cursor: okPage(saved.backfill.cursor) }).toEqual({ seed, cursor: true });
      expect({ seed, cand: saved.backfill.exhaustCandidateCursor === undefined || okPage(saved.backfill.exhaustCandidateCursor) }).toEqual({ seed, cand: true });
      expect({ seed, pool: readVisited(saved.recent.pagePool, saved.backfill.cursor!, T0, 72 * HOUR_MS).malformed }).toEqual({ seed, pool: false });
      expect({ seed, warns: corruptWarns(warn).length }).toEqual({ seed, warns: anyCorrupt ? 1 : 0 });
    }
    expect(corruptSeeds).toBeGreaterThan(20);
    expect(corruptSeeds).toBeLessThan(80);
  });
});
