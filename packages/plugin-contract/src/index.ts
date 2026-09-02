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
  url: string;
  title: string;
  statusCode?: number;
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
  bySearch?: { urlTemplate: string; scope?: 'listed' | 'orderable'; acceptsGtin?: boolean; queryMatch?: 'tokens' | 'substring' };
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
