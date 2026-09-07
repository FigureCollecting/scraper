/**
 * ScrapingService adapter — generic page-fetch capability built on top of
 * the existing BrowserPool (pooled + stealth browser lifecycle management).
 * This adapter only navigates and returns raw HTML — extraction is the
 * plugin's job via its own ExtractionRuleset.
 */
import type { Browser, Page, HTTPResponse } from 'puppeteer';
import { BrowserPool } from '../genericScraper.js';
import { ScrapingService, ScrapePageOptions, ScrapePageResult, PageOptions, BrowserFetchOptions, WaitForReadiness } from '@figurecollecting/scraper-plugin-contract';
import { CaptureSink, NoopCaptureSink, buildRawCapture } from '../captureSink.js';
import { sanitizeForLog } from '../../utils/security.js';
import { getCfCookieStore, type CfCookieSource } from '../cookieJar.js';
import { applyEgressTimezone } from '../browserTimezone.js';
import { awaitChallengeClearance, challengeHost, isChallengeGated } from '../browserChallenge.js';
import {
  getPersistentContexts,
  persistentContextKey,
  type EgressKind,
  type PersistentContextCache,
  type PersistentContextEntry,
} from '../persistentContexts.js';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';
const NAV_TIMEOUT_MS = 20000;
const MAX_WAIT_TIME_MS = 10000;
const CHALLENGE_RECHECK_DELAY_MS = 1500;

/** Readiness budget (SearchFetch.waitFor.timeoutMs) when the store declares none, and its clamp. */
const DEFAULT_WAIT_FOR_TIMEOUT_MS = 15000;
const MIN_WAIT_FOR_TIMEOUT_MS = 1000;
const MAX_WAIT_FOR_TIMEOUT_MS = 60000;

/**
 * The engine's own browser-lane options: the contract's per-request shapes plus the two the
 * dispatchers resolve from the store's `searchFetch` — `proxyServer` (residential egress: bind this
 * request's context to the proxy) and `waitFor` (client-rendered readiness). Kept engine-side
 * because they are engine WIRING, not something a plugin passes per call; the returned service is
 * still a contract `ScrapingService` for every existing caller.
 */
export interface EngineScrapePageOptions extends ScrapePageOptions {
  proxyServer?: string;
  waitFor?: WaitForReadiness;
  challengeGated?: boolean;
  primeUrl?: string;
}

export interface EngineBrowserFetchOptions extends BrowserFetchOptions {
  proxyServer?: string;
  waitFor?: WaitForReadiness;
  challengeGated?: boolean;
  primeUrl?: string;
}

export interface EnginePageOptions extends PageOptions {
  proxyServer?: string;
  /** The URL about to be fetched — the per-host key for a persistent (challenge-gated) context. */
  targetUrl?: string;
  /** The store declares a challenge gate (`access: 'cloudflare'`): keep this host's context alive. */
  challengeGated?: boolean;
  /** Session prime (`SearchFetch.sessionPrime`): navigate here once, on a fresh context, first. */
  primeUrl?: string;
}

/** The contract ScrapingService, widened to accept the engine's egress/readiness wiring. */
export interface EngineScrapingService extends ScrapingService {
  scrapePage(url: string, options?: EngineScrapePageOptions): Promise<ScrapePageResult>;
  scrapePageStealth(url: string, options?: EngineScrapePageOptions): Promise<ScrapePageResult>;
  browserFetch(url: string, options?: EngineBrowserFetchOptions): Promise<string>;
}

/** Resolve the readiness budget: the store's `timeoutMs` clamped to [1000, 60000], else 15000. */
function resolveWaitForTimeoutMs(timeoutMs?: number): number {
  if (!Number.isFinite(timeoutMs) || (timeoutMs as number) <= 0) return DEFAULT_WAIT_FOR_TIMEOUT_MS;
  return Math.min(MAX_WAIT_FOR_TIMEOUT_MS, Math.max(MIN_WAIT_FOR_TIMEOUT_MS, timeoutMs as number));
}

/**
 * Wait for a client-rendered storefront to actually render before the body is read: the declared
 * selector and/or network idle, both bounded by one budget. A store that declares nothing waits
 * nothing (the pre-0.7.0 `domcontentloaded` behavior, byte-identical). A wait that TIMES OUT is a
 * degraded capture, not a failure — whatever rendered is returned and ONE warning is logged, so a
 * slow store yields a partial page instead of a thrown scrape and a retry storm.
 */
async function applyWaitFor(page: Page, url: string, waitFor: WaitForReadiness | undefined): Promise<void> {
  if (!waitFor || (!waitFor.selector && !waitFor.networkIdle)) return;
  const timeout = resolveWaitForTimeoutMs(waitFor.timeoutMs);
  try {
    if (waitFor.selector) await page.waitForSelector(waitFor.selector, { timeout });
    if (waitFor.networkIdle) await page.waitForNetworkIdle({ timeout });
  } catch (err) {
    // eslint-disable-next-line no-console
    // lgtm[js/log-injection] — url is caller-influenced; sanitize before logging
    console.warn(`[WAITFOR] readiness wait timed out for ${sanitizeForLog(url)} after ${timeout}ms — capturing whatever rendered: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// JSON-ish content types whose body must be read from the response, not page.content():
// Chrome wraps a navigated JSON document in a viewer DOM, so page.content() would return markup.
const JSON_CONTENT_TYPE = /\bjson\b/i;

/**
 * Watch for the LAST main-frame document response of a navigation. The response `goto` resolves
 * with is the FIRST one — after a Cloudflare interstitial (or any redirect chain) that is the 403
 * challenge, not the document that was actually served, so its status and content type describe the
 * wrong page. Every lane reads its body off the final one instead.
 */
function trackFinalDocumentResponse(page: Page): { get(): HTTPResponse | undefined; stop(): void } {
  let last: HTTPResponse | undefined;
  const onResponse = (response: HTTPResponse): void => {
    try {
      if (response.request().resourceType() === 'document' && response.frame() === page.mainFrame()) {
        last = response;
      }
    } catch {
      /* a response that can no longer describe itself is not the one we want anyway */
    }
  };
  page.on('response', onResponse);
  return { get: () => last, stop: () => page.off('response', onResponse) };
}

/**
 * The body a fetch RETURNS: the raw response bytes for a JSON document (Chrome would otherwise hand
 * back its JSON-viewer markup), else the rendered DOM. A JSON body the browser has already discarded
 * falls back to the viewer's own text — which is the same JSON — before giving up on `page.content()`.
 */
async function readMainBody(page: Page, response: HTTPResponse | null | undefined): Promise<string> {
  const contentType = response?.headers?.()?.['content-type'] ?? '';
  if (response && JSON_CONTENT_TYPE.test(contentType)) {
    const text = await response.text().catch(() => '');
    if (text.trim() !== '') return text;
    const innerText = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
    if (typeof innerText === 'string' && innerText.trim() !== '') return innerText;
  }
  return await page.content();
}

function capWaitTime(waitTime?: number): number {
  if (!waitTime || waitTime < 0) return 0;
  return Math.min(waitTime, MAX_WAIT_TIME_MS);
}

/**
 * Build puppeteer setCookie params for a URL's registrable host from a name→value map, dropping
 * empty values. Shared by navigateAndCapture and browserFetchBody so cookie scoping is identical.
 * Every cookie is emitted `httpOnly` (cf_clearance and the MFC session cookies are HttpOnly at the
 * origin — the page's own scripts must not see them) and `secure` iff the url is https (a Secure
 * cookie is never sent over plain http, so flagging it there would silently drop it).
 */
function buildCookieParams(url: string, cookies: Record<string, string>): Parameters<Page['setCookie']> {
  const target = new URL(url);
  const secure = target.protocol === 'https:';
  return Object.entries(cookies)
    .filter(([, value]) => value != null && value !== '')
    .map(([name, value]) => ({
      name,
      value,
      domain: `.${target.hostname.replace(/^www\./, '')}`,
      path: '/',
      httpOnly: true,
      secure,
    })) as Parameters<Page['setCookie']>;
}

/**
 * STORED COOKIES (CfCookieStore) merged UNDER the request's own: a host the store has cookies for
 * contributes them, and a request/item cookie of the same name WINS (a request-scoped session — the
 * MFC user-sync path — carries its own coherent set). Neither ⇒ undefined (no setCookie call at all,
 * byte-identical to the pre-store behavior).
 */
function mergeStoredCookies(
  store: CfCookieSource,
  url: string,
  requestCookies: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const stored = store.cookiesFor(url);
  if (!stored && !requestCookies) return undefined;
  return { ...(stored ?? {}), ...(requestCookies ?? {}) };
}

/** UA precedence on the browser lane: the request's own UA, else the host's pinned mint UA, else the default. */
function resolveUserAgent(store: CfCookieSource, url: string, requestUa: string | undefined): string {
  return requestUa || store.userAgentFor(url) || DEFAULT_USER_AGENT;
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
  options: Omit<EngineBrowserFetchOptions, 'stealth'> = {},
  store: CfCookieSource = getCfCookieStore(),
): Promise<string> {
  await page.setViewport({ width: 1280, height: 720 });
  await page.setUserAgent(resolveUserAgent(store, url, options.userAgent));

  if (options.headers && Object.keys(options.headers).length > 0) {
    await page.setExtraHTTPHeaders(options.headers);
  }
  const cookies = mergeStoredCookies(store, url, options.cookies);
  if (cookies) {
    const cookieArray = buildCookieParams(url, cookies);
    if (cookieArray.length > 0) {
      await page.setCookie(...cookieArray);
    }
  }

  const documents = trackFinalDocumentResponse(page);
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    // CHALLENGE: `domcontentloaded` fires on the Cloudflare interstitial too. Wait (bounded) for the
    // clean-headful browser to clear it, so the body below is the store's document and not "Just a
    // moment" — and so the host is marked gated, keeping this context alive for the clearance window.
    await awaitChallengeClearance(page, response, url);
    // READINESS: a client-rendered storefront has only its app shell at domcontentloaded — wait for
    // the declared selector / network idle before reading the body. Undeclared ⇒ no wait.
    await applyWaitFor(page, url, options.waitFor);
    return await readMainBody(page, documents.get() ?? response);
  } finally {
    documents.stop();
  }
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
  options: EngineScrapePageOptions = {},
  sink: CaptureSink = new NoopCaptureSink(),
  store: CfCookieSource = getCfCookieStore(),
): Promise<ScrapePageResult> {
  await page.setViewport({ width: 1280, height: 720 });
  await page.setUserAgent(resolveUserAgent(store, url, options.userAgent));

  const cookies = mergeStoredCookies(store, url, options.cookies);
  if (cookies) {
    const cookieArray = buildCookieParams(url, cookies);
    if (cookieArray.length > 0) {
      await page.setCookie(...cookieArray);
    }
  }

  // WIRE lane: buffer the main-document response body as it arrives, before JS
  // runs. `.buffer()` must be called during the response event — after the
  // browser consumes it for rendering it may no longer be retrievable. A body
  // that is genuinely unavailable (e.g. a 3xx with no body) is skipped, not fatal.
  let wire: { bytes: Buffer; statusCode?: number; contentType?: string } | undefined;
  let finalResponse: HTTPResponse | undefined;
  const onResponse = async (resp: HTTPResponse): Promise<void> => {
    try {
      if (resp.request().resourceType() === 'document' && resp.frame() === page.mainFrame()) {
        // The LAST main-frame document is the one that was actually served (a challenge or redirect
        // makes goto's response describe a page nobody wanted). Recorded before the body read, so a
        // response whose bytes are gone still supplies the status and content type.
        finalResponse = resp;
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

    // CHALLENGE: wait out a Cloudflare interstitial before either lane is read (see browserChallenge).
    await awaitChallengeClearance(page, response, url);

    // READINESS (SearchFetch.waitFor): wait for the client-rendered product before the DOM lane is
    // read, so a PWA storefront captures the product page rather than its 8 KB app shell. This sits
    // INSIDE the response listener's window, so the wire lane still records the main document.
    await applyWaitFor(page, url, options.waitFor);

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

  const served = finalResponse ?? response;
  const servedContentType = served?.headers?.()?.['content-type'] ?? '';
  const domContentType = JSON_CONTENT_TYPE.test(servedContentType) ? servedContentType : 'text/html';
  // JSON PASSTHROUGH: a JSON API on this lane (sugotoys' Store API) returns its raw bytes — Chrome's
  // JSON viewer DOM is not a body any ruleset can parse.
  const html = await readMainBody(page, served);
  const title = await page.title();

  // Hand both lanes to the sink. Capturing must never break a scrape.
  const fetchedAt = new Date().toISOString();
  const finalUrl = served?.url?.() ?? url;
  try {
    if (wire) {
      await sink.capture(buildRawCapture({
        url, finalUrl, lane: 'wire', bytes: wire.bytes,
        statusCode: wire.statusCode, contentType: wire.contentType, fetchedAt,
      }));
    }
    await sink.capture(buildRawCapture({
      url, finalUrl, lane: 'dom', bytes: Buffer.from(html, 'utf8'),
      statusCode: served?.status(), contentType: domContentType, fetchedAt,
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
    statusCode: served?.status(),
  };
}

/** Optional wiring for {@link createScrapingService}. */
export interface ScrapingServiceOptions {
  /** Stored-cookie source (defaults to the CfCookieStore singleton, resolved per navigation). */
  cookieStore?: CfCookieSource;
}

export function createScrapingService(
  captureSink: CaptureSink = new NoopCaptureSink(),
  options: ScrapingServiceOptions = {},
): EngineScrapingService {
  // Resolved per navigation (not once here) so a hot-reloaded cookie file is always the one consulted.
  const store = (): CfCookieSource => options.cookieStore ?? getCfCookieStore();
  /** Close contexts the cache evicted, keeping the pool's leak counters honest. */
  async function closeEvicted(evicted: PersistentContextEntry[]): Promise<void> {
    for (const entry of evicted) {
      const closedCleanly = await BrowserPool.closeContext(entry.context);
      if (!closedCleanly) {
        // The context leaked onto the long-lived challenge-lane browser: retire it, and forget
        // every other context that lived on it (they died with it — there is nothing to close).
        getPersistentContexts().dropBrowser(entry.browser);
        await BrowserPool.retireStealthBrowser(entry.browser);
      }
    }
  }

  /** Page setup shared by both lifecycles: egress timezone first, then the caller's overrides. */
  async function preparePage(page: Page, options: EnginePageOptions): Promise<void> {
    // TIMEZONE follows the EGRESS, per page: the residential exit's zone for a proxied context,
    // the node's own for a direct one. Applied BEFORE any navigation — a challenge samples the
    // environment on its first script, and a zone that disagrees with the exit IP's geolocation
    // silently never clears. Nothing configured ⇒ no CDP call (CI/tests unchanged).
    await applyEgressTimezone(page, Boolean(options.proxyServer));
    if (options.viewport) {
      await page.setViewport(options.viewport);
    }
    if (options.userAgent) {
      await page.setUserAgent(options.userAgent);
    }
  }

  /**
   * Run one fetch on a KEPT context: a new page inside it, the session prime if this context has
   * not made one yet, then the fetch. Only the PAGE is closed — the context (and the clearance it
   * holds) outlives the request, bounded by the cache.
   */
  async function runOnPersistentContext<T>(
    entry: PersistentContextEntry,
    fn: (page: Page) => Promise<T>,
    options: EnginePageOptions,
    contexts: PersistentContextCache,
  ): Promise<T> {
    const page: Page = await entry.context.newPage();
    try {
      await preparePage(page, options);
      // SESSION PRIME on a fresh session: anitoys' search results 404 without a same-session
      // homepage visit, so the origin root is navigated once per context, before the target.
      if (options.primeUrl && !entry.primed) {
        await page.goto(options.primeUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
        entry.primed = true;
      }
      return await fn(page);
    } finally {
      await page.close().catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.warn(`[BROWSER LANE] failed to close a page on a kept context: ${err instanceof Error ? err.message : String(err)}`);
      });
      contexts.release(entry);
    }
  }

  /**
   * Run one fetch on a browser page.
   *
   * Two lifecycles share this door:
   *   - EPHEMERAL (the default): a fresh context per request, closed with the request. Byte-identical
   *     to the pre-persistence behavior for every store that is not challenge-gated.
   *   - PERSISTENT: a challenge-gated host (declared `access: 'cloudflare'`, or LEARNED from a
   *     `cf-mitigated: challenge` response on an earlier fetch) reuses one context per (host,
   *     egress) so its Cloudflare clearance is reused instead of re-earned. Those contexts live on
   *     the long-lived challenge-lane browser — never on a pooled one, which may be retired or
   *     closed under them — and are bounded by the cache (25 min age, 10 min idle, 6 contexts).
   * A fetch that DISCOVERS the gate mid-flight keeps its own context on the way out (that context
   * is the one holding the clearance it just earned), provided it ran on the challenge-lane browser.
   */
  async function withPage<T>(fn: (page: Page) => Promise<T>, options: EnginePageOptions = {}): Promise<T> {
    const stealth = options.stealth ?? false;
    const egress: EgressKind = options.proxyServer ? 'residential' : 'direct';
    const host = options.targetUrl ? challengeHost(options.targetUrl) : undefined;
    const key = host ? persistentContextKey(host, egress) : undefined;
    const contexts = getPersistentContexts();

    if (key && (options.challengeGated === true || isChallengeGated(host))) {
      const { entry, evicted } = contexts.acquire(key);
      await closeEvicted(evicted);
      if (entry) return await runOnPersistentContext(entry, fn, options, contexts);

      const browser = await BrowserPool.getStealthBrowser();
      const context = await BrowserPool.openContext(browser, options.proxyServer ? { proxyServer: options.proxyServer } : {});
      const stored = contexts.store(key, { browser, context, inUse: 1 });
      await closeEvicted(stored.evicted);
      return await runOnPersistentContext(stored.entry, fn, options, contexts);
    }

    const browser: Browser = stealth ? await BrowserPool.getStealthBrowser() : await BrowserPool.getBrowser();
    // RESIDENTIAL EGRESS: bind the per-request context (not the browser) to the proxy, so only the
    // declaring store's navigations leave through it. The context is closed in the finally below
    // exactly like a direct one — a proxied context is never leaked onto the pooled browser.
    const context = await BrowserPool.openContext(browser, options.proxyServer ? { proxyServer: options.proxyServer } : {});

    let page: Page | undefined;
    try {
      page = await context.newPage();
      await preparePage(page, options);
      if (options.primeUrl) {
        await page.goto(options.primeUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
      }
      return await fn(page);
    } finally {
      // A gate revealed DURING this fetch (cf-mitigated) means this context now holds a clearance.
      // Keep it — but only on the challenge-lane browser, which is never returned to the pool.
      if (key && stealth && isChallengeGated(host)) {
        if (page) {
          await page.close().catch(() => { /* the context outlives it; a stuck page is not fatal */ });
        }
        const retained = contexts.store(key, { browser, context, inUse: 0, primed: Boolean(options.primeUrl) });
        await closeEvicted(retained.evicted);
      } else {
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
  }

  async function withBrowser<T>(fn: (browser: Browser) => Promise<T>): Promise<T> {
    const browser = await BrowserPool.getBrowser();
    try {
      return await fn(browser);
    } finally {
      await BrowserPool.returnBrowser(browser);
    }
  }

  /** The per-request page options every entry point derives from the caller's fetch options. */
  const laneOptions = (
    url: string,
    fetchOptions: { proxyServer?: string; challengeGated?: boolean; primeUrl?: string } | undefined,
  ): Omit<EnginePageOptions, 'stealth'> => ({
    targetUrl: url,
    ...(fetchOptions?.proxyServer ? { proxyServer: fetchOptions.proxyServer } : {}),
    ...(fetchOptions?.challengeGated ? { challengeGated: true } : {}),
    ...(fetchOptions?.primeUrl ? { primeUrl: fetchOptions.primeUrl } : {}),
  });

  return {
    scrapePage: (url: string, options?: EngineScrapePageOptions) =>
      withPage(page => navigateAndCapture(page, url, options, captureSink, store()), { stealth: false, ...laneOptions(url, options) }),

    scrapePageStealth: (url: string, options?: EngineScrapePageOptions) =>
      withPage(page => navigateAndCapture(page, url, options, captureSink, store()), { stealth: true, ...laneOptions(url, options) }),

    // browserFetch defaults to the stealth browser — it exists for CF-fronted / SPA hosts.
    browserFetch: (url: string, options?: EngineBrowserFetchOptions) =>
      withPage(page => browserFetchBody(page, url, options, store()), { stealth: options?.stealth ?? true, ...laneOptions(url, options) }),

    withBrowser,
    withPage,
  };
}
