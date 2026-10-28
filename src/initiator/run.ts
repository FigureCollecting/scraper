/**
 * Entrypoint for the interim ingestion initiator: `node dist/initiator/run.js`.
 *
 * One invocation performs ONE bounded pass and exits — recurrence is the K8s
 * CronJob's schedule, and stop = the CronJob's `suspend: true`. This is wiring
 * only; the run is ./job (one trace, a job.start and a job.end line) and all
 * logic (and its tests) lives in ./config and ./initiator. It does NOT touch the
 * server's default CMD (node dist/index.js).
 */
import dotenv from 'dotenv';
import { runInitiatorJob } from './job.js';

dotenv.config({ quiet: true });

// A failed pass is already on its job.end line (code=error, err): exit non-zero without writing it
// a second time.
runInitiatorJob().then(
  () => process.exit(0),
  () => process.exit(1),
);
