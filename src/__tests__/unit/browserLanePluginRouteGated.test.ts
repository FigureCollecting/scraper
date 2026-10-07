/**
 * The plugin service on the host clock (QB-U30b caller 'pluginRoute') on the GATED lane: each tab's
 * page-level requests pass the clock at the request (interception on the tab), and the gated runner
 * still reads the challenge outcome off the tab, so the first-navigation retry (the 2026-09-11 fix)
 * works for plugin routes too. Puppeteer is mocked; fixture host only.
 */
import { jest } from '@jest/globals';
import puppeteer from 'puppeteer';
import type { Browser, Page } from 'puppeteer';
import { BrowserPool } from '../../services/genericScraper';
import { createScrapingService } from '../../services/engineServices/scrapingService';
import { clearChallengeGates } from '../../services/browserChallenge';
import { resetHostConcurrency } from '../../services/gatedBrowsers';
import type { PageRequestPacer } from '../../services/hostClockSend';
import { requestModelPage } from '../helpers/requestModelPage';

const PROXY = 'socks5://127.0.0.1:1055';
const GATED = 'https://gated.example.test/item/1';

describe('plugin service on the gated lane', () => {
  const savedMode = process.env.BROWSER_LAUNCH_MODE;
  let models: Array<ReturnType<typeof requestModelPage>>;

  /** A tab that models request issue and interception; the first one stays on the interstitial. */
  const newMockPage = (stuck: boolean): jest.Mocked<Page> => {
    const model = requestModelPage({
      respond: url => ({
        status: () => 200,
        url: () => url,
        headers: (): Record<string, string> => (stuck ? { 'content-type': 'text/html', 'cf-mitigated': 'challenge' } : { 'content-type': 'text/html' }),
      }),
      extra: {
        title: jest.fn<(...a: any[]) => any>().mockResolvedValue(stuck ? 'Just a moment...' : 'Lucy'),
        content: jest.fn<(...a: any[]) => any>().mockResolvedValue(stuck ? '<html>interstitial</html>' : '<html>store</html>'),
        evaluate: jest.fn<(...a: any[]) => any>().mockResolvedValue('body'),
      },
    });
    models.push(model);
    return model.page;
  };
  const gotos = () => models.flatMap(m => m.wire.map(w => w.url));

  beforeEach(async () => {
    jest.clearAllMocks();
    await BrowserPool.reset();
    (BrowserPool as any).stealthBrowser = null;
    clearChallengeGates();
    resetHostConcurrency();
    process.env.BROWSER_LAUNCH_MODE = 'clean-headful';
    models = [];
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
    const pacer: PageRequestPacer = {
      first: url => { events.push(`first ${url}`); },
      send: async (url, caller, invoke) => {
        events.push(`send ${caller} ${url}`);
        return invoke();
      },
      holds: () => true,
      observe: (url, caller) => { events.push(`observe ${caller} ${url}`); },
    };
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.useFakeTimers();
    try {
      const service = createScrapingService(undefined, { clockCaller: 'pluginRoute', pacer });
      const fetching = service.browserFetch(GATED, { challengeGated: true, proxyServer: PROXY });
      await jest.advanceTimersByTimeAsync(40_000);
      expect(await fetching).toBe('<html>store</html>');
      expect(gotos()).toEqual([GATED, GATED]);
      expect(models.map(m => m.interception)).toEqual([[true], [true]]);
      expect(events).toEqual([`send pluginRoute ${GATED}`, `send pluginRoute ${GATED}`]);
      expect(BrowserPool.gatedLaneStats('residential').firstNavigationRetries).toBe(1);
    } finally {
      jest.useRealTimers();
      warnSpy.mockRestore();
    }
  });
});
