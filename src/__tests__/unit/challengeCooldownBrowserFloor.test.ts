/**
 * challengeCooldown — the BROWSER-LANE floor and "never shorten a live window" (ANCF a), on top of
 * the per-host escalating streak (30 → 60 → 120 → 240 → 360 min, 24 h decay).
 *
 * - A challenge seen on the browser lane opens at least 3 hours: the window is the larger of the
 *   streak's window and 3 h, so the host keeps climbing the same ladder above the floor.
 * - A challenge never moves a live window's end earlier: when the running window outlasts the one
 *   this challenge would open, the running entry is kept (not re-persisted).
 * Cases marked (A…) / (F…) are ported from the challenger's fixtures.
 */
import { ChallengeCooldown } from '../../services/challengeCooldown';

const MIN = 60_000;
const HOUR = 60 * MIN;
const H = 'gated.example.test';

describe('challengeCooldown — browser-lane floor', () => {
  let warn: jest.SpyInstance;
  const warnLines = () => warn.mock.calls.map((c) => String(c[0]));
  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    delete process.env.CHALLENGE_COOLDOWN_MS;
  });

  it('a browser-lane challenge opens 3 hours, not the 30-minute first step', () => {
    const t = 1_000_000;
    const cd = new ChallengeCooldown({ now: () => t });
    const e = cd.open(H, 'catalog challenge page', 'browser');
    expect(e.until - e.openedAt).toBe(3 * HOUR);
    expect(warnLines()).toContainEqual(`[COOLDOWN] opened ${H} for 180 min (streak 1, catalog challenge page)`);
  });

  it('the streak keeps climbing above the floor: 180, 180, 180, 240, 360, 360 min', () => {
    let t = 1_000_000;
    const cd = new ChallengeCooldown({ now: () => t });
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) {
      const e = cd.open(H, 'r', 'browser');
      seen.push((e.until - e.openedAt) / MIN);
      t = e.until;
    }
    expect(seen).toEqual([180, 180, 180, 240, 360, 360]);
  });

  it('the floor never lowers a longer configured base (A5, adapted): a 24 h base stays 24 h on every lane', () => {
    process.env.CHALLENGE_COOLDOWN_MS = String(24 * HOUR);
    const cd = new ChallengeCooldown({ now: () => 1 });
    expect(cd.open('b.test', 'r', 'browser').until - 1).toBe(24 * HOUR);
    expect(cd.open('i.test', 'r', 'impersonate').until - 1).toBe(24 * HOUR);
    expect(cd.open('u.test', 'r', 'unknown').until - 1).toBe(24 * HOUR);
  });

  it('lane names are exact (A6): "Browser" gets the streak window, not the floor', () => {
    const cd = new ChallengeCooldown({ now: () => 1, windowMs: 2 * MIN });
    expect(cd.open('x.test', 'r', 'Browser').until - 1).toBe(2 * MIN);
    expect(cd.open('y.test', 'r', 'impit').until - 1).toBe(2 * MIN);
  });

  it('an expired browser window is one step of the host streak (A2, adapted): the next impit challenge opens 60 min, not 6 h', () => {
    let t = 1_000_000;
    const cd = new ChallengeCooldown({ now: () => t });
    t = cd.open(H, 'detail challenge page', 'browser').until;
    const e = cd.open(H, 'search challenge page', 'impersonate');
    expect(e.until - e.openedAt).toBe(60 * MIN);
  });

  it('the streak is per host, whatever the lane (F5, adapted): impit 30, impit 60, browser 180, then impit 240', () => {
    let t = 1_000_000;
    const cd = new ChallengeCooldown({ now: () => t });
    t = cd.open('x.test', 'r', 'impersonate').until;
    t = cd.open('x.test', 'r', 'impersonate').until;
    t = cd.open('x.test', 'r', 'browser').until;
    const e = cd.open('x.test', 'r', 'impersonate');
    expect((e.until - e.openedAt) / MIN).toBe(240);
  });

  it('a restored 3 h browser window reads as streak 4, so the next challenge opens the 6 h cap (conservative)', () => {
    let t = 1_000_000;
    const cd = new ChallengeCooldown({ now: () => t });
    cd.restore([{ host: H, openedAt: t - MIN, until: t - MIN + 3 * HOUR, reason: 'r' }]);
    expect(cd.streak(H)).toBe(4);
    t += 3 * HOUR;
    const e = cd.open(H, 'r', 'browser');
    expect(e.until - e.openedAt).toBe(6 * HOUR);
  });
});

describe('challengeCooldown — a challenge never shortens a live window', () => {
  let warn: jest.SpyInstance;
  const warnLines = () => warn.mock.calls.map((c) => String(c[0]));
  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('a live 3 h browser window survives a later http-lane challenge (A1), logged as kept and still counted', () => {
    let t = 1_000_000;
    const cd = new ChallengeCooldown({ now: () => t });
    cd.open(H, 'detail challenge page', 'browser');
    t += MIN;
    const kept = cd.open(H, 'search challenge page', 'http');
    expect(cd.remaining(H)).toBe(3 * HOUR - MIN);
    expect(kept.reason).toBe('detail challenge page');
    expect(warnLines()).toContainEqual(
      `[COOLDOWN] kept ${H} (179 min left, longer than the 30 min a http challenge opens) (search challenge page)`,
    );
    expect(cd.history()[0]).toMatchObject({ challenged60m: 2, lastWindowMin: 180, streak: 1 });
  });

  it('an unnamed-lane challenge inside a live browser window is kept too', () => {
    let t = 1_000_000;
    const cd = new ChallengeCooldown({ now: () => t });
    cd.open(H, 'r', 'browser');
    t += MIN;
    cd.open(H, 'queue challenge');
    expect(cd.remaining(H)).toBe(3 * HOUR - MIN);
    expect(warnLines()).toContainEqual(
      `[COOLDOWN] kept ${H} (179 min left, longer than the 30 min a unnamed challenge opens) (queue challenge)`,
    );
  });

  it('a live 6 h step survives a later http challenge (A1b)', () => {
    let t = 1_000_000;
    const cd = new ChallengeCooldown({ now: () => t });
    for (let i = 0; i < 5; i++) t = cd.open(H, 'r', 'impersonate').until;
    cd.open(H, 'r', 'impersonate');
    t += MIN;
    cd.open(H, 'r', 'http');
    expect(cd.remaining(H)).toBeGreaterThanOrEqual(6 * HOUR - 2 * MIN);
  });

  it('short-lane challenges inside a longer live window leave its end exactly where it was (F2)', () => {
    let t = 1_000_000;
    const cd = new ChallengeCooldown({ now: () => t });
    const end = cd.open('i.test', 'r', 'browser').until;
    for (let i = 0; i < 150; i++) {
      t += MIN;
      cd.open('i.test', 'r', i % 2 ? 'http' : 'impersonate');
    }
    expect(t + cd.remaining('i.test')).toBe(end);
  });

  it('a kept window is not re-persisted (F4)', () => {
    let t = 1_000_000;
    const saves: unknown[] = [];
    const cd = new ChallengeCooldown({ now: () => t, persistence: { saveCooldown: (e) => saves.push(e), removeCooldown: () => {} } });
    cd.open('k.test', 'r', 'browser');
    for (let i = 0; i < 50; i++) {
      t += MIN;
      cd.open('k.test', 'r', 'http');
    }
    expect(saves).toHaveLength(1);
  });

  it('a same-lane re-open inside a live window still re-extends (F3)', () => {
    let t = 1_000_000;
    const cd = new ChallengeCooldown({ now: () => t });
    const end0 = cd.open('b.test', 'r', 'browser').until;
    t += 10 * MIN;
    expect(cd.open('b.test', 'r', 'browser').until - end0).toBe(10 * MIN);
  });

  it('never moves the end earlier, never holds more than 6 h from now, and clears within 6 h once challenges stop (F1)', () => {
    let t = 1_000_000;
    const cd = new ChallengeCooldown({ now: () => t });
    cd.open('h.test', 'r', 'browser');
    const lanes = ['http', 'impersonate', 'browser', undefined] as const;
    for (let i = 0; i < 2000; i++) {
      t += 37_000;
      const before = t + cd.remaining('h.test');
      cd.open('h.test', 'r', lanes[i % 4]);
      const after = t + cd.remaining('h.test');
      expect(after).toBeGreaterThanOrEqual(before);
      expect(after - t).toBeLessThanOrEqual(6 * HOUR);
    }
    t += 6 * HOUR;
    expect(cd.isOpen('h.test')).toBe(false);
  });

  it('two challenges after expiry step once (A3): 60, then 60 again', () => {
    let t = 1_000_000;
    const cd = new ChallengeCooldown({ now: () => t });
    t = cd.open(H, 'r', 'impersonate').until;
    const a = cd.open(H, 'r', 'impersonate');
    const b = cd.open(H, 'r', 'impersonate');
    expect([(a.until - a.openedAt) / MIN, (b.until - b.openedAt) / MIN]).toEqual([60, 60]);
  });

  it('a restart after the window expired resets the streak (A4)', () => {
    let t = 1_000_000;
    const a = new ChallengeCooldown({ now: () => t });
    t = a.open(H, 'r', 'impersonate').until;
    const e60 = a.open(H, 'r', 'impersonate');
    t = e60.until + 1;
    const b = new ChallengeCooldown({ now: () => t });
    expect(b.restore([e60])).toBe(0);
    const next = b.open(H, 'r', 'impersonate');
    expect((next.until - next.openedAt) / MIN).toBe(30);
  });
});
