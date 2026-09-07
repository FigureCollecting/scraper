/**
 * fetchSearch — the cross-store search FETCH dispatcher. A store declares how its `bySearch`
 * endpoint should be fetched (via `StoreCapabilities.searchFetch`); this routes each search URL to
 * the matching transport and applies the store's request decoration:
 *   - `http`        → a plain HTTP GET (Tier-1 cookieless JSON).
 *   - `impersonate` → impit (browser-TLS-impersonating GET) with profile + headers (CF JSON APIs).
 *   - `browser`     → a pooled browser navigation (rendered-DOM / JS-challenge stores).
 * The `browser` transport degrades to `http` when no browser fetcher is wired, so headless/test
 * compositions still work. Replaces the earlier boolean browser-vs-http routing.
 */
import type { SearchFetch, WaitForReadiness } from '@figurecollecting/scraper-plugin-contract';
import { resolvePrime, warnDroppedBrowserPrime } from './sessionPrime.js';
import {
  getResidentialProxyUrl,
  refuseHttpLaneResidentialEgress,
  requireResidentialProxy,
} from './residentialEgress.js';

export interface FetchSearchTransports {
  /** Plain HTTP GET (Tier-1 cookieless JSON). */
  http: (url: string) => Promise<string>;
  /** impit TLS-impersonating GET (Cloudflare-fronted JSON APIs). `prime` primes a session-gated host; `proxyUrl` is residential egress. */
  impersonate: (url: string, opts: { browser?: string; headers?: Record<string, string>; userAgent?: string; prime?: { url: string }; proxyUrl?: string }) => Promise<string>;
  /** Pooled browser navigation (rendered-DOM / JS-challenge). Optional — degrades to http if absent. */
  browser?: (url: string, opts?: { headers?: Record<string, string>; userAgent?: string; cookies?: Record<string, string>; proxyServer?: string; waitFor?: WaitForReadiness; challengeGated?: boolean; primeUrl?: string }) => Promise<string>;
}

/** Injectable wiring for {@link makeFetchSearch} (tests drive the egress config deterministically). */
export interface FetchSearchDeps {
  /** The engine's residential proxy (default: the process's RESIDENTIAL_PROXY_URL, resolved at boot). */
  residentialProxyUrl?: () => string | undefined;
  /** Warning sink for a dropped browser-lane session prime (default `console.warn`). */
  warn?: (message: string) => void;
}

/** Build the per-store search fetcher from the three transports. */
export function makeFetchSearch(t: FetchSearchTransports, deps: FetchSearchDeps = {}) {
  const resolveProxy = deps.residentialProxyUrl ?? getResidentialProxyUrl;
  return async function fetchSearch(url: string, searchFetch: SearchFetch): Promise<string> {
    // EGRESS (once per call): a store declaring `residential` fetches through the configured proxy;
    // with none configured this THROWS rather than letting the request out of the node IP. Every
    // other store resolves to `undefined` and takes exactly its pre-0.7.0 path.
    const proxyUrl = requireResidentialProxy(url, searchFetch.egress, resolveProxy());
    switch (searchFetch.transport) {
      case 'impersonate': {
        // A session-gated store (sessionPrime) is primed once per Impit session before the search
        // GET; undeclared → no `prime` key (byte-identical).
        const prime = resolvePrime(searchFetch, url);
        return t.impersonate(url, { browser: searchFetch.browser, headers: searchFetch.headers, userAgent: searchFetch.userAgent, ...(prime ? { prime } : {}), ...(proxyUrl ? { proxyUrl } : {}) });
      }
      case 'browser': {
        // A store that explicitly needs a browser must NOT silently fall back to a plain GET — that
        // returns a Cloudflare challenge PAGE the parser would treat as empty. Fail loud (→ the
        // lookup's failed[]) instead of returning garbage.
        if (!t.browser) throw new Error('search transport "browser" requested but no browser fetcher is wired');
        // A CHALLENGE-GATED store keeps its browser context between fetches (its clearance is bound
        // to it), and primes a fresh one on the origin first — the browser lane's own session prime.
        const challengeGated = searchFetch.access === 'cloudflare';
        const browserPrime = challengeGated ? resolvePrime(searchFetch, url) : undefined;
        // A prime declared without the gate is dropped here — say so once per host rather than never.
        if (!challengeGated) warnDroppedBrowserPrime(searchFetch, url, deps.warn);
        return t.browser(url, {
          headers: searchFetch.headers,
          userAgent: searchFetch.userAgent,
          cookies: searchFetch.cookies,
          ...(proxyUrl ? { proxyServer: proxyUrl } : {}),
          ...(searchFetch.waitFor ? { waitFor: searchFetch.waitFor } : {}),
          ...(challengeGated ? { challengeGated: true } : {}),
          ...(browserPrime ? { primeUrl: browserPrime.url } : {}),
        });
      }
      case 'http':
      default:
        // The plain-HTTP lane cannot proxy (see refuseHttpLaneResidentialEgress) — a residential
        // store on it is refused, never quietly fetched from the node IP.
        if (proxyUrl) refuseHttpLaneResidentialEgress(url, proxyUrl);
        return t.http(url);
    }
  };
}
