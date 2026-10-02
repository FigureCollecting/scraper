/**
 * TDD (red first) — QB-U1: a durable lane per queue item, and a real schema record.
 *
 * WHY: Ross (2026-09-29) splits MFC work into classes (new, company, gap; 'other' = no lane). The
 * class must survive a restart like everything else on the row, so `queue_items` gains a nullable
 * `lane` column. Adding a column to a file that already exists is the first schema change this store
 * has ever had, so it also needs a real record of applied steps: `schema_meta`. `PRAGMA user_version`
 * is NOT that record — it is the writability probe, rewritten on every open, and stays exactly so.
 *
 * Every step is gated by a PRESENCE check (`PRAGMA table_info`), never by a number, so:
 *   - a file written by today's build opens with no quarantine and its rows read lane null;
 *   - an older build can open the upgraded file (its INSERTs name their columns, so they leave lane
 *     NULL) and the new build re-opens it as a no-op, never a "duplicate column" throw into quarantine.
 *
 * The v1 statements below are FROZEN copies of today's open (upstream/develop 26c145a), not imports:
 * the point is to replay what an older binary does to the file, whatever this source becomes.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import {
  createMemoryQueueStore,
  createQueueStore,
  openQueueStore,
  QUEUE_DB_FILE,
  type PersistedQueueItem,
  type ScrapeQueueStore,
} from '../../services/queueStore';

// ---------------------------------------------------------------------------------------------
// The v1 (pre-lane) open, frozen.
// ---------------------------------------------------------------------------------------------
const V1_SCHEMA = `
CREATE TABLE IF NOT EXISTS queue_items (
  id               TEXT PRIMARY KEY,
  mfc_id           TEXT NOT NULL,
  url              TEXT NOT NULL,
  host             TEXT,
  priority         TEXT NOT NULL,
  status           TEXT,
  session_id       TEXT,
  attempts         INTEGER NOT NULL DEFAULT 0,
  max_retries      INTEGER NOT NULL,
  enqueued_at      INTEGER NOT NULL,
  state            TEXT NOT NULL,
  lease_until      INTEGER,
  last_error_class TEXT
);
CREATE INDEX IF NOT EXISTS idx_queue_state ON queue_items(state, enqueued_at);
CREATE TABLE IF NOT EXISTS host_cooldowns (
  host      TEXT PRIMARY KEY,
  until     INTEGER NOT NULL,
  reason    TEXT NOT NULL,
  opened_at INTEGER NOT NULL
);
`;
const V1_DEDUP_KEY_CONSTRAINT = `
DELETE FROM queue_items WHERE id NOT IN (
  SELECT id FROM (SELECT id, MIN(enqueued_at) FROM queue_items GROUP BY mfc_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_mfc_unique ON queue_items(mfc_id);
`;
const V1_PUT = `INSERT INTO queue_items
  (id, mfc_id, url, host, priority, status, session_id, attempts, max_retries, enqueued_at, state, lease_until, last_error_class)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT DO NOTHING`;

/** Replays today's openQueueStore against `file`, statement for statement. */
function v1Open(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(V1_SCHEMA);
  db.exec(V1_DEDUP_KEY_CONSTRAINT);
  db.prepare('SELECT COUNT(*) AS n FROM queue_items').get();
  db.exec('PRAGMA user_version = 1');
  db.exec('PRAGMA max_page_count = 65536');
  return db;
}

/** Today's put(), which names its columns — so it leaves a column it does not know NULL. */
function v1Put(db: DatabaseSync, id: string, url: string, state = 'pending', leaseUntil: number | null = null): void {
  const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  db.prepare(V1_PUT).run(id, id, url, host, 'WARM', null, null, 0, 3, 1_000, state, leaseUntil, null);
}

// ---------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------
let dirs: string[] = [];
let stores: ScrapeQueueStore[] = [];

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-store-lane-'));
  dirs.push(d);
  return d;
}

function open(dir: string, now?: () => number): ScrapeQueueStore {
  const s = openQueueStore({ dir, ...(now ? { now } : {}) });
  stores.push(s);
  return s;
}

/** A read-only look at the file, so assertions never write to what they inspect. */
function inspect<T>(dir: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path.join(dir, QUEUE_DB_FILE), { readOnly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

const columnsOf = (db: DatabaseSync, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>).map((c) => c.name);

const metaRows = (db: DatabaseSync) =>
  db.prepare('SELECT key, value, applied_at FROM schema_meta ORDER BY key').all() as unknown as Array<{
    key: string;
    value: string;
    applied_at: number;
  }>;

const laneOnDisk = (db: DatabaseSync, id: string): unknown =>
  (db.prepare('SELECT lane FROM queue_items WHERE id = ?').get(id) as unknown as { lane: unknown }).lane;

const ITEM = (over: Partial<PersistedQueueItem> = {}): PersistedQueueItem => ({
  id: 'id-1',
  mfcId: 'k-1',
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
  for (const d of dirs) {
    try {
      fs.chmodSync(d, 0o755);
    } catch {
      /* gone */
    }
    fs.rmSync(d, { recursive: true, force: true });
  }
  dirs = [];
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------
// (a) a fresh store
// ---------------------------------------------------------------------------------------------
describe('queueStore lane — (a) a fresh store has the lane column and a schema_meta record', () => {
  it('adds a nullable lane column to queue_items', () => {
    const dir = tmpDir();
    open(dir).close();

    const info = inspect(dir, (db) =>
      (db.prepare('PRAGMA table_info(queue_items)').all() as unknown as Array<{ name: string; type: string; notnull: number }>).find(
        (c) => c.name === 'lane'
      )
    );
    expect(info).toMatchObject({ name: 'lane', type: 'TEXT', notnull: 0 });
  });

  it('records the step in schema_meta with the time it was applied', () => {
    const dir = tmpDir();
    open(dir, () => 1_234_567).close();

    expect(inspect(dir, metaRows)).toEqual([{ key: 'queue_items.lane', value: '1', applied_at: 1_234_567 }]);
  });

  it('builds idx_queue_host_lane over (state, host, lane, priority, enqueued_at)', () => {
    const dir = tmpDir();
    open(dir).close();

    const cols = inspect(dir, (db) =>
      (db.prepare('PRAGMA index_info(idx_queue_host_lane)').all() as unknown as Array<{ name: string }>).map((c) => c.name)
    );
    expect(cols).toEqual(['state', 'host', 'lane', 'priority', 'enqueued_at']);
  });

  it('leaves PRAGMA user_version as the writability probe (1), not a schema version', () => {
    const dir = tmpDir();
    open(dir).close();

    expect(inspect(dir, (db) => (db.prepare('PRAGMA user_version').get() as unknown as { user_version: number }).user_version)).toBe(1);
  });

  it('round-trips a lane through put and restore', () => {
    const store = open(tmpDir());
    store.put(ITEM({ lane: 'company' }));
    store.put(ITEM({ id: 'id-2', mfcId: 'k-2', url: 'https://store.example/item/2' }));

    const byId = new Map(store.restore(2_000).pending.map((i) => [i.id, i]));
    expect(byId.get('id-1')?.lane).toBe('company');
    expect(byId.get('id-2')?.lane).toBeUndefined();
    expect('lane' in (byId.get('id-2') as object)).toBe(false);
  });

  it('re-opening is a no-op migration: no throw, no quarantine, and the first applied_at is kept', () => {
    const dir = tmpDir();
    const first = open(dir, () => 1_000);
    first.put(ITEM({ lane: 'gap' }));
    first.close();

    const second = createQueueStore({ dir, now: () => 9_000 });
    stores.push(second);

    expect(second.reason).toBe('ok');
    expect(second.quarantinedPath).toBeNull();
    expect(second.restore(2_000).pending[0].lane).toBe('gap');
    second.close();
    expect(inspect(dir, metaRows)).toEqual([{ key: 'queue_items.lane', value: '1', applied_at: 1_000 }]);
  });

  it.each([['0'], ['x']])('raises a schema_meta record below the current step (%p)', (below) => {
    const dir = tmpDir();
    open(dir, () => 1_000).close();
    const raw = new DatabaseSync(path.join(dir, QUEUE_DB_FILE));
    raw.prepare(`UPDATE schema_meta SET value = ? WHERE key = 'queue_items.lane'`).run(below);
    raw.close();

    open(dir, () => 5_000).close();

    expect(inspect(dir, metaRows)).toEqual([{ key: 'queue_items.lane', value: '1', applied_at: 5_000 }]);
  });

  it('never lowers a record a NEWER build wrote: after a rollback it still says what the file has had', () => {
    const dir = tmpDir();
    open(dir, () => 1_000).close();
    const raw = new DatabaseSync(path.join(dir, QUEUE_DB_FILE));
    raw.exec(`UPDATE schema_meta SET value = '2', applied_at = 2_000 WHERE key = 'queue_items.lane'`);
    raw.close();

    const reopened = createQueueStore({ dir, now: () => 9_000 });
    stores.push(reopened);
    expect(reopened.reason).toBe('ok');
    reopened.close();

    expect(inspect(dir, metaRows)).toEqual([{ key: 'queue_items.lane', value: '2', applied_at: 2_000 }]);
  });
});

// ---------------------------------------------------------------------------------------------
// (b) a file written by today's build
// ---------------------------------------------------------------------------------------------
describe('queueStore lane — (b) a store written by the v1 schema upgrades in place', () => {
  function writeV1File(dir: string): void {
    const db = v1Open(path.join(dir, QUEUE_DB_FILE));
    v1Put(db, 'old-a', 'https://www.myfigurecollection.net/item/1');
    v1Put(db, 'old-b', 'https://myfigurecollection.net/item/2', 'parked');
    v1Put(db, 'old-c', 'https://store.example/item/3', 'leased', 5_000);
    db.prepare('INSERT INTO host_cooldowns (host, until, reason, opened_at) VALUES (?,?,?,?)').run('cool.example', 900_000, 'challenge', 1_000);
    db.close();
  }

  it('opens with no quarantine and every legacy row reads lane null', () => {
    const dir = tmpDir();
    writeV1File(dir);
    expect(inspect(dir, (db) => columnsOf(db, 'queue_items'))).not.toContain('lane');

    const store = createQueueStore({ dir, now: () => 7_000 });
    stores.push(store);

    expect(store.reason).toBe('ok');
    expect(store.quarantinedPath).toBeNull();
    expect(fs.readdirSync(dir).filter((f) => f.includes('.corrupt-'))).toEqual([]);
    expect(store.counts()).toEqual({ pending: 1, leased: 1, parked: 1 });

    const restored = store.restore(8_000);
    expect(restored.pending.map((i) => [i.id, i.lane])).toEqual([['old-a', undefined]]);
    expect(store.pageIn(10).map((i) => [i.id, i.lane])).toEqual([['old-b', undefined]]);
    expect(restored.cooldowns.map((c) => c.host)).toEqual(['cool.example']);
    store.close();

    inspect(dir, (db) => {
      expect(columnsOf(db, 'queue_items')).toContain('lane');
      expect(laneOnDisk(db, 'old-a')).toBeNull();
      expect(metaRows(db)).toEqual([{ key: 'queue_items.lane', value: '1', applied_at: 7_000 }]);
    });
  });

  it('gates the step on the COLUMN, not on the record: a record without the column still migrates', () => {
    const dir = tmpDir();
    writeV1File(dir);
    const raw = new DatabaseSync(path.join(dir, QUEUE_DB_FILE));
    raw.exec('CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, applied_at INTEGER NOT NULL)');
    raw.exec(`INSERT INTO schema_meta VALUES ('queue_items.lane', '1', 1)`);
    raw.close();

    const store = createQueueStore({ dir });
    stores.push(store);

    expect(store.reason).toBe('ok');
    store.put(ITEM({ id: 'new-1', mfcId: 'new-1', lane: 'new' }));
    expect(store.restore(9_000).pending.find((i) => i.id === 'new-1')?.lane).toBe('new');
  });

  it('never throws "duplicate column" when the column is there but the record is not', () => {
    const dir = tmpDir();
    const first = open(dir);
    first.put(ITEM({ lane: 'company' }));
    first.close();
    const raw = new DatabaseSync(path.join(dir, QUEUE_DB_FILE));
    raw.exec('DROP TABLE schema_meta');
    raw.close();

    const store = createQueueStore({ dir, now: () => 4_000 });
    stores.push(store);

    expect(store.reason).toBe('ok');
    expect(store.quarantinedPath).toBeNull();
    expect(store.restore(9_000).pending[0].lane).toBe('company');
    store.close();
    expect(inspect(dir, metaRows)).toEqual([{ key: 'queue_items.lane', value: '1', applied_at: 4_000 }]);
  });
});

// ---------------------------------------------------------------------------------------------
// (c) rollback safety: new -> old -> new
// ---------------------------------------------------------------------------------------------
describe('queueStore lane — (c) new -> old -> new keeps the file usable and the labels', () => {
  it('an older build opens the upgraded file, works it, and the new build re-opens it cleanly', () => {
    const dir = tmpDir();
    const file = path.join(dir, QUEUE_DB_FILE);

    // NEW: labelled rows, one of each lane, plus one unlabelled.
    const first = open(dir, () => 1_000);
    first.put(ITEM({ id: 'n-new', mfcId: 'n-new', url: 'https://myfigurecollection.net/item/10', lane: 'new' }));
    first.put(ITEM({ id: 'n-co', mfcId: 'n-co', url: 'https://myfigurecollection.net/item/11', lane: 'company', state: 'parked' }));
    first.put(ITEM({ id: 'n-gap', mfcId: 'n-gap', url: 'https://myfigurecollection.net/item/12', lane: 'gap' }));
    first.close();

    // OLD: today's open replayed on the upgraded file must not throw. It then writes the way today's
    // build writes: unlabelled inserts, and the lease / fail / park / priority updates on a LABELLED row.
    const old = v1Open(file);
    v1Put(old, 'o-1', 'https://myfigurecollection.net/item/20');
    v1Put(old, 'o-2', 'https://myfigurecollection.net/item/21', 'parked');
    old.prepare(`UPDATE queue_items SET state = 'leased', lease_until = ? WHERE id = ?`).run(50_000, 'n-new');
    old.prepare(`UPDATE queue_items SET state = 'pending', lease_until = NULL, attempts = ?, last_error_class = ? WHERE id = ?`).run(1, 'timeout', 'n-new');
    old.prepare(`UPDATE queue_items SET state = 'parked', lease_until = NULL WHERE id = ?`).run('n-gap');
    old.prepare('UPDATE queue_items SET priority = ? WHERE id = ?').run('COLD', 'n-co');
    // Today's restore reads SELECT * — the extra column must not trip it.
    expect((old.prepare(`SELECT * FROM queue_items WHERE state = 'pending' ORDER BY enqueued_at ASC`).all() as unknown[]).length).toBe(2);
    old.close();

    // NEW again: no throw, no quarantine, labels kept, the old build's rows null.
    const again = createQueueStore({ dir, now: () => 99_000 });
    stores.push(again);
    expect(again.reason).toBe('ok');
    expect(again.quarantinedPath).toBeNull();

    const pending = new Map(again.restore(60_000).pending.map((i) => [i.id, i]));
    expect(pending.get('n-new')).toMatchObject({ lane: 'new', attempts: 1, lastErrorClass: 'timeout' });
    expect(pending.get('o-1')?.lane).toBeUndefined();
    const paged = new Map(again.pageIn(10).map((i) => [i.id, i]));
    expect(paged.get('n-co')).toMatchObject({ lane: 'company', priority: 'COLD' });
    expect(paged.get('n-gap')?.lane).toBe('gap');
    expect(paged.get('o-2')?.lane).toBeUndefined();
    again.close();

    inspect(dir, (db) => {
      expect(metaRows(db)).toEqual([{ key: 'queue_items.lane', value: '1', applied_at: 1_000 }]);
      expect(laneOnDisk(db, 'o-1')).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------------------------
// lane through lease, reap, release, claim and page-in
// ---------------------------------------------------------------------------------------------
describe('queueStore lane — carried through every path a row comes back by', () => {
  it('a leased row keeps its lane when its lease expires and is reaped', () => {
    const store = open(tmpDir());
    store.put(ITEM({ lane: 'gap' }));
    store.lease('id-1', 5_000);

    expect(store.reapExpiredLeases(6_000).map((i) => i.lane)).toEqual(['gap']);
  });

  it('a leased row comes back with its lane at restore after a crash', () => {
    const dir = tmpDir();
    const first = open(dir);
    first.put(ITEM({ lane: 'new' }));
    first.lease('id-1', 5_000);
    first.close();

    expect(open(dir).restore(6_000).leasedExpired.map((i) => i.lane)).toEqual(['new']);
  });

  it('a released lease keeps its lane', () => {
    const store = open(tmpDir());
    store.put(ITEM({ lane: 'company' }));
    store.lease('id-1', 5_000);
    store.releaseLeases();

    expect(store.restore(1_000).pending[0].lane).toBe('company');
  });

  it('page-in carries the lane', () => {
    const store = open(tmpDir());
    store.put(ITEM({ lane: 'gap', state: 'parked' }));

    expect(store.pageIn(5).map((i) => i.lane)).toEqual(['gap']);
  });

  it('claimKey carries the lane', () => {
    const store = open(tmpDir());
    store.put(ITEM({ lane: 'new', state: 'parked' }));

    expect(store.claimKey('k-1')?.lane).toBe('new');
  });

  it('setLane labels a row (the coalesce rule) without touching anything else on it', () => {
    const store = open(tmpDir());
    store.put(ITEM({ attempts: 2, lastErrorClass: 'timeout' }));
    store.setLane('id-1', 'company');

    expect(store.restore(1_000).pending[0]).toMatchObject({ lane: 'company', attempts: 2, lastErrorClass: 'timeout', priority: 'WARM' });
  });

  it('setLane labels only an UNLABELLED row: a lane already on the row is never overwritten', () => {
    const dir = tmpDir();
    const store = open(dir);
    store.put(ITEM({ lane: 'company' }));
    store.setLane('id-1', 'new');
    store.close();

    expect(inspect(dir, (db) => laneOnDisk(db, 'id-1'))).toBe('company');
  });
});

// ---------------------------------------------------------------------------------------------
// (d) salvage
// ---------------------------------------------------------------------------------------------
describe('queueStore lane — (d) the salvage copy carries the lane', () => {
  it('a quarantined file gives its rows back WITH their lanes', () => {
    const dir = tmpDir();
    const first = open(dir);
    first.put(ITEM({ id: 'a', mfcId: 'a', url: 'https://s.example/a', lane: 'company' }));
    first.put(ITEM({ id: 'b', mfcId: 'b', url: 'https://s.example/b', lane: 'gap', state: 'parked' }));
    first.put(ITEM({ id: 'c', mfcId: 'c', url: 'https://s.example/c' }));
    first.lease('a', 60_000);
    first.close();
    fs.chmodSync(path.join(dir, QUEUE_DB_FILE), 0o444);

    const store = createQueueStore({ dir });
    stores.push(store);
    expect(store.reason).toBe('open_failed_recovered');
    expect(store.lostAtStartup).toBe(0);

    const restored = new Map(store.restore(1_000).pending.map((i) => [i.id, i.lane]));
    expect(restored.get('a')).toBe('company');
    expect(restored.get('c')).toBeUndefined();
    expect(store.pageIn(5).map((i) => [i.id, i.lane])).toEqual([['b', 'gap']]);
  });

  it('salvaging a v1 file (no lane column at all) reads every lane as null, without an unknown-lane warning', () => {
    const dir = tmpDir();
    const db = v1Open(path.join(dir, QUEUE_DB_FILE));
    v1Put(db, 'old-a', 'https://s.example/a');
    db.close();
    fs.chmodSync(path.join(dir, QUEUE_DB_FILE), 0o444);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const store = createQueueStore({ dir });
    stores.push(store);
    expect(store.reason).toBe('open_failed_recovered');
    expect(store.restore(1_000).pending.map((i) => [i.id, i.lane])).toEqual([['old-a', undefined]]);
    expect(warn.mock.calls.filter((c) => /unknown lane/.test(String(c[0])))).toEqual([]);
  });

  it('a lane this build does not know is copied as it was, and still reads as unknown', () => {
    const dir = tmpDir();
    const first = open(dir);
    first.put(ITEM({ id: 'a', mfcId: 'a', url: 'https://s.example/a', lane: 'new' }));
    first.close();
    const raw = new DatabaseSync(path.join(dir, QUEUE_DB_FILE));
    raw.prepare('UPDATE queue_items SET lane = ? WHERE id = ?').run('promo', 'a');
    raw.close();
    fs.chmodSync(path.join(dir, QUEUE_DB_FILE), 0o444);
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    const store = createQueueStore({ dir });
    stores.push(store);
    expect(store.reason).toBe('open_failed_recovered');
    expect(store.restore(1_000).pending.map((i) => [i.id, i.lane, i.unknownLane])).toEqual([['a', undefined, 'promo']]);
    store.close();

    expect(inspect(dir, (db) => laneOnDisk(db, 'a'))).toBe('promo');
  });
});

// ---------------------------------------------------------------------------------------------
// (e) unknown lane values on disk
// ---------------------------------------------------------------------------------------------
describe('queueStore lane — (e) a lane this build does not know reads as null, with ONE warning', () => {
  function seedUnknown(dir: string): void {
    const first = open(dir);
    first.put(ITEM({ id: 'u1', mfcId: 'u1', url: 'https://s.example/1', lane: 'new' }));
    first.put(ITEM({ id: 'u2', mfcId: 'u2', url: 'https://s.example/2', lane: 'new' }));
    first.put(ITEM({ id: 'u3', mfcId: 'u3', url: 'https://s.example/3', lane: 'new', state: 'parked' }));
    first.put(ITEM({ id: 'u4', mfcId: 'u4', url: 'https://s.example/4', lane: 'gap' }));
    first.close();
    const raw = new DatabaseSync(path.join(dir, QUEUE_DB_FILE));
    raw.prepare('UPDATE queue_items SET lane = ? WHERE id = ?').run('promo', 'u1');
    raw.prepare('UPDATE queue_items SET lane = ? WHERE id = ?').run('other', 'u2');
    raw.prepare('UPDATE queue_items SET lane = ? WHERE id = ?').run('toString', 'u3');
    raw.close();
  }

  it('reads each unknown value as no lane, keeps the known one, and warns once for the store', () => {
    const dir = tmpDir();
    seedUnknown(dir);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const store = open(dir);
    const restored = new Map(store.restore(1_000).pending.map((i) => [i.id, i]));
    const paged = store.pageIn(5);

    expect(restored.get('u1')?.lane).toBeUndefined();
    expect(restored.get('u2')?.lane).toBeUndefined();
    expect(restored.get('u4')?.lane).toBe('gap');
    expect(paged.map((i) => [i.id, i.lane])).toEqual([['u3', undefined]]);
    expect('lane' in (restored.get('u1') as object)).toBe(false);

    const laneWarnings = warn.mock.calls.filter((c) => /unknown lane/.test(String(c[0])));
    expect(laneWarnings).toHaveLength(1);
    expect(String(laneWarnings[0][0])).toMatch(/\[SCRAPE QUEUE\].*unknown lane/);
  });

  it('does not warn about NULL lanes: no lane is not an unknown lane', () => {
    const store = open(tmpDir());
    store.put(ITEM({ id: 'a', mfcId: 'a' }));
    store.put(ITEM({ id: 'b', mfcId: 'b', state: 'parked' }));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    store.restore(1_000);
    store.countByHostLane('parked');
    store.pageIn(5);

    expect(warn.mock.calls.filter((c) => /unknown lane/.test(String(c[0])))).toEqual([]);
  });

  it('hands an unknown value back as unknownLane, never as lane, on every read path', () => {
    const dir = tmpDir();
    seedUnknown(dir);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const store = open(dir);

    const restored = new Map(store.restore(1_000).pending.map((i) => [i.id, i]));
    expect(restored.get('u1')?.unknownLane).toBe('promo');
    expect(restored.get('u2')?.unknownLane).toBe('other');
    expect('unknownLane' in (restored.get('u4') as object)).toBe(false);
    expect(store.claimKey('u3')).toMatchObject({ unknownLane: 'toString' });
    store.lease('u1', 5_000);
    expect(store.reapExpiredLeases(6_000).map((i) => [i.id, i.lane, i.unknownLane])).toEqual([['u1', undefined, 'promo']]);
  });

  it('never rewrites an unknown value on disk: reads, a claim and setLane all leave it (a newer build may know it)', () => {
    const dir = tmpDir();
    seedUnknown(dir);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const store = open(dir);
    store.restore(1_000);
    store.countByHostLane('parked');
    store.claimKey('u3');
    store.setLane('u1', 'new');
    store.setLane('u3', 'gap');
    store.close();

    expect(inspect(dir, (db) => [laneOnDisk(db, 'u1'), laneOnDisk(db, 'u2'), laneOnDisk(db, 'u3')])).toEqual([
      'promo',
      'other',
      'toString',
    ]);
  });

  it('counts unknown values as other in the per-(host, lane) reading', () => {
    const dir = tmpDir();
    seedUnknown(dir);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const store = open(dir);

    const sorted = (rows: ReturnType<ScrapeQueueStore['countByHostLane']>) =>
      [...rows].sort((a, b) => String(a.lane).localeCompare(String(b.lane)));
    expect(sorted(store.countByHostLane('pending'))).toEqual([
      { host: 's.example', lane: 'gap', n: 1 },
      { host: 's.example', lane: undefined, n: 2 },
    ]);
    expect(store.countByHostLane('parked')).toEqual([{ host: 's.example', lane: undefined, n: 1 }]);
  });
});

// ---------------------------------------------------------------------------------------------
// the per-(host, lane) reading the queue reconciles its counters from at boot
// ---------------------------------------------------------------------------------------------
describe('queueStore lane — countByHostLane', () => {
  it('counts rows of one state by normalized host and lane', () => {
    const store = open(tmpDir());
    store.put(ITEM({ id: 'a', mfcId: 'a', url: 'https://www.myfigurecollection.net/item/1', lane: 'new', state: 'parked' }));
    store.put(ITEM({ id: 'b', mfcId: 'b', url: 'https://myfigurecollection.net/item/2', lane: 'new', state: 'parked' }));
    store.put(ITEM({ id: 'c', mfcId: 'c', url: 'https://myfigurecollection.net/item/3', state: 'parked' }));
    store.put(ITEM({ id: 'd', mfcId: 'd', url: 'https://other.example/item/4', lane: 'gap', state: 'parked' }));
    store.put(ITEM({ id: 'e', mfcId: 'e', url: 'https://myfigurecollection.net/item/5', lane: 'new' }));
    store.put(ITEM({ id: 'f', mfcId: 'f', url: 'not a url', lane: 'gap', state: 'parked' }));

    const parked = store.countByHostLane('parked');
    expect(parked).toEqual(
      expect.arrayContaining([
        { host: 'myfigurecollection.net', lane: 'new', n: 2 },
        { host: 'myfigurecollection.net', lane: undefined, n: 1 },
        { host: 'other.example', lane: 'gap', n: 1 },
        { host: null, lane: 'gap', n: 1 },
      ])
    );
    expect(parked).toHaveLength(4);
    expect(store.countByHostLane('pending')).toEqual([{ host: 'myfigurecollection.net', lane: 'new', n: 1 }]);
    expect(store.countByHostLane('leased')).toEqual([]);
  });

  it('is empty after close, and on the in-memory fallback', () => {
    const store = open(tmpDir());
    store.put(ITEM({ lane: 'new', state: 'parked' }));
    store.close();
    expect(store.countByHostLane('parked')).toEqual([]);

    const memory = createMemoryQueueStore();
    expect(memory.countByHostLane('parked')).toEqual([]);
    expect(() => memory.setLane('x', 'new')).not.toThrow();
  });
});
