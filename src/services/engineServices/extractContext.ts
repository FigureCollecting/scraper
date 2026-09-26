/**
 * extractContext — builds the `ExtractContext` handed to `extractRecords` (and, through it, to a
 * ruleset's `extract`/`extractMany`). The one member this increment actually implements is
 * `scraping.fetchBody` (spec.md orzgk Slice B D1/D8/D9, plugin-contract 0.4.0): a same-store
 * follow-up GET for `extractMany()` implementations that need a second call off the same host
 * (e.g. a variation-batch endpoint) without owning their own HTTP stack.
 *
 * `fetchBody` is implemented over the SAME transport-dispatching `capturingFetch` the primary
 * ingest fetch already uses (`engineServices/capturingFetch.ts`), given the store's OWN declared
 * `searchFetch` transport — so the follow-up's raw bytes land in the capture sink on the SAME lane
 * as the primary fetch: 'api' for a store that declares an impersonate/http transport, but a
 * full browser navigation captured as wire/dom for a store that declares none (measured on hpoi,
 * 2026-09-22). The context's own cookies (the queue item's, engine-supplied) pass through to the
 * lane as before; a ruleset cannot add any (`opts.cookies` is refused, contract 0.15.0). A POST
 * (0.14.0) and request headers (0.15.0, `FETCH_BODY_ALLOWED_HEADERS` only) are validated here, before
 * the courtesy wait, and ride only the http/impersonate lanes.
 *
 * COURTESY GAP (D8): before dispatching, `fetchBody` waits until `primaryFetchedAt +
 * baseDelayMs` has elapsed — but ONLY when the follow-up targets the SAME host as the primary
 * fetch (a follow-up to a different host owes that host no courtesy against an unrelated fetch).
 * `now`/`sleep` are injectable so tests run on a fake clock with zero real waiting.
 *
 * `batchFetch`/`officialApi` are left undefined (optional per contract 0.4.0) — not built this
 * increment. `scrapePage`/`scrapePageStealth` pass through to the real base scraping service the
 * caller supplies, GATED on the store's declared egress (contract 0.7.0): a ruleset navigating a
 * residential-gated store's follow-up page rides the configured proxy, or is refused. Those
 * passthroughs are a door to the network exactly like `fetchBody`, and must not be the one that
 * leaks a residential store onto the node IP.
 *
 * `browserFetch`/`withBrowser`/`withPage` are NOT reachable via `fetchBody` (which is deliberately
 * a non-browser transport-only seam) and are stubbed to throw a clear error if a ruleset ever calls
 * them through `ExtractContext.scraping` — a loud failure, not a silent no-op, if a future ruleset
 * assumes more surface than this context provides.
 */
import {
  FETCH_BODY_ALLOWED_HEADERS,
  type ExtractContext,
  type FetchBodyOptions,
  type ScrapePageResult,
  type SearchFetch,
  type SiteConfig,
  type PluginLogger,
} from '@figurecollecting/scraper-plugin-contract';
import { DEFAULT_POST_CONTENT_TYPE, type CapturingFetch, type FetchRequest } from './capturingFetch.js';
import { sanitizeForLog } from '../../utils/security.js';
import type { EngineScrapePageOptions } from './scrapingService.js';
import {
  getResidentialProxyUrl,
  isDeclaringStoreUrl,
  resolveBrowserLaneOptions,
  withoutDeclaredEgress,
} from '../residentialEgress.js';

/**
 * Default courtesy gap (ms) when a store profile declares no `rateLimit.baseDelayMs` — should be
 * rare (every registered store's `SiteConfig.rateLimit` is required), but `buildExtractContext`
 * accepts callers that could not resolve one. 2000ms is a conservative floor (below orzgk's own
 * declared 3000ms, above the engine's global-lane MIN_DELAY of 274ms) — a real store should always
 * declare its own via `rateLimit.baseDelayMs` rather than relying on this default.
 */
export const DEFAULT_FETCH_BODY_GAP_MS = 2000;

/**
 * Base page-fetch methods `fetchBody` is layered over; the only ones this context truly needs.
 * Widened to the ENGINE's page options so the passthroughs can hand the lane the egress/readiness
 * wiring resolved from the store's `searchFetch` (a contract `ScrapingService` still satisfies it).
 */
interface BaseScraping {
  scrapePage(url: string, options?: EngineScrapePageOptions): Promise<ScrapePageResult>;
  scrapePageStealth(url: string, options?: EngineScrapePageOptions): Promise<ScrapePageResult>;
}

export interface BuildExtractContextOptions {
  /** `ExtractContext.config` — the resolved store's SiteConfig (or StoreCapabilities, a superset). */
  config: SiteConfig;
  logger: PluginLogger;
  /** Base page-fetch surface passed through onto `ExtractContext.scraping`. */
  scraping: BaseScraping;
  /** The engine's transport-dispatching capturing fetch (impersonate/http/browser + sink capture). */
  capturingFetch: CapturingFetch;
  /** The store's OWN declared search-fetch transport (undeclared → capturingFetch's browser default). */
  searchFetch: SearchFetch | undefined;
  /**
   * The queue item's own cookies (engine-supplied), passed to the lane; a ruleset cannot add or
   * override any (`opts.cookies` is refused, contract 0.15.0).
   */
  cookies?: Record<string, string>;
  /** The URL the PRIMARY fetch (that produced `html`) was fetched from — for the same-host gate. */
  primaryUrl: string;
  /** epoch ms when the primary fetch completed (the courtesy gap's anchor). */
  primaryFetchedAt: number;
  /** Courtesy gap in ms; defaults to `DEFAULT_FETCH_BODY_GAP_MS` when the store declares none. */
  baseDelayMs?: number;
  /**
   * OPTIONAL shared per-host last-fetch map (epoch ms, keyed by `safeHostname`). When several
   * contexts serve ONE caller-level operation (assembleResolve's sequential multi-id confirm),
   * passing one map threads the courtesy gap ACROSS them — a follow-up gaps against a SIBLING
   * context's fetch to the same host, not just this context's own (H1 parity, cross-id).
   * Callers must not run sharing contexts concurrently (the gap check is check-then-sleep).
   * Default: a private per-context map (single-extraction behavior, unchanged).
   */
  lastFetchedAt?: Map<string, number>;
  /** Injectable clock (default `Date.now`). */
  now?: () => number;
  /** Injectable sleep (default a real `setTimeout` promise). */
  sleep?: (ms: number) => Promise<void>;
  /** The engine's residential proxy (default: the process's RESIDENTIAL_PROXY_URL, resolved at boot). */
  residentialProxyUrl?: () => string | undefined;
}

/** Lowercased, `www.`-stripped hostname; `undefined` on an unparseable URL (never throws). */
export function safeHostname(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function notSupported(member: string): () => never {
  return () => {
    throw new Error(
      `[EXTRACT CONTEXT] ScrapingService.${member} is not available via ExtractContext — this context provides only ` +
        `scrapePage/scrapePageStealth (passthrough) and fetchBody (the extractMany same-store follow-up seam)`
    );
  };
}

/** A ruleset's fetchBody options break the contract (a GET with a body, an unknown method, …). */
export class FetchBodyRequestError extends Error {
  constructor(url: string, reason: string) {
    super(`[EXTRACT CONTEXT] fetchBody(${sanitizeForLog(url)}) refused: ${reason}`);
    this.name = 'FetchBodyRequestError';
  }
}

const ALLOWED_HEADERS: ReadonlySet<string> = new Set(FETCH_BODY_ALLOWED_HEADERS);

/**
 * A ruleset's `headers`, checked against the contract's allowlist and returned with lowercase names
 * and RFC 9110 surrounding whitespace dropped; `undefined` when there are none. Every refusal lands
 * before any request: the engine owns identity (UA, cookies, TLS profile) and framing headers.
 */
function toRequestHeaders(url: string, raw: unknown): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  // A plain object only: a Map or a WHATWG Headers has no own entries, so it would be dropped silently.
  const proto: unknown = raw !== null && typeof raw === 'object' ? Object.getPrototypeOf(raw) : undefined;
  if (proto !== Object.prototype && proto !== null) {
    throw new FetchBodyRequestError(url, 'headers must be a plain object of header name to string value');
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (/[\r\n]/.test(name)) throw new FetchBodyRequestError(url, 'a header name contains CR or LF');
    const lower = name.toLowerCase();
    if (!ALLOWED_HEADERS.has(lower)) {
      throw new FetchBodyRequestError(
        url,
        `header '${sanitizeForLog(name)}' is not one a ruleset may set (allowed: ${FETCH_BODY_ALLOWED_HEADERS.join(', ')}; ` +
          'the engine owns identity and framing headers)',
      );
    }
    if (typeof value !== 'string') throw new FetchBodyRequestError(url, `header '${lower}' value must be a string`);
    if (/[\r\n]/.test(value)) throw new FetchBodyRequestError(url, `header '${lower}' value contains CR or LF`);
    if (!/^[\t\x20-\x7e]*$/.test(value)) {
      throw new FetchBodyRequestError(url, `header '${lower}' value must be printable ASCII`);
    }
    if (lower in headers) throw new FetchBodyRequestError(url, `header '${lower}' is given twice`);
    // Empty after the OWS trim is refused: undici sends `name: ` while impit drops it, so the lanes would disagree.
    const trimmed = value.replace(/^[\t ]+|[\t ]+$/g, '');
    if (trimmed === '') throw new FetchBodyRequestError(url, `header '${lower}' value is empty`);
    headers[lower] = trimmed;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

/**
 * The contract's options as the lanes' request: `undefined` for a bare GET (the pre-0.14.0 call), a
 * GET carrying the ruleset's headers, or the POST. Checked at runtime too, since a JS ruleset is not
 * held to the contract's types.
 */
function toFetchRequest(url: string, opts: FetchBodyOptions | undefined): FetchRequest | undefined {
  if (opts?.cookies !== undefined) {
    throw new FetchBodyRequestError(url, 'cookies are not a fetchBody option: the engine owns the cookie jar (contract 0.15.0)');
  }
  const method: unknown = opts?.method;
  const body: unknown = opts?.body;
  const contentType: unknown = opts?.contentType;
  const headers = toRequestHeaders(url, opts?.headers);
  if (method === undefined || method === 'GET') {
    if (body !== undefined || contentType !== undefined) {
      throw new FetchBodyRequestError(url, 'a GET carries no body or contentType (send method POST)');
    }
    return headers ? { method: 'GET', headers } : undefined;
  }
  if (method !== 'POST') {
    throw new FetchBodyRequestError(url, `method '${sanitizeForLog(String(method))}' is not supported (GET or POST)`);
  }
  if (body !== undefined && typeof body !== 'string') throw new FetchBodyRequestError(url, 'body must be a string');
  if (contentType !== undefined && typeof contentType !== 'string') {
    throw new FetchBodyRequestError(url, 'contentType must be a string');
  }
  return {
    method: 'POST',
    body: body ?? '',
    contentType: contentType ?? DEFAULT_POST_CONTENT_TYPE,
    ...(headers ? { headers } : {}),
  };
}

/** Build the `ExtractContext` for one item's extraction (see module doc for `fetchBody`'s contract). */
export function buildExtractContext(options: BuildExtractContextOptions): ExtractContext {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const gapMs = options.baseDelayMs ?? DEFAULT_FETCH_BODY_GAP_MS;
  const primaryHost = safeHostname(options.primaryUrl);

  const resolveProxy = options.residentialProxyUrl ?? getResidentialProxyUrl;

  /**
   * The store's browser-lane wiring merged UNDER the ruleset's own page options: residential
   * `proxyServer` + declared `waitFor`, resolved per navigation (the proxy is process config, but
   * resolving it here keeps a hot-reloaded value honest). A residential store with no configured
   * proxy THROWS the typed refusal — the ruleset's navigation fails loudly instead of leaving from
   * the node IP. Nothing declared ⇒ the caller's own options pass through untouched.
   */
  /**
   * HOST SCOPE: the declaration belongs to the STORE, and the ruleset chooses the URL. A follow-up
   * to a host that is not the declaring store's (an image CDN, a third-party API) is dispatched
   * DIRECTLY — it neither rides the residential exit (which would hand the home IP to a host that
   * never declared it) nor is refused for lacking one (it never needed one).
   */
  const onDeclaringStore = (url: string): boolean => isDeclaringStoreUrl(url, options.primaryUrl);

  const withLaneOptions = (
    url: string,
    pageOptions: EngineScrapePageOptions | undefined,
  ): EngineScrapePageOptions | undefined => {
    if (!onDeclaringStore(url)) return pageOptions;
    const lane = resolveBrowserLaneOptions(url, options.searchFetch, resolveProxy());
    return lane ? { ...pageOptions, ...lane } : pageOptions;
  };

  // Last-fetch-per-host (re-gap, spec.md D8 follow-on): a ruleset issuing MULTIPLE fetchBody
  // calls to the SAME host must be courtesy-gapped against its OWN previous call, not just the
  // primary page fetch — otherwise only the FIRST follow-up ever waits, and every call after it
  // is gapped against a primaryFetchedAt that has long since elapsed. Seeded with the primary
  // fetch's own host/time so the first same-host follow-up's behaviour is unchanged.
  const lastFetchedAt = options.lastFetchedAt ?? new Map<string, number>();
  if (primaryHost !== undefined) {
    // Monotonic seed: never regress a SHARED map's entry (a sibling context may have touched the
    // primary host even more recently than this context's own primary fetch).
    const seeded = lastFetchedAt.get(primaryHost);
    if (seeded === undefined || seeded < options.primaryFetchedAt) {
      lastFetchedAt.set(primaryHost, options.primaryFetchedAt);
    }
  }

  return {
    config: options.config,
    logger: options.logger,
    scraping: {
      // `async` so an egress REFUSAL rejects the returned promise rather than throwing
      // synchronously out of a Promise-returning API (a ruleset's `.catch()` must be able to see it).
      scrapePage: async (url, pageOptions) => options.scraping.scrapePage(url, withLaneOptions(url, pageOptions)),
      scrapePageStealth: async (url, pageOptions) => options.scraping.scrapePageStealth(url, withLaneOptions(url, pageOptions)),
      browserFetch: notSupported('browserFetch'),
      withBrowser: notSupported('withBrowser'),
      withPage: notSupported('withPage'),

      async fetchBody(url, fetchOpts) {
        // Refused before the courtesy wait: a malformed request never costs the host a slot.
        const request = toFetchRequest(url, fetchOpts);
        const targetHost = safeHostname(url);
        const last = targetHost !== undefined ? lastFetchedAt.get(targetHost) : undefined;
        if (last !== undefined) {
          const waitUntil = last + gapMs;
          const remaining = waitUntil - now();
          if (remaining > 0) {
            await sleep(remaining);
          }
        }
        const cookies = options.cookies;
        // Same host scope as the page passthroughs: an off-store follow-up keeps the store's
        // transport/headers but never its residential exit.
        const searchFetch = onDeclaringStore(url) ? options.searchFetch : withoutDeclaredEgress(options.searchFetch);
        const result = await options.capturingFetch(url, searchFetch, {
          ...(cookies ? { cookies } : {}),
          ...(request ? { request } : {}),
        });
        if (targetHost !== undefined) {
          lastFetchedAt.set(targetHost, now());
        }
        // The plugin contract names the HTTP status `statusCode`; the capturing fetch names it
        // `status`. Rulesets written to the contract (hpoi's non-2xx gate, amiami's status notes)
        // read `statusCode` and silently saw undefined. Carry both names.
        return result.status === undefined ? result : { ...result, statusCode: result.status };
      },
    },
  };
}
