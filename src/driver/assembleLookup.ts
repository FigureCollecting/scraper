/**
 * assembleLookup — the cross-store SEARCH runtime: the buy-decision fan-out. Given a query (a JAN,
 * or a studio+character/name(+ver)+scale combo when there's no JAN), it fans across every store
 * with a `retrieval.bySearch` axis, fetches each store's search endpoint, and parses the results
 * into `SearchCandidate[]` via that store's ruleset `extractCandidates` (contract 0.3.1).
 *
 * TWO MODES over ONE fetch (no double-searching):
 *   - `listed`    — every item the store carries, incl. sold-out ("which stores have this?").
 *   - `orderable` — only in-stock/buyable items ("what can I buy right now?"), i.e. drop
 *     candidates whose `available === false`.
 * The store's `bySearch` should target the LISTED (complete) endpoint + each `SearchCandidate`
 * carries `available`, so both modes are views over the same result. Where a store's ONLY search
 * is `orderable`-scope (a predictive endpoint that hides sold-out), a `listed` query can't confirm
 * its sold-out items — that store is reported in `orderableOnly` rather than silently
 * under-counted (the false-negative that hid a sold-out solaris figure).
 *
 * Distinct from the byId currency crawl (assembleCrawlDriver): search DISCOVERS on demand. The
 * next stage (a follow-on) matches candidates by JAN-equality / ER and byId-fetches the full
 * record. Everything is injected so the fan-out is deterministic in tests.
 */
import { planRetrieval } from './retrievalPlanner.js';
import type { ProfileRegistry } from './profileRegistry.js';
import type { ExtractionRuleset, SearchCandidate } from '@figurecollecting/scraper-plugin-contract';

export type LookupMode = 'listed' | 'orderable';

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
  mode: LookupMode;
  results: StoreLookupResult[];
  /** Stores that cannot serve the search: no `bySearch` axis, or no `extractCandidates` parser. */
  unsupported: string[];
  /**
   * Stores that DID return results but whose search is `orderable`-scope — so a `listed` query
   * can't confirm their sold-out items (coverage caveat, not a failure). Always empty in
   * `orderable` mode (where that scope is exactly what's wanted).
   */
  orderableOnly: string[];
  /** Stores whose search fetch or parse errored (transparency, not silent drop). */
  failed: string[];
}

export interface Lookup {
  lookup(query: string, opts?: { mode?: LookupMode }): Promise<LookupResult>;
}

export function assembleLookup(services: LookupServices): Lookup {
  return {
    async lookup(query, opts = {}) {
      const mode: LookupMode = opts.mode ?? 'listed';
      const plan = planRetrieval(services.profiles, { mode: 'lookup', query });
      const unsupported = [...plan.unsupported];
      const orderableOnly: string[] = [];
      const failed: string[] = [];

      const settled = await Promise.all(
        plan.plans.map(async (p): Promise<StoreLookupResult | null> => {
          const ruleset = services.getRulesetForUrl(p.url);
          if (!ruleset?.extractCandidates) {
            unsupported.push(p.siteId); // has a bySearch URL but no parser yet
            return null;
          }
          const scope = services.profiles.retrievalFor(p.host)?.bySearch?.scope ?? 'listed';
          if (mode === 'listed' && scope === 'orderable') orderableOnly.push(p.siteId);
          try {
            const body = await services.fetchBody(p.url);
            let candidates = await ruleset.extractCandidates(body, p.url);
            if (mode === 'orderable') candidates = candidates.filter((c) => c.available !== false);
            return { siteId: p.siteId, host: p.host, url: p.url, candidates };
          } catch {
            failed.push(p.siteId);
            return null;
          }
        }),
      );

      return {
        query,
        mode,
        results: settled.filter((r): r is StoreLookupResult => r !== null),
        unsupported,
        orderableOnly,
        failed,
      };
    },
  };
}
