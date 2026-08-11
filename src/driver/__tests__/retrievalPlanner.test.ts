/**
 * retrievalPlanner — targeted-retrieval request → fetch plans via each store's retrieval
 * templates. Covers by-id detail plans, single-store search, the cross-store `lookup` fan-out
 * (the buy-decision seam), and the `unsupported` coverage-gap report.
 */
import type { IdentityQuery, RetrievalCapability, StoreCapabilities } from '@figurecollecting/scraper-plugin-contract';
import { ProfileRegistry } from '../profileRegistry';
import { planRetrieval, resolveByIdUrl, resolveSearchUrl, composeStoreQuery, composeNameQuery } from '../retrievalPlanner';

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

describe('composeNameQuery', () => {
  it('prefers the display name; else studio + character|series + scale', () => {
    expect(composeNameQuery({ name: 'Gyaru Tomie x Hello Kitty', studio: 'GSC' })).toBe('Gyaru Tomie x Hello Kitty');
    expect(composeNameQuery({ studio: 'WLOP', character: 'Aria', scale: '1/4' })).toBe('WLOP Aria 1/4');
    expect(composeNameQuery({ studio: 'WLOP', series: 'Wings', scale: '1/4' })).toBe('WLOP Wings 1/4'); // character||series fallback
    expect(composeNameQuery({})).toBeUndefined();
  });
});

describe('composeStoreQuery', () => {
  const JAN = '4570232591424';
  const amiami = caps('amiami', 'amiami.com', { bySearch: { urlTemplate: 'https://api.amiami.com/items?s_keywords={q}', acceptsGtin: true } });
  const shopify = caps('goodsmileus', 'goodsmileus.com', { bySearch: { urlTemplate: 'https://gsus/suggest.json?q={q}' } }); // acceptsGtin absent
  const plaza = caps('plazajapan', 'plazajapan.com', { byId: { urlTemplate: 'https://plazajapan.com/{id}', idKind: 'barcode' } });
  const nogo = caps('nogo', 'nogo.com', undefined);

  it('JAN-exact search where the store bySearch acceptsGtin', () => {
    expect(composeStoreQuery(amiami, { gtin14: JAN, name: 'Tomie' })).toEqual({ kind: 'search', q: JAN });
  });
  it('barcode-byId store resolves the JAN straight to a detail plan', () => {
    expect(composeStoreQuery(plaza, { gtin14: JAN })).toEqual({ kind: 'detail', id: JAN });
  });
  it('title-index store (no acceptsGtin) ignores the JAN and searches by the composed name', () => {
    expect(composeStoreQuery(shopify, { gtin14: JAN, name: 'Gyaru Tomie' })).toEqual({ kind: 'search', q: 'Gyaru Tomie' });
  });
  it('undefined when there is no usable query (no retrieval, or empty identity)', () => {
    expect(composeStoreQuery(nogo, { gtin14: JAN, name: 'x' })).toBeUndefined(); // no retrieval axis
    expect(composeStoreQuery(amiami, {})).toBeUndefined(); // no gtin, no name → nothing to search by
  });
});

describe('planRetrieval record mode', () => {
  const reg = () => {
    const r = new ProfileRegistry();
    r.register(caps('amiami', 'amiami.com', { bySearch: { urlTemplate: 'https://api.amiami.com/items?s_keywords={q}', acceptsGtin: true } }));
    r.register(caps('goodsmileus', 'goodsmileus.com', { bySearch: { urlTemplate: 'https://gsus/suggest.json?q={q}' } }));
    r.register(caps('plazajapan', 'plazajapan.com', { byId: { urlTemplate: 'https://plazajapan.com/{id}', idKind: 'barcode' } }));
    r.register(caps('nogo', 'nogo.com', undefined));
    return r;
  };

  it('composes each store query server-side: JAN-exact / name / barcode-byId / unsupported', () => {
    const identity: IdentityQuery = { gtin14: '4570232591424', name: 'Gyaru Tomie x Hello Kitty' };
    const p = planRetrieval(reg(), { mode: 'record', identity });
    const bySite = Object.fromEntries(p.plans.map((x) => [x.siteId, x]));

    expect(bySite.amiami.kind).toBe('search');
    expect(bySite.amiami.url).toContain('4570232591424'); // JAN-exact
    expect(bySite.goodsmileus.kind).toBe('search');
    expect(bySite.goodsmileus.url).toContain('Gyaru'); // name, not the JAN
    expect(bySite.goodsmileus.url).not.toContain('4570232591424');
    expect(bySite.plazajapan.kind).toBe('detail');
    expect(bySite.plazajapan.itemId).toBe('4570232591424'); // barcode-byId
    expect(p.unsupported).toEqual(['nogo']);
  });
});
