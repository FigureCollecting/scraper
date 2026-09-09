/**
 * runCrawlerPass — ONE bounded catalog-crawl pass (the CronJob body). Over the
 * configured stores it walks the scraper's own GET /catalog?store=&page= feed —
 * RECENT (newest-first, from page 1, stop at the first page with nothing new)
 * THEN BACKFILL (resume a durable per-store page cursor) — and POSTs every new
 * item's collectUrl to /ingest/scrape, all throttled by the global egress gate.
 *
 * Every test drives a MOCKED http surface (scripted /catalog pages + /ingest
 * replies), an in-memory ledger store, and a fake clock. No network, no store.
 */
import { runCrawlerPass, type CrawlerConfig, type FetchLike, type HttpResponseLike } from '../../crawler/crawler';
import { createMemoryLedgerStore, createEmptyLedger, type Ledger } from '../../crawler/ledger';
import { logger } from '../../utils/logger';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-09-06T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

const waitFor = async (pred: () => boolean, timeoutMs = 3000): Promise<void> => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 1));
  }
};

const mkCfg = (over: Partial<CrawlerConfig> = {}): CrawlerConfig => ({
  scraperServiceUrl: 'http://scraper.test',
  mode: 'both',
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

/** A canned 200 /catalog body for `siteId` page `p`. */
const pageBody = (siteId: string, p: number, ids: string[], hasMore: boolean, extra: Record<string, unknown> = {}) => ({
  siteId,
  page: p,
  url: `https://${siteId}.test/list?page=${p}`,
  items: ids.map((id) => ({ itemId: id, url: `https://${siteId}.test/p/${id}`, collectUrl: collectUrl(siteId, id) })),
  collectUrls: ids.map((id) => collectUrl(siteId, id)),
  hasMore,
  ...(hasMore ? { nextPage: p + 1 } : {}),
  count: ids.length,
  ...extra,
});

interface Reply {
  status: number;
  body?: unknown;
  throwErr?: boolean;
  throwValue?: unknown;
}

/** Shorthand replies. */
const ok = (siteId: string, p: number, ids: string[], hasMore = true, extra: Record<string, unknown> = {}): Reply => ({
  status: 200,
  body: pageBody(siteId, p, ids, hasMore, extra),
});
const cooldown = (siteId: string): Reply => ({ status: 503, body: { error: 'cooldown', siteId, host: `${siteId}.test`, remainingMs: 60000 } });
const unsupported = (siteId: string): Reply => ({ status: 422, body: { error: 'unsupported', siteId, reason: 'no listing axis' } });
const failed = (siteId: string): Reply => ({ status: 502, body: { error: 'catalog failed', siteId, reason: 'boom' } });
const badRequest = (): Reply => ({ status: 400, body: { error: "query parameter 'page' must be a positive integer" } });

interface FakeOpts {
  catalog: (siteId: string, page: number) => Reply;
  /** GET /catalog?store=&range=1&from=&count= — the synthesized descending id window. */
  range?: (siteId: string, from: number, count: number) => Reply;
  ingest?: (url: string) => Reply;
  holdIngest?: boolean;
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
    ...(lowest > 1 ? { nextFrom: lowest - 1 } : {}),
    count: ids.length,
  };
};

const okRange = (siteId: string, from: number, count: number): Reply => ({ status: 200, body: rangeBody(siteId, from, count) });

const makeFake = (opts: FakeOpts) => {
  let active = 0;
  let peak = 0;
  const calls: { method: string; url: string; body?: any }[] = [];
  let releaseIngest!: () => void;
  const ingestBarrier = new Promise<void>((r) => (releaseIngest = r));
  const resp = (status: number, body: unknown): HttpResponseLike => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  const fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body) : undefined;
    active++;
    peak = Math.max(peak, active);
    calls.push({ method, url, body });
    try {
      if (url.includes('/catalog')) {
        const u = new URL(url);
        const siteId = u.searchParams.get('store') ?? '';
        const page = Number(u.searchParams.get('page'));
        const r =
          u.searchParams.get('range') === '1'
            ? (opts.range ?? ((s2: string, f: number, c: number) => okRange(s2, f, c)))(
                siteId,
                Number(u.searchParams.get('from')),
                Number(u.searchParams.get('count')),
              )
            : opts.catalog(siteId, page);
        if (r.throwErr) throw r.throwValue !== undefined ? r.throwValue : new Error('catalog network error');
        return resp(r.status, r.body ?? {});
      }
      const u = body?.url as string;
      if (opts.holdIngest) await ingestBarrier;
      const r = opts.ingest ? opts.ingest(u) : { status: 202, body: { success: true, itemId: u, deduplicated: false, position: 1 } };
      if (r.throwErr) throw r.throwValue !== undefined ? r.throwValue : new Error('ingest timeout');
      return resp(r.status, r.body ?? { success: true, itemId: u, deduplicated: false, position: 1 });
    } finally {
      active--;
    }
  };
  return {
    fetch,
    calls,
    releaseIngest,
    get peak() {
      return peak;
    },
    get active() {
      return active;
    },
    /** [siteId, page] of every /catalog GET in dispatch order. */
    catalogCalls: () =>
      calls
        .filter((c) => c.url.includes('/catalog'))
        .map((c) => {
          const u = new URL(c.url);
          return [u.searchParams.get('store'), Number(u.searchParams.get('page'))] as [string, number];
        }),
    /** [siteId, from, count] of every id-range GET in dispatch order. */
    rangeCalls: () =>
      calls
        .filter((c) => c.url.includes('/catalog') && c.url.includes('range=1'))
        .map((c) => {
          const u = new URL(c.url);
          return [u.searchParams.get('store'), Number(u.searchParams.get('from')), Number(u.searchParams.get('count'))] as [string, number, number];
        }),
    /** LISTING page numbers only (the id-range axis carries no `page`). */
    pages: (siteId?: string) => calls.filter((c) => c.url.includes('/catalog') && !c.url.includes('range=1')).map((c) => new URL(c.url)).filter((u) => !siteId || u.searchParams.get('store') === siteId).map((u) => Number(u.searchParams.get('page'))),
    posted: () => calls.filter((c) => c.url.includes('/ingest')).map((c) => c.body.url as string),
  };
};

/** A ledger with the given item ids marked enqueued at `at`, plus optional overrides. */
const ledgerWith = (siteId: string, ids: string[], at: number, over: Partial<Ledger> = {}): Ledger => ({
  ...createEmptyLedger(siteId),
  enqueued: Object.fromEntries(ids.map((id) => [id, { at: iso(at), collectUrl: collectUrl(siteId, id) }])),
  ...over,
});

const clock = (start = T0) => {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms), set: (ms: number) => (t = ms) };
};

describe('runCrawlerPass — recent mode', () => {
  it('first run on an empty ledger: walks page 1.. up to recentMaxPages, POSTs every collectUrl, marks the ledger, saves after every page', async () => {
    const fake = makeFake({ catalog: (s, p) => ok(s, p, [`${p}a`, `${p}b`]) });
    const store = createMemoryLedgerStore();
    const c = clock();
    const s = await runCrawlerPass(mkCfg({ mode: 'recent' }), { fetch: fake.fetch, ledgerStore: store, now: c.now });

    expect(fake.pages('orzgk')).toEqual([1, 2, 3]);
    expect(fake.calls.filter((x) => x.url.includes('/catalog')).every((x) => x.method === 'GET' && x.url.startsWith('http://scraper.test/catalog?store=orzgk&page='))).toBe(true);
    expect(fake.posted()).toEqual(['1a', '1b', '2a', '2b', '3a', '3b'].map((id) => collectUrl('orzgk', id)));
    expect(fake.calls.filter((x) => x.url.includes('/ingest')).every((x) => x.method === 'POST' && x.url === 'http://scraper.test/ingest/scrape')).toBe(true);

    const l = store.files.get('orzgk')!;
    expect(Object.keys(l.enqueued).sort()).toEqual(['1a', '1b', '2a', '2b', '3a', '3b']);
    expect(l.enqueued['2a']).toEqual({ at: iso(T0), collectUrl: collectUrl('orzgk', '2a') });
    expect(l.recent).toEqual({ lastRunAt: iso(T0), lastNewCount: 6 });
    expect(l.backfill).toEqual({ cursor: null }); // recent-only never touches backfill state
    expect(l.updatedAt).toBe(iso(T0));
    expect(store.saveLog).toEqual(['orzgk', 'orzgk', 'orzgk']); // one save per page

    const st = s.stores[0];
    expect(st).toMatchObject({
      siteId: 'orzgk',
      pagesFetched: 3,
      recentPages: 3,
      recentNew: 6,
      backfillPages: 0,
      discovered: 6,
      known: 0,
      uncollectable: 0,
      enqueued: 6,
      deduplicated: 0,
      reobserved: 0,
      errors: 0,
      skipped: 0,
      ledgerCorrupt: false,
      backfillCursor: null,
      exhaustCandidate: false,
      exhausted: false,
    });
    expect(s.mode).toBe('recent');
    expect(s.requestsIssued).toBe(9);
    expect(s.budgetExhausted).toBe(false);
    expect(s.totalPagesFetched).toBe(3);
    expect(s.totalDiscovered).toBe(6);
    expect(s.totalEnqueued).toBe(6);
    expect(s.totalErrors).toBe(0);
    expect(s.totalSkipped).toBe(0);
    expect(s.storesConfigured).toBe(1);
    expect(s.startedAt).toBe(iso(T0));
    expect(s.durationMs).toBe(0);
  });

  it('stops the store at the first page that yields 0 new ids (everything already in the ledger)', async () => {
    const fake = makeFake({ catalog: (s, p) => ok(s, p, [`${p}a`, `${p}b`]) });
    const store = createMemoryLedgerStore({ orzgk: ledgerWith('orzgk', ['1a', '1b'], T0 - 1000) });
    const s = await runCrawlerPass(mkCfg({ mode: 'recent' }), { fetch: fake.fetch, ledgerStore: store, now: clock().now });

    expect(fake.pages('orzgk')).toEqual([1]);
    expect(fake.posted()).toEqual([]);
    expect(s.stores[0]).toMatchObject({ pagesFetched: 1, discovered: 2, known: 2, enqueued: 0, recentNew: 0 });
    expect(store.files.get('orzgk')!.recent).toEqual({ lastRunAt: iso(T0), lastNewCount: 0 });
    expect(store.saveLog).toEqual(['orzgk']); // the page was still recorded
  });

  it('continues past a page with SOME new ids and stops at the end of the listing (hasMore:false)', async () => {
    const fake = makeFake({ catalog: (s, p) => (p === 1 ? ok(s, 1, ['1a', '1b']) : ok(s, 2, ['2a'], false)) });
    const store = createMemoryLedgerStore({ orzgk: ledgerWith('orzgk', ['1a'], T0 - 1000) });
    const s = await runCrawlerPass(mkCfg({ mode: 'recent', recentMaxPages: 10 }), { fetch: fake.fetch, ledgerStore: store, now: clock().now });

    expect(fake.pages('orzgk')).toEqual([1, 2]);
    expect(fake.posted()).toEqual([collectUrl('orzgk', '1b'), collectUrl('orzgk', '2a')]);
    expect(s.stores[0]).toMatchObject({ pagesFetched: 2, discovered: 3, known: 1, enqueued: 2, recentNew: 2 });
  });

  it('re-observes an entry older than reobserveAfterMs (re-POSTs, refreshes `at`), never one younger, never when the window is 0', async () => {
    const fake = makeFake({ catalog: (s, p) => ok(s, p, ['old', 'young'], false) });
    const seed = () => ({
      orzgk: {
        ...createEmptyLedger('orzgk'),
        enqueued: {
          old: { at: iso(T0 - WEEK_MS), collectUrl: collectUrl('orzgk', 'old') },
          young: { at: iso(T0 - WEEK_MS + 1), collectUrl: collectUrl('orzgk', 'young') },
        },
      },
    });

    const store = createMemoryLedgerStore(seed());
    const s = await runCrawlerPass(mkCfg({ mode: 'recent', reobserveAfterMs: WEEK_MS }), { fetch: fake.fetch, ledgerStore: store, now: clock().now });
    expect(fake.posted()).toEqual([collectUrl('orzgk', 'old')]);
    expect(s.stores[0]).toMatchObject({ discovered: 2, known: 1, enqueued: 1, reobserved: 1, recentNew: 1 });
    expect(store.files.get('orzgk')!.enqueued.old.at).toBe(iso(T0));
    expect(store.files.get('orzgk')!.enqueued.young.at).toBe(iso(T0 - WEEK_MS + 1));

    const never = makeFake({ catalog: (s, p) => ok(s, p, ['old', 'young'], false) });
    const s0 = await runCrawlerPass(mkCfg({ mode: 'recent', reobserveAfterMs: 0 }), { fetch: never.fetch, ledgerStore: createMemoryLedgerStore(seed()), now: clock().now });
    expect(never.posted()).toEqual([]);
    expect(s0.stores[0]).toMatchObject({ known: 2, enqueued: 0, reobserved: 0 });
  });

  it('treats an unparseable ledger timestamp as due for re-observation (the cheap, self-healing direction)', async () => {
    const fake = makeFake({ catalog: (s, p) => ok(s, p, ['x'], false) });
    const store = createMemoryLedgerStore({
      orzgk: { ...createEmptyLedger('orzgk'), enqueued: { x: { at: 'garbage', collectUrl: collectUrl('orzgk', 'x') } } },
    });
    await runCrawlerPass(mkCfg({ mode: 'recent', reobserveAfterMs: WEEK_MS }), { fetch: fake.fetch, ledgerStore: store, now: clock().now });
    expect(fake.posted()).toEqual([collectUrl('orzgk', 'x')]);
    expect(store.files.get('orzgk')!.enqueued.x.at).toBe(iso(T0));
  });

  it('skips items without a collectUrl (uncollectable) and drops items without a usable itemId', async () => {
    const fake = makeFake({
      catalog: (s) => ({
        status: 200,
        body: {
          siteId: s,
          page: 1,
          url: 'u',
          items: [
            { itemId: 'a', url: 'https://orzgk.test/p/a' }, // no collectUrl
            { itemId: 'b', collectUrl: '' }, // empty collectUrl
            { itemId: 'c', collectUrl: 7 }, // junk collectUrl
            { itemId: '', collectUrl: collectUrl(s, 'blank') }, // blank id
            { collectUrl: collectUrl(s, 'noid') }, // missing id
            null, // not an object
            { itemId: 'd', collectUrl: collectUrl(s, 'd') }, // kept
          ],
          collectUrls: [],
          hasMore: false,
          count: 7,
        },
      }),
    });
    const s = await runCrawlerPass(mkCfg({ mode: 'recent' }), { fetch: fake.fetch, ledgerStore: createMemoryLedgerStore(), now: clock().now });
    expect(fake.posted()).toEqual([collectUrl('orzgk', 'd')]);
    expect(s.stores[0]).toMatchObject({ discovered: 4, uncollectable: 3, enqueued: 1, recentNew: 1 });
  });

  it('dedupes an itemId repeated within a page and across pages in one run (one POST)', async () => {
    const fake = makeFake({ catalog: (s, p) => (p === 1 ? ok(s, 1, ['x', 'x', 'y']) : ok(s, 2, ['x', 'z'], false)) });
    const s = await runCrawlerPass(mkCfg({ mode: 'recent' }), { fetch: fake.fetch, ledgerStore: createMemoryLedgerStore(), now: clock().now });
    expect(fake.posted()).toEqual(['x', 'y', 'z'].map((id) => collectUrl('orzgk', id)));
    expect(s.stores[0]).toMatchObject({ discovered: 5, known: 2, enqueued: 3 });
  });

  it('does not re-POST within the run an item whose POST was rejected with a 4xx (skips it, keeps going, errors++)', async () => {
    const fake = makeFake({
      catalog: (s, p) => (p === 1 ? ok(s, 1, ['bad', 'good']) : ok(s, 2, ['bad', 'more'], false)),
      ingest: (u) => (u.endsWith('/bad') ? { status: 422, body: { success: false, message: 'No plugin ruleset matches this URL' } } : { status: 202 }),
    });
    const store = createMemoryLedgerStore();
    const s = await runCrawlerPass(mkCfg({ mode: 'recent' }), { fetch: fake.fetch, ledgerStore: store, now: clock().now });
    expect(fake.posted()).toEqual(['bad', 'good', 'more'].map((id) => collectUrl('orzgk', id)));
    expect(s.stores[0]).toMatchObject({ enqueued: 2, errors: 1, known: 1 });
    expect(Object.keys(store.files.get('orzgk')!.enqueued).sort()).toEqual(['good', 'more']); // a rejected item is never marked
  });

  it('counts a queue-coalesced (deduplicated:true) 202 as enqueued AND deduplicated, and marks it', async () => {
    const fake = makeFake({
      catalog: (s, p) => ok(s, p, ['a', 'b'], false),
      ingest: (u) => (u.endsWith('/b') ? { status: 202, body: { success: true, itemId: 'b', deduplicated: true, position: 0 } } : { status: 202 }),
    });
    const store = createMemoryLedgerStore();
    const s = await runCrawlerPass(mkCfg({ mode: 'recent' }), { fetch: fake.fetch, ledgerStore: store, now: clock().now });
    expect(s.stores[0]).toMatchObject({ enqueued: 2, deduplicated: 1 });
    expect(Object.keys(store.files.get('orzgk')!.enqueued).sort()).toEqual(['a', 'b']);
  });

  it('tolerates a 202 with an unparseable body (still counted as enqueued)', async () => {
    const fake = makeFake({ catalog: (s, p) => ok(s, p, ['a'], false) });
    const badJson: FetchLike = async (url, init) => {
      const r = await fake.fetch(url, init);
      return url.includes('/ingest') ? { ...r, json: async () => { throw new Error('bad json'); } } : r;
    };
    const s = await runCrawlerPass(mkCfg({ mode: 'recent' }), { fetch: badJson, ledgerStore: createMemoryLedgerStore(), now: clock().now });
    expect(s.stores[0]).toMatchObject({ enqueued: 1, deduplicated: 0, errors: 0 });
  });

  it('stops the store (errors++) on a 5xx or a thrown POST — the scraper itself is unwell, the rest of the page is left for next run', async () => {
    const fake5xx = makeFake({
      catalog: (s, p) => ok(s, p, ['a', 'b', 'c'], true),
      ingest: (u) => (u.endsWith('/b') ? { status: 503, body: { success: false, message: 'Ingest not configured' } } : { status: 202 }),
    });
    const s1 = await runCrawlerPass(mkCfg({ mode: 'recent' }), { fetch: fake5xx.fetch, ledgerStore: createMemoryLedgerStore(), now: clock().now });
    expect(fake5xx.posted()).toEqual(['a', 'b'].map((id) => collectUrl('orzgk', id))); // c never attempted
    expect(fake5xx.pages('orzgk')).toEqual([1]); // no page 2
    expect(s1.stores[0]).toMatchObject({ enqueued: 1, errors: 1 });

    const fakeThrow = makeFake({
      catalog: (s, p) => ok(s, p, ['a', 'b', 'c'], true),
      ingest: (u) => (u.endsWith('/b') ? { status: 0, throwErr: true } : { status: 202 }),
    });
    const s2 = await runCrawlerPass(mkCfg({ mode: 'recent' }), { fetch: fakeThrow.fetch, ledgerStore: createMemoryLedgerStore(), now: clock().now });
    expect(fakeThrow.posted()).toEqual(['a', 'b'].map((id) => collectUrl('orzgk', id)));
    expect(s2.stores[0]).toMatchObject({ enqueued: 1, errors: 1 });

    const fakeThrowString = makeFake({
      catalog: (s, p) => ok(s, p, ['a'], false),
      ingest: () => ({ status: 0, throwErr: true, throwValue: 'kaboom-string' }),
    });
    const s3 = await runCrawlerPass(mkCfg({ mode: 'recent' }), { fetch: fakeThrowString.fetch, ledgerStore: createMemoryLedgerStore(), now: clock().now });
    expect(s3.stores[0]).toMatchObject({ enqueued: 0, errors: 1 });
  });

  it('caps POSTs per store at maxEnqueuePerStore and stops the store (page progress still saved)', async () => {
    const fake = makeFake({ catalog: (s, p) => ok(s, p, [`${p}a`, `${p}b`, `${p}c`]) });
    const store = createMemoryLedgerStore();
    const s = await runCrawlerPass(mkCfg({ mode: 'recent', maxEnqueuePerStore: 4 }), { fetch: fake.fetch, ledgerStore: store, now: clock().now });
    expect(fake.posted()).toEqual(['1a', '1b', '1c', '2a'].map((id) => collectUrl('orzgk', id)));
    expect(fake.pages('orzgk')).toEqual([1, 2]); // page 3 never fetched
    expect(s.stores[0]).toMatchObject({ enqueued: 4, pagesFetched: 2 });
    expect(Object.keys(store.files.get('orzgk')!.enqueued).sort()).toEqual(['1a', '1b', '1c', '2a']);
  });

  it('maxEnqueuePerStore=0 is a discovery-only dry run: one page fetched, nothing POSTed, nothing marked', async () => {
    const fake = makeFake({ catalog: (s, p) => ok(s, p, ['a', 'b']) });
    const store = createMemoryLedgerStore();
    const s = await runCrawlerPass(mkCfg({ mode: 'both', maxEnqueuePerStore: 0 }), { fetch: fake.fetch, ledgerStore: store, now: clock().now });
    expect(fake.pages('orzgk')).toEqual([1]);
    expect(fake.posted()).toEqual([]);
    expect(s.stores[0]).toMatchObject({ discovered: 2, enqueued: 0, recentNew: 2, backfillPages: 0 });
    expect(store.files.get('orzgk')!.enqueued).toEqual({});
  });

  it('503 cooldown on /catalog → skipped++, the WHOLE store stops for this run (backfill shares the cooling host), ledger untouched', async () => {
    const fake = makeFake({ catalog: (s) => cooldown(s) });
    const store = createMemoryLedgerStore({ orzgk: ledgerWith('orzgk', ['k'], T0 - 1000, { backfill: { cursor: 9 } }) });
    const s = await runCrawlerPass(mkCfg({ mode: 'both' }), { fetch: fake.fetch, ledgerStore: store, now: clock().now });
    expect(fake.pages('orzgk')).toEqual([1]); // recent tried page 1 and cooled; backfill was not attempted
    expect(fake.posted()).toEqual([]);
    expect(s.stores[0]).toMatchObject({ skipped: 1, errors: 0, pagesFetched: 0, backfillCursor: 9 });
    expect(store.saveLog).toEqual([]);
    expect(store.files.get('orzgk')).toEqual(ledgerWith('orzgk', ['k'], T0 - 1000, { backfill: { cursor: 9 } })); // seeded ledger untouched
  });

  it('422 unsupported on /catalog → errors++, store stops (a config problem, not exhaustion), ledger untouched', async () => {
    const fake = makeFake({ catalog: (s) => unsupported(s) });
    const store = createMemoryLedgerStore();
    const s = await runCrawlerPass(mkCfg({ mode: 'both' }), { fetch: fake.fetch, ledgerStore: store, now: clock().now });
    expect(fake.pages('orzgk')).toEqual([1]); // backfill is not even attempted after an unsupported verdict
    expect(s.stores[0]).toMatchObject({ errors: 1, skipped: 0, pagesFetched: 0, exhausted: false, exhaustCandidate: false });
    expect(store.saveLog).toEqual([]);
  });

  it('503 cooldown with an unparseable body is still a cooldown (skipped++), never an error', async () => {
    const fake = makeFake({ catalog: (s) => cooldown(s) });
    const badJson: FetchLike = async (url, init) => {
      const r = await fake.fetch(url, init);
      return { ...r, json: async () => { throw new Error('bad json'); } };
    };
    const s = await runCrawlerPass(mkCfg({ mode: 'recent' }), { fetch: badJson, ledgerStore: createMemoryLedgerStore(), now: clock().now });
    expect(s.stores[0]).toMatchObject({ skipped: 1, errors: 0, pagesFetched: 0 });
  });

  it('aborts a hung /catalog GET after requestTimeoutMs (errors++, store stops) and a hung /ingest POST (errors++, store stops)', async () => {
    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })));
      });
    const sGet = await runCrawlerPass(mkCfg({ mode: 'both', requestTimeoutMs: 5 }), { fetch: hang, ledgerStore: createMemoryLedgerStore(), now: clock().now });
    expect(sGet.stores[0]).toMatchObject({ errors: 1, pagesFetched: 0, enqueued: 0 });

    const fake = makeFake({ catalog: (s, p) => ok(s, p, ['a', 'b']) });
    const hangPosts: FetchLike = (url, init) => (url.includes('/ingest') ? hang(url, init) : fake.fetch(url, init));
    const store = createMemoryLedgerStore({ orzgk: ledgerWith('orzgk', [], T0, { backfill: { cursor: 30 } }) });
    const sPost = await runCrawlerPass(mkCfg({ mode: 'backfill', requestTimeoutMs: 5 }), { fetch: hangPosts, ledgerStore: store, now: clock().now });
    expect(sPost.stores[0]).toMatchObject({ errors: 1, pagesFetched: 1, enqueued: 0, backfillCursor: 30 });
    expect(store.files.get('orzgk')!.backfill).toEqual({ cursor: 30 }); // transient: no advance
  });

  it('502 / 400 / thrown GET on /catalog → errors++, store stops, no state change', async () => {
    for (const reply of [failed('orzgk'), badRequest(), { status: 0, throwErr: true } as Reply, { status: 0, throwErr: true, throwValue: 'str' } as Reply]) {
      const fake = makeFake({ catalog: () => reply });
      const store = createMemoryLedgerStore();
      const s = await runCrawlerPass(mkCfg({ mode: 'recent' }), { fetch: fake.fetch, ledgerStore: store, now: clock().now });
      expect(fake.pages('orzgk')).toEqual([1]);
      expect(s.stores[0]).toMatchObject({ errors: 1, pagesFetched: 0, enqueued: 0 });
      expect(store.saveLog).toEqual([]);
    }
  });

  it('a 200 whose body is not a listing (items missing / not an array / unparseable) → errors++, store stops, never an exhaustion signal', async () => {
    const bodies: unknown[] = [{}, { items: 'x' }, { items: null }, 'not-an-object'];
    for (const body of bodies) {
      const fake = makeFake({ catalog: () => ({ status: 200, body }) });
      const store = createMemoryLedgerStore({ orzgk: ledgerWith('orzgk', [], T0, { backfill: { cursor: 5 } }) });
      const s = await runCrawlerPass(mkCfg({ mode: 'backfill' }), { fetch: fake.fetch, ledgerStore: store, now: clock().now });
      expect(s.stores[0]).toMatchObject({ errors: 1, pagesFetched: 0, exhaustCandidate: false, exhausted: false, backfillCursor: 5 });
      expect(store.saveLog).toEqual([]);
    }
    const fake = makeFake({ catalog: (s, p) => ok(s, p, ['a'], false) });
    const badJson: FetchLike = async (url, init) => {
      const r = await fake.fetch(url, init);
      return url.includes('/catalog') ? { ...r, json: async () => { throw new Error('bad json'); } } : r;
    };
    const s = await runCrawlerPass(mkCfg({ mode: 'recent' }), { fetch: badJson, ledgerStore: createMemoryLedgerStore(), now: clock().now });
    expect(s.stores[0]).toMatchObject({ errors: 1, pagesFetched: 0 });
  });
});

describe('runCrawlerPass — backfill mode', () => {
  it('initialises the cursor at 2 when there is no saved cursor and no recent phase, advances ONLY on hasMore:true, saves after every page', async () => {
    const fake = makeFake({ catalog: (s, p) => ok(s, p, [`${p}a`]) });
    const store = createMemoryLedgerStore();
    const c = clock();
    const s = await runCrawlerPass(mkCfg({ mode: 'backfill', backfillPagesPerRun: 3 }), { fetch: fake.fetch, ledgerStore: store, now: c.now });

    expect(fake.pages('orzgk')).toEqual([2, 3, 4]);
    expect(fake.posted()).toEqual(['2a', '3a', '4a'].map((id) => collectUrl('orzgk', id)));
    const l = store.files.get('orzgk')!;
    expect(l.backfill).toEqual({ cursor: 5, updatedAt: iso(T0) });
    expect(l.recent).toEqual({}); // backfill-only never touches recent state
    expect(store.saveLog).toEqual(['orzgk', 'orzgk', 'orzgk']);
    expect(s.stores[0]).toMatchObject({ pagesFetched: 3, backfillPages: 3, recentPages: 0, enqueued: 3, backfillCursor: 5, exhausted: false, exhaustCandidate: false });
  });

  it('resumes from the saved cursor and enqueues NEW ids only — a known id is never re-observed in backfill even past the window', async () => {
    const fake = makeFake({ catalog: (s, p) => ok(s, p, ['known', `${p}new`]) });
    const store = createMemoryLedgerStore({ orzgk: ledgerWith('orzgk', ['known'], T0 - 2 * WEEK_MS, { backfill: { cursor: 40 } }) });
    const s = await runCrawlerPass(mkCfg({ mode: 'backfill', backfillPagesPerRun: 2, reobserveAfterMs: WEEK_MS }), { fetch: fake.fetch, ledgerStore: store, now: clock().now });
    expect(fake.pages('orzgk')).toEqual([40, 41]);
    expect(fake.posted()).toEqual(['40new', '41new'].map((id) => collectUrl('orzgk', id)));
    expect(s.stores[0]).toMatchObject({ known: 2, enqueued: 2, reobserved: 0, backfillCursor: 42 });
    expect(store.files.get('orzgk')!.enqueued.known.at).toBe(iso(T0 - 2 * WEEK_MS));
  });

  it('NEVER advances on hasMore:false — even with a contradictory nextPage — and records an exhaustion CANDIDATE, not exhaustion', async () => {
    const fake = makeFake({ catalog: (s, p) => ok(s, p, ['last1', 'last2'], false, { nextPage: p + 1 }) });
    const store = createMemoryLedgerStore({ orzgk: ledgerWith('orzgk', [], T0, { backfill: { cursor: 409 } }) });
    const s = await runCrawlerPass(mkCfg({ mode: 'backfill' }), { fetch: fake.fetch, ledgerStore: store, now: clock().now });

    expect(fake.pages('orzgk')).toEqual([409]); // stopped after the candidate page
    expect(fake.posted()).toEqual(['last1', 'last2'].map((id) => collectUrl('orzgk', id))); // its items are still enqueued
    const b = store.files.get('orzgk')!.backfill;
    expect(b.cursor).toBe(409);
    expect(b.exhaustCandidateCursor).toBe(409);
    expect(b.exhaustCandidateAt).toBe(iso(T0));
    expect(b.exhaustedAt).toBeUndefined();
    expect(s.stores[0]).toMatchObject({ backfillCursor: 409, exhaustCandidate: true, exhausted: false, enqueued: 2 });
  });

  it('a 0-item page (a status-blind error page parsed as an empty listing) is only a CANDIDATE, even with hasMore:true', async () => {
    const fake = makeFake({ catalog: (s, p) => ok(s, p, [], true) });
    const store = createMemoryLedgerStore({ orzgk: ledgerWith('orzgk', [], T0, { backfill: { cursor: 12 } }) });
    const s = await runCrawlerPass(mkCfg({ mode: 'backfill' }), { fetch: fake.fetch, ledgerStore: store, now: clock().now });
    expect(fake.pages('orzgk')).toEqual([12]);
    expect(store.files.get('orzgk')!.backfill).toMatchObject({ cursor: 12, exhaustCandidateCursor: 12, exhaustCandidateAt: iso(T0) });
    expect(s.stores[0]).toMatchObject({ pagesFetched: 1, exhaustCandidate: true, exhausted: false });
  });

  it('marks EXHAUSTED only when the NEXT run sees the same cursor empty again; the cursor is kept for the re-check', async () => {
    const fake = makeFake({ catalog: (s, p) => ok(s, p, [], false) });
    const store = createMemoryLedgerStore({ orzgk: ledgerWith('orzgk', [], T0, { backfill: { cursor: 410 } }) });
    const c = clock();

    const r1 = await runCrawlerPass(mkCfg({ mode: 'backfill' }), { fetch: fake.fetch, ledgerStore: store, now: c.now });
    expect(r1.stores[0]).toMatchObject({ exhaustCandidate: true, exhausted: false });
    expect(store.files.get('orzgk')!.backfill.exhaustedAt).toBeUndefined();

    c.advance(3600_000);
    const r2 = await runCrawlerPass(mkCfg({ mode: 'backfill' }), { fetch: fake.fetch, ledgerStore: store, now: c.now });
    expect(fake.pages('orzgk')).toEqual([410, 410]);
    const b = store.files.get('orzgk')!.backfill;
    expect(b).toEqual({ cursor: 410, exhaustedAt: iso(T0 + 3600_000), updatedAt: iso(T0 + 3600_000) });
    expect(r2.stores[0]).toMatchObject({ exhaustCandidate: false, exhausted: true, backfillCursor: 410 });

    // A third run inside the re-check window makes NO backfill request at all.
    c.advance(3600_000);
    const r3 = await runCrawlerPass(mkCfg({ mode: 'backfill' }), { fetch: fake.fetch, ledgerStore: store, now: c.now });
    expect(fake.pages('orzgk')).toEqual([410, 410]);
    expect(r3.stores[0]).toMatchObject({ exhausted: true, pagesFetched: 0, backfillCursor: 410 });
    expect(store.saveLog.length).toBe(2); // nothing to persist on the skipped run
  });

  it('a candidate is NOT confirmed within the same run, and a stale candidate at a different cursor does not count', async () => {
    // The ledger carries a candidate at cursor 5 but the cursor is 6 (e.g. hand-edited): 6 empty → new candidate at 6, not exhausted.
    const fake = makeFake({ catalog: (s, p) => ok(s, p, [], false) });
    const store = createMemoryLedgerStore({
      orzgk: ledgerWith('orzgk', [], T0, { backfill: { cursor: 6, exhaustCandidateCursor: 5, exhaustCandidateAt: iso(T0 - 1000) } }),
    });
    const s = await runCrawlerPass(mkCfg({ mode: 'backfill' }), { fetch: fake.fetch, ledgerStore: store, now: clock().now });
    expect(s.stores[0]).toMatchObject({ exhaustCandidate: true, exhausted: false });
    expect(store.files.get('orzgk')!.backfill).toMatchObject({ cursor: 6, exhaustCandidateCursor: 6, exhaustCandidateAt: iso(T0) });
  });

  it('clears the candidate and resumes advancing when the same cursor yields items again', async () => {
    let attempt = 0;
    const fake = makeFake({
      catalog: (s, p) => {
        attempt++;
        return attempt === 1 ? ok(s, p, [], false) : ok(s, p, [`${p}x`], true);
      },
    });
    const store = createMemoryLedgerStore({ orzgk: ledgerWith('orzgk', [], T0, { backfill: { cursor: 20 } }) });
    const c = clock();
    await runCrawlerPass(mkCfg({ mode: 'backfill', backfillPagesPerRun: 2 }), { fetch: fake.fetch, ledgerStore: store, now: c.now });
    expect(store.files.get('orzgk')!.backfill).toMatchObject({ cursor: 20, exhaustCandidateCursor: 20 });

    c.advance(3600_000);
    const r2 = await runCrawlerPass(mkCfg({ mode: 'backfill', backfillPagesPerRun: 2 }), { fetch: fake.fetch, ledgerStore: store, now: c.now });
    expect(fake.pages('orzgk')).toEqual([20, 20, 21]);
    expect(store.files.get('orzgk')!.backfill).toEqual({ cursor: 22, updatedAt: iso(T0 + 3600_000) });
    expect(r2.stores[0]).toMatchObject({ exhaustCandidate: false, exhausted: false, backfillCursor: 22, enqueued: 2 });
  });

  it('re-checks an EXHAUSTED store at its kept cursor once the re-check window has elapsed: still empty → re-stamped; items → resumes', async () => {
    const exhaustedLedger = () => ledgerWith('orzgk', [], T0, { backfill: { cursor: 410, exhaustedAt: iso(T0 - WEEK_MS), updatedAt: iso(T0 - WEEK_MS) } });

    // Still empty at the re-check → exhaustedAt re-stamped to now, cursor kept, no candidate dance needed.
    const empty = makeFake({ catalog: (s, p) => ok(s, p, [], false) });
    const storeA = createMemoryLedgerStore({ orzgk: exhaustedLedger() });
    const a = await runCrawlerPass(mkCfg({ mode: 'backfill' }), { fetch: empty.fetch, ledgerStore: storeA, now: clock().now });
    expect(empty.pages('orzgk')).toEqual([410]);
    expect(storeA.files.get('orzgk')!.backfill).toEqual({ cursor: 410, exhaustedAt: iso(T0), updatedAt: iso(T0) });
    expect(a.stores[0]).toMatchObject({ exhausted: true, exhaustCandidate: false, pagesFetched: 1 });

    // Items appeared → exhaustion cleared, cursor advances, the rest of the run's pages proceed.
    const grown = makeFake({ catalog: (s, p) => ok(s, p, [`${p}n`], true) });
    const storeB = createMemoryLedgerStore({ orzgk: exhaustedLedger() });
    const b = await runCrawlerPass(mkCfg({ mode: 'backfill', backfillPagesPerRun: 2 }), { fetch: grown.fetch, ledgerStore: storeB, now: clock().now });
    expect(grown.pages('orzgk')).toEqual([410, 411]);
    expect(storeB.files.get('orzgk')!.backfill).toEqual({ cursor: 412, updatedAt: iso(T0) });
    expect(b.stores[0]).toMatchObject({ exhausted: false, backfillCursor: 412, enqueued: 2 });

    // One ms short of the window → no request.
    const early = makeFake({ catalog: (s, p) => ok(s, p, [`${p}n`], true) });
    const storeC = createMemoryLedgerStore({ orzgk: exhaustedLedger() });
    const e = await runCrawlerPass(mkCfg({ mode: 'backfill' }), { fetch: early.fetch, ledgerStore: storeC, now: clock(T0 - 1).now });
    expect(early.pages('orzgk')).toEqual([]);
    expect(e.stores[0]).toMatchObject({ exhausted: true, pagesFetched: 0 });
  });

  it('422 unsupported mid-backfill → errors++, store stops, cursor unchanged (config, not exhaustion); other stores continue', async () => {
    const fake = makeFake({ catalog: (s, p) => (s === 'orzgk' ? unsupported(s) : ok(s, p, [`${s}${p}`])) });
    const store = createMemoryLedgerStore({ orzgk: ledgerWith('orzgk', [], T0, { backfill: { cursor: 30 } }) });
    const s = await runCrawlerPass(mkCfg({ mode: 'backfill', stores: ['orzgk', 'goodsmileus'], backfillPagesPerRun: 2 }), { fetch: fake.fetch, ledgerStore: store, now: clock().now });
    expect(fake.pages('orzgk')).toEqual([30]);
    expect(fake.pages('goodsmileus')).toEqual([2, 3]);
    expect(s.stores.find((x) => x.siteId === 'orzgk')).toMatchObject({ errors: 1, backfillCursor: 30, exhausted: false, exhaustCandidate: false });
    expect(s.stores.find((x) => x.siteId === 'goodsmileus')).toMatchObject({ errors: 0, backfillCursor: 4, enqueued: 2 });
    expect(store.saveLog).toEqual(['goodsmileus', 'goodsmileus']);
  });

  it('503 cooldown mid-backfill → skipped++, store stops this run, cursor and any candidate untouched', async () => {
    const fake = makeFake({ catalog: (s, p) => (p === 31 ? cooldown(s) : ok(s, p, [`${p}a`])) });
    const store = createMemoryLedgerStore({ orzgk: ledgerWith('orzgk', [], T0, { backfill: { cursor: 30 } }) });
    const s = await runCrawlerPass(mkCfg({ mode: 'backfill' }), { fetch: fake.fetch, ledgerStore: store, now: clock().now });
    expect(fake.pages('orzgk')).toEqual([30, 31]);
    expect(store.files.get('orzgk')!.backfill).toEqual({ cursor: 31, updatedAt: iso(T0) });
    expect(s.stores[0]).toMatchObject({ skipped: 1, errors: 0, pagesFetched: 1, backfillCursor: 31 });
  });

  it('502 (catalog failed) mid-backfill → errors++, store stops, no advance', async () => {
    const fake = makeFake({ catalog: (s, p) => (p === 31 ? failed(s) : ok(s, p, [`${p}a`])) });
    const store = createMemoryLedgerStore({ orzgk: ledgerWith('orzgk', [], T0, { backfill: { cursor: 30 } }) });
    const s = await runCrawlerPass(mkCfg({ mode: 'backfill' }), { fetch: fake.fetch, ledgerStore: store, now: clock().now });
    expect(fake.pages('orzgk')).toEqual([30, 31]);
    expect(s.stores[0]).toMatchObject({ errors: 1, pagesFetched: 1, backfillCursor: 31 });
  });

  it('400 from /catalog (our own bad params) → errors++, store stops, no advance — never treated as the Shopify page cap', async () => {
    const fake = makeFake({ catalog: (s, p) => (p === 101 ? badRequest() : ok(s, p, [`${p}a`])) });
    const store = createMemoryLedgerStore({ orzgk: ledgerWith('orzgk', [], T0, { backfill: { cursor: 100 } }) });
    const s = await runCrawlerPass(mkCfg({ mode: 'backfill' }), { fetch: fake.fetch, ledgerStore: store, now: clock().now });
    expect(s.stores[0]).toMatchObject({ errors: 1, backfillCursor: 101, exhaustCandidate: false, exhausted: false });
  });

  it('budget exhausted mid-page: the items already accepted are persisted, the cursor does NOT advance, budgetExhausted is flagged', async () => {
    // 1 GET + 2 POSTs = 3 requests; the third item and every further page are cut off.
    const fake = makeFake({ catalog: (s, p) => ok(s, p, ['a', 'b', 'c']) });
    const store = createMemoryLedgerStore({ orzgk: ledgerWith('orzgk', [], T0, { backfill: { cursor: 30 } }) });
    const s = await runCrawlerPass(mkCfg({ mode: 'backfill', maxRequests: 3 }), { fetch: fake.fetch, ledgerStore: store, now: clock().now });
    expect(fake.pages('orzgk')).toEqual([30]);
    expect(fake.posted()).toEqual(['a', 'b'].map((id) => collectUrl('orzgk', id)));
    const l = store.files.get('orzgk')!;
    expect(Object.keys(l.enqueued).sort()).toEqual(['a', 'b']);
    expect(l.backfill).toEqual({ cursor: 30 });
    expect(s.budgetExhausted).toBe(true);
    expect(s.requestsIssued).toBe(3);
    expect(s.stores[0]).toMatchObject({ enqueued: 2, backfillCursor: 30, exhaustCandidate: false });
  });

  it('budget exhausted before a page GET: no further requests, progress so far persisted', async () => {
    const fake = makeFake({ catalog: (s, p) => ok(s, p, [`${p}a`]) });
    const store = createMemoryLedgerStore({ orzgk: ledgerWith('orzgk', [], T0, { backfill: { cursor: 30 } }) });
    const s = await runCrawlerPass(mkCfg({ mode: 'backfill', maxRequests: 2 }), { fetch: fake.fetch, ledgerStore: store, now: clock().now });
    expect(fake.pages('orzgk')).toEqual([30]);
    expect(store.files.get('orzgk')!.backfill.cursor).toBe(31);
    expect(s.budgetExhausted).toBe(true);
    expect(s.stores[0]).toMatchObject({ enqueued: 1, backfillCursor: 31 });
  });

  it('per-store cap reached mid-page: the cursor does NOT advance (the rest of the page is picked up next run)', async () => {
    const fake = makeFake({ catalog: (s, p) => ok(s, p, ['a', 'b', 'c']) });
    const store = createMemoryLedgerStore({ orzgk: ledgerWith('orzgk', [], T0, { backfill: { cursor: 30 } }) });
    const s = await runCrawlerPass(mkCfg({ mode: 'backfill', maxEnqueuePerStore: 2 }), { fetch: fake.fetch, ledgerStore: store, now: clock().now });
    expect(fake.pages('orzgk')).toEqual([30]);
    expect(fake.posted()).toEqual(['a', 'b'].map((id) => collectUrl('orzgk', id)));
    expect(store.files.get('orzgk')!.backfill).toEqual({ cursor: 30 });
    expect(s.stores[0]).toMatchObject({ enqueued: 2, backfillCursor: 30 });
  });

  it('a page whose new items are all rejected with 4xx still advances (deterministic rejections are not retried)', async () => {
    const fake = makeFake({ catalog: (s, p) => ok(s, p, [`${p}bad`]), ingest: () => ({ status: 400, body: { success: false, message: 'Invalid URL format' } }) });
    const store = createMemoryLedgerStore({ orzgk: ledgerWith('orzgk', [], T0, { backfill: { cursor: 30 } }) });
    const s = await runCrawlerPass(mkCfg({ mode: 'backfill', backfillPagesPerRun: 2 }), { fetch: fake.fetch, ledgerStore: store, now: clock().now });
    expect(fake.pages('orzgk')).toEqual([30, 31]);
    expect(store.files.get('orzgk')!.backfill.cursor).toBe(32);
    expect(s.stores[0]).toMatchObject({ errors: 2, enqueued: 0, backfillCursor: 32 });
  });

  it('a 5xx POST mid-backfill stops the store WITHOUT advancing (transient — the page is retried next run)', async () => {
    const fake = makeFake({ catalog: (s, p) => ok(s, p, ['a', 'b']), ingest: (u) => (u.endsWith('/b') ? { status: 503, body: { success: false } } : { status: 202 }) });
    const store = createMemoryLedgerStore({ orzgk: ledgerWith('orzgk', [], T0, { backfill: { cursor: 30 } }) });
    const s = await runCrawlerPass(mkCfg({ mode: 'backfill' }), { fetch: fake.fetch, ledgerStore: store, now: clock().now });
    expect(fake.pages('orzgk')).toEqual([30]);
    expect(Object.keys(store.files.get('orzgk')!.enqueued)).toEqual(['a']);
    expect(store.files.get('orzgk')!.backfill).toEqual({ cursor: 30 });
    expect(s.stores[0]).toMatchObject({ enqueued: 1, errors: 1, backfillCursor: 30 });
  });
});

describe('runCrawlerPass — modes, ledgers, budget, parallelism, summary', () => {
  it("mode 'both': recent runs first (pages 1..N), then backfill starts at the page after recent's deepest page", async () => {
    const fake = makeFake({ catalog: (s, p) => ok(s, p, [`${p}a`]) });
    const store = createMemoryLedgerStore();
    const s = await runCrawlerPass(mkCfg({ mode: 'both', recentMaxPages: 3, backfillPagesPerRun: 2 }), { fetch: fake.fetch, ledgerStore: store, now: clock().now });
    expect(fake.pages('orzgk')).toEqual([1, 2, 3, 4, 5]);
    const l = store.files.get('orzgk')!;
    expect(l.backfill).toEqual({ cursor: 6, updatedAt: iso(T0) });
    expect(l.recent).toEqual({ lastRunAt: iso(T0), lastNewCount: 3 });
    expect(s.stores[0]).toMatchObject({ recentPages: 3, backfillPages: 2, pagesFetched: 5, enqueued: 5, backfillCursor: 6 });
    expect(store.saveLog.length).toBe(5);
  });

  it("mode 'both': backfill init falls back to 2 when recent stopped on page 1, and to the saved cursor when one exists", async () => {
    const fake = makeFake({ catalog: (s, p) => ok(s, p, [`${p}a`]) });
    const store = createMemoryLedgerStore({ orzgk: ledgerWith('orzgk', ['1a'], T0 - 1000) });
    await runCrawlerPass(mkCfg({ mode: 'both', backfillPagesPerRun: 1 }), { fetch: fake.fetch, ledgerStore: store, now: clock().now });
    expect(fake.pages('orzgk')).toEqual([1, 2]);
    expect(store.files.get('orzgk')!.backfill.cursor).toBe(3);

    const saved = makeFake({ catalog: (s, p) => ok(s, p, [`${p}a`]) });
    const store2 = createMemoryLedgerStore({ orzgk: ledgerWith('orzgk', [], T0, { backfill: { cursor: 77 } }) });
    await runCrawlerPass(mkCfg({ mode: 'both', backfillPagesPerRun: 1 }), { fetch: saved.fetch, ledgerStore: store2, now: clock().now });
    expect(saved.pages('orzgk')).toEqual([1, 2, 3, 77]);
    expect(store2.files.get('orzgk')!.backfill.cursor).toBe(78);
  });

  it("mode 'both' with several stores: EVERY store's recent phase completes before ANY store's backfill begins (recent has budget priority)", async () => {
    const fake = makeFake({ catalog: (s, p) => ok(s, p, [`${s}${p}`]) });
    const s = await runCrawlerPass(mkCfg({ mode: 'both', stores: ['orzgk', 'goodsmileus'], recentMaxPages: 2, backfillPagesPerRun: 2 }), {
      fetch: fake.fetch,
      ledgerStore: createMemoryLedgerStore(),
      now: clock().now,
    });
    const seq = fake.catalogCalls();
    const lastRecent = Math.max(...seq.map(([, p], i) => (p <= 2 ? i : -1)));
    const firstBackfill = Math.min(...seq.map(([, p], i) => (p >= 3 ? i : Infinity)));
    expect(seq.length).toBe(8);
    expect(lastRecent).toBeLessThan(firstBackfill);
    expect(fake.pages('orzgk')).toEqual([1, 2, 3, 4]);
    expect(fake.pages('goodsmileus')).toEqual([1, 2, 3, 4]);
    expect(s.stores.map((x) => x.siteId)).toEqual(['orzgk', 'goodsmileus']);
  });

  it("mode 'recent' makes no backfill requests; mode 'backfill' makes no recent requests", async () => {
    const r = makeFake({ catalog: (s, p) => ok(s, p, [`${p}a`]) });
    await runCrawlerPass(mkCfg({ mode: 'recent', recentMaxPages: 2 }), { fetch: r.fetch, ledgerStore: createMemoryLedgerStore(), now: clock().now });
    expect(r.pages('orzgk')).toEqual([1, 2]);

    const b = makeFake({ catalog: (s, p) => ok(s, p, [`${p}a`]) });
    const store = createMemoryLedgerStore({ orzgk: ledgerWith('orzgk', [], T0, { backfill: { cursor: 50 } }) });
    await runCrawlerPass(mkCfg({ mode: 'backfill', backfillPagesPerRun: 2 }), { fetch: b.fetch, ledgerStore: store, now: clock().now });
    expect(b.pages('orzgk')).toEqual([50, 51]);
  });

  it('a corrupt ledger → errors++, ledgerCorrupt, ZERO requests for that store, NEVER saved; other stores proceed', async () => {
    const fake = makeFake({ catalog: (s, p) => ok(s, p, [`${s}${p}`], false) });
    const store = createMemoryLedgerStore({ orzgk: 'corrupt' });
    const s = await runCrawlerPass(mkCfg({ mode: 'both', stores: ['orzgk', 'goodsmileus'] }), { fetch: fake.fetch, ledgerStore: store, now: clock().now });
    expect(fake.pages('orzgk')).toEqual([]);
    expect(fake.pages('goodsmileus')).toEqual([1, 2]);
    expect(s.stores.find((x) => x.siteId === 'orzgk')).toMatchObject({ errors: 1, ledgerCorrupt: true, pagesFetched: 0, enqueued: 0 });
    expect(s.stores.find((x) => x.siteId === 'goodsmileus')).toMatchObject({ errors: 0, ledgerCorrupt: false, enqueued: 2 });
    expect(store.saveLog).toEqual(['goodsmileus', 'goodsmileus']);
    expect(store.files.has('orzgk')).toBe(false);
  });

  it('a ledger load failure (fs error) → errors++, store skipped; a save failure → errors++, store stops', async () => {
    const fake = makeFake({ catalog: (s, p) => ok(s, p, [`${p}a`]) });
    const loadFail = {
      load: async () => {
        throw new Error('EACCES');
      },
      save: async () => undefined,
    };
    const s1 = await runCrawlerPass(mkCfg({ mode: 'both' }), { fetch: fake.fetch, ledgerStore: loadFail, now: clock().now });
    expect(fake.calls.length).toBe(0);
    expect(s1.stores[0]).toMatchObject({ errors: 1, ledgerCorrupt: false, pagesFetched: 0 });

    const fake2 = makeFake({ catalog: (s, p) => ok(s, p, [`${p}a`]) });
    const mem = createMemoryLedgerStore();
    const saveFail = {
      load: mem.load,
      save: async () => {
        throw new Error('ENOSPC');
      },
    };
    const s2 = await runCrawlerPass(mkCfg({ mode: 'both' }), { fetch: fake2.fetch, ledgerStore: saveFail, now: clock().now });
    expect(fake2.pages('orzgk')).toEqual([1]); // stopped after the first page's save failed; no backfill either
    expect(s2.stores[0]).toMatchObject({ errors: 1, pagesFetched: 1, enqueued: 1 });

    // The same failure mid-backfill stops the store after that page (the advance was never made durable).
    const fake3 = makeFake({ catalog: (s, p) => ok(s, p, [`${p}a`]) });
    const mem3 = createMemoryLedgerStore({ orzgk: ledgerWith('orzgk', [], T0, { backfill: { cursor: 30 } }) });
    const s3 = await runCrawlerPass(mkCfg({ mode: 'backfill' }), { fetch: fake3.fetch, ledgerStore: { load: mem3.load, save: saveFail.save }, now: clock().now });
    expect(fake3.pages('orzgk')).toEqual([30]);
    expect(s3.stores[0]).toMatchObject({ errors: 1, pagesFetched: 1, enqueued: 1 });
    expect(mem3.files.get('orzgk')!.backfill.cursor).toBe(30); // nothing persisted
  });

  it('zero stores → no requests, no ledger access, empty summary', async () => {
    const fake = makeFake({ catalog: (s, p) => ok(s, p, ['a']) });
    const store = createMemoryLedgerStore();
    const s = await runCrawlerPass(mkCfg({ stores: [] }), { fetch: fake.fetch, ledgerStore: store, now: clock().now });
    expect(fake.calls.length).toBe(0);
    expect(s.stores).toEqual([]);
    expect(s.totalEnqueued).toBe(0);
    expect(s.requestsIssued).toBe(0);
    expect(s.budgetExhausted).toBe(false);
  });

  it('maxRequests 0 (kill switch) → no requests at all, budgetExhausted flagged, nothing saved', async () => {
    const fake = makeFake({ catalog: (s, p) => ok(s, p, ['a']) });
    const store = createMemoryLedgerStore();
    const s = await runCrawlerPass(mkCfg({ maxRequests: 0 }), { fetch: fake.fetch, ledgerStore: store, now: clock().now });
    expect(fake.calls.length).toBe(0);
    expect(s.budgetExhausted).toBe(true);
    expect(s.requestsIssued).toBe(0);
    expect(s.stores[0]).toMatchObject({ pagesFetched: 0, errors: 0 });
    expect(store.saveLog).toEqual([]);
  });

  it('runs stores in parallel under the global gate: never more than maxConcurrency in flight, every store completes', async () => {
    const fake = makeFake({ holdIngest: true, catalog: (s, p) => ok(s, p, [`${s}${p}a`, `${s}${p}b`], false) });
    const p = runCrawlerPass(mkCfg({ mode: 'recent', stores: ['orzgk', 'goodsmileus', 'solaris'], maxConcurrency: 2 }), {
      fetch: fake.fetch,
      ledgerStore: createMemoryLedgerStore(),
      now: clock().now,
    });
    await waitFor(() => fake.active === 2 && fake.posted().length >= 2);
    expect(fake.peak).toBeLessThanOrEqual(2);
    fake.releaseIngest();
    const s = await p;
    expect(fake.peak).toBeLessThanOrEqual(2);
    expect(s.peakInFlight).toBeLessThanOrEqual(2);
    expect(s.stores.map((x) => x.enqueued)).toEqual([2, 2, 2]);
    expect(s.totalEnqueued).toBe(6);
  });

  it('shares ONE budget across stores and phases (catalog GETs + ingest POSTs) and reports totals in config order without duplicates', async () => {
    const fake = makeFake({ catalog: (s, p) => ok(s, p, [`${s}${p}`], false) });
    const s = await runCrawlerPass(mkCfg({ mode: 'recent', stores: ['orzgk', 'goodsmileus', 'orzgk'], maxRequests: 3 }), {
      fetch: fake.fetch,
      ledgerStore: createMemoryLedgerStore(),
      now: clock().now,
    });
    expect(fake.calls.length).toBe(3);
    expect(s.requestsIssued).toBe(3);
    expect(s.budgetExhausted).toBe(true);
    expect(s.stores.map((x) => x.siteId)).toEqual(['orzgk', 'goodsmileus']);
    expect(s.storesConfigured).toBe(2);
    expect(s.totalPagesFetched + s.totalEnqueued).toBe(3);
  });

  it('uses an injected gate when provided, runs with timeouts disabled, and reports the wall clock from the injected `now`', async () => {
    const { createRequestGate } = await import('../../initiator/requestGate');
    const gate = createRequestGate({ maxConcurrency: 1, maxRequests: 100, spacingMs: 0 });
    const fake = makeFake({ catalog: (s, p) => ok(s, p, ['a'], false) });
    const c = clock();
    const fetchAdvancing: FetchLike = async (url, init) => {
      c.advance(10);
      return fake.fetch(url, init);
    };
    const s = await runCrawlerPass(mkCfg({ mode: 'recent', requestTimeoutMs: 0 }), { fetch: fetchAdvancing, ledgerStore: createMemoryLedgerStore(), now: c.now, gate });
    expect(gate.issued()).toBe(2);
    expect(s.requestsIssued).toBe(2);
    expect(s.startedAt).toBe(iso(T0));
    expect(s.finishedAt).toBe(iso(T0 + 20));
    expect(s.durationMs).toBe(20);
    expect(s.scraperServiceUrl).toBe('http://scraper.test');
    expect(s.requestBudget).toBe(100);
    expect(s.maxConcurrency).toBe(2);
  });

  it('defaults `now` to the wall clock when not injected', async () => {
    const fake = makeFake({ catalog: (s, p) => ok(s, p, ['a'], false) });
    const store = createMemoryLedgerStore();
    const before = Date.now();
    const s = await runCrawlerPass(mkCfg({ mode: 'recent' }), { fetch: fake.fetch, ledgerStore: store });
    expect(Date.parse(s.startedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(store.files.get('orzgk')!.enqueued.a.at)).toBeGreaterThanOrEqual(before);
  });
});

describe('runCrawlerPass — backfill exhaustion must not be CONFIRMED on a page that was not fully attempted', () => {
  const seeded = (cursor: number) => createMemoryLedgerStore({ orzgk: { ...createEmptyLedger('orzgk'), backfill: { cursor } } });
  const twoRuns = async (store: ReturnType<typeof createMemoryLedgerStore>, catalog: (s: string, p: number) => Reply, ingest?: (u: string) => Reply) => {
    const c = clock();
    const runs: Array<{ s: Awaited<ReturnType<typeof runCrawlerPass>>; fake: ReturnType<typeof makeFake> }> = [];
    for (let i = 0; i < 3; i++) {
      const fake = makeFake({ catalog, ingest });
      const s = await runCrawlerPass(mkCfg({ mode: 'backfill' }), { fetch: fake.fetch, ledgerStore: store, now: c.now });
      runs.push({ s, fake });
      c.advance(60 * 60 * 1000);
    }
    return runs;
  };

  it('last page (hasMore:false) cut short by the per-store cap twice → still a candidate, NOT exhausted; run 3 re-fetches it', async () => {
    const last = Array.from({ length: 250 }, (_, i) => `L${i}`);
    const store = seeded(409);
    const runs = await twoRuns(store, (s, p) => ok(s, p, last, false));
    expect(runs[0].fake.posted()).toHaveLength(50);
    expect(runs[1].fake.posted()).toHaveLength(50); // 100 marked after run 2, 150 never attempted
    expect(store.files.get('orzgk')!.backfill.exhaustedAt).toBeUndefined();
    expect(runs[2].fake.pages()).toEqual([409]);
    expect(runs[2].fake.posted()).toHaveLength(50); // run 3 drains the next 50 instead of parking for 7d
    expect(Object.keys(store.files.get('orzgk')!.enqueued)).toHaveLength(150);
  });

  it('last page (hasMore:false) whose POSTs all 5xx twice (scraper unwell) → NOT exhausted; run 3 re-fetches it', async () => {
    const store = seeded(409);
    const sick = (): Reply => ({ status: 503, body: { success: false, message: 'Ingest not configured (INGEST_BASE_URL unset)' } });
    const runs = await twoRuns(store, (s, p) => ok(s, p, ['z1', 'z2'], false), sick);
    expect(Object.keys(store.files.get('orzgk')!.enqueued)).toHaveLength(0);
    expect(store.files.get('orzgk')!.backfill.exhaustedAt).toBeUndefined();
    expect(runs[2].fake.pages()).toEqual([409]);
  });
  it('global budget cuts the last page short: accepted marks persisted, cursor initialised and kept, NO candidate recorded', async () => {
    // 1 GET + 2 POSTs = 3 requests; 'c' is never attempted, so this page says nothing about the end of the catalog.
    const fake = makeFake({ catalog: (s, p) => ok(s, p, ['a', 'b', 'c'], false) });
    const store = createMemoryLedgerStore({ orzgk: createEmptyLedger('orzgk') });
    const s = await runCrawlerPass(mkCfg({ mode: 'backfill', maxRequests: 3 }), { fetch: fake.fetch, ledgerStore: store, now: clock().now });
    expect(fake.pages('orzgk')).toEqual([2]);
    expect(Object.keys(store.files.get('orzgk')!.enqueued).sort()).toEqual(['a', 'b']);
    expect(store.files.get('orzgk')!.backfill).toEqual({ cursor: 2, updatedAt: iso(T0) });
    expect(s.budgetExhausted).toBe(true);
    expect(s.stores[0]).toMatchObject({ enqueued: 2, backfillCursor: 2, exhaustCandidate: false, exhausted: false });
  });

  it('an existing candidate survives a cut-short run at the same cursor (kept, not re-stamped) and is confirmed once the page is fully attempted', async () => {
    const candidateAt = iso(T0 - 60 * 60 * 1000);
    const store = createMemoryLedgerStore({
      orzgk: { ...createEmptyLedger('orzgk'), backfill: { cursor: 409, exhaustCandidateCursor: 409, exhaustCandidateAt: candidateAt } },
    });
    const c = clock();
    // Run 1: three new items on the last page, cap 2 → cut short: candidate untouched, nothing confirmed.
    const r1 = makeFake({ catalog: (s, p) => ok(s, p, ['x1', 'x2', 'x3'], false) });
    const s1 = await runCrawlerPass(mkCfg({ mode: 'backfill', maxEnqueuePerStore: 2 }), { fetch: r1.fetch, ledgerStore: store, now: c.now });
    expect(r1.posted()).toHaveLength(2);
    expect(store.files.get('orzgk')!.backfill).toEqual({ cursor: 409, exhaustCandidateCursor: 409, exhaustCandidateAt: candidateAt });
    expect(s1.stores[0]).toMatchObject({ exhausted: false, exhaustCandidate: true, enqueued: 2 });
    // Run 2: the remaining item is attempted → the page is fully seen at the candidate cursor → confirmed.
    c.advance(60 * 60 * 1000);
    const r2 = makeFake({ catalog: (s, p) => ok(s, p, ['x1', 'x2', 'x3'], false) });
    const s2 = await runCrawlerPass(mkCfg({ mode: 'backfill', maxEnqueuePerStore: 2 }), { fetch: r2.fetch, ledgerStore: store, now: c.now });
    expect(r2.posted()).toEqual([collectUrl('orzgk', 'x3')]);
    expect(store.files.get('orzgk')!.backfill).toEqual({ cursor: 409, exhaustedAt: iso(c.now()), updatedAt: iso(c.now()) });
    expect(s2.stores[0]).toMatchObject({ exhausted: true, exhaustCandidate: false, enqueued: 1 });
  });

  it('an EXHAUSTED store whose due re-check is cut short keeps the stale exhaustedAt (stays due), drains hourly, and is re-stamped only once fully attempted', async () => {
    const stale = iso(T0 - WEEK_MS - 24 * 60 * 60 * 1000);
    const store = createMemoryLedgerStore({ orzgk: { ...createEmptyLedger('orzgk'), backfill: { cursor: 409, exhaustedAt: stale, updatedAt: stale } } });
    const c = clock();
    const grown = (s: string, p: number): Reply => ok(s, p, ['y1', 'y2', 'y3'], false);
    // Run 1 (due): cap 2 cuts the re-check short → exhaustedAt NOT re-stamped, so the store is still due next hour.
    const r1 = makeFake({ catalog: grown });
    await runCrawlerPass(mkCfg({ mode: 'backfill', maxEnqueuePerStore: 2 }), { fetch: r1.fetch, ledgerStore: store, now: c.now });
    expect(r1.pages()).toEqual([409]);
    expect(r1.posted()).toHaveLength(2);
    expect(store.files.get('orzgk')!.backfill).toEqual({ cursor: 409, exhaustedAt: stale, updatedAt: stale });
    // Run 2 (+1h, still due): the last item is attempted → re-stamped now.
    c.advance(60 * 60 * 1000);
    const r2 = makeFake({ catalog: grown });
    await runCrawlerPass(mkCfg({ mode: 'backfill', maxEnqueuePerStore: 2 }), { fetch: r2.fetch, ledgerStore: store, now: c.now });
    expect(r2.pages()).toEqual([409]);
    expect(r2.posted()).toEqual([collectUrl('orzgk', 'y3')]);
    expect(store.files.get('orzgk')!.backfill).toEqual({ cursor: 409, exhaustedAt: iso(c.now()), updatedAt: iso(c.now()) });
    // Run 3 (+2h): inside the window → parked, zero requests.
    c.advance(60 * 60 * 1000);
    const r3 = makeFake({ catalog: grown });
    await runCrawlerPass(mkCfg({ mode: 'backfill', maxEnqueuePerStore: 2 }), { fetch: r3.fetch, ledgerStore: store, now: c.now });
    expect(r3.pages()).toEqual([]);
  });
});

describe('runCrawlerPass — per-store enqueue caps', () => {
  it('applies a per-store cap in place of the global one, leaving unnamed stores on the global cap', async () => {
    const fake = makeFake({ catalog: (s, p) => ok(s, p, [`${s}-${p}a`, `${s}-${p}b`, `${s}-${p}c`], false) });
    const store = createMemoryLedgerStore();
    const s = await runCrawlerPass(
      mkCfg({ mode: 'recent', stores: ['anitoys', 'orzgk'], maxEnqueuePerStore: 50, storeEnqueueCaps: { anitoys: 2 } }),
      { fetch: fake.fetch, ledgerStore: store, now: clock().now },
    );

    expect(fake.posted().filter((u) => u.includes('anitoys'))).toEqual([collectUrl('anitoys', 'anitoys-1a'), collectUrl('anitoys', 'anitoys-1b')]);
    expect(fake.posted().filter((u) => u.includes('orzgk')).length).toBe(3);
    expect(s.stores.find((x) => x.siteId === 'anitoys')).toMatchObject({ capApplied: 2, enqueued: 2 });
    expect(s.stores.find((x) => x.siteId === 'orzgk')).toMatchObject({ capApplied: 50, enqueued: 3 });
  });

  it('lists the effective per-store cap overrides on the run summary (only the ones that actually applied)', async () => {
    const fake = makeFake({ catalog: (s, p) => ok(s, p, ['a'], false) });
    const s = await runCrawlerPass(
      mkCfg({ mode: 'recent', stores: ['anitoys', 'orzgk'], storeEnqueueCaps: { anitoys: 15, elsewhere: 4 } }),
      { fetch: fake.fetch, ledgerStore: createMemoryLedgerStore(), now: clock().now },
    );
    expect(s.enqueueCapOverrides).toEqual({ anitoys: 15 });
  });

  it('a per-store cap of 0 skips the store entirely (no requests, no ledger writes) while the others run', async () => {
    const fake = makeFake({ catalog: (s, p) => ok(s, p, ['a'], false) });
    const store = createMemoryLedgerStore();
    const s = await runCrawlerPass(
      mkCfg({ mode: 'both', stores: ['anitoys', 'orzgk'], storeEnqueueCaps: { anitoys: 0 } }),
      { fetch: fake.fetch, ledgerStore: store, now: clock().now },
    );

    expect(fake.catalogCalls().every(([site]) => site === 'orzgk')).toBe(true);
    expect(fake.pages('anitoys')).toEqual([]);
    expect(store.saveLog.includes('anitoys')).toBe(false);
    expect(store.files.has('anitoys')).toBe(false);
    expect(s.stores.find((x) => x.siteId === 'anitoys')).toMatchObject({ capApplied: 0, pagesFetched: 0, discovered: 0, enqueued: 0, errors: 0 });
    expect(s.enqueueCapOverrides).toEqual({ anitoys: 0 });
  });

  it('a global maxEnqueuePerStore of 0 stays a discovery-only dry run (a page IS fetched) for unnamed stores', async () => {
    const fake = makeFake({ catalog: (s, p) => ok(s, p, ['a'], false) });
    const s = await runCrawlerPass(
      mkCfg({ mode: 'recent', stores: ['orzgk'], maxEnqueuePerStore: 0 }),
      { fetch: fake.fetch, ledgerStore: createMemoryLedgerStore(), now: clock().now },
    );
    expect(fake.pages('orzgk')).toEqual([1]);
    expect(fake.posted()).toEqual([]);
    expect(s.stores[0]).toMatchObject({ capApplied: 0, discovered: 1, enqueued: 0 });
  });
});

/**
 * ID-RANGE BACKFILL — a store whose ids are sequential (mfc: ~3.6M numeric item ids) needs no
 * listing to be enumerated: the crawler walks the id space DOWNWARD from a frontier, a bounded
 * window per run, resuming a durable cursor. The ledger's enqueued map is still the dedup, the
 * store's enqueue cap is still the ceiling, and ids that do not exist are the ingest's 404s, not
 * the crawler's problem.
 */
describe('runCrawlerPass — id-range backfill', () => {
  /** A config that does the id-range walk and NOTHING else (no listing pages at all). */
  const rangeOnly = (over: Partial<CrawlerConfig> = {}): CrawlerConfig =>
    mkCfg({ mode: 'backfill', backfillPagesPerRun: 0, stores: ['mfc'], rangeStores: ['mfc'], rangeIdsPerRun: 5, ...over });

  it('walks a window DOWN from the env-seeded frontier, POSTs every id and persists the cursor below the window', async () => {
    const fake = makeFake({ catalog: (s, p) => failed(s) });
    const store = createMemoryLedgerStore();
    const s = await runCrawlerPass(rangeOnly({ rangeFrontiers: { mfc: 500 } }), { fetch: fake.fetch, ledgerStore: store, now: clock().now });

    expect(fake.rangeCalls()).toEqual([['mfc', 500, 5]]);
    expect(fake.posted()).toEqual(['500', '499', '498', '497', '496'].map((id) => collectUrl('mfc', id)));
    expect(store.files.get('mfc')!.range).toEqual({ cursor: 495, frontier: 500, seed: 500, updatedAt: iso(T0) });
    expect(s.stores[0]).toMatchObject({ siteId: 'mfc', rangeWalked: 5, rangeCursor: 495, rangeFrontier: 500, discovered: 5, enqueued: 5, errors: 0 });
    expect(s.totalRangeWalked).toBe(5);
  });

  it('prefers the highest numeric itemId the ledger has seen over the env seed; ids already enqueued are skipped but still consume the walk', async () => {
    const fake = makeFake({ catalog: (s, p) => failed(s) });
    const store = createMemoryLedgerStore({ mfc: ledgerWith('mfc', ['800', '799', 'not-a-number', '12'], T0 - 1000) });
    const s = await runCrawlerPass(rangeOnly({ rangeIdsPerRun: 3, rangeFrontiers: { mfc: 500 } }), { fetch: fake.fetch, ledgerStore: store, now: clock().now });

    expect(fake.rangeCalls()).toEqual([['mfc', 800, 3]]);
    expect(fake.posted()).toEqual([collectUrl('mfc', '798')]);
    // The ledger's own highest id wins the FIRST frontier; the env seed is only recorded, so that a
    // later change to it is detectable.
    expect(store.files.get('mfc')!.range).toEqual({ cursor: 797, frontier: 800, seed: 500, updatedAt: iso(T0) });
    expect(s.stores[0]).toMatchObject({ rangeWalked: 3, rangeCursor: 797, rangeFrontier: 800, discovered: 3, known: 2, enqueued: 1 });
  });

  it('resumes the persisted cursor on the next run and never re-walks an id', async () => {
    const store = createMemoryLedgerStore();
    const cfg = rangeOnly({ rangeIdsPerRun: 4, rangeFrontiers: { mfc: 20 } });

    const first = makeFake({ catalog: (s) => failed(s) });
    await runCrawlerPass(cfg, { fetch: first.fetch, ledgerStore: store, now: clock().now });
    expect(first.rangeCalls()).toEqual([['mfc', 20, 4]]);

    const second = makeFake({ catalog: (s) => failed(s) });
    const s2 = await runCrawlerPass(cfg, { fetch: second.fetch, ledgerStore: store, now: clock().now });
    expect(second.rangeCalls()).toEqual([['mfc', 16, 4]]);
    expect(second.posted()).toEqual(['16', '15', '14', '13'].map((id) => collectUrl('mfc', id)));
    expect(store.files.get('mfc')!.range!.cursor).toBe(12);
    expect(s2.stores[0]).toMatchObject({ rangeWalked: 4, rangeCursor: 12 });
  });

  it('shares the store enqueue cap: the cursor advances ONLY over the ids actually handled, the rest are re-walked next run', async () => {
    const fake = makeFake({ catalog: (s) => failed(s) });
    const store = createMemoryLedgerStore();
    const s = await runCrawlerPass(rangeOnly({ rangeIdsPerRun: 5, storeEnqueueCaps: { mfc: 2 }, rangeFrontiers: { mfc: 500 } }), {
      fetch: fake.fetch,
      ledgerStore: store,
      now: clock().now,
    });

    expect(fake.posted()).toEqual([collectUrl('mfc', '500'), collectUrl('mfc', '499')]);
    expect(store.files.get('mfc')!.range!.cursor).toBe(498);
    expect(s.stores[0]).toMatchObject({ capApplied: 2, rangeWalked: 2, rangeCursor: 498, enqueued: 2 });
  });

  it('skips the walk with a WARN, and no request, when there is no frontier at all (empty ledger, no env seed)', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      const fake = makeFake({ catalog: (s) => failed(s) });
      const store = createMemoryLedgerStore();
      const s = await runCrawlerPass(rangeOnly(), { fetch: fake.fetch, ledgerStore: store, now: clock().now });

      expect(fake.calls).toEqual([]);
      expect(store.saveLog).toEqual([]);
      expect(s.stores[0]).toMatchObject({ rangeWalked: 0, rangeCursor: null, rangeFrontier: null });
      expect(warn.mock.calls.some((c) => String(c[0]).includes('no frontier'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('walks only the stores named in rangeStores', async () => {
    const fake = makeFake({ catalog: (s, p) => ok(s, p, [], false) });
    const s = await runCrawlerPass(
      rangeOnly({ stores: ['mfc', 'orzgk'], rangeStores: ['mfc'], rangeFrontiers: { mfc: 9, orzgk: 9 } }),
      { fetch: fake.fetch, ledgerStore: createMemoryLedgerStore(), now: clock().now },
    );
    expect(fake.rangeCalls().map(([site]) => site)).toEqual(['mfc']);
    expect(s.stores.find((x) => x.siteId === 'orzgk')).toMatchObject({ rangeWalked: 0, rangeCursor: null });
  });

  it('runs AFTER the recent listing pass, and still runs when the listing axis answers 422 unsupported (mfc has no byListing yet)', async () => {
    const listing = makeFake({ catalog: (s, p) => ok(s, p, [`${p}a`], p === 1) });
    await runCrawlerPass(
      mkCfg({ mode: 'both', recentMaxPages: 2, backfillPagesPerRun: 0, stores: ['mfc'], rangeStores: ['mfc'], rangeIdsPerRun: 2, rangeFrontiers: { mfc: 9 } }),
      { fetch: listing.fetch, ledgerStore: createMemoryLedgerStore(), now: clock().now },
    );
    const order = listing.calls.filter((c) => c.url.includes('/catalog')).map((c) => (c.url.includes('range=1') ? 'range' : 'page'));
    expect(order).toEqual(['page', 'page', 'range']);

    const unsup = makeFake({ catalog: (s) => unsupported(s) });
    const s = await runCrawlerPass(
      mkCfg({ mode: 'both', backfillPagesPerRun: 5, stores: ['mfc'], rangeStores: ['mfc'], rangeIdsPerRun: 2, rangeFrontiers: { mfc: 9 } }),
      { fetch: unsup.fetch, ledgerStore: createMemoryLedgerStore(), now: clock().now },
    );
    expect(unsup.pages('mfc')).toEqual([1]); // the 422 stopped the LISTING walk (backfill made no further page GET)
    expect(unsup.rangeCalls()).toEqual([['mfc', 9, 2]]);
    expect(unsup.posted()).toEqual([collectUrl('mfc', '9'), collectUrl('mfc', '8')]);
    expect(s.stores[0]).toMatchObject({ errors: 1, rangeWalked: 2, rangeCursor: 7 });
  });

  it('a cooldown / a sick scraper on the listing axis DOES stop the range walk too (same host, same egress)', async () => {
    const cool = makeFake({ catalog: (s) => cooldown(s) });
    const s = await runCrawlerPass(
      mkCfg({ mode: 'both', stores: ['mfc'], rangeStores: ['mfc'], rangeIdsPerRun: 2, rangeFrontiers: { mfc: 9 } }),
      { fetch: cool.fetch, ledgerStore: createMemoryLedgerStore(), now: clock().now },
    );
    expect(cool.rangeCalls()).toEqual([]);
    expect(s.stores[0]).toMatchObject({ skipped: 1, rangeWalked: 0 });
  });

  it('stops at the id floor: the window bottoms out at id 1, the cursor lands on 0 and no further run requests anything', async () => {
    const store = createMemoryLedgerStore();
    const cfg = rangeOnly({ rangeIdsPerRun: 5, rangeFrontiers: { mfc: 3 } });

    const first = makeFake({ catalog: (s) => failed(s) });
    const s1 = await runCrawlerPass(cfg, { fetch: first.fetch, ledgerStore: store, now: clock().now });
    expect(first.posted()).toEqual(['3', '2', '1'].map((id) => collectUrl('mfc', id)));
    expect(store.files.get('mfc')!.range!.cursor).toBe(0);
    expect(s1.stores[0]).toMatchObject({ rangeWalked: 3, rangeCursor: 0 });

    const second = makeFake({ catalog: (s) => failed(s) });
    const s2 = await runCrawlerPass(cfg, { fetch: second.fetch, ledgerStore: store, now: clock().now });
    expect(second.calls).toEqual([]);
    expect(s2.stores[0]).toMatchObject({ rangeWalked: 0, rangeCursor: 0 });
  });

  it('422 on the RANGE axis (the store declares no byRange) → errors++, no cursor written', async () => {
    const fake = makeFake({ catalog: (s) => failed(s), range: (s) => unsupported(s) });
    const store = createMemoryLedgerStore();
    const s = await runCrawlerPass(rangeOnly({ rangeFrontiers: { mfc: 500 } }), { fetch: fake.fetch, ledgerStore: store, now: clock().now });

    expect(fake.posted()).toEqual([]);
    expect(store.saveLog).toEqual([]);
    expect(s.stores[0]).toMatchObject({ errors: 1, rangeWalked: 0, rangeCursor: null });
  });

  it('holds the cursor when /ingest/scrape rejected EVERY id in the window (a ruleset/engine skew burns no id space)', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      const store = createMemoryLedgerStore();
      const cfg = rangeOnly({ rangeFrontiers: { mfc: 500 } });
      const reject = { status: 422, body: { success: false, message: 'No plugin ruleset matches this URL' } };

      const first = makeFake({ catalog: (s) => failed(s), ingest: () => reject });
      const s1 = await runCrawlerPass(cfg, { fetch: first.fetch, ledgerStore: store, now: clock().now });
      expect(first.posted().length).toBe(5);
      expect(Object.keys(store.files.get('mfc')?.enqueued ?? {})).toEqual([]);
      expect(store.saveLog).toEqual([]);
      expect(s1.stores[0]).toMatchObject({ errors: 5, enqueued: 0, rangeCursor: null });
      expect(warn.mock.calls.some((c) => String(c[0]).includes('rejected'))).toBe(true);

      // Next run re-walks the SAME window — the ids are not below a cursor that nothing collected.
      const second = makeFake({ catalog: (s) => failed(s) });
      await runCrawlerPass(cfg, { fetch: second.fetch, ledgerStore: store, now: clock().now });
      expect(second.rangeCalls()).toEqual([['mfc', 500, 5]]);
      expect(second.posted().length).toBe(5);
    } finally {
      warn.mockRestore();
    }
  });

  it('a window with at least one accepted id still advances over a single rejected one', async () => {
    const store = createMemoryLedgerStore();
    const fake = makeFake({
      catalog: (s) => failed(s),
      ingest: (u) => (u.endsWith('/499') ? { status: 422, body: { success: false } } : { status: 202, body: { success: true, deduplicated: false } }),
    });
    const s = await runCrawlerPass(rangeOnly({ rangeIdsPerRun: 3, rangeFrontiers: { mfc: 500 } }), {
      fetch: fake.fetch,
      ledgerStore: store,
      now: clock().now,
    });
    expect(store.files.get('mfc')!.range!.cursor).toBe(497);
    expect(s.stores[0]).toMatchObject({ enqueued: 2, errors: 1, rangeWalked: 3, rangeCursor: 497 });
  });

  it('refuses a window that is not the descending run it asked for — no POST, no cursor movement', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      const store = createMemoryLedgerStore();
      // A window whose first item is unusable (dropped by sanitize) would otherwise move the cursor
      // by an ARRAY INDEX and skip id 500 forever.
      const skewed = (siteId: string, from: number) => ({
        status: 200,
        body: {
          siteId,
          from,
          items: [{ itemId: null }, ...[499, 498, 497, 496].map((id) => ({ itemId: String(id), collectUrl: collectUrl(siteId, String(id)) }))],
          hasMore: true,
          count: 5,
        },
      });
      const fake = makeFake({ catalog: (s) => failed(s), range: skewed });
      const s = await runCrawlerPass(rangeOnly({ rangeFrontiers: { mfc: 500 } }), { fetch: fake.fetch, ledgerStore: store, now: clock().now });

      expect(fake.posted()).toEqual([]);
      expect(store.saveLog).toEqual([]);
      expect(s.stores[0]).toMatchObject({ errors: 1, rangeWalked: 0, rangeCursor: null });
      expect(warn.mock.calls.some((c) => String(c[0]).includes('descending run'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('accepts a window SHORTER than the one it asked for (the engine clamps at 200) and moves the cursor by the ids returned', async () => {
    const store = createMemoryLedgerStore();
    const short = (siteId: string, from: number) => okRange(siteId, from, 3); // asked for 5, served 3
    const fake = makeFake({ catalog: (s) => failed(s), range: short });
    const s = await runCrawlerPass(rangeOnly({ rangeFrontiers: { mfc: 500 } }), { fetch: fake.fetch, ledgerStore: store, now: clock().now });

    expect(fake.rangeCalls()).toEqual([['mfc', 500, 5]]);
    expect(fake.posted()).toEqual(['500', '499', '498'].map((id) => collectUrl('mfc', id)));
    expect(store.files.get('mfc')!.range!.cursor).toBe(497);
    expect(s.stores[0]).toMatchObject({ rangeWalked: 3, rangeCursor: 497, errors: 0 });
  });

  it('reports the cursor the ledger actually holds: a failed save leaves rangeCursor/rangeFrontier where they were', async () => {
    const mem = createMemoryLedgerStore();
    const saveFail = { load: mem.load, save: async () => { throw new Error('ENOSPC'); } };
    const fake = makeFake({ catalog: (s) => failed(s) });
    const s = await runCrawlerPass(rangeOnly({ rangeFrontiers: { mfc: 500 } }), { fetch: fake.fetch, ledgerStore: saveFail, now: clock().now });

    expect(fake.posted().length).toBe(5);
    expect(mem.files.has('mfc')).toBe(false);
    // The walk did happen (5 ids POSTed) but NOTHING is durable — reporting cursor 495 would show
    // progress an operator's next run will re-do.
    expect(s.stores[0]).toMatchObject({ errors: 1, rangeWalked: 5, rangeCursor: null, rangeFrontier: null });
  });

  it('re-seeds the walk when CRAWLER_RANGE_FRONTIER_<SITEID> CHANGES — the only lever over a wrong seed or ids minted above the frontier', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      const store = createMemoryLedgerStore();
      const first = makeFake({ catalog: (s) => failed(s) });
      await runCrawlerPass(rangeOnly({ rangeIdsPerRun: 2, rangeFrontiers: { mfc: 500 } }), { fetch: first.fetch, ledgerStore: store, now: clock().now });
      expect(first.rangeCalls()).toEqual([['mfc', 500, 2]]);
      expect(store.files.get('mfc')!.range).toMatchObject({ cursor: 498, frontier: 500, seed: 500 });

      // The operator raises the seed in the manifest: the walk restarts from the new top.
      const second = makeFake({ catalog: (s) => failed(s) });
      const s2 = await runCrawlerPass(rangeOnly({ rangeIdsPerRun: 2, rangeFrontiers: { mfc: 600 } }), { fetch: second.fetch, ledgerStore: store, now: clock().now });
      expect(second.rangeCalls()).toEqual([['mfc', 600, 2]]);
      expect(store.files.get('mfc')!.range).toMatchObject({ cursor: 598, frontier: 600, seed: 600 });
      expect(s2.stores[0]).toMatchObject({ rangeFrontier: 600, rangeCursor: 598 });
      expect(warn.mock.calls.some((c) => String(c[0]).includes('re-seeded'))).toBe(true);

      // Unchanged from here on: the walk simply resumes its cursor.
      const third = makeFake({ catalog: (s) => failed(s) });
      await runCrawlerPass(rangeOnly({ rangeIdsPerRun: 2, rangeFrontiers: { mfc: 600 } }), { fetch: third.fetch, ledgerStore: store, now: clock().now });
      expect(third.rangeCalls()).toEqual([['mfc', 598, 2]]);
    } finally {
      warn.mockRestore();
    }
  });

  it('a new seed revives a walk that had reached the id floor', async () => {
    const store = createMemoryLedgerStore({ mfc: ledgerWith('mfc', [], T0, { range: { cursor: 0, frontier: 3, seed: 3 } }) });
    const fake = makeFake({ catalog: (s) => failed(s) });
    await runCrawlerPass(rangeOnly({ rangeIdsPerRun: 2, rangeFrontiers: { mfc: 900 } }), { fetch: fake.fetch, ledgerStore: store, now: clock().now });
    expect(fake.rangeCalls()).toEqual([['mfc', 900, 2]]);
    expect(store.files.get('mfc')!.range).toMatchObject({ cursor: 898, frontier: 900, seed: 900 });
  });

  it('a 503 cooldown on the RANGE axis skips the store for the run: no POSTs, no cursor written', async () => {
    const fake = makeFake({ catalog: (s) => failed(s), range: (s) => cooldown(s) });
    const store = createMemoryLedgerStore();
    const s = await runCrawlerPass(rangeOnly({ rangeFrontiers: { mfc: 500 } }), { fetch: fake.fetch, ledgerStore: store, now: clock().now });

    expect(fake.posted()).toEqual([]);
    expect(store.saveLog).toEqual([]);
    expect(s.stores[0]).toMatchObject({ skipped: 1, rangeWalked: 0, rangeCursor: null });
  });

  it('says WHY the walk did not run: not-configured / cap / budget / no-frontier / floor, and null when it did', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      // ran
      const okRun = makeFake({ catalog: (s) => failed(s) });
      const ran = await runCrawlerPass(rangeOnly({ rangeFrontiers: { mfc: 9 } }), { fetch: okRun.fetch, ledgerStore: createMemoryLedgerStore(), now: clock().now });
      expect(ran.stores[0]).toMatchObject({ rangeSkipped: null });

      // not configured for the walk at all
      const other = makeFake({ catalog: (s, p) => ok(s, p, [], false) });
      const notCfg = await runCrawlerPass(rangeOnly({ stores: ['mfc', 'orzgk'], rangeStores: ['mfc'], rangeFrontiers: { mfc: 9 } }), {
        fetch: other.fetch,
        ledgerStore: createMemoryLedgerStore(),
        now: clock().now,
      });
      expect(notCfg.stores.find((x) => x.siteId === 'orzgk')).toMatchObject({ rangeSkipped: 'not-configured' });

      // the listing phases spent the store's whole enqueue cap
      const busy = makeFake({ catalog: (s, p) => ok(s, p, [`${p}a`, `${p}b`], false) });
      const capped = await runCrawlerPass(
        mkCfg({ mode: 'both', backfillPagesPerRun: 0, stores: ['mfc'], rangeStores: ['mfc'], rangeIdsPerRun: 2, storeEnqueueCaps: { mfc: 1 }, rangeFrontiers: { mfc: 9 } }),
        { fetch: busy.fetch, ledgerStore: createMemoryLedgerStore(), now: clock().now },
      );
      expect(busy.rangeCalls()).toEqual([]);
      expect(capped.stores[0]).toMatchObject({ rangeSkipped: 'cap', rangeWalked: 0 });

      // the global request budget was gone before the walk's own GET
      const broke = makeFake({ catalog: (s, p) => ok(s, p, [], false) });
      const budget = await runCrawlerPass(
        mkCfg({ mode: 'both', recentMaxPages: 1, backfillPagesPerRun: 0, maxRequests: 1, stores: ['mfc'], rangeStores: ['mfc'], rangeIdsPerRun: 2, rangeFrontiers: { mfc: 9 } }),
        { fetch: broke.fetch, ledgerStore: createMemoryLedgerStore(), now: clock().now },
      );
      expect(broke.rangeCalls()).toEqual([]);
      expect(budget.stores[0]).toMatchObject({ rangeSkipped: 'budget' });

      // no frontier at all, and a walk that already reached the floor
      const none = makeFake({ catalog: (s) => failed(s) });
      const noFrontier = await runCrawlerPass(rangeOnly(), { fetch: none.fetch, ledgerStore: createMemoryLedgerStore(), now: clock().now });
      expect(noFrontier.stores[0]).toMatchObject({ rangeSkipped: 'no-frontier' });

      const done = makeFake({ catalog: (s) => failed(s) });
      const floor = await runCrawlerPass(rangeOnly({ rangeFrontiers: { mfc: 3 } }), {
        fetch: done.fetch,
        ledgerStore: createMemoryLedgerStore({ mfc: ledgerWith('mfc', [], T0, { range: { cursor: 0, frontier: 3, seed: 3 } }) }),
        now: clock().now,
      });
      expect(floor.stores[0]).toMatchObject({ rangeSkipped: 'floor' });
    } finally {
      warn.mockRestore();
    }
  });

  it('a window whose FIRST id the cap blocks moves nothing: no cursor, no ledger write, rangeSkipped cap', async () => {
    const store = createMemoryLedgerStore();
    // The listing spends the cap exactly (2 items, cap 2) without ever being cut short, so the walk
    // still starts — and then cannot get its first id through.
    const fake = makeFake({ catalog: (s, p) => ok(s, p, [`${p}a`, `${p}b`], false) });
    const sum = await runCrawlerPass(
      mkCfg({ mode: 'both', recentMaxPages: 1, backfillPagesPerRun: 0, stores: ['mfc'], rangeStores: ['mfc'], rangeIdsPerRun: 2, storeEnqueueCaps: { mfc: 2 }, rangeFrontiers: { mfc: 9 } }),
      { fetch: fake.fetch, ledgerStore: store, now: clock().now },
    );

    expect(fake.rangeCalls()).toEqual([['mfc', 9, 2]]);
    expect(fake.posted()).toEqual([collectUrl('mfc', '1a'), collectUrl('mfc', '1b')]);
    expect(store.files.get('mfc')!.range).toBeUndefined();
    expect(sum.stores[0]).toMatchObject({ rangeWalked: 0, rangeCursor: null, rangeSkipped: 'cap' });
  });

  it('WARNs when CRAWLER_RANGE_STORES or CRAWLER_STORE_ENQUEUE_CAPS names a store that is not being crawled', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      const fake = makeFake({ catalog: (s, p) => ok(s, p, [], false) });
      await runCrawlerPass(
        mkCfg({ mode: 'both', stores: ['orzgk'], rangeStores: ['mfc'], storeEnqueueCaps: { anitoys: 15 } }),
        { fetch: fake.fetch, ledgerStore: createMemoryLedgerStore(), now: clock().now },
      );
      const lines = warn.mock.calls.map((c) => `${String(c[0])} ${JSON.stringify(c[1])}`);
      expect(lines.some((l) => l.includes('CRAWLER_RANGE_STORES') && l.includes('mfc'))).toBe(true);
      expect(lines.some((l) => l.includes('CRAWLER_STORE_ENQUEUE_CAPS') && l.includes('anitoys'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("mode 'recent' makes no id-range request at all", async () => {
    const fake = makeFake({ catalog: (s, p) => ok(s, p, [], false) });
    await runCrawlerPass(rangeOnly({ mode: 'recent', rangeFrontiers: { mfc: 9 } }), {
      fetch: fake.fetch,
      ledgerStore: createMemoryLedgerStore(),
      now: clock().now,
    });
    expect(fake.rangeCalls()).toEqual([]);
  });
});
