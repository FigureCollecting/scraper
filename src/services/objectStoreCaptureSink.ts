/**
 * ObjectStoreCaptureSink — CaptureSink Phase 2: persists raw captures to a
 * content-addressed object store (Hetzner `mindsignals-raw`) per the ratified
 * `sha256-v1` contract (fc-infra nodes/fc-app-01/raw-store/README.md):
 *
 *   key   = <prefix>sha256/<aa>/<sha256hex>.html.gz   (aa = first 2 hex of digest)
 *   hash  = sha256 of the UNCOMPRESSED, exact-as-received bytes (hash-before-compress;
 *           already computed by buildRawCapture — we never re-hash here)
 *   body  = gzip(content), Content-Type: application/gzip, and deliberately NO
 *           Content-Encoding: gzip (transparent double-decode footgun)
 *   write = HEAD-then-PUT, write-once: a dedup hit records nothing here (the spine
 *           capture table is the authoritative event log); nothing is ever DELETEd.
 *
 * The ASSET lane (product images) is the one exception to the body rules above:
 *
 *   key   = <imagePrefix>sha256/<aa>/<sha256hex>.<ext>   (ext from the MAGIC BYTES)
 *   body  = the ORIGINAL bytes, unaltered — no gzip, no re-encode, no derivative
 *   type  = the sniffed image type; the store's declared Content-Type is advisory
 *           only and is recorded as metadata beside it
 *   skips = a body that is not an image, is oversized, or is empty is SKIPPED with
 *           a typed reason and counted — never stored, never thrown.
 *
 * The store is injected via a minimal SDK-agnostic port so this logic is unit-
 * testable without creds, a network, or the real S3 SDK. A slow/broken store must
 * NEVER break or stall a scrape: every op is timeout-bounded and failures are
 * swallowed-but-counted (observable via stats()).
 *
 * ADMISSION: capture() does the cheap, no-I/O decisions in the caller's stack (the
 * kill switches, and the asset lane's empty/tooLarge/notImage skips) and then hands
 * the store round trip to an internal bounded worker pool, returning at once. That
 * bound is the point: without it a crawl wave put one HEAD+PUT pair in flight per
 * captured page, so hundreds of ops contended for DNS-lookup slots on the 4-thread
 * libuv pool, for TLS handshakes, and for an event loop that synchronous gzip was
 * blocking — and each op's WALL CLOCK ran past a budget sized for the upload alone.
 * The op budget now starts when the store round trip begins and covers the WHOLE
 * capture (HEAD + gzip + PUT under one bound, see withTimeout), while the wait for a
 * worker slot is reported separately (queueWaitP50/P95) instead of being charged to it.
 * A capture offered when the queue is already full is DROPPED and counted rather
 * than making the backlog unbounded — and capture() SAYS SO, so a caller keeping a
 * per-url memo does not record a lost capture as done and suppress its own retry.
 *
 * THE PAGE RESERVATION: that one queue carries two lanes whose losses are not
 * comparable. A page body is the provenance behind a claim already written to the
 * spine and NOTHING will ever fetch it again; an image is a re-fetchable ~10 MiB
 * blob that the next crawl pass would pick up anyway. Shared first-come-first-served,
 * the cheap half evicts the expensive one — in prod on 2026-09-09, arming the image
 * lane put the queue on its depth ceiling and refused 1561 captures, ≈63 of them
 * pages: a permanent provenance gap bought with re-fetchable bytes. So the asset lane
 * is admitted only while the queue sits BELOW `assetQueueShare` of BOTH budgets
 * (RAW_STORE_ASSET_QUEUE_SHARE, default 0.75; 1 = no reservation), and the remaining
 * share is there for pages. The BYTE half of that test counts the capture's own size,
 * because one asset can be a quarter of the whole budget where a slot is only ever a
 * slot — measured on occupancy alone, four assets could walk the queue from under the
 * line to the hard ceiling and refuse the next page. An asset refused that way is told
 * `assetReserve` — a refusal like any other, so its caller still retries — and counted
 * apart, BY THE BUDGET THAT HELD IT (`assetRefusedReserveDepth` / `assetRefusedReserveBytes`,
 * summed in `assetRefusedReserve`), so "the store is behind" stays distinguishable from
 * "the reservation is working", and a depth problem from a payload problem.
 *
 * PAGE PRIORITY: the reservation buys a page ADMISSION, not a turn. Drained first-come-
 * first-served, a page admitted into the reserved tail waited behind every asset queued
 * before it — at prod scale 375 uploads of up to 10 MiB across twelve workers — and at
 * SIGTERM the bounded flush spent its whole budget on re-fetchable images and abandoned
 * the page behind them. So the two lanes wait in two queues, and a worker takes a PAGE
 * whenever one is waiting and an asset only when none is; FIFO inside each. Every bound
 * — depth, bytes, the share — is measured over the two queues COMBINED, exactly as with
 * one queue: priority changes no single admission decision, only who goes next. What it
 * does change over time is which lane's captures stay RESIDENT: while pages keep coming
 * the assets do not drain, so they keep holding their slots and their bytes, and a page
 * can be refused `queueBytesFull` against bytes a waiting asset holds where first-come-
 * first-served would have drained it and given them back. The page reserve
 * `(1 − assetQueueShare) × queueMaxBytes` holds either way; what priority costs a page
 * is the opportunistic headroom above it. And priority reorders only what is WAITING:
 * a shutdown budget (RAW_STORE_SHUTDOWN_FLUSH_MS) shorter than one PUT's p95 cannot
 * rescue a page when every worker is mid-PUT at SIGTERM, because no worker frees inside
 * it — that is a deployment tuning note (the budget against the measured PUT p95), not
 * something this queue can fix.
 *
 * THE ASSET LANE NEVER STARVES: strict priority let a crawler burst (~17 min of every
 * hour in prod) park the whole resident asset backlog for its duration — nothing
 * uploaded, every new asset refused `assetReserve`, and the hold line naming
 * RAW_STORE_QUEUE_MAX, a knob that frees nothing, because those captures were short of
 * a worker that prefers pages, not of space. So an asset that has waited LONGER THAN
 * `assetMaxWaitMs` (RAW_STORE_ASSET_MAX_WAIT_MS, default 30 s, never under 1 s) goes
 * next — ONE of them, then a page again. That alternation is the bound: out of a page
 * burst the asset lane gets at most every other take, so a page never waits behind more
 * than one asset, and the window bounds how long the lane waits for its next turn, not
 * how long every asset waits (a 375-deep backlog still drains one asset per page). The
 * shutdown flush is exempt and stays strictly pages first: its budget is for the
 * captures nothing will fetch again.
 *
 * WHAT THE SHARE MEASURES: the queue — captures WAITING for a worker. An upload that is
 * running has left the queue and holds no slot in it (the concurrency bounds what runs,
 * the queue bounds what waits: the same split the byte budget makes), and its bytes sit
 * OUTSIDE RAW_STORE_QUEUE_MAX_BYTES. So the sink's footprint is, in captures, `queueMax`
 * waiting + `concurrency` running, and in bytes `queueMaxBytes` + `concurrency` ×
 * `maxImageBytes` (RAW_STORE_IMAGE_MAX_BYTES — the most one running upload can hold).
 * At the deployed RAW_STORE_CONCURRENCY=12 that is 500 + 12 captures and 256 MiB +
 * 12 × 10 MiB = 376 MiB, of which the asset lane's share is 375 + 12 captures and
 * 192 MiB + 120 MiB = 312 MiB. A page admitted behind them waits for at most ONE of
 * those uploads — plus one aged asset, when the lane's turn has come — before a worker
 * takes it. Counting the running uploads against the share was tried and rejected: at a
 * legal configuration (RAW_STORE_QUEUE_MAX=8, RAW_STORE_CONCURRENCY=8) it refuses the
 * seventh asset with the queue EMPTY and two workers idle — the empty-queue admission
 * the reservation promises, broken by a knob that is not the concurrency knob.
 */
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import type { CaptureAdmission, CaptureSink, RawCapture } from './captureSink.js';
import { CAPTURE_ADMITTED } from './captureSink.js';
import { sanitizeForLog } from '../utils/security.js';

/**
 * Compression runs on libuv's threadpool, not the event loop. `gzipSync` on a wave of
 * page bodies is milliseconds of blocking each, and it blocks the very loop the store
 * ops' timers and socket callbacks live on — so the synchronous call inflates the
 * measured duration of every op running beside it.
 */
const gzipAsync = promisify(gzip);

/** The signal's own reason where it is an Error, so an ended op reports why. */
function abortReasonOf(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error('raw-store op aborted');
}

/** A promise that rejects when the op's budget ends it, and otherwise never settles. */
function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(abortReasonOf(signal));
      return;
    }
    signal.addEventListener('abort', () => reject(abortReasonOf(signal)), { once: true });
  });
}

/** Options for a single object write. */
export interface PutOptions {
  /** `application/gzip` for page bodies; the sniffed image type on the asset lane. */
  contentType: string;
  /**
   * Intentionally never set by this sink — the `.gz` suffix declares compression
   * and `Content-Encoding: gzip` triggers transparent double-decoding in some
   * clients. Present on the port only so tests can assert it stays unset.
   */
  contentEncoding?: string;
  /**
   * Best-effort convenience metadata describing the FIRST capture only — the key is
   * the content address, so bytes reused across items keep the first capture's tags.
   * The spine's capture event log (one row per reference) is the authoritative index.
   */
  metadata?: Record<string, string>;
}

/**
 * Minimal S3-compatible port. Concrete adapter (Hetzner) lives separately.
 *
 * Both ops take the op budget's AbortSignal, and an adapter is expected to tear the
 * request down when it fires. Abandoning the promise is not enough: measured against
 * the live bucket, cost per object is dominated by the REQUEST, not its bytes (a
 * 40 KB and a 3 MB PUT cost the same seconds), so a request nobody is waiting for
 * still holds a socket and still spends the store's request budget — beside the
 * replacement op the freed worker has already started.
 */
export interface ObjectStore {
  /** HEAD — does this content address already exist? */
  exists(key: string, signal?: AbortSignal): Promise<boolean>;
  /** PUT — write the object. Callers guarantee write-once by content address. */
  put(key: string, body: Buffer, opts: PutOptions, signal?: AbortSignal): Promise<void>;
}

/** Non-secret store contract (from raw-store-config.yaml) + operational bounds. */
export interface RawStoreConfig {
  endpoint: string;
  region: string;
  bucket: string;
  /** Capture-type prefix for html lanes, e.g. `raw-html/`. */
  prefix: string;
  /** Capture-type prefix for the json (api) lane, e.g. `raw-json/`. */
  jsonPrefix?: string;
  /** Capture-type prefix for the asset (image) lane, e.g. `raw-img/`. */
  imagePrefix?: string;
  /** Hard ceiling on one stored image's bytes; larger bodies are SKIPPED. */
  maxImageBytes?: number;
  /**
   * Per-lane kill switches, resolved from PERSIST_RAW_HTML / PERSIST_RAW_IMAGES by
   * the composition root. Enforced HERE, at the write boundary, so a caller that
   * ignores the switch still cannot put bytes in the bucket — the image switch is a
   * RIGHTS control, and a rights control enforced only by convention is not one.
   * Undefined = on, so a directly-constructed sink behaves as it always has.
   */
  pagesEnabled?: boolean;
  assetsEnabled?: boolean;
  /** Key-scheme contract version; this writer only knows `sha256-v1`. */
  keyScheme: string;
  /**
   * Hard bound on ONE page/api capture's whole trip to the store — the HEAD, the gzip
   * and the PUT together, not each of them (RAW_STORE_PUT_TIMEOUT_MS). Set 30000 and a
   * capture may spend 30 s, where the per-call reading of the same number bought a 60 s
   * worst case. Reaching it CANCELS the op and loses the body, so it belongs above the
   * store's measured cost, not near it.
   */
  putTimeoutMs?: number;
  /**
   * The asset lane's own whole-op bound (RAW_STORE_IMAGE_PUT_TIMEOUT_MS), read exactly
   * the same way. An original image is up to maxImageBytes (10 MiB by default) against a
   * page body's ~30 KB gzipped, so it cannot share the page budget without timing out on
   * payload size alone. It is the longer of the two even though an image is the
   * RE-FETCHABLE capture: the asymmetry pays for payload, not for importance.
   */
  imagePutTimeoutMs?: number;
  /**
   * How many store ops (a HEAD or a PUT) may be in flight at once, across BOTH
   * lanes. This is the admission bound that keeps a crawl wave from turning every
   * captured page into a simultaneous socket + DNS lookup + TLS handshake.
   */
  concurrency?: number;
  /**
   * Hard ceiling on captures waiting for a worker. Beyond it a capture is DROPPED
   * and counted: raw capture is best-effort insurance, and an unbounded backlog of
   * buffered page bodies is a memory leak with a scrape attached to it.
   */
  queueMax?: number;
  /**
   * Hard ceiling on the BYTES those waiting captures hold. A count alone is not a
   * memory bound: the same 500-deep queue is ~15 MB of page bodies or ~5 GB of
   * 10 MiB originals, and the pod has 3Gi with 2Gi of it spoken for by /dev/shm.
   * Whichever ceiling binds first drops the capture.
   */
  queueMaxBytes?: number;
  /**
   * The share of BOTH queue budgets (depth and bytes) the asset lane may occupy —
   * the rest is reserved for page bodies, which are irreplaceable where an image is
   * merely re-fetched. A fraction in (0, 1]; 1 means no reservation (the lanes share
   * the queue first-come-first-served, as they did before this existed). Turning the
   * asset lane OFF is `assetsEnabled`/PERSIST_RAW_IMAGES' job, never a share of 0.
   * Measured over captures WAITING (both lanes combined); a running upload holds no
   * slot, so the lane's footprint is share × queueMax waiting + concurrency running.
   */
  assetQueueShare?: number;
  /**
   * How long an asset may wait behind pages before its lane's oldest capture goes next
   * (one of them, then a page again). Pages go first otherwise. Bounds the starvation
   * that strict priority allowed for the length of a crawler burst; never under
   * MIN_RAW_STORE_ASSET_MAX_WAIT_MS, because a window of a few milliseconds is
   * round-robin, which hands the page reservation's turn back to the images.
   */
  assetMaxWaitMs?: number;
  /**
   * S3 addressing style for the adapter. Hetzner uses virtual-hosted style, so
   * the adapter defaults to `false` (path-style off). Unused by the sink logic.
   */
  pathStyle?: boolean;
}

/** Why an asset-lane capture was skipped without being stored. */
export type AssetSkipReason = 'notImage' | 'tooLarge' | 'empty' | 'disabled';

/** Per-reason skip tally for the asset lane. */
export type AssetSkipCounts = Record<AssetSkipReason, number>;

/** Observable counters — the leak/failure surface for prod (mirrors BrowserPool). */
export interface SinkStats {
  stored: number;
  deduped: number;
  failed: number;
  /** Page-lane captures refused because PERSIST_RAW_HTML is off. */
  skippedDisabled: number;
  /** Asset lane, counted separately so page-body volume stays readable. */
  assetStored: number;
  assetDeduped: number;
  assetSkipped: AssetSkipCounts;
  assetFailed: number;
  /** Captures waiting for a worker slot right now — both lanes, combined: the number every budget is measured on. */
  queued: number;
  /**
   * The same depth by lane. `queued` alone cannot tell "375 images parked behind pages"
   * from "375 pages backed up", and the two want different responses: the first is the
   * reservation and the priority doing their job, the second is the store falling behind.
   */
  queuedPages: number;
  queuedAssets: number;
  /** Store ops executing right now — never above the configured concurrency. */
  inFlight: number;
  /** Captures refused because the queue was already at queueMax. Irrecoverable. */
  dropped: number;
  /** Captures refused because the queue's BYTE budget was full. Counted apart from
   * `dropped` so an operator can see WHICH ceiling bound: a depth problem and a
   * payload problem want different settings. */
  droppedBytes: number;
  /**
   * Asset-lane captures refused because the queue was above the asset SHARE, while
   * the page lanes still had room. Never folded into `dropped`: a rising count here
   * is the reservation holding the line (and those images come back on the next
   * pass), where a rising `dropped` is page provenance being lost outright.
   * The SUM of the two split counters below, kept under the original name.
   */
  assetRefusedReserve: number;
  /**
   * The same refusals, by the budget that held the asset — mirroring `dropped` vs
   * `droppedBytes`, and for the same reason: a depth problem wants RAW_STORE_QUEUE_MAX
   * raised and a payload problem RAW_STORE_QUEUE_MAX_BYTES, and one counter cannot say
   * which.
   */
  assetRefusedReserveDepth: number;
  assetRefusedReserveBytes: number;
  /** Bytes currently held by queued captures — the live reading of that budget. */
  queuedBytes: number;
  /** Milliseconds a capture waited for a slot. Deliberately OUTSIDE the op budget. */
  queueWaitP50: number;
  queueWaitP95: number;
  /** Milliseconds the PUT itself took, once it actually began. Sampled on failure
   * too — an op that spent its whole budget is the one an operator most needs. */
  putP50: number;
  putP95: number;
  /** Milliseconds the HEAD took. Half this sink's round trips, and the ONLY one a
   * dedup hit makes, so leaving it untimed hid half the latency. */
  headP50: number;
  headP95: number;
  /**
   * Ops the budget ended, a SUBSET of failed + assetFailed. A store answering slowly
   * and a store answering wrongly are different faults, and until this counter existed
   * they arrived on the health page as the same number.
   */
  timedOut: number;
  /**
   * Milliseconds between when a zero-delay callback was due and when it ran — this
   * PROCESS's scheduling delay, sampled continuously.
   *
   * It is here because every duration above is wall clock measured inside this
   * process, so anything that keeps the process off the CPU — a cgroup CPU quota,
   * a co-tenant Chrome, a long synchronous parse — inflates them without the store
   * having slowed down at all. Read the two together: a fat putP95 over a flat lag is
   * the store, and a fat putP95 over a fat lag is this pod.
   */
  eventLoopLagP50: number;
  eventLoopLagP95: number;
}

const SUPPORTED_KEY_SCHEME = 'sha256-v1';
/**
 * The page/api lanes' default budget for ONE store op.
 *
 * 30 s, matching the deployed RAW_STORE_PUT_TIMEOUT_MS, because the budget now ends the
 * op for real: it was 5 s while a timeout merely mis-counted a PUT that still landed,
 * and 5 s sits BELOW the measured cost of a PUT (p50 3.5-5.7 s on the slow path measured
 * 2026-09-10). A default under the real cost would abort about half of all uploads and
 * destroy those bodies — and a page body is the one nothing will fetch again.
 */
export const DEFAULT_PUT_TIMEOUT_MS = 30_000;
/** Four concurrent ops: enough to keep the link busy, few enough to stay off the cliff. */
export const DEFAULT_RAW_STORE_CONCURRENCY = 4;
/**
 * Ceiling on the configured concurrency. Without one a typo (`RAW_STORE_CONCURRENCY=1000`)
 * silently restores the unbounded fan-out this queue exists to remove — the same reason
 * the image byte ceiling is clamped.
 */
export const MAX_RAW_STORE_CONCURRENCY = 64;

/**
 * The concurrency the sink will actually run at, from a raw config value. Exported
 * because the S3 adapter sizes its connection pool from the SAME number: a pool
 * larger than the op bound lets an op the sink has written off keep a socket beside
 * its replacement, and a smaller one would queue ops inside the transport where the
 * sink cannot see the wait.
 */
export function resolveRawStoreConcurrency(raw: number | undefined): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0
    ? Math.min(Math.floor(raw), MAX_RAW_STORE_CONCURRENCY)
    : DEFAULT_RAW_STORE_CONCURRENCY;
}
/** Backlog ceiling. Page bodies are buffered, so the queue is memory we are holding. */
export const DEFAULT_RAW_STORE_QUEUE_MAX = 500;
/**
 * Bounds on the configured depth. A depth of 0 is a sink that stores nothing, and a
 * depth in the tens of thousands is the unbounded backlog wearing a number — the same
 * reason the concurrency and the image byte ceiling are clamped.
 */
export const MIN_RAW_STORE_QUEUE_MAX = 1;
export const MAX_RAW_STORE_QUEUE_MAX = 5000;
/**
 * 256 MiB of queued bodies. Sized against the container (3Gi, 2Gi of it /dev/shm for
 * Chrome) rather than against a capture count, because the count says nothing about
 * what is being held: 500 page bodies is ~15 MB and 500 originals is up to ~5 GB.
 */
export const DEFAULT_RAW_STORE_QUEUE_MAX_BYTES = 256 * 1024 * 1024;
/**
 * Three quarters of the queue for images, the last quarter held for page bodies.
 * Sized from what the two lanes actually hold: a gzipped page is ~40 KB against an
 * original's megabytes, so a quarter of the budget is thousands of pages of headroom
 * while still leaving the image lane the bulk of a queue built for it.
 */
export const DEFAULT_RAW_STORE_ASSET_QUEUE_SHARE = 0.75;
/**
 * 30 s: three of the ~10 s HEAD+PUT round trips the deployed lane measures, so a page
 * burst hands the asset lane a turn a few uploads in rather than at the burst's end.
 */
export const DEFAULT_RAW_STORE_ASSET_MAX_WAIT_MS = 30_000;
/** Floor on the window. Below it the priority is round-robin with extra steps. */
export const MIN_RAW_STORE_ASSET_MAX_WAIT_MS = 1_000;
/** Drops are loud, but once a minute — a wave must not turn into a log flood. */
const DROP_LOG_INTERVAL_MS = 60_000;
/** Rolling latency window. Percentiles over the recent past, at a fixed memory cost. */
const LATENCY_SAMPLE_MAX = 512;

/**
 * How often the sink samples its own scheduling delay while it has work. Frequent
 * enough to catch a CPU quota's 100 ms slices, cheap enough to leave running.
 */
const LOOP_LAG_SAMPLE_INTERVAL_MS = 250;
/** 30 s — 10 MiB at a pessimistic ~350 KB/s, so payload size alone never times out. */
export const DEFAULT_IMAGE_PUT_TIMEOUT_MS = 30_000;
const MAX_METADATA_VALUE_LEN = 1024;
/**
 * S3 caps USER METADATA as a SET (2 KB of `x-amz-meta-*` header bytes), not per
 * value — an over-budget set fails the whole PUT with 400 MetadataTooLarge and the
 * bytes are lost (write-once, nothing re-queues). We aim well under the limit so a
 * signed CDN image URL plus a long referring page URL can never cost the object.
 */
const MAX_METADATA_TOTAL_BYTES = 1800;
/** The header name S3 counts alongside each value. */
const METADATA_HEADER_PREFIX = 'x-amz-meta-';
/** Least-valuable provenance first: what gets dropped when the set is over budget. */
const METADATA_SHED_ORDER = ['vary', 'content-encoding', 'declared-content-type', 'source-url', 'position', 'bytes'];
/** No value is truncated below this — a stub still identifies the object. */
const MIN_BUDGETED_VALUE_LEN = 64;
const DEFAULT_IMAGE_PREFIX = 'raw-img/';
/**
 * 10 MiB — comfortably above a storefront hero image, well below a stall. This
 * bounds what is STORED, not what is fetched: the body reaches the sink already
 * buffered and already hashed, so the fetcher owns the download bound.
 */
export const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** An image format this lane will store: its file extension and true media type. */
interface ImageType {
  ext: string;
  contentType: string;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const AVIF_BRANDS = new Set(['avif', 'avis']);

/** Any binary view as a Buffer — a caller may hand a Uint8Array from arrayBuffer(). */
function asBuffer(bytes: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * Identifies an image from its leading bytes. The store's declared Content-Type is
 * NOT trusted: CDNs mislabel images as `application/octet-stream`, and a challenge
 * or error page is routinely served with the image's own Content-Type. Only the
 * magic bytes decide what — if anything — gets stored.
 *
 * This types the PREFIX; it does not validate the tail. A GIF89a- or FFD8FF-prefixed
 * polyglot that is also a valid script is a real image header and IS stored — which
 * is why originals are private, never served, and never shown. Total by construction:
 * anything that is not a binary view is simply "not an image", never a throw.
 */
export function sniffImageType(input: Buffer | Uint8Array): ImageType | undefined {
  if (!ArrayBuffer.isView(input)) return undefined;
  const bytes = asBuffer(input);
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { ext: 'jpg', contentType: 'image/jpeg' };
  }
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return { ext: 'png', contentType: 'image/png' };
  }
  if (bytes.length >= 6) {
    const head = bytes.toString('latin1', 0, 6);
    if (head === 'GIF87a' || head === 'GIF89a') return { ext: 'gif', contentType: 'image/gif' };
  }
  if (bytes.length >= 12) {
    // RIFF container: bytes 0-3 'RIFF', 4-7 size, 8-11 the form type.
    if (bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') {
      return { ext: 'webp', contentType: 'image/webp' };
    }
    // ISO-BMFF: bytes 4-7 'ftyp', 8-11 the MAJOR brand, then (from byte 16) the
    // COMPATIBLE-brand list in 4-byte strides. Real AVIF is emitted with a major
    // brand of mif1/miaf and `avif` only in that list, so both must be read.
    if (bytes.toString('latin1', 4, 8) === 'ftyp') {
      if (AVIF_BRANDS.has(bytes.toString('latin1', 8, 12))) {
        return { ext: 'avif', contentType: 'image/avif' };
      }
      const boxSize = bytes.readUInt32BE(0);
      const end = Math.min(bytes.length, boxSize > 16 ? boxSize : bytes.length);
      for (let o = 16; o + 4 <= end; o += 4) {
        if (AVIF_BRANDS.has(bytes.toString('latin1', o, o + 4))) {
          return { ext: 'avif', contentType: 'image/avif' };
        }
      }
    }
  }
  return undefined;
}

/**
 * S3 user-metadata is carried in HTTP headers: values must be header-safe (ASCII,
 * no control chars) and bounded, or the PUT itself fails. A capture's URL is
 * caller-influenced and may hold non-ASCII (international paths) or hostile bytes,
 * so we make it header-safe here — a bad URL degrades the convenience tag, never
 * the byte write.
 */
function headerSafe(value: string): string {
  let s: string;
  try {
    s = encodeURI(value); // percent-encodes non-ASCII, preserves URL structure
  } catch {
    s = value.replace(/[^\x20-\x7e]/g, '');
  }
  s = s.replace(/[\x00-\x1f\x7f]/g, ''); // strip any residual control chars
  return s.length > MAX_METADATA_VALUE_LEN ? s.slice(0, MAX_METADATA_VALUE_LEN) : s;
}

/** The header bytes S3 actually counts for a metadata set. */
function metadataBytes(md: Record<string, string>): number {
  let n = 0;
  for (const [k, v] of Object.entries(md)) {
    n += Buffer.byteLength(`${METADATA_HEADER_PREFIX}${k}`, 'utf8') + Buffer.byteLength(v, 'utf8');
  }
  return n;
}

/**
 * Fits a metadata set inside MAX_METADATA_TOTAL_BYTES. Per-value capping is not
 * enough: the asset lane emits several independently-capped, store-controlled
 * values (the image URL and the declared Content-Type both come from the store).
 * Sheds the optional provenance in priority order first, then halves the longest
 * survivor until it fits — a degraded tag is always better than a lost object.
 */
function budgetMetadata(md: Record<string, string>): Record<string, string> {
  for (const k of METADATA_SHED_ORDER) {
    if (metadataBytes(md) <= MAX_METADATA_TOTAL_BYTES) return md;
    delete md[k];
  }
  while (metadataBytes(md) > MAX_METADATA_TOTAL_BYTES) {
    const longest = Object.entries(md).sort((a, b) => b[1].length - a[1].length)[0];
    if (!longest || longest[1].length <= MIN_BUDGETED_VALUE_LEN) break;
    md[longest[0]] = longest[1].slice(0, Math.max(MIN_BUDGETED_VALUE_LEN, Math.ceil(longest[1].length / 2)));
  }
  return md;
}

/**
 * The p-th percentile of a rolling sample, nearest-rank. Zero for an empty sample:
 * a lane that has not run yet reports 0, which is what an operator reads as "no
 * signal", rather than a null the health surface would have to special-case.
 */
function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))] ?? 0;
}

/** The URL's hostname, or undefined when it is not parseable (best-effort tagging). */
function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/** One admitted capture, waiting for a worker. */
interface QueuedOp {
  /** Owns its own try/catch — a worker's `await` on this must never reject. */
  readonly run: () => Promise<void>;
  readonly enqueuedAt: number;
  /** What this capture is holding, charged against the queue's byte budget. */
  readonly bytes: number;
}

/** A body's length, or 0 for a malformed capture (the worker will count that). */
function byteLengthOf(bytes: Buffer | Uint8Array | undefined): number {
  return ArrayBuffer.isView(bytes) ? bytes.byteLength : 0;
}

export class ObjectStoreCaptureSink implements CaptureSink {
  private readonly putTimeoutMs: number;
  private readonly imagePutTimeoutMs: number;
  private readonly maxImageBytes: number;
  private readonly pagesEnabled: boolean;
  private readonly assetsEnabled: boolean;
  private readonly concurrency: number;
  private readonly queueMax: number;
  private readonly queueMaxBytes: number;
  private readonly assetQueueShare: number;
  private readonly assetMaxWaitMs: number;
  /**
   * Set when a worker took an aged asset ahead of a waiting page; the next take from a
   * mixed queue is a page, whatever the assets' age. Cleared by that page take.
   */
  private pageOwed = false;
  /**
   * Two queues, one budget. Pages and assets wait apart so a worker can take a page
   * whenever one is waiting; every bound is measured over the two COMBINED (see
   * queueDepth), so admission is exactly what it was with one queue.
   */
  private readonly pageQueue: QueuedOp[] = [];
  private readonly assetQueue: QueuedOp[] = [];
  private queuedBytes = 0;
  private inFlight = 0;
  private dropped = 0;
  private droppedBytes = 0;
  private droppedSinceLog = 0;
  private lastDropLogAt = 0;
  private assetRefusedReserveDepth = 0;
  private assetRefusedReserveBytes = 0;
  private assetHeldSinceLog = 0;
  private lastAssetHoldLogAt = 0;
  /**
   * This process's scheduling delay, sampled only while the sink has work — lag while
   * idle says nothing, and a sink nobody uses should hold no timer.
   */
  private readonly loopLags: number[] = [];
  private lagTimer: ReturnType<typeof setInterval> | undefined;
  private lagDueAt = 0;
  private readonly queueWaits: number[] = [];
  private readonly putDurations: number[] = [];
  private readonly headDurations: number[] = [];
  private readonly drainWaiters: Array<() => void> = [];
  /**
   * Content addresses with an op already running. HEAD-then-PUT is blind to a sibling:
   * two captures of the same bytes both HEAD before either PUT lands, both miss, and
   * "write-once" becomes two uploads of the same object. Both lanes share this set —
   * their prefixes keep the key spaces apart, so one guard covers both.
   */
  private readonly inFlightKeys = new Set<string>();
  /**
   * Ops the BUDGET ended, counted inside `failed`/`assetFailed` rather than beside
   * them. "The store answered with an error" and "the store never answered" are
   * different faults wanting different responses, and one counter cannot say which.
   */
  private timedOut = 0;
  private stored = 0;
  private deduped = 0;
  private failed = 0;
  private skippedDisabled = 0;
  private assetStored = 0;
  private assetDeduped = 0;
  private assetFailed = 0;
  private readonly assetSkipped: AssetSkipCounts = { notImage: 0, tooLarge: 0, empty: 0, disabled: 0 };

  constructor(
    private readonly store: ObjectStore,
    private readonly config: RawStoreConfig,
  ) {
    if (config.keyScheme !== SUPPORTED_KEY_SCHEME) {
      throw new Error(
        `unsupported raw-store key scheme "${config.keyScheme}" — this writer only knows "${SUPPORTED_KEY_SCHEME}"`,
      );
    }
    const t = config.putTimeoutMs;
    this.putTimeoutMs = typeof t === 'number' && Number.isFinite(t) && t > 0 ? t : DEFAULT_PUT_TIMEOUT_MS;
    const it = config.imagePutTimeoutMs;
    this.imagePutTimeoutMs =
      typeof it === 'number' && Number.isFinite(it) && it > 0 ? it : DEFAULT_IMAGE_PUT_TIMEOUT_MS;
    const m = config.maxImageBytes;
    this.maxImageBytes = typeof m === 'number' && Number.isFinite(m) && m > 0 ? m : DEFAULT_MAX_IMAGE_BYTES;
    this.pagesEnabled = config.pagesEnabled !== false;
    this.assetsEnabled = config.assetsEnabled !== false;
    this.concurrency = resolveRawStoreConcurrency(config.concurrency);
    const q = config.queueMax;
    this.queueMax =
      typeof q === 'number' && Number.isFinite(q) && q > 0
        ? Math.min(Math.max(Math.floor(q), MIN_RAW_STORE_QUEUE_MAX), MAX_RAW_STORE_QUEUE_MAX)
        : DEFAULT_RAW_STORE_QUEUE_MAX;
    const qb = config.queueMaxBytes;
    this.queueMaxBytes =
      typeof qb === 'number' && Number.isFinite(qb) && qb > 0 ? Math.floor(qb) : DEFAULT_RAW_STORE_QUEUE_MAX_BYTES;
    // Clamped like the other bounds, and for the same reason: a share above 1 is not a
    // bigger reservation but none at all, and a zero/negative one would silently close
    // the asset lane behind PERSIST_RAW_IMAGES' back.
    const as = config.assetQueueShare;
    this.assetQueueShare =
      typeof as === 'number' && Number.isFinite(as) && as > 0
        ? Math.min(as, 1)
        : DEFAULT_RAW_STORE_ASSET_QUEUE_SHARE;
    const w = config.assetMaxWaitMs;
    this.assetMaxWaitMs =
      typeof w === 'number' && Number.isFinite(w) && w > 0
        ? Math.max(w, MIN_RAW_STORE_ASSET_MAX_WAIT_MS)
        : DEFAULT_RAW_STORE_ASSET_MAX_WAIT_MS;
  }

  stats(): SinkStats {
    return {
      stored: this.stored,
      deduped: this.deduped,
      failed: this.failed,
      skippedDisabled: this.skippedDisabled,
      assetStored: this.assetStored,
      assetDeduped: this.assetDeduped,
      assetSkipped: { ...this.assetSkipped },
      assetFailed: this.assetFailed,
      queued: this.queueDepth(),
      queuedPages: this.pageQueue.length,
      queuedAssets: this.assetQueue.length,
      inFlight: this.inFlight,
      dropped: this.dropped,
      droppedBytes: this.droppedBytes,
      assetRefusedReserve: this.assetRefusedReserve,
      assetRefusedReserveDepth: this.assetRefusedReserveDepth,
      assetRefusedReserveBytes: this.assetRefusedReserveBytes,
      queuedBytes: this.queuedBytes,
      queueWaitP50: percentile(this.queueWaits, 50),
      queueWaitP95: percentile(this.queueWaits, 95),
      putP50: percentile(this.putDurations, 50),
      putP95: percentile(this.putDurations, 95),
      headP50: percentile(this.headDurations, 50),
      headP95: percentile(this.headDurations, 95),
      timedOut: this.timedOut,
      eventLoopLagP50: percentile(this.loopLags, 50),
      eventLoopLagP95: percentile(this.loopLags, 95),
    };
  }

  /** What the queue holds, both lanes together — the number every budget is measured on. */
  private queueDepth(): number {
    return this.pageQueue.length + this.assetQueue.length;
  }

  private get assetRefusedReserve(): number {
    return this.assetRefusedReserveDepth + this.assetRefusedReserveBytes;
  }

  /**
   * Resolves once both queues are empty and every worker has finished. For tests and
   * for a graceful shutdown — the fetch path never calls it, because waiting for the
   * object store is the exact thing this queue exists to stop it doing. Pages drain
   * first — strictly, the aged-asset turn suspended — so a bounded shutdown spends its
   * budget on the captures it cannot get back.
   */
  async flush(): Promise<void> {
    if (this.queueDepth() === 0 && this.inFlight === 0) return;
    await new Promise<void>(resolve => {
      this.drainWaiters.push(resolve);
    });
  }

  /**
   * ADMIT a capture. Returns as soon as the capture is queued (or refused) — the
   * store round trip runs on a worker, so a slow bucket costs the fetch path
   * nothing. Never rejects: this lane is insurance, not a dependency.
   */
  async capture(c: RawCapture): Promise<CaptureAdmission> {
    if (c.lane === 'asset') return this.admitAsset(c);
    if (!this.pagesEnabled) {
      this.skippedDisabled += 1;
      return CAPTURE_ADMITTED; // a DECISION, not a refusal — re-offering changes nothing
    }
    return this.enqueue(() => this.storePage(c), byteLengthOf(c.bytes), 'page');
  }

  /** The page/api lanes' store round trip, on a worker. Swallows-but-counts. */
  private async storePage(c: RawCapture): Promise<void> {
    try {
      const key = this.objectKey(c);

      // A sibling op already owns this address. Its bytes are ours by definition —
      // the key IS the content hash — so this capture is a dedup, not a second write.
      if (this.inFlightKeys.has(key)) {
        this.deduped += 1;
        return;
      }
      this.inFlightKeys.add(key);
      try {
        // ONE budget across both round trips (see withTimeout): what the operator sets
        // is what the capture may spend, rather than what EACH half may spend.
        const outcome = await this.withTimeout(async signal => {
          // HEAD-then-PUT: content-addressed, so an existing key means identical bytes.
          if (await this.timed(this.headDurations, signal, () => this.store.exists(key, signal))) {
            return 'deduped' as const;
          }

          // Off the event loop, and INSIDE the budget: it is our own cost rather than
          // the store's, but it is time the capture holds a worker, and the budget is
          // what bounds that. The per-phase split stays honest either way — headP50 and
          // putP50 time the store CALLS only — and eventLoopLagP95 beside them says
          // whether our own CPU, not the bucket, is what ran the clock down.
          const body = await gzipAsync(c.bytes);
          // Never open a round trip the budget has already spent: it would reach the
          // store for an op nobody is waiting for, and record a phantom 0 ms sample.
          signal.throwIfAborted();
          await this.timed(this.putDurations, signal, () =>
            this.store.put(key, body, { contentType: 'application/gzip', metadata: this.metadata(c) }, signal),
          );
          return 'stored' as const;
        });
        // Counted out here, on the value the RACE resolved with: an op the budget ended
        // keeps running in the background, and must never book itself as stored.
        if (outcome === 'deduped') this.deduped += 1;
        else this.stored += 1;
      } finally {
        this.inFlightKeys.delete(key);
      }
    } catch (err) {
      // Raw capture is best-effort insurance; a store failure must never break or
      // stall a scrape. Count it so the failure is observable in prod.
      this.failed += 1;
      // eslint-disable-next-line no-console
      console.warn(
        // lgtm[js/log-injection] — url is caller-influenced; sanitize before logging
        `[RAW-STORE] capture failed for ${sanitizeForLog(c.url)} (sha ${c.sha256.slice(0, 12)}…): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * The asset lane: store the ORIGINAL image bytes, unaltered. A body that is not
   * an image, is oversized, or is empty is a typed SKIP — counted, never stored and
   * never thrown, because a mislabelled or challenge-page response on this lane is
   * routine and must not disturb the scrape.
   */
  private async admitAsset(c: RawCapture): Promise<CaptureAdmission> {
    if (!this.assetsEnabled) {
      this.assetSkipped.disabled += 1;
      return CAPTURE_ADMITTED;
    }
    let bytes: Buffer;
    let type: ImageType | undefined;
    try {
      // Inside the try: the sink's contract is swallowed-but-counted, so even a
      // malformed capture must be a counter, never a rejection out of capture().
      // These decisions cost no round trip, so they are settled HERE rather than
      // spending a queue slot to discover that nothing was going to be stored.
      bytes = asBuffer(c.bytes);
      if (bytes.length === 0) {
        this.assetSkipped.empty += 1;
        return CAPTURE_ADMITTED;
      }
      if (bytes.length > this.maxImageBytes) {
        this.assetSkipped.tooLarge += 1;
        return CAPTURE_ADMITTED;
      }
      type = sniffImageType(bytes);
      if (!type) {
        this.assetSkipped.notImage += 1;
        return CAPTURE_ADMITTED;
      }
    } catch (err) {
      this.assetFailed += 1;
      this.warnAssetFailure(c, err);
      return CAPTURE_ADMITTED; // counted and logged — the sink has resolved it
    }
    const stored = bytes;
    const imageType = type;
    return this.enqueue(() => this.storeAsset(c, stored, imageType), stored.byteLength, 'asset');
  }

  /** The asset lane's store round trip, on a worker — the SAME queue as the pages. */
  private async storeAsset(c: RawCapture, bytes: Buffer, type: ImageType): Promise<void> {
    try {
      const prefix = this.config.imagePrefix ?? DEFAULT_IMAGE_PREFIX;
      const key = `${prefix}sha256/${c.sha256.slice(0, 2)}/${c.sha256}.${type.ext}`;

      if (this.inFlightKeys.has(key)) {
        this.assetDeduped += 1;
        return;
      }
      this.inFlightKeys.add(key);
      try {
        // One budget across this lane's two round trips, exactly as the page lanes.
        const outcome = await this.withTimeout(async signal => {
          if (await this.timed(this.headDurations, signal, () => this.store.exists(key, signal))) {
            return 'deduped' as const;
          }

          // No gzip and no Content-Encoding: an image is already compressed, and the
          // original must be readable as itself straight out of the bucket.
          signal.throwIfAborted();
          await this.timed(this.putDurations, signal, () =>
            this.store.put(key, bytes, { contentType: type.contentType, metadata: this.assetMetadata(c) }, signal),
          );
          return 'stored' as const;
        }, this.imagePutTimeoutMs);
        if (outcome === 'deduped') this.assetDeduped += 1;
        else this.assetStored += 1;
      } finally {
        this.inFlightKeys.delete(key);
      }
    } catch (err) {
      this.assetFailed += 1;
      this.warnAssetFailure(c, err);
    }
  }

  private warnAssetFailure(c: RawCapture, err: unknown): void {
    // eslint-disable-next-line no-console
    console.warn(
      // lgtm[js/log-injection] — url is caller-influenced; sanitize before logging
      `[RAW-STORE] asset capture failed for ${sanitizeForLog(c.url)} (sha ${String(c.sha256).slice(0, 12)}…): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  /**
   * Admit one store op, or drop it. Dropping is the deliberate alternative to an
   * unbounded backlog: a queue of buffered page bodies that outruns the store is
   * memory we are holding on a scrape's behalf, and the capture it is holding is
   * already stale by the time it would be written.
   */
  private enqueue(run: () => Promise<void>, bytes: number, lane: 'page' | 'asset'): CaptureAdmission {
    // The PAGE RESERVATION. Both lanes share this queue, but not the consequences of
    // losing a slot: a refused page body is provenance gone for good behind a claim
    // already written, a refused image is one the next crawl pass re-fetches. So the
    // asset lane may enter only while the queue is below its share of both budgets,
    // and the remainder stays there for pages.
    //
    // The two budgets are tested differently BECAUSE the two lanes' units are: one
    // slot is one slot, but one asset is up to RAW_STORE_IMAGE_MAX_BYTES — settable
    // as high as 64 MiB, which is exactly the quarter of the 256 MiB default budget
    // this reservation holds. So DEPTH is tested on what the queue holds now (a
    // one-slot overshoot is one slot), while BYTES are tested on what the queue WOULD
    // hold: admitting an asset because the queue had not yet crossed the line let four
    // of them walk a 256 KB budget from 191997 to 255996 and refuse the next PAGE
    // `queueBytesFull` — the reserve spent entirely on images, which is the outcome
    // the reservation exists to prevent.
    //
    // The empty queue is the one exemption, and only for the bytes: a capture that
    // waits behind nobody displaces nobody, so it is admitted even when it alone
    // exceeds the share. That holds at most ONE such asset (the next one is measured
    // against it), and the hard ceilings below still bound the memory either way.
    //
    // Both tests read the two lanes' queues COMBINED — the reservation is a share of the
    // whole queue, and page priority (see work) changed the order of service, not this.
    if (lane === 'asset' && this.assetQueueShare < 1) {
      const depth = this.queueDepth();
      const held: 'depth' | 'bytes' | undefined =
        depth >= this.assetQueueShare * this.queueMax
          ? 'depth'
          : depth > 0 && this.queuedBytes + bytes > this.assetQueueShare * this.queueMaxBytes
            ? 'bytes'
            : undefined;
      if (held) {
        // Counted by the budget that held it, as the drops are: the two want different knobs.
        if (held === 'depth') this.assetRefusedReserveDepth += 1;
        else this.assetRefusedReserveBytes += 1;
        this.holdAndLog(held, bytes);
        // A refusal, not a skip: the caller must retry rather than memoize this url.
        return { admitted: false, reason: 'assetReserve' };
      }
    }
    if (this.queueDepth() >= this.queueMax) {
      this.dropped += 1;
      this.dropAndLog('depth');
      return { admitted: false, reason: 'queueFull' };
    }
    // The byte budget, checked against what the queue would hold AFTER this capture.
    // A count ceiling is not a memory bound: the depth that is 15 MB of page bodies
    // is gigabytes of 10 MiB originals, and both arrive on the same queue.
    if (this.queuedBytes + bytes > this.queueMaxBytes) {
      this.droppedBytes += 1;
      this.dropAndLog('bytes');
      return { admitted: false, reason: 'queueBytesFull' };
    }
    this.startLagSampling();
    this.queuedBytes += bytes;
    (lane === 'page' ? this.pageQueue : this.assetQueue).push({ run, enqueuedAt: Date.now(), bytes });
    // `.catch` for the same reason the queue's other fire-and-forget call sites have
    // one: an unhandled rejection out here would take the process with it, and this
    // lane is insurance — it is never allowed to be the thing that kills a scraper.
    if (this.inFlight < this.concurrency) void this.work().catch(() => undefined);
    return CAPTURE_ADMITTED;
  }

  /** One worker: take ops until both queues are empty, then release any flush() waiters. */
  private async work(): Promise<void> {
    this.inFlight += 1;
    try {
      for (;;) {
        const job = this.nextJob();
        if (!job) break;
        // The budget bounds what is WAITING; what is running is already bounded by
        // the concurrency, so a dequeued capture gives its bytes back immediately.
        this.queuedBytes -= job.bytes;
        this.record(this.queueWaits, Date.now() - job.enqueuedAt);
        await job.run(); // storePage/storeAsset own their try/catch — this cannot reject
      }
    } finally {
      this.inFlight -= 1;
      if (this.queueDepth() === 0 && this.inFlight === 0) {
        this.stopLagSampling();
        for (const resolve of this.drainWaiters.splice(0)) resolve();
      }
    }
  }

  /**
   * Which capture a freed worker takes. A page whenever one is waiting, an asset only
   * when none is, FIFO inside each — the page is the capture nothing will fetch again,
   * and it must not wait behind a backlog of images the next pass would re-fetch anyway.
   * The one exception is an asset that has waited LONGER THAN `assetMaxWaitMs` while
   * pages kept coming: it goes next, ONE of them, and then a page again (`pageOwed`), so
   * the lane never starves and a page never waits behind more than one asset. A shutdown
   * flush — a drain waiter registered — is strictly pages first: that budget is for the
   * captures nothing will fetch again.
   */
  private nextJob(): QueuedOp | undefined {
    const oldestAsset = this.assetQueue[0];
    if (
      oldestAsset !== undefined &&
      this.pageQueue.length > 0 &&
      !this.pageOwed &&
      this.drainWaiters.length === 0 &&
      Date.now() - oldestAsset.enqueuedAt > this.assetMaxWaitMs
    ) {
      this.pageOwed = true;
      return this.assetQueue.shift();
    }
    const page = this.pageQueue.shift();
    if (page) {
      this.pageOwed = false;
      return page;
    }
    return this.assetQueue.shift();
  }

  /**
   * Run one store op and sample how long it took — on the way out either way. A
   * percentile built from successes only is the one an operator cannot use: the ops
   * that consume the whole budget are exactly the ones being dropped from it, so a
   * lane timing out on every upload reports the same fast p95 as a healthy one.
   */
  private async timed<T>(into: number[], signal: AbortSignal, op: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    try {
      // Raced against the budget as well as awaited, so the PHASE ends when the op does.
      // The port makes the signal optional, so a store may simply ignore it — and one
      // that does would otherwise hold this sample open forever and leave the very op
      // that consumed the whole budget out of the percentile built to show it.
      return await Promise.race([op(), rejectOnAbort(signal)]);
    } finally {
      this.record(into, Date.now() - startedAt);
    }
  }

  private record(into: number[], ms: number): void {
    into.push(ms);
    if (into.length > LATENCY_SAMPLE_MAX) into.shift();
  }

  /**
   * Sample how late a due timer runs — the delay this PROCESS is suffering, whatever
   * its cause (a synchronous parse on the loop, a cgroup CPU quota, a noisy co-tenant).
   * Every other duration this sink reports is wall clock measured from inside the
   * process, so without this reading a throttled pod and a slow bucket are the same
   * number, and the two want opposite remedies.
   */
  private startLagSampling(): void {
    if (this.lagTimer) return;
    this.lagDueAt = Date.now() + LOOP_LAG_SAMPLE_INTERVAL_MS;
    this.lagTimer = setInterval(() => {
      const now = Date.now();
      this.record(this.loopLags, Math.max(0, now - this.lagDueAt));
      this.lagDueAt = now + LOOP_LAG_SAMPLE_INTERVAL_MS;
    }, LOOP_LAG_SAMPLE_INTERVAL_MS);
    // Never a reason for the process to stay alive: this is instrumentation.
    this.lagTimer.unref?.();
  }

  private stopLagSampling(): void {
    if (!this.lagTimer) return;
    // Take the reading the interval never got to. A block that runs right through the
    // last op ends in microtasks — the worker finishes, the queue empties and this
    // clears the timer before the loop ever reaches its timers phase — so the one
    // sample that would have shown the stall is exactly the one that gets thrown away.
    this.record(this.loopLags, Math.max(0, Date.now() - this.lagDueAt));
    clearInterval(this.lagTimer);
    this.lagTimer = undefined;
  }

  /** Tally one drop and report the burst, at most once a minute. */
  private dropAndLog(ceiling: 'depth' | 'bytes'): void {
    this.droppedSinceLog += 1;
    const now = Date.now();
    if (now - this.lastDropLogAt < DROP_LOG_INTERVAL_MS) return;
    this.lastDropLogAt = now;
    const since = this.droppedSinceLog;
    this.droppedSinceLog = 0;
    const bound = ceiling === 'depth' ? `depth ${this.queueMax}` : `${this.queueMaxBytes} bytes`;
    // eslint-disable-next-line no-console
    console.warn(
      `[RAW-STORE] capture queue full (${bound} reached, concurrency ${this.concurrency}) — ` +
        `dropped ${since} capture(s) since the last report, ${this.dropped} on depth and ` +
        `${this.droppedBytes} on bytes in total`,
    );
  }

  /**
   * Tally one held-back asset and report the burst, at most once a minute — on its
   * OWN line and its own window, never mixed into the drop report. The two events say
   * different things to an operator: "capture queue full" is captures being lost, this
   * one is captures being deferred to protect the ones that cannot be. The line names
   * the budget that held THIS asset and the knob that raises it; refusals carried from
   * inside the window are reported by budget in the running totals, so a burst that
   * bound on both still reads right.
   */
  private holdAndLog(budget: 'depth' | 'bytes', bytes: number): void {
    this.assetHeldSinceLog += 1;
    const now = Date.now();
    if (now - this.lastAssetHoldLogAt < DROP_LOG_INTERVAL_MS) return;
    this.lastAssetHoldLogAt = now;
    const since = this.assetHeldSinceLog;
    this.assetHeldSinceLog = 0;
    // By lane, always: the share is a share of the WHOLE queue, so "the asset share is
    // spent" can be true with no asset waiting at all — pages spent it — and the line
    // must not read as an image backlog when it is a page backlog.
    const lanes = `${this.pageQueue.length} page(s) + ${this.assetQueue.length} asset(s)`;
    const bound =
      budget === 'depth'
        ? `the asset share of the queue DEPTH is spent (share ${this.assetQueueShare} of ` +
          `RAW_STORE_QUEUE_MAX ${this.queueMax}: ${this.queueDepth()} queued = ${lanes})`
        : `the asset share of the queue BYTES is spent (share ${this.assetQueueShare} of ` +
          `RAW_STORE_QUEUE_MAX_BYTES ${this.queueMaxBytes}: ${this.queuedBytes} queued + ${bytes} offered, ` +
          `held by ${lanes})`;
    // eslint-disable-next-line no-console
    console.warn(
      `[RAW-STORE] asset capture held back for the page reservation — ${bound} — ` +
        `refused ${since} asset capture(s) since the last report, ${this.assetRefusedReserveDepth} on depth ` +
        `and ${this.assetRefusedReserveBytes} on bytes in total; those images are re-fetchable next pass, ` +
        'the page bodies the space is held for are not',
    );
  }

  /** `<prefix>sha256/<aa>/<sha256hex><ext>` — the json (api) lane uses jsonPrefix. */
  private objectKey(c: RawCapture): string {
    const aa = c.sha256.slice(0, 2);
    const isJson = c.lane === 'api' || (c.contentType ?? '').includes('json');
    const prefix = isJson ? this.jsonPrefix() : this.config.prefix;
    const ext = isJson ? '.json.gz' : '.html.gz';
    return `${prefix}sha256/${aa}/${c.sha256}${ext}`;
  }

  private jsonPrefix(): string {
    if (this.config.jsonPrefix) return this.config.jsonPrefix;
    // Fallback only when unconfigured: derive a raw-json/ sibling from the html
    // prefix if it follows the raw-html/ convention, else reuse the html prefix.
    return this.config.prefix.includes('raw-html')
      ? this.config.prefix.replace('raw-html', 'raw-json')
      : this.config.prefix;
  }

  private metadata(c: RawCapture): Record<string, string> {
    const url = c.finalUrl ?? c.url;
    const md: Record<string, string> = { url: headerSafe(url), 'fetched-at': headerSafe(c.fetchedAt) };
    const host = hostOf(url); // best-effort — a malformed URL just omits the site tag
    if (host) md.site = headerSafe(host);
    return budgetMetadata(md);
  }

  /**
   * Asset provenance: which item's page referenced these bytes, where in its image
   * list, what the store CLAIMED they were (kept beside the sniffed type that
   * actually decided the object's Content-Type), and whether the response was
   * NEGOTIATED or transfer-encoded rather than served as-is.
   */
  private assetMetadata(c: RawCapture): Record<string, string> {
    const url = c.finalUrl ?? c.url;
    const md: Record<string, string> = {
      url: headerSafe(url),
      'fetched-at': headerSafe(c.fetchedAt),
      lane: 'asset',
      bytes: String(asBuffer(c.bytes).length),
    };
    // The DECLARING store when we know it — an image usually lives on a CDN host
    // that says nothing about whose catalogue it belongs to.
    const site = c.sourceItem?.site ?? hostOf(url);
    if (site) md.site = headerSafe(site);
    if (c.sourceItem) md['source-item'] = headerSafe(`${c.sourceItem.site}/${c.sourceItem.itemId}`);
    if (c.sourceUrl) md['source-url'] = headerSafe(c.sourceUrl);
    if (c.position !== undefined) md.position = headerSafe(String(c.position));
    if (c.role) md.role = headerSafe(c.role);
    if (c.contentType) md['declared-content-type'] = headerSafe(c.contentType);
    // The NEGOTIATION witnesses, beside the declared type they qualify: `vary` says the server chose
    // this representation from the request headers, `content-encoding` that the wire body was not
    // the stored one. Absent — never empty — when the server sent neither, which is the ordinary
    // case and the one that means "this is the object as served".
    if (c.contentEncoding) md['content-encoding'] = headerSafe(c.contentEncoding);
    if (c.vary) md['vary'] = headerSafe(c.vary);
    return budgetMetadata(md);
  }

  /**
   * Bounds ONE CAPTURE'S whole trip to the store — the HEAD, the gzip and the PUT under
   * a single budget — and CANCELS it when the bound is reached.
   *
   * One budget, not one per call: `RAW_STORE_PUT_TIMEOUT_MS=30000` promises an operator
   * that a capture may spend 30 s on the store, and giving each half its own budget
   * quietly made that a 60 s worst case (and the asset lane's 60 s a 120 s one). That
   * gap was survivable while a timeout only mis-counted a PUT that still landed; now
   * that reaching the bound destroys the body, the number an operator sets has to be the
   * number the op can spend.
   *
   * This was a bare race for as long as the adapter had no way to stop a request, and
   * the race is the part that bites: the sink stopped waiting, counted a failure and
   * freed the worker, while the request carried on holding its socket. Because cost
   * per object here is the round trip and not the payload, that abandoned request goes
   * on spending the store's request budget beside the replacement the freed worker
   * started — so `concurrency` bounded what the sink was WATCHING, not what was in
   * flight, and every op that overran made the next one likelier to overrun too.
   *
   * The signal is handed to the op, and the adapter destroys the underlying request on
   * abort. The race stays: it is what makes the budget observable to the caller even if
   * an adapter ignores the signal. A cancelled PUT may still have landed server-side —
   * the key is a content address and PUT is idempotent, so the next capture of those
   * bytes simply finds them.
   */
  private withTimeout<T>(
    run: (signal: AbortSignal) => Promise<T>,
    budgetMs: number = this.putTimeoutMs,
  ): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.timedOut += 1;
        const err = new Error(`raw-store op exceeded ${budgetMs}ms`);
        controller.abort(err);
        reject(err);
      }, budgetMs);
    });
    // Promise.race subscribes to BOTH, so the op's own late rejection (the abort
    // arriving back through the adapter) is handled and never reaches the process as
    // an unhandled rejection.
    return Promise.race([run(controller.signal), timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }
}
