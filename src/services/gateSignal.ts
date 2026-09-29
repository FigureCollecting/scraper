/**
 * gateSignal — a GATED host answering an EMPTY body or a 5xx is a gate signal, never a clean fetch.
 *
 * WHY (the 2026-09-29 mfc incident): impit through the residential exit got HTTP 500 with a 0-byte
 * body on every item. That body is not a Cloudflare interstitial, so no lane flagged it, and the
 * queue treated it as a clean fetch: it cleared the host's cooldown and marked its stored cookies
 * FRESH, then retried every item to exhaustion. /health/detailed stayed green while ~700 refused
 * requests an hour left the home IP carrying the scrape account's login.
 *
 * THE RULE, used at every site that marks a host FRESH or clears its cooldown after a fetch:
 *   - CLEAN = a 2xx status, a non-empty body, and not a flagged challenge. Nothing else is proof.
 *     A site that cannot see a status at all (`statusBlind`: the browser lane at /lookup and
 *     /catalog, a bare-body composition) can never prove CLEAN: a refusal page with a body looks
 *     exactly like a real one there. (The ingest queue's lanes all surface a status; when one
 *     observed none — a browser navigation with no response — the queue still judges the body.)
 *   - GATE FAILURE = not a flagged challenge (that keeps its own one-shot path), and an empty body or
 *     a 5xx. An EMPTY 404 / 410 is the store's own "gone" answer, not a refused gate. It only COUNTS
 *     on a GATED host: one with stored cookies in the CfCookieStore, whose profile declares access
 *     'cloudflare', or that leaves through the RESIDENTIAL exit (the thing at risk there is Ross's
 *     home IP). Elsewhere a 5xx stays the transient upstream it always was.
 *   - A gate failure marks the stored cookies STALE (→ /health/detailed cfCookies[].stale) and adds a
 *     strike to the host's run in the SHARED ChallengeCooldown; N in a row open that host's existing
 *     cooldown (ChallengeCooldown.recordGateFailure). A clean fetch resets the run.
 */
import type { SearchFetch } from '@figurecollecting/scraper-plugin-contract';
import type { ChallengeCooldown } from './challengeCooldown.js';
import { markStaleIfStored, type CfCookieSource, type CfCookieStoreLike } from './cookieJar.js';

/** What a fetch site knows about one response. */
export interface GateOutcome {
  /** The upstream status, when the lane observed one. Absent ⇒ status-blind lane. */
  status?: number;
  body: string;
  /** The lane flagged the body as a Cloudflare challenge/block interstitial. */
  challenge?: boolean;
  /**
   * The SITE could not see a status (a bare-body lane). Its body can still prove an EMPTY answer
   * (a gate failure), but never a clean fetch: it neither resets the run nor may mark FRESH.
   */
  statusBlind?: boolean;
}

/** What one response proved about the host's gate. */
export type GateVerdict = 'clean' | 'gate_failure' | 'challenge' | 'other';

/** An empty body: zero bytes or whitespace only. A non-string (untrusted transport output) reads as empty. */
export function isEmptyBody(body: string): boolean {
  return typeof body !== 'string' || !/\S/.test(body);
}

function is2xx(status: number | undefined): boolean {
  return status === undefined || (status >= 200 && status <= 299);
}

/** The ONLY response that may mark a host FRESH or clear its cooldown. */
export function isCleanFetch(o: GateOutcome): boolean {
  return o.challenge !== true && o.statusBlind !== true && is2xx(o.status) && !isEmptyBody(o.body);
}

/** The store's own "this item is gone" answers: empty or not, they say nothing about the gate. */
function isGoneStatus(status: number | undefined): boolean {
  return status === 404 || status === 410;
}

/** A 5xx, or an empty body that is not a "gone" answer, that is not a flagged challenge. */
export function isGateFailure(o: GateOutcome): boolean {
  if (o.challenge === true) return false;
  if (o.status !== undefined && o.status >= 500) return true;
  return isEmptyBody(o.body) && !isGoneStatus(o.status);
}

/**
 * A host the engine has a gate for: stored cookies, a declared Cloudflare gate on its profile, or the
 * residential exit. The last matters because rulesets projects `access` onto searchFetch only for
 * browser-lane profiles — mfc (impersonate + residential) was otherwise gated only while the
 * cf-cookies Secret held a jar for it — and what a refusing gate burns there is Ross's home IP.
 */
export function isGatedHost(store: CfCookieSource, url: string, searchFetch?: SearchFetch): boolean {
  return store.cookiesFor(url) !== undefined || searchFetch?.access === 'cloudflare' || searchFetch?.egress === 'residential';
}

/**
 * A /lookup or /catalog fetch result as a GateOutcome. A bare body (the browser lane, a bare-body
 * composition) or a detail with no status is STATUS-BLIND; a detail with a status carries it.
 */
export function gateOutcomeOf(fetched: string | { body: string; status?: number }): GateOutcome {
  if (typeof fetched === 'string') return { body: fetched, statusBlind: true };
  return fetched.status === undefined ? { body: fetched.body, statusBlind: true } : { body: fetched.body, status: fetched.status };
}

/** The operator-facing reason: lane, status, and whether the body was empty. */
export function gateFailureReason(o: GateOutcome, lane: string): string {
  const status = o.status !== undefined ? `HTTP ${o.status}` : 'no status';
  return `gate failure via ${lane} transport: ${status}${isEmptyBody(o.body) ? ' with an empty body' : ''}`;
}

/**
 * Judge one response at a fetch site and move the gate state. On CLEAN the host's run is reset and
 * the caller keeps its own FRESH / cooldown-clear step (and its own guards). On a GATE FAILURE of a
 * gated host the stored cookies are marked stale and a strike is recorded (N opens the cooldown).
 * A flagged challenge and every other answer (a 404, a non-empty 403, a 5xx from a non-gated host,
 * a status-blind body) move nothing.
 */
export function observeGate(
  deps: { cooldown: ChallengeCooldown; store: CfCookieStoreLike },
  fetch: GateOutcome & { url: string; host: string; lane: string; searchFetch?: SearchFetch },
): GateVerdict {
  if (fetch.challenge === true) return 'challenge';
  if (isCleanFetch(fetch)) {
    deps.cooldown.resetGateFailures(fetch.host);
    return 'clean';
  }
  if (!isGateFailure(fetch) || !isGatedHost(deps.store, fetch.url, fetch.searchFetch)) return 'other';
  const reason = gateFailureReason(fetch, fetch.lane);
  markStaleIfStored(deps.store, fetch.url, fetch.host, fetch.lane, reason);
  deps.cooldown.recordGateFailure(fetch.host, reason);
  return 'gate_failure';
}
