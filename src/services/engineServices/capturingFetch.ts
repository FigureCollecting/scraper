/**
 * capturingFetch — the ingest path's transport-aware raw fetch. A store's declared
 * `StoreCapabilities.searchFetch` says how to reach it (http / impersonate / browser); this
 * dispatches a single item URL through that transport instead of always paying for a headless
 * browser. Mirrors fetchSearch's dispatcher (same transport switch, same per-store
 * headers/profile), but differs in two ways the ingest path needs:
 *   - it captures the fetched bytes to the raw-capture sink on EVERY lane. Only the browser lane
 *     captures on its own (navigateAndCapture writes the wire+dom lanes internally) — the
 *     impit/http lanes are captured here, under the 'api' lane, so raw.capture + the raw store
 *     stay populated no matter which transport served the fetch.
 *   - it returns `{ html }` (the shape ruleset.extract() consumes), not a bare string.
 *
 * An UNDECLARED transport (no `SearchFetch` at all) resolves to the browser lane — this preserves
 * existing behavior for HTML-rendered rulesets that predate per-store transport declarations, and
 * is a deliberate divergence from ProfileRegistry.searchTransportFor()'s default (which falls back
 * to `requiresBrowser`): the ingest path wants "declared transport, else browser", not "declared
 * transport, else infer from requiresBrowser".
 */
import type { SearchFetch, ScrapePageOptions, ScrapePageResult } from '@figurecollecting/scraper-plugin-contract';
import type { CaptureSink } from '../captureSink.js';
import { buildRawCapture } from '../captureSink.js';
import { sanitizeForLog } from '../../utils/security.js';
import { resolvePrime } from '../sessionPrime.js';
import { isCloudflareChallenge } from './challengeDetect.js';

export interface CapturingFetchResult {
  html: string;
}

/**
 * A non-browser lane (impersonate / http) received a Cloudflare challenge interstitial instead of
 * the real page — a TRANSPORT failure, not an empty success. Thrown AFTER the bytes are handed to
 * the capture sink (provenance is still recorded), so the queue's existing failure handling
 * (attempts / backoff / FAILED) owns it rather than a ruleset silently lifting zero rows. The
 * message names Cloudflare so the queue's classifyError treats it as a rate-limit/block class.
 */
export class ChallengePageError extends Error {
  readonly url: string;
  readonly transport: string;
  constructor(url: string, transport: string) {
    super(`Cloudflare challenge page received for ${sanitizeForLog(url)} via ${transport} transport`);
    this.name = 'ChallengePageError';
    this.url = url;
    this.transport = transport;
  }
}

/** The browser lane's raw-fetch surface — it already captures internally via navigateAndCapture. */
export interface BrowserLaneFetcher {
  scrapePage(url: string, options?: ScrapePageOptions): Promise<ScrapePageResult>;
  scrapePageStealth(url: string, options?: ScrapePageOptions): Promise<ScrapePageResult>;
}

export interface CapturingFetchTransports {
  /** Plain HTTP GET (Tier-1 cookieless JSON/HTML). */
  http: (url: string) => Promise<string>;
  /** impit TLS-impersonating GET (Cloudflare-fronted JSON APIs). `prime` primes a session-gated host. */
  impersonate: (url: string, opts: { browser?: string; headers?: Record<string, string>; userAgent?: string; prime?: { url: string } }) => Promise<string>;
  /** Pooled browser navigation — the fallback for `browser`/undeclared transports. */
  browser: BrowserLaneFetcher;
}

export type CapturingFetch = (
  url: string,
  searchFetch: SearchFetch | undefined,
  options?: { cookies?: Record<string, string> },
) => Promise<CapturingFetchResult>;

/** Hand a non-browser-lane body to the sink under the 'api' lane. Capturing must never break a fetch. */
async function captureApiBody(sink: CaptureSink, url: string, body: string): Promise<void> {
  try {
    await sink.capture(buildRawCapture({
      url,
      lane: 'api',
      bytes: Buffer.from(body, 'utf8'),
      fetchedAt: new Date().toISOString(),
    }));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[CAPTURE] sink failed for ${sanitizeForLog(url)}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Build the dispatcher. `sink` backs the impit/http lanes' capture (the browser lane captures
 * itself, via whatever sink `transports.browser` was built with).
 */
export function createCapturingFetch(transports: CapturingFetchTransports, sink: CaptureSink): CapturingFetch {
  return async function capturingFetch(url, searchFetch, options = {}) {
    switch (searchFetch?.transport) {
      case 'impersonate': {
        // Session-gated stores (403-cold) declare `sessionPrime`; the impit transport primes the
        // host once per session before this fetch. Undeclared → no `prime` key (byte-identical). The
        // prime GET happens INSIDE the transport and its body is discarded there, so only THIS
        // target body is captured below — a prime never produces a raw.capture (capture-neutral).
        const prime = resolvePrime(searchFetch, url);
        const html = await transports.impersonate(url, {
          browser: searchFetch.browser,
          headers: searchFetch.headers,
          userAgent: searchFetch.userAgent,
          ...(prime ? { prime } : {}),
        });
        // Capture FIRST (provenance is recorded even for a challenge body), THEN reject a challenge
        // interstitial as a transport failure — a ruleset would silently lift zero rows from it.
        await captureApiBody(sink, url, html);
        if (isCloudflareChallenge(html)) throw new ChallengePageError(url, 'impersonate');
        return { html };
      }
      case 'http': {
        const html = await transports.http(url);
        await captureApiBody(sink, url, html);
        if (isCloudflareChallenge(html)) throw new ChallengePageError(url, 'http');
        return { html };
      }
      case 'browser':
      default: {
        const page = options.cookies
          ? await transports.browser.scrapePageStealth(url, { cookies: options.cookies })
          : await transports.browser.scrapePage(url);
        return { html: page.html };
      }
    }
  };
}
