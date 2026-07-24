/**
 * QueueService adapter — thin wrapper around the existing ScrapeQueue
 * singleton, mapping its {id, ...} results onto the generic
 * {itemId, ...} contract shape. Accepts an injected queue for testability;
 * defaults to the real singleton at runtime.
 */
import { getScrapeQueue } from '../scrapeQueue.js';
import type { ScrapeQueue } from '../scrapeQueue.js';
import { QueueService, EnqueueOptions, EnqueueResult } from '@figurecollecting/scraper-plugin-contract';

export type QueueServiceDeps = Pick<
  ScrapeQueue,
  'enqueue' | 'enqueueBulk' | 'getStats' | 'resumeSession' | 'cancelFailedItems' | 'cancelAllForSession' | 'clear'
>;

export function createQueueService(queue: QueueServiceDeps = getScrapeQueue()): QueueService {
  return {
    enqueue(itemId: string, options?: EnqueueOptions): EnqueueResult {
      const result = queue.enqueue(itemId, options);
      // Guard against unhandled rejection — plugins that don't await the
      // scrape result (they get progress via webhooks instead) shouldn't
      // crash the process when a scrape ultimately fails.
      result.promise.catch(() => {});
      return { itemId: result.id, deduplicated: result.deduplicated, position: result.position };
    },

    enqueueBulk(items: Array<{ itemId: string; options?: EnqueueOptions }>): EnqueueResult[] {
      const results = queue.enqueueBulk(items.map(({ itemId, options }) => ({ mfcId: itemId, ...options })));
      results.forEach(r => r.promise.catch(() => {}));
      return results.map(r => ({ itemId: r.id, deduplicated: r.deduplicated, position: r.position }));
    },

    getStats() {
      return queue.getStats();
    },

    resumeSession(sessionId: string): boolean {
      return queue.resumeSession(sessionId);
    },

    cancelFailedItems(sessionId: string): number {
      return queue.cancelFailedItems(sessionId);
    },

    cancelAllForSession(sessionId: string): number {
      return queue.cancelAllForSession(sessionId);
    },

    reset(): void {
      queue.clear();
    },
  };
}
