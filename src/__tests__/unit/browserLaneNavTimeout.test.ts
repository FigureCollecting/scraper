import { jest } from '@jest/globals';
import puppeteer from 'puppeteer';
import type { Browser, Page } from 'puppeteer';
import { BrowserPool, browserLaneView } from '../../services/genericScraper';
import { resolveNavTimeoutMs } from '../../services/browserNavTimeout';
import { createScrapingService } from '../../services/engineServices/scrapingService';
import { clearChallengeGates } from '../../services/browserChallenge';
import { resetHostConcurrency } from '../../services/gatedBrowsers';
import { resolveBrowserLaneOptions } from '../../services/residentialEgress';
import { makeFetchSearch } from '../../services/fetchSearch';

/**
 * The browser lane's navigation budget. Production 2026-09-09 (11:00-11:50Z) booked 65 "Navigation
 * timeout of 20000 ms exceeded" on the residential gated lane (anitoys listing + items, sugotoys
 * search) while the path itself measured healthy — 1.4 MB/s, sub-second TTFB. A Cloudflare-fronted
 * store reached through a relayed exit spends most of that budget on the CHALLENGE, not on bytes,
 * so the one hardcoded number has to become an operator dial (BROWSER_NAV_TIMEOUT_MS) with a
 * per-store override for the stores that are slow on purpose.
 */
describe('resolveNavTimeoutMs', () => {
  it('defaults to 20000 when the variable is unset or empty', () => {
    expect(resolveNavTimeoutMs({} as NodeJS.ProcessEnv)).toBe(20000);
    expect(resolveNavTimeoutMs({ BROWSER_NAV_TIMEOUT_MS: '' } as NodeJS.ProcessEnv)).toBe(20000);
  });

  it('takes a usable numeric override', () => {
    expect(resolveNavTimeoutMs({ BROWSER_NAV_TIMEOUT_MS: '45000' } as NodeJS.ProcessEnv)).toBe(45000);
  });

  /** The clamp is what keeps a typo from strangling (or unbounding) every navigation in the pod. */
  it('clamps to [5000, 120000]', () => {
    expect(resolveNavTimeoutMs({ BROWSER_NAV_TIMEOUT_MS: '250' } as NodeJS.ProcessEnv)).toBe(5000);
    expect(resolveNavTimeoutMs({ BROWSER_NAV_TIMEOUT_MS: '600000' } as NodeJS.ProcessEnv)).toBe(120000);
  });

  it('falls back to the default and warns ONCE for a non-numeric value', () => {
    const warn = jest.fn();
    expect(resolveNavTimeoutMs({ BROWSER_NAV_TIMEOUT_MS: 'soon' } as NodeJS.ProcessEnv, warn)).toBe(20000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('BROWSER_NAV_TIMEOUT_MS');
  });

  it('falls back to the default and warns for a non-positive value', () => {
    const warn = jest.fn();
    expect(resolveNavTimeoutMs({ BROWSER_NAV_TIMEOUT_MS: '0' } as NodeJS.ProcessEnv, warn)).toBe(20000);
    expect(resolveNavTimeoutMs({ BROWSER_NAV_TIMEOUT_MS: '-1' } as NodeJS.ProcessEnv, warn)).toBe(20000);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  /** The default sink is console.warn — the boot warning has to reach the pod's log with no wiring. */
  it('warns through console.warn when no sink is supplied', () => {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(resolveNavTimeoutMs({ BROWSER_NAV_TIMEOUT_MS: 'later' } as NodeJS.ProcessEnv)).toBe(20000);
      expect(spy.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('BROWSER_NAV_TIMEOUT_MS'))).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('does not warn for a value it accepts or for an absent one', () => {
    const warn = jest.fn();
    resolveNavTimeoutMs({ BROWSER_NAV_TIMEOUT_MS: '30000' } as NodeJS.ProcessEnv, warn);
    resolveNavTimeoutMs({} as NodeJS.ProcessEnv, warn);
    expect(warn).not.toHaveBeenCalled();
  });
});

/** The effective budget has to be readable from outside the pod, like every other lane setting. */
describe('browserLaneView — navigationTimeoutMs', () => {
  it('reports the default when nothing is configured', () => {
    expect(browserLaneView({} as NodeJS.ProcessEnv).navigationTimeoutMs).toBe(20000);
  });

  it('reports the configured (clamped) value', () => {
    expect(browserLaneView({ BROWSER_NAV_TIMEOUT_MS: '45000' } as NodeJS.ProcessEnv).navigationTimeoutMs).toBe(45000);
    expect(browserLaneView({ BROWSER_NAV_TIMEOUT_MS: '900000' } as NodeJS.ProcessEnv).navigationTimeoutMs).toBe(120000);
  });
});

describe('browser lane navigation timeout — page.goto', () => {
  const PROXY = 'socks5://127.0.0.1:1055';
  let launches: Array<{ browser: jest.Mocked<Browser>; args: string[]; pages: jest.Mocked<Page>[] }>;
  const savedMode = process.env.BROWSER_LAUNCH_MODE;

  const newMockPage = (): jest.Mocked<Page> => ({
    goto: jest.fn<(...a: any[]) => any>().mockImplementation(async (url: any) => ({
      status: () => 200,
      headers: () => ({ 'content-type': 'text/html' }),
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
  } as unknown as jest.Mocked<Page>);

  const wire = (): void => {
    launches = [];
    jest.mocked(puppeteer.launch).mockImplementation(async (config: any) => {
      const record: any = { args: config?.args ?? [], pages: [] };
      const makePage = async () => {
        const page = newMockPage();
        record.pages.push(page);
        return page;
      };
      record.browser = {
        newPage: jest.fn<(...a: any[]) => any>().mockImplementation(makePage),
        createBrowserContext: jest.fn<(...a: any[]) => any>().mockImplementation(async () => ({
          newPage: jest.fn<(...a: any[]) => any>().mockImplementation(makePage),
          close: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
        })),
        close: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
        connected: true,
      } as unknown as jest.Mocked<Browser>;
      launches.push(record);
      return record.browser;
    });
  };

  /** Every `{url, timeout}` pair the lane navigated with, across all pages of all browsers. */
  const navigations = (): Array<{ url: string; timeout: number | undefined }> =>
    launches.flatMap((launch) => launch.pages).flatMap((page) =>
      jest.mocked(page.goto).mock.calls.map((call: any[]) => ({ url: String(call[0]), timeout: call[1]?.timeout })));

  beforeEach(async () => {
    jest.clearAllMocks();
    await BrowserPool.reset();
    (BrowserPool as any).stealthBrowser = null;
    clearChallengeGates();
    resetHostConcurrency();
    wire();
  });

  afterEach(async () => {
    if (savedMode === undefined) delete process.env.BROWSER_LAUNCH_MODE;
    else process.env.BROWSER_LAUNCH_MODE = savedMode;
    await BrowserPool.reset();
    clearChallengeGates();
    resetHostConcurrency();
  });

  it('navigates browserFetch with the default budget', async () => {
    await createScrapingService().browserFetch('https://hobby-genki.com/item/1');

    expect(navigations()).toEqual([{ url: 'https://hobby-genki.com/item/1', timeout: 20000 }]);
  });

  it('navigates scrapePage with the default budget', async () => {
    await createScrapingService().scrapePage('https://hobby-genki.com/item/1');

    expect(navigations()).toEqual([{ url: 'https://hobby-genki.com/item/1', timeout: 20000 }]);
  });

  it('honours a per-store override on browserFetch and scrapePage', async () => {
    const service = createScrapingService();

    await service.browserFetch('https://hobby-genki.com/item/1', { navTimeoutMs: 60000 });
    await service.scrapePage('https://hobby-genki.com/item/2', { navTimeoutMs: 60000 });

    expect(navigations().map((nav) => nav.timeout)).toEqual([60000, 60000]);
  });

  /**
   * The PRIME is the navigation that actually meets the challenge, so it is the one that was timing
   * out in production — it must ride the same budget as the target fetch, on both lifecycles.
   */
  it('applies the override to the GATED session prime and its target', async () => {
    process.env.BROWSER_LAUNCH_MODE = 'clean-headful';

    await createScrapingService().browserFetch('https://www.anitoysgk.com/lucy.html', {
      challengeGated: true, proxyServer: PROXY, primeUrl: 'https://www.anitoysgk.com', navTimeoutMs: 75000,
    });

    expect(navigations()).toEqual([
      { url: 'https://www.anitoysgk.com', timeout: 75000 },
      { url: 'https://www.anitoysgk.com/lucy.html', timeout: 75000 },
    ]);
  });

  it('applies the override to the UNGATED session prime and its target', async () => {
    await createScrapingService().scrapePage('https://hobby-genki.com/item/1', {
      primeUrl: 'https://hobby-genki.com', navTimeoutMs: 50000,
    });

    expect(navigations()).toEqual([
      { url: 'https://hobby-genki.com', timeout: 50000 },
      { url: 'https://hobby-genki.com/item/1', timeout: 50000 },
    ]);
  });

  it('clamps a per-store override to the same range as the environment value', async () => {
    const service = createScrapingService();

    await service.browserFetch('https://hobby-genki.com/item/1', { navTimeoutMs: 900000 });
    await service.browserFetch('https://hobby-genki.com/item/2', { navTimeoutMs: 100 });

    expect(navigations().map((nav) => nav.timeout)).toEqual([120000, 5000]);
  });

  it('falls back to the process budget for an unusable per-store override', async () => {
    await createScrapingService().browserFetch('https://hobby-genki.com/item/1', { navTimeoutMs: Number.NaN });

    expect(navigations().map((nav) => nav.timeout)).toEqual([20000]);
  });

  /** The environment dial is the operator's, and it has to reach the actual navigation. */
  it('navigates with BROWSER_NAV_TIMEOUT_MS when the environment sets one', async () => {
    const saved = process.env.BROWSER_NAV_TIMEOUT_MS;
    process.env.BROWSER_NAV_TIMEOUT_MS = '45000';
    jest.resetModules();
    try {
      // The module registry is fresh, so the lane's puppeteer is a fresh mock too — wire THAT one.
      const isolatedPuppeteer = require('puppeteer').default ?? require('puppeteer');
      const pages: jest.Mocked<Page>[] = [];
      jest.mocked(isolatedPuppeteer.launch).mockImplementation(async () => {
        const makePage = async (): Promise<Page> => {
          const page = newMockPage();
          pages.push(page);
          return page;
        };
        return {
          newPage: jest.fn<(...a: any[]) => any>().mockImplementation(makePage),
          createBrowserContext: jest.fn<(...a: any[]) => any>().mockImplementation(async () => ({
            newPage: jest.fn<(...a: any[]) => any>().mockImplementation(makePage),
            close: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
          })),
          close: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
          connected: true,
        } as unknown as Browser;
      });
      const isolated = require('../../services/engineServices/scrapingService') as typeof import('../../services/engineServices/scrapingService');
      const pool = (require('../../services/genericScraper') as typeof import('../../services/genericScraper')).BrowserPool;
      await pool.reset();

      await isolated.createScrapingService().browserFetch('https://hobby-genki.com/item/1');

      const timeouts = pages.flatMap((page) =>
        jest.mocked(page.goto).mock.calls.map((call: any[]) => call[1]?.timeout));
      expect(timeouts).toEqual([45000]);
      await pool.reset();
    } finally {
      if (saved === undefined) delete process.env.BROWSER_NAV_TIMEOUT_MS;
      else process.env.BROWSER_NAV_TIMEOUT_MS = saved;
      jest.resetModules();
    }
  });
});

/** The per-store declaration reaches the lane through the SAME resolver every caller uses. */
describe('navTimeoutMs — store declaration plumbing', () => {
  it('resolveBrowserLaneOptions carries a declared navTimeoutMs', () => {
    expect(resolveBrowserLaneOptions('https://www.anitoysgk.com/lucy.html', { navTimeoutMs: 60000 }, undefined))
      .toEqual({ navTimeoutMs: 60000 });
  });

  it('resolveBrowserLaneOptions stays undefined for a store declaring nothing', () => {
    expect(resolveBrowserLaneOptions('https://hobby-genki.com/item/1', {}, undefined)).toBeUndefined();
  });

  it('the search dispatcher hands navTimeoutMs to the browser transport', async () => {
    const browser = jest.fn<(...a: any[]) => any>().mockResolvedValue('<html></html>');
    const fetchSearch = makeFetchSearch({
      http: jest.fn<(...a: any[]) => any>().mockResolvedValue(''),
      impersonate: jest.fn<(...a: any[]) => any>().mockResolvedValue(''),
      browser,
    }, { residentialProxyUrl: () => undefined });

    await fetchSearch('https://hobby-genki.com/search?q=lucy', { transport: 'browser', navTimeoutMs: 60000 });

    expect(browser.mock.calls[0][1]).toMatchObject({ navTimeoutMs: 60000 });
  });

  it('omits navTimeoutMs entirely for a store that declares none', async () => {
    const browser = jest.fn<(...a: any[]) => any>().mockResolvedValue('<html></html>');
    const fetchSearch = makeFetchSearch({
      http: jest.fn<(...a: any[]) => any>().mockResolvedValue(''),
      impersonate: jest.fn<(...a: any[]) => any>().mockResolvedValue(''),
      browser,
    }, { residentialProxyUrl: () => undefined });

    await fetchSearch('https://hobby-genki.com/search?q=lucy', { transport: 'browser' });

    expect(Object.keys(browser.mock.calls[0][1] as object)).not.toContain('navTimeoutMs');
  });
});
