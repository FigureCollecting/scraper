/**
 * Session Manager Service
 *
 * Manages MFC cookie session validation with caching to avoid
 * making network requests on every queue item. Sessions are
 * validated periodically and cached results are used for subsequent
 * requests until they expire or are invalidated.
 *
 * Design Rationale:
 * - Full cookie validation (validateMfcCookies) makes network requests
 * - We can't do that for every queue item - too slow and rate-limit risky
 * - Instead, we cache validation results per sessionId
 * - Invalidate cache on auth errors from scraping
 * - Re-validate when cache expires (default: 10 minutes)
 */

import { validateMfcCookies, MfcCookies, CookieValidationResult } from './mfcCsvExporter.js';
import { sanitizeForLog } from '../utils/security.js';

// ============================================================================
// Types and Interfaces
// ============================================================================

export interface CachedSession {
  /** Session identifier */
  sessionId: string;
  /** When this session was last validated */
  validatedAt: number;
  /** Validation result from last check */
  lastResult: CookieValidationResult;
  /** Associated cookies (reference, not stored) */
  cookiesSnapshot: string;
  /** Number of auth errors since last validation */
  authErrorCount: number;
  /** Consecutive auth failures (resets on success) */
  consecutiveFailures: number;
  /** MFC IDs that failed during this pause period */
  failedMfcIds: string[];
  /** When the last auth failure occurred */
  lastFailureTime: number;
  /** Whether this session is paused due to failures */
  isPaused: boolean;
  /** Users associated with this session */
  userIds: string[];
}

export interface SessionValidationOptions {
  /** Force revalidation even if cached result exists */
  forceRevalidate?: boolean;
  /** Skip network validation (structure check only) */
  structureOnly?: boolean;
  /** User ID for notification purposes */
  userId?: string;
}

export interface SessionInvalidationEvent {
  sessionId: string;
  reason: 'auth_error' | 'expired' | 'rate_limited' | 'cloudflare';
  timestamp: number;
  userIds: string[];
  lastError?: string;
}

export interface SessionPausedEvent {
  sessionId: string;
  userId: string;
  reason: 'auth_failures';
  failureCount: number;
  timestamp: number;
  failedMfcIds: string[];
  pendingCount: number;
  actions: ('resume' | 'cancel_item' | 'cancel_all')[];
}

export type SessionEventCallback = (event: SessionInvalidationEvent) => void;
export type SessionPausedCallback = (event: SessionPausedEvent) => void;

// ============================================================================
// Configuration
// ============================================================================

const SESSION_CONFIG = {
  /** How long to cache a valid session result (ms) */
  CACHE_TTL: 10 * 60 * 1000, // 10 minutes

  /** After this many auth errors, force revalidation */
  AUTH_ERROR_THRESHOLD: 2,

  /** After this many consecutive auth failures for a session, pause it */
  AUTH_FAILURE_PAUSE_THRESHOLD: 3,

  /** Cooldown period after auth failure before retrying (ms) */
  AUTH_FAILURE_COOLDOWN: 20 * 1000, // 20 seconds

  /** Minimum time between validation attempts for same session (ms) */
  MIN_REVALIDATION_INTERVAL: 30 * 1000, // 30 seconds

  /** Maximum sessions to cache */
  MAX_CACHED_SESSIONS: 100,

  /** Known public MFC item ID for connectivity probing (SFW) */
  PROBE_MFC_ID: '50', // Item #50 is a known good SFW item

  /** How long to cache probe results (ms) */
  PROBE_CACHE_TTL: 60 * 1000, // 1 minute
} as const;

// ============================================================================
// Failure Classification
// ============================================================================

export type FailureReason = 'cookies_expired' | 'mfc_overloaded' | 'network_error' | 'unknown';

export interface DiagnosticResult {
  /** What we think caused the failure */
  reason: FailureReason;
  /** Confidence level 0-1 */
  confidence: number;
  /** Human-readable explanation */
  explanation: string;
  /** Whether MFC is reachable at all */
  mfcReachable: boolean;
  /** Last probe result */
  lastProbeSuccess?: boolean;
  /** Time of last probe */
  lastProbeTime?: number;
}

// ============================================================================
// Session Manager Class
// ============================================================================

export class SessionManager {
  private sessions: Map<string, CachedSession> = new Map();
  private eventCallbacks: SessionEventCallback[] = [];
  private pausedCallbacks: SessionPausedCallback[] = [];
  private validationLocks: Map<string, Promise<CookieValidationResult>> = new Map();

  // MFC connectivity probe state
  private lastProbeTime: number = 0;
  private lastProbeSuccess: boolean = false;
  private probeInProgress: Promise<boolean> | null = null;

  constructor() {
    console.log('[SESSION MANAGER] Initialized');
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Check if a session is likely valid for making cookie-authenticated requests
   *
   * This uses cached results when available to avoid network requests.
   * Use forceRevalidate: true to force a fresh network check.
   */
  async isSessionValid(
    sessionId: string,
    cookies: Record<string, string>,
    options: SessionValidationOptions = {}
  ): Promise<{ valid: boolean; reason?: string; shouldNotify?: boolean }> {
    const { forceRevalidate = false, structureOnly = false, userId } = options;

    // Quick structure check
    const structureResult = this.validateCookieStructure(cookies);
    if (!structureResult.valid) {
      return { valid: false, reason: structureResult.reason };
    }

    // If only structure check requested, we're done
    if (structureOnly) {
      return { valid: true };
    }

    // Check cached session
    const cached = this.sessions.get(sessionId);
    const now = Date.now();

    if (cached && !forceRevalidate) {
      // Add user to session tracking
      if (userId && !cached.userIds.includes(userId)) {
        cached.userIds.push(userId);
      }

      // Check if cache is still valid
      const cacheAge = now - cached.validatedAt;
      const cacheValid = cacheAge < SESSION_CONFIG.CACHE_TTL;
      const notTooManyErrors = cached.authErrorCount < SESSION_CONFIG.AUTH_ERROR_THRESHOLD;

      if (cacheValid && notTooManyErrors) {
        // Use cached result
        if (cached.lastResult.valid) {
          console.log(`[SESSION MANAGER] Session ${sanitizeForLog(sessionId.substring(0, 8))}... cache hit (valid)`);
          return { valid: true };
        } else {
          console.log(`[SESSION MANAGER] Session ${sanitizeForLog(sessionId.substring(0, 8))}... cache hit (invalid)`);
          return {
            valid: false,
            reason: cached.lastResult.reason,
            shouldNotify: true
          };
        }
      }

      // Cache expired or too many errors, need revalidation
      console.log(`[SESSION MANAGER] Session ${sanitizeForLog(sessionId.substring(0, 8))}... cache miss (age: ${Math.round(cacheAge / 1000)}s, errors: ${cached.authErrorCount})`);
    }

    // Need to validate - use lock to prevent parallel validation for same session
    return this.performValidation(sessionId, cookies, userId);
  }

  /**
   * Report an authentication error for a session
   *
   * This increments the error count and may trigger cache invalidation.
   * Returns true if the session should be considered invalid.
   */
  reportAuthError(sessionId: string, error: string): boolean {
    const cached = this.sessions.get(sessionId);

    if (!cached) {
      // No cached session - this is an unknown session
      console.log(`[SESSION MANAGER] Auth error for unknown session ${sanitizeForLog(sessionId.substring(0, 8))}...`);
      return true; // Assume invalid
    }

    cached.authErrorCount++;
    console.log(`[SESSION MANAGER] Auth error for session ${sanitizeForLog(sessionId.substring(0, 8))}... (count: ${cached.authErrorCount})`);

    // Check if we've hit the threshold
    if (cached.authErrorCount >= SESSION_CONFIG.AUTH_ERROR_THRESHOLD) {
      // Invalidate and notify
      this.invalidateSession(sessionId, 'auth_error', error);
      return true;
    }

    return false;
  }

  /**
   * Report a scraping failure for a cookie-authenticated request.
   * Tracks failures and pauses session after threshold.
   *
   * @param sessionId - Session ID
   * @param mfcId - MFC item that failed
   * @param userId - User who owns this session
   * @param pendingCount - How many items remain in queue for this session
   * @returns Object with retry decision and cooldown info
   */
  reportCookieFailure(
    sessionId: string,
    mfcId: string,
    userId: string,
    pendingCount: number
  ): {
    shouldRetry: boolean;
    isPaused: boolean;
    cooldownMs: number;
    failureCount: number;
  } {
    let cached = this.sessions.get(sessionId);

    if (!cached) {
      // Create a new cache entry for tracking
      cached = this.createEmptySession(sessionId, userId);
      this.sessions.set(sessionId, cached);
    }

    const now = Date.now();
    cached.consecutiveFailures++;
    cached.lastFailureTime = now;

    // Track failed MFC ID
    if (!cached.failedMfcIds.includes(mfcId)) {
      cached.failedMfcIds.push(mfcId);
    }

    // Add user if not tracked
    if (!cached.userIds.includes(userId)) {
      cached.userIds.push(userId);
    }

    console.log(`[SESSION MANAGER] Cookie failure for session ${sanitizeForLog(sessionId.substring(0, 8))}... (failures: ${cached.consecutiveFailures}, mfcId: ${mfcId})`);

    // Check if we should pause this session
    if (cached.consecutiveFailures >= SESSION_CONFIG.AUTH_FAILURE_PAUSE_THRESHOLD) {
      cached.isPaused = true;

      console.log(`[SESSION MANAGER] Pausing session ${sanitizeForLog(sessionId.substring(0, 8))}... after ${cached.consecutiveFailures} failures`);

      // Emit paused event for user notification
      this.emitPausedEvent({
        sessionId,
        userId,
        reason: 'auth_failures',
        failureCount: cached.consecutiveFailures,
        timestamp: now,
        failedMfcIds: [...cached.failedMfcIds],
        pendingCount,
        actions: ['resume', 'cancel_item', 'cancel_all'],
      });

      return {
        shouldRetry: false,
        isPaused: true,
        cooldownMs: 0,
        failureCount: cached.consecutiveFailures,
      };
    }

    // Not paused yet, apply cooldown before next retry
    return {
      shouldRetry: true,
      isPaused: false,
      cooldownMs: SESSION_CONFIG.AUTH_FAILURE_COOLDOWN,
      failureCount: cached.consecutiveFailures,
    };
  }

  /**
   * Report a successful scrape for a session
   * Resets failure count and clears cooldown
   */
  reportSuccess(sessionId: string): void {
    const cached = this.sessions.get(sessionId);
    if (cached) {
      cached.consecutiveFailures = 0;
      cached.failedMfcIds = [];
      // Note: don't clear isPaused - user must explicitly resume
      console.log(`[SESSION MANAGER] Success for session ${sanitizeForLog(sessionId.substring(0, 8))}... - failure count reset`);
    }
  }

  /**
   * Check if a session is currently in cooldown after a failure
   */
  isInCooldown(sessionId: string): { inCooldown: boolean; remainingMs: number } {
    const cached = this.sessions.get(sessionId);

    if (!cached || cached.lastFailureTime === 0) {
      return { inCooldown: false, remainingMs: 0 };
    }

    const elapsed = Date.now() - cached.lastFailureTime;
    const remaining = SESSION_CONFIG.AUTH_FAILURE_COOLDOWN - elapsed;

    if (remaining > 0) {
      return { inCooldown: true, remainingMs: remaining };
    }

    return { inCooldown: false, remainingMs: 0 };
  }

  /**
   * Check if a session is paused
   */
  isSessionPaused(sessionId: string): boolean {
    const cached = this.sessions.get(sessionId);
    return cached?.isPaused ?? false;
  }

  /**
   * Get all sessions with their status (for debugging/monitoring)
   */
  getAllSessions(): Array<{
    sessionId: string;
    isPaused: boolean;
    consecutiveFailures: number;
    failedMfcIds: string[];
    inCooldown: boolean;
    cooldownRemainingMs: number;
  }> {
    const result: Array<{
      sessionId: string;
      isPaused: boolean;
      consecutiveFailures: number;
      failedMfcIds: string[];
      inCooldown: boolean;
      cooldownRemainingMs: number;
    }> = [];

    for (const [sessionId, session] of this.sessions.entries()) {
      const cooldown = this.isInCooldown(sessionId);
      result.push({
        sessionId: sessionId,  // Full ID needed for resume/cancel operations
        isPaused: session.isPaused,
        consecutiveFailures: session.consecutiveFailures,
        failedMfcIds: session.failedMfcIds,
        inCooldown: cooldown.inCooldown,
        cooldownRemainingMs: cooldown.remainingMs,
      });
    }

    return result;
  }

  /**
   * Resume a paused session (user action)
   */
  resumeSession(sessionId: string): boolean {
    const cached = this.sessions.get(sessionId);

    if (!cached) {
      console.log(`[SESSION MANAGER] Cannot resume unknown session ${sanitizeForLog(sessionId.substring(0, 8))}...`);
      return false;
    }

    if (!cached.isPaused) {
      console.log(`[SESSION MANAGER] Session ${sanitizeForLog(sessionId.substring(0, 8))}... is not paused`);
      return true;
    }

    cached.isPaused = false;
    cached.consecutiveFailures = 0;
    cached.failedMfcIds = [];
    cached.lastFailureTime = 0;

    console.log(`[SESSION MANAGER] Resumed session ${sanitizeForLog(sessionId.substring(0, 8))}...`);
    return true;
  }

  /**
   * Get failed MFC IDs for a session (for cancel_item action)
   */
  getFailedItems(sessionId: string): string[] {
    const cached = this.sessions.get(sessionId);
    return cached ? [...cached.failedMfcIds] : [];
  }

  /**
   * Register a callback for session paused events
   */
  onSessionPaused(callback: SessionPausedCallback): () => void {
    this.pausedCallbacks.push(callback);

    return () => {
      const index = this.pausedCallbacks.indexOf(callback);
      if (index !== -1) {
        this.pausedCallbacks.splice(index, 1);
      }
    };
  }

  /**
   * Diagnose why cookie-authenticated requests are failing.
   * Probes MFC with a known public item to determine if it's:
   * - Cookie expiration (public works, auth fails)
   * - MFC overload (public also fails)
   * - Network issues (can't reach MFC at all)
   */
  async diagnoseFailure(sessionId: string): Promise<DiagnosticResult> {
    const cached = this.sessions.get(sessionId);
    const now = Date.now();

    // Check if we have a recent probe result
    if (now - this.lastProbeTime < SESSION_CONFIG.PROBE_CACHE_TTL) {
      return this.buildDiagnostic(cached, this.lastProbeSuccess);
    }

    // Perform a fresh probe
    const probeSuccess = await this.probePublicItem();

    return this.buildDiagnostic(cached, probeSuccess);
  }

  /**
   * Probe MFC with a known public item (no auth required)
   * This helps distinguish between MFC overload and cookie expiration
   */
  async probePublicItem(): Promise<boolean> {
    // Use existing probe if in progress
    if (this.probeInProgress) {
      return this.probeInProgress;
    }

    this.probeInProgress = this.doProbe();

    try {
      const result = await this.probeInProgress;
      this.lastProbeTime = Date.now();
      this.lastProbeSuccess = result;
      return result;
    } finally {
      this.probeInProgress = null;
    }
  }

  private async doProbe(): Promise<boolean> {
    console.log('[SESSION MANAGER] Probing MFC with public item...');

    try {
      // Dynamic import to avoid circular dependency
      const { scrapeMFC } = await import('./genericScraper.js');

      const url = `https://myfigurecollection.net/item/${SESSION_CONFIG.PROBE_MFC_ID}`;
      const result = await scrapeMFC(url);

      // Check if we got valid data back
      const success = Boolean(result && result.name && result.name.length > 0);
      console.log(`[SESSION MANAGER] Probe result: ${success ? 'SUCCESS' : 'FAILED'}`);

      return success;
    } catch (error: any) {
      console.log(`[SESSION MANAGER] Probe failed: ${error.message}`);
      return false;
    }
  }

  private buildDiagnostic(cached: CachedSession | undefined, probeSuccess: boolean): DiagnosticResult {
    if (!probeSuccess) {
      // Public item also fails - MFC is having issues
      return {
        reason: 'mfc_overloaded',
        confidence: 0.85,
        explanation: 'MFC appears to be overloaded or experiencing issues. Public items are also inaccessible.',
        mfcReachable: false,
        lastProbeSuccess: false,
        lastProbeTime: this.lastProbeTime,
      };
    }

    // Public item works but we're seeing auth failures
    if (cached && cached.consecutiveFailures > 0) {
      return {
        reason: 'cookies_expired',
        confidence: 0.9,
        explanation: 'MFC is reachable but authenticated requests are failing. Your session cookies have likely expired.',
        mfcReachable: true,
        lastProbeSuccess: true,
        lastProbeTime: this.lastProbeTime,
      };
    }

    // No failures tracked - could be intermittent
    return {
      reason: 'unknown',
      confidence: 0.5,
      explanation: 'MFC is reachable. The failure may have been intermittent.',
      mfcReachable: true,
      lastProbeSuccess: true,
      lastProbeTime: this.lastProbeTime,
    };
  }

  /**
   * Report a rate limit or Cloudflare block for a session
   *
   * This is informational and may be used to pause processing.
   */
  reportRateLimitBlock(sessionId: string, isCloudflare: boolean): void {
    const cached = this.sessions.get(sessionId);

    if (cached) {
      const reason = isCloudflare ? 'cloudflare' : 'rate_limited';
      this.emitEvent({
        sessionId,
        reason,
        timestamp: Date.now(),
        userIds: [...cached.userIds],
      });
    }

    console.log(`[SESSION MANAGER] ${isCloudflare ? 'Cloudflare' : 'Rate limit'} block for session ${sanitizeForLog(sessionId.substring(0, 8))}...`);
  }

  /**
   * Clear a session from the cache
   */
  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    console.log(`[SESSION MANAGER] Cleared session ${sanitizeForLog(sessionId.substring(0, 8))}...`);
  }

  /**
   * Clear all cached sessions
   */
  clearAll(): void {
    this.sessions.clear();
    this.validationLocks.clear();
    console.log('[SESSION MANAGER] Cleared all sessions');
  }

  /**
   * Register a callback for session events (invalidation, etc.)
   */
  onSessionEvent(callback: SessionEventCallback): () => void {
    this.eventCallbacks.push(callback);

    // Return unsubscribe function
    return () => {
      const index = this.eventCallbacks.indexOf(callback);
      if (index !== -1) {
        this.eventCallbacks.splice(index, 1);
      }
    };
  }

  /**
   * Get statistics about cached sessions
   */
  getStats(): { cachedSessions: number; activeSessions: number } {
    const now = Date.now();
    let activeSessions = 0;

    this.sessions.forEach((session) => {
      if (now - session.validatedAt < SESSION_CONFIG.CACHE_TTL) {
        activeSessions++;
      }
    });

    return {
      cachedSessions: this.sessions.size,
      activeSessions,
    };
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  private validateCookieStructure(cookies: Record<string, string>): { valid: boolean; reason?: string } {
    const required = ['PHPSESSID', 'sesUID', 'sesDID'];
    const missing = required.filter(name => !cookies[name]);

    if (missing.length > 0) {
      return {
        valid: false,
        reason: `Missing required cookies: ${missing.join(', ')}`
      };
    }

    // Check for empty values
    const empty = required.filter(name => cookies[name] === '');
    if (empty.length > 0) {
      return {
        valid: false,
        reason: `Empty cookie values: ${empty.join(', ')}`
      };
    }

    return { valid: true };
  }

  private async performValidation(
    sessionId: string,
    cookies: Record<string, string>,
    userId?: string
  ): Promise<{ valid: boolean; reason?: string; shouldNotify?: boolean }> {
    // Check if validation already in progress for this session
    const existingLock = this.validationLocks.get(sessionId);
    if (existingLock) {
      console.log(`[SESSION MANAGER] Waiting for in-progress validation of session ${sanitizeForLog(sessionId.substring(0, 8))}...`);
      const result = await existingLock;
      return { valid: result.valid, reason: result.reason };
    }

    // Create validation promise
    const validationPromise = this.doNetworkValidation(sessionId, cookies, userId);
    this.validationLocks.set(sessionId, validationPromise);

    try {
      const result = await validationPromise;
      return {
        valid: result.valid,
        reason: result.reason,
        shouldNotify: !result.valid
      };
    } finally {
      this.validationLocks.delete(sessionId);
    }
  }

  private async doNetworkValidation(
    sessionId: string,
    cookies: Record<string, string>,
    userId?: string
  ): Promise<CookieValidationResult> {
    console.log(`[SESSION MANAGER] Performing network validation for session ${sanitizeForLog(sessionId.substring(0, 8))}...`);

    try {
      // Convert to MfcCookies format
      const mfcCookies: MfcCookies = {
        PHPSESSID: cookies.PHPSESSID || '',
        sesUID: cookies.sesUID || '',
        sesDID: cookies.sesDID || '',
        cf_clearance: cookies.cf_clearance,
      };

      const result = await validateMfcCookies(mfcCookies);

      // Cache the result
      this.cacheSession(sessionId, result, cookies, userId);

      if (!result.valid) {
        // Emit invalidation event
        this.invalidateSession(sessionId, 'expired', result.reason);
      }

      return result;

    } catch (error: any) {
      console.error(`[SESSION MANAGER] Validation error for session ${sanitizeForLog(sessionId.substring(0, 8))}...:`, error.message);

      const failureResult: CookieValidationResult = {
        valid: false,
        reason: `Validation error: ${error.message}`,
        canAccessManager: false,
        canExportCsv: false,
      };

      // Cache the failure
      this.cacheSession(sessionId, failureResult, cookies, userId);

      return failureResult;
    }
  }

  private cacheSession(
    sessionId: string,
    result: CookieValidationResult,
    cookies: Record<string, string>,
    userId?: string
  ): void {
    // Create cookie snapshot for change detection
    const cookiesSnapshot = Object.keys(cookies).sort().join(',');

    const existing = this.sessions.get(sessionId);

    const cached: CachedSession = {
      sessionId,
      validatedAt: Date.now(),
      lastResult: result,
      cookiesSnapshot,
      authErrorCount: 0, // Reset on fresh validation
      consecutiveFailures: existing?.consecutiveFailures ?? 0,
      failedMfcIds: existing?.failedMfcIds ?? [],
      lastFailureTime: existing?.lastFailureTime ?? 0,
      isPaused: existing?.isPaused ?? false,
      userIds: existing?.userIds || [],
    };

    if (userId && !cached.userIds.includes(userId)) {
      cached.userIds.push(userId);
    }

    // Enforce cache size limit
    if (this.sessions.size >= SESSION_CONFIG.MAX_CACHED_SESSIONS) {
      this.evictOldestSession();
    }

    this.sessions.set(sessionId, cached);
    console.log(`[SESSION MANAGER] Cached session ${sanitizeForLog(sessionId.substring(0, 8))}... (valid: ${result.valid})`);
  }

  private createEmptySession(sessionId: string, userId?: string): CachedSession {
    return {
      sessionId,
      validatedAt: 0,
      lastResult: {
        valid: false,
        reason: 'Not yet validated',
        canAccessManager: false,
        canExportCsv: false,
      },
      cookiesSnapshot: '',
      authErrorCount: 0,
      consecutiveFailures: 0,
      failedMfcIds: [],
      lastFailureTime: 0,
      isPaused: false,
      userIds: userId ? [userId] : [],
    };
  }

  private emitPausedEvent(event: SessionPausedEvent): void {
    this.pausedCallbacks.forEach(callback => {
      try {
        callback(event);
      } catch (error) {
        console.error('[SESSION MANAGER] Error in paused event callback:', error);
      }
    });
  }

  private evictOldestSession(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    this.sessions.forEach((session, key) => {
      if (session.validatedAt < oldestTime) {
        oldestTime = session.validatedAt;
        oldestKey = key;
      }
    });

    if (oldestKey) {
      this.sessions.delete(oldestKey);
      console.log(`[SESSION MANAGER] Evicted oldest session`);
    }
  }

  private invalidateSession(sessionId: string, reason: SessionInvalidationEvent['reason'], error?: string): void {
    const cached = this.sessions.get(sessionId);

    if (cached) {
      this.emitEvent({
        sessionId,
        reason,
        timestamp: Date.now(),
        userIds: [...cached.userIds],
        lastError: error,
      });
    }

    // Clear from cache
    this.sessions.delete(sessionId);
    console.log(`[SESSION MANAGER] Invalidated session ${sanitizeForLog(sessionId.substring(0, 8))}... (reason: ${reason})`);
  }

  private emitEvent(event: SessionInvalidationEvent): void {
    this.eventCallbacks.forEach(callback => {
      try {
        callback(event);
      } catch (error) {
        console.error('[SESSION MANAGER] Error in event callback:', error);
      }
    });
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let sessionManagerInstance: SessionManager | null = null;

export function getSessionManager(): SessionManager {
  if (!sessionManagerInstance) {
    sessionManagerInstance = new SessionManager();
  }
  return sessionManagerInstance;
}

export function resetSessionManager(): void {
  if (sessionManagerInstance) {
    sessionManagerInstance.clearAll();
    sessionManagerInstance = null;
  }
}
