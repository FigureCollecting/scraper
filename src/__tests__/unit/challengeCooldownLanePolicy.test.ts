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

    it('survives a restart inside a live window: the restored impit window length is the next step\'s base', () => {
      let t = 1_000_000;
      const cd = new ChallengeCooldown({ now: () => t });
      cd.restore([{ host: HOST, openedAt: t - 10 * MIN, until: t - 10 * MIN + 60 * MIN, reason: 'r', lane: 'impersonate' }]);
      t += 50 * MIN; // the restored 60-minute window has expired
      const e = cd.open(HOST, 'r', 'impersonate');
      expect(e.until - e.openedAt).toBe(120 * MIN);
    });

    it('a restored row with no lane (written before lanes were stored) is not an impit step', () => {
      let t = 1_000_000;
      const cd = new ChallengeCooldown({ now: () => t });
      cd.restore([{ host: HOST, openedAt: t - 10 * MIN, until: t - 10 * MIN + 60 * MIN, reason: 'r' }]);
      t += 50 * MIN;
      const e = cd.open(HOST, 'r', 'impersonate');
      expect(e.until - e.openedAt).toBe(30 * MIN);
    });

    it('an expired BROWSER window is not an impit step: the next impit challenge opens 30 min, not 6 h (A2)', () => {
      let t = 1_000_000;
      const cd = new ChallengeCooldown({ now: () => t });
      t = cd.open(HOST, 'detail challenge page', 'browser').until;
      const e = cd.open(HOST, 'search challenge page', 'impersonate');
      expect(e.until - e.openedAt).toBe(30 * MIN);
    });

    it('two impit challenges after expiry step once: 60, then 60 again (A3)', () => {
      let t = 1_000_000;
      const cd = new ChallengeCooldown({ now: () => t });
      t = cd.open(HOST, 'r', 'impersonate').until;
      const a = cd.open(HOST, 'r', 'impersonate');
      const b = cd.open(HOST, 'r', 'impersonate');
      expect([(a.until - a.openedAt) / MIN, (b.until - b.openedAt) / MIN]).toEqual([60, 60]);
    });
  });

  describe('a shorter lane never cuts a longer live window (F2)', () => {
    it('a live 3 h browser window survives a later http-lane challenge (A1)', () => {
      let t = 1_000_000;
      const cd = new ChallengeCooldown({ now: () => t });
      cd.open(HOST, 'detail challenge page', 'browser');
      t += MIN;
      const kept = cd.open(HOST, 'search challenge page', 'http');
      expect(cd.remaining(HOST)).toBe(3 * HOUR - MIN);
      expect(kept).toMatchObject({ lane: 'browser', reason: 'detail challenge page' });
      expect(warn.mock.calls.map((c) => String(c[0]))).toContainEqual(
        `[COOLDOWN] kept ${HOST} (179 min left, longer than the 30 min a http challenge opens) (search challenge page)`,
      );
    });

    it('a live 6 h impit step survives a later http challenge, and the ladder still steps from it (A1b)', () => {
      let t = 1_000_000;
      const cd = new ChallengeCooldown({ now: () => t });
      for (let i = 0; i < 5; i++) t = cd.open(HOST, 'r', 'impersonate').until;
      cd.open(HOST, 'r', 'impersonate'); // live 6 h
      t += MIN;
      cd.open(HOST, 'r', 'http');
      expect(cd.remaining(HOST)).toBe(6 * HOUR - MIN);
      t += 6 * HOUR;
      const next = cd.open(HOST, 'r', 'impersonate');
      expect(next.until - next.openedAt).toBe(6 * HOUR);
    });

    it('an unnamed-lane challenge inside a live browser window is kept too, and the log says so', () => {
      let t = 1_000_000;
      const cd = new ChallengeCooldown({ now: () => t });
      cd.open(HOST, 'r', 'browser');
      t += MIN;
      cd.open(HOST, 'queue challenge');
      expect(cd.remaining(HOST)).toBe(3 * HOUR - MIN);
      expect(warn.mock.calls.map((c) => String(c[0]))).toContainEqual(
        `[COOLDOWN] kept ${HOST} (179 min left, longer than the 30 min a unnamed challenge opens) (queue challenge)`,
      );
    });

    it('a longer lane still replaces a shorter live window', () => {
      let t = 1_000_000;
      const cd = new ChallengeCooldown({ now: () => t });
      cd.open(HOST, 'r', 'http');
      t += MIN;
      const e = cd.open(HOST, 'r', 'browser');
      expect(e).toMatchObject({ lane: 'browser', openedAt: t, until: t + 3 * HOUR });
    });
  });

  describe('the entry records its lane', () => {
    it('open returns and persists the lane; an unnamed lane is left off', () => {
      const saved: unknown[] = [];
      const cd = new ChallengeCooldown({
        now: () => 5,
        persistence: { saveCooldown: (e) => saved.push(e), removeCooldown: () => {} },
      });
      cd.open('a.test', 'r', 'impersonate');
      cd.open('b.test', 'r');
      expect(saved).toEqual([
        { host: 'a.test', until: 5 + 30 * MIN, reason: 'r', openedAt: 5, lane: 'impersonate' },
        { host: 'b.test', until: 5 + 30 * MIN, reason: 'r', openedAt: 5 },
      ]);
    });
  });

  describe('env and lane names (A5, A6)', () => {
    it('a 24 h CHALLENGE_COOLDOWN_MS reaches http, unknown and unnamed lanes but not browser or impersonate', () => {
      process.env.CHALLENGE_COOLDOWN_MS = String(24 * HOUR);
      const cd = new ChallengeCooldown({ now: () => 1 });
      expect(cd.open('b.test', 'r', 'browser').until - 1).toBe(3 * HOUR);
      expect(cd.open('i.test', 'r', 'impersonate').until - 1).toBe(30 * MIN);
      expect(cd.open('h.test', 'r', 'http').until - 1).toBe(24 * HOUR);
      expect(cd.open('u.test', 'r', 'unknown').until - 1).toBe(24 * HOUR);
      expect(cd.open('n.test', 'r').until - 1).toBe(24 * HOUR);
    });

    it('lane names are exact: "Browser" and "impit" get the configured window', () => {
      const cd = new ChallengeCooldown({ now: () => 1, windowMs: 2 * MIN });
      expect(cd.open('x.test', 'r', 'Browser').until - 1).toBe(2 * MIN);
      expect(cd.open('y.test', 'r', 'impit').until - 1).toBe(2 * MIN);
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
