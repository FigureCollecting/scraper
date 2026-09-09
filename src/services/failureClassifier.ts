/**
 * failureClassifier — the PURE map from one engine fetch outcome to the fetch-failure ledger's
 * reason class (ingest.v1.FetchReasonClass / migration 0020's `fetch_failure_reason`).
 *
 * WHY ITS OWN MODULE: the reason class decides RETRY vs REVIEW on the spine, so it is the one piece
 * of this feature that must be exhaustively testable — and the queue that produces most of its
 * inputs is 1800 lines with a browser pool behind it. Nothing here fetches, logs, or reads a clock.
 *
 * CLASSIFICATION ORDER (each step wins over every step below it):
 *   1. CLASS. A typed engine error's taxonomy must never depend on free text in its message — the
 *      same RS-2 rule scrapeQueue's own classifyError follows. ChallengePageError's message NAMES
 *      Cloudflare, EmptyIngestRecordError's carries server warnings; neither may be re-read.
 *   2. EXTRACTION. The record lane's own '[EXTRACT …]' family — ours to fix, never a store verdict.
 *   3. REDIRECT HOME. An item URL that bounced to a landing page is terminal-by-store even though
 *      it usually carries a 200.
 *   4. DENIED-OR-GONE. A 404 from a store where 404 also means "not entitled" (mfc's NSFW items)
 *      must never be read as gone — it outranks the status reading it would otherwise get.
 *   5. STATUS, when the transport surfaced one. Every ingest lane surfaces it now; the search and
 *      listing lanes still do not, which is why an absent status stays honest, never fabricated.
 *   6. ErrorType — the queue's own classification, already load-bearing for retry/backoff.
 *   7. MESSAGE, for the untyped Errors the search fan-out and the crawler still throw.
 *   8. The challenge FLAG, else `other` — the operator's triage bucket.
 *
 * TERMINALITY is NOT modelled here, deliberately: it is a property of the CALL SITE, not of the
 * outcome. Every emit point sits at its producer's give-up seam (the queue's gave-up branch, the
 * crawler's axis stop, the fan-out's per-store catch). Reporting per internal retry would inflate
 * the ledger's `attempts` — which drives the spine's backoff — and turn one failing item into a row
 * that never cools; that discipline lives where the calls are made.
 */
import { ConnectError, Code } from '@connectrpc/connect';
import { ChallengeCooldownError } from './challengeCooldown.js';
import { ChallengePageError } from './engineServices/capturingFetch.js';
import { EmptyExtractionError } from './engineServices/extractRecords.js';
import { ResidentialEgressUnavailableError } from './residentialEgress.js';
import { ChallengeLaneUnavailableError } from './browserChallenge.js';
import type { ErrorType } from './scrapeQueue.js';

/**
 * Match one of the engine's own error classes by its DECLARED name. Used only where a value import
 * would be a liability: scrapeQueue imports THIS module, so importing its EmptyIngestRecordError
 * back would be a cycle — and would drag the whole engine graph (genericScraper -> puppeteer,
 * s3ObjectStore -> minio) into the two CronJob CLIs, which never open a browser or an object store.
 * `name` is the class's own declared identity, not free text: nothing else in the estate sets it.
 */
function isNamed(error: unknown, name: string): boolean {
  return error instanceof Error && error.name === name;
}

/** The ledger's reason vocabulary — 1:1 with `fetch_failure_reason` (migration 0020). */
export type FetchReasonClass =
  | 'challenge'
  | 'cooldown'
  | 'timeout'
  | 'http_5xx'
  | 'http_429'
  | 'http_403'
  | 'network'
  | 'gone_404'
  | 'gone_410'
  | 'redirect_home'
  | 'parse'
  | 'ruleset'
  | 'validation'
  | 'other';

/** What the producer observed. Every field is optional: a caller supplies only what it truly knows. */
export interface FetchOutcome {
  /** The thrown error, when the failure surfaced as one (an Error, a string, or anything). */
  error?: unknown;
  /** The scrape queue's own classification, when the caller has one. */
  errorType?: ErrorType;
  /** The upstream HTTP status, when the lane surfaced one. */
  httpStatus?: number;
  /** The transport FLAGGED the body as a Cloudflare interstitial (CapturingFetchResult.challenge). */
  challenge?: boolean;
  /** The fetch ended on the store's home/landing page instead of the requested item. */
  redirectedHome?: boolean;
  /**
   * The status was a 404 from a store where a 404 does NOT prove the item is gone (an unentitled
   * NSFW item on mfc answers exactly like a missing one). Set by the record gate's ambiguity table.
   */
  deniedOrGone?: boolean;
}

export interface FetchClassification {
  reasonClass: FetchReasonClass;
  /** Echoed only when the caller supplied a real HTTP status (100–599). */
  httpStatus?: number;
}

/** The message text of whatever was thrown, `''` when there is nothing to read. */
function messageOf(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return '';
}

/** A status the ledger may record: a real HTTP code, never a sentinel 0 / NaN / 999. */
function usableStatus(status: number | undefined): number | undefined {
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : undefined;
}

/** Step 1 — the typed engine errors. Class wins; the message is never consulted. */
function fromClass(error: unknown): FetchReasonClass | undefined {
  if (error instanceof ChallengeCooldownError) return 'cooldown';
  if (error instanceof ChallengePageError) return 'challenge';
  if (isNamed(error, 'EmptyIngestRecordError')) return 'ruleset';
  // Both config shortfalls are refusals to SPEND the egress: no proxy wired, or a launch profile
  // that cannot clear the gate. Neither is our parser's fault and neither is the store's — they are
  // an unusable path to the host, which is what `network` names.
  if (error instanceof ResidentialEgressUnavailableError) return 'network';
  if (error instanceof ChallengeLaneUnavailableError) return 'network';
  // The spine REFUSED the record. Its own class, because a human must fix the producer.
  if (error instanceof ConnectError && error.code === Code.InvalidArgument) return 'validation';
  return undefined;
}

/**
 * Step 2 — the record lane's EXTRACTION family. scrapeQueue rethrows these raw (scrapeQueue.ts's
 * non-challenge branch), and their free text would otherwise be read as a STORE verdict: a guard
 * violation naming a selector "not found" becomes ErrorType 'not_found' -> gone_404 -> closed as
 * "the store removed it", and everything else falls to the `other` triage bucket. Extraction is
 * OURS: an empty lift is a `ruleset` gap, a violated guard is a `parse` fault. Both go to review.
 */
function fromExtraction(error: unknown): FetchReasonClass | undefined {
  if (error instanceof EmptyExtractionError) return 'ruleset';
  // The engine prefixes every extraction throw with its stage marker; nothing else in the estate
  // emits it, so the prefix is a TAXONOMY token, not free text.
  return messageOf(error).startsWith('[EXTRACT ') ? 'parse' : undefined;
}

/**
 * Step 4 — the AMBIGUOUS 404. `gone_404` is the class that CLOSES a target as removed, so a 404 that
 * might equally be an entitlement denial (mfc's NSFW / NSFW+ items answer 404 to an unentitled
 * session, indistinguishably from a missing item) must not take it. It is booked as `http_403`: the
 * class for a door that was closed to us — reviewable, re-mintable, never auto-closed. The real
 * status is still echoed on the row, so the operator sees the 404 that was actually served.
 */
function fromDeniedOrGone(deniedOrGone: boolean | undefined): FetchReasonClass | undefined {
  return deniedOrGone === true ? 'http_403' : undefined;
}

/** Step 5 — an upstream status the transport actually surfaced. */
function fromStatus(status: number | undefined): FetchReasonClass | undefined {
  if (status === undefined) return undefined;
  if (status === 404) return 'gone_404';
  if (status === 410) return 'gone_410';
  if (status === 403) return 'http_403';
  if (status === 429) return 'http_429';
  if (status >= 500) return 'http_5xx';
  return undefined;
}

/** Step 6 — the queue's ErrorType, the classification the retry/backoff logic already trusts. */
function fromErrorType(
  errorType: ErrorType | undefined,
  message: string,
  challenge: boolean,
): FetchReasonClass | undefined {
  switch (errorType) {
    case 'timeout':
      return 'timeout';
    case 'network':
      return 'network';
    case 'rate_limited':
      // classifyError folds a Cloudflare block INTO rate_limited (its message rule names both), and
      // the queue's own RT-1 branch re-detects it by the same text. The two classes need different
      // spine policies — a challenge escalates to review after 3 attempts, a 429 rides the 10-attempt
      // transient ladder — so recover here what the coarse ErrorType lost. Seven extra CF fetches per
      // target is a real cost against the estate's scarcest resource, the egress IP's reputation.
      return challenge || /cloudflare|just a moment/i.test(message) ? 'challenge' : 'http_429';
    case 'not_found':
      return 'gone_404';
    // A missing emitter, an unmatched ruleset, and a persisted-nothing ingest are all OUR coverage
    // gap: the store answered, we could not turn the answer into rows.
    case 'extraction_unavailable':
    case 'empty_record':
      return 'ruleset';
    case 'auth_required':
      return 'http_403';
    case 'challenge_cooldown':
      return 'cooldown';
    default:
      return undefined;
  }
}

/**
 * Step 7 — the untyped Errors. Ordered so a specific marker can never be swallowed by a broader
 * one: the config shortfall's own token first, then the timeout spelling withTimeout() emits, then
 * the status-in-text spellings, then the transport faults.
 */
function fromMessage(message: string): FetchReasonClass | undefined {
  if (!message) return undefined;
  if (message.includes('EXTRACTION_UNAVAILABLE')) return 'ruleset';
  if (/timed out|timeout|ETIMEDOUT|was aborted|AbortError/i.test(message)) return 'timeout';
  if (/\b410\b|GONE/.test(message)) return 'gone_410';
  if (/\b404\b|NOT_FOUND|not found/i.test(message)) return 'gone_404';
  if (/\b429\b|RATE_LIMIT|rate limit/i.test(message)) return 'http_429';
  if (/cloudflare|challenge/i.test(message)) return 'challenge';
  if (/\b403\b|FORBIDDEN/i.test(message)) return 'http_403';
  if (/ECONN|ENOTFOUND|EAI_AGAIN|EPIPE|ERR_|socket hang up|fetch failed|disconnected|network/i.test(message)) {
    return 'network';
  }
  return undefined;
}

/**
 * Classify one fetch outcome. Pure: same outcome in, same classification out, no clock and no I/O.
 */
export function classifyFetchFailure(outcome: FetchOutcome): FetchClassification {
  const httpStatus = usableStatus(outcome.httpStatus);
  const message = messageOf(outcome.error);
  const reasonClass: FetchReasonClass =
    fromClass(outcome.error) ??
    fromExtraction(outcome.error) ??
    (outcome.redirectedHome === true ? 'redirect_home' : undefined) ??
    fromDeniedOrGone(outcome.deniedOrGone) ??
    fromStatus(httpStatus) ??
    fromErrorType(outcome.errorType, message, outcome.challenge === true) ??
    fromMessage(message) ??
    (outcome.challenge === true ? 'challenge' : 'other');

  return {
    reasonClass,
    ...(httpStatus !== undefined ? { httpStatus } : {}),
  };
}
