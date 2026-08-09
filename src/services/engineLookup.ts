/**
 * engineLookup — the entrypoint (A) that wires the driver's cross-store SEARCH runtime
 * (assembleLookup) to the ENGINE's real registry + a fetch. It builds the driver ProfileRegistry
 * from the plugin-populated ExtractionRegistry (`allStores()`) and resolves rulesets +
 * candidate-parsers through `getRulesetForUrl`. The result is a ready `Lookup` the HTTP route calls.
 *
 * `httpFetchBody` is the default fetch: a plain HTTP GET returning the RAW body — correct for the
 * Tier-1 cookieless JSON stores (Shopify suggest.json, Woo Store API). CF-gated stores (amiami, the
 * HTML-search stores) need a browser context; that `browserFetch` is a follow-on that swaps in as
 * the `fetchBody` for `requiresBrowser` hosts without changing this wiring.
 */
import { buildProfileRegistry } from '../driver/profileRegistry.js';
import { assembleLookup, type Lookup } from '../driver/assembleLookup.js';
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
 * Build the cross-store Lookup from the engine's registered stores + fetchers. `fetchBody` is the
 * plain-HTTP default (Tier-1 cookieless JSON); `browserFetch`, when provided, backs the
 * `requiresBrowser` (CF-fronted / SPA) stores — the lookup routes per host without changing wiring.
 */
export function createEngineLookup(
  registry: LookupRegistry,
  fetchBody: (url: string) => Promise<string> = httpFetchBody,
  browserFetch?: (url: string) => Promise<string>,
): Lookup {
  const profiles = buildProfileRegistry(registry.allStores());
  return assembleLookup({
    profiles,
    getRulesetForUrl: (url) => registry.getRulesetForUrl(url),
    fetchBody,
    browserFetchBody: browserFetch,
  });
}
