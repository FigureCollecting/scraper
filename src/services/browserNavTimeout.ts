/**
 * The browser lane's NAVIGATION budget — the ceiling on every `page.goto` the lane makes.
 *
 * Its own module rather than a constant inside the lane: the lane resolves it at module load (one
 * warning for a bad value, not one per navigation), while /health/detailed resolves it again per
 * request from whatever env it is handed, and neither should have to import the other.
 */
import { sanitizeForLog } from '../utils/security.js';

/**
 * Navigation budget (ms) for the browser lane when `BROWSER_NAV_TIMEOUT_MS` is unset or unusable,
 * and the clamp any override — environment or per-store — rides within.
 *
 * 20 s was hardcoded, and 20 s is not a page-load budget on this lane: a Cloudflare-fronted store
 * reached through a relayed residential exit spends most of it on the CHALLENGE rather than on
 * bytes. Production 2026-09-09 booked 65 "Navigation timeout of 20000 ms exceeded" across anitoys
 * and sugotoys while the path itself measured 1.4 MB/s with sub-second TTFB — a budget problem, not
 * a network one. The default stays 20 s so nothing changes for the stores that were fine.
 */
export const DEFAULT_NAV_TIMEOUT_MS = 20_000;
export const MIN_NAV_TIMEOUT_MS = 5_000;
export const MAX_NAV_TIMEOUT_MS = 120_000;

/**
 * Resolve the browser lane's navigation budget (ms) from the environment. `BROWSER_NAV_TIMEOUT_MS`
 * overrides the 20 s default; a missing or empty value falls back to it silently (the default is a
 * legitimate configuration), a SET but non-numeric / non-positive value falls back to it with ONE
 * warning, and any usable value is clamped to [5000, 120000] so a typo can neither strangle every
 * navigation in the pod nor let one tarpit a browser tab indefinitely. Pure (env + sink in →
 * number out) — mirrors resolveImpitTimeoutMs / resolveHttpFetchTimeoutMs.
 */
export function resolveNavTimeoutMs(
  env: NodeJS.ProcessEnv,
  warn: (message: string) => void = (message) => {
    // eslint-disable-next-line no-console
    console.warn(message);
  },
): number {
  const raw = env.BROWSER_NAV_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_NAV_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    warn(
      `[BROWSER LANE] BROWSER_NAV_TIMEOUT_MS is set to an unusable value (${sanitizeForLog(raw)}) — ` +
      `using the ${DEFAULT_NAV_TIMEOUT_MS}ms default. Give it a positive number of milliseconds.`,
    );
    return DEFAULT_NAV_TIMEOUT_MS;
  }
  return clampNavTimeoutMs(parsed);
}

/** The shared clamp, applied to the environment value and to a store's own `navTimeoutMs` alike. */
export function clampNavTimeoutMs(value: number): number {
  return Math.min(MAX_NAV_TIMEOUT_MS, Math.max(MIN_NAV_TIMEOUT_MS, value));
}

