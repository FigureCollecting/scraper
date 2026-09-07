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

  const makePage = (titles: string[]) => {
    const queue = [...titles];
    return {
      title: jest.fn<(...a: any[]) => any>().mockImplementation(async () => queue.length > 1 ? queue.shift() : queue[0]),
    } as any;
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
});
