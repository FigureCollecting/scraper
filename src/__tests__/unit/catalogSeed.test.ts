/**
 * assembleCatalog().seed / .seedLists — the DECLARED SEED LIST axis behind
 * `GET /catalog?store=&seed=<listId>` and its discovery sibling `GET /catalog?store=&seeds=1`.
 *
 * A seed list is ONE declared, URL-addressable page (contract 0.9.0 `retrieval.seedLists`), fetched
 * through EXACTLY the lane the listing axis uses — the store's declared search transport, under the
 * same per-host challenge cooldown, with the same challenge detection and the same stored-cookie
 * stale/fresh signals — and parsed by the ruleset's `extractSeedList`. `hasMore` is always false:
 * there is no next page on this axis, so nothing may be walked.
 */
import { assembleCatalog, type CatalogServices } from '../../driver/assembleCatalog';
import { ProfileRegistry } from '../../driver/profileRegistry';
import { ChallengeCooldown } from '../../services/challengeCooldown';
import type { ExtractionRuleset, ListingPage, StoreCapabilities } from '@figurecollecting/scraper-plugin-contract';

const NOW = 1_000_000;

const STORE: StoreCapabilities = {
  siteId: 'examplestore',
  name: 'Example Store',
  domains: ['example.test'],
  rateLimit: { domain: 'example.test', baseDelayMs: 0, minDelayMs: 0, maxDelayMs: 100, backoffMultiplier: 2, recoveryDivisor: 2, successThreshold: 3 },
  requiresBrowser: false,
  allowedCookies: [],
  retrieval: {
    byId: { urlTemplate: 'https://example.test/item/{id}', idKind: 'store-internal' },
    seedLists: [
      { id: 'new-arrivals', url: 'https://example.test/new', cadence: 'daily', note: 'front shelf' },
      { id: 'staff-picks', url: 'https://example.test/picks', cadence: 'weekly' },
    ],
  },
};

/** A store with seed lists but NO byId axis — collectUrl must then come from the item's page link. */
const LINK_STORE: StoreCapabilities = {
  ...STORE,
  siteId: 'linkstore',
  retrieval: { seedLists: [{ id: 'shelf', url: 'https://example.test/shelf', cadence: 'weekly' }] },
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
  cooldown?: ChallengeCooldown;
  cfCookieStore?: CatalogServices['cfCookieStore'];
}

const services = (opts: Opts = {}): CatalogServices => {
  const profiles = new ProfileRegistry();
  for (const s of opts.stores ?? [STORE]) profiles.register(s);
  const body = opts.body ?? '<html>seed</html>';
  return {
    profiles,
    getRulesetForUrl: jest.fn(() => ('ruleset' in opts ? opts.ruleset : ruleset({ items: [{ itemId: '11' }, { itemId: '12' }] }))),
    fetchSearch: jest.fn(typeof body === 'function' ? body : async () => body),
    challengeCooldown: opts.cooldown ?? new ChallengeCooldown({ now: () => NOW, windowMs: 30 * 60_000 }),
    ...(opts.cfCookieStore ? { cfCookieStore: opts.cfCookieStore } : {}),
  };
};

describe('assembleCatalog — seedLists (discovery)', () => {
  it('lists the store\'s declared seed lists in DECLARED order, without fetching anything', () => {
    const svc = services();
    const out = assembleCatalog(svc).seedLists('examplestore');

    expect(out).toEqual({
      status: 'ok',
      siteId: 'examplestore',
      seedLists: [
        { id: 'new-arrivals', url: 'https://example.test/new', cadence: 'daily', note: 'front shelf' },
        { id: 'staff-picks', url: 'https://example.test/picks', cadence: 'weekly' },
      ],
      count: 2,
    });
    expect(svc.fetchSearch).not.toHaveBeenCalled();
  });

  it('reports each list\'s url, so a poller can see when two ids resolve to the SAME page', () => {
    const twins = {
      ...STORE,
      siteId: 'twins',
      retrieval: {
        seedLists: [
          { id: 'new-arrivals', url: 'https://example.test/shelf', cadence: 'daily' },
          { id: 'front-shelf', url: 'https://example.test/shelf', cadence: 'weekly' },
        ],
      },
    } as unknown as StoreCapabilities;
    const out = assembleCatalog(services({ stores: [twins] })).seedLists('twins');

    // Both ids survive here: collapsing them is the CALLER's call (it credits both), not the
    // engine's, which would otherwise make the second id unaddressable.
    expect(out).toMatchObject({
      status: 'ok',
      seedLists: [
        { id: 'new-arrivals', url: 'https://example.test/shelf' },
        { id: 'front-shelf', url: 'https://example.test/shelf' },
      ],
    });
  });

  it('unsupported for an unknown store', () => {
    expect(assembleCatalog(services()).seedLists('nosuch')).toEqual({ status: 'unsupported', siteId: 'nosuch', reason: 'unknown store' });
  });

  it('unsupported for a store that declares no seed lists (and for an empty declaration)', () => {
    const bare: StoreCapabilities = { ...STORE, siteId: 'bare', retrieval: { byRange: true } };
    const empty: StoreCapabilities = { ...STORE, siteId: 'empty', retrieval: { seedLists: [] } };
    const cat = assembleCatalog(services({ stores: [bare, empty] }));
    expect(cat.seedLists('bare')).toEqual({ status: 'unsupported', siteId: 'bare', reason: 'store declares no seed lists' });
    expect(cat.seedLists('empty')).toEqual({ status: 'unsupported', siteId: 'empty', reason: 'store declares no seed lists' });
  });

  it('drops malformed entries from an UNTRUSTED declaration and keeps the well-formed ones', () => {
    const messy = {
      ...STORE,
      siteId: 'messy',
      retrieval: {
        seedLists: [
          { id: 'good', url: 'https://example.test/good', cadence: 'weekly' },
          { id: '', url: 'https://example.test/blank', cadence: 'weekly' },
          { id: 'nourl', cadence: 'weekly' },
          { id: 'badcadence', url: 'https://example.test/x', cadence: 'hourly' },
          'not-an-object',
          null,
          { id: 'good', url: 'https://example.test/dupe', cadence: 'daily' },
        ],
      },
    } as unknown as StoreCapabilities;
    const out = assembleCatalog(services({ stores: [messy] })).seedLists('messy');
    expect(out).toEqual({ status: 'ok', siteId: 'messy', seedLists: [{ id: 'good', url: 'https://example.test/good', cadence: 'weekly' }], count: 1 });
  });
});

describe('assembleCatalog — seed (fetch one declared list)', () => {
  it('fetches the DECLARED url through the store\'s lane and returns the parsed page with hasMore false', async () => {
    const rs = ruleset({ items: [{ itemId: '11' }, { itemId: '12' }] });
    const svc = services({ ruleset: rs });
    const out = await assembleCatalog(svc).seed('examplestore', 'new-arrivals');

    expect(out).toEqual({
      status: 'ok',
      siteId: 'examplestore',
      listId: 'new-arrivals',
      url: 'https://example.test/new',
      items: [
        { itemId: '11', collectUrl: 'https://example.test/item/11' },
        { itemId: '12', collectUrl: 'https://example.test/item/12' },
      ],
      collectUrls: ['https://example.test/item/11', 'https://example.test/item/12'],
      hasMore: false,
      count: 2,
    });
    expect(svc.fetchSearch).toHaveBeenCalledTimes(1);
    expect((svc.fetchSearch as jest.Mock).mock.calls[0][0]).toBe('https://example.test/new');
    expect(rs.extractSeedList).toHaveBeenCalledWith('<html>seed</html>', 'new-arrivals');
  });

  it('inherits the store\'s DECLARED lane: the same searchTransportFor the listing axis uses', async () => {
    const svc = services();
    const spy = jest.spyOn(svc.profiles, 'searchTransportFor');
    await assembleCatalog(svc).seed('examplestore', 'new-arrivals');

    expect(spy).toHaveBeenCalledWith('example.test');
    expect((svc.fetchSearch as jest.Mock).mock.calls[0][1]).toEqual(svc.profiles.searchTransportFor('example.test'));
  });

  it('addresses the SECOND declared list by its own id and url', async () => {
    const svc = services();
    const out = await assembleCatalog(svc).seed('examplestore', 'staff-picks');
    expect(out).toMatchObject({ status: 'ok', listId: 'staff-picks', url: 'https://example.test/picks' });
  });

  it('a parser that claims hasMore/nextPage is IGNORED — a seed list is one page, never a walk', async () => {
    const svc = services({ ruleset: ruleset({ items: [{ itemId: '11' }], hasMore: true, nextPage: 2 } as ListingPage) });
    const out = await assembleCatalog(svc).seed('examplestore', 'new-arrivals');
    expect(out).toMatchObject({ status: 'ok', hasMore: false });
    expect(out).not.toHaveProperty('nextPage');
  });

  it('absolutizes an item page link against the declared url for a store with no byId axis', async () => {
    const svc = services({
      stores: [LINK_STORE],
      ruleset: ruleset({ items: [{ itemId: 'slug-2', url: '/products/slug-2' }, { itemId: 'nolink' }] }),
    });
    const out = await assembleCatalog(svc).seed('linkstore', 'shelf');
    expect(out).toMatchObject({
      status: 'ok',
      items: [
        { itemId: 'slug-2', url: '/products/slug-2', collectUrl: 'https://example.test/products/slug-2' },
        { itemId: 'nolink' },
      ],
      collectUrls: ['https://example.test/products/slug-2'],
      count: 2,
    });
  });

  it('guards UNTRUSTED parser output: non-object page, non-array items, and items without a string itemId', async () => {
    const cases: unknown[] = [null, 'a string', { items: 'nope' }, { items: [null, { itemId: '' }, { itemId: 7 }, { itemId: 'ok' }] }];
    for (const [i, page] of cases.entries()) {
      const svc = services({ ruleset: ruleset(() => page as ListingPage) });
      const out = await assembleCatalog(svc).seed('examplestore', 'new-arrivals');
      expect(out).toMatchObject({ status: 'ok', count: i === 3 ? 1 : 0, hasMore: false });
    }
  });

  it('422-shaped `unsupported` for an unknown store, an undeclared list id, and a store with no seed lists', async () => {
    const bare: StoreCapabilities = { ...STORE, siteId: 'bare', retrieval: { byRange: true } };
    const cat = assembleCatalog(services({ stores: [STORE, bare] }));
    await expect(cat.seed('nosuch', 'x')).resolves.toEqual({ status: 'unsupported', siteId: 'nosuch', reason: 'unknown store' });
    await expect(cat.seed('bare', 'x')).resolves.toEqual({ status: 'unsupported', siteId: 'bare', reason: 'store declares no seed lists' });
    await expect(cat.seed('examplestore', 'nope')).resolves.toEqual({
      status: 'unsupported',
      siteId: 'examplestore',
      reason: 'store declares no seed list "nope"',
    });
  });

  it('unsupported when the ruleset has no extractSeedList parser', async () => {
    const svc = services({ ruleset: { siteId: 'examplestore', version: '1', extract: jest.fn(), validate: jest.fn() } as unknown as ExtractionRuleset });
    await expect(assembleCatalog(svc).seed('examplestore', 'new-arrivals')).resolves.toEqual({
      status: 'unsupported',
      siteId: 'examplestore',
      reason: 'ruleset has no extractSeedList parser',
    });
    expect(svc.fetchSearch).not.toHaveBeenCalled();
  });

  it('unsupported when the declared url is malformed — nothing is fetched', async () => {
    const bad: StoreCapabilities = { ...STORE, siteId: 'badurl', retrieval: { seedLists: [{ id: 'a', url: 'not a url', cadence: 'weekly' }] } };
    const svc = services({ stores: [bad] });
    await expect(assembleCatalog(svc).seed('badurl', 'a')).resolves.toEqual({
      status: 'unsupported',
      siteId: 'badurl',
      reason: 'malformed seed list url',
    });
    expect(svc.fetchSearch).not.toHaveBeenCalled();
  });

  it('COOLDOWN: a cooling host is skipped WITHOUT fetching, exactly like the listing axis', async () => {
    const cd = new ChallengeCooldown({ now: () => NOW, windowMs: 30 * 60_000 });
    cd.open('example.test', 'test');
    const svc = services({ cooldown: cd });
    const out = await assembleCatalog(svc).seed('examplestore', 'new-arrivals');

    expect(out).toEqual({ status: 'cooldown', siteId: 'examplestore', host: 'example.test', remainingMs: cd.remaining('example.test') });
    expect(svc.fetchSearch).not.toHaveBeenCalled();
  });

  it('a CHALLENGE body fails the fetch, opens the host cooldown and never reaches the parser', async () => {
    const cd = new ChallengeCooldown({ now: () => NOW, windowMs: 30 * 60_000 });
    const rs = ruleset({ items: [{ itemId: '11' }] });
    const svc = services({ cooldown: cd, ruleset: rs, body: '<title>Just a moment...</title><script>window._cf_chl_opt' });
    const out = await assembleCatalog(svc).seed('examplestore', 'new-arrivals');

    expect(out).toEqual({ status: 'failed', siteId: 'examplestore', reason: 'challenge page' });
    expect(cd.isOpen('example.test')).toBe(true);
    expect(rs.extractSeedList).not.toHaveBeenCalled();
  });

  it('marks a STORED cookie stale on a challenge and fresh on a clean body', async () => {
    const store = {
      cookiesFor: jest.fn(() => 'cf_clearance=x'),
      markStale: jest.fn(() => true),
      markFresh: jest.fn(() => true),
    } as unknown as NonNullable<CatalogServices['cfCookieStore']>;
    const challenged = services({ cfCookieStore: store, body: '<title>Just a moment...</title><script>window._cf_chl_opt' });
    await assembleCatalog(challenged).seed('examplestore', 'new-arrivals');
    expect(store.markStale).toHaveBeenCalled();

    const clean = services({ cfCookieStore: store });
    await assembleCatalog(clean).seed('examplestore', 'new-arrivals');
    expect(store.markFresh).toHaveBeenCalled();
  });

  it('a fetch error is `failed`, never a throw', async () => {
    const svc = services({ body: async () => { throw new Error('socket hang up'); } });
    await expect(assembleCatalog(svc).seed('examplestore', 'new-arrivals')).resolves.toEqual({
      status: 'failed',
      siteId: 'examplestore',
      reason: 'socket hang up',
    });
  });

  it('a parser throw is `failed`, never a throw', async () => {
    const svc = services({ ruleset: ruleset(() => { throw new Error('bad selector'); }) });
    await expect(assembleCatalog(svc).seed('examplestore', 'new-arrivals')).resolves.toMatchObject({ status: 'failed', reason: 'bad selector' });
  });
});
