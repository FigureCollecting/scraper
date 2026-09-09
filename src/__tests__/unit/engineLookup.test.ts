/**
 * createEngineLookup — the entrypoint factory: builds a cross-store Lookup from the engine's
 * registry (allStores → ProfileRegistry) + a fetch, and fans a query to parse candidates.
 */
import { join } from 'path';
import { createEngineLookup, createEngineCatalog, httpFetchBody, httpFetchBodyDetailed, createHttpFetch, createHttpFetchDetailed, resolveHttpFetchTimeoutMs, HTTP_FETCH_TIMEOUT_MS, type LookupRegistry } from '../../services/engineLookup';
import { getCfCookieStore, resetCfCookieStore } from '../../services/cookieJar';
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

/**
 * Stored-cookie injection on the plain-http lane (CfCookieStore): a host the store has cookies for
 * gets a `cookie` header + the pinned mint User-Agent; an unknown host's request is BYTE-IDENTICAL to
 * the cookieless path. Values are obviously-fake placeholders.
 */
describe('httpFetchBody × stored cookies + pinned UA (CfCookieStore)', () => {
  const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';
  const fakeStore = (hosts: Record<string, { cookies?: Record<string, string>; userAgent?: string }>) => {
    const key = (url: string) => new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return {
      cookiesFor: (url: string) => (hosts[key(url)]?.cookies ? { ...hosts[key(url)].cookies } : undefined),
      userAgentFor: (url: string) => hosts[key(url)]?.userAgent,
    };
  };
  let fetchMock: jest.Mock;
  const orig = global.fetch;
  beforeEach(() => {
    fetchMock = jest.fn(async (_url: string, _init?: RequestInit) => ({ text: async () => 'body' }));
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => { global.fetch = orig; });

  it('cohort host: sends a `cookie` header (name=value; name2=value2) and the pinned UA, keeping the accept header and the abort signal', async () => {
    const store = fakeStore({ 'sugotoys.com.au': { cookies: { cf_clearance: 'FAKE_cf_1', wp_sess: 'FAKE_sess_1' }, userAgent: 'Mozilla/5.0 FAKE-MINT-UA' } });
    const fetchBody = createHttpFetch({ store });

    expect(await fetchBody('https://www.sugotoys.com.au/wp-json/wc/store/v1/products?search=lucy')).toBe('body');

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.headers).toEqual({
      'user-agent': 'Mozilla/5.0 FAKE-MINT-UA',
      accept: 'application/json, text/html',
      cookie: 'cf_clearance=FAKE_cf_1; wp_sess=FAKE_sess_1',
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('unknown host: headers byte-identical to the cookieless path (no cookie key, default desktop UA)', async () => {
    const store = fakeStore({ 'sugotoys.com.au': { cookies: { cf_clearance: 'FAKE_cf_1' }, userAgent: 'Mozilla/5.0 FAKE-MINT-UA' } });
    const fetchBody = createHttpFetch({ store });

    await fetchBody('https://www.goodsmileus.com/search/suggest.json?q=tomie');

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.headers).toEqual({ 'user-agent': DESKTOP_UA, accept: 'application/json, text/html' });
    expect(init.headers).not.toHaveProperty('cookie');
  });

  it('a UA pin without cookies pins only the UA; cookies without a pin keep the default UA', async () => {
    const store = fakeStore({ 'pinonly.test': { userAgent: 'Mozilla/5.0 FAKE-PIN' }, 'cookieonly.test': { cookies: { a: 'FAKE_a' } } });
    const fetchBody = createHttpFetch({ store });
    await fetchBody('https://pinonly.test/x');
    await fetchBody('https://cookieonly.test/x');
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toEqual({ 'user-agent': 'Mozilla/5.0 FAKE-PIN', accept: 'application/json, text/html' });
    expect((fetchMock.mock.calls[1][1] as RequestInit).headers).toEqual({ 'user-agent': DESKTOP_UA, accept: 'application/json, text/html', cookie: 'a=FAKE_a' });
  });

  it('the default export consults the CfCookieStore singleton (CF_COOKIE_FILE fixture, FAKE values)', async () => {
    const ORIGINAL = process.env.CF_COOKIE_FILE;
    process.env.CF_COOKIE_FILE = join(__dirname, '../fixtures/cfCookies/cf-cookies.json');
    resetCfCookieStore();
    try {
      expect(getCfCookieStore().view()).toHaveLength(2);
      await httpFetchBody('https://www.myfigurecollection.net/item/1');
      const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
      expect(headers.cookie).toBe('cf_clearance=FAKE_cf_fixture_1; PHPSESSID=FAKE_sess_fixture_1');
      expect(headers['user-agent']).toBe('Mozilla/5.0 FAKE-FIXTURE-MINT-UA');
    } finally {
      resetCfCookieStore();
      if (ORIGINAL === undefined) delete process.env.CF_COOKIE_FILE; else process.env.CF_COOKIE_FILE = ORIGINAL;
    }
  });
});

/**
 * HTTP_FETCH_TIMEOUT_MS: the plain-http lane's abort ceiling is env-configurable (the orzgk 100-item
 * listing takes ~15 s, so ops set 30000). Default 15000, clamped to [5000, 120000]; resolved ONCE at
 * module load and threaded into AbortSignal.timeout.
 */
describe('resolveHttpFetchTimeoutMs — pure env → ms resolver (HTTP_FETCH_TIMEOUT_MS)', () => {
  const env = (v?: string): NodeJS.ProcessEnv => ({ HTTP_FETCH_TIMEOUT_MS: v } as NodeJS.ProcessEnv);

  it('defaults to 15000 when unset / blank / non-numeric / non-positive', () => {
    expect(resolveHttpFetchTimeoutMs(env())).toBe(15000);
    expect(resolveHttpFetchTimeoutMs(env(''))).toBe(15000);
    expect(resolveHttpFetchTimeoutMs(env('abc'))).toBe(15000);
    expect(resolveHttpFetchTimeoutMs(env('0'))).toBe(15000);
    expect(resolveHttpFetchTimeoutMs(env('-5'))).toBe(15000);
  });
  it('honors a valid override', () => {
    expect(resolveHttpFetchTimeoutMs(env('30000'))).toBe(30000);
  });
  it('clamps a too-small value up to 5000 and a too-large value down to 120000', () => {
    expect(resolveHttpFetchTimeoutMs(env('10'))).toBe(5000);
    expect(resolveHttpFetchTimeoutMs(env('999999'))).toBe(120000);
  });
  it('HTTP_FETCH_TIMEOUT_MS is the module-load resolution of process.env (15000 with no override)', () => {
    expect(HTTP_FETCH_TIMEOUT_MS).toBe(resolveHttpFetchTimeoutMs(process.env));
    expect(HTTP_FETCH_TIMEOUT_MS).toBe(15000);
  });
  it('threads an HTTP_FETCH_TIMEOUT_MS override through an isolated module load into AbortSignal.timeout', async () => {
    const ORIGINAL = process.env.HTTP_FETCH_TIMEOUT_MS;
    const orig = global.fetch;
    const spy = jest.spyOn(AbortSignal, 'timeout');
    process.env.HTTP_FETCH_TIMEOUT_MS = '30000';
    global.fetch = jest.fn(async () => ({ text: async () => 'ok' })) as unknown as typeof fetch;
    try {
      let mod!: { httpFetchBody: typeof httpFetchBody };
      jest.isolateModules(() => { mod = require('../../services/engineLookup'); });
      await mod.httpFetchBody('https://www.orzgk.com/wp-json/wc/store/v1/products?per_page=100');
      expect(spy).toHaveBeenCalledWith(30000);
    } finally {
      spy.mockRestore();
      global.fetch = orig;
      if (ORIGINAL === undefined) delete process.env.HTTP_FETCH_TIMEOUT_MS; else process.env.HTTP_FETCH_TIMEOUT_MS = ORIGINAL;
    }
  });
});

/**
 * The STATUS-AWARE plain-HTTP lane (R1). The ingest path needs the response's status and
 * post-redirect URL, which `res.text()` alone threw away. The detail variant reads both off the
 * very same fetch; the string variant is that variant's body, so both lanes stay byte-identical on
 * the wire and every existing caller of `httpFetchBody` keeps its `Promise<string>` signature.
 */
describe('createHttpFetchDetailed — status + final URL off the same request', () => {
  const orig = global.fetch;
  afterEach(() => { global.fetch = orig; });

  it('returns the body with the status and the post-redirect URL', async () => {
    global.fetch = jest.fn(async () => ({
      text: async () => 'BODY',
      status: 404,
      url: 'https://x.test/item/1',
    })) as unknown as typeof fetch;

    await expect(createHttpFetchDetailed()('https://x.test/item/1')).resolves.toEqual({
      body: 'BODY',
      status: 404,
      finalUrl: 'https://x.test/item/1',
    });
  });

  it('carries the FINAL url of a followed redirect, not the requested one', async () => {
    global.fetch = jest.fn(async () => ({
      text: async () => 'HOME',
      status: 200,
      url: 'https://x.test/',
    })) as unknown as typeof fetch;

    const detail = await httpFetchBodyDetailed('https://x.test/item/1');
    expect(detail.finalUrl).toBe('https://x.test/');
    expect(detail.body).toBe('HOME');
  });

  it('omits what a response did not carry rather than inventing it', async () => {
    global.fetch = jest.fn(async () => ({ text: async () => 'BODY' })) as unknown as typeof fetch;

    const detail = await createHttpFetchDetailed()('https://x.test/item/1');
    expect(detail.body).toBe('BODY');
    expect(detail.status).toBeUndefined();
    expect(detail.finalUrl).toBeUndefined();
  });

  it('sends the SAME request the string lane sends (headers unchanged)', async () => {
    const fetchMock = jest.fn(async (_url: string, _init?: RequestInit) => ({ text: async () => 'ok', status: 200, url: 'https://x.test/s' }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await httpFetchBody('https://x.test/s');
    await httpFetchBodyDetailed('https://x.test/s');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toEqual((fetchMock.mock.calls[1][1] as RequestInit).headers);
  });

  it('still resolves the plain body on the string lane (unchanged signature)', async () => {
    global.fetch = jest.fn(async () => ({ text: async () => 'PLAIN', status: 500, url: 'https://x.test/s' })) as unknown as typeof fetch;
    await expect(httpFetchBody('https://x.test/s')).resolves.toBe('PLAIN');
  });
});
