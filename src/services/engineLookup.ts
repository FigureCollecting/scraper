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
import type { ExtractionRuleset, StoreCapabilities } from '@figurecollecting/scraper-plugin-contract';

/** The slice of the engine ExtractionRegistry the lookup needs. */
export interface LookupRegistry {
  allStores(): StoreCapabilities[];
  getRulesetForUrl(url: string): ExtractionRuleset | undefined;
}

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

/**
 * Abort ceiling for the plain-HTTP lane, matching impit's own 15s cap (impitFetch TIMEOUT_MS) so
 * neither non-browser transport can outlive the other. Without it a tarpitted endpoint rides
 * undici's ~300s header/body defaults — tolerable for the ingest queue, not for the synchronous
 * /lookup and /resolve callers this lane also serves.
 */
export const HTTP_FETCH_TIMEOUT_MS = 15_000;

/** Raw response body of a search URL via plain HTTP (Tier-1 cookieless JSON), abort-bounded. */
export async function httpFetchBody(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'user-agent': DESKTOP_UA, accept: 'application/json, text/html' },
    // One signal bounds headers AND body: text() streams under the same abort.
    signal: AbortSignal.timeout(HTTP_FETCH_TIMEOUT_MS),
  });
  return res.text();
}

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
