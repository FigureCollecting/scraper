/**
 * recordFetchGate — the PURE verdict on ONE record fetch's response metadata (status + final URL).
 *
 * WHY IT EXISTS: the record lane used to be status-BLIND. Every transport returned bytes and only
 * bytes, so a store's 404 page, a busy 5xx, and an item URL that bounced to the shop's front page
 * were all handed to the ruleset — which then failed to lift a record from them, and the fetch-
 * failure ledger booked the store's answer as OUR `parse` / `ruleset` / `other` gap. With
 * {status, finalUrl} now surfaced by every lane (CapturingFetchResult), this module names what the
 * STORE said, once, before extraction is ever attempted.
 *
 * PURE by design (same inputs → same verdict, no clock, no I/O, no logging): the reason class it
 * feeds decides RETRY vs REVIEW on the spine, so it must be exhaustively testable away from the
 * queue's browser pool. Deliberately light on imports for the same reason failureClassifier is —
 * both are reachable from the CronJob CLIs, which must never drag the engine's browser/object-store
 * graph in behind them.
 *
 * WHAT IT DOES NOT DECIDE: terminality and retry policy (the queue's classifyError/shouldRetry own
 * those, keyed off this error's class), and Cloudflare interstitials (a challenge-FLAGGED body is
 * the challenge path's business — it may still be recovered by a ruleset's own follow-up transport,
 * the amiami case — so the queue never runs this gate on one).
 */
import type { GonePage } from '@figurecollecting/scraper-plugin-contract';
import { sanitizeForLog } from '../utils/security.js';

/**
 * STORES WHERE A 404 IS AMBIGUOUS — a table, deliberately, not a special case buried in the gate.
 *
 * A 404 normally means the store removed the thing, and the ledger closes such a row as gone. On
 * some stores it means something else entirely, and closing it would destroy a real item's history:
 *
 *   myfigurecollection.net — NSFW and NSFW+ items answer 404 to a session that is not ENTITLED to
 *   see them (the age gate, or scrape-account cookies that have gone stale). The site does not
 *   differentiate that denial from a genuinely missing item, so neither can we. Such a row must go
 *   to REVIEW carrying the re-mint hint, never to auto-close. (Owner rule, 2026-09-09.)
 *
 * Keyed by registrable host, matched on the host itself or any subdomain of it — never by substring,
 * which would hand `myfigurecollection.net.evil.test` the same exemption.
 */
const AMBIGUOUS_NOT_FOUND_STORES: readonly { host: string; site: string }[] = [
  { host: 'myfigurecollection.net', site: 'mfc' },
];

/**
 * The store whose 404 is ambiguous, by its siteId, or `undefined` when this URL's host is not one of
 * them. Matched on the host itself or a subdomain of it — never by substring, which would hand
 * `myfigurecollection.net.evil.test` the same exemption. Unparseable input is never a match.
 */
export function ambiguousNotFoundSite(url: string): string | undefined {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  return AMBIGUOUS_NOT_FOUND_STORES.find(({ host: known }) => host === known || host.endsWith(`.${known}`))?.site;
}

/** Is this URL's host one of the stores whose 404 is ambiguous? */
export function isAmbiguousNotFoundHost(url: string): boolean {
  return ambiguousNotFoundSite(url) !== undefined;
}

/**
 * The response metadata a lane surfaced for one fetch. Both fields are optional: a transport that
 * returns a bare string (every pre-status fetcher, and every test fake shaped like one) observed
 * neither, and an absent field is honest — never a fabricated 200.
 */
export interface RecordFetchMeta {
  status?: number;
  finalUrl?: string;
  /** The body, read only to match a ruleset-declared gone page. */
  html?: string;
}

/**
 * The store answered, but not with the record: a 4xx/5xx status, or a redirect that landed on the
 * store's home page. A CLASS, not a message convention — the queue's classifyError and the ledger's
 * classifyFetchFailure both read `status` / `redirectedHome` off it, so its taxonomy can never
 * depend on free text (the RS-2 rule the other typed engine errors follow).
 */
export class RecordFetchStatusError extends Error {
  readonly url: string;
  readonly transport: string;
  readonly status: number | undefined;
  readonly finalUrl: string | undefined;
  readonly redirectedHome: boolean;
  /**
   * The store answered 404 AND it is one of the stores where that does not mean "gone" (see
   * {@link AMBIGUOUS_NOT_FOUND_HOSTS}), or the response matched the ruleset's declared gone page.
   * The ledger books such a row as http_403 — reviewable — instead of auto-closing it as removed.
   */
  readonly deniedOrGone: boolean;
  /** The response matched the ruleset's declared gone page (ExtractionRuleset.gonePage). */
  readonly declaredGone: boolean;
  /** The siteId of the ambiguous-404 store, when this is one — `undefined` otherwise. */
  readonly deniedOrGoneSite: string | undefined;

  constructor(args: {
    url: string;
    transport: string;
    status?: number;
    finalUrl?: string;
    redirectedHome?: boolean;
    /** The store's siteId, when its 404 is ambiguous — it NAMES the store in the ledger message. */
    deniedOrGoneSite?: string;
    /** The response matched the ruleset's declared gone page. */
    declaredGone?: boolean;
  }) {
    const redirectedHome = args.redirectedHome === true;
    const declaredGone = args.declaredGone === true;
    const deniedOrGone = args.deniedOrGoneSite !== undefined || declaredGone;
    // The exact operator-facing token: "<site> 404: denied-or-gone, session may need re-minting".
    const what = redirectedHome
      ? `redirected to the store home page ${sanitizeForLog(args.finalUrl ?? '')}`
      : declaredGone
        ? `answered HTTP ${args.status} with the ruleset's declared gone page: gone-or-denied`
        : deniedOrGone
        ? `answered ${args.deniedOrGoneSite} 404: denied-or-gone, session may need re-minting (an unentitled NSFW item and a missing item answer alike here)`
        : `answered HTTP ${args.status}`;
    super(`Record fetch for ${sanitizeForLog(args.url)} via ${args.transport} transport ${what}.`);
    this.name = 'RecordFetchStatusError';
    this.url = args.url;
    this.transport = args.transport;
    this.status = args.status;
    this.finalUrl = args.finalUrl;
    this.redirectedHome = redirectedHome;
    this.deniedOrGone = deniedOrGone;
    this.declaredGone = declaredGone;
    this.deniedOrGoneSite = args.deniedOrGoneSite;
  }
}

/** A status a real HTTP response can carry — never a sentinel 0 / NaN / 999 from a defensive read. */
function usableStatus(status: number | undefined): number | undefined {
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : undefined;
}

/** The parsed URL, `undefined` when it will not parse. */
function parse(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

/** A bare root — `/` or the empty path a hostname-only URL normalizes to. */
function isHomePath(path: string): boolean {
  return path === '' || path === '/';
}

/**
 * Languages a store localizes into (ISO 639-1 and 639-2 B/T). An allowlist, not "any 2–3 letters":
 * root-slug stores keep categories and products at /<slug>/, and /new/ or /so_ta is not a language.
 */
const LOCALE_LANGUAGES =
  'ar|cs|da|de|el|en|es|fi|fr|he|hi|hu|id|it|ja|ko|ms|nl|no|pl|pt|ro|ru|sv|th|tl|tr|uk|vi|zh|' +
  'ara|chi|deu|dut|eng|fra|fre|ger|ind|ita|jpn|kor|nld|pol|por|rus|spa|swe|tha|tur|vie|zho';

/**
 * A bare locale root: ONE known language segment (`/eng/`, `/en`, `/zh-cn/`, `/es-419`, `/zh-Hant/`)
 * and nothing else, with at most a region (2 letters / 3 digits) or a real script subtag.
 */
const LOCALE_ROOT = new RegExp(
  `^/(?:${LOCALE_LANGUAGES})(?:[-_](?:[a-z]{2}|\\d{3}|hans|hant|latn|cyrl|arab))?/?$`,
  'i',
);

/** Same site: one host equals, or is a subdomain of, the other (`www.` bounces included). */
function isSameSite(a: string, b: string): boolean {
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

/**
 * Did an ITEM fetch end up on a home/landing page? True only when the requested URL asked for a
 * real path and the fetch finished on a bare root, or on a same-site locale root. The host is not
 * compared for `/`: a bounce to `www.` or to a regional front page is equally not the record.
 * Unparseable input is never a guess — it answers false.
 */
export function isRedirectHome(requestedUrl: string, finalUrl: string | undefined): boolean {
  if (finalUrl === undefined || finalUrl === '') return false;
  const requested = parse(requestedUrl);
  const landed = parse(finalUrl);
  if (requested === undefined || landed === undefined) return false;
  const requestedPath = requested.pathname;
  if (isHomePath(requestedPath)) return false;
  if (isHomePath(landed.pathname)) return true;
  // A locale segment is only a home page on the store's OWN site, and only when the request was not
  // already for one; elsewhere it is just a path.
  return (
    !LOCALE_ROOT.test(requestedPath) &&
    LOCALE_ROOT.test(landed.pathname) &&
    isSameSite(requested.hostname, landed.hostname)
  );
}

/** The page `<title>` text with whitespace collapsed, `undefined` when there is none. */
function titleOf(html: string): string | undefined {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match ? match[1].replace(/\s+/g, ' ').trim() : undefined;
}

/** A marker the declaration really set — a non-empty string. */
function isMarker(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Does this response match the ruleset's declared gone page? The status must be listed AND every
 * declared marker must be present; a declaration with no marker never matches, so a bare status
 * list can never turn a store's real outage into "gone". Rulesets are external code, so the shape
 * is checked, not trusted.
 */
export function matchesGonePage(status: number, html: string | undefined, gonePage: GonePage | undefined): boolean {
  if (gonePage === undefined || html === undefined) return false;
  if (!Array.isArray(gonePage.statuses) || !gonePage.statuses.includes(status)) return false;
  const { titleIncludes, bodyIncludes } = gonePage;
  if (!isMarker(titleIncludes) && !isMarker(bodyIncludes)) return false;
  if (isMarker(titleIncludes) && !(titleOf(html)?.includes(titleIncludes) ?? false)) return false;
  return !isMarker(bodyIncludes) || html.includes(bodyIncludes);
}

/**
 * The gate. Returns the typed failure when the lane's metadata says the record was NOT served, and
 * `undefined` when it says nothing against it (including when it says nothing at all).
 *
 * A failing STATUS wins over a redirect: `404` is the more specific truth about a bounce to the
 * front page than "it landed on the home page", and the ledger's classifier orders redirect_home
 * ABOVE status, so passing both would hide the 404.
 */
export function evaluateRecordFetch(
  url: string,
  meta: RecordFetchMeta,
  transport: string,
  gonePage?: GonePage,
): RecordFetchStatusError | undefined {
  const status = usableStatus(meta.status);
  if (status !== undefined && status >= 400) {
    // A ruleset-declared gone page wins over the status reading: the store's own template says
    // the item is gone, whatever status it chose to serve it with.
    const declaredGone = matchesGonePage(status, meta.html, gonePage);
    // Only a 404 is ambiguous, and only at the stores in the table. A 410 there is an explicit
    // Gone, and a 403 is already the class an entitlement failure belongs in.
    const ambiguousSite = status === 404 && !declaredGone ? ambiguousNotFoundSite(url) : undefined;
    return new RecordFetchStatusError({
      url,
      transport,
      status,
      ...(meta.finalUrl !== undefined ? { finalUrl: meta.finalUrl } : {}),
      ...(ambiguousSite !== undefined ? { deniedOrGoneSite: ambiguousSite } : {}),
      ...(declaredGone ? { declaredGone: true } : {}),
    });
  }
  if (isRedirectHome(url, meta.finalUrl)) {
    return new RecordFetchStatusError({
      url,
      transport,
      ...(status !== undefined ? { status } : {}),
      ...(meta.finalUrl !== undefined ? { finalUrl: meta.finalUrl } : {}),
      redirectedHome: true,
    });
  }
  return undefined;
}
