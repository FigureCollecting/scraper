/**
 * browserTimezone — the OPTIONAL per-page timezone override, chosen by the egress the page leaves
 * through.
 *
 * READ THIS FIRST: the timezone that decides a Cloudflare challenge is the PROCESS zone, not
 * anything this module sets. Measured 2026-09-07 against anitoysgk.com through the residential exit,
 * with the proven clean-headful recipe otherwise identical:
 *
 *   process TZ=UTC, `page.emulateTimezone('America/Chicago')`  →  STUCK on the interstitial
 *   process TZ=America/Chicago, no emulation                   →  PASS in ~8 s
 *   process TZ=America/Chicago, emulate 'America/New_York'     →  PASS
 *
 * The challenge runs in a CROSS-ORIGIN frame, and a CDP `Emulation.setTimezoneOverride` applied to
 * the page does not reach it — the frame reads the browser process's own zone. So the fix is the
 * CONTAINER's `TZ` (the deploy sets `America/Chicago` and leaves the two variables below EMPTY), and
 * a UTC process fails silently no matter what any page emulates.
 *
 * What remains here is cosmetics with a real purpose: making the page's own reported zone agree with
 * the exit it leaves through, for the fingerprinting a store does after the challenge. It is per
 * PAGE rather than a second process zone because one process serves residential and direct stores at
 * once:
 *   - a page on the residential proxy → `RESIDENTIAL_EGRESS_TIMEZONE`
 *   - a direct page                   → `DIRECT_EGRESS_TIMEZONE`
 * An unset (or blank) variable means EMULATE NOTHING — the page keeps the process zone, which is the
 * pre-0.7.0 behavior, the default, and what the deployment runs.
 */
/** Env var naming the timezone of the residential exit (proxied pages). Optional; usually empty. */
export const RESIDENTIAL_EGRESS_TIMEZONE_ENV = 'RESIDENTIAL_EGRESS_TIMEZONE';

/** Env var naming the timezone of the engine's own node (direct pages). Optional; usually empty. */
export const DIRECT_EGRESS_TIMEZONE_ENV = 'DIRECT_EGRESS_TIMEZONE';

/**
 * The IANA zone a page on this egress should emulate, or `undefined` when none is configured for it
 * (the default). Pure (egress + env in → zone out) so the selection is testable without a browser.
 *
 * @param residential - whether the page leaves through the residential proxy
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
 * Apply the egress's timezone to a page BEFORE it navigates (an override applied after a page has
 * already sampled its environment is worthless). Nothing configured ⇒ no CDP call at all, which is
 * the deployed configuration — the process zone is what a challenge reads. An invalid zone is NOT
 * swallowed: `emulateTimezone` rejects and the operator sees the typo.
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
