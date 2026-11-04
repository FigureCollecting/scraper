/**
 * challengeCooldown — a per-host "leave it alone after a Cloudflare challenge" timer.
 *
 * WHY: a challenged host must NOT be re-fetched in a tight loop. Every failed challenge fetch from
 * our egress IP degrades that IP's reputation with Cloudflare Bot Management — the live 2026-08-31
 * anitoysgk incident showed a product ingest retried 3× in ~10 s, each pulling another challenge
 * page, and minutes later the store's SEARCH endpoint (9 candidates earlier the same night) also
 * began serving the challenge. So once ANY lane sees a genuine challenge for a host, we open a
 * cooldown window and every subsequent request for that host fails/skips WITHOUT fetching until it
 * expires.
 *
 * SHARED SEAM: the ingest queue (single item URLs) and the lookup fan-out (search URLs) both consult
 * one shared instance (the module singleton), so a cooldown one opens is honored by the other, and
 * /health/detailed can list them. Pure and TIME-INJECTABLE (no timers, no ambient Date.now in tests)
 * so both callers' behavior is deterministic under an injected clock.
 */

/** Absolute floor for a cooldown window — 1 minute. A shorter window is not a cooldown. */
const MIN_WINDOW_MS = 60_000;
/** Absolute ceiling — 24 hours. A longer window is almost certainly a misconfiguration. */
const MAX_WINDOW_MS = 24 * 60 * 60_000;
/** Default window when nothing (arg or env) says otherwise — 30 minutes. */
const DEFAULT_WINDOW_MS = 30 * 60_000;
/**
 * Default ceiling for an ESCALATED window — 6 hours. A host that keeps challenging gets the base
 * window doubled on each re-open (30 → 60 → 120 → 240 → 360 min), so it takes one challenged request
 * every few hours instead of two an hour.
 */
const DEFAULT_MAX_ESCALATED_MS = 6 * 60 * 60_000;
/**
 * A streak wears off after this long with no challenge past the window's end — 24 hours. A host that
 * challenges once a week is treated as challenging for the first time, not climbing to 6 h, while a
 * host that keeps challenging (queue traffic re-hits it as the window lapses) still escalates.
 */
const STREAK_DECAY_MS = 24 * 60 * 60_000;
/**
 * Default run of CONSECUTIVE gate failures (an empty body or a 5xx from a gated host — see
 * gateSignal) that opens a host's cooldown. Conservative: one busy 5xx is not a refused gate.
 */
const DEFAULT_GATE_FAILURE_THRESHOLD = 5;

/**
 * Coerce a requested window (ms) into the allowed band. A finite value is clamped to
 * [1 min, 24 h]; a non-finite value (NaN / Infinity — e.g. a garbage env string) falls back to the
 * 30-minute default rather than clamping, so misconfiguration degrades to "sane default", never 0.
 */
export function clampWindow(ms: number): number {
  if (!Number.isFinite(ms)) return DEFAULT_WINDOW_MS;
  return Math.min(MAX_WINDOW_MS, Math.max(MIN_WINDOW_MS, ms));
}

/**
 * The window from the CHALLENGE_COOLDOWN_MS env override, clamped. Unset / empty → the 30-minute
 * default (empty string must NOT read as 0 → clamped-to-min); non-numeric → default.
 */
function resolveWindowFromEnv(): number {
  const raw = process.env.CHALLENGE_COOLDOWN_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_WINDOW_MS;
  return clampWindow(Number(raw));
}

/**
 * The escalation ceiling: an explicit value beats CHALLENGE_COOLDOWN_MAX_MS; unset / empty /
 * non-numeric → 6 h. Clamped like a window, and never below the base window (a cap under the base
 * just means "do not escalate").
 */
function resolveMaxWindow(explicit: number | undefined, baseMs: number): number {
  let ms = explicit;
  if (ms === undefined) {
    const raw = process.env.CHALLENGE_COOLDOWN_MAX_MS;
    ms = raw === undefined || raw.trim() === '' ? DEFAULT_MAX_ESCALATED_MS : Number(raw);
  }
  const clamped = Number.isFinite(ms) ? clampWindow(ms) : DEFAULT_MAX_ESCALATED_MS;
  return Math.max(baseMs, clamped);
}

/** A positive whole number, else the default — a garbage threshold degrades to sane, never to 0 or 1. */
function validThreshold(n: number): number {
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_GATE_FAILURE_THRESHOLD;
}

/** The gate-failure threshold from GATE_FAILURE_COOLDOWN_THRESHOLD. Unset / empty / invalid → 5. */
function resolveGateThresholdFromEnv(): number {
  const raw = process.env.GATE_FAILURE_COOLDOWN_THRESHOLD;
  if (raw === undefined || raw.trim() === '') return DEFAULT_GATE_FAILURE_THRESHOLD;
  return validThreshold(Number(raw));
}

/** Host key normalization — lowercase, trimmed, `www.` stripped (matches ProfileRegistry). */
export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^www\./, '');
}

/** A live cooldown record. */
export interface CooldownEntry {
  /** Normalized host key. */
  host: string;
  /** Epoch ms (on the injected clock) at which the cooldown expires. */
  until: number;
  /** Human reason the cooldown was opened (challenge page / search challenge page / …). */
  reason: string;
  /** Epoch ms the cooldown was opened. */
  openedAt: number;
}

/** The observability view of one open cooldown (what /health/detailed lists). */
export interface CooldownView {
  host: string;
  remainingMs: number;
  reason: string;
}

/**
 * One host's LAST cooldown window, open or closed (what /health/detailed lists as `challengeHistory`).
 * A window that already closed is otherwise invisible: a host challenged at the top of the hour and
 * clear by the next check looked exactly like a host that was never challenged. The two hour counters
 * split real challenged responses from no-network queue fast-fails, which the log tallies mix.
 */
export interface CooldownHistoryView {
  host: string;
  /** Whether the last window is still live. */
  open: boolean;
  /** When the last window was opened (ISO, on the injected clock). */
  lastOpenedAt: string;
  /** How long the last window was, in whole minutes (the escalated length). */
  lastWindowMin: number;
  lastReason: string;
  /** The escalation streak the last open reached. */
  streak: number;
  /** When a clean fetch last cleared the host (ISO), or null if it has not since the last open. */
  lastClearedAt: string | null;
  /** Challenged responses (each open or re-extend) in the trailing 60 min. */
  challenged60m: number;
  /** Queue items failed fast on this cooldown, with no request sent, in the trailing 60 min. */
  queueFastFails60m: number;
}

/** The trailing window the history counters cover — 60 minutes. */
const HISTORY_COUNTER_MS = 60 * 60_000;

interface HostHistory {
  openedAt: number;
  until: number;
  reason: string;
  streak: number;
  clearedAt: number | null;
  /** Timestamps inside the trailing hour (pruned on every write, so the arrays stay bounded). */
  challenged: number[];
  skips: number[];
}

/** The timestamps still inside the trailing hour at `now`. */
function withinHour(times: readonly number[], now: number): number[] {
  return times.filter((t) => now - t < HISTORY_COUNTER_MS);
}

/**
 * The durable sink a cooldown is written through to (queueStore). BOOKKEEPING ONLY: the register's
 * own decision never depends on it, and a throwing sink is swallowed — a failed write must not
 * re-open a cooling host to traffic.
 */
export interface CooldownPersistence {
  saveCooldown(entry: CooldownEntry): void;
  removeCooldown(host: string): void;
}

export interface ChallengeCooldownOptions {
  /** Injectable clock (default Date.now) — tests pass a controllable function. */
  now?: () => number;
  /** Explicit window (ms). Beats the env; clamped to [1 min, 24 h]. Default: env or 30 min. */
  windowMs?: number;
  /** Ceiling for the escalated window (ms). Beats CHALLENGE_COOLDOWN_MAX_MS; default 6 h; never below the base. */
  maxWindowMs?: number;
  /** Optional durable sink. Absent ⇒ the register is memory-only, exactly as before. */
  persistence?: CooldownPersistence;
  /** Consecutive gate failures that open a host's cooldown. Beats the env; invalid → 5. */
  gateFailureThreshold?: number;
}

/**
 * Raised by a consumer (the ingest queue) when a request targets a host that is currently cooling —
 * a FAST FAIL with no fetch. Its own error class so the queue's classifier routes it to a dedicated
 * `challenge_cooldown` type (never retried, never the cookie-session-pause path). The message names
 * the host and the whole-minutes remaining so an operator sees why the item failed.
 */
export class ChallengeCooldownError extends Error {
  readonly host: string;
  readonly remainingMs: number;
  constructor(host: string, remainingMs: number) {
    const mins = Math.max(1, Math.ceil(remainingMs / 60_000));
    super(`Host ${host} is cooling down after a Cloudflare challenge; ${mins} min remaining before retry.`);
    this.name = 'ChallengeCooldownError';
    this.host = host;
    this.remainingMs = remainingMs;
  }
}

/**
 * A per-host cooldown register. Keys are normalized hosts; each open() records an expiry `until`.
 * `isOpen`/`remaining`/`list` read against the injected clock, so an entry past its `until` reads as
 * closed even though it is not yet physically removed — `clear()` (called on the next clean fetch)
 * removes it.
 */
export class ChallengeCooldown {
  private readonly entries = new Map<string, CooldownEntry>();
  private readonly now: () => number;
  private readonly windowMs: number;
  private readonly maxWindowMs: number;
  /**
   * Per-host run of cooldowns opened with no clean fetch in between (1 = first open). Kept past the
   * window's lapse so the next challenge escalates; `clear()` (a clean queue fetch) ends it, and so
   * does 24 h with no challenge after the window closed (STREAK_DECAY_MS).
   */
  private readonly streaks = new Map<string, number>();
  /** Per-host last window + trailing-hour counters (memory-only; survives clear, unlike `entries`). */
  private readonly hostHistory = new Map<string, HostHistory>();
  private persistence: CooldownPersistence | null;
  /** Per-host run of consecutive gate failures (memory-only: a restart starts every run at 0). */
  private readonly gateFailures = new Map<string, number>();
  private readonly gateFailureThreshold: number;

  constructor(opts: ChallengeCooldownOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.windowMs = clampWindow(opts.windowMs ?? resolveWindowFromEnv());
    this.maxWindowMs = resolveMaxWindow(opts.maxWindowMs, this.windowMs);
    this.persistence = opts.persistence ?? null;
    this.gateFailureThreshold =
      opts.gateFailureThreshold !== undefined ? validThreshold(opts.gateFailureThreshold) : resolveGateThresholdFromEnv();
  }

  /**
   * Attach (or detach) the durable sink after construction — the composition root wires the shared
   * singleton once the queue store is open. Does NOT write the current entries through: `restore`
   * is the load direction, and re-persisting on attach would rewrite every `openedAt`.
   */
  setPersistence(persistence: CooldownPersistence | null): void {
    this.persistence = persistence;
  }

  /** Persistence is bookkeeping: a throwing sink is swallowed so the cooldown still holds. */
  private persist(fn: (p: CooldownPersistence) => void): void {
    const p = this.persistence;
    if (p === null) return;
    try {
      fn(p);
    } catch {
      // A cooldown that cannot be written down is still a cooldown.
    }
  }

  /**
   * Rehydrate from persisted entries (startup). Expired entries are skipped, host keys are
   * normalized, and NOTHING is written back through the sink. Returns how many were loaded.
   *
   * WHY it matters: a restart inside an open window is exactly when the engine is most likely to
   * walk back into the challenge it just backed off from — the crawler's batch is re-driven all at
   * once, at the same host, from the same egress IP.
   */
  restore(entries: readonly CooldownEntry[]): number {
    const now = this.now();
    let loaded = 0;
    for (const entry of entries) {
      if (entry.until <= now) continue;
      const key = normalizeHost(entry.host);
      this.entries.set(key, { ...entry, host: key });
      // No schema change: the streak is read back off the entry's own window (base × 2^(streak-1)).
      const doublings = Math.round(Math.log2(Math.max(1, (entry.until - entry.openedAt) / this.windowMs)));
      this.streaks.set(key, 1 + doublings);
      this.hostHistory.set(key, {
        openedAt: entry.openedAt, until: entry.until, reason: entry.reason, streak: 1 + doublings,
        clearedAt: null, challenged: [], skips: [],
      });
      loaded++;
    }
    return loaded;
  }

  /**
   * Open (or re-extend) the cooldown for `host`; logs the opened line. Returns the recorded entry.
   *
   * ESCALATION: a host that challenges again after its window lapsed, with no clean fetch in between
   * and within 24 h of the window's end, opens for twice the previous window (base × 2^(streak-1),
   * capped at the max); later than that it opens at the base again (streak 1). A challenge that
   * lands while the window is still live (a fetch already in flight) re-extends at the SAME level, so
   * concurrent stragglers cannot ratchet the streak.
   */
  open(host: string, reason: string): CooldownEntry {
    const key = normalizeHost(host);
    const now = this.now();
    const prior = this.entries.get(key);
    const live = prior !== undefined && now < prior.until;
    const decayed = prior !== undefined && now - prior.until >= STREAK_DECAY_MS;
    const streak = live ? this.streak(key) : decayed ? 1 : this.streak(key) + 1;
    this.streaks.set(key, streak);
    const windowMs = this.windowForStreak(streak);
    const entry: CooldownEntry = { host: key, until: now + windowMs, reason, openedAt: now };
    this.entries.set(key, entry);
    const prev = this.hostHistory.get(key);
    this.hostHistory.set(key, {
      openedAt: now, until: entry.until, reason, streak, clearedAt: null,
      challenged: [...withinHour(prev?.challenged ?? [], now), now],
      skips: withinHour(prev?.skips ?? [], now),
    });
    this.persist((p) => p.saveCooldown(entry));
    // eslint-disable-next-line no-console
    console.warn(`[COOLDOWN] opened ${key} for ${Math.round(windowMs / 60_000)} min (streak ${streak}, ${reason})`);
    return entry;
  }

  /** base × 2^(streak-1), capped at the max. The exponent is bounded so a long streak cannot overflow. */
  private windowForStreak(streak: number): number {
    return Math.min(this.maxWindowMs, this.windowMs * 2 ** Math.min(streak - 1, 32));
  }

  /** How many cooldowns `host` has opened with no clean fetch in between (0 when none). */
  streak(host: string): number {
    return this.streaks.get(normalizeHost(host)) ?? 0;
  }

  /** Whether `host` is currently cooling (an entry exists and has not yet reached `until`). */
  isOpen(host: string): boolean {
    const entry = this.entries.get(normalizeHost(host));
    return entry !== undefined && this.now() < entry.until;
  }

  /** Milliseconds left before `host` clears, or 0 if not open / already expired. */
  remaining(host: string): number {
    const entry = this.entries.get(normalizeHost(host));
    if (entry === undefined) return 0;
    return Math.max(0, entry.until - this.now());
  }

  /**
   * Drop `host`'s cooldown and end its escalation streak (only a clean fetch calls this). Returns
   * true (and logs the cleared line) if an entry was removed.
   */
  clear(host: string): boolean {
    const key = normalizeHost(host);
    this.streaks.delete(key);
    if (!this.entries.delete(key)) return false;
    // Every entry has a history row (open and restore write both), so this read always finds one.
    this.hostHistory.get(key)!.clearedAt = this.now();
    this.persist((p) => p.removeCooldown(key));
    // eslint-disable-next-line no-console
    console.warn(`[COOLDOWN] cleared ${key}`);
    return true;
  }

  /**
   * One more CONSECUTIVE gate failure for `host` (gateSignal: an empty body or a 5xx from a gated
   * host). When the run reaches the threshold, the host's cooldown opens exactly as a challenge opens
   * it — same escalating window, same persistence, same fast-fail for every queued item. The run is NOT reset by
   * opening: only a clean fetch ends it, so the first probe after the window lapses re-opens at once
   * if the gate is still refusing. A failure while the window is live (a fetch already in flight)
   * does not re-open it, so stragglers cannot stretch the window. Returns the run length, and the
   * entry when this call opened the cooldown.
   */
  recordGateFailure(host: string, reason: string): { count: number; opened?: CooldownEntry } {
    const key = normalizeHost(host);
    const count = (this.gateFailures.get(key) ?? 0) + 1;
    this.gateFailures.set(key, count);
    if (count < this.gateFailureThreshold || this.isOpen(key)) return { count };
    return { count, opened: this.open(key, `${count} consecutive gate failures (${reason})`) };
  }

  /** A clean fetch ends `host`'s run of gate failures. True if there was a run to end. */
  resetGateFailures(host: string): boolean {
    return this.gateFailures.delete(normalizeHost(host));
  }

  /** The current run of consecutive gate failures for `host` (0 when none). */
  gateFailureCount(host: string): number {
    return this.gateFailures.get(normalizeHost(host)) ?? 0;
  }

  /**
   * One more queue item failed fast on `host`'s cooldown (no request sent). Counted apart from the
   * challenged responses so the two are never read as one. A host with no history is ignored.
   */
  recordSkip(host: string): void {
    const h = this.hostHistory.get(normalizeHost(host));
    if (h === undefined) return;
    const now = this.now();
    h.skips = [...withinHour(h.skips, now), now];
  }

  /** Every host's last window, open or closed, with its trailing-hour counters. */
  history(): CooldownHistoryView[] {
    const now = this.now();
    return [...this.hostHistory.entries()].map(([host, h]) => ({
      host,
      open: now < h.until,
      lastOpenedAt: new Date(h.openedAt).toISOString(),
      lastWindowMin: Math.round((h.until - h.openedAt) / 60_000),
      lastReason: h.reason,
      streak: h.streak,
      lastClearedAt: h.clearedAt === null ? null : new Date(h.clearedAt).toISOString(),
      challenged60m: withinHour(h.challenged, now).length,
      queueFastFails60m: withinHour(h.skips, now).length,
    }));
  }

  /** The currently-open cooldowns as observability views (expired-but-unremoved entries excluded). */
  list(): CooldownView[] {
    const now = this.now();
    const out: CooldownView[] = [];
    for (const entry of this.entries.values()) {
      const remainingMs = entry.until - now;
      if (remainingMs > 0) out.push({ host: entry.host, remainingMs, reason: entry.reason });
    }
    return out;
  }
}

// ============================================================================
// Shared singleton — the instance the queue, the lookup fan-out, and /health/detailed all consult.
// ============================================================================

let singleton: ChallengeCooldown | null = null;

/** The process-wide cooldown register (lazy). */
export function getChallengeCooldown(): ChallengeCooldown {
  if (singleton === null) singleton = new ChallengeCooldown();
  return singleton;
}

/** Drop the singleton (tests). */
export function resetChallengeCooldown(): void {
  singleton = null;
}
