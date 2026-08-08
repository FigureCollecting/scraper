/**
 * assembleScheduler — the profile-injection wiring that closes I0.
 *
 * Turns a populated ProfileRegistry into a ready-to-run DispatchScheduler by connecting the
 * three seams:
 *   - HostRateLimiter's `configFor` ← `registry.rateConfigFor(host)` (per-store throttle;
 *     unmapped hosts get `defaultRate`).
 *   - PoolRouter ← the caller's per-pool capacity (sized vs the crawl-rate budget).
 *   - DispatchScheduler's `poolFor` ← `registry.poolFor(host)` (requiresBrowser → browser/fetch;
 *     unmapped hosts get the cheap fetch pool — never an expensive browser slot).
 *
 * The private StoreProfile axes never enter here — only the public StoreCapabilities the
 * ProfileRegistry holds. Returns the scheduler plus its primitives for lifecycle control.
 */
import { HostRateLimiter, type HostRateConfig } from './hostRateLimiter.js';
import { PoolRouter, type PoolCapacity, type PoolKind } from './poolRouter.js';
import { DispatchScheduler } from './dispatchScheduler.js';
import type { ProfileRegistry } from './profileRegistry.js';

/** Rate config for hosts with no StoreProfile (the legacy MFC-sync global default constants). */
const DEFAULT_RATE: HostRateConfig = {
  baseDelayMs: 2067, minDelayMs: 274, maxDelayMs: 180_000,
  backoffMultiplier: 1.4, recoveryDivisor: 1.4, successThreshold: 3,
};

export interface AssembledDriver {
  scheduler: DispatchScheduler;
  limiter: HostRateLimiter;
  router: PoolRouter;
}

export function assembleScheduler(
  registry: ProfileRegistry,
  capacity: PoolCapacity,
  defaultRate: HostRateConfig = DEFAULT_RATE,
): AssembledDriver {
  const limiter = new HostRateLimiter((host) => registry.rateConfigFor(host), defaultRate);
  const router = new PoolRouter(capacity);
  const poolFor = (host: string): PoolKind => registry.poolFor(host) ?? 'fetch';
  const scheduler = new DispatchScheduler(limiter, router, poolFor);
  return { scheduler, limiter, router };
}
