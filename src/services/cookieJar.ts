/**
 * cookieJar — the per-host STORED-COOKIE store (CF_COOKIE_FILE): hand-minted Cloudflare clearance
 * and session cookies, plus the User-Agent they were minted under, keyed by NORMALIZED host.
 *
 * WHY: cf_clearance is bound to the egress IP + User-Agent and cannot be minted from the pod's IP.
 * Ross mints it out-of-band (runbook), a sync script lands the file as a mounted Secret, and the
 * three fetch lanes (impit / http / browser) inject it per host. This module only READS: it never
 * refreshes a cookie, never retries, and never logs a value — cookie NAMES only, everywhere.
 *
 * FILE SHAPE (keyed by host; `www.` and case collapse via the shared normalizeHost):
 *   { "<host>": { "cookies": { "<name>": "<value>", … }, "userAgent"?: "…", "mintedAt"?: iso, "expiresAt"?: iso } }
 *
 * LIFECYCLE: `load()` reads + validates; a malformed file keeps the LAST-GOOD set (one warn); a
 * missing file reads as empty. `start()` polls the file's mtime (default 30 s, unref'd) — a kubelet
 * Secret refresh changes the mtime, so a re-mint goes live WITHOUT a restart. A reload resets stale
 * marks. `markStale`/`markFresh` are the engine's signal that a host WITH stored cookies still got
 * challenged (→ /health/detailed `cfCookies[].stale`), so an operator knows to re-mint.
 *
 * Everything is injectable (path / fs / clock / interval) so the behavior is deterministic in tests.
 */
import * as nodeFs from 'fs';
import { normalizeHost } from './challengeCooldown.js';

/** Default poll interval for the file's mtime. */
const DEFAULT_POLL_INTERVAL_MS = 30_000;

/** One host's stored entry (validated). */
interface HostEntry {
  cookies: Map<string, string>;
  userAgent?: string;
  mintedAt?: string;
  expiresAt?: string;
}

/** A stale mark on one host. */
interface StaleMark {
  since: number;
  reason: string;
}

/** The observability view of one host (what /health/detailed lists). NEVER carries a value. */
export interface CfCookieHostView {
  host: string;
  cookieNames: string[];
  userAgentPinned: boolean;
  loadedAt: string;
  mintedAt?: string;
  expiresAt?: string;
  stale: boolean;
  staleSince?: string;
  staleReason?: string;
}

/** The read surface the three fetch lanes consume (a structural subset of CfCookieStore). */
export interface CfCookieSource {
  /** The stored cookies for the url's host (exact, then parent-domain fallback), or undefined. A copy. */
  cookiesFor(url: string): Record<string, string> | undefined;
  /** The pinned mint User-Agent for the url's host, or undefined. */
  userAgentFor(url: string): string | undefined;
}

/** The stale-signal surface the cooldown sites consume. */
export interface CfCookieStaleSignals {
  /** A host WITH stored cookies was still challenged: flip stale (once). True on the transition. */
  markStale(host: string, lane: string, reason: string): boolean;
  /** A clean body came back for a host: clear its stale mark. True on the transition. */
  markFresh(host: string): boolean;
}

/** The fs slice the store depends on (Node's `fs` satisfies it; tests inject an in-memory fake). */
export interface CfCookieFs {
  readFileSync(path: string, encoding: 'utf8'): string;
  statSync(path: string): { mtimeMs: number };
}

export interface CfCookieStoreOptions {
  /** File path. Defaults to CF_COOKIE_FILE; undefined/empty ⇒ the store is DISABLED (empty, no fs). */
  path?: string;
  /** Injectable fs (default Node fs). */
  fs?: CfCookieFs;
  /** Injectable clock (default Date.now). */
  now?: () => number;
  /** Poll interval for mtime changes (default 30 s). */
  intervalMs?: number;
}

/** The path from the CF_COOKIE_FILE env — trimmed; unset/blank ⇒ undefined (feature off). */
export function resolveCfCookieFilePath(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.CF_COOKIE_FILE?.trim();
  return raw ? raw : undefined;
}

/** RFC 6265 cookie-name token (no separators / whitespace / control chars). */
const COOKIE_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** A value we can put on a Cookie header / into a jar verbatim: no control chars, whitespace, or `;`. */
const COOKIE_VALUE_BAD_RE = /[\x00-\x20\x7F;]/;

/** Hostname of a url (or a bare host string), normalized; undefined when neither parses. */
function hostOf(input: string): string | undefined {
  try {
    return normalizeHost(new URL(input).hostname);
  } catch {
    const h = normalizeHost(input);
    return /^[a-z0-9.-]+$/.test(h) ? h : undefined;
  }
}

type ParsedFile = { ok: true; entries: Map<string, HostEntry>; skipped: string[] } | { ok: false; reason: string };

/**
 * Parse + validate the file body. Top level must be an object of host → entry; each entry must carry
 * a `cookies` object. Cookies with an empty / non-string / unsendable value are dropped; a host left
 * with no cookies is dropped (and named under `skipped`). Nothing here ever throws.
 */
function parseCookieFile(raw: string): ParsedFile {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: `invalid JSON (${(err as Error).message})` };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, reason: 'top-level value is not an object keyed by host' };
  }
  const entries = new Map<string, HostEntry>();
  const skipped: string[] = [];
  for (const [rawHost, rawEntry] of Object.entries(data as Record<string, unknown>)) {
    const host = normalizeHost(rawHost);
    if (!host) { skipped.push('(empty host)'); continue; }
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) { skipped.push(host); continue; }
    const { cookies, userAgent, mintedAt, expiresAt } = rawEntry as Record<string, unknown>;
    if (!cookies || typeof cookies !== 'object' || Array.isArray(cookies)) { skipped.push(host); continue; }
    const jar = new Map<string, string>();
    for (const [name, value] of Object.entries(cookies as Record<string, unknown>)) {
      if (!COOKIE_NAME_RE.test(name)) continue;
      if (typeof value !== 'string' || value === '' || COOKIE_VALUE_BAD_RE.test(value)) continue;
      jar.set(name, value);
    }
    if (jar.size === 0) { skipped.push(host); continue; }
    const entry: HostEntry = { cookies: jar };
    if (typeof userAgent === 'string' && userAgent.trim() !== '') entry.userAgent = userAgent.trim();
    if (typeof mintedAt === 'string') entry.mintedAt = mintedAt;
    if (typeof expiresAt === 'string') entry.expiresAt = expiresAt;
    entries.set(host, entry);
  }
  return { ok: true, entries, skipped };
}

export class CfCookieStore implements CfCookieSource, CfCookieStaleSignals {
  private readonly path: string | undefined;
  private readonly fs: CfCookieFs;
  private readonly now: () => number;
  private readonly intervalMs: number;

  private entries = new Map<string, HostEntry>();
  private stale = new Map<string, StaleMark>();
  private loadedAt: number | undefined;
  /** mtime of the file at the last load attempt (undefined = missing / never loaded). */
  private lastMtimeMs: number | undefined;
  /** Whether any load attempt has run (so a still-missing file is not re-loaded every poll). */
  private attempted = false;
  private missingLogged = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(opts: CfCookieStoreOptions = {}) {
    this.path = opts.path !== undefined ? (opts.path || undefined) : resolveCfCookieFilePath(process.env);
    this.fs = opts.fs ?? nodeFs;
    this.now = opts.now ?? Date.now;
    this.intervalMs = opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  /**
   * Read + validate the file now. Missing/unreadable → empty (one warn); malformed → the last-good
   * set is kept (one warn per bad write, since the bad mtime is remembered); success → entries
   * replaced, stale marks reset, and one `loaded` line naming hosts + cookie NAMES.
   */
  load(): void {
    if (!this.path) return;
    this.attempted = true;
    let raw: string;
    let mtimeMs: number;
    try {
      mtimeMs = this.fs.statSync(this.path).mtimeMs;
      raw = this.fs.readFileSync(this.path, 'utf8');
    } catch (err) {
      const code = err instanceof Error ? ((err as { code?: string }).code ?? err.message) : String(err);
      if (!this.missingLogged) {
        // eslint-disable-next-line no-console
        console.warn(`[CF-COOKIE] cookie file ${this.path} not readable (${code}) — no stored cookies in use`);
      }
      this.missingLogged = true;
      this.lastMtimeMs = undefined;
      this.entries = new Map();
      this.stale = new Map();
      this.loadedAt = this.now();
      return;
    }
    this.lastMtimeMs = mtimeMs;
    this.missingLogged = false;
    const parsed = parseCookieFile(raw);
    if (!parsed.ok) {
      // eslint-disable-next-line no-console
      console.warn(`[CF-COOKIE] malformed cookie file ${this.path}: ${parsed.reason} — keeping the last-good set (${this.entries.size} host(s))`);
      return;
    }
    if (parsed.skipped.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(`[CF-COOKIE] skipped ${parsed.skipped.length} malformed host entr${parsed.skipped.length === 1 ? 'y' : 'ies'}: ${parsed.skipped.join(', ')}`);
    }
    this.entries = parsed.entries;
    this.stale = new Map();
    this.loadedAt = this.now();
    const summary = [...this.entries.entries()]
      .map(([host, e]) => `${host}(${[...e.cookies.keys()].join(',')}${e.userAgent ? ' ua=pinned' : ''})`)
      .join(' ');
    // eslint-disable-next-line no-console
    console.log(`[CF-COOKIE] loaded ${this.entries.size} host(s): ${summary}`);
  }

  /** Reload iff the file's mtime changed since the last load (or it appeared/disappeared). True when a load ran. */
  poll(): boolean {
    if (!this.path) return false;
    let mtimeMs: number | undefined;
    try {
      mtimeMs = this.fs.statSync(this.path).mtimeMs;
    } catch {
      mtimeMs = undefined;
    }
    if (this.attempted && mtimeMs === this.lastMtimeMs) return false;
    this.load();
    return true;
  }

  /** Load now (if not yet) and start the unref'd mtime poller. Idempotent; a no-op when disabled. */
  start(): void {
    if (!this.path || this.timer) return;
    this.poll();
    this.timer = setInterval(() => this.poll(), this.intervalMs);
    this.timer.unref?.();
  }

  /** Stop the poller (shutdown / tests). */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * The entry key serving `hostOrUrl`: exact normalized host, else the nearest parent domain that has
   * an entry (a.b.example.com → b.example.com → example.com). Never a single label (no TLD match).
   */
  private resolveKey(hostOrUrl: string): string | undefined {
    let h = hostOf(hostOrUrl);
    while (h) {
      if (this.entries.has(h)) return h;
      const dot = h.indexOf('.');
      if (dot < 0) return undefined;
      h = h.slice(dot + 1);
      if (!h.includes('.')) return undefined;
    }
    return undefined;
  }

  cookiesFor(url: string): Record<string, string> | undefined {
    const key = this.resolveKey(url);
    if (key === undefined) return undefined;
    return Object.fromEntries(this.entries.get(key)!.cookies);
  }

  userAgentFor(url: string): string | undefined {
    const key = this.resolveKey(url);
    return key === undefined ? undefined : this.entries.get(key)!.userAgent;
  }

  markStale(host: string, lane: string, reason: string): boolean {
    const key = this.resolveKey(host);
    if (key === undefined || this.stale.has(key)) return false;
    this.stale.set(key, { since: this.now(), reason });
    const names = [...this.entries.get(key)!.cookies.keys()].join(',');
    // eslint-disable-next-line no-console
    console.warn(`[CF-COOKIE] STALE ${key} via ${lane}: stored cookie(s) [${names}] present but challenge/403 received (${reason}) — re-mint via runbook`);
    return true;
  }

  markFresh(host: string): boolean {
    const key = this.resolveKey(host);
    if (key === undefined || !this.stale.delete(key)) return false;
    // eslint-disable-next-line no-console
    console.log(`[CF-COOKIE] FRESH ${key}: clean fetch with stored cookie(s)`);
    return true;
  }

  /** Snapshot for /health/detailed — names, pins, timestamps, stale flags. NEVER a value. */
  view(): CfCookieHostView[] {
    const loadedAt = new Date(this.loadedAt ?? this.now()).toISOString();
    const out: CfCookieHostView[] = [];
    for (const [host, e] of this.entries) {
      const mark = this.stale.get(host);
      out.push({
        host,
        cookieNames: [...e.cookies.keys()],
        userAgentPinned: e.userAgent !== undefined,
        loadedAt,
        ...(e.mintedAt !== undefined ? { mintedAt: e.mintedAt } : {}),
        ...(e.expiresAt !== undefined ? { expiresAt: e.expiresAt } : {}),
        stale: mark !== undefined,
        ...(mark ? { staleSince: new Date(mark.since).toISOString(), staleReason: mark.reason } : {}),
      });
    }
    return out;
  }
}

// ============================================================================
// Shared singleton — the instance the three lanes, the cooldown sites, and /health/detailed consult.
// ============================================================================

let singleton: CfCookieStore | null = null;

/** The process-wide store (lazy; loads the file on first access). */
export function getCfCookieStore(): CfCookieStore {
  if (singleton === null) {
    singleton = new CfCookieStore();
    singleton.poll();
  }
  return singleton;
}

/** Drop the singleton (tests). Stops its poller first. */
export function resetCfCookieStore(): void {
  singleton?.stop();
  singleton = null;
}
