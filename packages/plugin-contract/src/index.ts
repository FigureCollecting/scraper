/**
 * Plugin contract — single source of truth for the ScraperPlugin contract.
 *
 * Published as @figurecollecting/scraper-plugin-contract and consumed by both
 * the scraper engine and ruleset plugin packages, so the two sides can never
 * drift. The engine intentionally does NOT depend on any private ruleset
 * package (credential-free, publicly shippable): any package implementing the
 * shapes below can register itself with the engine at runtime, without the
 * engine importing anything private.
 */

export interface ScraperPlugin {
  name: string;
  version: string;
  register(registry: ExtractionRegistry, context: PluginContext): Promise<void>;
  registerRoutes?(router: ExpressRouter): void;
  shutdown?(): Promise<void>;
}

export interface ExtractionRegistry {
  registerSite(config: SiteConfig): void;
  registerRuleset(ruleset: ExtractionRuleset): void;
}

export interface PluginContext {
  logger: PluginLogger;
  config: RuntimeConfig;
  services: EngineServices;
}

// ============================================================================
// Engine Services — provided by the scraper engine via PluginContext.services
// ============================================================================

export interface EngineServices {
  scraping: ScrapingService;
  queue: QueueService;
  sessions: SessionService;
  webhooks: WebhookService;
}

export interface ScrapePageOptions {
  waitTime?: number;
  userAgent?: string;
  cookies?: Record<string, string>;
  cloudflareDetection?: {
    titleIncludes?: string[];
    bodyIncludes?: string[];
  };
}

export interface ScrapePageResult {
  html: string;
  /** The url that was REQUESTED. Echoed back verbatim — never the page's post-redirect location. */
  url: string;
  title: string;
  statusCode?: number;
  /**
   * The url the navigation actually ENDED on, when the served response reported one. Distinct from
   * `url` precisely because a redirect makes them differ: an item URL that lands on a store's front
   * page is how a dead item presents itself on a rendered store. ABSENT when the response reported
   * nothing — a caller must never read a fabricated final url, so there is no fallback to `url`.
   */
  finalUrl?: string;
}

export interface PageOptions {
  stealth?: boolean;
  viewport?: { width: number; height: number };
  userAgent?: string;
}

export interface BrowserFetchOptions {
  /** Use the stealth browser. Defaults to true — browserFetch exists for CF-fronted / SPA hosts. */
  stealth?: boolean;
  userAgent?: string;
  cookies?: Record<string, string>;
  /** Extra request headers (e.g. an API key header for a same-origin JSON endpoint). */
  headers?: Record<string, string>;
}

export interface ScrapingService {
  scrapePage(url: string, options?: ScrapePageOptions): Promise<ScrapePageResult>;
  scrapePageStealth(url: string, options?: ScrapePageOptions): Promise<ScrapePageResult>;
  /**
   * Fetch a URL's raw BODY through a managed browser page — the browser-backed counterpart to a
   * plain HTTP GET, for CF-fronted / SPA hosts a plain fetch can't reach. Returns the raw JSON body
   * for a JSON response (bypassing Chrome's JSON-viewer DOM) or the fully-rendered HTML otherwise.
   * Extraction stays the caller's job (feeds the lookup's per-host `browserFetchBody`).
   */
  browserFetch(url: string, options?: BrowserFetchOptions): Promise<string>;
  withBrowser<T>(fn: (browser: any) => Promise<T>): Promise<T>;
  withPage<T>(fn: (page: any) => Promise<T>, options?: PageOptions): Promise<T>;
}

export type QueuePriority = 'HOT' | 'WARM' | 'COLD';
export type ItemStatus = 'owned' | 'ordered' | 'wished';

export interface EnqueueOptions {
  priority?: QueuePriority;
  status?: ItemStatus;
  cookies?: Record<string, string>;
  sessionId?: string;
  userId?: string;
}

export interface EnqueueResult {
  itemId: string;
  deduplicated: boolean;
  position?: number;
}

export interface QueueStats {
  hot: number;
  warm: number;
  cold: number;
  total: number;
  processing: number;
  completed: number;
  failed: number;
  rateLimited: boolean;
  currentDelay: number;
}

export interface QueueService {
  enqueue(itemId: string, options?: EnqueueOptions): EnqueueResult;
  enqueueBulk(items: Array<{ itemId: string; options?: EnqueueOptions }>): EnqueueResult[];
  getStats(): QueueStats;
  resumeSession(sessionId: string): boolean;
  cancelFailedItems(sessionId: string): number;
  cancelAllForSession(sessionId: string): number;
  reset?(): void;
}

export interface SessionInfo {
  sessionId: string;
  isPaused: boolean;
  inCooldown: boolean;
  failureCount: number;
  totalItems: number;
  processedItems: number;
}

export interface SessionService {
  getAllSessions(): SessionInfo[];
  validateSession(sessionId: string): boolean;
  reportPause(sessionId: string, reason: string): void;
  reportFailure(sessionId: string, itemId: string, error: string): void;
}

export interface WebhookConfig {
  webhookUrl: string;
  webhookSecret: string;
  sessionId: string;
}

export interface PhaseChangePayload {
  sessionId: string;
  phase: string;
  message?: string;
  items?: Array<{
    mfcId: string;
    name?: string;
    collectionStatus: string;
    isNsfw?: boolean;
    mfcActivityOrder?: number;
    isOrphan?: boolean;
  }>;
}

export interface ListsSyncPayload {
  sessionId: string;
  lists: Array<{
    mfcId: number;
    name: string;
    teaser?: string;
    description?: string;
    privacy: string;
    iconUrl?: string;
    itemCount: number;
    itemMfcIds?: number[];
    itemDetails?: Array<{ mfcId: number; name?: string; imageUrl?: string }>;
    mfcCreatedAt?: string;
  }>;
}

export interface ItemCompletePayload {
  sessionId: string;
  mfcId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'skipped';
  error?: string;
  scrapedData?: Record<string, unknown>;
}

export interface WebhookService {
  registerConfig(config: WebhookConfig): void;
  unregisterConfig(sessionId: string): void;
  notifyItemComplete(payload: ItemCompletePayload): Promise<boolean>;
  notifyPhaseChange(payload: PhaseChangePayload): Promise<boolean>;
  notifyListsSync(payload: ListsSyncPayload): Promise<boolean>;
}

// ============================================================================
// Site Configuration & Extraction
// ============================================================================

export interface SiteConfig {
  siteId: string;
  name: string;
  domains: string[];
  rateLimit: DomainRateLimit;
  requiresBrowser: boolean;
  allowedCookies: string[];
}

export interface DomainRateLimit {
  domain: string;
  baseDelayMs: number;
  minDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  recoveryDivisor: number;
  successThreshold: number;
}

/**
 * Targeted-retrieval addressability — how SPECIFIC items are fetched ON REQUEST (by id, a
 * bounded id range, a batch/list of ids, or a name/keyword search), as opposed to full-catalog
 * discovery. This is what enables range-limited on-request fetches and cross-store lookup. The
 * per-store DATA is supplied by the plugin (mapped down from the private profile registry); the
 * engine consumes only this generic shape.
 */
export interface RetrievalCapability {
  /** Build an item URL/endpoint from an identifier; `{id}` is substituted. `idKind` names the id. */
  byId?: { urlTemplate: string; idKind?: string };
  /** Identifiers are sequential/enumerable, so a bounded [from,to] sweep is valid. */
  byRange?: boolean;
  /** One endpoint returns up to `maxBatch` items per call (cheaper than N by-id fetches). */
  byBatch?: { maxBatch: number };
  /**
   * Map a free-text query (name/keyword) to candidate items; `{q}` is substituted. `scope`
   * declares what the endpoint returns: `listed` = ALL matching items incl. sold-out (the
   * superset — answers "which stores carry this"); `orderable` = only in-stock/buyable items
   * (some stores' predictive endpoints, e.g. a Shopify `suggest.json` config, silently hide
   * sold-out). Absent scope defaults to `listed`. A `listed` endpoint + `SearchCandidate.available`
   * serves BOTH buy-decision modes; an `orderable`-only endpoint cannot answer the `listed` view.
   * `acceptsGtin` = the endpoint full-texts a GTIN/barcode as the `{q}` (amiami/Woo/PrestaShop), so
   * record-mode can substitute a JAN for a JAN-EXACT hit; absent = title-only (Shopify suggest), so
   * record-mode falls back to a composed name/ER query. Filled by the plugin from `identity.keys`.
   * `queryMatch` = how the store's search interprets `{q}`: `tokens` (the default, today's behavior)
   * matches the query WORDS against the product name (token/keyword index); `substring` matches `{q}`
   * as ONE contiguous case-insensitive substring of the product name (Ueeshop/gkloot), so a multi-term
   * identity PHRASE matches nothing. For a `substring` store the engine issues the single most
   * selective identity term as `{q}` and POST-FILTERS the candidates by the remaining identity terms.
   */
  bySearch?: {
    urlTemplate: string;
    scope?: 'listed' | 'orderable';
    acceptsGtin?: boolean;
    queryMatch?: 'tokens' | 'substring';
    /** How `{q}` must be ENCODED into the template (see {@link QueryEncoding}). Absent ⇒ one `encodeURIComponent`. */
    queryEncoding?: QueryEncoding;
  };
  /**
   * Newest-first PAGED catalog listing for ENUMERATION — the feed for recent/backfill crawls (a
   * recent crawl walks the first pages for fresh ids; a backfill resumes a saved page cursor
   * deeper in). Page N is fetched by substituting `{page}` (which the template MUST contain) with
   * the page number; `pageStart` is the first page (default 1); `maxPerPage` documents the store's
   * page-size cap; `order` is `newest` — the ONLY order the feeder reasons about (publish-date
   * desc, so page 1 is the freshest). Each page body is parsed by `ExtractionRuleset.extractListing`.
   */
  byListing?: { urlTemplate: string; pageStart?: number; maxPerPage?: number; order: 'newest' };
  /**
   * DECLARED SEED LISTS — the finite, named set of URL-addressable pages this store may be POLLED
   * from on a SLOW cadence. Each entry is one whole page (no paging, no cursor, no walk): the
   * engine fetches its `url` and the ruleset's {@link ExtractionRuleset.extractSeedList} parses it
   * into a {@link ListingPage}. Declared ONCE, in the order the operator wants them polled.
   *
   * This is deliberately NOT a second enumeration axis. `byListing` walks a store's whole catalogue
   * page after page; a seed list is a HANDFUL of curated pages a store publishes anyway — a shelf,
   * a "what's new" panel, a featured rail — polled at most daily to catch what a deep walk would
   * only reach much later. Because the set is finite and declared, the cost of the axis is knowable
   * before it runs, which is what makes it safe to point at a store that must be treated gently.
   *
   * `cadence` is the store's own answer to "how often is polling this list defensible" — `weekly`
   * or `daily`, never faster. `note` is free text for whoever reads the declaration later.
   */
  seedLists?: SeedList[];
}

/**
 * One declared seed list (see {@link RetrievalCapability.seedLists}). `id` names it — it is the
 * value the engine's seed axis is addressed by and the key its statistics are reported under, so it
 * must be unique within the store and stable across releases. `url` is the whole, fully-resolved
 * page to fetch: a seed list carries no `{page}` placeholder and no cursor, because a seed list is
 * ONE page by construction.
 */
export interface SeedList {
  /** Stable, store-unique name for this list — how the seed axis addresses it and reports on it. */
  id: string;
  /** The exact page to fetch. Fully resolved: no placeholder, no paging. */
  url: string;
  /** How often polling this list is defensible. A seed list is a slow poll — never faster than daily. */
  cadence: 'weekly' | 'daily';
  /** Free text for the reader: what this list is, why it earns a poll. */
  note?: string;
}

/**
 * How a store wants `{q}` ENCODED into its `bySearch.urlTemplate` — a DECLARATIVE spec, because the
 * one-size `encodeURIComponent` some storefronts accept is a BROKEN ROUTE at others. The engine
 * applies the steps in this fixed order and no other:
 *   1. `strip` — delete each declared substring from the RAW query, before any escaping.
 *   2. `encodeURIComponent(query)` — always, declaration or not.
 *   3. `reEncodePercentOf` — for each listed percent-escape, re-encode ITS OWN `%` (`%2f` → `%252f`),
 *      so the character survives the store's path/query parser instead of being read as structure.
 *      Matching is case-insensitive on the escape's hex; the output carries the escape exactly as
 *      DECLARED (declare `%2f` and the route gets `%252f`, lowercase f).
 *   4. `spaces` — `percent` leaves the `%20` that step 2 produced (the default); `plus` rewrites
 *      every `%20` to `+`.
 *   5. `lowercase` — lowercase the whole encoded segment.
 * Absent ⇒ step 2 alone: byte-identical to today for every store that does not declare it.
 *
 * The shape this exists for: a storefront that carries `{q}` in a PATH SEGMENT rather than a query
 * parameter. There a singly-escaped `/` is read as path STRUCTURE — the route does not match, the
 * store answers 404, and the caller cannot tell that from "no results". The character has to arrive
 * as data, which is what re-encoding its escape's own `%` achieves:
 * ```ts
 * bySearch: {
 *   urlTemplate: 'https://example.test/Search-{q}/list-r1.html',
 *   queryEncoding: { reEncodePercentOf: ['%2f'], spaces: 'plus', lowercase: true },
 * }
 * // "star origin 1/6" → "star+origin+1%252f6"  (a plain encodeURIComponent → "star%20origin%201%2F6")
 * ```
 * This is not cosmetic for a store whose records resolve by a scale-bearing identity: a query
 * carrying "1/6" is that store's NORMAL shape, and the naive encoding contributes zero candidates
 * for items it stocks.
 *
 * WHICH escapes a store re-encodes, WHICH substrings it strips and WHETHER it folds case are that
 * store's business and live in its own (private) plugin profile — the engine only replays what a
 * plugin hands it and never carries a store's rules itself.
 */
export interface QueryEncoding {
  /**
   * Substrings DELETED from the query before it is encoded — matched LITERALLY, not as a pattern.
   * For a store whose own client drops a character rather than escaping it: escaping it instead
   * emits a segment that store's search box could never have produced, and the SERP comes back
   * empty with no error to see.
   */
  strip?: string[];
  /**
   * Percent-escapes whose own `%` must be re-encoded (`'%2f'` ⇒ a literal `/` reaches the store as
   * `%252f`). Declare each escape as the store writes it — the declared spelling is what is emitted.
   */
  reEncodePercentOf?: string[];
  /** How a SPACE leaves the encoder: `percent` keeps `%20` (default), `plus` rewrites it to `+`. */
  spaces?: 'percent' | 'plus';
  /** Lowercase the finished segment (stores whose search index and route are both case-folded). */
  lowercase?: boolean;
}

export type SearchTransport = 'http' | 'impersonate' | 'browser';

/**
 * Session-prime declaration for a fully session-gated store (Cloudflare / 403-cold). A COLD fetch
 * (no prior same-session homepage GET) is challenged/blocked; the store returns real content only
 * after a SAME-SESSION homepage GET mints the clearance cookie. When declared, the engine's
 * impersonate (impit) transport GETs the prime URL ONCE per Impit session before the target fetch,
 * so the cached cookie jar carries the clearance into it. Honored by both the ingest raw-fetch and
 * the cross-store search; the impersonate lane is where it applies (the impit session persists
 * cookies per profile).
 *   - `true`               — prime the target URL's ORIGIN (its homepage).
 *   - `{ primeUrl: '…' }`  — prime an explicit URL instead of the origin.
 */
export type SessionPrime = boolean | { primeUrl?: string };

/**
 * Which EGRESS a store's fetches leave the engine through.
 *   - `direct`       — the engine's own network path (the node/pod IP). The implicit default.
 *   - `residential`  — route this store's fetches through the engine's configured RESIDENTIAL
 *                      proxy. For stores whose gate is IP/ASN REPUTATION rather than browser
 *                      fingerprint: they serve a challenge to any datacenter IP but real content to
 *                      a residential one, and their challenge-passage window is far shorter than a
 *                      hand-minted cookie can survive. Declaring it is a REQUIREMENT, never a hint:
 *                      with no residential proxy configured the engine REFUSES the fetch rather
 *                      than silently falling back to the node IP (which would both burn that IP's
 *                      reputation and reveal the attempt).
 */
export type EgressMode = 'direct' | 'residential';

/**
 * How a store's pages are GATED at the edge — what the fetching engine must expect at the door.
 *   - `open`        — no edge gate (the implicit default).
 *   - `cloudflare`  — the store sits behind a Cloudflare JS challenge. The engine's browser lane
 *                     KEEPS this host's browser context alive between fetches instead of opening a
 *                     fresh one per request: Cloudflare binds the clearance it issues to (IP, user
 *                     agent, browser context), so a fresh context re-runs the challenge on every
 *                     single fetch — slow, and one more challenge on the record each time — while a
 *                     kept context is served clean for the rest of the clearance window. Declaring
 *                     it is an optimisation, not a requirement: the engine also LEARNS the gate
 *                     from a `cf-mitigated: challenge` response, at the cost of one challenge per
 *                     cold host per process.
 */
export type StoreAccess = 'open' | 'cloudflare';

/**
 * Browser-lane READINESS for a client-rendered (PWA/SPA) storefront: what the lane must observe
 * AFTER `domcontentloaded` before it captures the page. Without it the lane captures the app SHELL
 * — the store's HTML skeleton with no product in it. All fields optional:
 *   - `selector`    — wait until this CSS selector is present in the DOM.
 *   - `networkIdle` — wait until the page's network goes quiet (the XHR/fetch hydration settles).
 *   - `timeoutMs`   — upper bound for the wait (engine default 15000, clamped to [1000, 60000]).
 * A wait that TIMES OUT is not fatal: the lane captures whatever rendered and logs one warning, so
 * a slow store degrades to today's behavior instead of failing the fetch. Undeclared ⇒ the lane
 * returns at `domcontentloaded` exactly as before.
 */
export interface WaitForReadiness {
  selector?: string;
  networkIdle?: boolean;
  timeoutMs?: number;
}

/**
 * Per-store fetch decoration for the cross-store SEARCH (`bySearch`) request: how the engine should
 * FETCH this store's search endpoint, and with what request headers/UA/cookies. Opaque to the engine
 * and filled by the plugin from the private profile (same pattern as `allowedCookies`/`rateLimit`).
 *   - `http`        — a plain HTTP GET (Tier-1 cookieless JSON; the implicit default when absent).
 *   - `impersonate` — a browser-TLS-impersonating HTTP GET (impit) with `browser` profile + `headers`;
 *                     reaches a Cloudflare-fronted JSON API (e.g. amiami) WITHOUT a real browser.
 *   - `browser`     — a full pooled browser navigation (rendered-DOM / JS-challenge stores).
 */
export interface SearchFetch {
  transport?: SearchTransport;
  /**
   * Impersonation profile for `transport: 'impersonate'` (the impit browser, e.g. 'chrome142').
   * A LIVE TUNABLE — bump it when Cloudflare tightens and an older profile's TLS fingerprint stops
   * passing (chrome110 already went stale). The engine supplies a recent default if omitted.
   */
  browser?: string;
  /** Extra request headers (e.g. amiami's static `X-User-Key: amiami_dev`). */
  headers?: Record<string, string>;
  userAgent?: string;
  /** Request-scoped cookies (e.g. a `cf_clearance` for the `browser` transport). */
  cookies?: Record<string, string>;
  /**
   * Session-priming for a session-gated store (see {@link SessionPrime}). Absent ⇒ no prime
   * (behavior byte-identical for undeclared stores). Applies to the `impersonate` transport.
   */
  sessionPrime?: SessionPrime;
  /**
   * Which egress this store's fetches leave through (see {@link EgressMode}). `residential` routes
   * them through the engine's configured residential proxy (`RESIDENTIAL_PROXY_URL`) on the impit
   * and browser lanes; with no proxy configured the fetch is REFUSED, never quietly sent from the
   * node IP. Undeclared (or `direct`) ⇒ today's behavior, byte-identical.
   */
  egress?: EgressMode;
  /**
   * Browser-lane readiness for a client-rendered storefront (see {@link WaitForReadiness}): wait for
   * the selector and/or network idle, bounded by `timeoutMs`, before capturing. Applies to the
   * `browser` transport. Undeclared ⇒ today's `domcontentloaded` behavior.
   */
  waitFor?: WaitForReadiness;
  /**
   * Browser-lane NAVIGATION budget (ms) for this store: the ceiling on each `page.goto`, the
   * session prime's included. A Cloudflare-fronted store reached through a relayed residential
   * exit spends most of its navigation on the CHALLENGE rather than on bytes, so the stores that
   * are slow BY CONSTRUCTION can say so instead of forcing the whole pod's budget up. Undeclared ⇒
   * the engine's own budget (`BROWSER_NAV_TIMEOUT_MS`, default 20000). Clamped to [5000, 120000].
   */
  navTimeoutMs?: number;
  /**
   * The store's edge gate (see {@link StoreAccess}). `cloudflare` tells the browser lane to keep
   * this host's context — and the Cloudflare clearance in it — alive between fetches, and makes
   * `sessionPrime` apply to the browser lane as well as impit. Undeclared (or `open`) ⇒ a fresh
   * context per request, exactly as before.
   */
  access?: StoreAccess;
}

/**
 * The engine-facing capability view of a store: its public `SiteConfig` (siteId / domains /
 * rateLimit / requiresBrowser) plus retrieval addressability. The crawl driver schedules from
 * this — `rateLimit` → per-host throttle, `requiresBrowser` → pool, `retrieval` → targeted
 * fetches — without ever importing the private StoreProfile axes. The plugin maps each private
 * StoreProfile down to this shape at registration.
 */
export interface StoreCapabilities extends SiteConfig {
  retrieval?: RetrievalCapability;
  /**
   * How to FETCH this store's `bySearch` endpoint (transport + request decoration). Absent ⇒ the
   * engine defaults the transport from `requiresBrowser` (`browser` if true, else `http`).
   */
  searchFetch?: SearchFetch;
}

/**
 * Per-extraction context handed to `extract()` by the engine (E1 seam).
 * Generic engine surface only: site config, page/batch/API fetch access, and
 * a logger — so rulesets that need multiple queries per item (search + detail,
 * batch endpoints, official APIs) can issue them through engine-managed
 * plumbing instead of owning their own HTTP stack. `batchFetch`/`officialApi`/
 * `fetchBody` are all OPTIONAL — a minimal engine may not yet provide them;
 * rulesets must treat `ctx` (and each of these members) as possibly absent
 * and degrade gracefully.
 */
export interface ExtractContext {
  config: SiteConfig;
  scraping: ScrapingService & {
    batchFetch?(codes: string[], opts?: Record<string, unknown>): Promise<Record<string, unknown>>;
    officialApi?(name: string, params: Record<string, unknown>, auth?: Record<string, unknown>): Promise<unknown>;
    /**
     * Added for orzgk Slice B (spec.md D1/D9, §3.1): a lightweight, NON-browser same-store
     * follow-up GET, issued through the engine's declared transport for this store (raw-captured
     * to the raw sink like any other fetch) and courtesy-gapped by the engine against the
     * primary fetch — the ruleset just awaits it, the engine enforces the gap. Used by
     * `extractMany()` implementations that need a second call off the same host (e.g. a
     * variation-batch endpoint) without owning their own HTTP stack. Optional: an engine that
     * doesn't yet provide it leaves this undefined; rulesets must check before calling.
     */
    fetchBody?(url: string, opts?: { cookies?: Record<string, string> }): Promise<{ html: string; statusCode?: number }>;
  };
  logger: PluginLogger;
}

/**
 * What an image found on a store page IS — the only thing the engine needs in order to decide
 * whether to fetch it, and the reason this vocabulary is small and closed.
 *
 * A store's own field names carry the meaning ("the big plates", "the little one in the grid", "the
 * ones collectors uploaded"), and those names differ per store and are private to its ruleset. The
 * engine must not learn them: an engine that keys on a field name has one store's schema compiled
 * into it. So the ruleset translates its fields into these four roles, and the engine's capture rule
 * is written against the roles alone.
 *
 *   `gallery`   — a product plate the store itself published for the item. The corpus worth keeping.
 *   `thumbnail` — a downscaled derivative of a plate the store also publishes at full size. Storing
 *                 it duplicates the plate at a worse resolution, so it is DELIBERATELY not captured.
 *   `user`      — uploaded by a member of the store's community. Not the store's to redistribute,
 *                 and not ours: a separate rights question that this lane does not answer.
 *   `other`     — a store image that is genuinely none of the above (a box shot on its own page, a
 *                 scale diagram). Captured with the gallery, because it is still the store's own.
 */
export type ImageRole = 'gallery' | 'thumbnail' | 'user' | 'other';

/**
 * ONE image a ruleset found on an item, normalized out of that store's private field shapes.
 *
 * `url` may be relative — the engine resolves it against the page it came from, so a ruleset never
 * has to reconstruct a base. `position` is the image's index on the referencing page in the order
 * the store presents it (the first plate is 0); it is stored beside the bytes, so a later renderer
 * can put a gallery back in the store's own order without re-fetching the page. Positions are
 * per-role-blind and need not be contiguous — the engine only ever compares them.
 */
export interface ImageRef {
  url: string;
  role: ImageRole;
  position: number;
}

export interface ExtractionRuleset {
  siteId: string;
  version: string;
  /**
   * Extract structured data from a fetched page. Async-capable via this
   * single method: the engine ALWAYS awaits the result, so a plain
   * synchronous body remains valid with zero ceremony. `ctx` is optional —
   * existing two-argument rulesets are unaffected.
   */
  extract(html: string, url: string, ctx?: ExtractContext): ExtractedData | Promise<ExtractedData>;
  validate(data: ExtractedData): ValidationResult;
  /**
   * OPTIONAL: extract MULTIPLE records from one fetched page — added for orzgk Slice B
   * (spec.md D1/D9, §1.2, §3.1, §6 B1) so a variable-product listing can emit its own record
   * plus one record per edition/offer found on the same page (or a courtesy-gapped follow-up
   * fetch via `ctx.scraping.fetchBody`). Contract: (a) `result[0]` is the page's own record —
   * exactly what `extract()` would return for this page; (b) every record shares `source.site`
   * but carries a DISTINCT `source.itemId`; (c) each record must independently pass
   * `validate()`; (d) ordering is TARGET-FIRST — a record naming another record via
   * `fields.offerOf`/`fields.editionOf` must appear AFTER the record it targets, since the
   * engine emits records sequentially in array order. Engines that don't call `extractMany`
   * keep calling `extract()` — existing 2-argument rulesets are unaffected.
   */
  extractMany?(html: string, url: string, ctx?: ExtractContext): ExtractedData[] | Promise<ExtractedData[]>;
  /**
   * OPTIONAL: parse a SEARCH-results response body (fetched from the store's `retrieval.bySearch`
   * endpoint) into candidate items for cross-store lookup — the buy-decision fan-out. Distinct
   * from `extract()`, which parses ONE product page: this turns a results LIST (Shopify predictive
   * `suggest.json`, a WooCommerce Store API product array, or an HTML results grid) into
   * `SearchCandidate[]`. Stores that support targeted search implement it; search-less stores omit
   * it. Async-capable like `extract()` — the engine always awaits the result.
   */
  extractCandidates?(
    body: string,
    url: string,
    ctx?: ExtractContext,
  ): SearchCandidate[] | Promise<SearchCandidate[]>;
  /**
   * OPTIONAL: parse one CATALOG-LISTING page body (fetched from the store's `retrieval.byListing`
   * endpoint) into the item ids it lists — the enumeration feed for recent/backfill crawls.
   * Distinct from `extractCandidates()`, which parses the results of ONE search query: this turns
   * a newest-first catalog page (a WooCommerce Store API product array, a Shopify `products.json`,
   * or an HTML product grid) into a `ListingPage`. Stores that declare `byListing` implement it;
   * the rest omit it. Async-capable like `extractCandidates()` — the engine always awaits the result.
   */
  extractListing?(body: string, url: string, ctx?: ExtractContext): ListingPage | Promise<ListingPage>;
  /**
   * OPTIONAL: parse one DECLARED SEED LIST body (fetched from the entry in the store's
   * `retrieval.seedLists` whose `id` is `listId`) into the item ids that page shows. Same
   * `ListingPage` shape as `extractListing`, and the parser is handed the LIST ID rather than a url
   * because the url is already declared — one parser can therefore serve every list the store
   * declares and switch on which one it was asked for.
   *
   * `hasMore` is ALWAYS FALSE here, whatever the parser returns: a seed list is one whole page by
   * construction, so there is no next page to signal and nothing for a caller to walk. Returning
   * `true` cannot make the engine fetch more — it is ignored. `nextPage` is likewise meaningless.
   *
   * Stores that declare `seedLists` implement it; the rest omit it. Async-capable like
   * `extractListing` — the engine always awaits the result.
   */
  extractSeedList?(body: string, listId: string): ListingPage | Promise<ListingPage>;
  /**
   * OPTIONAL: name the images this extraction found, as store-agnostic {@link ImageRef}s.
   *
   * Handed the SAME `fields` the ruleset just produced (never the html — this hook does no parsing
   * and no I/O of its own, which is why it is synchronous), it answers one question the engine
   * cannot: which of this store's field shapes hold image urls, and what each one MEANS. A store
   * that publishes full plates under one field, a grid thumbnail under another and member uploads
   * under a third maps all three here, each under its {@link ImageRole}, and the engine then applies
   * ONE capture rule to the result — it never learns a field name.
   *
   * Relative urls are fine; the engine resolves them against the page. Return `[]` for an item with
   * no images. Rulesets that omit the hook simply have no images captured — nothing else changes.
   */
  describeImages?(fields: Record<string, unknown>): ImageRef[];
  /**
   * OPTIONAL: when `true`, this ruleset declares that a ZERO-RECORD extraction is a VALID outcome
   * — the page was well-formed and the ruleset successfully determined there is genuinely nothing
   * to emit (an empty search/listing result, a delisted page with no claimable data). This is the
   * EXTRACTOR'S OWN SIGNAL that "no data" means "none expected", NOT "extraction failed": the
   * engine records such an extraction as a SUCCESS (empty) instead of a failure. It applies ONLY to
   * a genuinely empty return from `extractMany` (an `[]`) on a NON-challenge page; a challenge page,
   * a thrown extraction, or an emitted record the spine persisted nothing for stays a failure. Omit
   * (or `false`) to keep the default: a zero-record extraction is an error (the safe default — a
   * ruleset that has NOT reasoned about empties must not have its parse breaks silently pass).
   */
  emptyResultIsValid?: boolean;
}

/**
 * Uniform extraction result. `source` serializes 1:1 onto the aggregation
 * ingest wire: `extractedAt` MUST be an ISO-8601 UTC string (it becomes the
 * `as_of` timestamp on every downstream claim row — produce it with
 * `new Date().toISOString()`, never a Date object).
 */
export interface ExtractedData {
  source: {
    site: string;
    itemId: string;
    url?: string;
    extractedAt: string;
    rulesetVersion?: string;
  };
  fields: Record<string, unknown>;
  warnings: string[];
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * A single hit from a store's SEARCH (`bySearch`) results — the cross-store buy-decision entry.
 * Carries just enough to (a) show/compare and (b) re-fetch the full record: `itemId` feeds the
 * store's `retrieval.byId`, `name` drives name/ER matching, `url` links the product page. A JAN is
 * deliberately NOT required here — search hits are often title-indexed, so the barcode is resolved
 * by the follow-up `byId` fetch. `priceRaw` is the price string when the hit carries one (Shopify).
 */
export interface SearchCandidate {
  itemId: string;
  name: string;
  url?: string;
  priceRaw?: string;
  /**
   * Orderable status of this hit: `true` = in-stock/buyable, `false` = sold-out, `undefined` =
   * unknown (the endpoint didn't say). Drives the lookup's two modes — `orderable` keeps
   * `available !== false`, `listed` keeps all. Distinct from mere presence: a listed store may
   * carry an item that's currently sold-out (still valuable signal: restock / secondhand / price
   * history).
   */
  available?: boolean;
}

/**
 * One page of a store's newest-first catalog listing (`retrieval.byListing`), as parsed by
 * `ExtractionRuleset.extractListing`. Each item carries the store's `itemId` — it feeds
 * `retrieval.byId` exactly like `SearchCandidate.itemId` — and, for stores without a byId axis, the
 * product page `url` (absolute, or relative to the listing url; the engine absolutizes it) as the
 * collect target. `hasMore` = the store signalled a further page (absent → the engine infers it from
 * a non-empty page); `nextPage` = the store's explicit next page number when it reports one (absent
 * → page + 1 while `hasMore`).
 */
export interface ListingPage {
  items: Array<{ itemId: string; url?: string }>;
  hasMore?: boolean;
  nextPage?: number;
}

/**
 * A typed cross-store identity for RECORD-MODE lookup (POST /lookup) — the caller has a catalogued
 * figure and wants current cross-store price/availability. The engine's per-store query composer
 * turns this into each store's search query: a JAN-exact `{q}` where the store's bySearch
 * `acceptsGtin` (or a barcode-byId detail plan), else a composed name/ER string from the remaining
 * fields. All optional; a valid query needs at least a `gtin14` or a `name` (or studio+character/series).
 */
export interface IdentityQuery {
  /** Canonical GTIN-14 (JAN/UPC/EAN folded) — the strongest cross-store anchor; used JAN-exact where supported. */
  gtin14?: string;
  studio?: string;
  character?: string;
  series?: string;
  scale?: string;
  figureType?: string;
  version?: string;
  /** Display name / title — the fallback query for title-indexed stores (Shopify) and no-JAN statues. */
  name?: string;
}

export interface RuntimeConfig {
  get(key: string): unknown;
  getFeatureFlag(site: string, feature: string): boolean;
}

export interface PluginLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
}

// Express Router type (lightweight, avoids importing express in the contract)
export interface ExpressRouter {
  get(path: string, ...handlers: Function[]): void;
  post(path: string, ...handlers: Function[]): void;
  put(path: string, ...handlers: Function[]): void;
  delete(path: string, ...handlers: Function[]): void;
  use(path: string, ...handlers: Function[]): void;
}

/**
 * Type guard: validates an unknown module export has the minimum shape of a
 * ScraperPlugin (name/version/register required; registerRoutes/shutdown
 * optional). Used by the plugin loader to reject malformed packages instead
 * of crashing the engine at boot.
 */
export function isScraperPlugin(value: unknown): value is ScraperPlugin {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.name === 'string' &&
    typeof candidate.version === 'string' &&
    typeof candidate.register === 'function' &&
    (candidate.registerRoutes === undefined || typeof candidate.registerRoutes === 'function') &&
    (candidate.shutdown === undefined || typeof candidate.shutdown === 'function')
  );
}
