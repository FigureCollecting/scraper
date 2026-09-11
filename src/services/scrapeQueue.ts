/**
 * Scrape Queue Service
 *
 * Manages a priority-based queue for scraping requests with:
 * - Three-tier priority lanes (HOT, WARM, COLD)
 * - Request deduplication and coalescing
 * - Adaptive rate limiting with exponential backoff
 * - Error classification and retry logic
 *
 * Priority Lanes:
 * - HOT: NSFW items with active cookies (highest priority)
 * - WARM: SFW items from active imports
 * - COLD: Background enrichment (lowest priority)
 *
 * Extraction is plugin-only: items are processed via the ingest path
 * (raw page fetch -> plugin ruleset extract -> spine emit). The engine has
 * no extraction fallback — items with no matching ruleset, or with no
 * ingest emitter configured, fail cleanly through the standard failure
 * handling (never a crash, never a silent drop).
 */

import { ScrapedData, BrowserPool } from './genericScraper.js';
import { sanitizeForLog } from '../utils/security.js';
import { getSessionManager, resetSessionManager, SessionManager, SessionPausedEvent } from './sessionManager.js';
import { notifyItemFailed } from './webhookClient.js';
import { enrichmentLogger } from '../utils/logger.js';
import { createScrapingService } from './engineServices/scrapingService.js';
import { createCapturingFetch, laneOf, ChallengePageError, type CapturingFetch, type CapturingFetchTransports } from './engineServices/capturingFetch.js';
import { evaluateRecordFetch, RecordFetchStatusError } from './recordFetchGate.js';
import { observeMfcItemFetch } from './sessionCanary.js';
import { getChallengeCooldown, ChallengeCooldownError, type ChallengeCooldown } from './challengeCooldown.js';
import {
  createMemoryQueueStore,
  type PersistedQueueItem,
  type QueueStoreReason,
  type ScrapeQueueStore,
} from './queueStore.js';
import { classifyFetchFailure } from './failureClassifier.js';
import { createFailureReporterFromEnv, type FetchFailureReport } from './failureReporter.js';
import { ResidentialEgressUnavailableError } from './residentialEgress.js';
import { ChallengeLaneUnavailableError } from './browserChallenge.js';
import { getCfCookieStore, markStaleIfStored, markFreshIfStored, type CfCookieStoreLike } from './cookieJar.js';
import { getRawCaptureSink } from './s3ObjectStore.js';
import { createIngestEmitterFromEnv } from './ingestEmitter.js';
import { impitFetchBodyDetailed } from './impitFetch.js';
import { httpFetchBodyDetailed } from './engineLookup.js';
import { buildProfileRegistry, ProfileRegistry } from '../driver/profileRegistry.js';
import { extractRecords, EmptyExtractionError } from './engineServices/extractRecords.js';
import { buildExtractContext } from './engineServices/extractContext.js';
import { createPluginLogger } from './engineServices/pluginLogger.js';
import type { CaptureSink } from './captureSink.js';
import { getImageCaptureHook } from './images/assembleImageCapture.js';
import type { ImageCaptureHook } from './images/imageCaptureHook.js';
import type {
  ExtractionRuleset,
  ExtractContext,
  ExtractedData as PluginExtractedData,
  ScrapingService,
  SiteConfig,
  StoreCapabilities,
  SearchFetch,
} from '@figurecollecting/scraper-plugin-contract';

// ============================================================================
// Types and Interfaces
// ============================================================================

export type QueuePriority = 'HOT' | 'WARM' | 'COLD';
export type ItemStatus = 'owned' | 'ordered' | 'wished';
export type ErrorType = 'timeout' | 'not_found' | 'rate_limited' | 'auth_required' | 'network' | 'extraction_unavailable' | 'empty_record' | 'challenge_cooldown' | 'unknown';

export interface QueueItem {
  /** Unique identifier for this queue entry */
  id: string;
  /** MFC item ID */
  mfcId: string;
  /** URL to scrape */
  url: string;
  /** Priority lane */
  priority: QueuePriority;
  /** Collection status (affects enrichment priority) */
  status?: ItemStatus;
  /** Cookies for NSFW content (ephemeral, never stored) */
  cookies?: Record<string, string>;
  /** Session ID for cookie context (to dedupe by active session) */
  sessionId?: string;
  /** Number of retry attempts */
  retryCount: number;
  /** Maximum retries allowed */
  maxRetries: number;
  /** When this item was queued */
  queuedAt: number;
  /** Last error encountered */
  lastError?: string;
  /** Error type for classification */
  errorType?: ErrorType;
  /** Users waiting for this result (for deduplication) */
  waitingUserIds: string[];
  /** Promise resolvers for waiting callers */
  resolvers: Array<{
    resolve: (data: ScrapedData) => void;
    reject: (error: Error) => void;
  }>;
}

/** Progress tracking for a single status category */
export interface StatusProgress {
  queued: number;
  completed: number;
  failed: number;
}

export interface QueueStats {
  hot: number;
  warm: number;
  cold: number;
  /**
   * RESIDENT depth: hot + warm + cold. Unchanged — the fleet health checks and the `queue size: N`
   * log line both read this, and `parked` is deliberately NOT folded into it.
   */
  total: number;
  /**
   * Items queued but held ON DISK, outside the in-memory working set (the bounded-working-set
   * overflow). ADDITIVE: `hot + warm + cold` still equals `total`. Always 0 without a durable store.
   */
  parked: number;
  processing: number;
  completed: number;
  failed: number;
  rateLimited: boolean;
  currentDelay: number;
  /** Per-status progress tracking (owned/ordered/wished) */
  byStatus?: {
    owned: StatusProgress;
    ordered: StatusProgress;
    wished: StatusProgress;
  };
}

export interface EnqueueOptions {
  priority?: QueuePriority;
  status?: ItemStatus;
  cookies?: Record<string, string>;
  sessionId?: string;
  userId?: string;
  maxRetries?: number;
  /**
   * Explicit URL to scrape. When absent the key is treated as an MFC item ID
   * and the item URL is built from it (legacy shape). Trigger routes pass the
   * URL itself as both key and option — no faked MFC fields.
   */
  url?: string;
}

export interface EnqueueResult {
  /** Queue item ID (can be used to track status) */
  id: string;
  /** Whether this was deduplicated into existing request */
  deduplicated: boolean;
  /** Position in queue (approximate) */
  position: number;
  /** Promise that resolves when scraping completes */
  promise: Promise<ScrapedData>;
}

/**
 * Narrow view of the plugin extraction registry the queue needs: resolving a ruleset for an
 * item's URL (ingest cutover seam), and every registered store's capabilities — so the queue can
 * resolve a store's declared raw-fetch transport (searchFetch) the same way the /lookup path does
 * via ProfileRegistry.
 */
export interface RulesetResolver {
  getRulesetForUrl(url: string): ExtractionRuleset | undefined;
  allStores(): StoreCapabilities[];
}

/**
 * Narrow view of the spine ingest emitter. Engine plumbing ONLY — plugins
 * never see the emitter (it is not part of EngineServices or the contract).
 */
export interface IngestSender {
  send(extracted: PluginExtractedData): Promise<unknown>;
}

/**
 * The fetch-failure ledger seam (engine plumbing, injected like the ingest emitter). The queue only
 * ever calls it from its terminal give-up branch, and never lets it affect the item's outcome.
 */
export interface FailureLedgerReporter {
  report(report: FetchFailureReport): Promise<void>;
}

/**
 * Structural view of the ingest server's WriteStats accounting (the emitter resolves the full
 * @figurecollecting/ingest-contract WriteStats; the narrow IngestSender above types send()'s result
 * as unknown). Only the per-table fields the honesty gate + [INGEST STATS] log read.
 */
interface IngestRecordStats {
  claims?: { inserted?: number; deduped?: number; dropped?: number; quarantined?: number };
  identifiers?: { inserted?: number; deduped?: number; dropped?: number };
  prices?: { inserted?: number; deduped?: number; skipped?: number; dropped?: number };
  availability?: { inserted?: number; deduped?: number; dropped?: number };
  warnings?: string[];
}

/**
 * The spine accepted the RPC but persisted 0 rows for a record — inserted+deduped == 0 across ALL
 * four tables. An empty ingest is a FAILURE, never the "[INGEST] SUCCESS" the old emit-count path
 * reported (a Cloudflare challenge / dead ruleset lifts an empty field bag the server can persist
 * nothing from). Thrown from processViaIngest so the item flows through the queue's existing
 * attempts/backoff/FAILED handling. Classifies as 'unknown' (retryable, bounded by maxRetries) so a
 * permanently-empty store exhausts its attempts and lands FAILED rather than looping.
 */
export class EmptyIngestRecordError extends Error {
  readonly site: string;
  readonly itemId: string;
  readonly warnings: string[];
  constructor(site: string, itemId: string, warnings: string[]) {
    const tail = warnings.length
      ? ` server warnings: ${warnings.map(sanitizeForLog).join(' | ')}`
      : ' (no server warnings)';
    super(
      `EMPTY_INGEST_RECORD for ${site}:${itemId}: spine persisted 0 rows ` +
        `(inserted+deduped=0 across claims/identifiers/prices/availability).${tail}`
    );
    this.name = 'EmptyIngestRecordError';
    this.site = site;
    this.itemId = itemId;
    this.warnings = warnings;
  }
}

/**
 * inserted+deduped summed across all four tables — the rows that actually LANDED. An idempotent
 * re-ingest legitimately lands as all-deduped (inserted=0, deduped>0), so deduped counts as
 * persisted. An absent table contributes 0.
 */
function persistedRows(stats: IngestRecordStats): number {
  const t = (s?: { inserted?: number; deduped?: number }): number => (s ? (s.inserted ?? 0) + (s.deduped ?? 0) : 0);
  return t(stats.claims) + t(stats.identifiers) + t(stats.prices) + t(stats.availability);
}

/**
 * One [INGEST STATS] line per record surfacing the server WriteStats, then up to the first 3
 * warnings (each sanitized). Field order: claims=ins/dedup/drop/quar prices=ins/dedup/skip/drop
 * identifiers=ins/dedup/drop availability=ins/dedup/drop warnings=N.
 */
function logIngestStats(label: string, stats: IngestRecordStats): void {
  const n = (x?: number): number => x ?? 0;
  const c = stats.claims, id = stats.identifiers, p = stats.prices, av = stats.availability;
  const warnings = stats.warnings ?? [];
  console.log(
    `[INGEST STATS] ${sanitizeForLog(label)} ` +
      `claims=${n(c?.inserted)}/${n(c?.deduped)}/${n(c?.dropped)}/${n(c?.quarantined)} ` +
      `prices=${n(p?.inserted)}/${n(p?.deduped)}/${n(p?.skipped)}/${n(p?.dropped)} ` +
      `identifiers=${n(id?.inserted)}/${n(id?.deduped)}/${n(id?.dropped)} ` +
      `availability=${n(av?.inserted)}/${n(av?.deduped)}/${n(av?.dropped)} ` +
      `warnings=${warnings.length}`
  );
  for (const w of warnings.slice(0, 3)) {
    console.log(`[INGEST STATS]   warn: ${sanitizeForLog(w)}`);
  }
}

/** What a startup reconciliation put back into the queue. */
export interface QueueRestoreSummary {
  /** Rows that were resident and undispatched when the process died. */
  pending: number;
  /** Rows the dead process had dispatched, whose lease has since expired. */
  leasedExpired: number;
  /** Per-host challenge cooldowns still inside their window. */
  cooldowns: number;
  /** Rows left on disk, outside the working set. Not lost — paged in as the tiers drain. */
  parked: number;
  /** Leases not yet expired. Left held; `refillWorkingSet` reaps them when they do. */
  stillLeased: number;
}

/** The `queueStore` block on /health/detailed. */
export interface QueueStoreView {
  /** False ⇒ the in-memory fallback: a restart WILL drop queued items. */
  durable: boolean;
  /**
   * WHY `durable` reads the way it does — the field that separates a deliberate configuration from a
   * silent failure. `dir_missing` is the INTENDED intermediate state while the engine ships ahead of
   * its PVC; `not_writable` / `open_failed` / `write_failed` are faults. See QueueStoreReason.
   */
  reason: QueueStoreReason;
  /** The file in use, or the one that was ATTEMPTED. Null only when deliberately disabled. */
  path: string | null;
  /** Where an unusable file was moved aside to, for manual salvage. Null in every other case. */
  quarantinedPath: string | null;
  /** Rows a quarantined file held that could not be carried over. Should be 0; non-zero is an alarm. */
  lostAtStartup: number;
  /** ISO-8601 instant of the startup reconciliation, or null if none has run. */
  restoredAt: string | null;
  pending: number;
  leased: number;
  parked: number;
}

/** Raw page-fetch capability the ingest path uses (extraction is the plugin's job). */
type RawPageFetcher = Pick<ScrapingService, 'scrapePage' | 'scrapePageStealth'>;

// ============================================================================
// Rate Limiting Configuration
// ============================================================================

const RATE_LIMIT = {
  /** Base delay between requests (ms) */
  BASE_DELAY: 2067, // ~29 requests/minute

  /** Maximum delay after backoff */
  MAX_DELAY: 180000, // 3 minutes

  /** Minimum delay (even at full speed) */
  MIN_DELAY: 274, // Optimal: fastest floor with zero failures across full 1156-item sync

  /** Backoff multiplier on rate limit detection */
  BACKOFF_MULTIPLIER: 1.4,

  /** Recovery divisor when succeeding */
  RECOVERY_DIVISOR: 1.4,

  /** Consecutive successes before reducing delay */
  SUCCESS_THRESHOLD: 3,

  /** Default max retries per item */
  DEFAULT_MAX_RETRIES: 3,

  /** Maximum items in queue per priority */
  MAX_QUEUE_SIZE: 10000,
} as const;

/**
 * How long a dispatched item's lease is held before a restart treats it as abandoned. It bounds the
 * worst case of a `kill -9` MID-NAVIGATION: nothing releases that lease but its own expiry, so this
 * is how long that one item waits to be re-driven. 10 minutes is comfortably above the browser
 * lane's navigation timeout and well below the hour the crawler takes to come round again.
 */
const QUEUE_LEASE_MS_ENV = 'SCRAPE_QUEUE_LEASE_MS';
const DEFAULT_QUEUE_LEASE_MS = 10 * 60_000;

/**
 * The cap on RESIDENT items (hot + warm + cold). Above it an enqueue is written to disk as `parked`
 * and never enters a tier, so depth stops being a heap number — and, just as importantly, stops
 * being an O(n) scan: `addToQueue` scores every item in the lane to find its insertion point and
 * `getNextProcessableItem` walks the lanes on every dispatch.
 *
 * 1000 is chosen to be ABOVE today's observed depth (normally < 500 at ~520-620 enqueues/hour
 * against a ~600/hour drain), so on today's traffic NOTHING parks and the behaviour is byte-for-byte
 * what it is now. Parking is a ceiling, not a new normal.
 */
const QUEUE_MAX_RESIDENT_ENV = 'SCRAPE_QUEUE_MAX_RESIDENT';
const DEFAULT_QUEUE_MAX_RESIDENT = 1000;

/**
 * The cap on resident items for ONE host. Without it the crawler's 50-per-store burst — or a single
 * store's backfill — could fill the entire working set, and every other store's items would sit on
 * disk behind a host that is itself rate-limited to one request every few seconds.
 */
const QUEUE_MAX_RESIDENT_PER_HOST_ENV = 'SCRAPE_QUEUE_MAX_RESIDENT_PER_HOST';
const DEFAULT_QUEUE_MAX_RESIDENT_PER_HOST = 250;

/** How often the expired-lease reaper runs. One query a minute, not one per dispatch. */
const LEASE_REAP_INTERVAL_MS = 60_000;

/** Env var name for the per-host DEFAULT delay (ms) applied to hosts that declare no rate (D-11). */
const HOST_BASE_DELAY_ENV = 'SCRAPER_HOST_BASE_DELAY_MS';
/** Env var name for the ABSOLUTE per-host minimum (ms) that clamps EVERY host, declared or not. */
const HOST_HARD_FLOOR_ENV = 'SCRAPER_HOST_HARD_FLOOR_MS';

/**
 * The D-11 budget-safe per-host DEFAULT (ms) applied when a host DECLARES NO rate (no resolved store
 * profile) and `SCRAPER_HOST_BASE_DELAY_MS` is unset. The measured budget is 24,700 req/day/host =
 * 3500 ms at-budget; 4000 ms is the recommended value (12% headroom, D-11's own figure). This is the
 * DEFAULT so budget-safety is NEVER opt-in: a deploy that forgets the env still paces an unknown host
 * within budget (a forgotten env must not silently run the crawler ~1.75x over budget and burn
 * datacenter-IP reputation). The env LOWERS this toward 3500 ms only on clean evidence (D-11: "scale
 * to 3500 only if clean"). A store that DECLARES its own rate is paced by that value instead (clamped
 * up to HARD_FLOOR) — this default governs only undeclared hosts.
 */
const DEFAULT_HOST_BASE_FLOOR_MS = 4000;

/**
 * The absolute per-host MINIMUM (ms) applied when `SCRAPER_HOST_HARD_FLOOR_MS` is unset — clamps
 * EVERY host, INCLUDING a store that deliberately declares a fast rate. This is typo/misconfig
 * protection: a `baseDelayMs: 40` (or 0) must NOT hammer a host at 25 req/s — it clamps to 1 req/s.
 * 1000 ms = 1 req/s/host = 86,400 req/day/host: intentionally BELOW the 24,700/day frontier budget
 * (that budget is enforced by the 4000 ms DEFAULT on undeclared/HTML stores and by each store's own
 * declared rate), so a deliberately-declared clean JSON-API store can differentiate into the
 * ~1000-3000 ms band, while a mistake can never exceed 1 req/s. Anything faster than 1 req/s must be
 * a reviewed, explicit exception (lower this env — same fail-safe parsing applies).
 */
const DEFAULT_HOST_HARD_FLOOR_MS = 1000;

/**
 * Read a positive-ms env knob, fail-safe: `undefined` when unset OR when the value is non-finite or
 * non-positive (empty string, garbage, 0, negative) — so misconfiguration degrades to the caller's
 * safe default, NEVER to zero (no-pacing). Read fresh each call so an operator can tune without a
 * restart in tooling.
 */
function resolvePositiveEnvMs(envVar: string): number | undefined {
  const raw = process.env[envVar];
  if (raw === undefined || raw.trim() === '') return undefined;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

/** The per-host DEFAULT delay (ms) for UNDECLARED hosts: the env when valid, else the budget-safe 4000 ms. */
function resolveHostBaseDefaultMs(): number {
  return resolvePositiveEnvMs(HOST_BASE_DELAY_ENV) ?? DEFAULT_HOST_BASE_FLOOR_MS;
}

/** The lease TTL (ms): the env when valid and positive, else 10 minutes. */
function resolveLeaseMs(): number {
  return resolvePositiveEnvMs(QUEUE_LEASE_MS_ENV) ?? DEFAULT_QUEUE_LEASE_MS;
}

/** The resident cap: the env when valid and positive, else 1000. (Same fail-safe parse as the ms knobs.) */
function resolveMaxResident(): number {
  return resolvePositiveEnvMs(QUEUE_MAX_RESIDENT_ENV) ?? DEFAULT_QUEUE_MAX_RESIDENT;
}

/** The per-host resident cap: the env when valid and positive, else 250. */
function resolveMaxResidentPerHost(): number {
  return resolvePositiveEnvMs(QUEUE_MAX_RESIDENT_PER_HOST_ENV) ?? DEFAULT_QUEUE_MAX_RESIDENT_PER_HOST;
}

/** The absolute per-host MINIMUM (ms) clamping every host: the env when valid, else the safe 1000 ms. */
function resolveHostHardFloorMs(): number {
  return resolvePositiveEnvMs(HOST_HARD_FLOOR_ENV) ?? DEFAULT_HOST_HARD_FLOOR_MS;
}

// ============================================================================
// Error Classification
// ============================================================================

function classifyError(error: Error | string): ErrorType {
  // Class-based classification wins over any substring match: a typed engine error's taxonomy must
  // never depend on free text (itemId / URL / server warnings) embedded in its message (RS-2). A
  // ChallengePageError is a CF challenge/block → rate_limited (backoff + CF block tracking); an
  // EmptyIngestRecordError is a persisted-nothing failure → its own class, retryable-but-bounded,
  // and never an auth/cookie fault.
  if (error instanceof ChallengePageError) {
    return 'rate_limited';
  }
  // A ChallengeCooldownError is a FAST FAIL raised before any fetch because the host is cooling — its
  // own class, so it is never retried and never mistaken for a cookie/auth or empty-record fault.
  if (error instanceof ChallengeCooldownError) {
    return 'challenge_cooldown';
  }
  if (error instanceof EmptyIngestRecordError) {
    return 'empty_record';
  }
  // A RecordFetchStatusError is the store's own answer, and its STATUS — never its message — decides
  // this queue's retry policy. 404 / 410 and a bounce to the front page are terminal-by-store, so
  // they take 'not_found' (one fetch, then FAILED) instead of being retried to exhaustion. 401 / 403
  // are a closed door: re-knocking cannot open it and only spends the egress IP's reputation, so
  // they take 'auth_required' (also never retried). 429 rides the existing rate-limit backoff, a 5xx
  // is a transient upstream ('network'), and anything else keeps the bounded generic retry.
  if (error instanceof RecordFetchStatusError) {
    // AMBIGUOUS 404 first: on a store where a 404 may be an entitlement denial (mfc's NSFW items),
    // 'not_found' would close a live item as removed. It is an access failure — never retried,
    // because no number of retries re-mints a session cookie — and the ledger books it http_403.
    if (error.deniedOrGone) return 'auth_required';
    if (error.redirectedHome) return 'not_found';
    const status = error.status ?? 0;
    if (status === 404 || status === 410) return 'not_found';
    if (status === 401 || status === 403) return 'auth_required';
    if (status === 429) return 'rate_limited';
    if (status >= 500) return 'network';
    return 'unknown';
  }
  // A ResidentialEgressUnavailableError is a CONFIG shortfall raised before any fetch: the store
  // declares residential egress and no usable proxy is wired (or its lane cannot proxy). Booked
  // like the other config shortfalls — extraction_unavailable, so it is never retried (a missing
  // env var will not appear between attempts) and never mistaken for a cookie/auth fault.
  if (error instanceof ResidentialEgressUnavailableError) {
    return 'extraction_unavailable';
  }
  // A ChallengeLaneUnavailableError is the same shape of CONFIG shortfall on the browser lane: the
  // store declares a Cloudflare gate and this process launches the headless profile, which cannot
  // clear one. Never retried — BROWSER_LAUNCH_MODE will not change between attempts.
  if (error instanceof ChallengeLaneUnavailableError) {
    return 'extraction_unavailable';
  }

  const message = typeof error === 'string' ? error : error.message;

  // Config-level shortfall (no emitter / no matching ruleset) — checked first
  // so its reason text can never be mistaken for a transient error.
  if (message.includes('EXTRACTION_UNAVAILABLE')) {
    return 'extraction_unavailable';
  }

  if (message.includes('timeout') || message.includes('TIMEOUT')) {
    return 'timeout';
  }

  if (message.includes('404') || message.includes('NOT_FOUND') || message.includes('not found')) {
    return 'not_found';
  }

  if (message.includes('429') || message.includes('RATE_LIMIT') || message.includes('rate limit') ||
      message.includes('CLOUDFLARE') || message.includes('Cloudflare')) {
    return 'rate_limited';
  }

  if (message.includes('AUTH') || message.includes('authentication') || message.includes('NSFW')) {
    return 'auth_required';
  }

  if (message.includes('NETWORK') || message.includes('ERR_') || message.includes('disconnected')) {
    return 'network';
  }

  return 'unknown';
}

/**
 * The ledger `site` for a URL NO ruleset claims. Deliberately a single reserved key, never the URL's
 * hostname: the spine registers an unseen site on first sight, so a hostname here would mint
 * host-shaped rows in the shared `source` vocabulary that the claim lanes and the per-site config
 * key off — and a ruleset skew that comes and goes would split one store's ledger in two
 * ('mfc' rows before it, 'myfigurecollection.net' rows during), with no join between them and no
 * chance of the record row resolving when the re-drive later succeeds under the real siteId. The
 * host is not lost: the row's target IS the url.
 */
const UNMATCHED_SITE = 'unmatched';

function shouldRetry(error: Error | string, errorType: ErrorType, retryCount: number, maxRetries: number): boolean {
  // Never retry auth errors without new cookies
  if (errorType === 'auth_required') {
    return false;
  }

  // Never retry config-level shortfalls — a missing emitter or ruleset will
  // not appear between attempts
  if (errorType === 'extraction_unavailable') {
    return false;
  }

  // Never retry a fast-fail against a cooling host — the host is deliberately being left alone; a
  // retry would just re-check the same closed window.
  if (errorType === 'challenge_cooldown') {
    return false;
  }

  // A ChallengePageError is ONE SHOT: retrying it re-fetches another challenge page and degrades the
  // egress IP's CF reputation (the live anitoysgk 3×-in-10s storm). One attempt, then FAILED — even
  // though its class stays rate_limited so the global backoff/CF-block accounting still fires once.
  if (error instanceof ChallengePageError) {
    return false;
  }

  // Don't retry if at max
  if (retryCount >= maxRetries) {
    return false;
  }

  // Retry transient errors. 'empty_record' is bounded-retryable: a re-fetch/re-extract may land rows
  // (transient upstream), but a permanently-empty store (e.g. a CF block) exhausts maxRetries and
  // then lands FAILED — never an infinite loop.
  return ['timeout', 'rate_limited', 'network', 'empty_record', 'unknown'].includes(errorType);
}

// ============================================================================
// Scrape Queue Class
// ============================================================================

export class ScrapeQueue {
  // Priority queues
  private hotQueue: QueueItem[] = [];
  private warmQueue: QueueItem[] = [];
  private coldQueue: QueueItem[] = [];

  // Deduplication map: mfcId -> QueueItem
  private pendingItems: Map<string, QueueItem> = new Map();

  // Rate limiting state
  private currentDelay: number = RATE_LIMIT.BASE_DELAY;
  private consecutiveSuccesses: number = 0;
  private isRateLimited: boolean = false;
  private lastRequestTime: number = 0;

  // Processing state
  private isProcessing: boolean = false;
  private processingItem: QueueItem | null = null;
  private completedCount: number = 0;
  private failedCount: number = 0;

  // Per-status tracking (owned/ordered/wished)
  private statusQueued: Record<ItemStatus, number> = { owned: 0, ordered: 0, wished: 0 };
  private statusCompleted: Record<ItemStatus, number> = { owned: 0, ordered: 0, wished: 0 };
  private statusFailed: Record<ItemStatus, number> = { owned: 0, ordered: 0, wished: 0 };

  // Processing interval
  private processInterval: NodeJS.Timeout | null = null;

  // Session manager for cookie validation and failure tracking
  private sessionManager: SessionManager;

  // Paused session event handlers
  private pausedSessionCallbacks: Array<(event: SessionPausedEvent) => void> = [];

  // Test mode - disables auto-processing for unit tests
  private testMode: boolean;

  // Cooldown wait timer - prevents multiple concurrent timers when all items blocked
  private cooldownWaitTimerId: NodeJS.Timeout | null = null;

  // Per-host pacing floor (H1, spec.md orzgk Slice B D8/§4 Rate row): last time an item was
  // DISPATCHED to each host, keyed by normalized (lowercased, www-stripped) hostname — same
  // normalization as ProfileRegistry so domain variants collapse to one entry. Independent of
  // `currentDelay` (the GLOBAL lane): an item is only dispatched once BOTH the global lane AND
  // this per-host floor are satisfied.
  private hostLastDispatch: Map<string, number> = new Map();

  // Ingest seams (engine plumbing, injected — see setters below).
  // When an emitter is configured (INGEST_BASE_URL) AND the registry resolves
  // a ruleset for the item's URL, processing runs: raw page fetch ->
  // ruleset.extract() -> spine emit. There is no other extraction path —
  // anything else is a clean item failure.
  private pluginRegistry: RulesetResolver | null = null;
  private ingestEmitter: IngestSender | null = null;
  private rawPageFetcher: RawPageFetcher | null = null;

  // Durable fetch-failure ledger (INGEST_BASE_URL + REPORT_FETCH_FAILURES). Null = reporting OFF,
  // and every emit point is a no-op — the queue's behavior is byte-identical to before.
  private failureReporter: FailureLedgerReporter | null = null;

  // Store-capability index (searchFetch/rateLimit/etc.), rebuilt alongside pluginRegistry — the
  // ingest path's transport lookup (getSearchFetchFor) reads a store's declared searchFetch from
  // here, same as the /lookup path's ProfileRegistry.
  private profiles: ProfileRegistry | null = null;
  // Non-browser raw-fetch transports for the ingest path (tests / DI); default lazily to the
  // engine's real impit/http fetchers — the same ones /lookup uses.
  private impersonateFetch: CapturingFetchTransports['impersonate'] | null = null;
  private httpFetch: CapturingFetchTransports['http'] | null = null;
  // Raw-capture sink for the ingest path's impit/http lanes (tests / DI); defaults lazily to the
  // shared engine sink — the same one the browser lane's navigateAndCapture writes to.
  private captureSink: CaptureSink | null = null;
  private imageCaptureHook: ImageCaptureHook | null = null;

  // Per-host Cloudflare-challenge cooldown register. Defaults to the process-wide singleton (shared
  // with the lookup fan-out and /health/detailed); a test may inject a clock-controlled instance.
  private challengeCooldownStore: ChallengeCooldown | null = null;

  // Per-host STORED-COOKIE store (CfCookieStore, CF_COOKIE_FILE). Defaults to the process-wide
  // singleton; a test injects a fake. Read by the ingest fetch (stealth selection) and signalled
  // at the challenge / clean-fetch sites (markStale / markFresh) — never mutated here.
  private cfCookieStore: CfCookieStoreLike | null = null;

  // ==========================================================================
  // Durable backing store (queueStore.ts)
  // ==========================================================================
  // Defaults to the no-op fallback so a unit test — and any process that never wires one — behaves
  // EXACTLY as the queue does today. The composition root (src/index.ts) swaps in the real SQLite
  // store at boot via setQueueStore().
  private store: ScrapeQueueStore = createMemoryQueueStore();
  /** ISO-8601 of the startup reconciliation, for /health/detailed. Null until restoreFromStore runs. */
  private storeRestoredAt: string | null = null;
  /** Mirror of the store's parked count, so the common path never pays a query. Re-synced on change. */
  private parkedCount = 0;
  /**
   * Promise handlers for items PARKED on disk. The item itself lives in SQLite; only the two
   * closures a caller is actually holding stay in the heap, so a parked item's promise still settles
   * when it is paged back in. A fire-and-forget enqueue (crawler / initiator) leaves one entry
   * nobody reads. Keyed by dedup key, like `pendingItems`.
   */
  private parkedResolvers: Map<string, QueueItem['resolvers']> = new Map();
  /** Last expired-lease sweep (epoch ms) — the reaper is throttled to LEASE_REAP_INTERVAL_MS. */
  private lastLeaseReapAt = 0;

  constructor(testMode?: boolean) {
    // Auto-detect test environment if not explicitly set
    this.testMode = testMode ?? (
      process.env.NODE_ENV === 'test' ||
      process.env.JEST_WORKER_ID !== undefined
    );

    // New ingest path is enabled by INGEST_BASE_URL; unset = null = disabled.
    this.ingestEmitter = createIngestEmitterFromEnv();

    // Failure reporting rides the same spine hop; unset / REPORT_FETCH_FAILURES=false = null = off.
    this.failureReporter = createFailureReporterFromEnv();

    // Get or create session manager
    this.sessionManager = getSessionManager();

    // Subscribe to session paused events to notify waiting users
    this.sessionManager.onSessionPaused((event) => {
      this.handleSessionPaused(event);
    });

    console.log(`[SCRAPE QUEUE] Initialized (testMode: ${this.testMode})`);
  }

  /**
   * Wire the durable backing store (src/index.ts at boot; a test injects a temp-dir store). Passing
   * null restores the no-op fallback. Does NOT reconcile — call restoreFromStore() for that, so the
   * wiring and the (logging, tier-populating) reload stay separable.
   */
  setQueueStore(store: ScrapeQueueStore | null): void {
    this.store = store ?? createMemoryQueueStore();
    this.parkedCount = this.store.counts().parked;
    // WRITE-THROUGH for per-host cooldowns. Without this the register would be read back at boot and
    // never written, so "a restart honours an open cooldown" would hold only in tests — and the very
    // restart that re-drives the crawler's batch would walk straight back into the challenge the
    // previous process had just backed off from. Only a DURABLE store is attached: a no-op sink adds
    // nothing, and detaching keeps the register from holding a store the queue no longer uses.
    this.getChallengeCooldownStore().setPersistence(this.store.durable ? this.store : null);
  }

  /** Close the backing store (process shutdown / test teardown). Safe on the fallback. */
  closeQueueStore(): void {
    try {
      this.store.close();
    } catch {
      // A store that will not close cleanly must not hold up a shutdown.
    }
  }

  /**
   * STARTUP RECONCILIATION — the whole point of the durable store.
   *
   * Reloads rows that were resident when the process died, plus rows it had dispatched whose lease
   * has since expired (a crash mid-navigation), into the in-memory tiers WITH their attempt counts,
   * so a restored item neither starts its retry budget over nor is re-driven forever. Unexpired
   * cooldowns are rehydrated too: a restart inside an open window is exactly when the engine is most
   * likely to walk straight back into the Cloudflare challenge it just backed off from.
   *
   * A no-op (and silent) on the in-memory fallback — there is nothing to reconcile.
   */
  restoreFromStore(now: number = Date.now()): QueueRestoreSummary {
    if (!this.store.durable) {
      return { pending: 0, leasedExpired: 0, cooldowns: 0, parked: 0, stillLeased: 0 };
    }
    const restored = this.store.restore(now);
    let pending = 0;
    for (const row of restored.pending) if (this.adoptPersisted(row, true)) pending++;
    let leasedExpired = 0;
    for (const row of restored.leasedExpired) if (this.adoptPersisted(row, true)) leasedExpired++;
    const cooldowns =
      restored.cooldowns.length > 0 ? this.getChallengeCooldownStore().restore(restored.cooldowns) : 0;

    this.parkedCount = restored.parked;
    this.storeRestoredAt = new Date(now).toISOString();
    console.log(
      `[SCRAPE QUEUE] restored ${pending} pending, ${leasedExpired} leased-expired, ${cooldowns} cooldowns ` +
        `from ${sanitizeForLog(String(this.store.path))} ` +
        `(${restored.parked} parked, ${restored.stillLeased} still leased)`
    ); // lgtm[js/log-injection]

    if (!this.testMode && pending + leasedExpired > 0) {
      this.startProcessing();
    }
    return { pending, leasedExpired, cooldowns, parked: restored.parked, stillLeased: restored.stillLeased };
  }

  /**
   * SIGTERM: hand every leased row back as pending. A PLANNED rollout then loses nothing — the next
   * process finds the in-flight items ready and re-drives them immediately, instead of waiting out a
   * lease nobody holds. Returns how many were released. Safe on the fallback (0).
   */
  releaseLeasesForShutdown(): number {
    const released = this.store.releaseLeases();
    if (released > 0) {
      console.log(`[SCRAPE QUEUE] released ${released} lease(s) for shutdown — they re-drive on the next start`);
    }
    return released;
  }

  /** The `queueStore` block on /health/detailed. Counts come from the store, so they are the TRUE depth. */
  getQueueStoreView(): QueueStoreView {
    const counts = this.store.counts();
    return {
      durable: this.store.durable,
      reason: this.store.reason,
      path: this.store.path,
      quarantinedPath: this.store.quarantinedPath,
      lostAtStartup: this.store.lostAtStartup,
      restoredAt: this.storeRestoredAt,
      pending: counts.pending,
      leased: counts.leased,
      parked: counts.parked,
    };
  }

  /**
   * Inject the plugin extraction registry (threaded from bootstrapPlugins in
   * src/index.ts). Without it, or without an emitter, items fail cleanly —
   * the engine has no extraction fallback.
   */
  setPluginRegistry(registry: RulesetResolver | null): void {
    this.pluginRegistry = registry;
    // Rebuild the capability index whenever the registry changes so getSearchFetchFor never
    // reads a stale store list (mirrors how createEngineLookup/createEngineResolve build theirs).
    this.profiles = registry ? buildProfileRegistry(registry.allStores()) : null;
  }

  /**
   * Override the spine ingest emitter (tests / DI). The constructor default
   * comes from INGEST_BASE_URL via createIngestEmitterFromEnv().
   */
  setIngestEmitter(emitter: IngestSender | null): void {
    this.ingestEmitter = emitter;
  }

  /**
   * Override the fetch-failure ledger reporter (tests / DI). The constructor default comes from
   * INGEST_BASE_URL + REPORT_FETCH_FAILURES via createFailureReporterFromEnv().
   */
  setFailureReporter(reporter: FailureLedgerReporter | null): void {
    this.failureReporter = reporter;
  }

  /**
   * Override the raw page-fetch service used by the ingest path's browser lane (tests / DI).
   * Defaults lazily to the same engine scraping service plugins get.
   */
  setScrapingService(service: RawPageFetcher | null): void {
    this.rawPageFetcher = service;
  }

  /**
   * Override the ingest path's non-browser raw-fetch transports (tests / DI). Only the keys
   * supplied are replaced; omitted keys keep their current fetcher (real or previously injected).
   */
  setIngestTransports(transports: {
    impersonate?: CapturingFetchTransports['impersonate'];
    http?: CapturingFetchTransports['http'];
  }): void {
    if (transports.impersonate) this.impersonateFetch = transports.impersonate;
    if (transports.http) this.httpFetch = transports.http;
  }

  /**
   * Override the raw-capture sink used by the ingest path's impit/http lanes (tests / DI).
   * Defaults lazily to the shared engine sink (getRawCaptureSink()).
   */
  setCaptureSink(sink: CaptureSink | null): void {
    this.captureSink = sink;
  }

  /**
   * Override the image capture hook (tests / DI). Defaults lazily to the process hook, which is
   * itself inert unless PERSIST_RAW_IMAGES is on.
   */
  setImageCaptureHook(hook: ImageCaptureHook | null): void {
    this.imageCaptureHook = hook;
  }

  /**
   * Offer an extraction's records to the image capture lane.
   *
   * Called AFTER extraction succeeded and BESIDE the emit, never inside it, and deliberately NOT
   * awaited: the item's fate is already decided, and making it wait on a CDN would let a slow image
   * host throttle live ingest. The try/catch is for a hook that throws SYNCHRONOUSLY (a broken DI
   * override, a bug in the composition root) — an image lane that cannot start must not be able to
   * fail an item that scraped perfectly well.
   *
   * One request per record, because an extractMany store's editions each carry their own plates and
   * each is its own item downstream. `pageUrl` is the page that was FETCHED — it is the base every
   * relative image url resolves against, the Referer a hotlink guard checks, and the provenance
   * stored beside the bytes.
   */
  private captureRecordImages(
    records: PluginExtractedData[],
    item: QueueItem,
    ruleset: ExtractionRuleset,
    searchFetch: SearchFetch | undefined,
  ): void {
    try {
      const hook = this.imageCaptureHook ?? getImageCaptureHook();
      for (const record of records) {
        // The real hook resolves whatever happens; the catch is for an injected one that does not,
        // because an unhandled rejection out here would take the process with it.
        void hook
          .capture({
            site: record.source.site,
            itemId: record.source.itemId,
            pageUrl: item.url,
            fields: record.fields,
            ruleset,
            searchFetch,
            origin: 'ingest',
          })
          .catch(() => undefined);
      }
    } catch (error) {
      console.warn(
        `[SCRAPE QUEUE] image capture could not start for ${sanitizeForLog(item.url)}: ${sanitizeForLog(
          error instanceof Error ? error.message : String(error),
        )}`
      );
    }
  }

  /**
   * Override the per-host challenge-cooldown register (tests / DI). Defaults to the process-wide
   * singleton so the queue, the lookup fan-out, and /health/detailed all share one register.
   */
  setChallengeCooldown(cooldown: ChallengeCooldown | null): void {
    this.challengeCooldownStore = cooldown;
  }

  /** The active challenge-cooldown register — the injected instance, else the shared singleton. */
  private getChallengeCooldownStore(): ChallengeCooldown {
    return this.challengeCooldownStore ?? getChallengeCooldown();
  }

  /**
   * Override the per-host stored-cookie store (tests / DI). Defaults to the process-wide singleton
   * so the queue, the lookup fan-out, and /health/detailed all read one jar.
   */
  setCfCookieStore(store: CfCookieStoreLike | null): void {
    this.cfCookieStore = store;
  }

  /** The active stored-cookie store — the injected instance, else the shared singleton. */
  private getCfCookieStoreRef(): CfCookieStoreLike {
    return this.cfCookieStore ?? getCfCookieStore();
  }

  /**
   * Register a callback to be notified when a session is paused
   * due to repeated failures. The user should be notified and can
   * choose to: resume, cancel the failed item, or cancel all items.
   */
  onSessionPaused(callback: (event: SessionPausedEvent) => void): () => void {
    this.pausedSessionCallbacks.push(callback);

    return () => {
      const index = this.pausedSessionCallbacks.indexOf(callback);
      if (index !== -1) {
        this.pausedSessionCallbacks.splice(index, 1);
      }
    };
  }

  private handleSessionPaused(event: SessionPausedEvent): void {
    console.log(`[SCRAPE QUEUE] Session paused for user ${event.userId} after ${event.failureCount} failures`);

    // Notify registered callbacks
    this.pausedSessionCallbacks.forEach(callback => {
      try {
        callback(event);
      } catch (error) {
        console.error('[SCRAPE QUEUE] Error in session paused callback:', error);
      }
    });
  }

  /**
   * Resume a paused session (user chose to retry)
   */
  resumeSession(sessionId: string): boolean {
    return this.sessionManager.resumeSession(sessionId);
  }

  /**
   * Cancel failed items for a session (user chose to remove failed items)
   */
  cancelFailedItems(sessionId: string): number {
    const failedIds = this.sessionManager.getFailedItems(sessionId);
    let cancelledCount = 0;

    for (const mfcId of failedIds) {
      if (this.cancel(mfcId)) {
        cancelledCount++;
      }
    }

    // Resume the session now that failed items are removed
    this.sessionManager.resumeSession(sessionId);

    console.log(`[SCRAPE QUEUE] Cancelled ${cancelledCount} failed items for session`);
    return cancelledCount;
  }

  /**
   * Cancel all items for a session (user chose to abort completely)
   */
  cancelAllForSession(sessionId: string): number {
    let cancelledCount = 0;

    // Find all items with this sessionId
    this.pendingItems.forEach((item, mfcId) => {
      if (item.sessionId === sessionId) {
        if (this.cancel(mfcId)) {
          cancelledCount++;
        }
      }
    });

    // Clear the session
    this.sessionManager.clearSession(sessionId);

    console.log(`[SCRAPE QUEUE] Cancelled all ${cancelledCount} items for session`);
    return cancelledCount;
  }

  /**
   * Get pending count for a session
   */
  getPendingCountForSession(sessionId: string): number {
    let count = 0;
    this.pendingItems.forEach((item) => {
      if (item.sessionId === sessionId) {
        count++;
      }
    });
    return count;
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Whether the spine ingest path is configured (an emitter is present).
   * Trigger routes use this to answer "ingest not configured" up front
   * instead of enqueueing items doomed to fail extraction_unavailable.
   */
  isIngestConfigured(): boolean {
    return this.ingestEmitter !== null;
  }

  /**
   * Whether the plugin registry resolves an extraction ruleset for this URL
   * (same lookup the processing loop uses; lookup errors count as no match).
   */
  hasRulesetForUrl(url: string): boolean {
    return this.lookupRuleset(url) !== undefined;
  }

  /**
   * Add an item to the scrape queue
   *
   * @param mfcId - Dedup key: an MFC item ID (legacy shape) or, when
   *   options.url is supplied, any caller-chosen key (trigger routes use the
   *   URL itself)
   * @param options - Enqueue options (priority, cookies, url, etc.)
   * @returns EnqueueResult with promise that resolves when scraping completes
   */
  enqueue(mfcId: string, options: EnqueueOptions = {}): EnqueueResult {
    const {
      priority = 'WARM',
      status,
      cookies,
      sessionId,
      userId = 'anonymous',
      maxRetries = RATE_LIMIT.DEFAULT_MAX_RETRIES,
    } = options;

    // Caller-supplied URL wins; otherwise build the MFC item URL from the key
    const url = options.url ?? `https://myfigurecollection.net/item/${mfcId}`;

    // A row on disk that `pendingItems` does not know about belongs to THIS queue and must be
    // CLAIMED, not duplicated. Two ways that happens: the item is parked (over the working-set cap),
    // or a previous process died holding its lease — and nothing else notices the second case,
    // because the expired-lease reaper only runs inside the dispatch scan and an idle queue never
    // scans. Minting a new row instead would fetch the item again inside the live lease and hand the
    // resident copy a fresh retry budget.
    //
    // The lookup is UNCONDITIONAL: gating it on `parkedCount > 0` skipped the stale-lease case
    // entirely, which is the normal case. One indexed SELECT at ~600 enqueues/hour is free, and it
    // only runs when the key is not already resident — an item being processed RIGHT NOW is still in
    // `pendingItems`, so this never reclaims work that is on the wire.
    if (!this.pendingItems.has(mfcId) && this.store.hasKey(mfcId)) {
      const orphan = this.store.claimKey(mfcId);
      if (orphan !== null) {
        this.adoptPersisted(orphan, false);
        this.parkedCount = this.store.counts().parked;
        // A claimed orphan lands in `pendingItems`, so the caller below takes the DEDUP path — which
        // deliberately never starts the loop, because an ordinary dedup joins an item something else
        // already set running. Nothing set this one running: it came off disk. Kick the loop, or the
        // row we just reclaimed sits resident and undispatched until some unrelated enqueue arrives.
        if (!this.testMode) this.startProcessing();
      }
    }

    // Check for deduplication
    const existingItem = this.pendingItems.get(mfcId);
    if (existingItem) {
      // Add user to waiting list and return existing promise
      if (!existingItem.waitingUserIds.includes(userId)) {
        existingItem.waitingUserIds.push(userId);
      }

      // Upgrade priority if new request is higher
      if (this.comparePriority(priority, existingItem.priority) > 0) {
        this.upgradePriority(existingItem, priority);
      }

      // Update cookies if new request has them and existing doesn't
      if (cookies && !existingItem.cookies) {
        existingItem.cookies = cookies;
        existingItem.sessionId = sessionId;
        // Upgrade to HOT if we now have cookies
        if (priority !== 'COLD') {
          this.upgradePriority(existingItem, 'HOT');
        }
      }

      // Create promise for this caller
      const promise = new Promise<ScrapedData>((resolve, reject) => {
        existingItem.resolvers.push({ resolve, reject });
      });
      // Prevent unhandled rejection crash when items are cancelled
      promise.catch(() => {});

      // mfcId can be a caller-supplied URL (trigger route) — sanitize for log
      console.log(`[SCRAPE QUEUE] Deduplicated request for ${sanitizeForLog(mfcId)} (${existingItem.waitingUserIds.length} users waiting)`); // lgtm[js/log-injection]

      return {
        id: existingItem.id,
        deduplicated: true,
        position: this.getPosition(existingItem),
        promise,
      };
    }

    // Create new queue item
    const id = `${mfcId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // Determine effective priority
    // Items with cookies go to HOT, unless explicitly COLD
    let effectivePriority = priority;
    if (cookies && priority !== 'COLD') {
      effectivePriority = 'HOT';
    }

    const item: QueueItem = {
      id,
      mfcId,
      url,
      priority: effectivePriority,
      status,
      cookies,
      sessionId,
      retryCount: 0,
      maxRetries,
      queuedAt: Date.now(),
      waitingUserIds: [userId],
      resolvers: [],
    };

    // Create promise for first caller
    const promise = new Promise<ScrapedData>((resolve, reject) => {
      item.resolvers.push({ resolve, reject });
    });
    // Prevent unhandled rejection crash when items are cancelled
    promise.catch(() => {});

    // DURABILITY: write the item down before anything can drop it. Over the working-set caps it
    // goes STRAIGHT to disk as `parked` and never enters a tier — only the caller's promise handlers
    // stay in the heap, so depth above the cap costs a pair of closures rather than a queue entry
    // plus an O(n) insertion scan on every subsequent enqueue.
    if (this.shouldPark(item)) {
      this.store.put(this.toPersisted(item, 'parked'));
      this.parkedResolvers.set(mfcId, item.resolvers);
      this.parkedCount++;
    } else {
      // Add to appropriate queue
      this.addToQueue(item);
      this.pendingItems.set(mfcId, item);
      if (this.persistable(item)) this.store.put(this.toPersisted(item, 'pending'));
    }

    // Track per-status totals
    const itemStatus = status || 'wished';
    this.statusQueued[itemStatus]++;

    // mfcId can be a caller-supplied URL (trigger route) — sanitize for log
    console.log(`[SCRAPE QUEUE] Enqueued ${sanitizeForLog(mfcId)} at priority ${effectivePriority} (queue size: ${this.getStats().total})`); // lgtm[js/log-injection]

    // Start processing if not already running (skip in test mode)
    if (!this.testMode) {
      this.startProcessing();
    }

    return {
      id: item.id,
      deduplicated: false,
      position: this.getPosition(item),
      promise,
    };
  }

  /**
   * Bulk enqueue multiple items
   *
   * @param items - Array of {mfcId, ...options}
   * @returns Array of EnqueueResults
   */
  enqueueBulk(items: Array<{ mfcId: string } & EnqueueOptions>): EnqueueResult[] {
    console.log(`[SCRAPE QUEUE] Bulk enqueue: ${items.length} items`);
    // ONE transaction for the whole burst: the crawler enqueues 50 per store, and 50 commits would
    // be 50 fsyncs where one will do.
    return this.store.batch(() => items.map(({ mfcId, ...options }) => this.enqueue(mfcId, options)));
  }

  /**
   * Get current queue statistics
   */
  getStats(): QueueStats {
    return {
      hot: this.hotQueue.length,
      warm: this.warmQueue.length,
      cold: this.coldQueue.length,
      total: this.hotQueue.length + this.warmQueue.length + this.coldQueue.length,
      parked: this.parkedCount,
      processing: this.processingItem ? 1 : 0,
      completed: this.completedCount,
      failed: this.failedCount,
      rateLimited: this.isRateLimited,
      currentDelay: this.currentDelay,
      byStatus: {
        owned: {
          queued: this.statusQueued.owned,
          completed: this.statusCompleted.owned,
          failed: this.statusFailed.owned,
        },
        ordered: {
          queued: this.statusQueued.ordered,
          completed: this.statusCompleted.ordered,
          failed: this.statusFailed.ordered,
        },
        wished: {
          queued: this.statusQueued.wished,
          completed: this.statusCompleted.wished,
          failed: this.statusFailed.wished,
        },
      },
    };
  }

  /**
   * Check if an item is already pending in the queue
   */
  isPending(mfcId: string): boolean {
    return this.pendingItems.has(mfcId);
  }

  /**
   * Get waiting users for an item
   */
  getWaitingUsers(mfcId: string): string[] {
    const item = this.pendingItems.get(mfcId);
    return item ? [...item.waitingUserIds] : [];
  }

  /**
   * Cancel a pending item (if not already processing)
   */
  cancel(mfcId: string): boolean {
    const item = this.pendingItems.get(mfcId);
    if (!item || item === this.processingItem) {
      return false;
    }

    this.removeFromQueue(item);
    this.pendingItems.delete(mfcId);
    this.store.remove(item.id);

    // Reject all waiting promises
    const cancelError = new Error('Request cancelled');
    item.resolvers.forEach(({ reject }) => reject(cancelError));

    console.log(`[SCRAPE QUEUE] Cancelled request for ${mfcId}`);
    return true;
  }

  /**
   * Clear all queues (emergency use only)
   */
  clear(): void {
    // Only reject pending promises in production mode
    // In test mode, silently discard to avoid unhandled promise rejections
    if (!this.testMode) {
      const cancelError = new Error('Queue cleared');
      this.pendingItems.forEach(item => {
        item.resolvers.forEach(({ reject }) => reject(cancelError));
      });
    }

    // Parked items have no QueueItem in the heap, only the caller's handlers — settle those too so
    // a clear() never leaves a promise hanging on work that no longer exists.
    if (!this.testMode) {
      const cancelError = new Error('Queue cleared');
      this.parkedResolvers.forEach((resolvers) => resolvers.forEach(({ reject }) => reject(cancelError)));
    }

    this.hotQueue = [];
    this.warmQueue = [];
    this.coldQueue = [];
    this.pendingItems.clear();
    this.parkedResolvers.clear();
    this.store.clearAll();
    this.parkedCount = 0;

    // Reset per-status counters
    this.statusQueued = { owned: 0, ordered: 0, wished: 0 };
    this.statusCompleted = { owned: 0, ordered: 0, wished: 0 };
    this.statusFailed = { owned: 0, ordered: 0, wished: 0 };

    console.log('[SCRAPE QUEUE] All queues cleared');
  }

  /**
   * Stop queue processing
   */
  stop(): void {
    if (this.processInterval) {
      clearInterval(this.processInterval);
      this.processInterval = null;
    }
    // Clear cooldown wait timer to prevent orphaned timer callbacks
    if (this.cooldownWaitTimerId) {
      clearTimeout(this.cooldownWaitTimerId);
      this.cooldownWaitTimerId = null;
    }
    this.isProcessing = false;
    console.log('[SCRAPE QUEUE] Processing stopped');
  }

  /**
   * Manually trigger rate limit mode (useful when Cloudflare detected externally)
   */
  triggerRateLimit(): void {
    this.handleRateLimit();
  }

  // ==========================================================================
  // Private Methods - Queue Management
  // ==========================================================================

  // ==========================================================================
  // Private Methods - Durability
  // ==========================================================================

  /**
   * Whether this item may be written to disk. A COOKIE-BEARING item never is: `QueueItem.cookies` is
   * documented "ephemeral, never stored", the item is bound to a live user session, and the HTTP
   * caller waiting on it dies with the process anyway. Nothing about such an item reaches the store.
   */
  private persistable(item: QueueItem): boolean {
    return item.cookies === undefined;
  }

  /** The item's on-disk projection — the persistable SUBSET only (see queueStore.ts). */
  private toPersisted(item: QueueItem, state: PersistedQueueItem['state']): PersistedQueueItem {
    return {
      id: item.id,
      mfcId: item.mfcId,
      url: item.url,
      priority: item.priority,
      ...(item.status !== undefined ? { status: item.status } : {}),
      ...(item.sessionId !== undefined ? { sessionId: item.sessionId } : {}),
      attempts: item.retryCount,
      maxRetries: item.maxRetries,
      enqueuedAt: item.queuedAt,
      state,
      ...(item.errorType !== undefined ? { lastErrorClass: item.errorType } : {}),
    };
  }

  /** Resident depth across the three tiers — what the working-set caps are measured against. */
  private residentCount(): number {
    return this.hotQueue.length + this.warmQueue.length + this.coldQueue.length;
  }

  /** Resident items for one host. Only ever called once the total is already at the per-host cap. */
  private residentForHost(host: string): number {
    let n = 0;
    for (const queue of [this.hotQueue, this.warmQueue, this.coldQueue]) {
      for (const item of queue) if (this.hostOf(item.url) === host) n++;
    }
    return n;
  }

  /** Hosts already at their resident cap — skipped when paging parked rows back in. */
  private hostsAtCap(perHost: number): string[] {
    const counts = new Map<string, number>();
    for (const queue of [this.hotQueue, this.warmQueue, this.coldQueue]) {
      for (const item of queue) {
        const host = this.hostOf(item.url);
        if (host !== undefined) counts.set(host, (counts.get(host) ?? 0) + 1);
      }
    }
    return [...counts.entries()].filter(([, n]) => n >= perHost).map(([host]) => host);
  }

  /**
   * Whether this enqueue must go to disk instead of a tier. Never on the fallback: parking without a
   * disk behind it would DELETE the item, which is precisely the bug this whole change exists to fix.
   */
  private shouldPark(item: QueueItem): boolean {
    if (!this.store.durable || !this.persistable(item)) return false;
    const resident = this.residentCount();
    const perHost = resolveMaxResidentPerHost();
    if (resident >= resolveMaxResident()) return true;
    // A single host cannot be over its own cap while the WHOLE working set is under it, so the
    // O(n) per-host scan below is skipped entirely on the normal path.
    if (resident < perHost) return false;
    const host = this.hostOf(item.url);
    if (host === undefined) return false;
    return this.residentForHost(host) >= perHost;
  }

  /**
   * Rebuild a persisted row as a live QueueItem and put it in a tier. Returns false when the dedup
   * key is already resident (nothing to adopt). `countStatus` bumps the per-status queued counter —
   * true on a startup reload (the counters are empty), false when paging a row back in (it was
   * already counted at its original enqueue).
   *
   * A restored item carries NO cookies and NO waiting users: those belonged to a connection that
   * died with the previous process. Its resolvers come from `parkedResolvers` when this process is
   * the one that parked it.
   */
  private adoptPersisted(row: PersistedQueueItem, countStatus: boolean): boolean {
    if (this.pendingItems.has(row.mfcId)) return false;
    const item: QueueItem = {
      id: row.id,
      mfcId: row.mfcId,
      url: row.url,
      priority: row.priority,
      ...(row.status !== undefined ? { status: row.status } : {}),
      ...(row.sessionId !== undefined ? { sessionId: row.sessionId } : {}),
      retryCount: row.attempts,
      maxRetries: row.maxRetries,
      queuedAt: row.enqueuedAt,
      ...(row.lastErrorClass !== undefined ? { errorType: row.lastErrorClass as ErrorType } : {}),
      waitingUserIds: [],
      resolvers: this.parkedResolvers.get(row.mfcId) ?? [],
    };
    this.parkedResolvers.delete(row.mfcId);
    this.addToQueue(item);
    this.pendingItems.set(row.mfcId, item);
    if (countStatus) this.statusQueued[row.status ?? 'wished']++;
    return true;
  }

  /**
   * Top the working set back up from disk: reap leases the dead process never released, then page
   * parked rows into the tiers up to the caps. Returns how many items became resident.
   *
   * Called before each dispatch scan. On today's traffic both halves are no-ops — the reaper is
   * throttled to once a minute and there is nothing parked below the 1000-item cap.
   */
  refillWorkingSet(now: number = Date.now()): number {
    if (!this.store.durable) return 0;
    let loaded = 0;

    // A lease left by a `kill -9` is released by NOTHING but its own expiry, so this sweep is the
    // only thing that re-drives an item the dead process was mid-navigation on.
    if (now - this.lastLeaseReapAt >= LEASE_REAP_INTERVAL_MS) {
      this.lastLeaseReapAt = now;
      for (const row of this.store.reapExpiredLeases(now)) {
        if (this.adoptPersisted(row, false)) loaded++;
      }
    }

    if (this.parkedCount > 0) {
      const budget = resolveMaxResident() - this.residentCount();
      if (budget > 0) {
        const skipHosts = this.hostsAtCap(resolveMaxResidentPerHost());
        for (const row of this.store.pageIn(budget, { skipHosts })) {
          if (this.adoptPersisted(row, false)) loaded++;
        }
        // Re-read rather than decrement: a count that can never drift is worth one COUNT query.
        this.parkedCount = this.store.counts().parked;
      }
    }
    return loaded;
  }

  private addToQueue(item: QueueItem): void {
    const queue = this.getQueueForPriority(item.priority);

    // Check queue size limit
    if (queue.length >= RATE_LIMIT.MAX_QUEUE_SIZE) {
      console.warn(`[SCRAPE QUEUE] ${item.priority} queue full, rejecting item`);
      const error = new Error('Queue full - try again later');
      item.resolvers.forEach(({ reject }) => reject(error));
      return;
    }

    // Sort by priority score within the queue
    const score = this.calculateItemScore(item);
    const insertIndex = queue.findIndex(existing =>
      this.calculateItemScore(existing) < score
    );

    if (insertIndex === -1) {
      queue.push(item);
    } else {
      queue.splice(insertIndex, 0, item);
    }
  }

  private removeFromQueue(item: QueueItem): void {
    const queue = this.getQueueForPriority(item.priority);
    const index = queue.indexOf(item);
    if (index !== -1) {
      queue.splice(index, 1);
    }
  }

  private getQueueForPriority(priority: QueuePriority): QueueItem[] {
    switch (priority) {
      case 'HOT': return this.hotQueue;
      case 'WARM': return this.warmQueue;
      case 'COLD': return this.coldQueue;
    }
  }

  private getNextItem(): QueueItem | null {
    // HOT queue first (highest priority)
    if (this.hotQueue.length > 0) {
      return this.hotQueue.shift()!;
    }

    // Then WARM queue
    if (this.warmQueue.length > 0) {
      return this.warmQueue.shift()!;
    }

    // Finally COLD queue
    if (this.coldQueue.length > 0) {
      return this.coldQueue.shift()!;
    }

    return null;
  }

  private upgradePriority(item: QueueItem, newPriority: QueuePriority): void {
    if (this.comparePriority(newPriority, item.priority) <= 0) {
      return; // Not an upgrade
    }

    this.removeFromQueue(item);
    item.priority = newPriority;
    this.addToQueue(item);
    // Record it, so an item restored after a restart comes back in the lane it was raised to.
    this.store.setPriority(item.id, newPriority);

    console.log(`[SCRAPE QUEUE] Upgraded ${item.mfcId} to ${newPriority}`);
  }

  private comparePriority(a: QueuePriority, b: QueuePriority): number {
    const order: Record<QueuePriority, number> = { HOT: 3, WARM: 2, COLD: 1 };
    return order[a] - order[b];
  }

  private getPosition(item: QueueItem): number {
    const queue = this.getQueueForPriority(item.priority);
    const indexInQueue = queue.indexOf(item);

    if (indexInQueue === -1) return -1;

    // Calculate position considering higher priority queues
    switch (item.priority) {
      case 'HOT':
        return indexInQueue;
      case 'WARM':
        return this.hotQueue.length + indexInQueue;
      case 'COLD':
        return this.hotQueue.length + this.warmQueue.length + indexInQueue;
    }
  }

  private calculateItemScore(item: QueueItem): number {
    let score = 0;

    // Status priority: owned > ordered > wished
    const statusScores: Record<ItemStatus, number> = {
      owned: 30,
      ordered: 20,
      wished: 10,
    };
    score += statusScores[item.status || 'wished'] || 0;

    // Cookie session boost (active session gets priority)
    if (item.cookies && item.sessionId) {
      score += 20;
    }

    // User count boost (popular items get priority)
    score += Math.min(20, item.waitingUserIds.length * 5);

    // Age penalty (older queued items get slight boost)
    const ageMinutes = (Date.now() - item.queuedAt) / 60000;
    score += Math.min(10, ageMinutes);

    return score;
  }

  // ==========================================================================
  // Private Methods - Processing
  // ==========================================================================

  private startProcessing(): void {
    if (this.processInterval) return; // Already running

    this.isProcessing = true;
    this.processNext();

    console.log('[SCRAPE QUEUE] Processing started');
  }

  private async processNext(): Promise<void> {
    // Double-lock guard: prevent concurrent processing
    // Lock 1: Check processingItem (set when actively scraping)
    if (this.processingItem !== null) {
      return; // Already processing an item - wait for it to complete
    }

    // Lock 2: Check isProcessing flag (set when processNext loop is active)
    // This catches edge cases where processingItem is null but we're between items
    if (!this.isProcessing) {
      return; // Processing loop not active - don't start new work
    }

    const now = Date.now();

    // GLOBAL BACKOFF BRAKE (D-11): the blanket inter-request delay applies ONLY while a rate-limit
    // backoff is in effect (`isRateLimited`) — a CF-storm safety net that briefly serializes ALL
    // hosts on the escalated `currentDelay` until SUCCESS_THRESHOLD clean successes recover it.
    // During NORMAL operation there is NO global blanket: primary-dispatch pacing is PER-HOST
    // (getNextProcessableItem's per-host floor, keyed on the request's host), so independent hosts
    // are never serialized behind one another — retiring the 2067 ms global base delay that
    // DECISIONS-PENDING.md D-11 flags as 1.7x over the per-host budget.
    if (this.isRateLimited) {
      const timeSinceLastRequest = now - this.lastRequestTime;
      if (timeSinceLastRequest < this.currentDelay) {
        // Schedule next attempt after delay (unless cooldown timer already handling retry)
        if (!this.cooldownWaitTimerId) {
          const waitTime = this.currentDelay - timeSinceLastRequest;
          setTimeout(() => this.processNext(), waitTime);
        }
        return;
      }
    }

    // Get next item, considering paused sessions, cooldowns, and per-host pacing
    const item = this.getNextProcessableItem(now);
    if (!item) {
      // Queue empty or all items blocked, stop processing
      this.isProcessing = false;
      const queueSizes = {
        hot: this.hotQueue.length,
        warm: this.warmQueue.length,
        cold: this.coldQueue.length,
        total: this.hotQueue.length + this.warmQueue.length + this.coldQueue.length
      };
      if (queueSizes.total === 0) {
        console.log('[SCRAPE QUEUE] Queue empty, processing stopped');
      } else {
        console.log(`[SCRAPE QUEUE] All ${queueSizes.total} items blocked (paused/cooldown), processing paused. Hot: ${queueSizes.hot}, Warm: ${queueSizes.warm}, Cold: ${queueSizes.cold}`);
      }
      return;
    }

    // Acquire item lock - set BEFORE any async operations
    this.processingItem = item;
    // Remember the last REAL request time: a challenge_cooldown fast-fail (below) never touches the
    // network, so it must not consume this global pacing slot — we restore this value in that case.
    const prevLastRequestTime = this.lastRequestTime;
    this.lastRequestTime = now;

    const poolAvailable = BrowserPool.getPoolSize();
    console.log(`[SCRAPE QUEUE] Processing ${item.mfcId} (${item.priority}, attempt ${item.retryCount + 1}/${item.maxRetries + 1}, delay=${this.currentDelay}ms, pool=${poolAvailable}/${BrowserPool.getPoolCapacity()})`);

    let fastFailedOnCooldown = false;
    try {
      // Extraction is plugin-only: an ingest emitter must be configured AND
      // a plugin ruleset must match the item's URL. Anything else is a
      // clean, non-retryable item failure (never a crash, never silent).
      const ruleset = this.ingestEmitter ? this.lookupRuleset(item.url) : undefined;

      if (this.ingestEmitter && ruleset) {
        const fields = await this.processViaIngest(item, ruleset);
        this.handleSuccess(item, fields);
      } else {
        const reason = !this.ingestEmitter
          ? 'no ingest emitter configured (INGEST_BASE_URL unset)'
          : `no plugin ruleset matches ${item.url}`;
        throw new Error(`EXTRACTION_UNAVAILABLE: ${reason}`);
      }

    } catch (error: any) {
      // Handle failure
      fastFailedOnCooldown = error instanceof ChallengeCooldownError;
      this.handleFailure(item, error);
    }

    this.processingItem = null;

    if (fastFailedOnCooldown) {
      // A challenge_cooldown fast-fail made NO network request, so it must not burn a global pacing
      // slot: restore the pre-dispatch lastRequestTime and re-drive immediately. Otherwise N cooling
      // items ahead of a healthy host's item would delay it by N×currentDelay for no-op failures
      // (the cooling host's own siblings stay held off by the per-host floor, not the global lane).
      this.lastRequestTime = prevLastRequestTime;
      if (!this.cooldownWaitTimerId) {
        setTimeout(() => this.processNext(), 0);
      }
    } else if (!this.cooldownWaitTimerId) {
      // Schedule the next dispatch (unless cooldown timer already handling retry). Under NORMAL
      // operation re-drive IMMEDIATELY (0) and let getNextProcessableItem's per-host floor pace the
      // next item — it schedules a precise re-check when every ready item is host-paced (D-11). Only
      // while an active rate-limit backoff is in effect do we honor the escalated global brake.
      const nextIn = this.isRateLimited ? this.currentDelay : 0;
      setTimeout(() => this.processNext(), nextIn);
    }
  }

  /**
   * Resolve a plugin ruleset for a URL. A lookup failure (e.g. unparseable
   * URL) is treated as "no match" so the legacy path still gets its chance.
   */
  private lookupRuleset(url: string): ExtractionRuleset | undefined {
    if (!this.pluginRegistry) return undefined;
    try {
      return this.pluginRegistry.getRulesetForUrl(url);
    } catch {
      return undefined;
    }
  }

  private getRawPageFetcher(): RawPageFetcher {
    if (!this.rawPageFetcher) {
      // Same raw page-fetch machinery plugins get via EngineServices — the
      // engine only fetches; extraction is the plugin's job.
      this.rawPageFetcher = createScrapingService(getRawCaptureSink());
    }
    return this.rawPageFetcher;
  }

  /**
   * The item URL's store's declared search transport (undefined = undeclared → the ingest fetch
   * defaults to the browser lane). A lookup failure (e.g. unparseable URL, or no registry yet)
   * is treated the same as "undeclared" rather than throwing — the raw fetch still gets a lane.
   */
  private getSearchFetchFor(url: string): SearchFetch | undefined {
    if (!this.profiles) return undefined;
    try {
      return this.profiles.forHost(new URL(url).hostname)?.searchFetch;
    } catch {
      return undefined;
    }
  }

  /**
   * Build the ingest path's transport-aware capturing fetch. Rebuilt per call (cheap — it's a
   * thin dispatcher) so DI overrides from setIngestTransports/setCaptureSink/setScrapingService
   * are always picked up, including ones applied after this queue instance already fetched once.
   */
  private getCapturingFetch(): CapturingFetch {
    return createCapturingFetch(
      {
        // The DETAILED variants: same request, same profile/jar/cookies/timeout, but they carry the
        // response's status and post-redirect URL through to the gate below. An injected transport
        // (tests, and any caller still handing over a bare string fetcher) is used as given.
        impersonate: this.impersonateFetch ?? impitFetchBodyDetailed,
        http: this.httpFetch ?? httpFetchBodyDetailed,
        browser: this.getRawPageFetcher(),
      },
      this.captureSink ?? getRawCaptureSink(),
      // An INJECTED stored-cookie store reaches the dispatcher's stealth selection too; without one
      // the dispatcher resolves the singleton itself, per call (hot reload).
      this.cfCookieStore ? { cookieStore: this.cfCookieStore } : {},
    );
  }

  /**
   * The ingest path: fetch the item's raw body via the store's declared transport (impersonate /
   * http / browser — undeclared defaults to browser), hand it to the plugin's ruleset for
   * extraction, and emit the result to the aggregation spine. No webhook leg here. Throws on
   * fetch, extraction, or emit failure so the item flows through the queue's existing failure
   * handling (never a silent drop). Returns the extracted field bag so waiting callers' promises
   * still resolve.
   */
  private async processViaIngest(item: QueueItem, ruleset: ExtractionRuleset): Promise<ScrapedData> {
    const searchFetch = this.getSearchFetchFor(item.url);
    const host = this.hostOf(item.url);
    // CHALLENGE COOLDOWN (fast fail, before any fetch): if this host is cooling from a recent CF
    // challenge, do NOT fetch it — every challenge fetch degrades the egress IP's CF reputation.
    // Fail the item immediately with a typed ChallengeCooldownError (→ challenge_cooldown: not
    // retried, never the cookie-session-pause path). Expiry: once `until` passes, isOpen is false and
    // the fetch below proceeds normally.
    const cooldown = this.getChallengeCooldownStore();
    if (host !== undefined && cooldown.isOpen(host)) {
      const minsLeft = Math.max(1, Math.ceil(cooldown.remaining(host) / 60_000));
      console.warn(`[COOLDOWN] skipped ${sanitizeForLog(item.url)} (${host} cooling, ${minsLeft} min left)`);
      throw new ChallengeCooldownError(host, cooldown.remaining(host));
    }
    const page = await this.getCapturingFetch()(item.url, searchFetch, { cookies: item.cookies });
    // A clean (non-challenge) body proves this host serves real pages again — clear a lingering,
    // now-EXPIRED cooldown entry so /health/detailed stops listing it and the recovery is logged.
    // Guard on !isOpen: a still-LIVE window (one the search fan-out opened on this host WHILE this
    // fetch was in flight — the fetch passed isOpen before that open) must SURVIVE, or clearing it
    // here would drop the protection and let the next item fetch the cooling host (F4 race).
    // The same clean body is the STORED-COOKIE FRESH signal (CfCookieStore): a host WITH stored
    // cookies that served a real page has a live cookie — clear its stale mark. Same isOpen guard,
    // for the same reason: a window (and stale mark) opened while this fetch was in flight survives.
    if (host !== undefined && !page.challenge && !cooldown.isOpen(host)) {
      cooldown.clear(host);
      markFreshIfStored(this.getCfCookieStoreRef(), item.url, host);
    }
    // SESSION CANARY: this fetch is already an observation. On a store whose 404 may be an
    // entitlement denial, a 404 on the configured canary item plus a 200 on any other item of the
    // same store within the hour proves the scrape session lost its entitlement (→ the stale flag on
    // /health/detailed, and the cookie runbook). Costs one comparison on traffic that was happening
    // anyway, moves nothing unless that exact pair is seen, and never throws.
    observeMfcItemFetch(item.url, page.status);
    // STATUS GATE (R1) — what the STORE said, before the ruleset is asked to lift anything. Every
    // lane now surfaces {status, finalUrl}, so a 404/410 (the item is gone), a 403/429/5xx (the door
    // is closed or the host is unwell) and an item URL that bounced to the store's front page each
    // fail HERE, named by the store's own answer. Left un-gated they reached the ruleset, failed
    // extraction, and were booked against OUR parser — a `parse` / `ruleset` / `other` row for
    // something we did not do, with a terminal 404 retried to exhaustion first.
    //
    // A CHALLENGE-flagged body is deliberately exempt: a Cloudflare interstitial usually carries a
    // 403/503, and its recovery (a ruleset's own follow-up transport — the amiami case) and its
    // discipline (one shot + host cooldown) belong to the challenge path below. Gating it here would
    // book it as http_403 and skip the cooldown that protects the egress IP.
    if (!page.challenge) {
      const statusFailure = evaluateRecordFetch(item.url, page, laneOf(searchFetch));
      if (statusFailure) {
        console.warn(`[FETCH] ${sanitizeForLog(statusFailure.message)}`);
        throw statusFailure;
      }
    }
    // Anchor for the courtesy gap (D8): the instant the PRIMARY fetch completed, so a same-store
    // `ctx.scraping.fetchBody` follow-up (extractMany's second call) waits the store's declared
    // gap against THIS fetch, not against whenever the follow-up happens to be invoked.
    const primaryFetchedAt = Date.now();
    const ctx = this.buildIngestExtractContext(item, ruleset, searchFetch, primaryFetchedAt);

    let records: PluginExtractedData[];
    try {
      // extractRecords folds extractMany > extractAsync > extract into one always-array result
      // (engineServices/extractRecords.ts) — a single-record ruleset's own extraction call is
      // byte-for-byte what it was before this dispatch existed; only the caller-facing shape
      // (array vs bare object) is new. D11 guards (empty / dup itemId / target-before-source) run
      // inside it: a violation throws here, so nothing is emitted, same as any other extraction
      // failure.
      records = await extractRecords(ruleset, page.html, item.url, ctx);
    } catch (error: any) {
      // VALID-EMPTY (Ross directive: "differentiate between no data when none expected and no data
      // as error"). A ruleset that EXPLICITLY opted in via `emptyResultIsValid` AND returned zero
      // records (EmptyExtractionError) on a NON-challenge page has SUCCESSFULLY determined there is
      // genuinely nothing to emit — a well-formed empty listing/search result. Record it as a
      // SUCCESS (empty), never an error: the distinction is the EXTRACTOR'S OWN explicit signal +
      // its returned-empty, never the row count alone. A challenge page (blocked, not truly empty),
      // a non-opting ruleset's empty, or any other extraction throw stays a failure below.
      if (error instanceof EmptyExtractionError && ruleset.emptyResultIsValid === true && !page.challenge) {
        console.log(
          `[SCRAPE QUEUE] Ingest complete for ${item.url}: persisted=0 emitted=0 valid-empty ` +
            `(ruleset ${ruleset.siteId}@${ruleset.version} declared an empty extraction valid)`
        );
        return {} as ScrapedData;
      }
      console.error(
        `[SCRAPE QUEUE] Extraction failed for ${item.url} (ruleset ${ruleset.siteId}@${ruleset.version}): ${sanitizeForLog(error?.message ?? String(error))}`
      );
      // CHALLENGE PAGE, EXTRACTION THREW — the SECOND door into the challenge-retry storm (live
      // 2026-09-06, orzgk). A challenge has two exits: (a) extraction SUCCEEDS on the challenge body
      // (a JSON-tolerant or follow-up-transport ruleset) and the post-emit honesty gate below decides
      // persisted-0 → ChallengePageError + cooldown vs persisted>0 → amiami recovery; (b) extraction
      // THROWS on it (a JSON-only ruleset fed CF's HTML interstitial trips the D11 itemId guard, or a
      // non-opting ruleset returns empty) — which used to rethrow a PLAIN Error → 'unknown' → retried
      // up to maxRetries, re-fetching the challenge page every time, and the cooldown (only reachable
      // via door (a)) never opened. Door (b) now takes the same one-shot exit: open the host cooldown
      // and raise the typed ChallengePageError (rate_limited, never retried; later same-host items
      // fast-fail on ChallengeCooldownError before any fetch). The amiami recovery is untouched — it
      // lives in door (a), where extraction did not throw.
      if (page.challenge) {
        const lane = page.transport ?? 'unknown';
        const reason = `challenge page via ${lane} transport (extraction failed)`;
        if (host !== undefined) {
          cooldown.open(host, reason);
          // STORED-COOKIE STALE signal: a host WITH stored cookies still got challenged → its cookie
          // is dead (the engine cannot re-mint; /health/detailed flags it for the operator). A host
          // without stored cookies is never marked. Storm protection above is unchanged.
          markStaleIfStored(this.getCfCookieStoreRef(), item.url, host, lane, reason);
        }
        console.error(
          `[SCRAPE QUEUE] Extraction failed on a challenge page for ${sanitizeForLog(item.url)} (ruleset ${ruleset.siteId}@${ruleset.version}) — one-shot fail, host cooldown opened`
        );
        throw new ChallengePageError(item.url, page.transport ?? 'unknown', []);
      }
      throw error instanceof Error ? error : new Error(String(error));
    }

    // IMAGE CAPTURE (capture-only): the extraction succeeded, so the store's own plates are now
    // nameable. Fire-and-forget, ahead of the emit it is independent of — see captureRecordImages.
    this.captureRecordImages(records, item, ruleset, searchFetch);

    // D2: N sequential unary Ingest calls in array order, parent FIRST, each awaited — STOP at
    // the first failure. The ingest server commits a record before the call resolves, so an
    // awaited prefix guarantees every later (dependent, e.g. editionOf/offerOf) record's target
    // already landed before it is sent. A failure here is a PARTIAL-EMIT state: logged and
    // counted (never silently swallowed), then rethrown through the queue's existing failure
    // handling — the retry re-fetches, re-extracts, and re-emits ALL records as new honest
    // observations (no partial-batch ambiguity: there is no batch, only a resumable prefix).
    let emittedCount = 0;
    let sentCount = 0;
    let totalPersisted = 0;
    try {
      for (const record of records) {
        // send() resolves the server WriteStats (any OK RPC); the queue's IngestSender narrows it to
        // unknown, so read it through the structural IngestRecordStats view. A send() that resolves
        // undefined/null (no WriteStats at all) is normalized to an empty {} so it accounts as a
        // zeroed, persisted-nothing record (→ EmptyIngestRecordError via the gate below), never a
        // TypeError from reading stats.claims on undefined.
        const stats = ((await this.ingestEmitter!.send(record)) ?? {}) as IngestRecordStats;
        // This record reached the emitter and returned a response — count it as SENT before the
        // honesty gate below can reject it, so a partial-emit failure log reports records SENT
        // (including the one that persisted nothing), distinct from the rows actually PERSISTED.
        sentCount++;
        const label = `${record.source.site}:${record.source.itemId}`;
        logIngestStats(label, stats);
        const persisted = persistedRows(stats);
        // HONESTY GATE: an OK RPC that persisted nothing (inserted+deduped==0 across all four tables)
        // is a FAILURE, not success. All-deduped (idempotent re-run) has deduped>0 and passes.
        if (persisted === 0) {
          // A page the transport FLAGGED as a Cloudflare challenge/block that ALSO persisted nothing
          // is a TRANSPORT failure (rate_limited → backoff + CF tracking), named by its lane — the
          // branch's class-based classification owns it. A plain persisted-nothing page is an empty
          // record. The transport is trusted for the flag; the gate is trusted for persist-or-fail.
          if (page.challenge) {
            // Genuine challenge that persisted nothing: OPEN the host's cooldown so the next item for
            // it (and the lookup fan-out's search of it) is left alone until the window expires.
            const lane = page.transport ?? 'unknown';
            const reason = `challenge page via ${lane} transport`;
            if (host !== undefined) {
              cooldown.open(host, reason);
              // STORED-COOKIE STALE signal (see the extraction-throw door above): only a host the
              // store has cookies for is marked, once.
              markStaleIfStored(this.getCfCookieStoreRef(), item.url, host, lane, reason);
            }
            throw new ChallengePageError(item.url, lane, stats.warnings ?? []);
          }
          throw new EmptyIngestRecordError(record.source.site, record.source.itemId, stats.warnings ?? []);
        }
        if (page.challenge) {
          // amiami case: the primary page was a challenge/block body, but the ruleset recovered the
          // real record through its OWN follow-up transport (ctx.scraping.fetchBody -> item API).
          // Persisted > 0 ⇒ honest success — log it, never fail.
          console.log(
            `[INGEST STATS] challenge page received for ${sanitizeForLog(label)} but the ruleset recovered ${persisted} rows via its own transport`
          );
        }
        totalPersisted += persisted;
        emittedCount++;
      }
    } catch (error: any) {
      console.error(
        `[SCRAPE QUEUE] Ingest emit failed for ${item.url} after ${sentCount}/${records.length} records emitted (persisted=${totalPersisted}) ` +
          `(ruleset ${ruleset.siteId}@${ruleset.version}): ${sanitizeForLog(error?.message ?? String(error))}`
      );
      throw error instanceof Error ? error : new Error(String(error));
    }

    console.log(
      `[SCRAPE QUEUE] Ingest complete for ${item.url}: persisted=${totalPersisted} emitted=${emittedCount}/${records.length} (ruleset ${ruleset.siteId}@${ruleset.version})`
    );

    // [0] is always the page's own record (extractMany's documented contract; the single-record
    // fallback's one-element array trivially satisfies it too) — handleSuccess/the /ingest/scrape
    // response stay parent-shaped, unchanged from today.
    return records[0].fields as ScrapedData;
  }

  /**
   * Build the ExtractContext for one item's extraction (B3, spec.md D1/D8/D9). Only
   * `scraping.fetchBody` is truly implemented (engineServices/extractContext.ts); it reuses the
   * SAME capturing fetch + the store's OWN declared `searchFetch` transport as the primary fetch,
   * so a same-store follow-up (e.g. orzgk's variation-batch endpoint) still lands in the capture
   * sink under the 'api' lane, courtesy-gapped against `primaryFetchedAt`.
   */
  private buildIngestExtractContext(
    item: QueueItem,
    ruleset: ExtractionRuleset,
    searchFetch: SearchFetch | undefined,
    primaryFetchedAt: number,
  ): ExtractContext {
    let hostname: string | undefined;
    try {
      hostname = new URL(item.url).hostname;
    } catch {
      hostname = undefined;
    }
    const caps = hostname ? this.profiles?.forHost(hostname) : undefined;
    // Fallback SiteConfig for the (should-be-rare) case a ruleset resolved but its store isn't in
    // the capability index — e.g. a stale/DI'd registry in tests. Mirrors the queue's own global
    // adaptive-lane defaults (RATE_LIMIT above) so a missing profile degrades to a sane, documented
    // gap rather than an undefined one.
    const config: SiteConfig =
      caps ?? {
        siteId: ruleset.siteId,
        name: ruleset.siteId,
        domains: hostname ? [hostname] : [],
        rateLimit: {
          domain: hostname ?? '',
          baseDelayMs: RATE_LIMIT.BASE_DELAY,
          minDelayMs: RATE_LIMIT.MIN_DELAY,
          maxDelayMs: RATE_LIMIT.MAX_DELAY,
          backoffMultiplier: RATE_LIMIT.BACKOFF_MULTIPLIER,
          recoveryDivisor: RATE_LIMIT.RECOVERY_DIVISOR,
          successThreshold: RATE_LIMIT.SUCCESS_THRESHOLD,
        },
        requiresBrowser: false,
        allowedCookies: [],
      };

    return buildExtractContext({
      config,
      logger: createPluginLogger(ruleset.siteId),
      scraping: this.getRawPageFetcher(),
      capturingFetch: this.getCapturingFetch(),
      searchFetch,
      cookies: item.cookies,
      primaryUrl: item.url,
      primaryFetchedAt,
      baseDelayMs: caps?.rateLimit?.baseDelayMs,
    });
  }

  /**
   * Get the next processable item, skipping paused sessions and respecting cooldowns
   */
  /** Lowercased, `www.`-stripped hostname (same normalization as ProfileRegistry); undefined on an unparseable URL. */
  private hostOf(url: string): string | undefined {
    try {
      return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      return undefined;
    }
  }

  /**
   * The per-host pacing delay — per-store DIFFERENTIATED (two knobs, fail-safe preserved):
   *
   *   effective = declared != null ? max(declared, hardFloor) : max(default, hardFloor)
   *
   * where `declared` is the store's own `rateLimit.baseDelayMs` (the SAME store-caps index the ingest
   * path's transport lookup already reads — buildIngestExtractContext above), `default` is
   * `SCRAPER_HOST_BASE_DELAY_MS` (else 4000 ms), and `hardFloor` is `SCRAPER_HOST_HARD_FLOOR_MS`
   * (else 1000 ms). So:
   *   - a host that DECLARES NO rate (no resolved profile) → the budget-safe DEFAULT (4000 ms) —
   *     UNCHANGED fail-safe; a forgotten env cannot silently run an unknown host over budget.
   *   - a store that DECLARES a rate → its OWN value, clamped UP to the hard floor. This is the
   *     differentiation: a clean JSON-API store can now be paced FASTER than 4000 ms (down to the
   *     hard floor) WITHOUT lowering the global default for every other host — and a mis-declared
   *     fast value (e.g. 40 ms) still clamps to the hard floor, so a typo can never hammer a host.
   *
   * NOTE: a store declaring a rate SLOWER than the default is still honored (max wins), so a store
   * asking to be paced gently is unaffected. Migrating a store to a fast declared rate is therefore a
   * DELIBERATE per-store change in its profile (scraper-rulesets), never a silent global acceleration.
   */
  private hostBaseDelayMs(host: string): number {
    // A declared rate is honored ONLY when finite: `??` catches null/undefined, but a NON-finite
    // number (NaN/Infinity) slips through — `Math.max(NaN, floor) = NaN` makes the dispatch gate
    // `NaN > 0` false (fail-OPEN: zero pacing), and `Math.max(Infinity, floor) = Infinity` stalls the
    // host forever. Both violate "the floor clamps EVERY host". Route a non-finite declared value to
    // the budget-safe 4000ms default instead — conservative (slower), never faster, never zero,
    // never a deadlock. Mirrors the Number.isFinite discipline resolvePositiveEnvMs already applies.
    const raw = this.profiles?.forHost(host)?.rateLimit?.baseDelayMs;
    const declared = typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
    const base = declared ?? resolveHostBaseDefaultMs();
    return Math.max(base, resolveHostHardFloorMs());
  }

  private getNextProcessableItem(now: number): QueueItem | null {
    // Top the working set up from disk BEFORE scanning: reap leases a dead process never released,
    // and page in parked rows if the tiers have drained below the caps. A no-op on today's traffic.
    this.refillWorkingSet(now);

    // Try each priority queue in order
    const queues = [this.hotQueue, this.warmQueue, this.coldQueue];
    let pausedCount = 0;
    let cooldownCount = 0;
    let hostPacedCount = 0;
    // Smallest remaining wait among host-paced items, so a purely-pacing block can re-check
    // precisely instead of falling back to the generic 5s cooldown poll below.
    let minHostWaitMs = Infinity;

    for (const queue of queues) {
      for (let i = 0; i < queue.length; i++) {
        const item = queue[i];

        // Check if this item's session is paused (for HOT items with cookies)
        if (item.cookies && item.sessionId) {
          if (this.sessionManager.isSessionPaused(item.sessionId)) {
            // Skip this item - session is paused waiting for user action
            pausedCount++;
            continue;
          }

          // Check if session is in cooldown after recent failure
          const cooldown = this.sessionManager.isInCooldown(item.sessionId);
          if (cooldown.inCooldown) {
            // Skip this item - still in cooldown, will try later
            cooldownCount++;
            continue;
          }
        }

        // Per-host floor: an item whose host was dispatched to more recently than its declared
        // baseDelayMs must wait — but ONLY this item; other hosts' items (including lower-priority
        // ones further down the lanes) are unaffected, so a paced host never stalls the rest of
        // the queue.
        const host = this.hostOf(item.url);
        if (host !== undefined) {
          const lastDispatch = this.hostLastDispatch.get(host);
          if (lastDispatch !== undefined) {
            const remaining = lastDispatch + this.hostBaseDelayMs(host) - now;
            if (remaining > 0) {
              hostPacedCount++;
              if (remaining < minHostWaitMs) minHostWaitMs = remaining;
              continue;
            }
          }
        }

        // This item is processable - remove from queue, record its host dispatch, and return
        queue.splice(i, 1);
        if (host !== undefined) this.hostLastDispatch.set(host, now);
        // LEASE it: the row stays on disk, marked as in-flight with an expiry. A crash here (the
        // `kill -9` / OOM case) leaves a lease that the next process's reaper re-drives, instead of
        // an item that simply vanished mid-navigation.
        this.store.lease(item.id, now + resolveLeaseMs());
        return item;
      }
    }

    // No processable items found - check if there are items waiting in cooldown or host-paced
    const totalBlocked = pausedCount + cooldownCount + hostPacedCount;
    if (totalBlocked > 0 && !this.cooldownWaitTimerId) {
      // Purely host-paced (no paused/cooldown items in the mix): re-check exactly when the
      // soonest-ready host clears, rather than the generic 5s poll below.
      const waitMs = pausedCount === 0 && cooldownCount === 0 && minHostWaitMs !== Infinity
        ? minHostWaitMs
        : 5000;
      // Log summary once and schedule SINGLE retry timer
      // Guard with cooldownWaitTimerId to prevent multiple concurrent timers
      console.log(`[SCRAPE QUEUE] All ${totalBlocked} items blocked (${pausedCount} paused, ${cooldownCount} in cooldown, ${hostPacedCount} host-paced), waiting ${waitMs}ms...`);
      this.cooldownWaitTimerId = setTimeout(() => {
        this.cooldownWaitTimerId = null; // Clear before retry to allow future timers
        // Always re-drive: `isProcessing` may already be true (e.g. a DIFFERENT item for another
        // host dispatched successfully while this one stayed blocked — see H1), in which case
        // nothing else schedules a further attempt for the item(s) that caused this timer.
        // processNext() is itself re-entrancy-safe (guarded by the processingItem lock), so
        // calling it unconditionally here is always correct, never a double-dispatch risk.
        this.isProcessing = true;
        this.processNext();
      }, waitMs);
    }

    return null;
  }

  private hasItemsInCooldownOrPaused(): boolean {
    const allItems = [...this.hotQueue, ...this.warmQueue, ...this.coldQueue];

    for (const item of allItems) {
      if (item.cookies && item.sessionId) {
        if (this.sessionManager.isSessionPaused(item.sessionId)) {
          return true;
        }
        if (this.sessionManager.isInCooldown(item.sessionId).inCooldown) {
          return true;
        }
      }
    }

    return false;
  }

  private handleSuccess(item: QueueItem, result: ScrapedData): void {
    // Track success
    this.completedCount++;
    this.consecutiveSuccesses++;

    // Track per-status completion
    const itemStatus = item.status || 'wished';
    this.statusCompleted[itemStatus]++;

    // Log enrichment success with PLUGIN-shaped field presence derived from the emitted record's own
    // fields — the legacy {imageUrl,name,manufacturer,origin,releaseDate,price} summary read
    // ScrapedData keys plugins never set and logged all-false on every plugin ingest.
    const durationMs = Date.now() - item.queuedAt;
    const recordFields = result as unknown as Record<string, unknown>;
    const fields = {
      title: !!(recordFields.title ?? recordFields.name),
      price: recordFields.price != null,
      images: Array.isArray(recordFields.images) ? recordFields.images.length : 0,
      fieldCount: Object.keys(recordFields).length,
    };
    enrichmentLogger.success(item.mfcId, item.sessionId, durationMs, fields);

    // Report success to session manager (clears failure count). No webhook
    // leg on success — the ingest path emits to the spine ONLY (clean cut).
    if (item.sessionId) {
      this.sessionManager.reportSuccess(item.sessionId);
    }

    // Reduce delay if consistently succeeding
    if (this.consecutiveSuccesses >= RATE_LIMIT.SUCCESS_THRESHOLD) {
      this.currentDelay = Math.max(
        RATE_LIMIT.MIN_DELAY,
        Math.floor(this.currentDelay / RATE_LIMIT.RECOVERY_DIVISOR)
      );
      this.consecutiveSuccesses = 0;
      this.isRateLimited = false;

      console.log(`[SCRAPE QUEUE] Rate limit recovery: delay now ${this.currentDelay}ms`);
    }

    // Remove from pending
    this.pendingItems.delete(item.mfcId);
    // Done: the row goes away, so a restart never re-scrapes what already landed in the spine.
    this.store.remove(item.id);

    // Resolve all waiting promises
    item.resolvers.forEach(({ resolve }) => resolve(result));

    console.log(`[SCRAPE QUEUE] Completed ${item.mfcId} (${item.waitingUserIds.length} users notified, delay=${this.currentDelay}ms)`);
  }

  private handleFailure(item: QueueItem, error: Error): void {
    const errorType = classifyError(error);
    item.errorType = errorType;
    item.lastError = error.message;
    item.retryCount++;

    const durationMs = Date.now() - item.queuedAt;
    console.log(`[SCRAPE QUEUE] Failed ${item.mfcId}: ${errorType} - ${sanitizeForLog(error.message)}`);

    // Log enrichment failure for analysis
    enrichmentLogger.failure(item.mfcId, errorType, error.message, {
      sessionId: item.sessionId,
      retryCount: item.retryCount,
      maxRetries: item.maxRetries,
      durationMs,
    });

    // Handle rate limiting specially
    if (errorType === 'rate_limited') {
      this.handleRateLimit();

      // Log rate limit event for rate-limit analysis
      const isCloudflare = error.message.toLowerCase().includes('cloudflare');
      enrichmentLogger.rateLimited(item.mfcId, item.sessionId, isCloudflare);

      // Also notify session manager for Cloudflare tracking
      if (item.sessionId) {
        this.sessionManager.reportRateLimitBlock(item.sessionId, isCloudflare);
      }
    }

    // Reset the success streak on any REAL failure. A challenge_cooldown fast-fail never touched the
    // network (the host was cooling, so nothing was fetched), so it is NEUTRAL to the adaptive lane:
    // resetting the streak on it would let a trickle of same-host cooling items block the recovery a
    // real challenge escalated, holding the ×1.4 backoff + rateLimited flag open for the whole window.
    if (errorType !== 'challenge_cooldown') {
      this.consecutiveSuccesses = 0;
    }

    // For cookie-authenticated requests, track failures in session manager.
    // Config-level shortfalls (extraction_unavailable) and persisted-nothing ingests (empty_record)
    // are NOT cookie/auth failures — the cookies are fine, the store just returned nothing (layout
    // change, deleted item, a CF block slipping past the browser lane). They skip session
    // pause/cooldown and fall through to the maxRetries/give-up path below, so a permanently-empty
    // record lands FAILED with a clear reason instead of pausing the user's whole sync session as
    // 'auth_failures' and holding the item indefinitely (RS-3).
    // A ChallengePageError is likewise NOT a cookie fault: it is raised by the ingest queue (the honesty gate, or the extraction-throw door when the flagged page breaks the extractor) for a
    // NON-browser lane (http/impersonate) that never sent the cookies, so a cookie'd item must fail
    // bounded like the cookieless case instead of pausing the session (RT-1). The carve-out keys on the
    // ChallengePageError CLASS, not errorType==='rate_limited' — a browser-lane CF block still surfaces
    // as a plain rate_limited Error on a cookie'd lane and keeps its session-pause behavior.
    if (
      errorType !== 'extraction_unavailable' &&
      errorType !== 'empty_record' &&
      errorType !== 'challenge_cooldown' &&
      !(error instanceof ChallengePageError) &&
      item.cookies &&
      item.sessionId &&
      item.waitingUserIds.length > 0
    ) {
      const pendingCount = this.getPendingCountForSession(item.sessionId);
      const userId = item.waitingUserIds[0]; // Primary user for this session

      const failureResult = this.sessionManager.reportCookieFailure(
        item.sessionId,
        item.mfcId,
        userId,
        pendingCount
      );

      if (failureResult.isPaused) {
        // Session is now paused - don't retry, keep in queue for resume
        console.log(`[SCRAPE QUEUE] Session paused after ${failureResult.failureCount} failures - item ${item.mfcId} held for user action`);

        // Re-add to queue but it will be skipped until session is resumed
        this.addToQueue(item);
        this.store.fail(item.id, item.retryCount, errorType);
        return;
      }

      if (failureResult.shouldRetry && failureResult.cooldownMs > 0) {
        // Apply cooldown delay before retry
        console.log(`[SCRAPE QUEUE] Cookie failure - retrying ${item.mfcId} after ${failureResult.cooldownMs / 1000}s cooldown`);
        this.addToQueue(item);
        this.store.fail(item.id, item.retryCount, errorType);
        return;
      }
    }

    // Standard retry logic for non-cookie requests or if session manager says don't retry
    if (shouldRetry(error, errorType, item.retryCount, item.maxRetries)) {
      // Re-queue for retry
      this.addToQueue(item);
      // Release the lease and write the SPENT attempt back, so a restart mid-retry resumes this
      // item's budget where it left off instead of granting it a fresh set of attempts.
      this.store.fail(item.id, item.retryCount, errorType);
      enrichmentLogger.retry(item.mfcId, item.retryCount, item.maxRetries, item.sessionId);
      console.log(`[SCRAPE QUEUE] Retrying ${item.mfcId} (attempt ${item.retryCount + 1})`);
    } else {
      // Give up
      this.failedCount++;
      this.pendingItems.delete(item.mfcId);
      // Terminal: the row goes away. The fetch_failure ledger (reportTerminalFailure, below) is what
      // records this permanently — the queue store is a working set, never a history.
      this.store.remove(item.id);

      // Track per-status failure
      const itemStatus = item.status || 'wished';
      this.statusFailed[itemStatus]++;

      // E1/E2 — THE terminal seam of the record lane: every non-retryable class and every exhausted
      // retry funnels through this branch, so ONE report here is exactly one ledger row per cycle.
      // Reporting from the retry branch above would inflate the row's `attempts` (which drives the
      // spine's backoff) once per internal attempt.
      this.reportTerminalFailure(item, error, errorType);

      // Notify backend of permanent failure via webhook (non-blocking)
      if (item.sessionId) {
        notifyItemFailed(item.sessionId, item.mfcId, `${errorType}: ${error.message}`).catch(() => {
          console.warn(`[SCRAPE QUEUE] Webhook notification failed for ${item.mfcId}`);
        });
      }

      // Reject all waiting promises
      const finalError = new Error(`Scrape failed: ${errorType} - ${error.message}`);
      item.resolvers.forEach(({ reject }) => reject(finalError));

      console.log(`[SCRAPE QUEUE] Gave up on ${item.mfcId} after ${item.retryCount} attempts`);
    }
  }

  /**
   * Put ONE terminal record failure into the durable ledger. Best effort in every direction: no
   * reporter is a no-op, a synchronous throw is swallowed, and a rejected report is swallowed — the
   * item's own outcome (webhook, waiting promises, counters) is already decided and must not move
   * because bookkeeping failed.
   *
   * `site` prefers the matched ruleset's siteId; with no ruleset (the EXTRACTION_UNAVAILABLE case)
   * it falls back to the reserved UNMATCHED_SITE, whose row still names the url as its target.
   */
  private reportTerminalFailure(item: QueueItem, error: Error, errorType: ErrorType): void {
    const reporter = this.failureReporter;
    if (!reporter) return;
    try {
      const ruleset = this.lookupRuleset(item.url);
      // A status failure hands the classifier what the LANE observed — the status it answered with,
      // or the fact that the fetch ended on the store's home page. Both are properties of the typed
      // error, so the row's reason class never depends on reading its message.
      const statusFailure = error instanceof RecordFetchStatusError ? error : undefined;
      const { reasonClass, httpStatus } = classifyFetchFailure({
        error,
        errorType,
        ...(statusFailure?.status !== undefined ? { httpStatus: statusFailure.status } : {}),
        ...(statusFailure?.redirectedHome ? { redirectedHome: true } : {}),
        ...(statusFailure?.deniedOrGone ? { deniedOrGone: true } : {}),
      });
      // A cooldown fast-fail KNOWS when the host is next fetchable; the spine takes the later of this
      // hint and its own backoff (a hint may delay a retry, never pull one forward).
      const nextRetryHint =
        error instanceof ChallengeCooldownError ? new Date(Date.now() + error.remainingMs).toISOString() : undefined;
      const transport = error instanceof ChallengePageError ? error.transport : statusFailure?.transport;
      // mfcId doubles as the dedup key — the trigger routes pass the URL itself, which is not a
      // native id and must not be recorded as one.
      const itemId = item.mfcId && item.mfcId !== item.url ? item.mfcId : undefined;

      void reporter
        .report({
          site: ruleset?.siteId ?? UNMATCHED_SITE,
          ...(itemId !== undefined ? { itemId } : {}),
          target: item.url,
          kind: 'record',
          origin: 'ingest',
          reasonClass,
          ...(httpStatus !== undefined ? { httpStatus } : {}),
          message: `${errorType}: ${error.message} (gave up after ${item.retryCount} attempts)`,
          ...(transport !== undefined ? { transport } : {}),
          ...(ruleset?.version !== undefined ? { rulesetVersion: ruleset.version } : {}),
          ...(nextRetryHint !== undefined ? { nextRetryHint } : {}),
        })
        .catch(() => {});
    } catch {
      // The ledger is bookkeeping. A reporter fault never becomes an item fault.
    }
  }

  private handleRateLimit(): void {
    this.isRateLimited = true;
    this.consecutiveSuccesses = 0;

    // Exponential backoff
    const newDelay = Math.min(
      RATE_LIMIT.MAX_DELAY,
      this.currentDelay * RATE_LIMIT.BACKOFF_MULTIPLIER
    );

    console.log(`[SCRAPE QUEUE] Rate limit detected: delay ${this.currentDelay}ms -> ${newDelay}ms`);
    this.currentDelay = newDelay;
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let queueInstance: ScrapeQueue | null = null;

export function getScrapeQueue(): ScrapeQueue {
  if (!queueInstance) {
    queueInstance = new ScrapeQueue();
  }
  return queueInstance;
}

export function resetScrapeQueue(): void {
  if (queueInstance) {
    queueInstance.stop();
    queueInstance.clear();
    queueInstance.closeQueueStore();
    queueInstance = null;
  }
  // Also reset session manager for a clean slate
  resetSessionManager();
}
