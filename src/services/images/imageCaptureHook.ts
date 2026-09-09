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
import { buildRawCapture, type CaptureSink } from '../captureSink.js';
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
import { normalizeImageRefs } from './imageRefs.js';
import { createImageUrlMemo, createResidentialByteBudget } from './imageCaptureState.js';
import type { GatedTabBytesFetcher } from './gatedTabBytesFetch.js';

/** All gallery images of one item, per the owner's decision. */
export const DEFAULT_IMAGE_MAX_PER_ITEM = 12;
/** Roughly a day of urls at ingest volume; the memo is an optimization, so its size is not critical. */
export const DEFAULT_IMAGE_MEMO_SIZE = 50_000;
/** 1 GiB. The ceiling is on the LINE — it is somebody's house, not a datacentre uplink. */
export const DEFAULT_RESIDENTIAL_BYTES_PER_DAY = 1024 * 1024 * 1024;
/** At most one log line per image host per hour; the counters carry the volume. */
const HOST_LOG_INTERVAL_MS = 60 * 60_000;

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
}

export interface ImageCaptureStats {
  /** Whether the lane is switched on at all (PERSIST_RAW_IMAGES). */
  enabled: boolean;
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

export interface ImageCaptureHookDeps {
  sink: CaptureSink;
  policy: ImageHostPolicy;
  /** The PACED bytes fetcher (a `createImageBytesRouter` wrapped in `paceImageBytesByHost`). */
  fetchBytes: ImageBytesFetcher;
  /** Resolves the residential proxy. Absent (or undefined for `residential`) ⇒ the fetch is refused. */
  proxyUrlFor?: (egress: ImageEgress) => string | undefined;
  /** The durable fetch-failure ledger. Absent ⇒ failures are counted and logged but not persisted. */
  reportFailure?: ReportFetchFailure;
  /** PERSIST_RAW_IMAGES. Default true — the composition root owns the switch. */
  enabled?: boolean;
  maxPerItem?: number;
  memoSize?: number;
  residentialBytesPerDay?: number;
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
  };
  const lastLoggedByHost = new Map<string, number>();
  const inFlight = new Set<Promise<void>>();

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

  const captureOne = async (request: ImageCaptureRequest, url: string, role: string, position: number): Promise<void> => {
    if (memo.hasUrl(url)) {
      skipped.memo += 1;
      return;
    }
    const decision = chooseImageLane(request.pageUrl, url, request.searchFetch, deps.policy);
    if (!decision.ok) {
      skipped.policyDeny += 1;
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
      storeHost: storeHostOf(request.pageUrl),
      egress: decision.egress,
      ...(request.searchFetch?.access === 'cloudflare' ? { challengeGated: true } : {}),
      ...(decision.referer !== undefined ? { referer: decision.referer } : {}),
      ...(userAgent !== undefined ? { userAgent } : {}),
      ...(proxyUrl !== undefined ? { proxyUrl } : {}),
      // Re-assert on what the bytes ACTUALLY came from: the lane decision only ever saw the
      // requested url, and a redirect can land on a banned host, or carry a residential fetch off
      // the store that declared the exit.
      allowFinalUrl: (finalUrl: string) =>
        !isDeniedImageUrl(finalUrl) && (decision.egress !== 'residential' || isDeclaringStoreUrl(finalUrl, request.pageUrl)),
    };

    attempted += 1;
    const host = storeHostOf(url) || url;
    let result;
    try {
      result = await deps.fetchBytes(url, plan);
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      logOncePerHost(host, `[IMAGE-CAPTURE] ${sanitizeForLog(host)} image fetch faulted: ${sanitizeForLog(message)}`);
      await report({
        site: request.site,
        itemId: request.itemId,
        target: url,
        origin: request.origin,
        reasonClass: 'network',
        message,
        transport: decision.lane,
      });
      return;
    }

    if (!result.ok) {
      const failure = result as ImageBytesFailure;
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
      failed += 1;
      logOncePerHost(
        host,
        `[IMAGE-CAPTURE] ${sanitizeForLog(host)} image fetch failed (${failure.reason}${
          failure.status !== undefined ? ` ${failure.status}` : ''
        })${failure.detail ? `: ${sanitizeForLog(failure.detail)}` : ''}`,
      );
      await report({
        site: request.site,
        itemId: request.itemId,
        target: url,
        origin: request.origin,
        reasonClass: reasonClassFor(failure),
        ...(failure.status !== undefined ? { httpStatus: failure.status } : {}),
        ...(failure.detail !== undefined ? { message: failure.detail } : {}),
        transport: decision.lane,
      });
      return;
    }

    if (decision.egress === 'residential') budget.record(result.bytes.length, now());

    const capture = buildRawCapture({
      url,
      finalUrl: result.finalUrl,
      lane: 'asset',
      bytes: result.bytes,
      statusCode: result.status,
      contentType: result.contentType,
      sourceItem: { site: request.site, itemId: request.itemId },
      sourceUrl: request.pageUrl,
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
      await deps.sink.capture(capture);
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

  const run = async (request: ImageCaptureRequest): Promise<void> => {
    if (!enabled || typeof request.ruleset.describeImages !== 'function') return;
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
      return;
    }
    const normalized = normalizeImageRefs(described, request.pageUrl, maxPerItem);
    skipped.thumbnailRole += normalized.skipped.thumbnailRole;
    skipped.userRole += normalized.skipped.userRole;
    skipped.cap += normalized.skipped.cap;
    skipped.policyDeny += normalized.skipped.policyDeny;
    // SEQUENTIAL on purpose. The per-host pacing would serialize a shared CDN anyway, and a gallery
    // fired in parallel would hold a browser tab per image on the gated lane.
    for (const ref of normalized.refs) {
      await captureOne(request, ref.url, ref.role, ref.position);
    }
  };

  return {
    capture(request: ImageCaptureRequest): Promise<void> {
      const task = run(request)
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
