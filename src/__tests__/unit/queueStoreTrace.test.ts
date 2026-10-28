/**
 * LG-QUEUE-1: a queue row carries the W3C traceparent its item is processed under (queue_items.traceparent).
 *
 * One trace per ITEM: the queue stores the enqueuer's trace with the item, so a restart, a park and a page-in
 * dispatch it under the same trace. The column is nullable and added as a schema step gated by presence, like
 * lane and class_entered_at: a row the develop build (f2115538) wrote has no traceparent and still loads, and that
 * build still opens a file this build migrated, its own rows leaving the column NULL. The v3 statements below are
 * FROZEN copies of f2115538's open and put, not imports.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { openQueueStore, QUEUE_DB_FILE, type PersistedQueueItem, type ScrapeQueueStore } from '../../services/queueStore';

// ---------------------------------------------------------------------------------------------
// The v3 (lane + class_entered_at, pre-traceparent) open and put, frozen from develop f2115538.
// ---------------------------------------------------------------------------------------------
const V3_SCHEMA = `
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
CREATE TABLE IF NOT EXISTS schema_meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);
`;
const V3_PUT = `INSERT INTO queue_items
  (id, mfc_id, url, host, priority, status, session_id, attempts, max_retries, enqueued_at, state, lease_until, last_error_class, lane, class_entered_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT DO NOTHING`;

/** Replays f2115538's openQueueStore against `file`, step for step. */
function v3Open(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(V3_SCHEMA);
  const columns = db.prepare('PRAGMA table_info(queue_items)').all() as unknown as Array<{ name: string }>;
  if (!columns.some((c) => c.name === 'lane')) db.exec('ALTER TABLE queue_items ADD COLUMN lane TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_queue_host_lane ON queue_items(state, host, lane, priority, enqueued_at)');
  if (!columns.some((c) => c.name === 'class_entered_at')) db.exec('ALTER TABLE queue_items ADD COLUMN class_entered_at INTEGER');
  db.exec('CREATE INDEX IF NOT EXISTS idx_queue_class_age ON queue_items(state, host, lane, priority, class_entered_at)');
  db.exec(`DELETE FROM queue_items WHERE id NOT IN (SELECT id FROM (SELECT id, MIN(enqueued_at) FROM queue_items GROUP BY mfc_id));
CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_mfc_unique ON queue_items(mfc_id);`);
  db.exec('PRAGMA user_version = 1');
  return db;
}

/** f2115538's put(), which names its columns: it never writes a traceparent. */
function v3Put(db: DatabaseSync, id: string, url: string, state = 'pending'): void {
  db.prepare(V3_PUT).run(id, id, url, new URL(url).hostname, 'WARM', null, null, 0, 3, 1_000, state, null, null, null, 1_000);
}

// ---------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------
const TP_A = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
const TP_B = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

let dirs: string[] = [];
let stores: ScrapeQueueStore[] = [];

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-store-trace-'));
  dirs.push(d);
  return d;
}

function open(dir: string): ScrapeQueueStore {
  const s = openQueueStore({ dir });
  stores.push(s);
  return s;
}

function onDisk(dir: string, id: string): unknown {
  const db = new DatabaseSync(path.join(dir, QUEUE_DB_FILE), { readOnly: true });
  try {
    return (db.prepare('SELECT traceparent AS t FROM queue_items WHERE id = ?').get(id) as unknown as { t: unknown }).t;
  } finally {
    db.close();
  }
}

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

describe('queue_items.traceparent: the item trace survives the disk', () => {
  it('a new file has the nullable column and the schema_meta record', () => {
    const dir = tmpDir();
    open(dir).close();
    const db = new DatabaseSync(path.join(dir, QUEUE_DB_FILE), { readOnly: true });
    try {
      const cols = db.prepare('PRAGMA table_info(queue_items)').all() as unknown as Array<{ name: string; type: string; notnull: number }>;
      expect(cols.find((c) => c.name === 'traceparent')).toMatchObject({ type: 'TEXT', notnull: 0 });
      expect(db.prepare("SELECT value FROM schema_meta WHERE key = 'queue_items.traceparent'").get()).toEqual({ value: '1' });
    } finally {
      db.close();
    }
  });

  it('round-trips through put, restart restore, claimKey, listParked and pageIn', () => {
    const dir = tmpDir();
    const s = open(dir);
    s.put(ITEM({ id: 'a', mfcId: 'a', traceparent: TP_A }));
    s.put(ITEM({ id: 'b', mfcId: 'b', url: 'https://store.test/item/2', traceparent: TP_B, state: 'parked' }));
    s.put(ITEM({ id: 'c', mfcId: 'c', url: 'https://store.test/item/3', traceparent: TP_A, state: 'parked' }));
    // A retry writes the spent attempt back; it must not touch the trace.
    s.fail('a', 1, 'network');
    s.close();
    expect(onDisk(dir, 'a')).toBe(TP_A);

    const again = open(dir);
    expect(again.restore(Date.now()).pending.map((r) => [r.id, r.attempts, r.traceparent])).toEqual([['a', 1, TP_A]]);
    expect(again.listParked('store.test', 'WARM').map((r) => [r.id, r.traceparent])).toEqual([['b', TP_B], ['c', TP_A]]);
    expect(again.claimKey('b')?.traceparent).toBe(TP_B);
    expect(again.pageIn(10).map((r) => [r.id, r.traceparent])).toEqual([['c', TP_A]]);
  });

  it('a row put without a trace reads back with none (the field stays absent, not null)', () => {
    const dir = tmpDir();
    const s = open(dir);
    s.put(ITEM());
    const [row] = s.restore(Date.now()).pending;
    expect(onDisk(dir, 'id-1')).toBeNull();
    expect(row).not.toHaveProperty('traceparent');
  });

  it('upgrades a file the develop build wrote in place: its rows load with no trace, new rows carry theirs', () => {
    const dir = tmpDir();
    const old = v3Open(path.join(dir, QUEUE_DB_FILE));
    v3Put(old, 'old-1', 'https://store.test/item/1');
    v3Put(old, 'old-2', 'https://store.test/item/2', 'parked');
    old.close();

    const s = open(dir);
    expect(s.reason).toBe('ok');
    expect(s.counts()).toEqual({ pending: 1, leased: 0, parked: 1 });
    s.put(ITEM({ id: 'new-1', mfcId: 'new-1', url: 'https://store.test/item/3', enqueuedAt: 2_000, traceparent: TP_A }));
    const pending = s.restore(Date.now()).pending;
    expect(pending.map((r) => r.id)).toEqual(['old-1', 'new-1']);
    expect(pending[0]).not.toHaveProperty('traceparent');
    expect(pending[1].traceparent).toBe(TP_A);
    expect(s.pageIn(10)[0]).not.toHaveProperty('traceparent');
  });

  it('the develop build still opens a migrated file, and its own rows leave the column NULL (rollback safe)', () => {
    const dir = tmpDir();
    const s = open(dir);
    s.put(ITEM({ id: 'new-1', mfcId: 'new-1', enqueuedAt: 500, traceparent: TP_A }));
    s.close();

    const old = v3Open(path.join(dir, QUEUE_DB_FILE));
    v3Put(old, 'old-1', 'https://store.test/item/9');
    old.close();
    expect(onDisk(dir, 'new-1')).toBe(TP_A);
    expect(onDisk(dir, 'old-1')).toBeNull();

    const again = open(dir);
    expect(again.reason).toBe('ok');
    expect(again.restore(Date.now()).pending.map((r) => [r.id, r.traceparent])).toEqual([['new-1', TP_A], ['old-1', undefined]]);
  });
});
