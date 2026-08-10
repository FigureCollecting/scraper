/**
 * createImpitFetch — the browser-TLS-impersonating HTTP body fetch (impit). Unit-tested with an
 * injected fake impit so it never loads the native binary: verifies the default profile, per-store
 * profile + header/UA merge, and one-instance-per-profile caching.
 */
import { createImpitFetch, type ImpitLike } from '../../services/impitFetch';

describe('createImpitFetch', () => {
  it('fetches via impit with the default chrome142 profile and returns the body text', async () => {
    const calls: Array<{ browser: string; url: string; init: any }> = [];
    const fake = (browser: string): ImpitLike => ({
      fetch: async (url, init) => { calls.push({ browser, url, init }); return { text: async () => '{"items":[]}' }; },
    });

    const impitFetch = createImpitFetch(fake);
    const body = await impitFetch('https://api.amiami.com/api/v1.0/items?s_keywords=tomie');

    expect(body).toBe('{"items":[]}');
    expect(calls[0].browser).toBe('chrome142'); // engine default profile
    expect(calls[0].url).toBe('https://api.amiami.com/api/v1.0/items?s_keywords=tomie');
    expect(calls[0].init.method).toBe('GET');
  });

  it('uses the store-specified browser profile and merges headers + userAgent', async () => {
    let seen: { browser: string; init: any } | undefined;
    const fake = (browser: string): ImpitLike => ({
      fetch: async (_url, init) => { seen = { browser, init }; return { text: async () => 'ok' }; },
    });

    const impitFetch = createImpitFetch(fake);
    await impitFetch('https://x.test/s', {
      browser: 'chrome124',
      headers: { 'X-User-Key': 'amiami_dev' },
      userAgent: 'python-amiami_dev',
    });

    expect(seen?.browser).toBe('chrome124');
    expect(seen?.init.headers).toEqual({ 'User-Agent': 'python-amiami_dev', 'X-User-Key': 'amiami_dev' });
  });

  it('caches one impit instance per profile (reuses across calls, rebuilds only for a new profile)', async () => {
    let builds = 0;
    const fake = (_browser: string): ImpitLike => { builds++; return { fetch: async () => ({ text: async () => 'ok' }) }; };

    const impitFetch = createImpitFetch(fake);
    await impitFetch('https://x.test/a', { browser: 'chrome142' });
    await impitFetch('https://x.test/b', { browser: 'chrome142' }); // same profile → reuse
    await impitFetch('https://x.test/c', { browser: 'chrome124' }); // new profile → build

    expect(builds).toBe(2);
  });
});
