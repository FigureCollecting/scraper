/**
 * assembleCatalog().rotatingSeedLists / .rotatingSeed — the axis behind `GET /catalog/rotating`. Never on
 * the seed axis; rides the listing lane; a failure says deterministic or transient, and whether it is blocked.
 */
import { assembleCatalog, type CatalogServices } from '../../driver/assembleCatalog';
import { ProfileRegistry } from '../../driver/profileRegistry';
import { ChallengeCooldown } from '../../services/challengeCooldown';
import type { ExtractionRuleset, ListingPage, StoreCapabilities } from '@figurecollecting/scraper-plugin-contract';

const NOW = 1_000_000;

const ROTATING = [
  { id: 'maker-1-d9', url: 'https://example.test/search?maker=1&d=9', group: 'maker-1', order: 1 },
  { id: 'maker-1-d1', url: 'https://example.test/search?maker=1&d=1', group: 'maker-1', order: 1 },
  { id: 'maker-2-d9', url: 'https://example.test/search?maker=2&d=9', group: 'maker-2', order: 2 },
];

const STORE: StoreCapabilities = {
  siteId: 'examplestore',
  name: 'Example Store',
  domains: ['example.test'],
  rateLimit: { domain: 'example.test', baseDelayMs: 0, minDelayMs: 0, maxDelayMs: 100, backoffMultiplier: 2, recoveryDivisor: 2, successThreshold: 3 },
  requiresBrowser: false,
  allowedCookies: [],
  retrieval: {
    byId: { urlTemplate: 'https://example.test/item/{id}', idKind: 'store-internal' },
    seedLists: [{ id: 'featured', url: 'https://example.test/featured', cadence: 'weekly' }],
    rotatingSeedLists: ROTATING,
  },
};

/** A store that declares ONLY rotating lists. */
const ROTATING_ONLY: StoreCapabilities = {
  ...STORE,
  siteId: 'rotonly',
  retrieval: { byId: { urlTemplate: 'https://example.test/item/{id}' }, rotatingSeedLists: [ROTATING[0]] },
};

const ruleset = (page: ListingPage | ((body: string, listId: string) => ListingPage | Promise<ListingPage>)): ExtractionRuleset =>
  ({
    siteId: 'examplestore',
    version: '1.0',
    extract: jest.fn(),
    validate: jest.fn(),
    extractSeedList: typeof page === 'function' ? jest.fn(page) : jest.fn(() => page),
  }) as unknown as ExtractionRuleset;

interface Opts {
  stores?: StoreCapabilities[];
  ruleset?: ExtractionRuleset | undefined;
  body?: string | (() => Promise<string>);
  detail?: () => Promise<string | { body: string; status?: number }>;
  cooldown?: ChallengeCooldown;
  cfCookieStore?: CatalogServices['cfCookieStore'];
}

const services = (opts: Opts = {}): CatalogServices => {
  const profiles = new ProfileRegistry();
  for (const s of opts.stores ?? [STORE]) profiles.register(s);
  const body = opts.body ?? '<html>list</html>';
  return {
    profiles,
    getRulesetForUrl: jest.fn(() => ('ruleset' in opts ? opts.ruleset : ruleset({ items: [{ itemId: '11' }, { itemId: '12' }], hasMore: true }))),
    fetchSearch: jest.fn(typeof body === 'function' ? body : async () => body),
    ...(opts.detail ? { fetchSearchDetail: jest.fn(opts.detail) } : {}),
    challengeCooldown: opts.cooldown ?? new ChallengeCooldown({ now: () => NOW, windowMs: 30 * 60_000 }),
    ...(opts.cfCookieStore ? { cfCookieStore: opts.cfCookieStore } : {}),
  };
};

const CF_CHALLENGE = '<title>Just a moment...</title><script>window._cf_chl_opt';

describe('assembleCatalog — rotatingSeedLists (discovery)', () => {
  it('lists the declared rotating lists in DECLARED order with id, url, group and order, fetching nothing', () => {
    const svc = services();
    const out = assembleCatalog(svc).rotatingSeedLists('examplestore');
    expect(out).toEqual({ status: 'ok', siteId: 'examplestore', rotatingSeedLists: ROTATING, count: 3 });
    expect(svc.fetchSearch).not.toHaveBeenCalled();
  });

  it('the SEED axis never lists a rotating list, and a store declaring only rotating lists has no seed lists', () => {
    const cat = assembleCatalog(services({ stores: [STORE, ROTATING_ONLY] }));
    const seeds = cat.seedLists('examplestore');
    expect(seeds).toMatchObject({ status: 'ok', count: 1 });
    expect(seeds.status === 'ok' && seeds.seedLists.map((l) => l.id)).toEqual(['featured']);
    expect(cat.seedLists('rotonly')).toEqual({ status: 'unsupported', siteId: 'rotonly', reason: 'store declares no seed lists' });
  });

  it('drops malformed, repeated and seed-colliding entries and keeps the well-formed ones', () => {
    const store: StoreCapabilities = {
      ...STORE,
      retrieval: {
        seedLists: [{ id: 'featured', url: 'https://example.test/featured', cadence: 'weekly' }],
        rotatingSeedLists: [
          null,
          'maker-1',
          { id: '', url: 'https://example.test/a', group: 'g', order: 1 },
          { id: 'no-url', url: '', group: 'g', order: 1 },
          { id: 'no-group', url: 'https://example.test/b', group: '', order: 1 },
          { id: 'nan-order', url: 'https://example.test/c', group: 'g', order: Number.NaN },
          { id: 'str-order', url: 'https://example.test/d', group: 'g', order: '1' },
          { id: 'featured', url: 'https://example.test/e', group: 'g', order: 1 },
          ROTATING[0],
          { ...ROTATING[0], url: 'https://example.test/dup' },
        ] as unknown as StoreCapabilities['retrieval'] extends infer R ? R extends { rotatingSeedLists?: infer L } ? L : never : never,
      },
    };
    const out = assembleCatalog(services({ stores: [store] })).rotatingSeedLists('examplestore');
    expect(out).toEqual({ status: 'ok', siteId: 'examplestore', rotatingSeedLists: [ROTATING[0]], count: 1 });
  });

  it('unsupported for an unknown store and for a store with no (usable) rotating lists', () => {
    const noLists: StoreCapabilities = { ...STORE, siteId: 'none', retrieval: { seedLists: STORE.retrieval!.seedLists } };
    const cat = assembleCatalog(services({ stores: [STORE, noLists] }));
    expect(cat.rotatingSeedLists('ghost')).toEqual({ status: 'unsupported', siteId: 'ghost', reason: 'unknown store' });
    expect(cat.rotatingSeedLists('none')).toEqual({ status: 'unsupported', siteId: 'none', reason: 'store declares no rotating seed lists' });
  });
});

describe('assembleCatalog — rotatingSeed (one fetch)', () => {
  it('fetches the declared url on the store transport, parses it with extractSeedList(body, listId), and never claims a next page', async () => {
    const rs = ruleset({ items: [{ itemId: '11' }, { itemId: '12' }, { itemId: '' } as never], hasMore: true, nextPage: 2 });
    const svc = services({ ruleset: rs, body: '<html>maker-1 distributor</html>' });
    const out = await assembleCatalog(svc).rotatingSeed('examplestore', 'maker-1-d9');
    expect(out).toEqual({
      status: 'ok',
      siteId: 'examplestore',
      listId: 'maker-1-d9',
      group: 'maker-1',
      url: ROTATING[0].url,
      items: [
        { itemId: '11', collectUrl: 'https://example.test/item/11' },
        { itemId: '12', collectUrl: 'https://example.test/item/12' },
      ],
      collectUrls: ['https://example.test/item/11', 'https://example.test/item/12'],
      hasMore: false,
      count: 2,
    });
    expect(svc.fetchSearch).toHaveBeenCalledWith(ROTATING[0].url, expect.any(Object));
    expect(rs.extractSeedList).toHaveBeenCalledWith('<html>maker-1 distributor</html>', 'maker-1-d9');
  });

  it('the SEED axis never fetches a rotating list, and the rotating axis never fetches a seed list', async () => {
    const svc = services();
    const cat = assembleCatalog(svc);
    expect(await cat.seed('examplestore', 'maker-1-d9')).toEqual({
      status: 'unsupported',
      siteId: 'examplestore',
      reason: 'store declares no seed list "maker-1-d9"',
    });
    expect(await cat.rotatingSeed('examplestore', 'featured')).toEqual({
      status: 'unsupported',
      siteId: 'examplestore',
      reason: 'store declares no rotating seed list "featured"',
    });
    expect(svc.fetchSearch).not.toHaveBeenCalled();
  });

  it('unsupported, with no fetch, for an unknown store, a store with no rotating lists, no parser, or a malformed url', async () => {
    const badUrl: StoreCapabilities = { ...STORE, siteId: 'badurl', retrieval: { rotatingSeedLists: [{ id: 'x', url: 'not a url', group: 'g', order: 1 }] } };
    const svc = services({ stores: [STORE, badUrl, { ...STORE, siteId: 'none', retrieval: {} }] });
    const cat = assembleCatalog(svc);
    expect(await cat.rotatingSeed('ghost', 'x')).toMatchObject({ status: 'unsupported', reason: 'unknown store' });
    expect(await cat.rotatingSeed('none', 'x')).toMatchObject({ status: 'unsupported', reason: 'store declares no rotating seed lists' });
    expect(await cat.rotatingSeed('badurl', 'x')).toMatchObject({ status: 'unsupported', reason: 'malformed rotating seed list url' });
    const noParser = assembleCatalog(services({ ruleset: { siteId: 'x', version: '1', extract: jest.fn(), validate: jest.fn() } as unknown as ExtractionRuleset }));
    expect(await noParser.rotatingSeed('examplestore', 'maker-1-d9')).toMatchObject({ status: 'unsupported', reason: 'ruleset has no extractSeedList parser' });
    expect(svc.fetchSearch).not.toHaveBeenCalled();
  });

  it('a cooling host is skipped WITHOUT fetching', async () => {
    const cooldown = new ChallengeCooldown({ now: () => NOW, windowMs: 30 * 60_000 });
    cooldown.open('example.test', 'earlier challenge');
    const svc = services({ cooldown });
    const out = await assembleCatalog(svc).rotatingSeed('examplestore', 'maker-1-d9');
    expect(out).toMatchObject({ status: 'cooldown', siteId: 'examplestore', host: 'example.test' });
    expect(svc.fetchSearch).not.toHaveBeenCalled();
  });

  it('a challenge page is a DETERMINISTIC, BLOCKING failure: the host cools and a stored cookie is marked stale', async () => {
    const cooldown = new ChallengeCooldown({ now: () => NOW, windowMs: 30 * 60_000 });
    const cfCookieStore = { cookiesFor: jest.fn(() => ({ cf_clearance: 'x' })), markStale: jest.fn(() => true), markFresh: jest.fn(() => true) };
    const svc = services({ body: CF_CHALLENGE, cooldown, cfCookieStore: cfCookieStore as unknown as CatalogServices['cfCookieStore'] });
    const out = await assembleCatalog(svc).rotatingSeed('examplestore', 'maker-1-d9');
    expect(out).toEqual({ status: 'failed', siteId: 'examplestore', reason: 'challenge page', failure: 'deterministic', blocked: true });
    expect(cooldown.isOpen('example.test')).toBe(true);
    expect(cfCookieStore.markStale).toHaveBeenCalled();
  });

  it('a parser throw is DETERMINISTIC and not blocking; a clean body marks a stored cookie fresh', async () => {
    const cfCookieStore = { cookiesFor: jest.fn(() => ({ cf_clearance: 'x' })), markStale: jest.fn(() => true), markFresh: jest.fn(() => true) };
    const rs = ruleset(() => {
      throw new Error('company filter not proven');
    });
    const out = await assembleCatalog(services({ ruleset: rs, cfCookieStore: cfCookieStore as unknown as CatalogServices['cfCookieStore'] })).rotatingSeed(
      'examplestore',
      'maker-1-d9',
    );
    expect(out).toEqual({ status: 'failed', siteId: 'examplestore', reason: 'company filter not proven', failure: 'deterministic' });
    expect(cfCookieStore.markFresh).toHaveBeenCalled();
  });

  it('a fetch that throws or times out is TRANSIENT', async () => {
    const thrown = await assembleCatalog(
      services({
        body: async () => {
          throw new Error('socket hang up');
        },
      }),
    ).rotatingSeed('examplestore', 'maker-1-d9');
    expect(thrown).toEqual({ status: 'failed', siteId: 'examplestore', reason: 'socket hang up', failure: 'transient' });

    const prev = process.env.CATALOG_STORE_TIMEOUT_MS;
    process.env.CATALOG_STORE_TIMEOUT_MS = '1000';
    jest.useFakeTimers();
    try {
      const pending = assembleCatalog(services({ body: () => new Promise<string>(() => {}) })).rotatingSeed('examplestore', 'maker-1-d9');
      await jest.advanceTimersByTimeAsync(1001);
      expect(await pending).toMatchObject({ status: 'failed', failure: 'transient', reason: expect.stringContaining('timed out') });
    } finally {
      jest.useRealTimers();
      if (prev === undefined) delete process.env.CATALOG_STORE_TIMEOUT_MS;
      else process.env.CATALOG_STORE_TIMEOUT_MS = prev;
    }
  });

  it('reads the STORE status when the status-aware fetch is wired: 4xx deterministic, 5xx transient, 403 and 429 blocking', async () => {
    const at = async (status: number) =>
      assembleCatalog(services({ detail: async () => ({ body: '<html>error</html>', status }) })).rotatingSeed('examplestore', 'maker-1-d9');
    const failed = { status: 'failed', siteId: 'examplestore' };
    expect(await at(404)).toEqual({ ...failed, reason: 'store answered 404', failure: 'deterministic', upstreamStatus: 404 });
    expect(await at(403)).toEqual({ ...failed, reason: 'store answered 403', failure: 'deterministic', blocked: true, upstreamStatus: 403 });
    expect(await at(429)).toEqual({ ...failed, reason: 'store answered 429', failure: 'transient', blocked: true, upstreamStatus: 429 });
    expect(await at(503)).toEqual({ ...failed, reason: 'store answered 503', failure: 'transient', upstreamStatus: 503 });
  });

  it('the status-aware fetch is preferred over the body fetch; a 200 or an absent status parses as usual', async () => {
    const svc = services({ detail: async () => ({ body: '<html>ok</html>', status: 200 }) });
    expect(await assembleCatalog(svc).rotatingSeed('examplestore', 'maker-1-d9')).toMatchObject({ status: 'ok', count: 2 });
    expect(svc.fetchSearch).not.toHaveBeenCalled();
    expect(await assembleCatalog(services({ detail: async () => '<html>bare</html>' })).rotatingSeed('examplestore', 'maker-1-d9')).toMatchObject({
      status: 'ok',
      count: 2,
    });
  });

  it('a challenge served WITH a 403 is the challenge: cooldown opened, deterministic and blocking', async () => {
    const cooldown = new ChallengeCooldown({ now: () => NOW, windowMs: 30 * 60_000 });
    const out = await assembleCatalog(services({ cooldown, detail: async () => ({ body: CF_CHALLENGE, status: 403 }) })).rotatingSeed(
      'examplestore',
      'maker-1-d9',
    );
    expect(out).toMatchObject({ status: 'failed', reason: 'challenge page', failure: 'deterministic', blocked: true });
    expect(cooldown.isOpen('example.test')).toBe(true);
  });

  it('a thrown non-Error is still classified, and a store with no domains keys its transport on the page host', async () => {
    const svcThrow = services({
      body: async () => {
        throw 'proxy refused';
      },
    });
    expect(await assembleCatalog(svcThrow).rotatingSeed('examplestore', 'maker-1-d9')).toMatchObject({ reason: 'proxy refused', failure: 'transient' });
    const rs = ruleset(() => {
      throw 'no rows';
    });
    expect(await assembleCatalog(services({ ruleset: rs })).rotatingSeed('examplestore', 'maker-1-d9')).toMatchObject({ reason: 'no rows', failure: 'deterministic' });
    const bare = assembleCatalog(services({ stores: [{ ...STORE, domains: [] }] }));
    expect(await bare.rotatingSeed('examplestore', 'maker-1-d9')).toMatchObject({ status: 'ok' });
  });

  it('a challenge on a store with a declared transport marks the cookie stale on THAT lane', async () => {
    const cfCookieStore = { cookiesFor: jest.fn(() => ({ cf_clearance: 'x' })), markStale: jest.fn(() => true), markFresh: jest.fn(() => true) };
    const imp: StoreCapabilities = { ...STORE, searchFetch: { transport: 'impersonate', browser: 'chrome142' } };
    const svc = services({ stores: [imp], body: CF_CHALLENGE, cfCookieStore: cfCookieStore as unknown as CatalogServices['cfCookieStore'] });
    await assembleCatalog(svc).rotatingSeed('examplestore', 'maker-1-d9');
    expect(cfCookieStore.markStale).toHaveBeenCalledWith('example.test', 'impersonate', 'rotating seed list challenge page');
    // A searchFetch that names no transport is the plain http lane.
    const unnamed: StoreCapabilities = { ...STORE, searchFetch: { headers: { accept: 'text/html' } } as StoreCapabilities['searchFetch'] };
    await assembleCatalog(services({ stores: [unnamed], body: CF_CHALLENGE, cfCookieStore: cfCookieStore as unknown as CatalogServices['cfCookieStore'] })).rotatingSeed(
      'examplestore',
      'maker-1-d9',
    );
    expect(cfCookieStore.markStale).toHaveBeenLastCalledWith('example.test', 'http', 'rotating seed list challenge page');
  });

  it('a non-object parser result yields no items rather than a crash', async () => {
    const out = await assembleCatalog(services({ ruleset: ruleset((() => 'nonsense') as never) })).rotatingSeed('examplestore', 'maker-1-d9');
    expect(out).toMatchObject({ status: 'ok', items: [], count: 0 });
  });
});
