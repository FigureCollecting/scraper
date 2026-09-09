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
 * HostRateLimiter, the same dispatch-time recording — differing only in what it keys on (the image
 * URL) and in that it also books the OUTCOME: a 429/403 from a CDN is exactly the signal the
 * limiter's backoff exists for.
 */
import type { HostRateLimiter } from '../../driver/hostRateLimiter.js';
import type { ImageBytesFailure, ImageBytesFetcher, ImageFetchOptions, ImageBytesResult } from './imageBytes.js';

/** Statuses that mean "you are going too fast / you are blocked" rather than "no such image". */
const BLOCKED_STATUSES = new Set([403, 429, 503]);

/** Injectable clock and sleeper — tests drive pacing deterministically, with no real timers. */
export interface ImageBytesPacingDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
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
    await awaitTurn(host);
    const result = await fetcher(url, options);
    // Cast rather than narrow on `ok`: this module is also compiled under the tests' non-strict
    // config, where a boolean discriminant does not narrow a union.
    const failure = result.ok ? undefined : (result as ImageBytesFailure);
    if (!failure) limiter.recordSuccess(host);
    else if (failure.reason === 'http-status' && failure.status !== undefined && BLOCKED_STATUSES.has(failure.status)) {
      limiter.recordRateLimited(host);
    }
    return result;
  };
}
