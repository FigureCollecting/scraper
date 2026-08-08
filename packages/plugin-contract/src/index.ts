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

export interface ScrapingService {
  scrapePage(url: string, options?: ScrapePageOptions): Promise<ScrapePageResult>;
  scrapePageStealth(url: string, options?: ScrapePageOptions): Promise<ScrapePageResult>;
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
 * Per-extraction context handed to `extract()` by the engine (E1 seam).
 * Generic engine surface only: site config, page/batch/API fetch access, and
 * a logger — so rulesets that need multiple queries per item (search + detail,
 * batch endpoints, official APIs) can issue them through engine-managed
 * plumbing instead of owning their own HTTP stack. A minimal engine may not
 * yet provide `batchFetch`/`officialApi`; rulesets must treat `ctx` as
 * optional and degrade gracefully when it is absent.
 */
export interface ExtractContext {
  config: SiteConfig;
  scraping: ScrapingService & {
    batchFetch(codes: string[], opts?: Record<string, unknown>): Promise<Record<string, unknown>>;
    officialApi(name: string, params: Record<string, unknown>, auth?: Record<string, unknown>): Promise<unknown>;
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
