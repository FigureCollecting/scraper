/**
 * assembleCatalog — the newest-first CATALOG LISTING runtime (the crawler's enumeration feed):
 * `catalog(siteId, page)` resolves the store's `byListing` page url, fetches it through the store's
 * search transport under the challenge-cooldown gate, parses it via the ruleset's `extractListing`,
 * and decorates every listed id with its collect-ready URL. Fakes model the two live shapes: a Woo
 * Store API array with a byId axis (orzgk — numeric ids → byId collectUrls) and a Shopify
 * products.json without one (goodsmileus — handles → absolutized page links).
 */
import { assembleCatalog, resolveCatalogStoreTimeoutMs, type CatalogServices } from '../assembleCatalog';
import { buildProfileRegistry } from '../profileRegistry';
import { ChallengeCooldown } from '../../services/challengeCooldown';
import type { ExtractionRuleset, ListingPage, StoreCapabilities } from '@figurecollecting/scraper-plugin-contract';

const caps = (siteId: string, host: string, retrieval: StoreCapabilities['retrieval'], extra: Partial<StoreCapabilities> = {}): StoreCapabilities => ({
  siteId,
  name: siteId,
  domains: [host],
  rateLimit: { domain: host, baseDelayMs: 0, minDelayMs: 0, maxDelayMs: 100, backoffMultiplier: 2, recoveryDivisor: 2, successThreshold: 3 },
  requiresBrowser: false,
  allowedCookies: [],
  retrieval,
  ...extra,
});

// orzgk: Woo Store API listing (publish-date desc, 100/page) + byId → collectUrl is the byId JSON endpoint.
const ORZGK = caps('orzgk', 'www.orzgk.com', {
  byId: { urlTemplate: 'https://www.orzgk.com/wp-json/wc/store/v1/products/{id}', idKind: 'store-internal' },
  byListing: { urlTemplate: 'https://www.orzgk.com/wp-json/wc/store/v1/products?orderby=date&order=desc&per_page=100&page={page}', maxPerPage: 100, order: 'newest' },
});
// goodsmileus: Shopify products.json (published_at desc, 250/page), NO byId → collectUrl = absolutized handle link.
const GSUS = caps('goodsmileus', 'www.goodsmileus.com', {
  bySearch: { urlTemplate: 'https://www.goodsmileus.com/search?q={q}&type=product', scope: 'listed' },
  byListing: { urlTemplate: 'https://www.goodsmileus.com/products.json?limit=250&page={page}', maxPerPage: 250, order: 'newest' },
});
// cdjapan: byId only — no listing axis.
const CDJAPAN = caps('cdjapan', 'www.cdjapan.co.jp', {
  byId: { urlTemplate: 'https://www.cdjapan.co.jp/product/{id}', idKind: 'store-internal' },
});
// A store whose listing starts at page 3 (pins the pageStart default).
const LATE = caps('late', 'late.test', {
  byListing: { urlTemplate: 'https://late.test/list?page={page}', pageStart: 3, order: 'newest' },
});
// A CF-fronted store whose listing is served from a SIBLING api. host, with an explicit impersonate transport.
const APISTORE = caps(
  'apistore',
  'www.apistore.test',
  { byListing: { urlTemplate: 'https://api.apistore.test/v1/items?sort=newest&page={page}', order: 'newest' } },
  { searchFetch: { transport: 'impersonate', browser: 'chrome142', headers: { 'X-User-Key': 'k' } } },
);

// Real ids from the live-captured fixtures (orzgk page 1 / goodsmileus page 1).
const ORZGK_IDS = [68064530, 68064520, 68064444];
const GSUS_HANDLES = ['noir-black-rabbit-14825', 'magician-s-valkyria-yu-gi-oh-card-game-monster-figure-collection-14776', 'nendoroid-plus-maomao-garden-party-ver-rubber-mascot-62186'];
const ORZGK_PAGE: ListingPage = { items: ORZGK_IDS.map((id) => ({ itemId: String(id) })), hasMore: true, nextPage: 2 };
const GSUS_PAGE: ListingPage = { items: GSUS_HANDLES.map((h) => ({ itemId: h, url: `/products/${h}` })) };

const stub = (siteId: string, extractListing?: ExtractionRuleset['extractListing']): ExtractionRuleset => ({
  siteId,
  version: '1.0.0',
  extract: () => ({ source: { site: siteId, itemId: 'x', extractedAt: '2026-09-06T00:00:00.000Z' }, fields: {}, warnings: [] }),
  validate: () => ({ valid: true, errors: [], warnings: [] }),
  ...(extractListing ? { extractListing } : {}),
});

const build = (over: Partial<CatalogServices> = {}) => {
  const fetchSearch = jest.fn(async () => '[]');
  const services: CatalogServices = {
    profiles: buildProfileRegistry([ORZGK, GSUS, CDJAPAN, LATE, APISTORE]),
    getRulesetForUrl: (url) =>
      url.includes('orzgk') ? stub('orzgk', () => ORZGK_PAGE)
      : url.includes('goodsmileus') ? stub('goodsmileus', () => GSUS_PAGE)
      : url.includes('late.test') ? stub('late', () => ({ items: [{ itemId: 'l1' }] }))
      : url.includes('apistore') ? stub('apistore', () => ({ items: [{ itemId: 'a1' }] }))
      : undefined,
    fetchSearch,
    ...over,
  };
  return { services, fetchSearch, catalog: assembleCatalog(services) };
};

describe('assembleCatalog — unsupported stores (no fetch)', () => {
  it('an unknown siteId → unsupported', async () => {
    const { fetchSearch, catalog } = build();
    const out = await catalog.catalog('nope');
    expect(out).toEqual({ status: 'unsupported', siteId: 'nope', reason: expect.stringContaining('unknown store') });
    expect(fetchSearch).not.toHaveBeenCalled();
  });

  it('a store without a byListing axis → unsupported', async () => {
    const { fetchSearch, catalog } = build();
    const out = await catalog.catalog('cdjapan');
    expect(out).toEqual({ status: 'unsupported', siteId: 'cdjapan', reason: expect.stringContaining('byListing') });
    expect(fetchSearch).not.toHaveBeenCalled();
  });

  it('a byListing template that is not a parseable url → unsupported (a plugin config defect), never fetched', async () => {
    const BROKEN = caps('broken', 'broken.test', { byListing: { urlTemplate: 'http://[bad/?page={page}', order: 'newest' } });
    const { fetchSearch, catalog } = build({ profiles: buildProfileRegistry([BROKEN]), getRulesetForUrl: () => stub('broken', () => ({ items: [] })) });
    expect(await catalog.catalog('broken')).toEqual({ status: 'unsupported', siteId: 'broken', reason: expect.stringContaining('malformed') });
    expect(fetchSearch).not.toHaveBeenCalled();
  });

  it('a byListing store whose ruleset lacks extractListing (or has no ruleset) → unsupported, never fetched', async () => {
    const { fetchSearch, catalog } = build({
      getRulesetForUrl: (url) => (url.includes('orzgk') ? stub('orzgk') : undefined),
    });
    expect(await catalog.catalog('orzgk')).toEqual({ status: 'unsupported', siteId: 'orzgk', reason: expect.stringContaining('extractListing') });
    expect(await catalog.catalog('goodsmileus')).toEqual({ status: 'unsupported', siteId: 'goodsmileus', reason: expect.stringContaining('extractListing') });
    expect(fetchSearch).not.toHaveBeenCalled();
  });
});

describe('assembleCatalog — page resolution + transport', () => {
  it('default page = byListing.pageStart (else 1): the store\'s first page is fetched', async () => {
    const { fetchSearch, catalog } = build();

    const orz = await catalog.catalog('orzgk');
    expect(fetchSearch).toHaveBeenLastCalledWith('https://www.orzgk.com/wp-json/wc/store/v1/products?orderby=date&order=desc&per_page=100&page=1', { transport: 'http' });
    expect(orz).toMatchObject({ status: 'ok', siteId: 'orzgk', page: 1 });

    const late = await catalog.catalog('late');
    expect(fetchSearch).toHaveBeenLastCalledWith('https://late.test/list?page=3', { transport: 'http' });
    expect(late).toMatchObject({ status: 'ok', siteId: 'late', page: 3, url: 'https://late.test/list?page=3' });
  });

  it('an explicit page is substituted into the template and echoed back', async () => {
    const { fetchSearch, catalog } = build();
    const out = await catalog.catalog('goodsmileus', 42);
    expect(fetchSearch).toHaveBeenCalledWith('https://www.goodsmileus.com/products.json?limit=250&page=42', { transport: 'http' });
    expect(out).toMatchObject({ status: 'ok', page: 42, url: 'https://www.goodsmileus.com/products.json?limit=250&page=42' });
  });

  it('a non-positive / non-integer page → failed (never a page=0 fetch)', async () => {
    const { fetchSearch, catalog } = build();
    expect(await catalog.catalog('orzgk', 0)).toMatchObject({ status: 'failed', siteId: 'orzgk', reason: expect.stringContaining('page') });
    expect(await catalog.catalog('orzgk', 2.5)).toMatchObject({ status: 'failed', siteId: 'orzgk' });
    expect(fetchSearch).not.toHaveBeenCalled();
  });

  it('the host is derived from the LISTING url (a sibling api. host), and the fetch rides the STORE\'s declared transport', async () => {
    const cd = new ChallengeCooldown({ now: () => 1000, windowMs: 60_000 });
    const { fetchSearch, catalog } = build({ challengeCooldown: cd });

    const ok = await catalog.catalog('apistore', 2);
    expect(ok).toMatchObject({ status: 'ok', siteId: 'apistore', page: 2, url: 'https://api.apistore.test/v1/items?sort=newest&page=2' });
    expect(fetchSearch).toHaveBeenCalledWith(
      'https://api.apistore.test/v1/items?sort=newest&page=2',
      { transport: 'impersonate', browser: 'chrome142', headers: { 'X-User-Key': 'k' } },
    );

    // the cooldown is keyed by the FETCHED host: a cooling api. host blocks, the cooling www. sibling does not
    cd.open('api.apistore.test', 'catalog challenge page');
    expect(await catalog.catalog('apistore', 2)).toEqual({ status: 'cooldown', siteId: 'apistore', host: 'api.apistore.test', remainingMs: 60_000 });
    cd.clear('api.apistore.test');
    cd.open('www.apistore.test', 'search challenge page');
    expect(await catalog.catalog('apistore', 2)).toMatchObject({ status: 'ok' });
  });

  it('a store registered with NO domains falls back to the listing host for transport resolution (http default)', async () => {
    const NODOMAIN = caps('nodomain', 'ignored.test', { byListing: { urlTemplate: 'https://nodomain.test/list?page={page}', order: 'newest' } }, { domains: [] });
    const { fetchSearch, catalog } = build({ profiles: buildProfileRegistry([NODOMAIN]), getRulesetForUrl: () => stub('nodomain', () => ({ items: [{ itemId: 'n1', url: '/p/n1' }] })) });
    const out = await catalog.catalog('nodomain');
    expect(fetchSearch).toHaveBeenCalledWith('https://nodomain.test/list?page=1', { transport: 'http' });
    expect(out).toMatchObject({ status: 'ok', collectUrls: ['https://nodomain.test/p/n1'] });
  });
});

describe('assembleCatalog × challenge cooldown', () => {
  const CHALLENGE = '<html><head><title>Just a moment...</title></head><body>cf</body></html>';

  it('a cooling host → status cooldown with the remaining ms, NO fetch, and the [COOLDOWN] skipped line', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const cd = new ChallengeCooldown({ now: () => 1000, windowMs: 120_000 });
    cd.open('orzgk.com', 'challenge page'); // the ingest queue already tripped it (www. is normalized away)
    const { fetchSearch, catalog } = build({ challengeCooldown: cd });

    const out = await catalog.catalog('orzgk', 5);

    expect(out).toEqual({ status: 'cooldown', siteId: 'orzgk', host: 'orzgk.com', remainingMs: 120_000 });
    expect(fetchSearch).not.toHaveBeenCalled();
    const skipped = warn.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith('[COOLDOWN] skipped'));
    expect(skipped).toContain('page=5');
    expect(skipped).toContain('orzgk.com cooling');
    expect(skipped).toContain('2 min left');
    warn.mockRestore();
  });

  it('a Cloudflare-challenge listing body → failed ("challenge page") AND the host cooldown is opened — never a phantom empty page', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const cd = new ChallengeCooldown({ now: () => 1000, windowMs: 60_000 });
    const extractListing = jest.fn(() => ORZGK_PAGE);
    const { catalog } = build({
      challengeCooldown: cd,
      fetchSearch: jest.fn(async () => CHALLENGE),
      getRulesetForUrl: () => stub('orzgk', extractListing),
    });

    const out = await catalog.catalog('orzgk');

    expect(out).toEqual({ status: 'failed', siteId: 'orzgk', reason: 'challenge page' });
    expect(extractListing).not.toHaveBeenCalled(); // a challenge body is never parsed into "0 items"
    expect(cd.isOpen('www.orzgk.com')).toBe(true);
    expect(cd.list()).toEqual([expect.objectContaining({ host: 'orzgk.com', reason: 'catalog challenge page' })]);
    expect(warn.mock.calls.map((c) => String(c[0]))).toContainEqual(expect.stringContaining('challenge page'));
    warn.mockRestore();
  });
});

/**
 * Stored-cookie STALE / FRESH signals (CfCookieStore): the catalog challenge site marks a host the
 * store has cookies for stale via the fetching lane; a clean listing marks it fresh.
 */
describe('assembleCatalog × stored cookies — stale / fresh signals', () => {
  const CHALLENGE = '<html><head><title>Just a moment...</title></head><body>cf</body></html>';
  const fakeStore = (hosts: string[]) => ({
    cookiesFor: (url: string) => (hosts.includes(new URL(url).hostname.replace(/^www\./, '')) ? { cf_clearance: 'FAKE_cf_1' } : undefined),
    userAgentFor: () => undefined,
    markStale: jest.fn(() => true),
    markFresh: jest.fn(() => true),
  });

  it('a challenge listing from a host WITH stored cookies → markStale("orzgk.com", lane, "catalog challenge page") once', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const cd = new ChallengeCooldown({ now: () => 1000, windowMs: 60_000 });
    const cfCookieStore = fakeStore(['orzgk.com']);
    const { catalog } = build({ challengeCooldown: cd, fetchSearch: jest.fn(async () => CHALLENGE), cfCookieStore });

    expect(await catalog.catalog('orzgk')).toEqual({ status: 'failed', siteId: 'orzgk', reason: 'challenge page' });
    expect(cd.isOpen('orzgk.com')).toBe(true);
    expect(cfCookieStore.markStale).toHaveBeenCalledTimes(1);
    expect(cfCookieStore.markStale).toHaveBeenCalledWith('orzgk.com', 'http', 'catalog challenge page');
    expect(cfCookieStore.markFresh).not.toHaveBeenCalled();
  });

  it('a clean listing → markFresh("orzgk.com"); markStale never', async () => {
    const cfCookieStore = fakeStore(['orzgk.com']);
    const { catalog } = build({ fetchSearch: jest.fn(async () => '[]'), cfCookieStore });

    expect(await catalog.catalog('orzgk')).toMatchObject({ status: 'ok', siteId: 'orzgk' });
    expect(cfCookieStore.markFresh).toHaveBeenCalledTimes(1);
    expect(cfCookieStore.markFresh).toHaveBeenCalledWith('orzgk.com');
    expect(cfCookieStore.markStale).not.toHaveBeenCalled();
  });

  it('a challenge from a host WITHOUT stored cookies → cooldown opens, markStale never', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const cd = new ChallengeCooldown({ now: () => 1000, windowMs: 60_000 });
    const cfCookieStore = fakeStore([]);
    const { catalog } = build({ challengeCooldown: cd, fetchSearch: jest.fn(async () => CHALLENGE), cfCookieStore });

    expect(await catalog.catalog('orzgk')).toEqual({ status: 'failed', siteId: 'orzgk', reason: 'challenge page' });
    expect(cd.isOpen('orzgk.com')).toBe(true);
    expect(cfCookieStore.markStale).not.toHaveBeenCalled();
  });

  it('a store whose declared searchFetch names NO transport is marked via "http" — the same default makeFetchSearch rides', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const cfCookieStore = fakeStore(['orzgk.com']);
    const { catalog } = build({
      profiles: buildProfileRegistry([{ ...ORZGK, searchFetch: { headers: { 'X-Api': 'k' } } }]),
      challengeCooldown: new ChallengeCooldown({ now: () => 1000, windowMs: 60_000 }),
      fetchSearch: jest.fn(async () => CHALLENGE),
      cfCookieStore,
    });

    expect(await catalog.catalog('orzgk')).toEqual({ status: 'failed', siteId: 'orzgk', reason: 'challenge page' });
    expect(cfCookieStore.markStale).toHaveBeenCalledWith('orzgk.com', 'http', 'catalog challenge page');
  });
});

describe('assembleCatalog — failures never throw', () => {
  it('a fetch that throws → failed with the (sanitized) reason, logged like /lookup', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { catalog } = build({ fetchSearch: jest.fn(async () => { throw new Error('CF block\nforged line'); }) });

    const out = await catalog.catalog('orzgk');

    expect(out).toEqual({ status: 'failed', siteId: 'orzgk', reason: 'CF block forged line' }); // newline stripped
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[catalog] orzgk'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('CF block'));
    warn.mockRestore();
  });

  it('a non-Error throw is stringified into the reason', async () => {
    const { catalog } = build({ fetchSearch: jest.fn(async () => { throw 'boom-string'; }) });
    expect(await catalog.catalog('orzgk')).toEqual({ status: 'failed', siteId: 'orzgk', reason: 'boom-string' });
  });

  it('extractListing that throws → failed (the plugin is untrusted), not an unhandled rejection', async () => {
    const { catalog } = build({ getRulesetForUrl: () => stub('orzgk', () => { throw new Error('parse exploded'); }) });
    expect(await catalog.catalog('orzgk')).toEqual({ status: 'failed', siteId: 'orzgk', reason: 'parse exploded' });
  });

  it('a listing fetch that HANGS is timed out (CATALOG_STORE_TIMEOUT_MS window) → failed "timed out"', async () => {
    jest.useFakeTimers();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { catalog } = build({ fetchSearch: jest.fn(() => new Promise<string>(() => {})) });

    const pending = catalog.catalog('orzgk');
    await jest.advanceTimersByTimeAsync(resolveCatalogStoreTimeoutMs(process.env) + 1);
    const out = await pending;

    expect(out).toMatchObject({ status: 'failed', siteId: 'orzgk', reason: expect.stringContaining('timed out') });
    jest.useRealTimers();
    warn.mockRestore();
  });
});

describe('assembleCatalog — happy path: items + collectUrl decoration + paging signals', () => {
  it('orzgk (byId store): every listed numeric id → byId collectUrl; hasMore/nextPage come from the plugin', async () => {
    const { catalog } = build();

    const out = await catalog.catalog('orzgk');

    expect(out).toEqual({
      status: 'ok',
      siteId: 'orzgk',
      page: 1,
      url: 'https://www.orzgk.com/wp-json/wc/store/v1/products?orderby=date&order=desc&per_page=100&page=1',
      items: ORZGK_IDS.map((id) => ({ itemId: String(id), collectUrl: `https://www.orzgk.com/wp-json/wc/store/v1/products/${id}` })),
      collectUrls: ORZGK_IDS.map((id) => `https://www.orzgk.com/wp-json/wc/store/v1/products/${id}`),
      hasMore: true,
      nextPage: 2,
      count: 3,
    });
  });

  it('goodsmileus (no byId): handle page links are absolutized against the listing url; `url` stays as the plugin emitted it', async () => {
    const { catalog } = build();

    const out = await catalog.catalog('goodsmileus', 2);

    expect(out).toMatchObject({ status: 'ok', siteId: 'goodsmileus', page: 2, count: 3 });
    if (out.status !== 'ok') throw new Error('unreachable');
    expect(out.items).toEqual(GSUS_HANDLES.map((h) => ({ itemId: h, url: `/products/${h}`, collectUrl: `https://www.goodsmileus.com/products/${h}` })));
    expect(out.collectUrls).toEqual(GSUS_HANDLES.map((h) => `https://www.goodsmileus.com/products/${h}`));
    // the plugin gave no paging signals → a non-empty page implies more, next = page + 1
    expect(out.hasMore).toBe(true);
    expect(out.nextPage).toBe(3);
  });

  it('paging defaults: an EMPTY page (Shopify end-of-catalog) → hasMore false, no nextPage; hasMore:false from the plugin wins over a full page', async () => {
    const empty = build({ getRulesetForUrl: () => stub('goodsmileus', () => ({ items: [] })) });
    const end = await empty.catalog.catalog('goodsmileus', 100);
    expect(end).toEqual({ status: 'ok', siteId: 'goodsmileus', page: 100, url: 'https://www.goodsmileus.com/products.json?limit=250&page=100', items: [], collectUrls: [], hasMore: false, count: 0 });
    expect(Object.prototype.hasOwnProperty.call(end, 'nextPage')).toBe(false);

    const last = build({ getRulesetForUrl: () => stub('orzgk', () => ({ items: [{ itemId: '1' }], hasMore: false })) });
    const out = await last.catalog.catalog('orzgk', 409);
    expect(out).toMatchObject({ status: 'ok', hasMore: false, count: 1 });
    expect(Object.prototype.hasOwnProperty.call(out, 'nextPage')).toBe(false);
  });

  it('nextPage from the plugin is honored only when it is an integer AFTER the current page; else derived from hasMore', async () => {
    const run = async (page: Partial<ListingPage>, at: number) => {
      const { catalog } = build({ getRulesetForUrl: () => stub('orzgk', () => page as ListingPage) });
      const out = await catalog.catalog('orzgk', at);
      if (out.status !== 'ok') throw new Error('unreachable');
      return { hasMore: out.hasMore, nextPage: out.nextPage };
    };
    expect(await run({ items: [{ itemId: '1' }], nextPage: 10 }, 4)).toEqual({ hasMore: true, nextPage: 10 }); // explicit skip-ahead honored
    expect(await run({ items: [{ itemId: '1' }], nextPage: 4 }, 4)).toEqual({ hasMore: true, nextPage: 5 }); // same page → never loop
    expect(await run({ items: [{ itemId: '1' }], nextPage: 2 }, 4)).toEqual({ hasMore: true, nextPage: 5 }); // backwards → ignored
    expect(await run({ items: [{ itemId: '1' }], nextPage: 5.5 }, 4)).toEqual({ hasMore: true, nextPage: 5 }); // non-integer → ignored
    expect(await run({ items: [{ itemId: '1' }], hasMore: false, nextPage: 9 }, 4)).toEqual({ hasMore: false, nextPage: 9 }); // explicit next survives hasMore:false
    expect(await run({ items: [], nextPage: 'x' as unknown as number }, 4)).toEqual({ hasMore: false, nextPage: undefined });
  });

  it('untrusted plugin output: malformed items are dropped, items keep only itemId/url, a non-object page → ok with 0 items', async () => {
    const dirty = [
      { itemId: '68064530', extra: 'stripped' },
      { itemId: '' },                                  // empty id → dropped
      { itemId: 123 },                                 // non-string id → dropped
      null,                                            // not an object → dropped
      'str',                                           // not an object → dropped
      { url: '/products/no-id' },                      // missing id → dropped
      { itemId: 'kept', url: 42 },                     // non-string url → url omitted, item kept (byId store → still collectable)
    ] as unknown as ListingPage['items'];
    const { catalog } = build({ getRulesetForUrl: () => stub('orzgk', () => ({ items: dirty, hasMore: 'yes' as unknown as boolean })) });

    const out = await catalog.catalog('orzgk');

    expect(out).toMatchObject({ status: 'ok', count: 2, hasMore: true, nextPage: 2 }); // hasMore non-boolean → derived from items
    if (out.status !== 'ok') throw new Error('unreachable');
    expect(out.items).toEqual([
      { itemId: '68064530', collectUrl: 'https://www.orzgk.com/wp-json/wc/store/v1/products/68064530' },
      { itemId: 'kept', collectUrl: 'https://www.orzgk.com/wp-json/wc/store/v1/products/kept' },
    ]);

    for (const bad of [undefined, null, 'nope', 42, { items: 'not-an-array' }, { items: { 0: 'x' } }]) {
      const { catalog: c } = build({ getRulesetForUrl: () => stub('goodsmileus', (() => bad) as unknown as ExtractionRuleset['extractListing']) });
      const r = await c.catalog('goodsmileus', 3);
      expect(r).toEqual({ status: 'ok', siteId: 'goodsmileus', page: 3, url: 'https://www.goodsmileus.com/products.json?limit=250&page=3', items: [], collectUrls: [], hasMore: false, count: 0 });
    }
  });

  it('no byId + an unusable page link (missing / malformed / non-http scheme) → item kept WITHOUT collectUrl and excluded from collectUrls', async () => {
    const { catalog } = build({
      getRulesetForUrl: () => stub('goodsmileus', () => ({
        items: [
          { itemId: 'no-url' },
          { itemId: 'bad-url', url: 'http://[bad' },
          { itemId: 'js', url: 'javascript:alert(1)' },
          { itemId: 'ok', url: '/products/ok' },
        ],
      })),
    });

    const out = await catalog.catalog('goodsmileus');

    if (out.status !== 'ok') throw new Error('unreachable');
    expect(out.items).toEqual([
      { itemId: 'no-url' },
      { itemId: 'bad-url', url: 'http://[bad' },
      { itemId: 'js', url: 'javascript:alert(1)' },
      { itemId: 'ok', url: '/products/ok', collectUrl: 'https://www.goodsmileus.com/products/ok' },
    ]);
    expect(out.collectUrls).toEqual(['https://www.goodsmileus.com/products/ok']);
    expect(out.count).toBe(4);
  });

  it('extractListing is called with the body and the listing url, and may be async', async () => {
    const extractListing = jest.fn(async (body: string, url: string) => ({ items: [{ itemId: `${body.length}:${url.length}` }] }));
    const { catalog } = build({ fetchSearch: jest.fn(async () => '[{"id":1}]'), getRulesetForUrl: () => stub('orzgk', extractListing) });

    const out = await catalog.catalog('orzgk', 2);

    const url = 'https://www.orzgk.com/wp-json/wc/store/v1/products?orderby=date&order=desc&per_page=100&page=2';
    expect(extractListing).toHaveBeenCalledWith('[{"id":1}]', url);
    expect(out).toMatchObject({ status: 'ok', items: [{ itemId: `10:${url.length}`, collectUrl: expect.stringContaining('/products/10%3A') }] });
  });
});

describe('resolveCatalogStoreTimeoutMs — pure env → ms resolver (CATALOG_STORE_TIMEOUT_MS)', () => {
  const env = (v?: string): NodeJS.ProcessEnv => ({ CATALOG_STORE_TIMEOUT_MS: v } as NodeJS.ProcessEnv);

  it('defaults to 30000 when unset / empty / non-numeric / non-positive', () => {
    expect(resolveCatalogStoreTimeoutMs(env())).toBe(30000);
    expect(resolveCatalogStoreTimeoutMs(env(''))).toBe(30000);
    expect(resolveCatalogStoreTimeoutMs(env('abc'))).toBe(30000);
    expect(resolveCatalogStoreTimeoutMs(env('0'))).toBe(30000);
    expect(resolveCatalogStoreTimeoutMs(env('-5'))).toBe(30000);
  });
  it('honors a valid override and clamps to [1000, 120000]', () => {
    expect(resolveCatalogStoreTimeoutMs(env('45000'))).toBe(45000);
    expect(resolveCatalogStoreTimeoutMs(env('10'))).toBe(1000);
    expect(resolveCatalogStoreTimeoutMs(env('999999'))).toBe(120000);
  });
});
