import { jest } from '@jest/globals';
import puppeteer from 'puppeteer';
import type { Page, Browser } from 'puppeteer';
import { BrowserPool } from '../../services/genericScraper';
import { createScrapingService } from '../../services/engineServices/scrapingService';
import { clearChallengeGates } from '../../services/browserChallenge';
import { resetPersistentContexts } from '../../services/persistentContexts';

/**
 * In clean-headful mode the browser IS the disguise, so the lane must stop dressing it up. Two
 * overrides that are harmless on headless Chrome are actively harmful here:
 *   - the default `Chrome/127` user agent, on a Chrome 152 binary — Cloudflare cross-checks UA
 *     against the client hints the same browser sends, and BINDS the clearance it issues to the UA;
 *   - the 1280x720 device-metrics override, against a 1280x900 window.
 * Both are still applied when a store DECLARES them (a pinned mint UA must match its stored cookie),
 * and both are unchanged in the default headless profile.
 */
describe('clean-headful page setup', () => {
  let mockPage: jest.Mocked<Page>;
  let mockContext: any;
  let mockBrowser: jest.Mocked<Browser>;
  const savedMode = process.env.BROWSER_LAUNCH_MODE;

  beforeEach(async () => {
    jest.clearAllMocks();
    await BrowserPool.reset();
    (BrowserPool as any).stealthBrowser = null;
    clearChallengeGates();
    resetPersistentContexts();

    mockPage = {
      goto: jest.fn<(...a: any[]) => any>().mockResolvedValue({ status: () => 200, headers: () => ({ 'content-type': 'text/html' }), url: () => 'https://x.test/1' }),
      title: jest.fn<(...a: any[]) => any>().mockResolvedValue('T'),
      content: jest.fn<(...a: any[]) => any>().mockResolvedValue('<html></html>'),
      evaluate: jest.fn<(...a: any[]) => any>().mockResolvedValue('b'),
      setViewport: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
      setUserAgent: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
      setExtraHTTPHeaders: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
      setCookie: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
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
      close: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
      connected: true,
    } as unknown as jest.Mocked<Browser>;
    jest.mocked(puppeteer.launch).mockClear();
    jest.mocked(puppeteer.launch).mockResolvedValue(mockBrowser);
  });

  afterEach(async () => {
    if (savedMode === undefined) delete process.env.BROWSER_LAUNCH_MODE;
    else process.env.BROWSER_LAUNCH_MODE = savedMode;
    await BrowserPool.reset();
    resetPersistentContexts();
  });

  it('leaves the real browser UA and window size alone when nothing is declared', async () => {
    process.env.BROWSER_LAUNCH_MODE = 'clean-headful';
    const service = createScrapingService();

    await service.browserFetch('https://www.anitoysgk.com/lucy.html', { stealth: false });

    expect(mockPage.setUserAgent).not.toHaveBeenCalled();
    expect(mockPage.setViewport).not.toHaveBeenCalled();
  });

  it('still applies a UA the request declares', async () => {
    process.env.BROWSER_LAUNCH_MODE = 'clean-headful';
    const service = createScrapingService();

    await service.browserFetch('https://www.anitoysgk.com/lucy.html', { stealth: false, userAgent: 'Declared/1.0' });

    expect(mockPage.setUserAgent).toHaveBeenCalledWith('Declared/1.0');
  });

  it('still applies the UA pinned to a host\'s stored cookies (the clearance is bound to it)', async () => {
    process.env.BROWSER_LAUNCH_MODE = 'clean-headful';
    const cookieStore = { cookiesFor: () => undefined, userAgentFor: () => 'Pinned/152.0' };
    const service = createScrapingService(undefined, { cookieStore });

    await service.browserFetch('https://www.anitoysgk.com/lucy.html', { stealth: false });

    expect(mockPage.setUserAgent).toHaveBeenCalledWith('Pinned/152.0');
  });

  it('keeps the historical UA and viewport in the default headless profile', async () => {
    delete process.env.BROWSER_LAUNCH_MODE;
    const service = createScrapingService();

    await service.scrapePage('https://alpha.example.test/item/1');

    expect(mockPage.setViewport).toHaveBeenCalledWith({ width: 1280, height: 720 });
    expect(mockPage.setUserAgent).toHaveBeenCalledWith(expect.stringContaining('Chrome/127'));
  });
});
