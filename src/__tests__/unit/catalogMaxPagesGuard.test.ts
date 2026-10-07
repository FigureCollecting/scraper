/**
 * QB-U24 — the ENGINE's maxPages guard (SCRAPE_CATALOG_MAX_PAGES_GUARD = off | all | stores csv; default off).
 *
 * The crawler has no rulesets profiles, so the bound lives in the engine: GET /catalog?store=&page=p with p
 * above the profile's `byListing.maxPages` (an extra property the rulesets plugin carries across the
 * injection boundary) is answered with the existing EXHAUSTED page — `{siteId, page, url, items: [],
 * collectUrls: [], hasMore: false, count: 0}`, no new field — WITHOUT a store fetch, for a guarded store.
 * The crawler then learns the end exactly as at a real catalog end (candidate, then the two-run rule) at
 * zero store GETs. mfc (maxPages 1): its weekly page-2 backfill re-check becomes an engine answer.
 *
 * Everything runs through the REAL /catalog route (createCatalogRoute(createEngineCatalog(registry, ...)))
 * with a RECORDING fake transport on every lane and the real ProfileRegistry. Hands-off: no request ever
 * leaves the process — global fetch is replaced by a thrower for the whole file.
 */
import express from 'express';
import request from 'supertest';
import { createCatalogRoute } from '../../routes/catalog';
import { createEngineCatalog, type LookupRegistry } from '../../services/engineLookup';
import { declaredLastPage, MaxPagesGuard, setMaxPagesGuard, getMaxPagesGuard, MAX_PAGES_GUARD_ENV } from '../../services/maxPagesGuard';
import { getChallengeCooldown } from '../../services/challengeCooldown';
import { runCrawlerPass, type CrawlerConfig, type FetchLike } from '../../crawler/crawler';
import { createEmptyLedger, createMemoryLedgerStore, type Ledger } from '../../crawler/ledger';
import { createMemoryListsStateStore } from '../../crawler/listsState';
import type { ExtractionRuleset, StoreCapabilities } from '@figurecollecting/scraper-plugin-contract';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const T0 = Date.parse('2026-10-07T03:30:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

const realFetch = global.fetch;
beforeEach(() => {
  global.fetch = jest.fn(async () => {
    throw new Error('hands-off: a test tried to reach the network');
  }) as unknown as typeof fetch;
  setMaxPagesGuard(null);
});
afterEach(() => {
  global.fetch = realFetch;
  setMaxPagesGuard(null);
  delete process.env[MAX_PAGES_GUARD_ENV];
});

const rate = (domain: string) => ({ domain, baseDelayMs: 0, minDelayMs: 0, maxDelayMs: 100, backoffMultiplier: 2, recoveryDivisor: 2, successThreshold: 3 });

/** A store whose listing declares maxPages 3 (ten ids a page). */
const THREE: StoreCapabilities = {
  siteId: 'three',
  name: 'Three',
  domains: ['three.test'],
  rateLimit: rate('three.test'),
  requiresBrowser: false,
  allowedCookies: [],
  retrieval: { byListing: { urlTemplate: 'https://three.test/new?page={page}', order: 'newest', maxPages: 3 } as never },
};
/** A store that declares no maxPages (gkloot's shape). */
const NOMAX: StoreCapabilities = {
  ...THREE,
  siteId: 'nomax',
  name: 'NoMax',
  domains: ['nomax.test'],
  rateLimit: rate('nomax.test'),
  retrieval: { byListing: { urlTemplate: 'https://nomax.test/new?page={page}', order: 'newest' } },
};
/** mfc's Latest Additions feed, as its profile declares it: one url, no {page}, maxPages 1. */
const MFC: StoreCapabilities = {
  ...THREE,
  siteId: 'mfc',
  name: 'MFC',
  domains: ['myfigurecollection.net'],
  rateLimit: rate('myfigurecollection.net'),
  retrieval: {
    byId: { urlTemplate: 'https://myfigurecollection.net/item/{id}' },
    byListing: { urlTemplate: 'https://myfigurecollection.net/item/browse/figure/', order: 'newest', maxPages: 1 } as never,
  },
};
/** A store with maxPages but no listing parser. */
const NOPARSER: StoreCapabilities = { ...THREE, siteId: 'noparser', domains: ['noparser.test'], rateLimit: rate('noparser.test'), retrieval: { byListing: { urlTemplate: 'https://noparser.test/new?page={page}', order: 'newest', maxPages: 1 } as never } };

/** The fixture parser: page N of a {page} store lists ids N01..N10 and has more below; mfc's feed lists five ids and never has more. */
const ruleset = (siteId: string): ExtractionRuleset => ({
  siteId,
  version: '1.0.0',
  extract: () => ({ source: { site: siteId, itemId: 'x', extractedAt: '2026-10-07T00:00:00.000Z' }, fields: {}, warnings: [] }),
  validate: () => ({ valid: true, errors: [], warnings: [] }),
  ...(siteId === 'noparser'
    ? {}
    : {
        extractListing: (body: string) => {
          const { page } = JSON.parse(body) as { page: number };
          if (siteId === 'mfc') return { items: [1, 2, 3, 4, 5].map((n) => ({ itemId: String(4_000_000 - n) })), hasMore: false };
          return { items: Array.from({ length: 10 }, (_, i) => ({ itemId: `${page}${String(i + 1).padStart(2, '0')}`, url: `/item/${page}${i + 1}` })), hasMore: true };
        },
      }),
});

const STORES = [THREE, NOMAX, MFC, NOPARSER];
const registry: LookupRegistry = {
  allStores: () => STORES,
  getRulesetForUrl: (url) => ruleset(STORES.find((s) => url.includes(s.domains[0]))!.siteId),
};

/** Every lane records and answers a fixture body; nothing is fetched. */
const recordingTransports = () => {
  const fetched: string[] = [];
  const body = (url: string) => {
    fetched.push(url);
    const page = Number(new URL(url).searchParams.get('page') ?? 1);
    return JSON.stringify({ page });
  };
  return {
    fetched,
    transports: {
      http: jest.fn(async (url: string) => body(url)),
      impersonate: jest.fn(async (url: string) => body(url)),
      browser: jest.fn(async (url: string) => body(url)),
    },
  };
};

const engineApp = () => {
  const rec = recordingTransports();
  const app = express();
  app.use('/', createCatalogRoute(createEngineCatalog(registry, rec.transports)));
  return { app, fetched: rec.fetched };
};

const EXHAUSTED = (siteId: string, page: number, url: string) => ({ siteId, page, url, items: [], collectUrls: [], hasMore: false, count: 0 });

describe('SCRAPE_CATALOG_MAX_PAGES_GUARD scope', () => {
  it.each([undefined, '', 'off', ' OFF '])('%p = off: guards nothing', (raw) => {
    const g = new MaxPagesGuard(raw);
    expect(g.covers('mfc')).toBe(false);
    expect(g.view(T0)).toEqual({ mode: 'off', stores: [] });
    expect(g.describe()).toContain('off');
  });

  it('all: every store', () => {
    const g = new MaxPagesGuard(' all ');
    expect(g.covers('mfc')).toBe(true);
    expect(g.covers('anything')).toBe(true);
    expect(g.view(T0).mode).toBe('all');
    expect(g.describe()).toContain(`${MAX_PAGES_GUARD_ENV}=all`);
  });

  it('a csv: only those stores; a bad entry or a keyword inside the list is ignored with a WARN', () => {
    const g = new MaxPagesGuard('mfc, three,mfc,bad/id,all');
    expect(g.covers('mfc')).toBe(true);
    expect(g.covers('three')).toBe(true);
    expect(g.covers('nomax')).toBe(false);
    expect(g.warnings()).toHaveLength(2);
    expect(g.warnings()[0]).toContain('bad/id');
    expect(g.warnings()[1]).toContain('"all"');
    expect(g.describe()).toContain('mfc, three');
    expect(new MaxPagesGuard('bad/id').view(T0).mode).toBe('off');
  });

  it('getMaxPagesGuard reads the env var once', () => {
    process.env[MAX_PAGES_GUARD_ENV] = 'mfc';
    expect(getMaxPagesGuard().covers('mfc')).toBe(true);
    process.env[MAX_PAGES_GUARD_ENV] = 'off';
    expect(getMaxPagesGuard().covers('mfc')).toBe(true);
    setMaxPagesGuard(null);
    expect(getMaxPagesGuard().covers('mfc')).toBe(false);
  });
});

describe('declaredLastPage (the profile extra property, read as untrusted)', () => {
  it.each([
    [{ maxPages: 3 }, 3],
    [{ maxPages: 1 }, 1],
    [{ maxPages: 3, pageStart: 1 }, 3],
    [{ maxPages: 3, pageStart: 0 }, 2],
    [{ maxPages: 3, pageStart: 5 }, 7],
  ])('%p -> %p', (byListing, last) => {
    expect(declaredLastPage(byListing)).toBe(last);
  });

  it.each([
    [undefined],
    [null],
    ['x'],
    [{}],
    [{ maxPages: 0 }],
    [{ maxPages: -1 }],
    [{ maxPages: 1.5 }],
    [{ maxPages: '3' }],
    [{ maxPages: Number.NaN }],
    [{ maxPages: 3, pageStart: -1 }],
    [{ maxPages: 3, pageStart: 1.5 }],
    [{ maxPages: 3, pageStart: '1' }],
  ])('%p: no usable bound (unguarded)', (byListing) => {
    expect(declaredLastPage(byListing)).toBeUndefined();
  });
});

describe('the trailing-hour count (maxPagesGuarded60m)', () => {
  it('counts the engine answers of the last hour per store, sorted by store, with the last time', () => {
    const g = new MaxPagesGuard('three,mfc');
    g.record('three', T0);
    g.record('three', T0 + 30 * 60_000);
    g.record('mfc', T0 + 10 * 60_000);
    expect(g.view(T0 + 59 * 60_000)).toEqual({
      mode: 'stores',
      stores: [
        { siteId: 'mfc', maxPagesGuarded60m: 1, lastGuardedAt: iso(T0 + 10 * 60_000) },
        { siteId: 'three', maxPagesGuarded60m: 2, lastGuardedAt: iso(T0 + 30 * 60_000) },
      ],
    });
    // Exactly one hour old is out of the window; the last time stays.
    expect(g.view(T0 + HOUR_MS).stores[1]).toEqual({ siteId: 'three', maxPagesGuarded60m: 1, lastGuardedAt: iso(T0 + 30 * 60_000) });
    expect(g.view(T0 + 3 * HOUR_MS).stores).toEqual([
      { siteId: 'mfc', maxPagesGuarded60m: 0, lastGuardedAt: iso(T0 + 10 * 60_000) },
      { siteId: 'three', maxPagesGuarded60m: 0, lastGuardedAt: iso(T0 + 30 * 60_000) },
    ]);
  });

  it('a listed store that was never guarded reads zero; `all` lists only the stores it answered for', () => {
    expect(new MaxPagesGuard('mfc').view(T0).stores).toEqual([{ siteId: 'mfc', maxPagesGuarded60m: 0, lastGuardedAt: null }]);
    const all = new MaxPagesGuard('all');
    expect(all.view(T0).stores).toEqual([]);
    all.record('nomax', T0);
    expect(all.view(T0).stores).toEqual([{ siteId: 'nomax', maxPagesGuarded60m: 1, lastGuardedAt: iso(T0) }]);
  });
});

describe('GET /catalog through the real route', () => {
  it('guard off = today: page 4 of a maxPages-3 store is fetched from the store', async () => {
    const { app, fetched } = engineApp();
    const res = await request(app).get('/catalog?store=three&page=4');
    expect(res.status).toBe(200);
    expect(fetched).toEqual(['https://three.test/new?page=4']);
    expect(res.body.count).toBe(10);
  });

  it('guard on: page 4 answers exhausted with ZERO store fetches; pages 1-3 are unchanged', async () => {
    const off = engineApp();
    const offBodies = [];
    for (const p of [1, 2, 3]) offBodies.push((await request(off.app).get(`/catalog?store=three&page=${p}`)).body);

    setMaxPagesGuard(new MaxPagesGuard('three'));
    const on = engineApp();
    for (const [i, p] of [1, 2, 3].entries()) {
      const res = await request(on.app).get(`/catalog?store=three&page=${p}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(offBodies[i]);
    }
    expect(on.fetched).toEqual(off.fetched);
    const res = await request(on.app).get('/catalog?store=three&page=4');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(EXHAUSTED('three', 4, 'https://three.test/new?page=4'));
    expect(on.fetched).toHaveLength(3);
    await request(on.app).get('/catalog?store=three&page=99');
    expect(on.fetched).toHaveLength(3);
    expect(getMaxPagesGuard().view(Date.now()).stores).toEqual([{ siteId: 'three', maxPagesGuarded60m: 2, lastGuardedAt: expect.any(String) }]);
  });

  it('an unguarded store is unchanged: no maxPages under `all`, or a store the csv does not name', async () => {
    setMaxPagesGuard(new MaxPagesGuard('all'));
    const a = engineApp();
    expect((await request(a.app).get('/catalog?store=nomax&page=9')).body.count).toBe(10);
    expect(a.fetched).toEqual(['https://nomax.test/new?page=9']);
    setMaxPagesGuard(new MaxPagesGuard('mfc'));
    const b = engineApp();
    expect((await request(b.app).get('/catalog?store=three&page=4')).body.count).toBe(10);
    expect(b.fetched).toEqual(['https://three.test/new?page=4']);
  });

  it('unsupported still wins: a store with no listing parser answers 422, guarded or not', async () => {
    setMaxPagesGuard(new MaxPagesGuard('all'));
    const { app, fetched } = engineApp();
    const res = await request(app).get('/catalog?store=noparser&page=2');
    expect(res.status).toBe(422);
    expect(fetched).toEqual([]);
  });

  it('a guarded page above maxPages is answered from the declaration even while the host cools (no fetch either way)', async () => {
    const cd = getChallengeCooldown();
    cd.open('three.test', 'test');
    try {
      setMaxPagesGuard(new MaxPagesGuard('three'));
      const { app, fetched } = engineApp();
      expect((await request(app).get('/catalog?store=three&page=4')).body).toEqual(EXHAUSTED('three', 4, 'https://three.test/new?page=4'));
      expect((await request(app).get('/catalog?store=three&page=2')).status).toBe(503);
      expect(fetched).toEqual([]);
    } finally {
      cd.clear('three.test');
    }
  });
});

describe('mfc (maxPages 1): the crawler through the real /catalog path', () => {
  /** The crawler's http surface: /catalog goes to the real engine route, /ingest/scrape is accepted. */
  const bridge = (app: express.Express): FetchLike => async (url, init) => {
    const u = new URL(url);
    if (init?.method === 'POST') {
      return { ok: true, status: 202, json: async () => ({ success: true, deduplicated: false }), text: async () => '{}' };
    }
    const res = await request(app).get(`${u.pathname}${u.search}`);
    return { ok: res.status >= 200 && res.status < 300, status: res.status, json: async () => res.body, text: async () => res.text };
  };

  const cfg = (over: Partial<CrawlerConfig> = {}): CrawlerConfig => ({
    scraperServiceUrl: 'http://scraper.test',
    mode: 'both',
    phases: ['recent', 'backfill'],
    stores: ['mfc'],
    ledgerDir: '/unused',
    recentMaxPages: 3,
    backfillPagesPerRun: 5,
    maxRequests: 100,
    maxEnqueuePerStore: 50,
    maxConcurrency: 1,
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
    rangeReanchorMs: DAY_MS,
    rangeReanchorMaxDelta: 50_000,
    rangeGapBudget: 0,
    rangeGaps: {},
    rangeGapDryRun: false,
    pagePool: [],
    pagePoolLookahead: 5,
    pagePoolVisitedTtlMs: 72 * HOUR_MS,
    ...over,
  });

  /** mfc's ledger today: page 1's ids known, the end confirmed at page 2 more than a week ago. */
  const exhaustedMfc = (): Ledger => {
    const l = createEmptyLedger('mfc');
    for (const n of [1, 2, 3, 4, 5]) l.enqueued[String(4_000_000 - n)] = { at: iso(T0 - DAY_MS), collectUrl: `https://myfigurecollection.net/item/${4_000_000 - n}` };
    l.backfill = { cursor: 2, exhaustedAt: iso(T0 - 8 * DAY_MS) };
    return l;
  };

  const weekly = async (guard: string | undefined, pool: CrawlerConfig['pagePool'] = []) => {
    setMaxPagesGuard(new MaxPagesGuard(guard));
    const { app, fetched } = engineApp();
    const ledgers = createMemoryLedgerStore({ mfc: exhaustedMfc() });
    const summary = await runCrawlerPass(cfg({ pagePool: pool }), { fetch: bridge(app), ledgerStore: ledgers, listsStore: createMemoryListsStateStore(), now: () => T0, pagePoolSeed: 1 });
    return { fetched, summary: summary.stores[0], ledger: ledgers.files.get('mfc')! };
  };

  it('the weekly page-2 re-check: one MFC GET today, ZERO with the guard; the end is re-confirmed either way', async () => {
    const today = await weekly(undefined);
    // The recent read (page 1) and the re-check (page 2) both reach the one feed url.
    expect(today.fetched).toEqual(['https://myfigurecollection.net/item/browse/figure/', 'https://myfigurecollection.net/item/browse/figure/']);
    expect(today.summary.backfillPages).toBe(1);
    expect(today.ledger.backfill.exhaustedAt).toBe(iso(T0));

    for (const pool of [[], ['mfc']] as CrawlerConfig['pagePool'][]) {
      const guarded = await weekly('mfc', pool);
      expect(guarded.fetched).toEqual(['https://myfigurecollection.net/item/browse/figure/']);
      expect(guarded.summary.backfillPages).toBe(1);
      expect(guarded.summary.exhausted).toBe(true);
      expect(guarded.ledger.backfill.exhaustedAt).toBe(iso(T0));
    }
  });

  it('a fresh mfc ledger: candidate then confirmation by the two-run rule, zero MFC GETs above page 1 (pooled too)', async () => {
    for (const pool of [[], 'all'] as CrawlerConfig['pagePool'][]) {
      setMaxPagesGuard(new MaxPagesGuard('mfc'));
      const { app, fetched } = engineApp();
      const ledgers = createMemoryLedgerStore();
      const pass = async (at: number) =>
        (await runCrawlerPass(cfg({ pagePool: pool }), { fetch: bridge(app), ledgerStore: ledgers, listsStore: createMemoryListsStateStore(), now: () => at, pagePoolSeed: 3 })).stores[0];
      const p1 = await pass(T0);
      expect(p1.exhaustCandidate).toBe(true);
      expect(p1.backfillCursor).toBe(2);
      const p2 = await pass(T0 + HOUR_MS);
      expect(p2.exhausted).toBe(true);
      const p3 = await pass(T0 + 2 * HOUR_MS);
      expect(p3.backfillPages).toBe(0);
      // Three recent reads of page 1; nothing else ever reached the feed.
      expect(fetched).toEqual(Array(3).fill('https://myfigurecollection.net/item/browse/figure/'));
    }
  });
});
