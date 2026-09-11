import { jest } from '@jest/globals';
import {
  GATED_BROWSER_MAX_AGE_MS,
  GATED_BROWSER_MAX_RSS_BYTES,
  GATED_NAV_FAILURE_STREAK,
  HostConcurrencyLimiter,
  MAX_CONCURRENT_PAGES_PER_HOST,
  gatedHostKey,
  getHostConcurrency,
  resetHostConcurrency,
  resolveGatedMaxAgeMs,
  resolveGatedMaxRssBytes,
  resolveGatedNavFailureStreak,
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

describe('the gated browser bounds', () => {
  const withEnv = (vars: Record<string, string | undefined>, run: () => void): void => {
    const saved: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(vars)) {
      saved[key] = process.env[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      run();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };

  /**
   * THE CLOCK IS NOW A BACKSTOP, not the policy. A cleared Cloudflare session is an asset bound to
   * the egress IP, the TLS fingerprint and the user agent; recycling a healthy one buys nothing and
   * spends that IP's reputation earning the challenge again. What the old two-hour timer was FOR —
   * memory growth and a wedged instance — is measured directly by the two bounds below, so the clock
   * only catches whatever they miss.
   */
  it('keeps a healthy gated browser for twelve hours', () => {
    expect(GATED_BROWSER_MAX_AGE_MS).toBe(12 * 60 * 60 * 1000);
    expect(resolveGatedMaxAgeMs({} as NodeJS.ProcessEnv)).toBe(GATED_BROWSER_MAX_AGE_MS);
  });

  /** The pod's limit is 3 GiB across four Chromes, so a gigabyte in one gated browser is a leak. */
  it('recycles a gated browser whose process tree passes a gigabyte', () => {
    expect(GATED_BROWSER_MAX_RSS_BYTES).toBe(1024 * 1024 * 1024);
    expect(resolveGatedMaxRssBytes({} as NodeJS.ProcessEnv)).toBe(GATED_BROWSER_MAX_RSS_BYTES);
  });

  it('treats three consecutive navigation failures as a wedged lane', () => {
    expect(GATED_NAV_FAILURE_STREAK).toBe(3);
    expect(resolveGatedNavFailureStreak({} as NodeJS.ProcessEnv)).toBe(3);
  });

  it('takes each bound from the environment when it is set', () => {
    withEnv({ GATED_BROWSER_MAX_AGE_MS: '1000', GATED_BROWSER_MAX_RSS_MB: '512', GATED_NAV_FAILURE_STREAK: '5' }, () => {
      expect(resolveGatedMaxAgeMs()).toBe(1000);
      expect(resolveGatedMaxRssBytes()).toBe(512 * 1024 * 1024);
      expect(resolveGatedNavFailureStreak()).toBe(5);
    });
  });

  /**
   * A garbage override must degrade to the default, never to zero — a zero age would relaunch on
   * every fetch, which is the failure this whole change exists to stop.
   */
  it('falls back to the default for an empty, zero, negative or non-numeric override', () => {
    for (const bad of ['', '   ', '0', '-1', 'soon']) {
      withEnv({ GATED_BROWSER_MAX_AGE_MS: bad, GATED_BROWSER_MAX_RSS_MB: bad, GATED_NAV_FAILURE_STREAK: bad }, () => {
        expect(resolveGatedMaxAgeMs()).toBe(GATED_BROWSER_MAX_AGE_MS);
        expect(resolveGatedMaxRssBytes()).toBe(GATED_BROWSER_MAX_RSS_BYTES);
        expect(resolveGatedNavFailureStreak()).toBe(GATED_NAV_FAILURE_STREAK);
      });
    }
  });

  /** A streak bound below one would relaunch on the first blip; it is clamped, not trusted. */
  it('never lets the failure streak fall below one', () => {
    withEnv({ GATED_NAV_FAILURE_STREAK: '0.2' }, () => {
      expect(resolveGatedNavFailureStreak()).toBe(1);
    });
  });
});
