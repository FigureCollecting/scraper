/**
 * residentialEgress — the engine's residential-proxy runtime config and its typed refusal.
 *
 * Five Cloudflare-cohort stores are gated on IP/ASN REPUTATION, not browser fingerprint: they serve
 * a challenge to the datacenter node and real content to a residential IP. A store declares
 * `searchFetch.egress: 'residential'` and the engine routes its fetches through
 * `RESIDENTIAL_PROXY_URL` (a userspace Tailscale SOCKS5 proxy in-cluster). The rules pinned here:
 *   - the env value is parsed, not trusted: only socks5(h)/http(s) URLs are usable; anything else is
 *     IGNORED with exactly one boot warning that never echoes the value (it can carry credentials);
 *   - a residential store with NO usable proxy is REFUSED with a typed error — never silently sent
 *     from the node IP, which would both burn that IP's CF reputation and reveal the attempt;
 *   - the operator view redacts credentials down to `scheme://host:port`.
 */
import {
  ResidentialEgressUnavailableError,
  isSocksProxy,
  redactProxyUrl,
  refuseHttpLaneResidentialEgress,
  requireResidentialProxy,
  residentialEgressView,
  resolveResidentialProxyUrl,
} from '../../services/residentialEgress';

const env = (v?: string): NodeJS.ProcessEnv =>
  (v === undefined ? {} : { RESIDENTIAL_PROXY_URL: v }) as NodeJS.ProcessEnv;

describe('resolveResidentialProxyUrl', () => {
  it('returns undefined and never warns when RESIDENTIAL_PROXY_URL is unset (the default posture)', () => {
    const warn = jest.fn();
    expect(resolveResidentialProxyUrl(env(), warn)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('treats an empty / whitespace-only value as unset (no warn — an unfilled manifest field is not a typo)', () => {
    const warn = jest.fn();
    expect(resolveResidentialProxyUrl(env(''), warn)).toBeUndefined();
    expect(resolveResidentialProxyUrl(env('   '), warn)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('accepts a socks5 proxy verbatim (the in-cluster userspace Tailscale egress proxy)', () => {
    const warn = jest.fn();
    expect(resolveResidentialProxyUrl(env('socks5://egress-proxy.fc.svc.cluster.local:1055'), warn))
      .toBe('socks5://egress-proxy.fc.svc.cluster.local:1055');
    expect(warn).not.toHaveBeenCalled();
  });

  it('accepts http and https proxies, trimming surrounding whitespace', () => {
    const warn = jest.fn();
    expect(resolveResidentialProxyUrl(env('http://proxy.test:3128'), warn)).toBe('http://proxy.test:3128');
    expect(resolveResidentialProxyUrl(env(' https://proxy.test:8443 '), warn)).toBe('https://proxy.test:8443');
    expect(warn).not.toHaveBeenCalled();
  });

  /**
   * BROWSER-LANE REALITY (probed against this repo's own Chromium, 2026-09-07): Chromium's
   * `--proxy-server` understands `socks5://host:port` and `http(s)://host:port` and NOTHING else —
   * `socks5h://` and ANY credentialed proxy URL both die with `net::ERR_NO_SUPPORTED_PROXIES`
   * before a single byte leaves. impit accepts both, so a value that only impit can use would give
   * a half-working residential cohort (impit fetches succeed, every browser fetch dies opaquely).
   * The resolver therefore only ever hands the lanes a shape EVERY lane can use.
   */
  it('canonicalizes socks5h:// to socks5:// — the DNS-through-proxy spelling Chromium rejects', () => {
    const warn = jest.fn();
    expect(resolveResidentialProxyUrl(env('socks5h://127.0.0.1:1055'), warn)).toBe('socks5://127.0.0.1:1055');
    expect(resolveResidentialProxyUrl(env('socks5h://egress-proxy.fc.svc.cluster.local:1055'), warn))
      .toBe('socks5://egress-proxy.fc.svc.cluster.local:1055');
    expect(warn).not.toHaveBeenCalled();
  });

  it('IGNORES an embedded-credential proxy (Chromium cannot carry them) with one warning that says so and never echoes them', () => {
    const warn = jest.fn();
    expect(resolveResidentialProxyUrl(env('socks5://user:FAKE_PASS@proxy.test:1055'), warn)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('RESIDENTIAL_PROXY_URL');
    expect(warn.mock.calls[0][0]).toContain('credential');
    expect(warn.mock.calls[0][0]).not.toContain('FAKE_PASS');
    expect(warn.mock.calls[0][0]).not.toContain('proxy.test');
  });

  it('ignores a credentialed http(s) proxy for the same reason (one rule for every lane)', () => {
    const warn = jest.fn();
    expect(resolveResidentialProxyUrl(env('http://user:FAKE_PASS@proxy.test:3128'), warn)).toBeUndefined();
    expect(resolveResidentialProxyUrl(env('socks5h://user:FAKE_PASS@proxy.test:1055'), warn)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('FAKE_PASS');
  });

  it('ignores a password-only credential too (no username, still a credential Chromium cannot carry)', () => {
    const warn = jest.fn();
    expect(resolveResidentialProxyUrl(env('socks5://:FAKE_PASS@proxy.test:1055'), warn)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('credential');
  });

  it('ignores an unparseable value with exactly ONE warning that never echoes it', () => {
    const warn = jest.fn();
    expect(resolveResidentialProxyUrl(env('not a url'), warn)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('RESIDENTIAL_PROXY_URL');
    expect(warn.mock.calls[0][0]).not.toContain('not a url');
  });

  it('ignores a URL whose scheme is not socks5(h)/http(s), with one warning that never echoes credentials', () => {
    const warn = jest.fn();
    expect(resolveResidentialProxyUrl(env('ftp://proxy.test:21'), warn)).toBeUndefined();
    expect(resolveResidentialProxyUrl(env('ftp://user:FAKE_PASS@proxy.test:21'), warn)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toContain('scheme');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('FAKE_PASS');
  });

  it('ignores a socks4 proxy (impit speaks it, but the browser lane cannot — one declared scheme set for every lane)', () => {
    const warn = jest.fn();
    expect(resolveResidentialProxyUrl(env('socks4://proxy.test:1080'), warn)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('ignores a host-less proxy URL — it parses, but it names no proxy for any lane to dial', () => {
    const warn = jest.fn();
    expect(resolveResidentialProxyUrl(env('socks5://'), warn)).toBeUndefined();
    expect(resolveResidentialProxyUrl(env('socks5h:///path'), warn)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toContain('host');
  });

  it('is usable without a warn sink (the pure resolver has no side effects of its own)', () => {
    expect(resolveResidentialProxyUrl(env('socks5://p.test:1055'))).toBe('socks5://p.test:1055');
    expect(resolveResidentialProxyUrl(env('garbage'))).toBeUndefined();
  });
});

describe('isSocksProxy', () => {
  it('is true for socks5 / socks5h and false for http(s)', () => {
    expect(isSocksProxy('socks5://p.test:1055')).toBe(true);
    expect(isSocksProxy('socks5h://p.test:1055')).toBe(true);
    expect(isSocksProxy('http://p.test:3128')).toBe(false);
    expect(isSocksProxy('https://p.test:8443')).toBe(false);
  });

  it('is false for an unparseable value (it is not a socks proxy — it is not a proxy at all)', () => {
    expect(isSocksProxy('not a url')).toBe(false);
  });
});

describe('redactProxyUrl', () => {
  it('reduces a credentialed proxy to scheme://host:port', () => {
    expect(redactProxyUrl('socks5://user:FAKE_PASS@proxy.test:1055')).toBe('socks5://proxy.test:1055');
  });

  it('keeps a credential-free proxy intact and omits an absent port', () => {
    expect(redactProxyUrl('socks5://egress-proxy.fc.svc.cluster.local:1055'))
      .toBe('socks5://egress-proxy.fc.svc.cluster.local:1055');
    expect(redactProxyUrl('http://proxy.test')).toBe('http://proxy.test');
  });

  it('never echoes an unparseable value — it degrades to a fixed placeholder', () => {
    // Two distinct shapes: one that parses into a host-less `user:` URL (so a naive
    // `${protocol}//${host}` would echo credential debris), and one that does not parse at all.
    expect(redactProxyUrl('user:FAKE_PASS@whatever')).toBe('<unparseable>');
    expect(redactProxyUrl('not a url')).toBe('<unparseable>');
  });
});

describe('requireResidentialProxy', () => {
  const URL_ = 'https://www.anitoysgk.com/lucy-p29358268.html';

  it('returns undefined for an undeclared or explicitly direct store, even when a proxy IS configured', () => {
    expect(requireResidentialProxy(URL_, undefined, 'socks5://p.test:1055')).toBeUndefined();
    expect(requireResidentialProxy(URL_, 'direct', 'socks5://p.test:1055')).toBeUndefined();
  });

  it('returns undefined for an undeclared store when no proxy is configured (the default path is untouched)', () => {
    expect(requireResidentialProxy(URL_, undefined, undefined)).toBeUndefined();
  });

  it('returns the configured proxy for a residential store', () => {
    expect(requireResidentialProxy(URL_, 'residential', 'socks5://p.test:1055')).toBe('socks5://p.test:1055');
  });

  it('REFUSES a residential store when no proxy is configured — typed, and never a node-IP fallback', () => {
    expect(() => requireResidentialProxy(URL_, 'residential', undefined))
      .toThrow(ResidentialEgressUnavailableError);
    try {
      requireResidentialProxy(URL_, 'residential', undefined);
      throw new Error('expected a refusal');
    } catch (err) {
      const e = err as ResidentialEgressUnavailableError;
      expect(e.name).toBe('ResidentialEgressUnavailableError');
      expect(e.reason).toBe('unconfigured');
      expect(e.url).toBe(URL_);
      expect(e.message).toContain('RESIDENTIAL_PROXY_URL');
      expect(e.message).toContain('anitoysgk.com');
    }
  });

  it('defaults to the unconfigured reason when constructed without one', () => {
    const e = new ResidentialEgressUnavailableError('https://x.test/a');
    expect(e.reason).toBe('unconfigured');
    expect(e.message).toContain('RESIDENTIAL_PROXY_URL');
  });

  it('carries a lane-refusal variant whose message names the lane rule, not the proxy', () => {
    const e = new ResidentialEgressUnavailableError('https://x.test/a', 'unsupported-lane');
    expect(e.reason).toBe('unsupported-lane');
    expect(e.message).toContain('impersonate');
    expect(e.message).not.toContain('RESIDENTIAL_PROXY_URL is not configured');
  });
});

describe('refuseHttpLaneResidentialEgress (the plain-HTTP lane rule)', () => {
  const URL_ = 'https://www.anitoysgk.com/api/item/1';

  it('refuses a SOCKS proxy, naming why an undici ProxyAgent cannot serve this lane', () => {
    try {
      refuseHttpLaneResidentialEgress(URL_, 'socks5://p.test:1055');
      throw new Error('expected a refusal');
    } catch (err) {
      const e = err as ResidentialEgressUnavailableError;
      expect(e).toBeInstanceOf(ResidentialEgressUnavailableError);
      expect(e.reason).toBe('unsupported-lane');
      expect(e.message).toContain('SOCKS');
      expect(e.message).toContain('impersonate');
    }
  });

  it('refuses an HTTP(S) proxy too — this lane has no proxy support at all, so it never falls back', () => {
    try {
      refuseHttpLaneResidentialEgress(URL_, 'http://proxy.test:3128');
      throw new Error('expected a refusal');
    } catch (err) {
      const e = err as ResidentialEgressUnavailableError;
      expect(e.reason).toBe('unsupported-lane');
      expect(e.message).toContain('no proxy support');
      expect(e.message).not.toContain('SOCKS');
    }
  });
});

describe('residentialEgressView (the /health/detailed shape)', () => {
  const SHOW = { RESIDENTIAL_EGRESS_HEALTH_DETAIL: 'true' } as NodeJS.ProcessEnv;

  it('reports configured:false with no proxy string when nothing is configured', () => {
    expect(residentialEgressView(undefined)).toEqual({ configured: false });
  });

  /**
   * /health/detailed is UNAUTHENTICATED. `configured` is the whole operator question ("is residential
   * egress wired?"); the endpoint's exact host:port is topology nobody needs from outside the pod, so
   * it is published only on an explicit opt-in.
   */
  it('reports configured:true WITHOUT the proxy endpoint by default', () => {
    expect(residentialEgressView('socks5://egress-proxy.fc.svc.cluster.local:1055', {} as NodeJS.ProcessEnv))
      .toEqual({ configured: true });
  });

  it('reports the proxy REDACTED to scheme://host:port under the opt-in (never credentials)', () => {
    const view = residentialEgressView('socks5://user:FAKE_PASS@egress-proxy.fc.svc.cluster.local:1055', SHOW);
    expect(view).toEqual({ configured: true, proxy: 'socks5://egress-proxy.fc.svc.cluster.local:1055' });
    expect(JSON.stringify(view)).not.toContain('FAKE_PASS');
    expect(JSON.stringify(view)).not.toContain('user');
  });
});

/**
 * Boot resolution: the module reads RESIDENTIAL_PROXY_URL ONCE at load (like IMPIT_TIMEOUT_MS) and
 * emits at most ONE warning for a garbage value. Each case isolates a fresh module load, since the
 * resolved value is cached at first load.
 */
describe('residentialEgress — boot resolution (module load reads process.env, warns once)', () => {
  const MODULE_PATH = '../../services/residentialEgress';
  const ORIGINAL = process.env.RESIDENTIAL_PROXY_URL;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
    if (ORIGINAL === undefined) delete process.env.RESIDENTIAL_PROXY_URL;
    else process.env.RESIDENTIAL_PROXY_URL = ORIGINAL;
  });

  it('exposes the env-configured proxy through getResidentialProxyUrl(), with no warning', () => {
    process.env.RESIDENTIAL_PROXY_URL = 'socks5://egress-proxy.fc.svc.cluster.local:1055';
    let mod!: typeof import('../../services/residentialEgress');
    jest.isolateModules(() => { mod = require(MODULE_PATH); });
    expect(mod.getResidentialProxyUrl()).toBe('socks5://egress-proxy.fc.svc.cluster.local:1055');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns ONCE at load for a garbage value and resolves to undefined (residential stores are then refused)', () => {
    process.env.RESIDENTIAL_PROXY_URL = 'socks4://nope:1080';
    let mod!: typeof import('../../services/residentialEgress');
    jest.isolateModules(() => { mod = require(MODULE_PATH); });
    expect(mod.getResidentialProxyUrl()).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('RESIDENTIAL_PROXY_URL');
    // a second read does NOT re-warn — the value is resolved once at boot
    expect(mod.getResidentialProxyUrl()).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('resolves to undefined with no warning when the env var is absent', () => {
    delete process.env.RESIDENTIAL_PROXY_URL;
    let mod!: typeof import('../../services/residentialEgress');
    jest.isolateModules(() => { mod = require(MODULE_PATH); });
    expect(mod.getResidentialProxyUrl()).toBeUndefined();
    expect(mod.residentialEgressView()).toEqual({ configured: false });
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
