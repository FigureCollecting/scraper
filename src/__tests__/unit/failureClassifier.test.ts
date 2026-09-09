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
import { ResidentialEgressUnavailableError } from '../../services/residentialEgress.js';
import { ChallengeLaneUnavailableError } from '../../services/browserChallenge.js';

describe('classifyFetchFailure — typed errors (class wins over message text)', () => {
  it('maps a cooldown fast-fail to cooldown', () => {
    const err = new ChallengeCooldownError('anitoysgk.com', 600_000);
    expect(classifyFetchFailure({ error: err })).toEqual({ reasonClass: 'cooldown', terminal: true });
  });

  it('maps a challenge page to challenge even though its message names Cloudflare', () => {
    const err = new ChallengePageError('https://s/x', 'impersonate');
    expect(err.message).toContain('Cloudflare');
    expect(classifyFetchFailure({ error: err })).toEqual({ reasonClass: 'challenge', terminal: true });
  });

  it('maps a persisted-nothing ingest to ruleset', () => {
    const err = new EmptyIngestRecordError('mfc', '123', []);
    expect(classifyFetchFailure({ error: err })).toEqual({ reasonClass: 'ruleset', terminal: true });
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
    expect(classifyFetchFailure({ httpStatus: status as number })).toEqual({ reasonClass, httpStatus: status, terminal: true });
  });

  it('leaves an unmapped 4xx to the other rules but still echoes the status', () => {
    expect(classifyFetchFailure({ httpStatus: 418 })).toEqual({ reasonClass: 'other', httpStatus: 418, terminal: true });
  });

  it('ignores an out-of-band status', () => {
    expect(classifyFetchFailure({ httpStatus: 0 })).toEqual({ reasonClass: 'other', terminal: true });
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

describe('classifyFetchFailure — terminal', () => {
  it('is false while the producer will try again this cycle', () => {
    expect(classifyFetchFailure({ errorType: 'timeout', willRetry: true }).terminal).toBe(false);
  });

  it('is true once the producer has stopped', () => {
    expect(classifyFetchFailure({ errorType: 'timeout', willRetry: false }).terminal).toBe(true);
    expect(classifyFetchFailure({ errorType: 'timeout' }).terminal).toBe(true);
  });
});
