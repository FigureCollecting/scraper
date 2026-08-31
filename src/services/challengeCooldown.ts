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

export interface ChallengeCooldownOptions {
  /** Injectable clock (default Date.now) — tests pass a controllable function. */
  now?: () => number;
  /** Explicit window (ms). Beats the env; clamped to [1 min, 24 h]. Default: env or 30 min. */
  windowMs?: number;
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

  constructor(opts: ChallengeCooldownOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.windowMs = clampWindow(opts.windowMs ?? resolveWindowFromEnv());
  }

  /** Open (or re-extend) the cooldown for `host`; logs the opened line. Returns the recorded entry. */
  open(host: string, reason: string): CooldownEntry {
    const key = normalizeHost(host);
    const now = this.now();
    const entry: CooldownEntry = { host: key, until: now + this.windowMs, reason, openedAt: now };
    this.entries.set(key, entry);
    // eslint-disable-next-line no-console
    console.warn(`[COOLDOWN] opened ${key} for ${Math.round(this.windowMs / 60_000)} min (${reason})`);
    return entry;
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

  /** Drop `host`'s cooldown. Returns true (and logs the cleared line) if an entry was removed. */
  clear(host: string): boolean {
    const key = normalizeHost(host);
    if (!this.entries.delete(key)) return false;
    // eslint-disable-next-line no-console
    console.warn(`[COOLDOWN] cleared ${key}`);
    return true;
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
