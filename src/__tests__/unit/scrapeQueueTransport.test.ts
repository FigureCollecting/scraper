/**
 * ScrapeQueue ingest transport tests — the ingest raw-fetch honors the ruleset's declared
 * `searchFetch` transport (impersonate / http / browser) instead of always browser-fetching.
 *
 * Bug this covers: an `impersonate`-transport JSON-API store (e.g. sentai) was always fetched via
 * the headless browser, which renders the `.js` JSON response as an HTML document. Handing that
 * rendered HTML to a ruleset's JSON.parse-based extract() silently returned empty data — nothing
 * reached the spine, no error thrown. The fix routes the raw fetch through the transport the store
 * declares (mirroring what the /lookup path already does via profiles.searchTransportFor), and
 * preserves the raw-capture sink on every lane (previously only the browser lane captured).
 */

// Persistent mock objects that survive clearAllMocks
const mockNotifyItemSuccess = jest.fn().mockResolvedValue(true);
const mockNotifyItemFailed = jest.fn().mockResolvedValue(true);
const mockNotifyItemSkipped = jest.fn().mockResolvedValue(true);

jest.mock('../../services/genericScraper', () => ({
  BrowserPool: {
    getStealthBrowser: jest.fn(),
    getBrowser: jest.fn(),
    returnBrowser: jest.fn(),
    getPoolSize: jest.fn().mockReturnValue(2),
    getPoolCapacity: jest.fn().mockReturnValue(3),
    reset: jest.fn(),
  },
}));

jest.mock('../../services/webhookClient', () => ({
  notifyItemSuccess: (...args: any[]) => mockNotifyItemSuccess(...args),
  notifyItemFailed: (...args: any[]) => mockNotifyItemFailed(...args),
  notifyItemSkipped: (...args: any[]) => mockNotifyItemSkipped(...args),
}));

import type { ExtractionRuleset, StoreCapabilities } from '@figurecollecting/scraper-plugin-contract';
import { ScrapeQueue, resetScrapeQueue } from '../../services/scrapeQueue';
import { createExtractionRegistry, ExtractionRegistryImpl } from '../../services/extractionRegistry';
import { CollectingCaptureSink } from '../../services/captureSink';

/**
 * Registry with a store whose full StoreCapabilities (incl. `searchFetch`) is registered — the
 * same shape a real plugin uses to declare its transport. `registerSite` is typed against the
 * narrower `SiteConfig`, so the capability object is built and typed as `StoreCapabilities` first
 * (assignability, not an inline literal) to carry `searchFetch` through untouched.
 */
function makeRegistry(ruleset: ExtractionRuleset, domain: string, searchFetch?: StoreCapabilities['searchFetch']): ExtractionRegistryImpl {
  const registry = createExtractionRegistry();
  const caps: StoreCapabilities = {
    siteId: ruleset.siteId,
    name: 'Mock Store',
    domains: [domain],
    rateLimit: {
      domain,
      baseDelayMs: 1000,
      minDelayMs: 500,
      maxDelayMs: 5000,
      backoffMultiplier: 1.5,
      recoveryDivisor: 1.5,
      successThreshold: 3,
    },
    requiresBrowser: false,
    allowedCookies: [],
    searchFetch,
  };
  registry.registerSite(caps);
  registry.registerRuleset(ruleset);
  return registry;
}

/** Fixture ruleset whose extract() JSON.parses the body — mirrors a real JSON-API ruleset. */
function makeJsonRuleset(): ExtractionRuleset & { extract: jest.Mock } {
  const extract = jest.fn((body: string, url: string) => {
    const parsed = JSON.parse(body); // throws on non-JSON, e.g. a browser-rendered HTML wrapper
    return {
      source: {
        site: 'mock-sentai',
        itemId: '1',
        url,
        extractedAt: '2026-08-14T00:00:00.000Z',
        rulesetVersion: '1.0.0',
      },
      fields: { name: parsed.name },
      warnings: [],
    };
  });
  return {
    siteId: 'mock-sentai',
    version: '1.0.0',
    extract,
    validate: () => ({ valid: true, errors: [], warnings: [] }),
  };
}

function makeHtmlRuleset(): ExtractionRuleset & { extract: jest.Mock } {
  const extract = jest.fn((html: string, url: string) => ({
    source: {
      site: 'mock-mfc',
      itemId: '12345',
      url,
      extractedAt: '2026-08-14T00:00:00.000Z',
      rulesetVersion: '1.0.0',
    },
    fields: { name: 'Kitagawa Marin' },
    warnings: [],
  }));
  return {
    siteId: 'mock-mfc',
    version: '1.0.0',
    extract,
    validate: () => ({ valid: true, errors: [], warnings: [] }),
  };
}

function makeScrapingStub(html = '<html><body>rendered</body></html>') {
  return {
    scrapePage: jest.fn().mockResolvedValue({ html, url: 'https://x.test/item/1', title: 'Item', statusCode: 200 }),
    scrapePageStealth: jest.fn().mockResolvedValue({ html, url: 'https://x.test/item/1', title: 'Item', statusCode: 200 }),
  };
}

describe('ScrapeQueue - ingest raw-fetch honors ruleset transport', () => {
  let queue: ScrapeQueue;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ advanceTimers: true });
    resetScrapeQueue();
    mockNotifyItemSuccess.mockResolvedValue(true);
    mockNotifyItemFailed.mockResolvedValue(true);
    mockNotifyItemSkipped.mockResolvedValue(true);
  });

  afterEach(() => {
    if (queue) {
      queue.stop();
      queue.clear();
    }
    resetScrapeQueue();
    jest.useRealTimers();
  });

  async function advanceAndFlush(ms: number, iterations: number = 3) {
    for (let i = 0; i < iterations; i++) {
      jest.advanceTimersByTime(ms / iterations);
      await jest.advanceTimersByTimeAsync(50);
    }
  }

  it('demonstrates the OLD bug: browser-rendering a JSON-API response and handing it to a JSON.parse-based ruleset throws', async () => {
    // This is the failure mode the fix eliminates: page-rendering a JSON API through Chrome wraps
    // the body in an HTML document (Chrome's JSON-viewer), so the SAME ruleset that correctly
    // parses a raw impit/http body throws on the browser-rendered wrapper — extraction fails
    // silently (the queue's try/catch around extract() turns it into a clean item failure, never
    // reaching send(), so nothing lands on the spine).
    const ruleset = makeJsonRuleset();
    const chromeRenderedWrapper = '<html><head></head><body><pre>{"name":"Cannot Parse Me"}</pre></body></html>';

    expect(() => ruleset.extract(chromeRenderedWrapper, 'https://api.sentai.example.test/item/1')).toThrow();
    // ...whereas the exact same ruleset succeeds on the RAW body the fix now fetches (proven in
    // the next test, end-to-end through the queue).
    expect(() => ruleset.extract('{"name":"OK"}', 'https://api.sentai.example.test/item/1')).not.toThrow();
  });

  it("routes an impersonate-transport store's ingest fetch through impit, not the browser, and hands the raw JSON to extract()", async () => {
    const ruleset = makeJsonRuleset();
    const scraping = makeScrapingStub(); // would render JSON as HTML — must NOT be called
    const send = jest.fn().mockResolvedValue({ sourceId: 'src-1' });
    const impersonate = jest.fn().mockResolvedValue('{"name":"Sentai Figure"}');
    const sink = new CollectingCaptureSink();

    queue = new ScrapeQueue(false);
    queue.setPluginRegistry(makeRegistry(ruleset, 'api.sentai.example.test', { transport: 'impersonate', browser: 'chrome142' }));
    queue.setIngestEmitter({ send });
    queue.setScrapingService(scraping);
    queue.setIngestTransports({ impersonate });
    queue.setCaptureSink(sink);

    const url = 'https://api.sentai.example.test/item/1';
    const result = queue.enqueue(url, { url });
    await advanceAndFlush(500);
    const data = await result.promise;

    // impit was used, with the store's declared profile
    expect(impersonate).toHaveBeenCalledWith(url, { browser: 'chrome142', headers: undefined, userAgent: undefined });
    // the browser was never touched
    expect(scraping.scrapePage).not.toHaveBeenCalled();
    expect(scraping.scrapePageStealth).not.toHaveBeenCalled();
    // the RAW json body (not a browser-rendered wrapper) reached extract()
    // B3: extractRecords forwards the built ExtractContext as extract's 3rd arg.
    expect(ruleset.extract).toHaveBeenCalledWith('{"name":"Sentai Figure"}', url, expect.anything());
    expect(data).toEqual({ name: 'Sentai Figure' });
    // spine emit happened — this is the "zero claims" bug, fixed
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].fields).toEqual({ name: 'Sentai Figure' });
    // the fetched bytes were captured (previously only the browser lane captured)
    expect(sink.captures).toHaveLength(1);
    expect(sink.captures[0]).toMatchObject({ url, lane: 'api' });
    expect(sink.captures[0].bytes.toString('utf8')).toBe('{"name":"Sentai Figure"}');
  });

  it("routes an http-transport store's ingest fetch through plain HTTP and captures the body", async () => {
    const ruleset = makeJsonRuleset();
    const scraping = makeScrapingStub();
    const send = jest.fn().mockResolvedValue({ sourceId: 'src-1' });
    const http = jest.fn().mockResolvedValue('{"name":"Tier1 Figure"}');
    const sink = new CollectingCaptureSink();

    queue = new ScrapeQueue(false);
    queue.setPluginRegistry(makeRegistry(ruleset, 'json.example.test', { transport: 'http' }));
    queue.setIngestEmitter({ send });
    queue.setScrapingService(scraping);
    queue.setIngestTransports({ http });
    queue.setCaptureSink(sink);

    const url = 'https://json.example.test/item/1';
    const result = queue.enqueue(url, { url });
    await advanceAndFlush(500);
    await result.promise;

    expect(http).toHaveBeenCalledWith(url);
    expect(scraping.scrapePage).not.toHaveBeenCalled();
    // B3: extractRecords forwards the built ExtractContext as extract's 3rd arg.
    expect(ruleset.extract).toHaveBeenCalledWith('{"name":"Tier1 Figure"}', url, expect.anything());
    expect(send).toHaveBeenCalledTimes(1);
    expect(sink.captures).toHaveLength(1);
    expect(sink.captures[0].lane).toBe('api');
  });

  it('a browser-transport (or no-transport) store still uses the browser lane (regression guard)', async () => {
    const ruleset = makeHtmlRuleset();
    const scraping = makeScrapingStub('<html><body><h1>Kitagawa Marin</h1></body></html>');
    const send = jest.fn().mockResolvedValue({ sourceId: 'src-1' });
    const impersonate = jest.fn();
    const http = jest.fn();

    queue = new ScrapeQueue(false);
    // no searchFetch declared at all — must default to the browser lane, not http
    queue.setPluginRegistry(makeRegistry(ruleset, 'myfigurecollection.net', undefined));
    queue.setIngestEmitter({ send });
    queue.setScrapingService(scraping);
    queue.setIngestTransports({ impersonate, http });

    const result = queue.enqueue('12345', { priority: 'WARM' });
    await advanceAndFlush(500);
    await result.promise;

    expect(scraping.scrapePage).toHaveBeenCalledWith('https://myfigurecollection.net/item/12345');
    expect(impersonate).not.toHaveBeenCalled();
    expect(http).not.toHaveBeenCalled();
    // B3: extractRecords forwards the built ExtractContext as extract's 3rd arg.
    expect(ruleset.extract).toHaveBeenCalledWith('<html><body><h1>Kitagawa Marin</h1></body></html>', 'https://myfigurecollection.net/item/12345', expect.anything());
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('an explicit browser-transport store also uses the browser lane and keeps cookie-driven stealth fetch', async () => {
    const ruleset = makeHtmlRuleset();
    const scraping = makeScrapingStub();
    const send = jest.fn().mockResolvedValue({ sourceId: 'src-1' });

    queue = new ScrapeQueue(false);
    queue.setPluginRegistry(makeRegistry(ruleset, 'myfigurecollection.net', { transport: 'browser' }));
    queue.setIngestEmitter({ send });
    queue.setScrapingService(scraping);

    const cookies = { PHPSESSID: 'abc' };
    const result = queue.enqueue('12345', { priority: 'WARM', sessionId: 'session1', cookies });
    await advanceAndFlush(500);
    await result.promise;

    expect(scraping.scrapePageStealth).toHaveBeenCalledWith('https://myfigurecollection.net/item/12345', { cookies });
    expect(scraping.scrapePage).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
  });
});
