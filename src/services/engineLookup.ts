/**
 * engineLookup — the entrypoint (A) that wires the driver's cross-store SEARCH runtime
 * (assembleLookup) to the ENGINE's real registry + a fetch. It builds the driver ProfileRegistry
 * from the plugin-populated ExtractionRegistry (`allStores()`) and resolves rulesets +
 * candidate-parsers through `getRulesetForUrl`. The result is a ready `Lookup` the HTTP route calls.
 *
 * Each store's search body is fetched via the transport it declares (StoreCapabilities.searchFetch):
 * `http` = plain GET (Tier-1 cookieless JSON — the default), `impersonate` = impit TLS-impersonation
 * (CF-fronted JSON APIs like amiami), `browser` = pooled browser nav (rendered-DOM stores). The
 * `browser` transport is wired at the mount from the ScrapingService; unset here → it degrades to http.
 */
import { buildProfileRegistry } from '../driver/profileRegistry.js';
import { assembleLookup, type Lookup, type LookupServices } from '../driver/assembleLookup.js';
import { assembleCatalog, type Catalog } from '../driver/assembleCatalog.js';
import { makeFetchSearch, type FetchSearchTransports } from './fetchSearch.js';
import { impitFetchBody } from './impitFetch.js';
import { getCfCookieStore, type CfCookieSource } from './cookieJar.js';
import type { ExtractionRuleset, StoreCapabilities } from '@figurecollecting/scraper-plugin-contract';

/** The slice of the engine ExtractionRegistry the lookup needs. */
export interface LookupRegistry {
  allStores(): StoreCapabilities[];
  getRulesetForUrl(url: string): ExtractionRuleset | undefined;
}

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

/** Abort ceiling (ms) for the plain-HTTP lane when HTTP_FETCH_TIMEOUT_MS is unset/invalid, and the clamp any override rides within. */
const DEFAULT_HTTP_FETCH_TIMEOUT_MS = 15_000;
const MIN_HTTP_FETCH_TIMEOUT_MS = 5_000;
const MAX_HTTP_FETCH_TIMEOUT_MS = 120_000;

/**
 * Resolve the plain-HTTP lane's abort ceiling (ms) from the environment. HTTP_FETCH_TIMEOUT_MS
 * overrides the 15s default (the orzgk 100-item listing takes ~15s, so ops set 30000); a missing,
 * empty, non-numeric, or non-positive value falls back to the default, and any usable value is
 * clamped to [5000, 120000]. Pure (env in → number out) — mirrors resolveImpitTimeoutMs.
 */
export function resolveHttpFetchTimeoutMs(env: NodeJS.ProcessEnv): number {
  const n = Number(env.HTTP_FETCH_TIMEOUT_MS);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_HTTP_FETCH_TIMEOUT_MS;
  return Math.min(MAX_HTTP_FETCH_TIMEOUT_MS, Math.max(MIN_HTTP_FETCH_TIMEOUT_MS, n));
}

/**
 * Abort ceiling for the plain-HTTP lane, resolved ONCE at module load. Without it a tarpitted
 * endpoint rides undici's ~300s header/body defaults — tolerable for the ingest queue, not for the
 * synchronous /lookup and /resolve callers this lane also serves.
 */
export const HTTP_FETCH_TIMEOUT_MS = resolveHttpFetchTimeoutMs(process.env);

/** `name=value; name2=value2` — the Cookie request-header form of a stored cookie map. */
function serializeCookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies).map(([name, value]) => `${name}=${value}`).join('; ');
}

/**
 * Build the plain-HTTP body fetcher. STORED COOKIES + PINNED UA (CfCookieStore): a host the store has
 * cookies for gets a `cookie` header and the mint User-Agent (cf_clearance is IP+UA-bound); an unknown
 * host's request is BYTE-IDENTICAL to the cookieless path. `store` is injectable (tests); the default
 * resolves the singleton per call so a hot-reloaded file is always the one consulted.
 */
export function createHttpFetch(options: { store?: CfCookieSource } = {}) {
  /** Raw response body of a search URL via plain HTTP (Tier-1 cookieless JSON), abort-bounded. */
  return async function httpFetchBody(url: string): Promise<string> {
    const store = options.store ?? getCfCookieStore();
    const cookies = store.cookiesFor(url);
    const headers: Record<string, string> = {
      'user-agent': store.userAgentFor(url) ?? DESKTOP_UA,
      accept: 'application/json, text/html',
      ...(cookies ? { cookie: serializeCookieHeader(cookies) } : {}),
    };
    const res = await fetch(url, {
      headers,
      // One signal bounds headers AND body: text() streams under the same abort.
      signal: AbortSignal.timeout(HTTP_FETCH_TIMEOUT_MS),
    });
    return res.text();
  };
}

/** The engine's default plain-HTTP fetcher (CfCookieStore singleton, module-load timeout). */
export const httpFetchBody = createHttpFetch();

/**
 * Build the cross-store Lookup from the engine's registered stores + the three search transports.
 * `http` and `impersonate` default to the real engine fetchers (plain fetch / impit); `browser` is
 * wired at the mount from the ScrapingService (left unset in tests → the browser transport degrades
 * to http). Per-store transport selection is data-driven via `StoreCapabilities.searchFetch`.
 */
export function createEngineLookup(
  registry: LookupRegistry,
  transports: Partial<FetchSearchTransports> = {},
): Lookup {
  return assembleLookup(wireServices(registry, transports));
}

/**
 * Build the per-store CATALOG listing runtime (GET /catalog — the crawler's enumeration feed) from
 * the same registry + transports as the Lookup: a store's listing page is fetched through the very
 * transport its `searchFetch` declares, and parsed by its ruleset's `extractListing`.
 */
export function createEngineCatalog(
  registry: LookupRegistry,
  transports: Partial<FetchSearchTransports> = {},
): Catalog {
  return assembleCatalog(wireServices(registry, transports));
}

/** The engine wiring both runtimes share: registry → ProfileRegistry, ruleset lookup, 3-way search fetch. */
function wireServices(registry: LookupRegistry, transports: Partial<FetchSearchTransports>): LookupServices {
  const profiles = buildProfileRegistry(registry.allStores());
  const fetchSearch = makeFetchSearch({
    http: transports.http ?? httpFetchBody,
    impersonate: transports.impersonate ?? impitFetchBody,
    browser: transports.browser,
  });
  return {
    profiles,
    getRulesetForUrl: (url) => registry.getRulesetForUrl(url),
    fetchSearch,
  };
}
