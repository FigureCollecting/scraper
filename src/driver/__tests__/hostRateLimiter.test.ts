/**
 * TDD (red first): HostRateLimiter — the new driver's PER-HOST throttle,
 * replacing the legacy queue's single global delay. Each host carries its own
 * delay/backoff/recovery seeded from that store's rate config (StoreProfile
 * `rateLimit`), so parallel stores never share a throttle and a Cloudflare
 * block on one host cannot slow another.
 */
import { HostRateLimiter, type HostRateConfig } from '../hostRateLimiter';

const cfg = (over: Partial<HostRateConfig> = {}): HostRateConfig => ({
  baseDelayMs: 1000,
  minDelayMs: 250,
  maxDelayMs: 60000,
  backoffMultiplier: 2,
  recoveryDivisor: 2,
  successThreshold: 3,
  ...over,
});

describe('HostRateLimiter — per-host throttle', () => {
  it('starts each host at its own base delay (independent config)', () => {
    const rl = new HostRateLimiter((host) =>
      host === 'a.com' ? cfg({ baseDelayMs: 1000 }) : cfg({ baseDelayMs: 5000 }),
    );
    expect(rl.currentDelay('a.com')).toBe(1000);
    expect(rl.currentDelay('b.com')).toBe(5000);
  });

  it('a rate-limit backoff on host A does not affect host B', () => {
    const rl = new HostRateLimiter(() => cfg({ baseDelayMs: 1000, backoffMultiplier: 2 }));
    rl.recordRateLimited('a.com');
    expect(rl.currentDelay('a.com')).toBe(2000); // backed off
    expect(rl.currentDelay('b.com')).toBe(1000); // untouched — separate host state
  });

  it('recovers per host after successThreshold consecutive successes', () => {
    const rl = new HostRateLimiter(() =>
      cfg({ baseDelayMs: 4000, recoveryDivisor: 2, successThreshold: 3 }),
    );
    rl.recordRateLimited('a.com'); // 8000
    rl.recordSuccess('a.com');
    rl.recordSuccess('a.com');
    expect(rl.currentDelay('a.com')).toBe(8000); // not yet at threshold
    rl.recordSuccess('a.com'); // 3rd → one recovery step
    expect(rl.currentDelay('a.com')).toBe(4000); // 8000 / 2
  });

  it('clamps delay to [minDelayMs, maxDelayMs]', () => {
    const rl = new HostRateLimiter(() => cfg({ baseDelayMs: 1000, maxDelayMs: 1500, backoffMultiplier: 2 }));
    rl.recordRateLimited('a.com'); // 2000 → clamp 1500
    rl.recordRateLimited('a.com'); // 3000 → clamp 1500
    expect(rl.currentDelay('a.com')).toBe(1500);
  });

  it('msUntilReady counts down the per-host delay from the last dispatch', () => {
    const rl = new HostRateLimiter(() => cfg({ baseDelayMs: 1000 }));
    rl.recordDispatch('a.com', 10_000);
    expect(rl.msUntilReady('a.com', 10_400)).toBe(600); // 1000 - 400 elapsed
    expect(rl.msUntilReady('a.com', 11_000)).toBe(0); // delay elapsed → ready
    expect(rl.msUntilReady('never-dispatched.com', 11_000)).toBe(0); // fresh host is ready
  });

  it('falls back to the default config for a host with no profile', () => {
    const rl = new HostRateLimiter(() => undefined, cfg({ baseDelayMs: 2067 }));
    expect(rl.currentDelay('unmapped.example')).toBe(2067);
  });

  it('resets the success streak on a rate-limit (no accidental recovery)', () => {
    const rl = new HostRateLimiter(() => cfg({ baseDelayMs: 1000, successThreshold: 3, recoveryDivisor: 2 }));
    rl.recordSuccess('a.com');
    rl.recordSuccess('a.com');
    rl.recordRateLimited('a.com'); // streak reset + backoff → 2000
    rl.recordSuccess('a.com'); // only 1 toward threshold now
    expect(rl.currentDelay('a.com')).toBe(2000); // no recovery yet
  });

  it('treats a dispatch at now=0 as real (0 is a valid time, not the never-dispatched sentinel)', () => {
    const rl = new HostRateLimiter(() => cfg({ baseDelayMs: 1000 }));
    rl.recordDispatch('a.com', 0);
    expect(rl.msUntilReady('a.com', 400)).toBe(600); // throttled from t=0, not treated as fresh
  });
});
