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
  });
  await runInitiatorPass(config, { fetch: httpFetch });
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error('[INITIATOR] pass crashed', error);
    process.exit(1);
  });
