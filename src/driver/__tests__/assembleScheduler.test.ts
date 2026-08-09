/**
 * TDD (red first): assembleScheduler — the profile-injection wiring. Given a ProfileRegistry
 * and pool capacities, it produces a ready-to-run DispatchScheduler whose per-host throttle is
 * seeded from each store's rateLimit and whose pool is resolved from requiresBrowser. Hosts with
 * no profile fall back to a default rate config and the cheap fetch pool (never a browser slot).
 */
import type { StoreCapabilities } from '@figurecollecting/scraper-plugin-contract';
import { ProfileRegistry } from '../profileRegistry';
import { assembleScheduler } from '../assembleScheduler';

const caps = (over: Partial<StoreCapabilities> = {}): StoreCapabilities => ({
  siteId: 'amiami', name: 'AmiAmi', domains: ['amiami.com'],
  rateLimit: {
    domain: 'amiami.com', baseDelayMs: 2000, minDelayMs: 300, maxDelayMs: 180_000,
    backoffMultiplier: 1.4, recoveryDivisor: 1.4, successThreshold: 3,
  },
  requiresBrowser: true, allowedCookies: [], ...over,
});

describe('assembleScheduler — wire ProfileRegistry into a runnable scheduler', () => {
  it('routes a mapped store to its pool and seeds its rate config', () => {
    const reg = new ProfileRegistry();
    reg.register(caps({ siteId: 'amiami', domains: ['amiami.com'], requiresBrowser: true }));
    reg.register(caps({
      siteId: 'hlj', name: 'HLJ', domains: ['hlj.com'], requiresBrowser: false,
      rateLimit: {
        domain: 'hlj.com', baseDelayMs: 500, minDelayMs: 100, maxDelayMs: 60_000,
        backoffMultiplier: 2, recoveryDivisor: 2, successThreshold: 3,
      },
    }));
    const { scheduler, limiter } = assembleScheduler(reg, { browser: 1, fetch: 2 });
    scheduler.enqueue({ id: 'a', host: 'amiami.com' }); // browser, base 2000
    scheduler.enqueue({ id: 'h', host: 'hlj.com' }); // fetch, base 500
    const da = scheduler.dispatch(10_000);
    expect(da?.pool).toBe('browser');
    expect(limiter.currentDelay('amiami.com')).toBe(2000); // from the store's rate config
    const dh = scheduler.dispatch(10_000);
    expect(dh?.pool).toBe('fetch');
    expect(limiter.currentDelay('hlj.com')).toBe(500);
  });

  it('falls back to the default rate config and the fetch pool for an unmapped host', () => {
    const reg = new ProfileRegistry();
    const { scheduler, limiter, router } = assembleScheduler(reg, { browser: 1, fetch: 1 });
    scheduler.enqueue({ id: 'u', host: 'unknown.example' });
    const d = scheduler.dispatch(10_000);
    expect(d?.pool).toBe('fetch'); // unmapped → cheap fetch pool, never a browser slot
    expect(limiter.currentDelay('unknown.example')).toBe(2067); // default base delay
    expect(router.inFlightOf('fetch')).toBe(1);
  });

  it('honors a custom default rate config for unmapped hosts', () => {
    const reg = new ProfileRegistry();
    const { limiter } = assembleScheduler(reg, { browser: 1, fetch: 1 }, {
      baseDelayMs: 999, minDelayMs: 100, maxDelayMs: 5000,
      backoffMultiplier: 2, recoveryDivisor: 2, successThreshold: 2,
    });
    expect(limiter.currentDelay('whatever.com')).toBe(999);
  });
});
