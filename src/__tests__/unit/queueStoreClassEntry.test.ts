/**
 * QB-U19: class_entered_at on every queue row, the index the pool reads a class through, and the
 * parked-row listing pool dispatch uses.
 *
 * R1 and R2 age a queue row from when it ENTERED ITS DISPATCH CLASS (host + tier now), not from its
 * first enqueue: a row raised from COLD to WARM joins the WARM class at the raise, behind every WARM
 * row already waiting (the starvation theorem needs that). So the column is stamped on insert, re-stamped
 * by setPriority when the class changes, and left alone by a retry (fail), a claim, a page-in, a lease
 * release and a dedup enqueue (an INSERT that does nothing). A NULL cell (a row an older build wrote)
 * reads as the row's enqueued_at; a read-back carries `classEnteredAt` only when it differs from
 * `enqueuedAt` (absent = never changed class), like `lane` absent = no lane.
 *
 * Added as a schema step recorded in schema_meta, gated by presence (PRAGMA table_info), so the
 * develop build (049ac7ce, the deployed QB-U33 image) still opens a file this build migrated, and
 * writes rows that leave the column NULL. The v2 statements below are FROZEN copies of 049ac7ce's
 * open and put, not imports.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import {
  createMemoryQueueStore,
  openQueueStore,
  QUEUE_DB_FILE,
  type PersistedQueueItem,
  type ScrapeQueueStore,
} from '../../services/queueStore';

// ---------------------------------------------------------------------------------------------
// The v2 (lane, pre-class_entered_at) open and put, frozen from develop 049ac7ce queueStore.ts.
// ---------------------------------------------------------------------------------------------
const V2_SCHEMA = `
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
const V2_SCHEMA_META = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);
`;
const V2_DEDUP_KEY_CONSTRAINT = `
DELETE FROM queue_items WHERE id NOT IN (
  SELECT id FROM (SELECT id, MIN(enqueued_at) FROM queue_items GROUP BY mfc_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_mfc_unique ON queue_items(mfc_id);
`;
const V2_PUT = `INSERT INTO queue_items
  (id, mfc_id, url, host, priority, status, session_id, attempts, max_retries, enqueued_at, state, lease_until, last_error_class, lane)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT DO NOTHING`;

/** Replays 049ac7ce's openQueueStore against `file`, statement for statement. */
function v2Open(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(V2_SCHEMA);
  db.exec(V2_SCHEMA_META);
  const columns = db.prepare('PRAGMA table_info(queue_items)').all() as unknown as Array<{ name: string }>;
  if (!columns.some((c) => c.name === 'lane')) db.exec('ALTER TABLE queue_items ADD COLUMN lane TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_queue_host_lane ON queue_items(state, host, lane, priority, enqueued_at)');
  db.prepare(
    `INSERT INTO schema_meta (key, value, applied_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, applied_at = excluded.applied_at
     WHERE CAST(schema_meta.value AS INTEGER) < CAST(excluded.value AS INTEGER)`
  ).run('queue_items.lane', '1', 5);
  db.exec(V2_DEDUP_KEY_CONSTRAINT);
  db.prepare('SELECT COUNT(*) AS n FROM queue_items').get();
  db.exec('PRAGMA user_version = 1');
  db.exec('PRAGMA max_page_count = 65536');
  return db;
}

/** 049ac7ce's put(), which names its columns: it leaves class_entered_at NULL. */
function v2Put(db: DatabaseSync, id: string, url: string, opts: { state?: string; priority?: string; enqueuedAt?: number } = {}): void {
  const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  db.prepare(V2_PUT).run(id, id, url, host, opts.priority ?? 'WARM', null, null, 0, 3, opts.enqueuedAt ?? 1_000, opts.state ?? 'pending', null, null, null);
}

// ---------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------
let dirs: string[] = [];
let stores: ScrapeQueueStore[] = [];

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-store-cea-'));
  dirs.push(d);
  return d;
}

function open(dir: string, now?: () => number): ScrapeQueueStore {
  const s = openQueueStore({ dir, ...(now ? { now } : {}) });
  stores.push(s);
  return s;
}

function inspect<T>(dir: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path.join(dir, QUEUE_DB_FILE), { readOnly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

const ceaOnDisk = (dir: string, id: string): unknown =>
  inspect(dir, (db) => (db.prepare('SELECT class_entered_at AS c FROM queue_items WHERE id = ?').get(id) as unknown as { c: unknown }).c);

const ITEM = (over: Partial<PersistedQueueItem> = {}): PersistedQueueItem => ({
  id: 'id-1',
  mfcId: 'k-1',
  url: 'https://store.test/item/1',
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
      /* closed */
    }
  }
  stores = [];
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe('schema step: class_entered_at + idx_queue_class_age, recorded in schema_meta', () => {
  it('a new file has the column, the index (state, host, lane, priority, class_entered_at) and the record', () => {
    const dir = tmpDir();
    open(dir, () => 42).close();
    inspect(dir, (db) => {
      const cols = (db.prepare('PRAGMA table_info(queue_items)').all() as unknown as Array<{ name: string; type: string; notnull: number }>);
      const cea = cols.find((c) => c.name === 'class_entered_at');
      expect(cea).toMatchObject({ type: 'INTEGER', notnull: 0 });
      const idx = (db.prepare('PRAGMA index_info(idx_queue_class_age)').all() as unknown as Array<{ name: string }>).map((c) => c.name);
      expect(idx).toEqual(['state', 'host', 'lane', 'priority', 'class_entered_at']);
      const meta = db.prepare("SELECT value, applied_at FROM schema_meta WHERE key = 'queue_items.class_entered_at'").get() as unknown as { value: string; applied_at: number };
      expect(meta).toEqual({ value: '1', applied_at: 42 });
    });
  });

  it('upgrades a file the develop build wrote in place: rows kept, no quarantine; a re-open is a no-op', () => {
    const dir = tmpDir();
    const file = path.join(dir, QUEUE_DB_FILE);
    const old = v2Open(file);
    v2Put(old, 'a', 'https://store.test/item/1', { enqueuedAt: 1_000 });
    v2Put(old, 'b', 'https://store.test/item/2', { state: 'parked', enqueuedAt: 2_000 });
    old.close();

    const s = open(dir, () => 50);
    expect(s.reason).toBe('ok');
    expect(s.counts()).toEqual({ pending: 1, leased: 0, parked: 1 });
    s.close();
    const again = open(dir, () => 99);
    expect(again.reason).toBe('ok');
    again.close();
    inspect(dir, (db) => {
      const meta = db.prepare("SELECT applied_at FROM schema_meta WHERE key = 'queue_items.class_entered_at'").get();
      expect(meta).toEqual({ applied_at: 50 });
    });
    expect(ceaOnDisk(dir, 'a')).toBeNull();
  });

  it('the develop build opens a file this build migrated and wrote, and its own rows leave the column NULL', () => {
    const dir = tmpDir();
    const s = open(dir);
    s.put(ITEM({ id: 'new-1', mfcId: 'new-1', enqueuedAt: 1_000, classEnteredAt: 5_000 }));
    s.put(ITEM({ id: 'new-2', mfcId: 'new-2', enqueuedAt: 2_000, state: 'parked' }));
    s.close();

    const old = v2Open(path.join(dir, QUEUE_DB_FILE));
    v2Put(old, 'old-1', 'https://store.test/item/3', { enqueuedAt: 3_000 });
    const rows = old.prepare('SELECT * FROM queue_items ORDER BY id').all() as unknown as Array<{ id: string; state: string; class_entered_at: unknown }>;
    old.close();
    expect(rows.map((r) => [r.id, r.state, r.class_entered_at])).toEqual([
      ['new-1', 'pending', 5_000],
      ['new-2', 'parked', 2_000],
      ['old-1', 'pending', null],
    ]);

    // Back on this build: the NULL row coalesces to its enqueued_at, the others keep their stamp.
    const back = open(dir);
    const restored = back.restore(10_000);
    const byId = new Map(restored.pending.map((r) => [r.id, r]));
    expect(byId.get('new-1')?.classEnteredAt).toBe(5_000);
    expect(byId.get('old-1')?.classEnteredAt).toBeUndefined();
    expect(byId.get('old-1')?.enqueuedAt).toBe(3_000);
    expect(restored.parked).toBe(1);
  });
});

describe('put / read-back', () => {
  it('stamps class_entered_at = classEnteredAt, else enqueuedAt', () => {
    const dir = tmpDir();
    const s = open(dir);
    s.put(ITEM({ id: 'x', mfcId: 'x', enqueuedAt: 1_000 }));
    s.put(ITEM({ id: 'y', mfcId: 'y', enqueuedAt: 1_000, classEnteredAt: 4_000 }));
    expect(ceaOnDisk(dir, 'x')).toBe(1_000);
    expect(ceaOnDisk(dir, 'y')).toBe(4_000);
  });

  it('a read-back carries classEnteredAt only when it differs from enqueuedAt', () => {
    const s = open(tmpDir());
    s.put(ITEM({ id: 'x', mfcId: 'x', enqueuedAt: 1_000 }));
    s.put(ITEM({ id: 'y', mfcId: 'y', enqueuedAt: 1_000, classEnteredAt: 4_000 }));
    const rows = new Map(s.restore(10_000).pending.map((r) => [r.id, r]));
    expect(rows.get('x')).not.toHaveProperty('classEnteredAt');
    expect(rows.get('y')?.classEnteredAt).toBe(4_000);
  });

  it('a dedup put (same id) never refreshes the stamp', () => {
    const dir = tmpDir();
    const s = open(dir);
    s.put(ITEM({ id: 'x', mfcId: 'x', enqueuedAt: 1_000, classEnteredAt: 2_000 }));
    s.put(ITEM({ id: 'x', mfcId: 'x', enqueuedAt: 9_000, classEnteredAt: 9_000 }));
    expect(ceaOnDisk(dir, 'x')).toBe(2_000);
  });
});

describe('setPriority re-stamps the class entry; nothing else moves it', () => {
  it('setPriority(id, priority, classEnteredAt) records both', () => {
    const dir = tmpDir();
    const s = open(dir);
    s.put(ITEM({ id: 'x', mfcId: 'x', priority: 'COLD', enqueuedAt: 1_000 }));
    s.setPriority('x', 'WARM', 7_000);
    const row = s.restore(10_000).pending[0];
    expect(row).toMatchObject({ priority: 'WARM', enqueuedAt: 1_000, classEnteredAt: 7_000 });
    expect(ceaOnDisk(dir, 'x')).toBe(7_000);
  });

  it('setPriority without a class entry keeps the stamp', () => {
    const dir = tmpDir();
    const s = open(dir);
    s.put(ITEM({ id: 'x', mfcId: 'x', priority: 'COLD', enqueuedAt: 1_000, classEnteredAt: 3_000 }));
    s.setPriority('x', 'WARM');
    expect(ceaOnDisk(dir, 'x')).toBe(3_000);
  });

  it('lease, fail (a retry), park, pageIn, claimKey, releaseLeases and reapExpiredLeases keep it', () => {
    const dir = tmpDir();
    const s = open(dir);
    s.put(ITEM({ id: 'x', mfcId: 'x', enqueuedAt: 1_000, classEnteredAt: 3_000 }));
    s.lease('x', 5_000);
    s.fail('x', 1, 'network');
    s.park('x');
    expect(s.pageIn(5).map((r) => r.classEnteredAt)).toEqual([3_000]);
    s.park('x');
    expect(s.claimKey('x')?.classEnteredAt).toBe(3_000);
    s.lease('x', 5_000);
    expect(s.releaseLeases()).toBe(1);
    s.lease('x', 5_000);
    expect(s.reapExpiredLeases(6_000).map((r) => r.classEnteredAt)).toEqual([3_000]);
    expect(ceaOnDisk(dir, 'x')).toBe(3_000);
  });
});

describe('listParked(host, priority): one class\'s parked rows, oldest class entry first', () => {
  it('returns only parked rows of that host and priority, ordered by (class entry, dedup key)', () => {
    const dir = tmpDir();
    const s = open(dir);
    s.put(ITEM({ id: 'p3', mfcId: 'p3', url: 'https://store.test/item/3', state: 'parked', enqueuedAt: 3_000 }));
    s.put(ITEM({ id: 'p1', mfcId: 'p1', url: 'https://www.store.test/item/1', state: 'parked', enqueuedAt: 5_000, classEnteredAt: 1_500 }));
    s.put(ITEM({ id: 'p2b', mfcId: 'p2b', url: 'https://store.test/item/22', state: 'parked', enqueuedAt: 2_000 }));
    s.put(ITEM({ id: 'p2a', mfcId: 'p2a', url: 'https://store.test/item/21', state: 'parked', enqueuedAt: 2_000 }));
    s.put(ITEM({ id: 'res', mfcId: 'res', url: 'https://store.test/item/9', state: 'pending', enqueuedAt: 100 }));
    s.put(ITEM({ id: 'cold', mfcId: 'cold', url: 'https://store.test/item/8', priority: 'COLD', state: 'parked', enqueuedAt: 100 }));
    s.put(ITEM({ id: 'other', mfcId: 'other', url: 'https://other.test/item/7', state: 'parked', enqueuedAt: 100 }));
    s.put(ITEM({ id: 'gone', mfcId: 'gone', url: 'https://store.test/item/6', state: 'leased', enqueuedAt: 100 }));
    const rows = s.listParked('store.test', 'WARM');
    expect(rows.map((r) => r.id)).toEqual(['p1', 'p2a', 'p2b', 'p3']);
    expect(rows.every((r) => r.state === 'parked')).toBe(true);
    expect(rows[0].classEnteredAt).toBe(1_500);
    expect(s.listParked('store.test', 'COLD').map((r) => r.id)).toEqual(['cold']);
    expect(s.listParked('nothing.test', 'WARM')).toEqual([]);
  });

  it('a NULL stamp (an older build\'s row) sorts by its enqueued_at', () => {
    const dir = tmpDir();
    open(dir).close();
    const old = v2Open(path.join(dir, QUEUE_DB_FILE));
    v2Put(old, 'old', 'https://store.test/item/1', { state: 'parked', enqueuedAt: 2_000 });
    old.close();
    const s = open(dir);
    s.put(ITEM({ id: 'new', mfcId: 'new', state: 'parked', enqueuedAt: 500, classEnteredAt: 2_500 }));
    s.put(ITEM({ id: 'first', mfcId: 'first', url: 'https://store.test/item/0', state: 'parked', enqueuedAt: 1_500 }));
    expect(s.listParked('store.test', 'WARM').map((r) => r.id)).toEqual(['first', 'old', 'new']);
  });

  it('is empty on the in-memory fallback and after close', () => {
    expect(createMemoryQueueStore().listParked('store.test', 'WARM')).toEqual([]);
    const s = open(tmpDir());
    s.put(ITEM({ state: 'parked' }));
    s.close();
    expect(s.listParked('store.test', 'WARM')).toEqual([]);
  });
});
