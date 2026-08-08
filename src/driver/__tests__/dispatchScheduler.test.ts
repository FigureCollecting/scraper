/**
 * TDD (red first): DispatchScheduler — composes HostRateLimiter (per-host timing) and
 * PoolRouter (per-pool capacity) into the crawl driver's scheduler. A queued task may
 * dispatch only when BOTH gates open: its host is past its rate-limit delay AND its access
 * tier's pool has a free slot. Dispatching acquires both resources; `settle` releases the
 * pool slot and records the host outcome (success -> recover, rate-limited -> back off).
 * Pure + synchronous — `now` is passed explicitly, so no timers in the tests.
 */
import { HostRateLimiter, type HostRateConfig } from '../hostRateLimiter';
import { PoolRouter, type PoolKind } from '../poolRouter';
import { DispatchScheduler } from '../dispatchScheduler';

const cfg = (over: Partial<HostRateConfig> = {}): HostRateConfig => ({
  baseDelayMs: 1000, minDelayMs: 250, maxDelayMs: 60000,
  backoffMultiplier: 2, recoveryDivisor: 2, successThreshold: 3, ...over,
});
const classify = (a: string): PoolKind =>
  ['cloudflare', 'datadome', 'robotchecker', 'aws-waf', 'headless-fingerprint'].includes(a) ? 'browser' : 'fetch';

const mk = (cap = { browser: 1, fetch: 2 }) => {
  const limiter = new HostRateLimiter(() => cfg());
  const router = new PoolRouter(cap, classify);
  return { limiter, router, sched: new DispatchScheduler(limiter, router) };
};

describe('DispatchScheduler — host-ready AND pool-slot gating', () => {
  it('returns null when the queue is empty', () => {
    expect(mk().sched.dispatch(0)).toBeNull();
  });

  it('dispatches a ready task, records the host dispatch, and takes a pool slot', () => {
    const { sched, limiter } = mk();
    sched.enqueue({ id: 't1', host: 'a.com', access: 'none' });
    const d = sched.dispatch(1000);
    expect(d?.task.id).toBe('t1');
    expect(d?.pool).toBe('fetch');
    expect(sched.pending()).toBe(0);
    expect(limiter.msUntilReady('a.com', 1000)).toBe(1000); // host now throttled by its delay
  });

  it('skips a throttled host and dispatches the next ready one, leaving the throttled task queued', () => {
    const { sched, limiter } = mk();
    limiter.recordDispatch('busy.com', 1000); // throttled until 2000
    sched.enqueue({ id: 'busy', host: 'busy.com', access: 'none' });
    sched.enqueue({ id: 'free', host: 'free.com', access: 'none' });
    const d = sched.dispatch(1500);
    expect(d?.task.id).toBe('free');
    expect(sched.pending()).toBe(1);
  });

  it('skips a saturated pool and dispatches into a pool with room', () => {
    const { sched, router } = mk(); // browser cap 1
    router.tryAcquire('cloudflare'); // browser pool full
    sched.enqueue({ id: 'br', host: 'cf.com', access: 'cloudflare' });
    sched.enqueue({ id: 'fe', host: 'hlj.com', access: 'none' });
    const d = sched.dispatch(0);
    expect(d?.task.id).toBe('fe');
    expect(d?.pool).toBe('fetch');
    expect(sched.pending()).toBe(1);
  });

  it('holds a second same-pool task until a settle frees the slot', () => {
    const { sched } = mk(); // browser cap 1
    sched.enqueue({ id: 'b1', host: 'x.com', access: 'cloudflare' });
    sched.enqueue({ id: 'b2', host: 'y.com', access: 'cloudflare' });
    const d1 = sched.dispatch(0);
    expect(d1?.task.id).toBe('b1');
    expect(sched.dispatch(0)).toBeNull(); // b2 blocked: browser pool saturated
    sched.settle(d1!.task, d1!.pool, 'success'); // frees the browser slot
    expect(sched.dispatch(0)?.task.id).toBe('b2');
  });

  it('settle records the host outcome (rate-limited backs the delay off)', () => {
    const { sched, limiter } = mk();
    sched.enqueue({ id: 't', host: 'z.com', access: 'cloudflare' });
    const d = sched.dispatch(0)!;
    sched.settle(d.task, d.pool, 'rate-limited');
    expect(limiter.currentDelay('z.com')).toBe(2000); // 1000 * backoff 2
  });

  it('msUntilNext: 0 when ready, the min host delay when throttled, Infinity when the pool is saturated or empty', () => {
    const { sched, limiter, router } = mk();
    expect(sched.msUntilNext(0)).toBe(Infinity); // empty
    sched.enqueue({ id: 'a', host: 'a.com', access: 'none' });
    expect(sched.msUntilNext(0)).toBe(0); // ready now
    limiter.recordDispatch('a.com', 0); // throttled until 1000
    expect(sched.msUntilNext(400)).toBe(600);
    router.tryAcquire('none');
    router.tryAcquire('none'); // fetch cap 2 now full -> task's pool has no room
    expect(sched.msUntilNext(400)).toBe(Infinity);
  });
});
