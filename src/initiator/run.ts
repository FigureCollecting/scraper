/**
 * Entrypoint for the interim ingestion initiator: `node dist/initiator/run.js`.
 *
 * One invocation performs ONE bounded pass and exits — recurrence is the K8s
 * CronJob's schedule, and stop = the CronJob's `suspend: true`. This is wiring
 * only; all logic (and its tests) live in ./config and ./initiator. It does NOT
 * touch the server's default CMD (node dist/index.js).
 */
import dotenv from 'dotenv';
import { loadInitiatorConfig } from './config.js';
import { runInitiatorPass, type FetchLike } from './initiator.js';
import { createFailureReporterFromEnv } from '../services/failureReporter.js';
import { logger } from '../utils/logger.js';

dotenv.config();

const httpFetch: FetchLike = (url, init) => fetch(url, init as RequestInit);

async function main(): Promise<void> {
  const config = loadInitiatorConfig(process.env);
  logger.info('[INITIATOR] pass starting', {
    scraperServiceUrl: config.scraperServiceUrl,
    stores: config.stores,
    terms: config.terms,
    mode: config.mode,
    maxConcurrency: config.maxConcurrency,
    maxRequests: config.maxRequests,
    maxUrlsPerStore: config.maxUrlsPerStore,
    requestSpacingMs: config.requestSpacingMs,
    requestTimeoutMs: config.requestTimeoutMs,
    passDeadlineMs: config.passDeadlineMs,
    lookupRetryDelayMs: config.lookupRetryDelayMs,
  });
  // The durable fetch-failure ledger (INGEST_BASE_URL + REPORT_FETCH_FAILURES). Null = off, and
  // every emit point in the pass is a no-op.
  const reporter = createFailureReporterFromEnv();
  await runInitiatorPass(config, {
    fetch: httpFetch,
    ...(reporter ? { reportFailure: (report) => reporter.report(report) } : {}),
  });
  // Every emit point is fire-and-forget and the process exits the instant this resolves, which
  // aborts an open socket: drain before returning or the pass's last report never lands.
  if (reporter) await reporter.drain();
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error('[INITIATOR] pass crashed', error);
    process.exit(1);
  });
