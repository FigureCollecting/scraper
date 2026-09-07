/**
 * browserChallenge — the browser lane's Cloudflare-challenge handling: recognise a challenge,
 * wait it out, and remember which hosts gate.
 *
 * The clean-headful Chrome profile passes Cloudflare's NON-interactive JS challenge by itself (no
 * solver, no human, no clicking) — but it takes seconds, and `page.goto(url, 'domcontentloaded')`
 * returns the instant the CHALLENGE page's DOM exists. Without a bounded wait the lane happily
 * captures "Just a moment" and hands it to a ruleset as the product page. So: navigate, and if the
 * first response carries `cf-mitigated: challenge` (or the title is the challenge page), poll until
 * the real document replaces it, bounded by a budget.
 *
 * Seeing a challenge is also the LEARNED signal that a host is gated. That matters beyond this
 * fetch: a gated host is served from then on by the long-lived browser for its egress (see
 * gatedBrowsers), whose default context holds the clearance — which Cloudflare binds to IP + user
 * agent + profile — so it is reused for the ~30 min it is good for instead of re-earned every fetch.
 */
import { sanitizeForLog } from '../utils/security.js';

/**
 * A store DECLARED a Cloudflare gate (`SearchFetch.access: 'cloudflare'`) but this process launches
 * Chrome with the headless profile, which does not clear a Cloudflare JS challenge — with any user
 * agent, and silently: the page simply never leaves the interstitial. The fetch is refused rather
 * than attempted, for the same reason an unconfigured residential proxy is refused: a doomed attempt
 * still spends the egress IP's Cloudflare reputation, and a config gap must fail loudly instead of
 * looking like a store that "stopped working". A LEARNED gate is not refused (see isChallengeGated):
 * one `cf-mitigated` response is a weaker signal than a declaration.
 */
export class ChallengeLaneUnavailableError extends Error {
  readonly url: string;
  constructor(url: string) {
    super(
      `A Cloudflare challenge gate is declared for ${sanitizeForLog(url)} but BROWSER_LAUNCH_MODE is not 'clean-headful' — ` +
      'the headless launch profile never clears the challenge, so the fetch is refused instead of spending the egress IP on an attempt that cannot pass.',
    );
    this.name = 'ChallengeLaneUnavailableError';
    this.url = url;
  }
}

/** Cloudflare's own header on a mitigated (challenge/block) response. */
export const CHALLENGE_HEADER = 'cf-mitigated';

/**
 * Default budget for a challenge to clear itself, and the poll interval inside it. Measured live, a
 * challenge clears in 3-9 s; the budget is the ceiling for a slow one. The CALLER's own budget can
 * be shorter and then bounds this first — `/lookup` gives each store LOOKUP_STORE_TIMEOUT_MS (15 s
 * by default), so a lookup abandons a stalled challenge before this timeout is ever reached, while
 * the crawl/ingest lane (no per-store deadline) gets the full window.
 */
export const CHALLENGE_CLEARANCE_TIMEOUT_MS = 30000;
export const CHALLENGE_POLL_MS = 750;

/** Titles the interstitial serves while the challenge runs (Chrome renders the English one). */
const CHALLENGE_TITLE = /^\s*just a moment/i;

/** Hosts observed serving a challenge in this process (learned, never configured). */
const gatedHosts = new Set<string>();

/** The minimal page surface the clearance wait drives (mockable, no puppeteer import needed). */
export interface ChallengeAwarePage {
  title(): Promise<string>;
  /** Optional: watches `document.readyState`, and looks for the interstitial's own containers. */
  evaluate?(pageFunction: () => any): Promise<unknown>;
}

/** The minimal response surface: its headers, whatever the lane got back from `goto`. */
export interface ChallengeAwareResponse {
  headers(): Record<string, string>;
}

/** `cf-mitigated: challenge` on a response's headers (header names arrive lowercased; be tolerant). */
export function isChallengeResponse(headers: Record<string, string> | undefined): boolean {
  if (!headers) return false;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === CHALLENGE_HEADER) return String(value).toLowerCase() === 'challenge';
  }
  return false;
}

/**
 * Cloudflare's own interstitial containers. The title is not enough on its own: the interstitial is
 * localised (Chrome renders the English one only when it asks for English) and `cf-mitigated` is not
 * always present, and a MISSED challenge is the expensive case — the interstitial is captured as the
 * product page AND the host is never marked gated, so every later fetch re-challenges from scratch.
 * Deliberately NOT the widget/script selectors the probe also accepts (`challenges.cloudflare.com`,
 * `#cf-chl-widget`): those appear on ordinary pages carrying a Turnstile, which are not interstitials
 * and must not be waited on.
 */
async function hasChallengeMarkers(page: ChallengeAwarePage): Promise<boolean> {
  if (typeof page.evaluate !== 'function') return false;
  const found = await page
    .evaluate(() => document.querySelector('#challenge-running, #challenge-stage') !== null)
    .catch(() => false);
  // STRICTLY true: any other value (a page surface that returns something else) is not a challenge.
  return found === true;
}

/** Whether a page title is Cloudflare's interstitial rather than the store's own document. */
export function isChallengeTitle(title: string | undefined): boolean {
  return CHALLENGE_TITLE.test(title ?? '');
}

/** A URL's hostname, lowercased — the key gated hosts are remembered by. `undefined` if unparseable. */
export function challengeHost(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Remember that a host serves challenges (so its context is worth keeping alive). */
export function markChallengeGated(host: string): void {
  gatedHosts.add(host.toLowerCase());
}

/** Whether this host has served a challenge in this process. */
export function isChallengeGated(host: string | undefined): boolean {
  return host !== undefined && gatedHosts.has(host.toLowerCase());
}

/** Forget every learned gate (test isolation; also what a full pool shutdown implies). */
export function clearChallengeGates(): void {
  gatedHosts.clear();
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Wait out a Cloudflare challenge on a freshly-navigated page.
 *
 * @returns whether a challenge was seen at all (true ⇒ the host is now marked gated, whether or not
 *          the challenge finished clearing). A timeout is NOT an error: the caller captures whatever
 *          rendered — exactly as the readiness wait does — with one warning, so a store that starts
 *          hard-blocking degrades to a bad capture instead of a thrown fetch and a retry storm.
 */
export async function awaitChallengeClearance(
  page: ChallengeAwarePage,
  response: ChallengeAwareResponse | null | undefined,
  url: string,
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<boolean> {
  const headerSaysChallenge = isChallengeResponse(response?.headers?.());
  const title = await page.title().catch(() => '');
  const showsChallenge = async (currentTitle: string): Promise<boolean> =>
    isChallengeTitle(currentTitle) || await hasChallengeMarkers(page);
  if (!headerSaysChallenge && !(await showsChallenge(title))) return false;

  const host = challengeHost(url);
  if (host) markChallengeGated(host);

  const timeoutMs = options.timeoutMs ?? CHALLENGE_CLEARANCE_TIMEOUT_MS;
  const pollMs = options.pollMs ?? CHALLENGE_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  let current = title;
  while (await showsChallenge(current)) {
    if (Date.now() >= deadline) {
      // eslint-disable-next-line no-console
      // lgtm[js/log-injection] — url is caller-influenced; sanitize before logging
      console.warn(`[CHALLENGE] ${sanitizeForLog(url)} was still showing the Cloudflare interstitial after ${timeoutMs}ms — capturing whatever rendered`);
      return true;
    }
    await sleep(pollMs);
    current = await page.title().catch(() => current);
  }

  // The title flips the moment the REAL document starts loading, which is not the moment it is
  // readable: measured live, reading right then yielded a 2 KB fragment of a 290 KB page. The
  // post-challenge document is a navigation the caller's `goto` never waited on, so wait for it
  // here — until the HTML is parsed (`readyState` past `loading`), bounded by the same deadline.
  await awaitDocumentParsed(page, deadline, pollMs);
  return true;
}

/** Poll `document.readyState` until the document is past `loading`, or the deadline passes. */
async function awaitDocumentParsed(page: ChallengeAwarePage, deadline: number, pollMs: number): Promise<void> {
  if (typeof page.evaluate !== 'function') return;
  const readyState = async (): Promise<unknown> =>
    await page.evaluate!(() => document.readyState).catch(() => 'complete');
  while ((await readyState()) === 'loading') {
    if (Date.now() >= deadline) return;
    await sleep(pollMs);
  }
}
