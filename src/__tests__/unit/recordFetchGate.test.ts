/**
 * recordFetchGate — the PURE verdict on one record fetch's response metadata.
 *
 * The record lane used to be status-blind: whatever bytes came back were handed to the ruleset, so
 * a store's 404 body, a busy 5xx, and an item URL that bounced to the shop's front page all reached
 * the ledger as `parse` / `other` / an empty record — a verdict against OUR ruleset for something
 * the STORE said. These cases fix what the gate must say about each.
 */
import { evaluateRecordFetch, isRedirectHome, RecordFetchStatusError } from '../../services/recordFetchGate';

const ITEM = 'https://store.example.test/product/12345';

describe('evaluateRecordFetch — failing statuses', () => {
  it.each([404, 410, 403, 429, 500, 503, 400, 451])('flags HTTP %s as a fetch failure carrying the status', (status) => {
    const failure = evaluateRecordFetch(ITEM, { status, finalUrl: ITEM }, 'http');
    expect(failure).toBeInstanceOf(RecordFetchStatusError);
    expect(failure!.status).toBe(status);
    expect(failure!.url).toBe(ITEM);
    expect(failure!.transport).toBe('http');
    expect(failure!.redirectedHome).toBe(false);
  });

  it.each([200, 201, 204, 206, 301, 302, 399])('passes HTTP %s through (no verdict)', (status) => {
    expect(evaluateRecordFetch(ITEM, { status, finalUrl: ITEM }, 'http')).toBeUndefined();
  });

  it('passes a lane that surfaced NO status (a bare string transport) through untouched', () => {
    expect(evaluateRecordFetch(ITEM, {}, 'browser')).toBeUndefined();
  });

  it('ignores a sentinel status no HTTP response can carry', () => {
    expect(evaluateRecordFetch(ITEM, { status: 0 }, 'http')).toBeUndefined();
    expect(evaluateRecordFetch(ITEM, { status: 999 }, 'http')).toBeUndefined();
  });

  it('names the status in the message and never invents a redirect for it', () => {
    const failure = evaluateRecordFetch(ITEM, { status: 404 }, 'impersonate')!;
    expect(failure.message).toContain('404');
    expect(failure.message).toContain(ITEM);
    expect(failure.name).toBe('RecordFetchStatusError');
    expect(failure.finalUrl).toBeUndefined();
  });
});

describe('evaluateRecordFetch — an item URL that landed on the store home page', () => {
  it('flags a redirect to the store root', () => {
    const failure = evaluateRecordFetch(ITEM, { status: 200, finalUrl: 'https://store.example.test/' }, 'browser');
    expect(failure).toBeInstanceOf(RecordFetchStatusError);
    expect(failure!.redirectedHome).toBe(true);
    expect(failure!.finalUrl).toBe('https://store.example.test/');
    expect(failure!.status).toBe(200);
    expect(failure!.message).toContain('home');
  });

  it('lets a FAILING status win over the redirect (the status is the more specific truth)', () => {
    const failure = evaluateRecordFetch(ITEM, { status: 404, finalUrl: 'https://store.example.test/' }, 'http')!;
    expect(failure.status).toBe(404);
    expect(failure.redirectedHome).toBe(false);
  });
});

describe('isRedirectHome', () => {
  it.each([
    ['https://store.example.test/'],
    ['https://store.example.test'],
    ['https://store.example.test/?redirected=1'],
    ['https://www.store.example.test/'],
  ])('is true when the fetch ended on a bare root (%s)', (finalUrl) => {
    expect(isRedirectHome(ITEM, finalUrl)).toBe(true);
  });

  it.each([
    ['https://store.example.test/product/12345'],
    ['https://store.example.test/product/12345?utm=1'],
    ['https://store.example.test/product/99999'],
    ['https://store.example.test/search?q=x'],
  ])('is false when the fetch ended on a real path (%s)', (finalUrl) => {
    expect(isRedirectHome(ITEM, finalUrl)).toBe(false);
  });

  it('is false when the lane surfaced no final URL', () => {
    expect(isRedirectHome(ITEM, undefined)).toBe(false);
  });

  it('is false when the REQUESTED url is itself the home page (nothing was redirected away)', () => {
    expect(isRedirectHome('https://store.example.test/', 'https://store.example.test/')).toBe(false);
  });

  it('is false when either url is unparseable — never guesses', () => {
    expect(isRedirectHome('not a url', 'https://store.example.test/')).toBe(false);
    expect(isRedirectHome(ITEM, 'not a url')).toBe(false);
  });
});
