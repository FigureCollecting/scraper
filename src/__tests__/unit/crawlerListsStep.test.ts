/**
 * runCrawlerPass — the ROTATING COMPANY-LISTS step (Ross 2026-09-22/25/26).
 *
 * Inside the id-range phase, AFTER the recent-gap sweep (origin 'reanchor' bands) and BEFORE the
 * older-gap sweep (origin 'operator') and the archive descent. Per pass: at most ONE group (all its
 * lists, >= 10 s apart), only inside CRAWLER_LISTS_WINDOW_UTC, each group at most once per
 * CRAWLER_LISTS_INTERVAL_H, the next group = the first by `order` whose last attempt is absent or
 * older than the interval. The group's ids are UNIONed and deduped, ids the ledger knows or the
 * backlog already holds (another group's copy) are dropped, and the rest drain on
 * CRAWLER_LISTS_DRAIN_CAPS, POSTed COLD so a tap or recent-gap id never waits behind them.
 *
 * Every test drives a MOCKED http surface, in-memory ledger and lists-state stores, and a fake clock.
 */
import { runCrawlerPass, type CrawlerConfig, type FetchLike, type HttpResponseLike } from '../../crawler/crawler';
import { createMemoryLedgerStore, createEmptyLedger, type Ledger, type LedgerGapBand } from '../../crawler/ledger';
import { createMemoryListsStateStore, createEmptyListsState, type ListsState } from '../../crawler/listsState';
import type { FetchFailureReport } from '../../services/failureReporter';
import { logger } from '../../utils/logger';

const HOUR_MS = 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * HOUR_MS;
/** 16:00Z — inside the 15:30-22:30 window. */
const T0 = Date.parse('2026-09-26T16:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const item = (id: string): string => `https://mfc.test/item/${id}`;

const mkCfg = (over: Partial<CrawlerConfig> = {}): CrawlerConfig => ({
  scraperServiceUrl: 'http://scraper.test',
  mode: 'backfill',
  phases: ['backfill'],
  stores: ['mfc'],
  ledgerDir: '/unused',
  recentMaxPages: 1,
  backfillPagesPerRun: 0,
  maxRequests: 500,
  maxEnqueuePerStore: 50,
  maxConcurrency: 1,
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
  listsWindow: { startMin: 15 * 60 + 30, endMin: 22 * 60 + 30 },
  listsIntervalMs: 160 * HOUR_MS,
  listsDrainCaps: { mfc: 200 },
  listsSpacingMs: 10_000,
  ...over,
});

interface Reply {
  status: number;
  body?: unknown;
  throwErr?: boolean;
}

/** Three companies declared OUT of rotation order: order, not array position, decides who goes first. */
const DECL = [
  { id: 'c3-d9', url: 'https://mfc.test/s?e=3&d=9', group: 'c3', order: 3 },
  { id: 'c1-d9', url: 'https://mfc.test/s?e=1&d=9', group: 'c1', order: 1 },
  { id: 'c1-d1', url: 'https://mfc.test/s?e=1&d=1', group: 'c1', order: 1 },
  { id: 'c2-d9', url: 'https://mfc.test/s?e=2&d=9', group: 'c2', order: 2 },
  { id: 'c2-d1', url: 'https://mfc.test/s?e=2&d=1', group: 'c2', order: 2 },
];

const listOk = (ids: string[]): Reply => ({
  status: 200,
  body: { siteId: 'mfc', items: ids.map((id) => ({ itemId: id, collectUrl: item(id) })), collectUrls: ids.map(item), hasMore: false, count: ids.length },
});
const listFail = (failure: 'deterministic' | 'transient', reason: string, extra: Record<string, unknown> = {}): Reply => ({
  status: 502,
  body: { error: 'catalog failed', siteId: 'mfc', reason, failure, ...extra },
});
const cooldown = (): Reply => ({ status: 503, body: { error: 'cooldown', siteId: 'mfc', host: 'mfc.test', remainingMs: 60_000 } });
const accepted = (): Reply => ({ status: 202, body: { success: true, deduplicated: false, position: 1 } });

/** Default list contents: c1's two domain lists overlap on 102; c2 repeats c1's 101 (a distributor list). */
const DEFAULT_LISTS: Record<string, string[]> = {
  'c1-d9': ['101', '102', '103'],
  'c1-d1': ['102', '104'],
  'c2-d9': ['101', '201'],
  'c2-d1': ['202'],
  'c3-d9': ['301'],
};

interface FakeOpts {
  discovery?: () => Reply;
  list?: (listId: string) => Reply;
  range?: (from: number, count: number) => Reply;
  listing?: () => Reply;
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
    const u = new URL(url);
    let r: Reply;
    if (u.pathname === '/catalog/rotating') {
      const list = u.searchParams.get('list');
      r =
        list === null
          ? (opts.discovery ?? (() => ({ status: 200, body: { siteId: 'mfc', rotatingSeedLists: DECL, count: DECL.length } })))()
          : (opts.list ?? ((id: string) => listOk(DEFAULT_LISTS[id] ?? [])))(list);
    } else if (u.pathname === '/catalog' && u.searchParams.get('range') === '1') {
      const from = Number(u.searchParams.get('from'));
      const count = Number(u.searchParams.get('count'));
      r = opts.range
        ? opts.range(from, count)
        : (() => {
            const ids: string[] = [];
            for (let id = from; id > from - count && id >= 1; id--) ids.push(String(id));
            return { status: 200, body: { items: ids.map((id) => ({ itemId: id, collectUrl: item(id) })), hasMore: true } };
          })();
    } else if (u.pathname === '/catalog') {
      r = (opts.listing ?? (() => ({ status: 200, body: { items: [], hasMore: false } })))();
    } else {
      r = (opts.ingest ?? accepted)(body?.url);
    }
    if (r.throwErr) throw new Error('network down');
    return resp(r.status, r.body ?? {});
  };
  return {
    fetch,
    calls,
    listGets: () => calls.filter((c) => c.url.includes('/catalog/rotating?') && c.url.includes('list=')).map((c) => new URL(c.url).searchParams.get('list')),
    discoveryGets: () => calls.filter((c) => c.url.includes('/catalog/rotating') && !c.url.includes('list=')).length,
    posts: () => calls.filter((c) => c.method === 'POST').map((c) => ({ id: String(c.body.url).split('/').pop(), priority: c.body.priority })),
  };
};

const clock = (start = T0) => {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
};

/** A ledger whose descent is at the floor (cursor 0), so only the lanes under test move. */
const ledger = (known: string[] = [], range: Ledger['range'] = { cursor: 0, frontier: 1000 }): Ledger => ({
  ...createEmptyLedger('mfc'),
  enqueued: Object.fromEntries(known.map((id) => [id, { at: iso(T0 - WEEK_MS), collectUrl: item(id) }])),
  range,
});

const run = async (
  cfg: CrawlerConfig,
  fake: ReturnType<typeof makeFake>,
  stores: { ledgers?: ReturnType<typeof createMemoryLedgerStore>; lists?: ReturnType<typeof createMemoryListsStateStore> } = {},
  c = clock(),
  report?: (r: FetchFailureReport) => void,
) => {
  const ledgers = stores.ledgers ?? createMemoryLedgerStore({ mfc: ledger() });
  const lists = stores.lists ?? createMemoryListsStateStore();
  const summary = await runCrawlerPass(cfg, {
    fetch: fake.fetch,
    ledgerStore: ledgers,
    listsStore: lists,
    now: c.now,
    sleep: c.sleep,
    ...(report ? { reportFailure: async (r: FetchFailureReport) => report(r) } : {}),
  });
  return { summary, s: summary.stores[0], ledgers, lists, c };
};

let warn: jest.SpyInstance;
beforeEach(() => {
  warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  jest.spyOn(logger, 'info').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('lists step — OFF unless configured', () => {
  it('a store with no drain cap costs no request and never opens its lists state', async () => {
    const fake = makeFake();
    const lists = createMemoryListsStateStore();
    const loadSpy = jest.spyOn(lists, 'load');
    const { s } = await run(mkCfg({ listsDrainCaps: {} }), fake, { lists });
    expect(fake.discoveryGets()).toBe(0);
    expect(loadSpy).not.toHaveBeenCalled();
    expect(s).toMatchObject({ listsSkipped: 'not-configured', listsDrainApplied: 0, listsPending: null, listsGroup: null });
  });

  it('a hand-built config with a window and a drain cap but no interval or spacing uses 160 h and 10 s', async () => {
    const cfg = mkCfg();
    delete cfg.listsIntervalMs;
    delete cfg.listsSpacingMs;
    const lists = createMemoryListsStateStore({
      mfc: {
        ...createEmptyListsState('mfc'),
        groups: { c1: { lastAttemptAt: iso(T0 - 159 * HOUR_MS), lastTriedAt: iso(T0 - 159 * HOUR_MS), outcome: 'ok', seen: 0, new: 0, enqueued: 0, strikes: 0, retries: 0 } },
      },
    });
    const c = clock();
    const fake = makeFake();
    await run(cfg, fake, { lists }, c);
    expect(fake.listGets()).toEqual(['c2-d9', 'c2-d1']);
    expect(c.sleeps).toEqual([10_000]);
  });

  it('a hand-built config without the lists knobs is off too', async () => {
    const cfg = mkCfg();
    delete cfg.listsDrainCaps;
    delete cfg.listsWindow;
    delete cfg.listsIntervalMs;
    delete cfg.listsSpacingMs;
    const fake = makeFake();
    const { s } = await run(cfg, fake);
    expect(fake.discoveryGets()).toBe(0);
    expect(s.listsSkipped).toBe('not-configured');
  });

  it('WARNs about a drain cap naming a store that is not id-range walked, and runs no lists step for it', async () => {
    const fake = makeFake();
    const { s } = await run(mkCfg({ rangeStores: [], listsDrainCaps: { mfc: 5, ghost: 5 } }), fake);
    expect(fake.discoveryGets()).toBe(0);
    expect(s.listsSkipped).toBe('not-configured');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('CRAWLER_LISTS_DRAIN_CAPS names a store that is not id-range walked'), { siteId: 'mfc' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('CRAWLER_LISTS_DRAIN_CAPS names a store that is not id-range walked'), { siteId: 'ghost' });
  });

  it('with no window no list is fetched, outside the window neither — but the backlog still drains', async () => {
    const backlog: ListsState = {
      ...createEmptyListsState('mfc'),
      pending: [{ itemId: '9', collectUrl: item('9'), group: 'c1' }],
    };
    for (const [cfg, reason, at] of [
      [mkCfg({ listsWindow: null }), 'window-off', T0],
      [mkCfg(), 'outside-window', Date.parse('2026-09-26T23:00:00.000Z')],
      [mkCfg({ listsWindow: { startMin: 22 * 60, endMin: 2 * 60 } }), 'outside-window', Date.parse('2026-09-26T03:00:00.000Z')],
    ] as const) {
      const fake = makeFake();
      const { s } = await run(cfg, fake, { lists: createMemoryListsStateStore({ mfc: backlog }) }, clock(at));
      expect(fake.discoveryGets()).toBe(0);
      expect(fake.posts()).toEqual([{ id: '9', priority: 'COLD' }]);
      expect(s).toMatchObject({ listsSkipped: reason, listsEnqueued: 1, listsPending: 0, listsDrainApplied: 200 });
    }
  });

  it('a window wrapping midnight is open after its start and before its end', async () => {
    const cfg = mkCfg({ listsWindow: { startMin: 22 * 60, endMin: 2 * 60 } });
    for (const at of ['2026-09-26T23:30:00.000Z', '2026-09-27T01:59:00.000Z']) {
      const fake = makeFake();
      await run(cfg, fake, {}, clock(Date.parse(at)));
      expect(fake.listGets()).toEqual(['c1-d9', 'c1-d1']);
    }
  });
});

describe('lists step — one group per pass', () => {
  it('fetches the FIRST group by order, both its lists 10 s apart, unions and dedupes them, and drains the rest COLD', async () => {
    const fake = makeFake();
    const c = clock();
    const { s, lists, summary } = await run(mkCfg(), fake, { ledgers: createMemoryLedgerStore({ mfc: ledger(['103']) }) }, c);
    expect(fake.listGets()).toEqual(['c1-d9', 'c1-d1']);
    expect(c.sleeps).toEqual([10_000]);
    // 101,102,103 ∪ 102,104 = 4 distinct; 103 is already in the ledger.
    expect(fake.posts()).toEqual([
      { id: '101', priority: 'COLD' },
      { id: '102', priority: 'COLD' },
      { id: '104', priority: 'COLD' },
    ]);
    expect(s).toMatchObject({
      listsGroup: 'c1',
      listsOutcome: 'ok',
      listsFetched: 2,
      listsFailed: 0,
      listsIdsSeen: 4,
      listsIdsNew: 3,
      listsEnqueued: 3,
      listsPending: 0,
      listsSkipped: null,
      listsDrainStopped: null,
      enqueued: 0,
    });
    expect(summary.totalListsEnqueued).toBe(3);
    expect(lists.files.get('mfc')!.groups.c1).toEqual({
      lastAttemptAt: iso(T0),
      lastTriedAt: iso(T0),
      outcome: 'ok',
      seen: 4,
      new: 3,
      enqueued: 3,
      strikes: 0,
      retries: 0,
    });
  });

  it('drops ids another group already queued this cycle (the cross-company copy)', async () => {
    const lists = createMemoryListsStateStore({
      mfc: {
        ...createEmptyListsState('mfc'),
        groups: { c1: { lastAttemptAt: iso(T0 - HOUR_MS), lastTriedAt: iso(T0 - HOUR_MS), outcome: 'ok', seen: 4, new: 1, enqueued: 0, strikes: 0, retries: 0 } },
        pending: [{ itemId: '101', collectUrl: item('101'), group: 'c1' }],
      },
    });
    const fake = makeFake();
    const { s } = await run(mkCfg({ listsDrainCaps: { mfc: 1 } }), fake, { lists });
    // c1 is not due (1 h old); c2 offers 101 (queued by c1), 201, 202.
    expect(fake.listGets()).toEqual(['c2-d9', 'c2-d1']);
    expect(s).toMatchObject({ listsGroup: 'c2', listsIdsSeen: 3, listsIdsNew: 2, listsEnqueued: 1, listsPending: 2 });
    expect(lists.files.get('mfc')!.pending.map((p) => [p.itemId, p.group])).toEqual([
      ['201', 'c2'],
      ['202', 'c2'],
    ]);
    // The drained id is credited to the group that queued it.
    expect(lists.files.get('mfc')!.groups.c1.enqueued).toBe(1);
  });

  it('rotates: each pass takes the next due group, and a group is polled again only once the interval has passed', async () => {
    const lists = createMemoryListsStateStore();
    const ledgers = createMemoryLedgerStore({ mfc: ledger() });
    // An all-day window, so only the interval decides.
    const cfg = mkCfg({ listsWindow: { startMin: 0, endMin: 23 * 60 + 59 } });
    const order: (string | null)[] = [];
    for (let pass = 0; pass < 4; pass++) {
      const { s } = await run(cfg, makeFake(), { lists, ledgers }, clock(T0 + pass * HOUR_MS));
      order.push(s.listsGroup);
      if (pass === 3) expect(s.listsSkipped).toBe('none-due');
    }
    expect(order).toEqual(['c1', 'c2', 'c3', null]);
    // One minute short of 160 h after c1's first request nothing is due; at 160 h c1 is.
    const early = clock(T0 + 160 * HOUR_MS - 60_000);
    expect((await run(cfg, makeFake(), { lists, ledgers }, early)).s.listsSkipped).toBe('none-due');
    const onTime = clock(T0 + 160 * HOUR_MS);
    expect((await run(cfg, makeFake(), { lists, ledgers }, onTime)).s.listsGroup).toBe('c1');
  });

  it('a spread-out backlog drains across passes at the cap, oldest first', async () => {
    const lists = createMemoryListsStateStore();
    const ledgers = createMemoryLedgerStore({ mfc: ledger() });
    const c = clock();
    const first = await run(mkCfg({ listsDrainCaps: { mfc: 2 } }), makeFake(), { lists, ledgers }, c);
    expect(first.s).toMatchObject({ listsIdsNew: 4, listsEnqueued: 2, listsPending: 2 });
    c.advance(HOUR_MS);
    const fake = makeFake({ list: () => listOk([]) });
    const second = await run(mkCfg({ listsDrainCaps: { mfc: 2 } }), fake, { lists, ledgers }, c);
    expect(fake.posts().map((p) => p.id)).toEqual(['103', '104']);
    expect(second.s).toMatchObject({ listsEnqueued: 2, listsPending: 0 });
    expect(lists.files.get('mfc')!.groups.c1.enqueued).toBe(4);
  });

  it('a backlog id the ledger learned since (the tap got it) leaves without a request', async () => {
    const lists = createMemoryListsStateStore({
      mfc: { ...createEmptyListsState('mfc'), pending: [{ itemId: '7', collectUrl: item('7'), group: 'c1' }, { itemId: '8', collectUrl: item('8'), group: 'c1' }] },
    });
    const fake = makeFake();
    const { s } = await run(mkCfg({ listsWindow: null }), fake, { lists, ledgers: createMemoryLedgerStore({ mfc: ledger(['7']) }) });
    expect(fake.posts()).toEqual([{ id: '8', priority: 'COLD' }]);
    expect(s.listsPending).toBe(0);
  });

  it('a drain POST the scraper refuses leaves the backlog; a sick scraper keeps the rest for next pass', async () => {
    const fake = makeFake({ ingest: (url) => (url.endsWith('/101') ? { status: 422, body: {} } : url.endsWith('/104') ? { status: 503, body: {} } : accepted()) });
    const { s, lists } = await run(mkCfg(), fake);
    expect(fake.posts().map((p) => p.id)).toEqual(['101', '102', '103', '104']);
    expect(lists.files.get('mfc')!.pending.map((p) => p.itemId)).toEqual(['104']);
    expect(s).toMatchObject({ listsEnqueued: 2, listsDrainStopped: 'failed', listsPending: 1 });
  });
});

describe('lists step — failures', () => {
  it('a DETERMINISTIC failure on every list spends the slot, so the next pass moves on to the next group', async () => {
    const lists = createMemoryListsStateStore();
    const c = clock();
    const bad = makeFake({ list: (id) => (id.startsWith('c1') ? listFail('deterministic', 'company filter not proven') : listOk(DEFAULT_LISTS[id])) });
    const reports: FetchFailureReport[] = [];
    const first = await run(mkCfg(), bad, { lists }, c, (r) => reports.push(r));
    expect(bad.listGets()).toEqual(['c1-d9', 'c1-d1']);
    expect(first.s).toMatchObject({ listsGroup: 'c1', listsOutcome: 'failed', listsFetched: 0, listsFailed: 2, listsIdsNew: 0 });
    expect(lists.files.get('mfc')!.groups.c1).toMatchObject({ lastAttemptAt: iso(T0), outcome: 'failed', reason: 'company filter not proven', strikes: 1 });
    expect(reports).toHaveLength(2);
    expect(reports[0]).toMatchObject({ site: 'mfc', kind: 'listing', origin: 'crawler', reasonClass: 'parse', target: 'fc:listing/mfc?axis=lists&list=c1-d9' });

    c.advance(HOUR_MS);
    const next = makeFake();
    const second = await run(mkCfg(), next, { lists }, c);
    expect(second.s.listsGroup).toBe('c2');
  });

  it('one list failing deterministically still queues the other list: the outcome is partial and the slot is spent', async () => {
    const fake = makeFake({ list: (id) => (id === 'c1-d9' ? listFail('deterministic', 'store answered 404', { upstreamStatus: 404 }) : listOk(DEFAULT_LISTS[id])) });
    const reports: FetchFailureReport[] = [];
    const { s, lists } = await run(mkCfg(), fake, {}, clock(), (r) => reports.push(r));
    expect(s).toMatchObject({ listsOutcome: 'partial', listsFetched: 1, listsFailed: 1, listsIdsNew: 2 });
    expect(lists.files.get('mfc')!.groups.c1).toMatchObject({ lastAttemptAt: iso(T0), outcome: 'partial', reason: 'store answered 404', strikes: 0 });
    expect(reports[0]).toMatchObject({ reasonClass: 'gone_404', httpStatus: 404 });
  });

  it('a TRANSIENT failure stops the store, spends no slot and retries next pass — until the third try spends it', async () => {
    const lists = createMemoryListsStateStore();
    const c = clock();
    const cfg = mkCfg();
    const flaky = () => makeFake({ list: (id) => (id === 'c1-d1' ? listFail('transient', 'store answered 503', { upstreamStatus: 503 }) : listOk(DEFAULT_LISTS[id])) });
    const reports: FetchFailureReport[] = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      const startedAt = c.now();
      const fake = flaky();
      const { s } = await run(cfg, fake, { lists, ledgers: createMemoryLedgerStore({ mfc: ledger([], { cursor: 900, frontier: 1000 }) }) }, c, (r) => reports.push(r));
      expect(fake.listGets()).toEqual(['c1-d9', 'c1-d1']);
      // The store is stopped: no drain, and the descent below the lists step does not run either.
      expect(fake.posts()).toEqual([]);
      expect(s).toMatchObject({ listsGroup: 'c1', listsOutcome: 'transient', listsDrainStopped: 'store-stopped', rangeSkipped: 'store-stopped' });
      const g = lists.files.get('mfc')!.groups.c1;
      expect(g).toMatchObject({ outcome: 'transient', strikes: attempt, reason: 'store answered 503' });
      if (attempt < 3) expect(g.lastAttemptAt).toBeUndefined();
      else expect(g).toMatchObject({ lastAttemptAt: iso(startedAt), retries: 0 });
      c.advance(HOUR_MS);
    }
    expect(reports[0]).toMatchObject({ reasonClass: 'http_5xx', httpStatus: 503 });
    const after = makeFake();
    const { s } = await run(cfg, after, { lists }, c);
    expect(s.listsGroup).toBe('c2');
  });

  it('a CHALLENGE stops the store at once: the second list is not fetched and the slot is spent', async () => {
    const fake = makeFake({ list: () => listFail('deterministic', 'challenge page', { blocked: true }) });
    const reports: FetchFailureReport[] = [];
    const { s, lists } = await run(mkCfg(), fake, { ledgers: createMemoryLedgerStore({ mfc: ledger([], { cursor: 900, frontier: 1000 }) }) }, clock(), (r) =>
      reports.push(r),
    );
    expect(fake.listGets()).toEqual(['c1-d9']);
    expect(fake.posts()).toEqual([]);
    expect(s).toMatchObject({ listsOutcome: 'failed', rangeSkipped: 'store-stopped' });
    expect(lists.files.get('mfc')!.groups.c1).toMatchObject({ lastAttemptAt: iso(T0), outcome: 'failed', reason: 'challenge page' });
    expect(reports[0]).toMatchObject({ reasonClass: 'challenge' });
  });

  it('a 403 answer is deterministic and blocking; a 429 is transient and blocking', async () => {
    const f403 = makeFake({ list: () => listFail('deterministic', 'store answered 403', { upstreamStatus: 403, blocked: true }) });
    const r403 = await run(mkCfg(), f403);
    expect(f403.listGets()).toEqual(['c1-d9']);
    expect(r403.lists.files.get('mfc')!.groups.c1).toMatchObject({ outcome: 'failed', lastAttemptAt: iso(T0) });
    const f429 = makeFake({ list: () => listFail('transient', 'store answered 429', { upstreamStatus: 429, blocked: true }) });
    const r429 = await run(mkCfg(), f429);
    expect(f429.listGets()).toEqual(['c1-d9']);
    expect(r429.lists.files.get('mfc')!.groups.c1.lastAttemptAt).toBeUndefined();
  });

  it('a COOLING host is left alone: no slot, no strike, and the store stops for the pass', async () => {
    const fake = makeFake({ list: () => cooldown() });
    const { s, lists } = await run(mkCfg(), fake);
    expect(fake.listGets()).toEqual(['c1-d9']);
    expect(s).toMatchObject({ listsSkipped: 'cooldown', listsOutcome: null, skipped: 1 });
    expect(lists.files.get('mfc')!.groups.c1).toBeUndefined();
  });

  it('the scraper unreachable, a bare 503, an unclassified 502 or a malformed 200 are failures of their own kind', async () => {
    const cases: [Reply, string, string][] = [
      [{ status: 0, throwErr: true }, 'transient', 'network'],
      [{ status: 503, body: {} }, 'transient', 'http_5xx'],
      [{ status: 502, body: { error: 'catalog failed' } }, 'transient', 'http_5xx'],
      [{ status: 422, body: { error: 'unsupported' } }, 'failed', 'other'],
      [{ status: 200, body: { nope: true } }, 'failed', 'parse'],
    ];
    for (const [reply, outcome, reasonClass] of cases) {
      const fake = makeFake({ list: () => reply });
      const reports: FetchFailureReport[] = [];
      const { lists } = await run(mkCfg(), fake, {}, clock(), (r) => reports.push(r));
      expect(lists.files.get('mfc')!.groups.c1.outcome).toBe(outcome);
      expect(reports[0].reasonClass).toBe(reasonClass);
    }
  });

  it('an engine failure class without a store status is booked by its words: timeout, network, or the default reason', async () => {
    const cases: [Reply, string, string][] = [
      [listFail('transient', 'rotating seed list fetch timed out after 30000ms'), 'timeout', 'rotating seed list fetch timed out after 30000ms'],
      [listFail('transient', 'socket hang up'), 'network', 'socket hang up'],
      [listFail('deterministic', 'store answered 400', { upstreamStatus: 400 }), 'other', 'store answered 400'],
      [{ status: 502, body: { error: 'catalog failed', failure: 'deterministic' } }, 'parse', 'catalog failed'],
      [{ status: 200, body: 'not json' }, 'parse', 'catalog answered 200 with a body that is not a list'],
    ];
    for (const [reply, reasonClass, message] of cases) {
      const reports: FetchFailureReport[] = [];
      await run(mkCfg(), makeFake({ list: () => reply }), {}, clock(), (r) => reports.push(r));
      expect(reports[0]).toMatchObject({ reasonClass, message });
    }
  });

  it('the scraper timing out on a list is a transient timeout', async () => {
    const fake = makeFake({ list: () => ({ status: 0, throwErr: true }) });
    const timeoutFetch: FetchLike = async (url, init) => {
      if (url.includes('list=')) throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
      return fake.fetch(url, init);
    };
    const reports: FetchFailureReport[] = [];
    const summary = await runCrawlerPass(mkCfg(), {
      fetch: timeoutFetch,
      ledgerStore: createMemoryLedgerStore({ mfc: ledger() }),
      listsStore: createMemoryListsStateStore(),
      now: clock().now,
      sleep: async () => undefined,
      reportFailure: async (r) => {
        reports.push(r);
      },
    });
    expect(summary.stores[0].listsOutcome).toBe('transient');
    expect(reports[0].reasonClass).toBe('timeout');
  });

  it('a spent GLOBAL budget mid-group records no attempt at all', async () => {
    // discovery + the first list = 2 requests; the second list finds the gate closed.
    const fake = makeFake();
    const { s, lists, summary } = await run(mkCfg({ maxRequests: 2 }), fake);
    expect(fake.listGets()).toEqual(['c1-d9']);
    expect(s).toMatchObject({ listsSkipped: 'budget', listsOutcome: null });
    expect(summary.budgetExhausted).toBe(true);
    expect(lists.files.get('mfc')!.groups.c1).toBeUndefined();
    // What the first list offered is kept for the drain rather than thrown away.
    expect(lists.files.get('mfc')!.pending.map((p) => p.itemId)).toEqual(['101', '102', '103']);
  });
});

describe('lists step — discovery', () => {
  it('an engine that predates the route (404) or a store with no rotating lists (422) skips the step, never the store', async () => {
    for (const status of [404, 422]) {
      const fake = makeFake({ discovery: () => ({ status, body: {} }) });
      const { s } = await run(mkCfg(), fake, { ledgers: createMemoryLedgerStore({ mfc: ledger([], { cursor: 900, frontier: 1000 }) }) });
      expect(fake.listGets()).toEqual([]);
      expect(s).toMatchObject({ listsSkipped: 'unsupported', rangeSkipped: null, rangeWalked: 5 });
    }
  });

  it('a malformed declaration body is a failure that fetches nothing; an unreachable scraper stops the store', async () => {
    const malformed = makeFake({ discovery: () => ({ status: 200, body: { rotatingSeedLists: 'x' } }) });
    const a = await run(mkCfg(), malformed);
    expect(malformed.listGets()).toEqual([]);
    expect(a.s).toMatchObject({ listsSkipped: 'failed', errors: 1 });

    const down = makeFake({ discovery: () => ({ status: 0, throwErr: true }) });
    const b = await run(mkCfg(), down, { ledgers: createMemoryLedgerStore({ mfc: ledger([], { cursor: 900, frontier: 1000 }) }) });
    expect(b.s).toMatchObject({ listsSkipped: 'failed', rangeSkipped: 'store-stopped' });

    const sick = makeFake({ discovery: () => ({ status: 500, body: {} }) });
    const c = await run(mkCfg(), sick);
    expect(c.s.listsSkipped).toBe('failed');

    const notObject = makeFake({ discovery: () => ({ status: 200, body: ['c1-d9'] }) });
    const e = await run(mkCfg(), notObject);
    expect(e.s.listsSkipped).toBe('failed');

    const spent = makeFake();
    const d = await run(mkCfg({ maxRequests: 0 }), spent);
    expect(d.s.listsSkipped).toBe('budget');
  });

  it('drops unusable declared entries and orders groups by `order`, ties by first declaration', async () => {
    const decl = [
      { id: 'z-1', url: 'https://mfc.test/z', group: 'z', order: 5 },
      { id: 'a-1', url: 'https://mfc.test/a', group: 'a', order: 5 },
      { id: '', url: 'https://mfc.test/x', group: 'x', order: 0 },
      { id: 'y-1', url: 'https://mfc.test/y', group: '', order: 0 },
      { id: 'w-1', url: 'https://mfc.test/w', group: 'w', order: 'first' },
      { id: 'z-1', url: 'https://mfc.test/z2', group: 'q', order: 0 },
      null,
    ];
    const fake = makeFake({ discovery: () => ({ status: 200, body: { rotatingSeedLists: decl } }) });
    const { s } = await run(mkCfg(), fake);
    expect(fake.listGets()).toEqual(['z-1']);
    expect(s.listsGroup).toBe('z');
  });

  it('a lower `order` on a later list of a group moves the whole group up', async () => {
    const decl = [
      { id: 'b-1', url: 'https://mfc.test/b', group: 'b', order: 2 },
      { id: 'a-1', url: 'https://mfc.test/a1', group: 'a', order: 3 },
      { id: 'a-2', url: 'https://mfc.test/a2', group: 'a', order: 1 },
    ];
    const fake = makeFake({ discovery: () => ({ status: 200, body: { rotatingSeedLists: decl } }) });
    await run(mkCfg(), fake);
    expect(fake.listGets()).toEqual(['a-1', 'a-2']);
  });
});

describe('lists step — state', () => {
  it('a corrupt lists state refuses the step (never overwritten) and leaves every other lane running', async () => {
    const lists = createMemoryListsStateStore({ mfc: 'corrupt' });
    const saveSpy = jest.spyOn(lists, 'save');
    const fake = makeFake();
    const { s } = await run(mkCfg(), fake, { lists, ledgers: createMemoryLedgerStore({ mfc: ledger([], { cursor: 900, frontier: 1000 }) }) });
    expect(fake.discoveryGets()).toBe(0);
    expect(saveSpy).not.toHaveBeenCalled();
    expect(s).toMatchObject({ listsSkipped: 'state-corrupt', errors: 1, rangeWalked: 5 });
  });

  it('a lists state that cannot be read or saved stops the step, not the store', async () => {
    const unreadable = createMemoryListsStateStore();
    jest.spyOn(unreadable, 'load').mockRejectedValue(new Error('EIO'));
    const a = await run(mkCfg(), makeFake(), { lists: unreadable });
    expect(a.s).toMatchObject({ listsSkipped: 'state-failed', errors: 1 });

    const unwritable = createMemoryListsStateStore();
    jest.spyOn(unwritable, 'save').mockRejectedValue(new Error('ENOSPC'));
    const fake = makeFake();
    const b = await run(mkCfg(), fake, { lists: unwritable, ledgers: createMemoryLedgerStore({ mfc: ledger([], { cursor: 900, frontier: 1000 }) }) });
    // The slot could not be recorded, so nothing is drained on the strength of it.
    expect(fake.posts().filter((p) => p.priority === 'COLD')).toEqual([]);
    expect(b.s).toMatchObject({ listsDrainStopped: 'failed', rangeWalked: 5 });
  });

  it('a ledger save that fails after the drain stops the store and keeps the backlog', async () => {
    const ledgers = createMemoryLedgerStore({ mfc: ledger() });
    const fake = makeFake();
    const lists = createMemoryListsStateStore();
    const saveSpy = jest.spyOn(ledgers, 'save');
    saveSpy.mockRejectedValue(new Error('ENOSPC'));
    const { s } = await run(mkCfg(), fake, { ledgers, lists });
    expect(s.listsDrainStopped).toBe('failed');
    expect(lists.files.get('mfc')!.pending.map((p) => p.itemId)).toEqual(['101', '102', '103', '104']);
  });

  it('a lane above it that stops the store (a recent-gap cooldown) skips the whole step', async () => {
    const band: LedgerGapBand = { from: 501, to: 510, next: 501, origin: 'reanchor', createdAt: iso(T0 - WEEK_MS) };
    const fake = makeFake({ range: () => cooldown() });
    const { s } = await run(mkCfg({ rangeGapBudget: 5 }), fake, { ledgers: createMemoryLedgerStore({ mfc: ledger([], { cursor: 0, frontier: 1000, gaps: [band] }) }) });
    expect(fake.discoveryGets()).toBe(0);
    expect(s).toMatchObject({ gapSkipped: 'cooldown', listsSkipped: 'store-stopped' });
  });

  it('a corrupt LEDGER stops the id-range phase, the lists step included', async () => {
    const fake = makeFake();
    const { s } = await run(mkCfg(), fake, { ledgers: createMemoryLedgerStore({ mfc: 'corrupt' }) });
    expect(fake.calls).toEqual([]);
    expect(s).toMatchObject({ ledgerCorrupt: true, listsSkipped: 'store-stopped' });
  });

  it('seed mode never runs the lists step', async () => {
    const fake = makeFake();
    await run(mkCfg({ mode: 'seed', phases: ['seed'] }), fake);
    expect(fake.discoveryGets()).toBe(0);
  });
});

describe('lists step — PRECEDENCE inside one pass', () => {
  it('tap → recent gaps → company lists (COLD) → older gaps → descent, each on its own budget', async () => {
    const band = (from: number, to: number, origin: LedgerGapBand['origin']): LedgerGapBand => ({ from, to, next: from, origin, createdAt: iso(T0 - WEEK_MS) });
    // The operator band is OLDER than the re-anchor band: age alone would sweep it first.
    const older = { ...band(401, 402, 'operator'), createdAt: iso(T0 - 2 * WEEK_MS) };
    const ledgers = createMemoryLedgerStore({
      mfc: ledger([], { cursor: 900, frontier: 1000, reanchoredAt: iso(T0), gaps: [band(501, 502, 'reanchor'), older] }),
    });
    const fake = makeFake({
      listing: () => ({ status: 200, body: { items: [{ itemId: '999', collectUrl: item('999') }], hasMore: false } }),
      list: (id) => listOk(id === 'c1-d9' ? ['101'] : []),
    });
    const { s } = await run(
      mkCfg({ mode: 'both', phases: ['recent', 'backfill'], rangeGapBudget: 4, rangeIdsPerRun: 2, maxEnqueuePerStore: 3 }),
      fake,
      { ledgers },
    );
    expect(fake.posts()).toEqual([
      { id: '999', priority: undefined }, // the Latest Additions tap
      { id: '501', priority: undefined }, // recent gap (re-anchor band)
      { id: '502', priority: undefined },
      { id: '101', priority: 'COLD' }, // company list drain
      { id: '401', priority: undefined }, // older gap (operator band)
      { id: '402', priority: undefined },
      { id: '900', priority: undefined }, // archive descent
      { id: '899', priority: undefined },
    ]);
    expect(s).toMatchObject({ enqueued: 3, gapEnqueued: 4, listsEnqueued: 1, gapSkipped: null, rangeSkipped: null });
  });
});
