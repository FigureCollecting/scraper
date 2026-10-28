/**
 * galleryCaptureCli — run-directly entry for the gallery Job (`node dist/services/images/galleryCaptureCli.js ...`).
 * Entry files execute at top level and are never imported by a test (src/initiator/run.ts precedent). The run is
 * ./galleryJob: one trace, JSON lines from job.start to job.end.
 */
import { runGalleryJob } from './galleryJob.js';

// SIGTERM (a deleted Job, an eviction, a deadline) and SIGINT stop the run at once: no further request is issued, what the store
// has confirmed is settled, and the process exits 7. The scraper's own SIGTERM handler (closing the browser pool) is not enough:
// it does not stop the fetching.
const stop = new AbortController();
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.once(sig, () => stop.abort());

// A crashed run is already on its job.end line (code=error, err): exit 1 without writing it a second time.
void runGalleryJob(process.argv.slice(2), { signal: stop.signal })
  .then(code => { process.exitCode = code; }, () => { process.exitCode = 1; });
