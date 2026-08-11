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
  const fetchSearch = jest.fn(async () => '{}');
  const services: LookupServices = {
    profiles: buildProfileRegistry([GOODSMILEUS, SOLARIS, CDJAPAN]),
    getRulesetForUrl: (url) =>
      url.includes('goodsmileus') ? stub('goodsmileus', () => GSUS_CANDIDATES)
      : url.includes('solaris') ? stub('solaris', () => SOLARIS_CANDIDATES)
      : undefined,
    fetchSearch,
    ...over,
  };
  return { services, fetchSearch, lookup: assembleLookup(services) };
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
    const { fetchSearch, lookup } = build({
      getRulesetForUrl: (url) => (url.includes('solaris') ? stub('solaris', () => SOLARIS_CANDIDATES) : stub('goodsmileus')),
    });

    const out = await lookup.lookup('miku');

    expect(out.unsupported).toContain('goodsmileus');
    expect(fetchSearch).not.toHaveBeenCalledWith(expect.stringContaining('goodsmileus'), expect.anything());
    expect(out.results.map((r) => r.siteId)).toEqual(['solaris']);
  });

  it('a store whose search fetch throws is reported failed AND the reason is logged (not silently dropped)', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { lookup } = build({
      fetchSearch: jest.fn(async (url: string) => {
        if (url.includes('goodsmileus')) throw new Error('CF block');
        return '{}';
      }),
    });

    const out = await lookup.lookup('tomie');

    expect(out.failed).toContain('goodsmileus');
    expect(out.results.map((r) => r.siteId)).toEqual(['solaris']);
    // the reason is surfaced, not swallowed — distinguishes CF-block from parse-error etc.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('goodsmileus'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('CF block'));
    warn.mockRestore();
  });

  it('passes each store its RESOLVED search transport to fetchSearch (explicit searchFetch vs http default)', async () => {
    // amiami declares an explicit impersonate transport with X-User-Key; goodsmileus has none → http.
    const AMIAMI: StoreCapabilities = {
      ...caps('amiami', 'www.amiami.com', {
        bySearch: { urlTemplate: 'https://api.amiami.com/api/v1.0/items?s_keywords={q}', scope: 'listed' },
      }),
      searchFetch: { transport: 'impersonate', browser: 'chrome142', headers: { 'X-User-Key': 'amiami_dev' } },
    };
    const fetchSearch = jest.fn(async () => '[]');
    const services: LookupServices = {
      profiles: buildProfileRegistry([GOODSMILEUS, AMIAMI]),
      getRulesetForUrl: (url) =>
        url.includes('goodsmileus') ? stub('goodsmileus', () => GSUS_CANDIDATES)
        : url.includes('amiami') ? stub('amiami', () => [{ itemId: 'a1', name: 'Tomie', available: true }])
        : undefined,
      fetchSearch,
    };

    await assembleLookup(services).lookup('tomie');

    // amiami → its explicit impersonate transport (URL {q}-filled); goodsmileus → the http default.
    expect(fetchSearch).toHaveBeenCalledWith(
      'https://api.amiami.com/api/v1.0/items?s_keywords=tomie',
      { transport: 'impersonate', browser: 'chrome142', headers: { 'X-User-Key': 'amiami_dev' } },
    );
    expect(fetchSearch).toHaveBeenCalledWith(expect.stringContaining('goodsmileus'), { transport: 'http' });
  });

  it('a bySearch store with no explicit scope defaults to listed (not flagged orderableOnly)', async () => {
    const NOSCOPE = caps('woo', 'woo.test', { bySearch: { urlTemplate: 'https://woo.test/api?search={q}' } });
    const services: LookupServices = {
      profiles: buildProfileRegistry([NOSCOPE]),
      getRulesetForUrl: () => stub('woo', () => [{ itemId: 'w1', name: 'Tomie', available: true }]),
      fetchSearch: jest.fn(async () => '{}'),
    };

    const out = await assembleLookup(services).lookup('tomie'); // listed (default)

    expect(out.orderableOnly).toEqual([]);
    expect(out.results[0]?.siteId).toBe('woo');
  });
});

describe('lookupByIdentity — record mode (typed identity → per-store query)', () => {
  const JAN = '4570232591424';
  // amiami full-texts the JAN (acceptsGtin); plazajapan resolves the JAN straight to a detail page.
  const AMIAMI = caps('amiami', 'api.amiami.com', { bySearch: { urlTemplate: 'https://api.amiami.com/items?s_keywords={q}', acceptsGtin: true } });
  const PLAZA = caps('plazajapan', 'plazajapan.com', { byId: { urlTemplate: 'https://plazajapan.com/{id}', idKind: 'barcode' } });

  it('routes JAN-exact / name / barcode-byId per store from one IdentityQuery', async () => {
    const fetchSearch = jest.fn(async () => '[]');
    const services: LookupServices = {
      profiles: buildProfileRegistry([AMIAMI, GOODSMILEUS, PLAZA]),
      getRulesetForUrl: (url) =>
        url.includes('amiami') ? stub('amiami', () => [{ itemId: 'a1', name: 'Tomie', available: true }])
        : url.includes('goodsmileus') ? stub('goodsmileus', () => GSUS_CANDIDATES)
        : undefined,
      fetchSearch,
    };

    const out = await assembleLookup(services).lookupByIdentity({ gtin14: JAN, name: 'Gyaru Tomie x Hello Kitty' });

    // amiami: JAN-exact search (the JAN is in the fetched URL).
    expect(fetchSearch).toHaveBeenCalledWith(expect.stringContaining(JAN), expect.anything());
    // goodsmileus (title-index, no acceptsGtin): name search — the NAME is in the URL, not the JAN.
    expect(fetchSearch).toHaveBeenCalledWith(expect.stringContaining('Gyaru'), expect.anything());
    expect(fetchSearch).not.toHaveBeenCalledWith(expect.stringContaining('goodsmileus.com/search?q=' + JAN), expect.anything());
    // plazajapan: barcode-byId → a RESOLVE TARGET (segregated), NOT a phantom candidate in results.
    expect(out.results.find((r) => r.siteId === 'plazajapan')).toBeUndefined();
    expect(out.resolveTargets).toContainEqual({ siteId: 'plazajapan', host: 'plazajapan.com', itemId: JAN, url: `https://plazajapan.com/${JAN}` });
    expect(out.query).toBe(JAN); // the result's query label is the JAN
  });

  it('a name-only identity searches by name and skips JAN-only stores gracefully', async () => {
    const fetchSearch = jest.fn(async () => JSON.stringify(GSUS_CANDIDATES));
    const services: LookupServices = {
      profiles: buildProfileRegistry([GOODSMILEUS, PLAZA]), // PLAZA is barcode-byId only → no name path
      getRulesetForUrl: () => stub('goodsmileus', () => GSUS_CANDIDATES),
      fetchSearch,
    };

    const out = await assembleLookup(services).lookupByIdentity({ name: 'Tomie' });

    expect(out.results.map((r) => r.siteId)).toContain('goodsmileus');
    expect(out.unsupported).toContain('plazajapan'); // no name search + no gtin14 for its byId
    expect(out.query).toBe('Tomie');
  });
});
