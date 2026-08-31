/**
 * challengeDetect — a pure, dependency-free predicate for "is this HTML a Cloudflare interstitial
 * challenge rather than the real page?".
 *
 * The ingest path's capturingFetch hands raw bytes straight to a ruleset; a Cloudflare
 * managed-JS / IUAM challenge body (a ~6KB "Just a moment..." interstitial) is NOT the product
 * page — a ruleset silently extracts an EMPTY field bag from it, which then persists nothing while
 * the pipeline reports success. This predicate lets the transport turn such a body into a loud,
 * typed failure instead. It is also reused by impitFetch's re-prime trigger (one detector, not two).
 *
 * CONSERVATIVE BY DESIGN: a real product page that merely mentions "Cloudflare" or "cf" must NOT
 * match. Detection keys ONLY on CF-challenge-SPECIFIC tokens (challenge script globals / loader) or
 * the challenge interstitial's own <title> / verification copy — never on a single loose word. A
 * false negative just means the empty-record honesty gate downstream still catches it; a false
 * positive would wrongly fail a real page, so we err toward specificity.
 */

/**
 * CF-challenge-specific script/token markers. Each of these strings is emitted by Cloudflare's
 * challenge machinery and does not occur on a real product page:
 *   - challenge-platform      — the /cdn-cgi/challenge-platform/… orchestrate loader
 *   - __cf_chl_               — challenge script globals (e.g. __cf_chl_ctx / __cf_chl_managed_tk__)
 *   - _cf_chl_opt             — window._cf_chl_opt challenge options object
 *   - cf-browser-verification — legacy "I'm Under Attack" verification container
 */
const TOKEN_MARKERS = [
  'challenge-platform',
  '__cf_chl_',
  '_cf_chl_opt',
  'cf-browser-verification',
] as const;

/** The CF managed-challenge document <title> ("Just a moment..."), required inside a <title> tag. */
const CHALLENGE_TITLE = /<title>\s*Just a moment/i;

/** The classic IUAM interstitial body copy. */
const IUAM_BODY_COPY = 'Checking your browser before accessing';

/**
 * Whether `html` is a Cloudflare managed-JS / IUAM challenge interstitial rather than real content.
 * Conservative: true only when a challenge-specific token is present, OR the challenge <title> is
 * present, OR the IUAM body copy is present. Non-string / empty input is never a challenge.
 */
export function isCloudflareChallenge(html: string): boolean {
  if (typeof html !== 'string' || html.length === 0) return false;
  if (TOKEN_MARKERS.some(marker => html.includes(marker))) return true;
  if (CHALLENGE_TITLE.test(html)) return true;
  if (html.includes(IUAM_BODY_COPY)) return true;
  return false;
}
