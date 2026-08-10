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
import type { SearchFetch } from '@figurecollecting/scraper-plugin-contract';

export interface FetchSearchTransports {
  /** Plain HTTP GET (Tier-1 cookieless JSON). */
  http: (url: string) => Promise<string>;
  /** impit TLS-impersonating GET (Cloudflare-fronted JSON APIs). */
  impersonate: (url: string, opts: { browser?: string; headers?: Record<string, string>; userAgent?: string }) => Promise<string>;
  /** Pooled browser navigation (rendered-DOM / JS-challenge). Optional — degrades to http if absent. */
  browser?: (url: string, opts?: { headers?: Record<string, string>; userAgent?: string; cookies?: Record<string, string> }) => Promise<string>;
}

/** Build the per-store search fetcher from the three transports. */
export function makeFetchSearch(t: FetchSearchTransports) {
  return async function fetchSearch(url: string, searchFetch: SearchFetch): Promise<string> {
    switch (searchFetch.transport) {
      case 'impersonate':
        return t.impersonate(url, { browser: searchFetch.browser, headers: searchFetch.headers, userAgent: searchFetch.userAgent });
      case 'browser':
        // A store that explicitly needs a browser must NOT silently fall back to a plain GET — that
        // returns a Cloudflare challenge PAGE the parser would treat as empty. Fail loud (→ the
        // lookup's failed[]) instead of returning garbage.
        if (!t.browser) throw new Error('search transport "browser" requested but no browser fetcher is wired');
        return t.browser(url, { headers: searchFetch.headers, userAgent: searchFetch.userAgent, cookies: searchFetch.cookies });
      case 'http':
      default:
        return t.http(url);
    }
  };
}
