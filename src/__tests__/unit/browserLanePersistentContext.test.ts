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

  beforeEach(async () => {
    jest.clearAllMocks();
    await BrowserPool.reset();
    (BrowserPool as any).stealthBrowser = null;
    clearChallengeGates();
    resetPersistentContexts();
    wire();
  });

  afterEach(async () => {
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

  it('closes every persistent context on pool shutdown', async () => {
    const service = createScrapingService();
    await service.browserFetch('https://www.anitoysgk.com/lucy.html', { challengeGated: true });
    expect(getPersistentContexts().size()).toBe(1);

    await BrowserPool.closeAll();

    expect(contexts[0].close).toHaveBeenCalledTimes(1);
    expect(getPersistentContexts().size()).toBe(0);
  });
});
