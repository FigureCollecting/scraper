/**
 * hostClockSend — the SEND BLOCK every QB-U30b caller runs on the shared per-host clock (plan-v3 rev 7,
 * design.host_clock.split_interface), so that no two page-level requests reach a store's main host
 * closer than its floor plus that send's jitter, whichever lane or route sends them.
 *
 * For a BLOCKING caller (the /catalog listing, seed and rotating fetches, POST /resolve, the legacy
 * /scrape route, /lookup, fetchBody follow-ups, a transport's extra request, the plugin routes):
 *
 *   0. ROLE, from the caller's own budget and minimum fetch: a host whose floor + J is above
 *      budget - slack - minimum fetch is not waited for (below).
 *   1. RESERVE the host's next slot at once (the queue sees it while this caller waits), refused when it
 *      is more than the WAIT CAP away (floor + J + SCRAPE_CATALOG_CLOCK_WAIT_SLACK_MS): the caller then
 *      gives its existing non-page outcome (the crawler's "stop this store for the pass") and nothing is
 *      sent; the refusal is counted per host and caller (clockRefusals60m).
 *   2. THE WAIT RULE: sleep (a timer, every iteration that does not send) until the gate opens; a slot
 *      still valid whose gate another caller's late send pushed out is slept out, NOT re-booked; only a
 *      LOST slot (another booking already due) is booked again. For a caller with a budget, a total
 *      wait past the cap (possible only after a re-book), or one that leaves the fetch no time, is
 *      refused at the gate, so wait + fetch stays within the budget.
 *   3. In ONE synchronous block, no await inside: the gate; the caller's veto (a challenge cooldown that
 *      opened while it waited); settle; INVOKE the transport without awaiting it; markSent + record the
 *      send at the instant AFTER the invocation (review 7: stamping before the call left the next send
 *      short by the synchronous work in between); then await. The fetch gets the budget minus the wait.
 *
 * A host whose floor + J is above the caller's ceiling is not waited for: the send goes at once and is
 * RECORDED on the clock (the queue's next record then waits a full floor after it). A host off the clock
 * (out of scope, or no store floor) is sent at once and reported to the observer only, exactly as before.
 *
 * Honest limit (design.host_clock.honest_limit): the recorded instant is the transport's invocation;
 * awaits inside the transport (an Impit session, a browser page from the pool) come after it.
 *
 * EVERY OUTBOUND SITE that can reach a store's main host from this process, and its caller name:
 *   queue           scrapeQueue.processViaIngest -> capturingFetch (impersonate | http | browser)  [QB-U30a]
 *   image           paceImageBytesByHost (store main host; a CDN or static host keeps its limiter) [QB-U30a]
 *   catalogListing  assembleCatalog.catalog (GET /catalog?store=&page=)
 *   catalogSeed     assembleCatalog.seed (GET /catalog?seed=)
 *   catalogRotating assembleCatalog.rotatingSeed (GET /catalog?list=)
 *   resolve         assembleResolve, each id's detail fetch (POST /resolve)
 *   scrape          routes/scraper.ts POST /scrape -> scrapeGeneric
 *   lookup          assembleLookup, each bySearch store fetch (POST /lookup); detail plans fetch nothing.
 *                   Its role comes from ITS budget (LOOKUP_STORE_TIMEOUT_MS) and minimum fetch (15 s).
 *   fetchBody       buildExtractContext: ctx.scraping.fetchBody and the scrapePage / scrapePageStealth
 *                   passthroughs (the queue's and /resolve's extraction; the crawl driver's
 *                   wrapFetchBodyWithLimiter wraps such a context and is not composed in index.ts)
 *   sessionPrime    every request after the first of one transport call: impit's prime / re-prime and
 *                   the target after it, the browser lane's target after a prime navigation, and a
 *                   relaunched gated browser's proof navigation
 *   pluginRoute     every PAGE-LEVEL request (a main-frame navigation) of a page the scraping service
 *                   handed to plugins (buildEngineServices) makes: the rulesets' /scrape/mfc,
 *                   /sync/validate-cookies, /sync/export-csv and /sync list workflows (withPage) and the
 *                   rulesets that hold it (amiami's API client, orzgk). Clocked at the REQUEST, whatever
 *                   started it: page.goto, reload, goBack/goForward, a main-frame goto, a click that
 *                   submits a form or follows a link (csv.ts's export submit, lists.ts's reload). While the
 *                   clock may hold it the page's requests are intercepted and a page-level one is held
 *                   for its send block (refused: aborted); otherwise nothing is intercepted and the
 *                   observer is fed from the page's request events. NOT clocked: a redirect hop (it
 *                   follows the navigation that passed), subresources and subframes (the honest limit:
 *                   page-level requests only), a popup or a page a plugin opens itself, and withBrowser,
 *                   which hands a plugin a whole browser (no ruleset calls it).
 * GET /catalog?range= synthesises its window and fetches nothing.
 */
import { getHostClock, type HostClock, type HostClockCaller, type HostClockLatencyKind } from './hostClock.js';

/** One blocking caller's send. */
export interface ClockedSendRequest {
  /** The host the request goes to (any spelling; the clock normalises it). */
  host: string;
  caller: HostClockCaller;
  /** The caller's whole budget (wait + fetch, ms); the transport is invoked with what the wait left. */
  budgetMs?: number;
  /**
   * The fetch time the caller must keep after its longest wait (default SCRAPE_CATALOG_MIN_FETCH_MS).
   * With `budgetMs` it decides the caller's ceiling: a host whose wait cap would leave less is recorded,
   * not waited for (/lookup's 35 s budget is not the catalog's 60 s).
   */
  minFetchMs?: number;
  /** Feed the host's listing p99 or /lookup p95 with this call's wait + fetch time. */
  latency?: HostClockLatencyKind;
  /** Checked in the send block, after any wait: a reason not to send now (e.g. a cooldown opened). */
  veto?: () => string | undefined;
}

export type ClockedSendResult<T> =
  | { sent: true; value: T; waitedMs: number }
  | { sent: false; refused: true; waitMs: number }
  | { sent: false; refused: false; reason: string };

/** Injectable clock, time and timer (tests); the defaults are the process clock, Date.now and setTimeout. */
export interface ClockedSendDeps {
  clock?: HostClock;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** The url's hostname, or undefined when it does not parse. */
export function hostOfUrl(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/** A send the clock refused: its slot is past the wait cap. Thrown by the throwing forms. */
export class HostClockRefusedError extends Error {
  constructor(
    readonly host: string,
    readonly caller: HostClockCaller,
    readonly waitMs: number,
    readonly capMs: number,
  ) {
    super(`[HOST-CLOCK] ${host} refused a ${caller} send: its slot is ${waitMs} ms away, past the ${capMs} ms cap`);
    this.name = 'HostClockRefusedError';
  }
}

/** Run one blocking caller's send on the clock (see the module doc). */
export async function sendOnHostClock<T>(
  request: ClockedSendRequest,
  invoke: (timeoutMs: number | undefined) => Promise<T>,
  deps: ClockedSendDeps = {},
): Promise<ClockedSendResult<T>> {
  const clock = deps.clock ?? getHostClock();
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? realSleep;
  const { host, caller, budgetMs } = request;
  const start = now();
  const awaitSent = async (sending: Promise<T>, waitedMs: number): Promise<ClockedSendResult<T>> => {
    try {
      return { sent: true, value: await sending, waitedMs };
    } finally {
      if (request.latency) clock.noteLatency(host, request.latency, now() - start, now());
    }
  };

  const role = clock.blockingRole(host, budgetMs, request.minFetchMs);
  if (role !== 'clocked') {
    const sending = invoke(budgetMs);
    const sentAt = now();
    if (role === 'recorded') clock.record(host, sentAt, caller);
    else clock.recordSend(host, caller, sentAt);
    return awaitSent(sending, 0);
  }

  const floor = clock.floorFor(host) as number;
  const cap = clock.capMsFor(host) as number;
  const refuse = (at: number, waitMs: number): ClockedSendResult<T> => {
    clock.noteRefusal(host, caller, at);
    return { sent: false, refused: true, waitMs };
  };
  let slot = clock.reserve(host, start, floor, cap);
  if (slot === null) return refuse(start, clock.nextSlot(host, start, floor) - start);
  for (;;) {
    const at = now();
    const wait = clock.sendWait(host, slot, at, floor);
    if (wait === null) {
      slot = clock.reserve(host, at, floor);
      await sleep(Math.max(0, slot - at));
      continue;
    }
    if (wait > 0) {
      await sleep(wait);
      continue;
    }
    // THE SEND BLOCK: nothing below awaits before the transport has been invoked and the send recorded.
    const waitedMs = at - start;
    // Never hand the transport a timeout of 0 or less: refused at the gate instead.
    if (budgetMs !== undefined && (waitedMs > cap || budgetMs - waitedMs <= 0)) return refuse(at, waitedMs);
    const reason = request.veto?.();
    if (reason !== undefined) return { sent: false, refused: false, reason };
    clock.settle(host, at, floor);
    const sending = invoke(budgetMs === undefined ? undefined : budgetMs - waitedMs);
    const sentAt = now();
    clock.markSent(host, sentAt);
    clock.recordSend(host, caller, sentAt);
    return awaitSent(sending, waitedMs);
  }
}

/** {@link sendOnHostClock} for a caller whose failure path is an exception: a refusal throws HostClockRefusedError, a veto an Error. */
export async function sendOnHostClockOrThrow<T>(
  request: ClockedSendRequest,
  invoke: (timeoutMs: number | undefined) => Promise<T>,
  deps: ClockedSendDeps = {},
): Promise<T> {
  const result = await sendOnHostClock(request, invoke, deps);
  if (result.sent) return result.value;
  if (result.refused) {
    const clock = deps.clock ?? getHostClock();
    throw new HostClockRefusedError(request.host, request.caller, result.waitMs, clock.capMsFor(request.host) ?? 0);
  }
  throw new Error(result.reason);
}

/**
 * For a TRANSPORT that sends more than one request in one call (a session prime before the target, a
 * re-prime and retry): its caller recorded the call's send when it invoked the transport, so
 *   - `first(url)`: the call's first request leaves now (e.g. the prime GET after the transport's own
 *     awaits): raise the host's last send to this instant, so what follows is spaced from it;
 *   - `send(url, caller, invoke)`: every LATER request of the call runs its own send block.
 */
export interface HostClockPacer {
  first(url: string): void;
  send<T>(url: string, caller: HostClockCaller, invoke: () => Promise<T>): Promise<T>;
}

/**
 * The pacer the engine's scraping service needs for the PLUGIN routes, whose pages are clocked at the
 * request (QB-U30b, caller 'pluginRoute'):
 *   - `holds(url?)`: whether the clock may hold a page-level request: to this url's host (it is on the
 *     clock), or, with no url (a plugin's own page, which may go anywhere), to any host (the clock is on);
 *   - `observe(url, caller)`: a page-level request the clock could not hold left now: the observer only.
 */
export interface PageRequestPacer extends HostClockPacer {
  holds(url?: string): boolean;
  observe(url: string, caller: HostClockCaller): void;
}

/** The pacer on the process clock (resolved at each call, so a test or a reload sees the current one). */
export function processHostClockPacer(deps: Omit<ClockedSendDeps, 'clock'> = {}): PageRequestPacer {
  const now = deps.now ?? Date.now;
  return {
    holds(url) {
      const clock = getHostClock();
      if (url === undefined) return clock.isOn();
      const host = hostOfUrl(url);
      return host !== undefined && clock.inScope(host);
    },
    observe(url, caller) {
      const host = hostOfUrl(url);
      if (host !== undefined) getHostClock().recordSend(host, caller, now());
    },
    first(url) {
      const host = hostOfUrl(url);
      if (host !== undefined) getHostClock().markSent(host, now());
    },
    send(url, caller, invoke) {
      const host = hostOfUrl(url);
      if (host === undefined) return invoke();
      return sendOnHostClockOrThrow({ host, caller }, () => invoke(), { ...deps, clock: getHostClock() });
    },
  };
}
