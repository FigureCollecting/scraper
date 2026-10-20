/**
 * challengeRecovery — the EVIDENCE that a challenge-flagged item page was recovered (NAME-ERRPAGE-1).
 *
 * capturingFetch flags a Cloudflare interstitial or error page (`challenge: true`) instead of throwing,
 * because a ruleset may still reach the record through its OWN follow-up transport (the amiami case:
 * the product page is challenged, the item API answers). The queue used to infer that recovery from
 * the post-emit honesty gate alone — persisted>0 on a challenge page counted as recovered. But a
 * ruleset extracts SOMETHING from any body: a Cloudflare 522 page's <h1> ("Connection timed out
 * Error code 522") became an MFC item's name, persisted, and was booked a success (827 spine products,
 * 2026-09-08..10-04). Persisting is not recovering.
 *
 * So the queue now counts the ruleset's follow-ups during extraction and requires at least ONE that
 * answered a real page — not itself a challenge, a 2xx (or a status the lane did not observe), a
 * non-blank body — before it will emit anything extracted on a challenge-flagged page. Only the two
 * doors an ExtractContext opens to the network are counted: `fetchBody` (over capturingFetch) and the
 * `scrapePage` / `scrapePageStealth` passthroughs.
 */
import { isCloudflareChallenge } from './engineServices/challengeDetect.js';
import type { BrowserLaneFetcher, CapturingFetch } from './engineServices/capturingFetch.js';

/** How many of an extraction's follow-up fetches answered a real page. */
export interface FollowUpTally {
  clean: number;
}

/** A follow-up answer that is a real page: not flagged, not a CF interstitial, 2xx or unobserved, non-blank. */
export function isRecoveredBody(html: unknown, status: number | undefined, challenge?: boolean): boolean {
  if (challenge === true || typeof html !== 'string' || html.trim().length === 0) return false;
  if (status !== undefined && (status < 200 || status > 299)) return false;
  return !isCloudflareChallenge(html);
}

/** capturingFetch, counting each follow-up that answered a real page into `tally`. */
export function tallyCapturingFetch(fetch: CapturingFetch, tally: FollowUpTally): CapturingFetch {
  return async (url, searchFetch, options) => {
    const res = await fetch(url, searchFetch, options);
    if (isRecoveredBody(res.html, res.status, res.challenge)) tally.clean++;
    return res;
  };
}

/** The scrapePage / scrapePageStealth passthroughs, counting each real page into `tally`. */
export function tallyPageFetcher(fetcher: BrowserLaneFetcher, tally: FollowUpTally): BrowserLaneFetcher {
  return {
    async scrapePage(url, options) {
      const page = await fetcher.scrapePage(url, options);
      if (isRecoveredBody(page.html, page.statusCode)) tally.clean++;
      return page;
    },
    async scrapePageStealth(url, options) {
      const page = await fetcher.scrapePageStealth(url, options);
      if (isRecoveredBody(page.html, page.statusCode)) tally.clean++;
      return page;
    },
  };
}
