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
import { DEFAULT_PAGE_PARAMS, passesAntiSequence } from '../../services/poolSelect';
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

  it('the same seed replays the same picks; the seed is logged once per pass', async () => {
    const info = jest.spyOn(logger, 'info');
    const picks = async (seed: number) => {
      const engine = makePagedEngine({ orzgk: catalog(30) });
      return (await runPass(mkCfg(POOLED), engine, createMemoryLedgerStore({ orzgk: ledgerAt(engine.items('orzgk'), 10) }), T0, seed)).backfillGets();
    };
    expect(await picks(99)).toEqual(await picks(99));
    const poolLines = info.mock.calls.filter((c) => String(c[0]).includes('page pool'));
    expect(poolLines).toHaveLength(2);
    expect(poolLines[0][1]).toEqual(expect.objectContaining({ seed: 99, stores: 'all', lookahead: 5 }));
  });

  it('an unpooled store logs no pool line and its summary carries no pagePicks', async () => {
    const info = jest.spyOn(logger, 'info');
    const engine = makePagedEngine({ orzgk: catalog(30) });
    const p = await runPass(mkCfg({ pagePool: ['hlj'] }), engine, createMemoryLedgerStore({ orzgk: ledgerAt(engine.items('orzgk'), 10) }), T0);
    expect(p.backfillGets()).toEqual([10, 11, 12, 13, 14]);
    expect('pagePicks' in p.store()).toBe(false);
    expect(info.mock.calls.filter((c) => String(c[0]).includes('page pool'))).toHaveLength(0);
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
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('page pool state malformed'), expect.objectContaining({ siteId: 'orzgk' }));
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

  describe('the bottom visited page above an unvisited one is read again when the listing moved', () => {
    /** cursor 20; pages 22-23 visited an hour ago; page 21 unvisited (the run sits on it). */
    const setFor = async (o: { prepend: number; phases?: CrawlerConfig['phases'] }) => {
      const engine = makePagedEngine({ orzgk: catalog(60) });
      const l = ledgerAt(engine.items('orzgk'), 20);
      l.recent.pagePool = { visited: [[22, 23, iso(T0 - HOUR_MS)]] };
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
  });
});
