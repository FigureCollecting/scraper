/**
 * ScrapingService adapter — generic page-fetch capability built on top of
 * the existing BrowserPool (pooled + stealth browser lifecycle management).
 * This adapter only navigates and returns raw HTML — extraction is the
 * plugin's job via its own ExtractionRuleset.
 */
import type { Browser, Page, HTTPResponse } from 'puppeteer';
import { BrowserPool } from '../genericScraper.js';
import { ScrapingService, ScrapePageOptions, ScrapePageResult, PageOptions } from '@figurecollecting/scraper-plugin-contract';
import { CaptureSink, NoopCaptureSink, buildRawCapture } from '../captureSink.js';

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

async function navigateAndCapture(
  page: Page,
  url: string,
  options: ScrapePageOptions = {},
  sink: CaptureSink = new NoopCaptureSink()
): Promise<ScrapePageResult> {
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

  // WIRE lane: buffer the main-document response body as it arrives, before JS
  // runs. `.buffer()` must be called during the response event — after the
  // browser consumes it for rendering it may no longer be retrievable. A body
  // that is genuinely unavailable (e.g. a 3xx with no body) is skipped, not fatal.
  let wire: { bytes: Buffer; statusCode?: number; contentType?: string } | undefined;
  const onResponse = async (resp: HTTPResponse): Promise<void> => {
    try {
      if (resp.request().resourceType() === 'document' && resp.frame() === page.mainFrame()) {
        const bytes = await resp.buffer();
        wire = { bytes, statusCode: resp.status(), contentType: resp.headers()['content-type'] };
      }
    } catch {
      /* body unavailable — leave the wire lane unset for this fetch */
    }
  };
  page.on('response', onResponse);

  let response;
  try {
    response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });

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
  } finally {
    page.off('response', onResponse);
  }

  const html = await page.content();
  const title = await page.title();

  // Hand both lanes to the sink. Capturing must never break a scrape.
  const fetchedAt = new Date().toISOString();
  const finalUrl = response?.url?.() ?? url;
  try {
    if (wire) {
      await sink.capture(buildRawCapture({
        url, finalUrl, lane: 'wire', bytes: wire.bytes,
        statusCode: wire.statusCode, contentType: wire.contentType, fetchedAt,
      }));
    }
    await sink.capture(buildRawCapture({
      url, finalUrl, lane: 'dom', bytes: Buffer.from(html, 'utf8'),
      statusCode: response?.status(), contentType: 'text/html', fetchedAt,
    }));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[CAPTURE] sink failed for ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    html,
    url,
    title,
    statusCode: response?.status(),
  };
}

export function createScrapingService(captureSink: CaptureSink = new NoopCaptureSink()): ScrapingService {
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
      withPage(page => navigateAndCapture(page, url, options, captureSink), { stealth: false }),

    scrapePageStealth: (url: string, options?: ScrapePageOptions) =>
      withPage(page => navigateAndCapture(page, url, options, captureSink), { stealth: true }),

    withBrowser,
    withPage,
  };
}
