import { jest } from '@jest/globals';
import puppeteer from 'puppeteer';
import type { Page, Browser } from 'puppeteer';
import { BrowserPool } from '../../services/genericScraper';
import { createScrapingService } from '../../services/engineServices/scrapingService';

// The browser is intentionally long-lived (a relaunch costs 4-7s and re-triggers
// Cloudflare); the per-request unit is the BrowserContext. A context that fails
// to close leaked onto its immortal browser and was silently swallowed — the
// ~25 GB OOM. These tests pin the reliable-teardown fix.
describe('BrowserContext teardown & leak accounting', () => {
  let mockPage: jest.Mocked<Page>;
  let mockContext: any;
  let mockBrowser: jest.Mocked<Browser>;

  const makeContext = (closeImpl: () => Promise<any>) => ({
    newPage: jest.fn<(...a: any[]) => any>().mockResolvedValue(mockPage),
    close: jest.fn<(...a: any[]) => any>().mockImplementation(closeImpl),
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await BrowserPool.reset();
    (BrowserPool as any).stealthBrowser = null;

    mockPage = {
      goto: jest.fn<(...a: any[]) => any>().mockResolvedValue({ status: () => 200 }),
      title: jest.fn<(...a: any[]) => any>().mockResolvedValue('T'),
      content: jest.fn<(...a: any[]) => any>().mockResolvedValue('<html></html>'),
      evaluate: jest.fn<(...a: any[]) => any>().mockResolvedValue('b'),
      setViewport: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
      setUserAgent: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
      setCookie: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
      close: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
      // capture hook (merged from develop) attaches a 'response' listener; no-op stubs
      on: jest.fn<(...a: any[]) => any>(),
      off: jest.fn<(...a: any[]) => any>(),
    } as unknown as jest.Mocked<Page>;

    mockContext = makeContext(() => Promise.resolve());
    mockBrowser = {
      createBrowserContext: jest.fn<(...a: any[]) => any>().mockImplementation(async () => mockContext),
      close: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
      connected: true,
    } as unknown as jest.Mocked<Browser>;
    jest.mocked(puppeteer.launch).mockClear();
    jest.mocked(puppeteer.launch).mockResolvedValue(mockBrowser);
  });

  it('clean close: returns the pooled browser and counts the context', async () => {
    const service = createScrapingService();
    await service.scrapePage('https://a.test/1');

    expect(mockContext.close).toHaveBeenCalled();
    expect(BrowserPool.getPoolSize()).toBe(BrowserPool.getPoolCapacity());
    expect(BrowserPool.contextStats()).toEqual({ opened: 1, closed: 1, failed: 0, leaked: 0 });
  });

  it('failing close: RETIRES the pooled browser instead of leaking it, and counts the failure', async () => {
    mockContext = makeContext(() => Promise.reject(new Error('context stuck')));
    const service = createScrapingService();

    await service.scrapePage('https://a.test/1');

    // the poisoned browser was closed (retired), not silently returned
    expect(mockBrowser.close).toHaveBeenCalled();
    const stats = BrowserPool.contextStats();
    expect(stats.failed).toBe(1);
    expect(stats.closed).toBe(0);
  });

  it('failing close on stealth: retires the singleton so the next request relaunches it', async () => {
    mockContext = makeContext(() => Promise.reject(new Error('context stuck')));
    const service = createScrapingService();

    await service.scrapePageStealth('https://a.test/1');

    expect((BrowserPool as any).stealthBrowser).toBeNull();
    expect(BrowserPool.contextStats().failed).toBe(1);
  });

  it('closeContext: a hung close times out and is treated as a leak (not an infinite hang)', async () => {
    jest.useFakeTimers();
    const hanging = { close: () => new Promise(() => {}) } as any;
    const p = BrowserPool.closeContext(hanging);
    await jest.advanceTimersByTimeAsync(10_000);
    await expect(p).resolves.toBe(false);
    expect(BrowserPool.contextStats().failed).toBe(1);
    jest.useRealTimers();
  });
});
