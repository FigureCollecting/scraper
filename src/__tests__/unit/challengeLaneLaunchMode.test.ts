import { jest } from '@jest/globals';
import puppeteer from 'puppeteer';
import type { Page, Browser } from 'puppeteer';
import { BrowserPool, isCleanHeadfulMode, warnUnrecognizedLaunchMode } from '../../services/genericScraper';
import { createScrapingService } from '../../services/engineServices/scrapingService';
import { ChallengeLaneUnavailableError, clearChallengeGates } from '../../services/browserChallenge';
import { resetHostConcurrency } from '../../services/gatedBrowsers';

/**
 * The DECLARED challenge gate is a claim about what the fetch needs: only the clean-headful profile
 * clears a Cloudflare JS challenge (headless FAILS, with any UA, silently — it just never leaves the
 * interstitial). Running one on the headless profile is not a degraded fetch, it is a doomed one that
 * also spends the egress IP's Cloudflare reputation, so it is REFUSED — the same rule the residential
 * lane already applies to a store declaring an egress the process cannot provide.
 *
 * A LEARNED gate is a weaker signal (one `cf-mitigated` response) and is NOT refused: those hosts
 * behaved before the challenge appeared and may again.
 */
describe('challenge lane vs BROWSER_LAUNCH_MODE', () => {
  let mockPage: jest.Mocked<Page>;
  let mockBrowser: jest.Mocked<Browser>;
  let createContext: jest.Mock;
  const savedMode = process.env.BROWSER_LAUNCH_MODE;

  beforeEach(async () => {
    jest.clearAllMocks();
    await BrowserPool.reset();
    (BrowserPool as any).stealthBrowser = null;
    clearChallengeGates();
    resetHostConcurrency();

    mockPage = {
      goto: jest.fn<(...a: any[]) => any>().mockResolvedValue({ status: () => 200, headers: () => ({ 'content-type': 'text/html', 'cf-mitigated': 'challenge' }), url: () => 'https://hobby-genki.com/item/1' }),
      title: jest.fn<(...a: any[]) => any>().mockResolvedValue('Item'),
      content: jest.fn<(...a: any[]) => any>().mockResolvedValue('<html><body>item</body></html>'),
      evaluate: jest.fn<(...a: any[]) => any>().mockResolvedValue('body'),
      setViewport: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
      setUserAgent: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
      setExtraHTTPHeaders: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
      setCookie: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
      close: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
      on: jest.fn(),
      off: jest.fn(),
      mainFrame: jest.fn(() => ({ id: 'main' })),
    } as unknown as jest.Mocked<Page>;

    createContext = jest.fn<(...a: any[]) => any>().mockResolvedValue({
      newPage: jest.fn<(...a: any[]) => any>().mockResolvedValue(mockPage),
      close: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
    }) as unknown as jest.Mock;
    mockBrowser = {
      createBrowserContext: createContext,
      newPage: jest.fn<(...a: any[]) => any>().mockResolvedValue(mockPage),
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
    clearChallengeGates();
    resetHostConcurrency();
  });

  it('refuses a DECLARED challenge-gated fetch on the headless profile, before any navigation', async () => {
    delete process.env.BROWSER_LAUNCH_MODE;
    const service = createScrapingService();

    await expect(
      service.browserFetch('https://www.anitoysgk.com/lucy.html', { challengeGated: true }),
    ).rejects.toThrow(ChallengeLaneUnavailableError);

    expect(puppeteer.launch).not.toHaveBeenCalled();
    expect(createContext).not.toHaveBeenCalled();
    expect(mockPage.goto).not.toHaveBeenCalled();
    expect(BrowserPool.gatedBrowsers()).toEqual([]);
  });

  it('names the env var that is wrong, so the refusal is actionable', async () => {
    process.env.BROWSER_LAUNCH_MODE = 'clean_headful'; // a typo is a headless launch
    const service = createScrapingService();

    await expect(
      service.browserFetch('https://www.anitoysgk.com/lucy.html', { challengeGated: true }),
    ).rejects.toThrow(/BROWSER_LAUNCH_MODE/);
  });

  it('runs the declared fetch normally in clean-headful mode', async () => {
    process.env.BROWSER_LAUNCH_MODE = 'clean-headful';
    const service = createScrapingService();

    await service.browserFetch('https://www.anitoysgk.com/lucy.html', { challengeGated: true });

    // The gated lane is a TAB in the per-egress browser's DEFAULT context, never a created one.
    expect(createContext).not.toHaveBeenCalled();
    expect(mockBrowser.newPage).toHaveBeenCalledTimes(1);
    expect(BrowserPool.gatedBrowsers()).toHaveLength(1);
  });

  it('does NOT refuse a host whose gate was only LEARNED from a cf-mitigated response', async () => {
    delete process.env.BROWSER_LAUNCH_MODE;
    const service = createScrapingService();

    await expect(service.browserFetch('https://hobby-genki.com/item/1')).resolves.toContain('item');
    await expect(service.browserFetch('https://hobby-genki.com/item/2')).resolves.toContain('item');
  });

  it('reads BROWSER_LAUNCH_MODE tolerantly (case and surrounding space)', () => {
    expect(isCleanHeadfulMode({ BROWSER_LAUNCH_MODE: ' Clean-Headful ' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isCleanHeadfulMode({ BROWSER_LAUNCH_MODE: 'clean_headful' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isCleanHeadfulMode({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it('warns ONCE at boot for a set-but-unrecognised launch mode, and stays silent otherwise', () => {
    const warn = jest.fn();
    warnUnrecognizedLaunchMode({ BROWSER_LAUNCH_MODE: 'clean_headful' } as NodeJS.ProcessEnv, warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('BROWSER_LAUNCH_MODE');

    warn.mockClear();
    warnUnrecognizedLaunchMode({ BROWSER_LAUNCH_MODE: 'clean-headful' } as NodeJS.ProcessEnv, warn);
    warnUnrecognizedLaunchMode({} as NodeJS.ProcessEnv, warn);
    expect(warn).not.toHaveBeenCalled();
  });
});
