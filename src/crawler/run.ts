/**
 * Entrypoint for the catalog crawler: `node dist/crawler/run.js`.
 *
 * One invocation performs ONE bounded pass (recent THEN backfill THEN the id-range walk, by default)
 * and exits — recurrence is the K8s CronJob's schedule, and stop = the CronJob's `suspend: true`.
 * CRAWLER_MODE may name any subset of the phases (`both,reobserve`); `--dry-run` prints the OPT-IN
 * lanes' plans without enqueuing them — the re-observation selection and the id-range gap sweep's
 * open bands. Discovery has its own dry run (CRAWLER_MAX_ENQUEUE_PER_STORE=0). This is wiring only; all logic (and its
 * tests) live in ./config, ./ledger and ./crawler. It does NOT touch the server's default CMD
 * (node dist/index.js).
 */
import dotenv from 'dotenv';
import { loadCrawlerConfig } from './config.js';
import { runCrawlerPass, type FetchLike } from './crawler.js';
import { createFileLedgerStore } from './ledger.js';
import { createFileListsStateStore } from './listsState.js';
import { logger } from '../utils/logger.js';
import { createFailureReporterFromEnv } from '../services/failureReporter.js';

dotenv.config();

const httpFetch: FetchLike = (url, init) => fetch(url, init as RequestInit);

async function main(): Promise<void> {
  const config = loadCrawlerConfig(process.env);
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
    rangeFrontiers: config.rangeFrontiers,
    reobserveMinAgeH: config.reobserveMinAgeMs / 3_600_000,
    maxReobservePerStore: config.maxReobservePerStore,
    storeReobserveCaps: config.storeReobserveCaps,
    reobserveDryRun: config.reobserveDryRun,
    listsWindow: config.listsWindow,
    listsIntervalH: (config.listsIntervalMs ?? 0) / 3_600_000,
    listsDrainCaps: config.listsDrainCaps,
    listsSpacingMs: config.listsSpacingMs,
  });
  // The durable fetch-failure ledger (INGEST_BASE_URL + REPORT_FETCH_FAILURES). Null = off, and
  // every emit point in the pass is a no-op.
  const reporter = createFailureReporterFromEnv();
  await runCrawlerPass(config, {
    fetch: httpFetch,
    ledgerStore: createFileLedgerStore(config.ledgerDir),
    listsStore: createFileListsStateStore(config.ledgerDir),
    ...(reporter ? { reportFailure: (report) => reporter.report(report) } : {}),
  });
  // Every emit point is fire-and-forget and the process exits the instant this resolves, which
  // aborts an open socket: drain before returning or the pass's last report never lands.
  if (reporter) await reporter.drain();
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error('[CRAWLER] pass crashed', error);
    process.exit(1);
  });
