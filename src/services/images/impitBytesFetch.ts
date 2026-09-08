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
  type CookieJarLike,
  type ImpitLike,
  type ImpitResponseLike,
  type MakeImpit,
} from '../impitFetch.js';
import {
  CAPTURED_IMAGE_HEADERS,
  IMAGE_ACCEPT,
  classifyImageBytes,
  isTimeoutError,
  type ImageBytesFetcher,
  type ImageBytesResult,
} from './imageBytes.js';

/** Resolves the Impit to fetch with, for an impersonation profile and (optional) residential proxy. */
export type ImpitProvider = (browser: string, proxyUrl: string | undefined) => Promise<ImpitLike>;

export interface ImpitBytesFetchOptions {
  /** Injectable session provider (default: one cached native Impit per profile+proxy). */
  getImpit?: ImpitProvider;
  /** Impersonation profile (default: the engine's current chrome profile). */
  browser?: string;
}

/**
 * The default provider: one Impit — with its own cookie jar — per (profile, proxy), built lazily and
 * cached. `makeImpit` is injectable so this is testable without the native binary.
 */
export function createImpitSessionProvider(makeImpit: MakeImpit = defaultMakeImpit): ImpitProvider {
  const sessions = new Map<string, Promise<ImpitLike>>();
  const timeoutMs = resolveImpitTimeoutMs(process.env);
  return (browser, proxyUrl) => {
    const key = `${browser} ${proxyUrl ?? 'direct'}`;
    let session = sessions.get(key);
    if (!session) {
      session = Promise.resolve(makeImpit(browser, new CookieJar() as unknown as CookieJarLike, timeoutMs, proxyUrl));
      sessions.set(key, session);
      // A build that fails evicts itself, so the next call retries instead of caching the failure.
      session.catch(() => {
        if (sessions.get(key) === session) sessions.delete(key);
      });
    }
    return session;
  };
}

/** A response's headers as a lowercased record, whether impit hands back a `Headers` or a record. */
function readHeaders(res: ImpitResponseLike): Record<string, string> {
  const bag = res.headers;
  const out: Record<string, string> = {};
  if (bag == null) return out;
  const getter = (bag as { get?: unknown }).get;
  if (typeof getter === 'function') {
    for (const name of CAPTURED_IMAGE_HEADERS) {
      const value = (bag as { get(name: string): unknown }).get(name);
      if (typeof value === 'string' && value !== '') out[name] = value;
    }
    return out;
  }
  for (const [name, value] of Object.entries(bag as Record<string, unknown>)) {
    const key = name.toLowerCase();
    if ((CAPTURED_IMAGE_HEADERS as readonly string[]).includes(key) && typeof value === 'string' && value !== '') {
      out[key] = value;
    }
  }
  return out;
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
  return async function impitBytesFetch(url, opts = {}): Promise<ImageBytesResult> {
    const headers: Record<string, string> = {
      accept: opts.accept ?? IMAGE_ACCEPT,
      ...(opts.referer ? { referer: opts.referer } : {}),
      ...(opts.userAgent ? { 'user-agent': opts.userAgent } : {}),
    };
    let res: ImpitResponseLike;
    let bytes: Buffer | undefined;
    try {
      const impit = await getImpit(browser, opts.proxyUrl);
      res = await impit.fetch(url, { method: 'GET', headers });
      // STATUS before BODY: a 403 hotlink page is not worth reading, and impit's own error bodies
      // are not images. An impit build that reports no status is treated as 2xx (the pre-status
      // behavior) rather than being failed on a value it never had.
      if (typeof res.status === 'number' && (res.status < 200 || res.status > 299)) {
        return { ok: false, reason: 'http-status', status: res.status };
      }
      bytes = await readBytes(res);
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
    return {
      ok: true,
      bytes,
      contentType: classified.contentType as string,
      status: typeof res.status === 'number' ? res.status : 200,
      finalUrl: typeof res.url === 'string' && res.url !== '' ? res.url : url,
      headers: headerSubset,
    };
  };
}
