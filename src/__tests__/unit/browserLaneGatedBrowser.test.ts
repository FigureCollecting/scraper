import { jest } from '@jest/globals';
import puppeteer from 'puppeteer';
import type { Browser, Page } from 'puppeteer';
import { BrowserPool } from '../../services/genericScraper';
import { createScrapingService } from '../../services/engineServices/scrapingService';
import { clearChallengeGates } from '../../services/browserChallenge';
import { GATED_BROWSER_MAX_AGE_MS, getHostConcurrency, resetHostConcurrency } from '../../services/gatedBrowsers';

/**
 * A challenge-gated fetch is a TAB in a dedicated per-egress browser's DEFAULT context — not a page
 * in a `createBrowserContext`. Measured 2026-09-07 through the residential exit: a created context
 * never clears the Cloudflare JS challenge (40 s+, traffic leaving the right IP), while a tab in the
 * default context clears in 8-9 s and hands its clearance to every later tab, gated host included.
 */
describe('browser lane gated browsers', () => {
  const PROXY = 'socks5://127.0.0.1:1055';
  let launches: Array<{ browser: jest.Mocked<Browser>; args: string[]; pages: jest.Mocked<Page>[]; contexts: any[]; gotos?: string[] }>;
  const savedMode = process.env.BROWSER_LAUNCH_MODE;

  /** A page whose navigations answer with `headers`, keyed by URL when a map is given. */
  const newMockPage = (headers: Record<string, string> | ((url: string) => Record<string, string>)): jest.Mocked<Page> => {
    const headersFor = typeof headers === 'function' ? headers : () => headers;
    return {
      goto: jest.fn<(...a: any[]) => any>().mockImplementation(async (url: any) => ({
        status: () => 200,
        headers: () => headersFor(String(url)),
        url: () => String(url),
      })),
      title: jest.fn<(...a: any[]) => any>().mockResolvedValue('Lucy'),
      content: jest.fn<(...a: any[]) => any>().mockResolvedValue('<html><body>lucy</body></html>'),
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
    } as unknown as jest.Mocked<Page>;
  };

  const wire = (headers: Record<string, string> | ((url: string) => Record<string, string>) = { 'content-type': 'text/html' }): void => {
    launches = [];
    jest.mocked(puppeteer.launch).mockImplementation(async (config: any) => {
      const record: any = { args: config?.args ?? [], pages: [], contexts: [] };
      record.browser = {
        newPage: jest.fn<(...a: any[]) => any>().mockImplementation(async () => {
          const page = newMockPage(headers);
          record.pages.push(page);
          return page;
        }),
        createBrowserContext: jest.fn<(...a: any[]) => any>().mockImplementation(async () => {
          const page = newMockPage(headers);
          record.pages.push(page);
          const context = {
            newPage: jest.fn<(...a: any[]) => any>().mockResolvedValue(page),
            close: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
          };
          record.contexts.push(context);
          return context;
        }),
        close: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
        connected: true,
      } as unknown as jest.Mocked<Browser>;
      launches.push(record);
      return record.browser;
    });
  };

  /** The launch record whose browser served a gated fetch (the pooled ones come first in headless). */
  const gatedLaunch = (index = 0) => launches[index];

  beforeEach(async () => {
    jest.clearAllMocks();
    await BrowserPool.reset();
    (BrowserPool as any).stealthBrowser = null;
    clearChallengeGates();
    resetHostConcurrency();
    process.env.BROWSER_LAUNCH_MODE = 'clean-headful';
    wire();
  });

  afterEach(async () => {
    if (savedMode === undefined) delete process.env.BROWSER_LAUNCH_MODE;
    else process.env.BROWSER_LAUNCH_MODE = savedMode;
    await BrowserPool.reset();
    clearChallengeGates();
    resetHostConcurrency();
  });

  it('fetches a declared gated store in a NEW TAB of the default context, never a created one', async () => {
    const service = createScrapingService();

    await service.browserFetch('https://www.anitoysgk.com/lucy.html', { challengeGated: true, proxyServer: PROXY });

    expect(puppeteer.launch).toHaveBeenCalledTimes(1);
    expect(gatedLaunch().args).toContain(`--proxy-server=${PROXY}`);
    expect(gatedLaunch().browser.newPage).toHaveBeenCalledTimes(1);
    expect(gatedLaunch().browser.createBrowserContext).not.toHaveBeenCalled();
  });

  /**
   * OBSERVABILITY: the gated lane is invisible from outside the pod until something fails, and the
   * defect it was built for (an ingest fetch quietly taking the per-request context) looked exactly
   * like a working lane in the logs. One line per gated fetch names the egress it left through, the
   * host, whether that browser already holds a primed session for it, and how many tabs are open on
   * it — enough to tell "the gate is wired" from "the gate was never reached".
   */
  it('logs ONE line per gated fetch: egress, host, prime state, open tabs', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const service = createScrapingService();

      await service.browserFetch('https://www.anitoysgk.com/lucy.html', {
        challengeGated: true, proxyServer: PROXY, primeUrl: 'https://www.anitoysgk.com',
      });
      // Second fetch: the prime is not repeated, but the browser still HOLDS the primed session.
      await service.browserFetch('https://www.anitoysgk.com/rebecca.html', {
        challengeGated: true, proxyServer: PROXY, primeUrl: 'https://www.anitoysgk.com',
      });

      const lines = logSpy.mock.calls.map((call) => String(call[0]));
      expect(lines.filter((line) => line.startsWith('[GATED]'))).toEqual([
        '[GATED] residential tab for www.anitoysgk.com (primed=true, tabs=1)',
        '[GATED] residential tab for www.anitoysgk.com (primed=true, tabs=1)',
      ]);
      // The pool's own launch line is the other half of the trail.
      expect(lines.some((line) => line.includes('Launching the residential challenge-lane browser'))).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('reports primed=false for a gated store that declares no session prime, and the direct egress', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const service = createScrapingService();

      await service.browserFetch('https://hobby-genki.com/item/1', { challengeGated: true });

      expect(logSpy.mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith('[GATED]'))).toEqual([
        '[GATED] direct tab for hobby-genki.com (primed=false, tabs=1)',
      ]);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('reuses ONE browser across fetches, closing only the tab', async () => {
    const service = createScrapingService();

    await service.browserFetch('https://www.anitoysgk.com/lucy-p1.html', { challengeGated: true, proxyServer: PROXY });
    await service.browserFetch('https://www.anitoysgk.com/lucy-p2.html', { challengeGated: true, proxyServer: PROXY });

    expect(puppeteer.launch).toHaveBeenCalledTimes(1);
    expect(gatedLaunch().browser.newPage).toHaveBeenCalledTimes(2);
    expect(gatedLaunch().pages.every((page) => jest.mocked(page.close).mock.calls.length === 1)).toBe(true);
    expect(gatedLaunch().browser.close).not.toHaveBeenCalled();
  });

  /**
   * The clearance lives in the browser PROFILE, so every gated host on one egress shares it — which
   * is exactly how a person's browser behaves with several tabs open.
   */
  it('shares one browser between different gated hosts on the same egress', async () => {
    const service = createScrapingService();

    await service.browserFetch('https://www.anitoysgk.com/lucy.html', { challengeGated: true, proxyServer: PROXY });
    await service.browserFetch('https://hobby-genki.com/item/1', { challengeGated: true, proxyServer: PROXY });

    expect(puppeteer.launch).toHaveBeenCalledTimes(1);
    expect(gatedLaunch().browser.newPage).toHaveBeenCalledTimes(2);
  });

  it('keeps the residential and direct sessions in separate browsers', async () => {
    const service = createScrapingService();

    await service.browserFetch('https://www.anitoysgk.com/lucy.html', { challengeGated: true, proxyServer: PROXY });
    await service.browserFetch('https://www.anitoysgk.com/lucy.html', { challengeGated: true });

    expect(puppeteer.launch).toHaveBeenCalledTimes(2);
    expect(launches[0].args).toContain(`--proxy-server=${PROXY}`);
    expect(launches[1].args.some((arg) => arg.startsWith('--proxy-server'))).toBe(false);
  });

  it('primes a host once per browser, and primes a second host separately', async () => {
    const service = createScrapingService();

    await service.browserFetch('https://www.anitoysgk.com/search?q=lucy', {
      challengeGated: true, proxyServer: PROXY, primeUrl: 'https://www.anitoysgk.com',
    });
    await service.browserFetch('https://www.anitoysgk.com/search?q=rebecca', {
      challengeGated: true, proxyServer: PROXY, primeUrl: 'https://www.anitoysgk.com',
    });
    await service.browserFetch('https://hobby-genki.com/search?q=lucy', {
      challengeGated: true, proxyServer: PROXY, primeUrl: 'https://hobby-genki.com',
    });

    const navigations = gatedLaunch().pages.flatMap((page) => jest.mocked(page.goto).mock.calls.map((call) => String(call[0])));
    expect(navigations).toEqual([
      'https://www.anitoysgk.com',
      'https://www.anitoysgk.com/search?q=lucy',
      'https://www.anitoysgk.com/search?q=rebecca',
      'https://hobby-genki.com',
      'https://hobby-genki.com/search?q=lucy',
    ]);
  });

  /**
   * WIRING: the clearance wait leaves on a `cf_clearance` cookie, and can only see one if the lane
   * hands it a page reporting the jar of the context it runs in. A gated tab runs in the browser's
   * DEFAULT context — the one holding the clearance for every gated host on this egress.
   */
  it('hands the wait the gated browser default context\'s cookie jar as clearance evidence', async () => {
    const cookies = jest.fn<(...a: any[]) => any>().mockResolvedValue([{ name: 'cf_clearance', domain: '.anitoysgk.com' }]);
    const titles = ['Just a moment...', 'Lucy'];
    jest.mocked(puppeteer.launch).mockImplementationOnce(async () => {
      const defaultContext = { cookies };
      return {
        newPage: jest.fn<(...a: any[]) => any>().mockImplementation(async () => {
          const page = newMockPage({ 'content-type': 'text/html', 'cf-mitigated': 'challenge' });
          jest.mocked(page.title).mockImplementation(async () => (titles.length > 1 ? titles.shift()! : titles[0]));
          (page as any).browserContext = jest.fn(() => defaultContext);
          return page;
        }),
        createBrowserContext: jest.fn<(...a: any[]) => any>(),
        close: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
        connected: true,
      } as unknown as jest.Mocked<Browser>;
    });
    const service = createScrapingService();

    await service.browserFetch('https://www.anitoysgk.com/lucy.html', { challengeGated: true, proxyServer: PROXY });

    expect(cookies).toHaveBeenCalled();
  });

  /**
   * The PRIME is the navigation that meets the challenge on a cold profile; navigating to the target
   * before it clears cancels the challenge script and the priming visit never happened.
   */
  it('waits out a challenge on the prime navigation before navigating to the target', async () => {
    const primeUrl = 'https://www.anitoysgk.com';
    const target = 'https://www.anitoysgk.com/search?q=lucy';
    wire((url): Record<string, string> => (url === primeUrl
      ? { 'content-type': 'text/html', 'cf-mitigated': 'challenge' }
      : { 'content-type': 'text/html' }));
    const service = createScrapingService();
    const events: string[] = [];

    jest.mocked(puppeteer.launch).mockImplementationOnce(async (config: any) => {
      const record: any = { args: config?.args ?? [], pages: [], contexts: [] };
      const titles = ['Just a moment...', 'Just a moment...', 'Lucy'];
      record.browser = {
        newPage: jest.fn<(...a: any[]) => any>().mockImplementation(async () => {
          const page = newMockPage({ 'content-type': 'text/html' });
          jest.mocked(page.title).mockImplementation(async () => {
            const title = titles.length > 1 ? titles.shift()! : titles[0];
            events.push(`title:${title}`);
            return title;
          });
          jest.mocked(page.goto).mockImplementation(async (url: any) => {
            events.push(`goto:${url}`);
            return {
              status: () => 200,
              url: () => String(url),
              headers: () => (String(url) === primeUrl
                ? { 'content-type': 'text/html', 'cf-mitigated': 'challenge' }
                : { 'content-type': 'text/html' }),
            } as any;
          });
          record.pages.push(page);
          return page;
        }),
        createBrowserContext: jest.fn<(...a: any[]) => any>(),
        close: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
        connected: true,
      } as unknown as jest.Mocked<Browser>;
      launches.push(record);
      return record.browser;
    });

    await service.browserFetch(target, { challengeGated: true, proxyServer: PROXY, primeUrl });

    const lastInterstitial = events.lastIndexOf('title:Just a moment...');
    expect(lastInterstitial).toBeGreaterThan(-1);
    expect(events.indexOf(`goto:${target}`)).toBeGreaterThan(lastInterstitial);
  });

  /**
   * A launch whose Nth tab shows an interstitial that NEVER clears, and whose other tabs are clean.
   * `gotos` records every navigation the browser was asked for, in order.
   */
  const wireChallengedTabs = (challenged: (nth: number) => boolean): void => {
    launches = [];
    jest.mocked(puppeteer.launch).mockImplementation(async (config: any) => {
      const record: any = { args: config?.args ?? [], pages: [], contexts: [], gotos: [] };
      let opened = 0;
      record.browser = {
        newPage: jest.fn<(...a: any[]) => any>().mockImplementation(async () => {
          const stuck = challenged(opened++);
          const page = newMockPage({ 'content-type': 'text/html' });
          jest.mocked(page.title).mockImplementation(async () => (stuck ? 'Just a moment...' : 'Lucy'));
          jest.mocked(page.content).mockResolvedValue(stuck ? '<html>interstitial</html>' : '<html>store</html>');
          jest.mocked(page.goto).mockImplementation(async (url: any) => {
            record.gotos.push(String(url));
            return {
              status: () => 200,
              url: () => String(url),
              headers: () => (stuck
                ? { 'content-type': 'text/html', 'cf-mitigated': 'challenge' }
                : { 'content-type': 'text/html' }),
            } as any;
          });
          record.pages.push(page);
          return page;
        }),
        createBrowserContext: jest.fn<(...a: any[]) => any>(),
        close: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
        connected: true,
      } as unknown as jest.Mocked<Browser>;
      launches.push(record);
      return record.browser;
    });
  };

  const SURUGAYA = 'https://www.suruga-ya.jp/product/detail/602304976';

  /**
   * THE 2026-09-11 DEFECT. A fresh gated browser holds no clearance, so the first navigation for a
   * host that declares NO prime URL (suruga-ya.jp, hobby-genki, sugotoys all log `primed=false`) has
   * to earn one inline. Measured in production at 00:39:41, 86 s after a relaunch, that navigation
   * sat on the interstitial past the 30 s budget: the lane reported a challenge page, a 30-minute
   * host cooldown opened, 15 queued items were dropped — and the SAME browser instance served the
   * host in 6 s as soon as the cooldown expired. One retry is what stands between those outcomes.
   */
  it('retries the FIRST navigation for a host once when its challenge never clears', async () => {
    wireChallengedTabs((nth) => nth === 0);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.useFakeTimers();
    try {
      const service = createScrapingService();

      const fetching = service.browserFetch(SURUGAYA, { challengeGated: true, proxyServer: PROXY });
      await jest.advanceTimersByTimeAsync(40_000);
      const body = await fetching;

      // The RETRY's document is what the caller gets, not the interstitial the first tab captured.
      expect(body).toBe('<html>store</html>');
      expect(gatedLaunch().browser.newPage).toHaveBeenCalledTimes(2);
      expect(gatedLaunch().gotos).toEqual([SURUGAYA, SURUGAYA]);
      expect(BrowserPool.gatedLaneStats('residential').firstNavigationRetries).toBe(1);
      expect(BrowserPool.gatedLaneStats('residential').firstNavigationRecoveries).toBe(1);
      expect(warnSpy.mock.calls.map((call) => String(call[0]))
        .some((line) => line.includes('first navigation for www.suruga-ya.jp'))).toBe(true);
    } finally {
      jest.useRealTimers();
      warnSpy.mockRestore();
    }
  });

  /**
   * The grace is ONE SHOT per (instance, host). A host that has already navigated on this browser
   * has a clearance or has lost it for a reason, and doubling every later failing fetch is exactly
   * the retry storm the host cooldown exists to prevent.
   */
  it('does not retry a challenge once the host has already navigated on this browser', async () => {
    wireChallengedTabs((nth) => nth > 0);
    jest.useFakeTimers();
    try {
      const service = createScrapingService();

      await service.browserFetch(SURUGAYA, { challengeGated: true, proxyServer: PROXY });
      expect(BrowserPool.gatedLaneStats('residential').firstNavigationRetries).toBe(0);

      const second = service.browserFetch(SURUGAYA, { challengeGated: true, proxyServer: PROXY });
      await jest.advanceTimersByTimeAsync(40_000);
      expect(await second).toBe('<html>interstitial</html>');

      expect(gatedLaunch().browser.newPage).toHaveBeenCalledTimes(2);
      expect(BrowserPool.gatedLaneStats('residential').firstNavigationRetries).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  /**
   * THE RELAUNCH PROOF, end to end. A replacement holds no clearance for any host, so before it may
   * carry traffic it re-primes every host the OUTGOING browser had primed and waits that challenge
   * out. Until it passes, the aged browser — which demonstrably works — keeps serving.
   */
  it('proves a relaunched browser by re-priming each primed host before it carries traffic', async () => {
    const primeUrl = 'https://www.anitoysgk.com';
    const service = createScrapingService();
    const gotos = (index: number): string[] =>
      launches[index].pages.flatMap((page) => jest.mocked(page.goto).mock.calls.map((call) => String(call[0])));

    await service.browserFetch('https://www.anitoysgk.com/lucy.html', { challengeGated: true, proxyServer: PROXY, primeUrl });
    expect(launches).toHaveLength(1);

    const aged = await BrowserPool.getGatedBrowser('residential', PROXY);
    aged.launchedAt = Date.now() - GATED_BROWSER_MAX_AGE_MS - 1;

    // This fetch is still served by the AGED browser; the replacement is built and proven beside it.
    await service.browserFetch('https://www.anitoysgk.com/rebecca.html', { challengeGated: true, proxyServer: PROXY, primeUrl });
    expect(gotos(0)).toContain('https://www.anitoysgk.com/rebecca.html');

    await BrowserPool.settleGatedRelaunches();
    await BrowserPool.settleGatedRetirements();

    // The replacement's ONLY navigation so far is the proof's prime — it has carried no fetch yet.
    expect(launches).toHaveLength(2);
    expect(gotos(1)).toEqual([primeUrl]);
    expect(aged.browser.close).toHaveBeenCalledTimes(1);
    expect(BrowserPool.gatedLaneStats('residential').relaunchCount).toBe(1);

    // And because the proof primed it, the next fetch rides the new browser without re-priming.
    await service.browserFetch('https://www.anitoysgk.com/nico.html', { challengeGated: true, proxyServer: PROXY, primeUrl });
    expect(gotos(1)).toEqual([primeUrl, 'https://www.anitoysgk.com/nico.html']);
  });

  /** A gate LEARNED from a `cf-mitigated` response moves the host onto the gated browser next time. */
  it('moves a host onto the gated browser once its gate is learned', async () => {
    wire({ 'content-type': 'text/html', 'cf-mitigated': 'challenge' });
    const service = createScrapingService();

    await service.browserFetch('https://hobby-genki.com/item/1'); // ungated: the stealth browser, own context
    expect(launches[0].browser.createBrowserContext).toHaveBeenCalledTimes(1);
    expect(launches[0].contexts[0].close).toHaveBeenCalledTimes(1);

    await service.browserFetch('https://hobby-genki.com/item/2');

    expect(launches[1].browser.newPage).toHaveBeenCalledTimes(1);
    expect(launches[1].browser.createBrowserContext).not.toHaveBeenCalled();
  });

  it('leaves an ungated fetch on its own per-request context, closed with the request', async () => {
    const service = createScrapingService();

    await service.browserFetch('https://alpha.example.test/item/1', { stealth: false });

    expect(launches[0].browser.createBrowserContext).toHaveBeenCalledTimes(1);
    expect(launches[0].contexts[0].close).toHaveBeenCalledTimes(1);
    expect(BrowserPool.gatedBrowsers()).toEqual([]);
  });

  /** A tab that will not close is a live renderer on a browser that outlives every request. */
  it('retires the gated browser when one of its tabs will not close', async () => {
    const service = createScrapingService();
    jest.mocked(puppeteer.launch).mockImplementationOnce(async (config: any) => {
      const record: any = { args: config?.args ?? [], pages: [], contexts: [] };
      record.browser = {
        newPage: jest.fn<(...a: any[]) => any>().mockImplementation(async () => {
          const page = newMockPage({ 'content-type': 'text/html' });
          jest.mocked(page.close).mockRejectedValue(new Error('page.close() timed out'));
          record.pages.push(page);
          return page;
        }),
        createBrowserContext: jest.fn<(...a: any[]) => any>(),
        close: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
        connected: true,
      } as unknown as jest.Mocked<Browser>;
      launches.push(record);
      return record.browser;
    });

    await service.browserFetch('https://www.anitoysgk.com/lucy.html', { challengeGated: true, proxyServer: PROXY });

    expect(launches[0].browser.close).toHaveBeenCalledTimes(1);
    expect(BrowserPool.gatedBrowsers()).toEqual([]);
  });

  /** One slow store must not be able to fill the shared browser with tabs. */
  it('holds a gated host to two concurrent tabs', async () => {
    const service = createScrapingService();
    const gate = new Map<string, () => void>();
    jest.mocked(puppeteer.launch).mockImplementationOnce(async (config: any) => {
      const record: any = { args: config?.args ?? [], pages: [], contexts: [] };
      record.browser = {
        newPage: jest.fn<(...a: any[]) => any>().mockImplementation(async () => {
          const page = newMockPage({ 'content-type': 'text/html' });
          jest.mocked(page.goto).mockImplementation(async (url: any) => {
            await new Promise<void>((resolve) => gate.set(String(url), resolve));
            return { status: () => 200, headers: () => ({ 'content-type': 'text/html' }), url: () => String(url) } as any;
          });
          record.pages.push(page);
          return page;
        }),
        createBrowserContext: jest.fn<(...a: any[]) => any>(),
        close: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
        connected: true,
      } as unknown as jest.Mocked<Browser>;
      launches.push(record);
      return record.browser;
    });

    const fetches = [1, 2, 3].map((n) =>
      service.browserFetch(`https://www.anitoysgk.com/lucy-p${n}.html`, { challengeGated: true, proxyServer: PROXY }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(launches[0].browser.newPage).toHaveBeenCalledTimes(2);
    expect(getHostConcurrency().waitingCount('www.anitoysgk.com|residential')).toBe(1);

    gate.get('https://www.anitoysgk.com/lucy-p1.html')!();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(launches[0].browser.newPage).toHaveBeenCalledTimes(3);

    for (const release of gate.values()) release();
    await Promise.all(fetches);
  });

  it('closes the gated browsers on pool shutdown', async () => {
    const service = createScrapingService();
    await service.browserFetch('https://www.anitoysgk.com/lucy.html', { challengeGated: true, proxyServer: PROXY });
    expect(BrowserPool.gatedBrowsers()).toHaveLength(1);

    await BrowserPool.closeAll();

    expect(launches[0].browser.close).toHaveBeenCalledTimes(1);
    expect(BrowserPool.gatedBrowsers()).toEqual([]);
  });
});
