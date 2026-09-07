import { jest } from '@jest/globals';
import {
  awaitChallengeClearance,
  challengeHost,
  clearChallengeGates,
  isChallengeGated,
  isChallengeResponse,
  isChallengeTitle,
  markChallengeGated,
} from '../../services/browserChallenge';

/**
 * The clean-headful browser PASSES Cloudflare's non-interactive JS challenge on its own — but it
 * takes 3-9 s, and `page.goto(…, 'domcontentloaded')` returns the moment the CHALLENGE page's DOM
 * exists. Without a bounded wait the lane captures "Just a moment" and calls it the product page.
 * Seeing the challenge is also what marks the host as gated, so its context is kept alive and the
 * clearance is reused instead of re-earned.
 */
describe('browser-lane challenge clearance', () => {
  beforeEach(() => clearChallengeGates());

  const makeResponse = (headers: Record<string, string>) => ({ headers: () => headers }) as any;

  const makePage = (titles: string[], readyStates: string[] = []) => {
    const queue = [...titles];
    const ready = [...readyStates];
    const page: any = {
      title: jest.fn<(...a: any[]) => any>().mockImplementation(async () => queue.length > 1 ? queue.shift() : queue[0]),
    };
    if (readyStates.length > 0) {
      page.evaluate = jest.fn<(...a: any[]) => any>().mockImplementation(async () => (ready.length > 1 ? ready.shift() : ready[0]));
    }
    return page;
  };

  it('recognises the challenge signal on a response', () => {
    expect(isChallengeResponse({ 'cf-mitigated': 'challenge' })).toBe(true);
    expect(isChallengeResponse({ 'CF-Mitigated': 'challenge' })).toBe(true);
    expect(isChallengeResponse({ 'cf-mitigated': 'block' })).toBe(false);
    expect(isChallengeResponse({ 'content-type': 'text/html' })).toBe(false);
    expect(isChallengeResponse(undefined)).toBe(false);
  });

  it('recognises the challenge page by title', () => {
    expect(isChallengeTitle('Just a moment...')).toBe(true);
    expect(isChallengeTitle('  just a moment ')).toBe(true);
    expect(isChallengeTitle('Lucy 1/4 Scale Statue')).toBe(false);
    expect(isChallengeTitle('')).toBe(false);
  });

  /**
   * The interstitial is not always in English and does not always carry `cf-mitigated`. The proven
   * probe (cf-probe.cjs) also treats Cloudflare's own challenge containers as the signal, so the
   * lane does too — otherwise the interstitial is captured as the product page and, worse, the host
   * is never marked gated, so every later fetch re-challenges on a fresh context.
   */
  it('recognises a challenge by Cloudflare\'s DOM containers when the title is not English', async () => {
    const markers = [true, true, false];
    const page: any = {
      title: jest.fn<(...a: any[]) => any>().mockResolvedValue('少々お待ちください'),
      evaluate: jest.fn<(...a: any[]) => any>().mockImplementation(async () =>
        (markers.length > 1 ? markers.shift() : markers[0])),
    };

    const seen = await awaitChallengeClearance(page, makeResponse({ 'content-type': 'text/html' }), 'https://www.anitoysgk.com/lucy.html', { timeoutMs: 500, pollMs: 5 });

    expect(seen).toBe(true);
    expect(isChallengeGated('www.anitoysgk.com')).toBe(true);
    expect(jest.mocked(page.evaluate).mock.calls.length).toBeGreaterThan(1); // it WAITED
  });

  it('does not mistake a page whose evaluate returns something other than true for a challenge', async () => {
    const page: any = {
      title: jest.fn<(...a: any[]) => any>().mockResolvedValue('Lucy — anitoys'),
      evaluate: jest.fn<(...a: any[]) => any>().mockResolvedValue('body text'),
    };

    const seen = await awaitChallengeClearance(page, makeResponse({ 'content-type': 'text/html' }), 'https://www.anitoysgk.com/lucy.html', { timeoutMs: 50, pollMs: 5 });

    expect(seen).toBe(false);
    expect(isChallengeGated('www.anitoysgk.com')).toBe(false);
  });

  it('does nothing when the first response is not a challenge', async () => {
    const page = makePage(['Lucy — anitoys']);

    const seen = await awaitChallengeClearance(page, makeResponse({ 'content-type': 'text/html' }), 'https://www.anitoysgk.com/lucy.html', { timeoutMs: 50, pollMs: 5 });

    expect(seen).toBe(false);
    expect(isChallengeGated('www.anitoysgk.com')).toBe(false);
  });

  it('waits out a challenge, returns as soon as it clears, and marks the host gated', async () => {
    const page = makePage(['Just a moment...', 'Just a moment...', 'Lucy — anitoys']);

    const seen = await awaitChallengeClearance(page, makeResponse({ 'cf-mitigated': 'challenge' }), 'https://www.anitoysgk.com/lucy.html', { timeoutMs: 5000, pollMs: 1 });

    expect(seen).toBe(true);
    expect(isChallengeGated('www.anitoysgk.com')).toBe(true);
    expect(page.title).toHaveBeenCalled();
  });

  it('detects a challenge that only the TITLE reveals (no cf-mitigated header)', async () => {
    const page = makePage(['Just a moment...', 'Lucy — anitoys']);

    const seen = await awaitChallengeClearance(page, makeResponse({}), 'https://www.anitoysgk.com/lucy.html', { timeoutMs: 5000, pollMs: 1 });

    expect(seen).toBe(true);
    expect(isChallengeGated('www.anitoysgk.com')).toBe(true);
  });

  it('gives up at the budget, warns once, and still reports the challenge (the host stays gated)', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const page = makePage(['Just a moment...']);

    const seen = await awaitChallengeClearance(page, makeResponse({ 'cf-mitigated': 'challenge' }), 'https://www.anitoysgk.com/lucy.html', { timeoutMs: 20, pollMs: 5 });

    expect(seen).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(isChallengeGated('www.anitoysgk.com')).toBe(true);
    warn.mockRestore();
  });

  it('keys gated hosts by hostname, case-insensitively, and never throws on a bad url', () => {
    expect(challengeHost('https://WWW.Anitoysgk.com/lucy.html')).toBe('www.anitoysgk.com');
    expect(challengeHost('not a url')).toBeUndefined();

    markChallengeGated('WWW.Anitoysgk.com');
    expect(isChallengeGated('www.anitoysgk.com')).toBe(true);
    expect(isChallengeGated('hobby-genki.com')).toBe(false);

    clearChallengeGates();
    expect(isChallengeGated('www.anitoysgk.com')).toBe(false);
  });

  it('waits for the document that REPLACED the interstitial to finish parsing', async () => {
    // The title flips as soon as the real document starts loading — reading the DOM then yields a
    // 2 KB fragment of a 290 KB page (measured live against anitoysgk.com 2026-09-07).
    const page = makePage(['Just a moment...', 'Lucy — anitoys'], ['loading', 'loading', 'interactive']);

    const seen = await awaitChallengeClearance(page, makeResponse({ 'cf-mitigated': 'challenge' }), 'https://www.anitoysgk.com/lucy.html', { timeoutMs: 5000, pollMs: 1 });

    expect(seen).toBe(true);
    expect(page.evaluate).toHaveBeenCalled();
  });

  /**
   * THE DEFECT (production 2026-09-07, www.suruga-ya.jp through the residential gated browser): the
   * 403 carrying `cf-mitigated: challenge` is answered by the interstitial navigating to
   * `…?__cf_chl_rt_tk=…` and back. During that round trip the page has NO title (and the interstitial
   * is localised anyway) and Cloudflare's containers are gone from the DOM — so a wait that leaves on
   * "no markers right now" left immediately and the lane captured the interstitial. The absence of a
   * challenge marker is not evidence the challenge finished; a `cf_clearance` cookie is.
   */
  it('keeps waiting through the interstitial round trip and leaves only once the clearance cookie lands', async () => {
    const jar: Array<{ name: string; domain: string }> = [];
    let reads = 0;
    const page: any = {
      title: jest.fn<(...a: any[]) => any>().mockResolvedValue(''),
      evaluate: jest.fn<(...a: any[]) => any>().mockResolvedValue(false),
      url: jest.fn(() => 'https://www.suruga-ya.jp/product/detail/100000950'),
      cookies: jest.fn<(...a: any[]) => any>().mockImplementation(async () => {
        if (++reads >= 3) jar.push({ name: 'cf_clearance', domain: '.suruga-ya.jp' });
        return [...jar];
      }),
    };

    const seen = await awaitChallengeClearance(page, makeResponse({ 'cf-mitigated': 'challenge' }), 'https://www.suruga-ya.jp/product/detail/100000950', { timeoutMs: 5000, pollMs: 1 });

    expect(seen).toBe(true);
    expect(reads).toBeGreaterThan(1); // it WAITED rather than leaving on the first empty title
    expect(isChallengeGated('www.suruga-ya.jp')).toBe(true);
  });

  it('leaves at once when the session already holds the clearance for this host', async () => {
    const page: any = {
      title: jest.fn<(...a: any[]) => any>().mockResolvedValue('駿河屋 - XRGB'),
      evaluate: jest.fn<(...a: any[]) => any>().mockResolvedValue(false),
      url: jest.fn(() => 'https://www.suruga-ya.jp/product/detail/100000950'),
      cookies: jest.fn<(...a: any[]) => any>().mockResolvedValue([{ name: 'cf_clearance', domain: 'www.suruga-ya.jp' }]),
    };

    const seen = await awaitChallengeClearance(page, makeResponse({ 'cf-mitigated': 'challenge' }), 'https://www.suruga-ya.jp/product/detail/100000950', { timeoutMs: 5000, pollMs: 50 });

    expect(seen).toBe(true);
    expect(jest.mocked(page.cookies).mock.calls.length).toBe(1); // no needless poll
  });

  it('never reads cookies for a page that was never challenged', async () => {
    const page: any = {
      title: jest.fn<(...a: any[]) => any>().mockResolvedValue('Lucy — anitoys'),
      evaluate: jest.fn<(...a: any[]) => any>().mockResolvedValue(false),
      cookies: jest.fn<(...a: any[]) => any>().mockResolvedValue([]),
    };

    const seen = await awaitChallengeClearance(page, makeResponse({ 'content-type': 'text/html' }), 'https://alpha.example.test/item/1', { timeoutMs: 50, pollMs: 5 });

    expect(seen).toBe(false);
    expect(page.cookies).not.toHaveBeenCalled();
  });

  it('does not accept a clearance cookie issued for a DIFFERENT host', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const page: any = {
      title: jest.fn<(...a: any[]) => any>().mockResolvedValue(''),
      evaluate: jest.fn<(...a: any[]) => any>().mockResolvedValue(false),
      url: jest.fn(() => 'https://www.suruga-ya.jp/product/detail/100000950'),
      cookies: jest.fn<(...a: any[]) => any>().mockResolvedValue([{ name: 'cf_clearance', domain: '.anitoysgk.com' }]),
    };

    const seen = await awaitChallengeClearance(page, makeResponse({ 'cf-mitigated': 'challenge' }), 'https://www.suruga-ya.jp/product/detail/100000950', { timeoutMs: 20, pollMs: 5 });

    expect(seen).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1); // it waited out the budget, then captured
    warn.mockRestore();
  });

  it('runs out the budget when the clearance never lands, warns once, and still captures', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const page: any = {
      title: jest.fn<(...a: any[]) => any>().mockResolvedValue(''),
      evaluate: jest.fn<(...a: any[]) => any>().mockResolvedValue(false),
      url: jest.fn(() => 'https://www.suruga-ya.jp/product/detail/100000950'),
      cookies: jest.fn<(...a: any[]) => any>().mockResolvedValue([]),
    };

    const seen = await awaitChallengeClearance(page, makeResponse({ 'cf-mitigated': 'challenge' }), 'https://www.suruga-ya.jp/product/detail/100000950', { timeoutMs: 20, pollMs: 5 });

    expect(seen).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(isChallengeGated('www.suruga-ya.jp')).toBe(true);
    warn.mockRestore();
  });

  /**
   * A page with no cookie surface (a mock, or an unusual page object) cannot supply positive
   * evidence, so the wait falls back to the old marker rule PLUS a grace: while the URL still
   * carries Cloudflare's own round-trip token the challenge is demonstrably still running.
   */
  it('without a cookie surface, keeps polling while the URL carries the challenge round-trip token', async () => {
    const urls = [
      'https://www.suruga-ya.jp/product/detail/100000950?__cf_chl_rt_tk=abc',
      'https://www.suruga-ya.jp/product/detail/100000950?__cf_chl_tk=abc',
      'https://www.suruga-ya.jp/product/detail/100000950',
    ];
    const page: any = {
      title: jest.fn<(...a: any[]) => any>().mockResolvedValue(''),
      evaluate: jest.fn<(...a: any[]) => any>().mockResolvedValue('complete'),
      url: jest.fn(() => (urls.length > 1 ? urls.shift()! : urls[0])),
    };

    const seen = await awaitChallengeClearance(page, makeResponse({ 'cf-mitigated': 'challenge' }), 'https://www.suruga-ya.jp/product/detail/100000950', { timeoutMs: 5000, pollMs: 1 });

    expect(seen).toBe(true);
    expect(jest.mocked(page.url).mock.calls.length).toBeGreaterThan(1);
  });

  it('does not wait on readyState for a page that was never challenged', async () => {
    // ONE evaluate — the challenge-marker probe — and then it is done: a page whose readyState is
    // still 'loading' is not polled, because nothing here was ever a challenge.
    const page = makePage(['Lucy — anitoys'], ['loading']);

    await awaitChallengeClearance(page, makeResponse({}), 'https://www.anitoysgk.com/lucy.html', { timeoutMs: 50, pollMs: 5 });

    expect(page.evaluate).toHaveBeenCalledTimes(1);
  });
});
