/**
 * PoolRouter — the crawl driver's two-pool concurrency limiter.
 *
 * The driver runs two worker pools that differ by COST:
 *   - `browser` — the expensive browser/mint tier (real headless Chrome, cf_clearance mint,
 *                 fingerprint evasion) for stores whose access barrier demands a browser.
 *   - `fetch`   — the cheap HTTP tier for stores reachable with a plain request.
 * Each pool is bounded by a capacity sized against the crawl-RATE budget (the binding
 * constraint per infra-budget), so a burst of browser-gated stores can never starve the cheap
 * fetch stores and vice-versa.
 *
 * This is a pure by-pool semaphore set: callers pass the resolved `PoolKind` (the driver derives
 * it from a store's public `requiresBrowser` via the ProfileRegistry — the private access
 * taxonomy never enters the engine). Synchronous and timer-free, so behaviour is deterministic.
 */

export type PoolKind = 'browser' | 'fetch';

/** Max concurrent in-flight workers per pool (sized vs the crawl-rate budget). */
export interface PoolCapacity {
  browser: number;
  fetch: number;
}

export class PoolRouter {
  private readonly inFlight: Record<PoolKind, number> = { browser: 0, fetch: 0 };

  constructor(private readonly capacity: PoolCapacity) {}

  /** Configured concurrency ceiling for a pool. */
  capacityOf(pool: PoolKind): number {
    return this.capacity[pool];
  }

  /** Workers currently in flight in a pool. */
  inFlightOf(pool: PoolKind): number {
    return this.inFlight[pool];
  }

  /** Free slots in a pool (never negative). */
  available(pool: PoolKind): number {
    return Math.max(0, this.capacity[pool] - this.inFlight[pool]);
  }

  /** Whether a pool has a free slot right now. */
  hasCapacity(pool: PoolKind): boolean {
    return this.available(pool) > 0;
  }

  /** Take a slot in the pool; returns false (without taking one) if the pool is saturated. */
  tryAcquire(pool: PoolKind): boolean {
    if (this.available(pool) <= 0) return false;
    this.inFlight[pool] += 1;
    return true;
  }

  /** Return a slot to a pool. Clamped at zero so an over-release can never invent capacity. */
  release(pool: PoolKind): void {
    if (this.inFlight[pool] > 0) this.inFlight[pool] -= 1;
  }
}
