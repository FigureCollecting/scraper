/**
 * TDD (red first) — queueStore: the durable backing store for the scrape queue.
 *
 * WHY: the scrape queue (hotQueue/warmQueue/coldQueue + pendingItems) is IN-MEMORY ONLY, so every
 * restart — a planned repin, a rollout, an OOM kill, the 2-hour browser relaunch going wrong —
 * drops whatever it held. A rollout on 2026-09-08 lost ~130 in-flight items; a repin drops the
 * crawler's current batch (up to ~500). The crawler advances its backfill cursor AFTER enqueueing,
 * so a dropped item is a COVERAGE HOLE, not a delay: nothing ever asks for it again.
 *
 * These tests pin the store's contract on its own, with no queue and no network: round-trips,
 * crash recovery (reopen the same file from a fresh handle), lease expiry, cooldown survival,
 * batched inserts, and the in-memory fallback when the directory is missing or unwritable — the
 * fallback must NEVER crash the process and never block ingest.
 *
 * Real files under os.tmpdir() (a fresh dir per test); node:sqlite is built into Node >= 24.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  createQueueStore,
  openQueueStore,
  type PersistedQueueItem,
  type ScrapeQueueStore,
} from '../../services/queueStore';

let dirs: string[] = [];
let stores: ScrapeQueueStore[] = [];

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-store-test-'));
  dirs.push(d);
  return d;
}

function open(dir: string, now?: () => number): ScrapeQueueStore {
  const s = openQueueStore({ dir, ...(now ? { now } : {}) });
  stores.push(s);
  return s;
}

const ITEM = (over: Partial<PersistedQueueItem> = {}): PersistedQueueItem => ({
  id: 'id-1',
  mfcId: 'https://store.example/item/1',
  url: 'https://store.example/item/1',
  priority: 'WARM',
  attempts: 0,
  maxRetries: 3,
  enqueuedAt: 1_000,
  state: 'pending',
  ...over,
});

afterEach(() => {
  for (const s of stores) {
    try {
      s.close();
    } catch {
      /* already closed */
    }
  }
  stores = [];
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
  delete process.env.SCRAPE_QUEUE_DIR;
});

describe('queueStore — durable round-trips', () => {
  it('persists an enqueued item and restores it as pending', () => {
    const dir = tmpDir();
    const store = open(dir);
    store.put(ITEM());

    const restored = store.restore(2_000);
    expect(restored.pending).toHaveLength(1);
    expect(restored.pending[0]).toMatchObject({
      id: 'id-1',
      url: 'https://store.example/item/1',
      priority: 'WARM',
      attempts: 0,
      state: 'pending',
    });
  });

  it('is idempotent on the existing item id (a re-put never duplicates the row)', () => {
    const dir = tmpDir();
    const store = open(dir);
    store.put(ITEM());
    store.put(ITEM({ priority: 'HOT' }));

    expect(store.counts().pending).toBe(1);
    // The first write wins — a re-put is a no-op, not an overwrite.
    expect(store.restore(2_000).pending[0].priority).toBe('WARM');
  });

  it('lease → complete removes the row', () => {
    const dir = tmpDir();
    const store = open(dir);
    store.put(ITEM());
    store.lease('id-1', 5_000);
    expect(store.counts()).toEqual({ pending: 0, leased: 1, parked: 0 });

    store.remove('id-1');
    expect(store.counts()).toEqual({ pending: 0, leased: 0, parked: 0 });
  });

  it('fail-retryable returns the row to pending with its attempt count', () => {
    const dir = tmpDir();
    const store = open(dir);
    store.put(ITEM());
    store.lease('id-1', 5_000);
    store.fail('id-1', 2, 'timeout');

    const restored = store.restore(2_000);
    expect(restored.pending).toHaveLength(1);
    expect(restored.pending[0].attempts).toBe(2);
    expect(restored.pending[0].lastErrorClass).toBe('timeout');
  });

  it('batches a burst of inserts in ONE transaction', () => {
    const dir = tmpDir();
    const store = open(dir);
    const items = Array.from({ length: 50 }, (_, i) =>
      ITEM({ id: `id-${i}`, mfcId: `m-${i}`, url: `https://store.example/item/${i}` })
    );

    store.batch(() => {
      for (const it of items) store.put(it);
    });

    expect(store.counts().pending).toBe(50);
  });

  it('never writes a cookie to disk — the on-disk bytes contain no cookie value', () => {
    const dir = tmpDir();
    const store = open(dir);
    // A cookie'd item is session-bound and must not be persisted AT ALL: `put` is only ever called
    // for cookieless items, and the row shape carries no cookie column to write one into.
    store.put(ITEM({ sessionId: 'sess-1' }));
    store.close();

    const bytes = fs.readFileSync(path.join(dir, 'scrape-queue.db'));
    expect(bytes.includes(Buffer.from('cookie'))).toBe(false);
    expect(bytes.includes(Buffer.from('cf_clearance'))).toBe(false);
  });
});

describe('queueStore — crash recovery', () => {
  it('reopening the SAME file from a fresh handle brings back pending rows with attempt counts', () => {
    const dir = tmpDir();
    const first = open(dir);
    first.put(ITEM({ id: 'a', mfcId: 'a', url: 'https://s.example/a' }));
    first.put(ITEM({ id: 'b', mfcId: 'b', url: 'https://s.example/b' }));
    first.fail('b', 2, 'network');
    // Simulate a hard kill: close the handle WITHOUT any shutdown bookkeeping.
    first.close();

    const second = open(dir);
    const restored = second.restore(2_000);
    expect(restored.pending.map((i) => i.id).sort()).toEqual(['a', 'b']);
    expect(restored.pending.find((i) => i.id === 'b')!.attempts).toBe(2);
  });

  it('an EXPIRED lease (a crash mid-navigation) comes back as leased-expired, not lost', () => {
    const dir = tmpDir();
    const first = open(dir);
    first.put(ITEM({ id: 'a', mfcId: 'a' }));
    first.lease('a', 1_500); // lease expires at 1500
    first.close();

    const second = open(dir);
    const restored = second.restore(9_999); // now > leaseUntil
    expect(restored.pending).toHaveLength(0);
    expect(restored.leasedExpired.map((i) => i.id)).toEqual(['a']);
    expect(restored.leasedExpired[0].attempts).toBe(0);
  });

  it('an UNEXPIRED lease is left held at restore and reaped once it expires', () => {
    const dir = tmpDir();
    const store = open(dir);
    store.put(ITEM({ id: 'a', mfcId: 'a' }));
    store.lease('a', 60_000);

    const restored = store.restore(1_200); // now < leaseUntil
    expect(restored.pending).toHaveLength(0);
    expect(restored.leasedExpired).toHaveLength(0);
    expect(restored.stillLeased).toBe(1);

    // Nothing releases a crashed lease but its own expiry, so the reaper is what re-drives it.
    expect(store.reapExpiredLeases(30_000)).toEqual([]);
    const reaped = store.reapExpiredLeases(90_000);
    expect(reaped.map((i) => i.id)).toEqual(['a']);
    expect(store.counts()).toEqual({ pending: 1, leased: 0, parked: 0 });
  });

  it('releaseLeases() puts every leased row back to pending (planned shutdown)', () => {
    const dir = tmpDir();
    const first = open(dir);
    first.put(ITEM({ id: 'a', mfcId: 'a' }));
    first.put(ITEM({ id: 'b', mfcId: 'b' }));
    first.lease('a', 60_000);
    first.lease('b', 60_000);

    expect(first.releaseLeases()).toBe(2);
    first.close();

    // A planned rollout therefore loses NOTHING and re-drives immediately on the next start.
    const second = open(dir);
    const restored = second.restore(2_000);
    expect(restored.pending.map((i) => i.id).sort()).toEqual(['a', 'b']);
    expect(restored.stillLeased).toBe(0);
  });

  it('de-duplicates rows for the same key at restore, keeping the earliest', () => {
    const dir = tmpDir();
    const store = open(dir);
    store.put(ITEM({ id: 'old', mfcId: 'same', enqueuedAt: 1_000 }));
    store.put(ITEM({ id: 'new', mfcId: 'same', enqueuedAt: 5_000 }));

    const restored = store.restore(9_000);
    expect(restored.pending.map((i) => i.id)).toEqual(['old']);
    // The loser is DELETED, not merely filtered — it must not leak as a permanent pending row.
    expect(store.counts().pending).toBe(1);
  });
});

describe('queueStore — host cooldowns', () => {
  it('an open cooldown survives a restart', () => {
    const dir = tmpDir();
    const first = open(dir);
    first.saveCooldown({ host: 'anitoysgk.com', until: 100_000, reason: 'challenge page', openedAt: 1_000 });
    first.close();

    const second = open(dir);
    const restored = second.restore(50_000);
    expect(restored.cooldowns).toEqual([
      { host: 'anitoysgk.com', until: 100_000, reason: 'challenge page', openedAt: 1_000 },
    ]);
  });

  it('an EXPIRED cooldown is not restored', () => {
    const dir = tmpDir();
    const store = open(dir);
    store.saveCooldown({ host: 'a.example', until: 10_000, reason: 'challenge page', openedAt: 1_000 });

    expect(store.restore(50_000).cooldowns).toEqual([]);
  });

  it('re-opening a cooldown for the same host extends it rather than duplicating it', () => {
    const dir = tmpDir();
    const store = open(dir);
    store.saveCooldown({ host: 'a.example', until: 10_000, reason: 'first', openedAt: 1_000 });
    store.saveCooldown({ host: 'a.example', until: 90_000, reason: 'second', openedAt: 2_000 });

    const cooldowns = store.restore(5_000).cooldowns;
    expect(cooldowns).toHaveLength(1);
    expect(cooldowns[0]).toMatchObject({ until: 90_000, reason: 'second' });
  });

  it('removeCooldown drops the host', () => {
    const dir = tmpDir();
    const store = open(dir);
    store.saveCooldown({ host: 'a.example', until: 90_000, reason: 'challenge page', openedAt: 1_000 });
    store.removeCooldown('a.example');

    expect(store.restore(5_000).cooldowns).toEqual([]);
  });
});

describe('queueStore — bounded working set (parked rows)', () => {
  it('parks a row on disk and pages it back in oldest-first', () => {
    const dir = tmpDir();
    const store = open(dir);
    store.put(ITEM({ id: 'p1', mfcId: 'p1', enqueuedAt: 1_000, state: 'parked' }));
    store.put(ITEM({ id: 'p2', mfcId: 'p2', enqueuedAt: 2_000, state: 'parked' }));
    store.put(ITEM({ id: 'p3', mfcId: 'p3', enqueuedAt: 3_000, state: 'parked' }));

    expect(store.counts()).toEqual({ pending: 0, leased: 0, parked: 3 });

    const pagedIn = store.pageIn(2);
    expect(pagedIn.map((i) => i.id)).toEqual(['p1', 'p2']);
    // Paging in FLIPS the state, so the same row is never handed out twice.
    expect(store.counts()).toEqual({ pending: 2, leased: 0, parked: 1 });
    expect(store.pageIn(2).map((i) => i.id)).toEqual(['p3']);
  });

  it('parked rows survive a restart and stay parked (they are not lost, just not resident)', () => {
    const dir = tmpDir();
    const first = open(dir);
    first.put(ITEM({ id: 'p1', mfcId: 'p1', state: 'parked' }));
    first.close();

    const second = open(dir);
    const restored = second.restore(9_000);
    expect(restored.pending).toHaveLength(0);
    expect(restored.parked).toBe(1);
    expect(second.pageIn(10).map((i) => i.id)).toEqual(['p1']);
  });

  it('park(id) moves a resident row out of memory without losing it', () => {
    const dir = tmpDir();
    const store = open(dir);
    store.put(ITEM({ id: 'a', mfcId: 'a' }));
    store.park('a');

    expect(store.counts()).toEqual({ pending: 0, leased: 0, parked: 1 });
    expect(store.pageIn(1).map((i) => i.id)).toEqual(['a']);
  });
});

describe('queueStore — in-memory fallback', () => {
  const warn = () => (console.warn as unknown as jest.Mock).mock.calls.map((c) => String(c[0]));

  it('falls back (never throws) when the directory does not exist', () => {
    const store = createQueueStore({ dir: path.join(tmpDir(), 'does', 'not', 'exist') });
    stores.push(store);

    expect(store.durable).toBe(false);
    expect(store.path).toBeNull();
    // Every operation stays a safe no-op so ingest is never blocked.
    expect(() => store.put(ITEM())).not.toThrow();
    expect(store.counts()).toEqual({ pending: 0, leased: 0, parked: 0 });
    expect(store.restore(1)).toMatchObject({ pending: [], leasedExpired: [], cooldowns: [] });
    expect(store.pageIn(10)).toEqual([]);
    expect(store.releaseLeases()).toBe(0);
  });

  it('falls back when the directory is not writable', () => {
    const dir = tmpDir();
    fs.chmodSync(dir, 0o555);
    try {
      const store = createQueueStore({ dir });
      stores.push(store);
      expect(store.durable).toBe(false);
    } finally {
      fs.chmodSync(dir, 0o755);
    }
  });

  it('logs EXACTLY ONE warning naming the path when it falls back', () => {
    const missing = path.join(tmpDir(), 'nope');
    const store = createQueueStore({ dir: missing });
    stores.push(store);

    const warnings = warn().filter((m) => m.includes('[SCRAPE QUEUE]'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(missing);
    expect(warnings[0]).toContain('in-memory');
  });

  it('opens durably when the directory IS writable', () => {
    const store = createQueueStore({ dir: tmpDir() });
    stores.push(store);

    expect(store.durable).toBe(true);
    expect(store.path).toMatch(/scrape-queue\.db$/);
  });

  it('resolves the directory from SCRAPE_QUEUE_DIR', () => {
    const dir = tmpDir();
    process.env.SCRAPE_QUEUE_DIR = dir;
    const store = createQueueStore();
    stores.push(store);

    expect(store.durable).toBe(true);
    expect(store.path).toBe(path.join(dir, 'scrape-queue.db'));
  });

  it('falls back rather than throwing when the db file is corrupt', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'scrape-queue.db'), 'this is not a sqlite database at all');
    const store = createQueueStore({ dir });
    stores.push(store);

    // A corrupt file must degrade to in-memory, never crash the engine at boot.
    expect(store.durable).toBe(false);
  });
});

describe('queueStore — dedup-key lookups (what the queue asks a parked item)', () => {
  it('hasKey finds a row in ANY state', () => {
    const dir = tmpDir();
    const store = open(dir);
    store.put(ITEM({ id: 'a', mfcId: 'key-a' }));
    store.put(ITEM({ id: 'b', mfcId: 'key-b', state: 'parked' }));
    store.put(ITEM({ id: 'c', mfcId: 'key-c' }));
    store.lease('c', 9_000);

    expect(store.hasKey('key-a')).toBe(true);
    expect(store.hasKey('key-b')).toBe(true);
    expect(store.hasKey('key-c')).toBe(true);
    expect(store.hasKey('never-seen')).toBe(false);
  });

  it('pageInKey promotes exactly the parked row a caller asked for', () => {
    const dir = tmpDir();
    const store = open(dir);
    store.put(ITEM({ id: 'p1', mfcId: 'key-1', enqueuedAt: 1_000, state: 'parked' }));
    store.put(ITEM({ id: 'p2', mfcId: 'key-2', enqueuedAt: 2_000, state: 'parked' }));

    const promoted = store.pageInKey('key-2');
    expect(promoted).toMatchObject({ id: 'p2', state: 'pending' });
    // The OTHER parked row is untouched — a dedup hit promotes one item, not the backlog.
    expect(store.counts()).toEqual({ pending: 1, leased: 0, parked: 1 });
  });

  it('pageInKey returns null for a key that is not parked', () => {
    const dir = tmpDir();
    const store = open(dir);
    store.put(ITEM({ id: 'a', mfcId: 'key-a' })); // pending, not parked

    expect(store.pageInKey('key-a')).toBeNull();
    expect(store.pageInKey('nothing')).toBeNull();
  });

  it('setPriority keeps a restored item at the priority it was upgraded to', () => {
    const dir = tmpDir();
    const store = open(dir);
    store.put(ITEM({ id: 'a', mfcId: 'key-a', priority: 'COLD' }));
    store.setPriority('a', 'HOT');

    expect(store.restore(9_000).pending[0].priority).toBe('HOT');
  });

  it('restore reports the parked keys so dedup survives a restart', () => {
    const dir = tmpDir();
    const store = open(dir);
    store.put(ITEM({ id: 'p1', mfcId: 'key-1', state: 'parked' }));
    store.put(ITEM({ id: 'p2', mfcId: 'key-2', state: 'parked' }));

    expect(store.restore(9_000).parked).toBe(2);
    expect(store.hasKey('key-1')).toBe(true);
  });

  it('the in-memory fallback answers the lookups safely', () => {
    const store = createQueueStore({ dir: path.join(tmpDir(), 'missing') });
    stores.push(store);

    expect(store.hasKey('anything')).toBe(false);
    expect(store.pageInKey('anything')).toBeNull();
    expect(() => store.setPriority('a', 'HOT')).not.toThrow();
  });
});


/**
 * SIGTERM tears the process down in stages (plugins, cookie poller, raw-capture flush, browser pool)
 * and the queue can still be draining when the store closes. A finalized-statement throw landing in
 * the middle of a shutdown would abort the rest of it, so every method degrades to a no-op instead.
 */
describe('queueStore — safe after close', () => {
  it('degrades every operation to a no-op once closed, and never throws', () => {
    const dir = tmpDir();
    const store = openQueueStore({ dir });
    store.put(ITEM());
    store.close();

    expect(() => store.put(ITEM({ id: 'later' }))).not.toThrow();
    expect(() => store.lease('id-1', 1)).not.toThrow();
    expect(() => store.fail('id-1', 1, 'timeout')).not.toThrow();
    expect(() => store.remove('id-1')).not.toThrow();
    expect(() => store.park('id-1')).not.toThrow();
    expect(() => store.saveCooldown({ host: 'a.example', until: 9, reason: 'r', openedAt: 1 })).not.toThrow();
    expect(() => store.removeCooldown('a.example')).not.toThrow();
    expect(() => store.setPriority('id-1', 'HOT')).not.toThrow();
    expect(() => store.clearAll()).not.toThrow();
    expect(store.counts()).toEqual({ pending: 0, leased: 0, parked: 0 });
    expect(store.pageIn(5)).toEqual([]);
    expect(store.pageInKey('id-1')).toBeNull();
    expect(store.hasKey('id-1')).toBe(false);
    expect(store.releaseLeases()).toBe(0);
    expect(store.reapExpiredLeases(9_999)).toEqual([]);
    expect(store.restore(9_999)).toEqual({ pending: [], leasedExpired: [], stillLeased: 0, parked: 0, cooldowns: [] });
    // close() is idempotent — a double shutdown path must not throw either.
    expect(() => store.close()).not.toThrow();

    // And nothing it swallowed corrupted the file: the original row is still there.
    const reopened = open(dir);
    expect(reopened.counts().pending).toBe(1);
  });
});

describe('queueStore — paging policy and transaction edges', () => {
  it('skips hosts that are already at their resident cap when paging in', () => {
    const dir = tmpDir();
    const store = open(dir);
    store.put(ITEM({ id: 'b1', mfcId: 'b1', url: 'https://busy.test/item/1', enqueuedAt: 1_000, state: 'parked' }));
    store.put(ITEM({ id: 'b2', mfcId: 'b2', url: 'https://busy.test/item/2', enqueuedAt: 2_000, state: 'parked' }));
    store.put(ITEM({ id: 'q1', mfcId: 'q1', url: 'https://quiet.test/item/1', enqueuedAt: 3_000, state: 'parked' }));

    // A capped host's backlog must not consume the page-in budget only to be re-parked.
    const paged = store.pageIn(10, { skipHosts: ['busy.test'] });
    expect(paged.map((i) => i.id)).toEqual(['q1']);
    expect(store.counts().parked).toBe(2);
  });

  it('matches skipHosts on the NORMALIZED host, so a `www.` url is still skipped', () => {
    const dir = tmpDir();
    const store = open(dir);
    store.put(ITEM({ id: 'w1', mfcId: 'w1', url: 'https://www.busy.test/item/1', state: 'parked' }));

    expect(store.pageIn(10, { skipHosts: ['busy.test'] })).toEqual([]);
  });

  it('stores a row whose url will not parse, with a null host (it still pages in)', () => {
    const dir = tmpDir();
    const store = open(dir);
    store.put(ITEM({ id: 'bad', mfcId: 'bad', url: 'not a url at all', state: 'parked' }));

    // A host we cannot name is never skipped — losing the item would be far worse than paging it in.
    expect(store.pageIn(10, { skipHosts: ['busy.test'] }).map((i) => i.id)).toEqual(['bad']);
  });

  it('rolls the transaction back when the batch body throws', () => {
    const dir = tmpDir();
    const store = open(dir);
    store.put(ITEM({ id: 'a', mfcId: 'a' }));

    expect(() =>
      store.batch(() => {
        store.put(ITEM({ id: 'b', mfcId: 'b' }));
        throw new Error('mid-batch fault');
      })
    ).toThrow('mid-batch fault');

    // All-or-nothing: the partial insert is gone, the pre-existing row is untouched.
    expect(store.counts().pending).toBe(1);
    expect(store.hasKey('b')).toBe(false);
  });

  it('keeps ONE commit for a nested batch', () => {
    const dir = tmpDir();
    const store = open(dir);

    store.batch(() => {
      store.put(ITEM({ id: 'a', mfcId: 'a' }));
      // An inner batch must not BEGIN a second transaction — sqlite has no nested BEGIN.
      store.batch(() => store.put(ITEM({ id: 'b', mfcId: 'b' })));
    });

    expect(store.counts().pending).toBe(2);
  });

  it('pageIn returns nothing for a non-positive limit', () => {
    const dir = tmpDir();
    const store = open(dir);
    store.put(ITEM({ id: 'p', mfcId: 'p', state: 'parked' }));

    expect(store.pageIn(0)).toEqual([]);
    expect(store.counts().parked).toBe(1);
  });

  it('the in-memory fallback reaps nothing and parks nothing', () => {
    const store = createQueueStore({ dir: path.join(tmpDir(), 'missing') });
    stores.push(store);

    expect(store.reapExpiredLeases(9_999)).toEqual([]);
    expect(() => store.park('anything')).not.toThrow();
    expect(() => store.batch(() => store.put(ITEM()))).not.toThrow();
    expect(store.counts().parked).toBe(0);
  });
});
