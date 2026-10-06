/**
 * runCrawlerPass — the PER-STORE DESCENT CAP (QB-U29; Ross QB-2, 2026-10-04: no blind MFC id walking).
 *
 * CRAWLER_RANGE_DESCENT_CAPS (a `siteId:n` csv) lowers, per store, how many ids the id-range DESCENT
 * walks in a pass. `0` turns that store's descent OFF and touches nothing the descent owns, while hpoi,
 * whose only discovery path is this walk, keeps walking CRAWLER_RANGE_IDS_PER_RUN in the same pass.
 * Everything above the descent (re-anchor, both gap sweeps, the lists step) runs exactly as without it.
 *
 * Mocked http surface, in-memory ledger and lists-state stores, fake clock: no store is ever contacted.
 */
import { runCrawlerPass, type CrawlerConfig, type FetchLike, type HttpResponseLike } from '../../crawler/crawler';
import { loadCrawlerConfig } from '../../crawler/config';
import { createMemoryLedgerStore, createEmptyLedger, type Ledger } from '../../crawler/ledger';
import { createMemoryListsStateStore } from '../../crawler/listsState';
import { logger } from '../../utils/logger';

const HOUR_MS = 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * HOUR_MS;
/** 16:00Z: inside the production 15:30-22:30Z lists window. */
const T0 = Date.parse('2026-10-06T16:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const collectUrl = (siteId: string, id: string): string => `https://${siteId}.test/item/${id}`;
/** The ids a descending window from `from` walks, newest first. */
const ids = (from: number, count: number): string[] => Array.from({ length: count }, (_, i) => String(from - i));

/** A hand-built config: like every config built before this knob, it has no `rangeDescentCaps` at all. */
const mkCfg = (over: Partial<CrawlerConfig> = {}): CrawlerConfig => ({
  scraperServiceUrl: 'http://scraper.test',
  mode: 'both',
  phases: ['recent', 'backfill'],
  stores: ['mfc', 'hpoi'],
  ledgerDir: '/unused',
  recentMaxPages: 1,
  backfillPagesPerRun: 1,
  maxRequests: 1000,
  maxEnqueuePerStore: 200,
  maxConcurrency: 1,
  requestSpacingMs: 0,
  requestTimeoutMs: 5000,
  reobserveAfterMs: 0,
  exhaustedRecheckMs: WEEK_MS,
  storeEnqueueCaps: {},
  rangeStores: ['mfc', 'hpoi'],
  rangeIdsPerRun: 25,
  rangeFrontiers: {},
  seedSpacingMs: 0,
  reobserveMinAgeMs: 12 * HOUR_MS,
  maxReobservePerStore: 0,
  storeReobserveCaps: {},
  reobserveDryRun: false,
  rangeReanchorMs: 24 * HOUR_MS,
  rangeReanchorMaxDelta: 50_000,
  rangeGapBudget: 0,
  rangeGaps: {},
  rangeGapDryRun: false,
  ...over,
});

/** The lists step armed for mfc, inside its window. */
const LISTS_ON: Partial<CrawlerConfig> = {
  listsWindow: { startMin: 15 * 60 + 30, endMin: 22 * 60 + 30 },
  listsIntervalMs: 160 * HOUR_MS,
  listsDrainCaps: { mfc: 200 },
  listsSpacingMs: 10_000,
};

interface Call {
  method: string;
  url: string;
  body?: any;
}

/** Page 1 of each store's newest-first listing (the recent phase); every deeper page is empty. */
const LISTING: Record<string, string[]> = { mfc: ['952', '951'], hpoi: ['552', '551'] };
/** Two company lists in one group; their ids sit far from every id-range window in these tests. */
const DECL = [
  { id: 'c1-d9', url: 'https://mfc.test/s?e=1&d=9', group: 'c1', order: 1 },
  { id: 'c1-d1', url: 'https://mfc.test/s?e=1&d=1', group: 'c1', order: 1 },
];
const LISTS: Record<string, string[]> = { 'c1-d9': ['101', '102'], 'c1-d1': ['102', '103'] };

const makeFake = () => {
  const calls: Call[] = [];
  const resp = (status: number, body: unknown): HttpResponseLike => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  const fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body });
    const u = new URL(url);
    const siteId = u.searchParams.get('store') ?? '';
    if (u.pathname === '/catalog/rotating') {
      const list = u.searchParams.get('list');
      if (list === null) return resp(200, { siteId, rotatingSeedLists: DECL, count: DECL.length });
      const listed = LISTS[list] ?? [];
      return resp(200, { siteId, items: listed.map((id) => ({ itemId: id, collectUrl: collectUrl(siteId, id) })), hasMore: false, count: listed.length });
    }
    if (u.pathname === '/catalog' && u.searchParams.get('range') === '1') {
      const from = Number(u.searchParams.get('from'));
      const count = Number(u.searchParams.get('count'));
      const walked = ids(from, count).filter((id) => Number(id) >= 1);
      return resp(200, {
        siteId,
        from,
        items: walked.map((id) => ({ itemId: id, collectUrl: collectUrl(siteId, id) })),
        hasMore: from - count + 1 > 1,
        count: walked.length,
      });
    }
    if (u.pathname === '/catalog') {
      const listed = u.searchParams.get('page') === '1' ? (LISTING[siteId] ?? []) : [];
      return resp(200, { siteId, items: listed.map((id) => ({ itemId: id, collectUrl: collectUrl(siteId, id) })), hasMore: false, count: listed.length });
    }
    return resp(202, { success: true, deduplicated: false, position: 1 });
  };
  return { fetch, calls };
};
type Fake = ReturnType<typeof makeFake>;

/** Which store a call belongs to: a GET names it in `store=`, a POST in its collect url's host. */
const storeOf = (c: Call): string =>
  c.method === 'POST' ? new URL(String(c.body.url)).hostname.split('.')[0] : (new URL(c.url).searchParams.get('store') ?? '');
const callsOf = (fake: Fake, siteId: string): Call[] => fake.calls.filter((c) => storeOf(c) === siteId);
/** [from, count] of every id-range GET for the store: the descent's AND the gap sweep's. */
const rangeCalls = (fake: Fake, siteId: string): [number, number][] =>
  callsOf(fake, siteId)
    .filter((c) => c.method === 'GET' && c.url.includes('range=1'))
    .map((c) => {
      const u = new URL(c.url);
      return [Number(u.searchParams.get('from')), Number(u.searchParams.get('count'))];
    });
const idOf = (c: Call): string => String(c.body.url).split('/').pop() as string;
const postedIds = (fake: Fake, siteId: string): string[] => callsOf(fake, siteId).filter((c) => c.method === 'POST').map(idOf);

const walkedLedger = (siteId: string, range: Ledger['range'], known: string[] = []): Ledger => ({
  ...createEmptyLedger(siteId),
  enqueued: Object.fromEntries(known.map((id) => [id, { at: iso(T0 - WEEK_MS), collectUrl: collectUrl(siteId, id) }])),
  range,
});

/** mfc deep in its descent; the re-anchor is NOT due (stamped an hour ago), so only the descent can move its range. */
const MFC_RANGE = { cursor: 900, frontier: 1000, seed: 1000, reanchoredAt: iso(T0 - HOUR_MS) };
const HPOI_RANGE = { cursor: 500, frontier: 600, reanchoredAt: iso(T0 - HOUR_MS) };
const ledgers = (mfc: Ledger = walkedLedger('mfc', MFC_RANGE, ['1000'])) =>
  createMemoryLedgerStore({ mfc, hpoi: walkedLedger('hpoi', HPOI_RANGE, ['600']) });

const run = async (
  cfg: CrawlerConfig,
  ledgerStore: ReturnType<typeof createMemoryLedgerStore> = ledgers(),
  listsStore: ReturnType<typeof createMemoryListsStateStore> = createMemoryListsStateStore(),
) => {
  const fake = makeFake();
  let t = T0;
  const summary = await runCrawlerPass(cfg, {
    fetch: fake.fetch,
    ledgerStore,
    listsStore,
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  });
  const of = (siteId: string) => summary.stores.find((s) => s.siteId === siteId)!;
  return { summary, mfc: of('mfc'), hpoi: of('hpoi'), fake, ledgerStore, listsStore };
};

let warn: jest.SpyInstance;
beforeEach(() => {
  warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  jest.spyOn(logger, 'info').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const capWarnings = () => warn.mock.calls.filter(([msg]) => String(msg).includes('CRAWLER_RANGE_DESCENT_CAPS'));

describe('CRAWLER_RANGE_DESCENT_CAPS unset is today, byte for byte', () => {
  it('the same GETs, POSTs, ledgers and summaries for mfc and hpoi', async () => {
    const today = await run(mkCfg());
    // Today's pass, literally: each store's recent page, its empty backfill page, then ONE 25-id window.
    expect(callsOf(today.fake, 'mfc').filter((c) => c.method === 'GET').map((c) => c.url)).toEqual([
      'http://scraper.test/catalog?store=mfc&page=1',
      'http://scraper.test/catalog?store=mfc&page=2',
      'http://scraper.test/catalog?store=mfc&range=1&from=900&count=25',
    ]);
    expect(callsOf(today.fake, 'hpoi').filter((c) => c.method === 'GET').map((c) => c.url)).toEqual([
      'http://scraper.test/catalog?store=hpoi&page=1',
      'http://scraper.test/catalog?store=hpoi&page=2',
      'http://scraper.test/catalog?store=hpoi&range=1&from=500&count=25',
    ]);
    expect(postedIds(today.fake, 'mfc')).toEqual(['952', '951', ...ids(900, 25)]);
    expect(postedIds(today.fake, 'hpoi')).toEqual(['552', '551', ...ids(500, 25)]);
    expect(today.ledgerStore.files.get('mfc')!.range).toEqual({ ...MFC_RANGE, cursor: 875, updatedAt: iso(T0) });
    expect(today.ledgerStore.files.get('hpoi')!.range).toEqual({ ...HPOI_RANGE, cursor: 475, updatedAt: iso(T0) });
    expect(today.mfc).toMatchObject({ rangeSkipped: null, rangeWalked: 25, rangeCursor: 875, rangeFrontier: 1000 });
    expect(today.hpoi).toMatchObject({ rangeSkipped: null, rangeWalked: 25, rangeCursor: 475, rangeFrontier: 600 });

    // The knob unset in the environment, and an explicitly empty map, change nothing at all.
    const fromEnv = loadCrawlerConfig({ CRAWLER_RANGE_STORES: 'mfc,hpoi' }, []).rangeDescentCaps;
    expect(fromEnv).toEqual({});
    for (const caps of [fromEnv, {}]) {
      const other = await run(mkCfg({ rangeDescentCaps: caps }));
      expect(other.fake.calls).toEqual(today.fake.calls);
      expect([...other.ledgerStore.files]).toEqual([...today.ledgerStore.files]);
      expect(other.ledgerStore.saveLog).toEqual(today.ledgerStore.saveLog);
      expect(other.summary).toEqual(today.summary);
    }
    expect(capWarnings()).toEqual([]);
  });
});

describe("'mfc:0' — no mfc descent, and nothing the descent owns is touched", () => {
  it('requests no mfc range window and POSTs no descent id, while hpoi walks its 25 ids in the same pass', async () => {
    const r = await run(mkCfg({ rangeDescentCaps: { mfc: 0 } }));
    expect(rangeCalls(r.fake, 'mfc')).toEqual([]);
    expect(r.fake.calls.filter((c) => c.url.includes('store=mfc') && c.url.includes('range=1'))).toEqual([]);
    // The tap and the listing still run; not one id of the descent window is POSTed.
    expect(postedIds(r.fake, 'mfc')).toEqual(['952', '951']);
    const range = r.ledgerStore.files.get('mfc')!.range!;
    expect(JSON.stringify(range)).toBe(JSON.stringify(MFC_RANGE));
    expect(r.mfc).toMatchObject({ rangeSkipped: 'descent-cap', rangeWalked: 0, rangeCursor: 900, rangeFrontier: 1000 });

    expect(rangeCalls(r.fake, 'hpoi')).toEqual([[500, 25]]);
    expect(postedIds(r.fake, 'hpoi')).toEqual(['552', '551', ...ids(500, 25)]);
    expect(r.hpoi).toMatchObject({ rangeSkipped: null, rangeWalked: 25, rangeCursor: 475 });
    expect(capWarnings()).toEqual([]);
  });

  it('writes nothing: a pass whose only mfc work is the descent never saves the mfc ledger', async () => {
    const seeded = walkedLedger('mfc', MFC_RANGE, ['1000']);
    const store = ledgers(seeded);
    const r = await run(mkCfg({ phases: ['backfill'], mode: 'backfill', backfillPagesPerRun: 0, rangeDescentCaps: { mfc: 0 } }), store);
    expect(r.ledgerStore.saveLog.filter((s) => s === 'mfc')).toEqual([]);
    expect(JSON.stringify(r.ledgerStore.files.get('mfc'))).toBe(JSON.stringify(seeded));
    expect(r.fake.calls.filter((c) => storeOf(c) === 'mfc')).toEqual([]);
    expect(r.mfc.rangeSkipped).toBe('descent-cap');
    // hpoi, in the same pass, is the descent as today.
    expect(rangeCalls(r.fake, 'hpoi')).toEqual([[500, 25]]);
  });

  it('a changed CRAWLER_RANGE_FRONTIER_MFC does not re-seed: cursor, frontier and seed stay as they were', async () => {
    // Without the cap the changed seed restarts the walk at the new top (today's re-seed)...
    const reseeded = await run(mkCfg({ rangeFrontiers: { mfc: 5000 } }));
    expect(rangeCalls(reseeded.fake, 'mfc')).toEqual([[5000, 25]]);
    // ...with it, the descent never reaches the cursor work at all.
    const r = await run(mkCfg({ rangeFrontiers: { mfc: 5000 }, rangeDescentCaps: { mfc: 0 } }));
    expect(rangeCalls(r.fake, 'mfc')).toEqual([]);
    expect(JSON.stringify(r.ledgerStore.files.get('mfc')!.range)).toBe(JSON.stringify(MFC_RANGE));
    expect(r.mfc).toMatchObject({ rangeSkipped: 'descent-cap', rangeCursor: 900, rangeFrontier: 1000 });
  });

  it('a FRESH mfc ledger (cursor null) does not get its frontier initialised', async () => {
    // The descent alone: no listing page, so nothing but the descent could touch the mfc ledger.
    const descentOnly: Partial<CrawlerConfig> = { phases: ['backfill'], mode: 'backfill', backfillPagesPerRun: 0, rangeFrontiers: { mfc: 700 } };
    const fresh = () => ledgers(walkedLedger('mfc', undefined, ['800']));
    // Without the cap the descent seeds the frontier from the ledger's newest id, records the seed, and walks.
    const today = await run(mkCfg(descentOnly), fresh());
    expect(today.mfc).toMatchObject({ rangeFrontier: 800, rangeCursor: 775 });
    expect(today.ledgerStore.files.get('mfc')!.range).toMatchObject({ frontier: 800, seed: 700 });

    const r = await run(mkCfg({ ...descentOnly, rangeDescentCaps: { mfc: 0 } }), fresh());
    expect(rangeCalls(r.fake, 'mfc')).toEqual([]);
    expect(r.mfc).toMatchObject({ rangeSkipped: 'descent-cap', rangeFrontier: null, rangeCursor: null });
    expect(r.ledgerStore.saveLog.filter((s) => s === 'mfc')).toEqual([]);
    const range = r.ledgerStore.files.get('mfc')!.range;
    expect(range?.frontier).toBeUndefined();
    expect(range?.seed).toBeUndefined();
    expect(range?.cursor ?? null).toBeNull();
  });

  it('the re-anchor gap sweep and the lists step run exactly as without the knob', async () => {
    // mfc's re-anchor is due and finds 1004 above the frontier: a band 1001-1004 to sweep (budget 5).
    const seeded = () => ledgers(walkedLedger('mfc', { cursor: 900, frontier: 1000 }, ['1004']));
    const cfg = (over: Partial<CrawlerConfig> = {}) => mkCfg({ rangeGapBudget: 5, ...LISTS_ON, ...over });
    const base = await run(cfg(), seeded());
    const capped = await run(cfg({ rangeDescentCaps: { mfc: 0 } }), seeded());

    // The scenario exercises both lanes, and without the cap the descent window comes LAST.
    expect(base.mfc.gapIdsSwept).toBeGreaterThan(0);
    expect(base.mfc.listsFetched).toBe(2);
    expect(rangeCalls(base.fake, 'mfc').at(-1)).toEqual([900, 25]);

    const descentIds = new Set(ids(900, 25));
    const isDescent = (c: Call): boolean =>
      c.method === 'POST' ? descentIds.has(idOf(c)) : c.url === 'http://scraper.test/catalog?store=mfc&range=1&from=900&count=25';
    expect(base.fake.calls.filter(isDescent)).toHaveLength(26);
    expect(callsOf(capped.fake, 'mfc')).toEqual(callsOf(base.fake, 'mfc').filter((c) => !isDescent(c)));
    expect(callsOf(capped.fake, 'hpoi')).toEqual(callsOf(base.fake, 'hpoi'));
    expect([...capped.listsStore.files]).toEqual([...base.listsStore.files]);

    const b = base.ledgerStore.files.get('mfc')!.range!;
    const c = capped.ledgerStore.files.get('mfc')!.range!;
    expect(c.gaps).toEqual(b.gaps);
    expect(c.frontier).toBe(1004);
    expect(c.frontier).toBe(b.frontier);
    expect(c.reanchoredAt).toBe(b.reanchoredAt);
    expect(b.cursor).toBe(875);
    expect(c.cursor).toBe(900);

    const lanes = (s: typeof base.mfc) => ({
      rangeReanchoredTo: s.rangeReanchoredTo,
      gapBandsOpen: s.gapBandsOpen,
      gapIdsRemaining: s.gapIdsRemaining,
      gapIdsSwept: s.gapIdsSwept,
      gapEnqueued: s.gapEnqueued,
      gapBudgetApplied: s.gapBudgetApplied,
      gapSkipped: s.gapSkipped,
      listsGroup: s.listsGroup,
      listsOutcome: s.listsOutcome,
      listsFetched: s.listsFetched,
      listsFailed: s.listsFailed,
      listsIdsSeen: s.listsIdsSeen,
      listsIdsNew: s.listsIdsNew,
      listsEnqueued: s.listsEnqueued,
      listsPending: s.listsPending,
      listsDrainApplied: s.listsDrainApplied,
      listsSkipped: s.listsSkipped,
    });
    expect(lanes(capped.mfc)).toEqual(lanes(base.mfc));
    expect(capped.mfc).toMatchObject({ rangeSkipped: 'descent-cap', rangeWalked: 0 });
    expect(capped.hpoi).toEqual(base.hpoi);
  });
});

describe('a non-zero cap only LOWERS the per-pass count', () => {
  it("'mfc:10' walks 10 mfc ids; hpoi, absent from the knob, keeps CRAWLER_RANGE_IDS_PER_RUN (25)", async () => {
    const r = await run(mkCfg({ rangeDescentCaps: { mfc: 10 } }));
    expect(rangeCalls(r.fake, 'mfc')).toEqual([[900, 10]]);
    expect(postedIds(r.fake, 'mfc')).toEqual(['952', '951', ...ids(900, 10)]);
    expect(r.mfc).toMatchObject({ rangeSkipped: null, rangeWalked: 10, rangeCursor: 890 });
    expect(rangeCalls(r.fake, 'hpoi')).toEqual([[500, 25]]);
    expect(r.hpoi).toMatchObject({ rangeWalked: 25, rangeCursor: 475 });
  });

  it("'mfc:100' with CRAWLER_RANGE_IDS_PER_RUN 25 still walks 25: a cap never raises the count", async () => {
    const r = await run(mkCfg({ rangeDescentCaps: { mfc: 100 } }));
    expect(rangeCalls(r.fake, 'mfc')).toEqual([[900, 25]]);
    expect(r.mfc).toMatchObject({ rangeWalked: 25, rangeCursor: 875 });
  });

  it('the id floor still bounds the window below the cap', async () => {
    const r = await run(mkCfg({ rangeDescentCaps: { mfc: 10 } }), ledgers(walkedLedger('mfc', { ...MFC_RANGE, cursor: 3 }, ['1000'])));
    expect(rangeCalls(r.fake, 'mfc')).toEqual([[3, 3]]);
    expect(r.mfc).toMatchObject({ rangeWalked: 3, rangeCursor: 0 });
  });
});

describe('the knob from the environment, end to end', () => {
  const capsFrom = (raw: string): Record<string, number> | undefined =>
    loadCrawlerConfig({ CRAWLER_RANGE_STORES: 'mfc,hpoi', CRAWLER_RANGE_DESCENT_CAPS: raw }, []).rangeDescentCaps;

  it.each(['mfc:-1', 'mfc:x', 'mfc'])("a malformed %j is dropped with a WARN naming the var; 'hpoi:5' in the same value still applies", async (bad) => {
    const caps = capsFrom(`${bad},hpoi:5`);
    expect(capWarnings()).toEqual([[expect.stringContaining('CRAWLER_RANGE_DESCENT_CAPS'), { entry: bad }]]);
    const r = await run(mkCfg({ rangeDescentCaps: caps }));
    // The dropped entry leaves mfc absent from the knob: it walks CRAWLER_RANGE_IDS_PER_RUN.
    expect(rangeCalls(r.fake, 'mfc')).toEqual([[900, 25]]);
    expect(rangeCalls(r.fake, 'hpoi')).toEqual([[500, 5]]);
  });

  it("'mfc:0,mfc:5' walks 5: a repeated store takes its LAST value", async () => {
    const r = await run(mkCfg({ rangeDescentCaps: capsFrom('mfc:0,mfc:5') }));
    expect(rangeCalls(r.fake, 'mfc')).toEqual([[900, 5]]);
    expect(r.mfc.rangeSkipped).toBeNull();
  });

  it("'mfc:5,mfc:0' stops the descent: the last value is the 0", async () => {
    const r = await run(mkCfg({ rangeDescentCaps: capsFrom('mfc:5,mfc:0') }));
    expect(rangeCalls(r.fake, 'mfc')).toEqual([]);
    expect(r.mfc.rangeSkipped).toBe('descent-cap');
  });
});

describe('a cap naming a store that is not id-range walked', () => {
  it("'nosuch:0' logs ONE WARN at the start and is ignored: mfc and hpoi both walk 25", async () => {
    const r = await run(mkCfg({ rangeDescentCaps: { nosuch: 0 } }));
    expect(capWarnings()).toEqual([[expect.stringContaining('CRAWLER_RANGE_DESCENT_CAPS'), { siteId: 'nosuch' }]]);
    expect(rangeCalls(r.fake, 'mfc')).toEqual([[900, 25]]);
    expect(rangeCalls(r.fake, 'hpoi')).toEqual([[500, 25]]);
    expect(r.fake.calls.some((c) => c.url.includes('nosuch'))).toBe(false);
  });

  it('a crawled store that is not in CRAWLER_RANGE_STORES is warned about once and keeps its listing pass', async () => {
    const r = await run(mkCfg({ stores: ['mfc', 'hpoi', 'orzgk'], rangeDescentCaps: { orzgk: 0, mfc: 10 } }));
    expect(capWarnings()).toEqual([[expect.stringContaining('CRAWLER_RANGE_DESCENT_CAPS'), { siteId: 'orzgk' }]]);
    const orzgk = r.summary.stores.find((s) => s.siteId === 'orzgk')!;
    expect(orzgk.rangeSkipped).toBe('not-configured');
    expect(r.fake.calls.filter((c) => c.url.includes('store=orzgk')).map((c) => c.url)).toEqual([
      'http://scraper.test/catalog?store=orzgk&page=1',
      'http://scraper.test/catalog?store=orzgk&page=2',
    ]);
    expect(rangeCalls(r.fake, 'mfc')).toEqual([[900, 10]]);
  });

  it('a store in CRAWLER_RANGE_STORES that is not crawled at all is warned about too', async () => {
    await run(mkCfg({ rangeStores: ['mfc', 'hpoi', 'ghost'], rangeDescentCaps: { ghost: 3 } }));
    expect(capWarnings()).toEqual([[expect.stringContaining('CRAWLER_RANGE_DESCENT_CAPS'), { siteId: 'ghost' }]]);
  });
});
