/**
 * processSeed — ONE 32-bit seed per scraper process (plan-v3 design.pool_select_v1_1.seeds): every
 * seeded stream the process draws (the host clock's (host, 'jitter') streams in QB-U30b; QB-U19's
 * (host, 'pick') and QB-U24's (store, 'page') later) derives from it with poolSelect.deriveStream, so a
 * logged seed replays the draws. Drawn from crypto once, at first use, and logged at boot by its users.
 */
import { randomInt } from 'node:crypto';

let seed: number | undefined;

/** The process seed: an integer in [0, 2^32), the same for the life of the process. */
export function getProcessSeed(): number {
  if (seed === undefined) seed = randomInt(0, 2 ** 32);
  return seed;
}

/** Test seam: fix the seed, or with `null` forget it (the next use draws a new one). */
export function setProcessSeed(value: number | null): void {
  seed = value ?? undefined;
}
