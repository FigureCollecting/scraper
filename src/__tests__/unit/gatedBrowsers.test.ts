import { jest } from '@jest/globals';
import {
  GATED_BROWSER_MAX_AGE_MS,
  HostConcurrencyLimiter,
  MAX_CONCURRENT_PAGES_PER_HOST,
  gatedHostKey,
  getHostConcurrency,
  resetHostConcurrency,
} from '../../services/gatedBrowsers';

/**
 * The bookkeeping the challenge lane needs once its unit is a per-EGRESS BROWSER rather than a
 * per-host context: the key a host's concurrency is counted under, and the small semaphore that
 * keeps one gated host from opening an unbounded number of tabs in the shared browser.
 */
describe('gatedHostKey', () => {
  it('lower-cases the host and separates the two egresses', () => {
    expect(gatedHostKey('WWW.Anitoysgk.com', 'residential')).toBe('www.anitoysgk.com|residential');
    expect(gatedHostKey('www.anitoysgk.com', 'direct')).not.toBe(gatedHostKey('www.anitoysgk.com', 'residential'));
  });
});

describe('HostConcurrencyLimiter', () => {
  it('admits up to the cap immediately, per key', async () => {
    const limiter = new HostConcurrencyLimiter(2);

    await limiter.acquire('a');
    await limiter.acquire('a');
    await limiter.acquire('b');

    expect(limiter.activeCount('a')).toBe(2);
    expect(limiter.activeCount('b')).toBe(1);
  });

  it('makes the third holder of a key WAIT until one releases', async () => {
    const limiter = new HostConcurrencyLimiter(2);
    const first = await limiter.acquire('a');
    await limiter.acquire('a');

    const admitted = jest.fn();
    const third = limiter.acquire('a').then((release) => { admitted(); return release; });
    await Promise.resolve();
    expect(admitted).not.toHaveBeenCalled();
    expect(limiter.waitingCount('a')).toBe(1);

    first();
    await third;
    expect(admitted).toHaveBeenCalledTimes(1);
    expect(limiter.activeCount('a')).toBe(2);
  });

  it('never lets a busy key block a different one', async () => {
    const limiter = new HostConcurrencyLimiter(1);
    await limiter.acquire('a');

    await expect(limiter.acquire('b')).resolves.toBeInstanceOf(Function);
  });

  it('hands the freed slot to the LONGEST-waiting caller', async () => {
    const limiter = new HostConcurrencyLimiter(1);
    const first = await limiter.acquire('a');
    const order: string[] = [];
    const second = limiter.acquire('a').then((release) => { order.push('second'); return release; });
    const third = limiter.acquire('a').then((release) => { order.push('third'); return release; });

    first();
    (await second)();
    await third;

    expect(order).toEqual(['second', 'third']);
  });

  it('ignores a double release, so one holder cannot free another\'s slot', async () => {
    const limiter = new HostConcurrencyLimiter(2);
    const release = await limiter.acquire('a');
    await limiter.acquire('a');

    release();
    release();

    expect(limiter.activeCount('a')).toBe(1);
  });

  it('forgets a key entirely once nothing holds it', async () => {
    const limiter = new HostConcurrencyLimiter(2);
    const release = await limiter.acquire('a');

    release();

    expect(limiter.activeCount('a')).toBe(0);
    expect(limiter.size()).toBe(0);
  });

  /** Shutdown must not leave a queued fetch awaiting a slot that will never be handed over. */
  it('releases everything waiting on reset', async () => {
    const limiter = new HostConcurrencyLimiter(1);
    await limiter.acquire('a');
    const queued = limiter.acquire('a');

    limiter.reset();

    await expect(queued).resolves.toBeInstanceOf(Function);
    expect(limiter.activeCount('a')).toBe(0);
  });

  it('defaults to two concurrent pages per gated host', () => {
    expect(MAX_CONCURRENT_PAGES_PER_HOST).toBe(2);
    expect(new HostConcurrencyLimiter().activeCount('a')).toBe(0);
  });
});

describe('the process-wide limiter', () => {
  afterEach(() => resetHostConcurrency());

  it('is a singleton, and resettable for isolation', async () => {
    expect(getHostConcurrency()).toBe(getHostConcurrency());
    await getHostConcurrency().acquire('a');
    expect(getHostConcurrency().activeCount('a')).toBe(1);

    resetHostConcurrency();

    expect(getHostConcurrency().activeCount('a')).toBe(0);
  });
});

describe('the gated browser bound', () => {
  /**
   * A gated browser is deliberately immortal between relaunches — it is the profile holding every
   * gated host's clearance — so the only thing bounding it is age. Two hours is far past the ~30 min
   * clearance window (nothing is lost by recycling) and far short of a leak that matters.
   */
  it('recycles a gated browser after two hours', () => {
    expect(GATED_BROWSER_MAX_AGE_MS).toBe(2 * 60 * 60 * 1000);
  });
});
