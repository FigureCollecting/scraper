/**
 * galleryCaptureCli — run-directly entry for the gallery Job (`node dist/services/images/galleryCaptureCli.js ...`).
 * Entry files execute at top level and are never imported by a test (src/initiator/run.ts precedent).
 */
import { main } from './galleryCapture.js';

// SIGTERM (a deleted Job, an eviction, a deadline) and SIGINT stop the run at once: no further request is issued, what the store
// has confirmed is settled, and the process exits 7. The scraper's own SIGTERM handler (closing the browser pool) is not enough:
// it does not stop the fetching.
const stop = new AbortController();
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.once(sig, () => stop.abort());

void main(undefined, { signal: stop.signal })
  .then(code => { process.exitCode = code; })
  .catch(err => {
    // eslint-disable-next-line no-console
    console.error('[gallery:capture] failed:', err);
    process.exitCode = 1;
  });
