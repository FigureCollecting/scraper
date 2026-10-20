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

/** The record field keys that carry a NAME (byte-identical family to the rulesets DATA-1 guard / fc-aggregation lifter). */
const NAME_KEY = /^(?:name|title)$|^[a-z][A-Za-z]*(?:Name|Title)$|^(?:name|title)_[a-z]{2,3}$|^(?:name|title)[A-Z][a-z]{1,2}$/;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Visible text, tags as spaces, basic entities decoded, whitespace collapsed, lowercased. */
function headline(text: string): string {
  return text
    .replace(/<[^>]*>/g, ' ')
    .replace(/&([a-z]+);/gi, (m, e: string) => ENTITIES[e.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * The name field a record LIFTED from the challenge body itself — one whose value is the challenge page's own
 * <title> or first <h1> — or undefined. A follow-up that answered (the amiami item API) is no proof the record
 * came from it: amiami falls back to the page's <h1> when the API answers "no item", and on a challenge page
 * that <h1> is "Sorry, you have been blocked" or "Connection timed out Error code 522".
 */
export function nameLiftedFromChallenge(records: ReadonlyArray<{ fields?: Record<string, unknown> }>, html: string): string | undefined {
  const heads = new Set<string>();
  for (const tag of ['title', 'h1']) {
    const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i').exec(html);
    const h = m ? headline(m[1]) : '';
    if (h) heads.add(h);
  }
  if (heads.size === 0) return undefined;
  for (const record of records) {
    for (const [key, value] of Object.entries(record.fields ?? {})) {
      if (NAME_KEY.test(key) && typeof value === 'string' && heads.has(headline(value))) return key;
    }
  }
  return undefined;
}
