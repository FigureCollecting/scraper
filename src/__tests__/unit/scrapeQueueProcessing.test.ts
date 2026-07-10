/**
 * Tests for ScrapeQueue processing loop
 * Exercises the actual processing pipeline: processNext, handleSuccess,
 * handleFailure, classifyError, shouldRetry, getNextProcessableItem
 */

// Mock scrapeMFC to control scraping outcomes
const mockScrapeMFC = jest.fn();

// Persistent mock objects that survive clearAllMocks
const mockNotifyItemSuccess = jest.fn().mockResolvedValue(true);
const mockNotifyItemFailed = jest.fn().mockResolvedValue(true);
const mockNotifyItemSkipped = jest.fn().mockResolvedValue(true);

jest.mock('../../services/genericScraper', () => ({
  scrapeMFC: (...args: any[]) => mockScrapeMFC(...args),
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

import {
  ScrapeQueue,
  resetScrapeQueue,
} from '../../services/scrapeQueue';

describe('ScrapeQueue - processing loop', () => {
  let queue: ScrapeQueue;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ advanceTimers: true });
    resetScrapeQueue();
    mockScrapeMFC.mockReset();
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

  it('should process an item successfully and resolve the promise', async () => {
    const scrapedData = { name: 'Test Figure', imageUrl: 'http://example.com/img.jpg' };
    mockScrapeMFC.mockResolvedValue(scrapedData);

    queue = new ScrapeQueue(false);
    const result = queue.enqueue('12345', { priority: 'WARM' });

    await advanceAndFlush(500);

    const data = await result.promise;
    expect(data).toEqual(scrapedData);
    expect(mockScrapeMFC).toHaveBeenCalled();

    const stats = queue.getStats();
    expect(stats.completed).toBe(1);
    expect(stats.failed).toBe(0);
  });

  it('should retry on timeout error', async () => {
    mockScrapeMFC
      .mockRejectedValueOnce(new Error('Navigation timeout exceeded'))
      .mockResolvedValueOnce({ name: 'Figure' });

    queue = new ScrapeQueue(false);
    const result = queue.enqueue('12345', { priority: 'WARM' });
    // No need to catch - it will succeed on retry

    // Process first attempt
    await advanceAndFlush(500);
    // Wait for retry delay
    await advanceAndFlush(5000);
    await advanceAndFlush(5000);

    const data = await result.promise;
    expect(data.name).toBe('Figure');
    expect(mockScrapeMFC).toHaveBeenCalledTimes(2);
  });

  it('should retry on network error', async () => {
    mockScrapeMFC
      .mockRejectedValueOnce(new Error('ERR_CONNECTION_REFUSED'))
      .mockResolvedValueOnce({ name: 'Figure' });

    queue = new ScrapeQueue(false);
    const result = queue.enqueue('12345', { priority: 'HOT' });

    await advanceAndFlush(500);
    await advanceAndFlush(5000);
    await advanceAndFlush(5000);

    const data = await result.promise;
    expect(data.name).toBe('Figure');
  });

  it('should NOT retry on auth_required error', async () => {
    mockScrapeMFC.mockRejectedValue(new Error('AUTH: authentication required'));

    queue = new ScrapeQueue(false);
    const result = queue.enqueue('12345', { priority: 'WARM' });
    const promiseRef = result.promise.catch((e: Error) => e);

    await advanceAndFlush(500);
    await advanceAndFlush(5000);

    const error = await promiseRef;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('auth_required');
    // Should only have been called once (no retry for auth errors)
    expect(mockScrapeMFC).toHaveBeenCalledTimes(1);
  });

  it('should give up after max retries and reject promise', async () => {
    mockScrapeMFC.mockRejectedValue(new Error('timeout exceeded'));

    queue = new ScrapeQueue(false);
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
    mockScrapeMFC.mockRejectedValue(new Error('MFC 404 - not found'));

    queue = new ScrapeQueue(false);
    const result = queue.enqueue('12345', { priority: 'WARM', maxRetries: 0 });
    const promiseRef = result.promise.catch((e: Error) => e);

    await advanceAndFlush(500);
    await advanceAndFlush(3000);

    const error = await promiseRef;
    expect((error as Error).message).toContain('not_found');
  });

  it('should classify rate limit errors and trigger rate limit mode', async () => {
    mockScrapeMFC.mockRejectedValue(new Error('CLOUDFLARE: Rate limited'));

    queue = new ScrapeQueue(false);
    const result = queue.enqueue('12345', { priority: 'WARM', maxRetries: 0 });
    result.promise.catch(() => {});

    await advanceAndFlush(500);
    await advanceAndFlush(5000);

    const stats = queue.getStats();
    expect(stats.rateLimited).toBe(true);
  });

  it('should reduce delay after consecutive successes', async () => {
    mockScrapeMFC.mockResolvedValue({ name: 'Figure' });

    queue = new ScrapeQueue(false);
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
    mockScrapeMFC.mockResolvedValue({ name: 'Figure' });

    queue = new ScrapeQueue(false);
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

  it('should call webhook on success for session items', async () => {
    mockScrapeMFC.mockResolvedValue({ name: 'Figure' });

    queue = new ScrapeQueue(false);
    // Use WARM without cookies to avoid session manager cookie-failure path
    const result = queue.enqueue('12345', {
      priority: 'WARM',
      sessionId: 'session1',
    });

    await advanceAndFlush(500);
    await advanceAndFlush(3000);

    await result.promise;
    expect(mockNotifyItemSuccess).toHaveBeenCalledWith('session1', '12345', expect.any(Object));
  });

  it('should pass raw HTML capture fields through to the item-complete webhook payload unmodified', async () => {
    // Proves the queue threads scrapedData straight through to the webhook client without
    // stripping fields -- so whatever genericScraper attaches (e.g. under PERSIST_RAW_HTML)
    // reaches the backend on the item-complete webhook.
    const scrapedData = {
      name: 'Figure',
      rawHtmlGz: 'base64gzipfixture==',
      htmlSha: 'a'.repeat(64),
      rawHtmlBytes: 1234,
    };
    mockScrapeMFC.mockResolvedValue(scrapedData);

    queue = new ScrapeQueue(false);
    const result = queue.enqueue('12345', {
      priority: 'WARM',
      sessionId: 'session1',
    });

    await advanceAndFlush(500);
    await advanceAndFlush(3000);

    await result.promise;
    expect(mockNotifyItemSuccess).toHaveBeenCalledWith('session1', '12345', scrapedData);
  });

  it('should call webhook on permanent failure for non-cookie session items', async () => {
    mockScrapeMFC.mockRejectedValue(new Error('AUTH: required'));

    queue = new ScrapeQueue(false);
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
    mockScrapeMFC.mockRejectedValue(new Error('Cloudflare blocked'));

    queue = new ScrapeQueue(false);
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
    mockScrapeMFC.mockRejectedValue(new Error('Something weird happened'));

    queue = new ScrapeQueue(false);
    const result = queue.enqueue('12345', { priority: 'WARM', maxRetries: 0 });
    const promiseRef = result.promise.catch((e: Error) => e);

    await advanceAndFlush(500);
    await advanceAndFlush(5000);

    const error = await promiseRef;
    expect((error as Error).message).toContain('unknown');
  });

  it('should stop processing when queue is empty', async () => {
    mockScrapeMFC.mockResolvedValue({ name: 'Figure' });

    queue = new ScrapeQueue(false);
    const result = queue.enqueue('12345', { priority: 'WARM' });

    await advanceAndFlush(500);

    await result.promise;

    await advanceAndFlush(5000);

    const stats = queue.getStats();
    expect(stats.total).toBe(0);
    expect(stats.completed).toBe(1);
  });

  it('should track per-status failed counts', async () => {
    mockScrapeMFC.mockRejectedValue(new Error('AUTH: fail'));

    queue = new ScrapeQueue(false);
    const result = queue.enqueue('1', { priority: 'WARM', status: 'owned', maxRetries: 0 });
    result.promise.catch(() => {});

    await advanceAndFlush(500);
    await advanceAndFlush(5000);

    const stats = queue.getStats();
    expect(stats.byStatus!.owned.failed).toBe(1);
  });
});
