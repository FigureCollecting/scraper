/**
 * assembleResolve — the byId CONFIRM runtime (the matcher's pass-2 bridge, and /resolve's engine).
 * Given a store + item ids (e.g. the `resolveTargets` a record-mode lookup surfaced, or a candidate
 * the caller picked), it fetches each item's DETAIL page and runs the store's `ruleset.extract` →
 * full `ExtractedData` (whose `fields.gtin14` the private byId ruleset populates). Unlike the crawl
 * worker, it RETURNS the data and NEVER emits to the spine or touches a ledger.
 *
 * Composed from three existing primitives — `resolveByIdUrl` + an injected detail fetch + the
 * ruleset's `extract` — so it reuses the same substrate the crawl worker is built from, one layer
 * down, without the spine/ledger coupling. Everything injected → deterministic in tests.
 */
import { resolveByIdUrl } from './retrievalPlanner.js';
import { sanitizeForLog } from '../utils/security.js';
import type { ProfileRegistry } from './profileRegistry.js';
import type { ExtractedData, ExtractionRuleset } from '@figurecollecting/scraper-plugin-contract';

export interface ResolveServices {
  /** The store registry (built from the engine's registered capabilities). */
  profiles: ProfileRegistry;
  /** URL → ruleset (engine ExtractionRegistryImpl.getRulesetForUrl); the ruleset's extract() confirms. */
  getRulesetForUrl: (url: string) => ExtractionRuleset | undefined;
  /** Fetch a detail page's body (the pooled ScrapingService's scrapePage at the mount). */
  fetchDetail: (url: string) => Promise<{ html: string; statusCode?: number }>;
}

export interface ResolveItem {
  itemId: string;
  url: string;
  /** The confirmed record when fetch + extract succeeded. */
  data?: ExtractedData;
  /**
   * The gtin14 the byId extract recovered, surfaced for the matcher. UNDEFINED means the confirm did
   * NOT yield a barcode (a no-JAN statue, OR an SPA/CF page the browser fetch under-extracted) — so
   * "confirmed but unanchored" is visible rather than a silent empty success.
   */
  gtin14?: string;
}

export interface ResolveResult {
  site: string;
  results: ResolveItem[];
  /** The site has no byId axis (or is unknown) — none of the ids can be resolved. */
  unsupported: boolean;
  /** Item ids whose detail fetch or extract errored (transparency, not silent drop). */
  failed: string[];
}

export interface Resolve {
  resolve(site: string, ids: string[]): Promise<ResolveResult>;
}

export function assembleResolve(services: ResolveServices): Resolve {
  return {
    async resolve(site, ids) {
      const caps = services.profiles.forSite(site);
      if (!caps?.retrieval?.byId) {
        return { site, results: [], unsupported: true, failed: [] };
      }

      const failed: string[] = [];
      const settled = await Promise.all(
        ids.map(async (itemId): Promise<ResolveItem | null> => {
          const url = resolveByIdUrl(caps.retrieval, itemId);
          const ruleset = url ? services.getRulesetForUrl(url) : undefined;
          if (!url || !ruleset) {
            failed.push(itemId);
            return null;
          }
          try {
            const { html, statusCode } = await services.fetchDetail(url);
            // A 4xx/5xx page (CF challenge / gone / error) is NOT a confirm — extract would happily
            // parse the error body into empty fields WITHOUT throwing, so gate on status explicitly.
            if (statusCode !== undefined && statusCode >= 400) {
              throw new Error(`detail fetch returned HTTP ${statusCode}`);
            }
            const data = await ruleset.extract(html, url);
            const gtin14 = typeof data.fields.gtin14 === 'string' ? data.fields.gtin14 : undefined;
            return { itemId, url, data, gtin14 };
          } catch (err) {
            // eslint-disable-next-line no-console
            console.warn(`[resolve] ${sanitizeForLog(site)}/${sanitizeForLog(itemId)} failed: ${sanitizeForLog(err instanceof Error ? err.message : String(err))}`);
            failed.push(itemId);
            return null;
          }
        }),
      );

      return { site, results: settled.filter((r): r is ResolveItem => r !== null), unsupported: false, failed };
    },
  };
}
