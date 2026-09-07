import { jest } from '@jest/globals';
import puppeteer from 'puppeteer';
import type { Page, Browser } from 'puppeteer';
import { BrowserPool } from '../../services/genericScraper';
import { createScrapingService } from '../../services/engineServices/scrapingService';
import { clearChallengeGates, isChallengeGated } from '../../services/browserChallenge';

/**
 * The lane must not hand a ruleset the Cloudflare interstitial. A navigation whose first response is
 * `cf-mitigated: challenge` waits — bounded — for the real document to replace it, and the host is
 * remembered as gated.
 */
describe('browser lane waits out a Cloudflare challenge', () => {
  let mockPage: jest.Mocked<Page>;
  let mockContext: any;
  let mockBrowser: jest.Mocked<Browser>;

  const titleQueue = (titles: string[]) => {
    const queue = [...titles];
    return jest.fn<(...a: any[]) => any>().mockImplementation(async () => (queue.length > 1 ? queue.shift() : queue[0]));
  };

  const build = (opts: { titles: string[]; headers: Record<string, string> }) => {
    mockPage = {
      goto: jest.fn<(...a: any[]) => any>().mockResolvedValue({ status: () => 403, headers: () => opts.headers, url: () => 'https://www.anitoysgk.com/lucy.html' }),
      title: titleQueue(opts.titles),
      content: jest.fn<(...a: any[]) => any>().mockResolvedValue('<html><body>lucy</body></html>'),
      evaluate: jest.fn<(...a: any[]) => any>().mockResolvedValue('body text'),
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
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    await BrowserPool.reset();
    (BrowserPool as any).stealthBrowser = null;
    clearChallengeGates();
  });

  afterEach(async () => {
    clearChallengeGates();
    await BrowserPool.reset();
  });

  it('browserFetch waits for the interstitial to clear before reading the body, and marks the host gated', async () => {
    build({ titles: ['Just a moment...', 'Lucy — anitoys'], headers: { 'cf-mitigated': 'challenge' } });
    const service = createScrapingService();

    const body = await service.browserFetch('https://www.anitoysgk.com/lucy.html', { stealth: false });

    expect(body).toBe('<html><body>lucy</body></html>');
    expect(mockPage.title).toHaveBeenCalled();
    expect(isChallengeGated('www.anitoysgk.com')).toBe(true);
  });

  it('scrapePage waits out the interstitial too', async () => {
    build({ titles: ['Just a moment...', 'Lucy — anitoys'], headers: { 'cf-mitigated': 'challenge' } });
    const service = createScrapingService();

    const result = await service.scrapePage('https://www.anitoysgk.com/lucy.html');

    expect(result.title).toBe('Lucy — anitoys');
    expect(isChallengeGated('www.anitoysgk.com')).toBe(true);
  });

  /**
   * WIRING: the wait leaves on a `cf_clearance` cookie, which it can only read if the lane hands it a
   * page that reports the jar of the context it runs in. On the ephemeral path that is the
   * per-request `createBrowserContext`.
   */
  it('hands the wait the ephemeral context\'s cookie jar as clearance evidence', async () => {
    build({ titles: ['Just a moment...', 'Lucy — anitoys'], headers: { 'cf-mitigated': 'challenge' } });
    const cookies = jest.fn<(...a: any[]) => any>().mockResolvedValue([{ name: 'cf_clearance', domain: '.anitoysgk.com' }]);
    (mockContext as any).cookies = cookies;
    (mockPage as any).browserContext = jest.fn(() => mockContext);
    const service = createScrapingService();

    await service.browserFetch('https://www.anitoysgk.com/lucy.html', { stealth: false });

    expect(cookies).toHaveBeenCalled();
  });

  it('an unchallenged store is never marked gated and never polls', async () => {
    build({ titles: ['Alpha item'], headers: { 'content-type': 'text/html' } });
    const service = createScrapingService();

    await service.browserFetch('https://alpha.example.test/item/1', { stealth: false });

    expect(isChallengeGated('alpha.example.test')).toBe(false);
  });
});
