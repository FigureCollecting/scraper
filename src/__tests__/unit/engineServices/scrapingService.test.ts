import { jest } from '@jest/globals';
import puppeteer from 'puppeteer';
import type { Page, Browser } from 'puppeteer';
import { BrowserPool } from '../../../services/genericScraper';
import { createScrapingService } from '../../../services/engineServices/scrapingService';

describe('createScrapingService', () => {
  let mockPage: jest.Mocked<Page>;
  let mockBrowser: jest.Mocked<Browser>;
  let mockContext: any;

  beforeEach(async () => {
    jest.clearAllMocks();
    await BrowserPool.reset();
    (BrowserPool as any).stealthBrowser = null;

    mockPage = {
      goto: jest.fn<(...args: any[]) => any>().mockResolvedValue({ status: () => 200 }),
      title: jest.fn<(...args: any[]) => any>().mockResolvedValue('Mock Page Title'),
      content: jest.fn<(...args: any[]) => any>().mockResolvedValue('<html><body>mock</body></html>'),
      evaluate: jest.fn<(...args: any[]) => any>().mockResolvedValue('mock body text'),
      setViewport: jest.fn<(...args: any[]) => any>().mockResolvedValue(undefined),
      setUserAgent: jest.fn<(...args: any[]) => any>().mockResolvedValue(undefined),
      setCookie: jest.fn<(...args: any[]) => any>().mockResolvedValue(undefined),
      setExtraHTTPHeaders: jest.fn<(...args: any[]) => any>().mockResolvedValue(undefined),
      // capture hook attaches a response listener; provide no-op stubs
      on: jest.fn(),
      off: jest.fn(),
      mainFrame: jest.fn(() => ({ id: 'main' })),
      close: jest.fn<(...args: any[]) => any>().mockResolvedValue(undefined),
      // Readiness waits (SearchFetch.waitFor) — only called when a store declares them.
      waitForSelector: jest.fn<(...args: any[]) => any>().mockResolvedValue({}),
      waitForNetworkIdle: jest.fn<(...args: any[]) => any>().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<Page>;

    mockContext = {
      newPage: jest.fn<(...args: any[]) => any>().mockResolvedValue(mockPage),
      close: jest.fn<(...args: any[]) => any>().mockResolvedValue(undefined),
    };

    mockBrowser = {
      newPage: jest.fn<(...args: any[]) => any>().mockResolvedValue(mockPage),
      close: jest.fn<(...args: any[]) => any>().mockResolvedValue(undefined),
      connected: true,
      createBrowserContext: jest.fn<(...args: any[]) => any>().mockResolvedValue(mockContext),
    } as unknown as jest.Mocked<Browser>;

    jest.mocked(puppeteer.launch).mockClear();
    jest.mocked(puppeteer.launch).mockResolvedValue(mockBrowser);
  });

  it('scrapePage navigates a pooled browser and returns html/title/url/statusCode', async () => {
    const service = createScrapingService();

    const result = await service.scrapePage('https://alpha.example.test/item/1');

    expect(mockPage.goto).toHaveBeenCalledWith(
      'https://alpha.example.test/item/1',
      expect.objectContaining({ waitUntil: 'domcontentloaded' })
    );
    expect(result).toEqual({
      html: '<html><body>mock</body></html>',
      url: 'https://alpha.example.test/item/1',
      title: 'Mock Page Title',
      statusCode: 200,
    });
  });

  it('scrapePage returns the browser to the pool after use', async () => {
    const service = createScrapingService();
    await service.scrapePage('https://alpha.example.test/item/1');

    expect(BrowserPool.getPoolSize()).toBe(BrowserPool.getPoolCapacity());
    expect(mockContext.close).toHaveBeenCalled();
  });

  it('scrapePage sets cookies scoped to the request domain when provided', async () => {
    const service = createScrapingService();

    await service.scrapePage('https://alpha.example.test/item/1', {
      cookies: { session: 'abc123' },
    });

    expect(mockPage.setCookie).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'session', value: 'abc123', domain: '.alpha.example.test' })
    );
  });

  it('scrapePageStealth uses the stealth browser, not the pooled one', async () => {
    const service = createScrapingService();

    await service.scrapePageStealth('https://alpha.example.test/item/1');

    // Stealth browser is a singleton, never returned to the regular pool.
    expect(BrowserPool.getPoolSize()).toBe(0);
  });

  it('withBrowser hands the caller a raw browser and returns it to the pool afterward', async () => {
    const service = createScrapingService();
    const seen: Browser[] = [];

    const result = await service.withBrowser(async (browser: Browser) => {
      seen.push(browser);
      return 'done';
    });

    expect(result).toBe('done');
    expect(seen).toHaveLength(1);
    expect(BrowserPool.getPoolSize()).toBe(BrowserPool.getPoolCapacity());
  });

  it('withPage hands the caller a managed page and cleans up the context', async () => {
    const service = createScrapingService();

    const title = await service.withPage(async (page: Page) => page.title());

    expect(title).toBe('Mock Page Title');
    expect(mockContext.close).toHaveBeenCalled();
  });

  it('withPage applies a custom viewport and user agent when provided', async () => {
    const service = createScrapingService();

    await service.withPage(async (page: Page) => page.title(), {
      viewport: { width: 800, height: 600 },
      userAgent: 'CustomUA/1.0',
    });

    expect(mockPage.setViewport).toHaveBeenCalledWith({ width: 800, height: 600 });
    expect(mockPage.setUserAgent).toHaveBeenCalledWith('CustomUA/1.0');
  });

  it('waits for the configured waitTime after navigation', async () => {
    const service = createScrapingService();
    const start = Date.now();

    await service.scrapePage('https://alpha.example.test/item/1', { waitTime: 50 });

    expect(Date.now() - start).toBeGreaterThanOrEqual(45);
  });

  it('waits an extra beat when a Cloudflare-style challenge is detected in title/body', async () => {
    mockPage.title.mockResolvedValue('Just a moment...');
    mockPage.evaluate.mockResolvedValue('checking your browser before accessing');

    const service = createScrapingService();
    const result = await service.scrapePage('https://alpha.example.test/item/1', {
      cloudflareDetection: { titleIncludes: ['Just a moment'], bodyIncludes: ['checking your browser'] },
    });

    expect(result.title).toBe('Just a moment...');
  });

  it('does not wait extra when cloudflareDetection is configured but no challenge matches', async () => {
    mockPage.title.mockResolvedValue('Ordinary Page');
    mockPage.evaluate.mockResolvedValue('nothing suspicious here');

    const service = createScrapingService();
    const result = await service.scrapePage('https://alpha.example.test/item/1', {
      cloudflareDetection: { titleIncludes: ['Just a moment'] },
    });

    expect(result.title).toBe('Ordinary Page');
  });

  // browserFetch — the CF-fronted / SPA fetch that returns a raw BODY (not a ScrapePageResult),
  // so it can back the lookup's `browserFetchBody` for `requiresBrowser` stores.
  it('browserFetch returns fully-rendered HTML via page.content() for a non-JSON response', async () => {
    const service = createScrapingService();

    const body = await service.browserFetch('https://cf.example.test/search?q=tomie', { stealth: false });

    expect(mockPage.goto).toHaveBeenCalledWith(
      'https://cf.example.test/search?q=tomie',
      expect.objectContaining({ waitUntil: 'domcontentloaded' })
    );
    expect(body).toBe('<html><body>mock</body></html>');
  });

  it('browserFetch returns the RAW JSON body via response.text() (not the JSON-viewer DOM) for a JSON content-type', async () => {
    mockPage.goto.mockResolvedValue({
      status: () => 200,
      headers: () => ({ 'content-type': 'application/json; charset=utf-8' }),
      text: async () => '{"items":[{"gcode":"FIG-1"}]}',
    } as any);
    const service = createScrapingService();

    const body = await service.browserFetch('https://api.amiami.com/api/v1.0/items?s_keywords=tomie', { stealth: false });

    expect(body).toBe('{"items":[{"gcode":"FIG-1"}]}');
    expect(mockPage.content).not.toHaveBeenCalled(); // JSON read from the response, not the wrapped DOM
  });

  it('browserFetch uses the stealth browser by default (CF-fronted hosts)', async () => {
    const service = createScrapingService();

    await service.browserFetch('https://cf.example.test/search?q=tomie');

    // Stealth browser is a singleton, never added to the regular pool.
    expect(BrowserPool.getPoolSize()).toBe(0);
  });

  it('browserFetch sets extra request headers and request-scoped cookies when provided', async () => {
    const service = createScrapingService();

    await service.browserFetch('https://www.amiami.com/api/v1.0/items?s_keywords=tomie', {
      stealth: false,
      headers: { 'X-User-Key': 'amiami_dev' },
      cookies: { cf_clearance: 'token123' },
    });

    expect(mockPage.setExtraHTTPHeaders).toHaveBeenCalledWith({ 'X-User-Key': 'amiami_dev' });
    expect(mockPage.setCookie).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'cf_clearance', value: 'token123', domain: '.amiami.com' })
    );
  });

  // Stored-cookie injection (CfCookieStore) on the browser lane — the single choke point every browser
  // navigation passes through (ingest queue, /resolve, ruleset ctx.scraping, /lookup + /catalog
  // browserFetch). Store cookies are merged UNDER request cookies (request wins per key), the mint UA is
  // pinned unless the request carries its own, and each cookie is emitted with httpOnly + secure flags.
  describe('× stored cookies (CfCookieStore) + pinned UA', () => {
    const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';
    // Plain functions (not jest.fn): the harness runs resetMocks, which would wipe a describe-scoped fake's implementation.
    const cookieStore = {
      cookiesFor: (url: string) => (url.includes('cf.example.test') ? { cf_clearance: 'FAKE_cf_1', PHPSESSID: 'FAKE_sess_1' } : undefined),
      userAgentFor: (url: string) => (url.includes('cf.example.test') ? 'Mozilla/5.0 FAKE-MINT-UA' : undefined),
    };

    it('scrapePage merges the store cookies (httpOnly + secure, domain-scoped) and pins the mint UA for a cohort host', async () => {
      const service = createScrapingService(undefined, { cookieStore });

      await service.scrapePage('https://www.cf.example.test/item/1');

      expect(mockPage.setUserAgent).toHaveBeenCalledWith('Mozilla/5.0 FAKE-MINT-UA');
      expect(mockPage.setCookie).toHaveBeenCalledTimes(1);
      expect(mockPage.setCookie).toHaveBeenCalledWith(
        { name: 'cf_clearance', value: 'FAKE_cf_1', domain: '.cf.example.test', path: '/', httpOnly: true, secure: true },
        { name: 'PHPSESSID', value: 'FAKE_sess_1', domain: '.cf.example.test', path: '/', httpOnly: true, secure: true },
      );
    });

    it('request/item cookies WIN per key over store cookies; the store\'s other cookies still ride', async () => {
      const service = createScrapingService(undefined, { cookieStore });

      await service.scrapePageStealth('https://cf.example.test/item/1', { cookies: { cf_clearance: 'FAKE_item_cf' } });

      const set = (mockPage.setCookie as jest.Mock).mock.calls[0] as Array<{ name: string; value: string }>;
      expect(set.map((c) => [c.name, c.value]).sort()).toEqual([['PHPSESSID', 'FAKE_sess_1'], ['cf_clearance', 'FAKE_item_cf']]);
    });

    it('options.userAgent wins over the pinned store UA (a request-scoped session carries its own coherent UA)', async () => {
      const service = createScrapingService(undefined, { cookieStore });
      await service.scrapePage('https://cf.example.test/item/1', { userAgent: 'RequestUA/1.0' });
      expect(mockPage.setUserAgent).toHaveBeenCalledWith('RequestUA/1.0');
    });

    it('unknown host → no setCookie call and the default UA: byte-identical to the pre-store behavior', async () => {
      const service = createScrapingService(undefined, { cookieStore });
      await service.scrapePage('https://alpha.example.test/item/1');
      expect(mockPage.setCookie).not.toHaveBeenCalled();
      expect(mockPage.setUserAgent).toHaveBeenCalledWith(DEFAULT_UA);
    });

    it('browserFetch (the /lookup + /catalog browser lane) merges store cookies under request cookies and pins the UA too', async () => {
      const service = createScrapingService(undefined, { cookieStore });

      await service.browserFetch('https://cf.example.test/search?q=lucy', { stealth: false, cookies: { extra: 'FAKE_x' } });

      expect(mockPage.setUserAgent).toHaveBeenCalledWith('Mozilla/5.0 FAKE-MINT-UA');
      const set = (mockPage.setCookie as jest.Mock).mock.calls[0] as Array<{ name: string; value: string; httpOnly: boolean; secure: boolean }>;
      expect(set.map((c) => c.name).sort()).toEqual(['PHPSESSID', 'cf_clearance', 'extra']);
      expect(set.every((c) => c.httpOnly === true && c.secure === true)).toBe(true);
    });

    it('a plain-http url emits secure:false so the cookie is actually sent', async () => {
      const service = createScrapingService(undefined, { cookieStore });
      await service.scrapePage('http://cf.example.test/item/1');
      expect(mockPage.setCookie).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'cf_clearance', secure: false, httpOnly: true }),
        expect.objectContaining({ name: 'PHPSESSID', secure: false, httpOnly: true }),
      );
    });
  });
  /**
   * RESIDENTIAL EGRESS + READINESS on the browser lane (contract 0.7.0).
   *
   * Egress: a store declaring `egress: 'residential'` gets a PER-REQUEST incognito context bound to
   * the proxy (`createBrowserContext({ proxyServer })`) — per context, so only that store's
   * navigations leave through the residential line while the pooled browser keeps serving everyone
   * else directly. The context is still closed after the request (no leaked proxied context).
   *
   * Readiness: a PWA storefront renders its product client-side, so returning at
   * `domcontentloaded` captures an empty app shell. `waitFor` makes the lane wait for a selector
   * and/or network idle first, bounded by `timeoutMs` (default 15000, clamped to [1000, 60000]). A
   * wait that times out is NOT fatal — the lane returns what rendered and logs exactly one warning.
   */
  describe('× residential egress (proxied context) + waitFor readiness', () => {
    const PROXY = 'socks5://egress-proxy.fc.svc.cluster.local:1055';
    let warnSpy: jest.Spied<typeof console.warn>;

    beforeEach(() => { warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
    afterEach(() => { warnSpy.mockRestore(); });

    it('scrapePage opens the per-request context BOUND TO THE PROXY for a residential store, and still closes it', async () => {
      const service = createScrapingService();

      const result = await service.scrapePage('https://www.anitoysgk.com/lucy-p29358268.html', { proxyServer: PROXY });

      expect(mockBrowser.createBrowserContext).toHaveBeenCalledWith({ proxyServer: PROXY });
      expect(mockContext.close).toHaveBeenCalledTimes(1); // proxied context is not leaked
      expect(result.html).toBe('<html><body>mock</body></html>');
    });

    it('scrapePageStealth (the CF cohort\'s lane) binds the proxy on the stealth browser too', async () => {
      const service = createScrapingService();
      await service.scrapePageStealth('https://www.anitoysgk.com/lucy-p29358268.html', { proxyServer: PROXY });
      expect(mockBrowser.createBrowserContext).toHaveBeenCalledWith({ proxyServer: PROXY });
    });

    it('browserFetch (the /lookup + /catalog lane) binds the proxy for a residential store', async () => {
      const service = createScrapingService();
      await service.browserFetch('https://www.anitoysgk.com/search?q=lucy', { stealth: false, proxyServer: PROXY });
      expect(mockBrowser.createBrowserContext).toHaveBeenCalledWith({ proxyServer: PROXY });
    });

    it('an undeclared store opens the context with NO arguments (byte-identical to the pre-egress path)', async () => {
      const service = createScrapingService();
      await service.scrapePage('https://alpha.example.test/item/1');
      expect(mockBrowser.createBrowserContext).toHaveBeenCalledWith();
    });

    it('waitFor.selector: waits for the selector after domcontentloaded, with the default 15 s bound', async () => {
      const service = createScrapingService();

      await service.scrapePage('https://www.crunchyroll-store.test/p/1', {
        waitFor: { selector: '[data-t="product-title"]' },
      });

      expect(mockPage.goto).toHaveBeenCalledWith(
        'https://www.crunchyroll-store.test/p/1',
        expect.objectContaining({ waitUntil: 'domcontentloaded' }),
      );
      expect(mockPage.waitForSelector).toHaveBeenCalledWith('[data-t="product-title"]', { timeout: 15000 });
      expect(mockPage.waitForNetworkIdle).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('waitFor.networkIdle: waits for the hydration XHRs to settle, bounded by the same budget', async () => {
      const service = createScrapingService();
      await service.scrapePage('https://www.crunchyroll-store.test/p/1', { waitFor: { networkIdle: true } });
      expect(mockPage.waitForNetworkIdle).toHaveBeenCalledWith({ timeout: 15000 });
      expect(mockPage.waitForSelector).not.toHaveBeenCalled();
    });

    it('honours an explicit timeoutMs and clamps it to [1000, 60000]', async () => {
      const service = createScrapingService();

      await service.scrapePage('https://a.test/1', { waitFor: { selector: '#a', timeoutMs: 20000 } });
      await service.scrapePage('https://a.test/2', { waitFor: { selector: '#b', timeoutMs: 10 } });
      await service.scrapePage('https://a.test/3', { waitFor: { selector: '#c', timeoutMs: 999999 } });

      expect(mockPage.waitForSelector).toHaveBeenNthCalledWith(1, '#a', { timeout: 20000 });
      expect(mockPage.waitForSelector).toHaveBeenNthCalledWith(2, '#b', { timeout: 1000 });
      expect(mockPage.waitForSelector).toHaveBeenNthCalledWith(3, '#c', { timeout: 60000 });
    });

    it('a TIMED-OUT wait returns whatever rendered with exactly one warning — never a thrown scrape', async () => {
      (mockPage.waitForSelector as unknown as jest.Mock<(...args: any[]) => any>).mockRejectedValue(new Error('Waiting for selector `#never` failed: timeout 15000ms exceeded'));
      const service = createScrapingService();

      const result = await service.scrapePage('https://www.crunchyroll-store.test/p/1', {
        waitFor: { selector: '#never', networkIdle: true },
      });

      expect(result.html).toBe('<html><body>mock</body></html>'); // the partial page, captured anyway
      expect(result.statusCode).toBe(200);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0][0])).toContain('crunchyroll-store.test');
    });

    it('browserFetch honours waitFor too (the search/listing body must be the rendered one)', async () => {
      const service = createScrapingService();
      const body = await service.browserFetch('https://www.crunchyroll-store.test/search?q=lucy', {
        stealth: false,
        waitFor: { selector: '.results', networkIdle: true, timeoutMs: 5000 },
      });
      expect(mockPage.waitForSelector).toHaveBeenCalledWith('.results', { timeout: 5000 });
      expect(mockPage.waitForNetworkIdle).toHaveBeenCalledWith({ timeout: 5000 });
      expect(body).toBe('<html><body>mock</body></html>');
    });

    it('a TIMED-OUT wait on browserFetch still returns the rendered body with one warning', async () => {
      (mockPage.waitForNetworkIdle as unknown as jest.Mock<(...args: any[]) => any>).mockRejectedValue(new Error('timeout'));
      const service = createScrapingService();
      const body = await service.browserFetch('https://www.crunchyroll-store.test/search?q=lucy', {
        stealth: false,
        waitFor: { networkIdle: true },
      });
      expect(body).toBe('<html><body>mock</body></html>');
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('an undeclared store never waits at all (byte-identical: goto → content)', async () => {
      const service = createScrapingService();
      await service.scrapePage('https://alpha.example.test/item/1');
      await service.browserFetch('https://alpha.example.test/search', { stealth: false });
      expect(mockPage.waitForSelector).not.toHaveBeenCalled();
      expect(mockPage.waitForNetworkIdle).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});
