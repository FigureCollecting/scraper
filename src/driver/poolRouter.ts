/**
 * PoolRouter — the crawl driver's access-tier pool router.
 *
 * The driver runs two worker pools that differ by COST, not by host:
 *   - `browser`  — the expensive browser/mint tier (real headless Chrome, cf_clearance mint,
 *                  fingerprint evasion) for stores whose access barrier demands a browser.
 *   - `fetch`    — the cheap HTTP tier for stores reachable with a plain request (+ a cookie
 *                  or auth header).
 * Each pool is bounded by a capacity sized against the crawl-RATE budget (the binding
 * constraint per infra-budget), so a burst of Cloudflare stores can never starve the cheap
 * fetch stores and vice-versa.
 *
 * The access -> pool mapping is INJECTED (`classify`) rather than hard-coded: the private
 * access taxonomy (StoreProfile.access) lives in the ruleset registry and must not leak into
 * the public engine. This mirrors HostRateLimiter taking `configFor`. Pure and synchronous —
 * capacity is a simple in-flight counter, so behaviour is deterministic and timer-free.
 */

export type PoolKind = 'browser' | 'fetch';

/** Max concurrent in-flight workers per pool (sized vs the crawl-rate budget). */
export interface PoolCapacity {
  browser: number;
  fetch: number;
}

export class PoolRouter {
  private readonly inFlight: Record<PoolKind, number> = { browser: 0, fetch: 0 };

  /**
   * @param capacity  per-pool concurrency ceilings.
   * @param classify  maps a store's access tier to its pool. Injected so the private access
   *                  taxonomy stays out of the public engine.
   */
  constructor(
    private readonly capacity: PoolCapacity,
    private readonly classify: (access: string) => PoolKind,
  ) {}

  /** Which pool a store with this access tier belongs to. */
  poolFor(access: string): PoolKind {
    return this.classify(access);
  }

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

  /**
   * Try to take a slot for a store with this access tier. Returns the resolved pool and
   * whether a slot was granted; on `ok: false` the pool is saturated and the caller should
   * defer this store. Does NOT block.
   */
  tryAcquire(access: string): { ok: boolean; pool: PoolKind } {
    const pool = this.classify(access);
    if (this.available(pool) <= 0) return { ok: false, pool };
    this.inFlight[pool] += 1;
    return { ok: true, pool };
  }

  /** Return a slot to a pool. Clamped at zero so an over-release can never invent capacity. */
  release(pool: PoolKind): void {
    if (this.inFlight[pool] > 0) this.inFlight[pool] -= 1;
  }
}
