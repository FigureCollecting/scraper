/**
 * impitFetch — a browser-TLS-impersonating HTTP GET (via impit) that clears Cloudflare's
 * fingerprint gate WITHOUT launching a real browser. The light counterpart to
 * ScrapingService.browserFetch, for CF-fronted JSON APIs (e.g. amiami's search endpoint) — ~600ms
 * vs the browser's tens of seconds. impit is loaded LAZILY (dynamic import inside the default
 * factory) so unit tests and non-impersonate code paths never touch the native binary. One Impit
 * instance is cached per impersonation profile.
 */

/** Default impersonation profile. A LIVE TUNABLE — chrome110 already went stale to Cloudflare; keep recent. */
const DEFAULT_PROFILE = 'chrome142';
const TIMEOUT_MS = 15000;

/** Minimal impit surface we depend on — lets tests inject a fake without the native module. */
export interface ImpitLike {
  fetch(url: string, init: { method: string; headers?: Record<string, string> }): Promise<{ text(): Promise<string> }>;
}

export interface ImpitFetchOptions {
  /** Impersonation profile (impit browser), e.g. 'chrome142'. Defaults to a recent engine value. */
  browser?: string;
  headers?: Record<string, string>;
  userAgent?: string;
}

/** Build a real impit instance for a profile — dynamic-imported so the native binary loads only on use. */
async function defaultMakeImpit(browser: string): Promise<ImpitLike> {
  const { Impit } = await import('impit');
  // `browser` is a runtime-valid profile string; impit types it as a Browser enum.
  return new Impit({ browser: browser as never, followRedirects: true, timeout: TIMEOUT_MS }) as unknown as ImpitLike;
}

export type MakeImpit = (browser: string) => ImpitLike | Promise<ImpitLike>;

/**
 * Build an impit body-fetcher. `makeImpit` is injectable (tests pass a fake); the default lazily
 * loads the native impit. Returns `(url, opts?) => Promise<string>` — the same shape the lookup's
 * fetchSearch dispatcher consumes.
 */
export function createImpitFetch(makeImpit: MakeImpit = defaultMakeImpit) {
  const cache = new Map<string, ImpitLike>();
  return async function impitFetchBody(url: string, opts: ImpitFetchOptions = {}): Promise<string> {
    const browser = opts.browser || DEFAULT_PROFILE;
    let impit = cache.get(browser);
    if (!impit) {
      impit = await makeImpit(browser);
      cache.set(browser, impit);
    }
    const headers: Record<string, string> = {
      ...(opts.userAgent ? { 'User-Agent': opts.userAgent } : {}),
      ...(opts.headers ?? {}),
    };
    const res = await impit.fetch(url, { method: 'GET', headers });
    return res.text();
  };
}

/** The engine's default impit fetcher (real native impit, chrome142 default profile). */
export const impitFetchBody = createImpitFetch();
