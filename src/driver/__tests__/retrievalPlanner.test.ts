/**
 * retrievalPlanner — targeted-retrieval request → fetch plans via each store's retrieval
 * templates. Covers by-id detail plans, single-store search, the cross-store `lookup` fan-out
 * (the buy-decision seam), and the `unsupported` coverage-gap report.
 */
import type { RetrievalCapability, StoreCapabilities } from '@figurecollecting/scraper-plugin-contract';
import { ProfileRegistry } from '../profileRegistry';
import { planRetrieval, resolveByIdUrl, resolveSearchUrl } from '../retrievalPlanner';

const caps = (siteId: string, host: string, retrieval?: RetrievalCapability): StoreCapabilities => ({
  siteId, name: siteId, domains: [host], requiresBrowser: false, allowedCookies: [],
  rateLimit: {
    domain: host, baseDelayMs: 1000, minDelayMs: 100, maxDelayMs: 60_000,
    backoffMultiplier: 2, recoveryDivisor: 2, successThreshold: 3,
  },
  retrieval,
});

const registry = () => {
  const r = new ProfileRegistry();
  r.register(caps('amiami', 'amiami.com', { byId: { urlTemplate: 'https://amiami.com/detail/?gcode={id}', idKind: 'store-internal' } }));
  r.register(caps('hlj', 'hlj.com', { bySearch: { urlTemplate: 'https://hlj.com/search?q={q}' } }));
  r.register(caps('nogo', 'nogo.com', undefined)); // enumeration-only, no retrieval
  return r;
};

describe('retrieval URL resolvers', () => {
  it('resolveByIdUrl substitutes {id}, url-encoded; undefined when unsupported', () => {
    expect(resolveByIdUrl({ byId: { urlTemplate: 'https://x/d/?g={id}' } }, 'FIG-1 2')).toBe('https://x/d/?g=FIG-1%202');
    expect(resolveByIdUrl({}, 'x')).toBeUndefined();
    expect(resolveByIdUrl(undefined, 'x')).toBeUndefined();
  });

  it('resolveSearchUrl substitutes {q}, url-encoded; undefined when unsupported', () => {
    expect(resolveSearchUrl({ bySearch: { urlTemplate: 'https://x/s?q={q}' } }, 'nendoroid miku')).toBe('https://x/s?q=nendoroid%20miku');
    expect(resolveSearchUrl({}, 'x')).toBeUndefined();
  });
});

describe('planRetrieval', () => {
  it('byId: one detail plan per item id for a supporting store', () => {
    const p = planRetrieval(registry(), { mode: 'byId', host: 'amiami.com', itemIds: ['FIGURE-1', 'FIGURE-2'] });
    expect(p.plans.map((x) => x.url)).toEqual([
      'https://amiami.com/detail/?gcode=FIGURE-1',
      'https://amiami.com/detail/?gcode=FIGURE-2',
    ]);
    expect(p.plans.every((x) => x.kind === 'detail' && x.siteId === 'amiami')).toBe(true);
    expect(p.unsupported).toEqual([]);
  });

  it('byId: a store that cannot be fetched by id comes back unsupported', () => {
    const p = planRetrieval(registry(), { mode: 'byId', host: 'hlj.com', itemIds: ['x'] }); // hlj only has search
    expect(p.plans).toEqual([]);
    expect(p.unsupported).toEqual(['hlj']);
  });

  it('search: one search plan for a supporting store', () => {
    const p = planRetrieval(registry(), { mode: 'search', host: 'hlj.com', query: 'miku' });
    expect(p.plans).toEqual([{ host: 'hlj.com', siteId: 'hlj', url: 'https://hlj.com/search?q=miku', kind: 'search' }]);
    expect(p.unsupported).toEqual([]);
  });

  it('lookup: fans a JAN/name out to every search-capable store and reports the rest as gaps', () => {
    const p = planRetrieval(registry(), { mode: 'lookup', query: '4571245296726' });
    expect(p.plans.map((x) => x.host)).toEqual(['hlj.com']); // only hlj supports search
    expect(p.plans[0].url).toContain('4571245296726');
    expect(p.unsupported.sort()).toEqual(['amiami', 'nogo']); // no bySearch → coverage gap
  });
});
