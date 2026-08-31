/**
 * assembleLookup — the cross-store SEARCH runtime: the buy-decision fan-out. Two entrypoints over
 * one shared fan-out:
 *   - `lookup(query)`            — DISCOVERY: a free-text query fanned across every store's bySearch.
 *   - `lookupByIdentity(identity)` — RECORD-MODE: a typed IdentityQuery (the caller has a catalogued
 *     figure); the planner composes EACH store's query server-side — JAN-exact where the store's
 *     bySearch `acceptsGtin`, a barcode-byId detail plan (plazajapan), else a composed name/ER query.
 *
 * TWO MODES over ONE fetch: `listed` (all, incl. sold-out) vs `orderable` (drop `available === false`).
 * A barcode-byId store yields a single "direct-hit" candidate (itemId = the gtin14) the caller
 * confirms via /resolve — no search/parse. Everything is injected so the fan-out is deterministic.
 *
 * SUBSTRING-MATCH stores (Ueeshop/gkloot, `bySearch.queryMatch === 'substring'`) are issued the single
 * most selective identity term and their candidates are POST-FILTERED by the remaining identity tokens
 * (a multi-term phrase would match nothing). Each per-store result reports `storeQuery` (the exact `{q}`
 * issued to that store) and, when that post-filter ran, `filtered` (how many candidates it removed).
 */
import { planRetrieval, composeNameQuery, normalizeText } from './retrievalPlanner.js';
import { sanitizeForLog } from '../utils/security.js';
import type { ProfileRegistry } from './profileRegistry.js';
import type { ExtractionRuleset, IdentityQuery, SearchCandidate, SearchFetch } from '@figurecollecting/scraper-plugin-contract';

export type LookupMode = 'listed' | 'orderable';

export interface LookupServices {
  /** The store registry (built from the engine's registered capabilities). */
  profiles: ProfileRegistry;
  /** URL → ruleset (engine ExtractionRegistryImpl.getRulesetForUrl); the ruleset parses candidates. */
  getRulesetForUrl: (url: string) => ExtractionRuleset | undefined;
  /**
   * Fetch a store's search-results body given the store's resolved search transport (http /
   * impersonate / browser + its per-store headers/profile). Built by the engine (makeFetchSearch)
   * and injected here, so the fan-out stays deterministic in tests.
   */
  fetchSearch: (url: string, searchFetch: SearchFetch) => Promise<string>;
}

export interface StoreLookupResult {
  siteId: string;
  host: string;
  url: string;
  /** The exact `{q}` issued to this store: a substring store's selective term, else the composed phrase. */
  storeQuery: string;
  candidates: SearchCandidate[];
  /** Candidates the substring-store identity post-filter removed (present ONLY when that filter ran). */
  filtered?: number;
}

/**
 * A barcode-byId direct hit (record-mode): a store whose byId URL IS the barcode, so a JAN resolves
 * straight to a product page. It is NOT a screen candidate — it is UNVERIFIED (never fetched), so it
 * is segregated here rather than surfaced as a phantom candidate; the caller confirms it via /resolve.
 */
export interface ResolveTarget {
  siteId: string;
  host: string;
  itemId: string;
  url: string;
}

export interface LookupResult {
  query: string;
  mode: LookupMode;
  results: StoreLookupResult[];
  /** Stores that cannot serve the search: no `bySearch` axis, or no `extractCandidates` parser. */
  unsupported: string[];
  /**
   * Stores that DID return results but whose search is `orderable`-scope — a `listed` query can't
   * confirm their sold-out items (coverage caveat, not a failure). Always empty in `orderable` mode.
   */
  orderableOnly: string[];
  /** Stores whose search fetch or parse errored (transparency, not silent drop). */
  failed: string[];
  /**
   * Barcode-byId direct hits (record-mode only): stores where the JAN resolves straight to a byId
   * URL. UNVERIFIED — the caller confirms each via /resolve (which returns the full record incl
   * price/availability). Kept OUT of `results` so an unfetched hit never poses as a real candidate.
   */
  resolveTargets: ResolveTarget[];
}

export interface Lookup {
  /** DISCOVERY: fan a free-text query across every store's bySearch. */
  lookup(query: string, opts?: { mode?: LookupMode }): Promise<LookupResult>;
  /** RECORD-MODE: fan a typed identity across stores, composing each store's query server-side. */
  lookupByIdentity(identity: IdentityQuery, opts?: { mode?: LookupMode }): Promise<LookupResult>;
}

/** Representative `query` label for a record-mode result: the JAN if present, else the composed name. */
const identityLabel = (identity: IdentityQuery): string => identity.gtin14 ?? composeNameQuery(identity) ?? '';

export function assembleLookup(services: LookupServices): Lookup {
  const runFanout = async (
    plan: ReturnType<typeof planRetrieval>,
    mode: LookupMode,
    query: string,
  ): Promise<LookupResult> => {
    const unsupported = [...plan.unsupported];
    const orderableOnly: string[] = [];
    const failed: string[] = [];
    const resolveTargets: ResolveTarget[] = [];

    const settled = await Promise.all(
      plan.plans.map(async (p): Promise<StoreLookupResult | null> => {
        // Barcode-byId direct hit (record-mode): a RESOLVE TARGET, not a screen candidate. It is
        // UNVERIFIED (we haven't fetched it), so segregate it into resolveTargets — never surface it
        // as a phantom candidate (no name=barcode into the matcher, no unfetched hit in orderable mode).
        if (p.kind === 'detail') {
          resolveTargets.push({ siteId: p.siteId, host: p.host, itemId: p.itemId ?? '', url: p.url });
          return null;
        }

        const ruleset = services.getRulesetForUrl(p.url);
        if (!ruleset?.extractCandidates) {
          unsupported.push(p.siteId); // has a bySearch URL but no parser yet
          return null;
        }
        const scope = services.profiles.retrievalFor(p.host)?.bySearch?.scope ?? 'listed';
        if (mode === 'listed' && scope === 'orderable') orderableOnly.push(p.siteId);
        try {
          const body = await services.fetchSearch(p.url, services.profiles.searchTransportFor(p.host));
          let candidates = await ruleset.extractCandidates(body, p.url);
          // Substring-store identity post-filter (record-mode): the store matched only the single
          // selective term issued as `{q}`, so drop candidates whose normalized name lacks any remaining
          // identity token. Runs BEFORE the orderable cut so `filtered` counts identity mismatches only.
          let filtered: number | undefined;
          if (p.filter?.length) {
            const kept = candidates.filter((c) => {
              // Plugin output is untrusted at runtime: a non-string name can't match identity, so
              // drop it as a non-match — never let it throw and take the WHOLE store into `failed`.
              const name = typeof c.name === 'string' ? normalizeText(c.name) : '';
              return p.filter!.every((tok) => name.includes(tok));
            });
            filtered = candidates.length - kept.length;
            candidates = kept;
          }
          if (mode === 'orderable') candidates = candidates.filter((c) => c.available !== false);
          return { siteId: p.siteId, host: p.host, url: p.url, storeQuery: p.query ?? '', candidates, ...(filtered !== undefined ? { filtered } : {}) };
        } catch (err) {
          // Surface WHY a store dropped out (CF block / invalid impersonation profile / parse error).
          // eslint-disable-next-line no-console
          console.warn(`[lookup] ${sanitizeForLog(p.siteId)} search failed: ${sanitizeForLog(err instanceof Error ? err.message : String(err))}`);
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
      resolveTargets,
    };
  };

  return {
    async lookup(query, opts = {}) {
      return runFanout(planRetrieval(services.profiles, { mode: 'lookup', query }), opts.mode ?? 'listed', query);
    },
    async lookupByIdentity(identity, opts = {}) {
      return runFanout(planRetrieval(services.profiles, { mode: 'record', identity }), opts.mode ?? 'listed', identityLabel(identity));
    },
  };
}
