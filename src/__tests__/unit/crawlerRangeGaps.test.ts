/**
 * runCrawlerPass — the ID-RANGE FRONTIER RE-ANCHOR and the KNOWN-GAP SWEEP (D5, Ross 2026-09-18).
 *
 * The descent walks mfc's id space DOWNWARD from a frontier that was frozen the day the walk began.
 * The store keeps adding ids ABOVE that frontier, and the only thing watching the top is the Latest
 * Additions tap — a single page with no pager, so anything added faster than its turnover between
 * runs is invisible and the descent never climbs back up to it.
 *
 * Two mechanisms close that hole, and NEITHER touches the descent's cursor:
 *   RE-ANCHOR — once per CRAWLER_RANGE_REANCHOR_H (default 24 h) the frontier is moved up to the
 *               newest id the ledger has seen, and the band it skipped over is recorded as a KNOWN GAP.
 *   GAP SWEEP — an ASCENDING walk of the open gap bands on its OWN per-run budget
 *               (CRAWLER_RANGE_GAP_BUDGET, default 0 = off), oldest band first, closing a band once
 *               its last id is swept. Operators declare bands of their own with CRAWLER_RANGE_GAPS.
 *
 * Every test drives a MOCKED http surface, an in-memory ledger store and a fake clock. No new URL
 * shape is introduced: a gap window is the SAME `/catalog?range=1&from=&count=` the descent uses.
 */
import { runCrawlerPass, type CrawlerConfig, type FetchLike, type HttpResponseLike } from '../../crawler/crawler';
import { createMemoryLedgerStore, createEmptyLedger, type Ledger, type LedgerGapBand } from '../../crawler/ledger';
import type { FetchFailureReport } from '../../services/failureReporter';
import { logger } from '../../utils/logger';

const HOUR_MS = 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * HOUR_MS;
const T0 = Date.parse('2026-09-18T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

/** The byId collect url the engine synthesises for an id-range window — the ONLY shape these lanes use. */
const collectUrl = (siteId: string, id: string): string => `https://${siteId}.test/item/${id}`;

const mkCfg = (over: Partial<CrawlerConfig> = {}): CrawlerConfig => ({
  scraperServiceUrl: 'http://scraper.test',
  mode: 'backfill',
  phases: ['backfill'],
  stores: ['mfc'],
  ledgerDir: '/unused',
  recentMaxPages: 3,
  backfillPagesPerRun: 0,
  maxRequests: 500,
  maxEnqueuePerStore: 50,
  maxConcurrency: 2,
  requestSpacingMs: 0,
  requestTimeoutMs: 5000,
  reobserveAfterMs: 0,
  exhaustedRecheckMs: WEEK_MS,
  storeEnqueueCaps: {},
  rangeStores: ['mfc'],
  rangeIdsPerRun: 5,
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

interface Reply {
  status: number;
  body?: unknown;
  throwErr?: boolean;
}

/** A canned 200 id-range body: `count` ids walking DOWN from `from` (floor 1), as the engine synthesizes them. */
const rangeBody = (siteId: string, from: number, count: number) => {
  const lowest = Math.max(1, from - count + 1);
  const ids: string[] = [];
  for (let id = from; id >= lowest; id--) ids.push(String(id));
  return {
    siteId,
    from,
    items: ids.map((id) => ({ itemId: id, collectUrl: collectUrl(siteId, id) })),
    collectUrls: ids.map((id) => collectUrl(siteId, id)),
    hasMore: lowest > 1,
    count: ids.length,
  };
};

const okRange = (siteId: string, from: number, count: number): Reply => ({ status: 200, body: rangeBody(siteId, from, count) });
const accepted = (): Reply => ({ status: 202, body: { success: true, deduplicated: false, position: 1 } });
const refused = (): Reply => ({ status: 400, body: { error: 'no ruleset matches this url' } });
const sick = (): Reply => ({ status: 503, body: { error: 'queue unavailable' } });
const cooldown = (siteId: string): Reply => ({ status: 503, body: { error: 'cooldown', siteId, host: `${siteId}.test`, remainingMs: 60000 } });

interface FakeOpts {
  range?: (siteId: string, from: number, count: number) => Reply;
  catalog?: (siteId: string, page: number) => Reply;
  ingest?: (url: string) => Reply;
}

const makeFake = (opts: FakeOpts = {}) => {
  const calls: { method: string; url: string; body?: any }[] = [];
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
    if (url.includes('/catalog')) {
      const u = new URL(url);
      const siteId = u.searchParams.get('store') ?? '';
      const r =
        u.searchParams.get('range') === '1'
          ? (opts.range ?? okRange)(siteId, Number(u.searchParams.get('from')), Number(u.searchParams.get('count')))
          : (opts.catalog ?? ((s2: string): Reply => ({ status: 200, body: { siteId: s2, page: 1, items: [], hasMore: false, count: 0 } })))(
              siteId,
              Number(u.searchParams.get('page')),
            );
      if (r.throwErr) throw new Error('catalog network error');
      return resp(r.status, r.body ?? {});
    }
    const r = opts.ingest ? opts.ingest(body?.url as string) : accepted();
    if (r.throwErr) throw new Error('ingest transport error');
    return resp(r.status, r.body ?? {});
  };
  return {
    fetch,
    calls,
    /** [from, count] of every id-range GET in dispatch order — the descent's AND the sweep's. */
    rangeCalls: () =>
      calls
        .filter((c) => c.url.includes('/catalog') && c.url.includes('range=1'))
        .map((c) => {
          const u = new URL(c.url);
          return [Number(u.searchParams.get('from')), Number(u.searchParams.get('count'))] as [number, number];
        }),
    catalogUrls: () => calls.filter((c) => c.url.includes('/catalog')).map((c) => c.url),
    posted: () => calls.filter((c) => c.url.includes('/ingest')).map((c) => c.body.url as string),
    /** The item ids POSTed, in dispatch order. */
    postedIds: () =>
      calls
        .filter((c) => c.url.includes('/ingest'))
        .map((c) => String(c.body.url).split('/').pop() as string),
  };
};

const clock = (start = T0) => {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
};

/** A ledger whose range section is already walking, with the given ids known. */
const walkedLedger = (
  siteId: string,
  range: Ledger['range'],
  knownIds: string[] = [],
  at: number = T0 - WEEK_MS,
): Ledger => ({
  ...createEmptyLedger(siteId),
  enqueued: Object.fromEntries(knownIds.map((id) => [id, { at: iso(at), collectUrl: collectUrl(siteId, id) }])),
  range,
});

const openBands = (l: Ledger): LedgerGapBand[] => (l.range?.gaps ?? []).filter((b) => b.closedAt === undefined);

describe('id-range FRONTIER RE-ANCHOR', () => {
  it('moves a stale frontier up to the ledger newest id, records the skipped band, and leaves the descent cursor alone', async () => {
    const store = createMemoryLedgerStore({
      // The descent is deep below the frontier; the tap has since put ids ABOVE it in the ledger.
      mfc: walkedLedger('mfc', { cursor: 900, frontier: 1000 }, ['1004', '1002']),
    });
    const fake = makeFake();
    const s = await runCrawlerPass(mkCfg(), { fetch: fake.fetch, ledgerStore: store, now: clock().now });

    const range = store.files.get('mfc')!.range!;
    expect(range.frontier).toBe(1004);
    expect(range.reanchoredAt).toBe(iso(T0));
    expect(range.gaps).toEqual([{ from: 1001, to: 1004, next: 1001, origin: 'reanchor', createdAt: iso(T0) }]);
    // The descent is untouched by the re-anchor: it asked for its own window from 900 and moved on.
    expect(fake.rangeCalls()).toEqual([[900, 5]]);
    expect(range.cursor).toBe(895);
    expect(s.stores[0]).toMatchObject({ rangeReanchoredTo: 1004, rangeFrontier: 1004, rangeCursor: 895, gapBandsOpen: 1, gapIdsRemaining: 4 });
  });

  it('does NOT re-anchor again inside the cadence window, and DOES once it has elapsed', async () => {
    const store = createMemoryLedgerStore({
      mfc: walkedLedger('mfc', { cursor: 900, frontier: 1000, reanchoredAt: iso(T0 - 23 * HOUR_MS) }, ['1004']),
    });
    const c = clock();
    const early = await runCrawlerPass(mkCfg(), { fetch: makeFake().fetch, ledgerStore: store, now: c.now });
    expect(early.stores[0].rangeReanchoredTo).toBeNull();
    expect(store.files.get('mfc')!.range!.frontier).toBe(1000);
    expect(store.files.get('mfc')!.range!.gaps ?? []).toEqual([]);

    c.advance(2 * HOUR_MS);
    const late = await runCrawlerPass(mkCfg(), { fetch: makeFake().fetch, ledgerStore: store, now: c.now });
    expect(late.stores[0].rangeReanchoredTo).toBe(1004);
    expect(store.files.get('mfc')!.range!.frontier).toBe(1004);
    expect(openBands(store.files.get('mfc')!)).toHaveLength(1);
  });

  it('records NOTHING when the ledger newest id has not passed the frontier', async () => {
    const store = createMemoryLedgerStore({ mfc: walkedLedger('mfc', { cursor: 900, frontier: 1000 }, ['1000', '999']) });
    const s = await runCrawlerPass(mkCfg(), { fetch: makeFake().fetch, ledgerStore: store, now: clock().now });
    expect(s.stores[0]).toMatchObject({ rangeReanchoredTo: null, gapBandsOpen: 0, gapIdsRemaining: 0 });
    expect(store.files.get('mfc')!.range!.frontier).toBe(1000);
    expect(store.files.get('mfc')!.range!.gaps ?? []).toEqual([]);
  });

  it('a store that has NEVER walked is not re-anchored — the descent seeds the frontier instead', async () => {
    const store = createMemoryLedgerStore({ mfc: walkedLedger('mfc', undefined, ['800']) });
    const s = await runCrawlerPass(mkCfg(), { fetch: makeFake().fetch, ledgerStore: store, now: clock().now });
    expect(s.stores[0]).toMatchObject({ rangeReanchoredTo: null, rangeFrontier: 800, gapBandsOpen: 0 });
    expect(store.files.get('mfc')!.range!.gaps ?? []).toEqual([]);
  });

  it('costs no request and is DURABLE even when the descent does nothing at all (its cap is spent)', async () => {
    const store = createMemoryLedgerStore({ mfc: walkedLedger('mfc', { cursor: 900, frontier: 1000 }, ['1004']) });
    const fake = makeFake();
    // An enqueue cap of 0 is the discovery dry run: pages are fetched, nothing is POSTed.
    const s = await runCrawlerPass(mkCfg({ maxEnqueuePerStore: 0 }), { fetch: fake.fetch, ledgerStore: store, now: clock().now });
    expect(fake.posted()).toEqual([]);
    expect(store.files.get('mfc')!.range!.frontier).toBe(1004);
    expect(openBands(store.files.get('mfc')!)).toHaveLength(1);
    expect(s.stores[0].rangeReanchoredTo).toBe(1004);
  });

  it('a save that fails takes the re-anchor with it: the frontier reported is the one on DISK', async () => {
    const store = createMemoryLedgerStore({ mfc: walkedLedger('mfc', { cursor: 900, frontier: 1000 }, ['1004']) });
    const failing = {
      ...store,
      save: async () => {
        throw new Error('PVC read-only');
      },
    };
    const fake = makeFake();
    const s = await runCrawlerPass(mkCfg(), { fetch: fake.fetch, ledgerStore: failing, now: clock().now });
    // Nothing reached the disk, so the descent never ran and the summary must not claim a new frontier.
    expect(fake.rangeCalls()).toEqual([]);
    expect(s.stores[0]).toMatchObject({ rangeFrontier: 1000, rangeSkipped: 'failed', gapSkipped: 'failed', gapBandsOpen: 0, errors: 1 });
  });

  it('CRAWLER_RANGE_REANCHOR_H=0 re-anchors on EVERY run (no minimum interval)', async () => {
    const store = createMemoryLedgerStore({
      mfc: walkedLedger('mfc', { cursor: 900, frontier: 1000, reanchoredAt: iso(T0 - 1000) }, ['1004']),
    });
    const s = await runCrawlerPass(mkCfg({ rangeReanchorMs: 0 }), { fetch: makeFake().fetch, ledgerStore: store, now: clock().now });
    expect(s.stores[0].rangeReanchoredTo).toBe(1004);
  });

  it('refuses a re-anchor further than CRAWLER_RANGE_REANCHOR_MAX_DELTA by name, and moves nothing until the knob allows it', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      // 50,001 above the frontier is a bad id in the ledger, not a day of new items.
      const store = createMemoryLedgerStore({ mfc: walkedLedger('mfc', { cursor: 900, frontier: 1000 }, ['51001', '1004']) });
      const c = clock();
      const s = await runCrawlerPass(mkCfg(), { fetch: makeFake().fetch, ledgerStore: store, now: c.now });
      const range = store.files.get('mfc')!.range!;
      expect(range.frontier).toBe(1000);
      expect(range.gaps ?? []).toEqual([]);
      expect(range.reanchoredAt).toBeUndefined();
      expect(s.stores[0]).toMatchObject({ rangeReanchoredTo: null, rangeReanchorRefused: 51001, rangeFrontier: 1000 });
      const line = warn.mock.calls.find(([msg]) => String(msg).includes('CRAWLER_RANGE_REANCHOR_MAX_DELTA'));
      expect(line?.[1]).toEqual({ siteId: 'mfc', frontier: 1000, newest: 51001, delta: 50001, maxDelta: 50000 });

      // The knob is the operator's lever: raised, the same ledger re-anchors on the next run.
      c.advance(HOUR_MS);
      const s2 = await runCrawlerPass(mkCfg({ rangeReanchorMaxDelta: 60_000 }), { fetch: makeFake().fetch, ledgerStore: store, now: c.now });
      expect(s2.stores[0]).toMatchObject({ rangeReanchoredTo: 51001, rangeReanchorRefused: null });
    } finally {
      warn.mockRestore();
    }
  });

  it('allows a move of exactly CRAWLER_RANGE_REANCHOR_MAX_DELTA ids, and 0 refuses every move', async () => {
    const edge = createMemoryLedgerStore({ mfc: walkedLedger('mfc', { cursor: 900, frontier: 1000 }, ['51000']) });
    const s1 = await runCrawlerPass(mkCfg(), { fetch: makeFake().fetch, ledgerStore: edge, now: clock().now });
    expect(s1.stores[0]).toMatchObject({ rangeReanchoredTo: 51000, rangeReanchorRefused: null });

    const zero = createMemoryLedgerStore({ mfc: walkedLedger('mfc', { cursor: 900, frontier: 1000 }, ['1001']) });
    const s2 = await runCrawlerPass(mkCfg({ rangeReanchorMaxDelta: 0 }), { fetch: makeFake().fetch, ledgerStore: zero, now: clock().now });
    expect(s2.stores[0]).toMatchObject({ rangeReanchoredTo: null, rangeReanchorRefused: 1001, rangeFrontier: 1000 });
  });

  it.each(['1e7', '0x10', ' 12', '12.0', 'abc', 'item-77', '99999999999999999999'])(
    'a ledger key that is not a plain run of digits (%j) never becomes the frontier',
    async (key) => {
      // Number('1e7') and Number('0x10') are safe integers: only the digits-only filter keeps them out.
      const ledger = walkedLedger('mfc', { cursor: 5, frontier: 10 }, ['11']);
      ledger.enqueued[key] = { at: iso(T0 - WEEK_MS), collectUrl: collectUrl('mfc', key) };
      const store = createMemoryLedgerStore({ mfc: ledger });
      const s = await runCrawlerPass(mkCfg(), { fetch: makeFake().fetch, ledgerStore: store, now: clock().now });
      expect(s.stores[0]).toMatchObject({ rangeReanchoredTo: 11, rangeFrontier: 11 });
    },
  );
});

describe('the frontier follows only ids the STORE has shown us', () => {
  it('CH-1: a bogus CRAWLER_RANGE_GAPS id is never swept, and the next re-anchor does not follow it', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      const store = createMemoryLedgerStore({ mfc: walkedLedger('mfc', { cursor: 900, frontier: 1000, reanchoredAt: iso(T0) }, []) });
      const cfg = mkCfg({ rangeGaps: { mfc: [{ from: 9_000_000, to: 9_000_000 }] }, rangeGapBudget: 5, rangeIdsPerRun: 5 });

      // RUN 1: the declaration is refused before the sweep can drive it.
      const f1 = makeFake();
      await runCrawlerPass(cfg, { fetch: f1.fetch, ledgerStore: store, now: clock(T0).now });
      const mid = store.files.get('mfc')!;
      expect(f1.postedIds()).not.toContain('9000000');
      expect(Object.keys(mid.enqueued)).not.toContain('9000000');
      expect(mid.range!.gaps ?? []).toEqual([]);
      const refusal = warn.mock.calls.find(([msg]) => String(msg).includes('band not adopted'));
      expect(refusal?.[1]).toEqual({ siteId: 'mfc', band: '9000000-9000000', frontier: 1000 });

      // RUN 2: a day later the re-anchor reads the ledger, and the frontier stays where the store put it.
      const s2 = await runCrawlerPass(cfg, { fetch: makeFake().fetch, ledgerStore: store, now: clock(T0 + 25 * HOUR_MS).now });
      const after = store.files.get('mfc')!;
      expect(after.range!.frontier).toBe(1000);
      expect(after.range!.gaps ?? []).toEqual([]);
      expect(s2.stores[0].rangeReanchoredTo).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  it('an id the SWEEP wrote never becomes the frontier, even one sitting above it', async () => {
    // A band above the frontier that is ALREADY on the ledger: adopted before declarations were checked,
    // or stranded there by a lowered CRAWLER_RANGE_FRONTIER_<SITEID>. Sweeping it is allowed; trusting it is not.
    const stranded: LedgerGapBand = { from: 1500, to: 1500, next: 1500, origin: 'operator', createdAt: iso(T0 - WEEK_MS) };
    const store = createMemoryLedgerStore({
      mfc: walkedLedger('mfc', { cursor: 0, frontier: 1000, reanchoredAt: iso(T0), gaps: [stranded] }, ['1200']),
    });
    const cfg = mkCfg({ rangeGapBudget: 5, rangeIdsPerRun: 5 });
    const f1 = makeFake();
    await runCrawlerPass(cfg, { fetch: f1.fetch, ledgerStore: store, now: clock(T0).now });
    expect(f1.postedIds()).toEqual(['1500']);
    expect(store.files.get('mfc')!.enqueued['1500']).toMatchObject({ sweptFrom: 'operator' });

    const s2 = await runCrawlerPass(cfg, { fetch: makeFake().fetch, ledgerStore: store, now: clock(T0 + 25 * HOUR_MS).now });
    // 1200 is the tap's, so the frontier follows it; 1500 is the sweep's, so it does not.
    expect(s2.stores[0].rangeReanchoredTo).toBe(1200);
    expect(store.files.get('mfc')!.range!.frontier).toBe(1200);
  });

  it('the tap moves the frontier and the sweep never does: only the sweep marks the entries it writes', async () => {
    const store = createMemoryLedgerStore({
      mfc: walkedLedger('mfc', {
        cursor: 900,
        frontier: 1000,
        gaps: [
          { from: 101, to: 101, next: 101, origin: 'operator', createdAt: iso(T0 - 2 * WEEK_MS) },
          { from: 201, to: 201, next: 201, origin: 'reanchor', createdAt: iso(T0 - WEEK_MS) },
        ],
      }),
    });
    // The Latest Additions tap: page 1 of the listing shows an id above the frontier.
    const fake = makeFake({
      catalog: (siteId) => ({
        status: 200,
        body: { siteId, page: 1, items: [{ itemId: '1100', collectUrl: collectUrl(siteId, '1100') }], hasMore: false, count: 1 },
      }),
    });
    const s = await runCrawlerPass(mkCfg({ mode: 'both', phases: ['recent', 'backfill'], rangeGapBudget: 2, rangeIdsPerRun: 1 }), {
      fetch: fake.fetch,
      ledgerStore: store,
      now: clock().now,
    });
    const enqueued = store.files.get('mfc')!.enqueued;
    expect(enqueued['1100'].sweptFrom).toBeUndefined();
    expect(enqueued['900'].sweptFrom).toBeUndefined();
    expect(enqueued['101'].sweptFrom).toBe('operator');
    expect(enqueued['201'].sweptFrom).toBe('reanchor');
    expect(s.stores[0].rangeReanchoredTo).toBe(1100);
  });

  it('a store that has never walked does not seed its descent from an id the sweep wrote', async () => {
    const ledger = walkedLedger('mfc', undefined, ['800']);
    ledger.enqueued['9000000'] = { at: iso(T0 - WEEK_MS), collectUrl: collectUrl('mfc', '9000000'), sweptFrom: 'operator' };
    const store = createMemoryLedgerStore({ mfc: ledger });
    const fake = makeFake();
    const s = await runCrawlerPass(mkCfg(), { fetch: fake.fetch, ledgerStore: store, now: clock().now });
    expect(fake.rangeCalls()).toEqual([[800, 5]]);
    expect(s.stores[0].rangeFrontier).toBe(800);
  });

  it('a null ledger entry (a hand-edited file) neither crashes the re-anchor nor hides its id', async () => {
    const ledger = walkedLedger('mfc', { cursor: 900, frontier: 1000 });
    (ledger.enqueued as Record<string, unknown>)['1004'] = null;
    const store = createMemoryLedgerStore({ mfc: ledger });
    const s = await runCrawlerPass(mkCfg(), { fetch: makeFake().fetch, ledgerStore: store, now: clock().now });
    expect(s.stores[0].rangeReanchoredTo).toBe(1004);
  });
});

describe('KNOWN-GAP bands declared by the operator', () => {
  it('adopts CRAWLER_RANGE_GAPS bands into the ledger with origin `operator`, exactly once', async () => {
    const store = createMemoryLedgerStore({ mfc: walkedLedger('mfc', { cursor: 900, frontier: 1000 }) });
    const cfg = mkCfg({ rangeGaps: { mfc: [{ from: 500, to: 504 }, { from: 777, to: 777 }] } });
    const c = clock();
    await runCrawlerPass(cfg, { fetch: makeFake().fetch, ledgerStore: store, now: c.now });
    expect(store.files.get('mfc')!.range!.gaps).toEqual([
      { from: 500, to: 504, next: 500, origin: 'operator', createdAt: iso(T0) },
      { from: 777, to: 777, next: 777, origin: 'operator', createdAt: iso(T0) },
    ]);

    c.advance(HOUR_MS);
    await runCrawlerPass(cfg, { fetch: makeFake().fetch, ledgerStore: store, now: c.now });
    expect(store.files.get('mfc')!.range!.gaps).toHaveLength(2);
  });

  it('does NOT re-open a declared band that has already been swept closed', async () => {
    const closed: LedgerGapBand = { from: 500, to: 504, next: 505, origin: 'operator', createdAt: iso(T0 - WEEK_MS), closedAt: iso(T0 - WEEK_MS) };
    const store = createMemoryLedgerStore({ mfc: walkedLedger('mfc', { cursor: 900, frontier: 1000, gaps: [closed] }) });
    const s = await runCrawlerPass(mkCfg({ rangeGaps: { mfc: [{ from: 500, to: 504 }] } }), {
      fetch: makeFake().fetch,
      ledgerStore: store,
      now: clock().now,
    });
    expect(store.files.get('mfc')!.range!.gaps).toEqual([closed]);
    expect(s.stores[0]).toMatchObject({ gapBandsOpen: 0, gapIdsRemaining: 0 });
  });

  it('refuses a declared band that reaches above the frontier, naming it and the frontier; one at or below it is adopted', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      const store = createMemoryLedgerStore({ mfc: walkedLedger('mfc', { cursor: 900, frontier: 1000 }) });
      const declared = [
        { from: 1001, to: 1001 },
        { from: 990, to: 1010 },
        { from: 991, to: 1000 },
        { from: 500, to: 504 },
      ];
      await runCrawlerPass(mkCfg({ rangeGaps: { mfc: declared } }), { fetch: makeFake().fetch, ledgerStore: store, now: clock().now });
      expect(store.files.get('mfc')!.range!.gaps).toEqual([
        { from: 991, to: 1000, next: 991, origin: 'operator', createdAt: iso(T0) },
        { from: 500, to: 504, next: 500, origin: 'operator', createdAt: iso(T0) },
      ]);
      const refused = warn.mock.calls.filter(([msg]) => String(msg).includes('band not adopted')).map(([, meta]) => meta);
      expect(refused).toEqual([
        { siteId: 'mfc', band: '1001-1001', frontier: 1000 },
        { siteId: 'mfc', band: '990-1010', frontier: 1000 },
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it('adopts nothing on a store with no frontier yet, and adopts the band once the walk has one', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      const store = createMemoryLedgerStore({ mfc: walkedLedger('mfc', undefined) });
      const cfg = mkCfg({ rangeFrontiers: { mfc: 1000 }, rangeGaps: { mfc: [{ from: 500, to: 504 }] } });
      const c = clock();
      await runCrawlerPass(cfg, { fetch: makeFake().fetch, ledgerStore: store, now: c.now });
      expect(store.files.get('mfc')!.range!.gaps ?? []).toEqual([]);
      expect(warn.mock.calls.find(([msg]) => String(msg).includes('band not adopted'))?.[1]).toEqual({ siteId: 'mfc', band: '500-504', frontier: null });

      c.advance(HOUR_MS);
      await runCrawlerPass(cfg, { fetch: makeFake().fetch, ledgerStore: store, now: c.now });
      expect(store.files.get('mfc')!.range!.gaps).toEqual([{ from: 500, to: 504, next: 500, origin: 'operator', createdAt: iso(T0 + HOUR_MS) }]);
    } finally {
      warn.mockRestore();
    }
  });

  it('checks a declared band against the frontier AFTER this run has re-anchored it', async () => {
    const store = createMemoryLedgerStore({ mfc: walkedLedger('mfc', { cursor: 900, frontier: 1000 }, ['1200']) });
    await runCrawlerPass(mkCfg({ rangeGaps: { mfc: [{ from: 1100, to: 1150 }] } }), { fetch: makeFake().fetch, ledgerStore: store, now: clock().now });
    const gaps = store.files.get('mfc')!.range!.gaps!;
    expect(gaps).toHaveLength(2);
    expect(gaps).toEqual(
      expect.arrayContaining([
        { from: 1001, to: 1200, next: 1001, origin: 'reanchor', createdAt: iso(T0) },
        { from: 1100, to: 1150, next: 1100, origin: 'operator', createdAt: iso(T0) },
      ]),
    );
  });

  it('WARNs about a declared band naming a store that is not id-range walked, and adopts nothing', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      const store = createMemoryLedgerStore({ mfc: walkedLedger('mfc', { cursor: 900, frontier: 1000 }) });
      await runCrawlerPass(mkCfg({ rangeGaps: { orzgk: [{ from: 1, to: 9 }] } }), {
        fetch: makeFake().fetch,
        ledgerStore: store,
        now: clock().now,
      });
      expect(store.files.get('mfc')!.range!.gaps ?? []).toEqual([]);
      expect(warn.mock.calls.some((call) => String(call[0]).includes('CRAWLER_RANGE_GAPS'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('KNOWN-GAP SWEEP', () => {
  const band = (from: number, to: number, next = from, over: Partial<LedgerGapBand> = {}): LedgerGapBand => ({
    from,
    to,
    next,
    origin: 'reanchor',
    createdAt: iso(T0 - WEEK_MS),
    ...over,
  });

  /** A ledger whose descent is already at the floor, so ONLY the sweep moves. */
  const sweepOnly = (gaps: LedgerGapBand[], knownIds: string[] = []): Ledger =>
    walkedLedger('mfc', { cursor: 0, frontier: 1000, gaps }, knownIds);

  it('is OFF by default: no gap window is requested and the summary says why', async () => {
    const store = createMemoryLedgerStore({ mfc: sweepOnly([band(101, 110)]) });
    const fake = makeFake();
    const s = await runCrawlerPass(mkCfg(), { fetch: fake.fetch, ledgerStore: store, now: clock().now });
    expect(fake.rangeCalls()).toEqual([]);
    expect(s.stores[0]).toMatchObject({ gapSkipped: 'not-configured', gapIdsSwept: 0, gapBudgetApplied: 0, gapBandsOpen: 1, gapIdsRemaining: 10 });
  });

  it('sweeps the band ASCENDING from its low id and advances the band cursor over the ids handled', async () => {
    const store = createMemoryLedgerStore({ mfc: sweepOnly([band(101, 110)]) });
    const fake = makeFake();
    const s = await runCrawlerPass(mkCfg({ rangeGapBudget: 6, rangeIdsPerRun: 5 }), {
      fetch: fake.fetch,
      ledgerStore: store,
      now: clock().now,
    });
    // ONE window per iteration, each asked for as the engine serves them (descending from the top of
    // the slice) and walked ascending: 101..105, then the budget allows one more id, 106.
    expect(fake.rangeCalls()).toEqual([
      [105, 5],
      [106, 1],
    ]);
    expect(fake.postedIds()).toEqual(['101', '102', '103', '104', '105', '106']);
    expect(openBands(store.files.get('mfc')!)[0]).toMatchObject({ from: 101, to: 110, next: 107 });
    expect(s.stores[0]).toMatchObject({ gapIdsSwept: 6, gapEnqueued: 6, gapBandsOpen: 1, gapIdsRemaining: 4, gapSkipped: null, gapBudgetApplied: 6 });
  });

  it('closes a band once its last id is swept and moves on to the next one, oldest band first', async () => {
    const older = band(101, 103, 101, { createdAt: iso(T0 - 2 * WEEK_MS) });
    const newer = band(201, 203, 201, { createdAt: iso(T0 - WEEK_MS) });
    const store = createMemoryLedgerStore({ mfc: sweepOnly([newer, older]) });
    const fake = makeFake();
    const s = await runCrawlerPass(mkCfg({ rangeGapBudget: 4, rangeIdsPerRun: 5 }), {
      fetch: fake.fetch,
      ledgerStore: store,
      now: clock().now,
    });
    expect(fake.postedIds()).toEqual(['101', '102', '103', '201']);
    const gaps = store.files.get('mfc')!.range!.gaps!;
    expect(gaps.find((b) => b.from === 101)).toMatchObject({ next: 104, closedAt: iso(T0) });
    // Still OPEN: `toMatchObject` would demand the key exist, and an open band simply has no `closedAt`.
    expect(gaps.find((b) => b.from === 201)!.next).toBe(202);
    expect(gaps.find((b) => b.from === 201)!.closedAt).toBeUndefined();
    expect(s.stores[0]).toMatchObject({ gapIdsSwept: 4, gapBandsOpen: 1, gapIdsRemaining: 2 });
  });

  it('known ids cost no POST but still advance the band cursor', async () => {
    const store = createMemoryLedgerStore({ mfc: sweepOnly([band(101, 105)], ['101', '102']) });
    const fake = makeFake();
    const s = await runCrawlerPass(mkCfg({ rangeGapBudget: 10, rangeIdsPerRun: 5 }), {
      fetch: fake.fetch,
      ledgerStore: store,
      now: clock().now,
    });
    expect(fake.postedIds()).toEqual(['103', '104', '105']);
    expect(store.files.get('mfc')!.range!.gaps![0]).toMatchObject({ next: 106, closedAt: iso(T0) });
    expect(s.stores[0]).toMatchObject({ gapIdsSwept: 5, gapEnqueued: 3, known: 2, gapBandsOpen: 0, gapIdsRemaining: 0 });
  });

  it('spends its OWN budget: a discovery cap already spent by the descent does not starve it', async () => {
    const store = createMemoryLedgerStore({ mfc: walkedLedger('mfc', { cursor: 900, frontier: 1000, gaps: [band(101, 110)] }) });
    const fake = makeFake();
    const s = await runCrawlerPass(mkCfg({ maxEnqueuePerStore: 2, rangeIdsPerRun: 5, rangeGapBudget: 3 }), {
      fetch: fake.fetch,
      ledgerStore: store,
      now: clock().now,
    });
    // The descent got its 2 (the store cap), the sweep its 3 (its own budget) — neither starved the other.
    expect(fake.postedIds()).toEqual(['900', '899', '101', '102', '103']);
    expect(s.stores[0]).toMatchObject({ enqueued: 2, capApplied: 2, gapEnqueued: 3, gapIdsSwept: 3, gapBudgetApplied: 3 });
  });

  it('a budget that cuts a window short leaves the rest of the band for the next run', async () => {
    const store = createMemoryLedgerStore({ mfc: sweepOnly([band(101, 120)]) });
    const c = clock();
    const cfg = mkCfg({ rangeGapBudget: 3, rangeIdsPerRun: 10 });
    const first = await runCrawlerPass(cfg, { fetch: makeFake().fetch, ledgerStore: store, now: c.now });
    expect(first.stores[0]).toMatchObject({ gapIdsSwept: 3, gapIdsRemaining: 17 });
    expect(openBands(store.files.get('mfc')!)[0].next).toBe(104);

    c.advance(HOUR_MS);
    const fake = makeFake();
    const second = await runCrawlerPass(cfg, { fetch: fake.fetch, ledgerStore: store, now: c.now });
    expect(fake.postedIds()).toEqual(['104', '105', '106']);
    expect(second.stores[0]).toMatchObject({ gapIdsSwept: 3, gapIdsRemaining: 14 });
  });

  it('keeps the band cursor when the engine serves a window that is not the requested descending run', async () => {
    const store = createMemoryLedgerStore({ mfc: sweepOnly([band(101, 110)]) });
    const rows: FetchFailureReport[] = [];
    const fake = makeFake({
      // A window SHORT of the slice's bottom: advancing over it would silently strand 101.
      range: (siteId, from) => ({ status: 200, body: rangeBody(siteId, from, 3) }),
    });
    const s = await runCrawlerPass(mkCfg({ rangeGapBudget: 5, rangeIdsPerRun: 5 }), {
      fetch: fake.fetch,
      ledgerStore: store,
      now: clock().now,
      reportFailure: async (r) => {
        rows.push(r);
      },
    });
    expect(fake.posted()).toEqual([]);
    expect(openBands(store.files.get('mfc')!)[0].next).toBe(101);
    expect(s.stores[0]).toMatchObject({ gapSkipped: 'window-malformed', gapIdsSwept: 0, errors: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ site: 'mfc', kind: 'listing', origin: 'crawler', reasonClass: 'ruleset' });
    expect(rows[0].target).toContain('axis=gap');
  });

  it('keeps the band cursor when every id in the window is refused by ingest, and files the window row', async () => {
    const store = createMemoryLedgerStore({ mfc: sweepOnly([band(101, 110)]) });
    const rows: FetchFailureReport[] = [];
    const fake = makeFake({ ingest: () => refused() });
    const s = await runCrawlerPass(mkCfg({ rangeGapBudget: 5, rangeIdsPerRun: 5 }), {
      fetch: fake.fetch,
      ledgerStore: store,
      now: clock().now,
      reportFailure: async (r) => {
        rows.push(r);
      },
    });
    expect(openBands(store.files.get('mfc')!)[0].next).toBe(101);
    expect(s.stores[0]).toMatchObject({ gapEnqueued: 0, gapIdsSwept: 0, gapSkipped: 'window-rejected' });
    // Five per-id RECORD rows, then ONE window row naming the band.
    expect(rows.filter((r) => r.kind === 'record')).toHaveLength(5);
    expect(rows.filter((r) => r.kind === 'listing' && r.target.includes('axis=gap'))).toHaveLength(1);
  });

  it('a window of known ids plus ONE refusal advances past it instead of stalling on it every run', async () => {
    // 800..803 are already in the ledger (the tap wrote them) and 804 is refused. A re-anchor band has
    // that shape by construction, so holding the cursor here would re-drive 804 on every run.
    const store = createMemoryLedgerStore({ mfc: sweepOnly([band(800, 804)], ['800', '801', '802', '803']) });
    const cfg = mkCfg({ rangeGapBudget: 5, rangeIdsPerRun: 5 });
    const ingest = (url: string): Reply => (url.endsWith('/804') ? refused() : accepted());
    const c = clock();
    const f1 = makeFake({ ingest });
    const s1 = await runCrawlerPass(cfg, { fetch: f1.fetch, ledgerStore: store, now: c.now });
    expect(f1.postedIds()).toEqual(['804']);
    expect(store.files.get('mfc')!.range!.gaps![0]).toMatchObject({ next: 805, closedAt: iso(T0) });
    expect(s1.stores[0]).toMatchObject({ gapIdsSwept: 5, gapEnqueued: 0, errors: 1, gapSkipped: null });

    c.advance(HOUR_MS);
    const f2 = makeFake({ ingest });
    const s2 = await runCrawlerPass(cfg, { fetch: f2.fetch, ledgerStore: store, now: c.now });
    expect(f2.calls).toEqual([]);
    expect(s2.stores[0]).toMatchObject({ gapSkipped: 'no-gap', gapBandsOpen: 0 });
  });

  it('the DRY RUN prints the band widths and enqueues nothing at all', async () => {
    const info = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    try {
      const store = createMemoryLedgerStore({ mfc: sweepOnly([band(101, 110)]) });
      const fake = makeFake();
      const s = await runCrawlerPass(mkCfg({ rangeGapBudget: 5, rangeGapDryRun: true }), {
        fetch: fake.fetch,
        ledgerStore: store,
        now: clock().now,
      });
      expect(fake.rangeCalls()).toEqual([]);
      expect(fake.posted()).toEqual([]);
      expect(openBands(store.files.get('mfc')!)[0].next).toBe(101);
      expect(s.stores[0]).toMatchObject({ gapSkipped: 'dry-run', gapIdsSwept: 0, gapBandsOpen: 1, gapIdsRemaining: 10 });
      const line = info.mock.calls.find((call) => String(call[0]).includes('gap sweep DRY RUN'));
      expect(line).toBeDefined();
      expect(line![1]).toMatchObject({ siteId: 'mfc', bandsOpen: 1, idsRemaining: 10 });
    } finally {
      info.mockRestore();
    }
  });

  it('introduces NO new url shape: every gap request is the byId id-range window the descent already uses', async () => {
    const store = createMemoryLedgerStore({ mfc: sweepOnly([band(101, 103)]) });
    const fake = makeFake();
    await runCrawlerPass(mkCfg({ rangeGapBudget: 5, rangeIdsPerRun: 5 }), { fetch: fake.fetch, ledgerStore: store, now: clock().now });
    // The descent is at the floor, so this window is the sweep's own: a sweep that fetched nothing fails here.
    expect(fake.catalogUrls()).toEqual(['http://scraper.test/catalog?store=mfc&range=1&from=103&count=3']);
    expect(fake.postedIds()).toEqual(['101', '102', '103']);
    for (const url of fake.catalogUrls()) {
      expect(url).toMatch(/^http:\/\/scraper\.test\/catalog\?store=mfc&range=1&from=\d+&count=\d+$/);
    }
    for (const url of fake.posted()) expect(url).toMatch(/^https:\/\/mfc\.test\/item\/\d+$/);
  });

  it('a cooling host stops the sweep as well as the descent — same store, same egress', async () => {
    const store = createMemoryLedgerStore({ mfc: walkedLedger('mfc', { cursor: 900, frontier: 1000, gaps: [band(101, 110)] }) });
    const fake = makeFake({ range: (siteId) => cooldown(siteId) });
    const s = await runCrawlerPass(mkCfg({ rangeGapBudget: 5 }), { fetch: fake.fetch, ledgerStore: store, now: clock().now });
    expect(fake.rangeCalls()).toEqual([[900, 5]]);
    expect(s.stores[0]).toMatchObject({ rangeSkipped: 'cooldown', gapSkipped: 'store-stopped', gapIdsSwept: 0 });
  });

  it('a sick scraper mid-sweep stops the lane and keeps the band cursor at the last id handled', async () => {
    const store = createMemoryLedgerStore({ mfc: sweepOnly([band(101, 110)]) });
    const fake = makeFake({ ingest: (url) => (url.endsWith('/103') ? sick() : accepted()) });
    const s = await runCrawlerPass(mkCfg({ rangeGapBudget: 8, rangeIdsPerRun: 5 }), {
      fetch: fake.fetch,
      ledgerStore: store,
      now: clock().now,
    });
    expect(fake.postedIds()).toEqual(['101', '102', '103']);
    expect(openBands(store.files.get('mfc')!)[0].next).toBe(103);
    expect(s.stores[0]).toMatchObject({ gapIdsSwept: 2, gapEnqueued: 2 });
  });

  it('a spent GLOBAL budget stops the sweep and says so rather than reading as an empty gap list', async () => {
    const store = createMemoryLedgerStore({ mfc: sweepOnly([band(101, 110)]) });
    const fake = makeFake();
    // 1 GET for the window + 2 POSTs, then the gate is out.
    const s = await runCrawlerPass(mkCfg({ rangeGapBudget: 5, rangeIdsPerRun: 5, maxRequests: 3 }), {
      fetch: fake.fetch,
      ledgerStore: store,
      now: clock().now,
    });
    expect(fake.postedIds()).toEqual(['101', '102']);
    expect(s.stores[0]).toMatchObject({ gapSkipped: 'budget', gapIdsSwept: 2 });
    expect(s.budgetExhausted).toBe(true);
  });

  it('reports the sweep separately from discovery so neither counter claims the other lane work', async () => {
    const store = createMemoryLedgerStore({ mfc: walkedLedger('mfc', { cursor: 900, frontier: 1000, gaps: [band(101, 110)] }) });
    const s = await runCrawlerPass(mkCfg({ rangeIdsPerRun: 5, maxEnqueuePerStore: 5, rangeGapBudget: 4 }), {
      fetch: makeFake().fetch,
      ledgerStore: store,
      now: clock().now,
    });
    // `enqueued` stays what `capApplied` bounds; the sweep's POSTs live in `gapEnqueued` alone.
    expect(s.stores[0]).toMatchObject({ enqueued: 5, capApplied: 5, rangeWalked: 5, gapEnqueued: 4, gapIdsSwept: 4 });
    expect(s.totalGapIdsSwept).toBe(4);
    expect(s.totalGapEnqueued).toBe(4);
    expect(s.totalEnqueued).toBe(5);
  });

  it('a failing gap window GET stops the sweep on ITS OWN reason, not the descent one', async () => {
    const store = createMemoryLedgerStore({ mfc: sweepOnly([band(101, 110)]) });
    const fake = makeFake({ range: (siteId) => cooldown(siteId) });
    const s = await runCrawlerPass(mkCfg({ rangeGapBudget: 5, rangeIdsPerRun: 5 }), {
      fetch: fake.fetch,
      ledgerStore: store,
      now: clock().now,
    });
    // The descent is at the floor, so this 503 can only be the SWEEP's window.
    expect(fake.rangeCalls()).toEqual([[105, 5]]);
    expect(openBands(store.files.get('mfc')!)[0].next).toBe(101);
    expect(s.stores[0]).toMatchObject({ rangeSkipped: 'floor', gapSkipped: 'cooldown', gapIdsSwept: 0, skipped: 1 });
  });

  it('a global budget spent on the window GET itself moves nothing and reports budget, not an empty band list', async () => {
    const store = createMemoryLedgerStore({ mfc: sweepOnly([band(101, 110)]) });
    const fake = makeFake();
    // Exactly one request: the window GET. The first POST then finds the gate empty.
    const s = await runCrawlerPass(mkCfg({ rangeGapBudget: 5, rangeIdsPerRun: 5, maxRequests: 1 }), {
      fetch: fake.fetch,
      ledgerStore: store,
      now: clock().now,
    });
    expect(fake.posted()).toEqual([]);
    expect(openBands(store.files.get('mfc')!)[0].next).toBe(101);
    expect(s.stores[0]).toMatchObject({ gapSkipped: 'budget', gapIdsSwept: 0, gapEnqueued: 0 });
  });

  it('a ledger save that fails mid-sweep stops the lane and restores the band the DISK holds', async () => {
    const store = createMemoryLedgerStore({ mfc: sweepOnly([band(101, 110)]) });
    let saves = 0;
    const failing = {
      ...store,
      save: async (l: Ledger) => {
        saves++;
        if (saves > 1) throw new Error('PVC full');
        await store.save(l);
      },
    };
    const fake = makeFake();
    // Two windows of 2: the first save lands, the second is refused.
    const s = await runCrawlerPass(mkCfg({ rangeGapBudget: 4, rangeIdsPerRun: 2 }), {
      fetch: fake.fetch,
      ledgerStore: failing,
      now: clock().now,
    });
    expect(fake.postedIds()).toEqual(['101', '102', '103', '104']);
    // The band the next run resumes from is the one that reached the disk, not the one in memory.
    expect(openBands(store.files.get('mfc')!)[0].next).toBe(103);
    expect(s.stores[0]).toMatchObject({ gapSkipped: 'failed', errors: 1 });
  });

  it('ids already in the ledger consume the run allowance too — a covered band cannot eat the global budget in window GETs', async () => {
    const store = createMemoryLedgerStore({ mfc: sweepOnly([band(101, 110)], ['101', '102']) });
    const fake = makeFake();
    const s = await runCrawlerPass(mkCfg({ rangeGapBudget: 3, rangeIdsPerRun: 2 }), {
      fetch: fake.fetch,
      ledgerStore: store,
      now: clock().now,
    });
    // 101 and 102 cost no POST, but they are still 2 of the run's 3 ids: the sweep asks for ONE more
    // window of 1 and stops. Without that, a band the tap had already covered would keep asking.
    expect(fake.rangeCalls()).toEqual([
      [102, 2],
      [103, 1],
    ]);
    expect(fake.postedIds()).toEqual(['103']);
    expect(s.stores[0]).toMatchObject({ gapSkipped: null, gapIdsSwept: 3, gapEnqueued: 1, gapIdsRemaining: 7 });
  });

  it('refuses an EMPTY gap window as malformed rather than closing the band on it', async () => {
    const store = createMemoryLedgerStore({ mfc: sweepOnly([band(101, 110)]) });
    const fake = makeFake({ range: (siteId) => ({ status: 200, body: { siteId, from: 105, items: [], collectUrls: [], hasMore: false, count: 0 } }) });
    const s = await runCrawlerPass(mkCfg({ rangeGapBudget: 5, rangeIdsPerRun: 5 }), {
      fetch: fake.fetch,
      ledgerStore: store,
      now: clock().now,
    });
    expect(openBands(store.files.get('mfc')!)[0].next).toBe(101);
    expect(s.stores[0]).toMatchObject({ gapSkipped: 'window-malformed', gapIdsSwept: 0 });
  });

  it('two bands created in the same instant are swept lowest id first — a stable order, never an arbitrary one', async () => {
    const store = createMemoryLedgerStore({ mfc: sweepOnly([band(301, 302), band(201, 202)]) });
    const fake = makeFake();
    await runCrawlerPass(mkCfg({ rangeGapBudget: 4, rangeIdsPerRun: 5 }), { fetch: fake.fetch, ledgerStore: store, now: clock().now });
    expect(fake.postedIds()).toEqual(['201', '202', '301', '302']);
  });

  it('the DRY RUN truncates a long band list rather than printing every band', async () => {
    const info = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    try {
      const many = Array.from({ length: 25 }, (_, i) => band(1000 + i * 10, 1000 + i * 10 + 1));
      const store = createMemoryLedgerStore({ mfc: sweepOnly(many) });
      await runCrawlerPass(mkCfg({ rangeGapBudget: 5, rangeGapDryRun: true }), {
        fetch: makeFake().fetch,
        ledgerStore: store,
        now: clock().now,
      });
      const line = info.mock.calls.find((call) => String(call[0]).includes('gap sweep DRY RUN'))!;
      expect(line[1]).toMatchObject({ bandsOpen: 25, truncated: true });
      expect((line[1] as { bands: unknown[] }).bands).toHaveLength(20);
    } finally {
      info.mockRestore();
    }
  });

  it('a store with no open band asks for no window and says so', async () => {
    const store = createMemoryLedgerStore({ mfc: sweepOnly([band(101, 103, 104, { closedAt: iso(T0 - HOUR_MS) })]) });
    const fake = makeFake();
    const s = await runCrawlerPass(mkCfg({ rangeGapBudget: 5 }), { fetch: fake.fetch, ledgerStore: store, now: clock().now });
    expect(fake.rangeCalls()).toEqual([]);
    expect(s.stores[0]).toMatchObject({ gapSkipped: 'no-gap', gapBandsOpen: 0, gapIdsRemaining: 0 });

    // And a store that has no `gaps` section at all — the shape every ledger has until the first
    // re-anchor — is the same quiet answer, not a missing-field failure.
    const virgin = createMemoryLedgerStore({ mfc: walkedLedger('mfc', { cursor: 0, frontier: 1000 }) });
    const s2 = await runCrawlerPass(mkCfg({ rangeGapBudget: 5 }), { fetch: makeFake().fetch, ledgerStore: virgin, now: clock().now });
    expect(s2.stores[0]).toMatchObject({ gapSkipped: 'no-gap', gapBandsOpen: 0, errors: 0 });
  });

  it('a band CLOSED early by hand is abandoned, not resumed — the operator lever for dropping a band', async () => {
    // `closedAt` set while `next` is still inside the band: an operator on the PVC deciding a band is
    // not worth finishing. It must stop being swept AND stop counting as backlog.
    const abandoned = band(101, 110, 104, { closedAt: iso(T0 - HOUR_MS) });
    const store = createMemoryLedgerStore({ mfc: sweepOnly([abandoned]) });
    const fake = makeFake();
    const s = await runCrawlerPass(mkCfg({ rangeGapBudget: 5 }), { fetch: fake.fetch, ledgerStore: store, now: clock().now });
    expect(fake.rangeCalls()).toEqual([]);
    expect(s.stores[0]).toMatchObject({ gapSkipped: 'no-gap', gapBandsOpen: 0, gapIdsRemaining: 0, gapIdsSwept: 0 });
  });

  it('a corrupt ledger refuses BOTH id-range axes — no re-anchor, no sweep, the file left untouched', async () => {
    const store = createMemoryLedgerStore({ mfc: 'corrupt' });
    const fake = makeFake();
    const s = await runCrawlerPass(mkCfg({ rangeGapBudget: 50, rangeGaps: { mfc: [{ from: 101, to: 110 }] } }), {
      fetch: fake.fetch,
      ledgerStore: store,
      now: clock().now,
    });
    expect(fake.calls).toEqual([]);
    expect(store.saveLog).toEqual([]);
    expect(s.stores[0]).toMatchObject({ ledgerCorrupt: true, rangeSkipped: 'store-stopped', gapSkipped: 'store-stopped', rangeReanchoredTo: null });
  });

  it('a store that is not id-range walked never sweeps, whatever the budget', async () => {
    const store = createMemoryLedgerStore({ mfc: sweepOnly([band(101, 110)]) });
    const fake = makeFake();
    const s = await runCrawlerPass(mkCfg({ rangeStores: [], rangeGapBudget: 50 }), {
      fetch: fake.fetch,
      ledgerStore: store,
      now: clock().now,
    });
    expect(fake.rangeCalls()).toEqual([]);
    expect(s.stores[0]).toMatchObject({ gapSkipped: 'not-configured', rangeSkipped: 'not-configured', gapIdsSwept: 0 });
  });
});
