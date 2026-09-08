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
 */
import { gzipSync } from 'node:zlib';
import type { CaptureSink, RawCapture } from './captureSink.js';
import { sanitizeForLog } from '../utils/security.js';

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
  /** Best-effort convenience metadata describing the FIRST capture only. */
  metadata?: Record<string, string>;
}

/** Minimal S3-compatible port. Concrete adapter (Hetzner) lives separately. */
export interface ObjectStore {
  /** HEAD — does this content address already exist? */
  exists(key: string): Promise<boolean>;
  /** PUT — write the object. Callers guarantee write-once by content address. */
  put(key: string, body: Buffer, opts: PutOptions): Promise<void>;
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
  /** Hard bound on each HEAD/PUT so a slow store can't stall the fetch path. */
  putTimeoutMs?: number;
  /**
   * The asset lane's own HEAD/PUT bound. An original image is up to maxImageBytes
   * (10 MiB by default) against a page body's ~30 KB gzipped, so it cannot share
   * the page budget without timing out on payload size alone.
   */
  imagePutTimeoutMs?: number;
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
}

const SUPPORTED_KEY_SCHEME = 'sha256-v1';
const DEFAULT_PUT_TIMEOUT_MS = 5_000;
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
const METADATA_SHED_ORDER = ['declared-content-type', 'source-url', 'position', 'bytes'];
/** No value is truncated below this — a stub still identifies the object. */
const MIN_BUDGETED_VALUE_LEN = 64;
const DEFAULT_IMAGE_PREFIX = 'raw-img/';
/** 10 MiB — comfortably above a storefront hero image, well below a stall. */
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

/** The URL's hostname, or undefined when it is not parseable (best-effort tagging). */
function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

export class ObjectStoreCaptureSink implements CaptureSink {
  private readonly putTimeoutMs: number;
  private readonly imagePutTimeoutMs: number;
  private readonly maxImageBytes: number;
  private readonly pagesEnabled: boolean;
  private readonly assetsEnabled: boolean;
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
    };
  }

  async capture(c: RawCapture): Promise<void> {
    if (c.lane === 'asset') return this.captureAsset(c);
    if (!this.pagesEnabled) return void (this.skippedDisabled += 1);
    try {
      const key = this.objectKey(c);

      // HEAD-then-PUT: content-addressed, so an existing key means identical bytes.
      if (await this.withTimeout(this.store.exists(key))) {
        this.deduped += 1;
        return;
      }

      const body = gzipSync(c.bytes);
      await this.withTimeout(
        this.store.put(key, body, {
          contentType: 'application/gzip',
          metadata: this.metadata(c),
        }),
      );
      this.stored += 1;
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
  private async captureAsset(c: RawCapture): Promise<void> {
    if (!this.assetsEnabled) return void (this.assetSkipped.disabled += 1);
    try {
      // Inside the try: the sink's contract is swallowed-but-counted, so even a
      // malformed capture must be a counter, never a rejection out of capture().
      const bytes = asBuffer(c.bytes);
      if (bytes.length === 0) return void (this.assetSkipped.empty += 1);
      if (bytes.length > this.maxImageBytes) return void (this.assetSkipped.tooLarge += 1);
      const type = sniffImageType(bytes);
      if (!type) return void (this.assetSkipped.notImage += 1);

      const prefix = this.config.imagePrefix ?? DEFAULT_IMAGE_PREFIX;
      const key = `${prefix}sha256/${c.sha256.slice(0, 2)}/${c.sha256}.${type.ext}`;

      if (await this.withTimeout(this.store.exists(key), this.imagePutTimeoutMs)) {
        this.assetDeduped += 1;
        return;
      }

      // No gzip and no Content-Encoding: an image is already compressed, and the
      // original must be readable as itself straight out of the bucket.
      await this.withTimeout(
        this.store.put(key, bytes, {
          contentType: type.contentType,
          metadata: this.assetMetadata(c),
        }),
        this.imagePutTimeoutMs,
      );
      this.assetStored += 1;
    } catch (err) {
      this.assetFailed += 1;
      // eslint-disable-next-line no-console
      console.warn(
        // lgtm[js/log-injection] — url is caller-influenced; sanitize before logging
        `[RAW-STORE] asset capture failed for ${sanitizeForLog(c.url)} (sha ${c.sha256.slice(0, 12)}…): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
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
   * list, and what the store CLAIMED they were (kept beside the sniffed type that
   * actually decided the object's Content-Type).
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
    if (c.contentType) md['declared-content-type'] = headerSafe(c.contentType);
    return budgetMetadata(md);
  }

  /**
   * Bounds one store op. NOTE: this is a race, not a cancellation — the underlying
   * request is abandoned, not aborted (the minio client takes no AbortSignal), so a
   * timed-out PUT may still complete into the bucket after it has been counted as a
   * failure. That is why the asset lane gets a budget sized to its payload rather
   * than sharing the page lanes'.
   */
  private withTimeout<T>(p: Promise<T>, budgetMs: number = this.putTimeoutMs): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`raw-store op exceeded ${budgetMs}ms`)), budgetMs);
    });
    return Promise.race([p, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }
}
