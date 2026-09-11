import { jest } from '@jest/globals';
import {
  GATED_BROWSER_MAX_AGE_MS,
  GATED_BROWSER_MAX_RSS_BYTES,
  GATED_BROWSER_MIN_RELAUNCH_INTERVAL_MS,
  GATED_MEMORY_LIMIT_FRACTION,
  GATED_NAV_FAILURE_STREAK,
  GATED_RELAUNCH_BACKOFF_CAP_MS,
  GATED_RELAUNCH_GRACE_MS,
  HostConcurrencyLimiter,
  MAX_CONCURRENT_PAGES_PER_HOST,
  cookieAppliesToHost,
  filterCarriedCookies,
  gateGatedRelaunch,
  gatedHostKey,
  gatedMemoryThresholdBytes,
  getHostConcurrency,
  newGatedLaneStats,
  noteCarriedProofFailure,
  noteGatedRelaunch,
  resetHostConcurrency,
  resolveGatedMaxAgeMs,
  resolveGatedMaxRssBytes,
  resolveGatedMinRelaunchIntervalMs,
  resolveGatedNavFailureStreak,
  resolveGatedRelaunchGraceMs,
  type RelaunchGateLimits,
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

/**
 * THE MEMORY THRESHOLD. A constant is a guess about a pod size; the cgroup publishes the real one.
 * The constant becomes the FLOOR so a small pod cannot derive a threshold so low it churns.
 */
describe('gatedMemoryThresholdBytes', () => {
  const GIB = 1024 * 1024 * 1024;

  it('derives forty per cent of the container ceiling on the 3 GiB scraper pod', () => {
    expect(GATED_MEMORY_LIMIT_FRACTION).toBe(0.4);
    expect(gatedMemoryThresholdBytes(3 * GIB)).toBe(Math.floor(3 * GIB * 0.4));
    expect(Math.round(gatedMemoryThresholdBytes(3 * GIB) / (1024 * 1024))).toBe(1229);
  });

  /** The 1 GiB floor stands wherever forty per cent would be lower — including a 1 GiB pod. */
  it('never derives a threshold below the one-gigabyte floor', () => {
    expect(gatedMemoryThresholdBytes(1 * GIB)).toBe(GATED_BROWSER_MAX_RSS_BYTES);
    expect(gatedMemoryThresholdBytes(512 * 1024 * 1024)).toBe(GATED_BROWSER_MAX_RSS_BYTES);
  });

  it('scales up with a bigger ceiling', () => {
    expect(gatedMemoryThresholdBytes(16 * GIB)).toBe(Math.floor(16 * GIB * 0.4));
  });

  /** Not knowing the ceiling leaves the floor standing — the conservative answer, never a guess. */
  it('falls back to the floor when the ceiling is unknown or nonsense', () => {
    for (const bad of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(gatedMemoryThresholdBytes(bad as number | undefined)).toBe(GATED_BROWSER_MAX_RSS_BYTES);
    }
  });

  /**
   * The env override wins outright. fc-infra currently names 2048 as the interim mitigation for the
   * churn this change replaces, and that value has to keep working across the deploy.
   */
  it('lets GATED_BROWSER_MAX_RSS_MB override the derived default', () => {
    expect(resolveGatedMaxRssBytes({ GATED_BROWSER_MAX_RSS_MB: '2048' } as NodeJS.ProcessEnv, 3 * GIB))
      .toBe(2048 * 1024 * 1024);
    expect(resolveGatedMaxRssBytes({} as NodeJS.ProcessEnv, 3 * GIB)).toBe(gatedMemoryThresholdBytes(3 * GIB));
  });
});

/**
 * THE RATE LIMITER — the half of this fix that is not about measurement.
 *
 * On 2026-09-11 the residential lane relaunched eight times in ten minutes because nothing stopped
 * it acting on the same trigger on every fetch: a successful relaunch CLEARS the measurement, so the
 * next sample re-measured the fresh tree and fired again 30 s later. Correct measurement fixes that
 * instance; the limiter fixes the class, so any trigger that is wrong — or right about something a
 * relaunch cannot cure — costs one prime navigation per interval instead of one per fetch.
 */
describe('gateGatedRelaunch', () => {
  const MB = 1024 * 1024;
  const limits: RelaunchGateLimits = {
    minIntervalMs: 30 * 60 * 1000,
    graceMs: 2 * 60 * 1000,
    backoffCapMs: GATED_RELAUNCH_BACKOFF_CAP_MS,
    thresholdBytes: 1229 * MB,
  };
  const T0 = 1_757_000_000_000;

  it('lets the first evidence relaunch through on a lane that has never relaunched', () => {
    const stats = newGatedLaneStats();
    expect(gateGatedRelaunch('rss', stats, T0, limits)).toEqual({ reason: 'rss', suppressed: null });
    expect(stats.relaunchSuppressed).toBe(0);
  });

  /** THE DEFECT, DIRECTLY. Thirty seconds after a relaunch the lane must refuse to relaunch again. */
  it('suppresses a second evidence relaunch inside the minimum interval', () => {
    const stats = newGatedLaneStats();
    noteGatedRelaunch(stats, T0, 'rss', limits);

    const verdict = gateGatedRelaunch('rss', stats, T0 + 30_000, limits);

    expect(verdict.reason).toBeNull();
    expect(verdict.suppressed).toContain('rate-limited');
    expect(stats.relaunchSuppressed).toBe(1);
    expect(stats.lastSuppressedReason).toMatch(/rss rate-limited, next attempt in \d+s/);
  });

  it('counts every suppression, so a churning trigger is visible on /health', () => {
    const stats = newGatedLaneStats();
    noteGatedRelaunch(stats, T0, 'rss', limits);
    for (let i = 1; i <= 8; i++) gateGatedRelaunch('rss', stats, T0 + i * 30_000, limits);
    expect(stats.relaunchSuppressed).toBe(8);
  });

  it('lets the lane act again once the interval has elapsed', () => {
    const stats = newGatedLaneStats();
    noteGatedRelaunch(stats, T0, 'rss', limits);
    // Settle the grace window on a tree that came down, so only the interval is in play.
    stats.memoryBytes = 100 * MB;
    gateGatedRelaunch(null, stats, T0 + limits.graceMs, limits);

    expect(gateGatedRelaunch('rss', stats, T0 + limits.minIntervalMs, limits).reason).toBe('rss');
  });

  /** A wedged lane is the 2026-09-08 shape, and it is evidence like any other: it waits its turn. */
  it('rate-limits a navigation-failure relaunch too', () => {
    const stats = newGatedLaneStats();
    noteGatedRelaunch(stats, T0, 'navigation-failures', limits);
    expect(gateGatedRelaunch('navigation-failures', stats, T0 + 60_000, limits).reason).toBeNull();
  });

  /**
   * THE ONE EXEMPTION. The backstop is the last line of defence against whatever the evidence
   * triggers miss, and a twelve-hour clock cannot storm — gating it would gate the safety net.
   */
  it('never rate-limits the backstop', () => {
    const stats = newGatedLaneStats();
    noteGatedRelaunch(stats, T0, 'rss', limits);
    expect(gateGatedRelaunch('backstop', stats, T0 + 1000, limits)).toEqual({ reason: 'backstop', suppressed: null });
    expect(stats.relaunchSuppressed).toBe(0);
  });

  describe('grace window and exponential backoff', () => {
    /**
     * A replacement still over the threshold two minutes in is not carrying a leak the old browser
     * had — the measurement is wrong, the threshold is wrong, or Chrome simply costs that much here.
     * Relaunching again cannot fix any of those, so the wait doubles instead.
     */
    it('doubles the wait when the replacement is still over the threshold', () => {
      const stats = newGatedLaneStats();
      noteGatedRelaunch(stats, T0, 'rss', limits);
      expect(stats.graceUntil).toBe(T0 + limits.graceMs);

      stats.memoryBytes = 1400 * MB; // the fresh tree is as big as the one it replaced
      gateGatedRelaunch(null, stats, T0 + limits.graceMs, limits);

      expect(stats.relaunchBackoffMs).toBe(2 * limits.minIntervalMs);
      expect(stats.nextRelaunchAllowedAt).toBe(T0 + limits.graceMs + 2 * limits.minIntervalMs);
      expect(stats.graceUntil).toBe(0);
    });

    it('keeps doubling, and stops at the four-hour cap', () => {
      const stats = newGatedLaneStats();
      const seen: number[] = [];
      let now = T0;
      for (let round = 0; round < 6; round++) {
        noteGatedRelaunch(stats, now, 'rss', limits);
        stats.memoryBytes = 1400 * MB;
        now += limits.graceMs;
        gateGatedRelaunch(null, stats, now, limits);
        seen.push(stats.relaunchBackoffMs);
        now += stats.relaunchBackoffMs;
      }

      expect(seen).toEqual([60, 120, 240, 240, 240, 240].map((m) => m * 60 * 1000));
      expect(stats.relaunchBackoffMs).toBe(GATED_RELAUNCH_BACKOFF_CAP_MS);
    });

    /** A relaunch that DID bring the tree down has earned the plain interval back. */
    it('clears the backoff when the replacement is smaller than the threshold', () => {
      const stats = newGatedLaneStats();
      stats.relaunchBackoffMs = 2 * 60 * 60 * 1000;
      noteGatedRelaunch(stats, T0, 'rss', limits);
      stats.memoryBytes = 300 * MB;

      gateGatedRelaunch(null, stats, T0 + limits.graceMs, limits);

      expect(stats.relaunchBackoffMs).toBe(0);
    });

    /**
     * No measurement is no verdict: an unmeasurable tree must neither punish nor absolve the lane.
     *
     * And the window stays OPEN waiting for one. The sample is taken fire-and-forget, so the instant
     * the window closes it may simply not have landed yet — settling on that race would throw away
     * the verdict on a timing accident rather than on evidence.
     */
    it('holds the window open for a sample that has not landed yet', () => {
      const stats = newGatedLaneStats();
      stats.relaunchBackoffMs = 60 * 60 * 1000;
      noteGatedRelaunch(stats, T0, 'rss', limits);
      stats.memoryBytes = 0;

      gateGatedRelaunch(null, stats, T0 + limits.graceMs, limits);

      expect(stats.relaunchBackoffMs).toBe(60 * 60 * 1000);
      expect(stats.graceUntil).toBe(T0 + limits.graceMs);

      // The sample lands late, and the verdict is reached on it rather than lost.
      stats.memoryBytes = 1400 * MB;
      gateGatedRelaunch(null, stats, T0 + limits.graceMs + 1000, limits);

      expect(stats.relaunchBackoffMs).toBe(2 * 60 * 60 * 1000);
      expect(stats.graceUntil).toBe(0);
    });

    /** A lane that cannot measure AT ALL must not hold the window open forever. */
    it('gives up on the verdict after one further window with no measurement', () => {
      const stats = newGatedLaneStats();
      noteGatedRelaunch(stats, T0, 'rss', limits);
      stats.memoryBytes = 0;

      gateGatedRelaunch(null, stats, T0 + limits.graceMs, limits);
      expect(stats.graceUntil).toBe(T0 + limits.graceMs);

      gateGatedRelaunch(null, stats, T0 + 2 * limits.graceMs, limits);

      expect(stats.graceUntil).toBe(0);
      expect(stats.relaunchBackoffMs).toBe(0);
    });

    /** Only a MEMORY relaunch has anything to judge; the other reasons open no window. */
    it('opens the grace window for rss and for nothing else', () => {
      const backstop = newGatedLaneStats();
      noteGatedRelaunch(backstop, T0, 'backstop', limits);
      expect(backstop.graceUntil).toBe(0);

      const wedged = newGatedLaneStats();
      noteGatedRelaunch(wedged, T0, 'navigation-failures', limits);
      expect(wedged.graceUntil).toBe(0);
    });

    /** The window must not be judged early — a browser two seconds old has settled nothing. */
    it('does not reach a verdict before the window closes', () => {
      const stats = newGatedLaneStats();
      noteGatedRelaunch(stats, T0, 'rss', limits);
      stats.memoryBytes = 1400 * MB;

      gateGatedRelaunch(null, stats, T0 + limits.graceMs - 1, limits);

      expect(stats.relaunchBackoffMs).toBe(0);
      expect(stats.graceUntil).toBe(T0 + limits.graceMs);
    });

    /** After a backoff, the NEXT relaunch inherits it rather than resetting to the plain interval. */
    it('carries the grown backoff into the next relaunch it allows', () => {
      const stats = newGatedLaneStats();
      stats.relaunchBackoffMs = 4 * 60 * 60 * 1000;
      noteGatedRelaunch(stats, T0, 'rss', limits);
      expect(stats.nextRelaunchAllowedAt).toBe(T0 + 4 * 60 * 60 * 1000);
    });
  });

  it('holds the gate settings the incident calls for', () => {
    expect(GATED_BROWSER_MIN_RELAUNCH_INTERVAL_MS).toBe(30 * 60 * 1000);
    expect(GATED_RELAUNCH_GRACE_MS).toBe(2 * 60 * 1000);
    expect(GATED_RELAUNCH_BACKOFF_CAP_MS).toBe(4 * 60 * 60 * 1000);
    expect(resolveGatedMinRelaunchIntervalMs({} as NodeJS.ProcessEnv)).toBe(GATED_BROWSER_MIN_RELAUNCH_INTERVAL_MS);
    expect(resolveGatedRelaunchGraceMs({} as NodeJS.ProcessEnv)).toBe(GATED_RELAUNCH_GRACE_MS);
    expect(resolveGatedMinRelaunchIntervalMs({ GATED_BROWSER_MIN_RELAUNCH_INTERVAL_MS: '900000' } as NodeJS.ProcessEnv))
      .toBe(900_000);
    expect(resolveGatedRelaunchGraceMs({ GATED_RELAUNCH_GRACE_MS: '45000' } as NodeJS.ProcessEnv)).toBe(45_000);
  });
});

/**
 * CARRY-OVER, NARROWED. A failed proof used to withhold the WHOLE cookie jar from the next
 * replacement. But the proof loop stops at the first failure, so every host it had already passed
 * cleared WITH its carried clearance — discarding those spends a fresh Cloudflare challenge each,
 * from the residential IP whose reputation this change exists to protect.
 */
describe('carried-cookie filtering', () => {
  it('matches a domain cookie against the host it covers, dot or no dot', () => {
    expect(cookieAppliesToHost('.anitoysgk.com', 'www.anitoysgk.com')).toBe(true);
    expect(cookieAppliesToHost('www.anitoysgk.com', 'www.anitoysgk.com')).toBe(true);
    expect(cookieAppliesToHost('anitoysgk.com', 'anitoysgk.com')).toBe(true);
    expect(cookieAppliesToHost('.ANITOYSGK.com', 'WWW.Anitoysgk.COM')).toBe(true);
  });

  /** A suffix match that ignored the dot boundary would drop `notanitoysgk.com` cookies too. */
  it('does not match a host that merely ends with the same letters', () => {
    expect(cookieAppliesToHost('.anitoysgk.com', 'www.notanitoysgk.com')).toBe(false);
    expect(cookieAppliesToHost('.suruga-ya.jp', 'www.anitoysgk.com')).toBe(false);
    expect(cookieAppliesToHost(undefined, 'www.anitoysgk.com')).toBe(false);
    expect(cookieAppliesToHost('.', 'www.anitoysgk.com')).toBe(false);
  });

  const jar = [
    { name: 'cf_clearance', domain: '.anitoysgk.com' },
    { name: 'cf_clearance', domain: '.suruga-ya.jp' },
    { name: 'cf_clearance', domain: '.hobby-genki.com' },
    { name: 'session', domain: 'www.anitoysgk.com' },
  ];

  it('carries the whole jar when nothing is blocked', () => {
    expect(filterCarriedCookies(jar, [])).toEqual(jar);
  });

  /** THE NARROWING: one failed host costs one host's clearance, not three. */
  it('withholds only the blocked host, keeping clearances that proved fine', () => {
    const carried = filterCarriedCookies(jar, ['www.anitoysgk.com']);

    expect(carried.map((cookie) => cookie.domain)).toEqual(['.suruga-ya.jp', '.hobby-genki.com']);
  });

  /** The escalation for a lane that has failed twice on the same host: the jar itself is suspect. */
  it('withholds everything once the lane has escalated', () => {
    expect(filterCarriedCookies(jar, ['www.anitoysgk.com'], true)).toEqual([]);
  });

  it('blocks one host on the first failure and escalates on a repeat', () => {
    const stats = newGatedLaneStats();

    noteCarriedProofFailure(stats, 'WWW.Anitoysgk.com');
    expect(stats.carryBlockedHosts).toEqual(['www.anitoysgk.com']);
    expect(stats.carryOverBlocked).toBe(false);

    noteCarriedProofFailure(stats, 'www.suruga-ya.jp');
    expect(stats.carryBlockedHosts).toEqual(['www.anitoysgk.com', 'www.suruga-ya.jp']);
    expect(stats.carryOverBlocked).toBe(false);

    // The same host again, with its cookies ALREADY withheld — so the jar is what is left to blame.
    noteCarriedProofFailure(stats, 'www.anitoysgk.com');
    expect(stats.carryOverBlocked).toBe(true);
  });

  it('ignores a failure with no host to attribute it to', () => {
    const stats = newGatedLaneStats();
    noteCarriedProofFailure(stats, '');
    expect(stats.carryBlockedHosts).toEqual([]);
    expect(stats.carryOverBlocked).toBe(false);
  });
});
