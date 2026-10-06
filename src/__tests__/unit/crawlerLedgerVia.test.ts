/**
 * runCrawlerPass — WHICH SOURCE wrote each ledger entry (`via`, QB-U27).
 *
 * The MFC hole detection has to tell the Latest Additions TAP's evidence from every other entry, and
 * until now an entry was `{ at, collectUrl[, sweptFrom] }` and could not be attributed. Every accepted
 * write now stamps the source:
 *   recent (store in rangeStores) -> 'tap'   (mfc: its recent listing IS the Latest Additions tap)
 *   recent (any other store)      -> 'recent'
 *   backfill -> 'backfill', range -> 'descent', gap -> 'gap', lists -> 'lists', seed -> 'seed'
 * FIRST WRITER WINS: a write to an id that already has an entry keeps its `via` (or keeps it ABSENT on
 * a legacy entry) and records the writer as `lastVia`. The ledger version stays 1, and an unknown
 * `via` (a newer build's) loads untouched.
 *
 * Mocked http surface, in-memory ledger / lists-state stores (and an in-memory fs for the file store),
 * fake clock.
 */
import { runCrawlerPass, type CrawlerConfig, type FetchLike, type HttpResponseLike } from '../../crawler/crawler';
import {
  createEmptyLedger,
  createFileLedgerStore,
  createMemoryLedgerStore,
  LEDGER_VERSION,
  type FsLike,
  type Ledger,
  type LedgerEntry,
} from '../../crawler/ledger';
import { createMemoryListsStateStore } from '../../crawler/listsState';
import { logger } from '../../utils/logger';

const HOUR_MS = 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * HOUR_MS;
/** 16:00Z — inside the 15:30-22:30Z lists window. */
const T0 = Date.parse('2026-10-06T16:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const item = (siteId: string, id: string): string => `https://${siteId}.test/item/${id}`;

const mkCfg = (over: Partial<CrawlerConfig> = {}): CrawlerConfig => ({
  scraperServiceUrl: 'http://scraper.test',
  mode: 'both',
  phases: ['recent'],
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
  rangeIdsPerRun: 3,
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
}

const accepted = (): Reply => ({ status: 202, body: { success: true, deduplicated: false, position: 1 } });
const dedup = (): Reply => ({ status: 202, body: { success: true, deduplicated: true, position: 1 } });
const refused = (): Reply => ({ status: 400, body: { error: 'no ruleset matches this url' } });
const itemsBody = (siteId: string, ids: string[], hasMore = false) => ({
  siteId,
  items: ids.map((id) => ({ itemId: id, collectUrl: item(siteId, id) })),
  collectUrls: ids.map((id) => item(siteId, id)),
  hasMore,
  count: ids.length,
});

/** The rotating company lists the lists step discovers: one group, two lists. */
const DECL = [
  { id: 'c1-d9', url: 'https://mfc.test/s?e=1&d=9', group: 'c1', order: 1 },
  { id: 'c1-d1', url: 'https://mfc.test/s?e=1&d=1', group: 'c1', order: 1 },
];
const LISTS: Record<string, string[]> = { 'c1-d9': ['401', '402'], 'c1-d1': ['402', '403'] };

interface FakeOpts {
  /** Listing page contents per store (absent page = empty, no more). */
  listing?: Record<string, Record<number, string[]>>;
  seeds?: string[];
  seed?: Record<string, string[]>;
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
    const siteId = u.searchParams.get('store') ?? 'mfc';
    let r: Reply;
    if (u.pathname === '/catalog/rotating') {
      const list = u.searchParams.get('list');
      r = list === null ? { status: 200, body: { siteId, rotatingSeedLists: DECL, count: DECL.length } } : { status: 200, body: itemsBody(siteId, LISTS[list] ?? []) };
    } else if (u.pathname === '/catalog' && u.searchParams.get('range') === '1') {
      const from = Number(u.searchParams.get('from'));
      const count = Number(u.searchParams.get('count'));
      const ids: string[] = [];
      for (let id = from; id > from - count && id >= 1; id--) ids.push(String(id));
      r = { status: 200, body: itemsBody(siteId, ids, true) };
    } else if (u.pathname === '/catalog' && u.searchParams.get('seeds') === '1') {
      const ids = opts.seeds ?? [];
      r = { status: 200, body: { siteId, seedLists: ids.map((id) => ({ id, url: `https://${siteId}.test/${id}`, cadence: 'weekly' })), count: ids.length } };
    } else if (u.pathname === '/catalog' && u.searchParams.get('seed')) {
      r = { status: 200, body: itemsBody(siteId, opts.seed?.[u.searchParams.get('seed')!] ?? []) };
    } else if (u.pathname === '/catalog') {
      const page = Number(u.searchParams.get('page'));
      const ids = opts.listing?.[siteId]?.[page] ?? [];
      r = { status: 200, body: { ...itemsBody(siteId, ids, false), page } };
    } else {
      r = (opts.ingest ?? accepted)(body?.url as string);
    }
    return resp(r.status, r.body ?? {});
  };
  return {
    fetch,
    calls,
    /** The item ids POSTed to /ingest/scrape, in dispatch order. */
    postedIds: () => calls.filter((c) => c.method === 'POST').map((c) => String(c.body.url).split('/').pop() as string),
  };
};

const clock = (start = T0) => {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
};

const entry = (siteId: string, id: string, hoursAgo: number, extra: Partial<LedgerEntry> = {}): LedgerEntry => ({
  at: iso(T0 - hoursAgo * HOUR_MS),
  collectUrl: item(siteId, id),
  ...extra,
});

const ledgerWith = (siteId: string, enqueued: Record<string, LedgerEntry> = {}, range?: Ledger['range']): Ledger => ({
  ...createEmptyLedger(siteId),
  enqueued,
  ...(range ? { range } : {}),
});

const run = async (cfg: CrawlerConfig, fake: ReturnType<typeof makeFake>, ledgers: ReturnType<typeof createMemoryLedgerStore>) => {
  const c = clock();
  const summary = await runCrawlerPass(cfg, {
    fetch: fake.fetch,
    ledgerStore: ledgers,
    listsStore: createMemoryListsStateStore(),
    now: c.now,
    sleep: c.sleep,
  });
  return summary;
};

const saved = (store: ReturnType<typeof createMemoryLedgerStore>, siteId: string): Ledger => store.files.get(siteId)!;

beforeEach(() => {
  jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  jest.spyOn(logger, 'info').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('ledger via — every write path stamps the source that CREATED the entry', () => {
  it("the recent listing of a store in rangeStores is the TAP ('tap'); every other store's recent listing is 'recent'", async () => {
    const fake = makeFake({ listing: { mfc: { 1: ['201', '202'] }, goodsmileus: { 1: ['g1'] } } });
    const ledgers = createMemoryLedgerStore();
    await run(mkCfg({ stores: ['mfc', 'goodsmileus'], rangeStores: ['mfc'], phases: ['recent'] }), fake, ledgers);

    expect(saved(ledgers, 'mfc').enqueued).toEqual({
      '201': { at: iso(T0), collectUrl: item('mfc', '201'), via: 'tap' },
      '202': { at: iso(T0), collectUrl: item('mfc', '202'), via: 'tap' },
    });
    expect(saved(ledgers, 'goodsmileus').enqueued).toEqual({ g1: { at: iso(T0), collectUrl: item('goodsmileus', 'g1'), via: 'recent' } });
  });

  it("a coalesced (deduplicated) POST is still a write and is stamped the same way", async () => {
    const fake = makeFake({ listing: { mfc: { 1: ['201'] } }, ingest: dedup });
    const ledgers = createMemoryLedgerStore();
    await run(mkCfg(), fake, ledgers);
    expect(saved(ledgers, 'mfc').enqueued['201'].via).toBe('tap');
  });

  it("the listing backfill stamps 'backfill'", async () => {
    const fake = makeFake({ listing: { goodsmileus: { 2: ['b1', 'b2'] } } });
    const ledgers = createMemoryLedgerStore();
    await run(mkCfg({ stores: ['goodsmileus'], rangeStores: [], phases: ['backfill'], backfillPagesPerRun: 1 }), fake, ledgers);

    expect(fake.postedIds()).toEqual(['b1', 'b2']);
    expect(saved(ledgers, 'goodsmileus').enqueued).toEqual({
      b1: { at: iso(T0), collectUrl: item('goodsmileus', 'b1'), via: 'backfill' },
      b2: { at: iso(T0), collectUrl: item('goodsmileus', 'b2'), via: 'backfill' },
    });
  });

  it("the id-range DESCENT stamps 'descent'", async () => {
    const fake = makeFake();
    const ledgers = createMemoryLedgerStore({ mfc: ledgerWith('mfc', {}, { cursor: 1000, frontier: 1000 }) });
    await run(mkCfg({ phases: ['backfill'] }), fake, ledgers);

    expect(fake.postedIds()).toEqual(['1000', '999', '998']);
    const e = saved(ledgers, 'mfc').enqueued;
    expect(Object.values(e).map((x) => x.via)).toEqual(['descent', 'descent', 'descent']);
    expect(e['999']).toEqual({ at: iso(T0), collectUrl: item('mfc', '999'), via: 'descent' });
  });

  it("the re-anchor GAP SWEEP stamps 'gap' and still stamps sweptFrom; the tap entry that moved the frontier is untouched", async () => {
    const tapEntry = entry('mfc', '1003', 2, { via: 'tap' });
    const fake = makeFake();
    const ledgers = createMemoryLedgerStore({ mfc: ledgerWith('mfc', { '1003': tapEntry }, { cursor: 0, frontier: 1000 }) });
    await run(mkCfg({ phases: ['backfill'], rangeGapBudget: 5 }), fake, ledgers);

    expect(fake.postedIds()).toEqual(['1001', '1002']);
    const e = saved(ledgers, 'mfc').enqueued;
    expect(e['1001']).toEqual({ at: iso(T0), collectUrl: item('mfc', '1001'), sweptFrom: 'reanchor', via: 'gap' });
    expect(e['1002']).toEqual({ at: iso(T0), collectUrl: item('mfc', '1002'), sweptFrom: 'reanchor', via: 'gap' });
    expect(e['1003']).toEqual(tapEntry);
  });

  it("an OPERATOR band's sweep stamps 'gap' too", async () => {
    const fake = makeFake();
    const ledgers = createMemoryLedgerStore({ mfc: ledgerWith('mfc', {}, { cursor: 0, frontier: 1000 }) });
    await run(mkCfg({ phases: ['backfill'], rangeGapBudget: 5, rangeGaps: { mfc: [{ from: 500, to: 501 }] } }), fake, ledgers);

    expect(fake.postedIds()).toEqual(['500', '501']);
    const e = saved(ledgers, 'mfc').enqueued;
    expect(e['500']).toEqual({ at: iso(T0), collectUrl: item('mfc', '500'), sweptFrom: 'operator', via: 'gap' });
  });

  it("the company-lists DRAIN stamps 'lists'", async () => {
    const fake = makeFake();
    const ledgers = createMemoryLedgerStore({ mfc: ledgerWith('mfc', {}, { cursor: 0, frontier: 1000 }) });
    await run(
      mkCfg({
        phases: ['backfill'],
        listsWindow: { startMin: 15 * 60 + 30, endMin: 22 * 60 + 30 },
        listsIntervalMs: 160 * HOUR_MS,
        listsDrainCaps: { mfc: 200 },
        listsSpacingMs: 10_000,
      }),
      fake,
      ledgers,
    );

    expect(fake.postedIds()).toEqual(['401', '402', '403']);
    const e = saved(ledgers, 'mfc').enqueued;
    expect(Object.fromEntries(Object.entries(e).map(([id, x]) => [id, x.via]))).toEqual({ '401': 'lists', '402': 'lists', '403': 'lists' });
  });

  it("the SEED pass stamps 'seed'", async () => {
    const fake = makeFake({ seeds: ['new-arrivals'], seed: { 'new-arrivals': ['s1', 's2'] } });
    const ledgers = createMemoryLedgerStore();
    await run(mkCfg({ stores: ['orzgk'], rangeStores: [], mode: 'seed', phases: ['seed'] }), fake, ledgers);

    expect(saved(ledgers, 'orzgk').enqueued).toEqual({
      s1: { at: iso(T0), collectUrl: item('orzgk', 's1'), via: 'seed' },
      s2: { at: iso(T0), collectUrl: item('orzgk', 's2'), via: 'seed' },
    });
  });

  it('a refused POST writes nothing, so nothing is stamped', async () => {
    const fake = makeFake({ listing: { mfc: { 1: ['201'] } }, ingest: refused });
    const ledgers = createMemoryLedgerStore();
    await run(mkCfg(), fake, ledgers);
    expect(saved(ledgers, 'mfc').enqueued).toEqual({});
  });
});

describe('ledger via — FIRST WRITER WINS; a re-write records lastVia', () => {
  it("a recent re-observation on the TAP keeps the entry's via and records lastVia 'tap'; a young entry is not touched", async () => {
    const fake = makeFake({ listing: { mfc: { 1: ['201', '202', '203'] } } });
    const young = entry('mfc', '203', 1, { via: 'lists' });
    const ledgers = createMemoryLedgerStore({
      mfc: ledgerWith('mfc', { '201': entry('mfc', '201', 50, { via: 'descent' }), '203': young }),
    });
    await run(mkCfg({ reobserveAfterMs: 24 * HOUR_MS }), fake, ledgers);

    expect(fake.postedIds()).toEqual(['201', '202']);
    const e = saved(ledgers, 'mfc').enqueued;
    expect(e['201']).toEqual({ at: iso(T0), collectUrl: item('mfc', '201'), via: 'descent', lastVia: 'tap' });
    expect(e['202']).toEqual({ at: iso(T0), collectUrl: item('mfc', '202'), via: 'tap' });
    expect(e['203']).toEqual(young);
  });

  it("a recent re-observation on a listing store keeps via and records lastVia 'recent'", async () => {
    const fake = makeFake({ listing: { goodsmileus: { 1: ['g1'] } } });
    const ledgers = createMemoryLedgerStore({ goodsmileus: ledgerWith('goodsmileus', { g1: entry('goodsmileus', 'g1', 50, { via: 'backfill' }) }) });
    await run(mkCfg({ stores: ['goodsmileus'], rangeStores: [], reobserveAfterMs: 24 * HOUR_MS }), fake, ledgers);

    expect(saved(ledgers, 'goodsmileus').enqueued.g1).toEqual({ at: iso(T0), collectUrl: item('goodsmileus', 'g1'), via: 'backfill', lastVia: 'recent' });
  });

  it('a LEGACY entry (no via) re-observed by the tap keeps via ABSENT and gains lastVia', async () => {
    const fake = makeFake({ listing: { mfc: { 1: ['201'] } } });
    const ledgers = createMemoryLedgerStore({ mfc: ledgerWith('mfc', { '201': entry('mfc', '201', 50) }) });
    await run(mkCfg({ reobserveAfterMs: 24 * HOUR_MS }), fake, ledgers);

    const e = saved(ledgers, 'mfc').enqueued['201'];
    expect(e).toEqual({ at: iso(T0), collectUrl: item('mfc', '201'), lastVia: 'tap' });
    expect(Object.prototype.hasOwnProperty.call(e, 'via')).toBe(false);
  });

  it('a later re-observation overwrites lastVia and still keeps the first via', async () => {
    const fake = makeFake({ listing: { mfc: { 1: ['201'] } } });
    const ledgers = createMemoryLedgerStore({ mfc: ledgerWith('mfc', { '201': entry('mfc', '201', 50, { via: 'gap', lastVia: 'reobserve' }) }) });
    await run(mkCfg({ reobserveAfterMs: 24 * HOUR_MS }), fake, ledgers);

    expect(saved(ledgers, 'mfc').enqueued['201']).toMatchObject({ via: 'gap', lastVia: 'tap' });
  });

  it("the re-observation LANE keeps via (absent on a legacy entry) and records lastVia 'reobserve'", async () => {
    const fake = makeFake();
    const ledgers = createMemoryLedgerStore({
      goodsmileus: ledgerWith('goodsmileus', {
        a: entry('goodsmileus', 'a', 90, { via: 'backfill' }),
        b: entry('goodsmileus', 'b', 80),
      }),
    });
    await run(mkCfg({ stores: ['goodsmileus'], rangeStores: [], phases: ['reobserve'], storeReobserveCaps: { goodsmileus: 5 } }), fake, ledgers);

    expect(fake.postedIds()).toEqual(['a', 'b']);
    const e = saved(ledgers, 'goodsmileus').enqueued;
    expect(e.a).toEqual({ at: iso(T0), collectUrl: item('goodsmileus', 'a'), via: 'backfill', lastVia: 'reobserve' });
    expect(e.b).toEqual({ at: iso(T0), collectUrl: item('goodsmileus', 'b'), lastVia: 'reobserve' });
    expect(Object.prototype.hasOwnProperty.call(e.b, 'via')).toBe(false);
  });

  it('a REFUSED re-observation observed nothing: via and lastVia stay as they were', async () => {
    const fake = makeFake({ ingest: refused });
    const ledgers = createMemoryLedgerStore({
      goodsmileus: ledgerWith('goodsmileus', { a: entry('goodsmileus', 'a', 90, { via: 'seed', lastVia: 'recent' }) }),
    });
    await run(mkCfg({ stores: ['goodsmileus'], rangeStores: [], phases: ['reobserve'], storeReobserveCaps: { goodsmileus: 5 } }), fake, ledgers);

    expect(saved(ledgers, 'goodsmileus').enqueued.a).toMatchObject({ at: iso(T0 - 90 * HOUR_MS), via: 'seed', lastVia: 'recent', reobserveFailures: 1 });
  });

  it("an UNKNOWN via written by a newer build survives a re-observation untouched", async () => {
    const fake = makeFake({ listing: { mfc: { 1: ['201'] } } });
    const future = entry('mfc', '201', 50, { via: 'future-lane' as unknown as LedgerEntry['via'] });
    const ledgers = createMemoryLedgerStore({ mfc: ledgerWith('mfc', { '201': future }) });
    await run(mkCfg({ reobserveAfterMs: 24 * HOUR_MS }), fake, ledgers);

    expect(saved(ledgers, 'mfc').enqueued['201']).toEqual({ at: iso(T0), collectUrl: item('mfc', '201'), via: 'future-lane', lastVia: 'tap' });
  });
});

describe('ledger via — the file stays version 1 and every build can read it', () => {
  /** An in-memory fs: path -> text. */
  const memFs = (initial: Record<string, string> = {}) => {
    const files = new Map<string, string>(Object.entries(initial));
    const fs: FsLike = {
      readFile: async (p) => {
        const v = files.get(p);
        if (v === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return v;
      },
      writeFile: async (p, data) => {
        files.set(p, data);
      },
      rename: async (from, to) => {
        files.set(to, files.get(from)!);
        files.delete(from);
      },
      mkdir: async () => undefined,
    };
    return { fs, files };
  };
  const DIR = '/ledgers';
  const FILE = '/ledgers/mfc.json';

  /** A ledger exactly as today's build writes it: no via anywhere. */
  const todays: Ledger = {
    version: LEDGER_VERSION,
    siteId: 'mfc',
    enqueued: {
      '1': { at: '2026-09-01T00:00:00.000Z', collectUrl: item('mfc', '1') },
      '2': { at: '2026-09-02T00:00:00.000Z', collectUrl: item('mfc', '2'), sweptFrom: 'reanchor' },
      '3': { at: '2026-09-03T00:00:00.000Z', collectUrl: item('mfc', '3'), reobserveFailedAt: '2026-09-04T00:00:00.000Z', reobserveFailures: 2 },
    },
    backfill: { cursor: null },
    recent: { lastRunAt: '2026-09-03T00:00:00.000Z', lastNewCount: 1 },
    range: { cursor: 900, frontier: 1000 },
    updatedAt: '2026-09-03T00:00:00.000Z',
  };

  it("a ledger written by today's code loads unchanged and saves back byte for byte", async () => {
    const text = JSON.stringify(todays, null, 2);
    const { fs, files } = memFs({ [FILE]: text });
    const store = createFileLedgerStore(DIR, fs, 1);
    const loaded = await store.load('mfc');
    expect(loaded).toEqual(todays);
    await store.save(loaded as Ledger);
    expect(files.get(FILE)).toBe(text);
  });

  it('a ledger carrying via and lastVia (and an unknown via) loads and saves back byte for byte, never corrupt', async () => {
    // The load/save path is develop's, unchanged: this is the OLDER BUILD reading a newer file.
    const withVia: Ledger = {
      ...todays,
      enqueued: {
        ...todays.enqueued,
        '4': { at: '2026-10-01T00:00:00.000Z', collectUrl: item('mfc', '4'), via: 'tap', lastVia: 'reobserve' },
        '5': { at: '2026-10-01T00:00:00.000Z', collectUrl: item('mfc', '5'), lastVia: 'tap' },
        '6': { at: '2026-10-01T00:00:00.000Z', collectUrl: item('mfc', '6'), via: 'future-lane' as unknown as LedgerEntry['via'], lastVia: 'later-lane' as unknown as LedgerEntry['via'] },
      },
    };
    const text = JSON.stringify(withVia, null, 2);
    const { fs, files } = memFs({ [FILE]: text });
    const store = createFileLedgerStore(DIR, fs, 1);
    const loaded = await store.load('mfc');
    expect(loaded).not.toBe('corrupt');
    expect(loaded).toEqual(withVia);
    await store.save(loaded as Ledger);
    expect(files.get(FILE)).toBe(text);
  });

  it("a pass over today's ledger stamps only what it writes, keeps version 1, and the file it leaves loads again", async () => {
    const { fs, files } = memFs({ [FILE]: JSON.stringify(todays, null, 2) });
    const store = createFileLedgerStore(DIR, fs, 1);
    const fake = makeFake({ listing: { mfc: { 1: ['1', '7'] } } });
    const c = clock();
    await runCrawlerPass(mkCfg(), { fetch: fake.fetch, ledgerStore: store, listsStore: createMemoryListsStateStore(), now: c.now, sleep: c.sleep });

    const doc = JSON.parse(files.get(FILE)!);
    expect(doc.version).toBe(1);
    expect(doc.enqueued['7']).toEqual({ at: iso(T0), collectUrl: item('mfc', '7'), via: 'tap' });
    // Known and young enough (reobserveAfterMs 0 = never): not re-written, so not stamped.
    expect(doc.enqueued['1']).toEqual(todays.enqueued['1']);
    expect(doc.enqueued['2']).toEqual(todays.enqueued['2']);
    expect(doc.enqueued['3']).toEqual(todays.enqueued['3']);
    const reloaded = await createFileLedgerStore(DIR, fs, 1).load('mfc');
    expect(reloaded).not.toBe('corrupt');
    expect((reloaded as Ledger).enqueued['7'].via).toBe('tap');
  });
});
