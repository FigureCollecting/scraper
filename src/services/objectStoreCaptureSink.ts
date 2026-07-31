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
  /** Always `application/gzip`. */
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
  /** Key-scheme contract version; this writer only knows `sha256-v1`. */
  keyScheme: string;
  /** Hard bound on each HEAD/PUT so a slow store can't stall the fetch path. */
  putTimeoutMs?: number;
  /**
   * S3 addressing style for the adapter. Hetzner uses virtual-hosted style, so
   * the adapter defaults to `false` (path-style off). Unused by the sink logic.
   */
  pathStyle?: boolean;
}

/** Observable counters — the leak/failure surface for prod (mirrors BrowserPool). */
export interface SinkStats {
  stored: number;
  deduped: number;
  failed: number;
}

const SUPPORTED_KEY_SCHEME = 'sha256-v1';
const DEFAULT_PUT_TIMEOUT_MS = 5_000;
const MAX_METADATA_VALUE_LEN = 1024;

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

export class ObjectStoreCaptureSink implements CaptureSink {
  private readonly putTimeoutMs: number;
  private stored = 0;
  private deduped = 0;
  private failed = 0;

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
  }

  stats(): SinkStats {
    return { stored: this.stored, deduped: this.deduped, failed: this.failed };
  }

  async capture(c: RawCapture): Promise<void> {
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
    const md: Record<string, string> = { url: headerSafe(url), 'fetched-at': c.fetchedAt };
    try {
      md.site = headerSafe(new URL(url).hostname);
    } catch {
      /* best-effort — a malformed URL just omits the site tag */
    }
    return md;
  }

  private withTimeout<T>(p: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`raw-store op exceeded ${this.putTimeoutMs}ms`)),
        this.putTimeoutMs,
      );
    });
    return Promise.race([p, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }
}
