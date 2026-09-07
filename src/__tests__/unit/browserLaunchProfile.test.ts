import { buildBrowserConfig, isCleanHeadfulMode } from '../../services/genericScraper';

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

  it('returns a fresh args array per call (no shared mutable module state)', () => {
    const first = buildBrowserConfig({ BROWSER_LAUNCH_MODE: 'clean-headful' } as NodeJS.ProcessEnv);
    first.args.push('--mutated');
    const second = buildBrowserConfig({ BROWSER_LAUNCH_MODE: 'clean-headful' } as NodeJS.ProcessEnv);

    expect(second.args).not.toContain('--mutated');
  });
});
