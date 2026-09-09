/**
 * imageBytesPacing — per-IMAGE-HOST throttling for the bytes lanes.
 *
 * The driver paces a store by ITS host, which is the right key for a page fetch and the wrong one
 * for an image: the bytes almost always come from somewhere else, and that somewhere is often SHARED
 * (cdn.shopify.com, cdn11.bigcommerce.com serve a large fraction of the stores in this engine).
 * Keyed on the store, a dozen stores would each hammer one CDN at their own individual rate; keyed on
 * the image host, that CDN gets ONE budget and every store draws from it.
 *
 * This is the bytes-lane counterpart of the driver's `wrapFetchBodyWithLimiter` — the same
 * HostRateLimiter, the same dispatch-time recording — differing in what it keys on (the image URL),
 * in that it also books the OUTCOME against that host's budget, and in that it honours the shared
 * CHALLENGE COOLDOWN: a host that has just served a challenge is not fetched at all. (The cooldown
 * on the STORE's host is the caller's gate, exactly as it is for the page lanes; this one covers the
 * image host, which for many stores is the store host itself.)
 */
import { getChallengeCooldown } from '../challengeCooldown.js';
import type { HostRateLimiter } from '../../driver/hostRateLimiter.js';
import type { ImageBytesFailure, ImageBytesFetcher, ImageFetchOptions, ImageBytesResult } from './imageBytes.js';

/** Statuses that mean "you are going too fast" on their own, with no further evidence needed. */
const RATE_LIMITED_STATUSES = new Set([429, 503]);

/**
 * Whether an outcome says something about the HOST's rate rather than about this one URL.
 *
 * 429/503 always do. A 403 usually does NOT — it is a hotlink guard, an expired signed URL or a
 * referrer policy answer, a per-URL verdict that will repeat for every image of that store; booking
 * it on a SHARED CDN drives one budget every store draws from to the ceiling over one store's
 * misconfiguration. So a 403 counts only when the response carried a genuine mitigation/throttle
 * signal ({@link BLOCK_SIGNAL_HEADERS}).
 *
 * Two non-status outcomes DO count, and used to book nothing: a 2xx body that is not an image is the
 * documented shape of a managed challenge or an interstitial (Cloudflare frequently answers 200),
 * and a timeout is the classic overload signal.
 */
function saysHostIsThrottling(failure: ImageBytesFailure): boolean {
  if (failure.reason === 'timeout') return true;
  if (failure.reason === 'not-image') return failure.status !== undefined && failure.status >= 200 && failure.status <= 299;
  if (failure.reason !== 'http-status' || failure.status === undefined) return false;
  if (RATE_LIMITED_STATUSES.has(failure.status)) return true;
  return failure.status === 403 && Object.keys(failure.signals ?? {}).length > 0;
}

/** The cooldown surface this wrapper reads — the shared register satisfies it structurally. */
export interface ChallengeCooldownLike {
  remaining(host: string): number;
}

/** Injectable clock, sleeper and cooldown register — tests drive pacing with no real timers. */
export interface ImageBytesPacingDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Default: the process-wide challenge cooldown register the queue and the lookup fan-out share. */
  cooldown?: ChallengeCooldownLike;
}

/**
 * The image URL's host (lowercased, trailing root dot stripped); undefined when the URL does not
 * parse — then nothing is paced. The trailing dot is stripped for the same reason the policy table
 * strips it: `cdn.shopify.com.` is the same CDN, and left alone it would draw a SECOND budget.
 */
function imageHostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.trim().toLowerCase().replace(/\.+$/, '');
  } catch {
    return undefined;
  }
}

/**
 * Wrap an image bytes fetcher so every call waits for, and is recorded against, the budget of the
 * host serving the IMAGE. The limiter normalizes the key itself (trim/lowercase/`www.`-strip), so
 * two spellings of one CDN collapse onto a single budget.
 *
 * The dispatch is recorded BEFORE the fetch (the driver's own convention: a concurrent decision must
 * already see this request in flight) and therefore also when the fetch throws — a fault must not
 * leave the host looking untouched.
 */
export function paceImageBytesByHost(
  fetcher: ImageBytesFetcher,
  limiter: HostRateLimiter,
  deps: ImageBytesPacingDeps = {},
): ImageBytesFetcher {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const cooldown = deps.cooldown ?? getChallengeCooldown();
  // One PROLOGUE at a time per host. The wait and the dispatch record are separated by an await, so
  // without this every concurrent caller reads the same msUntilReady before any of them records and
  // they all wake together — a PDP's dozen images arriving at a shared CDN in one burst, which is
  // exactly what the budget exists to prevent. The driver's own scheduler has no such gap (it checks
  // and records in one synchronous tick); this chain restores that property here.
  const prologues = new Map<string, Promise<void>>();
  const awaitTurn = (host: string): Promise<void> => {
    const tail = prologues.get(host) ?? Promise.resolve();
    const prologue = tail.then(async () => {
      const wait = limiter.msUntilReady(host, now());
      if (wait > 0) await sleep(wait);
      limiter.recordDispatch(host, now());
    });
    // The stored tail never rejects, so one failed prologue cannot wedge the host's whole queue.
    const chained = prologue.catch(() => undefined);
    prologues.set(host, chained);
    return prologue.finally(() => {
      // Drop the entry once this call is the last one on the chain, so an idle host costs nothing.
      if (prologues.get(host) === chained) prologues.delete(host);
    });
  };

  return async function pacedImageBytesFetch(url: string, options?: ImageFetchOptions): Promise<ImageBytesResult> {
    const host = imageHostOf(url);
    if (host === undefined) return fetcher(url, options);
    // COOLDOWN before anything else: a host that just served a challenge is left alone entirely —
    // the register's contract is that every subsequent request skips WITHOUT fetching, and an image
    // GET spends the same egress-IP reputation the cooldown was opened to preserve.
    const cooling = cooldown.remaining(host);
    if (cooling > 0) {
      return { ok: false, reason: 'refused', detail: `${host} is cooling from a Cloudflare challenge for another ${Math.ceil(cooling / 1000)}s` };
    }
    await awaitTurn(host);
    const result = await fetcher(url, options);
    // Cast rather than narrow on `ok`: this module is also compiled under the tests' non-strict
    // config, where a boolean discriminant does not narrow a union.
    const failure = result.ok ? undefined : (result as ImageBytesFailure);
    if (!failure) limiter.recordSuccess(host);
    else if (saysHostIsThrottling(failure)) limiter.recordRateLimited(host);
    return result;
  };
}
