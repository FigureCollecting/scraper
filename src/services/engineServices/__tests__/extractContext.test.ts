/**
 * extractContext — `buildExtractContext`'s `scraping.fetchBody`: dispatches through the SAME
 * store transport as the primary fetch, waits the D8 courtesy gap (same host only), passes
 * cookies through, and stubs out the ScrapingService members it does not implement.
 */
import { buildExtractContext, DEFAULT_FETCH_BODY_GAP_MS } from '../extractContext';
import type { SiteConfig } from '@figurecollecting/scraper-plugin-contract';

const CONFIG: SiteConfig = {
  siteId: 'orzgk',
  name: 'orzgk',
  domains: ['orzgk.com'],
  rateLimit: {
    domain: 'orzgk.com',
    baseDelayMs: 3000,
    minDelayMs: 500,
    maxDelayMs: 10000,
    backoffMultiplier: 1.5,
    recoveryDivisor: 1.5,
    successThreshold: 3,
  },
  requiresBrowser: false,
  allowedCookies: [],
};

const LOGGER = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

function makeScraping() {
  return {
    scrapePage: jest.fn().mockResolvedValue({ html: '<page/>', url: '', title: '', statusCode: 200 }),
    scrapePageStealth: jest.fn().mockResolvedValue({ html: '<page/>', url: '', title: '', statusCode: 200 }),
  };
}

describe('buildExtractContext — scraping.fetchBody', () => {
  it('waits until primaryFetchedAt + baseDelayMs (same host) before dispatching, using a fake clock', async () => {
    let clock = 1_000_000;
    const now = jest.fn(() => clock);
    const sleep = jest.fn(async (ms: number) => {
      clock += ms;
    });
    const capturingFetch = jest.fn().mockResolvedValue({ html: '{"variations":[]}' });

    const ctx = buildExtractContext({
      config: CONFIG,
      logger: LOGGER,
      scraping: makeScraping(),
      capturingFetch,
      searchFetch: { transport: 'http' },
      primaryUrl: 'https://orzgk.com/wp-json/wc/store/v1/products/1',
      primaryFetchedAt: 1_000_000, // == now() at t0
      baseDelayMs: 3000,
      now,
      sleep,
    });

    const followUpUrl = 'https://orzgk.com/wp-json/wc/store/v1/products?type=variation&parent=1';
    await ctx.scraping.fetchBody!(followUpUrl);

    expect(sleep).toHaveBeenCalledWith(3000);
    // capturingFetch must not have been called before the sleep advanced the clock.
    const sleepOrder = sleep.mock.invocationCallOrder[0];
    const fetchOrder = capturingFetch.mock.invocationCallOrder[0];
    expect(sleepOrder).toBeLessThan(fetchOrder);
    expect(capturingFetch).toHaveBeenCalledWith(followUpUrl, { transport: 'http' }, {});
  });

  it('does NOT wait (no early call, but also no needless delay) once primaryFetchedAt + gap has already elapsed', async () => {
    const now = jest.fn(() => 1_010_000); // 10s after primary fetch — well past a 3s gap
    const sleep = jest.fn().mockResolvedValue(undefined);
    const capturingFetch = jest.fn().mockResolvedValue({ html: '{}' });

    const ctx = buildExtractContext({
      config: CONFIG,
      logger: LOGGER,
      scraping: makeScraping(),
      capturingFetch,
      searchFetch: { transport: 'http' },
      primaryUrl: 'https://orzgk.com/wp-json/wc/store/v1/products/1',
      primaryFetchedAt: 1_000_000,
      baseDelayMs: 3000,
      now,
      sleep,
    });

    await ctx.scraping.fetchBody!('https://orzgk.com/wp-json/wc/store/v1/products?type=variation&parent=1');

    expect(sleep).not.toHaveBeenCalled();
    expect(capturingFetch).toHaveBeenCalled();
  });

  it('re-gaps a SECOND fetchBody call to the SAME host against the FIRST call\'s own dispatch — not just primaryFetchedAt', async () => {
    let clock = 1_000_000;
    const now = jest.fn(() => clock);
    const sleep = jest.fn(async (ms: number) => {
      clock += ms;
    });
    const capturingFetch = jest.fn().mockResolvedValue({ html: '{"variations":[]}' });

    const ctx = buildExtractContext({
      config: CONFIG,
      logger: LOGGER,
      scraping: makeScraping(),
      capturingFetch,
      searchFetch: { transport: 'http' },
      primaryUrl: 'https://orzgk.com/wp-json/wc/store/v1/products/1',
      primaryFetchedAt: 1_000_000, // == now() at t0
      baseDelayMs: 3000,
      now,
      sleep,
    });

    const followUpUrl = 'https://orzgk.com/wp-json/wc/store/v1/products?type=variation&parent=1';
    await ctx.scraping.fetchBody!(followUpUrl); // gapped against primaryFetchedAt: waits 3000
    await ctx.scraping.fetchBody!(followUpUrl); // SAME host again: must wait ANOTHER 3000, not 0

    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 3000);
    expect(sleep).toHaveBeenNthCalledWith(2, 3000);
    expect(capturingFetch).toHaveBeenCalledTimes(2);
  });

  it('tracks the courtesy gap PER HOST — a follow-up to a different host does not disturb the primary host\'s own gap tracking', async () => {
    let clock = 1_000_000;
    const now = jest.fn(() => clock);
    const sleep = jest.fn(async (ms: number) => {
      clock += ms;
    });
    const capturingFetch = jest.fn().mockResolvedValue({ html: '{}' });

    const ctx = buildExtractContext({
      config: CONFIG,
      logger: LOGGER,
      scraping: makeScraping(),
      capturingFetch,
      searchFetch: { transport: 'http' },
      primaryUrl: 'https://orzgk.com/wp-json/wc/store/v1/products/1',
      primaryFetchedAt: 1_000_000,
      baseDelayMs: 3000,
      now,
      sleep,
    });

    // Same-host follow-up first: waits the 3000ms gap against primaryFetchedAt, clock -> 1_003_000.
    await ctx.scraping.fetchBody!('https://orzgk.com/wp-json/wc/store/v1/products?type=variation&parent=1');
    // A DIFFERENT host in between: no gap owed against it (it has no prior fetch of its own).
    await ctx.scraping.fetchBody!('https://a-totally-different-store.example/api/x');
    // Back to the primary host again, immediately (clock unchanged since the different-host call
    // didn't advance it): still gapped against the FIRST same-host call, not reset by the detour.
    await ctx.scraping.fetchBody!('https://orzgk.com/wp-json/wc/store/v1/products?type=variation&parent=1');

    expect(sleep).toHaveBeenCalledTimes(2); // 1st same-host call + 3rd same-host call; NOT the different-host call
    expect(sleep).toHaveBeenNthCalledWith(1, 3000);
    expect(sleep).toHaveBeenNthCalledWith(2, 3000);
    expect(capturingFetch).toHaveBeenCalledTimes(3);
  });

  it('does NOT apply the courtesy gap when the follow-up targets a DIFFERENT host than the primary fetch', async () => {
    const now = jest.fn(() => 1_000_000);
    const sleep = jest.fn().mockResolvedValue(undefined);
    const capturingFetch = jest.fn().mockResolvedValue({ html: '{}' });

    const ctx = buildExtractContext({
      config: CONFIG,
      logger: LOGGER,
      scraping: makeScraping(),
      capturingFetch,
      searchFetch: { transport: 'http' },
      primaryUrl: 'https://orzgk.com/wp-json/wc/store/v1/products/1',
      primaryFetchedAt: 1_000_000,
      baseDelayMs: 3000,
      now,
      sleep,
    });

    await ctx.scraping.fetchBody!('https://a-totally-different-store.example/api/x');

    expect(sleep).not.toHaveBeenCalled();
    expect(capturingFetch).toHaveBeenCalled();
  });

  it('dispatches via capturingFetch using the STORE\'s declared searchFetch transport', async () => {
    const capturingFetch = jest.fn().mockResolvedValue({ html: 'body' });
    const searchFetch = { transport: 'impersonate' as const, browser: 'chrome142' };

    const ctx = buildExtractContext({
      config: CONFIG,
      logger: LOGGER,
      scraping: makeScraping(),
      capturingFetch,
      searchFetch,
      primaryUrl: 'https://orzgk.com/wp-json/wc/store/v1/products/1',
      primaryFetchedAt: 0,
      baseDelayMs: 0,
      now: () => 0,
    });

    await ctx.scraping.fetchBody!('https://orzgk.com/wp-json/wc/store/v1/products?type=variation&parent=1');

    expect(capturingFetch).toHaveBeenCalledWith(
      'https://orzgk.com/wp-json/wc/store/v1/products?type=variation&parent=1',
      searchFetch,
      {},
    );
  });

  it('passes the context\'s cookies through to capturingFetch', async () => {
    const capturingFetch = jest.fn().mockResolvedValue({ html: 'body' });
    const cookies = { cf_clearance: 'abc123' };

    const ctx = buildExtractContext({
      config: CONFIG,
      logger: LOGGER,
      scraping: makeScraping(),
      capturingFetch,
      searchFetch: { transport: 'http' },
      cookies,
      primaryUrl: 'https://orzgk.com/wp-json/wc/store/v1/products/1',
      primaryFetchedAt: 0,
      baseDelayMs: 0,
      now: () => 0,
    });

    await ctx.scraping.fetchBody!('https://orzgk.com/wp-json/wc/store/v1/products?type=variation&parent=1');

    expect(capturingFetch).toHaveBeenCalledWith(expect.any(String), expect.anything(), { cookies });
  });

  it('lets a per-call opts.cookies override the context\'s own cookies', async () => {
    const capturingFetch = jest.fn().mockResolvedValue({ html: 'body' });
    const callCookies = { session: 'override' };

    const ctx = buildExtractContext({
      config: CONFIG,
      logger: LOGGER,
      scraping: makeScraping(),
      capturingFetch,
      searchFetch: { transport: 'http' },
      cookies: { session: 'default' },
      primaryUrl: 'https://orzgk.com/wp-json/wc/store/v1/products/1',
      primaryFetchedAt: 0,
      baseDelayMs: 0,
      now: () => 0,
    });

    await ctx.scraping.fetchBody!('https://orzgk.com/wp-json/wc/store/v1/products?type=variation&parent=1', {
      cookies: callCookies,
    });

    expect(capturingFetch).toHaveBeenCalledWith(expect.any(String), expect.anything(), { cookies: callCookies });
  });

  it('falls back to DEFAULT_FETCH_BODY_GAP_MS when baseDelayMs is not supplied', async () => {
    let clock = 5000;
    const now = jest.fn(() => clock);
    const sleep = jest.fn(async (ms: number) => {
      clock += ms;
    });
    const capturingFetch = jest.fn().mockResolvedValue({ html: '{}' });

    const ctx = buildExtractContext({
      config: CONFIG,
      logger: LOGGER,
      scraping: makeScraping(),
      capturingFetch,
      searchFetch: { transport: 'http' },
      primaryUrl: 'https://orzgk.com/wp-json/wc/store/v1/products/1',
      primaryFetchedAt: 5000,
      now,
      sleep,
      // baseDelayMs intentionally omitted
    });

    await ctx.scraping.fetchBody!('https://orzgk.com/wp-json/wc/store/v1/products?type=variation&parent=1');

    expect(sleep).toHaveBeenCalledWith(DEFAULT_FETCH_BODY_GAP_MS);
  });

  it('passes config and logger through onto the ExtractContext verbatim, and forwards scrapePage/scrapePageStealth', async () => {
    const scraping = makeScraping();
    const ctx = buildExtractContext({
      config: CONFIG,
      logger: LOGGER,
      scraping,
      capturingFetch: jest.fn(),
      searchFetch: undefined,
      primaryUrl: 'https://orzgk.com/x',
      primaryFetchedAt: 0,
      now: () => 0,
    });

    expect(ctx.config).toBe(CONFIG);
    expect(ctx.logger).toBe(LOGGER);

    await ctx.scraping.scrapePage('https://orzgk.com/x');
    expect(scraping.scrapePage).toHaveBeenCalledWith('https://orzgk.com/x', undefined);

    await ctx.scraping.scrapePageStealth('https://orzgk.com/x', { cookies: { a: 'b' } });
    expect(scraping.scrapePageStealth).toHaveBeenCalledWith('https://orzgk.com/x', { cookies: { a: 'b' } });
  });

  it('treats an unparseable primaryUrl/target url as "no host" — no courtesy gap, never throws', async () => {
    const sleep = jest.fn().mockResolvedValue(undefined);
    const capturingFetch = jest.fn().mockResolvedValue({ html: 'body' });

    const ctx = buildExtractContext({
      config: CONFIG,
      logger: LOGGER,
      scraping: makeScraping(),
      capturingFetch,
      searchFetch: { transport: 'http' },
      primaryUrl: 'not a url at all',
      primaryFetchedAt: 0,
      baseDelayMs: 3000,
      now: () => 0,
      sleep,
    });

    await expect(ctx.scraping.fetchBody!('also not a url')).resolves.toEqual({ html: 'body' });
    expect(sleep).not.toHaveBeenCalled();
  });

  it('throws a clear error if a ruleset calls browserFetch/withBrowser/withPage through this context', () => {
    const ctx = buildExtractContext({
      config: CONFIG,
      logger: LOGGER,
      scraping: makeScraping(),
      capturingFetch: jest.fn(),
      searchFetch: undefined,
      primaryUrl: 'https://orzgk.com/x',
      primaryFetchedAt: 0,
      now: () => 0,
    });

    expect(() => ctx.scraping.browserFetch('https://orzgk.com/x')).toThrow(/browserFetch/);
    expect(() => ctx.scraping.withBrowser(async () => undefined)).toThrow(/withBrowser/);
    expect(() => ctx.scraping.withPage(async () => undefined)).toThrow(/withPage/);
  });

  it('leaves batchFetch/officialApi undefined (optional, not built this increment)', () => {
    const ctx = buildExtractContext({
      config: CONFIG,
      logger: LOGGER,
      scraping: makeScraping(),
      capturingFetch: jest.fn(),
      searchFetch: undefined,
      primaryUrl: 'https://orzgk.com/x',
      primaryFetchedAt: 0,
      now: () => 0,
    });

    expect(ctx.scraping.batchFetch).toBeUndefined();
    expect(ctx.scraping.officialApi).toBeUndefined();
  });
});
