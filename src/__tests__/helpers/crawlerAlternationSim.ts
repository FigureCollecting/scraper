/**
 * Test helper — a simulated day (or two) of the hourly :30 crawler CronJob against a fake engine, for the
 * lists-alternation tests (QB-U21) and their golden. Three stores in every pass: mfc (id-range walked,
 * company lists, a Latest Additions listing), hpoi (id-range walked, no lists) and orzgk (listing only).
 * The fake engine records EVERY request; nothing here reaches a real host.
 */
import { createHash } from 'crypto';
import { runCrawlerPass, type CrawlerConfig, type CrawlerStoreSummary, type FetchLike, type HttpResponseLike } from '../../crawler/crawler';
import { createEmptyLedger, createMemoryLedgerStore, type Ledger, type LedgerStore, type MemoryLedgerStore } from '../../crawler/ledger';
import { createEmptyListsState, createMemoryListsStateStore, type ListsState, type ListsStateStore, type MemoryListsStateStore } from '../../crawler/listsState';

export const MIN_MS = 60_000;
export const HOUR_MS = 60 * MIN_MS;
export const DAY_MS = 24 * HOUR_MS;
/** 2026-10-06 00:30Z: the first hourly :30 pass of day one. */
export const DAY0 = Date.parse('2026-10-06T00:30:00.000Z');
/** Production's CRAWLER_LISTS_WINDOW_UTC, 15:30-22:30Z (00:30-07:30 JST): seven :30 passes, 15:30 to 21:30. */
export const PROD_WINDOW = { startMin: 15 * 60 + 30, endMin: 22 * 60 + 30 };

export const iso = (ms: number): string => new Date(ms).toISOString();
export const itemUrl = (siteId: string, id: number | string): string => `https://${siteId}.test/item/${id}`;

export interface Reply {
  status: number;
  body?: unknown;
}

/** Ten single-list companies: one list per group, so no list spacing moves the shared fake clock. */
export const GROUP_COUNT = 10;
export const DECL = Array.from({ length: GROUP_COUNT }, (_, i) => ({
  id: `c${i + 1}-d9`,
  url: `https://mfc.test/s?e=${i + 1}`,
  group: `c${i + 1}`,
  order: i + 1,
}));

/** A company list's ids: three per company, disjoint from every listing and id-range id. */
export const listOk = (listId: string): Reply => {
  const n = Number(/^c(\d+)-/.exec(listId)?.[1] ?? 0);
  const ids = [0, 1, 2].map((k) => 50_000 + n * 10 + k);
  return { status: 200, body: { siteId: 'mfc', items: ids.map((id) => ({ itemId: String(id), collectUrl: itemUrl('mfc', id) })), hasMore: false, count: ids.length } };
};

const LISTING_BASE: Record<string, number> = { mfc: 2000, hpoi: 3000, orzgk: 4000 };

export interface Call {
  at: number;
  method: 'GET' | 'POST';
  store: string;
  kind: 'listing' | 'range' | 'decl' | 'list' | 'post';
  /** The path and query, scraper base stripped (GET), or the POSTed url and its priority (POST). */
  line: string;
  page?: number;
}

export interface EngineOpts {
  /** GET /catalog/rotating?store= (the declaration; no store fetch). */
  decl?: () => Reply;
  /** GET /catalog/rotating?store=&list= (one company list). */
  list?: (listId: string) => Reply;
  /** Called on every listing GET (the tap or a backfill page) before it answers: a slow page moves the clock. */
  onListing?: (store: string, page: number) => void;
}

/**
 * The fake engine. Listing pages are newest-first and grow two ids an hour (page p of store S at hour h
 * holds four ids from BASE[S] + 10 + 2h - 4(p-1) down); id-range windows are synthesized; every POST is
 * accepted.
 */
export const makeEngine = (now: () => number, opts: EngineOpts = {}) => {
  const calls: Call[] = [];
  const resp = (status: number, body: unknown): HttpResponseLike => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  const fetch: FetchLike = async (url, init) => {
    const method = (init?.method ?? 'GET') as 'GET' | 'POST';
    const u = new URL(url);
    if (method === 'POST') {
      const body = JSON.parse(init?.body ?? '{}') as { url: string; priority?: string };
      const store = new URL(body.url).hostname.replace(/\.test$/, '');
      calls.push({ at: now(), method, store, kind: 'post', line: `POST ${body.url}${body.priority ? ` ${body.priority}` : ''}` });
      return resp(202, { success: true, deduplicated: false, position: 1 });
    }
    const store = u.searchParams.get('store') ?? '';
    const line = `GET ${u.pathname}${u.search}`;
    if (u.pathname === '/catalog/rotating') {
      const list = u.searchParams.get('list');
      calls.push({ at: now(), method, store, kind: list === null ? 'decl' : 'list', line });
      const r =
        list === null
          ? (opts.decl ?? (() => ({ status: 200, body: { siteId: store, rotatingSeedLists: DECL, count: DECL.length } })))()
          : (opts.list ?? listOk)(list);
      return resp(r.status, r.body ?? {});
    }
    if (u.searchParams.get('range') === '1') {
      calls.push({ at: now(), method, store, kind: 'range', line });
      const from = Number(u.searchParams.get('from'));
      const count = Number(u.searchParams.get('count'));
      const ids: number[] = [];
      for (let id = from; id > from - count && id >= 1; id--) ids.push(id);
      return resp(200, { items: ids.map((id) => ({ itemId: String(id), collectUrl: itemUrl(store, id) })), hasMore: true });
    }
    const page = Number(u.searchParams.get('page'));
    calls.push({ at: now(), method, store, kind: 'listing', line, page });
    opts.onListing?.(store, page);
    const hour = Math.floor((now() - DAY0) / HOUR_MS);
    const top = LISTING_BASE[store] + 10 + 2 * hour - 4 * (page - 1);
    const ids = [0, 1, 2, 3].map((k) => top - k);
    return resp(200, { items: ids.map((id) => ({ itemId: String(id), collectUrl: itemUrl(store, id) })), hasMore: true });
  };
  return { fetch, calls };
};

/** The three-store configuration every simulation runs: production's window, mode `both`, small caps. */
export const simConfig = (over: Partial<CrawlerConfig> = {}): CrawlerConfig => ({
  scraperServiceUrl: 'http://scraper.test',
  mode: 'both',
  phases: ['recent', 'backfill'],
  stores: ['mfc', 'hpoi', 'orzgk'],
  ledgerDir: '/unused',
  recentMaxPages: 1,
  backfillPagesPerRun: 1,
  maxRequests: 1000,
  maxEnqueuePerStore: 3,
  maxConcurrency: 2,
  requestSpacingMs: 0,
  requestTimeoutMs: 5000,
  reobserveAfterMs: 0,
  exhaustedRecheckMs: 7 * DAY_MS,
  storeEnqueueCaps: {},
  rangeStores: ['mfc', 'hpoi'],
  rangeIdsPerRun: 2,
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
  listsWindow: PROD_WINDOW,
  listsIntervalMs: 160 * HOUR_MS,
  listsDrainCaps: { mfc: 2 },
  listsSpacingMs: 10_000,
  ...over,
});

export const seedLedgers = (): Record<string, Ledger> => ({
  mfc: { ...createEmptyLedger('mfc'), range: { cursor: 500, frontier: 1000 } },
  hpoi: { ...createEmptyLedger('hpoi'), range: { cursor: 800, frontier: 900 } },
});

/** mfc's lists state with a backlog of `n` ids, so the drain posts on every pass. */
export const backlogState = (n: number): ListsState => ({
  ...createEmptyListsState('mfc'),
  pending: Array.from({ length: n }, (_, i) => ({ itemId: String(90_000 + i), collectUrl: itemUrl('mfc', 90_000 + i), group: 'seed' })),
});

export const clock = (start = DAY0) => {
  let t = start;
  return {
    now: () => t,
    set: (ms: number) => {
      t = ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
    sleep: async (ms: number) => {
      t += ms;
    },
  };
};

export interface PassTrace {
  at: number;
  calls: Call[];
  stores: CrawlerStoreSummary[];
}

export interface SimOptions {
  passes: number;
  /** First pass start (default DAY0); later passes follow hourly. */
  from?: number;
  /** Explicit start instants instead of `from` + hourly. */
  at?: number[];
  ledgers?: MemoryLedgerStore;
  lists?: MemoryListsStateStore;
  engine?: EngineOpts;
  /** Per-pass stores (a restart = new store objects over the same files); default the two memory stores. */
  storesFor?: (pass: number) => { ledgerStore: LedgerStore; listsStore: ListsStateStore };
  /** Called before each pass starts, with the pass index and its start instant. */
  beforePass?: (pass: number, at: number) => void | Promise<void>;
}

export const simulate = async (cfg: CrawlerConfig, o: SimOptions) => {
  const c = clock();
  const engine = makeEngine(c.now, o.engine);
  const ledgers = o.ledgers ?? createMemoryLedgerStore(seedLedgers());
  const lists = o.lists ?? createMemoryListsStateStore({ mfc: backlogState(80) });
  const passes: PassTrace[] = [];
  const starts = o.at ?? Array.from({ length: o.passes }, (_, i) => (o.from ?? DAY0) + i * HOUR_MS);
  for (const [i, at] of starts.entries()) {
    c.set(at);
    await o.beforePass?.(i, at);
    const mark = engine.calls.length;
    const deps = o.storesFor?.(i) ?? { ledgerStore: ledgers, listsStore: lists };
    const summary = await runCrawlerPass(cfg, { fetch: engine.fetch, ...deps, now: c.now, sleep: c.sleep });
    passes.push({ at, calls: engine.calls.slice(mark), stores: summary.stores });
  }
  return { passes, ledgers, lists, engine, clock: c };
};

export const storeOf = (p: PassTrace, siteId: string): CrawlerStoreSummary => {
  const s = p.stores.find((x) => x.siteId === siteId);
  if (!s) throw new Error(`no summary for ${siteId}`);
  return s;
};

const digest = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);

/**
 * The golden's shape: every request of every pass in order, a digest of the ledgers and lists state after
 * every pass, and the full lists state at the end.
 */
export const goldenTrace = async (cfg: CrawlerConfig, passes = 24) => {
  const ledgers = createMemoryLedgerStore(seedLedgers());
  const lists = createMemoryListsStateStore({ mfc: backlogState(80) });
  const stateDigests: string[] = [];
  const snapshot = (): string => digest([[...ledgers.files.entries()], [...lists.files.entries()]]);
  const sim = await simulate(cfg, {
    passes,
    ledgers,
    lists,
    beforePass: (i) => {
      if (i > 0) stateDigests.push(snapshot());
    },
  });
  stateDigests.push(snapshot());
  return {
    passes: sim.passes.map((p, i) => ({ at: iso(p.at), calls: p.calls.map((c) => c.line), stateAfter: stateDigests[i] })),
    finalLists: Object.fromEntries([...lists.files.entries()].sort(([a], [b]) => a.localeCompare(b))),
  };
};
