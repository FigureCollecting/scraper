import { jest } from '@jest/globals';
import { createSessionService } from '../../../services/engineServices/sessionService';

function buildFakeSessionManager() {
  return {
    getAllSessions: jest.fn(),
    reportCookieFailure: jest.fn(),
  };
}

describe('createSessionService', () => {
  it('maps legacy session fields to the generic SessionInfo shape', () => {
    const sessionManager = buildFakeSessionManager();
    sessionManager.getAllSessions.mockReturnValue([
      {
        sessionId: 'sess-1',
        isPaused: true,
        consecutiveFailures: 3,
        failedMfcIds: ['1', '2'],
        inCooldown: false,
        cooldownRemainingMs: 0,
      },
    ]);

    const service = createSessionService(sessionManager as any);
    const sessions = service.getAllSessions();

    expect(sessions).toEqual([
      {
        sessionId: 'sess-1',
        isPaused: true,
        inCooldown: false,
        failureCount: 3,
        totalItems: 0,
        processedItems: 0,
      },
    ]);
  });

  it('validateSession returns true only for a known sessionId', () => {
    const sessionManager = buildFakeSessionManager();
    sessionManager.getAllSessions.mockReturnValue([
      { sessionId: 'known', isPaused: false, consecutiveFailures: 0, failedMfcIds: [], inCooldown: false, cooldownRemainingMs: 0 },
    ]);

    const service = createSessionService(sessionManager as any);

    expect(service.validateSession('known')).toBe(true);
    expect(service.validateSession('unknown')).toBe(false);
  });

  it('reportPause does not throw and does not require a mock session manager call', () => {
    const sessionManager = buildFakeSessionManager();
    const service = createSessionService(sessionManager as any);

    expect(() => service.reportPause('sess-1', 'plugin-detected pause')).not.toThrow();
  });

  it('reportFailure forwards to the legacy reportCookieFailure', () => {
    const sessionManager = buildFakeSessionManager();
    const service = createSessionService(sessionManager as any);

    service.reportFailure('sess-1', 'item-42', 'timeout');

    expect(sessionManager.reportCookieFailure).toHaveBeenCalledWith('sess-1', 'item-42', 'plugin', 0);
  });
});
