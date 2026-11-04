/**
 * challengeCooldown — a per-host "leave it alone" timer opened when a host serves a Cloudflare
 * challenge/block. A challenged host must NOT be re-fetched in a tight loop (each failed challenge
 * degrades the IP's reputation with CF Bot Management), so both the ingest queue and the lookup
 * fan-out consult this before fetching. Pure, time-injectable (no real clock, no timers).
 *
 * Pins: open/isOpen/remaining/expiry/clear, host normalization, window clamp (1 min .. 24 h),
 * the CHALLENGE_COOLDOWN_MS env override, list() observability shape, the ChallengeCooldownError,
 * and the [COOLDOWN] opened/cleared log lines.
 */
import {
  ChallengeCooldown,
  ChallengeCooldownError,
  clampWindow,
  getChallengeCooldown,
  resetChallengeCooldown,
} from '../../services/challengeCooldown';

const MIN = 60_000; // 1 minute
const MAX = 24 * 60 * 60_000; // 24 hours
const DEFAULT = 30 * 60_000; // 30 minutes

describe('challengeCooldown — per-host CF cooldown (time-injectable)', () => {
  const HOST = 'coolhost.example.test';

  afterEach(() => {
    delete process.env.CHALLENGE_COOLDOWN_MS;
    resetChallengeCooldown();
  });

  it('open → isOpen true, remaining ~= window, list() reports {host, remainingMs, reason}', () => {
    let t = 1_000_000;
    const cd = new ChallengeCooldown({ now: () => t, windowMs: MIN });

    cd.open(HOST, 'challenge page');

    expect(cd.isOpen(HOST)).toBe(true);
    expect(cd.remaining(HOST)).toBe(MIN);
    expect(cd.list()).toEqual([{ host: HOST, remainingMs: MIN, reason: 'challenge page' }]);
  });

  it('isOpen false / remaining 0 for a host that was never opened', () => {
    const cd = new ChallengeCooldown({ now: () => 5, windowMs: MIN });
    expect(cd.isOpen(HOST)).toBe(false);
    expect(cd.remaining(HOST)).toBe(0);
    expect(cd.list()).toEqual([]);
  });

  it('expires exactly at `until`: isOpen flips false, remaining hits 0, list() drops it', () => {
    let t = 1_000_000;
    const cd = new ChallengeCooldown({ now: () => t, windowMs: MIN });
    cd.open(HOST, 'r');

    t += MIN - 1;
    expect(cd.isOpen(HOST)).toBe(true);
    expect(cd.remaining(HOST)).toBe(1);

    t += 1; // now === until
    expect(cd.isOpen(HOST)).toBe(false);
    expect(cd.remaining(HOST)).toBe(0);
    expect(cd.list()).toEqual([]); // expired entries are not listed
  });

  it('clear removes the entry (returns true once, false thereafter) and logs [COOLDOWN] cleared', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const cd = new ChallengeCooldown({ now: () => 1, windowMs: MIN });
    cd.open(HOST, 'r');

    expect(cd.clear(HOST)).toBe(true);
    expect(cd.isOpen(HOST)).toBe(false);
    expect(cd.clear(HOST)).toBe(false); // nothing left to clear
    expect(warn).toHaveBeenCalledWith('[COOLDOWN] cleared coolhost.example.test');
    warn.mockRestore();
  });

  it('normalizes the host key (lowercase, strip www.) so domain variants collapse to one', () => {
    const cd = new ChallengeCooldown({ now: () => 1, windowMs: MIN });
    cd.open('WWW.CoolHost.example.test', 'r');
    expect(cd.isOpen('coolhost.example.test')).toBe(true);
    expect(cd.isOpen('www.coolhost.example.test')).toBe(true);
    expect(cd.remaining('CoolHost.example.test')).toBe(MIN);
    expect(cd.list()[0].host).toBe('coolhost.example.test'); // canonical key stored
  });

  it('logs [COOLDOWN] opened <host> for <m> min (streak <n>, <reason>)', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const cd = new ChallengeCooldown({ now: () => 1, windowMs: 2 * MIN });
    cd.open(HOST, 'search challenge page');
    expect(warn).toHaveBeenCalledWith('[COOLDOWN] opened coolhost.example.test for 2 min (streak 1, search challenge page)');
    warn.mockRestore();
  });

  describe('window clamp (1 min .. 24 h)', () => {
    it('clampWindow: below-min → 1 min, above-max → 24 h, non-finite → 30 min default', () => {
      expect(clampWindow(500)).toBe(MIN);
      expect(clampWindow(0)).toBe(MIN);
      expect(clampWindow(-5)).toBe(MIN);
      expect(clampWindow(100 * 60 * 60_000)).toBe(MAX); // 100 h → 24 h
      expect(clampWindow(5 * 60_000)).toBe(5 * 60_000); // in-range passes through
      expect(clampWindow(NaN)).toBe(DEFAULT);
      expect(clampWindow(Infinity)).toBe(DEFAULT);
    });

    it('constructor clamps a sub-minute window up to the 1-min floor', () => {
      const cd = new ChallengeCooldown({ now: () => 0, windowMs: 1_000 });
      cd.open(HOST, 'r');
      expect(cd.remaining(HOST)).toBe(MIN);
    });

    it('constructor clamps an over-24h window down to the ceiling', () => {
      const cd = new ChallengeCooldown({ now: () => 0, windowMs: 100 * 60 * 60_000 });
      cd.open(HOST, 'r');
      expect(cd.remaining(HOST)).toBe(MAX);
    });
  });

  describe('CHALLENGE_COOLDOWN_MS env override', () => {
    it('an unset env yields the 30-min default window', () => {
      delete process.env.CHALLENGE_COOLDOWN_MS;
      const cd = new ChallengeCooldown({ now: () => 0 });
      cd.open(HOST, 'r');
      expect(cd.remaining(HOST)).toBe(DEFAULT);
    });

    it('a valid env value sets the window (clamped)', () => {
      process.env.CHALLENGE_COOLDOWN_MS = String(2 * MIN);
      const cd = new ChallengeCooldown({ now: () => 0 });
      cd.open(HOST, 'r');
      expect(cd.remaining(HOST)).toBe(2 * MIN);
    });

    it('a below-min env value is clamped up to the 1-min floor', () => {
      process.env.CHALLENGE_COOLDOWN_MS = '500';
      const cd = new ChallengeCooldown({ now: () => 0 });
      cd.open(HOST, 'r');
      expect(cd.remaining(HOST)).toBe(MIN);
    });

    it('a non-numeric env value falls back to the 30-min default', () => {
      process.env.CHALLENGE_COOLDOWN_MS = 'not-a-number';
      const cd = new ChallengeCooldown({ now: () => 0 });
      cd.open(HOST, 'r');
      expect(cd.remaining(HOST)).toBe(DEFAULT);
    });

    it('an explicit constructor windowMs beats the env', () => {
      process.env.CHALLENGE_COOLDOWN_MS = String(2 * MIN);
      const cd = new ChallengeCooldown({ now: () => 0, windowMs: 5 * MIN });
      cd.open(HOST, 'r');
      expect(cd.remaining(HOST)).toBe(5 * MIN);
    });
  });

  describe('escalation while a host keeps challenging (base x 2^(streak-1), capped)', () => {
    const SIX_H = 6 * 60 * MIN;
    let warn: jest.SpyInstance;
    beforeEach(() => {
      warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
      delete process.env.CHALLENGE_COOLDOWN_MAX_MS;
      warn.mockRestore();
    });

    /** Open, read the window it set, then step the clock past it (the window lapses, no clean fetch). */
    function openAndLapse(cd: ChallengeCooldown, clock: { t: number }): number {
      cd.open(HOST, 'challenge page');
      const w = cd.remaining(HOST);
      clock.t += w;
      return w;
    }

    it('three opens with no clean fetch in between give 30, 60, 120 min and name the streak', () => {
      const clock = { t: 1_000_000 };
      const cd = new ChallengeCooldown({ now: () => clock.t });
      expect([openAndLapse(cd, clock), openAndLapse(cd, clock), openAndLapse(cd, clock)]).toEqual([
        DEFAULT,
        2 * DEFAULT,
        4 * DEFAULT,
      ]);
      expect(cd.streak(HOST)).toBe(3);
      expect(warn).toHaveBeenCalledWith('[COOLDOWN] opened coolhost.example.test for 60 min (streak 2, challenge page)');
      expect(warn).toHaveBeenCalledWith('[COOLDOWN] opened coolhost.example.test for 120 min (streak 3, challenge page)');
    });

    it('a clean fetch (clear) resets the streak, so the next open is back to the base window', () => {
      const clock = { t: 1_000_000 };
      const cd = new ChallengeCooldown({ now: () => clock.t });
      openAndLapse(cd, clock);
      openAndLapse(cd, clock);
      expect(cd.clear(HOST)).toBe(true);
      expect(cd.streak(HOST)).toBe(0);
      expect(openAndLapse(cd, clock)).toBe(DEFAULT);
    });

    it('the window is capped at CHALLENGE_COOLDOWN_MAX_MS (default 6 h): 30, 60, 120, 240, 360, 360', () => {
      const clock = { t: 0 };
      const cd = new ChallengeCooldown({ now: () => clock.t });
      const windows = Array.from({ length: 6 }, () => openAndLapse(cd, clock));
      expect(windows).toEqual([DEFAULT, 2 * DEFAULT, 4 * DEFAULT, 8 * DEFAULT, SIX_H, SIX_H]);
    });

    it('a straggler challenge while the window is still live re-extends at the same level, never escalates', () => {
      const clock = { t: 0 };
      const cd = new ChallengeCooldown({ now: () => clock.t });
      cd.open(HOST, 'challenge page');
      clock.t += 10 * MIN;
      cd.open(HOST, 'search challenge page'); // an in-flight lookup came back challenged
      expect(cd.streak(HOST)).toBe(1);
      expect(cd.remaining(HOST)).toBe(DEFAULT);
    });

    it('restore keeps the streak, derived from the entry window (until - openedAt)', () => {
      const clock = { t: 10_000_000 };
      const cd = new ChallengeCooldown({ now: () => clock.t });
      const openedAt = clock.t - 10 * MIN;
      expect(cd.restore([{ host: 'WWW.' + HOST, until: openedAt + 4 * DEFAULT, reason: 'r', openedAt }])).toBe(1);
      expect(cd.streak(HOST)).toBe(3);
      clock.t = openedAt + 4 * DEFAULT; // the restored window lapses, the host challenges again
      cd.open(HOST, 'r');
      expect(cd.remaining(HOST)).toBe(8 * DEFAULT);
      expect(cd.streak(HOST)).toBe(4);
    });

    it('restore of a base-window (or shorter) entry is streak 1', () => {
      const cd = new ChallengeCooldown({ now: () => 0 });
      cd.restore([{ host: HOST, until: 30 * MIN, reason: 'r', openedAt: 10 * MIN }]);
      expect(cd.streak(HOST)).toBe(1);
    });

    it('a valid CHALLENGE_COOLDOWN_MAX_MS sets the cap', () => {
      process.env.CHALLENGE_COOLDOWN_MAX_MS = String(60 * MIN);
      const clock = { t: 0 };
      const cd = new ChallengeCooldown({ now: () => clock.t });
      expect([openAndLapse(cd, clock), openAndLapse(cd, clock), openAndLapse(cd, clock)]).toEqual([DEFAULT, 60 * MIN, 60 * MIN]);
    });

    it.each([['not-a-number'], [''], ['   ']])('an invalid or empty CHALLENGE_COOLDOWN_MAX_MS (%p) falls back to 6 h', (raw) => {
      process.env.CHALLENGE_COOLDOWN_MAX_MS = raw;
      const clock = { t: 0 };
      const cd = new ChallengeCooldown({ now: () => clock.t });
      const windows = Array.from({ length: 6 }, () => openAndLapse(cd, clock));
      expect(windows[5]).toBe(SIX_H);
    });

    it('a cap below the base window means no escalation (the base wins), and above 24 h clamps to 24 h', () => {
      const clock = { t: 0 };
      const low = new ChallengeCooldown({ now: () => clock.t, maxWindowMs: 5 * MIN });
      expect([openAndLapse(low, clock), openAndLapse(low, clock)]).toEqual([DEFAULT, DEFAULT]);
      const high = new ChallengeCooldown({ now: () => clock.t, windowMs: 12 * 60 * MIN, maxWindowMs: 100 * 60 * MIN });
      expect([openAndLapse(high, clock), openAndLapse(high, clock), openAndLapse(high, clock)]).toEqual([12 * 60 * MIN, MAX, MAX]);
    });

    it('an explicit maxWindowMs beats the env', () => {
      process.env.CHALLENGE_COOLDOWN_MAX_MS = String(60 * MIN);
      const clock = { t: 0 };
      const cd = new ChallengeCooldown({ now: () => clock.t, maxWindowMs: 2 * 60 * MIN });
      expect([openAndLapse(cd, clock), openAndLapse(cd, clock), openAndLapse(cd, clock)]).toEqual([DEFAULT, 60 * MIN, 120 * MIN]);
    });

    it('a gate-failure run opens through the same escalation', () => {
      const clock = { t: 0 };
      const cd = new ChallengeCooldown({ now: () => clock.t, gateFailureThreshold: 1 });
      expect(cd.recordGateFailure(HOST, 'empty body').opened?.until).toBe(DEFAULT);
      clock.t += DEFAULT;
      const second = cd.recordGateFailure(HOST, 'empty body').opened;
      expect(second?.until).toBe(clock.t + 2 * DEFAULT);
      expect(cd.streak(HOST)).toBe(2);
    });

    it('streak is 0 for a host that never challenged', () => {
      expect(new ChallengeCooldown({ now: () => 0 }).streak(HOST)).toBe(0);
    });
  });

  describe('history: what the last window per host was, even after it closed', () => {
    let warn: jest.SpyInstance;
    beforeEach(() => {
      warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => warn.mockRestore());

    const iso = (ms: number) => new Date(ms).toISOString();

    it('is empty for a register that never opened', () => {
      expect(new ChallengeCooldown({ now: () => 0 }).history()).toEqual([]);
    });

    it('an open window is listed with when, how long, why, its streak and the hour counters', () => {
      const t = Date.UTC(2026, 10, 3, 1, 0, 0);
      const cd = new ChallengeCooldown({ now: () => t });
      cd.open(HOST, 'challenge page via impersonate transport');
      expect(cd.history()).toEqual([
        {
          host: HOST,
          open: true,
          lastOpenedAt: iso(t),
          lastWindowMin: 30,
          lastReason: 'challenge page via impersonate transport',
          streak: 1,
          lastClearedAt: null,
          challenged60m: 1,
          queueFastFails60m: 0,
        },
      ]);
    });

    it('a lapsed and cleared window stays listed, closed, with the streak it reached and when it cleared', () => {
      const clock = { t: Date.UTC(2026, 10, 3, 1, 0, 0) };
      const cd = new ChallengeCooldown({ now: () => clock.t });
      cd.open(HOST, 'r1');
      clock.t += DEFAULT;
      cd.open(HOST, 'r2'); // streak 2, 60 min
      const openedAt = clock.t;
      clock.t += 2 * DEFAULT;
      cd.clear(HOST);
      expect(cd.list()).toEqual([]);
      expect(cd.history()).toEqual([
        expect.objectContaining({
          host: HOST,
          open: false,
          lastOpenedAt: iso(openedAt),
          lastWindowMin: 60,
          lastReason: 'r2',
          streak: 2,
          lastClearedAt: iso(clock.t),
          challenged60m: 0, // both opens are now more than an hour old
        }),
      ]);
    });

    it('counts challenged fetches and queue fast-fails over the trailing 60 min only', () => {
      const clock = { t: 0 };
      const cd = new ChallengeCooldown({ now: () => clock.t });
      cd.open(HOST, 'r');
      cd.recordSkip(HOST);
      clock.t += 59 * MIN;
      cd.open(HOST, 'straggler'); // still live: re-extends, counts as a challenged fetch
      cd.recordSkip('WWW.' + HOST);
      cd.recordSkip(HOST);
      expect(cd.history()[0]).toEqual(expect.objectContaining({ challenged60m: 2, queueFastFails60m: 3 }));
      clock.t += 1 * MIN; // the first open and the first skip are now exactly an hour old
      expect(cd.history()[0]).toEqual(expect.objectContaining({ challenged60m: 1, queueFastFails60m: 2 }));
    });

    it('a skip for a host with no history is ignored', () => {
      const cd = new ChallengeCooldown({ now: () => 0 });
      cd.recordSkip(HOST);
      expect(cd.history()).toEqual([]);
    });

    it('restore lists the restored window (counters start at 0 after a restart)', () => {
      const t = Date.UTC(2026, 10, 3, 1, 0, 0);
      const cd = new ChallengeCooldown({ now: () => t });
      const openedAt = t - 10 * MIN;
      cd.restore([{ host: HOST, until: openedAt + 2 * DEFAULT, reason: 'restored', openedAt }]);
      expect(cd.history()).toEqual([
        expect.objectContaining({ open: true, lastOpenedAt: iso(openedAt), lastWindowMin: 60, streak: 2, challenged60m: 0 }),
      ]);
    });
  });

  describe('ChallengeCooldownError', () => {
    it('carries host + remainingMs and names the remaining minutes in its message', () => {
      const err = new ChallengeCooldownError(HOST, 90_000); // 1.5 min → ceil 2
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('ChallengeCooldownError');
      expect(err.host).toBe(HOST);
      expect(err.remainingMs).toBe(90_000);
      expect(err.message).toContain('coolhost.example.test');
      expect(err.message).toContain('2 min');
      expect(err.message.toLowerCase()).toContain('cooling');
    });

    it('floors the reported minutes at 1 even for a sub-minute remainder', () => {
      const err = new ChallengeCooldownError(HOST, 1_000);
      expect(err.message).toContain('1 min');
    });
  });

  describe('module singleton', () => {
    it('getChallengeCooldown returns a stable instance until reset', () => {
      const a = getChallengeCooldown();
      const b = getChallengeCooldown();
      expect(a).toBe(b);
      resetChallengeCooldown();
      expect(getChallengeCooldown()).not.toBe(a);
    });
  });
});
