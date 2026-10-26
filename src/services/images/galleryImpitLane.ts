/**
 * galleryImpitLane — the gallery's impit lane (GAL-IMPIT). The shared impit image transport (`createImpitBytesFetch`, the one the
 * ingest image lane uses), handed a session that keeps the gallery's rules:
 *
 *   - the impersonation profile is impit's `chrome`, the one the operator's host policy records clearing a static image host's
 *     TLS-fingerprint gate (fc-infra image-host-policy.yaml, probed 2026-09-08);
 *   - NO cookie jar: impit without one neither keeps nor sends a cookie, so a Set-Cookie is never sent back;
 *   - NO stored cookies and NO minted user agent: the process cookie store (CF_COOKIE_FILE) is not consulted, so a hand-minted
 *     clearance never rides on a gallery request;
 *   - NO proxy: a session asked for one is refused before it is built (the residential exit is not the gallery's to use);
 *   - impit follows NO redirect (`followRedirects: false`; the recorder also asks every request for `manual`): the driver's
 *     `followAllowedRedirects` checks the allow-list before any request to a redirect target.
 *
 * Everything else (status before body, the size cap on the declared length and again on the bytes, the image-type check, the deny
 * list, placeholders) is the shared transport's own, exactly as the ingest image lane runs it. The session is built on the first
 * request, so a run whose hosts are all on the http lane never loads the native module.
 */
import type { CfCookieSource } from '../cookieJar.js';
import type { ImpitLike } from '../impitFetch.js';
import { DEFAULT_IMAGE_FETCH_TIMEOUT_MS } from './httpBytesFetch.js';
import type { ImageBytesFetcher } from './imageBytes.js';
import { createImpitBytesFetch } from './impitBytesFetch.js';

/** impit's `chrome` profile (its own default Chrome fingerprint, user agent and client hints). */
export const GALLERY_IMPIT_BROWSER = 'chrome';

/** Builds the impit session for a profile. */
export type GalleryImpitFactory = (browser: string) => ImpitLike | Promise<ImpitLike>;

const NO_STORED_COOKIES: CfCookieSource = { cookiesFor: () => undefined, userAgentFor: () => undefined };

/**
 * The real session: no cookie jar, no proxy, no redirect following, and the http lane's per-image timeout (15 s) rather than the
 * listing budget. impit is imported on first use, as the other impit lanes do.
 */
export function galleryImpitFactory(timeoutMs: number = DEFAULT_IMAGE_FETCH_TIMEOUT_MS): GalleryImpitFactory {
  return async browser => {
    const { Impit } = await import('impit');
    return new Impit({ browser: browser as never, followRedirects: false, timeout: timeoutMs }) as unknown as ImpitLike;
  };
}

/** The gallery's impit fetcher, and a way to build its session ahead of a request. */
export type GalleryImpitFetcher = ImageBytesFetcher & { ready(): Promise<void> };

/**
 * The impit bytes fetcher of a gallery run: ONE session for the run (built on the first request or by `ready()`, built again if
 * building it failed), passed through `wrap` (the recorder, so every request lands in the probe evidence and every 3xx's Location
 * reaches the redirect follower).
 */
export function createGalleryImpitFetch(opts: { makeImpit: GalleryImpitFactory; wrap?: (impit: ImpitLike) => ImpitLike }): GalleryImpitFetcher {
  const wrap = opts.wrap ?? ((impit: ImpitLike) => impit);
  let session: Promise<ImpitLike> | undefined;
  const getImpit = (browser: string, proxyUrl: string | undefined): Promise<ImpitLike> => {
    if (proxyUrl !== undefined) return Promise.reject(new Error('the gallery impit lane never leaves through a proxy'));
    if (session === undefined) {
      const building = Promise.resolve().then(() => opts.makeImpit(browser)).then(wrap);
      session = building;
      building.catch(() => { session = undefined; });
    }
    return session;
  };
  const fetcher = createImpitBytesFetch({ getImpit, cookieStore: NO_STORED_COOKIES, browser: GALLERY_IMPIT_BROWSER });
  return Object.assign(fetcher, { ready: async () => { await getImpit(GALLERY_IMPIT_BROWSER, undefined); } });
}

/**
 * Build the impit session BEFORE an impit request takes its pacing slot. The pacer books a host's slot when it lets a request go;
 * loading the native module after that would hold the first request back while the next slot's clock already runs, so the host
 * would see the first two requests closer together than its interval (measured on loopback: 55 to 74 ms apart at a 100 ms row).
 * Put this OVER the pacer. A session that cannot be built throws here, before any slot is taken.
 */
export function impitReadyFirst(paced: ImageBytesFetcher, impit: { ready(): Promise<void> }): ImageBytesFetcher {
  return async (url, options) => {
    if ((options as { lane?: string } | undefined)?.lane === 'impit') await impit.ready();
    return paced(url, options);
  };
}
