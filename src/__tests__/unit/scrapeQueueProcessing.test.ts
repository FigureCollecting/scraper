/**
 * Tests for ScrapeQueue processing loop
 * Exercises the actual processing pipeline: processNext, handleSuccess,
 * handleFailure, classifyError, shouldRetry, getNextProcessableItem.
 *
 * The queue is ingest-path-only (extraction is plugin territory), so the
 * work function is driven via the DI seams: setPluginRegistry /
 * setIngestEmitter / setScrapingService. Failures are injected through the
 * raw page fetch (scrapePage / scrapePageStealth).
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
import {
  ScrapeQueue,
  resetScrapeQueue,
} from '../../services/scrapeQueue';
import { createExtractionRegistry, ExtractionRegistryImpl } from '../../services/extractionRegistry';

/** Registry with the fixture site registered against the queue's MFC URLs. */
function makeRegistry(ruleset: ExtractionRuleset): ExtractionRegistryImpl {
  const registry = createExtractionRegistry();
  registry.registerSite({
    siteId: ruleset.siteId,
    name: 'Mock Site',
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

/** Fixture ruleset whose extract() returns the given field bag. */
function makeRuleset(fields: Record<string, unknown> = { name: 'Figure' }): ExtractionRuleset {
  return {
    siteId: 'mock-site',
    version: '1.0.0',
    extract: (html: string, url: string) => ({
      source: {
        site: 'mock-site',
        itemId: '1',
        url,
        extractedAt: '2026-07-24T00:00:00.000Z',
        rulesetVersion: '1.0.0',
      },
      fields,
      warnings: [],
    }),
    validate: () => ({ valid: true, errors: [], warnings: [] }),
  };
}

function makeScrapingStub() {
  return {
    scrapePage: jest.fn().mockResolvedValue({
      html: '<html></html>',
      url: 'https://myfigurecollection.net/item/12345',
      title: 'Item',
      statusCode: 200,
    }),
    scrapePageStealth: jest.fn().mockResolvedValue({
      html: '<html></html>',
      url: 'https://myfigurecollection.net/item/12345',
      title: 'Item',
      statusCode: 200,
    }),
  };
}

describe('ScrapeQueue - processing loop', () => {
  let queue: ScrapeQueue;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ advanceTimers: true });
    resetScrapeQueue();
    // Re-establish mock return values after clearAllMocks
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

  /** Build a queue wired for the ingest path with a controllable fetch stub. */
  function makeIngestQueue(fields?: Record<string, unknown>) {
    const scraping = makeScrapingStub();
    const send = jest.fn().mockResolvedValue({ sourceId: 'src-1' });
    queue = new ScrapeQueue(false);
    queue.setPluginRegistry(makeRegistry(makeRuleset(fields)));
    queue.setIngestEmitter({ send });
    queue.setScrapingService(scraping);
    return { scraping, send };
  }

  it('should process an item successfully and resolve the promise', async () => {
    const scrapedData = { name: 'Test Figure', imageUrl: 'http://example.com/img.jpg' };
    makeIngestQueue(scrapedData);

    const result = queue.enqueue('12345', { priority: 'WARM' });

    await advanceAndFlush(500);

    const data = await result.promise;
    expect(data).toEqual(scrapedData);

    const stats = queue.getStats();
    expect(stats.completed).toBe(1);
    expect(stats.failed).toBe(0);
  });

  it('should retry on timeout error', async () => {
    const { scraping } = makeIngestQueue({ name: 'Figure' });
    scraping.scrapePage
      .mockRejectedValueOnce(new Error('Navigation timeout exceeded'))
      .mockResolvedValueOnce({
        html: '<html></html>',
        url: 'https://myfigurecollection.net/item/12345',
        title: 'Item',
        statusCode: 200,
      });

    const result = queue.enqueue('12345', { priority: 'WARM' });
    // No need to catch - it will succeed on retry

    // Process first attempt
    await advanceAndFlush(500);
    // Wait for retry delay
    await advanceAndFlush(5000);
    await advanceAndFlush(5000);

    const data = await result.promise;
    expect(data.name).toBe('Figure');
    expect(scraping.scrapePage).toHaveBeenCalledTimes(2);
  });

  it('should retry on network error', async () => {
    const { scraping } = makeIngestQueue({ name: 'Figure' });
    scraping.scrapePage
      .mockRejectedValueOnce(new Error('ERR_CONNECTION_REFUSED'))
      .mockResolvedValueOnce({
        html: '<html></html>',
        url: 'https://myfigurecollection.net/item/12345',
        title: 'Item',
        statusCode: 200,
      });

    const result = queue.enqueue('12345', { priority: 'HOT' });

    await advanceAndFlush(500);
    await advanceAndFlush(5000);
    await advanceAndFlush(5000);

    const data = await result.promise;
    expect(data.name).toBe('Figure');
  });

  it('should NOT retry on auth_required error', async () => {
    const { scraping } = makeIngestQueue();
    scraping.scrapePage.mockRejectedValue(new Error('AUTH: authentication required'));

    const result = queue.enqueue('12345', { priority: 'WARM' });
    const promiseRef = result.promise.catch((e: Error) => e);

    await advanceAndFlush(500);
    await advanceAndFlush(5000);

    const error = await promiseRef;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('auth_required');
    // Should only have been called once (no retry for auth errors)
    expect(scraping.scrapePage).toHaveBeenCalledTimes(1);
  });

  it('should give up after max retries and reject promise', async () => {
    const { scraping } = makeIngestQueue();
    scraping.scrapePage.mockRejectedValue(new Error('timeout exceeded'));

    const result = queue.enqueue('12345', { priority: 'WARM', maxRetries: 1 });
    const promiseRef = result.promise.catch((e: Error) => e);

    // Process through attempts and retries
    for (let i = 0; i < 15; i++) {
      await advanceAndFlush(3000);
    }

    const error = await promiseRef;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('timeout');

    const stats = queue.getStats();
    expect(stats.failed).toBe(1);
  });

  it('should classify 404 errors as not_found', async () => {
    const { scraping } = makeIngestQueue();
    scraping.scrapePage.mockRejectedValue(new Error('404 - page not found'));

    const result = queue.enqueue('12345', { priority: 'WARM', maxRetries: 0 });
    const promiseRef = result.promise.catch((e: Error) => e);

    await advanceAndFlush(500);
    await advanceAndFlush(3000);

    const error = await promiseRef;
    expect((error as Error).message).toContain('not_found');
  });

  it('should classify rate limit errors and trigger rate limit mode', async () => {
    const { scraping } = makeIngestQueue();
    scraping.scrapePage.mockRejectedValue(new Error('CLOUDFLARE: Rate limited'));

    const result = queue.enqueue('12345', { priority: 'WARM', maxRetries: 0 });
    result.promise.catch(() => {});

    await advanceAndFlush(500);
    await advanceAndFlush(5000);

    const stats = queue.getStats();
    expect(stats.rateLimited).toBe(true);
  });

  it('should reduce delay after consecutive successes', async () => {
    makeIngestQueue({ name: 'Figure' });
    // First trigger rate limit to increase delay
    queue.triggerRateLimit();
    const highDelay = queue.getStats().currentDelay;

    // Enqueue multiple items
    const promises: Promise<any>[] = [];
    for (let i = 1; i <= 5; i++) {
      const r = queue.enqueue(String(i), { priority: 'WARM' });
      promises.push(r.promise.catch(() => {}));
    }

    // Process all items with enough time for high delay
    for (let i = 0; i < 30; i++) {
      await advanceAndFlush(highDelay + 1000);
    }

    await Promise.allSettled(promises);

    const finalStats = queue.getStats();
    expect(finalStats.currentDelay).toBeLessThan(highDelay);
    expect(finalStats.completed).toBeGreaterThanOrEqual(3);
  });

  it('should track per-status completion', async () => {
    makeIngestQueue({ name: 'Figure' });
    const r1 = queue.enqueue('1', { priority: 'WARM', status: 'owned' });
    const r2 = queue.enqueue('2', { priority: 'WARM', status: 'ordered' });

    for (let i = 0; i < 20; i++) {
      await advanceAndFlush(3000);
    }

    await Promise.all([r1.promise, r2.promise]);

    const stats = queue.getStats();
    expect(stats.byStatus!.owned.completed).toBe(1);
    expect(stats.byStatus!.ordered.completed).toBe(1);
  });

  it('should NOT call the success webhook (ingest path emits to the spine only)', async () => {
    makeIngestQueue({ name: 'Figure' });
    const result = queue.enqueue('12345', {
      priority: 'WARM',
      sessionId: 'session1',
    });

    await advanceAndFlush(500);
    await advanceAndFlush(3000);

    await result.promise;
    expect(mockNotifyItemSuccess).not.toHaveBeenCalled();
  });

  it('should call webhook on permanent failure for non-cookie session items', async () => {
    const { scraping } = makeIngestQueue();
    scraping.scrapePage.mockRejectedValue(new Error('AUTH: required'));

    // Use WARM without cookies so the standard retry/failure path runs (not session manager)
    const result = queue.enqueue('12345', {
      priority: 'WARM',
      sessionId: 'session1',
      maxRetries: 0,
    });
    result.promise.catch(() => {});

    await advanceAndFlush(500);
    await advanceAndFlush(5000);
    await advanceAndFlush(1000);

    expect(mockNotifyItemFailed).toHaveBeenCalled();
  });

  it('should handle Cloudflare rate limit with session reporting', async () => {
    const { scraping } = makeIngestQueue();
    scraping.scrapePageStealth.mockRejectedValue(new Error('Cloudflare blocked'));

    const result = queue.enqueue('12345', {
      priority: 'HOT',
      sessionId: 'session1',
      cookies: { PHPSESSID: 'a' },
      maxRetries: 0,
    });
    result.promise.catch(() => {});

    await advanceAndFlush(500);
    await advanceAndFlush(5000);

    const stats = queue.getStats();
    expect(stats.rateLimited).toBe(true);
  });

  it('should handle unknown error type', async () => {
    const { scraping } = makeIngestQueue();
    scraping.scrapePage.mockRejectedValue(new Error('Something weird happened'));

    const result = queue.enqueue('12345', { priority: 'WARM', maxRetries: 0 });
    const promiseRef = result.promise.catch((e: Error) => e);

    await advanceAndFlush(500);
    await advanceAndFlush(5000);

    const error = await promiseRef;
    expect((error as Error).message).toContain('unknown');
  });

  it('should stop processing when queue is empty', async () => {
    makeIngestQueue({ name: 'Figure' });
    const result = queue.enqueue('12345', { priority: 'WARM' });

    await advanceAndFlush(500);

    await result.promise;

    await advanceAndFlush(5000);

    const stats = queue.getStats();
    expect(stats.total).toBe(0);
    expect(stats.completed).toBe(1);
  });

  it('should track per-status failed counts', async () => {
    const { scraping } = makeIngestQueue();
    scraping.scrapePage.mockRejectedValue(new Error('AUTH: fail'));

    const result = queue.enqueue('1', { priority: 'WARM', status: 'owned', maxRetries: 0 });
    result.promise.catch(() => {});

    await advanceAndFlush(500);
    await advanceAndFlush(5000);

    const stats = queue.getStats();
    expect(stats.byStatus!.owned.failed).toBe(1);
  });
});
