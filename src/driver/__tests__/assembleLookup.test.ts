/**
 * assembleLookup — the cross-store SEARCH (buy-decision) fan-out, in both modes. `listed` returns
 * every carried item (incl. sold-out) with a coverage caveat for orderable-scope stores;
 * `orderable` filters to in-stock. Fakes model the two shapes: a listed store with a sold-out hit,
 * and an orderable-scope store (predictive endpoint that hides sold-out — the solaris case).
 */
import { assembleLookup, resolveLookupStoreTimeoutMs, type LookupServices } from '../assembleLookup';
import { buildProfileRegistry } from '../profileRegistry';
import { ChallengeCooldown } from '../../services/challengeCooldown';
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

describe('assembleLookup — scoped store fan-out (initiator interim path)', () => {
  it('stores scope: fetches ONLY the requested stores; the others are never touched', async () => {
    const { fetchSearch, lookup } = build();

    const out = await lookup.lookup('tomie', { stores: ['solaris'] });

    // only the requested store is fetched — goodsmileus (a supported store) is NOT
    expect(fetchSearch).toHaveBeenCalledWith(expect.stringContaining('solaris'), expect.anything());
    expect(fetchSearch).not.toHaveBeenCalledWith(expect.stringContaining('goodsmileus'), expect.anything());
    expect(out.results.map((r) => r.siteId)).toEqual(['solaris']);
  });

  it('stores scope: unsupported envelope is filtered to the requested set too', async () => {
    const { lookup } = build();

    // cdjapan (byId-only → unsupported for search) is OUT of scope → dropped from the coverage envelope
    const scoped = await lookup.lookup('tomie', { stores: ['solaris'] });
    expect(scoped.unsupported).not.toContain('cdjapan');

    // …but scoping cdjapan IN keeps it in the envelope (it is a requested, if unsupported, store)
    const inScope = await lookup.lookup('tomie', { stores: ['solaris', 'cdjapan'] });
    expect(inScope.unsupported).toContain('cdjapan');
  });

  it('no stores (omitted OR empty) → full fan-out, UNCHANGED (backward-compat contract)', async () => {
    const { fetchSearch: fetchOmitted, lookup: lookupOmitted } = build();
    const omitted = await lookupOmitted.lookup('tomie');

    const { fetchSearch: fetchEmpty, lookup: lookupEmpty } = build();
    const empty = await lookupEmpty.lookup('tomie', { stores: [] });

    // both fetch every supported store and report the same coverage envelope as the pre-scope behavior
    for (const fs of [fetchOmitted, fetchEmpty]) {
      expect(fs).toHaveBeenCalledWith(expect.stringContaining('goodsmileus'), expect.anything());
      expect(fs).toHaveBeenCalledWith(expect.stringContaining('solaris'), expect.anything());
    }
    expect(omitted.results.map((r) => r.siteId).sort()).toEqual(['goodsmileus', 'solaris']);
    expect(empty.results.map((r) => r.siteId).sort()).toEqual(['goodsmileus', 'solaris']);
    expect(omitted.unsupported).toContain('cdjapan');
    expect(empty.unsupported).toContain('cdjapan');
  });

  it('a store whose search fetch HANGS is timed out → reported `failed`, and never blocks the others', async () => {
    jest.useFakeTimers();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    // goodsmileus never resolves; solaris returns normally — the timeout must free the fan-out.
    const fetchSearch = jest.fn((url: string) =>
      url.includes('goodsmileus') ? new Promise<string>(() => {}) : Promise.resolve('{}'),
    );
    const { lookup } = build({ fetchSearch });

    const pending = lookup.lookup('tomie');
    // fire the per-store timeout (and drain the microtasks it releases)
    await jest.advanceTimersByTimeAsync(resolveLookupStoreTimeoutMs(process.env) + 1);
    const out = await pending;

    expect(out.failed).toContain('goodsmileus'); // the hung store is surfaced, not a silent stall
    expect(out.results.map((r) => r.siteId)).toContain('solaris'); // the healthy store still returned
    const failLog = warn.mock.calls.map((c) => String(c[0])).find((l) => l.includes('goodsmileus') && l.includes('search failed'));
    expect(failLog).toContain('timed out');
    jest.useRealTimers();
    warn.mockRestore();
  });
});

describe('resolveLookupStoreTimeoutMs — pure env → ms resolver (LOOKUP_STORE_TIMEOUT_MS)', () => {
  const env = (v?: string): NodeJS.ProcessEnv => ({ LOOKUP_STORE_TIMEOUT_MS: v } as NodeJS.ProcessEnv);

  it('defaults to 15000 when unset', () => {
    expect(resolveLookupStoreTimeoutMs(env())).toBe(15000);
  });
  it('honors a valid override', () => {
    expect(resolveLookupStoreTimeoutMs(env('20000'))).toBe(20000);
  });
  it('falls back to the default on non-numeric input', () => {
    expect(resolveLookupStoreTimeoutMs(env('abc'))).toBe(15000);
  });
  it('clamps a too-small value up to the min', () => {
    expect(resolveLookupStoreTimeoutMs(env('10'))).toBe(1000);
  });
  it('clamps a too-large value down to the max', () => {
    expect(resolveLookupStoreTimeoutMs(env('999999'))).toBe(60000);
  });
});

describe('assembleLookup × challenge cooldown — honest search lane + per-host skip', () => {
  const CHALLENGE = '<html><head><title>Just a moment...</title></head><body>cf</body></html>';

  it('a Cloudflare-challenge search body → store lands in `failed` (reason "challenge page") and opens its cooldown, never a silent 0-candidates', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const cd = new ChallengeCooldown({ now: () => 1000, windowMs: 60_000 });
    const fetchSearch = jest.fn(async (url: string) => (url.includes('goodsmileus') ? CHALLENGE : '{}'));
    const { lookup } = build({ challengeCooldown: cd, fetchSearch });

    const out = await lookup.lookup('tomie');

    // goodsmileus served a challenge → FAILED, not a phantom 0-candidate result
    expect(out.failed).toContain('goodsmileus');
    expect(out.results.find((r) => r.siteId === 'goodsmileus')).toBeUndefined();
    // the reason is logged as "challenge page" (not swallowed as an empty parse)
    const failLog = warn.mock.calls.map((c) => String(c[0])).find((l) => l.includes('goodsmileus') && l.includes('search failed'));
    expect(failLog).toContain('challenge page');
    // and the host's cooldown is now OPEN (so the ingest queue + a later lookup leave it alone)
    expect(cd.isOpen('goodsmileus.com')).toBe(true);
    expect(cd.list().map((e) => e.host)).toContain('goodsmileus.com');
    // solaris (a normal body) is unaffected and still returns results
    expect(out.results.map((r) => r.siteId)).toContain('solaris');
    warn.mockRestore();
  });

  it('a store whose host is cooling is SKIPPED without fetching and listed under `cooldown` (not failed/unsupported)', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const cd = new ChallengeCooldown({ now: () => 1000, windowMs: 60_000 });
    cd.open('goodsmileus.com', 'search challenge page'); // host already cooling from an earlier hit
    const fetchSearch = jest.fn(async () => '{}');
    const { lookup } = build({ challengeCooldown: cd, fetchSearch });

    const out = await lookup.lookup('tomie');

    // goodsmileus is skipped WITHOUT fetching — the whole point of the cooldown
    expect(fetchSearch).not.toHaveBeenCalledWith(expect.stringContaining('goodsmileus'), expect.anything());
    expect(out.cooldown).toContain('goodsmileus');
    expect(out.failed).not.toContain('goodsmileus');
    expect(out.unsupported).not.toContain('goodsmileus');
    expect(out.results.find((r) => r.siteId === 'goodsmileus')).toBeUndefined();
    // the skipped line names the url + host + minutes-left
    const skipped = warn.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith('[COOLDOWN] skipped'));
    expect(skipped).toContain('goodsmileus');
    expect(skipped).toContain('cooling');
    expect(skipped).toContain('min left');
    // solaris (not cooling) is still fetched and returned
    expect(fetchSearch).toHaveBeenCalledWith(expect.stringContaining('solaris'), expect.anything());
    expect(out.results.map((r) => r.siteId)).toContain('solaris');
    warn.mockRestore();
  });

  it('a normal run (no challenge, nothing cooling) leaves `cooldown` empty and does not alter substring/token composition', async () => {
    const cd = new ChallengeCooldown({ now: () => 1000, windowMs: 60_000 });
    const SUBSTORE = caps('gkloot', 'www.gkloot.com', {
      bySearch: { urlTemplate: 'https://www.gkloot.com/search/?Keyword={q}', scope: 'listed', queryMatch: 'substring' },
    });
    const TOKSTORE = caps('fnc', 'www.fnc.com', { bySearch: { urlTemplate: 'https://www.fnc.com/search?q={q}', scope: 'listed' } });
    const CANDS: SearchCandidate[] = [
      { itemId: '17412', name: 'Star Origin Studio Lucy Deluxe', available: true },
      { itemId: '9001', name: 'Crown Studio Lucy 1/4', available: true },
    ];
    const fetchSearch = jest.fn(async () => JSON.stringify(CANDS));
    const services: LookupServices = {
      profiles: buildProfileRegistry([SUBSTORE, TOKSTORE]),
      getRulesetForUrl: (url) => (url.includes('gkloot') ? stub('gkloot', () => CANDS) : stub('fnc', () => CANDS)),
      fetchSearch,
      challengeCooldown: cd,
    };

    const out = await assembleLookup(services).lookupByIdentity({ studio: 'Star Origin Studio', character: 'Lucy' });

    expect(out.cooldown).toEqual([]); // nothing cooling → empty
    // substring store still issued the single selective term + post-filtered; token store got the composed phrase
    expect(fetchSearch).toHaveBeenCalledWith('https://www.gkloot.com/search/?Keyword=Lucy', expect.anything());
    expect(fetchSearch).toHaveBeenCalledWith('https://www.fnc.com/search?q=Star%20Origin%20Studio%20Lucy', expect.anything());
    const gk = out.results.find((r) => r.siteId === 'gkloot')!;
    expect(gk.candidates.map((c) => c.itemId)).toEqual(['17412']); // Crown decoy filtered out — composition intact
    expect(gk.filtered).toBe(1);
  });
});

/**
 * Stored-cookie STALE / FRESH signals (CfCookieStore): at the existing search-challenge cooldown site,
 * a host the store has cookies for is marked stale via the lane that fetched it; a clean search body
 * marks it fresh. A host without stored cookies is never marked (the cooldown still opens).
 */
describe('assembleLookup × stored cookies — stale / fresh signals', () => {
  const CHALLENGE = '<html><head><title>Just a moment...</title></head><body>cf</body></html>';
  const fakeStore = (hosts: string[]) => ({
    cookiesFor: (url: string) => (hosts.includes(new URL(url).hostname.replace(/^www\./, '')) ? { cf_clearance: 'FAKE_cf_1' } : undefined),
    userAgentFor: () => undefined,
    markStale: jest.fn(() => true),
    markFresh: jest.fn(() => true),
  });

  it('a challenge from a host WITH stored cookies → markStale(host, lane, "search challenge page") once; a clean store → markFresh(host)', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const cd = new ChallengeCooldown({ now: () => 1000, windowMs: 60_000 });
    const cfCookieStore = fakeStore(['goodsmileus.com', 'solarisjapan.com']);
    const fetchSearch = jest.fn(async (url: string) => (url.includes('goodsmileus') ? CHALLENGE : '{}'));
    const { lookup } = build({ challengeCooldown: cd, fetchSearch, cfCookieStore });

    const out = await lookup.lookup('tomie');

    expect(out.failed).toContain('goodsmileus');
    expect(cd.isOpen('goodsmileus.com')).toBe(true);
    expect(cfCookieStore.markStale).toHaveBeenCalledTimes(1);
    expect(cfCookieStore.markStale).toHaveBeenCalledWith('goodsmileus.com', 'http', 'search challenge page');
    expect(cfCookieStore.markFresh).toHaveBeenCalledTimes(1);
    expect(cfCookieStore.markFresh).toHaveBeenCalledWith('solarisjapan.com');
  });

  it('a challenge from a host WITHOUT stored cookies → cooldown opens but markStale is never called', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const cd = new ChallengeCooldown({ now: () => 1000, windowMs: 60_000 });
    const cfCookieStore = fakeStore([]);
    const fetchSearch = jest.fn(async (url: string) => (url.includes('goodsmileus') ? CHALLENGE : '{}'));
    const { lookup } = build({ challengeCooldown: cd, fetchSearch, cfCookieStore });

    const out = await lookup.lookup('tomie');

    expect(out.failed).toContain('goodsmileus');
    expect(cd.isOpen('goodsmileus.com')).toBe(true);
    expect(cfCookieStore.markStale).not.toHaveBeenCalled();
  });

  it('a store whose declared searchFetch names NO transport is marked via "http" — the same default makeFetchSearch rides', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const cfCookieStore = fakeStore(['goodsmileus.com']);
    const { lookup } = build({
      profiles: buildProfileRegistry([{ ...GOODSMILEUS, searchFetch: { headers: { 'X-Api': 'k' } } }]),
      challengeCooldown: new ChallengeCooldown({ now: () => 1000, windowMs: 60_000 }),
      fetchSearch: jest.fn(async () => CHALLENGE),
      cfCookieStore,
    });

    await lookup.lookup('tomie');

    expect(cfCookieStore.markStale).toHaveBeenCalledWith('goodsmileus.com', 'http', 'search challenge page');
  });
});

describe('assembleLookup — per-candidate collectUrl (the collect-ready URL; `url` stays the page link)', () => {
  // orzgk: bySearch + byId — the byId Store-API JSON collects where the CF-challenged HTML page does not.
  const ORZGK = caps('orzgk', 'www.orzgk.com', {
    bySearch: { urlTemplate: 'https://www.orzgk.com/wp-json/wc/store/v1/products?search={q}', scope: 'listed' },
    byId: { urlTemplate: 'https://www.orzgk.com/wp-json/wc/store/v1/products/{id}', idKind: 'store-internal' },
  });
  // fnc: bySearch only (no byId) — the page url is the only collect path.
  const FNC = caps('fnc', 'www.fnc.com', { bySearch: { urlTemplate: 'https://www.fnc.com/search?q={q}', scope: 'listed' } });

  const run = async (store: StoreCapabilities, cands: SearchCandidate[], opts?: { mode?: 'listed' | 'orderable' }) => {
    const services: LookupServices = {
      profiles: buildProfileRegistry([store]),
      getRulesetForUrl: () => stub(store.siteId, () => cands),
      fetchSearch: jest.fn(async () => '{}'),
    };
    const out = await assembleLookup(services).lookup('lucy', opts);
    return { out, r: out.results.find((x) => x.siteId === store.siteId)! };
  };

  it('(1) byId store + itemId → collectUrl is the byId template with the itemId url-encoded; `url` is untouched', async () => {
    const { r } = await run(ORZGK, [{ itemId: 'a b/1', name: 'Lucy', url: 'https://www.orzgk.com/product/lucy/', available: true }]);

    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].collectUrl).toBe('https://www.orzgk.com/wp-json/wc/store/v1/products/a%20b%2F1');
    // the contract's page link is NOT rewritten, and every other field is intact
    expect(r.candidates[0].url).toBe('https://www.orzgk.com/product/lucy/');
    expect(r.candidates[0]).toMatchObject({ itemId: 'a b/1', name: 'Lucy', available: true });
  });

  it('(2) no byId + absolute url → collectUrl === url', async () => {
    const { r } = await run(FNC, [{ itemId: 'f1', name: 'Lucy', url: 'https://www.fnc.com/item/f1', available: true }]);

    expect(r.candidates[0].collectUrl).toBe('https://www.fnc.com/item/f1');
    expect(r.candidates[0].url).toBe('https://www.fnc.com/item/f1');
  });

  it('(3) no byId + RELATIVE url (Shopify /products/<handle>) → absolutized against the search URL origin', async () => {
    // goodsmileus: bySearch only; its hits carry `/products/nendo` (relative) — the live 400 cause.
    const { r } = await run(GOODSMILEUS, GSUS_CANDIDATES);

    expect(r.candidates.map((c) => c.collectUrl)).toEqual([
      'https://www.goodsmileus.com/products/nendo',
      'https://www.goodsmileus.com/products/gyaru',
    ]);
    expect(r.candidates.map((c) => c.url)).toEqual(['/products/nendo', '/products/gyaru']); // page links unchanged
  });

  it('(4) byId declared but itemId empty → falls back to the url rule', async () => {
    const { r } = await run(ORZGK, [{ itemId: '', name: 'Lucy', url: '/product/lucy/', available: true }]);

    expect(r.candidates[0].collectUrl).toBe('https://www.orzgk.com/product/lucy/');
    expect(r.candidates[0].itemId).toBe('');
  });

  it('(5) neither usable (no itemId, no url) → collectUrl absent, candidate still returned', async () => {
    // untrusted plugin output: a non-string itemId on a byId store, and no url at all
    const { r: byIdStore } = await run(ORZGK, [{ itemId: 42 as unknown as string, name: 'Lucy', available: true }]);
    expect(byIdStore.candidates).toHaveLength(1);
    expect(Object.prototype.hasOwnProperty.call(byIdStore.candidates[0], 'collectUrl')).toBe(false);
    expect(byIdStore.candidates[0]).toEqual({ itemId: 42, name: 'Lucy', available: true });

    // a no-byId store whose hit has no url (the solaris suggest shape)
    const { r: noByIdStore } = await run(FNC, [{ itemId: 'f1', name: 'Lucy', available: true }]);
    expect(noByIdStore.candidates).toHaveLength(1);
    expect(Object.prototype.hasOwnProperty.call(noByIdStore.candidates[0], 'collectUrl')).toBe(false);
  });

  it('(6) collectUrl survives the substring identity post-filter AND the orderable-mode cut', async () => {
    const GK = caps('gkloot', 'www.gkloot.com', {
      bySearch: { urlTemplate: 'https://www.gkloot.com/search/?Keyword={q}', scope: 'listed', queryMatch: 'substring' },
      byId: { urlTemplate: 'https://www.gkloot.com/products/{id}', idKind: 'store-internal' },
    });
    const MIXED: SearchCandidate[] = [
      { itemId: '17412', name: 'Star Origin Studio Lucy Deluxe', url: '/p/17412', available: true },
      { itemId: '9001', name: 'Crown Studio Lucy 1/4', url: '/p/9001', available: true },
      { itemId: '9004', name: 'Star Origin Studio Lucy Sold', url: '/p/9004', available: false },
    ];
    const build = () => assembleLookup({
      profiles: buildProfileRegistry([GK]),
      getRulesetForUrl: () => stub('gkloot', () => MIXED),
      fetchSearch: jest.fn(async () => '{}'),
    });
    const IDENTITY = { studio: 'Star Origin Studio', character: 'Lucy' };

    // listed: the identity post-filter drops Crown; both Star Origin hits keep their byId collectUrl
    const listed = (await build().lookupByIdentity(IDENTITY)).results.find((r) => r.siteId === 'gkloot')!;
    expect(listed.filtered).toBe(1);
    expect(listed.candidates.map((c) => [c.itemId, c.collectUrl])).toEqual([
      ['17412', 'https://www.gkloot.com/products/17412'],
      ['9004', 'https://www.gkloot.com/products/9004'],
    ]);

    // orderable: the sold-out 9004 is cut too; the survivor still carries collectUrl
    const orderable = (await build().lookupByIdentity(IDENTITY, { mode: 'orderable' })).results.find((r) => r.siteId === 'gkloot')!;
    expect(orderable.candidates.map((c) => [c.itemId, c.collectUrl])).toEqual([['17412', 'https://www.gkloot.com/products/17412']]);
  });

  it('(7) a malformed url with no byId → no throw, collectUrl absent, the candidate AND the store survive', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { out, r } = await run(FNC, [
      { itemId: 'bad', name: 'Lucy', url: 'http://[bad', available: true },
      { itemId: 'ok', name: 'Lucy 2', url: 'https://www.fnc.com/item/ok', available: true },
    ]);

    expect(out.failed).toEqual([]); // the store is NOT taken down by one bad link
    expect(r.candidates.map((c) => c.itemId)).toEqual(['bad', 'ok']); // the bad candidate is kept
    expect(Object.prototype.hasOwnProperty.call(r.candidates[0], 'collectUrl')).toBe(false);
    expect(r.candidates[0].url).toBe('http://[bad');
    expect(r.candidates[1].collectUrl).toBe('https://www.fnc.com/item/ok');
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('(8) a whitespace-only url, or one whose trimmed value is fragment/query-only, → no collectUrl; url untouched', async () => {
    const { r } = await run(FNC, [
      { itemId: 'w1', name: 'Lucy A', url: '   ', available: true },
      { itemId: 'w2', name: 'Lucy B', url: '  #section  ', available: true },
      { itemId: 'w3', name: 'Lucy C', url: '?foo=bar', available: true },
    ]);

    expect(r.candidates).toHaveLength(3);
    for (const c of r.candidates) {
      expect(Object.prototype.hasOwnProperty.call(c, 'collectUrl')).toBe(false);
    }
    // url is untouched (not trimmed, not rewritten) even though the trimmed value drove the decision
    expect(r.candidates.map((c) => c.url)).toEqual(['   ', '  #section  ', '?foo=bar']);
  });

  it('(9) a resolved collectUrl whose protocol is not http/https is rejected; a protocol-relative url still resolves (to https)', async () => {
    const { r } = await run(FNC, [
      { itemId: 'j1', name: 'Lucy A', url: 'javascript:alert(1)', available: true },
      { itemId: 'd1', name: 'Lucy B', url: 'data:text/html,hi', available: true },
      { itemId: 'm1', name: 'Lucy C', url: 'mailto:a@b.com', available: true },
      { itemId: 'p1', name: 'Lucy D', url: '//cdn.fnc.com/item/p1', available: true },
    ]);
    const byId = (id: string) => r.candidates.find((c) => c.itemId === id)!;

    expect(Object.prototype.hasOwnProperty.call(byId('j1'), 'collectUrl')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(byId('d1'), 'collectUrl')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(byId('m1'), 'collectUrl')).toBe(false);
    // protocol-relative is NOT special-cased by host — it resolves against the (https) search URL and is allowed
    expect(byId('p1').collectUrl).toBe('https://cdn.fnc.com/item/p1');
  });

  it('(10) a null element inside the candidates array passes through untouched — no throw, store not `failed`', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const cands = [
      { itemId: 'ok', name: 'Lucy', url: 'https://www.fnc.com/item/ok', available: true },
      null,
    ] as unknown as SearchCandidate[];

    const { out, r } = await run(FNC, cands);

    expect(out.failed).toEqual([]);
    expect(r.candidates).toHaveLength(2);
    expect(r.candidates[0].collectUrl).toBe('https://www.fnc.com/item/ok');
    expect(r.candidates[1]).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('(11) extractCandidates resolving to a non-array passes through exactly as before collectUrl decoration existed — no throw, store not `failed`', async () => {
    const services: LookupServices = {
      profiles: buildProfileRegistry([FNC]),
      getRulesetForUrl: () => stub('fnc', (() => undefined) as unknown as ExtractionRuleset['extractCandidates']),
      fetchSearch: jest.fn(async () => '{}'),
    };

    const out = await assembleLookup(services).lookup('lucy');

    expect(out.failed).toEqual([]);
    const r = out.results.find((x) => x.siteId === 'fnc')!;
    expect(r).toBeDefined();
    expect(r.candidates).toBeUndefined();
  });
});
