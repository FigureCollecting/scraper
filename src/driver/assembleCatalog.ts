/**
 * assembleCatalog — the newest-first CATALOG LISTING runtime: the enumeration feed behind
 * GET /catalog that the crawler (recent + backfill modes) walks page by page. One store, one page
 * per call: `catalog(siteId, page)` resolves the store's `retrieval.byListing` page url, fetches it
 * through the store's declared search transport under the shared challenge-cooldown gate, parses it
 * via the ruleset's `extractListing`, and decorates every listed id with its collect-ready URL
 * (`withCollectUrl` — the same byId-else-page-link rule /lookup applies to candidates).
 *
 * The result is a DISCRIMINATED UNION, never a throw: `ok` (items + paging signals), `unsupported`
 * (unknown store / no byListing axis / no extractListing parser — a coverage gap, not a failure),
 * `cooldown` (the listing host is cooling from a recent CF challenge — skipped WITHOUT fetching), or
 * `failed` (challenge page → the host cooldown is opened; fetch error; timeout; parser throw).
 * Plugin output is UNTRUSTED at runtime and guarded field by field. Everything is injected
 * (LookupServices shape) so the flow is deterministic in tests.
 */
import { resolveListingUrl } from './retrievalPlanner.js';
import { withCollectUrl, withTimeout, type LookupServices } from './assembleLookup.js';
import { sanitizeForLog } from '../utils/security.js';
import { isCloudflareChallenge } from '../services/engineServices/challengeDetect.js';
import { getChallengeCooldown, normalizeHost } from '../services/challengeCooldown.js';
import type { ListingPage } from '@figurecollecting/scraper-plugin-contract';

/** The catalog runtime takes exactly the lookup's injected services (registry, ruleset lookup, fetch, cooldown). */
export type CatalogServices = LookupServices;

/** A listed item as /catalog returns it: the contract's listing item plus the engine-derived `collectUrl`. */
export type CatalogItem = ListingPage['items'][number] & { collectUrl?: string };

export type CatalogResult =
  | {
      status: 'ok';
      siteId: string;
      page: number;
      url: string;
      items: CatalogItem[];
      /** The collect-ready urls of `items` (those that have one), in listing order — the crawler's enqueue list. */
      collectUrls: string[];
      hasMore: boolean;
      nextPage?: number;
      count: number;
    }
  | { status: 'unsupported'; siteId: string; reason: string }
  | { status: 'cooldown'; siteId: string; host: string; remainingMs: number }
  | { status: 'failed'; siteId: string; reason: string };

export interface Catalog {
  /** One page of `siteId`'s newest-first listing; `page` defaults to the store's `byListing.pageStart` (else 1). */
  catalog(siteId: string, page?: number): Promise<CatalogResult>;
}

/** Listing-fetch timeout (ms) used when CATALOG_STORE_TIMEOUT_MS is unset/invalid, and the clamp any override rides within. */
const DEFAULT_CATALOG_TIMEOUT_MS = 30000;
const MIN_CATALOG_TIMEOUT_MS = 1000;
const MAX_CATALOG_TIMEOUT_MS = 120000;

/**
 * Resolve the listing-fetch timeout (ms) from the environment. CATALOG_STORE_TIMEOUT_MS overrides the
 * 30s default (a catalog page is a 1.5–2MB body on orzgk — wider than a search hit); a missing,
 * empty, non-numeric, or non-positive value falls back to the default, and any usable value is
 * clamped to [1000, 120000]. Pure (env in → number out) — mirrors resolveLookupStoreTimeoutMs.
 */
export function resolveCatalogStoreTimeoutMs(env: NodeJS.ProcessEnv): number {
  const n = Number(env.CATALOG_STORE_TIMEOUT_MS);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_CATALOG_TIMEOUT_MS;
  return Math.min(MAX_CATALOG_TIMEOUT_MS, Math.max(MIN_CATALOG_TIMEOUT_MS, n));
}

/** An untrusted listing item is kept only as `{ itemId, url? }` with a non-empty string itemId. */
const normalizeItem = (raw: unknown): ListingPage['items'][number] | undefined => {
  if (!raw || typeof raw !== 'object') return undefined;
  const { itemId, url } = raw as { itemId?: unknown; url?: unknown };
  if (typeof itemId !== 'string' || itemId.length === 0) return undefined;
  return typeof url === 'string' ? { itemId, url } : { itemId };
};

export function assembleCatalog(services: CatalogServices): Catalog {
  // Resolved ONCE per assembly (not per call), like the lookup's module-load resolution.
  const timeoutMs = resolveCatalogStoreTimeoutMs(process.env);
  const cd = services.challengeCooldown ?? getChallengeCooldown();

  return {
    async catalog(siteId, page) {
      const caps = services.profiles.forSite(siteId);
      if (!caps) return { status: 'unsupported', siteId, reason: 'unknown store' };
      const byListing = caps.retrieval?.byListing;
      if (!byListing) return { status: 'unsupported', siteId, reason: 'store declares no byListing axis' };
      const pageNo = page ?? byListing.pageStart ?? 1;
      const url = resolveListingUrl(caps.retrieval, pageNo);
      if (!url) return { status: 'failed', siteId, reason: `invalid page ${pageNo} (must be a positive integer)` };
      let host: string;
      try {
        host = normalizeHost(new URL(url).hostname);
      } catch {
        return { status: 'unsupported', siteId, reason: 'malformed byListing url template' };
      }
      const ruleset = services.getRulesetForUrl(url);
      if (!ruleset?.extractListing) return { status: 'unsupported', siteId, reason: 'ruleset has no extractListing parser' };

      // CHALLENGE COOLDOWN gate, keyed by the host actually fetched (a sibling api. host cools on its
      // own): a cooling host is skipped WITHOUT fetching — a challenge fetch degrades the egress IP's
      // CF reputation — and reported as `cooldown` (the store is fine; we are leaving it alone).
      if (cd.isOpen(host)) {
        const remainingMs = cd.remaining(host);
        const minsLeft = Math.max(1, Math.ceil(remainingMs / 60_000));
        // eslint-disable-next-line no-console
        console.warn(`[COOLDOWN] skipped ${sanitizeForLog(url)} (${host} cooling, ${minsLeft} min left)`);
        return { status: 'cooldown', siteId, host, remainingMs };
      }

      try {
        // The STORE's declared search transport (impersonate / browser / http), resolved from its
        // primary domain exactly as /lookup does — the listing may live on a sibling host (api.)
        // the store's domains don't list. BOUNDED so a hung / CF-stalled store fails, not stalls.
        const transport = services.profiles.searchTransportFor(caps.domains[0] ?? host);
        const body = await withTimeout(services.fetchSearch(url, transport), timeoutMs, 'catalog fetch');
        // HONEST LISTING: a CF challenge/block body is NOT a catalog page — extractListing would
        // lift 0 items and pose the page as "end of catalog". Detect it BEFORE parsing, open the
        // host's cooldown so the queue and the next crawl leave it alone, and report failed.
        if (isCloudflareChallenge(body)) {
          // eslint-disable-next-line no-console
          console.warn(`[catalog] ${sanitizeForLog(siteId)} page ${pageNo} failed: challenge page`);
          cd.open(host, 'catalog challenge page');
          return { status: 'failed', siteId, reason: 'challenge page' };
        }
        // UNTRUSTED plugin output: a non-object page → no items; a non-array `items` → none; each
        // item must be an object with a non-empty string itemId (else dropped); paging signals are
        // used only when well-typed, else derived (non-empty page ⇒ more; next = page + 1).
        const listing: unknown = await ruleset.extractListing(body, url);
        const raw = listing && typeof listing === 'object' ? (listing as Partial<ListingPage>) : {};
        const items = Array.isArray(raw.items)
          ? raw.items.map(normalizeItem).filter((it): it is ListingPage['items'][number] => it !== undefined)
          : [];
        const hasMore = typeof raw.hasMore === 'boolean' ? raw.hasMore : items.length > 0;
        const nextPage = Number.isInteger(raw.nextPage) && (raw.nextPage as number) > pageNo
          ? (raw.nextPage as number)
          : hasMore ? pageNo + 1 : undefined;
        const decorated: CatalogItem[] = items.map((it) => withCollectUrl(it, caps.retrieval, url));
        const collectUrls = decorated.map((it) => it.collectUrl).filter((u): u is string => typeof u === 'string' && u.length > 0);
        return {
          status: 'ok',
          siteId,
          page: pageNo,
          url,
          items: decorated,
          collectUrls,
          hasMore,
          ...(nextPage !== undefined ? { nextPage } : {}),
          count: decorated.length,
        };
      } catch (err) {
        // Surface WHY the page dropped (CF block / transport error / timeout / parser throw) — sanitized.
        const reason = sanitizeForLog(err instanceof Error ? err.message : String(err));
        // eslint-disable-next-line no-console
        console.warn(`[catalog] ${sanitizeForLog(siteId)} page ${pageNo} failed: ${reason}`);
        return { status: 'failed', siteId, reason };
      }
    },
  };
}
