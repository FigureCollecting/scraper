/**
 * Entrypoint for the catalog crawler: `node dist/crawler/run.js`.
 *
 * One invocation performs ONE bounded pass (recent THEN backfill by default) and
 * exits — recurrence is the K8s CronJob's schedule, and stop = the CronJob's
 * `suspend: true`. This is wiring only; all logic (and its tests) live in
 * ./config, ./ledger and ./crawler. It does NOT touch the server's default CMD
 * (node dist/index.js).
 */
import dotenv from 'dotenv';
import { loadCrawlerConfig } from './config.js';
import { runCrawlerPass, type FetchLike } from './crawler.js';
import { createFileLedgerStore } from './ledger.js';
import { logger } from '../utils/logger.js';

dotenv.config();

const httpFetch: FetchLike = (url, init) => fetch(url, init as RequestInit);

async function main(): Promise<void> {
  const config = loadCrawlerConfig(process.env);
  logger.info('[CRAWLER] pass starting', {
    scraperServiceUrl: config.scraperServiceUrl,
    mode: config.mode,
    stores: config.stores,
    ledgerDir: config.ledgerDir,
    recentMaxPages: config.recentMaxPages,
    backfillPagesPerRun: config.backfillPagesPerRun,
    maxRequests: config.maxRequests,
    maxEnqueuePerStore: config.maxEnqueuePerStore,
    maxConcurrency: config.maxConcurrency,
    requestSpacingMs: config.requestSpacingMs,
    requestTimeoutMs: config.requestTimeoutMs,
    reobserveAfterMs: config.reobserveAfterMs,
    exhaustedRecheckMs: config.exhaustedRecheckMs,
  });
  await runCrawlerPass(config, { fetch: httpFetch, ledgerStore: createFileLedgerStore(config.ledgerDir) });
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error('[CRAWLER] pass crashed', error);
    process.exit(1);
  });
