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

  const services = (body: string, cd: ChallengeCooldown, store: ReturnType<typeof fakeStore>, caps: StoreCapabilities = STORE): LookupServices => ({
    profiles: buildProfileRegistry([caps]),
    getRulesetForUrl: () => rs,
    fetchSearch: jest.fn(async () => body),
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

  it('a real search body still marks FRESH and resets the run', async () => {
    const cd = new ChallengeCooldown({ now: () => 1, windowMs: MIN, gateFailureThreshold: 5 });
    cd.recordGateFailure(HOST, 'r');
    const store = fakeStore([HOST]);
    await assembleLookup(services('{"products":[]}', cd, store)).lookup('marin');

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

  it('listing page: a real body still marks FRESH and resets the run', async () => {
    const cd = new ChallengeCooldown({ now: () => 1, windowMs: MIN });
    cd.recordGateFailure(HOST, 'r');
    const store = fakeStore([HOST]);
    await assembleCatalog(services('<html>list</html>', cd, store)).catalog('gatedstore', 1);

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
    await assembleCatalog(services('<html>seed</html>', cd, cleanStore)).seed('gatedstore', 'featured');
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
