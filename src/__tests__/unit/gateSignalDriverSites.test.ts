/**
 * The OTHER markFresh sites — /lookup's search fan-out and the /catalog listing + declared-page
 * axes — obey the same gate rule as the ingest queue (gateSignal): only a CLEAN fetch (2xx or no
 * status, a non-empty body, not a flagged challenge) may mark a stored-cookie host FRESH, and an
 * empty body or a 5xx from a GATED host is a gate failure — stale mark + one strike toward the
 * shared host cooldown.
 *
 * Before: each site called markFreshIfStored on ANY non-challenge body, so an empty body from a
 * refusing gate cleared the operator's stale mark exactly like a real page.
 */
import { assembleLookup, type LookupServices } from '../../driver/assembleLookup';
import { assembleCatalog, type CatalogServices } from '../../driver/assembleCatalog';
import { buildProfileRegistry, ProfileRegistry } from '../../driver/profileRegistry';
import { ChallengeCooldown } from '../../services/challengeCooldown';
import { createImpitFetchers } from '../../services/impitFetch';
import type { ExtractionRuleset, ListingPage, SearchCandidate, StoreCapabilities } from '@figurecollecting/scraper-plugin-contract';

const HOST = 'gated.example.test';
const MIN = 60_000;

function fakeStore(hosts: string[]) {
  const has = (url: string) => {
    try { return hosts.includes(new URL(url).hostname.toLowerCase().replace(/^www\./, '')); } catch { return false; }
  };
  return {
    cookiesFor: jest.fn((url: string) => (has(url) ? { cf_clearance: 'FAKE_cf_1' } : undefined)),
    userAgentFor: jest.fn(() => undefined),
    markStale: jest.fn(() => true),
    markFresh: jest.fn(() => true),
  };
}

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('/lookup search fan-out × gate rule', () => {
  const STORE: StoreCapabilities = {
    siteId: 'gatedstore',
    name: 'gatedstore',
    domains: [HOST],
    rateLimit: { domain: HOST, baseDelayMs: 0, minDelayMs: 0, maxDelayMs: 100, backoffMultiplier: 2, recoveryDivisor: 2, successThreshold: 3 },
    requiresBrowser: false,
    allowedCookies: [],
    retrieval: { bySearch: { urlTemplate: `https://${HOST}/search?q={q}`, scope: 'listed' } },
  };
  const CANDS: SearchCandidate[] = [{ itemId: 'x', name: 'Figure X', url: '/p/x', available: true }];
  const rs: ExtractionRuleset = {
    siteId: 'gatedstore',
    version: '1.0.0',
    extract: () => ({ source: { site: 'gatedstore', itemId: 'x', extractedAt: '2026-09-29T00:00:00.000Z' }, fields: {}, warnings: [] }),
    validate: () => ({ valid: true, errors: [], warnings: [] }),
    extractCandidates: () => CANDS,
  };

  // A bare string is a status-blind lane (fetchSearch only); an object is what the status-aware
  // lane answers, wired as fetchSearchDetail exactly as the engine's wireServices does.
  const services = (
    fetched: string | { body: string; status?: number },
    cd: ChallengeCooldown,
    store: ReturnType<typeof fakeStore>,
    caps: StoreCapabilities = STORE,
  ): LookupServices => ({
    profiles: buildProfileRegistry([caps]),
    getRulesetForUrl: () => rs,
    fetchSearch: jest.fn(async () => (typeof fetched === 'string' ? fetched : fetched.body)),
    ...(typeof fetched === 'string' ? {} : { fetchSearchDetail: jest.fn(async () => fetched) }),
    challengeCooldown: cd,
    cfCookieStore: store,
  });

  it('an EMPTY search body on a stored-cookie host never marks FRESH; it marks STALE and strikes toward the cooldown', async () => {
    const cd = new ChallengeCooldown({ now: () => 1, windowMs: MIN, gateFailureThreshold: 1 });
    const store = fakeStore([HOST]);
    await assembleLookup(services('', cd, store)).lookup('marin');

    expect(store.markFresh).not.toHaveBeenCalled();
    expect(store.markStale).toHaveBeenCalledWith(HOST, 'http', 'gate failure via http transport: no status with an empty body');
    expect(cd.isOpen(HOST)).toBe(true);
  });

  it('a store DECLARING access "cloudflare" (no transport, no stored cookies) is gated by the declaration: an empty body strikes', async () => {
    const cd = new ChallengeCooldown({ now: () => 1, windowMs: MIN, gateFailureThreshold: 1 });
    const store = fakeStore([]);
    await assembleLookup(services('', cd, store, { ...STORE, searchFetch: { access: 'cloudflare' } })).lookup('marin');

    expect(store.markStale).not.toHaveBeenCalled(); // nothing stored to mark
    expect(store.markFresh).not.toHaveBeenCalled();
    expect(cd.list()).toEqual([
      { host: HOST, remainingMs: MIN, reason: '1 consecutive gate failures (gate failure via http transport: no status with an empty body)' },
    ]);
  });

  it('a real 2xx search body still marks FRESH and resets the run', async () => {
    const cd = new ChallengeCooldown({ now: () => 1, windowMs: MIN, gateFailureThreshold: 5 });
    cd.recordGateFailure(HOST, 'r');
    const store = fakeStore([HOST]);
    await assembleLookup(services({ status: 200, body: '{"products":[]}' }, cd, store)).lookup('marin');

    expect(store.markFresh).toHaveBeenCalledWith(HOST);
    expect(store.markStale).not.toHaveBeenCalled();
    expect(cd.gateFailureCount(HOST)).toBe(0);
  });
});

describe('/catalog axes × gate rule', () => {
  const STORE: StoreCapabilities = {
    siteId: 'gatedstore',
    name: 'Gated Store',
    domains: [HOST],
    rateLimit: { domain: HOST, baseDelayMs: 0, minDelayMs: 0, maxDelayMs: 100, backoffMultiplier: 2, recoveryDivisor: 2, successThreshold: 3 },
    requiresBrowser: false,
    allowedCookies: [],
    retrieval: {
      byId: { urlTemplate: `https://${HOST}/item/{id}`, idKind: 'store-internal' },
      byListing: { urlTemplate: `https://${HOST}/new?page={page}`, order: 'newest' },
      seedLists: [{ id: 'featured', url: `https://${HOST}/featured`, cadence: 'weekly' }],
      rotatingSeedLists: [{ id: 'maker-1', url: `https://${HOST}/search?maker=1`, group: 'maker-1', order: 1 }],
    },
  };
  const page: ListingPage = { items: [{ itemId: '11' }], hasMore: false };
  const ruleset = {
    siteId: 'gatedstore',
    version: '1.0',
    extract: jest.fn(),
    validate: jest.fn(),
    extractListing: jest.fn(() => page),
    extractSeedList: jest.fn(() => page),
  } as unknown as ExtractionRuleset;

  const services = (
    fetched: string | { body: string; status?: number },
    cd: ChallengeCooldown,
    store: ReturnType<typeof fakeStore>,
    caps: StoreCapabilities = STORE,
  ): CatalogServices => {
    const profiles = new ProfileRegistry();
    profiles.register(caps);
    return {
      profiles,
      getRulesetForUrl: jest.fn(() => ruleset),
      fetchSearch: jest.fn(async () => (typeof fetched === 'string' ? fetched : fetched.body)),
      fetchSearchDetail: jest.fn(async () => fetched),
      challengeCooldown: cd,
      cfCookieStore: store as unknown as CatalogServices['cfCookieStore'],
    };
  };

  it('listing page: an EMPTY body never marks FRESH; it marks STALE and strikes', async () => {
    const cd = new ChallengeCooldown({ now: () => 1, windowMs: MIN, gateFailureThreshold: 1 });
    const store = fakeStore([HOST]);
    await assembleCatalog(services('', cd, store)).catalog('gatedstore', 1);

    expect(store.markFresh).not.toHaveBeenCalled();
    expect(store.markStale).toHaveBeenCalledWith(HOST, 'http', 'gate failure via http transport: no status with an empty body');
    expect(cd.isOpen(HOST)).toBe(true);
  });

  it('listing page: a real 2xx body still marks FRESH and resets the run', async () => {
    const cd = new ChallengeCooldown({ now: () => 1, windowMs: MIN });
    cd.recordGateFailure(HOST, 'r');
    const store = fakeStore([HOST]);
    await assembleCatalog(services({ status: 200, body: '<html>list</html>' }, cd, store)).catalog('gatedstore', 1);

    expect(store.markFresh).toHaveBeenCalledWith(HOST);
    expect(cd.gateFailureCount(HOST)).toBe(0);
  });

  it('declared page (rotating seed, status-aware lane): a 5xx from a gated host is a gate failure — stale + strike, never FRESH — and still reported transient', async () => {
    const cd = new ChallengeCooldown({ now: () => 1, windowMs: MIN, gateFailureThreshold: 1 });
    const store = fakeStore([HOST]);
    const out = await assembleCatalog(services({ body: '', status: 500 }, cd, store)).rotatingSeed('gatedstore', 'maker-1');

    expect(out).toMatchObject({ status: 'failed', failure: 'transient', upstreamStatus: 500 });
    expect(store.markFresh).not.toHaveBeenCalled();
    expect(store.markStale).toHaveBeenCalledWith(HOST, 'http', 'gate failure via http transport: HTTP 500 with an empty body');
    expect(cd.isOpen(HOST)).toBe(true);
  });

  it('declared page (seed): an EMPTY 200 is not clean — no FRESH; a real 200 is', async () => {
    const cd = new ChallengeCooldown({ now: () => 1, windowMs: MIN });
    const emptyStore = fakeStore([HOST]);
    await assembleCatalog(services('', cd, emptyStore)).seed('gatedstore', 'featured');
    expect(emptyStore.markFresh).not.toHaveBeenCalled();
    expect(cd.gateFailureCount(HOST)).toBe(1);

    const cleanStore = fakeStore([HOST]);
    await assembleCatalog(services({ status: 200, body: '<html>seed</html>' }, cd, cleanStore)).seed('gatedstore', 'featured');
    expect(cleanStore.markFresh).toHaveBeenCalledWith(HOST);
    expect(cd.gateFailureCount(HOST)).toBe(0);
  });

  it('a store DECLARING access "cloudflare" (no transport, no stored cookies) is gated by the declaration on both catalog axes', async () => {
    const DECLARED = { ...STORE, searchFetch: { access: 'cloudflare' as const } };
    const listCd = new ChallengeCooldown({ now: () => 1, windowMs: MIN, gateFailureThreshold: 1 });
    await assembleCatalog(services('', listCd, fakeStore([]), DECLARED)).catalog('gatedstore', 1);
    expect(listCd.list()[0]?.reason).toBe('1 consecutive gate failures (gate failure via http transport: no status with an empty body)');

    const seedCd = new ChallengeCooldown({ now: () => 1, windowMs: MIN, gateFailureThreshold: 1 });
    await assembleCatalog(services({ body: '', status: 502 }, seedCd, fakeStore([]), DECLARED)).rotatingSeed('gatedstore', 'maker-1');
    expect(seedCd.list()[0]?.reason).toBe('1 consecutive gate failures (gate failure via http transport: HTTP 502 with an empty body)');
  });

  it('a NON-gated host: an empty body is neither FRESH nor a strike (no cookies, no access gate)', async () => {
    const cd = new ChallengeCooldown({ now: () => 1, windowMs: MIN, gateFailureThreshold: 1 });
    const store = fakeStore([]);
    await assembleCatalog(services('', cd, store)).catalog('gatedstore', 1);

    expect(store.markFresh).not.toHaveBeenCalled();
    expect(store.markStale).not.toHaveBeenCalled();
    expect(cd.isOpen(HOST)).toBe(false);
    expect(cd.gateFailureCount(HOST)).toBe(0);
  });
});

/**
 * Challenger round 1 on PR #334 — the three sites above were fed the BARE-BODY lanes in production
 * (wireServices: `impersonate: impitFetchBody`, which drops the status the lane saw), so a 500
 * "Internal Server Error" or a 403 "Security check" page from a gated host counted as clean: it
 * marked the host FRESH and reset the SHARED run. Now:
 *   - each site reads the status-aware lane (fetchSearchDetail, the same impit / http sessions), so
 *     the status reaches the gate;
 *   - a site that still saw NO status (the browser lane, a bare-body composition) cannot prove clean:
 *     a non-empty body there neither resets the run nor marks FRESH;
 *   - a gate failure at a /catalog axis is reported `failed`, never parsed as a page (an empty or
 *     refused listing must not read as "end of catalog").
 */
describe('round 1 — the status the lane saw reaches the gate at /lookup and /catalog', () => {
  const INTERNAL_ERROR = 'Internal Server Error';
  const SECURITY_CHECK = '<html><head><title>Security check | MyFigure</title></head><body>' + 'x'.repeat(37_000) + '</body></html>';
  /** The REAL impit lanes (both surfaces over one session) over a fake native impit answering `status` + `text`. */
  const impitAnswering = (status: number, text: string) =>
    createImpitFetchers(async () => ({ fetch: async () => ({ status, text: async () => text }) }) as never, {
      store: { cookiesFor: () => undefined, userAgentFor: () => undefined },
    });

  const LOOKUP_STORE: StoreCapabilities = {
    siteId: 'gatedstore', name: 'gatedstore', domains: [HOST],
    rateLimit: { domain: HOST, baseDelayMs: 0, minDelayMs: 0, maxDelayMs: 100, backoffMultiplier: 2, recoveryDivisor: 2, successThreshold: 3 },
    requiresBrowser: false, allowedCookies: [],
    retrieval: { bySearch: { urlTemplate: `https://${HOST}/search?q={q}`, scope: 'listed' } },
    searchFetch: { transport: 'impersonate', browser: 'chrome142' },
  };
  const lookupRs = { siteId: 'gatedstore', version: '1.0.0', extract: jest.fn(), validate: jest.fn(), extractCandidates: () => [] } as unknown as ExtractionRuleset;
  const CAT_STORE: StoreCapabilities = {
    ...LOOKUP_STORE,
    retrieval: {
      byListing: { urlTemplate: `https://${HOST}/new?page={page}`, order: 'newest' },
      seedLists: [{ id: 'featured', url: `https://${HOST}/featured`, cadence: 'weekly' }],
    },
  };
  const listing: ListingPage = { items: [{ itemId: '11' }], hasMore: false };
  const catRs = () => ({
    siteId: 'gatedstore', version: '1', extract: jest.fn(), validate: jest.fn(),
    extractListing: jest.fn(() => listing), extractSeedList: jest.fn(() => listing),
  }) as unknown as ExtractionRuleset & { extractListing: jest.Mock; extractSeedList: jest.Mock };
  const struck = (n: number, threshold = 5) => {
    const cd = new ChallengeCooldown({ now: () => 1, windowMs: MIN, gateFailureThreshold: threshold });
    for (let i = 0; i < n; i++) cd.recordGateFailure(HOST, 'queue empty 500');
    return cd;
  };
  const lookupOver = (lane: ReturnType<typeof impitAnswering>, cd: ChallengeCooldown, store: ReturnType<typeof fakeStore>, statusAware = true) =>
    assembleLookup({
      profiles: buildProfileRegistry([LOOKUP_STORE]),
      getRulesetForUrl: () => lookupRs,
      fetchSearch: (url) => lane.body(url),
      ...(statusAware ? { fetchSearchDetail: (url: string) => lane.detailed(url) } : {}),
      challengeCooldown: cd,
      cfCookieStore: store,
    } as LookupServices);
  const catalogOver = (lane: ReturnType<typeof impitAnswering>, cd: ChallengeCooldown, store: ReturnType<typeof fakeStore>, rs = catRs(), statusAware = true) => {
    const profiles = new ProfileRegistry();
    profiles.register(CAT_STORE);
    return assembleCatalog({
      profiles,
      getRulesetForUrl: () => rs,
      fetchSearch: (url) => lane.body(url),
      ...(statusAware ? { fetchSearchDetail: (url: string) => lane.detailed(url) } : {}),
      challengeCooldown: cd,
      cfCookieStore: store as unknown as CatalogServices['cfCookieStore'],
    });
  };

  it('B0 (fact) the detailed impit lane sees HTTP 500; the body lane hands back only the text', async () => {
    const lane = impitAnswering(500, INTERNAL_ERROR);
    expect(await lane.detailed(`https://${HOST}/search?q=x`)).toMatchObject({ status: 500, body: INTERNAL_ERROR });
    expect(await lane.body(`https://${HOST}/search?q=x`)).toBe(INTERNAL_ERROR);
  });

  it('B1 /lookup: a 500 "Internal Server Error" from a gated host is a strike and a stale mark, never FRESH', async () => {
    const cd = struck(4);
    const store = fakeStore([HOST]);
    await lookupOver(impitAnswering(500, INTERNAL_ERROR), cd, store).lookup('marin');
    expect({ fresh: store.markFresh.mock.calls.length, run: cd.gateFailureCount(HOST), open: cd.isOpen(HOST) }).toEqual({ fresh: 0, run: 5, open: true });
    expect(store.markStale).toHaveBeenCalledWith(HOST, 'impersonate', 'gate failure via impersonate transport: HTTP 500');
  });

  it('B2 /lookup: a 403 "Security check" page (not a CF interstitial) neither marks FRESH nor resets the run', async () => {
    const cd = struck(4);
    const store = fakeStore([HOST]);
    await lookupOver(impitAnswering(403, SECURITY_CHECK), cd, store).lookup('marin');
    expect({ fresh: store.markFresh.mock.calls.length, run: cd.gateFailureCount(HOST) }).toEqual({ fresh: 0, run: 4 });
  });

  it('B1b /lookup on a STATUS-BLIND lane (browser, bare-body composition): a non-empty body proves nothing — no FRESH, no reset', async () => {
    for (const [status, text] of [[500, INTERNAL_ERROR], [403, SECURITY_CHECK], [200, '{"products":[]}']] as const) {
      const cd = struck(4);
      const store = fakeStore([HOST]);
      await lookupOver(impitAnswering(status, text), cd, store, false).lookup('marin');
      expect({ status, fresh: store.markFresh.mock.calls.length, run: cd.gateFailureCount(HOST) }).toEqual({ status, fresh: 0, run: 4 });
    }
  });

  it('B3 /catalog listing + seed: a 500 "Internal Server Error" from a gated host is `failed`, a strike each, never FRESH, never parsed', async () => {
    const lane = impitAnswering(500, INTERNAL_ERROR);
    const cd = struck(0, 99);
    const store = fakeStore([HOST]);
    const rs = catRs();
    const cat = catalogOver(lane, cd, store, rs);
    const listOut = await cat.catalog('gatedstore', 1);
    const seedOut = await cat.seed('gatedstore', 'featured');
    expect(listOut).toEqual({ status: 'failed', siteId: 'gatedstore', reason: 'gate failure via impersonate transport: HTTP 500' });
    expect(seedOut).toEqual({ status: 'failed', siteId: 'gatedstore', reason: 'store answered 500' });
    expect({ fresh: store.markFresh.mock.calls.length, run: cd.gateFailureCount(HOST) }).toEqual({ fresh: 0, run: 2 });
    expect(rs.extractListing).not.toHaveBeenCalled();
    expect(rs.extractSeedList).not.toHaveBeenCalled();
  });

  it('B3b /catalog listing + seed: a 403 "Security check" page neither marks FRESH nor resets the run', async () => {
    const cd = struck(4);
    const store = fakeStore([HOST]);
    const cat = catalogOver(impitAnswering(403, SECURITY_CHECK), cd, store);
    await cat.catalog('gatedstore', 1);
    await cat.seed('gatedstore', 'featured');
    expect({ fresh: store.markFresh.mock.calls.length, run: cd.gateFailureCount(HOST) }).toEqual({ fresh: 0, run: 4 });
  });

  it('B3c /catalog on a STATUS-BLIND lane: a non-empty listing / seed body neither marks FRESH nor resets the run', async () => {
    const cd = struck(4);
    const store = fakeStore([HOST]);
    const cat = catalogOver(impitAnswering(200, '<html>list</html>'), cd, store, catRs(), false);
    expect(await cat.catalog('gatedstore', 1)).toMatchObject({ status: 'ok' });
    expect(await cat.seed('gatedstore', 'featured')).toMatchObject({ status: 'ok' });
    expect({ fresh: store.markFresh.mock.calls.length, run: cd.gateFailureCount(HOST) }).toEqual({ fresh: 0, run: 4 });
  });

  it('a gate failure at a /catalog axis is never parsed: an EMPTY 200 listing or seed from a gated host is `failed`', async () => {
    const cd = struck(0, 99);
    const store = fakeStore([HOST]);
    const rs = catRs();
    const cat = catalogOver(impitAnswering(200, ''), cd, store, rs);
    expect(await cat.catalog('gatedstore', 1)).toEqual({ status: 'failed', siteId: 'gatedstore', reason: 'gate failure via impersonate transport: HTTP 200 with an empty body' });
    expect(await cat.seed('gatedstore', 'featured')).toEqual({ status: 'failed', siteId: 'gatedstore', reason: 'gate failure via impersonate transport: HTTP 200 with an empty body' });
    expect(rs.extractListing).not.toHaveBeenCalled();
    expect(rs.extractSeedList).not.toHaveBeenCalled();
    expect(cd.gateFailureCount(HOST)).toBe(2);
  });

  it('the status-aware lane still proves a real 2xx at every site: FRESH, run reset', async () => {
    const lane = impitAnswering(200, '<html>real page</html>');
    const lookupCd = struck(3);
    const lookupStore = fakeStore([HOST]);
    await lookupOver(lane, lookupCd, lookupStore).lookup('marin');
    expect({ fresh: lookupStore.markFresh.mock.calls.length, run: lookupCd.gateFailureCount(HOST) }).toEqual({ fresh: 1, run: 0 });

    const catCd = struck(3);
    const catStore = fakeStore([HOST]);
    const cat = catalogOver(lane, catCd, catStore);
    expect(await cat.catalog('gatedstore', 1)).toMatchObject({ status: 'ok' });
    catCd.recordGateFailure(HOST, 'r');
    expect(await cat.seed('gatedstore', 'featured')).toMatchObject({ status: 'ok' });
    expect({ fresh: catStore.markFresh.mock.calls.length, run: catCd.gateFailureCount(HOST) }).toEqual({ fresh: 2, run: 0 });
  });
});

/**
 * Challenger round 2 on PR #334.
 *   - A declared page (seed / rotating seed) that is a gate failure although the store answered 2xx
 *     (an EMPTY 200, or an empty body on a status-blind lane) is `failed` + `transient`, and NOT
 *     `blocked`. The crawler's rotating pass stops the store on a transient (the refusing host is not
 *     asked again this pass); a `deterministic` would mark only that list failed and fetch the NEXT
 *     list of the same refusing host in the same pass. The seed result carries no failure class.
 *   - A clean answer that lands while the host's window is OPEN (another site opened it while this
 *     fetch was in flight) never marks the host FRESH at /lookup or any /catalog axis: the stale mark
 *     that came with the window survives, exactly as the ingest queue's isOpen guard keeps it.
 */
describe('round 2 — declared-page failure class, and no FRESH inside an open window', () => {
  const STORE: StoreCapabilities = {
    siteId: 'gatedstore', name: 'Gated Store', domains: [HOST],
    rateLimit: { domain: HOST, baseDelayMs: 0, minDelayMs: 0, maxDelayMs: 100, backoffMultiplier: 2, recoveryDivisor: 2, successThreshold: 3 },
    requiresBrowser: false, allowedCookies: [],
    retrieval: {
      bySearch: { urlTemplate: `https://${HOST}/search?q={q}`, scope: 'listed' },
      byListing: { urlTemplate: `https://${HOST}/new?page={page}`, order: 'newest' },
      seedLists: [{ id: 'featured', url: `https://${HOST}/featured`, cadence: 'weekly' }],
      rotatingSeedLists: [{ id: 'maker-1', url: `https://${HOST}/search?maker=1`, group: 'maker-1', order: 1 }],
    },
  };
  const listing: ListingPage = { items: [{ itemId: '11' }], hasMore: false };
  const rs = {
    siteId: 'gatedstore', version: '1', extract: jest.fn(), validate: jest.fn(),
    extractCandidates: () => [], extractListing: () => listing, extractSeedList: () => listing,
  } as unknown as ExtractionRuleset;
  type Fetched = string | { body: string; status?: number };
  /** One status-aware lane for every site, as wireServices wires it. */
  const wire = (answer: () => Fetched, cd: ChallengeCooldown, store: ReturnType<typeof fakeStore>): CatalogServices => ({
    profiles: buildProfileRegistry([STORE]),
    getRulesetForUrl: () => rs,
    fetchSearch: async () => { const f = answer(); return typeof f === 'string' ? f : f.body; },
    fetchSearchDetail: async () => answer(),
    challengeCooldown: cd,
    cfCookieStore: store as unknown as CatalogServices['cfCookieStore'],
  });

  it.each([
    ['an EMPTY 200 (status-aware lane)', { status: 200, body: '' } as Fetched, 'HTTP 200 with an empty body'],
    ['an empty body on a status-blind lane', '' as Fetched, 'no status with an empty body'],
  ])('rotating seed: %s from a gated host is `failed` + `transient`, never `blocked`', async (_shape, fetched, tail) => {
    const cd = new ChallengeCooldown({ now: () => 1, windowMs: MIN, gateFailureThreshold: 99 });
    const cat = assembleCatalog(wire(() => fetched, cd, fakeStore([HOST])));

    const rotating = await cat.rotatingSeed('gatedstore', 'maker-1');
    expect(rotating).toEqual({ status: 'failed', siteId: 'gatedstore', reason: `gate failure via http transport: ${tail}`, failure: 'transient' });
    expect(rotating).not.toHaveProperty('blocked');
    // The seed axis reports the same failure without a class (SeedResult has none).
    expect(await cat.seed('gatedstore', 'featured')).toEqual({ status: 'failed', siteId: 'gatedstore', reason: `gate failure via http transport: ${tail}` });
    expect(cd.gateFailureCount(HOST)).toBe(2);
  });

  const SITES: [string, (s: CatalogServices) => Promise<unknown>][] = [
    ['/lookup search', (s) => assembleLookup(s).lookup('marin')],
    ['/catalog listing', (s) => assembleCatalog(s).catalog('gatedstore', 1)],
    ['/catalog seed', (s) => assembleCatalog(s).seed('gatedstore', 'featured')],
    ['/catalog rotating seed', (s) => assembleCatalog(s).rotatingSeed('gatedstore', 'maker-1')],
  ];

  it.each(SITES)('%s: a clean 200 that lands after the window opened in flight never marks FRESH (the window stays)', async (_site, run) => {
    const cd = new ChallengeCooldown({ now: () => 1, windowMs: MIN, gateFailureThreshold: 5 });
    const store = fakeStore([HOST]);
    await run(wire(() => {
      cd.open(HOST, 'opened by the ingest queue while this fetch was in flight');
      return { status: 200, body: '<html>real page</html>' };
    }, cd, store));

    expect({ fresh: store.markFresh.mock.calls.length, open: cd.isOpen(HOST) }).toEqual({ fresh: 0, open: true });
  });

  it.each(SITES)('%s: the same clean 200 with the window closed still marks FRESH (control)', async (_site, run) => {
    const cd = new ChallengeCooldown({ now: () => 1, windowMs: MIN, gateFailureThreshold: 5 });
    const store = fakeStore([HOST]);
    await run(wire(() => ({ status: 200, body: '<html>real page</html>' }), cd, store));

    expect({ fresh: store.markFresh.mock.calls.length, open: cd.isOpen(HOST) }).toEqual({ fresh: 1, open: false });
  });
});
