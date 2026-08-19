/**
 * HostRateLimiter — the new crawl driver's PER-HOST throttle.
 *
 * The legacy queue kept ONE global delay/backoff for every request. This keeps
 * an independent throttle per host, each seeded from that store's rate config
 * (StoreProfile `rateLimit`), so parallel stores never share a throttle and a
 * Cloudflare backoff on one host cannot slow another.
 *
 * Pure and synchronous: `msUntilReady` is the only time-aware method and takes
 * `now` explicitly, so behaviour is deterministic and testable without timers.
 */

import type { ExtractContext } from '@figurecollecting/scraper-plugin-contract';

/** The rate knobs the limiter needs. `DomainRateLimit` is structurally assignable. */
export interface HostRateConfig {
  baseDelayMs: number;
  minDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  recoveryDivisor: number;
  successThreshold: number;
}

interface HostState {
  config: HostRateConfig;
  currentDelay: number;
  lastRequestTime: number; // -1 = never dispatched
  consecutiveSuccesses: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * Host key: lowercased, trimmed, `www.`-stripped, so domain variants collapse to ONE state entry
 * (same normalization as ProfileRegistry.normalizeHost). Callers pass whatever raw string form
 * they have on hand — CrawlTask.host is StoreCapabilities.domains[0] verbatim, while a fetchBody
 * follow-up's key is parsed straight off the request URL (hostnameOf, below) — and this repo's
 * own fixtures already mix 'amiami.com'/'www.amiami.com' for the SAME store, so those two forms
 * are not guaranteed to be byte-identical. Normalizing here, at the single state-lookup seam
 * every method already funnels through, is what makes a fetchBody dispatch land on the SAME host
 * entry a primary dispatch created, regardless of which raw form either side used.
 */
const normalizeHost = (host: string): string => host.trim().toLowerCase().replace(/^www\./, '');

const DEFAULT_CONFIG: HostRateConfig = {
  baseDelayMs: 2067,
  minDelayMs: 274,
  maxDelayMs: 180_000,
  backoffMultiplier: 1.4,
  recoveryDivisor: 1.4,
  successThreshold: 3,
};

export class HostRateLimiter {
  private readonly hosts = new Map<string, HostState>();

  /**
   * @param configFor     resolves a host to its rate config (from its StoreProfile).
   * @param defaultConfig  used when `configFor` returns undefined (unmapped host).
   */
  constructor(
    private readonly configFor: (host: string) => HostRateConfig | undefined,
    private readonly defaultConfig: HostRateConfig = DEFAULT_CONFIG,
  ) {}

  private stateFor(rawHost: string): HostState {
    const host = normalizeHost(rawHost);
    let s = this.hosts.get(host);
    if (!s) {
      const config = this.configFor(host) ?? this.defaultConfig;
      s = { config, currentDelay: config.baseDelayMs, lastRequestTime: -1, consecutiveSuccesses: 0 };
      this.hosts.set(host, s);
    }
    return s;
  }

  /** The host's current inter-request delay (ms). */
  currentDelay(host: string): number {
    return this.stateFor(host).currentDelay;
  }

  /** Ms until the next request to this host may dispatch (0 = ready now). */
  msUntilReady(host: string, now: number): number {
    const s = this.stateFor(host);
    if (s.lastRequestTime < 0) return 0; // never dispatched → ready
    return Math.max(0, s.lastRequestTime + s.currentDelay - now);
  }

  /** Mark a request dispatched to this host at `now`. */
  recordDispatch(host: string, now: number): void {
    this.stateFor(host).lastRequestTime = now;
  }

  /** A success: recover the delay one step after `successThreshold` in a row. */
  recordSuccess(host: string): void {
    const s = this.stateFor(host);
    s.consecutiveSuccesses += 1;
    if (s.consecutiveSuccesses >= s.config.successThreshold) {
      s.currentDelay = clamp(
        s.currentDelay / s.config.recoveryDivisor,
        s.config.minDelayMs,
        s.config.maxDelayMs,
      );
      s.consecutiveSuccesses = 0;
    }
  }

  /** A rate-limit / block: back the delay off and reset the success streak. */
  recordRateLimited(host: string): void {
    const s = this.stateFor(host);
    s.currentDelay = clamp(
      s.currentDelay * s.config.backoffMultiplier,
      s.config.minDelayMs,
      s.config.maxDelayMs,
    );
    s.consecutiveSuccesses = 0;
  }
}

/**
 * Lowercased hostname, undefined on an unparseable URL. Handed to HostRateLimiter as-is — its own
 * `stateFor` normalizes (www-strip/trim/lowercase) on the way in, so this need not match
 * CrawlTask.host's raw string form; the limiter is what makes the two forms collapse.
 */
function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.trim().toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Wrap an ExtractContext's `scraping.fetchBody` so every in-slot follow-up call ALSO records a
 * dispatch on the given HostRateLimiter (H1 seam 2, spec.md orzgk Slice B): without this, a
 * ruleset's `ctx.scraping.fetchBody` (extractMany's same-store follow-up, courtesy-gapped by
 * buildExtractContext against ITS OWN prior call) is invisible to the driver's scheduler — the
 * NEXT primary dispatch to that host would only know about the earlier PRIMARY fetch's timing,
 * understating how recently the host was actually contacted. A context with no `fetchBody`
 * (nothing to route) is returned UNCHANGED (same reference), so callers that don't touch it see
 * no behavioural difference.
 */
export function wrapFetchBodyWithLimiter(
  ctx: ExtractContext,
  limiter: HostRateLimiter,
  now: () => number = Date.now,
): ExtractContext {
  const original = ctx.scraping.fetchBody;
  if (!original) return ctx;

  return {
    ...ctx,
    scraping: {
      ...ctx.scraping,
      fetchBody: async (url, opts) => {
        // Record at CALL time (matching DispatchScheduler.dispatch's own convention for primary
        // dispatches), not once the fetch resolves — a same-host primary dispatch decision made
        // WHILE this follow-up is still in flight must already see it, or the two can be paced
        // far closer together than baseDelayMs intends (H1 finding: dispatch-time race).
        const host = hostnameOf(url);
        if (host !== undefined) limiter.recordDispatch(host, now());
        return original(url, opts);
      },
    },
  };
}
