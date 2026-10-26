/**
 * galleryImpitLane — the gallery's impit lane (GAL-IMPIT). The shared impit image transport (`createImpitBytesFetch`, the one the
 * ingest image lane uses), handed a session that keeps the gallery's rules:
 *
 *   - the impersonation profile is impit's `chrome`, the one the operator's host policy records clearing a static image host's
 *     TLS-fingerprint gate (fc-infra image-host-policy.yaml, probed 2026-09-08);
 *   - NO cookie jar: impit without one neither keeps nor sends a cookie, so a Set-Cookie is never sent back;
 *   - NO stored cookies and NO minted user agent: the process cookie store (CF_COOKIE_FILE) is not consulted, so a hand-minted
 *     clearance never rides on a gallery request;
 *   - NO proxy but the scraper's own residential exit, and that one only on a run that permits it (GALLERY_EGRESS=residential under
 *     a byte budget, GAL-RES): a session asked for any other proxy is refused before it is built. The exit is a session property in
 *     impit, so a run keeps one session per egress (direct, and the residential exit), each with no cookie jar;
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

/** Builds the impit session for a profile, through the residential exit when `proxyUrl` is given. */
export type GalleryImpitFactory = (browser: string, proxyUrl?: string) => ImpitLike | Promise<ImpitLike>;

const NO_STORED_COOKIES: CfCookieSource = { cookiesFor: () => undefined, userAgentFor: () => undefined };

/**
 * The real session: no cookie jar, no redirect following, and the http lane's per-image timeout (15 s) rather than the listing budget.
 * A proxied session takes `proxyUrl` exactly as the scraper's own impit sessions do (impitFetch.ts `defaultMakeImpit`). impit is imported
 * on first use, as the other impit lanes do.
 */
export function galleryImpitFactory(timeoutMs: number = DEFAULT_IMAGE_FETCH_TIMEOUT_MS): GalleryImpitFactory {
  return async (browser, proxyUrl) => {
    const { Impit } = await import('impit');
    return new Impit({ browser: browser as never, followRedirects: false, timeout: timeoutMs, ...(proxyUrl ? { proxyUrl } : {}) }) as unknown as ImpitLike;
  };
}

/** The gallery's impit fetcher, and a way to build a session (direct, or through the residential exit) ahead of a request. */
export type GalleryImpitFetcher = ImageBytesFetcher & { ready(proxyUrl?: string): Promise<void> };

/**
 * The impit bytes fetcher of a gallery run: ONE session per egress for the run (direct, and on a residential run the scraper's
 * residential exit; each built on its first request or by `ready()`, built again if building it failed), passed through `wrap` with the
 * egress it carries (the recorder and the byte meter, so every request lands in the probe evidence, every 3xx's Location reaches the
 * redirect follower, and every body read is counted). `maxBytes` is the per-file cap (default the shared lane's 32 MiB).
 */
export function createGalleryImpitFetch(opts: {
  makeImpit: GalleryImpitFactory;
  wrap?: (impit: ImpitLike, egress: 'direct' | 'residential') => ImpitLike;
  /** The scraper's residential exit (RESIDENTIAL_PROXY_URL), on a run permitted to use it; the only proxy a session may be built with. */
  residentialProxy?: string;
  maxBytes?: number;
}): GalleryImpitFetcher {
  const wrap = opts.wrap ?? ((impit: ImpitLike) => impit);
  const sessions = new Map<string, Promise<ImpitLike>>();
  const permitted = (proxyUrl: string | undefined): boolean => proxyUrl === undefined || proxyUrl === opts.residentialProxy;
  const getImpit = (browser: string, proxyUrl: string | undefined): Promise<ImpitLike> => {
    if (!permitted(proxyUrl)) {
      return Promise.reject(new Error(opts.residentialProxy === undefined
        ? 'the gallery impit lane never leaves through a proxy'
        : "the gallery impit lane leaves through no proxy but the scraper's residential exit (RESIDENTIAL_PROXY_URL)"));
    }
    const key = proxyUrl ?? 'direct';
    let session = sessions.get(key);
    if (session === undefined) {
      const building = Promise.resolve()
        .then(() => (proxyUrl === undefined ? opts.makeImpit(browser) : opts.makeImpit(browser, proxyUrl)))
        .then(impit => wrap(impit, proxyUrl === undefined ? 'direct' : 'residential'));
      session = building;
      sessions.set(key, building);
      building.catch(() => { if (sessions.get(key) === building) sessions.delete(key); });
    }
    return session;
  };
  const fetcher = createImpitBytesFetch({
    getImpit, cookieStore: NO_STORED_COOKIES, browser: GALLERY_IMPIT_BROWSER, ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
  });
  // A proxy this run may not use builds nothing here: the dispatch guard under the pacer refuses that request without a session.
  return Object.assign(fetcher, { ready: async (proxyUrl?: string) => { if (permitted(proxyUrl)) await getImpit(GALLERY_IMPIT_BROWSER, proxyUrl); } });
}

/**
 * Build the impit session BEFORE an impit request takes its pacing slot. The pacer books a host's slot when it lets a request go;
 * loading the native module after that would hold the first request back while the next slot's clock already runs, so the host
 * would see the first two requests closer together than its interval (measured on loopback: 55 to 74 ms apart at a 100 ms row).
 * Put this OVER the pacer. A session that cannot be built throws here, before any slot is taken.
 */
export function impitReadyFirst(paced: ImageBytesFetcher, impit: { ready(proxyUrl?: string): Promise<void> }): ImageBytesFetcher {
  return async (url, options) => {
    if ((options as { lane?: string } | undefined)?.lane === 'impit') await impit.ready(options?.proxyUrl);
    return paced(url, options);
  };
}
