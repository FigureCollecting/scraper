/**
 * persistentContexts — the browser lane's per-host context cache for CHALLENGE-GATED stores.
 *
 * Cloudflare binds a `cf_clearance` to (IP, user agent, browser context). A fresh incognito context
 * therefore re-earns the challenge on EVERY fetch (measured 3-9 s each, and every re-run is another
 * challenge Cloudflare's reputation model sees), while a context that already passed gets clean
 * 200s for the rest of the clearance window (~30 min from issuance). So a gated host's context is
 * kept alive between fetches instead of being closed with the request.
 *
 * It is a CACHE, not a leak, and the bounds are the whole point:
 *   - max age 25 min from creation — inside the ~30 min clearance window, so a reused context never
 *     hands back a page that is about to be re-challenged mid-fetch;
 *   - idle TTL 10 min — a host nobody is fetching does not hold browser memory;
 *   - LRU cap of 6 contexts — the hard ceiling on how much this can ever cost;
 *   - everything closed on pool shutdown.
 * An entry that is IN USE is never evicted out from under its fetch; it becomes evictable as soon
 * as the fetch releases it.
 *
 * The cache never closes anything itself: eviction RETURNS the entries, and the caller (which owns
 * the BrowserPool accounting) closes them. That keeps this module free of engine imports — no
 * cycles, and the leak counters stay honest.
 */
import type { Browser, BrowserContext } from 'puppeteer';

/** Bounds. Age is measured from creation, idle from last use; the cap is a hard ceiling. */
export const MAX_CONTEXT_AGE_MS = 25 * 60_000;
export const CONTEXT_IDLE_TTL_MS = 10 * 60_000;
export const MAX_PERSISTENT_CONTEXTS = 6;

/** Which egress a context is bound to — part of the key: the same host on two exits is two sessions. */
export type EgressKind = 'residential' | 'direct';

/** One kept-alive context and the bookkeeping that bounds it. */
export interface PersistentContextEntry {
  key: string;
  browser: Browser;
  context: BrowserContext;
  createdAt: number;
  lastUsedAt: number;
  /** Fetches currently running on this context (an in-use entry is never evicted). */
  inUse: number;
  /** Whether this context has already made its session-priming navigation (SearchFetch.sessionPrime). */
  primed: boolean;
}

/** The cache key: one session per (host, egress) — the same host on two exits is two clearances. */
export function persistentContextKey(host: string, egress: EgressKind): string {
  return `${host.toLowerCase()}|${egress}`;
}

export interface PersistentContextCacheOptions {
  maxAgeMs?: number;
  idleTtlMs?: number;
  maxEntries?: number;
  /** Liveness check for a cached entry (default: its browser is still connected). */
  isAlive?: (entry: PersistentContextEntry) => boolean;
}

/** What a caller must supply to register a context it just opened. */
export interface PersistentContextInit {
  browser: Browser;
  context: BrowserContext;
  /** 1 when the caller is about to use it (the create-then-use path), 0 when retaining a finished one. */
  inUse?: number;
  primed?: boolean;
}

export class PersistentContextCache {
  private readonly entries = new Map<string, PersistentContextEntry>();
  private readonly maxAgeMs: number;
  private readonly idleTtlMs: number;
  private readonly maxEntries: number;
  private readonly isAlive: (entry: PersistentContextEntry) => boolean;

  constructor(options: PersistentContextCacheOptions = {}) {
    this.maxAgeMs = options.maxAgeMs ?? MAX_CONTEXT_AGE_MS;
    this.idleTtlMs = options.idleTtlMs ?? CONTEXT_IDLE_TTL_MS;
    this.maxEntries = options.maxEntries ?? MAX_PERSISTENT_CONTEXTS;
    this.isAlive = options.isAlive ?? ((entry) => entry.browser.connected !== false);
  }

  /**
   * Take the live context for a key, if there is a usable one, and sweep everything expired.
   * The returned `evicted` entries are the caller's to close.
   */
  acquire(key: string): { entry?: PersistentContextEntry; evicted: PersistentContextEntry[] } {
    const now = Date.now();
    const evicted = this.sweep(now);
    const entry = this.entries.get(key);
    if (!entry) return { evicted };
    if (!this.isAlive(entry)) {
      // Its browser died (retired, crashed): the context went with it. Drop it — nothing to close.
      this.entries.delete(key);
      return { evicted };
    }
    entry.inUse++;
    entry.lastUsedAt = now;
    // Re-insert to keep Map iteration order == least-recently-used first (the LRU the cap evicts by).
    this.entries.delete(key);
    this.entries.set(key, entry);
    return { entry, evicted };
  }

  /**
   * Register a freshly-opened context. Returns the entry to fetch on, plus everything the caller must
   * close (the LRU cap's victims, a displaced idle entry, or — see below — the caller's OWN context).
   *
   * LOST RACE: when the key already holds an entry a fetch is still running on, that entry WINS. Two
   * concurrent fetches to one gated host both miss `acquire` and both open a context; the loser's
   * context is the disposable duplicate, so it comes back in `evicted` and the caller fetches on the
   * incumbent instead. Handing back the in-flight entry would have the caller close a context
   * mid-navigation, killing the other fetch and discarding the clearance it was earning.
   */
  store(key: string, init: PersistentContextInit): { entry: PersistentContextEntry; evicted: PersistentContextEntry[] } {
    const now = Date.now();
    const existing = this.entries.get(key);

    if (existing && existing.inUse > 0 && this.isAlive(existing)) {
      const claim = init.inUse ?? 1;
      existing.inUse += claim;
      if (claim > 0) existing.lastUsedAt = now;
      // Re-insert to keep Map order == least-recently-used first (the LRU the cap evicts by).
      this.entries.delete(key);
      this.entries.set(key, existing);
      return { entry: existing, evicted: [this.orphan(key, init, now)] };
    }

    const evicted: PersistentContextEntry[] = existing ? [existing] : [];
    if (existing) this.entries.delete(key);

    const entry: PersistentContextEntry = {
      key,
      browser: init.browser,
      context: init.context,
      createdAt: now,
      lastUsedAt: now,
      inUse: init.inUse ?? 1,
      primed: init.primed ?? false,
    };
    this.entries.set(key, entry);
    evicted.push(...this.enforceCap(key));
    return { entry, evicted };
  }

  /**
   * An entry for a context that never entered the map — the loser of a store race. It exists only so
   * the caller closes it through the same `evicted` path (and the same BrowserPool accounting) as a
   * genuinely evicted one.
   */
  private orphan(key: string, init: PersistentContextInit, now: number): PersistentContextEntry {
    return {
      key,
      browser: init.browser,
      context: init.context,
      createdAt: now,
      lastUsedAt: now,
      inUse: 0,
      primed: init.primed ?? false,
    };
  }

  /** A fetch finished with this entry: it is idle again (and evictable). */
  release(entry: PersistentContextEntry): void {
    entry.inUse = Math.max(0, entry.inUse - 1);
    entry.lastUsedAt = Date.now();
  }

  /** Forget every entry on a browser that is gone (its contexts died with it — nothing to close). */
  dropBrowser(browser: Browser): void {
    for (const [key, entry] of this.entries) {
      if (entry.browser === browser) this.entries.delete(key);
    }
  }

  /** Remove and return everything (pool shutdown): the caller closes them. */
  drain(): PersistentContextEntry[] {
    const all = [...this.entries.values()];
    this.entries.clear();
    return all;
  }

  /** How many contexts are currently kept alive (health surface). */
  size(): number {
    return this.entries.size;
  }

  /** Expired-and-idle entries, removed and returned. In-use entries survive until released. */
  private sweep(now: number): PersistentContextEntry[] {
    const evicted: PersistentContextEntry[] = [];
    for (const [key, entry] of this.entries) {
      if (entry.inUse > 0) continue;
      const tooOld = now - entry.createdAt >= this.maxAgeMs;
      const tooIdle = now - entry.lastUsedAt >= this.idleTtlMs;
      if (tooOld || tooIdle) {
        this.entries.delete(key);
        evicted.push(entry);
      }
    }
    return evicted;
  }

  /**
   * Drop least-recently-used idle entries until the cap holds. Never takes an in-use entry, and
   * never takes the entry just stored (`keep`) — evicting the context the caller is about to fetch
   * on would be a cap that guarantees a re-challenge.
   */
  private enforceCap(keep: string): PersistentContextEntry[] {
    const evicted: PersistentContextEntry[] = [];
    while (this.entries.size > this.maxEntries) {
      const victim = [...this.entries.values()].find((entry) => entry.inUse === 0 && entry.key !== keep);
      if (!victim) break; // everything is in flight; the cap re-asserts on the next release
      this.entries.delete(victim.key);
      evicted.push(victim);
    }
    return evicted;
  }
}

let cache: PersistentContextCache | undefined;

/** The process-wide cache (one per engine; the browser lane's only user). */
export function getPersistentContexts(): PersistentContextCache {
  if (!cache) cache = new PersistentContextCache();
  return cache;
}

/** Drop the singleton (tests). Contexts must already have been drained/closed by the caller. */
export function resetPersistentContexts(): void {
  cache = undefined;
}
