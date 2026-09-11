/**
 * ScrapingService adapter — generic page-fetch capability built on top of the existing BrowserPool
 * (pooled, stealth and per-egress GATED browser lifecycles). This adapter only navigates and returns
 * raw HTML — extraction is the plugin's job via its own ExtractionRuleset.
 *
 * The lane splits on ONE question: is this host challenge-gated? A gated fetch is a tab in the
 * long-lived browser for its egress, opened in that browser's DEFAULT context — measured 2026-09-07,
 * a `createBrowserContext` page never clears Cloudflare's JS challenge even with its traffic leaving
 * the correct residential IP, while a default-context tab clears in 8-9 s and every later tab reuses
 * the clearance. Everything else keeps the per-request context it has always had.
 *
 * The gated browser's other two requirements live outside this file: the residential proxy is a
 * LAUNCH argument on that browser (genericScraper), and the PROCESS timezone must not be UTC (the
 * container's TZ) — the challenge's cross-origin frame reads the process zone, so `emulateTimezone`
 * cannot stand in for it (browserTimezone).
 */
import type { Browser, Page, HTTPResponse } from 'puppeteer';
import { BrowserPool, isCleanHeadfulMode } from '../genericScraper.js';
import { clampNavTimeoutMs, resolveNavTimeoutMs } from '../browserNavTimeout.js';
import { ScrapingService, ScrapePageOptions, ScrapePageResult, PageOptions, BrowserFetchOptions, WaitForReadiness } from '@figurecollecting/scraper-plugin-contract';
import { CaptureSink, NoopCaptureSink, buildRawCapture } from '../captureSink.js';
import { sanitizeForLog } from '../../utils/security.js';
import { getCfCookieStore, type CfCookieSource } from '../cookieJar.js';
import { applyEgressTimezone } from '../browserTimezone.js';
import {
  ChallengeLaneUnavailableError,
  awaitChallengeClearance,
  awaitChallengeClearanceOutcome,
  type ChallengeOutcome,
  challengeHost,
  isChallengeGated,
  type ChallengeAwarePage,
  type ChallengeCookie,
} from '../browserChallenge.js';
import {
  gatedHostKey,
  getHostConcurrency,
  type EgressKind,
  type GatedBrowserEntry,
  type GatedBrowserProof,
} from '../gatedBrowsers.js';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';
/**
 * The lane's navigation budget, resolved ONCE at module load (`BROWSER_NAV_TIMEOUT_MS`, default
 * 20 s, clamped) — one warning here rather than one per navigation. A store's own `navTimeoutMs`
 * overrides it per fetch; see resolveNavTimeout.
 */
const NAV_TIMEOUT_MS = resolveNavTimeoutMs(process.env);

/**
 * The budget for ONE navigation: a store's declared `navTimeoutMs` clamped to the same range as the
 * environment value, or the process budget when it declares none (or declares something unusable —
 * a bad declaration must not be sharper than the default it replaced).
 */
function resolveNavTimeout(override: number | undefined): number {
  if (override === undefined) return NAV_TIMEOUT_MS;
  return Number.isFinite(override) && override > 0 ? clampNavTimeoutMs(override) : NAV_TIMEOUT_MS;
}
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
  /** Per-store navigation budget (ms) — `SearchFetch.navTimeoutMs`, clamped to [5000, 120000]. */
  navTimeoutMs?: number;
  challengeGated?: boolean;
  primeUrl?: string;
}

export interface EngineBrowserFetchOptions extends BrowserFetchOptions {
  proxyServer?: string;
  waitFor?: WaitForReadiness;
  /** Per-store navigation budget (ms) — `SearchFetch.navTimeoutMs`, clamped to [5000, 120000]. */
  navTimeoutMs?: number;
  challengeGated?: boolean;
  primeUrl?: string;
}

export interface EnginePageOptions extends PageOptions {
  proxyServer?: string;
  /** The URL about to be fetched — the per-host key for a persistent (challenge-gated) context. */
  targetUrl?: string;
  /** The store declares a challenge gate (`access: 'cloudflare'`): fetch it on the gated browser. */
  challengeGated?: boolean;
  /** Session prime (`SearchFetch.sessionPrime`): navigate here first, once per gated browser. */
  primeUrl?: string;
  /** Per-store navigation budget (ms) — applies to the PRIME navigation made inside `withPage`. */
  navTimeoutMs?: number;
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
export function buildCookieParams(url: string, cookies: Record<string, string>): Parameters<Page['setCookie']> {
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
 * The jar cookie a clean-headful Chrome must never replay. Cloudflare binds a `cf_clearance` to the
 * (IP, user agent) that EARNED it; every stored one was minted out-of-band by another client, from
 * another exit. Presenting it from this browser is a contradiction the challenge can see, and it
 * buys nothing — this browser earns its own clearance in-context.
 */
const IP_BOUND_STORED_COOKIE = /^cf_clearance$/i;

/**
 * The jar's cookies MINUS the ones this launch profile must not replay: in clean-headful mode a
 * stored `cf_clearance` is dropped (see IP_BOUND_STORED_COOKIE); session cookies (the MFC set) still
 * pass through, and the headless profile is unchanged. Everything dropped ⇒ undefined, so a host
 * whose only stored cookie was the clearance makes no `setCookie` call at all.
 */
function usableStoredCookies(stored: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!stored || !isCleanHeadfulMode()) return stored;
  const usable = Object.fromEntries(Object.entries(stored).filter(([name]) => !IP_BOUND_STORED_COOKIE.test(name)));
  return Object.keys(usable).length > 0 ? usable : undefined;
}

/**
 * STORED COOKIES (CfCookieStore) merged UNDER the request's own: a host the store has cookies for
 * contributes them, and a request/item cookie of the same name WINS (a request-scoped session — the
 * MFC user-sync path — carries its own coherent set). Neither ⇒ undefined (no setCookie call at all,
 * byte-identical to the pre-store behavior).
 */
export function mergeStoredCookies(
  store: CfCookieSource,
  url: string,
  requestCookies: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const stored = usableStoredCookies(store.cookiesFor(url));
  if (!stored && !requestCookies) return undefined;
  return { ...(stored ?? {}), ...(requestCookies ?? {}) };
}

/**
 * UA precedence on the browser lane: the REQUEST's own UA always wins (a store declaring one means
 * it). Below that the two profiles diverge:
 *   - headless (default)    — the host's pinned mint UA (a stored `cf_clearance` is only valid for
 *                             the UA it was minted with), else the engine default. Unchanged.
 *   - clean-headful         — NOTHING. Don't touch the real Chrome's UA: the jar's pinned UA is the
 *                             MINT client's, sent from another exit, and this browser no longer
 *                             replays that clearance (see usableStoredCookies). Rewriting a Chrome
 *                             152's UA contradicts the client hints the same browser sends, and
 *                             Cloudflare binds the clearance it issues to the UA that earned it.
 */
export function resolveUserAgent(store: CfCookieSource, url: string, requestUa: string | undefined): string | undefined {
  if (requestUa) return requestUa;
  if (isCleanHeadfulMode()) return undefined;
  return store.userAgentFor(url) || DEFAULT_USER_AGENT;
}

/**
 * The default 1280x720 device-metrics override, applied only in the headless profile. Clean-headful
 * Chrome already opens a 1280x900 window (`--window-size`); overriding its metrics on top of that is
 * a mismatch the challenge can see, and buys nothing.
 */
async function applyDefaultViewport(page: Page): Promise<void> {
  if (isCleanHeadfulMode()) return;
  await page.setViewport({ width: 1280, height: 720 });
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
  await applyDefaultViewport(page);
  const userAgent = resolveUserAgent(store, url, options.userAgent);
  if (userAgent) await page.setUserAgent(userAgent);

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
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: resolveNavTimeout(options.navTimeoutMs) });
    // CHALLENGE: `domcontentloaded` fires on the Cloudflare interstitial too. Wait (bounded) for the
    // clean-headful browser to clear it, so the body below is the store's document and not "Just a
    // moment" — and so the host is marked gated, moving its later fetches onto the gated browser.
    recordChallengeOutcome(page, await awaitChallengeClearanceOutcome(challengeAwarePage(page), response, url));
    // READINESS: a client-rendered storefront has only its app shell at domcontentloaded — wait for
    // the declared selector / network idle before reading the body. Undeclared ⇒ no wait.
    await applyWaitFor(page, url, options.waitFor);
    return await readMainBody(page, documents.get() ?? response);
  } finally {
    documents.stop();
  }
}

/**
 * How the LAST challenge wait on a given page ended.
 *
 * Keyed by the page rather than kept in a module variable because gated fetches run concurrently —
 * two tabs for two hosts are in flight at once, and a single "last outcome" would hand one host's
 * verdict to the other. A WeakMap also means a closed tab's entry disappears with the tab.
 *
 * The navigation functions (`browserFetchBody`, `navigateAndCapture`) are opaque to the gated runner
 * that wraps them: it hands them a page and gets a result back, with no room in the signature for
 * "and by the way, the challenge never cleared". This is that channel.
 */
const challengeOutcomes = new WeakMap<object, ChallengeOutcome>();

/** Record how this page's challenge wait ended. */
function recordChallengeOutcome(page: object, outcome: ChallengeOutcome): void {
  challengeOutcomes.set(page, outcome);
}

/**
 * Read and clear this page's recorded outcome. Cleared on read so a page that is reused for a second
 * navigation cannot answer with the first one's verdict; an unrecorded page reads as `'none'`, which
 * is the honest answer for a fetch that never reached a challenge wait.
 */
function takeChallengeOutcome(page: object): ChallengeOutcome {
  const outcome = challengeOutcomes.get(page) ?? 'none';
  challengeOutcomes.delete(page);
  return outcome;
}

/**
 * The cookie read for a page, or `undefined` when this page surface cannot answer one (mocks, and
 * pages whose browser has already gone). The jar asked for is the one the page RUNS IN: a gated tab
 * lives in the browser's default context, an ephemeral fetch in its own `createBrowserContext`, and
 * a Cloudflare clearance lives in whichever of them earned it.
 */
function pageCookieJar(page: Page): (() => Promise<ChallengeCookie[]>) | undefined {
  type Jar = { cookies?: () => Promise<ChallengeCookie[]> };
  const loose = page as unknown as {
    browserContext?: () => Jar | undefined;
    browser?: () => Jar | undefined;
    cookies?: () => Promise<ChallengeCookie[]>;
  };
  const owner = (get: (() => Jar | undefined) | undefined): Jar | undefined => {
    if (typeof get !== 'function') return undefined;
    try {
      return get();
    } catch {
      return undefined;
    }
  };
  const context = owner(loose.browserContext);
  if (context && typeof context.cookies === 'function') return () => context.cookies!();
  // puppeteer 25 reads the DEFAULT context's jar off the browser; a page in a created context is
  // covered above, so this is the gated tab's own path when `browserContext` is unavailable.
  const browser = owner(loose.browser);
  if (browser && typeof browser.cookies === 'function') return () => browser.cookies!();
  if (typeof loose.cookies === 'function') return () => loose.cookies!();
  return undefined;
}

/**
 * The puppeteer Page as the challenge wait sees it: `title`/`evaluate` pass straight through, plus
 * the two signals that separate "the challenge finished" from "the interstitial is mid-round-trip" —
 * the page's current URL, and its cookie jar. The wait leaves on the `cf_clearance` cookie, so
 * without this wrapper it has no evidence to leave on (see browserChallenge).
 */
function challengeAwarePage(page: Page): ChallengeAwarePage {
  const wrapper: ChallengeAwarePage = { title: () => page.title() };
  if (typeof page.evaluate === 'function') {
    wrapper.evaluate = (pageFunction: () => any) => page.evaluate(pageFunction as any) as Promise<unknown>;
  }
  if (typeof page.url === 'function') wrapper.url = () => page.url();
  const jar = pageCookieJar(page);
  if (jar) wrapper.cookies = jar;
  return wrapper;
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
  await applyDefaultViewport(page);
  const userAgent = resolveUserAgent(store, url, options.userAgent);
  if (userAgent) await page.setUserAgent(userAgent);

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
    response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: resolveNavTimeout(options.navTimeoutMs) });

    // CHALLENGE: wait out a Cloudflare interstitial before either lane is read (see browserChallenge).
    recordChallengeOutcome(page, await awaitChallengeClearanceOutcome(challengeAwarePage(page), response, url));

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
  // What the response says it came FROM, which after a redirect is not what we asked for. The sink
  // has always been given the requested url as its fallback (a capture must be attributable either
  // way); the RESULT carries only the real thing, so a reader can tell "ended elsewhere" from
  // "nothing was reported" — see ScrapePageResult.finalUrl.
  const servedUrl = served?.url?.();
  const finalUrl = servedUrl ?? url;
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
    ...(servedUrl ? { finalUrl: servedUrl } : {}),
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
  /** Page setup shared by both lifecycles: egress timezone first, then the caller's overrides. */
  async function preparePage(page: Page, options: EnginePageOptions): Promise<void> {
    // TIMEZONE, optional and cosmetic: what actually decides a challenge is the PROCESS zone (the
    // container's TZ), because the challenge's cross-origin frame reads that, not this page's CDP
    // override — measured 2026-09-07: a UTC process never clears no matter what the page emulates,
    // and a non-UTC process clears with or without an override. So this only aligns what the page
    // itself reports with the exit it leaves through. Nothing configured ⇒ no CDP call (the default).
    await applyEgressTimezone(page, Boolean(options.proxyServer));
    if (options.viewport) {
      await page.setViewport(options.viewport);
    }
    if (options.userAgent) {
      await page.setUserAgent(options.userAgent);
    }
  }

  /**
   * Run one fetch as a TAB in the gated browser for this egress: a new page in its DEFAULT context,
   * the session prime if this host has not been primed on THIS browser instance, then the fetch.
   * Only the tab is closed — the browser, and the clearance its profile holds for every gated host,
   * outlives the request.
   *
   * A `createBrowserContext` page is deliberately NOT used here: measured 2026-09-07 through the
   * residential exit, such a page never clears the challenge (the traffic leaves the right IP; the
   * interstitial simply stays), while a default-context tab clears in 8-9 s.
   */
  async function runOnGatedBrowser<T>(
    fn: (page: Page) => Promise<T>,
    options: EnginePageOptions,
    host: string,
    egress: EgressKind,
  ): Promise<T> {
    // Bound the tabs one host may hold BEFORE the browser is touched, so a slow store queues instead
    // of filling the shared browser with renderers.
    const slot = await getHostConcurrency().acquire(gatedHostKey(host, egress));
    let entry: GatedBrowserEntry | undefined;
    try {
      entry = await BrowserPool.getGatedBrowser(egress, options.proxyServer, gatedBrowserProof(options));
      // A fresh instance holds no clearance for any host, so the FIRST navigation for a host is the
      // one that has to earn one inline — and an interstitial that outlasts the clearance budget on
      // THAT navigation is the measured production defect (2026-09-11 00:39:41): the lane reports a
      // challenge page, the queue opens a 30-minute host cooldown, and every queued item for the
      // host is dropped, while the clearance lands moments later and the same instance serves the
      // host for the rest of its life. So the first navigation gets ONE retry before that verdict
      // stands. It is bounded to once per (instance, host) — at most one extra request per host per
      // browser lifetime — so a store that is genuinely hard-blocking is not hammered.
      const firstOnInstance = !entry.navigatedHosts.has(host);
      try {
        const attempt = await runGatedAttempt(fn, options, entry, host, egress);
        if (!firstOnInstance || attempt.outcome !== 'unresolved') return attempt.value;

        const retry = await runGatedAttempt(fn, options, entry, host, egress);
        const recovered = retry.outcome !== 'unresolved';
        BrowserPool.recordGatedFirstNavigationRetry(egress, recovered);
        // eslint-disable-next-line no-console
        // lgtm[js/log-injection] — host is caller-influenced; sanitize before logging
        console.warn(
          `[GATED] first navigation for ${sanitizeForLog(host)} on the fresh ${egress} browser did not clear — ` +
          `retried once, ${recovered ? 'cleared' : 'still challenged'}`,
        );
        return retry.value;
      } finally {
        // Recorded whichever way it went: the grace is a ONE-SHOT per (instance, host), not a
        // standing licence to double every failing fetch.
        entry.navigatedHosts.add(host);
      }
    } finally {
      slot();
    }
  }

  /**
   * One attempt on the gated browser: a fresh tab in its default context, the session prime if this
   * host has not been primed on THIS instance, the fetch, then the tab. Reports how the navigation's
   * challenge wait ended so the caller can decide whether the attempt deserves a second go.
   */
  async function runGatedAttempt<T>(
    fn: (page: Page) => Promise<T>,
    options: EnginePageOptions,
    entry: GatedBrowserEntry,
    host: string,
    egress: EgressKind,
  ): Promise<{ value: T; outcome: ChallengeOutcome }> {
    let page: Page | undefined;
    try {
      page = await BrowserPool.openGatedPage(entry);
      await preparePage(page, options);
      // SESSION PRIME on a cold profile: anitoys' search results 404 without a same-session homepage
      // visit, so the origin root is navigated once per (browser instance, host), before the target.
      if (options.primeUrl && !entry.primedHosts.has(host)) {
        const primed = await page.goto(options.primeUrl, { waitUntil: 'domcontentloaded', timeout: resolveNavTimeout(options.navTimeoutMs) });
        // The PRIME is the navigation that meets the challenge — `domcontentloaded` fires on the
        // interstitial, and navigating to the target without waiting CANCELS the challenge script:
        // the homepage never loads and the cookie the prime exists for is never set.
        await awaitChallengeClearance(challengeAwarePage(page), primed, options.primeUrl);
        // Keyed by the URL that primed it, because a RELAUNCH must re-prove this host on the
        // replacement browser and has no other way to learn where to navigate.
        entry.primedHosts.set(host, options.primeUrl);
      }
      // ONE line per gated fetch — the lane is invisible from outside the pod otherwise, and its
      // failure mode (a fetch quietly taking the per-request context instead) looks identical to a
      // working one in the logs. Names the egress the tab left through, the host, whether THIS
      // browser instance already holds a primed session for it, and how many tabs it is carrying.
      // eslint-disable-next-line no-console
      // lgtm[js/log-injection] — host is caller-influenced; sanitize before logging
      console.log(
        `[GATED] ${egress} tab for ${sanitizeForLog(host)} ` +
        `(primed=${entry.primedHosts.has(host)}, tabs=${entry.pagesOpen})`,
      );
      const value = await fn(page);
      return { value, outcome: takeChallengeOutcome(page) };
    } finally {
      if (page) {
        const closedCleanly = await BrowserPool.closeGatedPage(entry, page);
        // A tab that will not close is a live renderer on a browser that outlives every request — the
        // leak shape that once climbed to ~25 GB. Retire the whole browser and pay one round of
        // re-challenges rather than keep opening tabs on it.
        if (!closedCleanly) await BrowserPool.retireGatedBrowser(entry);
      }
    }
  }

  /**
   * The proof a RELAUNCH runs before its replacement may carry traffic: navigate a tab of the NEW
   * browser to a host's prime URL and report whether the challenge cleared. Built here rather than in
   * the pool because the clearance wait belongs with the navigation code — the pool launches Chrome,
   * it does not know how to tell a cleared challenge from an interstitial.
   */
  function gatedBrowserProof(options: EnginePageOptions): GatedBrowserProof {
    return async (browser, _host, primeUrl) => {
      let page: Page | undefined;
      try {
        page = await browser.newPage();
        // The same page preparation a real fetch gets: the challenge reads the profile, so a proof
        // run on a differently-shaped page proves nothing about the fetches that follow it.
        await preparePage(page, options);
        const primed = await page.goto(primeUrl, { waitUntil: 'domcontentloaded', timeout: resolveNavTimeout(options.navTimeoutMs) });
        return (await awaitChallengeClearanceOutcome(challengeAwarePage(page), primed, primeUrl)) !== 'unresolved';
      } catch {
        return false;
      } finally {
        if (page) await page.close().catch(() => undefined);
      }
    };
  }

  /**
   * Run one fetch on a browser page.
   *
   * Two lifecycles share this door:
   *   - EPHEMERAL (the default): a fresh `createBrowserContext` per request on a pooled (or the
   *     stealth) browser, closed with the request. Unchanged for every store that is not gated —
   *     those pass the challenge-free web perfectly well, and the context is what bounds them.
   *   - GATED: a challenge-gated host (declared `access: 'cloudflare'`, or LEARNED from a
   *     `cf-mitigated: challenge` response on an earlier fetch) is fetched as a tab in the
   *     long-lived browser for its egress, whose default context holds the clearance.
   */
  async function withPage<T>(fn: (page: Page) => Promise<T>, options: EnginePageOptions = {}): Promise<T> {
    const stealth = options.stealth ?? false;
    const egress: EgressKind = options.proxyServer ? 'residential' : 'direct';
    const host = options.targetUrl ? challengeHost(options.targetUrl) : undefined;

    // A DECLARED gate needs the profile that can actually clear a challenge. Refuse rather than
    // attempt: the headless profile fails silently (it never leaves the interstitial) and every
    // attempt still costs the egress IP Cloudflare reputation. Learned gates are not refused.
    if (options.challengeGated === true && !isCleanHeadfulMode()) {
      throw new ChallengeLaneUnavailableError(options.targetUrl ?? '');
    }

    if (host && (options.challengeGated === true || isChallengeGated(host))) {
      return await runOnGatedBrowser(fn, options, host, egress);
    }

    const browser: Browser = stealth ? await BrowserPool.getStealthBrowser() : await BrowserPool.getBrowser();
    // RESIDENTIAL EGRESS on the ungated path: bind the per-request context (not the browser) to the
    // proxy, so only the declaring store's navigations leave through it. Gated fetches cannot use
    // this — their browser carries the proxy at launch instead (see runOnGatedBrowser).
    const context = await BrowserPool.openContext(browser, options.proxyServer ? { proxyServer: options.proxyServer } : {});

    let page: Page | undefined;
    try {
      page = await context.newPage();
      await preparePage(page, options);
      if (options.primeUrl) {
        // Same rule as the gated prime above: wait the interstitial out, or the target navigation
        // cancels it and the priming visit never happened.
        const primed = await page.goto(options.primeUrl, { waitUntil: 'domcontentloaded', timeout: resolveNavTimeout(options.navTimeoutMs) });
        await awaitChallengeClearance(challengeAwarePage(page), primed, options.primeUrl);
      }
      return await fn(page);
    } finally {
      // The browser is intentionally long-lived; the context is the per-request unit. If it will not
      // close cleanly it has leaked onto that browser, so retire the browser rather than reuse it
      // (paying the relaunch cost only on the rare failure). A clean close returns the pooled browser.
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

  /** The per-request page options every entry point derives from the caller's fetch options. */
  const laneOptions = (
    url: string,
    fetchOptions: { proxyServer?: string; challengeGated?: boolean; primeUrl?: string; navTimeoutMs?: number } | undefined,
  ): Omit<EnginePageOptions, 'stealth'> => ({
    targetUrl: url,
    ...(fetchOptions?.proxyServer ? { proxyServer: fetchOptions.proxyServer } : {}),
    ...(fetchOptions?.challengeGated ? { challengeGated: true } : {}),
    ...(fetchOptions?.primeUrl ? { primeUrl: fetchOptions.primeUrl } : {}),
    // The PRIME navigation happens inside withPage, so the store's budget has to travel with the
    // page options too — not only with the fetch options the target navigation reads.
    ...(fetchOptions?.navTimeoutMs !== undefined ? { navTimeoutMs: fetchOptions.navTimeoutMs } : {}),
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
