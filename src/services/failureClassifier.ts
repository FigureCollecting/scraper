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
 *   2. REDIRECT HOME. An item URL that bounced to a landing page is terminal-by-store even though
 *      it usually carries a 200.
 *   3. STATUS, when the transport surfaced one. Rare on the record lane today (the engine's http
 *      fetch is status-blind) — which is exactly why an absent status is honest, never fabricated.
 *   4. ErrorType — the queue's own classification, already load-bearing for retry/backoff.
 *   5. MESSAGE, for the untyped Errors the search fan-out and the crawler still throw.
 *   6. The challenge FLAG, else `other` — the operator's triage bucket.
 *
 * TERMINAL means "the producer has stopped trying for this cycle". Only a terminal outcome is
 * reported: reporting per internal retry would inflate the ledger's `attempts` (which drives the
 * backoff) and turn one failing item into a row that never cools.
 */
import { ConnectError, Code } from '@connectrpc/connect';
import { ChallengeCooldownError } from './challengeCooldown.js';
import { ChallengePageError } from './engineServices/capturingFetch.js';
import { EmptyIngestRecordError } from './scrapeQueue.js';
import { ResidentialEgressUnavailableError } from './residentialEgress.js';
import { ChallengeLaneUnavailableError } from './browserChallenge.js';
import type { ErrorType } from './scrapeQueue.js';

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
   * The producer is going to try again in this cycle. `true` makes the outcome NON-terminal, so the
   * caller must not report it. Absent means the caller is already at its give-up seam.
   */
  willRetry?: boolean;
}

export interface FetchClassification {
  reasonClass: FetchReasonClass;
  /** Echoed only when the caller supplied a real HTTP status (100–599). */
  httpStatus?: number;
  /** True when the producer has stopped trying for this cycle — the ONLY state that may be reported. */
  terminal: boolean;
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
  if (error instanceof EmptyIngestRecordError) return 'ruleset';
  // Both config shortfalls are refusals to SPEND the egress: no proxy wired, or a launch profile
  // that cannot clear the gate. Neither is our parser's fault and neither is the store's — they are
  // an unusable path to the host, which is what `network` names.
  if (error instanceof ResidentialEgressUnavailableError) return 'network';
  if (error instanceof ChallengeLaneUnavailableError) return 'network';
  // The spine REFUSED the record. Its own class, because a human must fix the producer.
  if (error instanceof ConnectError && error.code === Code.InvalidArgument) return 'validation';
  return undefined;
}

/** Step 3 — an upstream status the transport actually surfaced. */
function fromStatus(status: number | undefined): FetchReasonClass | undefined {
  if (status === undefined) return undefined;
  if (status === 404) return 'gone_404';
  if (status === 410) return 'gone_410';
  if (status === 403) return 'http_403';
  if (status === 429) return 'http_429';
  if (status >= 500) return 'http_5xx';
  return undefined;
}

/** Step 4 — the queue's ErrorType, the classification the retry/backoff logic already trusts. */
function fromErrorType(errorType: ErrorType | undefined): FetchReasonClass | undefined {
  switch (errorType) {
    case 'timeout':
      return 'timeout';
    case 'network':
      return 'network';
    case 'rate_limited':
      return 'http_429';
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
 * Step 5 — the untyped Errors. Ordered so a specific marker can never be swallowed by a broader
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
  const reasonClass: FetchReasonClass =
    fromClass(outcome.error) ??
    (outcome.redirectedHome === true ? 'redirect_home' : undefined) ??
    fromStatus(httpStatus) ??
    fromErrorType(outcome.errorType) ??
    fromMessage(messageOf(outcome.error)) ??
    (outcome.challenge === true ? 'challenge' : 'other');

  return {
    reasonClass,
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    terminal: outcome.willRetry !== true,
  };
}
