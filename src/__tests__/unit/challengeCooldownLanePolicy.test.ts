/**
 * challengeCooldown — the per-LANE window policy (ANCF a).
 *
 * - browser lane: a challenge the real browser could not clear opens a fixed 3-hour window.
 * - impersonate (impit) lane: an escalating back-off — 30 min, then 60, 120, 240, capped at 6 h —
 *   that grows on each challenge after the previous window expired WITHOUT a clean fetch in
 *   between, and resets on a clean fetch (noteSuccess).
 * - any other lane (http, or none named): the configured window, exactly as before.
 */
import { ChallengeCooldown } from '../../services/challengeCooldown';

const MIN = 60_000;
const HOUR = 60 * MIN;
const HOST = 'gated.example.test';

describe('challengeCooldown — per-lane window policy', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    delete process.env.CHALLENGE_COOLDOWN_MS;
  });

  describe('browser lane', () => {
    it('opens a fixed 3-hour window, whatever the configured window or env says', () => {
      process.env.CHALLENGE_COOLDOWN_MS = String(5 * MIN);
      const t = 1_000_000;
      const cd = new ChallengeCooldown({ now: () => t, windowMs: MIN });

      const entry = cd.open(HOST, 'catalog challenge page', 'browser');

      expect(entry.until - entry.openedAt).toBe(3 * HOUR);
      expect(cd.remaining(HOST)).toBe(3 * HOUR);
      expect(warn.mock.calls.map((c) => String(c[0]))).toContainEqual(
        `[COOLDOWN] opened ${HOST} for 180 min (catalog challenge page)`,
      );
    });

    it('does not escalate: a second challenge after expiry opens 3 hours again', () => {
      let t = 1_000_000;
      const cd = new ChallengeCooldown({ now: () => t });
      cd.open(HOST, 'r', 'browser');
      t += 3 * HOUR;
      cd.open(HOST, 'r', 'browser');
      expect(cd.remaining(HOST)).toBe(3 * HOUR);
    });
  });

  describe('other lanes keep the configured window', () => {
    it('http lane and an unnamed lane both use windowMs', () => {
      const t = 1_000_000;
      const cd = new ChallengeCooldown({ now: () => t, windowMs: 2 * MIN });
      cd.open('a.test', 'r', 'http');
      cd.open('b.test', 'r');
      expect(cd.remaining('a.test')).toBe(2 * MIN);
      expect(cd.remaining('b.test')).toBe(2 * MIN);
    });
  });

  describe('impersonate lane: escalating back-off', () => {
    it('30 → 60 → 120 → 240 → 360 (cap) → 360 min, each opened after the previous window expired', () => {
      let t = 1_000_000;
      const cd = new ChallengeCooldown({ now: () => t, windowMs: MIN });
      const seen: number[] = [];
      for (let i = 0; i < 6; i++) {
        const e = cd.open(HOST, 'catalog challenge page', 'impersonate');
        seen.push((e.until - e.openedAt) / MIN);
        t = e.until; // the window has just expired; no clean fetch in between
      }
      expect(seen).toEqual([30, 60, 120, 240, 360, 360]);
    });

    it('a re-open while the window is still live is the same incident: same length, not escalated', () => {
      let t = 1_000_000;
      const cd = new ChallengeCooldown({ now: () => t });
      cd.open(HOST, 'r', 'impersonate');
      t += 10 * MIN;
      const again = cd.open(HOST, 'r', 'impersonate');
      expect(again.until - again.openedAt).toBe(30 * MIN);
      expect(cd.remaining(HOST)).toBe(30 * MIN);
    });

    it('a clean fetch resets the ladder: noteSuccess clears the expired entry and the next challenge opens 30 min', () => {
      let t = 1_000_000;
      const cd = new ChallengeCooldown({ now: () => t });
      t = cd.open(HOST, 'r', 'impersonate').until;
      t = cd.open(HOST, 'r', 'impersonate').until; // 60 min, now expired

      expect(cd.noteSuccess(HOST)).toBe(true);

      const fresh = cd.open(HOST, 'r', 'impersonate');
      expect(fresh.until - fresh.openedAt).toBe(30 * MIN);
    });

    it('starts from the 30-minute floor when the previous entry was a short window from another lane', () => {
      let t = 1_000_000;
      const cd = new ChallengeCooldown({ now: () => t, windowMs: MIN });
      t = cd.open(HOST, 'r', 'http').until; // 1 min, expired
      const e = cd.open(HOST, 'r', 'impersonate');
      expect(e.until - e.openedAt).toBe(30 * MIN);
    });

    it('survives a restart inside a live window: the restored window length is the next step\'s base', () => {
      let t = 1_000_000;
      const cd = new ChallengeCooldown({ now: () => t });
      cd.restore([{ host: HOST, openedAt: t - 10 * MIN, until: t - 10 * MIN + 60 * MIN, reason: 'r' }]);
      t += 50 * MIN; // the restored 60-minute window has expired
      const e = cd.open(HOST, 'r', 'impersonate');
      expect(e.until - e.openedAt).toBe(120 * MIN);
    });
  });

  describe('noteSuccess', () => {
    it('never clears a still-live window (a window opened while the clean fetch was in flight survives)', () => {
      const t = 1_000_000;
      const cd = new ChallengeCooldown({ now: () => t });
      cd.open(HOST, 'r', 'impersonate');
      expect(cd.noteSuccess(HOST)).toBe(false);
      expect(cd.isOpen(HOST)).toBe(true);
    });

    it('is false (and logs nothing) for a host that was never opened', () => {
      const cd = new ChallengeCooldown({ now: () => 1 });
      expect(cd.noteSuccess(HOST)).toBe(false);
      expect(warn).not.toHaveBeenCalled();
    });
  });
});
