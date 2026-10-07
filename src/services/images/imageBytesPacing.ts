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
 *
 * A store's MAIN host on the shared per-host clock (`SCRAPE_HOST_CLOCK`, see hostClock.ts) is paced
 * on that clock too, at the store's floor (QB-U30a): the image books its slot, sleeps, and on waking
 * passes the clock's SEND-TIME gate, re-checks the challenge cooldown and stamps the send, in one
 * synchronous step with the transport call. The queue's record dispatch passes the same gate, so an
 * image never leaves closer than the floor to a record or to another image of that host, measured at
 * the instant each request is handed to its transport, however late a timer fires. The limiter still
 * applies on top; every host the clock does not cover is paced exactly as before. Every main-host
 * image of a store, clocked or not, is reported to the clock's send-time observer.
 */
import { getChallengeCooldown } from '../challengeCooldown.js';
import { getHostClock, type HostClock } from '../hostClock.js';
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
  /** Default: the process-wide host clock the queue's record dispatch books (off unless scoped). */
  hostClock?: Pick<HostClock, 'floorFor' | 'reserve' | 'msUntilSendable' | 'sendWait' | 'settle' | 'markSent' | 'recordSend'>;
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
  const hostClock = deps.hostClock ?? getHostClock();
  // One PROLOGUE at a time per host. The wait and the dispatch record are separated by an await, so
  // without this every concurrent caller reads the same msUntilReady before any of them records and
  // they all wake together — a PDP's dozen images arriving at a shared CDN in one burst, which is
  // exactly what the budget exists to prevent. The driver's own scheduler has no such gap (it checks
  // and records in one synchronous tick); this chain restores that property here.
  const prologues = new Map<string, Promise<unknown>>();
  const awaitTurn = <T>(host: string, step: () => Promise<T>): Promise<T> => {
    const tail = prologues.get(host) ?? Promise.resolve();
    const prologue = tail.then(step);
    // The stored tail never rejects, so one failed prologue cannot wedge the host's whole queue.
    const chained = prologue.catch(() => undefined);
    prologues.set(host, chained);
    return prologue.finally(() => {
      // Drop the entry once this call is the last one on the chain, so an idle host costs nothing.
      if (prologues.get(host) === chained) prologues.delete(host);
    });
  };
  // A host the clock does not cover: wait out the limiter and record the dispatch; the caller fetches
  // once its turn resolves, exactly as before the clock existed.
  const limiterTurn = (host: string) => async (): Promise<void> => {
    const wait = limiter.msUntilReady(host, now());
    if (wait > 0) await sleep(wait);
    limiter.recordDispatch(host, now());
  };
  // A host on the shared clock: book the slot NOW, at the later of the limiter's ready time and the
  // clock's floor, so the queue sees it while this image sleeps. Awake, the image passes the
  // SEND-TIME gate under the WAIT RULE (plan-v3 rev 7, QB-U30b): an early timer, or a valid slot whose
  // gate another caller's late send pushed out, sleeps the rest WITHOUT re-booking (re-booking would
  // burn a full floor); only a LOST slot (the host was taken by another booking that is already due)
  // is booked again. Then, in one synchronous step: the cooldown is checked again (a challenge met
  // while this image waited, which on a clocked host can be several floors, closes the host to it as
  // well); the send is settled on the limiter and the clock; the transport is INVOKED; and the send is
  // recorded on the clock and the observer at the instant after that invocation (rev 7 SEND BLOCK).
  type Sent = { sent: Promise<ImageBytesResult> } | { refused: ImageBytesResult };
  const clockTurn = (host: string, floor: number, url: string, options: ImageFetchOptions | undefined) => async (): Promise<Sent> => {
    const start = now();
    let slot = hostClock.reserve(host, start + limiter.msUntilReady(host, start), floor);
    for (;;) {
      const at = now();
      const wait = hostClock.sendWait(host, slot, at, floor);
      if (wait === null) {
        slot = hostClock.reserve(host, at, floor);
        await sleep(Math.max(0, slot - at));
        continue;
      }
      if (wait === 0) {
        const cooling = cooldown.remaining(host);
        if (cooling > 0) {
          return { refused: { ok: false, reason: 'refused', detail: `${host} began cooling from a Cloudflare challenge while this image waited; another ${Math.ceil(cooling / 1000)}s` } };
        }
        limiter.recordDispatch(host, at);
        hostClock.settle(host, at, floor);
        const sent = fetcher(url, options);
        const sentAt = now();
        hostClock.markSent(host, sentAt);
        hostClock.recordSend(host, 'image', sentAt);
        return { sent };
      }
      await sleep(wait);
    }
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
    const floor = hostClock.floorFor(host);
    let result: ImageBytesResult;
    if (floor === undefined) {
      await awaitTurn(host, limiterTurn(host));
      hostClock.recordSend(host, 'image', now());
      result = await fetcher(url, options);
    } else {
      const turn = await awaitTurn(host, clockTurn(host, floor, url, options));
      if ('refused' in turn) return turn.refused;
      result = await turn.sent;
    }
    // Cast rather than narrow on `ok`: this module is also compiled under the tests' non-strict
    // config, where a boolean discriminant does not narrow a union.
    const failure = result.ok ? undefined : (result as ImageBytesFailure);
    if (!failure) limiter.recordSuccess(host);
    else if (saysHostIsThrottling(failure)) limiter.recordRateLimited(host);
    return result;
  };
}
