/**
 * The CONFIRM leg's residential-egress gate (/resolve + the ExtractContext page passthroughs).
 *
 * `capturingFetch`/`fetchSearch` gate the SEARCH lane, but /resolve reaches the network by two
 * other doors, and both must obey the same rule — a store declaring `searchFetch.egress:
 * 'residential'` is either fetched through the configured proxy or REFUSED, never sent from the
 * node IP:
 *   1. the PRIMARY detail fetch (`assembleResolve` → `services.fetchDetail`, wired at the mount to
 *      the pooled ScrapingService's `scrapePage`);
 *   2. `ctx.scraping.scrapePage` / `scrapePageStealth` — the ExtractContext passthroughs an
 *      extractAsync/extractMany ruleset uses for a follow-up navigation (the sibling of the
 *      already-gated `fetchBody`).
 *
 * Undeclared / `direct` stores must stay byte-identical: the detail fetch is called with ONE
 * argument and the passthrough forwards the caller's own pageOptions untouched.
 */
import { createEngineResolve } from '../../services/engineResolve';
import { buildExtractContext } from '../../services/engineServices/extractContext';
import { ResidentialEgressUnavailableError } from '../../services/residentialEgress';
import type { LookupRegistry } from '../../services/engineLookup';
import type {
  ExtractContext,
  SearchFetch,
  ExtractedData,
  ExtractionRuleset,
  SiteConfig,
  StoreCapabilities,
} from '@figurecollecting/scraper-plugin-contract';

const PROXY = 'socks5://egress-proxy.fc.svc.cluster.local:1055';

const rateLimit = (domain: string) => ({
  domain, baseDelayMs: 1, minDelayMs: 1, maxDelayMs: 10, backoffMultiplier: 1, recoveryDivisor: 1, successThreshold: 1,
});

/** A Cloudflare-cohort store: browser lane, residential egress, client-rendered readiness. */
const RESIDENTIAL: StoreCapabilities = {
  siteId: 'anitoys', name: 'anitoys', domains: ['anitoysgk.com'], requiresBrowser: true, allowedCookies: [],
  rateLimit: rateLimit('anitoysgk.com'),
  retrieval: { byId: { urlTemplate: 'https://anitoysgk.com/product/{id}', idKind: 'store-internal' } },
  searchFetch: { transport: 'browser', egress: 'residential', waitFor: { selector: '#product' } },
};

/** The same store with nothing declared — the pre-0.7.0 path that must not move a byte. */
const DIRECT: StoreCapabilities = {
  siteId: 'orzgk', name: 'orzgk', domains: ['orzgk.com'], requiresBrowser: false, allowedCookies: [],
  rateLimit: rateLimit('orzgk.com'),
  retrieval: { byId: { urlTemplate: 'https://orzgk.com/product/{id}', idKind: 'store-internal' } },
  searchFetch: { transport: 'http' },
};

const CONFIG: SiteConfig = { ...RESIDENTIAL };

const record = (fields: Record<string, unknown>): ExtractedData => ({
  source: { site: 'anitoys', itemId: 'x', extractedAt: '2026-09-07T00:00:00.000Z' },
  fields,
  warnings: [],
});

const ruleset = (extractAsync?: (html: string, url: string, ctx?: ExtractContext) => Promise<ExtractedData>): ExtractionRuleset => ({
  siteId: 'anitoys', version: '1.0.0',
  extract: () => record({ gtin14: '04570232591424' }),
  validate: () => ({ valid: true, errors: [], warnings: [] }),
  ...(extractAsync ? { extractAsync } : {}),
} as ExtractionRuleset);

const fakeScraping = () => ({
  scrapePage: jest.fn(async () => ({ html: '<page/>', url: '', title: '', statusCode: 200 })),
  scrapePageStealth: jest.fn(async () => ({ html: '<page/>', url: '', title: '', statusCode: 200 })),
});

const LOGGER = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

describe('/resolve primary detail fetch — residential egress gate', () => {
  let warnSpy: jest.SpyInstance;
  beforeEach(() => { warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warnSpy.mockRestore(); });

  it('routes a residential store\'s detail fetch through the configured proxy, with its declared readiness', async () => {
    const registry: LookupRegistry = { allStores: () => [RESIDENTIAL], getRulesetForUrl: () => ruleset() };
    const fetchDetail = jest.fn(async () => ({ html: '<html/>', statusCode: 200 }));

    const out = await createEngineResolve(registry, fetchDetail, {
      scraping: fakeScraping(),
      residentialProxyUrl: () => PROXY,
    }).resolve('anitoys', ['ABC']);

    expect(fetchDetail).toHaveBeenCalledWith('https://anitoysgk.com/product/ABC', {
      proxyServer: PROXY,
      waitFor: { selector: '#product' },
    });
    expect(out.results[0]?.gtin14).toBe('04570232591424');
  });

  it('REFUSES a residential store when no proxy is configured — no detail fetch at all, the id fails', async () => {
    const registry: LookupRegistry = { allStores: () => [RESIDENTIAL], getRulesetForUrl: () => ruleset() };
    const fetchDetail = jest.fn(async () => ({ html: '<html/>', statusCode: 200 }));

    const out = await createEngineResolve(registry, fetchDetail, {
      scraping: fakeScraping(),
      residentialProxyUrl: () => undefined,
    }).resolve('anitoys', ['ABC']);

    expect(fetchDetail).not.toHaveBeenCalled();
    expect(out.results).toEqual([]);
    expect(out.failed).toEqual(['ABC']);
    expect(out.unsupported).toBe(false);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('RESIDENTIAL_PROXY_URL');
  });

  it('leaves an undeclared store byte-identical: the detail fetch is called with the url ALONE', async () => {
    const registry: LookupRegistry = { allStores: () => [DIRECT], getRulesetForUrl: () => ruleset() };
    const fetchDetail = jest.fn(async () => ({ html: '<html/>', statusCode: 200 }));

    await createEngineResolve(registry, fetchDetail, {
      scraping: fakeScraping(),
      residentialProxyUrl: () => PROXY,
    }).resolve('orzgk', ['ZZZ']);

    expect(fetchDetail).toHaveBeenCalledWith('https://orzgk.com/product/ZZZ');
  });
});

describe('ExtractContext page passthroughs — residential egress gate', () => {
  const build = (proxy: string | undefined, scraping = fakeScraping()) => ({
    scraping,
    ctx: buildExtractContext({
      config: CONFIG,
      logger: LOGGER,
      scraping,
      capturingFetch: jest.fn(async () => ({ html: '{}' })),
      searchFetch: RESIDENTIAL.searchFetch,
      primaryUrl: 'https://anitoysgk.com/product/ABC',
      primaryFetchedAt: 0,
      residentialProxyUrl: () => proxy,
      now: () => 10_000_000,
      sleep: jest.fn(async () => {}),
    }),
  });

  it('binds scrapePage to the residential proxy (and the store readiness), keeping the caller\'s own options', async () => {
    const { ctx, scraping } = build(PROXY);
    await ctx.scraping.scrapePage('https://anitoysgk.com/follow-up', { waitTime: 500 });
    expect(scraping.scrapePage).toHaveBeenCalledWith('https://anitoysgk.com/follow-up', {
      waitTime: 500,
      proxyServer: PROXY,
      waitFor: { selector: '#product' },
    });
  });

  it('binds scrapePageStealth the same way when the ruleset asks for the stealth lane', async () => {
    const { ctx, scraping } = build(PROXY);
    await ctx.scraping.scrapePageStealth('https://anitoysgk.com/follow-up');
    expect(scraping.scrapePageStealth).toHaveBeenCalledWith('https://anitoysgk.com/follow-up', {
      proxyServer: PROXY,
      waitFor: { selector: '#product' },
    });
  });

  it('REFUSES both passthroughs when no proxy is configured — typed, and never a node-IP navigation', async () => {
    const { ctx, scraping } = build(undefined);
    await expect(ctx.scraping.scrapePage('https://anitoysgk.com/follow-up'))
      .rejects.toThrow(ResidentialEgressUnavailableError);
    await expect(ctx.scraping.scrapePageStealth('https://anitoysgk.com/follow-up'))
      .rejects.toThrow(ResidentialEgressUnavailableError);
    expect(scraping.scrapePage).not.toHaveBeenCalled();
    expect(scraping.scrapePageStealth).not.toHaveBeenCalled();
  });

  /**
   * The proxy is chosen by the DECLARING store, but a ruleset chooses the URL. A follow-up to some
   * third-party host must not inherit the residential exit: that hands the home IP to a host that
   * never declared it, and spends the residential line's reputation on someone else's traffic.
   */
  it('does NOT send an OFF-STORE follow-up through the residential exit', async () => {
    const { ctx, scraping } = build(PROXY);
    await ctx.scraping.scrapePage('https://cdn.thirdparty.example/img/1.jpg');
    expect(scraping.scrapePage).toHaveBeenCalledWith('https://cdn.thirdparty.example/img/1.jpg', undefined);
  });

  it('does not REFUSE an off-store follow-up either — it is simply not the declaring store\'s fetch', async () => {
    const { ctx, scraping } = build(undefined);
    await ctx.scraping.scrapePage('https://cdn.thirdparty.example/img/1.jpg');
    expect(scraping.scrapePage).toHaveBeenCalledWith('https://cdn.thirdparty.example/img/1.jpg', undefined);
  });

  it('still covers the store\'s OWN subdomains (an asset host under the declaring domain)', async () => {
    const { ctx, scraping } = build(PROXY);
    await ctx.scraping.scrapePage('https://cdn.anitoysgk.com/product/ABC');
    expect(scraping.scrapePage).toHaveBeenCalledWith('https://cdn.anitoysgk.com/product/ABC', expect.objectContaining({ proxyServer: PROXY }));
  });

  it('does not let a look-alike suffix host ride the exit', async () => {
    const { ctx, scraping } = build(PROXY);
    await ctx.scraping.scrapePage('https://evil-anitoysgk.com/product/ABC');
    expect(scraping.scrapePage).toHaveBeenCalledWith('https://evil-anitoysgk.com/product/ABC', undefined);
  });

  it('keeps an OFF-STORE fetchBody off the residential exit as well', async () => {
    const capturingFetch = jest.fn<Promise<{ html: string }>, [string, SearchFetch | undefined, unknown?]>(async () => ({ html: '{}' }));
    const ctx = buildExtractContext({
      config: CONFIG,
      logger: LOGGER,
      scraping: fakeScraping(),
      capturingFetch,
      searchFetch: { transport: 'impersonate', egress: 'residential', browser: 'chrome142' },
      primaryUrl: 'https://anitoysgk.com/product/ABC',
      primaryFetchedAt: 0,
      residentialProxyUrl: () => PROXY,
      now: () => 10_000_000,
      sleep: jest.fn(async () => {}),
    });

    await ctx.scraping.fetchBody!('https://api.thirdparty.example/v1/item');
    await ctx.scraping.fetchBody!('https://anitoysgk.com/api/variations');

    expect(capturingFetch.mock.calls[0][1]).toEqual({ transport: 'impersonate', browser: 'chrome142' });
    expect(capturingFetch.mock.calls[1][1]).toEqual({ transport: 'impersonate', egress: 'residential', browser: 'chrome142' });
  });

  it('forwards an undeclared store\'s pageOptions untouched (undefined stays undefined)', async () => {
    const scraping = fakeScraping();
    const ctx = buildExtractContext({
      config: CONFIG,
      logger: LOGGER,
      scraping,
      capturingFetch: jest.fn(async () => ({ html: '{}' })),
      searchFetch: { transport: 'browser' },
      primaryUrl: 'https://orzgk.com/product/ABC',
      primaryFetchedAt: 0,
      residentialProxyUrl: () => PROXY,
      now: () => 10_000_000,
      sleep: jest.fn(async () => {}),
    });
    await ctx.scraping.scrapePage('https://orzgk.com/follow-up');
    await ctx.scraping.scrapePageStealth('https://orzgk.com/follow-up', { waitTime: 100 });
    expect(scraping.scrapePage).toHaveBeenCalledWith('https://orzgk.com/follow-up', undefined);
    expect(scraping.scrapePageStealth).toHaveBeenCalledWith('https://orzgk.com/follow-up', { waitTime: 100 });
  });

  it('reaches a ruleset through /resolve: an extractAsync follow-up navigation carries the proxy', async () => {
    const scraping = fakeScraping();
    const seen: unknown[] = [];
    const registry: LookupRegistry = {
      allStores: () => [RESIDENTIAL],
      getRulesetForUrl: () => ruleset(async (_html, _url, ctx) => {
        const res = await ctx!.scraping.scrapePage('https://anitoysgk.com/follow-up');
        seen.push(res.statusCode);
        return record({ gtin14: '1' });
      }),
    };

    await createEngineResolve(registry, async () => ({ html: '<html/>', statusCode: 200 }), {
      scraping,
      residentialProxyUrl: () => PROXY,
    }).resolve('anitoys', ['ABC']);

    expect(seen).toEqual([200]);
    expect(scraping.scrapePage).toHaveBeenCalledWith('https://anitoysgk.com/follow-up', {
      proxyServer: PROXY,
      waitFor: { selector: '#product' },
    });
  });
});
