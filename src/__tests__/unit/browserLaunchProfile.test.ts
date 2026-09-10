import { jest } from '@jest/globals';
import puppeteer from 'puppeteer';
import type { Browser } from 'puppeteer';
import { BrowserPool, buildBrowserConfig, isCleanHeadfulMode } from '../../services/genericScraper';

/**
 * The launch profile is the difference between passing a Cloudflare JS challenge and staring at
 * "Just a moment" forever. `clean-headful` is the PROVEN production recipe (real Chrome, headful on
 * the Ozone headless platform, no automation switch, minimal flag surface); the default headless
 * profile is what CI and every existing test still launch, unchanged.
 */
describe('browser launch profile (BROWSER_LAUNCH_MODE)', () => {
  const CLEAN_HEADFUL_ARGS = [
    '--ozone-platform=headless',
    '--disable-blink-features=AutomationControlled',
    '--lang=en-US',
    '--window-size=1280,900',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-features=EnableTLS13EarlyData',
  ];

  // Every flag the headless profile carries that the proven recipe does NOT: each one is an extra
  // detection surface, so none of them may leak into clean-headful.
  const FORBIDDEN_IN_CLEAN_HEADFUL = [
    '--disable-web-security',
    '--disable-gpu',
    '--disable-extensions',
    '--no-zygote',
    '--disable-features=TranslateUI',
    '--disable-ipc-flooding-protection',
    '--memory-pressure-off',
    '--disable-accelerated-2d-canvas',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
  ];

  it('defaults to the headless profile when BROWSER_LAUNCH_MODE is unset', () => {
    const config = buildBrowserConfig({} as NodeJS.ProcessEnv);

    expect(isCleanHeadfulMode({} as NodeJS.ProcessEnv)).toBe(false);
    expect(config.headless).toBe(true);
    expect(config.ignoreDefaultArgs).toBeUndefined();
    expect(config.defaultViewport).toBeUndefined(); // headless keeps puppeteer's own default
    expect(config.args).toContain('--disable-web-security');
    expect(config.args).toContain('--no-sandbox');
  });

  it('keeps the headless profile for any other value', () => {
    const config = buildBrowserConfig({ BROWSER_LAUNCH_MODE: 'headless' } as NodeJS.ProcessEnv);

    expect(config.headless).toBe(true);
  });

  it('builds EXACTLY the proven recipe in clean-headful mode', () => {
    const config = buildBrowserConfig({ BROWSER_LAUNCH_MODE: 'clean-headful' } as NodeJS.ProcessEnv);

    expect(isCleanHeadfulMode({ BROWSER_LAUNCH_MODE: 'clean-headful' } as NodeJS.ProcessEnv)).toBe(true);
    expect(config.headless).toBe(false);
    expect(config.ignoreDefaultArgs).toEqual(['--enable-automation']);
    expect(config.args).toEqual(CLEAN_HEADFUL_ARGS);
    // No device-metrics override at all: puppeteer's 800x600 default would contradict the 1280x900
    // window the launch flag asks for (measured: outer 1280x900 vs inner 800x600).
    expect(config.defaultViewport).toBeNull();
  });

  /**
   * PROD INCIDENT 2026-09-10: the residential gated browser's network service burned 40-100% of the
   * pod's 1-CPU limit in an unbounded loop logging
   * `ssl_client_socket_impl.cc: handshake failed; ... SSL error code 15, net_error -178`
   * (SSL_ERROR_EARLY_DATA_REJECTED / ERR_EARLY_DATA_REJECTED) ~10,700 times a second, leaking one
   * TCP connection to the egress proxy per iteration, until every navigation timed out. TLS 1.3
   * 0-RTT is what makes that state reachable: without early data the reject cannot occur.
   */
  it('disables TLS 1.3 early data in clean-headful mode (0-RTT reject spin, 2026-09-10)', () => {
    const config = buildBrowserConfig({ BROWSER_LAUNCH_MODE: 'clean-headful' } as NodeJS.ProcessEnv);

    expect(config.args).toContain('--disable-features=EnableTLS13EarlyData');
  });

  it('carries none of the headless profile\'s extra flags in clean-headful mode', () => {
    const config = buildBrowserConfig({ BROWSER_LAUNCH_MODE: 'clean-headful' } as NodeJS.ProcessEnv);

    for (const flag of FORBIDDEN_IN_CLEAN_HEADFUL) {
      expect(config.args).not.toContain(flag);
    }
  });

  it('adds --single-process under GitHub Actions in both modes', () => {
    const headless = buildBrowserConfig({ GITHUB_ACTIONS: 'true' } as NodeJS.ProcessEnv);
    const clean = buildBrowserConfig({ GITHUB_ACTIONS: 'true', BROWSER_LAUNCH_MODE: 'clean-headful' } as NodeJS.ProcessEnv);

    expect(headless.args).toContain('--single-process');
    expect(clean.args).toContain('--single-process');
    expect(clean.args.slice(0, CLEAN_HEADFUL_ARGS.length)).toEqual(CLEAN_HEADFUL_ARGS);
  });

  it('takes the executable path from PUPPETEER_EXECUTABLE_PATH in both modes', () => {
    const headless = buildBrowserConfig({ PUPPETEER_EXECUTABLE_PATH: '/opt/chrome/chrome' } as NodeJS.ProcessEnv);
    const clean = buildBrowserConfig({ PUPPETEER_EXECUTABLE_PATH: '/opt/chrome/chrome', BROWSER_LAUNCH_MODE: 'clean-headful' } as NodeJS.ProcessEnv);

    expect(headless.executablePath).toBe('/opt/chrome/chrome');
    expect(clean.executablePath).toBe('/opt/chrome/chrome');
  });

  /**
   * The profile is process-wide: in clean-headful mode the warm POOL is full headful Chromes too,
   * each with its own GPU/viz process and a 1280x900 surface, and the challenge-lane browser is an
   * additional always-on one. The 3-browser HEADLESS warm pool already measured ~2.5 GB against a
   * 3 Gi limit, so the pool gives a slot back to keep the total at three browsers.
   */
  describe('warm pool size', () => {
    const savedMode = process.env.BROWSER_LAUNCH_MODE;

    afterEach(async () => {
      if (savedMode === undefined) delete process.env.BROWSER_LAUNCH_MODE;
      else process.env.BROWSER_LAUNCH_MODE = savedMode;
      await BrowserPool.reset();
    });

    it('keeps three warm browsers on the headless profile', () => {
      delete process.env.BROWSER_LAUNCH_MODE;
      expect(BrowserPool.getPoolCapacity()).toBe(3);
    });

    it('warms one fewer in clean-headful mode, and launches only that many', async () => {
      process.env.BROWSER_LAUNCH_MODE = 'clean-headful';
      expect(BrowserPool.getPoolCapacity()).toBe(2);

      jest.mocked(puppeteer.launch).mockClear();
      jest.mocked(puppeteer.launch).mockResolvedValue({
        close: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
        connected: true,
      } as unknown as Browser);
      await BrowserPool.initialize();

      expect(puppeteer.launch).toHaveBeenCalledTimes(2);
      expect(BrowserPool.getPoolSize()).toBe(2);
    });
  });

  /**
   * The challenge-lane browser is a singleton because its passed challenges are the asset. Caching
   * the RESOLVED browser (not the launch) let two concurrent first fetches launch two Chromes and
   * orphan one: closeAll only ever closes the survivor, so the orphan outlives SIGTERM and holds the
   * process open — the hang the shutdown close was written to fix, reachable again under load.
   */
  describe('challenge-lane singleton', () => {
    afterEach(async () => {
      await BrowserPool.reset();
      (BrowserPool as any).stealthBrowser = null;
      (BrowserPool as any).stealthLaunch = null;
    });

    it('launches ONE browser under concurrent first calls', async () => {
      (BrowserPool as any).stealthBrowser = null;
      (BrowserPool as any).stealthLaunch = null;
      jest.mocked(puppeteer.launch).mockClear();
      jest.mocked(puppeteer.launch).mockImplementation(async () => ({
        close: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
        connected: true,
      } as unknown as Browser));

      const [first, second] = await Promise.all([
        BrowserPool.getStealthBrowser(),
        BrowserPool.getStealthBrowser(),
      ]);

      expect(puppeteer.launch).toHaveBeenCalledTimes(1);
      expect(first).toBe(second);
    });

    it('relaunches after a failed launch instead of caching the rejection', async () => {
      (BrowserPool as any).stealthBrowser = null;
      (BrowserPool as any).stealthLaunch = null;
      jest.mocked(puppeteer.launch)
        .mockRejectedValueOnce(new Error('no display'))
        .mockResolvedValueOnce({ close: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined), connected: true } as unknown as Browser);

      await expect(BrowserPool.getStealthBrowser()).rejects.toThrow('no display');
      await expect(BrowserPool.getStealthBrowser()).resolves.toBeDefined();
    });
  });

  it('returns a fresh args array per call (no shared mutable module state)', () => {
    const first = buildBrowserConfig({ BROWSER_LAUNCH_MODE: 'clean-headful' } as NodeJS.ProcessEnv);
    first.args.push('--mutated');
    const second = buildBrowserConfig({ BROWSER_LAUNCH_MODE: 'clean-headful' } as NodeJS.ProcessEnv);

    expect(second.args).not.toContain('--mutated');
  });
});
