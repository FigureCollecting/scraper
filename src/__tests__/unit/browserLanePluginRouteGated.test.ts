/**
 * The plugin service's clock-paced page (QB-U30b caller 'pluginRoute') on the GATED lane: the page
 * the navigation runs on is a Proxy of the real tab, and the gated runner still reads the challenge
 * outcome off the real tab, so the first-navigation retry (the 2026-09-11 fix) works for plugin
 * routes too. Puppeteer is mocked; fixture host only.
 */
import { jest } from '@jest/globals';
import puppeteer from 'puppeteer';
import type { Browser, Page } from 'puppeteer';
import { BrowserPool } from '../../services/genericScraper';
import { createScrapingService } from '../../services/engineServices/scrapingService';
import { clearChallengeGates } from '../../services/browserChallenge';
import { resetHostConcurrency } from '../../services/gatedBrowsers';
import type { HostClockPacer } from '../../services/hostClockSend';

const PROXY = 'socks5://127.0.0.1:1055';
const GATED = 'https://gated.example.test/item/1';

describe('plugin service on the gated lane', () => {
  const savedMode = process.env.BROWSER_LAUNCH_MODE;
  let gotos: string[];

  const newMockPage = (stuck: boolean): jest.Mocked<Page> =>
    ({
      goto: jest.fn<(...a: any[]) => any>().mockImplementation(async (url: any) => {
        gotos.push(String(url));
        return {
          status: () => 200,
          url: () => String(url),
          headers: () => (stuck ? { 'content-type': 'text/html', 'cf-mitigated': 'challenge' } : { 'content-type': 'text/html' }),
        };
      }),
      title: jest.fn<(...a: any[]) => any>().mockResolvedValue(stuck ? 'Just a moment...' : 'Lucy'),
      content: jest.fn<(...a: any[]) => any>().mockResolvedValue(stuck ? '<html>interstitial</html>' : '<html>store</html>'),
      evaluate: jest.fn<(...a: any[]) => any>().mockResolvedValue('body'),
      emulateTimezone: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
      setViewport: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
      setUserAgent: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
      setExtraHTTPHeaders: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
      setCookie: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
      close: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
      on: jest.fn(),
      off: jest.fn(),
      mainFrame: jest.fn(() => ({ id: 'main' })),
    }) as unknown as jest.Mocked<Page>;

  beforeEach(async () => {
    jest.clearAllMocks();
    await BrowserPool.reset();
    (BrowserPool as any).stealthBrowser = null;
    clearChallengeGates();
    resetHostConcurrency();
    process.env.BROWSER_LAUNCH_MODE = 'clean-headful';
    gotos = [];
    let opened = 0;
    jest.mocked(puppeteer.launch).mockImplementation(async () => ({
      // The first tab stays on the interstitial; the retry's tab clears.
      newPage: jest.fn<(...a: any[]) => any>().mockImplementation(async () => newMockPage(opened++ === 0)),
      createBrowserContext: jest.fn<(...a: any[]) => any>(),
      close: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
      process: jest.fn(() => ({ pid: 424242 })),
      cookies: jest.fn<(...a: any[]) => any>().mockResolvedValue([]),
      setCookie: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
      connected: true,
    }) as unknown as Browser);
  });

  afterEach(async () => {
    if (savedMode === undefined) delete process.env.BROWSER_LAUNCH_MODE;
    else process.env.BROWSER_LAUNCH_MODE = savedMode;
    await BrowserPool.reset();
    clearChallengeGates();
    resetHostConcurrency();
  });

  it('retries the first navigation once through the paced page, each navigation passing the clock', async () => {
    const events: string[] = [];
    const pacer: HostClockPacer = {
      first: url => { events.push(`first ${url}`); },
      send: async (url, caller, invoke) => {
        events.push(`send ${caller} ${url}`);
        return invoke();
      },
    };
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.useFakeTimers();
    try {
      const service = createScrapingService(undefined, { clockCaller: 'pluginRoute', pacer });
      const fetching = service.browserFetch(GATED, { challengeGated: true, proxyServer: PROXY });
      await jest.advanceTimersByTimeAsync(40_000);
      expect(await fetching).toBe('<html>store</html>');
      expect(gotos).toEqual([GATED, GATED]);
      expect(events).toEqual([`send pluginRoute ${GATED}`, `send pluginRoute ${GATED}`]);
      expect(BrowserPool.gatedLaneStats('residential').firstNavigationRetries).toBe(1);
    } finally {
      jest.useRealTimers();
      warnSpy.mockRestore();
    }
  });
});
