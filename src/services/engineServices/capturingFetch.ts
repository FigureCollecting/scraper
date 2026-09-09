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
 * On the BROWSER lane it resolves its per-request wiring through the SAME `resolveBrowserLaneOptions`
 * the other doors use (the search dispatcher, the /resolve detail fetch, the ExtractContext
 * passthroughs), so one store is wired identically whichever path reaches it: the challenge GATE
 * (`access: 'cloudflare'`), the session PRIME, residential EGRESS and `waitFor` READINESS together.
 * Deriving those options here from egress + waitFor alone is exactly what left the ingest path
 * fetching Cloudflare-gated stores on a per-request context — which never clears the challenge —
 * while every other door had already moved to the per-egress gated browser (measured in production
 * 2026-09-07: anitoysgk.com ingest logged a challenge body with `gatedBrowsers` still empty).
 *
 * An UNDECLARED transport (no `SearchFetch` at all) resolves to the browser lane — this preserves
 * existing behavior for HTML-rendered rulesets that predate per-store transport declarations, and
 * is a deliberate divergence from ProfileRegistry.searchTransportFor()'s default (which falls back
 * to `requiresBrowser`): the ingest path wants "declared transport, else browser", not "declared
 * transport, else infer from requiresBrowser".
 */
import type { SearchFetch, ScrapePageResult } from '@figurecollecting/scraper-plugin-contract';
import type { EngineScrapePageOptions } from './scrapingService.js';
import {
  getResidentialProxyUrl,
  refuseHttpLaneResidentialEgress,
  requireResidentialProxy,
  resolveBrowserLaneOptions,
} from '../residentialEgress.js';
import type { CaptureSink } from '../captureSink.js';
import { buildRawCapture } from '../captureSink.js';
import { sanitizeForLog } from '../../utils/security.js';
import { resolvePrime } from '../sessionPrime.js';
import { isCloudflareChallenge } from './challengeDetect.js';
import { getCfCookieStore, type CfCookieSource } from '../cookieJar.js';

/**
 * What a non-browser lane answers with. A transport may return the BARE BODY (every fetcher written
 * before the lane surfaced anything about the response, and every fake shaped like one) or this
 * DETAIL — the dispatcher normalizes both. That is what keeps the string-returning `httpFetchBody` /
 * `impitFetchBody` the search fan-out and /resolve share untouched while the ingest path rides the
 * status-aware variants of the very same fetchers.
 */
export interface FetchBodyDetail {
  body: string;
  /** Upstream HTTP status, when the lane observed one. */
  status?: number;
  /** The URL the body actually came from, after redirects. */
  finalUrl?: string;
}

/** Either transport answer: the bare body, or the body plus what the lane observed about it. */
export type FetchBodyOutcome = string | FetchBodyDetail;

/** Normalize either answer to the detail shape. A bare string observed no metadata — and says so. */
export function detailOf(outcome: FetchBodyOutcome): FetchBodyDetail {
  return typeof outcome === 'string' ? { body: outcome } : outcome;
}

/**
 * The metadata fields of a {@link CapturingFetchResult}, each present ONLY when the lane really
 * observed it: a status a real response can carry (100-599, never a defensive read's 0 / NaN /
 * sentinel) and a non-empty final URL. Absent beats fabricated — the record gate reads absence as
 * "nothing known", never as 200, and the ledger echoes what is here verbatim.
 */
function metaFields(detail: { status?: number; finalUrl?: string }): Pick<CapturingFetchResult, 'status' | 'finalUrl'> {
  const status =
    typeof detail.status === 'number' && Number.isInteger(detail.status) && detail.status >= 100 && detail.status <= 599
      ? detail.status
      : undefined;
  const finalUrl = typeof detail.finalUrl === 'string' && detail.finalUrl !== '' ? detail.finalUrl : undefined;
  return {
    ...(status !== undefined ? { status } : {}),
    ...(finalUrl !== undefined ? { finalUrl } : {}),
  };
}

export interface CapturingFetchResult {
  html: string;
  /**
   * Set true ONLY when the lane received a Cloudflare challenge/block interstitial instead of the
   * real page. Absent (never false) for a normal body. The transport does NOT throw on a challenge —
   * a ruleset's own follow-up call (ctx.scraping.fetchBody) can still recover the real record (the
   * amiami case), so the queue's honesty gate is the authority: a challenge-flagged page that ALSO
   * persisted nothing becomes a typed ChallengePageError, while one the ruleset recovered rows from
   * is a logged success. The browser lane is flagged too (since the stored-cookie jar): a browser
   * interstitial used to degrade to a retried empty_record; now it takes the same one-shot +
   * host-cooldown exit as the other lanes.
   */
  challenge?: boolean;
  /**
   * The lane that served this fetch — 'impersonate' | 'http' | 'browser' — carried so the queue can
   * name the transport in a ChallengePageError. Present alongside `challenge`; absent for a normal
   * body.
   */
  transport?: string;
  /**
   * The upstream HTTP status this fetch ended on, when the lane observed one: the plain-HTTP and
   * impit lanes read it off the response, the browser lane off ScrapePageResult.statusCode. ABSENT
   * when the transport surfaced only bytes — the record lane was status-BLIND before this field
   * existed, and an absent status keeps that honest instead of implying a 200 nobody saw.
   */
  status?: number;
  /**
   * The URL the body actually came from, after redirects — the input to the redirect-to-home signal
   * (an item URL that lands on the store's front page carries a 200 and no record).
   */
  finalUrl?: string;
}

/**
 * A non-browser lane (impersonate / http) served a Cloudflare challenge/block interstitial AND the
 * ruleset then persisted nothing from it — a TRANSPORT failure, not an empty success. NO LONGER
 * thrown by the transport itself (capturingFetch merely FLAGS `challenge` on its result and captures
 * the bytes for provenance): it is thrown by scrapeQueue's ingest path (the honesty gate, or the extraction-throw door), which alone can see
 * whether the ruleset's own follow-up transport recovered the record (the amiami case, where the
 * product page is a challenge but a same-pod item-API call still lifts the full record). The message
 * names Cloudflare so the queue's classifyError treats it as a rate-limit/block class, and carries
 * any server warnings the gate saw.
 */
export class ChallengePageError extends Error {
  readonly url: string;
  readonly transport: string;
  readonly warnings: string[];
  constructor(url: string, transport: string, warnings: string[] = []) {
    const tail = warnings.length
      ? ` server warnings: ${warnings.map(sanitizeForLog).join(' | ')}`
      : '';
    super(`Cloudflare challenge page received for ${sanitizeForLog(url)} via ${transport} transport.${tail}`);
    this.name = 'ChallengePageError';
    this.url = url;
    this.transport = transport;
    this.warnings = warnings;
  }
}

/** The browser lane's raw-fetch surface — it already captures internally via navigateAndCapture. */
export interface BrowserLaneFetcher {
  scrapePage(url: string, options?: EngineScrapePageOptions): Promise<ScrapePageResult>;
  scrapePageStealth(url: string, options?: EngineScrapePageOptions): Promise<ScrapePageResult>;
}

export interface CapturingFetchTransports {
  /** Plain HTTP GET (Tier-1 cookieless JSON/HTML). May answer with the status-aware detail. */
  http: (url: string) => Promise<FetchBodyOutcome>;
  /** impit TLS-impersonating GET (Cloudflare-fronted JSON APIs). `prime` primes a session-gated host; `proxyUrl` is residential egress. */
  impersonate: (url: string, opts: { browser?: string; headers?: Record<string, string>; userAgent?: string; prime?: { url: string }; proxyUrl?: string }) => Promise<FetchBodyOutcome>;
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

/** Optional wiring for {@link createCapturingFetch}. */
export interface CapturingFetchDeps {
  /** Stored-cookie source (defaults to the CfCookieStore singleton, resolved per call). */
  cookieStore?: CfCookieSource;
  /** The engine's residential proxy (default: the process's RESIDENTIAL_PROXY_URL, resolved at boot). */
  residentialProxyUrl?: () => string | undefined;
}

/**
 * Build the dispatcher. `sink` backs the impit/http lanes' capture (the browser lane captures
 * itself, via whatever sink `transports.browser` was built with).
 */
export function createCapturingFetch(
  transports: CapturingFetchTransports,
  sink: CaptureSink,
  deps: CapturingFetchDeps = {},
): CapturingFetch {
  const resolveProxy = deps.residentialProxyUrl ?? getResidentialProxyUrl;
  return async function capturingFetch(url, searchFetch, options = {}) {
    // EGRESS (once per call, before any fetch or capture): a store declaring `residential` rides the
    // configured proxy; with none configured this THROWS a typed config failure rather than letting
    // the request leave from the node IP. Undeclared/direct ⇒ undefined and the pre-0.7.0 path.
    const proxyUrl = requireResidentialProxy(url, searchFetch?.egress, resolveProxy());
    switch (searchFetch?.transport) {
      case 'impersonate': {
        // Session-gated stores (403-cold) declare `sessionPrime`; the impit transport primes the
        // host once per session before this fetch. Undeclared → no `prime` key (byte-identical). The
        // prime GET happens INSIDE the transport and its body is discarded there, so only THIS
        // target body is captured below — a prime never produces a raw.capture (capture-neutral).
        const prime = resolvePrime(searchFetch, url);
        const detail = detailOf(await transports.impersonate(url, {
          browser: searchFetch.browser,
          headers: searchFetch.headers,
          userAgent: searchFetch.userAgent,
          ...(prime ? { prime } : {}),
          ...(proxyUrl ? { proxyUrl } : {}),
        }));
        const html = detail.body;
        const meta = metaFields(detail);
        // Capture FIRST (provenance is recorded even for a challenge body), THEN FLAG a challenge
        // interstitial rather than throwing — a ruleset's own follow-up transport may still recover
        // the record. The queue's honesty gate turns a flagged page that persisted nothing into a
        // ChallengePageError; one the ruleset recovered rows from stays a success.
        await captureApiBody(sink, url, html);
        if (isCloudflareChallenge(html)) {
          // eslint-disable-next-line no-console
          console.warn(`[FETCH] Cloudflare challenge/block page received for ${sanitizeForLog(url)} via impersonate transport`);
          return { html, challenge: true, transport: 'impersonate', ...meta };
        }
        return { html, ...meta };
      }
      case 'http': {
        // The plain-HTTP lane cannot proxy (see refuseHttpLaneResidentialEgress) — a residential
        // store on it is refused, never quietly fetched from the node IP.
        if (proxyUrl) refuseHttpLaneResidentialEgress(url, proxyUrl);
        const detail = detailOf(await transports.http(url));
        const html = detail.body;
        const meta = metaFields(detail);
        await captureApiBody(sink, url, html);
        if (isCloudflareChallenge(html)) {
          // eslint-disable-next-line no-console
          console.warn(`[FETCH] Cloudflare challenge/block page received for ${sanitizeForLog(url)} via http transport`);
          return { html, challenge: true, transport: 'http', ...meta };
        }
        return { html, ...meta };
      }
      case 'browser':
      default: {
        // STEALTH SELECTION: item (request) cookies OR stored cookies for this host ⇒ the stealth
        // browser (CF stores ride stealth). Only the CHOICE is made here — the lane itself
        // (navigateAndCapture) merges the store's cookies under the item's, so a store-only hit
        // forwards nothing; item cookies keep their exact pre-existing call shape.
        const store = deps.cookieStore ?? getCfCookieStore();
        const stealth = options.cookies !== undefined || store.cookiesFor(url) !== undefined;
        // LANE WIRING rides ALONGSIDE that choice, never changing it — and it is resolved by the
        // SAME function every other browser-lane caller uses (the search dispatcher, /resolve, the
        // ExtractContext passthroughs), so a store is wired identically whichever door reaches it:
        // `challengeGated` puts the fetch on the per-egress gated browser's default context (without
        // it a Cloudflare store takes the per-request context, which never clears the challenge —
        // the ingest defect measured in production 2026-09-07), `primeUrl` gives that cold profile
        // its session-priming visit, `proxyServer` binds the request to the residential exit and
        // `waitFor` makes a client-rendered store render before capture. A store declaring none of
        // them resolves to `undefined` and is called with the URL alone (byte-identical).
        //
        // The ALREADY-RESOLVED `proxyUrl` is handed back in rather than `resolveProxy()`: for a
        // residential store it is that same value (the refusal above has already fired if there was
        // none), and for every other store both are ignored — so the typed refusal is raised exactly
        // once per fetch, at the top of this function, before any transport is touched.
        const laneOptions = resolveBrowserLaneOptions(url, searchFetch, proxyUrl);
        const page = stealth
          ? await transports.browser.scrapePageStealth(url, { ...(options.cookies ? { cookies: options.cookies } : {}), ...laneOptions })
          : laneOptions
            ? await transports.browser.scrapePage(url, laneOptions)
            : await transports.browser.scrapePage(url);
        // FLAG a browser-lane interstitial like the other lanes (capture already happened inside
        // navigateAndCapture): the queue's honesty gate / extraction-throw door then give it the
        // same one-shot ChallengePageError + host cooldown instead of a retried empty_record.
        // The browser lane has carried both fields all along (ScrapePageResult.statusCode / .url);
        // they were simply dropped on the floor here.
        const meta = metaFields({ status: page.statusCode, finalUrl: page.url });
        if (isCloudflareChallenge(page.html)) {
          // eslint-disable-next-line no-console
          console.warn(`[FETCH] Cloudflare challenge/block page received for ${sanitizeForLog(url)} via browser transport`);
          return { html: page.html, challenge: true, transport: 'browser', ...meta };
        }
        return { html: page.html, ...meta };
      }
    }
  };
}
