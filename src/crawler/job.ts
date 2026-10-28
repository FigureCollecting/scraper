/**
 * The ingest-crawler CronJob's run (and ingest-seed-mfc's: the same entry with CRAWLER_MODE=seed), on fc-shared's server
 * logging (telemetry.ts). ONE pass is ONE run: one root trace, a job.start line, the pass's own lines, the ingest-server
 * rpc.out lines, and ONE job.end line with the pass's counts, or with code=error and err when the pass cannot run (the error
 * is rethrown unchanged). Every call to our own scraper carries the run's W3C traceparent (in-cluster hosts only).
 *
 * run.ts is the run-directly wrapper; all the pass's logic (and its tests) stays in ./config, ./ledger and ./crawler.
 */
import { createFailureReporterFromEnv } from '../services/failureReporter.js';
import { INGEST_CRAWLER, runJobProcess, tracedFetch, type Logger } from '../telemetry.js';
import { logger } from '../utils/logger.js';
import { loadCrawlerConfig } from './config.js';
import { runCrawlerPass, type CrawlerSummary, type FetchLike } from './crawler.js';
import { createFileLedgerStore } from './ledger.js';
import { createFileListsStateStore } from './listsState.js';
import { createFilePassRingStore, createHealthHostClockReader } from './passStrategy.js';

export interface CrawlerJobOptions {
  /** Default process.env (the CRAWLER_* knobs, SCRAPER_SERVICE_URL, INGEST_BASE_URL + REPORT_FETCH_FAILURES). */
  env?: NodeJS.ProcessEnv;
  /** Default process.argv (`--dry-run`). */
  argv?: string[];
  /** Default: the ingest-crawler logger on stdout. */
  logger?: Logger;
  /** Test seam: the transport under the traced fetch. Default the global fetch. */
  fetchImpl?: typeof fetch;
}

/** The pass's counters, flat, for its one job.end line (printed snake_case: pages_fetched, reobserve_landed, ...). */
export function crawlerCounts(s: CrawlerSummary): Record<string, string | number | boolean> {
  return {
    mode: s.mode, storesConfigured: s.storesConfigured, requestsIssued: s.requestsIssued, budgetExhausted: s.budgetExhausted,
    pagesFetched: s.totalPagesFetched, discovered: s.totalDiscovered, enqueued: s.totalEnqueued, reobserved: s.totalReobserved,
    reobserveLanded: s.totalReobserveLanded, rangeWalked: s.totalRangeWalked, gapIdsSwept: s.totalGapIdsSwept, gapEnqueued: s.totalGapEnqueued,
    listsEnqueued: s.totalListsEnqueued, errors: s.totalErrors, skipped: s.totalSkipped,
    peakInFlight: s.peakInFlight,
  };
}

export async function runCrawlerJob(options: CrawlerJobOptions = {}): Promise<CrawlerSummary> {
  const env = options.env ?? process.env;
  const httpFetch: FetchLike = tracedFetch(options.fetchImpl ?? fetch);
  return runJobProcess(INGEST_CRAWLER, async () => {
    const config = loadCrawlerConfig(env, options.argv ?? process.argv);
    logger.info('[CRAWLER] pass starting', {
      scraperServiceUrl: config.scraperServiceUrl,
      mode: config.mode,
      phases: config.phases,
      stores: config.stores,
      ledgerDir: config.ledgerDir,
      recentMaxPages: config.recentMaxPages,
      backfillPagesPerRun: config.backfillPagesPerRun,
      maxRequests: config.maxRequests,
      maxEnqueuePerStore: config.maxEnqueuePerStore,
      storeEnqueueCaps: config.storeEnqueueCaps,
      maxConcurrency: config.maxConcurrency,
      requestSpacingMs: config.requestSpacingMs,
      requestTimeoutMs: config.requestTimeoutMs,
      reobserveAfterMs: config.reobserveAfterMs,
      exhaustedRecheckMs: config.exhaustedRecheckMs,
      rangeStores: config.rangeStores,
      rangeIdsPerRun: config.rangeIdsPerRun,
      rangeDescentCaps: config.rangeDescentCaps,
      rangeFrontiers: config.rangeFrontiers,
      reobserveMinAgeH: config.reobserveMinAgeMs / 3_600_000,
      maxReobservePerStore: config.maxReobservePerStore,
      storeReobserveCaps: config.storeReobserveCaps,
      reobserveDryRun: config.reobserveDryRun,
      listsWindow: config.listsWindow,
      listsIntervalH: (config.listsIntervalMs ?? 0) / 3_600_000,
      listsDrainCaps: config.listsDrainCaps,
      listsSpacingMs: config.listsSpacingMs,
      listsAlternate: config.listsAlternate,
      pagePool: config.pagePool,
      pagePoolLookahead: config.pagePoolLookahead,
      pagePoolVisitedTtlH: (config.pagePoolVisitedTtlMs ?? 0) / 3_600_000,
    });
    // The durable fetch-failure ledger (INGEST_BASE_URL + REPORT_FETCH_FAILURES). Null = off, and
    // every emit point in the pass is a no-op.
    const reporter = createFailureReporterFromEnv(env);
    const summary = await runCrawlerPass(config, {
      fetch: httpFetch,
      ledgerStore: createFileLedgerStore(config.ledgerDir),
      listsStore: createFileListsStateStore(config.ledgerDir),
      // QB-U36: used only when a store is in CRAWLER_LISTS_ALTERNATE — our own /health/detailed, once a pass,
      // and `<siteId>.passes.ndjson` beside the ledgers.
      readHostClock: createHealthHostClockReader(config.scraperServiceUrl, httpFetch, config.requestTimeoutMs),
      passRing: createFilePassRingStore(config.ledgerDir),
      ...(reporter ? { reportFailure: (report) => reporter.report(report) } : {}),
    });
    // Every emit point is fire-and-forget and the process exits the instant the run resolves, which
    // aborts an open socket: drain INSIDE the run, so the last report lands and its rpc.out line is
    // on the run's trace, before job.end.
    if (reporter) await reporter.drain();
    return summary;
  }, crawlerCounts, { env, ...(options.logger === undefined ? {} : { logger: options.logger }) });
}
