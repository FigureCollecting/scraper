/**
 * assembleImageCapture — the image lane's composition root.
 *
 * Everything below this file is injected and tested with fakes; this is where the environment, the
 * three real transports, the per-image-host pacing and the shared capture sink are finally bound
 * together, once, into the process's hook.
 *
 * The BROWSER lane is built lazily rather than at import. It needs the pooled browser surface, which
 * needs Chrome, and an ingest process whose stores all ride the plain or impersonating lane must not
 * pay for a browser it never opens. It is also the reason this module owns a singleton: the gated
 * lane's per-host tab budget, the memo and the residential day's ledger are all process-wide facts,
 * and a second hook would quietly double every one of them.
 */
import type { ExtractedData, ExtractionRuleset, SearchFetch } from '@figurecollecting/scraper-plugin-contract';
import { HostRateLimiter } from '../../driver/hostRateLimiter.js';
import { getRawCaptureSink, isImagePersistenceEnabled, rawStoreView } from '../s3ObjectStore.js';
import type { CaptureSink } from '../captureSink.js';
import { createFailureReporterFromEnv, type FetchOriginName } from '../failureReporter.js';
import { getResidentialProxyUrl } from '../residentialEgress.js';
import { createCapturingScrapingService } from '../engineServices/capturingScrapingService.js';
import { createHttpBytesFetch } from './httpBytesFetch.js';
import { createImpitBytesFetch } from './impitBytesFetch.js';
import { createGatedTabBytesFetch, type GatedTabBytesFetcher, type GatedTabLane } from './gatedTabBytesFetch.js';
import { loadImageHostPolicy, type ImageHostPolicy } from './imageHostPolicy.js';
import { paceImageBytesByHost } from './imageBytesPacing.js';
import type { ImageBytesFetcher } from './imageBytes.js';
import {
  createImageBytesRouter,
  createImageCaptureHook,
  DEFAULT_IMAGE_FETCH_CONCURRENCY,
  DEFAULT_IMAGE_INFLIGHT_MAX,
  DEFAULT_IMAGE_MAX_PER_ITEM,
  DEFAULT_IMAGE_MEMO_SIZE,
  DEFAULT_RESIDENTIAL_BYTES_PER_DAY,
  type ImageCaptureHook,
  type ImageCaptureStats,
} from './imageCaptureHook.js';

/**
 * The most images one item may cost, whatever the env says.
 *
 * Not paranoia about a big number: `IMAGE_MAX_PER_ITEM` multiplies against every item of every
 * store, and a mistyped extra zero turns a gallery walk into a crawl of a CDN at a rate nobody
 * decided. A ceiling on a multiplier is cheaper than discovering the multiplier from the bandwidth
 * graph.
 */
export const MAX_CONFIGURABLE_IMAGES_PER_ITEM = 100;

/**
 * The most image fetches an operator may open at once. Same reasoning as the per-item ceiling, one
 * level up: this is a BACKGROUND lane sharing a pod with live lookups and ingest, and a mistyped
 * concurrency is exactly how it stops being background.
 */
export const MAX_CONFIGURABLE_IMAGE_CONCURRENCY = 32;

/** The tunables, resolved from env with the owner's defaults. */
export interface ImageCaptureSettings {
  enabled: boolean;
  maxPerItem: number;
  memoSize: number;
  residentialBytesPerDay: number;
  concurrency: number;
  inFlightMax: number;
}

/** A positive integer from env; undefined when absent, unparseable or non-positive. */
function positiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/**
 * A non-negative byte allowance. Distinguished from {@link positiveInt} because ZERO is meaningful
 * here and nowhere else: `IMAGE_RESIDENTIAL_BYTES_PER_DAY=0` is how an operator closes the home line
 * to images entirely, and folding it into "unset" would silently restore the 1 GiB default.
 */
function nonNegativeInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

export function resolveImageCaptureSettings(env: NodeJS.ProcessEnv = process.env): ImageCaptureSettings {
  return {
    enabled: isImagePersistenceEnabled(env),
    maxPerItem: Math.min(positiveInt(env.IMAGE_MAX_PER_ITEM) ?? DEFAULT_IMAGE_MAX_PER_ITEM, MAX_CONFIGURABLE_IMAGES_PER_ITEM),
    memoSize: positiveInt(env.IMAGE_MEMO_SIZE) ?? DEFAULT_IMAGE_MEMO_SIZE,
    residentialBytesPerDay: nonNegativeInt(env.IMAGE_RESIDENTIAL_BYTES_PER_DAY) ?? DEFAULT_RESIDENTIAL_BYTES_PER_DAY,
    concurrency: Math.min(
      positiveInt(env.IMAGE_FETCH_CONCURRENCY) ?? DEFAULT_IMAGE_FETCH_CONCURRENCY,
      MAX_CONFIGURABLE_IMAGE_CONCURRENCY,
    ),
    inFlightMax: positiveInt(env.IMAGE_INFLIGHT_MAX) ?? DEFAULT_IMAGE_INFLIGHT_MAX,
  };
}

/** Overrides for the root — tests supply the transports; production supplies none. */
export interface AssembleImageCaptureDeps {
  /** The raw-capture sink (default: the process one). Whether it is REAL decides whether the lane runs. */
  sink?: CaptureSink;
  /** A ready-made (already paced) bytes fetcher, replacing all three real lanes. */
  fetchBytes?: ImageBytesFetcher;
  /** The pooled browser surface for the gated lane (default: the shared capturing service, lazily). */
  browserLane?: () => GatedTabLane;
  policy?: ImageHostPolicy;
}

/**
 * The gated lane, built on first use. A refusal (rather than a throw) when the browser surface
 * cannot be built keeps a browserless deployment's image capture working on the other two lanes
 * instead of failing every image of every store.
 */
function lazyGatedLane(resolveLane: () => GatedTabLane): GatedTabBytesFetcher {
  let fetcher: GatedTabBytesFetcher | undefined;
  return (egress, host, url, options) => {
    if (!fetcher) {
      try {
        fetcher = createGatedTabBytesFetch(resolveLane());
      } catch (err) {
        return Promise.resolve({
          ok: false as const,
          reason: 'unsupported' as const,
          detail: `the browser bytes lane could not be built: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
    return fetcher(egress, host, url, options);
  };
}

/**
 * Build the process's image capture hook from the environment.
 *
 * The pacing wrapper goes OUTSIDE the lane router, not around each lane: the budget belongs to the
 * host serving the image, and a CDN reachable on two lanes is still one CDN with one budget. Its
 * limiter is this lane's own, deliberately separate from the driver's — the driver paces STORES.
 */
export function createImageCaptureHookFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  deps: AssembleImageCaptureDeps = {},
): ImageCaptureHook {
  const settings = resolveImageCaptureSettings(env);
  // BOTH halves, or the lane is off. With the switch on but no raw store configured, the sink loader
  // hands back a NoopCaptureSink — and capture would then fetch every image of every item, at real
  // cost to the store and to our egress reputation, only to drop the bytes. That is the traffic with
  // none of the corpus, so it is refused, loudly and once, rather than run.
  const sink = deps.sink ?? getRawCaptureSink();
  const storeConfigured = rawStoreView(sink).configured;
  const enabled = settings.enabled && storeConfigured;
  const disabledReason = settings.enabled
    ? storeConfigured
      ? undefined
      : 'the raw store is not configured (RAW_STORE_S3_ENDPOINT / _REGION / _BUCKET and the credential pair)'
    : 'PERSIST_RAW_IMAGES is not true';
  if (settings.enabled && !storeConfigured) {
    // eslint-disable-next-line no-console
    console.warn(`[IMAGE-CAPTURE] PERSIST_RAW_IMAGES is true but ${disabledReason} — image capture stays OFF.`);
  }
  const fetchBytes =
    deps.fetchBytes ??
    paceImageBytesByHost(
      createImageBytesRouter({
        http: createHttpBytesFetch(),
        impit: createImpitBytesFetch(),
        gated: lazyGatedLane(deps.browserLane ?? (() => createCapturingScrapingService())),
      }),
      // An unmapped image host gets the limiter's own default gap: a CDN is not in the store profile
      // index, so there is nothing store-specific to look up, and there should not be.
      new HostRateLimiter(() => undefined),
    );
  const reporter = createFailureReporterFromEnv(env);
  return createImageCaptureHook({
    sink,
    policy: deps.policy ?? loadImageHostPolicy(env),
    fetchBytes,
    proxyUrlFor: egress => (egress === 'residential' ? getResidentialProxyUrl() : undefined),
    ...(reporter ? { reportFailure: report => reporter.report(report) } : {}),
    enabled,
    ...(disabledReason !== undefined ? { disabledReason } : {}),
    maxPerItem: settings.maxPerItem,
    memoSize: settings.memoSize,
    residentialBytesPerDay: settings.residentialBytesPerDay,
    concurrency: settings.concurrency,
    inFlightMax: settings.inFlightMax,
  });
}

// One hook per process: the memo, the residential day's ledger and the gated lane's tab budget are
// all process-wide facts, and a second hook would double each of them without saying so.
let sharedHook: ImageCaptureHook | undefined;

export function getImageCaptureHook(): ImageCaptureHook {
  if (!sharedHook) sharedHook = createImageCaptureHookFromEnv();
  return sharedHook;
}

/** Test seam: replace (or with `null`, forget) the process hook. */
export function setImageCaptureHook(hook: ImageCaptureHook | null): void {
  sharedHook = hook ?? undefined;
}

/**
 * The ops-readable view. An image lane that is capturing nothing looks exactly like an idle one from
 * outside, so the counters ARE the signal — most of all the named skips, which say whether the
 * silence is a deny list, an exhausted home line, or a store answering every image with a block page.
 * Never throws: health reads it.
 */
export function imageCaptureView(hook: ImageCaptureHook = getImageCaptureHook()): ImageCaptureStats {
  try {
    return hook.stats();
  } catch {
    return {
      enabled: false,
      attempted: 0,
      stored: 0,
      deduped: 0,
      skipped: { policyDeny: 0, memo: 0, thumbnailRole: 0, userRole: 0, cap: 0, residentialBudget: 0, notImage: 0, tooLarge: 0, inFlight: 0 },
      failed: 0,
      residentialBytesToday: 0,
    };
  }
}

/**
 * The `captureImages` callback the driver legs take — one extraction's records, the url they came
 * from, and the ruleset that produced them, handed to the process hook.
 *
 * The legs take a callback rather than the hook because they own no services (see the seam comments
 * in `crawlWorker.ts` and `assembleResolve.ts`); this is where that callback is finally bound to a
 * real hook, a real store lane, and the origin the failure ledger will file the row under.
 *
 * Fire-and-forget, and total: nothing it does can reach the leg that called it.
 */
export function createRecordImageCapture(
  origin: FetchOriginName,
  searchFetchFor: (url: string) => SearchFetch | undefined,
  hook: () => ImageCaptureHook = getImageCaptureHook,
): (records: ExtractedData[], url: string, ruleset: ExtractionRuleset) => void {
  return (records, url, ruleset) => {
    let searchFetch: SearchFetch | undefined;
    try {
      searchFetch = searchFetchFor(url);
    } catch {
      searchFetch = undefined;
    }
    const capture = hook();
    for (const record of records) {
      void capture
        .capture({
          site: record.source.site,
          itemId: record.source.itemId,
          pageUrl: url,
          fields: record.fields,
          ruleset,
          searchFetch,
          origin,
        })
        .catch(() => undefined);
    }
  };
}
