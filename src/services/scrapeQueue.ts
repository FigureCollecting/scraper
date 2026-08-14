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
import { createCapturingFetch, type CapturingFetch, type CapturingFetchTransports } from './engineServices/capturingFetch.js';
import { getRawCaptureSink } from './s3ObjectStore.js';
import { createIngestEmitterFromEnv } from './ingestEmitter.js';
import { impitFetchBody } from './impitFetch.js';
import { httpFetchBody } from './engineLookup.js';
import { buildProfileRegistry, ProfileRegistry } from '../driver/profileRegistry.js';
import type { CaptureSink } from './captureSink.js';
import type {
  ExtractionRuleset,
  ExtractedData as PluginExtractedData,
  ScrapingService,
  StoreCapabilities,
  SearchFetch,
} from '@figurecollecting/scraper-plugin-contract';

// ============================================================================
// Types and Interfaces
// ============================================================================

export type QueuePriority = 'HOT' | 'WARM' | 'COLD';
export type ItemStatus = 'owned' | 'ordered' | 'wished';
export type ErrorType = 'timeout' | 'not_found' | 'rate_limited' | 'auth_required' | 'network' | 'extraction_unavailable' | 'unknown';

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
  total: number;
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

// ============================================================================
// Error Classification
// ============================================================================

function classifyError(error: Error | string): ErrorType {
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

function shouldRetry(errorType: ErrorType, retryCount: number, maxRetries: number): boolean {
  // Never retry auth errors without new cookies
  if (errorType === 'auth_required') {
    return false;
  }

  // Never retry config-level shortfalls — a missing emitter or ruleset will
  // not appear between attempts
  if (errorType === 'extraction_unavailable') {
    return false;
  }

  // Don't retry if at max
  if (retryCount >= maxRetries) {
    return false;
  }

  // Retry transient errors
  return ['timeout', 'rate_limited', 'network', 'unknown'].includes(errorType);
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

  // Ingest seams (engine plumbing, injected — see setters below).
  // When an emitter is configured (INGEST_BASE_URL) AND the registry resolves
  // a ruleset for the item's URL, processing runs: raw page fetch ->
  // ruleset.extract() -> spine emit. There is no other extraction path —
  // anything else is a clean item failure.
  private pluginRegistry: RulesetResolver | null = null;
  private ingestEmitter: IngestSender | null = null;
  private rawPageFetcher: RawPageFetcher | null = null;

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

  constructor(testMode?: boolean) {
    // Auto-detect test environment if not explicitly set
    this.testMode = testMode ?? (
      process.env.NODE_ENV === 'test' ||
      process.env.JEST_WORKER_ID !== undefined
    );

    // New ingest path is enabled by INGEST_BASE_URL; unset = null = disabled.
    this.ingestEmitter = createIngestEmitterFromEnv();

    // Get or create session manager
    this.sessionManager = getSessionManager();

    // Subscribe to session paused events to notify waiting users
    this.sessionManager.onSessionPaused((event) => {
      this.handleSessionPaused(event);
    });

    console.log(`[SCRAPE QUEUE] Initialized (testMode: ${this.testMode})`);
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
      console.log(`[SCRAPE QUEUE] Deduplicated request for MFC ${sanitizeForLog(mfcId)} (${existingItem.waitingUserIds.length} users waiting)`); // lgtm[js/log-injection]

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

    // Add to appropriate queue
    this.addToQueue(item);
    this.pendingItems.set(mfcId, item);

    // Track per-status totals
    const itemStatus = status || 'wished';
    this.statusQueued[itemStatus]++;

    // mfcId can be a caller-supplied URL (trigger route) — sanitize for log
    console.log(`[SCRAPE QUEUE] Enqueued MFC ${sanitizeForLog(mfcId)} at priority ${effectivePriority} (queue size: ${this.getStats().total})`); // lgtm[js/log-injection]

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
    return items.map(({ mfcId, ...options }) => this.enqueue(mfcId, options));
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

    // Reject all waiting promises
    const cancelError = new Error('Request cancelled');
    item.resolvers.forEach(({ reject }) => reject(cancelError));

    console.log(`[SCRAPE QUEUE] Cancelled request for MFC ${mfcId}`);
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

    this.hotQueue = [];
    this.warmQueue = [];
    this.coldQueue = [];
    this.pendingItems.clear();

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

    console.log(`[SCRAPE QUEUE] Upgraded MFC ${item.mfcId} to ${newPriority}`);
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

    // Check if we should wait for rate limit
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;

    if (timeSinceLastRequest < this.currentDelay) {
      // Schedule next attempt after delay (unless cooldown timer already handling retry)
      if (!this.cooldownWaitTimerId) {
        const waitTime = this.currentDelay - timeSinceLastRequest;
        setTimeout(() => this.processNext(), waitTime);
      }
      return;
    }

    // Get next item, considering paused sessions and cooldowns
    const item = this.getNextProcessableItem();
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
    this.lastRequestTime = now;

    const poolAvailable = BrowserPool.getPoolSize();
    console.log(`[SCRAPE QUEUE] Processing MFC ${item.mfcId} (${item.priority}, attempt ${item.retryCount + 1}/${item.maxRetries + 1}, delay=${this.currentDelay}ms, pool=${poolAvailable}/${BrowserPool.getPoolCapacity()})`);

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
      this.handleFailure(item, error);
    }

    this.processingItem = null;

    // Schedule next item (unless cooldown timer already handling retry)
    if (!this.cooldownWaitTimerId) {
      setTimeout(() => this.processNext(), this.currentDelay);
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
        impersonate: this.impersonateFetch ?? impitFetchBody,
        http: this.httpFetch ?? httpFetchBody,
        browser: this.getRawPageFetcher(),
      },
      this.captureSink ?? getRawCaptureSink(),
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
    const page = await this.getCapturingFetch()(item.url, searchFetch, { cookies: item.cookies });

    let extracted: PluginExtractedData;
    try {
      // extract() is async-capable (E1): the contract allows it to return
      // ExtractedData or a Promise, so the result is ALWAYS awaited — sync
      // rulesets pass through unchanged. The duck-typed extractAsync path
      // predates E1 and is kept for rulesets that still expose it.
      extracted = typeof (ruleset as { extractAsync?: unknown }).extractAsync === 'function'
        ? await (ruleset as unknown as { extractAsync(h: string, u: string): Promise<PluginExtractedData> }).extractAsync(page.html, item.url)
        : await ruleset.extract(page.html, item.url);
    } catch (error: any) {
      console.error(
        `[SCRAPE QUEUE] Extraction failed for ${item.url} (ruleset ${ruleset.siteId}@${ruleset.version}): ${sanitizeForLog(error?.message ?? String(error))}`
      );
      throw error instanceof Error ? error : new Error(String(error));
    }

    await this.ingestEmitter!.send(extracted);

    return extracted.fields as ScrapedData;
  }

  /**
   * Get the next processable item, skipping paused sessions and respecting cooldowns
   */
  private getNextProcessableItem(): QueueItem | null {
    // Try each priority queue in order
    const queues = [this.hotQueue, this.warmQueue, this.coldQueue];
    let pausedCount = 0;
    let cooldownCount = 0;

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

        // This item is processable - remove from queue and return
        queue.splice(i, 1);
        return item;
      }
    }

    // No processable items found - check if there are items waiting in cooldown
    const totalBlocked = pausedCount + cooldownCount;
    if (totalBlocked > 0 && !this.cooldownWaitTimerId) {
      // Log summary once and schedule SINGLE retry timer
      // Guard with cooldownWaitTimerId to prevent multiple concurrent timers
      console.log(`[SCRAPE QUEUE] All ${totalBlocked} items blocked (${pausedCount} paused, ${cooldownCount} in cooldown), waiting 5s...`);
      this.cooldownWaitTimerId = setTimeout(() => {
        this.cooldownWaitTimerId = null; // Clear before retry to allow future timers
        if (!this.isProcessing) {
          this.isProcessing = true;
          this.processNext();
        }
      }, 5000); // Check again in 5 seconds
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

    // Log enrichment success with field completeness for analysis
    const durationMs = Date.now() - item.queuedAt;
    const fields = {
      imageUrl: !!result.imageUrl,
      name: !!result.name,
      manufacturer: !!result.manufacturer,
      origin: !!result.origin,
      releaseDate: !!(result.releases?.[0]?.date),
      price: !!(result.releases?.[0]?.price),
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

    // Resolve all waiting promises
    item.resolvers.forEach(({ resolve }) => resolve(result));

    console.log(`[SCRAPE QUEUE] Completed MFC ${item.mfcId} (${item.waitingUserIds.length} users notified, delay=${this.currentDelay}ms)`);
  }

  private handleFailure(item: QueueItem, error: Error): void {
    const errorType = classifyError(error);
    item.errorType = errorType;
    item.lastError = error.message;
    item.retryCount++;

    const durationMs = Date.now() - item.queuedAt;
    console.log(`[SCRAPE QUEUE] Failed MFC ${item.mfcId}: ${errorType} - ${sanitizeForLog(error.message)}`);

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

      // Log rate limit event specifically for MFC busy analysis
      const isCloudflare = error.message.toLowerCase().includes('cloudflare');
      enrichmentLogger.rateLimited(item.mfcId, item.sessionId, isCloudflare);

      // Also notify session manager for Cloudflare tracking
      if (item.sessionId) {
        this.sessionManager.reportRateLimitBlock(item.sessionId, isCloudflare);
      }
    }

    // Reset success streak on any failure
    this.consecutiveSuccesses = 0;

    // For cookie-authenticated requests, track failures in session manager.
    // Config-level shortfalls (extraction_unavailable) are not cookie
    // failures — they skip session pause/cooldown and fail directly below.
    if (errorType !== 'extraction_unavailable' && item.cookies && item.sessionId && item.waitingUserIds.length > 0) {
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
        return;
      }

      if (failureResult.shouldRetry && failureResult.cooldownMs > 0) {
        // Apply cooldown delay before retry
        console.log(`[SCRAPE QUEUE] Cookie failure - retrying MFC ${item.mfcId} after ${failureResult.cooldownMs / 1000}s cooldown`);
        this.addToQueue(item);
        return;
      }
    }

    // Standard retry logic for non-cookie requests or if session manager says don't retry
    if (shouldRetry(errorType, item.retryCount, item.maxRetries)) {
      // Re-queue for retry
      this.addToQueue(item);
      enrichmentLogger.retry(item.mfcId, item.retryCount, item.maxRetries, item.sessionId);
      console.log(`[SCRAPE QUEUE] Retrying MFC ${item.mfcId} (attempt ${item.retryCount + 1})`);
    } else {
      // Give up
      this.failedCount++;
      this.pendingItems.delete(item.mfcId);

      // Track per-status failure
      const itemStatus = item.status || 'wished';
      this.statusFailed[itemStatus]++;

      // Notify backend of permanent failure via webhook (non-blocking)
      if (item.sessionId) {
        notifyItemFailed(item.sessionId, item.mfcId, `${errorType}: ${error.message}`).catch(() => {
          console.warn(`[SCRAPE QUEUE] Webhook notification failed for MFC ${item.mfcId}`);
        });
      }

      // Reject all waiting promises
      const finalError = new Error(`Scrape failed: ${errorType} - ${error.message}`);
      item.resolvers.forEach(({ reject }) => reject(finalError));

      console.log(`[SCRAPE QUEUE] Gave up on MFC ${item.mfcId} after ${item.retryCount} attempts`);
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
    queueInstance = null;
  }
  // Also reset session manager for a clean slate
  resetSessionManager();
}
