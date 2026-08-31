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

  it('logs [COOLDOWN] opened <host> for <m> min (<reason>)', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const cd = new ChallengeCooldown({ now: () => 1, windowMs: 2 * MIN });
    cd.open(HOST, 'search challenge page');
    expect(warn).toHaveBeenCalledWith('[COOLDOWN] opened coolhost.example.test for 2 min (search challenge page)');
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
