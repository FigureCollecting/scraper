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
const AMBIGUOUS_NOT_FOUND_HOSTS: readonly string[] = ['myfigurecollection.net'];

/** Why a 404 from one of those stores cannot be read as "gone" — carried into the ledger message. */
const DENIED_OR_GONE_NOTE =
  'denied-or-gone (an unentitled NSFW item and a missing item answer alike here; session may need re-minting)';

/** Is this URL's host one of the stores whose 404 is ambiguous? Unparseable input is never a match. */
export function isAmbiguousNotFoundHost(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return AMBIGUOUS_NOT_FOUND_HOSTS.some((known) => host === known || host.endsWith(`.${known}`));
}

/**
 * The response metadata a lane surfaced for one fetch. Both fields are optional: a transport that
 * returns a bare string (every pre-status fetcher, and every test fake shaped like one) observed
 * neither, and an absent field is honest — never a fabricated 200.
 */
export interface RecordFetchMeta {
  status?: number;
  finalUrl?: string;
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
   * {@link AMBIGUOUS_NOT_FOUND_HOSTS}). The ledger books such a row as http_403 — reviewable and
   * re-mintable — instead of gone_404, which would close a live item as removed.
   */
  readonly deniedOrGone: boolean;

  constructor(args: {
    url: string;
    transport: string;
    status?: number;
    finalUrl?: string;
    redirectedHome?: boolean;
    deniedOrGone?: boolean;
  }) {
    const redirectedHome = args.redirectedHome === true;
    const deniedOrGone = args.deniedOrGone === true;
    const what = redirectedHome
      ? `redirected to the store home page ${sanitizeForLog(args.finalUrl ?? '')}`
      : `answered HTTP ${args.status}${deniedOrGone ? `: ${DENIED_OR_GONE_NOTE}` : ''}`;
    super(`Record fetch for ${sanitizeForLog(args.url)} via ${args.transport} transport ${what}.`);
    this.name = 'RecordFetchStatusError';
    this.url = args.url;
    this.transport = args.transport;
    this.status = args.status;
    this.finalUrl = args.finalUrl;
    this.redirectedHome = redirectedHome;
    this.deniedOrGone = deniedOrGone;
  }
}

/** A status a real HTTP response can carry — never a sentinel 0 / NaN / 999 from a defensive read. */
function usableStatus(status: number | undefined): number | undefined {
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : undefined;
}

/** The path of a URL, `undefined` when it will not parse. Query and hash are irrelevant here. */
function pathOf(url: string): string | undefined {
  try {
    return new URL(url).pathname;
  } catch {
    return undefined;
  }
}

/** A bare root — `/` or the empty path a hostname-only URL normalizes to. */
function isHomePath(path: string): boolean {
  return path === '' || path === '/';
}

/**
 * Did an ITEM fetch end up on a home/landing page? True only when the requested URL asked for a
 * real path and the fetch finished on a bare root. The host is deliberately not compared: a bounce
 * to `www.` or to a regional front page is equally not the record. Unparseable input is never a
 * guess — it answers false.
 */
export function isRedirectHome(requestedUrl: string, finalUrl: string | undefined): boolean {
  if (finalUrl === undefined || finalUrl === '') return false;
  const requested = pathOf(requestedUrl);
  const landed = pathOf(finalUrl);
  if (requested === undefined || landed === undefined) return false;
  if (isHomePath(requested)) return false;
  return isHomePath(landed);
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
): RecordFetchStatusError | undefined {
  const status = usableStatus(meta.status);
  if (status !== undefined && status >= 400) {
    // Only a 404 is ambiguous, and only at the stores in the table. A 410 there is an explicit
    // Gone, and a 403 is already the class an entitlement failure belongs in.
    const deniedOrGone = status === 404 && isAmbiguousNotFoundHost(url);
    return new RecordFetchStatusError({
      url,
      transport,
      status,
      ...(meta.finalUrl !== undefined ? { finalUrl: meta.finalUrl } : {}),
      ...(deniedOrGone ? { deniedOrGone: true } : {}),
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
