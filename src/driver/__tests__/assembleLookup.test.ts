/**
 * assembleLookup — the cross-store SEARCH (buy-decision) fan-out, in both modes. `listed` returns
 * every carried item (incl. sold-out) with a coverage caveat for orderable-scope stores;
 * `orderable` filters to in-stock. Fakes model the two shapes: a listed store with a sold-out hit,
 * and an orderable-scope store (predictive endpoint that hides sold-out — the solaris case).
 */
import { assembleLookup, type LookupServices } from '../assembleLookup';
import { buildProfileRegistry } from '../profileRegistry';
import type {
  ExtractionRuleset,
  SearchCandidate,
  StoreCapabilities,
} from '@figurecollecting/scraper-plugin-contract';

const caps = (siteId: string, host: string, retrieval: StoreCapabilities['retrieval']): StoreCapabilities => ({
  siteId,
  name: siteId,
  domains: [host],
  rateLimit: { domain: host, baseDelayMs: 0, minDelayMs: 0, maxDelayMs: 100, backoffMultiplier: 2, recoveryDivisor: 2, successThreshold: 3 },
  requiresBrowser: false,
  allowedCookies: [],
  retrieval,
});

// goodsmileus: LISTED full-search — carries an in-stock item AND a sold-out one.
const GOODSMILEUS = caps('goodsmileus', 'www.goodsmileus.com', {
  bySearch: { urlTemplate: 'https://www.goodsmileus.com/search?q={q}&type=product', scope: 'listed' },
});
// solaris: ORDERABLE-scope predictive endpoint — hides sold-out (returns only in-stock).
const SOLARIS = caps('solaris', 'solarisjapan.com', {
  bySearch: { urlTemplate: 'https://solarisjapan.com/search/suggest.json?q={q}&resources[type]=product', scope: 'orderable' },
});
// cdjapan: byId only, no search.
const CDJAPAN = caps('cdjapan', 'www.cdjapan.co.jp', {
  byId: { urlTemplate: 'https://www.cdjapan.co.jp/product/{id}', idKind: 'store-internal' },
});

const GSUS_CANDIDATES: SearchCandidate[] = [
  { itemId: 'junji-ito-nendoroid-tomie', name: 'Junji Ito Maniac Nendoroid Tomie', url: '/products/nendo', priceRaw: '47.99', available: true },
  { itemId: 'gs-collection-gyaru-tomie-x-hello-kitty', name: 'GS Collection Gyaru Tomie x Hello Kitty Figure', url: '/products/gyaru', priceRaw: '149.99', available: false },
];
const SOLARIS_CANDIDATES: SearchCandidate[] = [
  { itemId: 'kawakami-tomie-nendoroid', name: 'Itou Junji: Maniac - Kawakami Tomie - Nendoroid', available: true },
];

const stub = (siteId: string, extractCandidates?: ExtractionRuleset['extractCandidates']): ExtractionRuleset => ({
  siteId,
  version: '1.0.0',
  extract: () => ({ source: { site: siteId, itemId: 'x', extractedAt: '2026-08-09T00:00:00.000Z' }, fields: {}, warnings: [] }),
  validate: () => ({ valid: true, errors: [], warnings: [] }),
  ...(extractCandidates ? { extractCandidates } : {}),
});

const build = (over: Partial<LookupServices> = {}) => {
  const fetchBody = jest.fn(async () => '{}');
  const services: LookupServices = {
    profiles: buildProfileRegistry([GOODSMILEUS, SOLARIS, CDJAPAN]),
    getRulesetForUrl: (url) =>
      url.includes('goodsmileus') ? stub('goodsmileus', () => GSUS_CANDIDATES)
      : url.includes('solaris') ? stub('solaris', () => SOLARIS_CANDIDATES)
      : undefined,
    fetchBody,
    ...over,
  };
  return { services, fetchBody, lookup: assembleLookup(services) };
};

const bySite = (r: Awaited<ReturnType<ReturnType<typeof build>['lookup']['lookup']>>, id: string) =>
  r.results.find((x) => x.siteId === id);

describe('assembleLookup — cross-store buy-decision search, listed + orderable modes', () => {
  it('listed mode (default): returns sold-out items too, and flags orderable-scope stores', async () => {
    const { lookup } = build();

    const out = await lookup.lookup('tomie');

    expect(out.mode).toBe('listed');
    // goodsmileus (listed) returns BOTH — including the sold-out Gyaru Tomie x Hello Kitty.
    expect(bySite(out, 'goodsmileus')?.candidates.map((c) => c.available)).toEqual([true, false]);
    // solaris returned results but is orderable-scope → can't confirm its sold-out items.
    expect(out.orderableOnly).toEqual(['solaris']);
    expect(bySite(out, 'solaris')?.candidates).toHaveLength(1);
    expect(out.unsupported).toContain('cdjapan');
  });

  it('orderable mode: filters out sold-out; no orderableOnly caveat', async () => {
    const { lookup } = build();

    const out = await lookup.lookup('tomie', { mode: 'orderable' });

    expect(out.mode).toBe('orderable');
    // the sold-out Gyaru Tomie x Hello Kitty is dropped — only the in-stock Nendoroid remains.
    const gs = bySite(out, 'goodsmileus');
    expect(gs?.candidates.map((c) => c.itemId)).toEqual(['junji-ito-nendoroid-tomie']);
    expect(gs?.candidates.every((c) => c.available !== false)).toBe(true);
    expect(out.orderableOnly).toEqual([]);
  });

  it('a bySearch store whose ruleset lacks extractCandidates is unsupported (not fetched)', async () => {
    const { fetchBody, lookup } = build({
      getRulesetForUrl: (url) => (url.includes('solaris') ? stub('solaris', () => SOLARIS_CANDIDATES) : stub('goodsmileus')),
    });

    const out = await lookup.lookup('miku');

    expect(out.unsupported).toContain('goodsmileus');
    expect(fetchBody).not.toHaveBeenCalledWith(expect.stringContaining('goodsmileus'));
    expect(out.results.map((r) => r.siteId)).toEqual(['solaris']);
  });

  it('a store whose search fetch throws is reported failed, not silently dropped', async () => {
    const { lookup } = build({
      fetchBody: jest.fn(async (url: string) => {
        if (url.includes('goodsmileus')) throw new Error('CF block');
        return '{}';
      }),
    });

    const out = await lookup.lookup('tomie');

    expect(out.failed).toContain('goodsmileus');
    expect(out.results.map((r) => r.siteId)).toEqual(['solaris']);
  });

  it('routes requiresBrowser stores through browserFetchBody and plain-fetch stores through fetchBody', async () => {
    // amiami: CF-fronted, requiresBrowser:true → must go through the browser path, not plain HTTP.
    const AMIAMI: StoreCapabilities = {
      ...caps('amiami', 'www.amiami.com', {
        bySearch: { urlTemplate: 'https://api.amiami.com/api/v1.0/items?s_keywords={q}', scope: 'listed' },
      }),
      requiresBrowser: true,
    };
    const fetchBody = jest.fn(async () => '{}');
    const browserFetchBody = jest.fn(async () => '[]');
    const services: LookupServices = {
      profiles: buildProfileRegistry([GOODSMILEUS, AMIAMI]),
      getRulesetForUrl: (url) =>
        url.includes('goodsmileus') ? stub('goodsmileus', () => GSUS_CANDIDATES)
        : url.includes('amiami') ? stub('amiami', () => [{ itemId: 'a1', name: 'Tomie', available: true }])
        : undefined,
      fetchBody,
      browserFetchBody,
    };

    await assembleLookup(services).lookup('tomie');

    // amiami (requiresBrowser) → browserFetchBody; goodsmileus (fetch) → fetchBody. No crossover.
    expect(browserFetchBody).toHaveBeenCalledWith('https://api.amiami.com/api/v1.0/items?s_keywords=tomie');
    expect(browserFetchBody).not.toHaveBeenCalledWith(expect.stringContaining('goodsmileus'));
    expect(fetchBody).toHaveBeenCalledWith(expect.stringContaining('goodsmileus'));
    expect(fetchBody).not.toHaveBeenCalledWith(expect.stringContaining('amiami'));
  });

  it('a requiresBrowser store falls back to fetchBody when no browserFetchBody is injected', async () => {
    const AMIAMI: StoreCapabilities = {
      ...caps('amiami', 'www.amiami.com', {
        bySearch: { urlTemplate: 'https://api.amiami.com/api/v1.0/items?s_keywords={q}', scope: 'listed' },
      }),
      requiresBrowser: true,
    };
    const fetchBody = jest.fn(async () => '[]');
    const services: LookupServices = {
      profiles: buildProfileRegistry([AMIAMI]),
      getRulesetForUrl: () => stub('amiami', () => [{ itemId: 'a1', name: 'Tomie', available: true }]),
      fetchBody, // no browserFetchBody
    };

    const out = await assembleLookup(services).lookup('tomie');

    expect(fetchBody).toHaveBeenCalledWith('https://api.amiami.com/api/v1.0/items?s_keywords=tomie');
    expect(out.results[0]?.siteId).toBe('amiami');
  });

  it('a bySearch store with no explicit scope defaults to listed (not flagged orderableOnly)', async () => {
    const NOSCOPE = caps('woo', 'woo.test', { bySearch: { urlTemplate: 'https://woo.test/api?search={q}' } });
    const services: LookupServices = {
      profiles: buildProfileRegistry([NOSCOPE]),
      getRulesetForUrl: () => stub('woo', () => [{ itemId: 'w1', name: 'Tomie', available: true }]),
      fetchBody: jest.fn(async () => '{}'),
    };

    const out = await assembleLookup(services).lookup('tomie'); // listed (default)

    expect(out.orderableOnly).toEqual([]);
    expect(out.results[0]?.siteId).toBe('woo');
  });
});
