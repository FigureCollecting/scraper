/**
 * budget — how many requests a diagnostic probe may send (hands-off plan unit S1).
 *
 * A diag probe is the one way the engine contacts a hands-off host on demand, so its request count
 * is the safety property. Two caps bound every call:
 *   - PER CALL: min(requested, the probe's hard maximum) — robots-snapshot 1, item-status 2 — and
 *     never more than the host has left;
 *   - PER HOST: DIAG_HOST_DAILY_CAP requests (default 6) in any rolling 24 h.
 *
 * CHARGED BEFORE DISPATCH, NEVER REFUNDED. `charge()` writes one row and returns true before the
 * caller sends the request; a request that then fails still counts. A crash between the charge and
 * the send leaves a request counted that was never sent, which is the safe direction.
 *
 * PERSISTED in table `diag_budget` of the queue sqlite (<SCRAPE_QUEUE_DIR>/scrape-queue.db), through
 * this module's own connection, so a restart does not reset the window. The check and the insert are
 * ONE statement, so no other connection or process can charge in between: concurrent calls cannot
 * overspend. A storage error throws from `charge()`; the caller must then not dispatch.
 *
 * Open this AFTER createQueueStore: a queue file found unusable at boot is moved aside, and a handle
 * opened before that would point at the old file.
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import * as path from 'path';
import { normalizeHost } from '../services/challengeCooldown.js';
import { QUEUE_DB_FILE, QUEUE_DIR_ENV, resolveQueueDir } from '../services/queueStore.js';
import { sanitizeForLog } from '../utils/security.js';
import { Probe } from '../gen/fc/diag/v1/diag_pb.js';

/** Env naming the per-host rolling 24 h request cap. */
export const DIAG_HOST_DAILY_CAP_ENV = 'DIAG_HOST_DAILY_CAP';
/** The per-host cap when DIAG_HOST_DAILY_CAP is unset. */
export const DEFAULT_DIAG_HOST_DAILY_CAP = 6;
/** The rolling window: a charge stops counting exactly this long after it was made. */
export const DIAG_BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000;
/** How long a charge waits for another connection's write lock before it throws. */
const BUSY_TIMEOUT_MS = 2_000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS diag_budget (
  id     INTEGER PRIMARY KEY,
  host   TEXT    NOT NULL,
  at     INTEGER NOT NULL,
  probe  TEXT    NOT NULL,
  run_id TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_diag_budget_host_at ON diag_budget(host, at);
`;

/** The most requests one call of `probe` may send. Throws for UNSPECIFIED or an unknown value. */
export function probeMaxRequests(probe: Probe): number {
  switch (probe) {
    case Probe.ROBOTS_SNAPSHOT:
      return 1;
    case Probe.ITEM_STATUS:
      return 2;
    default:
      throw new RangeError(`diag budget: no request maximum for probe ${String(probe)}`);
  }
}

/**
 * DIAG_HOST_DAILY_CAP as a number. Unset = the default. Anything but a plain non-negative integer
 * (digits only, no sign, no leading zero, no whitespace) is fatal and names the variable: a cap
 * nobody can read must stop the boot, never fall back to a guess.
 */
export function resolveHostDailyCap(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[DIAG_HOST_DAILY_CAP_ENV];
  if (raw === undefined) return DEFAULT_DIAG_HOST_DAILY_CAP;
  const n = Number(raw);
  if (!/^(0|[1-9][0-9]*)$/.test(raw) || !Number.isSafeInteger(n)) {
    throw new Error(`${DIAG_HOST_DAILY_CAP_ENV} must be a non-negative integer, got '${sanitizeForLog(raw)}'`);
  }
  return n;
}

/** Why a call was granted no request. */
export type DiagRefusal = 'host-cap' | 'none-requested';

/** One probe call's share of the budget. */
export interface DiagCallBudget {
  /** The normalised host every charge is booked against. */
  readonly host: string;
  /** The per-call cap: min(requested, probe maximum, the host's remaining budget at start). */
  readonly granted: number;
  /** Why `granted` is 0, or null when it is not. */
  readonly refusal: DiagRefusal | null;
  /** Requests this call has charged so far. */
  readonly spent: number;
  /**
   * Charge ONE request, BEFORE dispatching it. True = it is booked and on disk: send it. False =
   * nothing was booked (this call's grant is used up, or another call took the host's last request):
   * do not send. Throws on a storage error: do not send.
   */
  charge(): boolean;
}

export interface DiagCallRequest {
  probe: Probe;
  host: string;
  /** The caller's own limit (RunProbeRequest.max_requests). Absent = the probe maximum. */
  requested?: number;
  runId: string;
}

export interface DiagBudget {
  readonly hostDailyCap: number;
  /** Requests `host` has left in the current rolling window. */
  remaining(host: string): number;
  /** Start a call. Charges nothing; see DiagCallBudget.charge. */
  startCall(req: DiagCallRequest): DiagCallBudget;
  close(): void;
}

export interface OpenDiagBudgetOptions {
  /**
   * The queue directory. Default: SCRAPE_QUEUE_DIR, else /var/lib/scraper. A SCRAPE_QUEUE_DIR that
   * switches the queue sqlite off (blank or `off`) refuses the open: the budget must persist.
   */
  dir?: string;
  /** Default: DIAG_HOST_DAILY_CAP (resolveHostDailyCap). */
  hostDailyCap?: number;
  /** Injectable clock (tests). */
  now?: () => number;
}

function hostKey(host: string): string {
  const key = normalizeHost(host);
  if (key === '') throw new RangeError('diag budget: host must not be empty');
  return key;
}

/**
 * Open the budget on the queue sqlite. Throws if the file cannot be opened or the table created;
 * the caller then treats diag as unavailable (fail closed), never as unbudgeted.
 */
export function openDiagBudget(opts: OpenDiagBudgetOptions = {}): DiagBudget {
  const hostDailyCap = opts.hostDailyCap ?? resolveHostDailyCap();
  if (!Number.isSafeInteger(hostDailyCap) || hostDailyCap < 0) {
    throw new RangeError(`diag budget: hostDailyCap must be a non-negative integer, got ${String(hostDailyCap)}`);
  }
  const now = opts.now ?? Date.now;
  const dir = opts.dir ?? resolveQueueDir();
  if (dir === null) {
    throw new Error(`diag budget: ${QUEUE_DIR_ENV} switches the queue sqlite off, so the budget could not persist`);
  }
  const db = new DatabaseSync(path.join(dir, QUEUE_DB_FILE));

  let stmt: { count: StatementSync; charge: StatementSync; prune: StatementSync };
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    db.exec('PRAGMA journal_mode = WAL');
    // FULL: a charge is on disk before charge() returns, so it is on disk before the dispatch.
    db.exec('PRAGMA synchronous = FULL');
    db.exec(SCHEMA);
    stmt = {
      count: db.prepare('SELECT COUNT(*) AS n FROM diag_budget WHERE host = ? AND at > ?'),
      // The cap check and the insert in ONE statement: nothing can charge between them.
      charge: db.prepare(
        `INSERT INTO diag_budget (host, at, probe, run_id)
         SELECT ?, ?, ?, ?
         WHERE (SELECT COUNT(*) FROM diag_budget WHERE host = ? AND at > ?) < ?`
      ),
      // A row at or before the window's start can never count again.
      prune: db.prepare('DELETE FROM diag_budget WHERE at <= ?'),
    };
  } catch (error) {
    db.close();
    throw error;
  }

  const remaining = (host: string): number => {
    const row = stmt.count.get(host, now() - DIAG_BUDGET_WINDOW_MS) as { n: number };
    return Math.max(0, hostDailyCap - row.n);
  };

  return {
    hostDailyCap,

    remaining: (host) => remaining(hostKey(host)),

    startCall(req: DiagCallRequest): DiagCallBudget {
      const host = hostKey(req.host);
      const max = probeMaxRequests(req.probe);
      const requested = req.requested ?? max;
      if (!Number.isSafeInteger(requested) || requested < 0) {
        throw new RangeError(`diag budget: requested must be a non-negative integer, got ${String(req.requested)}`);
      }
      const left = remaining(host);
      const granted = Math.min(requested, max, left);
      const refusal: DiagRefusal | null = granted > 0 ? null : requested === 0 ? 'none-requested' : 'host-cap';
      const probe = Probe[req.probe];
      let spent = 0;

      return {
        host,
        granted,
        refusal,
        get spent() {
          return spent;
        },
        charge(): boolean {
          if (spent >= granted) return false;
          const at = now();
          const since = at - DIAG_BUDGET_WINDOW_MS;
          const { changes } = stmt.charge.run(host, at, probe, req.runId, host, since, hostDailyCap);
          if (Number(changes) !== 1) return false;
          spent++;
          stmt.prune.run(since);
          return true;
        },
      };
    },

    close(): void {
      db.close();
    },
  };
}
