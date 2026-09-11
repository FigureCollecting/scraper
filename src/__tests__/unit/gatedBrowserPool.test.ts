import { jest } from '@jest/globals';
import puppeteer from 'puppeteer';
import type { Browser, Page } from 'puppeteer';
import { BrowserPool, buildBrowserConfig } from '../../services/genericScraper';
import { GATED_BROWSER_MAX_AGE_MS, GATED_NAV_FAILURE_STREAK } from '../../services/gatedBrowsers';

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

  const savedCgroupReader = BrowserPool.readGatedCgroupLimitBytes;
  const savedMemoryReader = BrowserPool.readGatedTreeMemory;

  beforeEach(async () => {
    jest.clearAllMocks();
    await BrowserPool.reset();
    // The threshold is derived from the container ceiling, so a test that read a real /sys/fs/cgroup
    // would depend on the machine it runs on. Unknown ceiling ⇒ the documented 1 GiB floor.
    BrowserPool.readGatedCgroupLimitBytes = async () => undefined;
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
        process: jest.fn(() => ({ pid: 424242 })),
        cookies: jest.fn<(...a: any[]) => any>().mockResolvedValue([]),
        setCookie: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
        connected: true,
      } as unknown as jest.Mocked<Browser>;
      launched.push(record);
      return record.browser;
    });
  });

  afterEach(async () => {
    if (savedMode === undefined) delete process.env.BROWSER_LAUNCH_MODE;
    else process.env.BROWSER_LAUNCH_MODE = savedMode;
    BrowserPool.readGatedCgroupLimitBytes = savedCgroupReader;
    BrowserPool.readGatedTreeMemory = savedMemoryReader;
    await BrowserPool.reset();
  });

  /** A measured tree, as the PSS walk reports one. */
  const measured = (mb: number, method: 'pss-rollup' | 'rss-fallback' = 'pss-rollup') =>
    async () => ({ bytes: mb * 1024 * 1024, method, processes: 9 });

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

  /**
   * THE POLICY CHANGE. A cleared Cloudflare session is an asset bound to the egress IP, the TLS
   * fingerprint and the user agent; discarding a healthy one buys nothing and spends that IP's
   * reputation on a fresh challenge. The clock is now a twelve-hour BACKSTOP, so a browser that the
   * old two-hour timer would have thrown away is left alone.
   */
  it('leaves a healthy three-hour-old browser alone, where the old two-hour timer recycled it', async () => {
    const first = await BrowserPool.getGatedBrowser('residential', PROXY);
    first.launchedAt = Date.now() - 3 * 60 * 60 * 1000;

    expect(await BrowserPool.getGatedBrowser('residential', PROXY)).toBe(first);
    await BrowserPool.settleGatedRelaunches();
    expect(puppeteer.launch).toHaveBeenCalledTimes(1);
  });

  it('honours GATED_BROWSER_MAX_AGE_MS as the backstop, and records the reason', async () => {
    const saved = process.env.GATED_BROWSER_MAX_AGE_MS;
    process.env.GATED_BROWSER_MAX_AGE_MS = '1000';
    try {
      const first = await BrowserPool.getGatedBrowser('residential', PROXY);
      first.launchedAt = Date.now() - 5000;

      await BrowserPool.getGatedBrowser('residential', PROXY);
      await BrowserPool.settleGatedRelaunches();
      await BrowserPool.settleGatedRetirements();

      expect(puppeteer.launch).toHaveBeenCalledTimes(2);
      expect(BrowserPool.gatedLaneStats('residential').lastRelaunchReason).toBe('backstop');
    } finally {
      if (saved === undefined) delete process.env.GATED_BROWSER_MAX_AGE_MS;
      else process.env.GATED_BROWSER_MAX_AGE_MS = saved;
    }
  });

  /**
   * MEMORY IS WHAT THE TIMER WAS EVER PROXYING, so it is measured directly: the browser process plus
   * its renderers, which is where Chrome's growth actually lands.
   */
  it('relaunches on measured memory growth, naming rss as the reason', async () => {
    const savedLimit = process.env.GATED_BROWSER_MAX_RSS_MB;
    process.env.GATED_BROWSER_MAX_RSS_MB = '512';
    BrowserPool.readGatedTreeMemory = measured(600);
    try {
      const first = await BrowserPool.getGatedBrowser('residential', PROXY);
      // The sample is deliberately not awaited by the fetch that triggers it; the NEXT one reads it.
      await BrowserPool.getGatedBrowser('residential', PROXY);
      await new Promise((resolve) => setTimeout(resolve, 5));
      // This fetch sees the measurement and starts the relaunch; it is still served by `first`.
      expect(await BrowserPool.getGatedBrowser('residential', PROXY)).toBe(first);
      await BrowserPool.settleGatedRelaunches();
      await BrowserPool.settleGatedRetirements();

      expect(await BrowserPool.getGatedBrowser('residential', PROXY)).not.toBe(first);
      expect(BrowserPool.gatedLaneStats('residential').lastRelaunchReason).toBe('rss');
    } finally {
      if (savedLimit === undefined) delete process.env.GATED_BROWSER_MAX_RSS_MB;
      else process.env.GATED_BROWSER_MAX_RSS_MB = savedLimit;
    }
  });

  it('does not relaunch on memory it could not measure', async () => {
    const savedLimit = process.env.GATED_BROWSER_MAX_RSS_MB;
    process.env.GATED_BROWSER_MAX_RSS_MB = '1';
    BrowserPool.readGatedTreeMemory = async () => undefined;
    try {
      const first = await BrowserPool.getGatedBrowser('residential', PROXY);
      await new Promise((resolve) => setTimeout(resolve, 5));

      expect(await BrowserPool.getGatedBrowser('residential', PROXY)).toBe(first);
      await BrowserPool.settleGatedRelaunches();
      expect(puppeteer.launch).toHaveBeenCalledTimes(1);
      expect(BrowserPool.gatedBrowsers()[0].rssMb).toBeNull();
    } finally {
      if (savedLimit === undefined) delete process.env.GATED_BROWSER_MAX_RSS_MB;
      else process.env.GATED_BROWSER_MAX_RSS_MB = savedLimit;
    }
  });

  /** A memory read that THROWS is still no evidence, and must not take the lane down with it. */
  it('survives a memory reader that throws, leaving the browser in service', async () => {
    BrowserPool.readGatedTreeMemory = async () => { throw new Error('/proc/424242/smaps_rollup: EACCES'); };

    const first = await BrowserPool.getGatedBrowser('residential', PROXY);
    await BrowserPool.getGatedBrowser('residential', PROXY);
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(await BrowserPool.getGatedBrowser('residential', PROXY)).toBe(first);
    expect(BrowserPool.gatedBrowsers()[0].rssMb).toBeNull();
    await BrowserPool.settleGatedRelaunches();
    expect(puppeteer.launch).toHaveBeenCalledTimes(1);
  });

  /**
   * THE 2026-09-08 SELF-HEAL. That browser answered every navigation with a timeout for 102 minutes
   * and recovered only when a human restarted the pod, because nothing was watching for it.
   */
  it('relaunches a lane whose navigations keep failing, and a success clears the streak', async () => {
    const first = await BrowserPool.getGatedBrowser('residential', PROXY);

    for (let i = 0; i < GATED_NAV_FAILURE_STREAK - 1; i++) BrowserPool.recordGatedNavigation('residential', false);
    expect(await BrowserPool.getGatedBrowser('residential', PROXY)).toBe(first);
    expect(puppeteer.launch).toHaveBeenCalledTimes(1);

    BrowserPool.recordGatedNavigation('residential', true);
    expect(BrowserPool.gatedLaneStats('residential').navFailureStreak).toBe(0);

    for (let i = 0; i < GATED_NAV_FAILURE_STREAK; i++) BrowserPool.recordGatedNavigation('residential', false);
    await BrowserPool.getGatedBrowser('residential', PROXY);
    await BrowserPool.settleGatedRelaunches();
    await BrowserPool.settleGatedRetirements();

    expect(await BrowserPool.getGatedBrowser('residential', PROXY)).not.toBe(first);
    expect(BrowserPool.gatedLaneStats('residential').lastRelaunchReason).toBe('navigation-failures');
    expect(BrowserPool.gatedLaneStats('residential').navFailureStreak).toBe(0);
  });

  /**
   * PROFILE CARRY-OVER, as cookies rather than as a copied user-data-dir. The clearance is what makes
   * the outgoing browser valuable; the replacement should meet the store as a returning visitor.
   */
  it('carries the outgoing browser session into its replacement before the proof runs', async () => {
    const clearance = [{ name: 'cf_clearance', value: 'abc', domain: '.suruga-ya.jp' }];
    const first = await BrowserPool.getGatedBrowser('residential', PROXY);
    jest.mocked(first.browser.cookies).mockResolvedValue(clearance as any);
    first.launchedAt = Date.now() - GATED_BROWSER_MAX_AGE_MS - 1;

    const seenAtProof: boolean[] = [];
    const prove = async (browser: any): Promise<boolean> => {
      seenAtProof.push(jest.mocked(browser.setCookie).mock.calls.length > 0);
      return true;
    };
    first.primedHosts.set('www.anitoysgk.com', 'https://www.anitoysgk.com');

    await BrowserPool.getGatedBrowser('residential', PROXY, prove as any);
    await BrowserPool.settleGatedRelaunches();
    await BrowserPool.settleGatedRetirements();

    expect(jest.mocked(launched[1].browser.setCookie)).toHaveBeenCalledWith(clearance[0]);
    // The proof must judge the profile the replacement will actually serve with.
    expect(seenAtProof).toEqual([true]);
  });

  /**
   * A clearance can go BAD — the residential exit rotated under it — and copying a bad one into every
   * replacement forever would pin the lane to its old browser permanently.
   *
   * BUT ONLY THE FAILING HOST'S. The proof loop stops at the first failure, so every host it had
   * already passed cleared WITH its carried clearance; discarding those spends a fresh Cloudflare
   * challenge each, from the residential IP whose reputation this whole change protects. This was
   * lane-wide before 2026-09-11 and is now per host, escalating only on a repeat.
   */
  it('withholds only the failing host\'s clearance after a carried proof fails', async () => {
    const jar = [
      { name: 'cf_clearance', value: 'stale', domain: '.anitoysgk.com' },
      { name: 'cf_clearance', value: 'good', domain: '.suruga-ya.jp' },
    ];
    const first = await BrowserPool.getGatedBrowser('residential', PROXY);
    jest.mocked(first.browser.cookies).mockResolvedValue(jar as any);
    first.primedHosts.set('www.anitoysgk.com', 'https://www.anitoysgk.com');
    first.launchedAt = Date.now() - GATED_BROWSER_MAX_AGE_MS - 1;
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await BrowserPool.getGatedBrowser('residential', PROXY, (async () => false) as any);
      await BrowserPool.settleGatedRelaunches();
      expect(jest.mocked(launched[1].browser.setCookie)).toHaveBeenCalledWith(jar[0], jar[1]);
      expect(BrowserPool.gatedLaneStats('residential').carryBlockedHosts).toEqual(['www.anitoysgk.com']);
      expect(BrowserPool.gatedLaneStats('residential').carryOverBlocked).toBe(false);

      // The backoff is what stops the retry storm; clear it to exercise the NEXT attempt.
      BrowserPool.gatedLaneStats('residential').retryAfter = 0;
      await BrowserPool.getGatedBrowser('residential', PROXY, (async () => false) as any);
      await BrowserPool.settleGatedRelaunches();

      expect(launched).toHaveLength(3);
      // The suruga-ya clearance survives; only anitoysgk's is withheld.
      expect(jest.mocked(launched[2].browser.setCookie)).toHaveBeenCalledWith(jar[1]);
      // A REPEAT on the same host, with its cookies already withheld, escalates to a clean profile.
      expect(BrowserPool.gatedLaneStats('residential').carryOverBlocked).toBe(true);

      BrowserPool.gatedLaneStats('residential').retryAfter = 0;
      await BrowserPool.getGatedBrowser('residential', PROXY, (async () => false) as any);
      await BrowserPool.settleGatedRelaunches();

      expect(launched).toHaveLength(4);
      expect(jest.mocked(launched[3].browser.setCookie)).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('carries on regardless when the outgoing session cannot be read', async () => {
    const first = await BrowserPool.getGatedBrowser('residential', PROXY);
    jest.mocked(first.browser.cookies).mockRejectedValue(new Error('target closed'));
    first.launchedAt = Date.now() - GATED_BROWSER_MAX_AGE_MS - 1;
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await BrowserPool.getGatedBrowser('residential', PROXY);
      await BrowserPool.settleGatedRelaunches();
      await BrowserPool.settleGatedRetirements();

      expect(await BrowserPool.getGatedBrowser('residential', PROXY)).not.toBe(first);
      expect(BrowserPool.gatedLaneStats('residential').relaunchCount).toBe(1);
      expect(warnSpy.mock.calls.map((call) => String(call[0]))
        .some((line) => line.includes('could not carry the residential challenge-lane session'))).toBe(true);
    } finally {
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
        lastRelaunchReason: null,
        navFailureStreak: 0,
        // Both names carry the SAME measurement, so the fleet check's gated-browser probe keeps
        // working across this deploy while `memoryMethod` says which kind of number it is.
        pssMb: null,
        rssMb: null,
        memoryMethod: null,
        memoryThresholdMb: 1024,
        relaunchSuppressed: 0,
        lastSuppressedReason: null,
        nextRelaunchAllowedAt: null,
        relaunchBackoffMs: 0,
        carryBlockedHosts: [],
      },
    ]);
  });

  /**
   * /health has to EXPLAIN itself. During the 2026-09-11 churn it showed `rssMb: null` on every
   * fresh instance while `lastRelaunchReason` said `rss`, because a successful relaunch clears the
   * sample — an operator reading it concluded the memory trigger was inert while it was firing
   * every thirty seconds. The measurement, the method and the threshold now travel together.
   */
  it('reports the measurement, the method and the threshold it was compared against', async () => {
    const savedLimit = process.env.GATED_BROWSER_MAX_RSS_MB;
    delete process.env.GATED_BROWSER_MAX_RSS_MB;
    BrowserPool.readGatedCgroupLimitBytes = async () => 3 * 1024 * 1024 * 1024;
    BrowserPool.readGatedTreeMemory = measured(217);
    try {
      await BrowserPool.getGatedBrowser('residential', PROXY);
      await BrowserPool.getGatedBrowser('residential', PROXY);
      await new Promise((resolve) => setTimeout(resolve, 5));

      const view = BrowserPool.gatedBrowsers()[0];
      expect(view.pssMb).toBe(217);
      expect(view.rssMb).toBe(217);
      expect(view.memoryMethod).toBe('pss-rollup');
      // 40 % of the pod's own 3 GiB ceiling, derived rather than guessed.
      expect(view.memoryThresholdMb).toBe(1229);
      await BrowserPool.settleGatedRelaunches();
      expect(puppeteer.launch).toHaveBeenCalledTimes(1);
    } finally {
      if (savedLimit !== undefined) process.env.GATED_BROWSER_MAX_RSS_MB = savedLimit;
    }
  });

  /**
   * THE DEFECT ITSELF, end to end. Production relaunched the residential lane eight times between
   * 22:31:18Z and 22:40:49Z on 2026-09-11 — 30 to 40 s apart — because a successful relaunch CLEARS
   * the measurement, so the next fetch re-measured the fresh tree, found it over the threshold
   * again, and fired again. Eight prime navigations on Cloudflare-fronted stores in ten minutes.
   */
  it('relaunches ONCE on persistent memory pressure instead of on every fetch', async () => {
    const savedLimit = process.env.GATED_BROWSER_MAX_RSS_MB;
    process.env.GATED_BROWSER_MAX_RSS_MB = '512';
    // Every tree this lane ever measures is over the threshold — the 2026-09-11 shape exactly.
    BrowserPool.readGatedTreeMemory = measured(900);
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const first = await BrowserPool.getGatedBrowser('residential', PROXY);
      await BrowserPool.getGatedBrowser('residential', PROXY);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await BrowserPool.getGatedBrowser('residential', PROXY);
      await BrowserPool.settleGatedRelaunches();
      await BrowserPool.settleGatedRetirements();

      const replacement = await BrowserPool.getGatedBrowser('residential', PROXY);
      expect(replacement).not.toBe(first);

      // Eight more fetches, each of which USED TO start a relaunch of its own.
      for (let i = 0; i < 8; i++) {
        BrowserPool.gatedLaneStats('residential').memorySampledAt = 0; // force a fresh sample
        await BrowserPool.getGatedBrowser('residential', PROXY);
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      await BrowserPool.settleGatedRelaunches();

      expect(await BrowserPool.getGatedBrowser('residential', PROXY)).toBe(replacement);
      expect(puppeteer.launch).toHaveBeenCalledTimes(2);
      const stats = BrowserPool.gatedLaneStats('residential');
      expect(stats.relaunchCount).toBe(1);
      expect(stats.relaunchSuppressed).toBeGreaterThan(0);
      expect(BrowserPool.gatedBrowsers()[0].lastSuppressedReason).toMatch(/rss rate-limited/);
      // The suppression is stated in the log with the numbers behind it, not left to be inferred.
      expect(logSpy.mock.calls.map((call) => String(call[0]))
        .some((line) => /SUPPRESSED.*measured=900MB threshold=512MB method=pss-rollup/.test(line))).toBe(true);
    } finally {
      logSpy.mockRestore();
      if (savedLimit === undefined) delete process.env.GATED_BROWSER_MAX_RSS_MB;
      else process.env.GATED_BROWSER_MAX_RSS_MB = savedLimit;
    }
  });

  /**
   * A relaunch that does not bring the tree down cannot be the cure, so the wait DOUBLES rather
   * than repeating. Without this the lane would settle into one relaunch every interval forever.
   */
  it('backs off exponentially when a relaunch does not bring the tree down', async () => {
    const savedLimit = process.env.GATED_BROWSER_MAX_RSS_MB;
    const savedInterval = process.env.GATED_BROWSER_MIN_RELAUNCH_INTERVAL_MS;
    const savedGrace = process.env.GATED_RELAUNCH_GRACE_MS;
    process.env.GATED_BROWSER_MAX_RSS_MB = '512';
    process.env.GATED_BROWSER_MIN_RELAUNCH_INTERVAL_MS = '40';
    process.env.GATED_RELAUNCH_GRACE_MS = '60';
    BrowserPool.readGatedTreeMemory = measured(900);
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await BrowserPool.getGatedBrowser('residential', PROXY);
      await BrowserPool.getGatedBrowser('residential', PROXY);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await BrowserPool.getGatedBrowser('residential', PROXY);
      await BrowserPool.settleGatedRelaunches();
      await BrowserPool.settleGatedRetirements();
      expect(BrowserPool.gatedLaneStats('residential').relaunchCount).toBe(1);

      // Past the grace window, on a replacement that is just as big: the verdict is "this did not
      // help", and the next attempt has to wait twice the interval instead of one.
      await new Promise((resolve) => setTimeout(resolve, 70));
      BrowserPool.gatedLaneStats('residential').memorySampledAt = 0;
      await BrowserPool.getGatedBrowser('residential', PROXY); // fires the sample
      await new Promise((resolve) => setTimeout(resolve, 5));
      await BrowserPool.getGatedBrowser('residential', PROXY); // the gate now sees it
      await BrowserPool.settleGatedRelaunches();

      const stats = BrowserPool.gatedLaneStats('residential');
      expect(stats.relaunchBackoffMs).toBe(80);
      expect(stats.relaunchCount).toBe(1);
      expect(puppeteer.launch).toHaveBeenCalledTimes(2);
    } finally {
      logSpy.mockRestore();
      for (const [key, value] of [
        ['GATED_BROWSER_MAX_RSS_MB', savedLimit],
        ['GATED_BROWSER_MIN_RELAUNCH_INTERVAL_MS', savedInterval],
        ['GATED_RELAUNCH_GRACE_MS', savedGrace],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  /**
   * The threshold falls back to its documented 1 GiB floor when the ceiling cannot be read at all —
   * a laptop, a cgroup-less container, a /sys that refuses. Never a reason to stop measuring.
   */
  it('keeps the floor threshold when the cgroup ceiling cannot be read', async () => {
    const savedLimit = process.env.GATED_BROWSER_MAX_RSS_MB;
    delete process.env.GATED_BROWSER_MAX_RSS_MB;
    BrowserPool.readGatedCgroupLimitBytes = async () => { throw new Error('/sys/fs/cgroup: ENOENT'); };
    BrowserPool.readGatedTreeMemory = measured(300);
    try {
      await BrowserPool.getGatedBrowser('residential', PROXY);
      await BrowserPool.getGatedBrowser('residential', PROXY);
      await new Promise((resolve) => setTimeout(resolve, 5));

      const view = BrowserPool.gatedBrowsers()[0];
      expect(view.memoryThresholdMb).toBe(1024);
      expect(view.pssMb).toBe(300);
      await BrowserPool.settleGatedRelaunches();
      expect(puppeteer.launch).toHaveBeenCalledTimes(1);
    } finally {
      if (savedLimit !== undefined) process.env.GATED_BROWSER_MAX_RSS_MB = savedLimit;
    }
  });

  /**
   * THE ONE EXEMPTION, and the shadowing it has to survive.
   *
   * The backstop is the last line of defence against whatever the evidence triggers miss, so it is
   * never rate-limited. It is also asked SEPARATELY from the evidence ladder: this lane's memory
   * trigger is permanently hot, so a ladder that returned the first match would answer `rss` on
   * every evaluation, have it suppressed on every evaluation, and never reach the clock at all.
   */
  it('lets the backstop through even while the memory trigger is rate-limited', async () => {
    const savedAge = process.env.GATED_BROWSER_MAX_AGE_MS;
    const savedLimit = process.env.GATED_BROWSER_MAX_RSS_MB;
    process.env.GATED_BROWSER_MAX_RSS_MB = '512';
    BrowserPool.readGatedTreeMemory = measured(900);
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await BrowserPool.getGatedBrowser('residential', PROXY);
      await BrowserPool.getGatedBrowser('residential', PROXY);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await BrowserPool.getGatedBrowser('residential', PROXY);
      await BrowserPool.settleGatedRelaunches();
      await BrowserPool.settleGatedRetirements();
      expect(puppeteer.launch).toHaveBeenCalledTimes(2);

      // Let the replacement be MEASURED, so the memory trigger is genuinely hot on this lane…
      const replacement = await BrowserPool.getGatedBrowser('residential', PROXY);
      await new Promise((resolve) => setTimeout(resolve, 5));
      // …and refused, because the lane is inside its thirty-minute interval.
      await BrowserPool.getGatedBrowser('residential', PROXY);
      await BrowserPool.settleGatedRelaunches();
      expect(puppeteer.launch).toHaveBeenCalledTimes(2);
      expect(BrowserPool.gatedLaneStats('residential').relaunchSuppressed).toBeGreaterThan(0);

      // NOW age it past the backstop. A ladder that returned the first match would answer `rss`,
      // have it suppressed, and leave this browser running forever.
      process.env.GATED_BROWSER_MAX_AGE_MS = '1000';
      replacement.launchedAt = Date.now() - 5000;
      await BrowserPool.getGatedBrowser('residential', PROXY);
      await BrowserPool.settleGatedRelaunches();
      await BrowserPool.settleGatedRetirements();

      expect(puppeteer.launch).toHaveBeenCalledTimes(3);
      expect(BrowserPool.gatedLaneStats('residential').lastRelaunchReason).toBe('backstop');
    } finally {
      logSpy.mockRestore();
      if (savedAge === undefined) delete process.env.GATED_BROWSER_MAX_AGE_MS;
      else process.env.GATED_BROWSER_MAX_AGE_MS = savedAge;
      if (savedLimit === undefined) delete process.env.GATED_BROWSER_MAX_RSS_MB;
      else process.env.GATED_BROWSER_MAX_RSS_MB = savedLimit;
    }
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
