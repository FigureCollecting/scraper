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
 * the D8 courtesy gap is enforced against the primary detail fetch. `transports`/`sink` default to
 * the real engine fetchers (impit / plain HTTP / the raw sink); `now`/`sleep` default to real time —
 * all injectable so tests run on fakes with zero live fetches or waiting.
 */
import { buildProfileRegistry } from '../driver/profileRegistry.js';
import { assembleResolve, type Resolve } from '../driver/assembleResolve.js';
import { createCapturingFetch, type BrowserLaneFetcher, type CapturingFetchTransports } from './engineServices/capturingFetch.js';
import { buildExtractContext, DEFAULT_FETCH_BODY_GAP_MS } from './engineServices/extractContext.js';
import { createPluginLogger } from './engineServices/pluginLogger.js';
import { getRawCaptureSink } from './s3ObjectStore.js';
import { impitFetchBody } from './impitFetch.js';
import { httpFetchBody, type LookupRegistry } from './engineLookup.js';
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
}

/** Build the byId-confirm Resolve from the engine's registered stores + a detail fetch. */
export function createEngineResolve(
  registry: LookupRegistry,
  fetchDetail: (url: string) => Promise<{ html: string; statusCode?: number }>,
  extract: ResolveExtractDeps,
): Resolve {
  const profiles = buildProfileRegistry(registry.allStores());
  const capturingFetch = createCapturingFetch(
    {
      http: extract.transports?.http ?? httpFetchBody,
      impersonate: extract.transports?.impersonate ?? impitFetchBody,
      browser: extract.scraping,
    },
    extract.sink ?? getRawCaptureSink(),
  );

  return assembleResolve({
    profiles,
    getRulesetForUrl: (url) => registry.getRulesetForUrl(url),
    fetchDetail,
    ...(extract.now ? { now: extract.now } : {}),
    resolveContext: (ruleset, url, primaryFetchedAt) => {
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
        primaryUrl: url,
        primaryFetchedAt,
        baseDelayMs: caps?.rateLimit?.baseDelayMs,
        ...(extract.now ? { now: extract.now } : {}),
        ...(extract.sleep ? { sleep: extract.sleep } : {}),
      });
    },
  });
}
