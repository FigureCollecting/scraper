/**
 * makeFetchSearch — dispatches a store's search URL to the transport it declares
 * (http | impersonate | browser), applying its headers/profile/cookies, and degrades the
 * browser transport to http when no browser fetcher is wired.
 */
import { makeFetchSearch, type FetchSearchTransports } from '../../services/fetchSearch';
import { ResidentialEgressUnavailableError } from '../../services/residentialEgress';

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

/**
 * RESIDENTIAL EGRESS on the search fan-out (contract 0.7.0). A store declaring
 * `egress: 'residential'` has its search fetch routed through the engine's configured residential
 * proxy — impit takes it as `proxyUrl`, the browser lane as a per-context `proxyServer`. The proxy
 * is resolved from runtime config ONCE per call (injected here). Two rules are non-negotiable:
 *   - no proxy configured ⇒ the fetch is REFUSED (typed) and the transport is never called: a
 *     silent fall back to the node IP would burn that IP's CF reputation AND reveal the attempt;
 *   - the plain-HTTP lane cannot proxy at all, so a residential store on it is refused the same way
 *     (that store belongs on `impersonate`).
 */
describe('makeFetchSearch — residential egress + waitFor', () => {
  const PROXY = 'socks5://egress-proxy.fc.svc.cluster.local:1055';
  const withProxy = (t: FetchSearchTransports) => makeFetchSearch(t, { residentialProxyUrl: () => PROXY });
  const noProxy = (t: FetchSearchTransports) => makeFetchSearch(t, { residentialProxyUrl: () => undefined });

  it('threads the proxy into impit for a residential impersonate store', async () => {
    const { t, calls } = transports();
    const body = await withProxy(t)('https://www.anitoysgk.com/search?q=lucy', {
      transport: 'impersonate', browser: 'chrome142', egress: 'residential',
    });
    expect(body).toBe('IMPIT');
    expect(calls[0][2]).toMatchObject({ browser: 'chrome142', proxyUrl: PROXY });
  });

  it('adds NO proxyUrl key for an undeclared or explicitly direct store, even with a proxy configured', async () => {
    const { t, calls } = transports();
    await withProxy(t)('https://api.amiami.com/items?s_keywords=tomie', { transport: 'impersonate', browser: 'chrome142' });
    await withProxy(t)('https://api.amiami.com/items?s_keywords=tomie', { transport: 'impersonate', egress: 'direct' });
    expect(calls[0][2]).not.toHaveProperty('proxyUrl');
    expect(calls[1][2]).not.toHaveProperty('proxyUrl');
  });

  it('REFUSES a residential store when no proxy is configured — typed, and the transport is never called', async () => {
    const { t, calls } = transports();
    await expect(noProxy(t)('https://www.anitoysgk.com/search?q=lucy', { transport: 'impersonate', egress: 'residential' }))
      .rejects.toThrow(ResidentialEgressUnavailableError);
    expect(calls).toHaveLength(0);
  });

  it('REFUSES a residential store on the plain-HTTP lane (it cannot proxy) — the store belongs on impersonate', async () => {
    const { t, calls } = transports();
    await expect(withProxy(t)('https://www.anitoysgk.com/api/search?q=lucy', { transport: 'http', egress: 'residential' }))
      .rejects.toThrow(/impersonate/);
    expect(calls).toHaveLength(0);
  });

  it('threads proxyServer AND waitFor into the browser lane for a residential PWA store', async () => {
    const { t, calls } = transports();
    const body = await withProxy(t)('https://www.crunchyroll-store.test/search?q=lucy', {
      transport: 'browser', egress: 'residential', waitFor: { selector: '.product-card', networkIdle: true, timeoutMs: 20000 },
    });
    expect(body).toBe('BROWSER');
    expect(calls[0][2]).toMatchObject({
      proxyServer: PROXY,
      waitFor: { selector: '.product-card', networkIdle: true, timeoutMs: 20000 },
    });
  });

  it('threads waitFor alone for a DIRECT browser store (readiness is independent of egress)', async () => {
    const { t, calls } = transports();
    await withProxy(t)('https://www.crunchyroll-store.test/search?q=lucy', {
      transport: 'browser', waitFor: { selector: '.product-card' },
    });
    expect(calls[0][2]).toMatchObject({ waitFor: { selector: '.product-card' } });
    expect(calls[0][2]).not.toHaveProperty('proxyServer');
  });

  it('a browser store declaring neither gets NEITHER key (byte-identical to the pre-0.7.0 call)', async () => {
    const { t, calls } = transports();
    await withProxy(t)('https://surugaya.test/s', { transport: 'browser', cookies: { cf_clearance: 'x' } });
    expect(calls[0][2]).toEqual({ headers: undefined, userAgent: undefined, cookies: { cf_clearance: 'x' } });
  });

  it('resolves the proxy from runtime config ONCE per call (no re-read per transport branch)', async () => {
    const { t } = transports();
    const residentialProxyUrl = jest.fn(() => PROXY);
    const fetchSearch = makeFetchSearch(t, { residentialProxyUrl });
    await fetchSearch('https://www.anitoysgk.com/search?q=lucy', { transport: 'impersonate', egress: 'residential' });
    expect(residentialProxyUrl).toHaveBeenCalledTimes(1);
  });

  it('defaults to the engine\'s configured proxy when no resolver is injected (unset env ⇒ residential refused)', async () => {
    const { t, calls } = transports();
    await expect(makeFetchSearch(t)('https://www.anitoysgk.com/s', { transport: 'impersonate', egress: 'residential' }))
      .rejects.toThrow(ResidentialEgressUnavailableError);
    expect(calls).toHaveLength(0);
  });
});
