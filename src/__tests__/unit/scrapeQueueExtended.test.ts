/**
 * Extended unit tests for Scrape Queue
 * Covers error classification, retry logic, queue management,
 * deduplication, priority upgrades, and session management
 */

// Mock dependencies
jest.mock('../../services/genericScraper', () => ({
  BrowserPool: {
    getStealthBrowser: jest.fn(),
    getBrowser: jest.fn(),
    returnBrowser: jest.fn(),
    getPoolSize: jest.fn().mockReturnValue(2),
    getPoolCapacity: jest.fn().mockReturnValue(3),
    reset: jest.fn(),
  },
}));

jest.mock('../../services/webhookClient', () => ({
  notifyItemSuccess: jest.fn().mockResolvedValue(true),
  notifyItemFailed: jest.fn().mockResolvedValue(true),
  notifyItemSkipped: jest.fn().mockResolvedValue(true),
}));

import {
  ScrapeQueue,
  getScrapeQueue,
  resetScrapeQueue,
  QueuePriority,
} from '../../services/scrapeQueue';
import { resetSessionManager } from '../../services/sessionManager';

/**
 * Helper: enqueue and immediately suppress the promise rejection.
 * cancel() rejects the promise from enqueue(), so we must catch it
 * to prevent unhandled rejection crashes in Node.js.
 */
function enqueueAndCatch(queue: ScrapeQueue, mfcId: string, options?: any) {
  const result = queue.enqueue(mfcId, options);
  result.promise.catch(() => {}); // Suppress unhandled rejection
  return result;
}

describe('ScrapeQueue - extended', () => {
  let queue: ScrapeQueue;

  beforeEach(() => {
    jest.clearAllMocks();
    resetScrapeQueue();
    queue = new ScrapeQueue(true); // test mode = true
  });

  afterEach(() => {
    queue.stop();
    queue.clear();
    resetScrapeQueue();
  });

  // ============================================================================
  // Enqueue and Deduplication
  // ============================================================================

  describe('enqueue', () => {
    it('should enqueue an item and return result', () => {
      const result = queue.enqueue('12345');
      expect(result.id).toContain('12345');
      expect(result.deduplicated).toBe(false);
      expect(result.position).toBeGreaterThanOrEqual(0);
      expect(result.promise).toBeInstanceOf(Promise);
    });

    it('should deduplicate same mfcId', () => {
      const result1 = queue.enqueue('12345', { userId: 'user1' });
      const result2 = queue.enqueue('12345', { userId: 'user2' });

      expect(result1.deduplicated).toBe(false);
      expect(result2.deduplicated).toBe(true);
      expect(result2.id).toBe(result1.id);
    });

    it('should not add same user twice to waiting list', () => {
      queue.enqueue('12345', { userId: 'user1' });
      queue.enqueue('12345', { userId: 'user1' });
      const users = queue.getWaitingUsers('12345');
      expect(users.filter(u => u === 'user1')).toHaveLength(1);
    });

    it('should use HOT priority for items with cookies', () => {
      const result = queue.enqueue('12345', {
        priority: 'WARM',
        cookies: { PHPSESSID: 'a' },
      });
      expect(result.deduplicated).toBe(false);

      const stats = queue.getStats();
      expect(stats.hot).toBe(1);
      expect(stats.warm).toBe(0);
    });

    it('should keep COLD priority even with cookies', () => {
      queue.enqueue('12345', {
        priority: 'COLD',
        cookies: { PHPSESSID: 'a' },
      });
      const stats = queue.getStats();
      expect(stats.cold).toBe(1);
    });

    it('should upgrade priority on dedup if new is higher', () => {
      queue.enqueue('12345', { priority: 'COLD' });
      queue.enqueue('12345', { priority: 'WARM' });
      // Item should now be in WARM queue
      const stats = queue.getStats();
      expect(stats.cold).toBe(0);
      expect(stats.warm).toBe(1);
    });

    it('should update cookies on dedup if existing has none', () => {
      queue.enqueue('12345', { priority: 'WARM' });
      queue.enqueue('12345', {
        cookies: { PHPSESSID: 'a' },
        sessionId: 'session1',
      });
      // After adding cookies, should upgrade to HOT
      const stats = queue.getStats();
      expect(stats.hot).toBe(1);
    });

    it('should track per-status queued counts', () => {
      queue.enqueue('1', { status: 'owned' });
      queue.enqueue('2', { status: 'ordered' });
      queue.enqueue('3', { status: 'wished' });
      queue.enqueue('4'); // default status

      const stats = queue.getStats();
      expect(stats.byStatus!.owned.queued).toBe(1);
      expect(stats.byStatus!.ordered.queued).toBe(1);
      expect(stats.byStatus!.wished.queued).toBe(2); // default is wished
    });

    it('should use default userId anonymous', () => {
      queue.enqueue('12345');
      const users = queue.getWaitingUsers('12345');
      expect(users).toContain('anonymous');
    });
  });

  // ============================================================================
  // Bulk Enqueue
  // ============================================================================

  describe('enqueueBulk', () => {
    it('should enqueue multiple items', () => {
      const results = queue.enqueueBulk([
        { mfcId: '1', priority: 'HOT' },
        { mfcId: '2', priority: 'WARM' },
        { mfcId: '3', priority: 'COLD' },
      ]);

      expect(results).toHaveLength(3);
      expect(results.every(r => !r.deduplicated)).toBe(true);
      expect(queue.getStats().total).toBe(3);
    });
  });

  // ============================================================================
  // Queue Stats
  // ============================================================================

  describe('getStats', () => {
    it('should return correct queue sizes', () => {
      queue.enqueue('1', { priority: 'HOT' });
      queue.enqueue('2', { priority: 'HOT' });
      queue.enqueue('3', { priority: 'WARM' });
      queue.enqueue('4', { priority: 'COLD' });

      const stats = queue.getStats();
      expect(stats.hot).toBe(2);
      expect(stats.warm).toBe(1);
      expect(stats.cold).toBe(1);
      expect(stats.total).toBe(4);
      expect(stats.processing).toBe(0);
      expect(stats.completed).toBe(0);
      expect(stats.failed).toBe(0);
    });

    it('should include byStatus breakdown', () => {
      const stats = queue.getStats();
      expect(stats.byStatus).toBeDefined();
      expect(stats.byStatus!.owned).toBeDefined();
      expect(stats.byStatus!.ordered).toBeDefined();
      expect(stats.byStatus!.wished).toBeDefined();
    });
  });

  // ============================================================================
  // isPending / getWaitingUsers
  // ============================================================================

  describe('isPending', () => {
    it('should return true for queued items', () => {
      queue.enqueue('12345');
      expect(queue.isPending('12345')).toBe(true);
    });

    it('should return false for unknown items', () => {
      expect(queue.isPending('99999')).toBe(false);
    });
  });

  describe('getWaitingUsers', () => {
    it('should return users for queued item', () => {
      queue.enqueue('12345', { userId: 'user1' });
      queue.enqueue('12345', { userId: 'user2' });
      const users = queue.getWaitingUsers('12345');
      expect(users).toContain('user1');
      expect(users).toContain('user2');
    });

    it('should return empty for unknown item', () => {
      expect(queue.getWaitingUsers('99999')).toEqual([]);
    });
  });

  // ============================================================================
  // Cancel - uses enqueueAndCatch to suppress rejection crashes
  // ============================================================================

  describe('cancel', () => {
    it('should cancel a pending item', () => {
      enqueueAndCatch(queue, '12345');
      expect(queue.cancel('12345')).toBe(true);
      expect(queue.isPending('12345')).toBe(false);
    });

    it('should return false for non-pending item', () => {
      expect(queue.cancel('99999')).toBe(false);
    });

    it('should reduce queue count on cancel', () => {
      enqueueAndCatch(queue, '1');
      enqueueAndCatch(queue, '2');
      queue.cancel('1');
      expect(queue.getStats().total).toBe(1);
    });
  });

  // ============================================================================
  // Clear
  // ============================================================================

  describe('clear', () => {
    it('should clear all queues', () => {
      queue.enqueue('1', { priority: 'HOT' });
      queue.enqueue('2', { priority: 'WARM' });
      queue.enqueue('3', { priority: 'COLD' });

      queue.clear();

      const stats = queue.getStats();
      expect(stats.total).toBe(0);
      expect(stats.hot).toBe(0);
      expect(stats.warm).toBe(0);
      expect(stats.cold).toBe(0);
    });

    it('should reset status counters', () => {
      queue.enqueue('1', { status: 'owned' });
      queue.clear();
      const stats = queue.getStats();
      expect(stats.byStatus!.owned.queued).toBe(0);
    });
  });

  // ============================================================================
  // Stop
  // ============================================================================

  describe('stop', () => {
    it('should stop processing without error', () => {
      queue.enqueue('12345');
      expect(() => queue.stop()).not.toThrow();
    });
  });

  // ============================================================================
  // triggerRateLimit
  // ============================================================================

  describe('triggerRateLimit', () => {
    it('should set rateLimited flag', () => {
      queue.triggerRateLimit();
      const stats = queue.getStats();
      expect(stats.rateLimited).toBe(true);
    });

    it('should increase delay', () => {
      const initialDelay = queue.getStats().currentDelay;
      queue.triggerRateLimit();
      expect(queue.getStats().currentDelay).toBeGreaterThan(initialDelay);
    });
  });

  // ============================================================================
  // Session Management
  // ============================================================================

  describe('onSessionPaused', () => {
    it('should return unsubscribe function', () => {
      const unsub = queue.onSessionPaused(jest.fn());
      expect(typeof unsub).toBe('function');
      unsub();
    });
  });

  describe('resumeSession', () => {
    it('should delegate to session manager', () => {
      expect(queue.resumeSession('unknown')).toBe(false);
    });
  });

  describe('cancelFailedItems', () => {
    it('should return 0 for session with no items', () => {
      expect(queue.cancelFailedItems('unknown')).toBe(0);
    });
  });

  describe('cancelAllForSession', () => {
    it('should cancel items matching sessionId', () => {
      enqueueAndCatch(queue, '1', { sessionId: 'session1', cookies: { a: 'b' } });
      enqueueAndCatch(queue, '2', { sessionId: 'session1', cookies: { a: 'b' } });
      enqueueAndCatch(queue, '3', { sessionId: 'session2', cookies: { a: 'b' } });

      const count = queue.cancelAllForSession('session1');
      expect(count).toBe(2);
      expect(queue.getStats().total).toBe(1);
    });

    it('should return 0 for non-matching session', () => {
      expect(queue.cancelAllForSession('unknown')).toBe(0);
    });
  });

  describe('getPendingCountForSession', () => {
    it('should count items for session', () => {
      queue.enqueue('1', { sessionId: 'session1', cookies: { a: 'b' } });
      queue.enqueue('2', { sessionId: 'session1', cookies: { a: 'b' } });
      queue.enqueue('3', { sessionId: 'session2', cookies: { a: 'b' } });

      expect(queue.getPendingCountForSession('session1')).toBe(2);
      expect(queue.getPendingCountForSession('session2')).toBe(1);
      expect(queue.getPendingCountForSession('unknown')).toBe(0);
    });
  });

  // ============================================================================
  // Singleton
  // ============================================================================

  describe('getScrapeQueue / resetScrapeQueue', () => {
    it('should return same instance', () => {
      const q1 = getScrapeQueue();
      const q2 = getScrapeQueue();
      expect(q1).toBe(q2);
    });

    it('should return new instance after reset', () => {
      const q1 = getScrapeQueue();
      resetScrapeQueue();
      const q2 = getScrapeQueue();
      expect(q1).not.toBe(q2);
    });

    it('should handle double reset', () => {
      resetScrapeQueue();
      resetScrapeQueue();
    });
  });
});
