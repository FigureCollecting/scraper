/**
 * createEngineLookup — the entrypoint factory: builds a cross-store Lookup from the engine's
 * registry (allStores → ProfileRegistry) + a fetch, and fans a query to parse candidates.
 */
import { createEngineLookup, httpFetchBody, type LookupRegistry } from '../../services/engineLookup';
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
