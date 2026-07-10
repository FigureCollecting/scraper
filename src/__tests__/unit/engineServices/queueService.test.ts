import { jest } from '@jest/globals';
import { createQueueService } from '../../../services/engineServices/queueService';

function buildFakeQueue() {
  return {
    enqueue: jest.fn(),
    enqueueBulk: jest.fn(),
    getStats: jest.fn(),
    resumeSession: jest.fn(),
    cancelFailedItems: jest.fn(),
    cancelAllForSession: jest.fn(),
    clear: jest.fn(),
  };
}

describe('createQueueService', () => {
  it('maps enqueue() id -> itemId and forwards options', () => {
    const queue = buildFakeQueue();
    const promise = Promise.resolve({});
    queue.enqueue.mockReturnValue({ id: 'item-123', deduplicated: false, position: 2, promise });

    const service = createQueueService(queue as any);
    const result = service.enqueue('item-123', { priority: 'HOT' });

    expect(queue.enqueue).toHaveBeenCalledWith('item-123', { priority: 'HOT' });
    expect(result).toEqual({ itemId: 'item-123', deduplicated: false, position: 2 });
  });

  it('never leaks an unhandled rejection when the underlying promise rejects', async () => {
    const queue = buildFakeQueue();
    queue.enqueue.mockReturnValue({
      id: 'item-1',
      deduplicated: false,
      position: 0,
      promise: Promise.reject(new Error('scrape failed')),
    });

    const service = createQueueService(queue as any);
    expect(() => service.enqueue('item-1')).not.toThrow();

    // Flush microtasks; if the adapter did not attach a .catch, this test
    // process would surface an unhandledRejection.
    await new Promise(resolve => setImmediate(resolve));
  });

  it('maps enqueueBulk() items and results', () => {
    const queue = buildFakeQueue();
    queue.enqueueBulk.mockReturnValue([
      { id: 'a', deduplicated: false, position: 0, promise: Promise.resolve({}) },
      { id: 'b', deduplicated: true, position: 1, promise: Promise.resolve({}) },
    ]);

    const service = createQueueService(queue as any);
    const results = service.enqueueBulk([
      { itemId: 'a', options: { priority: 'WARM' } },
      { itemId: 'b' },
    ]);

    expect(queue.enqueueBulk).toHaveBeenCalledWith([
      { mfcId: 'a', priority: 'WARM' },
      { mfcId: 'b' },
    ]);
    expect(results).toEqual([
      { itemId: 'a', deduplicated: false, position: 0 },
      { itemId: 'b', deduplicated: true, position: 1 },
    ]);
  });

  it('passes getStats() through unchanged', () => {
    const queue = buildFakeQueue();
    const stats = {
      hot: 1, warm: 2, cold: 3, total: 6, processing: 1,
      completed: 10, failed: 0, rateLimited: false, currentDelay: 500,
    };
    queue.getStats.mockReturnValue(stats);

    const service = createQueueService(queue as any);
    expect(service.getStats()).toEqual(stats);
  });

  it('forwards resumeSession/cancelFailedItems/cancelAllForSession', () => {
    const queue = buildFakeQueue();
    queue.resumeSession.mockReturnValue(true);
    queue.cancelFailedItems.mockReturnValue(3);
    queue.cancelAllForSession.mockReturnValue(5);

    const service = createQueueService(queue as any);

    expect(service.resumeSession('sess-1')).toBe(true);
    expect(service.cancelFailedItems('sess-1')).toBe(3);
    expect(service.cancelAllForSession('sess-1')).toBe(5);
    expect(queue.resumeSession).toHaveBeenCalledWith('sess-1');
    expect(queue.cancelFailedItems).toHaveBeenCalledWith('sess-1');
    expect(queue.cancelAllForSession).toHaveBeenCalledWith('sess-1');
  });

  it('maps reset() to the legacy queue.clear()', () => {
    const queue = buildFakeQueue();
    const service = createQueueService(queue as any);

    service.reset?.();

    expect(queue.clear).toHaveBeenCalled();
  });
});
