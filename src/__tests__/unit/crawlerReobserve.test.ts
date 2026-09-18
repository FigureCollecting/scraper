/**
 * runCrawlerPass — the RE-OBSERVATION lane (`CRAWLER_MODE` names `reobserve`; D4, Ross 2026-09-18).
 *
 * Discovery answers "what exists"; this lane answers "what does it cost NOW". It walks the store's
 * LEDGER instead of its pages: the N oldest-observed ids whose last observation is older than
 * CRAWLER_REOBSERVE_MIN_AGE_H are re-driven through the ledger's stored absolute item url — which is
 * the store's byId url where the store has one, and the listing's own item link where it has none
 * (hobby-genki, bbts, gkloot, akimomo, anitoys) — so an exhausted store keeps a live price series
 * instead of freezing on the day it was walked.
 *
 * The lane has its OWN per-store budget (CRAWLER_STORE_REOBSERVE_CAPS, default 0 = off), spent from
 * the same global request gate as discovery, so neither lane can starve the other.
 *
 * Every test drives a MOCKED http surface, an in-memory ledger store and a fake clock.
 */
import { runCrawlerPass, type CrawlerConfig, type FetchLike, type HttpResponseLike } from '../../crawler/crawler';
import { createMemoryLedgerStore, createEmptyLedger, type Ledger, type LedgerEntry } from '../../crawler/ledger';
import type { FetchFailureReport } from '../../services/failureReporter';
import { logger } from '../../utils/logger';

const HOUR_MS = 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * HOUR_MS;
const T0 = Date.parse('2026-09-18T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

const mkCfg = (over: Partial<CrawlerConfig> = {}): CrawlerConfig => ({
  scraperServiceUrl: 'http://scraper.test',
  mode: 'reobserve',
  phases: ['reobserve'],
  stores: ['goodsmileus'],
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
  seedSpacingMs: 0,
  reobserveMinAgeMs: 12 * HOUR_MS,
  maxReobservePerStore: 0,
  storeReobserveCaps: {},
  reobserveDryRun: false,
  ...over,
});

/** The byId-shaped collect url the engine synthesises for a store that HAS a byId axis. */
const byIdUrl = (siteId: string, id: string): string => `https://${siteId}.test/products/${id}`;
/** The listing-derived item link a store with NO byId axis leaves in the ledger. */
const listingUrl = (siteId: string, id: string): string => `https://${siteId}.test/en/shop/${id}-some-figure.html`;

interface Reply {
  status: number;
  body?: unknown;
  throwErr?: boolean;
}

const accepted = (): Reply => ({ status: 202, body: { success: true, deduplicated: false, position: 1 } });
const dedup = (): Reply => ({ status: 202, body: { success: true, deduplicated: true, position: 1 } });
const refused = (): Reply => ({ status: 400, body: { error: 'no ruleset matches this url' } });
const sick = (): Reply => ({ status: 503, body: { error: 'queue unavailable' } });

interface FakeOpts {
  ingest?: (url: string) => Reply;
  catalog?: (siteId: string, page: number) => Reply;
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
      const r = opts.catalog
        ? opts.catalog(u.searchParams.get('store') ?? '', Number(u.searchParams.get('page')))
        : { status: 200, body: { siteId: u.searchParams.get('store'), page: 1, items: [], collectUrls: [], hasMore: false, count: 0 } };
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
    /** The collect urls POSTed to /ingest/scrape, in dispatch order. */
    posted: () => calls.filter((c) => c.url.includes('/ingest')).map((c) => c.body.url as string),
    catalogCalls: () => calls.filter((c) => c.url.includes('/catalog')).map((c) => c.url),
  };
};

/** A ledger whose entries carry per-id ages (hours BEFORE T0) and a url shape. */
const ledgerAged = (
  siteId: string,
  ages: Record<string, number>,
  url: (siteId: string, id: string) => string = byIdUrl,
  extra: Record<string, Partial<LedgerEntry>> = {},
): Ledger => ({
  ...createEmptyLedger(siteId),
  enqueued: Object.fromEntries(
    Object.entries(ages).map(([id, hoursAgo]) => [id, { at: iso(T0 - hoursAgo * HOUR_MS), collectUrl: url(siteId, id), ...(extra[id] ?? {}) }]),
  ),
});

const clock = (start = T0) => {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
};

const storeSummary = (summary: Awaited<ReturnType<typeof runCrawlerPass>>, siteId: string) => summary.stores.find((s) => s.siteId === siteId)!;

describe('runCrawlerPass — re-observation: selection', () => {
  it('selects the OLDEST-observed ids first, honours the min-age window, and stops at the store cap', async () => {
    const fake = makeFake();
    const store = createMemoryLedgerStore({
      goodsmileus: ledgerAged('goodsmileus', { young: 2, oldest: 90, middle: 40, newer: 13 }),
    });
    const c = clock();
    const s = await runCrawlerPass(mkCfg({ storeReobserveCaps: { goodsmileus: 2 } }), { fetch: fake.fetch, ledgerStore: store, now: c.now });

    // oldest (90 h) then middle (40 h); `newer` (13 h) is eligible but over the cap; `young` (2 h) is inside the window.
    expect(fake.posted()).toEqual([byIdUrl('goodsmileus', 'oldest'), byIdUrl('goodsmileus', 'middle')]);
    const st = storeSummary(s, 'goodsmileus');
    expect(st.reobserved).toBe(2);
    expect(st.reobserveSkipped).toBe(1); // `young` — inside the min-age window
    expect(st.reobserveSelected).toBe(2);
    expect(st.reobserveFailed).toBe(0);
    expect(st.reobserveCapApplied).toBe(2);
  });

  it('re-observes EVERYTHING once per window when the store knows fewer ids than its cap', async () => {
    const fake = makeFake();
    const store = createMemoryLedgerStore({ jfigure: ledgerAged('jfigure', { a: 30, b: 20, c: 14 }) });
    const c = clock();
    const s = await runCrawlerPass(mkCfg({ stores: ['jfigure'], storeReobserveCaps: { jfigure: 50 } }), {
      fetch: fake.fetch,
      ledgerStore: store,
      now: c.now,
    });
    expect(fake.posted()).toEqual([byIdUrl('jfigure', 'a'), byIdUrl('jfigure', 'b'), byIdUrl('jfigure', 'c')]);
    expect(storeSummary(s, 'jfigure').reobserved).toBe(3);

    // Immediately after, every id is inside the window again: a second pass re-observes nothing.
    const fake2 = makeFake();
    const s2 = await runCrawlerPass(mkCfg({ stores: ['jfigure'], storeReobserveCaps: { jfigure: 50 } }), {
      fetch: fake2.fetch,
      ledgerStore: store,
      now: c.now,
    });
    expect(fake2.posted()).toEqual([]);
    expect(storeSummary(s2, 'jfigure').reobserveSkipped).toBe(3);
  });

  it('never re-observes an id discovery already POSTed in the SAME run', async () => {
    const fake = makeFake({ catalog: (siteId, page) => ({
      status: 200,
      body: {
        siteId,
        page,
        items: [{ itemId: 'fresh', collectUrl: byIdUrl(siteId, 'fresh') }],
        collectUrls: [byIdUrl(siteId, 'fresh')],
        hasMore: false,
        count: 1,
      },
    }) });
    // `fresh` is BOTH on page 1 (new to the ledger) and — after discovery stamps it — a ledger id.
    const store = createMemoryLedgerStore({ goodsmileus: ledgerAged('goodsmileus', { old: 40 }) });
    const c = clock();
    const s = await runCrawlerPass(
      mkCfg({ mode: 'recent,reobserve', phases: ['recent', 'reobserve'], storeReobserveCaps: { goodsmileus: 10 } }),
      { fetch: fake.fetch, ledgerStore: store, now: c.now },
    );
    expect(fake.posted()).toEqual([byIdUrl('goodsmileus', 'fresh'), byIdUrl('goodsmileus', 'old')]);
    expect(storeSummary(s, 'goodsmileus').reobserved).toBe(1);
  });

  it('skips a ledger entry with no usable collect url instead of POSTing nothing at it', async () => {
    const fake = makeFake();
    const ledger = ledgerAged('goodsmileus', { good: 30, broken: 40 });
    (ledger.enqueued.broken as unknown as { collectUrl?: string }).collectUrl = '';
    const store = createMemoryLedgerStore({ goodsmileus: ledger });
    const c = clock();
    const s = await runCrawlerPass(mkCfg({ storeReobserveCaps: { goodsmileus: 10 } }), { fetch: fake.fetch, ledgerStore: store, now: c.now });
    expect(fake.posted()).toEqual([byIdUrl('goodsmileus', 'good')]);
    expect(storeSummary(s, 'goodsmileus').uncollectable).toBe(1);
  });

  it('CRAWLER_REOBSERVE_MIN_AGE_H=0 makes every known id eligible', async () => {
    const fake = makeFake();
    const store = createMemoryLedgerStore({ goodsmileus: ledgerAged('goodsmileus', { a: 0, b: 1 }) });
    const c = clock();
    await runCrawlerPass(mkCfg({ reobserveMinAgeMs: 0, storeReobserveCaps: { goodsmileus: 10 } }), {
      fetch: fake.fetch,
      ledgerStore: store,
      now: c.now,
    });
    expect(fake.posted().length).toBe(2);
  });
});

describe('runCrawlerPass — re-observation: the url the lane re-drives', () => {
  it('a store WITH a byId axis is re-driven through its byId url (what the ledger holds)', async () => {
    const fake = makeFake();
    const store = createMemoryLedgerStore({ goodsmileus: ledgerAged('goodsmileus', { '4934054045983': 30 }, byIdUrl) });
    const c = clock();
    await runCrawlerPass(mkCfg({ storeReobserveCaps: { goodsmileus: 5 } }), { fetch: fake.fetch, ledgerStore: store, now: c.now });
    expect(fake.posted()).toEqual(['https://goodsmileus.test/products/4934054045983']);
    // The lane costs NO catalog GET: the ledger is the listing.
    expect(fake.catalogCalls()).toEqual([]);
  });

  it('a store with NO byId axis is re-driven through the absolute item url the listing parser stored', async () => {
    const fake = makeFake();
    const store = createMemoryLedgerStore({ 'hobby-genki': ledgerAged('hobby-genki', { '12345': 30 }, listingUrl) });
    const c = clock();
    const s = await runCrawlerPass(mkCfg({ stores: ['hobby-genki'], storeReobserveCaps: { 'hobby-genki': 5 } }), {
      fetch: fake.fetch,
      ledgerStore: store,
      now: c.now,
    });
    expect(fake.posted()).toEqual(['https://hobby-genki.test/en/shop/12345-some-figure.html']);
    expect(storeSummary(s, 'hobby-genki').reobserved).toBe(1);
  });
});

describe('runCrawlerPass — re-observation: the ledger stamp', () => {
  it('stamps the new observation time on success, so the id goes to the BACK of the oldest-first queue', async () => {
    const fake = makeFake();
    const store = createMemoryLedgerStore({ goodsmileus: ledgerAged('goodsmileus', { a: 40, b: 30 }) });
    const c = clock();
    await runCrawlerPass(mkCfg({ storeReobserveCaps: { goodsmileus: 1 } }), { fetch: fake.fetch, ledgerStore: store, now: c.now });
    const saved = store.files.get('goodsmileus')!;
    expect(saved.enqueued.a.at).toBe(iso(T0)); // re-observed
    expect(saved.enqueued.b.at).toBe(iso(T0 - 30 * HOUR_MS)); // untouched

    // Next window: `b` is now the oldest and goes first.
    c.advance(13 * HOUR_MS);
    const fake2 = makeFake();
    await runCrawlerPass(mkCfg({ storeReobserveCaps: { goodsmileus: 1 } }), { fetch: fake2.fetch, ledgerStore: store, now: c.now });
    expect(fake2.posted()).toEqual([byIdUrl('goodsmileus', 'b')]);
  });

  it('counts a dedup-coalesced re-observation as a real one (the queue already had the url pending)', async () => {
    const fake = makeFake({ ingest: () => dedup() });
    const store = createMemoryLedgerStore({ goodsmileus: ledgerAged('goodsmileus', { a: 40 }) });
    const c = clock();
    const s = await runCrawlerPass(mkCfg({ storeReobserveCaps: { goodsmileus: 5 } }), { fetch: fake.fetch, ledgerStore: store, now: c.now });
    const st = storeSummary(s, 'goodsmileus');
    expect(st.reobserveLanded).toBe(1);
    expect(st.reobserved).toBe(1);
    // `deduplicated` is "of `enqueued`", and the lane never enqueues: a coalesced re-observation
    // counts as landed and nowhere else, so neither discovery counter can be read as breached.
    expect(st.enqueued).toBe(0);
    expect(st.deduplicated).toBe(0);
    expect(store.files.get('goodsmileus')!.enqueued.a.at).toBe(iso(T0));
  });

  it('a REFUSED re-observation records a distinct failure state, keeps the observation time, and reports the failure', async () => {
    const reports: FetchFailureReport[] = [];
    const fake = makeFake({ ingest: (url) => (url.endsWith('/bad') ? refused() : accepted()) });
    const store = createMemoryLedgerStore({ goodsmileus: ledgerAged('goodsmileus', { bad: 90, good: 40 }) });
    const c = clock();
    const s = await runCrawlerPass(mkCfg({ storeReobserveCaps: { goodsmileus: 5 } }), {
      fetch: fake.fetch,
      ledgerStore: store,
      now: c.now,
      reportFailure: async (r) => {
        reports.push(r);
      },
    });
    const st = storeSummary(s, 'goodsmileus');
    expect(st.reobserveFailed).toBe(1);
    expect(st.reobserved).toBe(1);
    const saved = store.files.get('goodsmileus')!;
    expect(saved.enqueued.bad.at).toBe(iso(T0 - 90 * HOUR_MS)); // NOT stamped — nothing was observed
    expect(saved.enqueued.bad.reobserveFailedAt).toBe(iso(T0));
    expect(saved.enqueued.bad.reobserveFailures).toBe(1);
    expect(saved.enqueued.good.at).toBe(iso(T0));
    // The existing fetch-failure ledger carries the refusal, keyed on the STORE's url.
    expect(reports.some((r) => r.site === 'goodsmileus' && r.target.endsWith('/bad') && r.kind === 'record')).toBe(true);
  });

  it('backs a refused id off for one min-age window so it cannot block the oldest-first queue every run', async () => {
    const fake = makeFake({ ingest: (url) => (url.endsWith('/bad') ? refused() : accepted()) });
    const store = createMemoryLedgerStore({ goodsmileus: ledgerAged('goodsmileus', { bad: 90, other: 40 }) });
    const c = clock();
    await runCrawlerPass(mkCfg({ storeReobserveCaps: { goodsmileus: 5 } }), { fetch: fake.fetch, ledgerStore: store, now: c.now });

    // An hour later `bad` is still the oldest observation, but its refusal is fresh: skip it.
    c.advance(HOUR_MS);
    const fake2 = makeFake({ ingest: () => accepted() });
    const s2 = await runCrawlerPass(mkCfg({ storeReobserveCaps: { goodsmileus: 5 } }), { fetch: fake2.fetch, ledgerStore: store, now: c.now });
    expect(fake2.posted()).toEqual([]);
    expect(storeSummary(s2, 'goodsmileus').reobserveSkipped).toBe(2);

    // Once the window has passed it is retried, and a success clears the failure state.
    c.advance(12 * HOUR_MS);
    const fake3 = makeFake({ ingest: () => accepted() });
    await runCrawlerPass(mkCfg({ storeReobserveCaps: { goodsmileus: 5 } }), { fetch: fake3.fetch, ledgerStore: store, now: c.now });
    expect(fake3.posted()).toContain(byIdUrl('goodsmileus', 'bad'));
    const saved = store.files.get('goodsmileus')!;
    expect(saved.enqueued.bad.reobserveFailedAt).toBeUndefined();
    expect(saved.enqueued.bad.reobserveFailures).toBeUndefined();
  });

  it('a TRANSIENT ingest failure stops the store for the run without backing the id off (our scraper, not the url)', async () => {
    const fake = makeFake({ ingest: () => sick() });
    const store = createMemoryLedgerStore({ goodsmileus: ledgerAged('goodsmileus', { a: 90, b: 40 }) });
    const c = clock();
    const s = await runCrawlerPass(mkCfg({ storeReobserveCaps: { goodsmileus: 5 } }), { fetch: fake.fetch, ledgerStore: store, now: c.now });
    expect(fake.posted()).toEqual([byIdUrl('goodsmileus', 'a')]); // stopped after the first
    const st = storeSummary(s, 'goodsmileus');
    expect(st.reobserveFailed).toBe(1);
    const saved = store.files.get('goodsmileus')!;
    expect(saved.enqueued.a.at).toBe(iso(T0 - 90 * HOUR_MS));
    expect(saved.enqueued.a.reobserveFailedAt).toBeUndefined();
  });
});

describe('runCrawlerPass — re-observation: budgets', () => {
  it('is OFF unless a cap opts the store in — no cap means no request at all, the same ledger WITH a cap means two', async () => {
    const seed = (): Record<string, Ledger> => ({ goodsmileus: ledgerAged('goodsmileus', { a: 90, b: 80 }) });
    const off = makeFake();
    const c = clock();
    const s = await runCrawlerPass(mkCfg({}), { fetch: off.fetch, ledgerStore: createMemoryLedgerStore(seed()), now: c.now });
    expect(off.calls).toEqual([]);
    const st = storeSummary(s, 'goodsmileus');
    expect(st.reobserveLanded).toBe(0);
    expect(st.reobserveCapApplied).toBe(0);

    // POSITIVE CONTROL, same ledger and same clock: without it this test passes just as happily
    // when the lane does not exist at all, and proves nothing about the cap.
    const on = makeFake();
    const s2 = await runCrawlerPass(mkCfg({ storeReobserveCaps: { goodsmileus: 2 } }), {
      fetch: on.fetch,
      ledgerStore: createMemoryLedgerStore(seed()),
      now: c.now,
    });
    expect(on.posted()).toEqual([byIdUrl('goodsmileus', 'a'), byIdUrl('goodsmileus', 'b')]);
    expect(storeSummary(s2, 'goodsmileus').reobserveLanded).toBe(2);
  });

  it('WARNs about a re-observe cap naming a store that is not being crawled (a typo must not read as a throttle)', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      const fake = makeFake();
      const store = createMemoryLedgerStore({ goodsmileus: ledgerAged('goodsmileus', { a: 90 }) });
      const c = clock();
      const s = await runCrawlerPass(mkCfg({ storeReobserveCaps: { goodsmileus: 5, 'not-crawled': 40 } }), {
        fetch: fake.fetch,
        ledgerStore: store,
        now: c.now,
      });
      expect(warn.mock.calls.some((call) => String(call[0]).includes('CRAWLER_STORE_REOBSERVE_CAPS'))).toBe(true);
      expect(s.reobserveCapOverrides).toEqual({ goodsmileus: 5 }); // the absent store is not reported as in force
    } finally {
      warn.mockRestore();
    }
  });

  it('falls back to the global CRAWLER_MAX_REOBSERVE_PER_STORE when a store has no override', async () => {
    const fake = makeFake();
    const store = createMemoryLedgerStore({ goodsmileus: ledgerAged('goodsmileus', { a: 90, b: 80, d: 70 }) });
    const c = clock();
    const s = await runCrawlerPass(mkCfg({ maxReobservePerStore: 2 }), { fetch: fake.fetch, ledgerStore: store, now: c.now });
    expect(fake.posted().length).toBe(2);
    expect(storeSummary(s, 'goodsmileus').reobserveCapApplied).toBe(2);
  });

  it('an explicit per-store 0 holds ONE store back while the others re-observe', async () => {
    const fake = makeFake();
    const store = createMemoryLedgerStore({
      goodsmileus: ledgerAged('goodsmileus', { a: 90 }),
      anitoys: ledgerAged('anitoys', { x: 90 }),
    });
    const c = clock();
    await runCrawlerPass(mkCfg({ stores: ['goodsmileus', 'anitoys'], maxReobservePerStore: 5, storeReobserveCaps: { anitoys: 0 } }), {
      fetch: fake.fetch,
      ledgerStore: store,
      now: c.now,
    });
    expect(fake.posted()).toEqual([byIdUrl('goodsmileus', 'a')]);
  });

  it('a SPENT DISCOVERY cap does not stop the re-observation lane (separate budgets)', async () => {
    const fake = makeFake({ catalog: (siteId, page) => ({
      status: 200,
      body: {
        siteId,
        page,
        items: [{ itemId: 'n1', collectUrl: byIdUrl(siteId, 'n1') }, { itemId: 'n2', collectUrl: byIdUrl(siteId, 'n2') }],
        collectUrls: [],
        hasMore: true,
        count: 2,
      },
    }) });
    const store = createMemoryLedgerStore({ goodsmileus: ledgerAged('goodsmileus', { old: 90 }) });
    const c = clock();
    const s = await runCrawlerPass(
      mkCfg({
        mode: 'recent,reobserve',
        phases: ['recent', 'reobserve'],
        storeEnqueueCaps: { goodsmileus: 1 }, // discovery spends its whole cap on n1
        storeReobserveCaps: { goodsmileus: 5 },
      }),
      { fetch: fake.fetch, ledgerStore: store, now: c.now },
    );
    const st = storeSummary(s, 'goodsmileus');
    expect(st.enqueued).toBe(1); // n1 — DISCOVERY only, and its cap is 1
    expect(st.enqueued).toBeLessThanOrEqual(st.capApplied);
    expect(st.reobserveLanded).toBe(1); // `old` — the lane's own, on the lane's own budget
    expect(fake.posted()).toEqual([byIdUrl('goodsmileus', 'n1'), byIdUrl('goodsmileus', 'old')]);
  });

  it('a SPENT RE-OBSERVE cap does not stop discovery (separate budgets, the other direction)', async () => {
    const fake = makeFake({ catalog: (siteId, page) => ({
      status: 200,
      body: {
        siteId,
        page,
        items: [{ itemId: 'n1', collectUrl: byIdUrl(siteId, 'n1') }, { itemId: 'n2', collectUrl: byIdUrl(siteId, 'n2') }],
        collectUrls: [],
        hasMore: false,
        count: 2,
      },
    }) });
    const store = createMemoryLedgerStore({ goodsmileus: ledgerAged('goodsmileus', { o1: 90, o2: 80 }) });
    const c = clock();
    const s = await runCrawlerPass(
      mkCfg({
        mode: 'recent,reobserve',
        phases: ['recent', 'reobserve'],
        storeEnqueueCaps: { goodsmileus: 10 },
        storeReobserveCaps: { goodsmileus: 1 },
      }),
      { fetch: fake.fetch, ledgerStore: store, now: c.now },
    );
    const st = storeSummary(s, 'goodsmileus');
    expect(st.enqueued).toBe(2); // n1 + n2 — DISCOVERY only
    expect(st.reobserveLanded).toBe(1); // o1 — the one re-observation the lane's cap allowed
    expect(st.reobserveSelected).toBe(1);
  });

  it('spends the SAME global request gate as discovery: the budget stops the lane and says so', async () => {
    const fake = makeFake();
    const store = createMemoryLedgerStore({ goodsmileus: ledgerAged('goodsmileus', { a: 90, b: 80, d: 70 }) });
    const c = clock();
    const s = await runCrawlerPass(mkCfg({ maxRequests: 2, storeReobserveCaps: { goodsmileus: 10 } }), {
      fetch: fake.fetch,
      ledgerStore: store,
      now: c.now,
    });
    expect(fake.posted().length).toBe(2);
    expect(s.budgetExhausted).toBe(true);
    expect(s.requestsIssued).toBe(2);
    expect(storeSummary(s, 'goodsmileus').reobserved).toBe(2);
  });

  it('paces its POSTs through the gate exactly like discovery (the same spacing path)', async () => {
    const fake = makeFake();
    const store = createMemoryLedgerStore({ goodsmileus: ledgerAged('goodsmileus', { a: 90, b: 80, d: 70 }) });
    const c = clock();
    const slept: number[] = [];
    await runCrawlerPass(mkCfg({ requestSpacingMs: 1000, storeReobserveCaps: { goodsmileus: 10 } }), {
      fetch: fake.fetch,
      ledgerStore: store,
      now: c.now,
      sleep: async (ms) => {
        slept.push(ms);
        c.advance(ms);
      },
    });
    expect(fake.posted().length).toBe(3);
    // Two waits for three dispatches — the gate's spacing, not a lane of its own.
    expect(slept).toEqual([1000, 1000]);
  });
});

describe('runCrawlerPass — re-observation: fairness across stores', () => {
  it('round-robins one id per store per turn, oldest first within each store', async () => {
    const fake = makeFake();
    const store = createMemoryLedgerStore({
      goodsmileus: ledgerAged('goodsmileus', { g1: 90, g2: 80, g3: 70 }),
      plazajapan: ledgerAged('plazajapan', { p1: 95, p2: 85 }),
    });
    const c = clock();
    await runCrawlerPass(
      mkCfg({ stores: ['goodsmileus', 'plazajapan'], storeReobserveCaps: { goodsmileus: 3, plazajapan: 3 } }),
      { fetch: fake.fetch, ledgerStore: store, now: c.now },
    );
    expect(fake.posted()).toEqual([
      byIdUrl('goodsmileus', 'g1'),
      byIdUrl('plazajapan', 'p1'),
      byIdUrl('goodsmileus', 'g2'),
      byIdUrl('plazajapan', 'p2'),
      byIdUrl('goodsmileus', 'g3'),
    ]);
  });

  it('a global budget short of the whole selection is split ACROSS stores, not spent on the first', async () => {
    const fake = makeFake();
    const store = createMemoryLedgerStore({
      goodsmileus: ledgerAged('goodsmileus', { g1: 90, g2: 80, g3: 70 }),
      plazajapan: ledgerAged('plazajapan', { p1: 95, p2: 85, p3: 75 }),
    });
    const c = clock();
    const s = await runCrawlerPass(
      mkCfg({ stores: ['goodsmileus', 'plazajapan'], maxRequests: 2, storeReobserveCaps: { goodsmileus: 3, plazajapan: 3 } }),
      { fetch: fake.fetch, ledgerStore: store, now: c.now },
    );
    expect(fake.posted()).toEqual([byIdUrl('goodsmileus', 'g1'), byIdUrl('plazajapan', 'p1')]);
    expect(storeSummary(s, 'goodsmileus').reobserved).toBe(1);
    expect(storeSummary(s, 'plazajapan').reobserved).toBe(1);
  });

  it('a store stopped by a cooldown is left alone; the others still re-observe', async () => {
    const fake = makeFake({ catalog: (siteId) =>
      siteId === 'anitoys'
        ? { status: 503, body: { error: 'cooldown', siteId, host: 'anitoys.test', remainingMs: 60_000 } }
        : { status: 200, body: { siteId, page: 1, items: [], collectUrls: [], hasMore: false, count: 0 } },
    });
    const store = createMemoryLedgerStore({
      anitoys: ledgerAged('anitoys', { x: 90 }),
      goodsmileus: ledgerAged('goodsmileus', { g: 90 }),
    });
    const c = clock();
    const s = await runCrawlerPass(
      mkCfg({
        mode: 'recent,reobserve',
        phases: ['recent', 'reobserve'],
        stores: ['anitoys', 'goodsmileus'],
        storeReobserveCaps: { anitoys: 5, goodsmileus: 5 },
      }),
      { fetch: fake.fetch, ledgerStore: store, now: c.now },
    );
    expect(fake.posted()).toEqual([byIdUrl('goodsmileus', 'g')]);
    expect(storeSummary(s, 'anitoys').reobserved).toBe(0);
  });

  it('a store whose LISTING axis is unsupported still re-observes (the ledger needs no listing)', async () => {
    const fake = makeFake({ catalog: (siteId) => ({ status: 422, body: { error: 'unsupported', siteId, reason: 'no listing axis' } }) });
    const store = createMemoryLedgerStore({ 'hobby-genki': ledgerAged('hobby-genki', { h: 90 }, listingUrl) });
    const c = clock();
    const s = await runCrawlerPass(
      mkCfg({ mode: 'recent,reobserve', phases: ['recent', 'reobserve'], stores: ['hobby-genki'], storeReobserveCaps: { 'hobby-genki': 5 } }),
      { fetch: fake.fetch, ledgerStore: store, now: c.now },
    );
    expect(fake.posted()).toEqual([listingUrl('hobby-genki', 'h')]);
    expect(storeSummary(s, 'hobby-genki').reobserved).toBe(1);
  });

  it('a corrupt ledger refuses the store here too — the file is never rewritten', async () => {
    const fake = makeFake();
    const store = createMemoryLedgerStore({ goodsmileus: 'corrupt' });
    const c = clock();
    const s = await runCrawlerPass(mkCfg({ storeReobserveCaps: { goodsmileus: 5 } }), { fetch: fake.fetch, ledgerStore: store, now: c.now });
    expect(fake.calls).toEqual([]);
    expect(storeSummary(s, 'goodsmileus').ledgerCorrupt).toBe(true);
    expect(store.saveLog).toEqual([]);
  });
});

describe('runCrawlerPass — re-observation: observability', () => {
  it('reports the per-store split and the run total, and logs the selection', async () => {
    const info = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    try {
      const fake = makeFake({ ingest: (url) => (url.endsWith('/bad') ? refused() : accepted()) });
      const store = createMemoryLedgerStore({
        goodsmileus: ledgerAged('goodsmileus', { bad: 95, g1: 90, young: 1 }),
        plazajapan: ledgerAged('plazajapan', { p1: 80 }),
      });
      const c = clock();
      const s = await runCrawlerPass(
        mkCfg({ stores: ['goodsmileus', 'plazajapan'], storeReobserveCaps: { goodsmileus: 5, plazajapan: 5 } }),
        { fetch: fake.fetch, ledgerStore: store, now: c.now },
      );
      expect(s.totalReobserved).toBe(2);
      expect(s.reobserveCapOverrides).toEqual({ goodsmileus: 5, plazajapan: 5 });
      const gs = storeSummary(s, 'goodsmileus');
      expect([gs.reobserved, gs.reobserveFailed, gs.reobserveSkipped]).toEqual([1, 1, 1]);
      const logged = info.mock.calls.map((call) => String(call[0]));
      expect(logged.some((m) => m.includes('reobserve'))).toBe(true);
    } finally {
      info.mockRestore();
    }
  });

  it('CRAWLER_REOBSERVE_DRY_RUN prints the selection and enqueues NOTHING', async () => {
    const info = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    try {
      const fake = makeFake();
      const store = createMemoryLedgerStore({ goodsmileus: ledgerAged('goodsmileus', { a: 90, b: 80, young: 1 }) });
      const c = clock();
      const s = await runCrawlerPass(mkCfg({ reobserveDryRun: true, storeReobserveCaps: { goodsmileus: 5 } }), {
        fetch: fake.fetch,
        ledgerStore: store,
        now: c.now,
      });
      expect(fake.calls).toEqual([]);
      expect(store.saveLog).toEqual([]); // nothing stamped
      const st = storeSummary(s, 'goodsmileus');
      expect(st.reobserveSelected).toBe(2);
      expect(st.reobserved).toBe(0);
      expect(st.reobserveSkipped).toBe(1);
      const dry = info.mock.calls.find((call) => String(call[0]).includes('DRY RUN'));
      expect(dry).toBeDefined();
      expect(JSON.stringify(dry![1])).toContain('"a"');
    } finally {
      info.mockRestore();
    }
  });
});

describe('runCrawlerPass — re-observation: determinism and odd ledgers', () => {
  it('breaks a tie in observation time by itemId, so a run is reproducible from the ledger alone', async () => {
    const fake = makeFake();
    const store = createMemoryLedgerStore({ goodsmileus: ledgerAged('goodsmileus', { zz: 40, aa: 40, mm: 40 }) });
    const c = clock();
    await runCrawlerPass(mkCfg({ storeReobserveCaps: { goodsmileus: 2 } }), { fetch: fake.fetch, ledgerStore: store, now: c.now });
    expect(fake.posted()).toEqual([byIdUrl('goodsmileus', 'aa'), byIdUrl('goodsmileus', 'mm')]);
  });

  it('survives a ledger entry that is not an object at all (the v1 coercer does not validate entries)', async () => {
    const fake = makeFake();
    const ledger = ledgerAged('goodsmileus', { good: 40 });
    (ledger.enqueued as Record<string, unknown>).broken = null;
    const store = createMemoryLedgerStore({ goodsmileus: ledger });
    const c = clock();
    const s = await runCrawlerPass(mkCfg({ storeReobserveCaps: { goodsmileus: 10 } }), { fetch: fake.fetch, ledgerStore: store, now: c.now });
    expect(fake.posted()).toEqual([byIdUrl('goodsmileus', 'good')]);
    expect(storeSummary(s, 'goodsmileus').uncollectable).toBe(1);
  });

  it('the dry run prints at most 50 ids and says so when it truncated', async () => {
    const info = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    try {
      const ages = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`id${String(i).padStart(3, '0')}`, 40 + i]));
      const fake = makeFake();
      const store = createMemoryLedgerStore({ goodsmileus: ledgerAged('goodsmileus', ages) });
      const c = clock();
      const s = await runCrawlerPass(mkCfg({ reobserveDryRun: true, storeReobserveCaps: { goodsmileus: 55 } }), {
        fetch: fake.fetch,
        ledgerStore: store,
        now: c.now,
      });
      expect(storeSummary(s, 'goodsmileus').reobserveSelected).toBe(55);
      const dry = info.mock.calls.find((call) => String(call[0]).includes('DRY RUN'))![1] as { itemIds: string[]; truncated?: boolean; count: number };
      expect(dry.itemIds).toHaveLength(50);
      expect(dry.truncated).toBe(true);
      expect(dry.count).toBe(55);
    } finally {
      info.mockRestore();
    }
  });
});

/**
 * WHOSE NUMBER IS IT. Two mechanisms re-observe: the RECENT phase's `reobserveAfterMs` window, which
 * re-POSTs a known item that reappears on listing pages 1..N and spends the DISCOVERY cap, and this
 * lane. They must not be credited to each other — jfigure is simultaneously the one store where the
 * recent-phase window fires today and a store on the proposed cap list, so the first live acceptance
 * read ("did the lane land anything?") is exactly where a shared counter would lie.
 */
describe('runCrawlerPass — re-observation: the lane reports only what the LANE did', () => {
  const jfigurePass = async (fake: ReturnType<typeof makeFake>, store: ReturnType<typeof createMemoryLedgerStore>, now: () => number) =>
    runCrawlerPass(
      mkCfg({
        mode: 'recent,reobserve',
        phases: ['recent', 'reobserve'],
        stores: ['jfigure'],
        recentMaxPages: 1,
        reobserveAfterMs: 7 * 24 * HOUR_MS, // the legacy window, as the fleet runs it
        storeReobserveCaps: { jfigure: 2 },
      }),
      { fetch: fake.fetch, ledgerStore: store, now },
    );

  /** Page 1 carries p1/p2 (known, past the legacy window); d1/d2 are deep ledger ids on no page. */
  const jfigureFake = () =>
    makeFake({
      catalog: (siteId, page) => ({
        status: 200,
        body: {
          siteId,
          page,
          items: [
            { itemId: 'p1', collectUrl: byIdUrl(siteId, 'p1') },
            { itemId: 'p2', collectUrl: byIdUrl(siteId, 'p2') },
          ],
          collectUrls: [],
          hasMore: false,
          count: 2,
        },
      }),
    });

  it('does not credit the recent phase’s window to the lane: reobserved counts both, reobserveLanded counts the lane', async () => {
    const fake = jfigureFake();
    const store = createMemoryLedgerStore({ jfigure: ledgerAged('jfigure', { p1: 200, p2: 200, d1: 300, d2: 290 }) });
    const c = clock();
    const s = await jfigurePass(fake, store, c.now);

    expect(fake.posted()).toEqual([
      byIdUrl('jfigure', 'p1'), // recent phase, legacy window
      byIdUrl('jfigure', 'p2'), // recent phase, legacy window
      byIdUrl('jfigure', 'd1'), // the lane, oldest first
      byIdUrl('jfigure', 'd2'),
    ]);
    const st = storeSummary(s, 'jfigure');
    expect(st.reobserveLanded).toBe(2); // the LANE's own work — the acceptance number
    expect(st.reobserved).toBe(4); // both mechanisms, which is what this field has always meant
    expect(st.enqueued).toBe(2); // the recent phase's two, which DID spend the discovery cap
    expect(s.totalReobserveLanded).toBe(2);
  });

  it('the lane’s completion log states the lane’s landings, not the shared total', async () => {
    const info = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    try {
      const fake = jfigureFake();
      const store = createMemoryLedgerStore({ jfigure: ledgerAged('jfigure', { p1: 200, p2: 200, d1: 300, d2: 290 }) });
      const c = clock();
      await jfigurePass(fake, store, c.now);
      const line = info.mock.calls.find((call) => String(call[0]).includes('reobserve lane complete'))![1] as {
        total: number;
        perStore: Record<string, { landed: number }>;
      };
      expect(line.total).toBe(2);
      expect(line.perStore.jfigure.landed).toBe(2);
    } finally {
      info.mockRestore();
    }
  });

  it('never reports `enqueued` past `capApplied`: the lane’s landings are not discovery enqueues', async () => {
    const fake = makeFake({ catalog: (siteId, page) => ({
      status: 200,
      body: {
        siteId,
        page,
        items: [
          { itemId: 'n1', collectUrl: byIdUrl(siteId, 'n1') },
          { itemId: 'n2', collectUrl: byIdUrl(siteId, 'n2') },
          { itemId: 'n3', collectUrl: byIdUrl(siteId, 'n3') },
        ],
        collectUrls: [],
        hasMore: false,
        count: 3,
      },
    }) });
    const store = createMemoryLedgerStore({ goodsmileus: ledgerAged('goodsmileus', { o1: 90, o2: 80, o3: 70 }) });
    const c = clock();
    const s = await runCrawlerPass(
      mkCfg({
        mode: 'recent,reobserve',
        phases: ['recent', 'reobserve'],
        storeEnqueueCaps: { goodsmileus: 2 },
        storeReobserveCaps: { goodsmileus: 3 },
      }),
      { fetch: fake.fetch, ledgerStore: store, now: c.now },
    );
    const st = storeSummary(s, 'goodsmileus');
    expect(st.capApplied).toBe(2);
    expect(st.enqueued).toBe(2); // NOT 5 — a fleet log reading `enqueued: 5, capApplied: 2` reads as a breached cap
    expect(st.reobserveLanded).toBe(3);
    expect(s.totalEnqueued).toBe(2);
    expect(s.totalReobserveLanded).toBe(3);
  });
});

/**
 * The three mutants that survived the first round's suite. The CODE was already right in all three;
 * these are the tests that were missing, so a future edit cannot quietly break them.
 */
describe('runCrawlerPass — re-observation: the guards that had no test', () => {
  it('does not repeat a url discovery was REFUSED for, in the same run (a rejection leaves `at` unstamped, so only the dedup guard stands)', async () => {
    // An ACCEPTED discovery POST stamps `at`, so the min-age filter would mask the guard. A 4xx does
    // NOT stamp it: `st.attempted` is then the only thing between the store and a second POST of a
    // url it just refused.
    const fake = makeFake({
      catalog: (siteId, page) => ({
        status: 200,
        body: {
          siteId,
          page,
          items: [{ itemId: 'bad', collectUrl: byIdUrl(siteId, 'bad') }],
          collectUrls: [],
          hasMore: false,
          count: 1,
        },
      }),
      ingest: (url) => (url.endsWith('/bad') ? refused() : accepted()),
    });
    const store = createMemoryLedgerStore({ goodsmileus: ledgerAged('goodsmileus', { bad: 300, other: 200 }) });
    const c = clock();
    const s = await runCrawlerPass(
      mkCfg({
        mode: 'recent,reobserve',
        phases: ['recent', 'reobserve'],
        recentMaxPages: 1,
        reobserveAfterMs: HOUR_MS, // the recent phase re-drives `bad` and is refused
        storeReobserveCaps: { goodsmileus: 5 },
      }),
      { fetch: fake.fetch, ledgerStore: store, now: c.now },
    );
    expect(fake.posted().filter((u) => u.endsWith('/bad'))).toHaveLength(1);
    expect(fake.posted()).toEqual([byIdUrl('goodsmileus', 'bad'), byIdUrl('goodsmileus', 'other')]);
    expect(storeSummary(s, 'goodsmileus').reobserveLanded).toBe(1); // `other` only
  });

  it('CRAWLER_MODE is the second safety key: caps alone never arm the lane', async () => {
    const fake = makeFake({ catalog: (siteId, page) => ({
      status: 200,
      body: { siteId, page, items: [], collectUrls: [], hasMore: false, count: 0 },
    }) });
    const store = createMemoryLedgerStore({ goodsmileus: ledgerAged('goodsmileus', { a: 99, b: 98, d: 97 }) });
    const c = clock();
    // Exactly the live manifest's mode, with the caps already applied — the deployment is a TWO-key
    // change, and this is the key the first round left untested.
    const s = await runCrawlerPass(
      mkCfg({ mode: 'both', phases: ['recent', 'backfill'], storeReobserveCaps: { goodsmileus: 5 } }),
      { fetch: fake.fetch, ledgerStore: store, now: c.now },
    );
    expect(fake.posted()).toEqual([]);
    const st = storeSummary(s, 'goodsmileus');
    expect(st.reobserveSelected).toBe(0);
    expect(st.reobserveLanded).toBe(0);
    // and it must not advertise a ceiling it never applied — see the cap-honesty block below
    expect(st.reobserveCapApplied).toBe(0);
    expect(st.reobserveLaneSkipped).toBe('mode-off');
  });

  it('a per-store cap SMALLER than the global default wins at the slice', async () => {
    const ages: Record<string, number> = {};
    for (let i = 0; i < 10; i++) ages[`o${i}`] = 90 + i;
    const fake = makeFake();
    const store = createMemoryLedgerStore({ goodsmileus: ledgerAged('goodsmileus', ages) });
    const c = clock();
    const s = await runCrawlerPass(mkCfg({ maxReobservePerStore: 20, storeReobserveCaps: { goodsmileus: 3 } }), {
      fetch: fake.fetch,
      ledgerStore: store,
      now: c.now,
    });
    expect(storeSummary(s, 'goodsmileus').reobserveCapApplied).toBe(3);
    expect(fake.posted()).toHaveLength(3); // not 10 (every eligible id), not 20 (the global default)
    expect(storeSummary(s, 'goodsmileus').reobserveLanded).toBe(3);
  });
});

/**
 * `reobserveCapApplied` is an APPLIED ceiling, not a configured one. A store the lane could not touch
 * at all must not advertise a cap, for the same reason the lane must not count the recent phase's
 * work: a fleet log that says `reobserveCapApplied: 8` next to zero activity sends the operator
 * looking for a broken lane instead of at the thing that held the store back.
 */
describe('runCrawlerPass — re-observation: the cap a store actually ran under, and why not', () => {
  it('a store pulled OUT of the run by a discovery cap of 0 reports no cap and says why', async () => {
    const fake = makeFake();
    const store = createMemoryLedgerStore({ 'hobby-genki': ledgerAged('hobby-genki', { a: 50, b: 60, d: 70 }, listingUrl) });
    const c = clock();
    const s = await runCrawlerPass(
      mkCfg({
        stores: ['hobby-genki'],
        storeEnqueueCaps: { 'hobby-genki': 0 }, // an explicit 0 pulls the store out of the WHOLE run
        storeReobserveCaps: { 'hobby-genki': 8 },
      }),
      { fetch: fake.fetch, ledgerStore: store, now: c.now },
    );
    expect(fake.calls).toEqual([]);
    const st = storeSummary(s, 'hobby-genki');
    expect(st.reobserveCapApplied).toBe(0); // NOT 8 — nothing of the sort was applied
    expect(st.reobserveLaneSkipped).toBe('store-out');
    // the configured value is not lost: it is still reported once, at run level
    expect(s.reobserveCapOverrides).toEqual({ 'hobby-genki': 8 });
  });

  it('a store with no cap of its own reports `not-configured`, and a store that ran reports its cap and null', async () => {
    const fake = makeFake();
    const store = createMemoryLedgerStore({
      goodsmileus: ledgerAged('goodsmileus', { g: 90 }),
      plazajapan: ledgerAged('plazajapan', { p: 90 }),
    });
    const c = clock();
    const s = await runCrawlerPass(
      mkCfg({ stores: ['goodsmileus', 'plazajapan'], storeReobserveCaps: { goodsmileus: 4 } }),
      { fetch: fake.fetch, ledgerStore: store, now: c.now },
    );
    const armed = storeSummary(s, 'goodsmileus');
    expect(armed.reobserveCapApplied).toBe(4);
    expect(armed.reobserveLaneSkipped).toBeNull();
    const unarmed = storeSummary(s, 'plazajapan');
    expect(unarmed.reobserveCapApplied).toBe(0);
    expect(unarmed.reobserveLaneSkipped).toBe('not-configured');
  });

  it('a corrupt ledger and a cooling host each report their own reason, not a cap', async () => {
    const fake = makeFake({ catalog: (siteId) =>
      siteId === 'anitoys'
        ? { status: 503, body: { error: 'cooldown', siteId, host: 'anitoys.test', remainingMs: 60_000 } }
        : { status: 200, body: { siteId, page: 1, items: [], collectUrls: [], hasMore: false, count: 0 } },
    });
    const store = createMemoryLedgerStore({
      goodsmileus: 'corrupt',
      anitoys: ledgerAged('anitoys', { x: 90 }),
    });
    const c = clock();
    const s = await runCrawlerPass(
      mkCfg({
        mode: 'recent,reobserve',
        phases: ['recent', 'reobserve'],
        stores: ['goodsmileus', 'anitoys'],
        storeReobserveCaps: { goodsmileus: 5, anitoys: 5 },
      }),
      { fetch: fake.fetch, ledgerStore: store, now: c.now },
    );
    const corrupt = storeSummary(s, 'goodsmileus');
    expect(corrupt.reobserveCapApplied).toBe(0);
    expect(corrupt.reobserveLaneSkipped).toBe('ledger');
    const cooling = storeSummary(s, 'anitoys');
    expect(cooling.reobserveCapApplied).toBe(0);
    expect(cooling.reobserveLaneSkipped).toBe('store-stopped');
  });
});

describe('runCrawlerPass — re-observation: the min-age window is also the back-off window', () => {
  it('CRAWLER_REOBSERVE_MIN_AGE_H=0 disables the refusal back-off as well as the age bar', async () => {
    // One value governs both, which is documented but easy to miss: at 0 an id refused seconds ago is
    // driven again on the very next pass. Pinned so the coupling cannot change by accident.
    const fake = makeFake({ ingest: () => refused() });
    const store = createMemoryLedgerStore({
      goodsmileus: ledgerAged('goodsmileus', { bad: 1 }, byIdUrl, {
        bad: { reobserveFailedAt: iso(T0 - 1000), reobserveFailures: 9 },
      }),
    });
    const c = clock();
    const s = await runCrawlerPass(mkCfg({ reobserveMinAgeMs: 0, storeReobserveCaps: { goodsmileus: 5 } }), {
      fetch: fake.fetch,
      ledgerStore: store,
      now: c.now,
    });
    expect(fake.posted()).toEqual([byIdUrl('goodsmileus', 'bad')]); // refused a second ago, driven anyway
    const st = storeSummary(s, 'goodsmileus');
    expect(st.reobserveSkipped).toBe(0);
    expect(st.reobserveFailed).toBe(1);
    expect(store.files.get('goodsmileus')!.enqueued.bad.reobserveFailures).toBe(10);
  });

  it('the default 12 h window DOES hold that id back (the control for the case above)', async () => {
    const fake = makeFake({ ingest: () => refused() });
    const store = createMemoryLedgerStore({
      goodsmileus: ledgerAged('goodsmileus', { bad: 1 }, byIdUrl, {
        bad: { reobserveFailedAt: iso(T0 - 1000), reobserveFailures: 9 },
      }),
    });
    const c = clock();
    const s = await runCrawlerPass(mkCfg({ storeReobserveCaps: { goodsmileus: 5 } }), {
      fetch: fake.fetch,
      ledgerStore: store,
      now: c.now,
    });
    expect(fake.posted()).toEqual([]);
    expect(storeSummary(s, 'goodsmileus').reobserveSkipped).toBe(1);
  });
});
