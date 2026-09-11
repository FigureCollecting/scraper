/**
 * gatedBrowsers — the challenge lane's unit of session: one long-lived Chrome per EGRESS, and the
 * bookkeeping that bounds it.
 *
 * WHY A BROWSER AND NOT A CONTEXT (measured 2026-09-07, anitoysgk.com / hobby-genki.com through the
 * residential exit): a Chrome launched with `--proxy-server=…` that fetches a gated store in a NEW
 * TAB of its DEFAULT context clears Cloudflare's non-interactive JS challenge in 8-9 s, and a repeat
 * visit in another tab is a clean 200 (the clearance is reused). The identical browser fetching
 * through `browser.createBrowserContext({ proxyServer })` — a DevTools-created context, which is what
 * this engine used to open per request and per kept host — NEVER clears: the traffic leaves from the
 * right IP, the challenge simply sits on the interstitial past 40 s. The created context is itself
 * the tell. So a gated fetch is a tab in a plain browser, exactly like a person's, and everything
 * Cloudflare binds a clearance to — IP, user agent, profile — is shared by every gated host on that
 * browser, one per egress:
 *
 *   residential → launched with `--proxy-server=<RESIDENTIAL_PROXY_URL>` (the proxy is a LAUNCH
 *                 argument here, not a per-context option)
 *   direct      → launched without one
 *
 * The other half of the recipe is not in this file but decides the same outcome: the browser's
 * PROCESS timezone must not be UTC (the container sets `TZ`). `page.emulateTimezone` cannot stand in
 * for it — the challenge's cross-origin frame reads the process zone (see browserTimezone.ts).
 *
 * This module holds only what is testable without launching Chrome: the key a gated host is counted
 * under, the per-host page semaphore, and the shape of a live gated browser. The launching, the
 * two-hour recycle and the page accounting live on BrowserPool (genericScraper.ts), which owns every
 * `puppeteer.launch` in the engine.
 */
import type { Browser } from 'puppeteer';

/** Which egress a gated browser leaves through — one browser per value, never shared. */
export type EgressKind = 'residential' | 'direct';

/**
 * How long a gated browser is kept before it is replaced. It holds live clearances, so recycling is
 * pure cost — but an immortal Chrome is the leak shape this engine has already paid for once. Two
 * hours is far past the ~30 min a Cloudflare clearance is good for (nothing of value is discarded)
 * and short enough that a slowly-growing renderer never becomes the pod's memory ceiling.
 */
export const GATED_BROWSER_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/**
 * Concurrent tabs one gated host may hold open in its browser. Two is what the traffic actually
 * needs (a `/lookup` fan-out reaches a store once, the ingest queue once) and is well inside what
 * looks like a person browsing; an unbounded count would let one slow store fill the shared browser
 * with renderers and take every other gated store down with it.
 */
export const MAX_CONCURRENT_PAGES_PER_HOST = 2;

/**
 * How long a lane waits before attempting another relaunch after one FAILED its proof. A relaunch
 * proof spends a real store request per primed host, so a lane whose replacement cannot clear (the
 * egress IP is in the penalty box, the store is hard-blocking) must not burn one every time a fetch
 * arrives. The old instance keeps serving throughout — a failed relaunch costs nothing but the
 * chance to refresh, so backing off is free.
 */
export const GATED_RELAUNCH_RETRY_MS = 5 * 60 * 1000;

/**
 * The key a host's concurrency is counted under. Egress is part of it because the same host on two
 * exits is two different browsers: a slot in one says nothing about the other.
 */
export function gatedHostKey(host: string, egress: EgressKind): string {
  return `${host.toLowerCase()}|${egress}`;
}

/** Frees one slot. Idempotent: calling it twice must not release someone else's slot. */
export type ConcurrencySlot = () => void;

/**
 * A per-key counting semaphore. Strictly FIFO: a released slot is HANDED to the longest-waiting
 * caller rather than decremented and re-contested, so a busy host cannot starve a queued fetch and
 * no waiter is ever woken to find the slot gone.
 */
export class HostConcurrencyLimiter {
  private readonly active = new Map<string, number>();
  private readonly waiters = new Map<string, Array<() => void>>();

  constructor(private readonly maxPerKey: number = MAX_CONCURRENT_PAGES_PER_HOST) {}

  /** Take a slot for `key`, waiting if the key is at its cap. Resolves with the slot's release. */
  async acquire(key: string): Promise<ConcurrencySlot> {
    const held = this.active.get(key) ?? 0;
    if (held < this.maxPerKey) {
      this.active.set(key, held + 1);
    } else {
      // The slot is transferred by the releaser (which leaves the count alone), so by the time this
      // resolves the caller already HOLDS it — there is nothing to re-check and nothing to race.
      await new Promise<void>((resolve) => {
        const queue = this.waiters.get(key);
        if (queue) queue.push(resolve);
        else this.waiters.set(key, [resolve]);
      });
    }
    return this.slot(key);
  }

  /** A one-shot release for one held slot: hand it to the next waiter, or give it back to the key. */
  private slot(key: string): ConcurrencySlot {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const queue = this.waiters.get(key);
      const next = queue?.shift();
      if (queue && queue.length === 0) this.waiters.delete(key);
      if (next) {
        next(); // handed over: the count is unchanged because the slot never became free
        return;
      }
      const held = (this.active.get(key) ?? 1) - 1;
      if (held <= 0) this.active.delete(key);
      else this.active.set(key, held);
    };
  }

  /** Slots currently held for a key. */
  activeCount(key: string): number {
    return this.active.get(key) ?? 0;
  }

  /** Callers queued for a key (health/diagnostics; a persistently non-zero value means a stuck tab). */
  waitingCount(key: string): number {
    return this.waiters.get(key)?.length ?? 0;
  }

  /** How many keys hold at least one slot. */
  size(): number {
    return this.active.size;
  }

  /**
   * Forget everything (shutdown, test isolation). Queued callers are RESOLVED rather than abandoned:
   * a fetch waiting for a slot at shutdown would otherwise hang forever holding the process open. It
   * will fail on the closed browser instead, which is the honest error.
   */
  reset(): void {
    for (const queue of this.waiters.values()) for (const resolve of queue) resolve();
    this.waiters.clear();
    this.active.clear();
  }
}

let limiter: HostConcurrencyLimiter | undefined;

/** The process-wide limiter (one per engine; the challenge lane's only user). */
export function getHostConcurrency(): HostConcurrencyLimiter {
  if (!limiter) limiter = new HostConcurrencyLimiter();
  return limiter;
}

/** Drop the singleton's state (shutdown, tests). */
export function resetHostConcurrency(): void {
  limiter?.reset();
  limiter = undefined;
}

/** One live gated browser and everything bounding it. Owned by BrowserPool, one per egress. */
export interface GatedBrowserEntry {
  egress: EgressKind;
  browser: Browser;
  /** The proxy this browser was LAUNCHED with (undefined for the direct one) — it cannot be changed. */
  proxyServer?: string;
  /** Epoch ms; the browser is replaced once it is GATED_BROWSER_MAX_AGE_MS old. */
  launchedAt: number;
  /** Tabs currently open on it. A retiring browser is closed only once this reaches zero. */
  pagesOpen: number;
  /**
   * Hosts already session-primed on THIS browser instance, mapped to the prime URL that did it.
   * The URL is kept because a RELAUNCH has to re-prove those same hosts on the replacement before it
   * may carry traffic, and the pool that runs the proof has no other way to learn where to navigate.
   */
  primedHosts: Map<string, string>;
  /**
   * Hosts that have completed at least one navigation on THIS instance. A fresh instance holds no
   * Cloudflare clearance for any host, so the FIRST navigation for a host is the one that has to
   * earn it inline — and that is the navigation measured failing in production (2026-09-11 00:39:41,
   * suruga-ya.jp, 86 s after a relaunch: the interstitial outlasted the 30 s clearance budget, a
   * 30-minute host cooldown opened, 15 queued items were dropped, and the SAME instance then served
   * the host in 6 s once the cooldown expired). Membership here is what tells a challenge on a
   * first navigation apart from a challenge on a settled one, so only the former gets the retry.
   */
  navigatedHosts: Set<string>;
  /**
   * Set when the browser is being taken out of service. It ABANDONS a drain that is waiting on
   * in-flight tabs — shutdown closes the handle immediately rather than waiting out a stuck page.
   */
  closing?: boolean;
  /** Latched by the one close attempt that owns the handle — a retirement and a shutdown can race. */
  closed?: boolean;
}

/**
 * Per-EGRESS relaunch bookkeeping. It deliberately does NOT live on GatedBrowserEntry: an entry is
 * one Chrome, and these counts describe the SEQUENCE of Chromes a lane has been through — the thing
 * an operator needs when asking "is this lane churning, and is it churning successfully?".
 */
export interface GatedLaneStats {
  /** Successful relaunches: a replacement was proven and took over. */
  relaunchCount: number;
  /** Relaunch attempts whose replacement failed its proof and was discarded, the old one kept. */
  relaunchFailures: number;
  /** Epoch ms of the last SUCCESSFUL relaunch, or null if this lane still runs its first browser. */
  lastRelaunchAt: number | null;
  /** Tabs still in flight on the outgoing instance at the moment the last relaunch retired it. */
  drainedTabsAtRelaunch: number;
  /** First-navigation challenges that were retried once instead of opening a host cooldown. */
  firstNavigationRetries: number;
  /** Those retries that came back without a challenge — the cooldowns this grace actually avoided. */
  firstNavigationRecoveries: number;
  /** Epoch ms before which no further relaunch is attempted (set by a failed proof). */
  retryAfter: number;
}

/** A lane that has never relaunched. */
export function newGatedLaneStats(): GatedLaneStats {
  return {
    relaunchCount: 0,
    relaunchFailures: 0,
    lastRelaunchAt: null,
    drainedTabsAtRelaunch: 0,
    firstNavigationRetries: 0,
    firstNavigationRecoveries: 0,
    retryAfter: 0,
  };
}

/**
 * A relaunch's PROOF: navigate a tab of the replacement browser to one host's prime URL and answer
 * whether the challenge cleared. Injected by the fetch layer rather than implemented here, because
 * the clearance wait lives with the navigation code and this module deliberately imports no Chrome.
 */
export type GatedBrowserProof = (browser: Browser, host: string, primeUrl: string) => Promise<boolean>;

/** The operator view of one gated browser for /health/detailed (counts only, no handles). */
export interface GatedBrowserView {
  egress: EgressKind;
  /** ISO-8601; with the max age it says how much of this browser's life is left. */
  launchedAt: string;
  pagesOpen: number;
  /** How many hosts have already made their session-priming visit on this instance. */
  primedHosts: number;
  /** ISO-8601 of the last successful relaunch on this egress; null while it runs its first browser. */
  lastRelaunchAt: string | null;
  relaunchCount: number;
  relaunchFailures: number;
  drainedTabsAtRelaunch: number;
  firstNavigationRetries: number;
  firstNavigationRecoveries: number;
}

/**
 * Project a live entry (and its lane's relaunch history) onto its health view. The stats default to
 * a never-relaunched lane so every existing caller keeps working and a lane reads as quiet rather
 * than as missing data.
 */
export function gatedBrowserView(entry: GatedBrowserEntry, stats: GatedLaneStats = newGatedLaneStats()): GatedBrowserView {
  return {
    egress: entry.egress,
    launchedAt: new Date(entry.launchedAt).toISOString(),
    pagesOpen: entry.pagesOpen,
    primedHosts: entry.primedHosts.size,
    lastRelaunchAt: stats.lastRelaunchAt === null ? null : new Date(stats.lastRelaunchAt).toISOString(),
    relaunchCount: stats.relaunchCount,
    relaunchFailures: stats.relaunchFailures,
    drainedTabsAtRelaunch: stats.drainedTabsAtRelaunch,
    firstNavigationRetries: stats.firstNavigationRetries,
    firstNavigationRecoveries: stats.firstNavigationRecoveries,
  };
}
