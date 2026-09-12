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
import type { MemoryMeasureMethod } from './browserRss.js';

/** Which egress a gated browser leaves through — one browser per value, never shared. */
export type EgressKind = 'residential' | 'direct';

/**
 * The age at which a gated browser is replaced — a BACKSTOP, not the policy.
 *
 * This was two hours, and it cost more than it saved. A cleared Cloudflare session is an ASSET: it
 * is bound to the egress IP, the TLS fingerprint and the user agent, it takes ~9 s of challenge to
 * earn, and every replacement re-earns it from an IP whose Bot Management reputation those very
 * challenges spend. Measured on 2026-09-11 the residential lane recycled four times in nine hours
 * and one of those four cost a store 15 dropped items and ~50 minutes of its queue — a loss with no
 * corresponding gain, because nothing was wrong with the browser being discarded.
 *
 * What the timer was ever FOR is stated in its own old comment: "an immortal Chrome is the leak
 * shape this engine has already paid for once". That is a memory argument and a wedged-instance
 * argument, and both are now measured directly (GATED_BROWSER_MAX_RSS_BYTES and the navigation
 * failure streak). So the clock becomes the last line of defence for whatever the evidence triggers
 * fail to catch, and twelve hours is long enough that a healthy session is left alone all day.
 */
export const GATED_BROWSER_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/**
 * Proportional bytes (browser process plus its renderers, PSS — see browserRss.ts) at which a gated
 * browser is recycled on EVIDENCE of growth. The floor: the pod's limit is 3 GiB and it runs four
 * Chromes — two pooled, two gated — so one gated browser holding a gigabyte is already twice its
 * fair share and heading for the ceiling.
 *
 * Never compare this against a sum of VmRSS. That sum counts Chrome's shared pages once per process
 * and reads 3.76x the true figure on this pod, which is what made the trigger fire within seconds of
 * every launch on 2026-09-11 (eight residential relaunches in ten minutes).
 */
export const GATED_BROWSER_MAX_RSS_BYTES = 1024 * 1024 * 1024;

/**
 * Share of the container's own memory ceiling one gated browser tree may hold before it is recycled.
 *
 * A constant threshold is a guess about a pod size. The cgroup publishes the real budget, so derive
 * from it and let the constant above be the FLOOR: on the 3 GiB scraper pod this lands at 1.2 GiB,
 * and on a pod resized either way the trigger moves with it instead of becoming either inert or
 * permanently hot. Four Chromes share that ceiling, so 40 % is already a generous single share —
 * it is a leak detector, not a fairness quota.
 */
export const GATED_MEMORY_LIMIT_FRACTION = 0.4;

/**
 * Minimum gap between EVIDENCE relaunches on one lane. The trigger that fires is not the cost; the
 * PRIME NAVIGATION each replacement spends on a Cloudflare-fronted store is, and eight of those in
 * ten minutes from one residential IP is request burn and reputation risk (2026-09-11 22:31–22:41,
 * ending in a replacement that failed its proof on www.anitoysgk.com and threw the session away).
 *
 * Thirty minutes is chosen against the thing being protected: a genuine leak takes far longer than
 * that to matter, while a misfiring trigger does its damage in minutes. The backstop is exempt —
 * it is the last line of defence and must not be gated by the rate limit meant to protect it.
 */
export const GATED_BROWSER_MIN_RELAUNCH_INTERVAL_MS = 30 * 60 * 1000;

/**
 * How long a memory relaunch is given to prove it HELPED before the lane concludes it did not.
 *
 * A replacement that is still over the threshold two minutes in is not carrying a leak the old
 * browser had — the measurement is wrong, the threshold is wrong, or Chrome simply costs that much
 * here. Relaunching again cannot fix any of those, so the lane backs off instead of repeating it.
 */
export const GATED_RELAUNCH_GRACE_MS = 2 * 60 * 1000;

/** Ceiling on the doubling. Past four hours the backstop arrives anyway and an operator should look. */
export const GATED_RELAUNCH_BACKOFF_CAP_MS = 4 * 60 * 60 * 1000;

/**
 * Consecutive failed navigations on one lane before its browser is treated as wedged and replaced.
 *
 * THE 2026-09-08 INCIDENT: the residential browser relaunched while tabs were in flight and every
 * navigation afterwards timed out at 20 s until a human restarted the pod. Nothing recovered it,
 * because nothing was watching for it. Three in a row is past coincidence — a gated lane's fetches
 * are seconds apart and independent — and short enough to self-heal inside one crawl slice.
 */
export const GATED_NAV_FAILURE_STREAK = 3;

/** How often a lane's memory is sampled. Walking /proc is cheap, but not per-fetch cheap. */
export const GATED_RSS_SAMPLE_MS = 60_000;

/**
 * Why a replacement was built. Recorded on every relaunch event and surfaced on /health so an
 * operator can tell a lane that is refreshing on schedule from one that is self-healing repeatedly.
 */
export type GatedRelaunchReason = 'backstop' | 'rss' | 'navigation-failures';

/** Read a positive-integer env override, falling back when unset, empty, or not a finite number. */
function envNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** The age backstop, overridable with GATED_BROWSER_MAX_AGE_MS. */
export function resolveGatedMaxAgeMs(env: NodeJS.ProcessEnv = process.env): number {
  return envNumber(env.GATED_BROWSER_MAX_AGE_MS, GATED_BROWSER_MAX_AGE_MS);
}

/**
 * The default memory trigger for a pod whose ceiling is `cgroupLimitBytes`: the larger of the 1 GiB
 * floor and GATED_MEMORY_LIMIT_FRACTION of that ceiling. An unknown ceiling (no cgroup, `max`, the
 * v1 unlimited sentinel) leaves the floor standing, which is the conservative answer.
 */
export function gatedMemoryThresholdBytes(cgroupLimitBytes?: number): number {
  if (cgroupLimitBytes === undefined || !Number.isFinite(cgroupLimitBytes) || cgroupLimitBytes <= 0) {
    return GATED_BROWSER_MAX_RSS_BYTES;
  }
  return Math.max(GATED_BROWSER_MAX_RSS_BYTES, Math.floor(cgroupLimitBytes * GATED_MEMORY_LIMIT_FRACTION));
}

/**
 * The memory trigger, overridable with GATED_BROWSER_MAX_RSS_MB (megabytes). The override wins over
 * the derived default outright — an operator who has named a number has already decided, and
 * fc-infra currently names 2048 as the interim mitigation for the churn this replaces.
 */
export function resolveGatedMaxRssBytes(env: NodeJS.ProcessEnv = process.env, cgroupLimitBytes?: number): number {
  const derived = gatedMemoryThresholdBytes(cgroupLimitBytes);
  const mb = envNumber(env.GATED_BROWSER_MAX_RSS_MB, derived / (1024 * 1024));
  return mb * 1024 * 1024;
}

/** The evidence-relaunch rate limit, overridable with GATED_BROWSER_MIN_RELAUNCH_INTERVAL_MS. */
export function resolveGatedMinRelaunchIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  return envNumber(env.GATED_BROWSER_MIN_RELAUNCH_INTERVAL_MS, GATED_BROWSER_MIN_RELAUNCH_INTERVAL_MS);
}

/** The window a memory relaunch gets to prove it helped, overridable with GATED_RELAUNCH_GRACE_MS. */
export function resolveGatedRelaunchGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  return envNumber(env.GATED_RELAUNCH_GRACE_MS, GATED_RELAUNCH_GRACE_MS);
}

/** Everything the relaunch gate needs, resolved once so a fake clock can drive the state machine. */
export interface RelaunchGateLimits {
  minIntervalMs: number;
  graceMs: number;
  backoffCapMs: number;
  thresholdBytes: number;
}

/** The live gate settings for this process. */
export function resolveRelaunchGateLimits(env: NodeJS.ProcessEnv = process.env, cgroupLimitBytes?: number): RelaunchGateLimits {
  return {
    minIntervalMs: resolveGatedMinRelaunchIntervalMs(env),
    graceMs: resolveGatedRelaunchGraceMs(env),
    backoffCapMs: GATED_RELAUNCH_BACKOFF_CAP_MS,
    thresholdBytes: resolveGatedMaxRssBytes(env, cgroupLimitBytes),
  };
}

/** The wedged-lane trigger, overridable with GATED_NAV_FAILURE_STREAK. */
export function resolveGatedNavFailureStreak(env: NodeJS.ProcessEnv = process.env): number {
  return Math.max(1, Math.round(envNumber(env.GATED_NAV_FAILURE_STREAK, GATED_NAV_FAILURE_STREAK)));
}

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
  /** Why the last relaunch was built. */
  lastRelaunchReason: GatedRelaunchReason | null;
  /** Navigations that have failed in a row on this lane; any success resets it to zero. */
  navFailureStreak: number;
  /**
   * Escalation: set only when a SECOND carried proof fails on a host whose cookies were already
   * being withheld. At that point the suspicion is no longer one host's clearance but the whole
   * jar, so the next attempt starts completely CLEAN. One failure blocks one host (below); it takes
   * a repeat to throw away clearances that have done nothing wrong.
   */
  carryOverBlocked: boolean;
  /**
   * Hosts whose carried cookies are implicated in a failed proof, and therefore withheld from the
   * next replacement. PER HOST rather than lane-wide: the proof loop stops at the first failure, so
   * the hosts it had ALREADY passed proved fine WITH their carried clearance — discarding those
   * spends a fresh Cloudflare challenge each, from the very IP whose reputation this whole change is
   * trying to protect.
   */
  carryBlockedHosts: string[];
  /**
   * Last MEASURED proportional bytes (PSS) for the live browser tree; 0 means no measurement has
   * succeeded, which is not the same as a small browser and must never read as one.
   */
  memoryBytes: number;
  /** How that number was obtained, so /health can flag a reading it knows is overstated. */
  memoryMethod: MemoryMeasureMethod | null;
  /** When the last sample was ATTEMPTED — the throttle, deliberately separate from the evidence. */
  memorySampledAt: number;
  /**
   * Epoch ms before which no EVIDENCE relaunch is started on this lane. The backstop ignores it; the
   * proof-failure retry has its own, shorter clock (`retryAfter`).
   */
  nextRelaunchAllowedAt: number;
  /**
   * Current exponential backoff, grown each time a memory relaunch fails to bring the new tree under
   * the threshold. 0 means the plain interval applies.
   */
  relaunchBackoffMs: number;
  /**
   * Epoch ms by which the last memory relaunch must have shown a smaller tree. 0 ⇒ nothing to judge.
   */
  graceUntil: number;
  /** Evidence relaunches the rate limiter declined — the counter that should stay flat in production. */
  relaunchSuppressed: number;
  /** Why the most recent suppression happened, for /health and the log. */
  lastSuppressedReason: string | null;
  /** Throttle for the per-evaluation trigger log, which a busy lane would otherwise write per fetch. */
  lastGateLogAt: number;
  /** What that last log said, so a CHANGE of verdict is always reported even inside the throttle. */
  lastGateLogKey: string;
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
    lastRelaunchReason: null,
    navFailureStreak: 0,
    carryOverBlocked: false,
    carryBlockedHosts: [],
    memoryBytes: 0,
    memoryMethod: null,
    memorySampledAt: 0,
    nextRelaunchAllowedAt: 0,
    relaunchBackoffMs: 0,
    graceUntil: 0,
    relaunchSuppressed: 0,
    lastSuppressedReason: null,
    lastGateLogAt: 0,
    lastGateLogKey: '',
  };
}

/**
 * THE RATE LIMITER. Decide whether a lane may act on the trigger it just raised, and keep the
 * grace/backoff state machine moving. Pure apart from mutating `stats`, and driven by an injected
 * `now`, so the whole policy is testable on a fake clock without launching anything.
 *
 * WHY THIS EXISTS: #313 gave the lane evidence triggers but nothing to stop it acting on the same
 * evidence over and over. On 2026-09-11 a mis-measured memory trigger (VmRSS summed over a Chrome
 * tree, 3.76x overstated) fired within seconds of every launch, and because a successful relaunch
 * RESETS the measurement the next fetch simply re-measured the fresh tree and fired again: eight
 * residential relaunches in ten minutes, each spending a prime navigation on a Cloudflare-fronted
 * store, the eighth failing its proof and throwing the carried session away.
 *
 * Correct measurement alone would have fixed that instance. The limiter is here because it fixes the
 * CLASS: any trigger that is wrong, or right about something a relaunch cannot cure, now costs the
 * lane one prime navigation per interval instead of one per fetch.
 *
 * Pass `reason: null` on a quiet evaluation too — an open grace window has to be able to close.
 */
export function gateGatedRelaunch(
  reason: GatedRelaunchReason | null,
  stats: GatedLaneStats,
  now: number,
  limits: RelaunchGateLimits,
): { reason: GatedRelaunchReason | null; suppressed: string | null } {
  // 1. Settle any open grace window FIRST: did the last memory relaunch actually shrink the tree?
  //    The sample that answers this is taken fire-and-forget, so it may not have landed the instant
  //    the window closes. Wait for a number rather than recording "no verdict" on a race — but give
  //    up after one further window, so a lane that cannot measure at all never holds it open.
  if (stats.graceUntil > 0 && now >= stats.graceUntil) {
    if (stats.memoryBytes > 0) {
      if (stats.memoryBytes >= limits.thresholdBytes) {
        // A fresh browser as big as the one it replaced is not a leak this can cure. Double the wait.
        const grown = stats.relaunchBackoffMs > 0 ? stats.relaunchBackoffMs * 2 : limits.minIntervalMs * 2;
        stats.relaunchBackoffMs = Math.min(limits.backoffCapMs, grown);
        stats.nextRelaunchAllowedAt = now + stats.relaunchBackoffMs;
      } else {
        stats.relaunchBackoffMs = 0; // it worked — back to the plain interval
      }
      stats.graceUntil = 0;
    } else if (now >= stats.graceUntil + limits.graceMs) {
      stats.graceUntil = 0; // nothing to judge with, and no point waiting longer for it
    }
  }

  if (reason === null) return { reason: null, suppressed: null };

  // 2. The backstop is the last line of defence against whatever the evidence triggers miss, and a
  //    twelve-hour clock cannot storm. Everything else waits its turn.
  if (reason !== 'backstop' && now < stats.nextRelaunchAllowedAt) {
    stats.relaunchSuppressed++;
    const waitSeconds = Math.ceil((stats.nextRelaunchAllowedAt - now) / 1000);
    stats.lastSuppressedReason = `${reason} rate-limited, next attempt in ${waitSeconds}s`;
    return { reason: null, suppressed: stats.lastSuppressedReason };
  }
  return { reason, suppressed: null };
}

/**
 * Arm the rate limiter after a replacement has been PROVEN and installed. A memory relaunch also
 * opens the grace window that judges whether it helped; the other reasons have nothing to judge.
 */
export function noteGatedRelaunch(
  stats: GatedLaneStats,
  now: number,
  reason: GatedRelaunchReason,
  limits: RelaunchGateLimits,
): void {
  stats.nextRelaunchAllowedAt = now + Math.max(limits.minIntervalMs, stats.relaunchBackoffMs);
  stats.graceUntil = reason === 'rss' ? now + limits.graceMs : 0;
}

/**
 * Whether a cookie's `domain` covers `host`, by the cookie rule: a leading dot is decoration, and a
 * domain cookie covers the domain itself and everything under it.
 */
export function cookieAppliesToHost(domain: string | undefined, host: string): boolean {
  if (!domain) return false;
  const scope = domain.replace(/^\./, '').toLowerCase();
  if (scope === '') return false;
  const target = host.toLowerCase();
  return target === scope || target.endsWith(`.${scope}`);
}

/**
 * Drop only the cookies belonging to hosts a failed proof has implicated, keeping every clearance
 * that has done nothing wrong. `blockAll` is the escalation for a lane that has failed twice on the
 * same host: at that point the jar itself is the suspect.
 */
export function filterCarriedCookies<T extends { domain?: string }>(
  cookies: readonly T[],
  blockedHosts: readonly string[],
  blockAll = false,
): T[] {
  if (blockAll) return [];
  if (blockedHosts.length === 0) return [...cookies];
  return cookies.filter((cookie) => !blockedHosts.some((host) => cookieAppliesToHost(cookie.domain, host)));
}

/**
 * Record a failed carried proof against the host it failed on. A repeat on an ALREADY-blocked host
 * escalates to withholding the whole jar: one host's clearance was clearly not the problem.
 */
export function noteCarriedProofFailure(stats: GatedLaneStats, failedHost: string): void {
  const host = failedHost.toLowerCase();
  if (host === '') return;
  if (stats.carryBlockedHosts.includes(host)) {
    stats.carryOverBlocked = true;
    return;
  }
  stats.carryBlockedHosts = [...stats.carryBlockedHosts, host];
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
  /** Why the last relaunch happened, or null if this lane has not relaunched. */
  lastRelaunchReason: GatedRelaunchReason | null;
  navFailureStreak: number;
  /**
   * Last sampled PROPORTIONAL megabytes (PSS) for this browser and its renderers; null ⇒ not
   * measurable, which also means the memory trigger is inert and is the one silent failure mode here.
   */
  pssMb: number | null;
  /**
   * The same number under its old name, so the fleet check's gated-browser probe keeps working
   * across this deploy. It is PSS now, not a VmRSS sum — read `memoryMethod` to know which.
   */
  rssMb: number | null;
  /** `pss-rollup` / `pss-smaps` are the honest readings; `rss-fallback` OVERSTATES a Chrome tree. */
  memoryMethod: MemoryMeasureMethod | null;
  /** The threshold that measurement is being compared against, so /health explains its own verdict. */
  memoryThresholdMb: number;
  /** Evidence relaunches the rate limiter declined. Non-zero means a trigger is firing repeatedly. */
  relaunchSuppressed: number;
  /** Why the most recent suppression happened; null on a lane that has never been rate-limited. */
  lastSuppressedReason: string | null;
  /** ISO-8601 of the earliest next evidence relaunch; null when the lane is free to act now. */
  nextRelaunchAllowedAt: string | null;
  /** Current exponential backoff in ms; non-zero means relaunching did not bring memory down. */
  relaunchBackoffMs: number;
  /** Hosts whose clearances are being withheld from the next replacement after a failed proof. */
  carryBlockedHosts: string[];
}

/**
 * Project a live entry (and its lane's relaunch history) onto its health view. The stats default to
 * a never-relaunched lane so every existing caller keeps working and a lane reads as quiet rather
 * than as missing data.
 */
export function gatedBrowserView(
  entry: GatedBrowserEntry,
  stats: GatedLaneStats = newGatedLaneStats(),
  thresholdBytes: number = resolveGatedMaxRssBytes(),
): GatedBrowserView {
  const measuredMb = stats.memoryBytes === 0 ? null : Math.round(stats.memoryBytes / (1024 * 1024));
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
    lastRelaunchReason: stats.lastRelaunchReason,
    navFailureStreak: stats.navFailureStreak,
    pssMb: measuredMb,
    rssMb: measuredMb,
    memoryMethod: stats.memoryMethod,
    memoryThresholdMb: Math.round(thresholdBytes / (1024 * 1024)),
    relaunchSuppressed: stats.relaunchSuppressed,
    lastSuppressedReason: stats.lastSuppressedReason,
    nextRelaunchAllowedAt: stats.nextRelaunchAllowedAt === 0 ? null : new Date(stats.nextRelaunchAllowedAt).toISOString(),
    relaunchBackoffMs: stats.relaunchBackoffMs,
    carryBlockedHosts: [...stats.carryBlockedHosts],
  };
}
