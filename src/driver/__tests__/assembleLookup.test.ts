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
  IdentityQuery,
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
    // discovery: the free-text query is the exact {q} issued, surfaced on each store result.
    expect(bySite(out, 'goodsmileus')?.storeQuery).toBe('tomie');
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

describe('lookupByIdentity — substring-match store post-filter + observability', () => {
  // gkloot: Ueeshop storefront, matches {q} as ONE contiguous substring → the engine issues the most
  // selective identity term and post-filters by the rest.
  const SUBSTORE = caps('gkloot', 'www.gkloot.com', {
    bySearch: { urlTemplate: 'https://www.gkloot.com/search/?Keyword={q}', scope: 'listed', queryMatch: 'substring' },
  });
  // fnc: a token/keyword store (queryMatch absent = tokens) → composed phrase, no post-filter.
  const TOKSTORE = caps('fnc', 'www.fnc.com', {
    bySearch: { urlTemplate: 'https://www.fnc.com/search?q={q}', scope: 'listed' },
  });
  // A Keyword=Lucy SERP mixes the target studio with decoys whose names also contain "Lucy".
  const MIXED: SearchCandidate[] = [
    { itemId: '17412', name: '[Pre-Order] Star Origin Studio 1/6 Cyberpunk: Edgerunners Lucyna Kushinada Statue', available: true },
    { itemId: '9001', name: 'Crown Studio Lucy 1/4 Statue', available: true },
    { itemId: '9002', name: "GIRL'S HOUSE GK Studio Lucy Figure", available: false },
    { itemId: '9003', name: 'Star Origin Studio Lucy Chibi Ver.', available: true },
    { itemId: '9004', name: 'Star Origin Studio Lucy Deluxe', available: false },
  ];
  const IDENTITY = { studio: 'Star Origin Studio', character: 'Lucy' };

  it('substring store: issues the selective term, keeps only names containing every filter token, reports storeQuery + filtered', async () => {
    const fetchSearch = jest.fn(async () => JSON.stringify(MIXED));
    const services: LookupServices = {
      profiles: buildProfileRegistry([SUBSTORE]),
      getRulesetForUrl: () => stub('gkloot', () => MIXED),
      fetchSearch,
    };

    const out = await assembleLookup(services).lookupByIdentity(IDENTITY);

    // gkloot was issued the single most selective term (not the multi-term phrase Ueeshop can't match).
    expect(fetchSearch).toHaveBeenCalledWith('https://www.gkloot.com/search/?Keyword=Lucy', expect.anything());
    const gk = out.results.find((r) => r.siteId === 'gkloot')!;
    expect(gk.storeQuery).toBe('Lucy');
    // only the Star Origin candidates survive; Crown + GIRL'S HOUSE are dropped.
    expect(gk.candidates.map((c) => c.itemId)).toEqual(['17412', '9003', '9004']);
    expect(gk.filtered).toBe(2);
  });

  it('tokens store in the SAME fanout is untouched: composed phrase issued, candidates unfiltered, no `filtered`', async () => {
    const fetchSearch = jest.fn(async () => JSON.stringify(MIXED));
    const services: LookupServices = {
      profiles: buildProfileRegistry([SUBSTORE, TOKSTORE]),
      getRulesetForUrl: (url) => (url.includes('gkloot') ? stub('gkloot', () => MIXED) : stub('fnc', () => MIXED)),
      fetchSearch,
    };

    const out = await assembleLookup(services).lookupByIdentity(IDENTITY);

    const fnc = out.results.find((r) => r.siteId === 'fnc')!;
    expect(fnc.storeQuery).toBe('Star Origin Studio Lucy'); // composed phrase, unchanged from today
    expect(fnc.candidates.map((c) => c.itemId)).toEqual(['17412', '9001', '9002', '9003', '9004']); // untouched
    expect(fnc.filtered).toBeUndefined(); // no filter → no `filtered` field
    // and the substring store is still filtered in the same run
    const gk = out.results.find((r) => r.siteId === 'gkloot')!;
    expect(gk.candidates.map((c) => c.itemId)).toEqual(['17412', '9003', '9004']);
    expect(fetchSearch).toHaveBeenCalledWith('https://www.fnc.com/search?q=Star%20Origin%20Studio%20Lucy', expect.anything());
    expect(fetchSearch).toHaveBeenCalledWith('https://www.gkloot.com/search/?Keyword=Lucy', expect.anything());
  });

  it('orderable mode composes with the filter: identity filter runs BEFORE the sold-out cut (filtered counts only identity removals)', async () => {
    const fetchSearch = jest.fn(async () => JSON.stringify(MIXED));
    const services: LookupServices = {
      profiles: buildProfileRegistry([SUBSTORE]),
      getRulesetForUrl: () => stub('gkloot', () => MIXED),
      fetchSearch,
    };

    const out = await assembleLookup(services).lookupByIdentity(IDENTITY, { mode: 'orderable' });

    const gk = out.results.find((r) => r.siteId === 'gkloot')!;
    // filter keeps the 3 Star Origin hits (filtered = 2); orderable then drops the sold-out 9004.
    expect(gk.filtered).toBe(2);
    expect(gk.candidates.map((c) => c.itemId)).toEqual(['17412', '9003']);
    expect(gk.storeQuery).toBe('Lucy');
  });

  it('a candidate with a non-string name is dropped as a non-match, not thrown — the substring store survives (not `failed`)', async () => {
    // Untrusted plugin output: a substring-store SERP emits a candidate whose name is undefined. The
    // identity post-filter must treat it as a non-match (drop it) — NOT throw and lose the WHOLE store.
    const withBadName: SearchCandidate[] = [
      { itemId: '17412', name: 'Star Origin Studio 1/6 Cyberpunk Lucyna Kushinada Statue', available: true },
      { itemId: 'nameless', name: undefined as unknown as string, available: true },
    ];
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const services: LookupServices = {
      profiles: buildProfileRegistry([SUBSTORE]),
      getRulesetForUrl: () => stub('gkloot', () => withBadName),
      fetchSearch: jest.fn(async () => JSON.stringify(withBadName)),
    };

    const out = await assembleLookup(services).lookupByIdentity(IDENTITY);

    expect(out.failed).toEqual([]); // no crash → store is NOT reported failed
    const gk = out.results.find((r) => r.siteId === 'gkloot')!;
    expect(gk.candidates.map((c) => c.itemId)).toEqual(['17412']); // nameless candidate dropped
    expect(gk.filtered).toBe(1);
    expect(warn).not.toHaveBeenCalled(); // no false "search failed" log
    warn.mockRestore();
  });

  it('matches identity tokens across intra-token punctuation variance (apostrophe/hyphen) — no silent false exclusion', async () => {
    // The store wrote the apostrophe/hyphen and the identity did not (or vice-versa). normalizeText
    // spaces punctuation, so a token spanning it ("girls" ⊄ "girl s house") would be falsely excluded.
    // The post-filter also tests the space-collapsed name, so cross-store title variance keeps the target.
    const only = async (identity: IdentityQuery, name: string) => {
      const cand: SearchCandidate[] = [{ itemId: 'x', name, available: true }];
      const services: LookupServices = {
        profiles: buildProfileRegistry([SUBSTORE]),
        getRulesetForUrl: () => stub('gkloot', () => cand),
        fetchSearch: jest.fn(async () => JSON.stringify(cand)),
      };
      return (await assembleLookup(services).lookupByIdentity(identity)).results.find((r) => r.siteId === 'gkloot')!;
    };

    // apostrophe variance: identity "Girls House" vs store title "GIRL'S HOUSE …" → KEPT (was dropped).
    const ap = await only({ studio: 'Girls House', character: 'Lucy' }, "GIRL'S HOUSE GK Studio Lucy Figure");
    expect(ap.candidates.map((c) => c.itemId)).toEqual(['x']);
    expect(ap.filtered).toBe(0);
    // hyphen/space variance inside a token: identity "WuKong Studio" vs "Wu-Kong Studio Lucy" → KEPT.
    const hy = await only({ studio: 'WuKong Studio', character: 'Lucy' }, 'Wu-Kong Studio Lucy');
    expect(hy.candidates.map((c) => c.itemId)).toEqual(['x']);
    // a genuine off-identity decoy is STILL dropped — the gate did not become a pass-through.
    const decoy = await only({ studio: 'Star Origin Studio', character: 'Lucy' }, 'Crown Studio Lucy 1/4');
    expect(decoy.candidates).toEqual([]);
    expect(decoy.filtered).toBe(1);
  });

  it('reports filtered: 0 when the identity filter ran but removed nothing (distinct from no-filter)', async () => {
    // Every candidate already contains all filter tokens → the filter runs but drops nobody. `filtered`
    // must still be PRESENT as 0, so "filter ran, all matched" stays distinguishable from "no filter".
    const allMatch: SearchCandidate[] = [
      { itemId: '17412', name: 'Star Origin Studio Lucy A', available: true },
      { itemId: '9003', name: 'Star Origin Studio Lucy B', available: true },
    ];
    const services: LookupServices = {
      profiles: buildProfileRegistry([SUBSTORE]),
      getRulesetForUrl: () => stub('gkloot', () => allMatch),
      fetchSearch: jest.fn(async () => JSON.stringify(allMatch)),
    };

    const gk = (await assembleLookup(services).lookupByIdentity(IDENTITY)).results.find((r) => r.siteId === 'gkloot')!;

    expect(gk.candidates.map((c) => c.itemId)).toEqual(['17412', '9003']); // nobody removed
    expect(gk.filtered).toBe(0);
    expect(Object.prototype.hasOwnProperty.call(gk, 'filtered')).toBe(true); // present, not omitted
  });
});
