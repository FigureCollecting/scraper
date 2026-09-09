/**
 * gatedTabBytesFetch — the browser image BYTES lane: a TAB of the per-egress gated browser navigated
 * straight at the image URL.
 *
 * It exists for the cohort whose image host sits behind the same Cloudflare gate as its store: no
 * amount of TLS impersonation clears that, but the browser holding the store's clearance already
 * has. The lane does not restate the page lane's recipe — it goes through the very same door
 * (`withPage` with `challengeGated: true`), which is what puts the fetch on the long-lived browser's
 * DEFAULT context; a per-request context never clears the challenge (measured 2026-09-07).
 *
 * The bytes are read with the SAME guard `navigateAndCapture` uses for its wire lane: only the MAIN
 * FRAME's DOCUMENT responses count, and the LAST one wins — after an interstitial or a redirect
 * chain, the response `goto` resolves with is the challenge, not the image. And with the same WAIT:
 * `awaitChallengeClearance` runs immediately after `goto`, because `domcontentloaded` fires on the
 * interstitial and walking away from it cancels the challenge script. The body is buffered
 * inside the response event (after the browser consumes it, it may no longer be retrievable) with
 * the served response as the fallback. Nothing about the page lane changes: this is a sibling
 * navigation, not an edit to that path.
 *
 * The gated session is keyed on the STORE host, not the image host: the image must ride the session
 * whose clearance the store earned, and it is counted against that host's tab budget.
 */
import { ChallengeLaneUnavailableError, awaitChallengeClearance, type ChallengeAwarePage, type ChallengeCookie } from '../browserChallenge.js';
import { ResidentialEgressUnavailableError, getResidentialProxyUrl } from '../residentialEgress.js';
import type { EgressKind } from '../gatedBrowsers.js';
import { isDeniedImageUrl } from './imageHostPolicy.js';
import {
  BLOCK_SIGNAL_HEADERS,
  CAPTURED_IMAGE_HEADERS,
  DEFAULT_MAX_IMAGE_BYTES,
  IMAGE_ACCEPT,
  classifyImageBytes,
  imageTooLarge,
  isTimeoutError,
  overImageSizeCap,
  refusedFinalUrl,
  type ImageBytesResult,
  type ImageFetchOptions,
} from './imageBytes.js';

/** Navigation budget (ms) for one image tab — an image is not a rendered storefront. */
export const GATED_IMAGE_NAV_TIMEOUT_MS = 20_000;

/** The slice of a puppeteer HTTPResponse this lane reads. */
export interface ImageResponseLike {
  status(): number;
  url(): string;
  headers(): Record<string, string>;
  buffer(): Promise<Buffer>;
  request(): { resourceType(): string };
  frame(): unknown;
}

/**
 * The slice of a puppeteer Page this lane drives. Everything the CHALLENGE WAIT reads is optional
 * and feature-detected: a page surface that cannot report a title has no interstitial to wait out
 * (and a test double that supplies one drives the wait exactly as the page lane's does).
 */
export interface ImagePageLike {
  on(event: 'response', handler: (response: ImageResponseLike) => void): unknown;
  off(event: 'response', handler: (response: ImageResponseLike) => void): unknown;
  mainFrame(): unknown;
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<ImageResponseLike | null>;
  setExtraHTTPHeaders?(headers: Record<string, string>): Promise<void>;
  title?(): Promise<string>;
  evaluate?(pageFunction: () => unknown): Promise<unknown>;
  url?(): string;
  cookies?(): Promise<ChallengeCookie[]>;
  browserContext?(): { cookies?(): Promise<ChallengeCookie[]> } | undefined;
  browser?(): { cookies?(): Promise<ChallengeCookie[]> } | undefined;
}

/**
 * The page as the challenge wait sees it — the same wrapper the page lane builds, over this lane's
 * structural surface. The clearance COOKIE is the wait's only positive evidence, so the jar is
 * resolved the way puppeteer 25 exposes it for a default-context tab: the context's, else the
 * browser's, else the page's own.
 */
function challengeAwareImagePage(page: ImagePageLike): ChallengeAwarePage | undefined {
  if (typeof page.title !== 'function') return undefined;
  const wrapper: ChallengeAwarePage = { title: () => page.title!() };
  if (typeof page.evaluate === 'function') {
    wrapper.evaluate = (fn: () => any) => page.evaluate!(fn as () => unknown);
  }
  if (typeof page.url === 'function') wrapper.url = () => page.url!();
  const owner = (get: (() => { cookies?(): Promise<ChallengeCookie[]> } | undefined) | undefined) => {
    if (typeof get !== 'function') return undefined;
    try {
      return get();
    } catch {
      return undefined;
    }
  };
  const context = owner(page.browserContext);
  const browser = owner(page.browser);
  if (context && typeof context.cookies === 'function') wrapper.cookies = () => context.cookies!();
  else if (browser && typeof browser.cookies === 'function') wrapper.cookies = () => browser.cookies!();
  else if (typeof page.cookies === 'function') wrapper.cookies = () => page.cookies!();
  return wrapper;
}

/** The per-request wiring the engine's `withPage` reads (a subset of EnginePageOptions). */
export interface GatedTabOptions {
  targetUrl?: string;
  challengeGated?: boolean;
  proxyServer?: string;
  stealth?: boolean;
}

/** The engine's browser-lane door — `EngineScrapingService.withPage` satisfies this structurally. */
export interface GatedTabLane {
  withPage<T>(fn: (page: ImagePageLike) => Promise<T>, options?: GatedTabOptions): Promise<T>;
}

export interface GatedTabBytesFetchOptions {
  /** Resolves the residential proxy (default: the engine's boot-resolved RESIDENTIAL_PROXY_URL). */
  proxyUrlFor?: (egress: EgressKind) => string | undefined;
  /** Navigation budget (default {@link GATED_IMAGE_NAV_TIMEOUT_MS}). */
  timeoutMs?: number;
  /** Body ceiling (default {@link DEFAULT_MAX_IMAGE_BYTES}). */
  maxBytes?: number;
  /** Challenge-wait tuning, passed straight to `awaitChallengeClearance` (defaults are its own). */
  challenge?: { timeoutMs?: number; pollMs?: number };
}

/** An image fetch on the gated lane: the egress and STORE host it belongs to, plus the image URL. */
export type GatedTabBytesFetcher = (
  egress: EgressKind,
  host: string,
  url: string,
  options?: ImageFetchOptions,
) => Promise<ImageBytesResult>;

/** The named headers a response carried, lowercased. */
function headerSubset(response: ImageResponseLike, names: readonly string[] = CAPTURED_IMAGE_HEADERS): Record<string, string> {
  const headers = response.headers() ?? {};
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (names.includes(key) && typeof value === 'string' && value !== '') out[key] = value;
  }
  return out;
}

/**
 * Build the gated-tab image bytes fetcher over the engine's browser-lane door. Every expected outcome
 * is a typed result — a refused lane included — and only a genuine browser fault propagates.
 */
export function createGatedTabBytesFetch(
  lane: GatedTabLane,
  options: GatedTabBytesFetchOptions = {},
): GatedTabBytesFetcher {
  const proxyUrlFor = options.proxyUrlFor ?? ((egress: EgressKind) => (egress === 'residential' ? getResidentialProxyUrl() : undefined));
  const timeout = options.timeoutMs ?? GATED_IMAGE_NAV_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_IMAGE_BYTES;

  return async function fetchBytesViaGatedTab(egress, host, url, opts = {}): Promise<ImageBytesResult> {
    // EGRESS first, before the browser is touched: a residential image with no proxy is REFUSED, the
    // same rule (and the same wording) every other residential door follows. It must never leave
    // through the node IP.
    let proxyServer: string | undefined;
    if (egress === 'residential') {
      proxyServer = opts.proxyUrl ?? proxyUrlFor(egress);
      if (!proxyServer) {
        return { ok: false, reason: 'refused', detail: new ResidentialEgressUnavailableError(url, 'unconfigured').message };
      }
    }

    try {
      return await lane.withPage(async (page): Promise<ImageBytesResult> => {
        // The document-only main-frame guard, recorded SYNCHRONOUSLY (so the last document of the
        // navigation is the one kept) with its body buffered inside the event — a body the browser
        // has already consumed may no longer be retrievable afterwards.
        let served: ImageResponseLike | undefined;
        let buffered: Promise<Buffer | undefined> | undefined;
        const onResponse = (response: ImageResponseLike): void => {
          try {
            if (response.request().resourceType() !== 'document') return;
            if (response.frame() !== page.mainFrame()) return;
            served = response;
            buffered = response.buffer().then(
              bytes => bytes,
              () => undefined,
            );
          } catch {
            /* a response that can no longer describe itself is not the one we want anyway */
          }
        };
        page.on('response', onResponse);
        let navigated: ImageResponseLike | null;
        try {
          if (page.setExtraHTTPHeaders) {
            await page.setExtraHTTPHeaders({
              accept: opts.accept ?? IMAGE_ACCEPT,
              ...(opts.referer ? { referer: opts.referer } : {}),
            });
          }
          navigated = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: opts.timeoutMs ?? timeout });
          // CHALLENGE: `domcontentloaded` fires on the INTERSTITIAL, so leaving here would both read
          // the challenge HTML as the image and cancel the challenge script mid-run — the browser
          // never earns the clearance and the attempt still spends the exit IP's reputation. This is
          // the same wait, in the same position, that navigateAndCapture uses on the page lane; the
          // response listener is still attached, so the post-challenge document replaces `served`.
          const aware = challengeAwareImagePage(page);
          if (aware) await awaitChallengeClearance(aware, navigated ?? undefined, url, options.challenge ?? {});
        } finally {
          page.off('response', onResponse);
        }

        const response = served ?? navigated ?? undefined;
        if (!response) {
          return { ok: false, reason: 'unsupported', detail: 'the navigation produced no main-frame document response' };
        }
        const status = response.status();
        if (status < 200 || status > 299) {
          const signals = headerSubset(response, BLOCK_SIGNAL_HEADERS);
          return { ok: false, reason: 'http-status', status, ...(Object.keys(signals).length > 0 ? { signals } : {}) };
        }
        // The event-time buffer first; the served response is the fallback for a navigation whose
        // listener never got to read it.
        const bytes = (await buffered) ?? (await response.buffer().catch(() => undefined));
        if (!bytes) {
          return { ok: false, reason: 'unsupported', detail: 'the response body was no longer retrievable from the browser' };
        }
        const headers = headerSubset(response);
        // SIZE: the renderer has already buffered the body, so this is the ceiling on what leaves
        // the lane — an oversized document is dropped rather than handed on.
        if (overImageSizeCap(headers['content-length'], maxBytes)) return imageTooLarge(headers['content-length'], maxBytes);
        if (overImageSizeCap(bytes.byteLength, maxBytes)) return imageTooLarge(bytes.byteLength, maxBytes);
        const servedType = headers['content-type'];
        const classified = classifyImageBytes(servedType, bytes);
        if (!classified.image) {
          return { ok: false, reason: 'not-image', status, ...(servedType ? { contentType: servedType } : {}) };
        }
        const finalUrl = response.url() || url;
        // A navigation follows redirects like every other lane — re-assert the ban, then the guard.
        if (isDeniedImageUrl(finalUrl)) return refusedFinalUrl(finalUrl, 'is on the image deny list');
        if (opts.allowFinalUrl && !opts.allowFinalUrl(finalUrl)) {
          return refusedFinalUrl(finalUrl, 'the caller\'s final-URL guard rejected');
        }
        return {
          ok: true,
          bytes,
          contentType: classified.contentType as string,
          status,
          finalUrl,
          headers,
        };
      }, {
        // The gated key is the STORE's host — the session the clearance lives in — not the image
        // host, so the tab joins that store's gated browser and its per-host tab budget.
        targetUrl: `https://${host}/`,
        challengeGated: true,
        stealth: false,
        ...(proxyServer ? { proxyServer } : {}),
      });
    } catch (err) {
      // A gate declared where the launch profile cannot clear it is a CONFIG outcome, not a fault:
      // the caller decides whether to try another lane, so it comes back as a refusal.
      if (err instanceof ChallengeLaneUnavailableError) return { ok: false, reason: 'refused', detail: err.message };
      if (isTimeoutError(err)) return { ok: false, reason: 'timeout', detail: (err as Error).message };
      throw err;
    }
  };
}
