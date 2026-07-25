/**
 * ScrapeQueue ingest tests — when an IngestEmitter is configured
 * (INGEST_BASE_URL) AND the plugin registry resolves a ruleset for the item's
 * URL, the queue processes: raw page fetch (engine's scraping service) ->
 * ruleset.extract() -> ingestEmitter.send(). Clean cut: NO webhook leg on
 * success. When the emitter is absent OR no ruleset matches, the item fails
 * cleanly (extraction_unavailable, non-retryable) — the engine carries no
 * extraction fallback.
 *
 * The fixture ruleset mirrors src/__tests__/fixtures/plugins/
 * mock-scraper-ruleset (same shape a real plugin registers), pointed at the
 * queue's myfigurecollection.net URLs so registry lookup resolves.
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

import type { ExtractionRuleset } from '@figurecollecting/scraper-plugin-contract';
import { ScrapeQueue, resetScrapeQueue } from '../../services/scrapeQueue';
import { createExtractionRegistry, ExtractionRegistryImpl } from '../../services/extractionRegistry';

const FIXTURE_HTML = '<html><body><h1 class="title">Kitagawa Marin</h1></body></html>';

/** Registry with the fixture site registered against the queue's MFC URLs. */
function makeRegistry(ruleset: ExtractionRuleset): ExtractionRegistryImpl {
  const registry = createExtractionRegistry();
  registry.registerSite({
    siteId: ruleset.siteId,
    name: 'Mock MFC',
    domains: ['myfigurecollection.net'],
    rateLimit: {
      domain: 'myfigurecollection.net',
      baseDelayMs: 1000,
      minDelayMs: 500,
      maxDelayMs: 5000,
      backoffMultiplier: 1.5,
      recoveryDivisor: 1.5,
      successThreshold: 3,
    },
    requiresBrowser: false,
    allowedCookies: [],
  });
  registry.registerRuleset(ruleset);
  return registry;
}

/** Fixture ruleset (same shape as fixtures/plugins/mock-scraper-ruleset). */
function makeRuleset(extract?: jest.Mock): ExtractionRuleset & { extract: jest.Mock } {
  const extractFn =
    extract ??
    jest.fn((html: string, url: string) => ({
      source: {
        site: 'mock-mfc',
        itemId: '12345',
        url,
        extractedAt: '2026-07-24T00:00:00.000Z',
        rulesetVersion: '1.0.0',
      },
      fields: { name: 'Kitagawa Marin', jan: '4530956107891' },
      warnings: [],
    }));
  return {
    siteId: 'mock-mfc',
    version: '1.0.0',
    extract: extractFn,
    validate: () => ({ valid: true, errors: [], warnings: [] }),
  };
}

function makeScrapingStub() {
  return {
    scrapePage: jest.fn().mockResolvedValue({
      html: FIXTURE_HTML,
      url: 'https://myfigurecollection.net/item/12345',
      title: 'Item',
      statusCode: 200,
    }),
    scrapePageStealth: jest.fn().mockResolvedValue({
      html: FIXTURE_HTML,
      url: 'https://myfigurecollection.net/item/12345',
      title: 'Item',
      statusCode: 200,
    }),
  };
}

describe('ScrapeQueue - ingest cutover', () => {
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

  // Helper to advance timers and flush microtask queue multiple times
  async function advanceAndFlush(ms: number, iterations: number = 3) {
    for (let i = 0; i < iterations; i++) {
      jest.advanceTimersByTime(ms / iterations);
      await jest.advanceTimersByTimeAsync(50);
    }
  }

  it('takes the ingest path when emitter configured and ruleset matches: fetch -> extract -> emit, NO webhook', async () => {
    const ruleset = makeRuleset();
    const scraping = makeScrapingStub();
    const send = jest.fn().mockResolvedValue({ sourceId: 'src-1' });

    queue = new ScrapeQueue(false);
    queue.setPluginRegistry(makeRegistry(ruleset));
    queue.setIngestEmitter({ send });
    queue.setScrapingService(scraping);

    const result = queue.enqueue('12345', { priority: 'WARM', sessionId: 'session1' });
    await advanceAndFlush(500);
    const data = await result.promise;

    // engine fetched the raw page; extraction was the plugin's job
    expect(scraping.scrapePage).toHaveBeenCalledWith('https://myfigurecollection.net/item/12345');
    expect(ruleset.extract).toHaveBeenCalledWith(FIXTURE_HTML, 'https://myfigurecollection.net/item/12345');
    // the extraction went to the spine, verbatim
    expect(send).toHaveBeenCalledTimes(1);
    const sent = send.mock.calls[0][0];
    expect(sent.source.site).toBe('mock-mfc');
    expect(sent.source.extractedAt).toBe('2026-07-24T00:00:00.000Z');
    expect(sent.fields).toEqual({ name: 'Kitagawa Marin', jan: '4530956107891' });
    // clean cut: no webhook leg on the ingest path
    expect(mockNotifyItemSuccess).not.toHaveBeenCalled();
    // waiting callers still resolve (with the extracted field bag)
    expect(data).toEqual({ name: 'Kitagawa Marin', jan: '4530956107891' });
    expect(queue.getStats().completed).toBe(1);
  });

  it('uses the stealth fetch when the item carries cookies', async () => {
    const ruleset = makeRuleset();
    const scraping = makeScrapingStub();
    const send = jest.fn().mockResolvedValue({ sourceId: 'src-1' });

    queue = new ScrapeQueue(false);
    queue.setPluginRegistry(makeRegistry(ruleset));
    queue.setIngestEmitter({ send });
    queue.setScrapingService(scraping);

    const cookies = { PHPSESSID: 'abc' };
    const result = queue.enqueue('12345', { priority: 'WARM', sessionId: 'session1', cookies });
    await advanceAndFlush(500);
    await result.promise;

    expect(scraping.scrapePageStealth).toHaveBeenCalledWith(
      'https://myfigurecollection.net/item/12345',
      { cookies }
    );
    expect(scraping.scrapePage).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('fails the item cleanly (non-retryable) when no emitter is configured', async () => {
    const ruleset = makeRuleset();
    const scraping = makeScrapingStub();

    queue = new ScrapeQueue(false);
    // registry present, but INGEST_BASE_URL unset -> no emitter -> clean failure
    queue.setPluginRegistry(makeRegistry(ruleset));
    queue.setScrapingService(scraping);

    const result = queue.enqueue('12345', { priority: 'WARM', sessionId: 'session1' });
    const promiseRef = result.promise.catch((e: Error) => e);
    await advanceAndFlush(500);
    await advanceAndFlush(5000);

    const error = await promiseRef;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('extraction_unavailable');
    expect((error as Error).message).toContain('no ingest emitter configured');
    // nothing was fetched or extracted; item failed once, no retries
    expect(ruleset.extract).not.toHaveBeenCalled();
    expect(scraping.scrapePage).not.toHaveBeenCalled();
    expect(queue.getStats().failed).toBe(1);
    // permanent failure is reported to the backend (well-logged, never silent)
    expect(mockNotifyItemFailed).toHaveBeenCalledWith(
      'session1',
      '12345',
      expect.stringContaining('EXTRACTION_UNAVAILABLE')
    );
  });

  it('fails the item cleanly (non-retryable) when the emitter is configured but no ruleset matches the URL', async () => {
    const scraping = makeScrapingStub();
    const send = jest.fn().mockResolvedValue({ sourceId: 'src-1' });

    queue = new ScrapeQueue(false);
    // registry has NO site registered for myfigurecollection.net
    queue.setPluginRegistry(createExtractionRegistry());
    queue.setIngestEmitter({ send });
    queue.setScrapingService(scraping);

    const result = queue.enqueue('12345', { priority: 'WARM', sessionId: 'session1' });
    const promiseRef = result.promise.catch((e: Error) => e);
    await advanceAndFlush(500);
    await advanceAndFlush(5000);

    const error = await promiseRef;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('extraction_unavailable');
    expect((error as Error).message).toContain('no plugin ruleset matches');
    expect(send).not.toHaveBeenCalled();
    expect(scraping.scrapePage).not.toHaveBeenCalled();
    expect(queue.getStats().failed).toBe(1);
  });

  it('does not trip session pause/cooldown machinery for extraction_unavailable failures on cookie items', async () => {
    const scraping = makeScrapingStub();

    queue = new ScrapeQueue(false);
    // no emitter at all -> every item is extraction_unavailable
    queue.setPluginRegistry(createExtractionRegistry());
    queue.setScrapingService(scraping);

    const result = queue.enqueue('12345', {
      priority: 'HOT',
      sessionId: 'session1',
      cookies: { PHPSESSID: 'abc' },
    });
    const promiseRef = result.promise.catch((e: Error) => e);
    await advanceAndFlush(500);
    await advanceAndFlush(5000);

    const error = await promiseRef;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('extraction_unavailable');
    // failed outright — not held in the queue for a cookie-cooldown retry
    expect(queue.getStats().failed).toBe(1);
    expect(queue.getStats().total).toBe(0);
  });

  it('fails the item through existing failure handling when the emitter gives up (never a silent drop)', async () => {
    const ruleset = makeRuleset();
    const scraping = makeScrapingStub();
    const send = jest.fn().mockRejectedValue(new Error('spine unavailable after retries'));

    queue = new ScrapeQueue(false);
    queue.setPluginRegistry(makeRegistry(ruleset));
    queue.setIngestEmitter({ send });
    queue.setScrapingService(scraping);

    const result = queue.enqueue('12345', { priority: 'WARM', maxRetries: 0 });
    const promiseRef = result.promise.catch((e: Error) => e);

    await advanceAndFlush(500);
    await advanceAndFlush(5000);

    const error = await promiseRef;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('Scrape failed');
    expect(queue.getStats().failed).toBe(1);
  });

  it('fails the item and logs the error when extraction throws', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const ruleset = makeRuleset(
      jest.fn(() => {
        throw new Error('selector drift: .title vanished');
      })
    );
    const scraping = makeScrapingStub();
    const send = jest.fn().mockResolvedValue({ sourceId: 'src-1' });

    queue = new ScrapeQueue(false);
    queue.setPluginRegistry(makeRegistry(ruleset));
    queue.setIngestEmitter({ send });
    queue.setScrapingService(scraping);

    const result = queue.enqueue('12345', { priority: 'WARM', maxRetries: 0 });
    const promiseRef = result.promise.catch((e: Error) => e);

    await advanceAndFlush(500);
    await advanceAndFlush(5000);

    const error = await promiseRef;
    expect(error).toBeInstanceOf(Error);
    expect(queue.getStats().failed).toBe(1);
    // nothing was emitted for a failed extraction
    expect(send).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Extraction failed'));
  });
});
