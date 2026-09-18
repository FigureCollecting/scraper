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
    expect(st.reobserved).toBe(1);
    expect(st.deduplicated).toBe(1);
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
  it('is OFF unless a cap opts the store in — no cap means no request at all', async () => {
    const fake = makeFake();
    const store = createMemoryLedgerStore({ goodsmileus: ledgerAged('goodsmileus', { a: 90, b: 80 }) });
    const c = clock();
    const s = await runCrawlerPass(mkCfg({}), { fetch: fake.fetch, ledgerStore: store, now: c.now });
    expect(fake.calls).toEqual([]);
    const st = storeSummary(s, 'goodsmileus');
    expect(st.reobserved).toBe(0);
    expect(st.reobserveCapApplied).toBe(0);
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
    expect(st.enqueued).toBe(2); // n1 (discovery) + old (re-observation)
    expect(st.reobserved).toBe(1);
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
    expect(st.enqueued).toBe(3); // n1 + n2 (discovery) + o1 (the one re-observation the cap allowed)
    expect(st.reobserved).toBe(1);
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
