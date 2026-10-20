/**
 * galleryCaptureCli — run-directly entry for the gallery Job (`node dist/services/images/galleryCaptureCli.js ...`).
 * Entry files execute at top level and are never imported by a test (src/initiator/run.ts precedent).
 */
import { main } from './galleryCapture.js';

void main()
  .then(code => { process.exitCode = code; })
  .catch(err => {
    // eslint-disable-next-line no-console
    console.error('[gallery:capture] failed:', err);
    process.exitCode = 1;
  });
