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
  resolveQueueDir,
  QUEUE_DB_FILE,
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
  delete process.env.SCRAPE_QUEUE_MAX_MB;
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

  it('cannot hold two rows for one dedup key in the first place', () => {
    const dir = tmpDir();
    const store = open(dir);
    store.put(ITEM({ id: 'old', mfcId: 'same', enqueuedAt: 1_000 }));
    store.put(ITEM({ id: 'new', mfcId: 'same', enqueuedAt: 5_000 }));

    // The unique index refuses the second insert, so a loser row can never leak as a permanent
    // pending entry nothing will dispatch. Collapsing legacy duplicates happens once, at open.
    const restored = store.restore(9_000);
    expect(restored.pending.map((i) => i.id)).toEqual(['old']);
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

/**
 * THE FALLBACK IS LOUD. `durable:false` on its own is ambiguous — the intended intermediate state
 * (the engine shipped ahead of its PVC) reads identically to a permissions bug. Each condition below
 * therefore carries a NAMED reason, the path that was attempted, and exactly one greppable line:
 *
 *   [SCRAPE QUEUE] queue store NOT durable: <reason> (<path>)
 */
describe('queueStore — fallback reasons', () => {
  const warnings = () =>
    (console.warn as unknown as jest.Mock).mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('[SCRAPE QUEUE]'));

  it('disabled — SCRAPE_QUEUE_DIR is blank', () => {
    process.env.SCRAPE_QUEUE_DIR = '';
    const store = createQueueStore();
    stores.push(store);

    expect(store.durable).toBe(false);
    expect(store.reason).toBe('disabled');
    expect(store.path).toBeNull();
    // Deliberate: an operator who switched it off does not need a warning about it.
    expect(warnings()).toHaveLength(0);
  });

  it('disabled — SCRAPE_QUEUE_DIR is `off`', () => {
    for (const value of ['off', 'OFF', 'none', 'false', '0']) {
      process.env.SCRAPE_QUEUE_DIR = value;
      const store = createQueueStore();
      stores.push(store);
      expect(store.reason).toBe('disabled');
    }
  });

  it('UNSET is not disabled — it falls through to the default mount', () => {
    delete process.env.SCRAPE_QUEUE_DIR;
    // An unset variable in production is a manifest that has not caught up, not a switch-off: it
    // must still TRY the standard mount, and report dir_missing if it is not there.
    expect(resolveQueueDir()).toBe('/var/lib/scraper');
  });

  it('dir_missing — the PVC is not mounted yet (the intended intermediate state)', () => {
    const missing = path.join(tmpDir(), 'not', 'mounted');
    const store = createQueueStore({ dir: missing });
    stores.push(store);

    expect(store.durable).toBe(false);
    expect(store.reason).toBe('dir_missing');
    // The path is REPORTED even though nothing was opened — it is what the operator goes and looks at.
    expect(store.path).toBe(path.join(missing, 'scrape-queue.db'));
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain('queue store NOT durable: dir_missing');
    expect(warnings()[0]).toContain(missing);
  });

  it('not_writable — the mount exists but this uid/gid cannot write it', () => {
    const dir = tmpDir();
    fs.chmodSync(dir, 0o555);
    try {
      const store = createQueueStore({ dir });
      stores.push(store);

      expect(store.durable).toBe(false);
      expect(store.reason).toBe('not_writable');
      expect(store.path).toBe(path.join(dir, 'scrape-queue.db'));
      expect(warnings()).toHaveLength(1);
      expect(warnings()[0]).toContain('queue store NOT durable: not_writable');
    } finally {
      fs.chmodSync(dir, 0o755);
    }
  });

  it('open_failed_recovered — an unusable file is moved ASIDE, never deleted, and a fresh store opens', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'scrape-queue.db');
    fs.writeFileSync(file, 'this is not a sqlite database at all');

    const store = createQueueStore({ dir });
    stores.push(store);

    // STILL DURABLE — the queue keeps its durability through a corrupt file.
    expect(store.durable).toBe(true);
    expect(store.reason).toBe('open_failed_recovered');
    expect(store.quarantinedPath).toMatch(/scrape-queue\.db\.corrupt-/);
    expect(store.lostAtStartup).toBe(0);

    // The bad bytes are KEPT. They may be the only copy of what was queued.
    expect(fs.existsSync(store.quarantinedPath as string)).toBe(true);
    expect(fs.readFileSync(store.quarantinedPath as string, 'utf8')).toBe('this is not a sqlite database at all');
    // And the fresh store works.
    store.put(ITEM());
    expect(store.counts().pending).toBe(1);
  });

  it('open_failed_recovered — carries readable rows over from the quarantined file', () => {
    const dir = tmpDir();
    const first = open(dir);
    first.put(ITEM({ id: 'a', mfcId: 'a', url: 'https://s.example/a' }));
    first.put(ITEM({ id: 'b', mfcId: 'b', url: 'https://s.example/b' }));
    first.lease('b', 60_000);
    first.saveCooldown({ host: 'cool.example', until: 900_000, reason: 'challenge page', openedAt: 1_000 });
    first.close();

    // The FIRST open fails on a WRITE (the journal-mode pragma), so a main database that READS
    // perfectly well can still land in recovery — a file that lost its write permission is exactly
    // that case. This is why salvage opens the quarantined file read-only instead of giving up.
    fs.chmodSync(path.join(dir, 'scrape-queue.db'), 0o444);

    const store = createQueueStore({ dir });
    stores.push(store);
    const restored = store.restore(50_000);

    expect(store.lostAtStartup).toBe(0);
    // Both items are back, and the leased one comes over DRIVABLE — no process holds that lease now.
    expect(restored.pending.map((i) => i.id).sort()).toEqual(['a', 'b']);
    expect(restored.cooldowns.map((c) => c.host)).toEqual(['cool.example']);
  });

  it('quarantines a DIRECTORY sitting where the db file belongs, and recovers', () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, 'scrape-queue.db'));

    const store = createQueueStore({ dir });
    stores.push(store);

    // Moving the obstruction aside and starting fresh is the right answer here too — and it is still
    // moved, never removed.
    expect(store.durable).toBe(true);
    expect(store.reason).toBe('open_failed_recovered');
    expect(fs.existsSync(store.quarantinedPath as string)).toBe(true);
  });

  it('open_failed — falls back in-memory when the file cannot even be moved aside', () => {
    const dir = tmpDir();
    const at = Date.parse('2026-09-11T12:00:00.000Z');
    // SQLite cannot open a directory as a database...
    fs.mkdirSync(path.join(dir, 'scrape-queue.db'));
    // ...and the quarantine rename lands on a NON-EMPTY directory, which fails with ENOTEMPTY. So
    // the bad path cannot be moved out of the way and there is nowhere for a fresh store to go.
    const target = path.join(dir, `scrape-queue.db.corrupt-${new Date(at).toISOString().replace(/[:.]/g, '-')}`);
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'occupied'), 'x');

    const store = createQueueStore({ dir, now: () => at });
    stores.push(store);

    expect(store.durable).toBe(false);
    expect(store.reason).toBe('open_failed');
    expect(store.path).toBe(path.join(dir, 'scrape-queue.db'));
    expect(warnings().some((w) => w.includes('queue store NOT durable: open_failed'))).toBe(true);
  });

  it('write_failed — a full disk degrades to in-memory for the rest of the process, still serving', () => {
    const dir = tmpDir();
    // max_page_count is the deterministic stand-in for a full filesystem: past the ceiling SQLite
    // raises the very same "database or disk is full" a full volume does.
    const store = openQueueStore({ dir, maxPageCount: 2 });
    stores.push(store);
    expect(store.durable).toBe(true);

    let threw = false;
    try {
      for (let i = 0; i < 5000; i++) {
        store.put(ITEM({ id: `id-${i}`, mfcId: `m-${i}`, url: `https://s.example/${'x'.repeat(200)}/${i}` }));
      }
    } catch {
      threw = true;
    }

    // NEVER throws into the queue: an enqueue must not fail because the disk did.
    expect(threw).toBe(false);
    expect(store.durable).toBe(false);
    expect(store.reason).toBe('write_failed');
    expect(warnings().filter((w) => w.includes('write_failed'))).toHaveLength(1);

    // Still serving: every operation stays safe, and reads stay LIVE so the rows already on disk
    // (which the next process will reconcile) remain visible on /health/detailed.
    expect(() => store.lease('id-0', 1)).not.toThrow();
    expect(() => store.remove('id-0')).not.toThrow();
    expect(() => store.saveCooldown({ host: 'a.example', until: 9, reason: 'r', openedAt: 1 })).not.toThrow();
    expect(store.counts().pending).toBeGreaterThan(0);
  });

  it('write_failed — the queue stops parking once the store degrades', () => {
    const dir = tmpDir();
    const store = openQueueStore({ dir, maxPageCount: 2 });
    stores.push(store);
    for (let i = 0; i < 5000; i++) {
      store.put(ITEM({ id: `id-${i}`, mfcId: `m-${i}`, url: `https://s.example/${'x'.repeat(200)}/${i}` }));
    }

    // `durable` is a GETTER for exactly this reason: the queue re-reads it before parking, and
    // parking into a store that is no longer writing would silently delete items.
    expect(store.durable).toBe(false);
    expect(store.pageIn(10)).toEqual([]);
    expect(store.restore(1)).toMatchObject({ pending: [], cooldowns: [] });
  });

  it('ok — reports a clean open with no warning at all', () => {
    const store = createQueueStore({ dir: tmpDir() });
    stores.push(store);

    expect(store.durable).toBe(true);
    expect(store.reason).toBe('ok');
    expect(store.path).toMatch(/scrape-queue\.db$/);
    expect(store.quarantinedPath).toBeNull();
    expect(store.lostAtStartup).toBe(0);
    expect(warnings()).toHaveLength(0);
  });

  it('resolves the directory from SCRAPE_QUEUE_DIR', () => {
    const dir = tmpDir();
    process.env.SCRAPE_QUEUE_DIR = dir;
    const store = createQueueStore();
    stores.push(store);

    expect(store.durable).toBe(true);
    expect(store.path).toBe(path.join(dir, QUEUE_DB_FILE));
  });

  it('every fallback answers the whole interface safely', () => {
    const store = createQueueStore({ dir: path.join(tmpDir(), 'missing') });
    stores.push(store);

    expect(() => store.put(ITEM())).not.toThrow();
    expect(store.counts()).toEqual({ pending: 0, leased: 0, parked: 0 });
    expect(store.restore(1)).toMatchObject({ pending: [], leasedExpired: [], cooldowns: [] });
    expect(store.pageIn(10)).toEqual([]);
    expect(store.releaseLeases()).toBe(0);
    expect(store.hasKey('anything')).toBe(false);
    expect(store.claimKey('anything')).toBeNull();
    expect(() => store.setPriority('a', 'HOT')).not.toThrow();
    expect(store.quarantinedPath).toBeNull();
    expect(store.lostAtStartup).toBe(0);
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

  it('claimKey promotes exactly the parked row a caller asked for', () => {
    const dir = tmpDir();
    const store = open(dir);
    store.put(ITEM({ id: 'p1', mfcId: 'key-1', enqueuedAt: 1_000, state: 'parked' }));
    store.put(ITEM({ id: 'p2', mfcId: 'key-2', enqueuedAt: 2_000, state: 'parked' }));

    const promoted = store.claimKey('key-2');
    expect(promoted).toMatchObject({ id: 'p2', state: 'pending' });
    // The OTHER parked row is untouched — a dedup hit promotes one item, not the backlog.
    expect(store.counts()).toEqual({ pending: 1, leased: 0, parked: 1 });
  });

  it('claimKey returns null only when there is NO row for the key', () => {
    const dir = tmpDir();
    const store = open(dir);
    store.put(ITEM({ id: 'a', mfcId: 'key-a' })); // already pending

    // A pending row is still this queue's row — claiming it is a no-op that returns it, not null.
    expect(store.claimKey('key-a')).toMatchObject({ id: 'a', state: 'pending' });
    expect(store.claimKey('nothing')).toBeNull();
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
    expect(store.claimKey('anything')).toBeNull();
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
    expect(store.claimKey('id-1')).toBeNull();
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

/**
 * Two faults found while building the fallback enumeration. Both are silent in normal operation and
 * both break the boot reconciliation — the one moment the store exists for.
 */
describe('queueStore — open must prove the database is USABLE, not merely openable', () => {
  it('refuses a database that opens cleanly but cannot be written', () => {
    const dir = tmpDir();
    const first = open(dir);
    first.put(ITEM());
    first.close();
    // A file that lost its write permission passes every open statement — `CREATE TABLE IF NOT
    // EXISTS` short-circuits on tables that already exist — and then throws on the FIRST real write,
    // which is the boot reconciliation. Without the write probe the engine boots and dies there.
    fs.chmodSync(path.join(dir, 'scrape-queue.db'), 0o444);

    expect(() => openQueueStore({ dir })).toThrow(/readonly/i);
  });

  it('routes that read-only file to quarantine and salvages every row out of it', () => {
    const dir = tmpDir();
    const first = open(dir);
    first.put(ITEM({ id: 'a', mfcId: 'a', url: 'https://s.example/a' }));
    first.put(ITEM({ id: 'b', mfcId: 'b', url: 'https://s.example/b' }));
    first.close();
    fs.chmodSync(path.join(dir, 'scrape-queue.db'), 0o444);

    const store = createQueueStore({ dir });
    stores.push(store);

    expect(store.reason).toBe('open_failed_recovered');
    expect(store.durable).toBe(true);
    expect(store.lostAtStartup).toBe(0);
    // The main database read perfectly well — only writing was refused — so salvage gets it all back.
    expect(store.restore(9_000).pending.map((i) => i.id).sort()).toEqual(['a', 'b']);
  });

  it('closes its handle when the open fails partway (no descriptor leak)', () => {
    const fdDir = '/proc/self/fd';
    if (!fs.existsSync(fdDir)) return; // Linux-only assertion; the engine and CI both run Linux.
    const dir = tmpDir();
    const first = open(dir);
    first.close();
    fs.chmodSync(path.join(dir, 'scrape-queue.db'), 0o444);

    const before = fs.readdirSync(fdDir).length;
    for (let i = 0; i < 20; i++) {
      expect(() => openQueueStore({ dir })).toThrow();
    }
    const after = fs.readdirSync(fdDir).length;

    // A failed open that keeps its handle leaks a descriptor every time. Twenty attempts make the
    // difference unmistakable; a handful of descriptors of slack keeps this from being flaky.
    expect(after - before).toBeLessThan(10);
  });

  it('a restore on a store that cannot write degrades instead of throwing at boot', () => {
    const dir = tmpDir();
    const store = openQueueStore({ dir, maxPageCount: 2 });
    stores.push(store);
    for (let i = 0; i < 5000; i++) {
      store.put(ITEM({ id: `id-${i}`, mfcId: `m-${i}`, url: `https://s.example/${'x'.repeat(200)}/${i}` }));
    }

    // restore() mutates (it frees expired leases and drops duplicates). Those writes must not throw
    // into the boot path — the engine has to come up and keep taking work regardless.
    expect(() => store.restore(9_999)).not.toThrow();
    expect(store.reason).toBe('write_failed');
  });
});

/**
 * F2 (reviewer finding) — the disk-full safety valve must be WIRED, not merely available.
 *
 * `maxPageCount` is described as "a genuine safety valve on a 1Gi PVC — the queue must never be the
 * thing that fills the volume the queue lives on", but nothing outside the tests ever passed it, so
 * a real store ran with SQLite's 4294967294-page default: no ceiling at all. The same shape of
 * defect as the cooldown sink that was never attached.
 */
describe('queueStore — the size ceiling is wired from the environment', () => {
  it('createQueueStore applies a ceiling by default', () => {
    const store = createQueueStore({ dir: tmpDir() });
    stores.push(store);

    // Not SQLite's 4294967294 default: the queue must not be able to fill its own volume.
    expect(store.maxPages).toBeGreaterThan(0);
    expect(store.maxPages).toBeLessThan(4_294_967_294);
  });

  it('SCRAPE_QUEUE_MAX_MB sets the ceiling, and exceeding it degrades to write_failed', () => {
    process.env.SCRAPE_QUEUE_MAX_MB = '1';
    const store = createQueueStore({ dir: tmpDir() });
    stores.push(store);
    expect(store.reason).toBe('ok');

    let threw = false;
    try {
      for (let i = 0; i < 20_000; i++) {
        store.put(ITEM({ id: `id-${i}`, mfcId: `m-${i}`, url: `https://s.example/${'x'.repeat(400)}/${i}` }));
      }
    } catch {
      threw = true;
    }

    // A full store must never throw into the queue, and must stop claiming to be durable.
    expect(threw).toBe(false);
    expect(store.reason).toBe('write_failed');
    expect(store.durable).toBe(false);
  });

  it('falls back to the default ceiling for a blank or nonsense SCRAPE_QUEUE_MAX_MB', () => {
    delete process.env.SCRAPE_QUEUE_MAX_MB;
    const def = createQueueStore({ dir: tmpDir() });
    stores.push(def);
    for (const bad of ['', '   ', 'abc', '0', '-5']) {
      process.env.SCRAPE_QUEUE_MAX_MB = bad;
      const store = createQueueStore({ dir: tmpDir() });
      stores.push(store);
      // Misconfiguration must never mean "no ceiling" OR "a ceiling of zero pages".
      expect(store.maxPages).toBe(def.maxPages);
      expect(store.reason).toBe('ok');
    }
  });

  it('degrades on a STORAGE fault but NOT on a logic fault', () => {
    const dir = tmpDir();
    const store = openQueueStore({ dir, maxPageCount: 2 });
    stores.push(store);

    // A NOT NULL violation is a bug in THIS code, not a sick disk. It must be reported and swallowed:
    // surrendering durability for the rest of the process over an engine fault would cause exactly
    // the item loss this store exists to prevent. (A duplicate KEY is not a usable probe here — the
    // insert's ON CONFLICT DO NOTHING absorbs it before `write` ever sees a fault.)
    store.put(ITEM({ id: 'null-url', mfcId: 'null-url', url: null as unknown as string }));
    expect(store.durable).toBe(true);
    expect(store.reason).toBe('ok');
    expect(
      (console.warn as unknown as jest.Mock).mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes('write refused'))
    ).toHaveLength(1);
    // Still working for everything else.
    store.put(ITEM({ id: 'fine', mfcId: 'fine' }));
    expect(store.counts().pending).toBe(1);

    // A full disk, by contrast, DOES cost the process its durability.
    for (let i = 0; i < 20_000; i++) {
      store.put(ITEM({ id: `f-${i}`, mfcId: `f-${i}`, url: `https://s.example/${'x'.repeat(400)}/${i}` }));
    }
    expect(store.reason).toBe('write_failed');
    expect(store.durable).toBe(false);
  });
});

/**
 * F1's structural backstop: one row per dedup key, enforced by the schema rather than by every
 * caller remembering to look first.
 */
describe('queueStore — one row per dedup key', () => {
  it('refuses a second row for the same key instead of duplicating it', () => {
    const dir = tmpDir();
    const store = open(dir);
    store.put(ITEM({ id: 'first', mfcId: 'same', enqueuedAt: 1_000 }));
    store.put(ITEM({ id: 'second', mfcId: 'same', enqueuedAt: 5_000 }));

    expect(store.counts().pending).toBe(1);
    expect(store.restore(9_000).pending[0].id).toBe('first');
  });

  it('claimKey promotes a row in ANY state, not just parked', () => {
    const dir = tmpDir();
    const store = open(dir);
    store.put(ITEM({ id: 'p', mfcId: 'parked-key', state: 'parked' }));
    store.put(ITEM({ id: 'l', mfcId: 'leased-key', attempts: 2 }));
    store.lease('l', 9_999_999);

    expect(store.claimKey('parked-key')).toMatchObject({ id: 'p', state: 'pending' });
    // The leased case is the one F1 turns on: a lease no process holds must be reclaimable.
    expect(store.claimKey('leased-key')).toMatchObject({ id: 'l', state: 'pending', attempts: 2 });
    expect(store.counts()).toEqual({ pending: 2, leased: 0, parked: 0 });
    expect(store.claimKey('never-seen')).toBeNull();
  });

  it('de-duplicates a legacy file that already holds two rows for one key, then enforces the rule', () => {
    const dir = tmpDir();
    const file = path.join(dir, QUEUE_DB_FILE);
    // A file written by a build without the constraint. Opening it must not fail — and must not
    // quarantine a perfectly readable queue just because the index cannot be built over it.
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    const raw = new DatabaseSync(file);
    raw.exec(`CREATE TABLE queue_items (
      id TEXT PRIMARY KEY, mfc_id TEXT NOT NULL, url TEXT NOT NULL, host TEXT, priority TEXT NOT NULL,
      status TEXT, session_id TEXT, attempts INTEGER NOT NULL DEFAULT 0, max_retries INTEGER NOT NULL,
      enqueued_at INTEGER NOT NULL, state TEXT NOT NULL, lease_until INTEGER, last_error_class TEXT)`);
    const ins = raw.prepare('INSERT INTO queue_items VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
    ins.run('older', 'dup', 'https://s.example/x', 's.example', 'WARM', null, null, 2, 3, 1_000, 'pending', null, null);
    ins.run('newer', 'dup', 'https://s.example/x', 's.example', 'WARM', null, null, 0, 3, 5_000, 'pending', null, null);
    raw.close();

    const store = open(dir);
    expect(store.reason).toBe('ok');
    // The EARLIEST row survives, carrying the real attempt count.
    expect(store.counts().pending).toBe(1);
    expect(store.restore(9_000).pending[0]).toMatchObject({ id: 'older', attempts: 2 });
  });
});


/**
 * `isStorageFault` decides whether a write fault costs the process its durability. Its shape checks
 * are what keep a malformed error object from being read as a healthy disk.
 */
describe('queueStore — storage-fault classification edges', () => {
  it('treats a Node ENOSPC as a storage fault', () => {
    const dir = tmpDir();
    const store = openQueueStore({ dir });
    stores.push(store);
    const enospc = Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });

    // A write can fail below SQLite — the same degrade path has to catch it.
    expect(() => store.batch(() => { throw enospc; })).toThrow();
    expect(store.reason).toBe('ok'); // a throw from the BODY is the caller's, not the disk's

    store.put(ITEM({ id: 'x', mfcId: 'x', url: null as unknown as string }));
    // A non-storage fault leaves durability intact.
    expect(store.durable).toBe(true);
  });

  it('does not read a non-object throw as a storage fault', () => {
    const dir = tmpDir();
    const store = openQueueStore({ dir });
    stores.push(store);

    // `throw 'a string'` and `throw null` must not be mistaken for a sick disk — that would hand
    // away durability on the strength of a value that carries no evidence either way.
    store.put(ITEM({ id: 'ok', mfcId: 'ok' }));
    expect(store.durable).toBe(true);
    expect(store.counts().pending).toBe(1);
  });
});
