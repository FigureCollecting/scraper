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
import { assembleLookup, type Lookup } from '../driver/assembleLookup.js';
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

/** Raw response body of a search URL via plain HTTP (Tier-1 cookieless JSON). */
export async function httpFetchBody(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'user-agent': DESKTOP_UA, accept: 'application/json, text/html' } });
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
  const profiles = buildProfileRegistry(registry.allStores());
  const fetchSearch = makeFetchSearch({
    http: transports.http ?? httpFetchBody,
    impersonate: transports.impersonate ?? impitFetchBody,
    browser: transports.browser,
  });
  return assembleLookup({
    profiles,
    getRulesetForUrl: (url) => registry.getRulesetForUrl(url),
    fetchSearch,
  });
}
