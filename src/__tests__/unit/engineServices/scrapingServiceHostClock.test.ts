/**
 * The engine's scraping service on the host clock (QB-U30b, design.host_clock.callers):
 *   - the plugin-mounted routes (rulesets /scrape/mfc, /sync/validate-cookies, /sync/export-csv, the
 *     /sync list workflows) reach stores through ctx.services.scraping; that service is built with
 *     caller 'pluginRoute' and every page.goto it makes (scrapePage, scrapePageStealth, browserFetch
 *     and the page a withPage callback drives) passes the clock at the navigation itself;
 *   - a browser-lane SESSION PRIME is a second request in one call: in a service whose caller clocks
 *     the call (the queue, /lookup, /catalog, /resolve), the prime is the call's first request and the
 *     target that follows passes the clock as 'sessionPrime'; in the plugin service both navigations
 *     pass it (the prime as 'sessionPrime').
 * Puppeteer is mocked; a recording pacer stands in for the clock.
 */
import { jest } from '@jest/globals';
import puppeteer from 'puppeteer';
import type { Page, Browser } from 'puppeteer';
import { BrowserPool } from '../../../services/genericScraper';
import { createScrapingService } from '../../../services/engineServices/scrapingService';
import { clearChallengeGates } from '../../../services/browserChallenge';
import { resetHostConcurrency } from '../../../services/gatedBrowsers';
import type { HostClockPacer } from '../../../services/hostClockSend';

const URL_A = 'https://alpha.example.test/item/1';
const URL_B = 'https://alpha.example.test/item/2';
const PRIME = 'https://alpha.example.test/';

describe('createScrapingService on the host clock', () => {
  let mockPage: jest.Mocked<Page>;
  let gotos: string[];
  let events: string[];
  let pacer: HostClockPacer;

  beforeEach(async () => {
    jest.clearAllMocks();
    await BrowserPool.reset();
    (BrowserPool as any).stealthBrowser = null;
    clearChallengeGates();
    resetHostConcurrency();
    gotos = [];
    events = [];
    pacer = {
      first: (url: string) => { events.push(`first ${url}`); },
      send: async (url, caller, invoke) => {
        events.push(`send ${caller} ${url}`);
        return invoke();
      },
    };
    mockPage = {
      goto: jest.fn<(...args: any[]) => any>().mockImplementation(async (url: string) => {
        gotos.push(url);
        return { status: () => 200 };
      }),
      title: jest.fn<(...args: any[]) => any>().mockResolvedValue('Mock Page Title'),
      content: jest.fn<(...args: any[]) => any>().mockResolvedValue('<html><body>mock</body></html>'),
      evaluate: jest.fn<(...args: any[]) => any>().mockResolvedValue('mock body text'),
      setViewport: jest.fn<(...args: any[]) => any>().mockResolvedValue(undefined),
      setUserAgent: jest.fn<(...args: any[]) => any>().mockResolvedValue(undefined),
      setCookie: jest.fn<(...args: any[]) => any>().mockResolvedValue(undefined),
      setExtraHTTPHeaders: jest.fn<(...args: any[]) => any>().mockResolvedValue(undefined),
      on: jest.fn(),
      off: jest.fn(),
      mainFrame: jest.fn(() => ({ id: 'main' })),
      close: jest.fn<(...args: any[]) => any>().mockResolvedValue(undefined),
      waitForSelector: jest.fn<(...args: any[]) => any>().mockResolvedValue({}),
      waitForNetworkIdle: jest.fn<(...args: any[]) => any>().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<Page>;
    const mockContext = {
      newPage: jest.fn<(...args: any[]) => any>().mockResolvedValue(mockPage),
      close: jest.fn<(...args: any[]) => any>().mockResolvedValue(undefined),
    };
    const mockBrowser = {
      newPage: jest.fn<(...args: any[]) => any>().mockResolvedValue(mockPage),
      close: jest.fn<(...args: any[]) => any>().mockResolvedValue(undefined),
      connected: true,
      createBrowserContext: jest.fn<(...args: any[]) => any>().mockResolvedValue(mockContext),
    } as unknown as jest.Mocked<Browser>;
    jest.mocked(puppeteer.launch).mockClear();
    jest.mocked(puppeteer.launch).mockResolvedValue(mockBrowser);
  });

  describe("the plugin service (caller 'pluginRoute')", () => {
    it('scrapePage, scrapePageStealth and browserFetch pass the clock at their navigation', async () => {
      const service = createScrapingService(undefined, { clockCaller: 'pluginRoute', pacer });
      await service.scrapePage(URL_A);
      await service.scrapePageStealth(URL_B);
      await service.browserFetch(URL_A);
      expect(events).toEqual([`send pluginRoute ${URL_A}`, `send pluginRoute ${URL_B}`, `send pluginRoute ${URL_A}`]);
      expect(gotos).toEqual([URL_A, URL_B, URL_A]);
    });

    it("a withPage callback's every page.goto passes the clock; the rest of the page is the page itself", async () => {
      const service = createScrapingService(undefined, { clockCaller: 'pluginRoute', pacer });
      const title = await service.withPage(async (page: Page) => {
        await page.goto(URL_A);
        await page.goto(URL_B, { waitUntil: 'load' });
        return page.title();
      });
      expect(title).toBe('Mock Page Title');
      expect(events).toEqual([`send pluginRoute ${URL_A}`, `send pluginRoute ${URL_B}`]);
      expect(mockPage.goto).toHaveBeenNthCalledWith(2, URL_B, { waitUntil: 'load' });
    });

    it('a declared prime: the prime navigation passes as sessionPrime, the target as pluginRoute', async () => {
      const service = createScrapingService(undefined, { clockCaller: 'pluginRoute', pacer });
      await service.scrapePage(URL_A, { primeUrl: PRIME });
      expect(gotos).toEqual([PRIME, URL_A]);
      expect(events).toEqual([`send sessionPrime ${PRIME}`, `send pluginRoute ${URL_A}`]);
    });
  });

  describe('a service whose caller clocks the call (the queue, /lookup, /catalog, /resolve)', () => {
    it('no prime: nothing passes the pacer here (byte-identical)', async () => {
      const service = createScrapingService(undefined, { pacer });
      await service.scrapePage(URL_A);
      await service.withPage(async (page: Page) => { await page.goto(URL_B); });
      expect(events).toEqual([]);
      expect(gotos).toEqual([URL_A, URL_B]);
    });

    it('a declared prime: the prime is the first request (stamped there), the target follows through the clock as sessionPrime', async () => {
      const service = createScrapingService(undefined, { pacer });
      await service.scrapePage(URL_A, { primeUrl: PRIME });
      expect(gotos).toEqual([PRIME, URL_A]);
      expect(events).toEqual([`first ${PRIME}`, `send sessionPrime ${URL_A}`]);
    });
  });

  it('by default the process pacer is used (the clock is off in tests: navigations go as before)', async () => {
    const service = createScrapingService(undefined, { clockCaller: 'pluginRoute' });
    await service.scrapePage(URL_A, { primeUrl: PRIME });
    expect(gotos).toEqual([PRIME, URL_A]);
  });
});
