import { jest } from '@jest/globals';
import puppeteer from 'puppeteer';
import type { Page, Browser } from 'puppeteer';
import { BrowserPool, scrapeGeneric } from '../../services/genericScraper';
import { createScrapingService } from '../../services/engineServices/scrapingService';

/**
 * PER-CONTEXT timezone emulation on the browser lane. One pooled browser serves residential and
 * direct stores side by side, so the timezone cannot be a process-wide TZ: it is emulated per page
 * (CDP `Emulation.setTimezoneOverride`) to match the egress that page leaves through — the
 * residential exit's zone for a proxied context, the node's own zone for a direct one.
 */
describe('browser-lane timezone emulation', () => {
  const PROXY = 'socks5://egress-proxy.fc.svc.cluster.local:1055';
  let mockPage: jest.Mocked<Page>;
  let mockContext: any;
  let mockBrowser: jest.Mocked<Browser>;
  const savedEnv = { ...process.env };

  beforeEach(async () => {
    jest.clearAllMocks();
    await BrowserPool.reset();
    (BrowserPool as any).stealthBrowser = null;
    delete process.env.RESIDENTIAL_EGRESS_TIMEZONE;
    delete process.env.DIRECT_EGRESS_TIMEZONE;

    mockPage = {
      goto: jest.fn<(...a: any[]) => any>().mockResolvedValue({ status: () => 200 }),
      title: jest.fn<(...a: any[]) => any>().mockResolvedValue('T'),
      content: jest.fn<(...a: any[]) => any>().mockResolvedValue('<html></html>'),
      evaluate: jest.fn<(...a: any[]) => any>().mockResolvedValue('body text'),
      emulateTimezone: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
      setViewport: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
      setUserAgent: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
      setExtraHTTPHeaders: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
      setCookie: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
      waitForFunction: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
      close: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
      on: jest.fn(),
      off: jest.fn(),
      mainFrame: jest.fn(() => ({ id: 'main' })),
    } as unknown as jest.Mocked<Page>;

    mockContext = {
      newPage: jest.fn<(...a: any[]) => any>().mockResolvedValue(mockPage),
      close: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
    };

    mockBrowser = {
      createBrowserContext: jest.fn<(...a: any[]) => any>().mockResolvedValue(mockContext),
      newPage: jest.fn<(...a: any[]) => any>().mockResolvedValue(mockPage),
      close: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
      connected: true,
    } as unknown as jest.Mocked<Browser>;

    jest.mocked(puppeteer.launch).mockClear();
    jest.mocked(puppeteer.launch).mockResolvedValue(mockBrowser);
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('emulates the RESIDENTIAL zone on a proxied context, before navigating', async () => {
    process.env.RESIDENTIAL_EGRESS_TIMEZONE = 'America/Chicago';
    process.env.DIRECT_EGRESS_TIMEZONE = 'America/New_York';
    const service = createScrapingService();

    await service.scrapePage('https://www.anitoysgk.com/lucy-p29358268.html', { proxyServer: PROXY });

    expect(mockPage.emulateTimezone).toHaveBeenCalledWith('America/Chicago');
    const tzOrder = jest.mocked(mockPage.emulateTimezone).mock.invocationCallOrder[0];
    const gotoOrder = jest.mocked(mockPage.goto).mock.invocationCallOrder[0];
    expect(tzOrder).toBeLessThan(gotoOrder);
  });

  it('emulates the DIRECT zone on an unproxied context', async () => {
    process.env.RESIDENTIAL_EGRESS_TIMEZONE = 'America/Chicago';
    process.env.DIRECT_EGRESS_TIMEZONE = 'America/New_York';
    const service = createScrapingService();

    await service.scrapePage('https://alpha.example.test/item/1');

    expect(mockPage.emulateTimezone).toHaveBeenCalledWith('America/New_York');
  });

  it('emulates on the browserFetch lane too', async () => {
    process.env.RESIDENTIAL_EGRESS_TIMEZONE = 'America/Chicago';
    const service = createScrapingService();

    await service.browserFetch('https://www.anitoysgk.com/search?q=lucy', { proxyServer: PROXY });

    expect(mockPage.emulateTimezone).toHaveBeenCalledWith('America/Chicago');
  });

  it('emulates nothing when the egress\'s variable is unset', async () => {
    process.env.RESIDENTIAL_EGRESS_TIMEZONE = 'America/Chicago';
    const service = createScrapingService();

    await service.scrapePage('https://alpha.example.test/item/1'); // direct, DIRECT_EGRESS_TIMEZONE unset

    expect(mockPage.emulateTimezone).not.toHaveBeenCalled();
  });

  it('emulates the DIRECT zone on the legacy selector scrape path', async () => {
    process.env.DIRECT_EGRESS_TIMEZONE = 'America/New_York';

    await scrapeGeneric('https://alpha.example.test/item/1', { nameSelector: 'h1' });

    expect(mockPage.emulateTimezone).toHaveBeenCalledWith('America/New_York');
  });
});
