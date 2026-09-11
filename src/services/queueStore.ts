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
 * WHY the store is in the state it is — the single field an operator reads to tell a deliberate
 * configuration from a silent failure. `durable:false` on its own is ambiguous: the intended
 * intermediate state while the engine ships ahead of its PVC looks exactly like a permissions bug.
 *
 *   ok                    — durable and healthy
 *   disabled              — SCRAPE_QUEUE_DIR explicitly blanked or set to `off` (dev / CI)
 *   dir_missing           — the directory does not exist: the PVC is not mounted yet
 *   not_writable          — the directory exists but this uid/gid cannot write it (fsGroup mismatch)
 *   open_failed           — SQLite could not open or create the file, and the retry also failed
 *   open_failed_recovered — the file was unusable, was moved ASIDE (never deleted), and a fresh
 *                           store was opened; readable rows were carried over. STILL DURABLE.
 *   write_failed          — a write failed at runtime (a full disk, a revoked mount). The store
 *                           degrades to in-memory for the rest of the process life and keeps serving.
 */
export type QueueStoreReason =
  | 'ok'
  | 'disabled'
  | 'dir_missing'
  | 'not_writable'
  | 'open_failed'
  | 'open_failed_recovered'
  | 'write_failed';

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
  /**
   * False for the no-op fallback: nothing is persisted and the queue must not park anything. Can flip
   * from true to false at RUNTIME if a write fails (see `write_failed`), so read it, never cache it.
   */
  readonly durable: boolean;
  /** WHY `durable` reads the way it does. 'ok' whenever the store is healthy and persisting. */
  readonly reason: QueueStoreReason;
  /**
   * The db file we are using, or ATTEMPTED to use. Null ONLY when deliberately disabled — an
   * operator diagnosing `dir_missing` or `not_writable` needs to know which path was tried.
   */
  readonly path: string | null;
  /**
   * Rows that were in a quarantined file and could NOT be carried into the fresh store. 0 in every
   * normal case, including a clean recovery. Non-zero is an alarm: that many queued items are only
   * in `quarantinedPath` now.
   */
  readonly lostAtStartup: number;
  /** Where an unusable file was moved aside to. Null unless reason is `open_failed_recovered`. */
  readonly quarantinedPath: string | null;
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
  /**
   * Hard ceiling on the db file in SQLite pages (`PRAGMA max_page_count`). A genuine safety valve on
   * a 1Gi PVC — the queue must never be the thing that fills the volume the queue lives on — and the
   * deterministic way to exercise the `write_failed` path: past the ceiling SQLite raises
   * "database or disk is full", exactly as a full filesystem does.
   */
  maxPageCount?: number;
  /** Reason to report when the open succeeded after a quarantine. Default 'ok'. */
  reason?: QueueStoreReason;
  /** Where an unusable file was moved aside to (reported on /health/detailed). */
  quarantinedPath?: string | null;
  /** Rows a quarantined file held that could not be carried over. */
  lostAtStartup?: number;
}

/**
 * Open the durable store. THROWS if the directory is missing/unwritable or the file is unusable —
 * `createQueueStore` is the fail-safe wrapper every caller should use.
 */
export function openQueueStore(opts: OpenQueueStoreOptions = {}): ScrapeQueueStore {
  const dir = opts.dir ?? resolveQueueDir() ?? DEFAULT_QUEUE_DIR;
  const file = path.join(dir, QUEUE_DB_FILE);
  const db = new DatabaseSync(file);

  try {
    // WAL so a reader (a future ops query) never blocks the writer, and a crash mid-write recovers
    // from the log rather than tearing the page. synchronous=FULL fsyncs on every commit: at the
    // measured 520-620 enqueues/hour that is one fsync every ~6 seconds, which the sizing calls
    // affordable — and it is what makes "the row was written before the pod died" TRUE rather than
    // probable.
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = FULL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(SCHEMA);
    // Any handle that survived the SCHEMA exec has a real, readable database behind it.
    db.prepare('SELECT COUNT(*) AS n FROM queue_items').get();
    // PROVE IT IS WRITABLE, not merely openable. A database that has lost its write permission opens
    // cleanly and passes every statement above — `CREATE TABLE IF NOT EXISTS` short-circuits on
    // tables that already exist — and then throws on the FIRST real write, which is the boot
    // reconciliation. Failing here instead routes it to quarantine + salvage, where it belongs.
    // (`BEGIN IMMEDIATE` is not enough: SQLite defers the readonly error until a page is touched.)
    db.exec('PRAGMA user_version = 1');
    // Applied AFTER the schema so creating the tables is never itself refused by the ceiling.
    if (opts.maxPageCount !== undefined) db.exec(`PRAGMA max_page_count = ${Number(opts.maxPageCount)}`);
  } catch (error) {
    // NEVER leak the handle: it holds the -wal/-shm sidecars open, and a caller that goes on to move
    // the file aside would leave a live mapping pointing at the old inode — the fresh database then
    // inherits it and fails on its first write.
    try {
      db.close();
    } catch {
      /* nothing useful to do with a handle we are already abandoning */
    }
    throw error;
  }

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

  /**
   * RUNTIME degradation. A write can start failing long after a healthy open — a full disk, a mount
   * revoked under us. The queue must keep taking work regardless, so the first write fault flips the
   * store to in-memory behaviour for the rest of the process life and says so ONCE.
   *
   * WRITES become no-ops; READS stay live. That combination is deliberate: rows already on disk are
   * NOT lost (the file is intact, only writing failed), so leaving the counts readable keeps
   * /health/detailed telling the truth about what is waiting there for the next process to reconcile.
   * Meanwhile `durable:false` stops the queue parking anything new, which would be unrecoverable.
   */
  let degraded = false;
  let reason: QueueStoreReason = opts.reason ?? 'ok';
  const degrade = (error: unknown): void => {
    if (degraded) return;
    degraded = true;
    reason = 'write_failed';
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(
      `[SCRAPE QUEUE] queue store NOT durable: write_failed (${sanitizeForLog(file)}) — ` +
        `${sanitizeForLog(detail)}; continuing in-memory for the rest of this process`
    );
  };
  /** Run a write; a store fault degrades instead of escaping into the queue. Never throws. */
  const write = (fn: () => void): void => {
    if (closed || degraded) return;
    try {
      fn();
    } catch (error) {
      degrade(error);
    }
  };
  /** Run a read; a fault yields the caller's fallback rather than throwing mid-dispatch. */
  const read = <T>(fn: () => T, fallback: T): T => {
    if (closed) return fallback;
    try {
      return fn();
    } catch {
      return fallback;
    }
  };

  // Transaction depth — `batch` is re-entrant (an outer batch keeps ONE commit).
  let depth = 0;
  const batch = <T>(fn: () => T): T => {
    if (closed || degraded || depth > 0) return fn();
    try {
      db.exec('BEGIN');
    } catch (error) {
      // Nothing has run yet, so degrading and running the body un-transacted is safe: every write
      // inside it is now a no-op. A queue must never fail an enqueue because a transaction would not open.
      degrade(error);
      return fn();
    }
    depth = 1;
    try {
      const out = fn();
      try {
        db.exec('COMMIT');
      } catch (error) {
        // The commit is where a full disk usually announces itself. Roll back, degrade, and still
        // return: the caller's in-memory state stands, only its durability is gone.
        try {
          db.exec('ROLLBACK');
        } catch {
          /* the transaction is already gone */
        }
        degrade(error);
      }
      return out;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* the transaction is already gone */
      }
      // A fault thrown by the BODY is the caller's, not the store's — it still propagates, and the
      // transaction is all-or-nothing around it.
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
    const rows = read(
      () =>
        db
          .prepare(`SELECT * FROM queue_items WHERE ${where} ORDER BY enqueued_at ASC LIMIT ?`)
          .all(...skipHosts, limit) as unknown as ItemRow[],
      [] as ItemRow[]
    );
    if (rows.length === 0) return [];
    return batch(() => {
      for (const row of rows) write(() => stmt.fail.run(row.attempts, row.last_error_class, row.id));
      return rows.map((r) => ({ ...rowToItem(r), state: 'pending' as const }));
    });
  };

  return {
    // Getters, not constants: `durable` and `reason` change if a write fails at runtime, and a caller
    // that cached them would keep parking items into a store that is no longer writing.
    get durable(): boolean {
      return !degraded;
    },
    get reason(): QueueStoreReason {
      return reason;
    },
    path: file,
    quarantinedPath: opts.quarantinedPath ?? null,
    lostAtStartup: opts.lostAtStartup ?? 0,
    batch,

    put(item: PersistedQueueItem): void {
      write(() =>
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
      ));
    },

    lease(id: string, leaseUntil: number): void {
      write(() => stmt.lease.run(leaseUntil, id));
    },

    fail(id: string, attempts: number, errorClass?: string): void {
      write(() => stmt.fail.run(attempts, errorClass ?? null, id));
    },

    remove(id: string): void {
      write(() => stmt.remove.run(id));
    },

    park(id: string): void {
      write(() => stmt.park.run(id));
    },

    pageIn(limit: number, opts?: { skipHosts?: readonly string[] }): PersistedQueueItem[] {
      if (closed || limit <= 0) return [];
      return pageInStmt(limit, opts?.skipHosts ?? []);
    },

    hasKey(mfcId: string): boolean {
      return read(() => stmt.hasKey.get(mfcId) !== undefined, false);
    },

    pageInKey(mfcId: string): PersistedQueueItem | null {
      const row = read(() => stmt.selParkedKey.get(mfcId) as unknown as ItemRow | undefined, undefined);
      if (row === undefined) return null;
      write(() => stmt.fail.run(row.attempts, row.last_error_class, row.id));
      return { ...rowToItem(row), state: 'pending' as const };
    },

    setPriority(id: string, priority: QueuePriority): void {
      write(() => stmt.setPriority.run(priority, id));
    },

    releaseLeases(): number {
      let released = 0;
      write(() => {
        released = Number(stmt.releaseAll.run().changes);
      });
      return released;
    },

    reapExpiredLeases(now: number): PersistedQueueItem[] {
      if (closed || degraded) return [];
      return batch(() => {
        const rows = read(() => stmt.selLeasedExpired.all(now) as unknown as ItemRow[], [] as ItemRow[]);
        if (rows.length === 0) return [];
        write(() => stmt.freeLeasedExpired.run(now));
        return rows.map((r) => ({ ...rowToItem(r), state: 'pending' as const, leaseUntil: undefined }));
      });
    },

    saveCooldown(entry: PersistedCooldown): void {
      write(() => stmt.saveCooldown.run(normalizeHost(entry.host), entry.until, entry.reason, entry.openedAt));
    },

    removeCooldown(host: string): void {
      write(() => stmt.removeCooldown.run(normalizeHost(host)));
    },

    restore(now: number): RestoredQueue {
      if (closed || degraded) return { pending: [], leasedExpired: [], stillLeased: 0, parked: 0, cooldowns: [] };
      return batch(() => {
        // A restart can only ever hold ONE live item per dedup key, so a second row for the same key
        // is debris from a crash that raced a re-enqueue. Keep the earliest and DELETE the rest —
        // filtering alone would leave the loser as a pending row nothing will ever dispatch.
        for (const dup of stmt.dupKeys.all() as unknown as Array<{ mfc_id: string }>) {
          for (const loser of stmt.dupLosers.all(dup.mfc_id) as unknown as Array<{ id: string }>) {
            write(() => stmt.remove.run(loser.id));
          }
        }
        const leasedExpiredRows = stmt.selLeasedExpired.all(now) as unknown as ItemRow[];
        write(() => stmt.freeLeasedExpired.run(now));
        // Read pending AFTER freeing expired leases would double-count them, so read it first and
        // report the two groups separately (the log line names both).
        const pendingRows = (stmt.selPending.all() as unknown as ItemRow[]).filter(
          (r) => !leasedExpiredRows.some((l) => l.id === r.id)
        );
        const stillLeased = read(
          () => Number((stmt.countStillLeased.get(now) as unknown as { n: number }).n),
          0
        );
        const byState = read(
          () => stmt.countByState.all() as unknown as Array<{ state: string; n: number }>,
          [] as Array<{ state: string; n: number }>
        );
        const parked = Number(byState.find((r) => r.state === 'parked')?.n ?? 0);

        const cooldownRows = stmt.selCooldowns.all(now) as unknown as Array<{
          host: string;
          until: number;
          reason: string;
          opened_at: number;
        }>;
        write(() => stmt.dropExpiredCooldowns.run(now));

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
      // Stays LIVE after a write degradation on purpose: those rows are still on disk waiting for the
      // next process, and zeroing the reading would hide exactly what the operator needs to see.
      return read(() => {
        const rows = stmt.countByState.all() as unknown as Array<{ state: string; n: number }>;
        const of = (st: string): number => Number(rows.find((r) => r.state === st)?.n ?? 0);
        return { pending: of('pending'), leased: of('leased'), parked: of('parked') };
      }, { ...NO_COUNTS });
    },

    clearAll(): void {
      write(() => stmt.clearItems.run());
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
 *
 * `reason` says WHY, and `path` names the file that WOULD have been used, so an operator can tell the
 * intended intermediate state (the engine shipped ahead of its PVC → `dir_missing`) from a real fault
 * (`not_writable`, `open_failed`) without reading pod logs.
 */
export function createMemoryQueueStore(
  reason: QueueStoreReason = 'disabled',
  attemptedPath: string | null = null
): ScrapeQueueStore {
  return {
    durable: false,
    reason,
    path: attemptedPath,
    quarantinedPath: null,
    lostAtStartup: 0,
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

/** Values that switch the store OFF outright (dev / CI), case-insensitive. */
const DISABLED_VALUES = new Set(['off', 'false', '0', 'none', 'disabled']);

/**
 * The configured directory, or null when durability is deliberately OFF.
 *
 * UNSET means "not configured, use the default" → /var/lib/scraper. EXPLICITLY BLANK (or `off`) means
 * "turn it off" → null. The two are deliberately different: an unset variable in production is a
 * manifest that has not caught up yet and should still try the standard mount, while a blank one is
 * a developer saying they do not want a file on disk.
 */
export function resolveQueueDir(): string | null {
  const raw = process.env[QUEUE_DIR_ENV];
  if (raw === undefined) return DEFAULT_QUEUE_DIR;
  const trimmed = raw.trim();
  if (trimmed === '' || DISABLED_VALUES.has(trimmed.toLowerCase())) return null;
  return trimmed;
}

/** The greppable one-liner a fleet check keys on. Exactly one per process. */
function warnNotDurable(reason: QueueStoreReason, attemptedPath: string, detail?: string): void {
  console.warn(
    `[SCRAPE QUEUE] queue store NOT durable: ${reason} (${sanitizeForLog(attemptedPath)})` +
      (detail !== undefined ? ` — ${sanitizeForLog(detail)}` : '')
  );
}

/**
 * Move an unusable db file (and its WAL sidecars) aside under a timestamped name. NEVER deletes:
 * those bytes are the only copy of whatever was queued, and an operator may be able to salvage them
 * by hand even when SQLite will not open them here. Returns the new path, or null if it could not be
 * moved (in which case the caller falls back to in-memory rather than fighting the filesystem).
 */
function quarantine(file: string, stamp: string): string | null {
  const target = `${file}.corrupt-${stamp}`;
  try {
    fs.renameSync(file, target);
  } catch {
    return null;
  }
  // -wal / -shm are part of the same corruption; leaving them would poison the fresh file.
  for (const suffix of ['-wal', '-shm']) {
    try {
      fs.renameSync(`${file}${suffix}`, `${target}${suffix}`);
    } catch {
      // Absent (the common case) or unmovable — neither is worth failing the recovery over.
    }
  }
  return target;
}

/**
 * Best-effort salvage from a quarantined file into the fresh store.
 *
 * This is not a formality: the FIRST open fails on a WRITE (the journal-mode pragma, the schema exec,
 * a bad `-wal`), so a file whose main database is perfectly readable can still land here. Opening it
 * READ-ONLY often gets every row back. Leased rows come over as pending — no process holds them now.
 *
 * Returns what was carried and what was left behind. A file that cannot be read at all yields
 * {carried: 0, lost: 0}: there is nothing to enumerate, and `quarantinedPath` is what the operator
 * follows instead.
 */
function salvage(quarantinedPath: string, into: ScrapeQueueStore): { carried: number; lost: number } {
  let rows: ItemRow[] = [];
  let cooldowns: Array<{ host: string; until: number; reason: string; opened_at: number }> = [];
  try {
    const old = new DatabaseSync(quarantinedPath, { readOnly: true });
    try {
      rows = old.prepare('SELECT * FROM queue_items').all() as unknown as ItemRow[];
      try {
        cooldowns = old.prepare('SELECT * FROM host_cooldowns').all() as unknown as typeof cooldowns;
      } catch {
        // A missing / unreadable cooldown table must not cost us the items.
      }
    } finally {
      old.close();
    }
  } catch {
    return { carried: 0, lost: 0 };
  }
  into.batch(() => {
    for (const row of rows) {
      const item = rowToItem(row);
      // Nothing holds a lease across a process boundary, so an in-flight row comes back drivable.
      into.put({ ...item, state: item.state === 'leased' ? 'pending' : item.state, leaseUntil: undefined });
    }
    for (const c of cooldowns) {
      into.saveCooldown({ host: c.host, until: c.until, reason: c.reason, openedAt: c.opened_at });
    }
  });
  const after = into.counts();
  const carried = after.pending + after.leased + after.parked;
  return { carried, lost: Math.max(0, rows.length - carried) };
}

/**
 * THE constructor every caller should use. Walks an explicit decision tree so that "not durable" is
 * never a shrug — every outcome has a named reason, a path, and exactly one greppable warning line:
 *
 *   [SCRAPE QUEUE] queue store NOT durable: <reason> (<path>)
 *
 *   disabled      — SCRAPE_QUEUE_DIR explicitly blank or `off`. Deliberate (dev / CI); no warning.
 *   dir_missing   — the directory is not there. THE INTENDED INTERMEDIATE STATE while the engine
 *                   ships ahead of its PVC, and the reason this must be distinguishable from a fault.
 *   not_writable  — the directory exists but this process cannot write it. The check is
 *                   `fs.accessSync(dir, W_OK)`, which tests the process's EFFECTIVE uid/gid against
 *                   the directory mode. Under the scraper's `fsGroup: 994`, Kubernetes chgrps the
 *                   volume to gid 994 and sets it group-writable while the container runs as
 *                   994:994, so this passes. A mount that arrives owned by root with mode 0755 — an
 *                   fsGroup that was dropped or never applied — is exactly what fails here.
 *   open_failed / open_failed_recovered — SQLite refused the file. It is moved ASIDE (never deleted),
 *                   a fresh store is opened, and readable rows are salvaged into it.
 *
 * NOTE: a pod rescheduled onto a node where the local-path claim cannot attach never reaches this
 * code at all — it stays Pending and the container never starts. That is a scheduling signal, visible
 * in `kubectl describe pod`, NOT a `durable:false` reading.
 *
 * Losing durability is a degradation, never an outage: the engine keeps taking work exactly as it
 * does today, and the operator sees one line saying why.
 */
export function createQueueStore(opts: OpenQueueStoreOptions = {}): ScrapeQueueStore {
  const dir = opts.dir ?? resolveQueueDir();
  if (dir === null) {
    // Deliberate. Not a warning — an operator who switched it off does not need to be told twice.
    console.log(`[SCRAPE QUEUE] queue store disabled (${QUEUE_DIR_ENV} is off) — running in-memory`);
    return createMemoryQueueStore('disabled', null);
  }
  const file = path.join(dir, QUEUE_DB_FILE);

  // (1) dir_missing — the PVC is not mounted yet.
  if (!fs.existsSync(dir)) {
    warnNotDurable('dir_missing', file, 'the directory does not exist (PVC not mounted?)');
    return createMemoryQueueStore('dir_missing', file);
  }

  // (2) not_writable — the mount is there but this uid/gid cannot write it (fsGroup mismatch).
  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch {
    warnNotDurable('not_writable', file, `uid ${process.getuid?.() ?? '?'} cannot write the directory`);
    return createMemoryQueueStore('not_writable', file);
  }

  // (3) the happy path.
  try {
    return openQueueStore({ ...opts, dir });
  } catch (openError) {
    // (4) open_failed — quarantine, retry, salvage. Nothing is ever deleted.
    // The injected clock, so a test can pin the quarantine name and exercise a rename that fails.
    const stamp = new Date(opts.now?.() ?? Date.now()).toISOString().replace(/[:.]/g, '-');
    const quarantinedPath = fs.existsSync(file) ? quarantine(file, stamp) : null;
    if (quarantinedPath !== null) {
      try {
        // Salvage through a first handle, then CLOSE it and reopen, so the store we hand back reports
        // the MEASURED lostAtStartup rather than the zero we would have had to guess at open time.
        const probe = openQueueStore({ ...opts, dir, reason: 'open_failed_recovered', quarantinedPath });
        let carried = 0;
        let lost = 0;
        try {
          ({ carried, lost } = salvage(quarantinedPath, probe));
        } finally {
          probe.close();
        }
        console.warn(
          `[SCRAPE QUEUE] queue store recovered: moved an unusable file aside to ` +
            `${sanitizeForLog(quarantinedPath)} and opened a fresh one — ` +
            `${carried} item(s) carried over, ${lost} lost`
        );
        return openQueueStore({ ...opts, dir, reason: 'open_failed_recovered', quarantinedPath, lostAtStartup: lost });
      } catch {
        // The fresh open failed too — the directory itself is the problem, not the file.
      }
    }
    const detail = openError instanceof Error ? openError.message : String(openError);
    warnNotDurable('open_failed', file, detail);
    return createMemoryQueueStore('open_failed', file);
  }
}
