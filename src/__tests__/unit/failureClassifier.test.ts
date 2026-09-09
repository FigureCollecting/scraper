/**
 * failureClassifier — the pure map from an engine fetch outcome to the ledger's reason class.
 *
 * The table below is driven by the REAL signals the engine produces today: the typed errors
 * (ChallengeCooldownError / ChallengePageError / EmptyIngestRecordError / the two config
 * shortfalls), the queue's own ErrorType, an upstream status when a lane surfaced one, and — for
 * the untyped Errors the search fan-out and the crawler still throw — the exact message strings
 * those paths emit.
 */
import { ConnectError, Code } from '@connectrpc/connect';
import { classifyFetchFailure } from '../../services/failureClassifier.js';
import { ChallengeCooldownError } from '../../services/challengeCooldown.js';
import { ChallengePageError } from '../../services/engineServices/capturingFetch.js';
import { EmptyIngestRecordError } from '../../services/scrapeQueue.js';
import { EmptyExtractionError } from '../../services/engineServices/extractRecords.js';
import { ResidentialEgressUnavailableError } from '../../services/residentialEgress.js';
import { ChallengeLaneUnavailableError } from '../../services/browserChallenge.js';
import { RecordFetchStatusError } from '../../services/recordFetchGate.js';

describe('classifyFetchFailure — typed errors (class wins over message text)', () => {
  it('maps a cooldown fast-fail to cooldown', () => {
    const err = new ChallengeCooldownError('anitoysgk.com', 600_000);
    expect(classifyFetchFailure({ error: err })).toEqual({ reasonClass: 'cooldown' });
  });

  it('maps a challenge page to challenge even though its message names Cloudflare', () => {
    const err = new ChallengePageError('https://s/x', 'impersonate');
    expect(err.message).toContain('Cloudflare');
    expect(classifyFetchFailure({ error: err })).toEqual({ reasonClass: 'challenge' });
  });

  it('maps a persisted-nothing ingest to ruleset', () => {
    const err = new EmptyIngestRecordError('mfc', '123', []);
    expect(classifyFetchFailure({ error: err })).toEqual({ reasonClass: 'ruleset' });
  });

  it('maps both config shortfalls to network', () => {
    expect(classifyFetchFailure({ error: new ResidentialEgressUnavailableError('https://anitoysgk.com/x') }).reasonClass).toBe('network');
    expect(classifyFetchFailure({ error: new ChallengeLaneUnavailableError('https://anitoysgk.com/x') }).reasonClass).toBe('network');
  });

  it('maps a spine INVALID_ARGUMENT to validation', () => {
    const err = new ConnectError('bad record', Code.InvalidArgument);
    expect(classifyFetchFailure({ error: err }).reasonClass).toBe('validation');
  });

  it('does not treat any other ConnectError code as validation', () => {
    expect(classifyFetchFailure({ error: new ConnectError('down', Code.Unavailable) }).reasonClass).toBe('other');
  });
});

describe('classifyFetchFailure — status, when a lane surfaced one', () => {
  it.each([
    [404, 'gone_404'],
    [410, 'gone_410'],
    [403, 'http_403'],
    [429, 'http_429'],
    [500, 'http_5xx'],
    [503, 'http_5xx'],
  ])('maps status %s to %s and echoes the status', (status, reasonClass) => {
    expect(classifyFetchFailure({ httpStatus: status as number })).toEqual({ reasonClass, httpStatus: status });
  });

  it('leaves an unmapped 4xx to the other rules but still echoes the status', () => {
    expect(classifyFetchFailure({ httpStatus: 418 })).toEqual({ reasonClass: 'other', httpStatus: 418 });
  });

  it('ignores an out-of-band status', () => {
    expect(classifyFetchFailure({ httpStatus: 0 })).toEqual({ reasonClass: 'other' });
  });

  it('lets a typed error beat the status', () => {
    const out = classifyFetchFailure({ error: new ChallengeCooldownError('h', 1), httpStatus: 503 });
    expect(out.reasonClass).toBe('cooldown');
    expect(out.httpStatus).toBe(503);
  });
});

describe('classifyFetchFailure — redirect home', () => {
  it('maps a redirect to the store landing page to redirect_home', () => {
    expect(classifyFetchFailure({ redirectedHome: true, httpStatus: 200 }).reasonClass).toBe('redirect_home');
  });
});

describe('classifyFetchFailure — the queue ErrorType', () => {
  it.each([
    ['timeout', 'timeout'],
    ['network', 'network'],
    ['rate_limited', 'http_429'],
    ['not_found', 'gone_404'],
    ['extraction_unavailable', 'ruleset'],
    ['empty_record', 'ruleset'],
    ['auth_required', 'http_403'],
    ['challenge_cooldown', 'cooldown'],
  ] as const)('maps errorType %s to %s', (errorType, reasonClass) => {
    expect(classifyFetchFailure({ errorType }).reasonClass).toBe(reasonClass);
  });

  it('falls through an unknown errorType to the message rules', () => {
    expect(classifyFetchFailure({ errorType: 'unknown', error: new Error('socket hang up') }).reasonClass).toBe('network');
  });

  it('reads a challenge-flagged body as challenge when nothing else classified it', () => {
    expect(classifyFetchFailure({ errorType: 'unknown', challenge: true }).reasonClass).toBe('challenge');
  });
});

describe('classifyFetchFailure — the exact strings the engine throws today', () => {
  it.each([
    // scrapeQueue.ts: the plugin-only shortfall
    ['EXTRACTION_UNAVAILABLE: no plugin ruleset matches https://s/x', 'ruleset'],
    ['EXTRACTION_UNAVAILABLE: no ingest emitter configured (INGEST_BASE_URL unset)', 'ruleset'],
    // assembleLookup.ts withTimeout()
    ['search timed out after 15000ms', 'timeout'],
    ['catalog timed out after 15000ms', 'timeout'],
    // crawler / initiator transport throws
    ['fetch failed', 'network'],
    ['request to https://s/catalog failed, reason: ECONNRESET', 'network'],
    ['This operation was aborted', 'timeout'],
    // the plain-text lanes
    ['Received 404 NOT_FOUND for item', 'gone_404'],
    ['Cloudflare challenge interstitial', 'challenge'],
    ['429 rate limit hit', 'http_429'],
  ])('maps %s to %s', (message, reasonClass) => {
    expect(classifyFetchFailure({ error: new Error(message) }).reasonClass).toBe(reasonClass);
  });

  it('accepts a bare string error', () => {
    expect(classifyFetchFailure({ error: 'search timed out after 1ms' }).reasonClass).toBe('timeout');
  });

  it('classifies an unrecognizable failure as other (the operator triage bucket)', () => {
    expect(classifyFetchFailure({ error: new Error('something odd happened') }).reasonClass).toBe('other');
    expect(classifyFetchFailure({}).reasonClass).toBe('other');
  });
});

describe('classifyFetchFailure — the classification carries nothing it cannot know', () => {
  it('returns only the reason class and, when there is one, the status', () => {
    // TERMINALITY is a property of the CALL SITE, not of the outcome: every emit point sits at its
    // producer's give-up seam. A flag here would only have restated that placement, unchecked.
    expect(Object.keys(classifyFetchFailure({ errorType: 'timeout' }))).toEqual(['reasonClass']);
    expect(Object.keys(classifyFetchFailure({ httpStatus: 503 })).sort()).toEqual(['httpStatus', 'reasonClass']);
  });
});

describe('classifyFetchFailure — the record lane extraction family', () => {
  it('maps an EmptyExtractionError to ruleset, not the triage bucket', () => {
    const err = new EmptyExtractionError('mfc@0.9.15');
    expect(classifyFetchFailure({ error: err, errorType: 'unknown' }).reasonClass).toBe('ruleset');
  });

  it('maps a D11 guard violation to parse — our selector, our queue', () => {
    const err = new Error('[EXTRACT RECORDS] mfc@0.9.15: record[2] has no source.itemId');
    expect(classifyFetchFailure({ error: err, errorType: 'unknown' }).reasonClass).toBe('parse');
  });

  it('never lets extraction text posing as a store verdict become gone_404', () => {
    // classifyError reads "not found" anywhere in the text as errorType 'not_found'; an extraction
    // fault is OURS and must never be closed as "the store removed it".
    const err = new Error('[EXTRACT RECORDS] mfc@0.9.15: selector .price not found');
    expect(classifyFetchFailure({ error: err, errorType: 'not_found' }).reasonClass).toBe('parse');
  });

  it('maps the ExtractContext shortfall to parse', () => {
    const err = new Error('[EXTRACT CONTEXT] mfc@0.9.15: context query produced nothing');
    expect(classifyFetchFailure({ error: err }).reasonClass).toBe('parse');
  });
});

describe('classifyFetchFailure — a Cloudflare block folded into rate_limited', () => {
  it('recovers challenge from the message the queue coarsened to rate_limited', () => {
    // scrapeQueue's classifyError maps any 'Cloudflare' text to ErrorType 'rate_limited'; the two
    // need DIFFERENT spine policies (challenge escalates to review at 3, a 429 rides the transient
    // ladder), so the distinction must survive.
    const err = new Error('Cloudflare challenge on a cookied lane');
    expect(classifyFetchFailure({ error: err, errorType: 'rate_limited' }).reasonClass).toBe('challenge');
  });

  it('recovers challenge from a challenge-flagged body under rate_limited', () => {
    expect(classifyFetchFailure({ errorType: 'rate_limited', challenge: true }).reasonClass).toBe('challenge');
  });

  it('leaves a real rate limit as http_429', () => {
    const err = new Error('rate limit hit, slow down');
    expect(classifyFetchFailure({ error: err, errorType: 'rate_limited' }).reasonClass).toBe('http_429');
  });
});

/**
 * The RECORD lane's own status failures (R1). The queue raises a typed RecordFetchStatusError the
 * moment a lane reports a response the record cannot come from, and hands the classifier what that
 * error OBSERVED — its status, or the fact that the fetch ended on the store's front page. These
 * cases pin the exact shape the queue passes, so the ledger's verdict on a store's answer can never
 * drift back into `other` or into a verdict against our own ruleset.
 */
describe('classifyFetchFailure — record-lane status failures', () => {
  const statusError = (args: { status?: number; finalUrl?: string; redirectedHome?: boolean }) =>
    new RecordFetchStatusError({ url: 'https://store.test/product/1', transport: 'http', ...args });

  it.each([
    [404, 'gone_404'],
    [410, 'gone_410'],
    [403, 'http_403'],
    [429, 'http_429'],
    [500, 'http_5xx'],
    [503, 'http_5xx'],
  ])('books a %s answer as %s and echoes the status', (status, reasonClass) => {
    const error = statusError({ status });
    expect(classifyFetchFailure({ error, errorType: 'unknown', httpStatus: error.status })).toEqual({
      reasonClass,
      httpStatus: status,
    });
  });

  it('books a bounce to the store home page as redirect_home', () => {
    const error = statusError({ status: 200, finalUrl: 'https://store.test/', redirectedHome: true });
    expect(
      classifyFetchFailure({ error, errorType: 'not_found', httpStatus: error.status, redirectedHome: true }).reasonClass,
    ).toBe('redirect_home');
  });

  it("keeps the STORE's status over the queue's coarser ErrorType (a 5xx is not a gone item)", () => {
    // classifyError maps a 5xx to 'network' for retry purposes; the ledger must still say http_5xx.
    const error = statusError({ status: 503 });
    expect(classifyFetchFailure({ error, errorType: 'network', httpStatus: 503 }).reasonClass).toBe('http_5xx');
  });

  it('falls back to the status IN the message if a caller forgets to pass it (never `other`)', () => {
    expect(classifyFetchFailure({ error: statusError({ status: 404 }) }).reasonClass).toBe('gone_404');
  });
});

/**
 * THE AMBIGUOUS 404 (owner rule, 2026-09-09). On myfigurecollection.net a 404 may be an unentitled
 * NSFW item rather than a missing one, so the row must NOT be gone_404 — that class is what closes
 * a target as removed. It is booked as http_403 instead: reviewable, re-mintable, never auto-closed.
 */
describe('classifyFetchFailure — denied-or-gone', () => {
  it('books an ambiguous 404 as http_403 while still echoing the real status', () => {
    expect(classifyFetchFailure({ httpStatus: 404, deniedOrGone: true })).toEqual({
      reasonClass: 'http_403',
      httpStatus: 404,
    });
  });

  it('wins over the status reading that would have closed the target as gone', () => {
    const error = new RecordFetchStatusError({
      url: 'https://myfigurecollection.net/item/999999999',
      transport: 'impersonate',
      status: 404,
      deniedOrGone: true,
    });
    expect(classifyFetchFailure({ error, errorType: 'auth_required', httpStatus: 404, deniedOrGone: true }).reasonClass)
      .toBe('http_403');
  });

  it('leaves an UNAMBIGUOUS 404 as gone_404', () => {
    expect(classifyFetchFailure({ httpStatus: 404, deniedOrGone: false }).reasonClass).toBe('gone_404');
  });

  it('never invents the class for a non-404 (the flag only ever rides a 404)', () => {
    expect(classifyFetchFailure({ httpStatus: 503 }).reasonClass).toBe('http_5xx');
  });
});
