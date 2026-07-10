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
      close: jest.fn<(...args: any[]) => any>().mockResolvedValue(undefined),
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
});
