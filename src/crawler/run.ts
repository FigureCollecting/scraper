/**
 * Entrypoint for the catalog crawler: `node dist/crawler/run.js`.
 *
 * One invocation performs ONE bounded pass (recent THEN backfill THEN the id-range walk, by default)
 * and exits — recurrence is the K8s CronJob's schedule, and stop = the CronJob's `suspend: true`.
 * CRAWLER_MODE may name any subset of the phases (`both,reobserve`); `--dry-run` prints the OPT-IN
 * lanes' plans without enqueuing them — the re-observation selection and the id-range gap sweep's
 * open bands. Discovery has its own dry run (CRAWLER_MAX_ENQUEUE_PER_STORE=0). This is wiring only; the
 * run is ./job (one trace, a job.start and a job.end line) and all the pass's logic (and its tests)
 * lives in ./config, ./ledger and ./crawler. It does NOT touch the server's default CMD
 * (node dist/index.js).
 */
import dotenv from 'dotenv';
import { runCrawlerJob } from './job.js';

dotenv.config({ quiet: true });

// A failed pass is already on its job.end line (code=error, err): exit non-zero without writing it
// a second time.
runCrawlerJob().then(
  () => process.exit(0),
  () => process.exit(1),
);
