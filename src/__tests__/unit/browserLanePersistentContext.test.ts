import { jest } from '@jest/globals';
import puppeteer from 'puppeteer';
import type { Page, Browser } from 'puppeteer';
import { BrowserPool } from '../../services/genericScraper';
import { createScrapingService } from '../../services/engineServices/scrapingService';
import { clearChallengeGates } from '../../services/browserChallenge';
import { getPersistentContexts, resetPersistentContexts } from '../../services/persistentContexts';

/**
 * A challenge-gated host keeps its browser context between fetches: the clearance it earned (bound
 * by Cloudflare to IP + UA + context) is worth far more than the memory the context costs, and a
 * fresh context would re-run the challenge — slowly, and visibly — on every single fetch.
 */
describe('browser lane persistent contexts', () => {
  let mockPage: jest.Mocked<Page>;
  let contexts: any[];
  let mockBrowser: jest.Mocked<Browser>;

  const newMockPage = (headers: Record<string, string> = { 'content-type': 'text/html' }) => ({
    goto: jest.fn<(...a: any[]) => any>().mockResolvedValue({ status: () => 200, headers: () => headers, url: () => 'https://www.anitoysgk.com/lucy.html' }),
    title: jest.fn<(...a: any[]) => any>().mockResolvedValue('Lucy'),
    content: jest.fn<(...a: any[]) => any>().mockResolvedValue('<html><body>lucy</body></html>'),
    evaluate: jest.fn<(...a: any[]) => any>().mockResolvedValue('body'),
    setViewport: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
    setUserAgent: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
    setExtraHTTPHeaders: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
    setCookie: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
    close: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
    on: jest.fn(),
    off: jest.fn(),
    mainFrame: jest.fn(() => ({ id: 'main' })),
  } as unknown as jest.Mocked<Page>);

  const wire = (headers?: Record<string, string>) => {
    mockPage = newMockPage(headers);
    contexts = [];
    mockBrowser = {
      createBrowserContext: jest.fn<(...a: any[]) => any>().mockImplementation(async () => {
        const context = {
          newPage: jest.fn<(...a: any[]) => any>().mockResolvedValue(mockPage),
          close: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
        };
        contexts.push(context);
        return context;
      }),
      close: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
      connected: true,
    } as unknown as jest.Mocked<Browser>;
    jest.mocked(puppeteer.launch).mockClear();
    jest.mocked(puppeteer.launch).mockResolvedValue(mockBrowser);
  };

  const savedMode = process.env.BROWSER_LAUNCH_MODE;

  beforeEach(async () => {
    jest.clearAllMocks();
    await BrowserPool.reset();
    (BrowserPool as any).stealthBrowser = null;
    clearChallengeGates();
    resetPersistentContexts();
    // A DECLARED gate is only served on the clean-headful profile (see challengeLaneLaunchMode) —
    // that is the mode these lifecycle tests describe.
    process.env.BROWSER_LAUNCH_MODE = 'clean-headful';
    wire();
  });

  afterEach(async () => {
    if (savedMode === undefined) delete process.env.BROWSER_LAUNCH_MODE;
    else process.env.BROWSER_LAUNCH_MODE = savedMode;
    await BrowserPool.reset();
    clearChallengeGates();
    resetPersistentContexts();
  });

  it('reuses ONE context across fetches to a declared challenge-gated host, closing only the page', async () => {
    const service = createScrapingService();

    await service.browserFetch('https://www.anitoysgk.com/lucy-p1.html', { challengeGated: true });
    await service.browserFetch('https://www.anitoysgk.com/lucy-p2.html', { challengeGated: true });

    expect(mockBrowser.createBrowserContext).toHaveBeenCalledTimes(1);
    expect(contexts[0].close).not.toHaveBeenCalled();
    expect(mockPage.close).toHaveBeenCalledTimes(2);
    expect(getPersistentContexts().size()).toBe(1);
  });

  it('keeps residential and direct sessions apart for the same host', async () => {
    const service = createScrapingService();

    await service.browserFetch('https://www.anitoysgk.com/lucy.html', { challengeGated: true, proxyServer: 'socks5://127.0.0.1:1055' });
    await service.browserFetch('https://www.anitoysgk.com/lucy.html', { challengeGated: true });

    expect(mockBrowser.createBrowserContext).toHaveBeenCalledTimes(2);
    expect(getPersistentContexts().size()).toBe(2);
  });

  it('primes a FRESH context with the origin root before the target, and never re-primes on reuse', async () => {
    const service = createScrapingService();

    await service.browserFetch('https://www.anitoysgk.com/search?q=lucy', {
      challengeGated: true,
      primeUrl: 'https://www.anitoysgk.com',
    });

    const firstNavs = jest.mocked(mockPage.goto).mock.calls.map(call => call[0]);
    expect(firstNavs).toEqual(['https://www.anitoysgk.com', 'https://www.anitoysgk.com/search?q=lucy']);

    jest.mocked(mockPage.goto).mockClear();
    await service.browserFetch('https://www.anitoysgk.com/search?q=rebecca', {
      challengeGated: true,
      primeUrl: 'https://www.anitoysgk.com',
    });

    expect(jest.mocked(mockPage.goto).mock.calls.map(call => call[0])).toEqual(['https://www.anitoysgk.com/search?q=rebecca']);
  });

  it('retains the context of a host that reveals its gate mid-fetch (cf-mitigated), and reuses it next time', async () => {
    wire({ 'cf-mitigated': 'challenge' });
    const service = createScrapingService();

    await service.browserFetch('https://hobby-genki.com/item/1'); // stealth lane by default
    expect(getPersistentContexts().size()).toBe(1);
    expect(contexts[0].close).not.toHaveBeenCalled();

    await service.browserFetch('https://hobby-genki.com/item/2');
    expect(mockBrowser.createBrowserContext).toHaveBeenCalledTimes(1);
  });

  it('still closes the per-request context for an ungated store', async () => {
    const service = createScrapingService();

    await service.browserFetch('https://alpha.example.test/item/1', { stealth: false });

    expect(contexts[0].close).toHaveBeenCalledTimes(1);
    expect(getPersistentContexts().size()).toBe(0);
  });

  /**
   * Two /lookup requests can search one gated host at the same time (assembleLookup fans out with
   * Promise.all, and nothing serializes the search lane). Both miss the cache and open a context;
   * the late one must NOT have its store() close the context the other is navigating in.
   */
  it('lets two concurrent fetches to one gated host share a context, closing only the duplicate', async () => {
    const service = createScrapingService();

    const [a, b] = await Promise.all([
      service.browserFetch('https://www.anitoysgk.com/lucy-p1.html', { challengeGated: true }),
      service.browserFetch('https://www.anitoysgk.com/lucy-p2.html', { challengeGated: true }),
    ]);

    expect(a).toContain('lucy');
    expect(b).toContain('lucy');
    expect(mockBrowser.createBrowserContext).toHaveBeenCalledTimes(2); // both missed the cold cache
    expect(contexts[0].close).not.toHaveBeenCalled();                  // the in-flight one survives
    expect(contexts[1].close).toHaveBeenCalledTimes(1);                // the duplicate is closed
    expect(getPersistentContexts().size()).toBe(1);
  });

  /**
   * The prime navigation is the one that MEETS the challenge: a fresh context always re-challenges,
   * and `goto(..., 'domcontentloaded')` returns on the interstitial. Navigating to the target right
   * then cancels the challenge script, so the homepage never loads, the same-session cookie the
   * prime exists for is never set — and `primed` latches for the life of the context.
   */
  const challengeScript = (target: string, primeUrl: string) => {
    const events: string[] = [];
    const titles = ['Just a moment...', 'Just a moment...', 'Lucy'];
    jest.mocked(mockPage.title).mockImplementation(async () => {
      const title = titles.length > 1 ? titles.shift()! : titles[0];
      events.push(`title:${title}`);
      return title;
    });
    jest.mocked(mockPage.goto).mockImplementation(async (url: any) => {
      events.push(`goto:${url}`);
      return {
        status: () => 200,
        url: () => url,
        headers: () => (url === primeUrl
          ? { 'content-type': 'text/html', 'cf-mitigated': 'challenge' }
          : { 'content-type': 'text/html' }),
      } as any;
    });
    return { events, target };
  };

  it('waits out a challenge on the PRIME navigation before navigating to the target (kept context)', async () => {
    const target = 'https://www.anitoysgk.com/search?q=lucy';
    const primeUrl = 'https://www.anitoysgk.com';
    const { events } = challengeScript(target, primeUrl);
    const service = createScrapingService();

    await service.browserFetch(target, { challengeGated: true, primeUrl });

    const lastInterstitial = events.lastIndexOf('title:Just a moment...');
    expect(lastInterstitial).toBeGreaterThan(-1);
    expect(events.indexOf(`goto:${target}`)).toBeGreaterThan(lastInterstitial);
  });

  it('waits out a challenge on the PRIME navigation before the target on an ephemeral context too', async () => {
    const target = 'https://hobby-genki.com/search?q=lucy';
    const primeUrl = 'https://hobby-genki.com';
    const { events } = challengeScript(target, primeUrl);
    const service = createScrapingService();

    await service.browserFetch(target, { primeUrl, stealth: false });

    const lastInterstitial = events.lastIndexOf('title:Just a moment...');
    expect(lastInterstitial).toBeGreaterThan(-1);
    expect(events.indexOf(`goto:${target}`)).toBeGreaterThan(lastInterstitial);
  });

  it('closes every persistent context on pool shutdown', async () => {
    const service = createScrapingService();
    await service.browserFetch('https://www.anitoysgk.com/lucy.html', { challengeGated: true });
    expect(getPersistentContexts().size()).toBe(1);

    await BrowserPool.closeAll();

    expect(contexts[0].close).toHaveBeenCalledTimes(1);
    expect(getPersistentContexts().size()).toBe(0);
  });
});
