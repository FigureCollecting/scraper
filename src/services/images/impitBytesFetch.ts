/**
 * impitBytesFetch — the impit image BYTES lane, sibling of the string `impersonate` transport.
 *
 * It exists for two cases the plain lane cannot serve: a CDN behind the same TLS-fingerprint gate as
 * its store, and any image that must leave through the RESIDENTIAL exit (impit takes `proxyUrl` on
 * the session; Node's global fetch has no proxy at all).
 *
 * The one hard rule: the body is read through impit's BINARY capability, feature-detected per
 * response — `bytes()` when the build has it, else `arrayBuffer()`. A build that exposes only
 * `text()` yields a typed 'unsupported' result and the response is left unread: a JPEG decoded
 * through a utf-8 string is silently destroyed, and a corrupted image stored as if it were genuine
 * is far worse than a refusal the caller can see.
 *
 * The lane seeds the CfCookieStore's hand-minted cookies into its jar and lets the pinned MINT
 * User-Agent win on every call, exactly as the string lane does — a cf_clearance is bound to IP + UA,
 * and this lane exists for hosts whose only way through is that clearance.
 *
 * SESSION: one Impit per (impersonation profile, proxy) — the same key the string lane uses, and for
 * the same reason (a Cloudflare clearance is bound to the IP that earned it, so a proxied session
 * must never share a cookie jar with the direct one). It is this lane's OWN cache, deliberately not
 * the string lane's: an image host is usually a different host from the store, and a store's own
 * gated host belongs on the browser lane anyway (see the image host policy).
 */
import { CookieJar } from 'tough-cookie';
import {
  DEFAULT_PROFILE,
  defaultMakeImpit,
  resolveImpitTimeoutMs,
  seedJar,
  type CookieJarLike,
  type ImpitLike,
  type ImpitResponseLike,
  type MakeImpit,
} from '../impitFetch.js';
import { getCfCookieStore, type CfCookieSource } from '../cookieJar.js';
import { ResidentialEgressUnavailableError } from '../residentialEgress.js';
import { isDeniedImageUrl } from './imageHostPolicy.js';
import {
  BLOCK_SIGNAL_HEADERS,
  CAPTURED_IMAGE_HEADERS,
  DEFAULT_MAX_IMAGE_BYTES,
  IMAGE_ACCEPT,
  classifyImageBytes,
  imageTooLarge,
  isTimeoutError,
  overImageSizeCap,
  refusedFinalUrl,
  resolveImageTimeout,
  type ImageBytesFetcher,
  type ImageBytesResult,
} from './imageBytes.js';

/** One impit session: the client and the jar its stored cookies are seeded into. */
export interface ImpitBytesSession {
  impit: ImpitLike;
  /** Absent on a fake that has no jar — then nothing is seeded, which is the pre-store behavior. */
  jar?: CookieJarLike;
}

/**
 * Resolves the session to fetch with, for an impersonation profile and (optional) residential proxy.
 * A bare `ImpitLike` is accepted so a test fake with no jar stays assignable — then nothing is
 * seeded, which is byte-identical to the pre-cookie-store behavior.
 */
export type ImpitProvider = (browser: string, proxyUrl: string | undefined) => Promise<ImpitBytesSession | ImpitLike>;

export interface ImpitBytesFetchOptions {
  /** Injectable session provider (default: one cached native Impit per profile+proxy). */
  getImpit?: ImpitProvider;
  /** Stored-cookie source (default: the process CfCookieStore singleton). */
  cookieStore?: CfCookieSource;
  /** Impersonation profile (default: the engine's current chrome profile). */
  browser?: string;
  /** Body ceiling (default {@link DEFAULT_MAX_IMAGE_BYTES}). */
  maxBytes?: number;
}

/**
 * The default provider: one Impit — with its own cookie jar — per (profile, proxy), built lazily and
 * cached. `makeImpit` is injectable so this is testable without the native binary.
 */
export function createImpitSessionProvider(
  makeImpit: MakeImpit = defaultMakeImpit,
): (browser: string, proxyUrl: string | undefined) => Promise<ImpitBytesSession> {
  const sessions = new Map<string, Promise<ImpitBytesSession>>();
  const timeoutMs = resolveImpitTimeoutMs(process.env);
  return (browser, proxyUrl) => {
    // NUL separator, exactly as the string lane keys its own cache: the two operands may both
    // contain a space, and a collision here would put a clearance minted on one egress into a
    // session leaving through another.
    const key = `${browser}\u0000${proxyUrl ?? 'direct'}`;
    let session = sessions.get(key);
    if (!session) {
      const jar = new CookieJar() as unknown as CookieJarLike;
      session = Promise.resolve(makeImpit(browser, jar, timeoutMs, proxyUrl)).then(impit => ({ impit, jar }));
      sessions.set(key, session);
      // A build that fails evicts itself, so the next call retries instead of caching the failure.
      session.catch(() => {
        if (sessions.get(key) === session) sessions.delete(key);
      });
    }
    return session;
  };
}

/** The named headers as a lowercased record, whether impit hands back a `Headers` or a record. */
function readHeaders(res: ImpitResponseLike, names: readonly string[] = CAPTURED_IMAGE_HEADERS): Record<string, string> {
  const bag = res.headers;
  const out: Record<string, string> = {};
  if (bag == null) return out;
  const getter = (bag as { get?: unknown }).get;
  if (typeof getter === 'function') {
    for (const name of names) {
      const value = (bag as { get(name: string): unknown }).get(name);
      if (typeof value === 'string' && value !== '') out[name] = value;
    }
    return out;
  }
  for (const [name, value] of Object.entries(bag as Record<string, unknown>)) {
    const key = name.toLowerCase();
    if (names.includes(key) && typeof value === 'string' && value !== '') out[key] = value;
  }
  return out;
}

/**
 * Bound ONE call with the caller's per-request budget. impit's own timeout is set per SESSION (and
 * the session is shared across hosts and requests), so without this a caller asking for a tight
 * image budget silently gets the whole listing budget instead. The rejection is the lane's own
 * timeout wording, so `isTimeoutError` classifies it like every other expired fetch.
 */
async function withRequestBudget<T>(pending: Promise<T>, timeoutMs: number | undefined): Promise<T> {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return pending;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`the image request timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The body via the binary capability this response actually has; undefined ⇒ the build has none. */
async function readBytes(res: ImpitResponseLike): Promise<Buffer | undefined> {
  if (typeof res.bytes === 'function') return Buffer.from(await res.bytes());
  if (typeof res.arrayBuffer === 'function') return Buffer.from(await res.arrayBuffer());
  return undefined;
}

/**
 * Build the impit image bytes fetcher. Every expected outcome is a typed result — including an impit
 * build with no binary capability ('unsupported') — and only a genuine transport fault propagates.
 */
export function createImpitBytesFetch(options: ImpitBytesFetchOptions = {}): ImageBytesFetcher {
  const getImpit = options.getImpit ?? createImpitSessionProvider();
  const browser = options.browser ?? DEFAULT_PROFILE;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  return async function impitBytesFetch(url, opts = {}): Promise<ImageBytesResult> {
    // EGRESS, before the session: a fetch DECLARED residential whose proxy never resolved is
    // refused, not quietly sent from the node IP. This lane is chosen precisely for hosts whose
    // datacenter reputation is burned, so a silent fallback is the one outcome worth nothing.
    if (opts.egress === 'residential' && !opts.proxyUrl) {
      return { ok: false, reason: 'refused', detail: new ResidentialEgressUnavailableError(url, 'unconfigured').message };
    }
    const store = options.cookieStore ?? getCfCookieStore();
    // STORED COOKIES + PINNED UA, exactly as the string lane does it: seed the host's hand-minted
    // cookies into the session jar, and let the mint User-Agent beat the caller's — cf_clearance is
    // bound to IP + UA, so any other UA voids it. An unknown host seeds nothing and pins nothing.
    const pinnedUa = store.userAgentFor(url);
    const headers: Record<string, string> = {
      accept: opts.accept ?? IMAGE_ACCEPT,
      ...(opts.referer ? { referer: opts.referer } : {}),
      ...(opts.userAgent ? { 'user-agent': opts.userAgent } : {}),
      ...(pinnedUa ? { 'user-agent': pinnedUa } : {}),
    };
    let res: ImpitResponseLike;
    let bytes: Buffer | undefined;
    try {
      const session = await getImpit(browser, opts.proxyUrl);
      const impit = 'impit' in session ? session.impit : session;
      const jar = 'impit' in session ? session.jar : undefined;
      const stored = store.cookiesFor(url);
      if (jar && stored) await seedJar(jar, url, stored);
      res = await withRequestBudget(
        impit.fetch(url, { method: 'GET', headers }),
        opts.timeoutMs === undefined ? undefined : resolveImageTimeout(opts.timeoutMs, opts.timeoutMs),
      );
      // STATUS before BODY: a 403 hotlink page is not worth reading, and impit's own error bodies
      // are not images. An impit build that reports no status is treated as 2xx (the pre-status
      // behavior) rather than being failed on a value it never had.
      if (typeof res.status === 'number' && (res.status < 200 || res.status > 299)) {
        const signals = readHeaders(res, BLOCK_SIGNAL_HEADERS);
        return { ok: false, reason: 'http-status', status: res.status, ...(Object.keys(signals).length > 0 ? { signals } : {}) };
      }
      // SIZE before the read where impit reports a length, and again on the bytes that arrived.
      const declaredLength = readHeaders(res, ['content-length'])['content-length'];
      if (overImageSizeCap(declaredLength, maxBytes)) return imageTooLarge(declaredLength, maxBytes);
      bytes = await readBytes(res);
      if (bytes !== undefined && overImageSizeCap(bytes.byteLength, maxBytes)) return imageTooLarge(bytes.byteLength, maxBytes);
    } catch (err) {
      if (isTimeoutError(err)) return { ok: false, reason: 'timeout', detail: (err as Error).message };
      throw err;
    }
    if (bytes === undefined) {
      return {
        ok: false,
        reason: 'unsupported',
        detail: 'this impit build exposes no bytes()/arrayBuffer() — an image must not be read through text()',
      };
    }
    const headerSubset = readHeaders(res);
    const served = headerSubset['content-type'];
    const classified = classifyImageBytes(served, bytes);
    if (!classified.image) {
      return {
        ok: false,
        reason: 'not-image',
        ...(typeof res.status === 'number' ? { status: res.status } : {}),
        ...(served ? { contentType: served } : {}),
      };
    }
    const finalUrl = typeof res.url === 'string' && res.url !== '' ? res.url : url;
    // impit follows redirects too — the ban, then the caller's guard, on what actually served.
    if (isDeniedImageUrl(finalUrl)) return refusedFinalUrl(finalUrl, 'is on the image deny list');
    if (opts.allowFinalUrl && !opts.allowFinalUrl(finalUrl)) {
      return refusedFinalUrl(finalUrl, 'the caller\'s final-URL guard rejected');
    }
    return {
      ok: true,
      bytes,
      contentType: classified.contentType as string,
      status: typeof res.status === 'number' ? res.status : 200,
      finalUrl,
      headers: headerSubset,
    };
  };
}
