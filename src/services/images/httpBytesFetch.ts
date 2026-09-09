/**
 * httpBytesFetch — the plain-HTTP image BYTES lane, sibling of `createHttpFetch`'s string transport.
 *
 * Same shape as the string lane (one abort signal bounds headers AND body, no cookies of its own)
 * with two differences that matter for an image: the body is read as an ARRAY BUFFER,
 * never `text()`, and residential egress is REFUSED here rather than silently ignored — Node's
 * global fetch cannot proxy, so a residential image rides impit or the gated tab. The refusal
 * carries the very wording `refuseHttpLaneResidentialEgress` throws for the string lane, and it is
 * raised on the DECLARED egress as well as on a resolved proxy URL: a residential fetch whose proxy
 * never resolved must not degrade into a direct one.
 */
import { httpLaneResidentialRefusal } from '../residentialEgress.js';
import { isDeniedImageUrl } from './imageHostPolicy.js';
import {
  BLOCK_SIGNAL_HEADERS,
  CAPTURED_IMAGE_HEADERS,
  DEFAULT_MAX_IMAGE_BYTES,
  classifyImageBytes,
  imageTooLarge,
  isTimeoutError,
  overImageSizeCap,
  refusedFinalUrl,
  resolveImageAccept,
  resolveImageTimeout,
  type ImageBytesFetcher,
  type ImageBytesResult,
} from './imageBytes.js';

export { ARCHIVAL_IMAGE_ACCEPT } from './imageBytes.js';

/** Abort ceiling (ms) for one image GET. An image is a small body; it does not get the listing budget. */
export const DEFAULT_IMAGE_FETCH_TIMEOUT_MS = 15_000;

/** The slice of a `fetch` Response this lane reads — lets a test drive it without the network. */
export interface BytesResponseLike {
  status: number;
  url?: string;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type BytesFetchImpl = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal; redirect?: 'follow' },
) => Promise<BytesResponseLike>;

export interface HttpBytesFetchOptions {
  /** Injectable transport (default: the global `fetch`). */
  fetchImpl?: BytesFetchImpl;
  /** Abort ceiling for every request this fetcher makes (default {@link DEFAULT_IMAGE_FETCH_TIMEOUT_MS}). */
  timeoutMs?: number;
  /** Body ceiling (default {@link DEFAULT_MAX_IMAGE_BYTES}). */
  maxBytes?: number;
  /** The Accept every request sends (default: `IMAGE_ACCEPT`, else the archival header). */
  accept?: string;
  /** Where an unusable `IMAGE_ACCEPT` is named (default: the console). */
  warn?: (message: string) => void;
}

/** The named headers the response actually carried, lowercased. */
function headerSubset(res: BytesResponseLike, names: readonly string[] = CAPTURED_IMAGE_HEADERS): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = res.headers.get(name);
    if (value != null && value !== '') out[name] = value;
  }
  return out;
}

/**
 * Build the plain-HTTP image bytes fetcher. Every expected outcome is a typed result; only a genuine
 * transport fault (DNS, connection reset) propagates.
 */
export function createHttpBytesFetch(options: HttpBytesFetchOptions = {}): ImageBytesFetcher {
  const timeoutMs = options.timeoutMs ?? DEFAULT_IMAGE_FETCH_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  // Resolved ONCE per lane, not per request: an unusable IMAGE_ACCEPT is then named once at build
  // rather than on every image of every item.
  const accept = options.accept ?? resolveImageAccept(process.env, options.warn);
  return async function httpBytesFetch(url, opts = {}): Promise<ImageBytesResult> {
    // EGRESS, before the network: this lane cannot proxy, so a residential image is refused here
    // rather than fetched from the node IP (the string lane's rule, same wording).
    if (opts.proxyUrl || opts.egress === 'residential') {
      return { ok: false, reason: 'refused', detail: httpLaneResidentialRefusal(url, opts.proxyUrl ?? '(unresolved)').message };
    }
    const headers: Record<string, string> = {
      // UA — and the one line where the policy table's ua:'default' has to SURVIVE. That token means
      // "send no browser identity", and it arrives here as an absent `userAgent`; substituting a
      // Chrome string for it (as this line did until 2026-09-09) inverted the operator's decision
      // into its opposite. hobby-genki.com is the proof: measured on 2026-09-09, its CDN answers a
      // request with no user agent 200/image/jpeg and one claiming Chrome 403/cf-mitigated:challenge
      // — a browser CLAIM over a non-browser TLS fingerprint is what it refuses, so the engine's own
      // page-lane Chrome UA is refused just the same. Absent, this lane sends undici's `node`: a
      // non-browser default that matches the fingerprint the connection actually has.
      ...(opts.userAgent ? { 'user-agent': opts.userAgent } : {}),
      accept: opts.accept ?? accept,
      ...(opts.referer ? { referer: opts.referer } : {}),
    };
    const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as BytesFetchImpl);
    let res: BytesResponseLike;
    try {
      res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(resolveImageTimeout(opts.timeoutMs, timeoutMs)) });
    } catch (err) {
      if (isTimeoutError(err)) return { ok: false, reason: 'timeout', detail: (err as Error).message };
      throw err;
    }
    // A non-2xx body is never stored: a 403 hotlink page and a 404 stub are both "no image here".
    if (res.status < 200 || res.status > 299) {
      // The block SIGNALS ride along so the pacing wrapper can tell a throttle from a per-URL verdict.
      const signals = headerSubset(res, BLOCK_SIGNAL_HEADERS);
      return { ok: false, reason: 'http-status', status: res.status, ...(Object.keys(signals).length > 0 ? { signals } : {}) };
    }
    // SIZE, before the read where the server declared one: an oversized body must not be buffered
    // just to be rejected afterwards.
    const declaredLength = res.headers.get('content-length');
    if (overImageSizeCap(declaredLength, maxBytes)) return imageTooLarge(declaredLength as string, maxBytes);
    let bytes: Buffer;
    try {
      bytes = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (isTimeoutError(err)) return { ok: false, reason: 'timeout', detail: (err as Error).message };
      throw err;
    }
    // And again on what actually arrived — a CDN that declares no length is only caught here.
    if (overImageSizeCap(bytes.byteLength, maxBytes)) return imageTooLarge(bytes.byteLength, maxBytes, bytes.byteLength);
    const served = res.headers.get('content-type') ?? undefined;
    const classified = classifyImageBytes(served, bytes);
    if (!classified.image) {
      return { ok: false, reason: 'not-image', status: res.status, bytesRead: bytes.byteLength, ...(served ? { contentType: served } : {}) };
    }
    const finalUrl = res.url && res.url !== '' ? res.url : url;
    // REDIRECTS: the lane follows them, and the lane decision only ever saw the REQUESTED url. The
    // permaban is re-asserted on what the bytes actually came from, then the caller's own guard.
    if (isDeniedImageUrl(finalUrl)) return refusedFinalUrl(finalUrl, 'is on the image deny list', bytes.byteLength);
    if (opts.allowFinalUrl && !opts.allowFinalUrl(finalUrl)) {
      return refusedFinalUrl(finalUrl, 'the caller\'s final-URL guard rejected', bytes.byteLength);
    }
    return {
      ok: true,
      bytes,
      contentType: classified.contentType as string,
      status: res.status,
      finalUrl,
      headers: headerSubset(res),
    };
  };
}
