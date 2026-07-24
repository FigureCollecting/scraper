/**
 * ScrapingService adapter — generic page-fetch capability built on top of
 * the existing BrowserPool (pooled + stealth browser lifecycle management).
 * Deliberately does NOT reuse genericScraper.scrapeGeneric()/scrapeMFC(): those
 * bake in MFC-specific selectors and schema-v3 extraction. This adapter only
 * navigates and returns raw HTML — extraction is the plugin's job via its
 * own ExtractionRuleset.
 */
import type { Browser, Page } from 'puppeteer';
import { BrowserPool } from '../genericScraper.js';
import { ScrapingService, ScrapePageOptions, ScrapePageResult, PageOptions } from '@figurecollecting/scraper-plugin-contract';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';
const NAV_TIMEOUT_MS = 20000;
const MAX_WAIT_TIME_MS = 10000;
const CHALLENGE_RECHECK_DELAY_MS = 1500;

function capWaitTime(waitTime?: number): number {
  if (!waitTime || waitTime < 0) return 0;
  return Math.min(waitTime, MAX_WAIT_TIME_MS);
}

async function detectChallenge(
  page: Page,
  patterns: NonNullable<ScrapePageOptions['cloudflareDetection']>
): Promise<boolean> {
  const title = (await page.title()).toLowerCase();
  const bodyText = ((await page.evaluate(() => document.body.innerText)) as string).toLowerCase();

  const matchesAny = (list?: string[]) =>
    (list || []).some(pattern => {
      const needle = pattern.toLowerCase();
      return title.includes(needle) || bodyText.includes(needle);
    });

  return matchesAny(patterns.titleIncludes) || matchesAny(patterns.bodyIncludes);
}

async function navigateAndCapture(page: Page, url: string, options: ScrapePageOptions = {}): Promise<ScrapePageResult> {
  await page.setViewport({ width: 1280, height: 720 });
  await page.setUserAgent(options.userAgent || DEFAULT_USER_AGENT);

  if (options.cookies) {
    const hostname = new URL(url).hostname;
    const cookieArray = Object.entries(options.cookies)
      .filter(([, value]) => value != null && value !== '')
      .map(([name, value]) => ({ name, value, domain: `.${hostname.replace(/^www\./, '')}`, path: '/' }));
    if (cookieArray.length > 0) {
      await page.setCookie(...(cookieArray as Parameters<Page['setCookie']>));
    }
  }

  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });

  const waitTime = capWaitTime(options.waitTime);
  if (waitTime > 0) {
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }

  if (options.cloudflareDetection) {
    const challenged = await detectChallenge(page, options.cloudflareDetection);
    if (challenged) {
      // Single bounded re-check wait. Plugins needing more elaborate
      // challenge-clearing behavior can retry from their own workflow layer.
      await new Promise(resolve => setTimeout(resolve, CHALLENGE_RECHECK_DELAY_MS));
    }
  }

  const html = await page.content();
  const title = await page.title();

  return {
    html,
    url,
    title,
    statusCode: response?.status(),
  };
}

export function createScrapingService(): ScrapingService {
  async function withPage<T>(fn: (page: Page) => Promise<T>, options: PageOptions = {}): Promise<T> {
    const stealth = options.stealth ?? false;
    const browser: Browser = stealth ? await BrowserPool.getStealthBrowser() : await BrowserPool.getBrowser();
    const context = await browser.createBrowserContext();

    try {
      const page: Page = await context.newPage();
      if (options.viewport) {
        await page.setViewport(options.viewport);
      }
      if (options.userAgent) {
        await page.setUserAgent(options.userAgent);
      }
      return await fn(page);
    } finally {
      await context.close().catch(() => {});
      if (!stealth) {
        await BrowserPool.returnBrowser(browser);
      }
    }
  }

  async function withBrowser<T>(fn: (browser: Browser) => Promise<T>): Promise<T> {
    const browser = await BrowserPool.getBrowser();
    try {
      return await fn(browser);
    } finally {
      await BrowserPool.returnBrowser(browser);
    }
  }

  return {
    scrapePage: (url: string, options?: ScrapePageOptions) =>
      withPage(page => navigateAndCapture(page, url, options), { stealth: false }),

    scrapePageStealth: (url: string, options?: ScrapePageOptions) =>
      withPage(page => navigateAndCapture(page, url, options), { stealth: true }),

    withBrowser,
    withPage,
  };
}
