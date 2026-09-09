/**
 * imageCaptureHook — where a successful extraction becomes stored ORIGINALS.
 *
 * It runs after `extractRecords` and beside the emit, never inside it. That placement is the whole
 * design: by the time this is reached the item's fate is already decided, so nothing here may change
 * it. A CDN that 403s, a lane that times out, a bucket that is unreachable, a ruleset whose
 * describeImages throws — every one of them is counted, at most one is logged per host per hour, and
 * the item that extracted fine still extracted fine.
 *
 * WHAT IT DOES NOT DO, deliberately, in this first landing: it writes no spine rows. The bytes land
 * in the content-addressed bucket with the provenance that says which item page referenced them and
 * where in that page's list they sat; the rows that make them a queryable gallery are a later step,
 * and separating them means the corpus can be accumulating while that shape is still being argued
 * about. Nothing here is lost if the row model changes — the objects are addressed by their content.
 *
 * The order of the decisions below is not arbitrary. Each one is cheaper than the one after it, and
 * the two that protect something outside this process — the permaban and the home line's daily
 * budget — sit BEFORE the network, never after:
 *
 *   role filter → dedupe → cap        (the ruleset's list, reduced to what this landing captures)
 *   memo                              (already have it; do not spend a request finding that out)
 *   lane + policy, deny list first    (may this be fetched at all, and how)
 *   residential budget                (has the house carried enough today)
 *   fetch, paced per image host       (the CDN's budget, shared across every store pointing at it)
 *   classify → dedupe by content      (two urls, one file)
 *   sink                              (content-addressed write)
 */
import type { ExtractionRuleset, SearchFetch } from '@figurecollecting/scraper-plugin-contract';
import { buildRawCapture, wasAdmitted, type CaptureAdmission, type CaptureSink } from '../captureSink.js';
import type { FetchOriginName, FetchFailureReport, ReportFetchFailure } from '../failureReporter.js';
import type { FetchReasonClass } from '../failureClassifier.js';
import { isDeclaringStoreUrl } from '../residentialEgress.js';
import { sanitizeForLog } from '../../utils/security.js';
import {
  chooseImageLane,
  isDeniedImageUrl,
  type ImageEgress,
  type ImageHostPolicy,
  type ImageLane,
} from './imageHostPolicy.js';
import { resolveImageUserAgent, type ImageBytesFailure, type ImageBytesFetcher, type ImageFetchOptions } from './imageBytes.js';
import { normalizeImageRefs, type PlannedImageRef } from './imageRefs.js';
import { createImageUrlMemo, createResidentialByteBudget } from './imageCaptureState.js';
import type { GatedTabBytesFetcher } from './gatedTabBytesFetch.js';

/** All gallery images of one item, per the owner's decision. */
export const DEFAULT_IMAGE_MAX_PER_ITEM = 12;
/** Roughly a day of urls at ingest volume; the memo is an optimization, so its size is not critical. */
export const DEFAULT_IMAGE_MEMO_SIZE = 50_000;
/** 1 GiB. The ceiling is on the LINE — it is somebody's house, not a datacentre uplink. */
export const DEFAULT_RESIDENTIAL_BYTES_PER_DAY = 1024 * 1024 * 1024;
/**
 * How many image fetches may be OPEN at once, across every item and every host.
 *
 * The lane's own design makes this necessary. Capture is fire-and-forget precisely so an item never
 * waits on a CDN — which means NOTHING upstream applies backpressure to it, and a queue processing
 * two hundred items concurrently would open two hundred image fetches. Per-host pacing does not
 * bound that: its budget is per CDN, and a catalogue sweep spans many. Six is a background lane's
 * share of a pod that is also serving lookups and ingest.
 */
export const DEFAULT_IMAGE_FETCH_CONCURRENCY = 6;
/**
 * How many ITEMS may be waiting for their turn before new ones are dropped.
 *
 * The concurrency bound alone only limits open sockets; the backlog behind it still grows without
 * limit, one job per item, for as long as ingest outruns the image lane. Dropping is the right
 * answer and not a loss: the item's own outcome is already decided, the store's plates are still
 * there on the next pass, and the memo means the pass that does catch them pays for them once.
 */
export const DEFAULT_IMAGE_INFLIGHT_MAX = 500;
/** At most one log line per image host per hour; the counters carry the volume. */
const HOST_LOG_INTERVAL_MS = 60 * 60_000;

/**
 * A counting semaphore with a FIFO queue of waiters. A waiter is resumed HOLDING the permit (the
 * count is never handed back to the pool in between), so a release cannot be won by a later arrival.
 */
function createSemaphore(permits: number): { acquire(): Promise<void>; release(): void } {
  let free = Math.max(1, Math.floor(Number.isFinite(permits) ? permits : 1));
  const waiters: Array<() => void> = [];
  return {
    acquire(): Promise<void> {
      if (free > 0) {
        free -= 1;
        return Promise.resolve();
      }
      return new Promise<void>(resolve => waiters.push(resolve));
    },
    release(): void {
      const next = waiters.shift();
      if (next) next();
      else free += 1;
    },
  };
}

/**
 * The fetch options PLUS the routing decision, carried on the same object.
 *
 * The three bytes lanes share one `ImageBytesFetcher` signature, and the pacing wrapper must sit
 * OUTSIDE the choice between them — one wrapper, one per-host budget, whichever lane a given image
 * ends up on. So the lane travels as data on the options the wrapper already passes through
 * untouched, and {@link createImageBytesRouter} reads it at the bottom.
 */
export interface ImageFetchPlan extends ImageFetchOptions {
  lane: ImageLane;
  /** The DECLARING store's host — what the gated browser's session and tab budget are keyed on. */
  storeHost: string;
  /** The store declared a Cloudflare gate; only then is the browser lane pinned to the gated browser. */
  challengeGated?: boolean;
}

/** The three lanes, as the router expects them. A lane that is absent is refused, not defaulted. */
export interface ImageBytesLanes {
  http?: ImageBytesFetcher;
  impit?: ImageBytesFetcher;
  gated?: GatedTabBytesFetcher;
}

/**
 * One fetcher over all three lanes, dispatching on the plan. Wrap THIS in `paceImageBytesByHost`
 * (not each lane separately): the budget belongs to the host serving the image, and a CDN reachable
 * on two lanes is still one CDN.
 */
export function createImageBytesRouter(lanes: ImageBytesLanes): ImageBytesFetcher {
  return async (url, options) => {
    const plan = (options ?? {}) as ImageFetchPlan;
    if (plan.lane === 'browser') {
      if (!lanes.gated) return { ok: false, reason: 'unsupported', detail: 'the browser bytes lane is not configured' };
      return lanes.gated(plan.egress ?? 'direct', plan.storeHost, url, plan);
    }
    const fetcher = plan.lane === 'impit' ? lanes.impit : lanes.http;
    if (!fetcher) return { ok: false, reason: 'unsupported', detail: `the ${plan.lane} bytes lane is not configured` };
    return fetcher(url, plan);
  };
}

/** Why a described image never became stored bytes. Every refusal has exactly one name. */
export interface ImageCaptureSkipCounts {
  /**
   * Refused before the network: the deny list, a url that is not fetchable, a role outside the
   * capture rule, a lane/egress pairing that has no transport, or residential egress with no proxy.
   */
  policyDeny: number;
  /** This exact url was already fetched and handed on. */
  memo: number;
  thumbnailRole: number;
  userRole: number;
  /** Past `IMAGE_MAX_PER_ITEM` for this item. */
  cap: number;
  /** The residential line's rolling daily byte ceiling was already reached. */
  residentialBudget: number;
  /** A 2xx body that was not an image — a hotlink interstitial, a challenge page, an error document. */
  notImage: number;
  /** A body past the image size cap. */
  tooLarge: number;
  /**
   * WE declined the bytes: an image host inside a challenge cooldown, a redirect off the declaring
   * store, a residential fetch whose proxy did not resolve. Our policy, not the store's answer.
   */
  refused: number;
  /** The lane could not carry bytes at all (an impit build exposing only `text()`). Our build. */
  unsupported: number;
  /** Dropped un-attempted because too many items were already waiting for the lane. */
  inFlight: number;
  /**
   * FETCHED, then refused by the raw-store sink: its queue was full, or it was above
   * the share of that queue this lane may occupy (the reservation that keeps images
   * from evicting page bodies — the sink names which in its own log). Counted here as
   * well as in `failed` on purpose: these bytes cost us a request and were thrown
   * away, and the named reason is what separates "the store is behind" from "the store
   * is broken". The url is deliberately NOT memoized, so the next pass tries again.
   */
  sinkQueueFull: number;
}

export interface ImageCaptureStats {
  /** Whether the lane is running at all. Needs BOTH the switch and a configured raw store. */
  enabled: boolean;
  /**
   * Why it is not, when it is not. An operator looking at `enabled: false` with `PERSIST_RAW_IMAGES`
   * plainly set to `true` has no other way to find the missing half. Absent when the lane is on.
   */
  reason?: string;
  /** Images an actual request was issued for. */
  attempted: number;
  /** Captures handed to the asset lane. The sink's own counters say what LANDED. */
  stored: number;
  /** Bytes this process had already handed on under another url — not re-sent. */
  deduped: number;
  skipped: ImageCaptureSkipCounts;
  /** Fetches, sink writes and ruleset descriptions that failed. Never affects an item. */
  failed: number;
  /** Bytes carried by the residential exit in the last rolling 24 hours. */
  residentialBytesToday: number;
}

/** One item's images, as the hook is asked to capture them. */
export interface ImageCaptureRequest {
  /** The DECLARING store's siteId — the ledger and the object metadata key on it. */
  site: string;
  itemId: string;
  /** The page the images were referenced from: the resolve base, the Referer, and the provenance. */
  pageUrl: string;
  /** The fields the extraction just produced; only the ruleset reads them. */
  fields: Record<string, unknown>;
  /** The store's ruleset. Only `describeImages` is consulted; a ruleset without it captures nothing. */
  ruleset: Pick<ExtractionRuleset, 'describeImages'>;
  /** The store's declared page transport — feeds the lane decision's on-store suffix rule. */
  searchFetch?: SearchFetch;
  /** Which leg asked, for the failure ledger. */
  origin: FetchOriginName;
}

/**
 * One item's capture work, AFTER the ruleset has been asked and the engine's capture rule applied.
 *
 * This is deliberately not the request: a request carries the whole extraction's `fields`, and a job
 * that may sit in a backlog for minutes must not pin one. Planning happens synchronously, in the
 * caller's own stack, and what is queued is a handful of urls.
 */
interface PlannedCapture {
  site: string;
  itemId: string;
  pageUrl: string;
  searchFetch: SearchFetch | undefined;
  origin: FetchOriginName;
  refs: PlannedImageRef[];
}

export interface ImageCaptureHookDeps {
  sink: CaptureSink;
  policy: ImageHostPolicy;
  /** The PACED bytes fetcher (a `createImageBytesRouter` wrapped in `paceImageBytesByHost`). */
  fetchBytes: ImageBytesFetcher;
  /** Resolves the residential proxy. Absent (or undefined for `residential`) ⇒ the fetch is refused. */
  proxyUrlFor?: (egress: ImageEgress) => string | undefined;
  /** The durable fetch-failure ledger. Absent ⇒ failures are counted and logged but not persisted. */
  reportFailure?: ReportFetchFailure;
  /** Whether the lane runs. Default true — the composition root owns both halves of that answer. */
  enabled?: boolean;
  /** Why it does not, published on the health view. Ignored when `enabled` is not false. */
  disabledReason?: string;
  maxPerItem?: number;
  memoSize?: number;
  residentialBytesPerDay?: number;
  /** Open image fetches allowed at once (default {@link DEFAULT_IMAGE_FETCH_CONCURRENCY}). */
  concurrency?: number;
  /** Items allowed to be waiting before new requests are dropped (default {@link DEFAULT_IMAGE_INFLIGHT_MAX}). */
  inFlightMax?: number;
  now?: () => number;
  warn?: (message: string) => void;
}

export interface ImageCaptureHook {
  /** Capture one item's images. NEVER throws and never rejects: the item's outcome is already fixed. */
  capture(request: ImageCaptureRequest): Promise<void>;
  /** Await every capture a caller fired and forgot — for tests and for a clean shutdown. */
  drain(): Promise<void>;
  stats(): ImageCaptureStats;
}

/** The store's host, for the gated browser's session key. Empty when the page url does not parse. */
function storeHostOf(pageUrl: string): string {
  try {
    return new URL(pageUrl).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * The ledger's reason class for a failed image fetch. Named by what the STORE said, so an image row
 * reads the same way a record row does: a 404 is a gone item, not a parse problem of ours.
 *
 * Only outcomes the store actually produced reach here. 'refused' and 'unsupported' are OUR OWN
 * decisions and are counted as skips before this is called — the ledger records what stores did.
 */
function reasonClassFor(failure: ImageBytesFailure): FetchReasonClass {
  switch (failure.reason) {
    case 'timeout':
      return 'timeout';
    case 'http-status':
      if (failure.status === 404) return 'gone_404';
      if (failure.status === 410) return 'gone_410';
      if (failure.status === 403) return 'http_403';
      if (failure.status === 429) return 'http_429';
      if (failure.status !== undefined && failure.status >= 500) return 'http_5xx';
      return 'other';
    default:
      return 'other';
  }
}

/**
 * Build the hook. Everything it touches is injected, so the whole decision chain is exercised with
 * fakes — no browser, no bucket, no store, and no clock.
 */
export function createImageCaptureHook(deps: ImageCaptureHookDeps): ImageCaptureHook {
  const enabled = deps.enabled !== false;
  const now = deps.now ?? Date.now;
  // eslint-disable-next-line no-console
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  const maxPerItem = deps.maxPerItem ?? DEFAULT_IMAGE_MAX_PER_ITEM;
  const memo = createImageUrlMemo(deps.memoSize ?? DEFAULT_IMAGE_MEMO_SIZE);
  const budget = createResidentialByteBudget(deps.residentialBytesPerDay ?? DEFAULT_RESIDENTIAL_BYTES_PER_DAY);

  let attempted = 0;
  let stored = 0;
  let deduped = 0;
  let failed = 0;
  const skipped: ImageCaptureSkipCounts = {
    policyDeny: 0,
    memo: 0,
    thumbnailRole: 0,
    userRole: 0,
    cap: 0,
    residentialBudget: 0,
    notImage: 0,
    tooLarge: 0,
    refused: 0,
    unsupported: 0,
    inFlight: 0,
    sinkQueueFull: 0,
  };
  const lastLoggedByHost = new Map<string, number>();
  const inFlight = new Set<Promise<void>>();
  const gate = createSemaphore(deps.concurrency ?? DEFAULT_IMAGE_FETCH_CONCURRENCY);
  const inFlightMax = Math.max(1, Math.floor(deps.inFlightMax ?? DEFAULT_IMAGE_INFLIGHT_MAX));

  /**
   * One line per host per hour, whatever the volume. An image lane that has started failing does so
   * for every image of that host at once, and a dozen items an hour turn that into a log nobody
   * reads — while the counters carry the real volume losslessly.
   */
  const logOncePerHost = (host: string, message: string): void => {
    const last = lastLoggedByHost.get(host);
    const at = now();
    if (last !== undefined && at - last < HOST_LOG_INTERVAL_MS) return;
    lastLoggedByHost.set(host, at);
    warn(message);
  };

  const report = async (partial: Omit<FetchFailureReport, 'kind'>): Promise<void> => {
    if (!deps.reportFailure) return;
    try {
      // The ledger is a best-effort observer of a best-effort lane; a ledger that is down must not
      // turn one unstored image into a second failure.
      await deps.reportFailure({ ...partial, kind: 'image' });
    } catch {
      /* the ledger's own reporter already swallows; this covers an injected one that does not */
    }
  };

  const captureOne = async (job: PlannedCapture, url: string, role: string, position: number): Promise<void> => {
    if (memo.hasUrl(url)) {
      skipped.memo += 1;
      return;
    }
    const decision = chooseImageLane(job.pageUrl, url, job.searchFetch, deps.policy);
    if (!decision.ok) {
      skipped.policyDeny += 1;
      // A deny-list hit is the table doing exactly its job and needs no log. The other two refusals
      // are the operator's table CONTRADICTING ITSELF — a lane that cannot proxy, or a residential
      // exit pointed at a host it may not carry — and they are invisible in the counters, which fold
      // all three into one number. Said once per host, they are a line an operator can act on.
      if (decision.reason !== 'denied') {
        logOncePerHost(
          `policy:${storeHostOf(url) || url}`,
          `[IMAGE-CAPTURE] policy refuses ${sanitizeForLog(url)} (${decision.reason})${
            decision.detail ? `: ${sanitizeForLog(decision.detail)}` : ''
          }`,
        );
      }
      return;
    }
    let proxyUrl: string | undefined;
    if (decision.egress === 'residential') {
      // The budget is checked BEFORE the request, so the day's last image may overshoot by one body.
      // Sizing it to the byte would need a length the store has not sent yet.
      if (!budget.hasRoom(now())) {
        skipped.residentialBudget += 1;
        return;
      }
      proxyUrl = deps.proxyUrlFor?.('residential');
      if (!proxyUrl) {
        // A residential store fetched from the node IP is the one outcome this must never produce:
        // it burns the reputation of the address every other store is also reached from.
        skipped.policyDeny += 1;
        return;
      }
    }
    const userAgent = resolveImageUserAgent(decision.ua);
    const plan: ImageFetchPlan = {
      lane: decision.lane,
      storeHost: storeHostOf(job.pageUrl),
      egress: decision.egress,
      ...(job.searchFetch?.access === 'cloudflare' ? { challengeGated: true } : {}),
      ...(decision.referer !== undefined ? { referer: decision.referer } : {}),
      // Only when the TABLE named one. Absent, the lane sends its own archival Accept — the header
      // that keeps a negotiating CDN from answering with a re-encode instead of the original.
      ...(decision.accept !== undefined ? { accept: decision.accept } : {}),
      ...(userAgent !== undefined ? { userAgent } : {}),
      ...(proxyUrl !== undefined ? { proxyUrl } : {}),
      // Re-assert on what the bytes ACTUALLY came from: the lane decision only ever saw the
      // requested url, and a redirect can land on a banned host, or carry a residential fetch off
      // the store that declared the exit.
      allowFinalUrl: (finalUrl: string) =>
        !isDeniedImageUrl(finalUrl) && (decision.egress !== 'residential' || isDeclaringStoreUrl(finalUrl, job.pageUrl)),
    };

    attempted += 1;
    const host = storeHostOf(url) || url;
    let result;
    // The GATE, taken around the fetch alone: everything before it is a decision (pure, instant) and
    // everything after is a hash and a write. Holding a permit across those would mean six images
    // could be resident while none of them is on the wire.
    await gate.acquire();
    try {
      result = await deps.fetchBytes(url, plan);
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      logOncePerHost(host, `[IMAGE-CAPTURE] ${sanitizeForLog(host)} image fetch faulted: ${sanitizeForLog(message)}`);
      await report({
        site: job.site,
        itemId: job.itemId,
        target: url,
        origin: job.origin,
        reasonClass: 'network',
        message,
        transport: decision.lane,
      });
      return;
    } finally {
      gate.release();
    }

    if (!result.ok) {
      const failure = result as ImageBytesFailure;
      // BOOK FIRST, whatever the verdict. The home line carried these bytes; that the lane then
      // rejected them is a fact about the body, not about the connection. Booking only on success
      // would let a store answering every image with an interstitial run all day against a counter
      // that never moves.
      if (decision.egress === 'residential' && failure.bytesRead !== undefined) {
        budget.record(failure.bytesRead, now());
      }
      // not-image and too-large are VERDICTS, not faults: the store answered, and what it answered
      // with is not something this lane stores. Reporting them would fill the ledger with rows an
      // operator can do nothing about.
      if (failure.reason === 'not-image') {
        skipped.notImage += 1;
        return;
      }
      if (failure.reason === 'too-large') {
        skipped.tooLarge += 1;
        return;
      }
      // OURS, not theirs. 'refused' is this engine declining the bytes (a cooling host, a redirect
      // off the declaring store, a residential fetch with no proxy) and 'unsupported' is this
      // BUILD's lane being unable to carry them. Neither is anything the store did, so neither is
      // filed in the store's fetch-failure ledger — a ledger full of our own policy decisions is a
      // triage queue nobody can act on, and it would misattribute our configuration to their site.
      // They are still logged, once per host, so they are counted but never silent.
      const ours = failure.reason === 'refused' || failure.reason === 'unsupported';
      const message = `[IMAGE-CAPTURE] ${sanitizeForLog(host)} image ${ours ? 'fetch refused by this engine' : 'fetch failed'} (${
        failure.reason
      }${failure.status !== undefined ? ` ${failure.status}` : ''})${failure.detail ? `: ${sanitizeForLog(failure.detail)}` : ''}`;
      if (ours) {
        if (failure.reason === 'refused') skipped.refused += 1;
        else skipped.unsupported += 1;
        logOncePerHost(host, message);
        return;
      }
      failed += 1;
      logOncePerHost(host, message);
      await report({
        site: job.site,
        itemId: job.itemId,
        target: url,
        origin: job.origin,
        reasonClass: reasonClassFor(failure),
        ...(failure.status !== undefined ? { httpStatus: failure.status } : {}),
        ...(failure.detail !== undefined ? { message: failure.detail } : {}),
        transport: decision.lane,
      });
      return;
    }

    if (decision.egress === 'residential') budget.record(result.bytes.length, now());

    // What the SERVER declared, not what classification settled on: `declared-content-type` is the
    // store's own claim, and the sniffed type it falls back to is already the object's real
    // Content-Type. Alongside it go the two negotiation witnesses — with the archival Accept in
    // place a re-encode should not happen, and if one does, the object says so.
    const served = result.headers['content-type'] ?? result.contentType;
    const capture = buildRawCapture({
      url,
      finalUrl: result.finalUrl,
      lane: 'asset',
      bytes: result.bytes,
      statusCode: result.status,
      contentType: served,
      ...(result.headers['content-encoding'] !== undefined ? { contentEncoding: result.headers['content-encoding'] } : {}),
      ...(result.headers.vary !== undefined ? { vary: result.headers.vary } : {}),
      sourceItem: { site: job.site, itemId: job.itemId },
      sourceUrl: job.pageUrl,
      position,
      role,
    });
    // Content dedupe, after the fetch because only the bytes can answer it: a store that versions its
    // urls (`?v=`) serves the same file under many names, and the bucket is addressed by content.
    if (memo.hasSha(capture.sha256)) {
      deduped += 1;
      memo.remember(url, capture.sha256);
      return;
    }
    try {
      const admission = await deps.sink.capture(capture);
      if (!wasAdmitted(admission)) {
        // The sink had no room for these bytes — its queue was full, or this lane was
        // over its share of it — so they are gone. Counting that as stored and
        // remembering the url would be the worst of both outcomes: the capture is lost
        // AND the retry that would have recovered it is suppressed.
        failed += 1;
        skipped.sinkQueueFull += 1;
        const why = (admission as CaptureAdmission | undefined)?.reason ?? 'refused';
        logOncePerHost(
          host,
          `[IMAGE-CAPTURE] raw-store took no capture (${why}) — ${sanitizeForLog(url)} not stored, will retry`,
        );
        return;
      }
      stored += 1;
      // Remembered only on a write that did not throw: a url whose bytes never reached the sink must
      // be retried on the next pass, not memoized as done.
      memo.remember(url, capture.sha256);
    } catch (err) {
      failed += 1;
      logOncePerHost(
        host,
        `[IMAGE-CAPTURE] storing ${sanitizeForLog(url)} failed: ${sanitizeForLog(err instanceof Error ? err.message : String(err))}`,
      );
    }
  };

  /**
   * Ask the ruleset what the item's images are and apply the engine's capture rule — SYNCHRONOUSLY,
   * in the caller's own stack, before anything is queued. That ordering is the point: a job that
   * waits in the backlog then holds a handful of urls rather than a whole extraction's `fields`.
   */
  const planCapture = (request: ImageCaptureRequest): PlannedCapture | undefined => {
    if (!enabled || typeof request.ruleset.describeImages !== 'function') return undefined;
    let described;
    try {
      described = request.ruleset.describeImages(request.fields);
    } catch (err) {
      // A broken describeImages is a RULESET fault, and it is counted as one — but the extraction it
      // came from already succeeded, so it cannot be allowed to retract that.
      failed += 1;
      logOncePerHost(
        `ruleset:${request.site}`,
        `[IMAGE-CAPTURE] ${sanitizeForLog(request.site)} describeImages threw: ${sanitizeForLog(err instanceof Error ? err.message : String(err))}`,
      );
      return undefined;
    }
    const normalized = normalizeImageRefs(described, request.pageUrl, maxPerItem);
    skipped.thumbnailRole += normalized.skipped.thumbnailRole;
    skipped.userRole += normalized.skipped.userRole;
    skipped.cap += normalized.skipped.cap;
    skipped.policyDeny += normalized.skipped.policyDeny;
    if (normalized.refs.length === 0) return undefined;
    return {
      site: request.site,
      itemId: request.itemId,
      pageUrl: request.pageUrl,
      searchFetch: request.searchFetch,
      origin: request.origin,
      refs: normalized.refs,
    };
  };

  const run = async (job: PlannedCapture): Promise<void> => {
    // SEQUENTIAL within one item on purpose, on top of the global gate: the per-host pacing would
    // serialize a shared CDN anyway, and a gallery fired in parallel would hold a browser tab per
    // image on the gated lane.
    for (const ref of job.refs) {
      await captureOne(job, ref.url, ref.role, ref.position);
    }
  };

  return {
    capture(request: ImageCaptureRequest): Promise<void> {
      let job: PlannedCapture | undefined;
      try {
        job = planCapture(request);
      } catch (err) {
        // planCapture is total; this is the guard for a bug in it. A synchronous throw here would
        // otherwise reach a caller that is not allowed to fail because of images.
        failed += 1;
        warn(`[IMAGE-CAPTURE] planning aborted: ${sanitizeForLog(err instanceof Error ? err.message : String(err))}`);
        return Promise.resolve();
      }
      if (!job) return Promise.resolve();
      // The CEILING. Dropping beats queueing: the item's outcome is already decided, the store's
      // plates will still be there next pass, and an unbounded backlog is how a background lane
      // takes a pod down instead of merely running behind.
      if (inFlight.size >= inFlightMax) {
        skipped.inFlight += job.refs.length;
        logOncePerHost(
          'inflight',
          `[IMAGE-CAPTURE] ${inFlight.size} items already waiting — dropping ${job.refs.length} image(s) of ${sanitizeForLog(job.site)}/${sanitizeForLog(job.itemId)}`,
        );
        return Promise.resolve();
      }
      const task = run(job)
        .catch(err => {
          // The chain above is total, so this is the guard for a bug in it — never a path an item
          // can be failed through.
          failed += 1;
          warn(`[IMAGE-CAPTURE] capture aborted: ${sanitizeForLog(err instanceof Error ? err.message : String(err))}`);
        })
        .finally(() => void inFlight.delete(task));
      inFlight.add(task);
      return task;
    },
    async drain(): Promise<void> {
      while (inFlight.size > 0) await Promise.all([...inFlight]);
    },
    stats(): ImageCaptureStats {
      return {
        enabled,
        ...(enabled || deps.disabledReason === undefined ? {} : { reason: deps.disabledReason }),
        attempted,
        stored,
        deduped,
        skipped: { ...skipped },
        failed,
        residentialBytesToday: budget.bytesInWindow(now()),
      };
    },
  };
}
