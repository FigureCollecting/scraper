/**
 * assembleResolve — the byId CONFIRM runtime (the matcher's pass-2 bridge, and /resolve's engine).
 * Given a store + item ids (e.g. the `resolveTargets` a record-mode lookup surfaced, or a candidate
 * the caller picked), it fetches each item's DETAIL page and dispatches the store's ruleset through
 * `extractRecords` (extractMany > extractAsync > extract — the SAME dispatch the ingest queue and
 * crawl worker use, engineServices/extractRecords.ts) → full `ExtractedData` (whose `fields.gtin14`
 * the private byId ruleset populates). `records[0]` (the page's own record) is the confirm's `data`;
 * an extractMany ruleset's EXTRA records (editions/offers) ride the additive `ResolveItem.records`.
 * Unlike the crawl worker, it RETURNS the data and NEVER emits to the spine or touches a ledger.
 *
 * Composed from existing primitives — `resolveByIdUrl` + an injected detail fetch + the shared
 * `extractRecords` dispatch (fed an `ExtractContext` via the optional `resolveContext` seam, the
 * crawlWorker pattern) — so it reuses the same substrate the crawl worker is built from, one layer
 * down, without the spine/ledger coupling. Everything injected → deterministic in tests.
 */
import { resolveByIdUrl } from './retrievalPlanner.js';
import { extractRecords } from '../services/engineServices/extractRecords.js';
import { sanitizeForLog } from '../utils/security.js';
import type { ProfileRegistry } from './profileRegistry.js';
import type { ExtractContext, ExtractedData, ExtractionRuleset } from '@figurecollecting/scraper-plugin-contract';

export interface ResolveServices {
  /** The store registry (built from the engine's registered capabilities). */
  profiles: ProfileRegistry;
  /** URL → ruleset (engine ExtractionRegistryImpl.getRulesetForUrl); the ruleset's extract() confirms. */
  getRulesetForUrl: (url: string) => ExtractionRuleset | undefined;
  /** Fetch a detail page's body (the pooled ScrapingService's scrapePage at the mount). */
  fetchDetail: (url: string) => Promise<{ html: string; statusCode?: number }>;
  /**
   * OPTIONAL per-id `ExtractContext` resolver (the crawlWorker `resolveContext` seam): the wiring
   * (engineResolve) builds it via `buildExtractContext`, so an extractAsync/extractMany ruleset's
   * follow-up fetches ride the store's declared transport into the capture sink, courtesy-gapped
   * against `primaryFetchedAt` (epoch ms when THIS id's detail fetch completed).
   */
  resolveContext?: (ruleset: ExtractionRuleset, url: string, primaryFetchedAt: number) => ExtractContext | undefined;
  /** Injectable clock anchoring `primaryFetchedAt` (default `Date.now`). */
  now?: () => number;
}

export interface ResolveItem {
  itemId: string;
  url: string;
  /** The confirmed record when fetch + extract succeeded. */
  data?: ExtractedData;
  /**
   * ADDITIVE (multi-record rulesets only): the records BEYOND the page's own — extractMany's
   * children (editions/offers), in the same target-first order the ingest path emits them. ABSENT
   * when extraction yielded exactly one record, so single-record confirms keep today's shape
   * byte-for-byte. `data` above is always `records[0]` of the full extraction (the listing/parent).
   */
  records?: ExtractedData[];
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
            // The courtesy-gap anchor: the instant the PRIMARY detail fetch completed (D8), so a
            // same-host ctx.scraping.fetchBody follow-up waits the store's gap against THIS fetch.
            const primaryFetchedAt = (services.now ?? Date.now)();
            // Same dispatch as ingest/crawl: extractMany > extractAsync > extract, D11-guarded —
            // a guard violation throws into this id's OWN failure handling below, same as ingest.
            const records = await extractRecords(
              ruleset,
              html,
              url,
              services.resolveContext?.(ruleset, url, primaryFetchedAt),
            );
            const data = records[0];
            const gtin14 = typeof data.fields.gtin14 === 'string' ? data.fields.gtin14 : undefined;
            return { itemId, url, data, ...(records.length > 1 ? { records: records.slice(1) } : {}), gtin14 };
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
