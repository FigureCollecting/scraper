import { jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer';
import type { Browser } from 'puppeteer';
import { BrowserPool, buildBrowserConfig } from '../../services/genericScraper';

/**
 * The stealth plugin is GONE. It was the wrong answer to Cloudflare — measured 2026-09-07, the
 * plugin + an old Chrome FAILS the JS challenge that a plain, current Chrome passes — and every
 * property it patches is one more thing that can disagree with the real browser. `getStealthBrowser`
 * now means only "the singleton browser reserved for challenge-gated hosts", launched with exactly
 * the same profile as the pool.
 */
describe('stealth plugin removal', () => {
  const repoRoot = path.resolve(__dirname, '../../..');

  it('declares neither puppeteer-extra nor its stealth plugin as a dependency', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const declared = { ...pkg.dependencies, ...pkg.devDependencies };

    expect(Object.keys(declared)).not.toContain('puppeteer-extra');
    expect(Object.keys(declared)).not.toContain('puppeteer-extra-plugin-stealth');
  });

  it('never imports puppeteer-extra or the stealth plugin in the browser pool source', () => {
    const source = fs.readFileSync(path.join(repoRoot, 'src/services/genericScraper.ts'), 'utf8');

    expect(source).not.toMatch(/(?:import|require)\s*\(?\s*['"]puppeteer-extra/);
    expect(source).not.toMatch(/from\s+['"]puppeteer-extra/);
    expect(source).not.toMatch(/StealthPlugin/);
  });

  it('launches the stealth browser with the pool profile, with no test-environment special case', async () => {
    const nodeEnv = process.env.NODE_ENV;
    const worker = process.env.JEST_WORKER_ID;
    process.env.NODE_ENV = 'production';
    delete process.env.JEST_WORKER_ID;

    try {
      await BrowserPool.reset();
      (BrowserPool as any).stealthBrowser = null;
      const mockBrowser = { connected: true, close: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined) } as unknown as Browser;
      jest.mocked(puppeteer.launch).mockClear();
      jest.mocked(puppeteer.launch).mockResolvedValue(mockBrowser);

      const browser = await BrowserPool.getStealthBrowser();

      expect(browser).toBe(mockBrowser);
      expect(puppeteer.launch).toHaveBeenCalledTimes(1);
      expect(jest.mocked(puppeteer.launch).mock.calls[0][0]).toEqual(buildBrowserConfig(process.env));
    } finally {
      (BrowserPool as any).stealthBrowser = null;
      if (nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = nodeEnv;
      if (worker === undefined) delete process.env.JEST_WORKER_ID; else process.env.JEST_WORKER_ID = worker;
    }
  });

  it('reuses the singleton stealth browser instead of relaunching per call', async () => {
    await BrowserPool.reset();
    (BrowserPool as any).stealthBrowser = null;
    const mockBrowser = { connected: true, close: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined) } as unknown as Browser;
    jest.mocked(puppeteer.launch).mockClear();
    jest.mocked(puppeteer.launch).mockResolvedValue(mockBrowser);

    const first = await BrowserPool.getStealthBrowser();
    const second = await BrowserPool.getStealthBrowser();

    expect(first).toBe(second);
    expect(puppeteer.launch).toHaveBeenCalledTimes(1);
    (BrowserPool as any).stealthBrowser = null;
  });
});

/**
 * The challenge-lane browser is long-lived BY DESIGN — which means nothing else ever closes it.
 * `closeAll` is the shutdown path (SIGTERM/SIGINT), so it must take that browser down too, or the
 * process hangs on an open Chrome after every deploy.
 */
describe('challenge-lane browser shutdown', () => {
  it('closeAll closes the challenge-lane browser and forgets it', async () => {
    await BrowserPool.reset();
    (BrowserPool as any).stealthBrowser = null;
    const close = jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined);
    const mockBrowser = { connected: true, close } as unknown as Browser;
    jest.mocked(puppeteer.launch).mockClear();
    jest.mocked(puppeteer.launch).mockResolvedValue(mockBrowser);
    await BrowserPool.getStealthBrowser();

    await BrowserPool.closeAll();

    expect(close).toHaveBeenCalledTimes(1);
    expect((await BrowserPool.getHealth()).hasStealthBrowser).toBe(false);
  });
});
