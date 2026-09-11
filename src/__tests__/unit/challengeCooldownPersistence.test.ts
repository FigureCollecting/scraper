/**
 * TDD (red first) — ChallengeCooldown durability.
 *
 * WHY: a cooldown is opened precisely because a host must be LEFT ALONE — every failed challenge
 * fetch from our egress IP degrades that IP's reputation with Cloudflare Bot Management (the live
 * 2026-08-31 anitoysgk incident). The register is in-memory, so a restart inside the 30-minute
 * window forgets it and the engine walks straight back into the challenge it just backed off from.
 * A restart is exactly when that is most likely: the crawler's batch is re-driven all at once.
 *
 * These tests pin: an opened cooldown is written through; a cleared one is removed; the register
 * can be REHYDRATED from persisted entries; an expired entry is not rehydrated; and a persistence
 * fault never breaks the cooldown itself (it is bookkeeping, not the decision).
 */
import {
  ChallengeCooldown,
  type CooldownEntry,
  type CooldownPersistence,
} from '../../services/challengeCooldown';

function recorder(): CooldownPersistence & { saved: CooldownEntry[]; removed: string[] } {
  const saved: CooldownEntry[] = [];
  const removed: string[] = [];
  return {
    saved,
    removed,
    saveCooldown: (e) => {
      saved.push({ ...e });
    },
    removeCooldown: (h) => {
      removed.push(h);
    },
  };
}

describe('ChallengeCooldown — persistence write-through', () => {
  it('writes an opened cooldown through to the store', () => {
    const persistence = recorder();
    const cd = new ChallengeCooldown({ now: () => 1_000, windowMs: 600_000, persistence });

    cd.open('www.Anitoysgk.com', 'challenge page');

    expect(persistence.saved).toEqual([
      { host: 'anitoysgk.com', until: 601_000, reason: 'challenge page', openedAt: 1_000 },
    ]);
  });

  it('removes a cleared cooldown from the store', () => {
    const persistence = recorder();
    const cd = new ChallengeCooldown({ now: () => 1_000, persistence });
    cd.open('a.example', 'challenge page');

    expect(cd.clear('a.example')).toBe(true);
    expect(persistence.removed).toEqual(['a.example']);
  });

  it('does not touch the store when clear() removes nothing', () => {
    const persistence = recorder();
    const cd = new ChallengeCooldown({ now: () => 1_000, persistence });

    expect(cd.clear('never-opened.example')).toBe(false);
    expect(persistence.removed).toEqual([]);
  });

  it('a throwing store never breaks the cooldown — the decision is not bookkeeping', () => {
    const cd = new ChallengeCooldown({
      now: () => 1_000,
      windowMs: 600_000,
      persistence: {
        saveCooldown: () => {
          throw new Error('disk full');
        },
        removeCooldown: () => {
          throw new Error('disk full');
        },
      },
    });

    expect(() => cd.open('a.example', 'challenge page')).not.toThrow();
    // The host is STILL cooling: a failed write must not re-open a host to traffic.
    expect(cd.isOpen('a.example')).toBe(true);
    expect(() => cd.clear('a.example')).not.toThrow();
  });
});

describe('ChallengeCooldown — rehydration', () => {
  it('restores unexpired entries so a restart does not hammer a cooling host', () => {
    let now = 50_000;
    const cd = new ChallengeCooldown({ now: () => now });

    const loaded = cd.restore([
      { host: 'anitoysgk.com', until: 100_000, reason: 'challenge page', openedAt: 1_000 },
      { host: 'surugaya.jp', until: 900_000, reason: 'search challenge page', openedAt: 2_000 },
    ]);

    expect(loaded).toBe(2);
    expect(cd.isOpen('anitoysgk.com')).toBe(true);
    expect(cd.remaining('anitoysgk.com')).toBe(50_000);
    expect(cd.list().map((c) => c.host).sort()).toEqual(['anitoysgk.com', 'surugaya.jp']);

    now = 150_000;
    expect(cd.isOpen('anitoysgk.com')).toBe(false);
    expect(cd.isOpen('surugaya.jp')).toBe(true);
  });

  it('skips an entry that already expired', () => {
    const cd = new ChallengeCooldown({ now: () => 500_000 });

    expect(cd.restore([{ host: 'a.example', until: 100_000, reason: 'stale', openedAt: 1_000 }])).toBe(0);
    expect(cd.isOpen('a.example')).toBe(false);
  });

  it('does NOT write restored entries back through the store', () => {
    const persistence = recorder();
    const cd = new ChallengeCooldown({ now: () => 1_000, persistence });

    cd.restore([{ host: 'a.example', until: 900_000, reason: 'challenge page', openedAt: 500 }]);

    // Rehydration is a read, not an event: re-persisting would rewrite openedAt on every boot.
    expect(persistence.saved).toEqual([]);
  });

  it('normalizes the host key on restore, so a stored `www.` form still matches', () => {
    const cd = new ChallengeCooldown({ now: () => 1_000 });
    cd.restore([{ host: 'WWW.A.example', until: 900_000, reason: 'challenge page', openedAt: 500 }]);

    expect(cd.isOpen('a.example')).toBe(true);
  });
});
