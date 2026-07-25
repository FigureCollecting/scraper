/**
 * Unit tests for Session Manager
 *
 * Covers the generic cookie-session failure/pause/cooldown machinery.
 * Site-specific session validation (network cookie checks, connectivity
 * probes) is plugin territory and is not part of the engine.
 */
import {
  SessionManager,
  getSessionManager,
  resetSessionManager,
  SessionInvalidationEvent,
  SessionPausedEvent,
} from '../../services/sessionManager';

describe('SessionManager', () => {
  let manager: SessionManager;

  beforeEach(() => {
    resetSessionManager();
    manager = new SessionManager();
  });

  afterEach(() => {
    resetSessionManager();
  });

  // ============================================================================
  // Auth Error Reporting
  // ============================================================================

  describe('reportAuthError', () => {
    it('should return true for unknown session', () => {
      const result = manager.reportAuthError('unknown-session', 'auth failed');
      expect(result).toBe(true);
    });

    it('should increment error count and invalidate at threshold', () => {
      // Create a tracked session entry first
      manager.reportCookieFailure('session1', '111', 'user1', 10);

      const result1 = manager.reportAuthError('session1', 'auth failed');
      expect(result1).toBe(false);

      const result2 = manager.reportAuthError('session1', 'auth failed again');
      expect(result2).toBe(true);
    });

    it('should emit auth_error invalidation event at threshold', () => {
      const events: SessionInvalidationEvent[] = [];
      manager.onSessionEvent((event) => events.push(event));

      manager.reportCookieFailure('session1', '111', 'user1', 10);
      manager.reportAuthError('session1', 'auth failed');
      manager.reportAuthError('session1', 'auth failed again');

      expect(events.length).toBe(1);
      expect(events[0].reason).toBe('auth_error');
    });
  });

  // ============================================================================
  // Cookie Failure Reporting
  // ============================================================================

  describe('reportCookieFailure', () => {
    it('should create session entry if not exists', () => {
      const result = manager.reportCookieFailure('new-session', '12345', 'user1', 10);
      expect(result.shouldRetry).toBe(true);
      expect(result.isPaused).toBe(false);
      expect(result.failureCount).toBe(1);
      expect(result.cooldownMs).toBeGreaterThan(0);
    });

    it('should pause session after threshold failures', () => {
      manager.reportCookieFailure('session1', '111', 'user1', 10);
      manager.reportCookieFailure('session1', '222', 'user1', 10);
      const result = manager.reportCookieFailure('session1', '333', 'user1', 10);

      expect(result.isPaused).toBe(true);
      expect(result.shouldRetry).toBe(false);
      expect(result.failureCount).toBe(3);
    });

    it('should emit paused event when session pauses', () => {
      const events: SessionPausedEvent[] = [];
      manager.onSessionPaused((event) => events.push(event));

      manager.reportCookieFailure('session1', '111', 'user1', 10);
      manager.reportCookieFailure('session1', '222', 'user1', 10);
      manager.reportCookieFailure('session1', '333', 'user1', 10);

      expect(events.length).toBe(1);
      expect(events[0].reason).toBe('auth_failures');
      expect(events[0].failedMfcIds).toContain('111');
      expect(events[0].actions).toContain('resume');
    });

    it('should deduplicate mfcIds', () => {
      manager.reportCookieFailure('session1', '111', 'user1', 10);
      manager.reportCookieFailure('session1', '111', 'user1', 10);
      expect(manager.getFailedItems('session1')).toEqual(['111']);
    });
  });

  // ============================================================================
  // Success Reporting
  // ============================================================================

  describe('reportSuccess', () => {
    it('should reset failure count', () => {
      manager.reportCookieFailure('session1', '111', 'user1', 10);
      manager.reportSuccess('session1');
      const sessions = manager.getAllSessions();
      expect(sessions[0].consecutiveFailures).toBe(0);
    });

    it('should do nothing for unknown session', () => {
      expect(() => manager.reportSuccess('unknown')).not.toThrow();
    });
  });

  // ============================================================================
  // Cooldown
  // ============================================================================

  describe('isInCooldown', () => {
    it('should return false for unknown session', () => {
      const result = manager.isInCooldown('unknown');
      expect(result.inCooldown).toBe(false);
      expect(result.remainingMs).toBe(0);
    });

    it('should return true immediately after failure', () => {
      manager.reportCookieFailure('session1', '111', 'user1', 10);
      const result = manager.isInCooldown('session1');
      expect(result.inCooldown).toBe(true);
      expect(result.remainingMs).toBeGreaterThan(0);
    });
  });

  // ============================================================================
  // Pause/Resume
  // ============================================================================

  describe('isSessionPaused / resumeSession', () => {
    it('should return false for unknown session', () => {
      expect(manager.isSessionPaused('unknown')).toBe(false);
    });

    it('should return false for resumeSession on unknown', () => {
      expect(manager.resumeSession('unknown')).toBe(false);
    });

    it('should return true for non-paused session resume', () => {
      manager.reportCookieFailure('session1', '111', 'user1', 10);
      expect(manager.resumeSession('session1')).toBe(true);
    });

    it('should resume paused session', () => {
      manager.reportCookieFailure('session1', '111', 'user1', 10);
      manager.reportCookieFailure('session1', '222', 'user1', 10);
      manager.reportCookieFailure('session1', '333', 'user1', 10);

      expect(manager.isSessionPaused('session1')).toBe(true);
      expect(manager.resumeSession('session1')).toBe(true);
      expect(manager.isSessionPaused('session1')).toBe(false);
    });
  });

  // ============================================================================
  // Failed Items / Events
  // ============================================================================

  describe('getFailedItems', () => {
    it('should return empty array for unknown session', () => {
      expect(manager.getFailedItems('unknown')).toEqual([]);
    });
  });

  describe('onSessionEvent / onSessionPaused', () => {
    it('should return unsubscribe function for events', () => {
      const unsub = manager.onSessionEvent(jest.fn());
      expect(typeof unsub).toBe('function');
      unsub();
    });

    it('should return unsubscribe function for paused', () => {
      const unsub = manager.onSessionPaused(jest.fn());
      expect(typeof unsub).toBe('function');
      unsub();
    });

    it('should handle callback errors in paused events', () => {
      manager.onSessionPaused(() => { throw new Error('callback error'); });
      expect(() => {
        manager.reportCookieFailure('s1', '1', 'u1', 10);
        manager.reportCookieFailure('s1', '2', 'u1', 10);
        manager.reportCookieFailure('s1', '3', 'u1', 10);
      }).not.toThrow();
    });

    it('should handle callback errors in session events', () => {
      manager.onSessionEvent(() => { throw new Error('cb error'); });
      manager.reportCookieFailure('s1', '1', 'u1', 10);
      expect(() => manager.reportRateLimitBlock('s1', false)).not.toThrow();
    });
  });

  // ============================================================================
  // Rate Limit Reporting
  // ============================================================================

  describe('reportRateLimitBlock', () => {
    it('should emit rate_limited event for known session', () => {
      const events: SessionInvalidationEvent[] = [];
      manager.onSessionEvent((event) => events.push(event));
      manager.reportCookieFailure('session1', '111', 'user1', 10);

      manager.reportRateLimitBlock('session1', false);
      expect(events[0].reason).toBe('rate_limited');
    });

    it('should emit cloudflare event', () => {
      const events: SessionInvalidationEvent[] = [];
      manager.onSessionEvent((event) => events.push(event));
      manager.reportCookieFailure('session1', '111', 'user1', 10);

      manager.reportRateLimitBlock('session1', true);
      expect(events[0].reason).toBe('cloudflare');
    });

    it('should not emit for unknown session', () => {
      const events: SessionInvalidationEvent[] = [];
      manager.onSessionEvent((event) => events.push(event));
      manager.reportRateLimitBlock('unknown', false);
      expect(events.length).toBe(0);
    });
  });

  // ============================================================================
  // Clearing / Stats / Singleton
  // ============================================================================

  describe('clearSession / clearAll / getStats', () => {
    it('should clear a session', () => {
      manager.reportCookieFailure('session1', '111', 'user1', 10);
      manager.clearSession('session1');
      expect(manager.getStats().cachedSessions).toBe(0);
    });

    it('should clear all sessions', () => {
      manager.reportCookieFailure('s1', '111', 'user1', 10);
      manager.clearAll();
      expect(manager.getStats().cachedSessions).toBe(0);
    });

    it('should report stats', () => {
      const stats = manager.getStats();
      expect(stats.cachedSessions).toBe(0);
      expect(stats.activeSessions).toBe(0);
    });

    it('should count tracked sessions in cachedSessions', () => {
      manager.reportCookieFailure('s1', '111', 'user1', 10);
      expect(manager.getStats().cachedSessions).toBe(1);
    });
  });

  describe('getAllSessions', () => {
    it('should return empty array initially', () => {
      expect(manager.getAllSessions()).toEqual([]);
    });

    it('should return sessions with status', () => {
      manager.reportCookieFailure('s1', '111', 'u1', 10);
      const sessions = manager.getAllSessions();
      expect(sessions.length).toBe(1);
      expect(sessions[0].consecutiveFailures).toBe(1);
    });
  });

  describe('getSessionManager / resetSessionManager', () => {
    it('should return same instance', () => {
      const m1 = getSessionManager();
      const m2 = getSessionManager();
      expect(m1).toBe(m2);
    });

    it('should return new instance after reset', () => {
      const m1 = getSessionManager();
      resetSessionManager();
      const m2 = getSessionManager();
      expect(m1).not.toBe(m2);
    });

    it('should handle double reset', () => {
      resetSessionManager();
      resetSessionManager();
    });
  });
});
