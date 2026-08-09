/**
 * assembleCrawlWorker — the I3 adapter: composes the real engine services into the
 * `CrawlWorkerDeps` that `makeCrawlWorker` consumes, so the CrawlLoop can run against live
 * scraping/extraction/emit. It is the ONLY place the driver's pure worker meets concrete engine
 * services; the worker itself stays service-agnostic (see crawlWorker.ts).
 *
 * What it wires:
 *   - resolveUrl : ProfileRegistry.retrievalFor(host) + resolveByIdUrl → the item URL.
 *   - fetch      : ScrapingService.scrapePage(url) → { html, statusCode }.
 *   - lookupRuleset : ExtractionRegistryImpl.getRulesetForUrl(url).
 *   - emit       : IngestEmitter.send.
 *   - ledger     : the per-store CoverageLedger.
 *
 * CLOUDFLARE NOTE (why the throttle default differs from the worker's): scrapePage does NOT throw
 * on a Cloudflare challenge — it detects it, waits a bounded re-check, then returns the page with
 * whatever status came back (see scrapingService.navigateAndCapture). The CF signal is not
 * surfaced on ScrapePageResult, so the adapter routes CF by STATUS: the throttle default is
 * [403, 429, 503] (403 = "access denied", 503 = "checking your browser", 429 = rate-limited). A
 * challenge that returns HTTP 200 with a JS interstitial is NOT caught by status alone — the
 * precise fix is an explicit `challenged` flag on ScrapePageResult (a small follow-on increment),
 * which this adapter would then map to 'rate-limited'.
 */
import type { CrawlTask, Outcome } from './dispatchScheduler.js';
import type { CoverageSink } from './crawlWorker.js';
import { makeCrawlWorker } from './crawlWorker.js';
import { resolveByIdUrl } from './retrievalPlanner.js';
import type {
  ExtractContext,
  ExtractedData,
  ExtractionRuleset,
  RetrievalCapability,
  ScrapePageResult,
} from '@figurecollecting/scraper-plugin-contract';

/** Cloudflare block codes (403/503) + rate-limit (429) — the crawl worker's throttle default. */
const DEFAULT_CRAWL_THROTTLE_STATUSES = [403, 429, 503];

export interface CrawlWorkerServices {
  /** Page fetch — scrapingService.scrapePage or .scrapePageStealth (caller picks per pool). */
  scrape: (url: string) => Promise<ScrapePageResult>;
  /** URL → ruleset (engine ExtractionRegistryImpl.getRulesetForUrl). */
  getRulesetForUrl: (url: string) => ExtractionRuleset | undefined;
  /** Host → targeted-retrieval capability (driver ProfileRegistry.retrievalFor). */
  retrievalFor: (host: string) => RetrievalCapability | undefined;
  /** Deliver an extraction to the spine (IngestEmitter.send). */
  emit: (extracted: ExtractedData) => Promise<unknown>;
  /** Per-store coverage record (markDone / markFailed). */
  ledger: CoverageSink;
  /** Optional per-extraction context for multi-query rulesets (I3 supplies it; omit → 2-arg extract). */
  resolveContext?: (task: CrawlTask, url: string) => ExtractContext | undefined;
  /** Override the throttle statuses; default [403, 429, 503] (see the CLOUDFLARE NOTE). */
  throttleStatuses?: number[];
}

/** Build the CrawlLoop-ready worker from concrete engine services. */
export function assembleCrawlWorker(services: CrawlWorkerServices): (task: CrawlTask) => Promise<Outcome> {
  return makeCrawlWorker({
    resolveUrl: (task) => resolveByIdUrl(services.retrievalFor(task.host), task.id),
    fetch: async (url) => {
      const result = await services.scrape(url);
      return { html: result.html, statusCode: result.statusCode };
    },
    lookupRuleset: services.getRulesetForUrl,
    emit: services.emit,
    ledger: services.ledger,
    ...(services.resolveContext ? { resolveContext: services.resolveContext } : {}),
    throttleStatuses: services.throttleStatuses ?? DEFAULT_CRAWL_THROTTLE_STATUSES,
  });
}
