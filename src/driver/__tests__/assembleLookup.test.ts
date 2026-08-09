/**
 * assembleLookup — the cross-store SEARCH (buy-decision) fan-out. Drives it with fakes shaped like
 * the live-verified Tier-1 responses (Shopify predictive suggest.json + Woo Store API array) and
 * asserts it fans across the bySearch stores, parses candidates via each ruleset's
 * extractCandidates, and reports honest coverage gaps (no-search / no-parser / errored).
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

const GOODSMILEUS = caps('goodsmileus', 'www.goodsmileus.com', {
  bySearch: { urlTemplate: 'https://www.goodsmileus.com/search/suggest.json?q={q}&resources[type]=product' },
});
const SUGOTOYS = caps('sugotoys', 'sugotoys.com.au', {
  bySearch: { urlTemplate: 'https://sugotoys.com.au/wp-json/wc/store/v1/products?search={q}&per_page=20' },
});
const CDJAPAN = caps('cdjapan', 'www.cdjapan.co.jp', {
  byId: { urlTemplate: 'https://www.cdjapan.co.jp/product/{id}', idKind: 'store-internal' },
});

const stub = (siteId: string, extractCandidates?: ExtractionRuleset['extractCandidates']): ExtractionRuleset => ({
  siteId,
  version: '1.0.0',
  extract: () => ({ source: { site: siteId, itemId: 'x', extractedAt: '2026-08-09T00:00:00.000Z' }, fields: {}, warnings: [] }),
  validate: () => ({ valid: true, errors: [], warnings: [] }),
  ...(extractCandidates ? { extractCandidates } : {}),
});

// Shopify predictive suggest.json shape → candidates.
const shopifyParse: ExtractionRuleset['extractCandidates'] = (body): SearchCandidate[] =>
  (JSON.parse(body).resources.results.products as Array<{ handle: string; title: string; url: string; price: string }>)
    .map((p) => ({ itemId: p.handle, name: p.title, url: p.url, priceRaw: p.price }));

// Woo Store API product array → candidates.
const wooParse: ExtractionRuleset['extractCandidates'] = (body): SearchCandidate[] =>
  (JSON.parse(body) as Array<{ id: number; name: string; permalink: string }>)
    .map((p) => ({ itemId: String(p.id), name: p.name, url: p.permalink }));

const build = (over: Partial<LookupServices> = {}) => {
  const fetchBody = jest.fn(async (url: string): Promise<string> => {
    if (url.includes('goodsmileus')) {
      return JSON.stringify({ resources: { results: { products: [
        { handle: 'gs-collection-gyaru-tomie-x-hello-kitty', title: 'GS Collection Gyaru Tomie x Hello Kitty', url: '/products/gs-collection-gyaru-tomie-x-hello-kitty', price: '5800' },
      ] } } });
    }
    if (url.includes('sugotoys')) {
      return JSON.stringify([{ id: 1118911, name: 'Tomie Figure', permalink: 'https://sugotoys.com.au/product/tomie' }]);
    }
    return '[]';
  });
  const services: LookupServices = {
    profiles: buildProfileRegistry([GOODSMILEUS, SUGOTOYS, CDJAPAN]),
    getRulesetForUrl: (url) =>
      url.includes('goodsmileus') ? stub('goodsmileus', shopifyParse)
      : url.includes('sugotoys') ? stub('sugotoys', wooParse)
      : undefined,
    fetchBody,
    ...over,
  };
  return { services, fetchBody, lookup: assembleLookup(services) };
};

describe('assembleLookup — cross-store buy-decision search', () => {
  it('fans across bySearch stores, parses candidates, and lists no-search stores as unsupported', async () => {
    const { services, fetchBody, lookup } = build();

    const out = await lookup.lookup('tomie');

    // Fanned to both bySearch stores (query url-encoded into {q}); cdjapan (byId only) not fetched.
    expect(fetchBody).toHaveBeenCalledWith('https://www.goodsmileus.com/search/suggest.json?q=tomie&resources[type]=product');
    expect(fetchBody).toHaveBeenCalledWith('https://sugotoys.com.au/wp-json/wc/store/v1/products?search=tomie&per_page=20');

    const gs = out.results.find((r) => r.siteId === 'goodsmileus');
    expect(gs?.candidates[0]).toEqual({
      itemId: 'gs-collection-gyaru-tomie-x-hello-kitty',
      name: 'GS Collection Gyaru Tomie x Hello Kitty',
      url: '/products/gs-collection-gyaru-tomie-x-hello-kitty',
      priceRaw: '5800',
    });
    expect(out.results.find((r) => r.siteId === 'sugotoys')?.candidates[0].name).toBe('Tomie Figure');
    expect(out.unsupported).toContain('cdjapan');
    expect(out.failed).toEqual([]);
  });

  it('a bySearch store whose ruleset lacks extractCandidates is unsupported (not fetched)', async () => {
    const { fetchBody, lookup } = build({
      getRulesetForUrl: (url) => (url.includes('sugotoys') ? stub('sugotoys', wooParse) : stub('goodsmileus')), // no shopify parser
    });

    const out = await lookup.lookup('miku');

    expect(out.unsupported).toContain('goodsmileus');
    expect(fetchBody).not.toHaveBeenCalledWith(expect.stringContaining('goodsmileus'));
    expect(out.results.map((r) => r.siteId)).toEqual(['sugotoys']);
  });

  it('a store whose search fetch throws is reported failed, not silently dropped', async () => {
    const { lookup } = build({
      fetchBody: jest.fn(async (url: string) => {
        if (url.includes('goodsmileus')) throw new Error('CF block');
        return JSON.stringify([{ id: 1, name: 'Tomie', permalink: 'u' }]);
      }),
    });

    const out = await lookup.lookup('tomie');

    expect(out.failed).toContain('goodsmileus');
    expect(out.results.map((r) => r.siteId)).toEqual(['sugotoys']);
  });
});
