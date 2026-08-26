/**
 * makeFetchSearch — dispatches a store's search URL to the transport it declares
 * (http | impersonate | browser), applying its headers/profile/cookies, and degrades the
 * browser transport to http when no browser fetcher is wired.
 */
import { makeFetchSearch, type FetchSearchTransports } from '../../services/fetchSearch';

const transports = () => {
  const calls: any[] = [];
  const t: FetchSearchTransports = {
    http: async (url) => { calls.push(['http', url]); return 'HTTP'; },
    impersonate: async (url, o) => { calls.push(['impersonate', url, o]); return 'IMPIT'; },
    browser: async (url, o) => { calls.push(['browser', url, o]); return 'BROWSER'; },
  };
  return { t, calls };
};

describe('makeFetchSearch', () => {
  it("routes 'impersonate' to impit with profile + headers + userAgent", async () => {
    const { t, calls } = transports();
    const body = await makeFetchSearch(t)('https://api.amiami.com/items?s_keywords=tomie', {
      transport: 'impersonate', browser: 'chrome142', headers: { 'X-User-Key': 'amiami_dev' }, userAgent: 'python-amiami_dev',
    });
    expect(body).toBe('IMPIT');
    expect(calls[0]).toEqual(['impersonate', 'https://api.amiami.com/items?s_keywords=tomie',
      { browser: 'chrome142', headers: { 'X-User-Key': 'amiami_dev' }, userAgent: 'python-amiami_dev' }]);
  });

  it("threads a session-prime (target origin) to impit for a sessionPrime store", async () => {
    const { t, calls } = transports();
    const body = await makeFetchSearch(t)('https://www.gkloot.com/search/?Keyword=lucy', {
      transport: 'impersonate', sessionPrime: true,
    });
    expect(body).toBe('IMPIT');
    expect(calls[0]).toEqual(['impersonate', 'https://www.gkloot.com/search/?Keyword=lucy',
      { browser: undefined, headers: undefined, userAgent: undefined, prime: { url: 'https://www.gkloot.com' } }]);
  });

  it("adds NO prime key for an impersonate store WITHOUT sessionPrime (byte-identical)", async () => {
    const { t, calls } = transports();
    await makeFetchSearch(t)('https://api.amiami.com/items?s_keywords=tomie', { transport: 'impersonate', browser: 'chrome142' });
    expect(calls[0][2]).not.toHaveProperty('prime');
  });

  it("routes 'browser' to the browser transport with headers/cookies", async () => {
    const { t, calls } = transports();
    const body = await makeFetchSearch(t)('https://surugaya.test/s', { transport: 'browser', cookies: { cf_clearance: 'x' } });
    expect(body).toBe('BROWSER');
    expect(calls[0][0]).toBe('browser');
    expect(calls[0][2]).toEqual({ headers: undefined, userAgent: undefined, cookies: { cf_clearance: 'x' } });
  });

  it("routes 'http' and an undefined transport to plain HTTP", async () => {
    const { t } = transports();
    expect(await makeFetchSearch(t)('https://gsus.test/s', { transport: 'http' })).toBe('HTTP');
    expect(await makeFetchSearch(t)('https://gsus.test/s', {})).toBe('HTTP'); // no transport → http default
  });

  it("throws when 'browser' is requested but no browser transport is wired (fails loud, not a silent http fallback)", async () => {
    const { t, calls } = transports();
    const noBrowser: FetchSearchTransports = { http: t.http, impersonate: t.impersonate }; // browser omitted
    await expect(makeFetchSearch(noBrowser)('https://x.test/s', { transport: 'browser' })).rejects.toThrow(/browser/);
    expect(calls).toEqual([]); // did NOT silently fall through to http
  });
});
