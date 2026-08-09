/**
 * assembleLookup — the cross-store SEARCH runtime: the buy-decision fan-out. Given a query (a JAN,
 * or a studio+character/name(+ver)+scale combo when there's no JAN), it fans across every store
 * with a `retrieval.bySearch` axis, fetches each store's search endpoint, and parses the results
 * into `SearchCandidate[]` via that store's ruleset `extractCandidates`. The output is a per-store
 * candidate map plus honest coverage gaps (which stores can't search, which errored).
 *
 * This is DISTINCT from the byId currency crawl (assembleCrawlDriver): search DISCOVERS items on
 * demand — it reaches any figure the moment you ask, independent of the slow full-catalog walk.
 * The next stage (a follow-on) matches candidates by JAN-equality / ER (studio+character+scale)
 * and then `byId`-fetches the full record for price + barcode.
 *
 * Everything is injected (profiles / getRulesetForUrl / fetchBody) so the fan-out is deterministic
 * in tests; `fetchBody` returns the RAW response body (JSON for the Tier-1 API searches, HTML for
 * the 2nd wave) so the ruleset parses exactly what the endpoint served.
 */
import { planRetrieval } from './retrievalPlanner.js';
import type { ProfileRegistry } from './profileRegistry.js';
import type { ExtractionRuleset, SearchCandidate } from '@figurecollecting/scraper-plugin-contract';

export interface LookupServices {
  /** The store registry (built from the engine's registered capabilities). */
  profiles: ProfileRegistry;
  /** URL → ruleset (engine ExtractionRegistryImpl.getRulesetForUrl); the ruleset parses candidates. */
  getRulesetForUrl: (url: string) => ExtractionRuleset | undefined;
  /** Raw response body of a search URL (JSON for Tier-1 API searches; HTML for the 2nd wave). */
  fetchBody: (url: string) => Promise<string>;
}

export interface StoreLookupResult {
  siteId: string;
  host: string;
  url: string;
  candidates: SearchCandidate[];
}

export interface LookupResult {
  query: string;
  results: StoreLookupResult[];
  /** Stores that cannot serve the search: no `bySearch` axis, or no `extractCandidates` parser. */
  unsupported: string[];
  /** Stores whose search fetch or parse errored (transparency, not silent drop). */
  failed: string[];
}

export interface Lookup {
  lookup(query: string): Promise<LookupResult>;
}

export function assembleLookup(services: LookupServices): Lookup {
  return {
    async lookup(query) {
      const plan = planRetrieval(services.profiles, { mode: 'lookup', query });
      const unsupported = [...plan.unsupported];
      const failed: string[] = [];

      const settled = await Promise.all(
        plan.plans.map(async (p): Promise<StoreLookupResult | null> => {
          const ruleset = services.getRulesetForUrl(p.url);
          if (!ruleset?.extractCandidates) {
            unsupported.push(p.siteId); // has a bySearch URL but no parser yet
            return null;
          }
          try {
            const body = await services.fetchBody(p.url);
            const candidates = await ruleset.extractCandidates(body, p.url);
            return { siteId: p.siteId, host: p.host, url: p.url, candidates };
          } catch {
            failed.push(p.siteId);
            return null;
          }
        }),
      );

      return {
        query,
        results: settled.filter((r): r is StoreLookupResult => r !== null),
        unsupported,
        failed,
      };
    },
  };
}
