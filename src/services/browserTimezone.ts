/**
 * browserTimezone — which timezone a browser page must EMULATE, chosen by the egress it leaves
 * through.
 *
 * Cloudflare's non-interactive JS challenge treats a browser that reports the UTC zone — the
 * container default, and something no real person's browser reports — as automation. Measured
 * 2026-09-07 on anitoysgk.com through the residential exit (Florida): the proven clean-Chrome recipe
 * with the browser on UTC (or Etc/GMT) never clears; the identical setup with `America/Chicago`,
 * `America/New_York` or even `Asia/Tokyo` clears in seconds. So the check is NOT a geolocation
 * match — the tell is UTC itself — but matching the egress IP's zone is the defensible default and
 * what the deploy sets. A UTC browser fails SILENTLY (the page just stays on "Just a moment"),
 * which is exactly why this is config, not a constant.
 *
 * It cannot be the process TZ: one pooled browser serves residential and direct stores side by
 * side, so the override belongs to the PAGE (CDP `Emulation.setTimezoneOverride`, i.e. puppeteer's
 * `page.emulateTimezone`) and is chosen per context:
 *   - a context bound to the residential proxy → `RESIDENTIAL_EGRESS_TIMEZONE` (deploy:
 *     America/Chicago, the home exit's zone);
 *   - a direct context                          → `DIRECT_EGRESS_TIMEZONE` (deploy:
 *     America/New_York, the OVH Virginia node's zone).
 * An unset (or blank) variable means EMULATE NOTHING — the browser keeps its own zone, which is the
 * pre-0.7.0 behavior and the right default for CI and local runs.
 */

/** Env var naming the timezone of the residential exit (proxied contexts). */
export const RESIDENTIAL_EGRESS_TIMEZONE_ENV = 'RESIDENTIAL_EGRESS_TIMEZONE';

/** Env var naming the timezone of the engine's own node (direct contexts). */
export const DIRECT_EGRESS_TIMEZONE_ENV = 'DIRECT_EGRESS_TIMEZONE';

/**
 * The IANA zone a page on this egress must emulate, or `undefined` when none is configured for it.
 * Pure (egress + env in → zone out) so the selection is testable without a browser or process env.
 *
 * @param residential - whether the page's context is bound to the residential proxy
 * @param env         - the environment to read (defaults to the process's)
 */
export function selectEgressTimezone(
  residential: boolean,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const raw = residential ? env[RESIDENTIAL_EGRESS_TIMEZONE_ENV] : env[DIRECT_EGRESS_TIMEZONE_ENV];
  const timezone = (raw ?? '').trim();
  return timezone === '' ? undefined : timezone;
}

/** The minimal page surface this module drives (keeps callers testable with a mock page). */
export interface TimezoneEmulatingPage {
  emulateTimezone(timezone?: string): Promise<void>;
}

/**
 * Apply the egress's timezone to a page BEFORE it navigates (an override applied after the
 * challenge has already sampled the environment is worthless). Nothing configured ⇒ no CDP call at
 * all. An invalid zone is NOT swallowed: `emulateTimezone` rejects, the fetch fails loudly, and the
 * operator sees the typo instead of a store that mysteriously stops clearing.
 *
 * @returns the emulated zone, or undefined when none was configured
 */
export async function applyEgressTimezone(
  page: TimezoneEmulatingPage,
  residential: boolean,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const timezone = selectEgressTimezone(residential, env);
  if (timezone) await page.emulateTimezone(timezone);
  return timezone;
}
