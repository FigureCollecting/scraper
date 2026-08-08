/**
 * DispatchScheduler — the crawl driver's scheduler core.
 *
 * Composes the two I0 primitives into a single "what can run right now?" decision:
 *   - HostRateLimiter gates by per-host TIMING (a host must be past its rate-limit delay).
 *   - PoolRouter gates by per-pool CAPACITY (the access tier's pool must have a free slot).
 * A queued task dispatches only when BOTH gates open. Dispatching acquires both resources
 * (records the host dispatch + takes a pool slot); `settle` returns the pool slot and records
 * the host outcome so the delay recovers on success or backs off on a rate-limit.
 *
 * Pure and synchronous: every time-aware call takes `now` explicitly (delegated to
 * HostRateLimiter), so the scheduler is deterministic and testable without timers. The
 * surrounding driver loop owns the actual sleeping (via `msUntilNext`) and worker execution.
 */
import type { HostRateLimiter } from './hostRateLimiter.js';
import type { PoolRouter, PoolKind } from './poolRouter.js';

/** A unit of crawl work: a host to fetch from and the access tier that selects its pool. */
export interface CrawlTask {
  id: string;
  host: string;
  access: string;
}

export interface Dispatch {
  task: CrawlTask;
  pool: PoolKind;
}

export type Outcome = 'success' | 'rate-limited';

export class DispatchScheduler {
  private readonly queue: CrawlTask[] = [];

  constructor(
    private readonly limiter: HostRateLimiter,
    private readonly router: PoolRouter,
  ) {}

  enqueue(task: CrawlTask): void {
    this.queue.push(task);
  }

  pending(): number {
    return this.queue.length;
  }

  /**
   * Pick and dispatch the first queued task that can run at `now` — host past its delay AND
   * its pool has a free slot. On success the task is removed from the queue, a pool slot is
   * taken, and the host dispatch is recorded (starting its next delay). Returns null when
   * nothing is dispatchable right now (every host throttled and/or every needed pool full).
   */
  dispatch(now: number): Dispatch | null {
    for (let i = 0; i < this.queue.length; i++) {
      const task = this.queue[i];
      if (this.limiter.msUntilReady(task.host, now) > 0) continue; // host still throttled
      const acquired = this.router.tryAcquire(task.access); // takes a slot iff the pool has room
      if (!acquired.ok) continue; // pool saturated — leave the task queued
      this.limiter.recordDispatch(task.host, now);
      this.queue.splice(i, 1);
      return { task, pool: acquired.pool };
    }
    return null;
  }

  /** Complete a dispatched task: return its pool slot and record the host outcome. */
  settle(task: CrawlTask, pool: PoolKind, outcome: Outcome): void {
    this.router.release(pool);
    if (outcome === 'success') this.limiter.recordSuccess(task.host);
    else this.limiter.recordRateLimited(task.host);
  }

  /**
   * Ms until the next dispatch could succeed WITHOUT an intervening settle — i.e. how long the
   * loop may sleep. 0 if a task is ready now; otherwise the smallest host delay among tasks
   * whose pool currently has capacity; Infinity if the queue is empty or every queued task's
   * pool is saturated (those need a settle to free a slot, not the passage of time).
   */
  msUntilNext(now: number): number {
    let min = Infinity;
    for (const task of this.queue) {
      const pool = this.router.poolFor(task.access);
      if (!this.router.hasCapacity(pool)) continue; // needs a settle, not a wait
      const wait = this.limiter.msUntilReady(task.host, now);
      if (wait <= 0) return 0;
      if (wait < min) min = wait;
    }
    return min;
  }
}
