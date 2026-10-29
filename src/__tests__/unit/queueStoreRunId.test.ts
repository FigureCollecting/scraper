/**
 * LG-RUNID: a queue row carries the run its item was enqueued in (queue_items.run_id), beside its traceparent.
 *
 * fc-shared 1.9.0 prints run_id (the run's trace id) on every line of a server/job run; withTraceparent restores only
 * the run it is handed. The queue stores currentRunId() with the item so a restart, a park and a page-in hand the run
 * back. The column is nullable and added as a schema step gated by presence, like traceparent: a row the develop build
 * (1f8187ca) wrote has no run_id and still loads, and that build still opens a file this build migrated, its own rows
 * leaving the column NULL. The v4 statements below are FROZEN copies of 1f8187ca's open and put, not imports.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { openQueueStore, QUEUE_DB_FILE, type PersistedQueueItem, type ScrapeQueueStore } from '../../services/queueStore';

// ---------------------------------------------------------------------------------------------
// The v4 (lane + class_entered_at + traceparent, pre-run_id) open and put, frozen from develop 1f8187ca.
// ---------------------------------------------------------------------------------------------
const V4_SCHEMA = `
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
const V4_PUT = `INSERT INTO queue_items
  (id, mfc_id, url, host, priority, status, session_id, attempts, max_retries, enqueued_at, state, lease_until, last_error_class, lane, class_entered_at, traceparent)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT DO NOTHING`;

/** Replays 1f8187ca's openQueueStore against `file`, step for step. */
function v4Open(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(V4_SCHEMA);
  const columns = db.prepare('PRAGMA table_info(queue_items)').all() as unknown as Array<{ name: string }>;
  if (!columns.some((c) => c.name === 'lane')) db.exec('ALTER TABLE queue_items ADD COLUMN lane TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_queue_host_lane ON queue_items(state, host, lane, priority, enqueued_at)');
  if (!columns.some((c) => c.name === 'class_entered_at')) db.exec('ALTER TABLE queue_items ADD COLUMN class_entered_at INTEGER');
  db.exec('CREATE INDEX IF NOT EXISTS idx_queue_class_age ON queue_items(state, host, lane, priority, class_entered_at)');
  if (!columns.some((c) => c.name === 'traceparent')) db.exec('ALTER TABLE queue_items ADD COLUMN traceparent TEXT');
  const record = db.prepare(
    `INSERT INTO schema_meta (key, value, applied_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, applied_at = excluded.applied_at
     WHERE CAST(schema_meta.value AS INTEGER) < CAST(excluded.value AS INTEGER)`
  );
  for (const key of ['queue_items.lane', 'queue_items.class_entered_at', 'queue_items.traceparent']) record.run(key, '1', 1);
  db.exec(`DELETE FROM queue_items WHERE id NOT IN (SELECT id FROM (SELECT id, MIN(enqueued_at) FROM queue_items GROUP BY mfc_id));
CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_mfc_unique ON queue_items(mfc_id);`);
  db.exec('PRAGMA user_version = 1');
  return db;
}

/** 1f8187ca's put(), which names its columns: it writes a traceparent and never a run_id. */
function v4Put(db: DatabaseSync, id: string, url: string, state = 'pending'): void {
  db.prepare(V4_PUT).run(id, id, url, new URL(url).hostname, 'WARM', null, null, 0, 3, 1_000, state, null, null, null, 1_000, TP_A);
}

// ---------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------
const TP_A = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
const RUN_A = '0af7651916cd43dd8448eb211c80319c';
const RUN_B = '5b8efff798038103d269b633813fc60c';

let dirs: string[] = [];
let stores: ScrapeQueueStore[] = [];

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-store-runid-'));
  dirs.push(d);
  return d;
}

function open(dir: string, now?: () => number): ScrapeQueueStore {
  const s = openQueueStore({ dir, ...(now !== undefined ? { now } : {}) });
  stores.push(s);
  return s;
}

/** Run fn against the file read-only. */
function readDb<T>(dir: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path.join(dir, QUEUE_DB_FILE), { readOnly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

const onDisk = (dir: string, id: string): unknown =>
  readDb(dir, (db) => (db.prepare('SELECT run_id AS r FROM queue_items WHERE id = ?').get(id) as unknown as { r: unknown }).r);

const runIdColumns = (dir: string): Array<{ name: string; type: string; notnull: number }> =>
  readDb(dir, (db) =>
    (db.prepare('PRAGMA table_info(queue_items)').all() as unknown as Array<{ name: string; type: string; notnull: number }>)
      .filter((c) => c.name === 'run_id')
      .map((c) => ({ name: c.name, type: c.type, notnull: c.notnull }))
  );

const runIdRecord = (dir: string): unknown =>
  readDb(dir, (db) => db.prepare("SELECT value, applied_at FROM schema_meta WHERE key = 'queue_items.run_id'").all());

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

describe('queue_items.run_id: the run an item was enqueued in survives the disk', () => {
  it('a new file has the nullable column and the schema_meta record', () => {
    const dir = tmpDir();
    open(dir, () => 7_000).close();

    expect(runIdColumns(dir)).toEqual([{ name: 'run_id', type: 'TEXT', notnull: 0 }]);
    expect(runIdRecord(dir)).toEqual([{ value: '1', applied_at: 7_000 }]);
  });

  it('round-trips beside the traceparent through put, restart restore, claimKey, listParked and pageIn', () => {
    const dir = tmpDir();
    const s = open(dir);
    s.put(ITEM({ id: 'a', mfcId: 'a', traceparent: TP_A, runId: RUN_A }));
    s.put(ITEM({ id: 'b', mfcId: 'b', url: 'https://store.test/item/2', runId: RUN_B, state: 'parked' }));
    s.put(ITEM({ id: 'c', mfcId: 'c', url: 'https://store.test/item/3', runId: RUN_A, state: 'parked' }));
    // A retry writes the spent attempt back; it must not touch the run.
    s.fail('a', 1, 'network');
    s.close();
    expect(onDisk(dir, 'a')).toBe(RUN_A);

    const again = open(dir);
    expect(again.restore(Date.now()).pending.map((r) => [r.id, r.attempts, r.traceparent, r.runId])).toEqual([['a', 1, TP_A, RUN_A]]);
    expect(again.listParked('store.test', 'WARM').map((r) => [r.id, r.runId])).toEqual([['b', RUN_B], ['c', RUN_A]]);
    expect(again.claimKey('b')?.runId).toBe(RUN_B);
    expect(again.pageIn(10).map((r) => [r.id, r.runId])).toEqual([['c', RUN_A]]);
  });

  it('a row put outside any run reads back with none (NULL on disk, the field absent, not null)', () => {
    const dir = tmpDir();
    const s = open(dir);
    s.put(ITEM({ traceparent: TP_A }));
    const [row] = s.restore(Date.now()).pending;
    expect(onDisk(dir, 'id-1')).toBeNull();
    expect(row).not.toHaveProperty('runId');
    expect(row.traceparent).toBe(TP_A);
  });

  it('reads a non-text cell as no run and passes a text cell through for fc-shared to judge, never throwing', () => {
    const dir = tmpDir();
    const s = open(dir);
    for (const id of ['integer', 'real', 'blob', 'garbage', 'empty']) s.put(ITEM({ id, mfcId: id, url: `https://store.test/item/${id}` }));
    s.close();
    // Values no build writes. The TEXT column turns a number into its text; a blob stays bytes.
    const db = new DatabaseSync(path.join(dir, QUEUE_DB_FILE));
    db.prepare("UPDATE queue_items SET run_id = 42 WHERE id = 'integer'").run();
    db.prepare("UPDATE queue_items SET run_id = 1.5 WHERE id = 'real'").run();
    db.prepare("UPDATE queue_items SET run_id = x'00ff' WHERE id = 'blob'").run();
    db.prepare("UPDATE queue_items SET run_id = 'not-a-run' WHERE id = 'garbage'").run();
    db.prepare("UPDATE queue_items SET run_id = '' WHERE id = 'empty'").run();
    db.close();

    const rows = open(dir).restore(Date.now()).pending;
    expect(Object.fromEntries(rows.map((r) => [r.id, r.runId ?? 'absent']))).toEqual({
      integer: '42',
      real: '1.5',
      blob: 'absent',
      garbage: 'not-a-run',
      empty: '',
    });
  });

  it('upgrades a file the develop build wrote in place: its rows load with no run, new rows carry theirs', () => {
    const dir = tmpDir();
    const old = v4Open(path.join(dir, QUEUE_DB_FILE));
    v4Put(old, 'old-1', 'https://store.test/item/1');
    v4Put(old, 'old-2', 'https://store.test/item/2', 'parked');
    old.close();
    expect(runIdColumns(dir)).toEqual([]);

    const s = open(dir);
    expect(s.reason).toBe('ok');
    expect(s.counts()).toEqual({ pending: 1, leased: 0, parked: 1 });
    s.put(ITEM({ id: 'new-1', mfcId: 'new-1', url: 'https://store.test/item/3', enqueuedAt: 2_000, runId: RUN_A }));
    const pending = s.restore(Date.now()).pending;
    expect(pending.map((r) => [r.id, r.traceparent, r.runId])).toEqual([['old-1', TP_A, undefined], ['new-1', undefined, RUN_A]]);
    expect(pending[0]).not.toHaveProperty('runId');
    expect(s.pageIn(10)[0]).not.toHaveProperty('runId');
  });

  it('the migration is idempotent: opening the upgraded file again adds nothing, keeps the rows and the first record', () => {
    const dir = tmpDir();
    const old = v4Open(path.join(dir, QUEUE_DB_FILE));
    v4Put(old, 'old-1', 'https://store.test/item/1');
    old.close();

    const first = open(dir, () => 1_000);
    first.put(ITEM({ id: 'new-1', mfcId: 'new-1', url: 'https://store.test/item/2', enqueuedAt: 2_000, runId: RUN_A }));
    first.close();
    const second = open(dir, () => 9_000);

    expect(second.reason).toBe('ok');
    expect(runIdColumns(dir)).toEqual([{ name: 'run_id', type: 'TEXT', notnull: 0 }]);
    expect(runIdRecord(dir)).toEqual([{ value: '1', applied_at: 1_000 }]);
    expect(second.restore(Date.now()).pending.map((r) => [r.id, r.runId])).toEqual([['old-1', undefined], ['new-1', RUN_A]]);
  });

  it('the develop build still opens a migrated file, and its own rows leave the column NULL (rollback safe)', () => {
    const dir = tmpDir();
    const s = open(dir);
    s.put(ITEM({ id: 'new-1', mfcId: 'new-1', enqueuedAt: 500, runId: RUN_A }));
    s.close();

    const old = v4Open(path.join(dir, QUEUE_DB_FILE));
    v4Put(old, 'old-1', 'https://store.test/item/9');
    old.close();
    expect(onDisk(dir, 'new-1')).toBe(RUN_A);
    expect(onDisk(dir, 'old-1')).toBeNull();

    const again = open(dir);
    expect(again.reason).toBe('ok');
    expect(again.restore(Date.now()).pending.map((r) => [r.id, r.runId])).toEqual([['new-1', RUN_A], ['old-1', undefined]]);
  });
});
