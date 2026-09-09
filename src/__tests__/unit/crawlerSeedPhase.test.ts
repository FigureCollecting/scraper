/**
 * runCrawlerPass — CRAWLER_MODE=seed: the SEED PHASE, and nothing else.
 *
 * A seed pass discovers the store's declared seed lists (GET /catalog?store=&seeds=1), then fetches
 * each one in DECLARED order (GET /catalog?store=&seed=<listId>) and enqueues the ids the ledger has
 * never seen. It is a slow, bounded poll of a store's own featured pages: no listing walk, no id
 * space, no cursor. It reuses the crawler's durable ledger, its per-store enqueue cap and its global
 * request budget unchanged — only the source of the ids differs.
 *
 * Every test drives a MOCKED http surface, an in-memory ledger store and a fake clock.
 */
import { runCrawlerPass, type CrawlerConfig, type FetchLike, type HttpResponseLike } from '../../crawler/crawler';
import { createMemoryLedgerStore, createEmptyLedger, type Ledger } from '../../crawler/ledger';
import { logger } from '../../utils/logger';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-09-09T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

const mkCfg = (over: Partial<CrawlerConfig> = {}): CrawlerConfig => ({
  scraperServiceUrl: 'http://scraper.test',
  mode: 'seed',
  stores: ['orzgk'],
  ledgerDir: '/unused',
  recentMaxPages: 3,
  backfillPagesPerRun: 5,
  maxRequests: 100,
  maxEnqueuePerStore: 50,
  maxConcurrency: 2,
  requestSpacingMs: 0,
  requestTimeoutMs: 5000,
  reobserveAfterMs: 0,
  exhaustedRecheckMs: WEEK_MS,
  storeEnqueueCaps: {},
  rangeStores: [],
  rangeIdsPerRun: 50,
  rangeFrontiers: {},
  seedSpacingMs: 10_000,
  ...over,
});

const collectUrl = (siteId: string, id: string): string => `https://${siteId}.test/api/${id}`;

interface Reply {
  status: number;
  body?: unknown;
  throwErr?: boolean;
}

/** The declared-lists discovery reply. */
const seedsOk = (siteId: string, ids: string[]): Reply => ({
  status: 200,
  body: { siteId, seedLists: ids.map((id) => ({ id, url: `https://${siteId}.test/${id}`, cadence: 'weekly' })), count: ids.length },
});

/** A discovery reply whose entries carry EXPLICIT urls — for the two-ids-one-url case. */
const seedsOkUrls = (siteId: string, entries: Array<[string, string]>): Reply => ({
  status: 200,
  body: { siteId, seedLists: entries.map(([id, url]) => ({ id, url, cadence: 'weekly' })), count: entries.length },
});

/** One fetched seed list. `hasMore` is always false on this axis. */
const seedOk = (siteId: string, listId: string, itemIds: string[]): Reply => ({
  status: 200,
  body: {
    siteId,
    listId,
    url: `https://${siteId}.test/${listId}`,
    items: itemIds.map((id) => ({ itemId: id, collectUrl: collectUrl(siteId, id) })),
    collectUrls: itemIds.map((id) => collectUrl(siteId, id)),
    hasMore: false,
    count: itemIds.length,
  },
});

const cooldownReply = (siteId: string): Reply => ({ status: 503, body: { error: 'cooldown', siteId, host: `${siteId}.test`, remainingMs: 60_000 } });
const unsupportedReply = (siteId: string): Reply => ({ status: 422, body: { error: 'unsupported', siteId, reason: 'store declares no seed lists' } });
const notFoundReply = (): Reply => ({ status: 404, body: { error: 'nope' } });

interface FakeOpts {
  seeds?: (siteId: string) => Reply;
  seed?: (siteId: string, listId: string) => Reply;
  catalog?: (siteId: string, page: number) => Reply;
  ingest?: (url: string) => Reply;
}

const makeFake = (opts: FakeOpts) => {
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
      let r: Reply;
      if (u.searchParams.get('seeds') === '1') {
        r = (opts.seeds ?? ((s) => seedsOk(s, ['new-arrivals', 'staff-picks'])))(siteId);
      } else if (u.searchParams.get('seed')) {
        r = (opts.seed ?? ((s, l) => seedOk(s, l, ['a', 'b'])))(siteId, u.searchParams.get('seed') as string);
      } else {
        r = (opts.catalog ?? (() => ({ status: 500, body: { error: 'the seed pass must not walk the listing' } })))(siteId, Number(u.searchParams.get('page')));
      }
      if (r.throwErr) throw new Error('catalog network error');
      return resp(r.status, r.body ?? {});
    }
    const u = body?.url as string;
    const r = opts.ingest ? opts.ingest(u) : { status: 202, body: { success: true, itemId: u, deduplicated: false, position: 1 } };
    if (r.throwErr) throw new Error('ingest timeout');
    return resp(r.status, r.body ?? { success: true, itemId: u, deduplicated: false, position: 1 });
  };
  const catalogUrls = () => calls.filter((c) => c.url.includes('/catalog')).map((c) => c.url);
  return {
    fetch,
    calls,
    catalogUrls,
    /** The listIds asked for, in dispatch order (discovery excluded). */
    seedsAsked: () =>
      catalogUrls()
        .map((u) => new URL(u).searchParams.get('seed'))
        .filter((v): v is string => v !== null),
    discoveries: () => catalogUrls().filter((u) => new URL(u).searchParams.get('seeds') === '1').length,
    posted: () => calls.filter((c) => c.url.includes('/ingest')).map((c) => c.body.url as string),
  };
};

const ledgerWith = (siteId: string, ids: string[], at: number, over: Partial<Ledger> = {}): Ledger => ({
  ...createEmptyLedger(siteId),
  enqueued: Object.fromEntries(ids.map((id) => [id, { at: iso(at), collectUrl: collectUrl(siteId, id) }])),
  ...over,
});

const clock = (start = T0) => {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
};

const storeOf = (summary: Awaited<ReturnType<typeof runCrawlerPass>>, siteId = 'orzgk') =>
  summary.stores.find((s) => s.siteId === siteId)!;

describe('runCrawlerPass — seed mode', () => {
  it('discovers the declared lists, then fetches each ONE in declared order, enqueuing every new id', async () => {
    const fake = makeFake({ seed: (s, l) => seedOk(s, l, l === 'new-arrivals' ? ['a', 'b'] : ['c']) });
    const store = createMemoryLedgerStore();
    const c = clock();
    const summary = await runCrawlerPass(mkCfg(), { fetch: fake.fetch, ledgerStore: store, now: c.now });

    expect(fake.discoveries()).toBe(1);
    expect(fake.seedsAsked()).toEqual(['new-arrivals', 'staff-picks']);
    expect(fake.posted()).toEqual([collectUrl('orzgk', 'a'), collectUrl('orzgk', 'b'), collectUrl('orzgk', 'c')]);

    const st = storeOf(summary);
    expect(st.enqueued).toBe(3);
    expect(st.seedLists).toEqual([
      { listId: 'new-arrivals', discovered: 2, known: 0, enqueued: 2 },
      { listId: 'staff-picks', discovered: 1, known: 0, enqueued: 1 },
    ]);
    expect(st.seedStopped).toBeNull();
    expect(summary.mode).toBe('seed');
    expect(Object.keys(store.files.get('orzgk')!.enqueued).sort()).toEqual(['a', 'b', 'c']);
  });

  it('LEDGER DEDUP: ids already enqueued are counted known and never re-POSTed', async () => {
    const fake = makeFake({ seed: (s, l) => seedOk(s, l, ['a', 'b']) });
    const store = createMemoryLedgerStore({ orzgk: ledgerWith('orzgk', ['a'], T0 - WEEK_MS * 4) });
    const c = clock();
    const summary = await runCrawlerPass(mkCfg({ reobserveAfterMs: WEEK_MS }), { fetch: fake.fetch, ledgerStore: store, now: c.now });

    // Both lists offer a+b; `a` is in the ledger, and a SEED pass never re-observes however old it is.
    expect(fake.posted()).toEqual([collectUrl('orzgk', 'b')]);
    const st = storeOf(summary);
    expect(st.seedLists).toEqual([
      { listId: 'new-arrivals', discovered: 2, known: 1, enqueued: 1 },
      { listId: 'staff-picks', discovered: 2, known: 2, enqueued: 0 },
    ]);
    expect(st.reobserved).toBe(0);
  });

  it('never fetches the same list twice in one run, even when discovery repeats an id', async () => {
    const fake = makeFake({ seeds: (s) => seedsOk(s, ['shelf', 'shelf', 'other']) });
    const summary = await runCrawlerPass(mkCfg(), { fetch: fake.fetch, ledgerStore: createMemoryLedgerStore(), now: clock().now });

    expect(fake.seedsAsked()).toEqual(['shelf', 'other']);
    expect(storeOf(summary).seedLists.map((l) => l.listId)).toEqual(['shelf', 'other']);
  });

  it('honours the per-store enqueue cap, and reports the ids it did not get to', async () => {
    const fake = makeFake({ seed: (s, l) => seedOk(s, l, ['a', 'b', 'c']) });
    const summary = await runCrawlerPass(
      mkCfg({ storeEnqueueCaps: { orzgk: 2 } }),
      { fetch: fake.fetch, ledgerStore: createMemoryLedgerStore(), now: clock().now },
    );

    expect(fake.posted()).toEqual([collectUrl('orzgk', 'a'), collectUrl('orzgk', 'b')]);
    const st = storeOf(summary);
    expect(st.enqueued).toBe(2);
    expect(st.capApplied).toBe(2);
  });

  it('honours the GLOBAL request budget: the pass stops and says so', async () => {
    const fake = makeFake({ seed: (s, l) => seedOk(s, l, ['a', 'b', 'c']) });
    // 1 discovery + 1 seed GET + 2 ingest POSTs = 4.
    const summary = await runCrawlerPass(mkCfg({ maxRequests: 4 }), { fetch: fake.fetch, ledgerStore: createMemoryLedgerStore(), now: clock().now });

    expect(summary.budgetExhausted).toBe(true);
    expect(summary.requestsIssued).toBe(4);
    expect(fake.posted()).toHaveLength(2);
  });

  it('STOPS the store at the first cooldown, and reports it — the remaining lists are left alone', async () => {
    const fake = makeFake({ seed: (s, l) => (l === 'new-arrivals' ? cooldownReply(s) : seedOk(s, l, ['c'])) });
    const summary = await runCrawlerPass(mkCfg(), { fetch: fake.fetch, ledgerStore: createMemoryLedgerStore(), now: clock().now });

    expect(fake.seedsAsked()).toEqual(['new-arrivals']);
    expect(fake.posted()).toEqual([]);
    const st = storeOf(summary);
    expect(st.seedStopped).toBe('cooldown');
    expect(st.skipped).toBe(1);
    expect(st.seedLists).toEqual([]);
  });

  it('STOPS the store on a 4xx from a seed list, and on a 422 (the list is declared nowhere)', async () => {
    const fourOhFour = makeFake({ seed: () => notFoundReply() });
    const a = await runCrawlerPass(mkCfg(), { fetch: fourOhFour.fetch, ledgerStore: createMemoryLedgerStore(), now: clock().now });
    expect(fourOhFour.seedsAsked()).toEqual(['new-arrivals']);
    expect(storeOf(a).seedStopped).toBe('failed');
    expect(storeOf(a).errors).toBe(1);

    const gone = makeFake({ seed: (s) => unsupportedReply(s) });
    const b = await runCrawlerPass(mkCfg(), { fetch: gone.fetch, ledgerStore: createMemoryLedgerStore(), now: clock().now });
    expect(gone.seedsAsked()).toEqual(['new-arrivals']);
    expect(storeOf(b).seedStopped).toBe('unsupported');
  });

  it('a store that declares NO seed lists costs exactly one discovery GET and is reported', async () => {
    const fake = makeFake({ seeds: (s) => unsupportedReply(s) });
    const summary = await runCrawlerPass(mkCfg(), { fetch: fake.fetch, ledgerStore: createMemoryLedgerStore(), now: clock().now });

    expect(fake.catalogUrls()).toHaveLength(1);
    expect(fake.posted()).toEqual([]);
    const st = storeOf(summary);
    expect(st.seedStopped).toBe('unsupported');
    expect(st.seedLists).toEqual([]);
  });

  it('a discovery body that is not a list of seed lists is a failure, never an empty poll', async () => {
    const fake = makeFake({ seeds: () => ({ status: 200, body: { siteId: 'orzgk', seedLists: 'nope' } }) });
    const summary = await runCrawlerPass(mkCfg(), { fetch: fake.fetch, ledgerStore: createMemoryLedgerStore(), now: clock().now });

    const st = storeOf(summary);
    expect(st.seedStopped).toBe('failed');
    expect(st.errors).toBe(1);
    expect(fake.posted()).toEqual([]);
  });

  it('drops malformed entries from a discovery body and polls the well-formed ones', async () => {
    const fake = makeFake({
      seeds: (s) => ({ status: 200, body: { siteId: s, seedLists: [{ id: 'good' }, { id: '' }, null, 'x', { cadence: 'weekly' }], count: 5 } }),
    });
    const summary = await runCrawlerPass(mkCfg(), { fetch: fake.fetch, ledgerStore: createMemoryLedgerStore(), now: clock().now });

    expect(fake.seedsAsked()).toEqual(['good']);
    expect(storeOf(summary).seedLists.map((l) => l.listId)).toEqual(['good']);
  });

  it('runs every configured store, each with its own ledger and its own stop', async () => {
    const fake = makeFake({
      seeds: (s) => seedsOk(s, [`${s}-list`]),
      seed: (s, l) => (s === 'sick' ? cooldownReply(s) : seedOk(s, l, ['a'])),
    });
    const store = createMemoryLedgerStore();
    const summary = await runCrawlerPass(mkCfg({ stores: ['orzgk', 'sick'] }), { fetch: fake.fetch, ledgerStore: store, now: clock().now });

    expect(fake.posted()).toEqual([collectUrl('orzgk', 'a')]);
    expect(storeOf(summary, 'orzgk').seedStopped).toBeNull();
    expect(storeOf(summary, 'sick').seedStopped).toBe('cooldown');
  });

  it('an explicit per-store cap of 0 pulls the store out of the seed pass entirely — not one request', async () => {
    const fake = makeFake({});
    const summary = await runCrawlerPass(
      mkCfg({ storeEnqueueCaps: { orzgk: 0 } }),
      { fetch: fake.fetch, ledgerStore: createMemoryLedgerStore(), now: clock().now },
    );

    expect(fake.calls).toHaveLength(0);
    expect(storeOf(summary).seedLists).toEqual([]);
  });

  it('the ledger is persisted after EVERY list, so a crash mid-pass loses nothing', async () => {
    const fake = makeFake({ seed: (s, l) => seedOk(s, l, [l === 'new-arrivals' ? 'a' : 'c']) });
    const store = createMemoryLedgerStore();
    await runCrawlerPass(mkCfg(), { fetch: fake.fetch, ledgerStore: store, now: clock().now });

    expect(store.saveLog).toEqual(['orzgk', 'orzgk']);
  });

  it('a TRANSIENT ingest failure stops the store and reports `failed` — never `budget` while the budget is intact', async () => {
    let posts = 0;
    const fake = makeFake({
      seed: (s, l) => seedOk(s, l, ['a', 'b']),
      ingest: () => (++posts === 1 ? { status: 503, body: { error: 'scraper unwell' } } : { status: 202, body: { success: true } }),
    });
    const summary = await runCrawlerPass(mkCfg(), { fetch: fake.fetch, ledgerStore: createMemoryLedgerStore(), now: clock().now });

    const st = storeOf(summary);
    expect(st.seedStopped).toBe('failed');
    expect(summary.budgetExhausted).toBe(false);
    // The store stopped inside the first list: the second list is never fetched.
    expect(fake.seedsAsked()).toEqual(['new-arrivals']);
  });

  it('a genuinely exhausted budget still reports `budget`', async () => {
    const fake = makeFake({ seed: (s, l) => seedOk(s, l, ['a', 'b', 'c']) });
    // 1 discovery + 1 seed GET + 2 ingest POSTs = 4; the third POST is refused by the gate.
    const summary = await runCrawlerPass(mkCfg({ maxRequests: 4 }), { fetch: fake.fetch, ledgerStore: createMemoryLedgerStore(), now: clock().now });

    expect(storeOf(summary).seedStopped).toBe('budget');
    expect(summary.budgetExhausted).toBe(true);
  });

  it('CAP: once the per-store cap is spent, later lists are NOT fetched for guaranteed-zero enqueues', async () => {
    const fake = makeFake({
      seeds: (s) => seedsOk(s, ['one', 'two', 'three']),
      seed: (s, l) => seedOk(s, l, ['a', 'b']),
    });
    const summary = await runCrawlerPass(
      mkCfg({ storeEnqueueCaps: { orzgk: 1 } }),
      { fetch: fake.fetch, ledgerStore: createMemoryLedgerStore(), now: clock().now },
    );

    expect(fake.seedsAsked()).toEqual(['one']);
    const st = storeOf(summary);
    expect(st.seedStopped).toBe('cap');
    expect(st.enqueued).toBe(1);
  });

  it('SPACING: waits CRAWLER_SEED_SPACING_MS between consecutive seed fetches, but not before the first', async () => {
    const fake = makeFake({ seeds: (s) => seedsOk(s, ['one', 'two', 'three']) });
    const sleep = jest.fn(async () => {});
    await runCrawlerPass(
      mkCfg({ seedSpacingMs: 10_000 }),
      { fetch: fake.fetch, ledgerStore: createMemoryLedgerStore(), now: clock().now, sleep },
    );

    expect(fake.seedsAsked()).toEqual(['one', 'two', 'three']);
    // Three fetches ⇒ two gaps. The global requestSpacingMs is 0 here, so the gate sleeps for nothing.
    expect(sleep.mock.calls.filter((c) => c[0] === 10_000)).toHaveLength(2);
  });

  it('SPACING: a per-store floor of 0 disables the wait', async () => {
    const fake = makeFake({ seeds: (s) => seedsOk(s, ['one', 'two']) });
    const sleep = jest.fn(async () => {});
    await runCrawlerPass(mkCfg({ seedSpacingMs: 0 }), { fetch: fake.fetch, ledgerStore: createMemoryLedgerStore(), now: clock().now, sleep });

    expect(fake.seedsAsked()).toEqual(['one', 'two']);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('URL DEDUP: two declared ids sharing one url are fetched ONCE, both ids credited, the slip WARNed', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    try {
      const fake = makeFake({
        seeds: (s) =>
          seedsOkUrls(s, [
            ['new-arrivals', 'https://orzgk.test/shelf'],
            ['front-shelf', 'https://orzgk.test/shelf'],
            ['picks', 'https://orzgk.test/picks'],
          ]),
        seed: (s, l) => seedOk(s, l, l === 'new-arrivals' ? ['a'] : ['c']),
      });
      const summary = await runCrawlerPass(mkCfg(), { fetch: fake.fetch, ledgerStore: createMemoryLedgerStore(), now: clock().now });

      expect(fake.seedsAsked()).toEqual(['new-arrivals', 'picks']);
      expect(storeOf(summary).seedLists).toEqual([
        { listId: 'new-arrivals', discovered: 1, known: 0, enqueued: 1, alsoDeclaredAs: ['front-shelf'] },
        { listId: 'picks', discovered: 1, known: 0, enqueued: 1 },
      ]);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('same url'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('a ledger save that FAILS stops the store mid-pass — the remaining lists are not polled', async () => {
    const fake = makeFake({ seed: (s, l) => seedOk(s, l, ['a']) });
    const inner = createMemoryLedgerStore();
    const store = { ...inner, save: jest.fn(async () => { throw new Error('disk full'); }) };
    const summary = await runCrawlerPass(mkCfg(), { fetch: fake.fetch, ledgerStore: store, now: clock().now });

    expect(fake.seedsAsked()).toEqual(['new-arrivals']);
    const st = storeOf(summary);
    expect(st.seedStopped).toBe('failed');
    expect(st.errors).toBe(1);
    expect(st.seedLists).toHaveLength(1);
  });

  it('a corrupt ledger refuses the store: no discovery, no fetch, no overwrite', async () => {
    const fake = makeFake({});
    const store = createMemoryLedgerStore({ orzgk: 'corrupt' });
    const summary = await runCrawlerPass(mkCfg(), { fetch: fake.fetch, ledgerStore: store, now: clock().now });

    expect(fake.calls).toHaveLength(0);
    expect(store.saveLog).toEqual([]);
    expect(storeOf(summary).ledgerCorrupt).toBe(true);
  });
});

describe('runCrawlerPass — the seed phase belongs to seed mode ALONE', () => {
  it.each(['recent', 'backfill', 'both'] as const)('mode %s runs NO seed phase at all', async (mode) => {
    const fake = makeFake({
      catalog: (s, p) => ({
        status: 200,
        body: { siteId: s, page: p, url: 'u', items: [], collectUrls: [], hasMore: false, count: 0 },
      }),
    });
    const summary = await runCrawlerPass(mkCfg({ mode }), { fetch: fake.fetch, ledgerStore: createMemoryLedgerStore(), now: clock().now });

    expect(fake.discoveries()).toBe(0);
    expect(fake.seedsAsked()).toEqual([]);
    expect(storeOf(summary).seedLists).toEqual([]);
    expect(storeOf(summary).seedStopped).toBeNull();
  });

  it('seed mode runs NO recent, backfill or id-range phase', async () => {
    const fake = makeFake({ seed: (s, l) => seedOk(s, l, ['a']) });
    const store = createMemoryLedgerStore();
    const summary = await runCrawlerPass(
      mkCfg({ rangeStores: ['orzgk'], rangeFrontiers: { orzgk: 500 } }),
      { fetch: fake.fetch, ledgerStore: store, now: clock().now },
    );

    expect(fake.catalogUrls().some((u) => new URL(u).searchParams.has('page'))).toBe(false);
    expect(fake.catalogUrls().some((u) => new URL(u).searchParams.get('range') === '1')).toBe(false);
    const st = storeOf(summary);
    expect(st.pagesFetched).toBe(0);
    expect(st.rangeWalked).toBe(0);
    expect(store.files.get('orzgk')!.range).toBeUndefined();
    expect(st.backfillCursor).toBeNull();
  });
});
