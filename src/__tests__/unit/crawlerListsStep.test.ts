/**
 * runCrawlerPass — the ROTATING COMPANY-LISTS step (Ross 2026-09-22/25/26), between the recent and the
 * older gap sweeps. Mocked http surface, in-memory ledger and lists-state stores, fake clock.
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

describe('lists step — FAIRNESS', () => {
  const stamp = (at: number) => ({ lastAttemptAt: iso(at), lastTriedAt: iso(at), outcome: 'ok' as const, seen: 0, new: 0, enqueued: 0, strikes: 0, retries: 0 });

  it('takes the due group attempted LONGEST ago, a never-attempted group before any, `order` only breaking ties', async () => {
    const lists = createMemoryListsStateStore({
      mfc: { ...createEmptyListsState('mfc'), groups: { c1: stamp(T0 - 200 * HOUR_MS), c2: stamp(T0 - 300 * HOUR_MS) } },
    });
    const ledgers = createMemoryLedgerStore({ mfc: ledger() });
    const order: (string | null)[] = [];
    for (let pass = 0; pass < 3; pass++) order.push((await run(mkCfg(), makeFake(), { lists, ledgers }, clock(T0 + pass * HOUR_MS))).s.listsGroup);
    expect(order).toEqual(['c3', 'c2', 'c1']);
  });

  it('54 companies, 7 in-window passes a night, 160 h interval: every company is polled and none twice before the others', async () => {
    const decl = Array.from({ length: 54 }, (_, i) =>
      [9, 1].map((d) => ({ id: `c${i + 1}-d${d}`, url: `https://mfc.test/s?e=${i + 1}&d=${d}`, group: `c${i + 1}`, order: i + 1 })),
    ).flat();
    const fake = makeFake({ discovery: () => ({ status: 200, body: { rotatingSeedLists: decl } }), list: () => listOk([]) });
    const lists = createMemoryListsStateStore();
    const ledgers = createMemoryLedgerStore({ mfc: ledger() });
    const polls: Record<string, number> = {};
    const firstNight = Date.parse('2026-10-01T15:30:00.000Z');
    // 16 nights x 7 slots = 112 = 2 x 54 + 4: a fair rotation polls each company 2 or 3 times.
    for (let night = 0; night < 16; night++) {
      for (let slot = 0; slot < 7; slot++) {
        const g = (await run(mkCfg(), fake, { lists, ledgers }, clock(firstNight + night * 24 * HOUR_MS + slot * HOUR_MS))).s.listsGroup;
        if (g) polls[g] = (polls[g] ?? 0) + 1;
      }
    }
    const counts = decl.filter((d) => d.id.endsWith('-d9')).map((d) => polls[d.group] ?? 0);
    expect(counts.filter((n) => n === 0)).toEqual([]);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });
});

describe('lists step — WINDOW and INTERVAL edges', () => {
  const at = async (whenIso: string, over: Partial<CrawlerConfig> = {}) => {
    const fake = makeFake();
    const { s } = await run(mkCfg(over), fake, {}, clock(Date.parse(whenIso)));
    return { s, gets: fake.listGets() };
  };

  it('15:30-22:30: the start minute is in, the end minute is out — no list request at 22:30:00', async () => {
    expect((await at('2026-10-01T15:30:00.000Z')).s.listsGroup).toBe('c1');
    expect((await at('2026-10-01T15:29:59.999Z')).s.listsSkipped).toBe('outside-window');
    expect((await at('2026-10-01T22:29:59.999Z')).s.listsGroup).toBe('c1');
    const end = await at('2026-10-01T22:30:00.000Z');
    expect(end.s.listsSkipped).toBe('outside-window');
    expect(end.gets).toEqual([]);
  });

  it('a window wrapping midnight (22:00-02:00) keeps the same edges on both sides of midnight', async () => {
    const wrap = { listsWindow: { startMin: 22 * 60, endMin: 2 * 60 } };
    expect((await at('2026-10-01T22:00:00.000Z', wrap)).s.listsGroup).toBe('c1');
    expect((await at('2026-10-01T21:59:59.999Z', wrap)).s.listsSkipped).toBe('outside-window');
    expect((await at('2026-10-02T01:59:59.999Z', wrap)).s.listsGroup).toBe('c1');
    expect((await at('2026-10-02T02:00:00.000Z', wrap)).s.listsSkipped).toBe('outside-window');
  });

  it('a group is due at exactly the interval and not 1 ms before it', async () => {
    const polledAgo = async (ageMs: number) => {
      const groups = Object.fromEntries(['c1', 'c2', 'c3'].map((g) => [g, { lastAttemptAt: iso(T0 - ageMs), lastTriedAt: iso(T0 - ageMs), outcome: 'ok' as const, seen: 0, new: 0, enqueued: 0, strikes: 0, retries: 0 }]));
      return (await run(mkCfg(), makeFake(), { lists: createMemoryListsStateStore({ mfc: { ...createEmptyListsState('mfc'), groups } }) })).s;
    };
    expect((await polledAgo(160 * HOUR_MS)).listsGroup).toBe('c1');
    expect((await polledAgo(160 * HOUR_MS - 1)).listsSkipped).toBe('none-due');
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

  it('a TRANSIENT failure stops the store, spends no slot and retries ONLY the unanswered list — until the third try spends it', async () => {
    const lists = createMemoryListsStateStore();
    const c = clock();
    const cfg = mkCfg();
    const flaky = () => makeFake({ list: (id) => (id === 'c1-d1' ? listFail('transient', 'store answered 503', { upstreamStatus: 503 }) : listOk(DEFAULT_LISTS[id])) });
    const reports: FetchFailureReport[] = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      const startedAt = c.now();
      const fake = flaky();
      const { s } = await run(cfg, fake, { lists, ledgers: createMemoryLedgerStore({ mfc: ledger([], { cursor: 900, frontier: 1000 }) }) }, c, (r) => reports.push(r));
      // c1-d9 answered on the first pass: the retries never ask it again.
      expect(fake.listGets()).toEqual(attempt === 1 ? ['c1-d9', 'c1-d1'] : ['c1-d1']);
      // The store is stopped: no drain, and the descent below the lists step does not run either.
      expect(fake.posts()).toEqual([]);
      expect(s).toMatchObject({ listsGroup: 'c1', listsOutcome: 'transient', listsDrainStopped: 'store-stopped', rangeSkipped: 'store-stopped' });
      const g = lists.files.get('mfc')!.groups.c1;
      expect(g).toMatchObject({ outcome: 'transient', strikes: attempt, reason: 'store answered 503', seen: 3, new: 3 });
      if (attempt < 3) expect(g).toMatchObject({ retries: attempt, answered: { 'c1-d9': 'ok' } });
      if (attempt < 3) expect(g.lastAttemptAt).toBeUndefined();
      else expect(g).toEqual(expect.not.objectContaining({ answered: expect.anything() }));
      if (attempt === 3) expect(g).toMatchObject({ lastAttemptAt: iso(startedAt), retries: 0 });
      c.advance(HOUR_MS);
    }
    expect(reports[0]).toMatchObject({ reasonClass: 'http_5xx', httpStatus: 503 });
    const after = makeFake();
    const { s } = await run(cfg, after, { lists }, c);
    expect(s.listsGroup).toBe('c2');
  });

  it('a retry that completes the group books the whole attempt: both passes counted, an id on both lists once, the slot spent once', async () => {
    const lists = createMemoryListsStateStore();
    const c = clock();
    const first = makeFake({ list: (id) => (id === 'c1-d1' ? listFail('transient', 'store answered 503', { upstreamStatus: 503 }) : listOk(DEFAULT_LISTS[id])) });
    await run(mkCfg(), first, { lists }, c);
    expect(lists.files.get('mfc')!.groups.c1).toMatchObject({ seen: 3, seenIds: ['101', '102', '103'] });
    c.advance(HOUR_MS);
    const retryAt = c.now();
    const second = makeFake();
    const { s } = await run(mkCfg(), second, { lists }, c);
    expect(second.listGets()).toEqual(['c1-d1']);
    // 102 is already in the backlog from c1-d9 (and already seen by this attempt); 104 is new.
    expect(s).toMatchObject({ listsGroup: 'c1', listsOutcome: 'ok', listsFetched: 1, listsIdsSeen: 2, listsIdsNew: 1 });
    expect(lists.files.get('mfc')!.groups.c1).toEqual({
      lastAttemptAt: iso(retryAt),
      lastTriedAt: iso(retryAt),
      outcome: 'ok',
      seen: 4,
      new: 4,
      enqueued: 4,
      strikes: 0,
      retries: 0,
    });
  });

  it('a list that failed deterministically is not asked again on the retry, and the attempt books partial', async () => {
    const lists = createMemoryListsStateStore();
    const c = clock();
    const decl = [
      { id: 'c1-a', url: 'https://mfc.test/a', group: 'c1', order: 1 },
      { id: 'c1-b', url: 'https://mfc.test/b', group: 'c1', order: 1 },
      { id: 'c1-c', url: 'https://mfc.test/c', group: 'c1', order: 1 },
    ];
    const discovery = () => ({ status: 200, body: { rotatingSeedLists: decl } });
    const first = makeFake({
      discovery,
      list: (id) =>
        id === 'c1-a' ? listFail('deterministic', 'company filter not proven') : id === 'c1-b' ? listOk(['7']) : listFail('transient', 'socket hang up'),
    });
    await run(mkCfg(), first, { lists }, c);
    expect(lists.files.get('mfc')!.groups.c1.answered).toEqual({ 'c1-a': 'failed', 'c1-b': 'ok' });
    c.advance(HOUR_MS);
    const second = makeFake({ discovery, list: () => listOk(['8']) });
    const { s } = await run(mkCfg(), second, { lists }, c);
    expect(second.listGets()).toEqual(['c1-c']);
    expect(s.listsOutcome).toBe('partial');
    expect(lists.files.get('mfc')!.groups.c1).toMatchObject({ outcome: 'partial', strikes: 0, lastAttemptAt: iso(c.now()) });
  });

  it('a list dropped from the declaration while its group was open is not waited for', async () => {
    const lists = createMemoryListsStateStore({
      mfc: {
        ...createEmptyListsState('mfc'),
        groups: {
          c1: { lastTriedAt: iso(T0 - HOUR_MS), outcome: 'transient', reason: 'socket hang up', seen: 3, new: 3, enqueued: 0, strikes: 1, retries: 1, answered: { 'c1-d9': 'ok', 'c1-old': 'failed' } },
        },
      },
    });
    const decl = [{ id: 'c1-d9', url: 'https://mfc.test/s?e=1&d=9', group: 'c1', order: 1 }];
    const fake = makeFake({ discovery: () => ({ status: 200, body: { rotatingSeedLists: decl } }) });
    const { s } = await run(mkCfg(), fake, { lists });
    expect(fake.listGets()).toEqual([]);
    expect(s).toMatchObject({ listsGroup: 'c1', listsOutcome: 'ok', listsFetched: 0 });
    expect(lists.files.get('mfc')!.groups.c1).toMatchObject({ outcome: 'ok', lastAttemptAt: iso(T0), strikes: 0 });
  });

  it('a BLOCKED answer (challenge, 401, 403, 429) spends NO slot: a strike, the store stops, and list fetching pauses for the rest of the window', async () => {
    const blocked: [Reply, string][] = [
      [listFail('deterministic', 'challenge page', { blocked: true }), 'challenge'],
      [listFail('deterministic', 'store answered 401', { upstreamStatus: 401, blocked: true }), 'other'],
      [listFail('deterministic', 'store answered 403', { upstreamStatus: 403, blocked: true }), 'http_403'],
      [listFail('transient', 'store answered 429', { upstreamStatus: 429, blocked: true }), 'http_429'],
    ];
    for (const [reply, reasonClass] of blocked) {
      const lists = createMemoryListsStateStore({ mfc: { ...createEmptyListsState('mfc'), pending: [{ itemId: '9', collectUrl: item('9'), group: 'c3' }] } });
      const ledgers = createMemoryLedgerStore({ mfc: ledger([], { cursor: 900, frontier: 1000 }) });
      const c = clock();
      const fake = makeFake({ list: () => reply });
      const reports: FetchFailureReport[] = [];
      const { s } = await run(mkCfg(), fake, { lists, ledgers }, c, (r) => reports.push(r));
      expect(fake.listGets()).toEqual(['c1-d9']);
      expect(fake.posts()).toEqual([]);
      expect(s).toMatchObject({ listsGroup: 'c1', listsOutcome: 'blocked', listsSkipped: null, rangeSkipped: 'store-stopped' });
      const state = lists.files.get('mfc')!;
      expect(state.groups.c1).toMatchObject({ outcome: 'blocked', strikes: 1, blockedStrikes: 1, retries: 0, answered: {} });
      expect(state.groups.c1.lastAttemptAt).toBeUndefined();
      expect(state.pausedUntil).toBe('2026-09-26T22:30:00.000Z');
      expect(reports[0].reasonClass).toBe(reasonClass);

      // Paused: no discovery, no list — but the backlog still drains (item pages, not the lists).
      c.advance(HOUR_MS);
      const paused = makeFake();
      const p = await run(mkCfg(), paused, { lists, ledgers }, c);
      expect(paused.discoveryGets()).toBe(0);
      expect(paused.posts()[0]).toEqual({ id: '9', priority: 'COLD' });
      expect(p.s).toMatchObject({ listsSkipped: 'paused', listsGroup: null, listsEnqueued: 1 });

      // The next night's first pass asks the SAME group again, and the pause is cleared.
      const nextNight = Date.parse('2026-09-27T15:30:00.000Z');
      c.advance(nextNight - c.now());
      const again = makeFake();
      const a = await run(mkCfg(), again, { lists, ledgers }, c);
      expect(again.listGets()).toEqual(['c1-d9', 'c1-d1']);
      expect(a.s).toMatchObject({ listsGroup: 'c1', listsOutcome: 'ok' });
      expect(lists.files.get('mfc')!.pausedUntil).toBeUndefined();
      expect(lists.files.get('mfc')!.groups.c1).toMatchObject({ strikes: 0, lastAttemptAt: iso(nextNight) });
      expect(lists.files.get('mfc')!.groups.c1.blockedStrikes).toBeUndefined();
    }
  });

  it('a night of 403s (7 hourly passes) costs ONE list request and no company its slot', async () => {
    const lists = createMemoryListsStateStore();
    const ledgers = createMemoryLedgerStore({ mfc: ledger() });
    let gets = 0;
    const skipped: (string | null)[] = [];
    for (let h = 0; h < 7; h++) {
      const fake = makeFake({ list: () => listFail('deterministic', 'store answered 403', { upstreamStatus: 403, blocked: true }) });
      const { s } = await run(mkCfg(), fake, { lists, ledgers }, clock(Date.parse('2026-10-01T15:30:00.000Z') + h * HOUR_MS));
      gets += fake.listGets().length;
      skipped.push(s.listsSkipped);
    }
    expect(gets).toBe(1);
    expect(skipped).toEqual([null, 'paused', 'paused', 'paused', 'paused', 'paused', 'paused']);
    expect(Object.values(lists.files.get('mfc')!.groups).filter((g) => g.lastAttemptAt !== undefined)).toEqual([]);
  });

  it('a block on the last pass pauses to the END of tonight: paused at pausedUntil - 1 ms, and the next night fetches', async () => {
    const lists = createMemoryListsStateStore();
    const ledgers = createMemoryLedgerStore({ mfc: ledger() });
    const refused = makeFake({ list: () => listFail('deterministic', 'store answered 403', { upstreamStatus: 403, blocked: true }) });
    await run(mkCfg(), refused, { lists, ledgers }, clock(Date.parse('2026-10-01T21:30:00.000Z')));
    expect(lists.files.get('mfc')!.pausedUntil).toBe('2026-10-01T22:30:00.000Z');

    const edge = makeFake();
    const e = await run(mkCfg(), edge, { lists, ledgers }, clock(Date.parse('2026-10-01T22:29:59.999Z')));
    expect(e.s.listsSkipped).toBe('paused');
    expect(edge.discoveryGets()).toBe(0);
    expect(edge.listGets()).toEqual([]);

    const nextNight = makeFake();
    const n = await run(mkCfg(), nextNight, { lists, ledgers }, clock(Date.parse('2026-10-02T15:30:00.000Z')));
    expect(nextNight.listGets()).toEqual(['c1-d9', 'c1-d1']);
    expect(n.s).toMatchObject({ listsGroup: 'c1', listsOutcome: 'ok', listsSkipped: null });
  });

  it('a pause holds until exactly pausedUntil: 1 ms before it no list is asked, at it the rotation resumes', async () => {
    const seeded = () => createMemoryListsStateStore({ mfc: { ...createEmptyListsState('mfc'), pausedUntil: '2026-10-01T18:00:00.000Z' } });
    const before = makeFake();
    const b = await run(mkCfg(), before, { lists: seeded() }, clock(Date.parse('2026-10-01T17:59:59.999Z')));
    expect(b.s.listsSkipped).toBe('paused');
    expect(before.listGets()).toEqual([]);
    const at = makeFake();
    const a = await run(mkCfg(), at, { lists: seeded() }, clock(Date.parse('2026-10-01T18:00:00.000Z')));
    expect(at.listGets()).toEqual(['c1-d9', 'c1-d1']);
    expect(a.lists.files.get('mfc')!.pausedUntil).toBeUndefined();
  });

  it('a window wrapping midnight pauses to ITS end: a block before midnight or after it both pause to 02:00', async () => {
    const wrap = mkCfg({ listsWindow: { startMin: 22 * 60, endMin: 2 * 60 } });
    for (const when of ['2026-10-01T23:00:00.000Z', '2026-10-02T01:00:00.000Z']) {
      const fake = makeFake({ list: () => listFail('deterministic', 'challenge page', { blocked: true }) });
      const { lists } = await run(wrap, fake, {}, clock(Date.parse(when)));
      expect(lists.files.get('mfc')!.pausedUntil).toBe('2026-10-02T02:00:00.000Z');
    }
  });

  it('one company REFUSED, the rest answering: its slot is spent after 3 blocked nights, and every other company is polled', async () => {
    const decl = Array.from({ length: 8 }, (_, i) =>
      [9, 1].map((d) => ({ id: `c${i + 1}-d${d}`, url: `https://mfc.test/s?e=${i + 1}&d=${d}`, group: `c${i + 1}`, order: i + 1 })),
    ).flat();
    const fake = makeFake({
      discovery: () => ({ status: 200, body: { rotatingSeedLists: decl } }),
      list: (id) => (id.startsWith('c1-') ? listFail('deterministic', 'store answered 403', { upstreamStatus: 403, blocked: true }) : listOk([])),
    });
    const lists = createMemoryListsStateStore();
    const ledgers = createMemoryLedgerStore({ mfc: ledger() });
    const night = (n: number, slot = 0) => Date.parse('2026-10-01T15:30:00.000Z') + n * 24 * HOUR_MS + slot * HOUR_MS;
    const nights: (string | null)[][] = [];
    for (let n = 0; n < 5; n++) {
      const skips: (string | null)[] = [];
      for (let slot = 0; slot < 7; slot++) skips.push((await run(mkCfg(), fake, { lists, ledgers }, clock(night(n, slot)))).s.listsSkipped);
      nights.push(skips);
    }
    const paused = [null, 'paused', 'paused', 'paused', 'paused', 'paused', 'paused'];
    expect(nights).toEqual([paused, paused, paused, Array(7).fill(null), Array(7).fill('none-due')]);
    expect(fake.listGets().filter((id) => id!.startsWith('c1-'))).toEqual(['c1-d9', 'c1-d9', 'c1-d9']);
    const groups = lists.files.get('mfc')!.groups;
    expect(groups.c1).toMatchObject({ outcome: 'blocked', strikes: 3, lastAttemptAt: iso(night(2)) });
    expect(groups.c1).toEqual(expect.not.objectContaining({ blockedStrikes: expect.anything(), answered: expect.anything() }));
    for (let i = 2; i <= 8; i++) expect(groups[`c${i}`]).toMatchObject({ outcome: 'ok', lastAttemptAt: iso(night(3, i - 2)) });
  });

  it('only CONSECUTIVE blocked passes count toward spending: a transient answer in between starts the count again', async () => {
    const lists = createMemoryListsStateStore();
    const blocked = () => listFail('deterministic', 'store answered 403', { upstreamStatus: 403, blocked: true });
    const passes: [string, Reply][] = [
      ['2026-10-01T15:30:00.000Z', blocked()],
      ['2026-10-02T15:30:00.000Z', listFail('transient', 'store answered 503', { upstreamStatus: 503 })],
      ['2026-10-02T16:30:00.000Z', blocked()],
      ['2026-10-03T15:30:00.000Z', blocked()],
      ['2026-10-04T15:30:00.000Z', blocked()],
    ];
    const seen: unknown[] = [];
    for (const [when, reply] of passes) {
      await run(mkCfg(), makeFake({ list: () => reply }), { lists }, clock(Date.parse(when)));
      const g = lists.files.get('mfc')!.groups.c1;
      seen.push([g.outcome, g.blockedStrikes, g.lastAttemptAt]);
    }
    expect(seen).toEqual([
      ['blocked', 1, undefined],
      ['transient', undefined, undefined],
      ['blocked', 1, undefined],
      ['blocked', 2, undefined],
      ['blocked', undefined, '2026-10-04T15:30:00.000Z'],
    ]);
  });

  it('a BLOCKED answer on list 2 keeps list 1: after the pause only list 2 is asked', async () => {
    const lists = createMemoryListsStateStore();
    const c = clock();
    const first = makeFake({ list: (id) => (id === 'c1-d1' ? listFail('deterministic', 'challenge page', { blocked: true }) : listOk(DEFAULT_LISTS[id])) });
    await run(mkCfg(), first, { lists }, c);
    expect(first.listGets()).toEqual(['c1-d9', 'c1-d1']);
    expect(lists.files.get('mfc')!.groups.c1.answered).toEqual({ 'c1-d9': 'ok' });
    c.advance(24 * HOUR_MS);
    const second = makeFake();
    await run(mkCfg(), second, { lists }, c);
    expect(second.listGets()).toEqual(['c1-d1']);
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

  it('a spent GLOBAL budget mid-group spends no slot and no strike, and keeps list 1 for the next pass', async () => {
    // discovery + the first list = 2 requests; the second list finds the gate closed.
    const lists = createMemoryListsStateStore();
    const c = clock();
    const fake = makeFake();
    const { s, summary } = await run(mkCfg({ maxRequests: 2 }), fake, { lists }, c);
    expect(fake.listGets()).toEqual(['c1-d9']);
    expect(s).toMatchObject({ listsSkipped: 'budget', listsOutcome: 'interrupted' });
    expect(summary.budgetExhausted).toBe(true);
    expect(lists.files.get('mfc')!.groups.c1).toMatchObject({ outcome: 'interrupted', strikes: 0, retries: 0, answered: { 'c1-d9': 'ok' } });
    expect(lists.files.get('mfc')!.groups.c1.lastAttemptAt).toBeUndefined();
    // What the first list offered is kept for the drain rather than thrown away.
    expect(lists.files.get('mfc')!.pending.map((p) => p.itemId)).toEqual(['101', '102', '103']);

    c.advance(HOUR_MS);
    const next = makeFake();
    const n = await run(mkCfg(), next, { lists }, c);
    expect(next.listGets()).toEqual(['c1-d1']);
    expect(n.s.listsOutcome).toBe('ok');
  });

  it('a host that starts cooling after list 1 FAILED still books list 1, so it is not asked again', async () => {
    const lists = createMemoryListsStateStore();
    const c = clock();
    const fake = makeFake({ list: (id) => (id === 'c1-d1' ? cooldown() : listFail('deterministic', 'company filter not proven')) });
    await run(mkCfg(), fake, { lists }, c);
    expect(lists.files.get('mfc')!.groups.c1).toMatchObject({ outcome: 'interrupted', answered: { 'c1-d9': 'failed' }, reason: 'company filter not proven' });
    c.advance(HOUR_MS);
    const next = makeFake();
    const { s } = await run(mkCfg(), next, { lists }, c);
    expect(next.listGets()).toEqual(['c1-d1']);
    expect(s.listsOutcome).toBe('partial');
  });

  it('a new attempt starts its counters from zero; last cycle\'s numbers do not carry over', async () => {
    const lists = createMemoryListsStateStore({
      mfc: {
        ...createEmptyListsState('mfc'),
        groups: { c1: { lastAttemptAt: iso(T0 - 200 * HOUR_MS), lastTriedAt: iso(T0 - 200 * HOUR_MS), outcome: 'ok', seen: 200, new: 123, enqueued: 50, strikes: 0, retries: 0 } },
      },
    });
    const decl = [{ id: 'c1-d9', url: 'https://mfc.test/s?e=1&d=9', group: 'c1', order: 1 }];
    await run(mkCfg(), makeFake({ discovery: () => ({ status: 200, body: { rotatingSeedLists: decl } }) }), { lists });
    expect(lists.files.get('mfc')!.groups.c1).toMatchObject({ seen: 3, new: 3, enqueued: 3 });
  });

  it('a host that starts cooling after list 1 answered keeps list 1 for the next pass', async () => {
    const lists = createMemoryListsStateStore();
    const c = clock();
    const fake = makeFake({ list: (id) => (id === 'c1-d1' ? cooldown() : listOk(DEFAULT_LISTS[id])) });
    const { s } = await run(mkCfg(), fake, { lists }, c);
    expect(s).toMatchObject({ listsSkipped: 'cooldown', listsOutcome: 'interrupted', skipped: 1 });
    c.advance(HOUR_MS);
    const next = makeFake();
    await run(mkCfg(), next, { lists }, c);
    expect(next.listGets()).toEqual(['c1-d1']);
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

  it('group and list names that are Object.prototype members are ordinary names: fetched, booked and persisted', async () => {
    const decl = [
      { id: 'toString', url: 'https://mfc.test/a', group: 'constructor', order: 1 },
      { id: 'valueOf', url: 'https://mfc.test/b', group: 'constructor', order: 1 },
      { id: 'isPrototypeOf', url: 'https://mfc.test/c', group: 'toString', order: 2 },
    ];
    const fake = makeFake({ discovery: () => ({ status: 200, body: { rotatingSeedLists: decl } }), list: (id) => listOk([`${id}-1`]) });
    // A backlog id whose group has no state yet: the drain must not book it onto the builtin.
    const lists = createMemoryListsStateStore({ mfc: { ...createEmptyListsState('mfc'), pending: [{ itemId: '9', collectUrl: item('9'), group: 'toString' }] } });
    const ledgers = createMemoryLedgerStore({ mfc: ledger() });
    const got: (string | null)[] = [];
    for (let pass = 0; pass < 3; pass++) got.push((await run(mkCfg(), fake, { lists, ledgers }, clock(T0 + pass * HOUR_MS))).s.listsGroup);
    expect(got).toEqual(['constructor', 'toString', null]);
    expect(fake.listGets()).toEqual(['toString', 'valueOf', 'isPrototypeOf']);
    const groups = lists.files.get('mfc')!.groups;
    expect(Object.keys(groups)).toEqual(['constructor', 'toString']);
    expect(groups.constructor).toMatchObject({ outcome: 'ok', lastAttemptAt: iso(T0), seen: 2, enqueued: 2 });
    expect(groups.toString).toMatchObject({ outcome: 'ok', lastAttemptAt: iso(T0 + HOUR_MS), seen: 1, enqueued: 1 });
    expect(Object.prototype.hasOwnProperty.call(Object, 'lastAttemptAt')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(Object.prototype.toString, 'lastAttemptAt')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(Object.prototype.toString, 'enqueued')).toBe(false);
  });

  it('an open attempt over lists named like Object.prototype members resumes with exactly the unanswered one', async () => {
    const decl = [
      { id: 'toString', url: 'https://mfc.test/a', group: 'constructor', order: 1 },
      { id: 'valueOf', url: 'https://mfc.test/b', group: 'constructor', order: 1 },
    ];
    const discovery = () => ({ status: 200, body: { rotatingSeedLists: decl } });
    const lists = createMemoryListsStateStore();
    const c = clock();
    await run(mkCfg(), makeFake({ discovery, list: (id) => (id === 'valueOf' ? listFail('transient', 'socket hang up') : listOk(['1'])) }), { lists }, c);
    expect(lists.files.get('mfc')!.groups['constructor'].answered).toEqual({ toString: 'ok' });
    c.advance(HOUR_MS);
    const retry = makeFake({ discovery, list: () => listOk(['2']) });
    const { s } = await run(mkCfg(), retry, { lists }, c);
    expect(retry.listGets()).toEqual(['valueOf']);
    expect(s.listsOutcome).toBe('ok');
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
    expect(fake.posts().map((p) => p.id)).toEqual(['900', '899', '898', '897', '896']);
    expect(b.s).toMatchObject({ listsDrainStopped: 'failed', listsEnqueued: 0, rangeWalked: 5 });
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
  const band = (from: number, to: number, origin: LedgerGapBand['origin']): LedgerGapBand => ({ from, to, next: from, origin, createdAt: iso(T0 - WEEK_MS) });
  // The operator band is OLDER than the re-anchor band: age alone would sweep it first.
  const twoTiers = () =>
    createMemoryLedgerStore({
      mfc: ledger([], { cursor: 900, frontier: 1000, reanchoredAt: iso(T0), gaps: [band(501, 502, 'reanchor'), { ...band(401, 402, 'operator'), createdAt: iso(T0 - 2 * WEEK_MS) }] }),
    });
  const lanes = () =>
    makeFake({
      listing: () => ({ status: 200, body: { items: [{ itemId: '999', collectUrl: item('999') }], hasMore: false } }),
      list: (id) => listOk(id === 'c1-d9' ? ['101'] : []),
    });
  const cfg = (over: Partial<CrawlerConfig> = {}) => mkCfg({ mode: 'both', phases: ['recent', 'backfill'], rangeGapBudget: 4, rangeIdsPerRun: 2, maxEnqueuePerStore: 3, ...over });

  it('tap, recent gaps WARM → company lists, older gaps, descent COLD: posted in lane order, so FIFO within COLD keeps it', async () => {
    const fake = lanes();
    const { s } = await run(cfg(), fake, { ledgers: twoTiers() });
    expect(fake.posts()).toEqual([
      { id: '999', priority: undefined }, // the Latest Additions tap
      { id: '501', priority: undefined }, // recent gap (re-anchor band)
      { id: '502', priority: undefined },
      { id: '101', priority: 'COLD' }, // company list drain
      { id: '401', priority: 'COLD' }, // older gap (operator band)
      { id: '402', priority: 'COLD' },
      { id: '900', priority: 'COLD' }, // archive descent
      { id: '899', priority: 'COLD' },
    ]);
    expect(s).toMatchObject({ enqueued: 3, gapEnqueued: 4, listsEnqueued: 1, gapSkipped: null, rangeSkipped: null });
  });

  it('a store without the lists step posts its older gaps and descent exactly as before (the queue default, WARM)', async () => {
    const fake = lanes();
    await run(cfg({ listsDrainCaps: {} }), fake, { ledgers: twoTiers() });
    expect(fake.posts()).toEqual(['999', '501', '502', '401', '402', '900', '899'].map((id) => ({ id, priority: undefined })));
  });
});
