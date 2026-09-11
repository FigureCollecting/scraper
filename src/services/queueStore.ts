/**
 * queueStore — the scrape queue's DURABLE backing store.
 *
 * WHY THIS EXISTS
 * The scrape queue (scrapeQueue.ts: hotQueue/warmQueue/coldQueue + pendingItems) lives entirely in
 * the heap. Every restart drops it — a planned repin, a rollout, an OOM kill, a crash, the two-hour
 * browser relaunch going wrong. A rollout on 2026-09-08 lost ~130 in-flight items and every repin
 * drops the crawler's current batch (up to ~500). That is not a DELAY: the crawler advances its
 * backfill cursor AFTER enqueueing, so an item dropped from the queue is a COVERAGE HOLE that
 * nothing ever asks for again.
 *
 * WHAT IT IS
 * One SQLite file (WAL) opened through `node:sqlite`, which is BUILT IN on the Node this engine
 * requires (>= 24.15; the prod image runs 26) — so durability costs no new dependency, no new
 * service, and no new failure domain. `DatabaseSync` is synchronous by design, which is exactly what
 * the queue needs: enqueue/dispatch/complete are synchronous methods on ScrapeQueue and an async
 * store would have turned every one of them into a promise.
 *
 * WHAT IT IS NOT
 * It is not the queue's ordering authority. Priority lanes, per-host pacing, attempt counting and
 * retry classes all stay in scrapeQueue.ts, unchanged. This store only answers "what was in the
 * queue when the process died", so a restart can put it back.
 *
 * NEVER PERSISTED: cookies. `QueueItem.cookies` is documented "ephemeral, never stored", and there
 * is deliberately no column to write one into. Cookie-bearing items are session-bound — their
 * waiting HTTP callers die with the pod — so the queue keeps them memory-only and never calls
 * `put()` for them. Promise resolvers are likewise unpersistable and are not restored.
 *
 * FAIL-SAFE: if the directory is missing, unwritable, or the file is unusable, `createQueueStore`
 * logs ONE warning and returns a no-op store whose `durable` is false. The engine then behaves
 * EXACTLY as it does today (in-memory only). Losing durability must never block ingest, and must
 * never crash the process at boot.
 *
 * STATE MACHINE (`queue_items.state`)
 *   pending  — resident in an in-memory tier, awaiting dispatch
 *   leased   — dispatched to a worker, with an expiry (`lease_until`) so a crash mid-navigation
 *              cannot strand the item forever
 *   parked   — on disk ONLY, not resident. The bounded-working-set overflow: depth above the
 *              in-memory cap becomes a disk number instead of a heap number.
 * A completed / given-up / cancelled item's row is DELETED (the fetch_failure ledger already books
 * terminal failures via the ingest-server; this store is not a history).
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import * as fs from 'fs';
import * as path from 'path';
import { normalizeHost } from './challengeCooldown.js';
import { sanitizeForLog } from '../utils/security.js';
import type { QueuePriority, ItemStatus } from './scrapeQueue.js';

/** The default directory — the mount point the fc-infra `scraper-queue` PVC provides. */
export const DEFAULT_QUEUE_DIR = '/var/lib/scraper';
/** The db file name inside that directory. */
export const QUEUE_DB_FILE = 'scrape-queue.db';
/** Env var naming the directory. Absent/empty ⇒ DEFAULT_QUEUE_DIR. */
export const QUEUE_DIR_ENV = 'SCRAPE_QUEUE_DIR';

/** Where a row sits in its lifecycle. See the state machine in the file header. */
export type QueueItemState = 'pending' | 'leased' | 'parked';

/**
 * The persistable shape of a QueueItem — deliberately a SUBSET. No cookies (never stored), no
 * resolvers (a promise cannot be written to disk), no waitingUserIds (those callers' connections
 * died with the process that held them).
 */
export interface PersistedQueueItem {
  id: string;
  /** The queue's dedup key: an MFC item id, or the URL itself for trigger-route enqueues. */
  mfcId: string;
  url: string;
  priority: QueuePriority;
  status?: ItemStatus;
  /** Recorded for observability only — a restored item carries no cookies, so it is never HOT-by-session. */
  sessionId?: string;
  /** `QueueItem.retryCount` — how many attempts this item has already spent. */
  attempts: number;
  maxRetries: number;
  /** `QueueItem.queuedAt` (epoch ms). */
  enqueuedAt: number;
  state: QueueItemState;
  /** Epoch ms at which a lease expires. Only meaningful while state === 'leased'. */
  leaseUntil?: number;
  /** The last `ErrorType` this item failed with — enough to explain a restored item's attempt count. */
  lastErrorClass?: string;
}

/** A persisted per-host challenge cooldown (mirrors challengeCooldown.ts's CooldownEntry). */
export interface PersistedCooldown {
  host: string;
  until: number;
  reason: string;
  openedAt: number;
}

/** What a startup reconciliation found. */
export interface RestoredQueue {
  /** Rows that were resident and undispatched — reload these into the in-memory tiers. */
  pending: PersistedQueueItem[];
  /** Rows dispatched by the dead process whose lease has since expired — re-drive these too. */
  leasedExpired: PersistedQueueItem[];
  /** Unexpired leases left behind. Not reloaded now; `reapExpiredLeases` picks them up later. */
  stillLeased: number;
  /** Rows on disk only. Not lost — paged in as the in-memory working set drains. */
  parked: number;
  /** Cooldowns still open, so a restart does not immediately hammer a cooling host. */
  cooldowns: PersistedCooldown[];
}

export interface QueueCounts {
  pending: number;
  leased: number;
  parked: number;
}

export interface ScrapeQueueStore {
  /** False for the no-op fallback: nothing is persisted and the queue must not park anything. */
  readonly durable: boolean;
  /** The db file path, or null when running in the in-memory fallback. */
  readonly path: string | null;
  /** Run `fn` inside ONE transaction — the crawler's 50-per-store burst costs one commit, not 50. */
  batch<T>(fn: () => T): T;
  /** Insert a row. Idempotent on `id`: a re-put is a no-op, never an overwrite. */
  put(item: PersistedQueueItem): void;
  /** Mark dispatched, with an expiry so a crash mid-navigation cannot strand the item. */
  lease(id: string, leaseUntil: number): void;
  /** A retryable failure: back to pending, carrying the new attempt count and error class. */
  fail(id: string, attempts: number, errorClass?: string): void;
  /** Completed, given up, or cancelled — the row goes away. */
  remove(id: string): void;
  /** Move a resident row out of the working set without losing it. */
  park(id: string): void;
  /** Flip up to `limit` parked rows back to pending and return them, oldest first. */
  pageIn(limit: number, opts?: { skipHosts?: readonly string[] }): PersistedQueueItem[];
  /**
   * Whether ANY row (pending, leased or parked) holds this dedup key. The queue's dedup path asks
   * this instead of holding a Set of parked ids — the whole point of parking is that depth lives on
   * disk, so the answer must live there too.
   */
  hasKey(mfcId: string): boolean;
  /** Promote exactly the parked row with this dedup key, so a caller can be handed a real promise. */
  pageInKey(mfcId: string): PersistedQueueItem | null;
  /** Record a priority upgrade, so a restored item comes back at the priority it was raised to. */
  setPriority(id: string, priority: QueuePriority): void;
  /** Release EVERY lease back to pending. Called on SIGTERM so a planned rollout loses nothing. */
  releaseLeases(): number;
  /** Flip leases that expired on or before `now` back to pending and return them. */
  reapExpiredLeases(now: number): PersistedQueueItem[];
  saveCooldown(entry: PersistedCooldown): void;
  removeCooldown(host: string): void;
  /** Startup reconciliation. Also flips expired leases to pending and drops expired cooldowns. */
  restore(now: number): RestoredQueue;
  counts(): QueueCounts;
  /** Drop every row (the queue's emergency `clear()`). */
  clearAll(): void;
  close(): void;
}

// ============================================================================
// Schema
// ============================================================================

const SCHEMA = `
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
CREATE INDEX IF NOT EXISTS idx_queue_mfc   ON queue_items(mfc_id);
CREATE TABLE IF NOT EXISTS host_cooldowns (
  host      TEXT PRIMARY KEY,
  until     INTEGER NOT NULL,
  reason    TEXT NOT NULL,
  opened_at INTEGER NOT NULL
);
`;

/** The zero reading — what a closed or non-durable store reports. */
const NO_COUNTS: QueueCounts = { pending: 0, leased: 0, parked: 0 };

/** A sqlite row as node:sqlite hands it back (null-prototype, snake_case columns). */
interface ItemRow {
  id: string;
  mfc_id: string;
  url: string;
  priority: string;
  status: string | null;
  session_id: string | null;
  attempts: number;
  max_retries: number;
  enqueued_at: number;
  state: string;
  lease_until: number | null;
  last_error_class: string | null;
}

function rowToItem(row: ItemRow): PersistedQueueItem {
  return {
    id: row.id,
    mfcId: row.mfc_id,
    url: row.url,
    priority: row.priority as QueuePriority,
    ...(row.status !== null ? { status: row.status as ItemStatus } : {}),
    ...(row.session_id !== null ? { sessionId: row.session_id } : {}),
    attempts: row.attempts,
    maxRetries: row.max_retries,
    enqueuedAt: row.enqueued_at,
    state: row.state as QueueItemState,
    ...(row.lease_until !== null ? { leaseUntil: row.lease_until } : {}),
    ...(row.last_error_class !== null ? { lastErrorClass: row.last_error_class } : {}),
  };
}

/** The normalized host for a url, or null when the url will not parse (the column is nullable). */
function hostOf(url: string): string | null {
  try {
    return normalizeHost(new URL(url).hostname);
  } catch {
    return null;
  }
}

// ============================================================================
// The durable (SQLite) store
// ============================================================================

export interface OpenQueueStoreOptions {
  /** The directory to hold the db file. Default: SCRAPE_QUEUE_DIR, else /var/lib/scraper. */
  dir?: string;
  /** Injectable clock (tests). Only used where the store needs "now" without being told it. */
  now?: () => number;
}

/**
 * Open the durable store. THROWS if the directory is missing/unwritable or the file is unusable —
 * `createQueueStore` is the fail-safe wrapper every caller should use.
 */
export function openQueueStore(opts: OpenQueueStoreOptions = {}): ScrapeQueueStore {
  const dir = opts.dir ?? resolveQueueDir();
  // fsGroup 994 makes the PVC group-writable; this is the same check the crawler's ledger dir gets.
  fs.accessSync(dir, fs.constants.W_OK);
  const file = path.join(dir, QUEUE_DB_FILE);
  const db = new DatabaseSync(file);

  // WAL so a reader (a future ops query) never blocks the writer, and a crash mid-write recovers
  // from the log rather than tearing the page. synchronous=FULL fsyncs on every commit: at the
  // measured 520-620 enqueues/hour that is one fsync every ~6 seconds, which the brief's own sizing
  // calls affordable — and it is what makes "the row was written before the pod died" TRUE rather
  // than probable.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  // Any handle that survived the SCHEMA exec has a real, readable database behind it.
  db.prepare('SELECT COUNT(*) AS n FROM queue_items').get();

  const stmt = {
    put: db.prepare(
      `INSERT INTO queue_items
         (id, mfc_id, url, host, priority, status, session_id, attempts, max_retries, enqueued_at, state, lease_until, last_error_class)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO NOTHING`
    ),
    lease: db.prepare(`UPDATE queue_items SET state = 'leased', lease_until = ? WHERE id = ?`),
    fail: db.prepare(
      `UPDATE queue_items SET state = 'pending', lease_until = NULL, attempts = ?, last_error_class = ? WHERE id = ?`
    ),
    remove: db.prepare('DELETE FROM queue_items WHERE id = ?'),
    park: db.prepare(`UPDATE queue_items SET state = 'parked', lease_until = NULL WHERE id = ?`),
    selPending: db.prepare(`SELECT * FROM queue_items WHERE state = 'pending' ORDER BY enqueued_at ASC`),
    selLeasedExpired: db.prepare(
      `SELECT * FROM queue_items WHERE state = 'leased' AND lease_until <= ? ORDER BY enqueued_at ASC`
    ),
    freeLeasedExpired: db.prepare(
      `UPDATE queue_items SET state = 'pending', lease_until = NULL WHERE state = 'leased' AND lease_until <= ?`
    ),
    countStillLeased: db.prepare(
      `SELECT COUNT(*) AS n FROM queue_items WHERE state = 'leased' AND lease_until > ?`
    ),
    releaseAll: db.prepare(`UPDATE queue_items SET state = 'pending', lease_until = NULL WHERE state = 'leased'`),
    countByState: db.prepare('SELECT state, COUNT(*) AS n FROM queue_items GROUP BY state'),
    dupKeys: db.prepare(
      'SELECT mfc_id FROM queue_items GROUP BY mfc_id HAVING COUNT(*) > 1'
    ),
    dupLosers: db.prepare(
      `SELECT id FROM queue_items WHERE mfc_id = ?
       ORDER BY enqueued_at ASC, id ASC
       LIMIT -1 OFFSET 1`
    ),
    saveCooldown: db.prepare(
      `INSERT INTO host_cooldowns (host, until, reason, opened_at) VALUES (?,?,?,?)
       ON CONFLICT(host) DO UPDATE SET until = excluded.until, reason = excluded.reason, opened_at = excluded.opened_at`
    ),
    removeCooldown: db.prepare('DELETE FROM host_cooldowns WHERE host = ?'),
    selCooldowns: db.prepare('SELECT * FROM host_cooldowns WHERE until > ? ORDER BY until ASC'),
    dropExpiredCooldowns: db.prepare('DELETE FROM host_cooldowns WHERE until <= ?'),
    hasKey: db.prepare('SELECT 1 AS hit FROM queue_items WHERE mfc_id = ? LIMIT 1'),
    selParkedKey: db.prepare(`SELECT * FROM queue_items WHERE mfc_id = ? AND state = 'parked' ORDER BY enqueued_at ASC LIMIT 1`),
    setPriority: db.prepare('UPDATE queue_items SET priority = ? WHERE id = ?'),
    clearItems: db.prepare('DELETE FROM queue_items'),
  } satisfies Record<string, StatementSync>;

  /**
   * Shutdown guard. SIGTERM tears the process down in stages (plugins, cookie poller, raw-capture
   * flush, browser pool) and the queue can still be running when the store closes, so every method
   * degrades to a no-op afterwards rather than throwing "statement has been finalized" into the
   * middle of a shutdown. `close()` is therefore also idempotent.
   */
  let closed = false;

  // Transaction depth — `batch` is re-entrant (an outer batch keeps ONE commit).
  let depth = 0;
  const batch = <T>(fn: () => T): T => {
    if (closed || depth > 0) return fn();
    depth = 1;
    db.exec('BEGIN');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* the transaction is already gone */
      }
      throw error;
    } finally {
      depth = 0;
    }
  };

  const pageInStmt = (limit: number, skipHosts: readonly string[]): PersistedQueueItem[] => {
    // A host already at its in-memory cap is skipped IN SQL, so a capped host's backlog never
    // consumes the page-in budget only to be re-parked.
    const placeholders = skipHosts.map(() => '?').join(',');
    const where = skipHosts.length
      ? `state = 'parked' AND (host IS NULL OR host NOT IN (${placeholders}))`
      : `state = 'parked'`;
    const rows = db
      .prepare(`SELECT * FROM queue_items WHERE ${where} ORDER BY enqueued_at ASC LIMIT ?`)
      .all(...skipHosts, limit) as unknown as ItemRow[];
    if (rows.length === 0) return [];
    return batch(() => {
      for (const row of rows) stmt.fail.run(row.attempts, row.last_error_class, row.id);
      return rows.map((r) => ({ ...rowToItem(r), state: 'pending' as const }));
    });
  };

  return {
    durable: true,
    path: file,
    batch,

    put(item: PersistedQueueItem): void {
      if (closed) return;
      stmt.put.run(
        item.id,
        item.mfcId,
        item.url,
        hostOf(item.url),
        item.priority,
        item.status ?? null,
        item.sessionId ?? null,
        item.attempts,
        item.maxRetries,
        item.enqueuedAt,
        item.state,
        item.leaseUntil ?? null,
        item.lastErrorClass ?? null
      );
    },

    lease(id: string, leaseUntil: number): void {
      if (closed) return;
      stmt.lease.run(leaseUntil, id);
    },

    fail(id: string, attempts: number, errorClass?: string): void {
      if (closed) return;
      stmt.fail.run(attempts, errorClass ?? null, id);
    },

    remove(id: string): void {
      if (closed) return;
      stmt.remove.run(id);
    },

    park(id: string): void {
      if (closed) return;
      stmt.park.run(id);
    },

    pageIn(limit: number, opts?: { skipHosts?: readonly string[] }): PersistedQueueItem[] {
      if (closed || limit <= 0) return [];
      return pageInStmt(limit, opts?.skipHosts ?? []);
    },

    hasKey(mfcId: string): boolean {
      if (closed) return false;
      return stmt.hasKey.get(mfcId) !== undefined;
    },

    pageInKey(mfcId: string): PersistedQueueItem | null {
      if (closed) return null;
      const row = stmt.selParkedKey.get(mfcId) as unknown as ItemRow | undefined;
      if (row === undefined) return null;
      stmt.fail.run(row.attempts, row.last_error_class, row.id);
      return { ...rowToItem(row), state: 'pending' as const };
    },

    setPriority(id: string, priority: QueuePriority): void {
      if (closed) return;
      stmt.setPriority.run(priority, id);
    },

    releaseLeases(): number {
      if (closed) return 0;
      const res = stmt.releaseAll.run();
      return Number(res.changes);
    },

    reapExpiredLeases(now: number): PersistedQueueItem[] {
      if (closed) return [];
      return batch(() => {
        const rows = stmt.selLeasedExpired.all(now) as unknown as ItemRow[];
        if (rows.length === 0) return [];
        stmt.freeLeasedExpired.run(now);
        return rows.map((r) => ({ ...rowToItem(r), state: 'pending' as const, leaseUntil: undefined }));
      });
    },

    saveCooldown(entry: PersistedCooldown): void {
      if (closed) return;
      stmt.saveCooldown.run(normalizeHost(entry.host), entry.until, entry.reason, entry.openedAt);
    },

    removeCooldown(host: string): void {
      if (closed) return;
      stmt.removeCooldown.run(normalizeHost(host));
    },

    restore(now: number): RestoredQueue {
      if (closed) return { pending: [], leasedExpired: [], stillLeased: 0, parked: 0, cooldowns: [] };
      return batch(() => {
        // A restart can only ever hold ONE live item per dedup key, so a second row for the same key
        // is debris from a crash that raced a re-enqueue. Keep the earliest and DELETE the rest —
        // filtering alone would leave the loser as a pending row nothing will ever dispatch.
        for (const dup of stmt.dupKeys.all() as unknown as Array<{ mfc_id: string }>) {
          for (const loser of stmt.dupLosers.all(dup.mfc_id) as unknown as Array<{ id: string }>) {
            stmt.remove.run(loser.id);
          }
        }
        const leasedExpiredRows = stmt.selLeasedExpired.all(now) as unknown as ItemRow[];
        stmt.freeLeasedExpired.run(now);
        // Read pending AFTER freeing expired leases would double-count them, so read it first and
        // report the two groups separately (the log line names both).
        const pendingRows = (stmt.selPending.all() as unknown as ItemRow[]).filter(
          (r) => !leasedExpiredRows.some((l) => l.id === r.id)
        );
        const stillLeased = Number(
          (stmt.countStillLeased.get(now) as unknown as { n: number }).n
        );
        const byState = stmt.countByState.all() as unknown as Array<{ state: string; n: number }>;
        const parked = Number(byState.find((r) => r.state === 'parked')?.n ?? 0);

        const cooldownRows = stmt.selCooldowns.all(now) as unknown as Array<{
          host: string;
          until: number;
          reason: string;
          opened_at: number;
        }>;
        stmt.dropExpiredCooldowns.run(now);

        return {
          pending: pendingRows.map(rowToItem),
          leasedExpired: leasedExpiredRows.map((r) => ({
            ...rowToItem(r),
            state: 'pending' as const,
            leaseUntil: undefined,
          })),
          stillLeased,
          parked,
          cooldowns: cooldownRows.map((c) => ({
            host: c.host,
            until: c.until,
            reason: c.reason,
            openedAt: c.opened_at,
          })),
        };
      });
    },

    counts(): QueueCounts {
      if (closed) return { ...NO_COUNTS };
      const rows = stmt.countByState.all() as unknown as Array<{ state: string; n: number }>;
      const of = (s: string): number => Number(rows.find((r) => r.state === s)?.n ?? 0);
      return { pending: of('pending'), leased: of('leased'), parked: of('parked') };
    },

    clearAll(): void {
      if (closed) return;
      stmt.clearItems.run();
    },

    close(): void {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}

// ============================================================================
// The in-memory fallback — the engine's behaviour EXACTLY as it is today
// ============================================================================

/**
 * A store that persists nothing. Every method is a safe no-op and `durable` is false — which the
 * queue reads as "never park anything", because parking without a disk behind it would DELETE items.
 */
export function createMemoryQueueStore(): ScrapeQueueStore {
  return {
    durable: false,
    path: null,
    batch: <T>(fn: () => T): T => fn(),
    put: () => {},
    lease: () => {},
    fail: () => {},
    remove: () => {},
    park: () => {},
    pageIn: () => [],
    hasKey: () => false,
    pageInKey: () => null,
    setPriority: () => {},
    releaseLeases: () => 0,
    reapExpiredLeases: () => [],
    saveCooldown: () => {},
    removeCooldown: () => {},
    restore: () => ({ pending: [], leasedExpired: [], stillLeased: 0, parked: 0, cooldowns: [] }),
    counts: () => ({ ...NO_COUNTS }),
    clearAll: () => {},
    close: () => {},
  };
}

/** The configured directory: SCRAPE_QUEUE_DIR when set and non-blank, else /var/lib/scraper. */
export function resolveQueueDir(): string {
  const raw = process.env[QUEUE_DIR_ENV];
  return raw !== undefined && raw.trim() !== '' ? raw.trim() : DEFAULT_QUEUE_DIR;
}

/**
 * THE constructor every caller should use. Opens the durable store when it can; on ANY failure
 * (directory absent, not writable, file corrupt, sqlite unavailable) logs ONE warning naming the
 * path and returns the in-memory fallback.
 *
 * Losing durability is a degradation, never an outage: the engine keeps taking work exactly as it
 * does today, and the operator sees one line saying why the queue is not durable.
 */
export function createQueueStore(opts: OpenQueueStoreOptions = {}): ScrapeQueueStore {
  const dir = opts.dir ?? resolveQueueDir();
  try {
    return openQueueStore({ ...opts, dir });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(
      `[SCRAPE QUEUE] durable queue unavailable at ${sanitizeForLog(dir)} (${sanitizeForLog(reason)}) — ` +
        'running in-memory; a restart will drop queued items'
    );
    return createMemoryQueueStore();
  }
}
