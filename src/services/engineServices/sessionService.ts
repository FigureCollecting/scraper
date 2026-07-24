/**
 * SessionService adapter — thin wrapper around the existing SessionManager
 * singleton. The legacy manager only tracks cookie-auth failure/pause state
 * (no total/processed item counts), so those two SessionInfo fields are
 * reserved at 0 for now; wiring them up is deferred until session tracking
 * is generalized away from cookie-specific semantics (a later task, same as
 * cutting genericScraper's MFC extraction over to the plugin).
 */
import { getSessionManager } from '../sessionManager.js';
import type { SessionManager } from '../sessionManager.js';
import { SessionService, SessionInfo } from '@figurecollecting/scraper-plugin-contract';

export type SessionServiceDeps = Pick<SessionManager, 'getAllSessions' | 'reportCookieFailure'>;

export function createSessionService(sessionManager: SessionServiceDeps = getSessionManager()): SessionService {
  return {
    getAllSessions(): SessionInfo[] {
      return sessionManager.getAllSessions().map(s => ({
        sessionId: s.sessionId,
        isPaused: s.isPaused,
        inCooldown: s.inCooldown,
        failureCount: s.consecutiveFailures,
        totalItems: 0,
        processedItems: 0,
      }));
    },

    validateSession(sessionId: string): boolean {
      return sessionManager.getAllSessions().some(s => s.sessionId === sessionId);
    },

    reportPause(sessionId: string, reason: string): void {
      // The legacy SessionManager derives pauses internally from
      // reportCookieFailure crossing a threshold; it has no API for an
      // externally-detected pause. Log for visibility until that's unified.
      console.warn(`[SESSION SERVICE] External pause report for session ${sessionId}: ${reason}`);
    },

    reportFailure(sessionId: string, itemId: string, error: string): void {
      sessionManager.reportCookieFailure(sessionId, itemId, 'plugin', 0);
      console.warn(`[SESSION SERVICE] Reported failure for session ${sessionId}, item ${itemId}: ${error}`);
    },
  };
}
