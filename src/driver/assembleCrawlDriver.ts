/**
 * assembleCrawlDriver — the crawl driver's top-level RUNTIME (2b I3/#2). It composes every merged
 * primitive into a runnable crawl:
 *
 *   allStores() → buildProfileRegistry → assembleScheduler (per-host throttle + per-pool capacity)
 *   CoverageLedger(siteId) seeded with the item ids → the task source
 *   assembleCrawlWorker (fetch → catch-gated extract → emit) bound to that ledger
 *   CrawlLoop.run() drains the scheduler, settling each outcome back for backoff/recovery
 *
 * `crawlSite(siteId, itemIds)` is the atomic unit — ONE store, ONE ledger, ONE loop (the
 * currency/backfill "cover store X's frontier" shape). Multi-site is a sequential wrapper over it
 * (shared-nothing pool budgets); the cross-store SEARCH runtime is a separate composition over the
 * retrievalPlanner. All effects are injected (scrape/emit/now/sleep) so the runtime is testable
 * with fakes and a virtual clock — the real ScrapingService / ExtractionRegistryImpl /
 * IngestEmitter wire in at the engine entrypoint.
 *
 * NOTE (scoped follow-ons): a single pass does not re-dispatch a rate-limited task — it stays
 * pending in the ledger for a resume pass (CoverageLedger.remaining()); and `scrape` here is one
 * fetch fn — per-pool stealth selection (browser pool → scrapePageStealth) and per-site
 * ExtractContext are later refinements.
 */
import { buildProfileRegistry, type ProfileRegistry } from './profileRegistry.js';
import { assembleScheduler } from './assembleScheduler.js';
import { assembleCrawlWorker } from './assembleCrawlWorker.js';
import { CrawlLoop, type CrawlLoopStats } from './crawlLoop.js';
import { CoverageLedger, type CoverageCounts } from './coverageLedger.js';
import type { PoolCapacity } from './poolRouter.js';
import type {
  ExtractedData,
  ExtractionRuleset,
  ScrapePageResult,
  StoreCapabilities,
} from '@figurecollecting/scraper-plugin-contract';

export interface CrawlDriverServices {
  /** Engine registry: the registered stores (→ ProfileRegistry) + URL→ruleset lookup. */
  extraction: {
    allStores: () => StoreCapabilities[];
    getRulesetForUrl: (url: string) => ExtractionRuleset | undefined;
  };
  /** Page fetch — scrapingService.scrapePage (or .scrapePageStealth for browser-pool stores). */
  scrape: (url: string) => Promise<ScrapePageResult>;
  /** Deliver an extraction to the spine (IngestEmitter.send). */
  emit: (extracted: ExtractedData) => Promise<unknown>;
  /** Injected clock + sleep (real: Date.now / setTimeout); keeps the loop deterministic in tests. */
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Per-pool worker capacity (browser/fetch), sized vs the crawl-rate budget. */
  capacity: PoolCapacity;
}

export interface CrawlSiteResult {
  siteId: string;
  stats: CrawlLoopStats;
  coverage: CoverageCounts;
  complete: boolean;
  ledger: CoverageLedger;
}

export interface CrawlDriver {
  /** The ProfileRegistry built from the engine's registered stores. */
  readonly profiles: ProfileRegistry;
  /** Crawl one store's items end-to-end (fetch → extract → emit), returning coverage. */
  crawlSite(siteId: string, itemIds: string[]): Promise<CrawlSiteResult>;
}

export function assembleCrawlDriver(services: CrawlDriverServices): CrawlDriver {
  const profiles = buildProfileRegistry(services.extraction.allStores());

  return {
    profiles,

    async crawlSite(siteId, itemIds) {
      const caps = profiles.forSite(siteId);
      if (!caps) throw new Error(`assembleCrawlDriver: no registered profile for site '${siteId}'`);
      const host = caps.domains[0];

      const ledger = new CoverageLedger(siteId);
      ledger.add(itemIds);

      const worker = assembleCrawlWorker({
        scrape: services.scrape,
        getRulesetForUrl: services.extraction.getRulesetForUrl,
        retrievalFor: (h) => profiles.retrievalFor(h),
        emit: services.emit,
        ledger,
      });

      const { scheduler } = assembleScheduler(profiles, services.capacity);
      // Seed from remaining() (pending + retryable-failed) so a restored ledger resumes cleanly.
      for (const id of ledger.remaining()) scheduler.enqueue({ id, host });

      const stats = await new CrawlLoop(scheduler, {
        now: services.now,
        sleep: services.sleep,
        worker,
      }).run();

      return { siteId, stats, coverage: ledger.counts(), complete: ledger.isComplete(), ledger };
    },
  };
}
