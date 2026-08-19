/**
 * extractContext — builds the `ExtractContext` handed to `extractRecords` (and, through it, to a
 * ruleset's `extract`/`extractMany`). The one member this increment actually implements is
 * `scraping.fetchBody` (spec.md orzgk Slice B D1/D8/D9, plugin-contract 0.4.0): a same-store
 * follow-up GET for `extractMany()` implementations that need a second call off the same host
 * (e.g. a variation-batch endpoint) without owning their own HTTP stack.
 *
 * `fetchBody` is implemented over the SAME transport-dispatching `capturingFetch` the primary
 * ingest fetch already uses (`engineServices/capturingFetch.ts`), given the store's OWN declared
 * `searchFetch` transport — so the follow-up's raw bytes still land in the capture sink under the
 * 'api' lane, same as the primary fetch. Cookies pass through (opts.cookies overrides the
 * context's own).
 *
 * COURTESY GAP (D8): before dispatching, `fetchBody` waits until `primaryFetchedAt +
 * baseDelayMs` has elapsed — but ONLY when the follow-up targets the SAME host as the primary
 * fetch (a follow-up to a different host owes that host no courtesy against an unrelated fetch).
 * `now`/`sleep` are injectable so tests run on a fake clock with zero real waiting.
 *
 * `batchFetch`/`officialApi` are left undefined (optional per contract 0.4.0) — not built this
 * increment. `scrapePage`/`scrapePageStealth` pass through to the real base scraping service the
 * caller supplies; `browserFetch`/`withBrowser`/`withPage` are NOT reachable via `fetchBody`
 * (which is deliberately a non-browser transport-only seam) and are stubbed to throw a clear
 * error if a ruleset ever calls them through `ExtractContext.scraping` — a loud failure, not a
 * silent no-op, if a future ruleset assumes more surface than this context provides.
 */
import type {
  ExtractContext,
  ScrapingService,
  SearchFetch,
  SiteConfig,
  PluginLogger,
} from '@figurecollecting/scraper-plugin-contract';
import type { CapturingFetch } from './capturingFetch.js';

/**
 * Default courtesy gap (ms) when a store profile declares no `rateLimit.baseDelayMs` — should be
 * rare (every registered store's `SiteConfig.rateLimit` is required), but `buildExtractContext`
 * accepts callers that could not resolve one. 2000ms is a conservative floor (below orzgk's own
 * declared 3000ms, above the engine's global-lane MIN_DELAY of 274ms) — a real store should always
 * declare its own via `rateLimit.baseDelayMs` rather than relying on this default.
 */
export const DEFAULT_FETCH_BODY_GAP_MS = 2000;

/** Base page-fetch methods `fetchBody` is layered over; the only ones this context truly needs. */
type BaseScraping = Pick<ScrapingService, 'scrapePage' | 'scrapePageStealth'>;

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
  /** Cookies to pass through to `fetchBody`, unless a call overrides them via `opts.cookies`. */
  cookies?: Record<string, string>;
  /** The URL the PRIMARY fetch (that produced `html`) was fetched from — for the same-host gate. */
  primaryUrl: string;
  /** epoch ms when the primary fetch completed (the courtesy gap's anchor). */
  primaryFetchedAt: number;
  /** Courtesy gap in ms; defaults to `DEFAULT_FETCH_BODY_GAP_MS` when the store declares none. */
  baseDelayMs?: number;
  /** Injectable clock (default `Date.now`). */
  now?: () => number;
  /** Injectable sleep (default a real `setTimeout` promise). */
  sleep?: (ms: number) => Promise<void>;
}

/** Lowercased, `www.`-stripped hostname; `undefined` on an unparseable URL (never throws). */
function safeHostname(url: string): string | undefined {
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

/** Build the `ExtractContext` for one item's extraction (see module doc for `fetchBody`'s contract). */
export function buildExtractContext(options: BuildExtractContextOptions): ExtractContext {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const gapMs = options.baseDelayMs ?? DEFAULT_FETCH_BODY_GAP_MS;
  const primaryHost = safeHostname(options.primaryUrl);

  // Last-fetch-per-host (re-gap, spec.md D8 follow-on): a ruleset issuing MULTIPLE fetchBody
  // calls to the SAME host must be courtesy-gapped against its OWN previous call, not just the
  // primary page fetch — otherwise only the FIRST follow-up ever waits, and every call after it
  // is gapped against a primaryFetchedAt that has long since elapsed. Seeded with the primary
  // fetch's own host/time so the first same-host follow-up's behaviour is unchanged.
  const lastFetchedAt = new Map<string, number>();
  if (primaryHost !== undefined) {
    lastFetchedAt.set(primaryHost, options.primaryFetchedAt);
  }

  return {
    config: options.config,
    logger: options.logger,
    scraping: {
      scrapePage: (url, pageOptions) => options.scraping.scrapePage(url, pageOptions),
      scrapePageStealth: (url, pageOptions) => options.scraping.scrapePageStealth(url, pageOptions),
      browserFetch: notSupported('browserFetch'),
      withBrowser: notSupported('withBrowser'),
      withPage: notSupported('withPage'),

      async fetchBody(url, fetchOpts) {
        const targetHost = safeHostname(url);
        const last = targetHost !== undefined ? lastFetchedAt.get(targetHost) : undefined;
        if (last !== undefined) {
          const waitUntil = last + gapMs;
          const remaining = waitUntil - now();
          if (remaining > 0) {
            await sleep(remaining);
          }
        }
        const cookies = fetchOpts?.cookies ?? options.cookies;
        const result = await options.capturingFetch(url, options.searchFetch, cookies ? { cookies } : {});
        if (targetHost !== undefined) {
          lastFetchedAt.set(targetHost, now());
        }
        return result;
      },
    },
  };
}
