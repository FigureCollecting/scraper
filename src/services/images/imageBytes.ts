/**
 * imageBytes — the shared contract of the image BYTES lanes.
 *
 * The engine's existing transports all return a STRING: `res.text()` on the http lane, `.text()` on
 * impit, the rendered DOM on the browser lane. That is right for a document and wrong for an image —
 * decoding JPEG/PNG bytes as utf-8 silently destroys them. These lanes are SIBLINGS of the string
 * ones (nothing about the page path changes): same egress rules, same per-host pacing, but they hand
 * back a Buffer.
 *
 * Every EXPECTED outcome is a typed result, never a throw: a 404, a hotlink block page served at an
 * image URL, a timeout, a lane that cannot carry bytes at all, a fetch refused by policy or egress.
 * The caller does something different for each, and an exception erases the difference. A genuine
 * transport FAULT (DNS failure, connection reset) still throws — that is not an outcome, it is a
 * fault, and it is classified by the queue exactly as it is for the string lanes.
 */

/** Why an image fetch did not yield bytes. */
export type ImageBytesFailureReason =
  /** The server answered, but not with 2xx. */
  | 'http-status'
  /** A 2xx body that is not an image (a hotlink interstitial, a challenge page, an error JSON). */
  | 'not-image'
  /** The request outlived its budget. */
  | 'timeout'
  /** The lane cannot carry bytes at all (an impit build exposing only `text()`). */
  | 'unsupported'
  /** The body is larger than the image size cap — refused before, or abandoned after, the read. */
  | 'too-large'
  /** Refused before the network: a denied host, or residential egress on a lane that cannot proxy. */
  | 'refused';

/** Response headers kept alongside the bytes — provenance only, never a cookie or an auth header. */
export const CAPTURED_IMAGE_HEADERS = ['content-type', 'content-length', 'etag', 'last-modified'] as const;

/**
 * Headers that distinguish "this host is throttling or challenging us" from "this URL is not for
 * you". A 403 is normally the SECOND thing — a hotlink guard, an expired signed URL — and treating
 * it as a rate signal on a shared CDN spends every other store's budget on one store's
 * misconfiguration. These two headers are what a genuine Cloudflare mitigation or a real throttle
 * carries, so they are read on a non-2xx and handed to the pacing wrapper as `signals`.
 */
export const BLOCK_SIGNAL_HEADERS = ['cf-mitigated', 'retry-after'] as const;

export interface ImageBytesOk {
  ok: true;
  /** The body EXACTLY as served — never re-encoded, never decoded through a string. */
  bytes: Buffer;
  /** The served content type, or the sniffed one when the server sent none (see classifyImageBytes). */
  contentType: string;
  status: number;
  /** The URL the bytes actually came from (after redirects); the requested URL when unknown. */
  finalUrl: string;
  /** {@link CAPTURED_IMAGE_HEADERS} that were present, lowercased. */
  headers: Record<string, string>;
}

export interface ImageBytesFailure {
  ok: false;
  reason: ImageBytesFailureReason;
  /** Present for 'http-status' and for a 'not-image' body the server answered 2xx for. */
  status?: number;
  /** The content type that was rejected ('not-image'). */
  contentType?: string;
  /** A human-readable reason, for the refusal and the unsupported lane. Never carries a secret. */
  detail?: string;
  /** {@link BLOCK_SIGNAL_HEADERS} the rejecting response carried — what separates a throttle from a verdict. */
  signals?: Record<string, string>;
}

export type ImageBytesResult = ImageBytesOk | ImageBytesFailure;

/** Per-request options every image lane accepts. Absent ⇒ the lane's own defaults. */
export interface ImageFetchOptions {
  /** `Referer` to send — hotlink-protected CDNs serve a block page without it. */
  referer?: string;
  /** Overrides {@link IMAGE_ACCEPT}. */
  accept?: string;
  /** Overrides the lane's default user agent. */
  userAgent?: string;
  /** Residential egress for this fetch. The plain-HTTP lane REFUSES it (it cannot proxy). */
  proxyUrl?: string;
  /**
   * The exit this fetch MUST leave through, carried alongside `proxyUrl` so a lane can tell "direct
   * by decision" from "residential whose proxy never got resolved". `residential` with no usable
   * proxy is refused by every lane — a residential store is never silently fetched from the node IP.
   */
  egress?: 'direct' | 'residential';
  /** Per-request budget (ms); the lane clamps/defaults it. */
  timeoutMs?: number;
  /**
   * Extra check on the URL the bytes actually came from, AFTER redirects. Every lane follows them
   * and `chooseImageLane` only ever saw the requested URL, so this is where a caller re-asserts a
   * decision a redirect could have invalidated — most importantly that a RESIDENTIAL fetch is still
   * on the declaring store's own hosts. Returning false refuses the result. The permaban is enforced
   * by the lanes themselves and needs no guard.
   */
  allowFinalUrl?: (finalUrl: string) => boolean;
}

/**
 * Ceiling on ONE image body. An image is a small object; a body far past this is a video, an archive
 * or a CDN error streaming without terminating — none of which this lane should hold in memory,
 * least of all several at once. The classification that would reject it only runs once the WHOLE
 * body is resident, so the cap has to sit before that.
 */
export const DEFAULT_MAX_IMAGE_BYTES = 32 * 1024 * 1024;

/** Whether a declared or measured length is past the cap. A missing/garbage length is not. */
export function overImageSizeCap(length: number | string | undefined | null, maxBytes: number): boolean {
  const n = typeof length === 'string' ? Number(length) : length;
  return typeof n === 'number' && Number.isFinite(n) && n > maxBytes;
}

/** The typed refusal for a body past the cap; `length` is the declared or measured size. */
export function imageTooLarge(length: number | string, maxBytes: number): ImageBytesFailure {
  return { ok: false, reason: 'too-large', detail: `body of ${length} bytes exceeds the ${maxBytes}-byte image size cap` };
}

/** An image bytes transport: url + options in, a typed result out. */
export type ImageBytesFetcher = (url: string, options?: ImageFetchOptions) => Promise<ImageBytesResult>;

/**
 * The Accept a browser sends for an <img> request. Some CDNs vary their response on it (serving webp
 * or avif to a client that declares support), and a few hotlink guards check that it is not `* / *`.
 */
export const IMAGE_ACCEPT = 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8';

/** SVG: an `image/*` type whose body is active content. Never accepted as an image by these lanes. */
const SVG_CONTENT_TYPE = /^image\/svg(\+xml)?\b/i;

/** Content types that mean "bytes, type unknown" — the only ones worth sniffing. */
const GENERIC_CONTENT_TYPE = /^(application|binary)\/octet-stream\b/i;

/** Magic-byte signatures, longest-anchored first. Enough to tell an image from a block page. */
const SIGNATURES: ReadonlyArray<{ contentType: string; test: (b: Buffer) => boolean }> = [
  { contentType: 'image/png', test: b => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { contentType: 'image/jpeg', test: b => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { contentType: 'image/gif', test: b => b.length >= 6 && (b.subarray(0, 6).toString('latin1') === 'GIF87a' || b.subarray(0, 6).toString('latin1') === 'GIF89a') },
  { contentType: 'image/webp', test: b => b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  { contentType: 'image/avif', test: b => b.length >= 12 && b.subarray(4, 8).toString('latin1') === 'ftyp' && b.subarray(8, 12).toString('latin1') === 'avif' },
  { contentType: 'image/bmp', test: b => b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d },
];

/** Whether a body is an image, and under which content type it should be stored. */
export interface ImageClassification {
  image: boolean;
  /** The type to store: the served one when it is `image/*`, else the sniffed one. */
  contentType?: string;
}

/**
 * Decide whether a fetched body is an image. A declared `image/*` type is taken verbatim (the server
 * knows its own format, and a stored object must carry the REAL content type). A missing or generic
 * `octet-stream` type — which several store CDNs serve — is decided by the magic bytes rather than
 * being rejected; anything else declared (text/html, application/json) is NOT an image no matter what
 * the bytes look like, because a block page that happens to start with the right byte is still a
 * block page.
 */
export function classifyImageBytes(contentType: string | undefined | null, bytes: Buffer): ImageClassification {
  const declared = (contentType ?? '').trim();
  // SVG is the exception to "a declared image/* is an image": it is a DOCUMENT format that carries
  // script, and these lanes exist to store bytes a media warehouse later serves to browsers. A
  // hostile or compromised store CDN would otherwise hand us stored XSS under an image content type.
  if (SVG_CONTENT_TYPE.test(declared)) return { image: false };
  if (/^image\//i.test(declared)) return { image: true, contentType: declared };
  if (declared !== '' && !GENERIC_CONTENT_TYPE.test(declared)) return { image: false };
  const sniffed = SIGNATURES.find(s => s.test(bytes));
  return sniffed ? { image: true, contentType: sniffed.contentType } : { image: false };
}

/**
 * The refusal a lane returns when the bytes came from somewhere the decision did not allow — a
 * redirect into a denied host, or off the declaring store on a residential fetch.
 */
export function refusedFinalUrl(finalUrl: string, why: string): ImageBytesFailure {
  return { ok: false, reason: 'refused', detail: `the bytes came from ${finalUrl}, which ${why}` };
}

/**
 * True for a request that ran out of time. undici names it (`TimeoutError` / `AbortError` from the
 * abort signal); impit's native binding does not — it throws a plain Error whose MESSAGE says so, so
 * the message is the only signal available for that lane. Matching on it is deliberately narrow: the
 * cost of a false positive is one expired fetch reported as 'timeout' instead of thrown, and the
 * cost of missing it is a timeout escaping as a fault the queue would classify as a hard failure.
 */
export function isTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return true;
  return /\btimed out\b|\btimeout\b/i.test(err.message);
}
