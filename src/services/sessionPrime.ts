/**
 * sessionPrime — resolve a store's `searchFetch.sessionPrime` declaration to the concrete prime
 * target the impersonate (impit) transport consumes. A session-gated store (403-cold Cloudflare)
 * clears only after a same-session homepage GET; the transport does that prime GET once per session
 * (see impitFetch's session-prime). This maps the DECLARATION (`true` / `{ primeUrl }`) plus the
 * target URL to the URL to prime — the store's origin by default, or an explicit override.
 *
 * Shared by both fetch paths that go through impit — the ingest capturingFetch and the search
 * fetchSearch — so a session-gated store is primed identically whichever path reaches it. An
 * undeclared store resolves to `undefined`, so those paths add nothing (byte-identical behavior).
 */
import type { SearchFetch } from '@figurecollecting/scraper-plugin-contract';

/** The impersonate transport's prime input: the single URL to GET (once/session) before the target. */
export interface PrimeTarget {
  url: string;
}

/**
 * @param searchFetch - the store's declared fetch decoration (carries `sessionPrime`), or undefined
 * @param targetUrl   - the URL about to be fetched; its origin is the default prime URL
 * @returns the prime target, or undefined when the store declares no session prime (or the origin
 *          cannot be derived from an unparseable target URL)
 */
export function resolvePrime(searchFetch: SearchFetch | undefined, targetUrl: string): PrimeTarget | undefined {
  const sp = searchFetch?.sessionPrime;
  if (!sp) return undefined; // undefined | false → no prime
  if (typeof sp === 'object' && sp.primeUrl) return { url: sp.primeUrl };
  // `true`, or an object without an explicit primeUrl → prime the target's origin (homepage).
  try {
    return { url: new URL(targetUrl).origin };
  } catch {
    return undefined;
  }
}
