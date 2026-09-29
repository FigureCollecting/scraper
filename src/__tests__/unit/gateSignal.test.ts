/**
 * gateSignal — a GATED host answering an EMPTY body or a 5xx is a gate signal, never a clean fetch.
 *
 * The 2026-09-29 mfc incident: impit through the residential exit got HTTP 500 with a 0-byte body on
 * every item. The body was not a flagged challenge, so the queue logged "[CF-COOKIE] FRESH" and
 * "[COOLDOWN] cleared", /health/detailed stayed green, and ~700 refused requests an hour kept
 * leaving Ross's home IP with the scrape account's login.
 *
 * Pins:
 *   - isCleanFetch: 2xx (or a lane that surfaced no status) + a non-empty body + not a flagged
 *     challenge. Nothing else may mark a host FRESH or clear its cooldown.
 *   - isGateFailure: an empty body, or a 5xx, that is not a flagged challenge.
 *   - isGatedHost: stored cookies in the CfCookieStore, OR the profile declares access 'cloudflare',
 *     OR the store fetches through the residential exit (egress 'residential').
 *   - ChallengeCooldown.recordGateFailure: N consecutive failures (env-configurable, default 5) open
 *     the EXISTING cooldown with its existing window; a clean fetch resets the run.
 *   - observeGate: the one call a fetch site makes — stale mark + strike on a gated host, reset on clean.
 */
import { ChallengeCooldown } from '../../services/challengeCooldown';
import {
  isEmptyBody,
  isCleanFetch,
  isGateFailure,
  isGatedHost,
  gateFailureReason,
  gateOutcomeOf,
  observeGate,
} from '../../services/gateSignal';

const HOST = 'gated.example.test';
const URL_ = `https://${HOST}/item/1`;
const BODY = '<html><body>real page</body></html>';
const MIN = 60_000;

function fakeStore(hosts: string[]) {
  const has = (url: string) => {
    try { return hosts.includes(new URL(url).hostname.toLowerCase().replace(/^www\./, '')); } catch { return false; }
  };
  return {
    cookiesFor: jest.fn((url: string) => (has(url) ? { cf_clearance: 'FAKE_cf_1' } : undefined)),
    userAgentFor: jest.fn(() => undefined),
    markStale: jest.fn(() => true),
    markFresh: jest.fn(() => true),
  };
}

describe('gateSignal — what counts as a clean fetch', () => {
  it.each([
    ['', true],
    ['   \n\t ', true],
    [BODY, false],
  ])('isEmptyBody(%j) === %s', (body, empty) => {
    expect(isEmptyBody(body)).toBe(empty);
  });

  it('a non-string body reads as empty (untrusted transport output never proves a page)', () => {
    expect(isEmptyBody(undefined as unknown as string)).toBe(true);
  });

  it.each([
    [200, true],
    [204, false], // 2xx but empty body
    [299, true],
    [undefined, true], // status-blind lane: the body test still applies
    [301, false],
    [404, false],
    [500, false],
    [503, false],
  ])('isCleanFetch({status: %s, non-empty body}) — 2xx or no status only', (status, clean) => {
    const body = status === 204 ? '' : BODY;
    expect(isCleanFetch({ status, body })).toBe(clean);
  });

  it('an EMPTY 200 is never clean, and neither is a flagged challenge', () => {
    expect(isCleanFetch({ status: 200, body: '' })).toBe(false);
    expect(isCleanFetch({ body: '' })).toBe(false);
    expect(isCleanFetch({ status: 200, body: BODY, challenge: true })).toBe(false);
  });

  it('the incident response — an empty HTTP 500 — is NOT clean and IS a gate failure', () => {
    expect(isCleanFetch({ status: 500, body: '' })).toBe(false);
    expect(isGateFailure({ status: 500, body: '' })).toBe(true);
  });

  it.each([
    [{ status: 500, body: BODY }, true],
    [{ status: 502, body: '' }, true],
    [{ status: 200, body: '' }, true],
    [{ body: '' }, true],
    [{ status: 200, body: BODY }, false],
    [{ status: 404, body: BODY }, false], // a store's own answer, not a gate signal
    [{ status: 403, body: BODY }, false],
    [{ status: 503, body: BODY, challenge: true }, false], // a challenge keeps its OWN path
  ])('isGateFailure(%j) === %s', (outcome, failure) => {
    expect(isGateFailure(outcome)).toBe(failure);
  });

  it('gateFailureReason names the lane, the status and the empty body', () => {
    expect(gateFailureReason({ status: 500, body: '' }, 'impersonate')).toBe('gate failure via impersonate transport: HTTP 500 with an empty body');
    expect(gateFailureReason({ status: 502, body: BODY }, 'http')).toBe('gate failure via http transport: HTTP 502');
    expect(gateFailureReason({ body: '' }, 'browser')).toBe('gate failure via browser transport: no status with an empty body');
  });
});

describe('gateSignal — isGatedHost', () => {
  it('a host WITH stored cookies is gated', () => {
    expect(isGatedHost(fakeStore([HOST]), URL_)).toBe(true);
  });

  it('a profile declaring access "cloudflare" is gated even without stored cookies', () => {
    expect(isGatedHost(fakeStore([]), URL_, { transport: 'browser', access: 'cloudflare' })).toBe(true);
  });

  it('neither signal → not gated', () => {
    expect(isGatedHost(fakeStore([]), URL_)).toBe(false);
    expect(isGatedHost(fakeStore([]), URL_, { transport: 'impersonate' })).toBe(false);
  });
});

describe('ChallengeCooldown — consecutive gate failures open the EXISTING cooldown', () => {
  afterEach(() => {
    delete process.env.GATE_FAILURE_COOLDOWN_THRESHOLD;
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('defaults to 5: four failures leave the host open, the fifth opens the cooldown with the existing window', () => {
    const t = 1_000_000;
    const cd = new ChallengeCooldown({ now: () => t, windowMs: 10 * MIN });
    for (let i = 1; i <= 4; i++) {
      expect(cd.recordGateFailure(HOST, 'r')).toEqual({ count: i });
      expect(cd.isOpen(HOST)).toBe(false);
    }
    const fifth = cd.recordGateFailure(HOST, 'gate failure via impersonate transport: HTTP 500 with an empty body');
    expect(fifth.count).toBe(5);
    expect(fifth.opened).toMatchObject({ host: HOST, until: t + 10 * MIN });
    expect(cd.isOpen(HOST)).toBe(true);
    expect(cd.remaining(HOST)).toBe(10 * MIN);
    expect(cd.list()).toEqual([
      { host: HOST, remainingMs: 10 * MIN, reason: '5 consecutive gate failures (gate failure via impersonate transport: HTTP 500 with an empty body)' },
    ]);
    expect(cd.gateFailureCount(HOST)).toBe(5);
  });

  it('a clean fetch resets the run: failures must be CONSECUTIVE', () => {
    const cd = new ChallengeCooldown({ now: () => 1, windowMs: MIN, gateFailureThreshold: 3 });
    cd.recordGateFailure(HOST, 'r');
    cd.recordGateFailure(HOST, 'r');
    expect(cd.resetGateFailures(HOST)).toBe(true);
    expect(cd.gateFailureCount(HOST)).toBe(0);
    expect(cd.resetGateFailures(HOST)).toBe(false); // nothing left to reset
    cd.recordGateFailure(HOST, 'r');
    cd.recordGateFailure(HOST, 'r');
    expect(cd.isOpen(HOST)).toBe(false);
    expect(cd.recordGateFailure(HOST, 'r').opened).toBeDefined();
    expect(cd.isOpen(HOST)).toBe(true);
  });

  it('host keys normalize (www. / case), like every other cooldown key', () => {
    const cd = new ChallengeCooldown({ now: () => 1, windowMs: MIN, gateFailureThreshold: 2 });
    cd.recordGateFailure(`www.${HOST.toUpperCase()}`, 'r');
    expect(cd.recordGateFailure(HOST, 'r').opened).toBeDefined();
  });

  it('a failure while the window is already open does not re-open (no window extension, no log spam)', () => {
    const cd = new ChallengeCooldown({ now: () => 1, windowMs: MIN, gateFailureThreshold: 1 });
    expect(cd.recordGateFailure(HOST, 'r').opened).toBeDefined();
    expect(cd.recordGateFailure(HOST, 'r')).toEqual({ count: 2 });
  });

  it('the run survives the window: the first failure AFTER expiry re-opens at once (one probe per window)', () => {
    let t = 1_000_000;
    const cd = new ChallengeCooldown({ now: () => t, windowMs: MIN, gateFailureThreshold: 2 });
    cd.recordGateFailure(HOST, 'r');
    cd.recordGateFailure(HOST, 'r');
    expect(cd.isOpen(HOST)).toBe(true);
    t += MIN; // expired
    expect(cd.isOpen(HOST)).toBe(false);
    expect(cd.recordGateFailure(HOST, 'r').opened).toBeDefined();
    expect(cd.isOpen(HOST)).toBe(true);
  });

  it.each([
    ['3', 3],
    [' 7 ', 7],
    ['', 5],
    ['0', 5],
    ['-2', 5],
    ['2.5', 5],
    ['abc', 5],
  ])('GATE_FAILURE_COOLDOWN_THRESHOLD=%j → threshold %s', (raw, threshold) => {
    process.env.GATE_FAILURE_COOLDOWN_THRESHOLD = raw;
    const cd = new ChallengeCooldown({ now: () => 1, windowMs: MIN });
    for (let i = 1; i < threshold; i++) cd.recordGateFailure(HOST, 'r');
    expect(cd.isOpen(HOST)).toBe(false);
    cd.recordGateFailure(HOST, 'r');
    expect(cd.isOpen(HOST)).toBe(true);
  });

  it('an explicit option beats the env; an invalid option falls back to the default', () => {
    process.env.GATE_FAILURE_COOLDOWN_THRESHOLD = '9';
    const explicit = new ChallengeCooldown({ now: () => 1, windowMs: MIN, gateFailureThreshold: 1 });
    expect(explicit.recordGateFailure(HOST, 'r').opened).toBeDefined();
    const invalid = new ChallengeCooldown({ now: () => 1, windowMs: MIN, gateFailureThreshold: 0 });
    for (let i = 1; i < 5; i++) invalid.recordGateFailure(HOST, 'r');
    expect(invalid.isOpen(HOST)).toBe(false);
    expect(invalid.recordGateFailure(HOST, 'r').opened).toBeDefined();
  });
});

describe('observeGate — the one call a fetch site makes after a non-challenge response', () => {
  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  const fetchOf = (o: { status?: number; body: string; challenge?: boolean; access?: 'cloudflare' }) => ({
    url: URL_,
    host: HOST,
    lane: 'impersonate',
    ...(o.access ? { searchFetch: { transport: 'browser' as const, access: o.access } } : {}),
    ...(o.status !== undefined ? { status: o.status } : {}),
    body: o.body,
    ...(o.challenge ? { challenge: true } : {}),
  });

  it('clean → "clean", resets the run, marks nothing stale (the caller owns FRESH / clear)', () => {
    const cooldown = new ChallengeCooldown({ now: () => 1, windowMs: MIN });
    const store = fakeStore([HOST]);
    cooldown.recordGateFailure(HOST, 'r');
    expect(observeGate({ cooldown, store }, fetchOf({ status: 200, body: BODY }))).toBe('clean');
    expect(cooldown.gateFailureCount(HOST)).toBe(0);
    expect(store.markStale).not.toHaveBeenCalled();
    expect(store.markFresh).not.toHaveBeenCalled();
  });

  it('empty 500 on a host WITH stored cookies → "gate_failure": stale with the reason, one strike', () => {
    const cooldown = new ChallengeCooldown({ now: () => 1, windowMs: MIN });
    const store = fakeStore([HOST]);
    expect(observeGate({ cooldown, store }, fetchOf({ status: 500, body: '' }))).toBe('gate_failure');
    expect(store.markStale).toHaveBeenCalledWith(HOST, 'impersonate', 'gate failure via impersonate transport: HTTP 500 with an empty body');
    expect(store.markFresh).not.toHaveBeenCalled();
    expect(cooldown.gateFailureCount(HOST)).toBe(1);
  });

  it('access "cloudflare" host without cookies → strike counted (nothing to mark stale in the jar)', () => {
    const cooldown = new ChallengeCooldown({ now: () => 1, windowMs: MIN, gateFailureThreshold: 1 });
    const store = fakeStore([]);
    expect(observeGate({ cooldown, store }, fetchOf({ status: 503, body: BODY, access: 'cloudflare' }))).toBe('gate_failure');
    expect(store.markStale).not.toHaveBeenCalled();
    expect(cooldown.isOpen(HOST)).toBe(true);
  });

  it('NON-gated host: an empty 500 is "other" — no strike, no stale, no cooldown (behaves as today)', () => {
    const cooldown = new ChallengeCooldown({ now: () => 1, windowMs: MIN, gateFailureThreshold: 1 });
    const store = fakeStore([]);
    expect(observeGate({ cooldown, store }, fetchOf({ status: 500, body: '' }))).toBe('other');
    expect(cooldown.gateFailureCount(HOST)).toBe(0);
    expect(cooldown.isOpen(HOST)).toBe(false);
    expect(store.markStale).not.toHaveBeenCalled();
  });

  it('a store answer that is neither clean nor a gate failure (404) is "other" and leaves the run alone', () => {
    const cooldown = new ChallengeCooldown({ now: () => 1, windowMs: MIN });
    const store = fakeStore([HOST]);
    cooldown.recordGateFailure(HOST, 'r');
    expect(observeGate({ cooldown, store }, fetchOf({ status: 404, body: BODY }))).toBe('other');
    expect(cooldown.gateFailureCount(HOST)).toBe(1);
  });

  it('a flagged challenge is "challenge" and untouched here (its own path opens the cooldown)', () => {
    const cooldown = new ChallengeCooldown({ now: () => 1, windowMs: MIN });
    const store = fakeStore([HOST]);
    expect(observeGate({ cooldown, store }, fetchOf({ status: 503, body: BODY, challenge: true }))).toBe('challenge');
    expect(cooldown.gateFailureCount(HOST)).toBe(0);
    expect(store.markStale).not.toHaveBeenCalled();
  });
});

/**
 * Challenger round 1 on PR #334:
 *   - A site that saw NO status (a bare-body lane) cannot prove a clean fetch: a non-empty body there
 *     neither resets the host's run nor may mark it FRESH. Its body can still prove an EMPTY answer.
 *   - A store on the RESIDENTIAL exit is gated by its egress: the thing at risk is Ross's home IP, and
 *     rulesets projects `access` onto searchFetch only for browser-lane profiles, so mfc (impersonate
 *     + residential) was gated only while the cf-cookies Secret held a jar for it.
 *   - An EMPTY 404 / 410 is the store's own "gone" answer, not a refused gate; an empty 403 is refused.
 */
describe('gateSignal — round 1: status-blind sites, residential egress, empty gone answers', () => {
  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  const MFC_SEARCH_FETCH = { transport: 'impersonate' as const, browser: 'chrome142', egress: 'residential' as const };

  it('a status-blind outcome with a real body is NOT clean: no reset, verdict "other"', () => {
    expect(isCleanFetch({ body: BODY, statusBlind: true })).toBe(false);
    const cooldown = new ChallengeCooldown({ now: () => 1, windowMs: MIN, gateFailureThreshold: 5 });
    const store = fakeStore([HOST]);
    for (let i = 0; i < 4; i++) cooldown.recordGateFailure(HOST, 'queue empty 500');
    const verdict = observeGate({ cooldown, store }, { url: URL_, host: HOST, lane: 'browser', body: BODY, statusBlind: true });
    expect({ verdict, run: cooldown.gateFailureCount(HOST), stale: store.markStale.mock.calls.length }).toEqual({ verdict: 'other', run: 4, stale: 0 });
  });

  it('a status-blind EMPTY body from a gated host is still a gate failure (the body alone proves it)', () => {
    const cooldown = new ChallengeCooldown({ now: () => 1, windowMs: MIN, gateFailureThreshold: 5 });
    const store = fakeStore([HOST]);
    const verdict = observeGate({ cooldown, store }, { url: URL_, host: HOST, lane: 'browser', body: '', statusBlind: true });
    expect(verdict).toBe('gate_failure');
    expect(store.markStale).toHaveBeenCalledWith(HOST, 'browser', 'gate failure via browser transport: no status with an empty body');
  });

  it('the mfc capability shape rulesets 0.9.31 ships (impersonate + chrome142 + residential) is gated WITHOUT a stored jar', () => {
    expect(isGatedHost(fakeStore([]), 'https://myfigurecollection.net/item/2253259', MFC_SEARCH_FETCH)).toBe(true);
    expect(isGatedHost(fakeStore([]), URL_, { transport: 'browser', egress: 'residential' })).toBe(true);
    expect(isGatedHost(fakeStore([]), URL_, { transport: 'impersonate', egress: 'direct' })).toBe(false);
  });

  it('observeGate: an empty 500 from the residential mfc shape with NO jar is one strike (and nothing to mark stale)', () => {
    const cooldown = new ChallengeCooldown({ now: () => 1, windowMs: MIN, gateFailureThreshold: 1 });
    const store = fakeStore([]);
    const url = 'https://myfigurecollection.net/item/2253259';
    expect(observeGate({ cooldown, store }, { url, host: 'myfigurecollection.net', lane: 'impersonate', searchFetch: MFC_SEARCH_FETCH, status: 500, body: '' })).toBe('gate_failure');
    expect(cooldown.isOpen('myfigurecollection.net')).toBe(true);
    expect(store.markStale).not.toHaveBeenCalled();
  });

  it.each([
    [404, 'other'],
    [410, 'other'],
    [403, 'gate_failure'],
    [429, 'gate_failure'],
  ])('an EMPTY %s from a gated host → %s', (status, expected) => {
    const cooldown = new ChallengeCooldown({ now: () => 1, windowMs: MIN, gateFailureThreshold: 99 });
    const store = fakeStore([HOST]);
    const verdict = observeGate({ cooldown, store }, { url: URL_, host: HOST, lane: 'impersonate', status, body: '' });
    expect({ verdict, run: cooldown.gateFailureCount(HOST) }).toEqual({ verdict: expected, run: expected === 'other' ? 0 : 1 });
  });
});

/**
 * Challenger round 2 on PR #334 — the edges of the rule, pinned on BOTH sides:
 *   - CLEAN is exactly 200..299: a 199 and a 300 with a real body are not clean.
 *   - GATE FAILURE by status is exactly >= 500: a 499 with a real body is not one.
 *   - gateOutcomeOf: a bare body AND a detail with no status are STATUS-BLIND (never clean); a
 *     detail with a status carries it and is judged by it.
 */
describe('gateSignal — round 2: both sides of every edge, and gateOutcomeOf', () => {
  it.each([
    [199, false],
    [200, true],
    [299, true],
    [300, false],
  ])('isCleanFetch({status: %s, non-empty body}) === %s — the 2xx band, both edges', (status, clean) => {
    expect(isCleanFetch({ status, body: BODY })).toBe(clean);
  });

  it.each([
    [499, false],
    [500, true],
    [599, true],
  ])('isGateFailure({status: %s, non-empty body}) === %s — the 5xx edge', (status, failure) => {
    expect(isGateFailure({ status, body: BODY })).toBe(failure);
  });

  it('gateOutcomeOf: a detail with NO status is status-blind, so a real body there is never clean', () => {
    const outcome = gateOutcomeOf({ body: BODY });
    expect(outcome).toEqual({ body: BODY, statusBlind: true });
    expect(isCleanFetch(outcome)).toBe(false);
  });

  it('gateOutcomeOf: a bare body is status-blind too', () => {
    expect(gateOutcomeOf(BODY)).toEqual({ body: BODY, statusBlind: true });
    expect(isCleanFetch(gateOutcomeOf(BODY))).toBe(false);
  });

  it('gateOutcomeOf: a detail WITH a status carries it (and only body + status), judged by it', () => {
    const clean = gateOutcomeOf({ body: BODY, status: 200 });
    expect(clean).toEqual({ body: BODY, status: 200 });
    expect(isCleanFetch(clean)).toBe(true);
    expect(isGateFailure(gateOutcomeOf({ body: BODY, status: 500 }))).toBe(true);
  });
});
