/**
 * The ingest-initiator CronJob's run, on fc-shared's server logging (telemetry.ts). ONE pass is ONE run: one root trace, a
 * job.start line, the pass's own lines, the ingest-server rpc.out lines, and ONE job.end line with the pass's counts (or
 * code=error and err, the error rethrown unchanged). Every lookup and enqueue sent to our own scraper carries the run's W3C
 * traceparent (in-cluster hosts only).
 *
 * run.ts is the run-directly wrapper; the pass's logic (and its tests) stays in ./config and ./initiator.
 */
import { createFailureReporterFromEnv } from '../services/failureReporter.js';
import { INGEST_INITIATOR, runJobProcess, tracedFetch, type Logger } from '../telemetry.js';
import { logger } from '../utils/logger.js';
import { loadInitiatorConfig } from './config.js';
import { runInitiatorPass, type FetchLike, type RunSummary } from './initiator.js';

export interface InitiatorJobOptions {
  /** Default process.env (the INITIATOR_* knobs, SCRAPER_SERVICE_URL, INGEST_BASE_URL + REPORT_FETCH_FAILURES). */
  env?: NodeJS.ProcessEnv;
  /** Default: the ingest-initiator logger on stdout. */
  logger?: Logger;
  /** Test seam: the transport under the traced fetch. Default the global fetch. */
  fetchImpl?: typeof fetch;
}

/** The pass's counters, flat, for its one job.end line (printed snake_case). */
export function initiatorCounts(s: RunSummary): Record<string, number | boolean> {
  return {
    storesConfigured: s.storesConfigured, termsConfigured: s.termsConfigured, requestsIssued: s.requestsIssued,
    budgetExhausted: s.budgetExhausted, deadlineExceeded: s.deadlineExceeded, lookupFailures: s.lookupFailures,
    discovered: s.totalDiscovered, enqueued: s.totalEnqueued, errors: s.totalErrors, peakInFlight: s.peakInFlight,
  };
}

export async function runInitiatorJob(options: InitiatorJobOptions = {}): Promise<RunSummary> {
  const env = options.env ?? process.env;
  const httpFetch: FetchLike = tracedFetch(options.fetchImpl ?? fetch);
  return runJobProcess(INGEST_INITIATOR, async () => {
    const config = loadInitiatorConfig(env);
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
    const reporter = createFailureReporterFromEnv(env);
    const summary = await runInitiatorPass(config, {
      fetch: httpFetch,
      ...(reporter ? { reportFailure: (report) => reporter.report(report) } : {}),
    });
    // Every emit point is fire-and-forget and the process exits the instant the run resolves, which
    // aborts an open socket: drain INSIDE the run, so the last report lands before job.end.
    if (reporter) await reporter.drain();
    return summary;
  }, initiatorCounts, { env, ...(options.logger === undefined ? {} : { logger: options.logger }) });
}
