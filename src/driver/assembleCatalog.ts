/**
 * assembleCatalog — the newest-first CATALOG LISTING runtime: the enumeration feed behind
 * GET /catalog that the crawler (recent + backfill modes) walks page by page. One store, one page
 * per call: `catalog(siteId, page)` resolves the store's `retrieval.byListing` page url, fetches it
 * through the store's declared search transport under the shared challenge-cooldown gate, parses it
 * via the ruleset's `extractListing`, and decorates every listed id with its collect-ready URL
 * (`withCollectUrl` — the same byId-else-page-link rule /lookup applies to candidates).
 *
 * The same runtime also serves the ID-RANGE axis (`idRange`, GET /catalog?store=&range=1&from=&count=):
 * for a store whose `retrieval.byRange` declares its ids sequential, a descending window of the id
 * space IS the listing, so the window is SYNTHESIZED from `byId.urlTemplate` with no fetch at all.
 * The capability resolution lives here (where the profile registry is); the frontier, the cursor and
 * the dedup stay with the crawler.
 *
 * The result is a DISCRIMINATED UNION, never a throw: `ok` (items + paging signals), `unsupported`
 * (unknown store / no byListing axis / no extractListing parser — a coverage gap, not a failure),
 * `cooldown` (the listing host is cooling from a recent CF challenge — skipped WITHOUT fetching), or
 * `failed` (challenge page → the host cooldown is opened; fetch error; timeout; parser throw).
 * A challenge on a host WITH stored cookies (CfCookieStore) also marks that host's cookie stale; a
 * clean listing marks it fresh — the operator's re-mint signal, surfaced on /health/detailed.
 * Plugin output is UNTRUSTED at runtime and guarded field by field. Everything is injected
 * (LookupServices shape) so the flow is deterministic in tests.
 */
import { resolveByIdUrl, resolveListingUrl } from './retrievalPlanner.js';
import { withCollectUrl, withTimeout, type LookupServices } from './assembleLookup.js';
import { sanitizeForLog } from '../utils/security.js';
import { isCloudflareChallenge } from '../services/engineServices/challengeDetect.js';
import { getChallengeCooldown, normalizeHost } from '../services/challengeCooldown.js';
import { getCfCookieStore, markStaleIfStored, markFreshIfStored } from '../services/cookieJar.js';
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

/**
 * One SYNTHESIZED window of a `byRange` store's id space, walking DOWN from `from`. Shaped like the
 * listing result (`items` + `collectUrls` + a paging signal) so the crawler consumes both axes with
 * one parser; `nextFrom` is the next id below the window (absent once the walk reaches id 1).
 */
export type IdRangeResult =
  | {
      status: 'ok';
      siteId: string;
      from: number;
      items: CatalogItem[];
      collectUrls: string[];
      hasMore: boolean;
      nextFrom?: number;
      count: number;
    }
  | { status: 'unsupported'; siteId: string; reason: string }
  | { status: 'cooldown'; siteId: string; host: string; remainingMs: number }
  | { status: 'failed'; siteId: string; reason: string };

/** Default and clamp for an id-range window's size (ids per call). */
const DEFAULT_ID_RANGE_COUNT = 50;
const MAX_ID_RANGE_COUNT = 200;

export interface Catalog {
  /** One page of `siteId`'s newest-first listing; `page` defaults to the store's `byListing.pageStart` (else 1). */
  catalog(siteId: string, page?: number): Promise<CatalogResult>;
  /**
   * One descending window of `siteId`'s SEQUENTIAL id space — `count` ids from `from` down, each
   * decorated with the collect URL its `byId.urlTemplate` builds. It fetches nothing and parses
   * nothing, because a store that declares `retrieval.byRange` has already told us its ids are
   * enumerable — the id space IS the listing. It DOES consult the challenge cooldown of the host the
   * window's urls point at: every id in a window handed out while that host is cooling would be
   * POSTed, ledgered as done and walked past, only to fast-fail in the ingest queue — the ids would
   * be burned, and this axis walks each id exactly once. Ids in the window that do not exist at the
   * store are EXPECTED and surface downstream as the ingest fetch's own 404; this surface never
   * probes them. `count` defaults to 50 and is clamped to [1, 200].
   */
  idRange(siteId: string, from: number, count?: number): IdRangeResult;
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
  const cfStore = services.cfCookieStore ?? getCfCookieStore();

  return {
    idRange(siteId, from, count) {
      const caps = services.profiles.forSite(siteId);
      if (!caps) return { status: 'unsupported', siteId, reason: 'unknown store' };
      // byRange is the store's DECLARATION that its ids are sequential/enumerable; byId is what turns
      // one of those ids into a fetchable URL. Neither alone makes a walk valid.
      if (caps.retrieval?.byRange !== true) return { status: 'unsupported', siteId, reason: 'store declares no byRange axis' };
      const byIdTemplate = caps.retrieval?.byId?.urlTemplate;
      if (!byIdTemplate) return { status: 'unsupported', siteId, reason: 'store declares no byId axis to build item urls from' };
      // Without the placeholder every id in the window resolves to the SAME url: the queue would
      // coalesce them onto one fetch while the crawler ledgered each id as done and walked past it.
      if (!byIdTemplate.includes('{id}')) return { status: 'unsupported', siteId, reason: 'byId urlTemplate has no {id} placeholder to walk' };
      if (!Number.isSafeInteger(from) || from < 1) {
        return { status: 'failed', siteId, reason: `invalid from ${from} (must be a positive integer)` };
      }
      // CHALLENGE COOLDOWN gate, keyed by the host the window's own item urls point at — the same
      // gate the listing axis applies before fetching. A window handed out now would be enqueued in
      // full, ledgered and walked past while every item fast-fails on the cooling host.
      const first = resolveByIdUrl(caps.retrieval, String(from));
      let host: string;
      try {
        host = normalizeHost(new URL(first as string).hostname);
      } catch {
        return { status: 'unsupported', siteId, reason: 'malformed byId url template' };
      }
      if (cd.isOpen(host)) return { status: 'cooldown', siteId, host, remainingMs: cd.remaining(host) };
      const size = Math.min(MAX_ID_RANGE_COUNT, Math.max(1, Number.isSafeInteger(count) ? (count as number) : DEFAULT_ID_RANGE_COUNT));
      const lowest = Math.max(1, from - size + 1);
      const items: CatalogItem[] = [];
      for (let id = from; id >= lowest; id--) {
        const collectUrl = resolveByIdUrl(caps.retrieval, String(id));
        items.push(collectUrl ? { itemId: String(id), collectUrl } : { itemId: String(id) });
      }
      const collectUrls = items.map((it) => it.collectUrl).filter((u): u is string => typeof u === 'string' && u.length > 0);
      const hasMore = lowest > 1;
      return {
        status: 'ok',
        siteId,
        from,
        items,
        collectUrls,
        hasMore,
        ...(hasMore ? { nextFrom: lowest - 1 } : {}),
        count: items.length,
      };
    },

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
          // STORED-COOKIE STALE signal: a host WITH stored cookies still challenged → dead cookie,
          // marked once via the lane that fetched (a host without stored cookies is never marked).
          markStaleIfStored(cfStore, url, host, transport.transport ?? 'http', 'catalog challenge page');
          return { status: 'failed', siteId, reason: 'challenge page' };
        }
        // A clean listing for a host WITH stored cookies is the FRESH signal (clears a stale mark).
        markFreshIfStored(cfStore, url, host);
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
