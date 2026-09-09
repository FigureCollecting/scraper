/**
 * engineResolve — wires the byId CONFIRM runtime (assembleResolve) to the engine's registry + a
 * detail fetch. Mirrors createEngineLookup: the ProfileRegistry is built from the plugin-populated
 * `allStores()`, rulesets resolve via `getRulesetForUrl`, and `fetchDetail` is the pooled
 * ScrapingService's scrapePage (wired at the mount). Result: a ready `Resolve` the /resolve route calls.
 *
 * Extraction dispatches through the SAME machinery as the ingest queue (extractRecords, fed an
 * `ExtractContext` built here via `buildExtractContext` — the queue's buildIngestExtractContext,
 * one layer out): an extractAsync/extractMany ruleset's follow-up `ctx.scraping.fetchBody` rides
 * the store's OWN declared `searchFetch` transport (impersonate for amiami / http / browser)
 * through the capturing fetch, so the raw bytes land in the capture sink under the 'api' lane and
 * the D8 courtesy gap is enforced against the call's LAST fetch to that host — the primary detail
 * fetch or a SIBLING id's fetch, via the per-call shared map assembleResolve threads through
 * (sequential ids + one map = the queue's H1 per-host floor). `transports`/`sink` default to
 * the real engine fetchers (impit / plain HTTP / the raw sink); `now`/`sleep` default to real time —
 * all injectable so tests run on fakes with zero live fetches or waiting.
 */
import { buildProfileRegistry } from '../driver/profileRegistry.js';
import { assembleResolve, type Resolve } from '../driver/assembleResolve.js';
import { createRecordImageCapture } from './images/assembleImageCapture.js';
import { createCapturingFetch, type BrowserLaneFetcher, type CapturingFetchTransports } from './engineServices/capturingFetch.js';
import { buildExtractContext, DEFAULT_FETCH_BODY_GAP_MS } from './engineServices/extractContext.js';
import { createPluginLogger } from './engineServices/pluginLogger.js';
import { getRawCaptureSink } from './s3ObjectStore.js';
import { impitFetchBody } from './impitFetch.js';
import { httpFetchBody, type LookupRegistry } from './engineLookup.js';
import { getResidentialProxyUrl, resolveBrowserLaneOptions, type BrowserLaneEgressOptions } from './residentialEgress.js';
import type { CaptureSink } from './captureSink.js';
import type { SiteConfig } from '@figurecollecting/scraper-plugin-contract';

/** The extraction-context dependencies the CONFIRM leg needs (real defaults at the mount). */
export interface ResolveExtractDeps {
  /** Pooled browser surface: `ctx.scraping` passthrough + the capturing fetch's browser lane. */
  scraping: BrowserLaneFetcher;
  /** Non-browser transports (default: the real impit + plain-HTTP engine fetchers). */
  transports?: Partial<Pick<CapturingFetchTransports, 'http' | 'impersonate'>>;
  /** Raw-capture sink for the impit/http lanes (default: the engine's shared raw sink). */
  sink?: CaptureSink;
  /** Injectable clock + sleep for the courtesy gap (default: real time). */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** The engine's residential proxy (default: the process's RESIDENTIAL_PROXY_URL, resolved at boot). */
  residentialProxyUrl?: () => string | undefined;
}

/** Build the byId-confirm Resolve from the engine's registered stores + a detail fetch. */
export function createEngineResolve(
  registry: LookupRegistry,
  fetchDetail: (url: string, options?: BrowserLaneEgressOptions) => Promise<{ html: string; statusCode?: number }>,
  extract: ResolveExtractDeps,
): Resolve {
  const profiles = buildProfileRegistry(registry.allStores());
  const resolveProxy = extract.residentialProxyUrl ?? getResidentialProxyUrl;
  const capturingFetch = createCapturingFetch(
    {
      http: extract.transports?.http ?? httpFetchBody,
      impersonate: extract.transports?.impersonate ?? impitFetchBody,
      browser: extract.scraping,
    },
    extract.sink ?? getRawCaptureSink(),
    extract.residentialProxyUrl ? { residentialProxyUrl: extract.residentialProxyUrl } : {},
  );

  return assembleResolve({
    profiles,
    getRulesetForUrl: (url) => registry.getRulesetForUrl(url),
    // EGRESS GATE on the PRIMARY detail fetch. /resolve is the confirm leg's own door to the
    // network — a different one from the search dispatchers — so it enforces the same rule here:
    // a store declaring `egress: 'residential'` is fetched through the configured proxy, or
    // REFUSED — never sent from the node IP. The refusal throws SYNCHRONOUSLY (assembleResolve
    // calls this inside its per-id try, so it fails just this id like any other detail-fetch
    // failure) and deliberately so: it lands before the pacer's `.finally` can record a fetch that
    // never happened, so a batch of refused ids fails fast instead of courtesy-waiting between
    // each one. A store declaring neither egress nor readiness is called with the url alone,
    // exactly as before 0.7.0.
    fetchDetail: (url, searchFetch) => {
      const laneOptions = resolveBrowserLaneOptions(url, searchFetch, resolveProxy());
      return laneOptions ? fetchDetail(url, laneOptions) : fetchDetail(url);
    },
    // IMAGE CAPTURE: a confirm is a READ, but it fetched a real detail page, so the store's plates
    // are nameable here exactly as they are on the ingest leg — same switch, same memo, so a
    // re-confirmed item costs nothing after its first pass.
    captureImages: createRecordImageCapture('lookup', url => {
      try {
        return profiles.searchTransportFor(new URL(url).hostname);
      } catch {
        return undefined;
      }
    }),
    ...(extract.now ? { now: extract.now } : {}),
    ...(extract.sleep ? { sleep: extract.sleep } : {}),
    resolveContext: (ruleset, url, primaryFetchedAt, lastFetchedAt) => {
      let hostname: string | undefined;
      try {
        hostname = new URL(url).hostname;
      } catch {
        hostname = undefined;
      }
      // The detail URL's store caps (same forHost lookup as the ingest queue), falling back to the
      // ruleset's own site — the byId template's host may sit outside the store's indexed domains.
      const caps = (hostname ? profiles.forHost(hostname) : undefined) ?? profiles.forSite(ruleset.siteId);
      // Last-resort SiteConfig for a ruleset with no registered profile (stale/DI'd registry in
      // tests) — degrade to the documented default gap rather than an undefined one.
      const config: SiteConfig =
        caps ?? {
          siteId: ruleset.siteId,
          name: ruleset.siteId,
          domains: hostname ? [hostname] : [],
          rateLimit: {
            domain: hostname ?? '',
            baseDelayMs: DEFAULT_FETCH_BODY_GAP_MS,
            minDelayMs: DEFAULT_FETCH_BODY_GAP_MS,
            maxDelayMs: DEFAULT_FETCH_BODY_GAP_MS,
            backoffMultiplier: 1,
            recoveryDivisor: 1,
            successThreshold: 1,
          },
          requiresBrowser: false,
          allowedCookies: [],
        };

      return buildExtractContext({
        config,
        logger: createPluginLogger(ruleset.siteId),
        scraping: extract.scraping,
        capturingFetch,
        searchFetch: caps?.searchFetch,
        ...(extract.residentialProxyUrl ? { residentialProxyUrl: extract.residentialProxyUrl } : {}),
        primaryUrl: url,
        primaryFetchedAt,
        // The call-wide shared map (assembleResolve's pacer): follow-ups re-gap against SIBLING
        // ids' fetches to the same host, not just this id's own (H1 parity, cross-id).
        lastFetchedAt,
        baseDelayMs: caps?.rateLimit?.baseDelayMs,
        ...(extract.now ? { now: extract.now } : {}),
        ...(extract.sleep ? { sleep: extract.sleep } : {}),
      });
    },
  });
}
