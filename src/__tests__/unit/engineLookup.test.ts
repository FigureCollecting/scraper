/**
 * createEngineLookup — the entrypoint factory: builds a cross-store Lookup from the engine's
 * registry (allStores → ProfileRegistry) + a fetch, and fans a query to parse candidates.
 */
import { createEngineLookup, createEngineCatalog, httpFetchBody, type LookupRegistry } from '../../services/engineLookup';
import type { ExtractionRuleset, StoreCapabilities } from '@figurecollecting/scraper-plugin-contract';

const STORE: StoreCapabilities = {
  siteId: 'goodsmileus',
  name: 'GSUS',
  domains: ['www.goodsmileus.com'],
  rateLimit: { domain: 'www.goodsmileus.com', baseDelayMs: 0, minDelayMs: 0, maxDelayMs: 100, backoffMultiplier: 2, recoveryDivisor: 2, successThreshold: 3 },
  requiresBrowser: false,
  allowedCookies: [],
  retrieval: { bySearch: { urlTemplate: 'https://www.goodsmileus.com/search/suggest.json?q={q}', scope: 'listed' } },
};

const RULESET: ExtractionRuleset = {
  siteId: 'goodsmileus',
  version: '1.0.0',
  extract: () => ({ source: { site: 'goodsmileus', itemId: 'x', extractedAt: '2026-08-09T00:00:00.000Z' }, fields: {}, warnings: [] }),
  validate: () => ({ valid: true, errors: [], warnings: [] }),
  extractCandidates: (body) =>
    (JSON.parse(body) as Array<{ h: string; t: string }>).map((p) => ({ itemId: p.h, name: p.t, available: true })),
};

describe('createEngineLookup', () => {
  it('builds a Lookup from the registry that fans search and parses candidates', async () => {
    const registry: LookupRegistry = { allStores: () => [STORE], getRulesetForUrl: () => RULESET };
    const fetchBody = jest.fn(async () => JSON.stringify([{ h: 'gyaru-tomie-hk', t: 'Gyaru Tomie x Hello Kitty' }]));

    const lookup = createEngineLookup(registry, { http: fetchBody });
    const out = await lookup.lookup('tomie', { mode: 'listed' });

    expect(fetchBody).toHaveBeenCalledWith('https://www.goodsmileus.com/search/suggest.json?q=tomie');
    expect(out.results[0]?.siteId).toBe('goodsmileus');
    expect(out.results[0]?.candidates[0]?.name).toBe('Gyaru Tomie x Hello Kitty');
  });

  it('defaults the http transport to httpFetchBody when none is provided', async () => {
    const orig = global.fetch;
    global.fetch = jest.fn(async () => ({ text: async () => JSON.stringify([{ h: 'x', t: 'X' }]) })) as unknown as typeof fetch;
    try {
      const registry: LookupRegistry = { allStores: () => [STORE], getRulesetForUrl: () => RULESET };
      const out = await createEngineLookup(registry).lookup('tomie'); // no transports → http = httpFetchBody
      expect(out.results[0]?.candidates[0]?.name).toBe('X');
    } finally {
      global.fetch = orig;
    }
  });

  it('a store with no ruleset parser is unsupported', async () => {
    const registry: LookupRegistry = { allStores: () => [STORE], getRulesetForUrl: () => undefined };
    const out = await createEngineLookup(registry, { http: jest.fn(async () => '[]') }).lookup('miku');
    expect(out.unsupported).toContain('goodsmileus');
    expect(out.results).toEqual([]);
  });

  it('routes a store that declares the impersonate transport to the impit fetcher (not http)', async () => {
    const AMIAMI_STORE: StoreCapabilities = {
      ...STORE,
      siteId: 'amiami',
      name: 'AmiAmi',
      domains: ['www.amiami.com'],
      requiresBrowser: true,
      retrieval: { bySearch: { urlTemplate: 'https://api.amiami.com/api/v1.0/items?s_keywords={q}', scope: 'listed' } },
      searchFetch: { transport: 'impersonate', browser: 'chrome142', headers: { 'X-User-Key': 'amiami_dev' } },
    };
    const registry: LookupRegistry = { allStores: () => [AMIAMI_STORE], getRulesetForUrl: () => RULESET };
    const http = jest.fn(async () => JSON.stringify([]));
    const impersonate = jest.fn(async () => JSON.stringify([{ h: 'a1', t: 'Tomie' }]));

    const out = await createEngineLookup(registry, { http, impersonate }).lookup('tomie');

    expect(impersonate).toHaveBeenCalledWith(
      'https://api.amiami.com/api/v1.0/items?s_keywords=tomie',
      { browser: 'chrome142', headers: { 'X-User-Key': 'amiami_dev' }, userAgent: undefined },
    );
    expect(http).not.toHaveBeenCalled();
    expect(out.results[0]?.candidates[0]?.name).toBe('Tomie');
  });
});

describe('createEngineCatalog', () => {
  const LISTING_STORE: StoreCapabilities = {
    ...STORE,
    retrieval: {
      bySearch: STORE.retrieval!.bySearch,
      byListing: { urlTemplate: 'https://www.goodsmileus.com/products.json?limit=250&page={page}', maxPerPage: 250, order: 'newest' },
    },
  };
  const LISTING_RULESET: ExtractionRuleset = {
    ...RULESET,
    extractListing: (body) => ({
      items: (JSON.parse(body) as { products: Array<{ handle: string }> }).products.map((p) => ({ itemId: p.handle, url: `/products/${p.handle}` })),
    }),
  };

  it('builds a Catalog from the registry that fetches the store\'s listing page and parses + decorates its items', async () => {
    const registry: LookupRegistry = { allStores: () => [LISTING_STORE], getRulesetForUrl: () => LISTING_RULESET };
    const fetchBody = jest.fn(async () => JSON.stringify({ products: [{ handle: 'noir-black-rabbit-14825' }] }));

    const out = await createEngineCatalog(registry, { http: fetchBody }).catalog('goodsmileus', 2);

    expect(fetchBody).toHaveBeenCalledWith('https://www.goodsmileus.com/products.json?limit=250&page=2');
    expect(out).toMatchObject({
      status: 'ok',
      siteId: 'goodsmileus',
      page: 2,
      items: [{ itemId: 'noir-black-rabbit-14825', url: '/products/noir-black-rabbit-14825', collectUrl: 'https://www.goodsmileus.com/products/noir-black-rabbit-14825' }],
      collectUrls: ['https://www.goodsmileus.com/products/noir-black-rabbit-14825'],
      hasMore: true,
      nextPage: 3,
      count: 1,
    });
  });

  it('defaults the http transport to httpFetchBody when no transports are given', async () => {
    const orig = global.fetch;
    global.fetch = jest.fn(async () => ({ text: async () => JSON.stringify({ products: [{ handle: 'x' }] }) })) as unknown as typeof fetch;
    try {
      const registry: LookupRegistry = { allStores: () => [LISTING_STORE], getRulesetForUrl: () => LISTING_RULESET };
      const out = await createEngineCatalog(registry).catalog('goodsmileus'); // no transports → http = httpFetchBody
      expect(global.fetch).toHaveBeenCalledWith('https://www.goodsmileus.com/products.json?limit=250&page=1', expect.anything());
      expect(out).toMatchObject({ status: 'ok', items: [{ itemId: 'x', collectUrl: 'https://www.goodsmileus.com/products/x' }] });
    } finally {
      global.fetch = orig;
    }
  });

  it('a store whose ruleset has no extractListing is unsupported (shares the lookup registry wiring)', async () => {
    const registry: LookupRegistry = { allStores: () => [LISTING_STORE], getRulesetForUrl: () => RULESET };
    const http = jest.fn(async () => '{}');
    const out = await createEngineCatalog(registry, { http }).catalog('goodsmileus');
    expect(out).toMatchObject({ status: 'unsupported', siteId: 'goodsmileus' });
    expect(http).not.toHaveBeenCalled();
  });

  it('routes a store that declares the impersonate transport to the impit fetcher (not http), like /lookup', async () => {
    const AMIAMI_LISTING: StoreCapabilities = {
      ...STORE,
      siteId: 'amiami',
      name: 'AmiAmi',
      domains: ['www.amiami.com'],
      requiresBrowser: true,
      retrieval: { byListing: { urlTemplate: 'https://api.amiami.com/api/v1.0/items?s_st_list_newitem_available=1&pagecnt={page}', order: 'newest' } },
      searchFetch: { transport: 'impersonate', browser: 'chrome142', headers: { 'X-User-Key': 'amiami_dev' } },
    };
    const registry: LookupRegistry = {
      allStores: () => [AMIAMI_LISTING],
      getRulesetForUrl: () => ({ ...RULESET, siteId: 'amiami', extractListing: () => ({ items: [{ itemId: 'FIGURE-1' }] }) }),
    };
    const http = jest.fn(async () => '{}');
    const impersonate = jest.fn(async () => '{}');

    const out = await createEngineCatalog(registry, { http, impersonate }).catalog('amiami');

    expect(impersonate).toHaveBeenCalledWith(
      'https://api.amiami.com/api/v1.0/items?s_st_list_newitem_available=1&pagecnt=1',
      { browser: 'chrome142', headers: { 'X-User-Key': 'amiami_dev' }, userAgent: undefined },
    );
    expect(http).not.toHaveBeenCalled();
    expect(out).toMatchObject({ status: 'ok', count: 1 });
  });
});

describe('httpFetchBody', () => {
  it('GETs the url and returns the raw response body text', async () => {
    const orig = global.fetch;
    global.fetch = jest.fn(async () => ({ text: async () => '{"ok":true}' })) as unknown as typeof fetch;
    try {
      expect(await httpFetchBody('https://x.test/search?q=tomie')).toBe('{"ok":true}');
      expect(global.fetch).toHaveBeenCalledWith('https://x.test/search?q=tomie', expect.objectContaining({ headers: expect.anything() }));
    } finally {
      global.fetch = orig;
    }
  });

  it('bounds the fetch with an abort signal — a tarpitted endpoint must not ride undici\'s ~300s defaults on a synchronous caller', async () => {
    const orig = global.fetch;
    const fetchMock = jest.fn(async (_url: string, _init?: RequestInit) => ({ text: async () => 'ok' }));
    global.fetch = fetchMock as unknown as typeof fetch;
    try {
      await httpFetchBody('https://store.example/api.json');
      const init = fetchMock.mock.calls[0]?.[1];
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.signal?.aborted).toBe(false);
    } finally {
      global.fetch = orig;
    }
  });
});
