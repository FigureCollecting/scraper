/**
 * ScrapingService adapter — generic page-fetch capability built on top of
 * the existing BrowserPool (pooled + stealth browser lifecycle management).
 * This adapter only navigates and returns raw HTML — extraction is the
 * plugin's job via its own ExtractionRuleset.
 */
import type { Browser, Page, HTTPResponse } from 'puppeteer';
import { BrowserPool } from '../genericScraper.js';
import { ScrapingService, ScrapePageOptions, ScrapePageResult, PageOptions, BrowserFetchOptions } from '@figurecollecting/scraper-plugin-contract';
import { CaptureSink, NoopCaptureSink, buildRawCapture } from '../captureSink.js';
import { sanitizeForLog } from '../../utils/security.js';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';
const NAV_TIMEOUT_MS = 20000;
const MAX_WAIT_TIME_MS = 10000;
const CHALLENGE_RECHECK_DELAY_MS = 1500;

// JSON-ish content types whose body must be read from the response, not page.content():
// Chrome wraps a navigated JSON document in a viewer DOM, so page.content() would return markup.
const JSON_CONTENT_TYPE = /\bjson\b/i;

function capWaitTime(waitTime?: number): number {
  if (!waitTime || waitTime < 0) return 0;
  return Math.min(waitTime, MAX_WAIT_TIME_MS);
}

/**
 * Build puppeteer setCookie params for a URL's registrable host from a name→value map, dropping
 * empty values. Shared by navigateAndCapture and browserFetchBody so cookie scoping is identical.
 */
function buildCookieParams(url: string, cookies: Record<string, string>): Parameters<Page['setCookie']> {
  const hostname = new URL(url).hostname;
  return Object.entries(cookies)
    .filter(([, value]) => value != null && value !== '')
    .map(([name, value]) => ({ name, value, domain: `.${hostname.replace(/^www\./, '')}`, path: '/' })) as Parameters<Page['setCookie']>;
}

/**
 * Fetch a URL's raw body through a managed Page: navigate (domcontentloaded), then return the RAW
 * JSON body for a JSON response (response.text(), bypassing Chrome's JSON-viewer DOM) or the
 * fully-rendered HTML (page.content()) otherwise. No capture sink — this is a plain body fetch;
 * `browserFetch` wraps it in the pooled `withPage` lifecycle.
 */
export async function browserFetchBody(
  page: Page,
  url: string,
  options: Omit<BrowserFetchOptions, 'stealth'> = {}
): Promise<string> {
  await page.setViewport({ width: 1280, height: 720 });
  await page.setUserAgent(options.userAgent || DEFAULT_USER_AGENT);

  if (options.headers && Object.keys(options.headers).length > 0) {
    await page.setExtraHTTPHeaders(options.headers);
  }
  if (options.cookies) {
    const cookieArray = buildCookieParams(url, options.cookies);
    if (cookieArray.length > 0) {
      await page.setCookie(...cookieArray);
    }
  }

  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  if (response) {
    const contentType = response.headers?.()?.['content-type'] ?? '';
    if (JSON_CONTENT_TYPE.test(contentType)) {
      return await response.text();
    }
  }
  return await page.content();
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
    const cookieArray = buildCookieParams(url, options.cookies);
    if (cookieArray.length > 0) {
      await page.setCookie(...cookieArray);
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
    // lgtm[js/log-injection] — url is caller-influenced; sanitize before logging
    console.warn(`[CAPTURE] sink failed for ${sanitizeForLog(url)}: ${err instanceof Error ? err.message : String(err)}`);
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
    const context = await BrowserPool.openContext(browser);

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
      // The browser is intentionally long-lived; the context is the per-request
      // unit. If it will not close cleanly it has leaked onto that browser, so
      // retire the browser rather than reuse it (paying the relaunch/Cloudflare
      // cost only on the rare failure). A clean close returns the pooled browser.
      const closedCleanly = await BrowserPool.closeContext(context);
      if (stealth) {
        if (!closedCleanly) await BrowserPool.retireStealthBrowser(browser);
      } else if (closedCleanly) {
        await BrowserPool.returnBrowser(browser);
      } else {
        await BrowserPool.retirePooledBrowser(browser);
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

    // browserFetch defaults to the stealth browser — it exists for CF-fronted / SPA hosts.
    browserFetch: (url: string, options?: BrowserFetchOptions) =>
      withPage(page => browserFetchBody(page, url, options), { stealth: options?.stealth ?? true }),

    withBrowser,
    withPage,
  };
}
