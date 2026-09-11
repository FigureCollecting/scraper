import { jest } from '@jest/globals';
import puppeteer from 'puppeteer';
import type { Browser, Page } from 'puppeteer';
import { BrowserPool, buildBrowserConfig } from '../../services/genericScraper';
import { GATED_BROWSER_MAX_AGE_MS } from '../../services/gatedBrowsers';

/**
 * The challenge lane's Chrome lifecycle: ONE long-lived browser per egress, the residential one
 * launched with `--proxy-server` (the proxy belongs to the LAUNCH, not to a context), gated fetches
 * riding NEW TABS of its DEFAULT context, and a two-hour recycle that drains before it closes.
 */
describe('BrowserPool gated browsers', () => {
  const PROXY = 'socks5://127.0.0.1:1055';
  let launched: Array<{ browser: jest.Mocked<Browser>; args: string[]; pages: any[] }>;
  const savedMode = process.env.BROWSER_LAUNCH_MODE;

  const newMockPage = (): jest.Mocked<Page> => ({
    close: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
    goto: jest.fn<(...a: any[]) => any>().mockResolvedValue({ status: () => 200, headers: () => ({}) }),
  } as unknown as jest.Mocked<Page>);

  beforeEach(async () => {
    jest.clearAllMocks();
    await BrowserPool.reset();
    process.env.BROWSER_LAUNCH_MODE = 'clean-headful';
    launched = [];
    jest.mocked(puppeteer.launch).mockImplementation(async (config: any) => {
      const record: any = { args: config?.args ?? [], pages: [] };
      record.browser = {
        newPage: jest.fn<(...a: any[]) => any>().mockImplementation(async () => {
          const page = newMockPage();
          record.pages.push(page);
          return page;
        }),
        createBrowserContext: jest.fn<(...a: any[]) => any>(),
        close: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
        connected: true,
      } as unknown as jest.Mocked<Browser>;
      launched.push(record);
      return record.browser;
    });
  });

  afterEach(async () => {
    if (savedMode === undefined) delete process.env.BROWSER_LAUNCH_MODE;
    else process.env.BROWSER_LAUNCH_MODE = savedMode;
    await BrowserPool.reset();
  });

  it('launches the residential browser WITH --proxy-server and the direct one without', async () => {
    const residential = await BrowserPool.getGatedBrowser('residential', PROXY);
    const direct = await BrowserPool.getGatedBrowser('direct');

    expect(launched).toHaveLength(2);
    expect(launched[0].args).toContain(`--proxy-server=${PROXY}`);
    expect(launched[1].args.some((arg) => arg.startsWith('--proxy-server'))).toBe(false);
    expect(residential.browser).not.toBe(direct.browser);
    expect(residential.proxyServer).toBe(PROXY);
    expect(direct.proxyServer).toBeUndefined();
  });

  it('reuses one browser per egress across fetches', async () => {
    const first = await BrowserPool.getGatedBrowser('residential', PROXY);
    const second = await BrowserPool.getGatedBrowser('residential', PROXY);

    expect(second).toBe(first);
    expect(puppeteer.launch).toHaveBeenCalledTimes(1);
  });

  /** Two concurrent first fetches once orphaned a whole Chrome; the in-flight launch is cached. */
  it('launches ONCE for concurrent first fetches to the same egress', async () => {
    const [a, b] = await Promise.all([
      BrowserPool.getGatedBrowser('residential', PROXY),
      BrowserPool.getGatedBrowser('residential', PROXY),
    ]);

    expect(a).toBe(b);
    expect(puppeteer.launch).toHaveBeenCalledTimes(1);
  });

  it('retries the launch after a failed one instead of caching the rejection', async () => {
    jest.mocked(puppeteer.launch).mockRejectedValueOnce(new Error('no chrome'));

    await expect(BrowserPool.getGatedBrowser('direct')).rejects.toThrow('no chrome');
    await expect(BrowserPool.getGatedBrowser('direct')).resolves.toBeDefined();
  });

  it('opens gated pages in the DEFAULT context, never a created one', async () => {
    const entry = await BrowserPool.getGatedBrowser('residential', PROXY);

    const page = await BrowserPool.openGatedPage(entry);

    expect(entry.browser.newPage).toHaveBeenCalledTimes(1);
    expect(entry.browser.createBrowserContext).not.toHaveBeenCalled();
    expect(entry.pagesOpen).toBe(1);

    await BrowserPool.closeGatedPage(entry, page);
    expect(page.close).toHaveBeenCalledTimes(1);
    expect(entry.pagesOpen).toBe(0);
    expect(entry.browser.close).not.toHaveBeenCalled();
  });

  it('does not book a page that failed to open', async () => {
    const entry = await BrowserPool.getGatedBrowser('direct');
    jest.mocked(entry.browser.newPage).mockRejectedValueOnce(new Error('target closed'));

    await expect(BrowserPool.openGatedPage(entry)).rejects.toThrow('target closed');
    expect(entry.pagesOpen).toBe(0);
  });

  it('reports a page that will not close, so the caller can retire the browser', async () => {
    const entry = await BrowserPool.getGatedBrowser('direct');
    const page = await BrowserPool.openGatedPage(entry);
    jest.mocked(page.close).mockRejectedValue(new Error('page.close() timed out'));

    await expect(BrowserPool.closeGatedPage(entry, page)).resolves.toBe(false);
    expect(entry.pagesOpen).toBe(0);
  });

  it('replaces a browser past its max age once the replacement is proven, closing the old one after it drains', async () => {
    const first = await BrowserPool.getGatedBrowser('residential', PROXY);
    first.launchedAt = Date.now() - GATED_BROWSER_MAX_AGE_MS - 1;

    await BrowserPool.getGatedBrowser('residential', PROXY);
    await BrowserPool.settleGatedRelaunches();
    await BrowserPool.settleGatedRetirements();

    const second = await BrowserPool.getGatedBrowser('residential', PROXY);
    expect(second).not.toBe(first);
    expect(puppeteer.launch).toHaveBeenCalledTimes(2);
    expect(first.browser.close).toHaveBeenCalledTimes(1);
    expect(second.browser.close).not.toHaveBeenCalled();
  });

  /**
   * THE 2026-09-08 INCIDENT: a relaunch that lands while tabs are in flight left every navigation
   * timing out until the pod was restarted by hand. The outgoing browser must keep its tabs.
   */
  it('never severs an in-flight tab: the replaced browser closes only after its tab does', async () => {
    const first = await BrowserPool.getGatedBrowser('residential', PROXY);
    const page = await BrowserPool.openGatedPage(first);
    first.launchedAt = Date.now() - GATED_BROWSER_MAX_AGE_MS - 1;

    await BrowserPool.getGatedBrowser('residential', PROXY);
    await BrowserPool.settleGatedRelaunches();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(first.browser.close).not.toHaveBeenCalled();
    expect(page.close).not.toHaveBeenCalled();
    expect(BrowserPool.gatedLaneStats('residential').drainedTabsAtRelaunch).toBe(1);

    await BrowserPool.closeGatedPage(first, page);
    await BrowserPool.settleGatedRetirements();
    expect(first.browser.close).toHaveBeenCalledTimes(1);
  });

  /**
   * The replacement holds no clearances, so it must EARN service rather than be handed it. Until its
   * proof finishes, every fetch is still answered by the browser that demonstrably works.
   */
  it('keeps serving from the aged browser until its replacement has passed the proof', async () => {
    const first = await BrowserPool.getGatedBrowser('residential', PROXY);
    first.primedHosts.set('www.anitoysgk.com', 'https://www.anitoysgk.com');
    first.launchedAt = Date.now() - GATED_BROWSER_MAX_AGE_MS - 1;

    let release!: () => void;
    const proving = new Promise<void>((resolve) => { release = resolve; });
    const prove = jest.fn<(...a: any[]) => any>().mockImplementation(async () => { await proving; return true; });

    const during = await BrowserPool.getGatedBrowser('residential', PROXY, prove as any);
    expect(during).toBe(first);
    expect(puppeteer.launch).toHaveBeenCalledTimes(2);
    expect(await BrowserPool.getGatedBrowser('residential', PROXY, prove as any)).toBe(first);
    expect(first.browser.close).not.toHaveBeenCalled();

    release();
    await BrowserPool.settleGatedRelaunches();
    await BrowserPool.settleGatedRetirements();

    const after = await BrowserPool.getGatedBrowser('residential', PROXY, prove as any);
    expect(after).not.toBe(first);
    expect(prove).toHaveBeenCalledWith(launched[1].browser, 'www.anitoysgk.com', 'https://www.anitoysgk.com');
    expect(after.primedHosts.get('www.anitoysgk.com')).toBe('https://www.anitoysgk.com');
    expect(first.browser.close).toHaveBeenCalledTimes(1);
    expect(BrowserPool.gatedLaneStats('residential').relaunchCount).toBe(1);
    expect(BrowserPool.gatedLaneStats('residential').relaunchFailures).toBe(0);
  });

  /**
   * A replacement that cannot clear the challenge is WORSE than the aged browser it would replace.
   * Discard it, keep the running one, count it, and back off instead of burning a store request per
   * fetch on a proof that is failing.
   */
  it('keeps the running browser when a replacement fails its proof, counts it, and backs off', async () => {
    const first = await BrowserPool.getGatedBrowser('residential', PROXY);
    first.primedHosts.set('www.anitoysgk.com', 'https://www.anitoysgk.com');
    first.launchedAt = Date.now() - GATED_BROWSER_MAX_AGE_MS - 1;

    await BrowserPool.getGatedBrowser('residential', PROXY, (async () => false) as any);
    await BrowserPool.settleGatedRelaunches();

    expect(await BrowserPool.getGatedBrowser('residential', PROXY, (async () => false) as any)).toBe(first);
    expect(first.browser.close).not.toHaveBeenCalled();
    expect(launched[1].browser.close).toHaveBeenCalledTimes(1);
    expect(BrowserPool.gatedLaneStats('residential').relaunchFailures).toBe(1);
    expect(BrowserPool.gatedLaneStats('residential').relaunchCount).toBe(0);
    // Backing off: the second call above must NOT have started another relaunch.
    await BrowserPool.settleGatedRelaunches();
    expect(puppeteer.launch).toHaveBeenCalledTimes(2);
  });

  /** A replacement that cannot even be launched is the same verdict as one that fails its proof. */
  it('counts a relaunch whose replacement cannot launch, and keeps the running browser', async () => {
    const first = await BrowserPool.getGatedBrowser('residential', PROXY);
    first.launchedAt = Date.now() - GATED_BROWSER_MAX_AGE_MS - 1;
    jest.mocked(puppeteer.launch).mockRejectedValueOnce(new Error('no display'));
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await BrowserPool.getGatedBrowser('residential', PROXY);
      await BrowserPool.settleGatedRelaunches();

      expect(await BrowserPool.getGatedBrowser('residential', PROXY)).toBe(first);
      expect(first.browser.close).not.toHaveBeenCalled();
      expect(BrowserPool.gatedLaneStats('residential').relaunchFailures).toBe(1);
      expect(errSpy.mock.calls.map((call) => String(call[0]))
        .some((line) => line.includes('could not launch'))).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });

  /**
   * A proof that THROWS (the prime navigation timed out, the tab died) is a failed proof, not a pass
   * — and discarding the replacement must survive a handle that will not close.
   */
  it('treats a proof that throws as a failure, even when the replacement will not close', async () => {
    const first = await BrowserPool.getGatedBrowser('residential', PROXY);
    first.primedHosts.set('www.anitoysgk.com', 'https://www.anitoysgk.com');
    first.launchedAt = Date.now() - GATED_BROWSER_MAX_AGE_MS - 1;
    jest.mocked(puppeteer.launch).mockImplementationOnce(async (config: any) => {
      const record: any = { args: config?.args ?? [], pages: [] };
      record.browser = {
        newPage: jest.fn<(...a: any[]) => any>(),
        createBrowserContext: jest.fn<(...a: any[]) => any>(),
        close: jest.fn<(...a: any[]) => any>().mockRejectedValue(new Error('handle gone')),
        connected: true,
      } as unknown as jest.Mocked<Browser>;
      launched.push(record);
      return record.browser;
    });
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const thrower = (async () => { throw new Error('prime navigation failed'); });
      await BrowserPool.getGatedBrowser('residential', PROXY, thrower as any);
      await BrowserPool.settleGatedRelaunches();

      expect(await BrowserPool.getGatedBrowser('residential', PROXY, thrower as any)).toBe(first);
      expect(first.browser.close).not.toHaveBeenCalled();
      expect(BrowserPool.gatedLaneStats('residential').relaunchFailures).toBe(1);
      expect(BrowserPool.gatedLaneStats('residential').relaunchCount).toBe(0);
      expect(warnSpy.mock.calls.map((call) => String(call[0]))
        .some((line) => line.includes('FAILED its proof on www.anitoysgk.com'))).toBe(true);
      expect(errSpy.mock.calls.map((call) => String(call[0]))
        .some((line) => line.includes('Error closing an unused residential challenge-lane replacement'))).toBe(true);
    } finally {
      errSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('replaces a gated browser that has disconnected', async () => {
    const first = await BrowserPool.getGatedBrowser('direct');
    (first.browser as any).connected = false;

    const second = await BrowserPool.getGatedBrowser('direct');

    expect(second).not.toBe(first);
    expect(puppeteer.launch).toHaveBeenCalledTimes(2);
  });

  it('relaunches when the configured proxy no longer matches the running browser', async () => {
    const first = await BrowserPool.getGatedBrowser('residential', PROXY);

    const second = await BrowserPool.getGatedBrowser('residential', 'socks5://127.0.0.1:1081');
    await BrowserPool.settleGatedRetirements();

    expect(second).not.toBe(first);
    expect(launched[1].args).toContain('--proxy-server=socks5://127.0.0.1:1081');
  });

  it('retires a browser on demand, and the next fetch gets a fresh one', async () => {
    const first = await BrowserPool.getGatedBrowser('direct');

    await BrowserPool.retireGatedBrowser(first);

    expect(first.browser.close).toHaveBeenCalledTimes(1);
    expect(await BrowserPool.getGatedBrowser('direct')).not.toBe(first);
  });

  it('closes BOTH gated browsers on shutdown', async () => {
    const residential = await BrowserPool.getGatedBrowser('residential', PROXY);
    const direct = await BrowserPool.getGatedBrowser('direct');

    await BrowserPool.closeAll();

    expect(residential.browser.close).toHaveBeenCalledTimes(1);
    expect(direct.browser.close).toHaveBeenCalledTimes(1);
    expect(BrowserPool.gatedBrowsers()).toEqual([]);
  });

  it('closes a still-draining browser on shutdown instead of waiting out its pages', async () => {
    const first = await BrowserPool.getGatedBrowser('direct');
    await BrowserPool.openGatedPage(first); // never closed: the drain would wait for it
    first.launchedAt = Date.now() - GATED_BROWSER_MAX_AGE_MS - 1;
    await BrowserPool.getGatedBrowser('direct');

    await BrowserPool.closeAll();

    expect(first.browser.close).toHaveBeenCalledTimes(1);
  });

  it('lists the live gated browsers for the health surface', async () => {
    const entry = await BrowserPool.getGatedBrowser('residential', PROXY);
    entry.primedHosts.set('www.anitoysgk.com', 'https://www.anitoysgk.com');
    await BrowserPool.openGatedPage(entry);

    expect(BrowserPool.gatedBrowsers()).toEqual([
      {
        egress: 'residential',
        launchedAt: new Date(entry.launchedAt).toISOString(),
        pagesOpen: 1,
        primedHosts: 1,
        lastRelaunchAt: null,
        relaunchCount: 0,
        relaunchFailures: 0,
        drainedTabsAtRelaunch: 0,
        firstNavigationRetries: 0,
        firstNavigationRecoveries: 0,
      },
    ]);
  });
});

describe('buildBrowserConfig proxy argument', () => {
  it('appends --proxy-server to the clean-headful args', () => {
    const config = buildBrowserConfig(
      { BROWSER_LAUNCH_MODE: 'clean-headful' } as NodeJS.ProcessEnv,
      { proxyServer: 'socks5://127.0.0.1:1055' },
    );

    expect(config.args).toContain('--proxy-server=socks5://127.0.0.1:1055');
    expect(config.headless).toBe(false);
  });

  it('adds nothing when no proxy is given', () => {
    const config = buildBrowserConfig({ BROWSER_LAUNCH_MODE: 'clean-headful' } as NodeJS.ProcessEnv);

    expect(config.args.some((arg) => arg.startsWith('--proxy-server'))).toBe(false);
  });
});
