/**
 * createCapturingFetch — the ingest path's transport-aware raw fetch. Dispatches on a store's
 * declared SearchFetch transport (impersonate | http | browser | undeclared) exactly like
 * fetchSearch's dispatcher, but ALWAYS captures the fetched bytes to the sink (today only the
 * browser lane's navigateAndCapture does that) and returns the ingest path's `{ html }` shape.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { createCapturingFetch, type CapturingFetchTransports } from '../../../services/engineServices/capturingFetch';
import { CollectingCaptureSink } from '../../../services/captureSink';
import { ResidentialEgressUnavailableError } from '../../../services/residentialEgress';

/** Load a real captured HTML fixture (verbatim store bytes) from the shared fixtures dir. */
const fixture = (name: string): string =>
  readFileSync(join(__dirname, '../../fixtures/challengeDetect', name), 'utf8');

function makeTransports() {
  const calls: any[] = [];
  const t: CapturingFetchTransports = {
    http: jest.fn(async (url: string) => {
      calls.push(['http', url]);
      return 'HTTP-BODY';
    }),
    impersonate: jest.fn(async (url: string, opts: any) => {
      calls.push(['impersonate', url, opts]);
      return '{"json":"BODY"}';
    }),
    browser: {
      scrapePage: jest.fn(async (url: string, opts?: any) => {
        // Record the options only when the dispatcher passes any, so the byte-identical
        // `scrapePage(url)` call shape stays visible as a 2-element entry.
        calls.push(opts === undefined ? ['scrapePage', url] : ['scrapePage', url, opts]);
        return { html: '<html>BROWSER</html>', url, title: 'T', statusCode: 200 };
      }),
      scrapePageStealth: jest.fn(async (url: string, opts: any) => {
        calls.push(['scrapePageStealth', url, opts]);
        return { html: '<html>STEALTH</html>', url, title: 'T', statusCode: 200 };
      }),
    },
  };
  return { t, calls };
}

describe('createCapturingFetch', () => {
  it("routes 'impersonate' to the impit transport and captures the raw body under the 'api' lane", async () => {
    const { t, calls } = makeTransports();
    const sink = new CollectingCaptureSink();
    const fetch = createCapturingFetch(t, sink);

    const result = await fetch('https://api.sentai.example.test/item/1', {
      transport: 'impersonate',
      browser: 'chrome142',
      headers: { 'X-User-Key': 'x' },
    });

    expect(result).toEqual({ html: '{"json":"BODY"}' });
    expect(calls[0]).toEqual([
      'impersonate',
      'https://api.sentai.example.test/item/1',
      { browser: 'chrome142', headers: { 'X-User-Key': 'x' }, userAgent: undefined },
    ]);
    // the browser was NEVER touched for an impersonate-transport store
    expect(t.browser.scrapePage).not.toHaveBeenCalled();
    expect(t.browser.scrapePageStealth).not.toHaveBeenCalled();
    // raw bytes reached the sink
    expect(sink.captures).toHaveLength(1);
    expect(sink.captures[0]).toMatchObject({
      url: 'https://api.sentai.example.test/item/1',
      lane: 'api',
    });
    expect(sink.captures[0].bytes.toString('utf8')).toBe('{"json":"BODY"}');
  });

  it("threads a session-prime (target origin) to the impit transport for a sessionPrime store", async () => {
    const { t, calls } = makeTransports();
    const fetch = createCapturingFetch(t, new CollectingCaptureSink());

    await fetch('https://www.anitoysgk.com/lucy-p29358268.html', {
      transport: 'impersonate',
      browser: 'chrome142',
      sessionPrime: true,
    });

    expect(calls[0]).toEqual([
      'impersonate',
      'https://www.anitoysgk.com/lucy-p29358268.html',
      { browser: 'chrome142', headers: undefined, userAgent: undefined, prime: { url: 'https://www.anitoysgk.com' } },
    ]);
  });

  it("adds NO prime key for an impersonate store WITHOUT sessionPrime (undeclared → byte-identical)", async () => {
    const { t, calls } = makeTransports();
    const fetch = createCapturingFetch(t, new CollectingCaptureSink());

    await fetch('https://api.sentai.example.test/item/1', { transport: 'impersonate', browser: 'chrome142' });

    expect(calls[0][2]).not.toHaveProperty('prime');
  });

  it("routes 'http' to the plain fetch transport and captures the raw body", async () => {
    const { t, calls } = makeTransports();
    const sink = new CollectingCaptureSink();
    const fetch = createCapturingFetch(t, sink);

    const result = await fetch('https://json.example.test/item/1', { transport: 'http' });

    expect(result).toEqual({ html: 'HTTP-BODY' });
    expect(calls[0]).toEqual(['http', 'https://json.example.test/item/1']);
    expect(t.browser.scrapePage).not.toHaveBeenCalled();
    expect(sink.captures).toHaveLength(1);
    expect(sink.captures[0].lane).toBe('api');
  });

  it("routes an explicit 'browser' transport to scrapePage (no cookies) — capture is the browser lane's own job", async () => {
    const { t, calls } = makeTransports();
    const sink = new CollectingCaptureSink();
    const fetch = createCapturingFetch(t, sink);

    const result = await fetch('https://rendered.example.test/item/1', { transport: 'browser' });

    expect(result).toEqual({ html: '<html>BROWSER</html>' });
    expect(calls).toEqual([['scrapePage', 'https://rendered.example.test/item/1']]);
    // capturingFetch does not double-capture the browser lane (navigateAndCapture owns that)
    expect(sink.captures).toHaveLength(0);
  });

  it('defaults an UNDECLARED transport to the browser lane (regression guard for HTML-rendered rulesets)', async () => {
    const { t, calls } = makeTransports();
    const sink = new CollectingCaptureSink();
    const fetch = createCapturingFetch(t, sink);

    const result = await fetch('https://myfigurecollection.net/item/12345', undefined);

    expect(result).toEqual({ html: '<html>BROWSER</html>' });
    expect(calls).toEqual([['scrapePage', 'https://myfigurecollection.net/item/12345']]);
    expect(sink.captures).toHaveLength(0);
  });

  it('uses scrapePageStealth when cookies are supplied, for the browser lane only', async () => {
    const { t, calls } = makeTransports();
    const sink = new CollectingCaptureSink();
    const fetch = createCapturingFetch(t, sink);
    const cookies = { PHPSESSID: 'abc' };

    const result = await fetch('https://myfigurecollection.net/item/12345', undefined, { cookies });

    expect(result).toEqual({ html: '<html>STEALTH</html>' });
    expect(calls).toEqual([['scrapePageStealth', 'https://myfigurecollection.net/item/12345', { cookies }]]);
  });

  it('a capture-sink failure never breaks the fetch (impersonate lane)', async () => {
    const { t } = makeTransports();
    const sink = { capture: jest.fn().mockRejectedValue(new Error('object store down')) };
    const fetch = createCapturingFetch(t, sink);

    await expect(
      fetch('https://api.sentai.example.test/item/1', { transport: 'impersonate' })
    ).resolves.toEqual({ html: '{"json":"BODY"}' });
  });

  describe('Cloudflare challenge → flagged challenge:true, NOT thrown (the honesty gate owns it)', () => {
    // Title-form managed-challenge interstitial (same shape impitFetch's re-prime fixture uses).
    const CHALLENGE = '<html><head><title>Just a moment...</title></head><body>cf challenge</body></html>';

    it('flags challenge:true + transport on the impersonate lane, captures the raw body, warns once, does NOT throw', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const sink = new CollectingCaptureSink();
      const t: CapturingFetchTransports = {
        http: jest.fn(),
        impersonate: jest.fn(async () => CHALLENGE),
        browser: { scrapePage: jest.fn(), scrapePageStealth: jest.fn() },
      };
      const fetch = createCapturingFetch(t, sink);
      const url = 'https://www.anitoysgk.com/lucy-p29358268.html';

      const result = await fetch(url, { transport: 'impersonate', browser: 'chrome142' });
      expect(result).toEqual({ html: CHALLENGE, challenge: true, transport: 'impersonate' });
      // the challenge bytes STILL reached the sink (raw-capture integrity) — flag does not skip capture
      expect(sink.captures).toHaveLength(1);
      expect(sink.captures[0]).toMatchObject({ url, lane: 'api' });
      expect(sink.captures[0].bytes.toString('utf8')).toBe(CHALLENGE);
      // exactly one warn line at the lane, naming the sanitized url + transport
      const warnLines = warnSpy.mock.calls
        .map(c => String(c[0]))
        .filter(l => l.includes('[FETCH] Cloudflare challenge/block page received'));
      expect(warnLines).toHaveLength(1);
      expect(warnLines[0]).toContain('via impersonate transport');
      expect(warnLines[0]).toContain(url);
      warnSpy.mockRestore();
    });

    it('flags challenge:true + transport on the http lane and captures the raw body', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const sink = new CollectingCaptureSink();
      const t: CapturingFetchTransports = {
        http: jest.fn(async () => CHALLENGE),
        impersonate: jest.fn(),
        browser: { scrapePage: jest.fn(), scrapePageStealth: jest.fn() },
      };
      const fetch = createCapturingFetch(t, sink);
      const url = 'https://json.example.test/item/1';

      const result = await fetch(url, { transport: 'http' });
      expect(result).toEqual({ html: CHALLENGE, challenge: true, transport: 'http' });
      expect(sink.captures).toHaveLength(1);
      expect(sink.captures[0].bytes.toString('utf8')).toBe(CHALLENGE);
      expect(warnSpy.mock.calls.map(c => String(c[0])).some(l => l.includes('via http transport'))).toBe(true);
      warnSpy.mockRestore();
    });

    it('does NOT flag challenge for a real body on the impersonate lane (challenge/transport keys absent)', async () => {
      const sink = new CollectingCaptureSink();
      const t: CapturingFetchTransports = {
        http: jest.fn(),
        impersonate: jest.fn(async () => '{"json":"REAL"}'),
        browser: { scrapePage: jest.fn(), scrapePageStealth: jest.fn() },
      };
      const fetch = createCapturingFetch(t, sink);
      const result = await fetch('https://api.sentai.example.test/item/1', { transport: 'impersonate' });
      expect(result).toEqual({ html: '{"json":"REAL"}' }); // no challenge/transport keys on a normal body
      expect(result).not.toHaveProperty('challenge');
      expect(sink.captures).toHaveLength(1);
    });

    it('flags challenge:true + transport:browser on the BROWSER lane too (a browser interstitial now gets the same one-shot + cooldown discipline; capture stays the lane\'s own)', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const sink = new CollectingCaptureSink();
      const t: CapturingFetchTransports = {
        http: jest.fn(),
        impersonate: jest.fn(),
        browser: {
          scrapePage: jest.fn(async (url: string) => ({ html: CHALLENGE, url, title: 'Just a moment...', statusCode: 200 })),
          scrapePageStealth: jest.fn(),
        },
      };
      const fetch = createCapturingFetch(t, sink);

      const result = await fetch('https://myfigurecollection.net/item/12345', { transport: 'browser' });
      expect(result).toEqual({ html: CHALLENGE, challenge: true, transport: 'browser' });
      expect(sink.captures).toHaveLength(0);        // browser lane captures itself (navigateAndCapture), not here
      const warnLines = warnSpy.mock.calls.map(c => String(c[0])).filter(l => l.includes('[FETCH] Cloudflare challenge/block page received'));
      expect(warnLines).toHaveLength(1);
      expect(warnLines[0]).toContain('via browser transport');
      warnSpy.mockRestore();
    });

    it('does NOT flag a real body on the browser lane (challenge/transport keys absent)', async () => {
      const { t } = makeTransports();
      const fetch = createCapturingFetch(t, new CollectingCaptureSink());
      const result = await fetch('https://myfigurecollection.net/item/12345', { transport: 'browser' });
      expect(result).toEqual({ html: '<html>BROWSER</html>' });
      expect(result).not.toHaveProperty('challenge');
    });
  });

  describe('real Bot-Management page (challenge-platform telemetry) → resolves, never ChallengePageError (RS-1)', () => {
    it('http lane returns a real fnc product page (precursor telemetry) instead of throwing', async () => {
      const html = fixture('fnc-product.html');
      const sink = new CollectingCaptureSink();
      const t: CapturingFetchTransports = {
        http: jest.fn(async () => html),
        impersonate: jest.fn(),
        browser: { scrapePage: jest.fn(), scrapePageStealth: jest.fn() },
      };
      const fetch = createCapturingFetch(t, sink);
      const url = 'https://www.fanaticanimestore.com/product/griffith';

      // Must resolve with the real bytes — the http-transport fnc ingest depends on this NOT throwing.
      await expect(fetch(url, { transport: 'http' })).resolves.toEqual({ html });
      expect(sink.captures).toHaveLength(1);
      expect(sink.captures[0].bytes.toString('utf8')).toBe(html);
    });

    it('impersonate lane returns a real MFC page (inline jsd telemetry) instead of throwing', async () => {
      const html = fixture('mfc-item.html');
      const sink = new CollectingCaptureSink();
      const t: CapturingFetchTransports = {
        http: jest.fn(),
        impersonate: jest.fn(async () => html),
        browser: { scrapePage: jest.fn(), scrapePageStealth: jest.fn() },
      };
      const fetch = createCapturingFetch(t, sink);

      await expect(
        fetch('https://myfigurecollection.net/item/107714', { transport: 'impersonate', browser: 'chrome142' }),
      ).resolves.toEqual({ html });
      expect(sink.captures).toHaveLength(1);
    });
  });

  describe('Cloudflare block / rate-limit error page → flagged challenge:true (RD-2)', () => {
    it('flags challenge:true on the impersonate lane for a real CF 1020 block body AFTER capturing it', async () => {
      const block = fixture('cf-block-1020-amiami.html');
      const sink = new CollectingCaptureSink();
      const t: CapturingFetchTransports = {
        http: jest.fn(),
        impersonate: jest.fn(async () => block),
        browser: { scrapePage: jest.fn(), scrapePageStealth: jest.fn() },
      };
      const fetch = createCapturingFetch(t, sink);
      const url = 'https://www.amiami.com/item/1';

      const result = await fetch(url, { transport: 'impersonate', browser: 'chrome142' });
      expect(result).toEqual({ html: block, challenge: true, transport: 'impersonate' });
      // provenance still captured even for a block body
      expect(sink.captures).toHaveLength(1);
      expect(sink.captures[0].bytes.toString('utf8')).toBe(block);
    });

    it('flags challenge:true on the http lane for a real CF 1020 block body', async () => {
      const block = fixture('cf-block-1020-sugo.html');
      const sink = new CollectingCaptureSink();
      const t: CapturingFetchTransports = {
        http: jest.fn(async () => block),
        impersonate: jest.fn(),
        browser: { scrapePage: jest.fn(), scrapePageStealth: jest.fn() },
      };
      const fetch = createCapturingFetch(t, sink);

      const result = await fetch('https://sugo.example.test/item/1', { transport: 'http' });
      expect(result).toMatchObject({ challenge: true, transport: 'http' });
      expect(sink.captures).toHaveLength(1);
    });
  });

  /**
   * Stealth selection with STORED cookies (CfCookieStore): CF stores whose cookies live in the jar
   * must ride the stealth browser even when the item carries no request cookies. The dispatcher only
   * CHOOSES the browser; the lane (navigateAndCapture) merges the store's cookies itself, so nothing
   * is forwarded for a store-only hit. Item cookies keep their exact pre-existing call shape.
   */
  describe('browser lane × stored cookies — stealth selection matrix', () => {
    // Plain functions (not jest.fn): the harness runs resetMocks, which would wipe a describe-scoped fake's implementation.
    const cookieStore = {
      cookiesFor: (url: string) => (url.includes('myfigurecollection.net') ? { cf_clearance: 'FAKE_cf_1' } : undefined),
      userAgentFor: () => undefined,
    };
    const ITEM = { PHPSESSID: 'FAKE_item_sess' };

    it('no item cookies + no store cookies → plain scrapePage (unchanged)', async () => {
      const { t, calls } = makeTransports();
      const fetch = createCapturingFetch(t, new CollectingCaptureSink(), { cookieStore });
      await fetch('https://rendered.example.test/item/1', { transport: 'browser' });
      expect(calls).toEqual([['scrapePage', 'https://rendered.example.test/item/1']]);
    });

    it('item cookies only → scrapePageStealth(url, { cookies }) (unchanged shape)', async () => {
      const { t, calls } = makeTransports();
      const fetch = createCapturingFetch(t, new CollectingCaptureSink(), { cookieStore });
      await fetch('https://rendered.example.test/item/1', undefined, { cookies: ITEM });
      expect(calls).toEqual([['scrapePageStealth', 'https://rendered.example.test/item/1', { cookies: ITEM }]]);
    });

    it('store cookies only → scrapePageStealth with NO item cookies forwarded (the lane merges the store itself)', async () => {
      const { t, calls } = makeTransports();
      const fetch = createCapturingFetch(t, new CollectingCaptureSink(), { cookieStore });
      const result = await fetch('https://myfigurecollection.net/item/12345', undefined);
      expect(calls).toEqual([['scrapePageStealth', 'https://myfigurecollection.net/item/12345', {}]]);
      expect(result).toEqual({ html: '<html>STEALTH</html>' });
      expect(t.browser.scrapePage).not.toHaveBeenCalled();
    });

    it('both → scrapePageStealth(url, { cookies: item }) — item cookies still travel as before', async () => {
      const { t, calls } = makeTransports();
      const fetch = createCapturingFetch(t, new CollectingCaptureSink(), { cookieStore });
      await fetch('https://myfigurecollection.net/item/12345', { transport: 'browser' }, { cookies: ITEM });
      expect(calls).toEqual([['scrapePageStealth', 'https://myfigurecollection.net/item/12345', { cookies: ITEM }]]);
    });

    it('the store is never consulted for the impersonate / http lanes (their calls are byte-identical)', async () => {
      const { t, calls } = makeTransports();
      const spyStore = { cookiesFor: jest.fn(() => ({ cf_clearance: 'FAKE_cf_1' })), userAgentFor: jest.fn(() => 'FAKE-UA') };
      const fetch = createCapturingFetch(t, new CollectingCaptureSink(), { cookieStore: spyStore });
      await fetch('https://api.sentai.example.test/item/1', { transport: 'impersonate', browser: 'chrome142' });
      await fetch('https://json.example.test/item/1', { transport: 'http' });
      expect(calls).toEqual([
        ['impersonate', 'https://api.sentai.example.test/item/1', { browser: 'chrome142', headers: undefined, userAgent: undefined }],
        ['http', 'https://json.example.test/item/1'],
      ]);
      expect(spyStore.cookiesFor).not.toHaveBeenCalled();
      expect(spyStore.userAgentFor).not.toHaveBeenCalled();
    });

    it('a stealth (store-cookie) browser fetch that returns a challenge is flagged transport:browser', async () => {
      const t: CapturingFetchTransports = {
        http: jest.fn(),
        impersonate: jest.fn(),
        browser: {
          scrapePage: jest.fn(),
          scrapePageStealth: jest.fn(async (url: string) => ({ html: '<html><head><title>Just a moment...</title></head><body>cf</body></html>', url, title: 'Just a moment...', statusCode: 200 })),
        },
      };
      const fetch = createCapturingFetch(t, new CollectingCaptureSink(), { cookieStore });
      const result = await fetch('https://myfigurecollection.net/item/1', undefined);
      expect(result).toMatchObject({ challenge: true, transport: 'browser' });
    });
  });
});

/**
 * RESIDENTIAL EGRESS on the INGEST path (contract 0.7.0) — same rules as the search dispatcher:
 * the declared store's fetch is routed through the configured residential proxy (impit `proxyUrl`,
 * browser per-context `proxyServer`), an unconfigured proxy is a typed REFUSAL before any fetch or
 * capture, and the plain-HTTP lane (which cannot proxy) refuses a residential store outright.
 * `waitFor` rides to the browser lane so a PWA storefront is captured rendered, not as its shell.
 */
describe('createCapturingFetch — residential egress + waitFor', () => {
  const PROXY = 'socks5://egress-proxy.fc.svc.cluster.local:1055';
  const withProxy = (t: CapturingFetchTransports, sink: CollectingCaptureSink) =>
    createCapturingFetch(t, sink, { residentialProxyUrl: () => PROXY });
  const noProxy = (t: CapturingFetchTransports, sink: CollectingCaptureSink) =>
    createCapturingFetch(t, sink, { residentialProxyUrl: () => undefined });

  it('threads the proxy into impit for a residential impersonate store, and still captures the body', async () => {
    const { t, calls } = makeTransports();
    const sink = new CollectingCaptureSink();

    const result = await withProxy(t, sink)('https://www.anitoysgk.com/lucy-p29358268.html', {
      transport: 'impersonate', browser: 'chrome142', egress: 'residential',
    });

    expect(result).toEqual({ html: '{"json":"BODY"}' });
    expect(calls[0][2]).toMatchObject({ browser: 'chrome142', proxyUrl: PROXY });
    expect(sink.captures).toHaveLength(1);
  });

  it('adds NO proxyUrl key for an undeclared store even when a proxy IS configured (byte-identical)', async () => {
    const { t, calls } = makeTransports();
    await withProxy(t, new CollectingCaptureSink())('https://api.sentai.example.test/item/1', {
      transport: 'impersonate', browser: 'chrome142',
    });
    expect(calls[0][2]).not.toHaveProperty('proxyUrl');
  });

  it('REFUSES a residential store when no proxy is configured — no fetch, no capture', async () => {
    const { t, calls } = makeTransports();
    const sink = new CollectingCaptureSink();

    await expect(noProxy(t, sink)('https://www.anitoysgk.com/lucy-p29358268.html', {
      transport: 'impersonate', egress: 'residential',
    })).rejects.toThrow(ResidentialEgressUnavailableError);

    expect(calls).toHaveLength(0);
    expect(sink.captures).toHaveLength(0);
  });

  it('REFUSES a residential store on the plain-HTTP lane (it cannot proxy)', async () => {
    const { t, calls } = makeTransports();
    await expect(withProxy(t, new CollectingCaptureSink())('https://www.anitoysgk.com/api/item/1', {
      transport: 'http', egress: 'residential',
    })).rejects.toThrow(/impersonate/);
    expect(calls).toHaveLength(0);
  });

  it('threads proxyServer + waitFor into the browser lane WITHOUT changing the stealth choice (cookies still decide it)', async () => {
    const { t, calls } = makeTransports();
    await withProxy(t, new CollectingCaptureSink())('https://www.crunchyroll-store.test/p/1', {
      transport: 'browser', egress: 'residential', waitFor: { selector: '[data-t="price"]', timeoutMs: 20000 },
    });
    // Egress is orthogonal to stealth: with no request/stored cookies this stays the plain lane.
    expect(calls[0][0]).toBe('scrapePage');
    expect(calls[0][2]).toEqual({
      proxyServer: PROXY,
      waitFor: { selector: '[data-t="price"]', timeoutMs: 20000 },
    });
  });

  it('carries proxyServer + waitFor on the STEALTH lane too when the item brings cookies', async () => {
    const { t, calls } = makeTransports();
    await withProxy(t, new CollectingCaptureSink())(
      'https://www.anitoysgk.com/lucy-p29358268.html',
      { transport: 'browser', egress: 'residential', waitFor: { networkIdle: true } },
      { cookies: { PHPSESSID: 'abc' } },
    );
    expect(calls[0][0]).toBe('scrapePageStealth');
    expect(calls[0][2]).toEqual({
      cookies: { PHPSESSID: 'abc' },
      proxyServer: PROXY,
      waitFor: { networkIdle: true },
    });
  });

  it('threads waitFor alone into the non-stealth browser lane for a DIRECT PWA store', async () => {
    const { t, calls } = makeTransports();
    await withProxy(t, new CollectingCaptureSink())('https://www.crunchyroll-store.test/p/1', {
      transport: 'browser', waitFor: { networkIdle: true },
    });
    expect(calls[0][0]).toBe('scrapePage');
    expect(calls[0][2]).toEqual({ waitFor: { networkIdle: true } });
  });

  it('an UNDECLARED store still takes the plain browser lane with no options at all (byte-identical)', async () => {
    const { t, calls } = makeTransports();
    await withProxy(t, new CollectingCaptureSink())('https://legacy.example.test/item/1', undefined);
    expect(calls[0]).toEqual(['scrapePage', 'https://legacy.example.test/item/1']);
  });

  it('defaults to the engine\'s configured proxy when no resolver is injected (unset env ⇒ residential refused)', async () => {
    const { t, calls } = makeTransports();
    await expect(createCapturingFetch(t, new CollectingCaptureSink())('https://www.anitoysgk.com/x', {
      transport: 'impersonate', egress: 'residential',
    })).rejects.toThrow(ResidentialEgressUnavailableError);
    expect(calls).toHaveLength(0);
  });
});

/**
 * THE CHALLENGE GATE on the INGEST path. The search dispatcher (fetchSearch), the /resolve detail
 * fetch and the ExtractContext passthroughs all turn a store's `searchFetch` into browser-lane
 * wiring through ONE resolver (`resolveBrowserLaneOptions`) — the ingest raw fetch used to build
 * its own options from `proxyUrl` + `waitFor` alone, so `access: 'cloudflare'` and `sessionPrime`
 * were DROPPED: `POST /ingest/scrape` for anitoysgk.com took the per-request-context path (measured
 * in production 2026-09-07, engine 424a270b: "Creating the challenge-lane browser", a challenge body
 * back, and /health/detailed.browserLane.gatedBrowsers still empty). The ingest path resolves the
 * same lane options as every other caller now — gate, prime, egress and readiness together.
 */
describe('createCapturingFetch — browser lane resolves the SAME options as the dispatchers', () => {
  const PROXY = 'socks5://egress-proxy.fc.svc.cluster.local:1055';
  /** No stored cookies for any host: the stealth CHOICE stays out of these assertions. */
  const bareStore = { cookiesFor: () => undefined, userAgentFor: () => undefined };
  const gated = (t: CapturingFetchTransports) =>
    createCapturingFetch(t, new CollectingCaptureSink(), {
      cookieStore: bareStore,
      residentialProxyUrl: () => PROXY,
    });
  const gatedNoProxy = (t: CapturingFetchTransports) =>
    createCapturingFetch(t, new CollectingCaptureSink(), {
      cookieStore: bareStore,
      residentialProxyUrl: () => undefined,
    });

  it('a gated RESIDENTIAL store rides the gate, the prime and the proxy (the anitoys ingest case)', async () => {
    const { t, calls } = makeTransports();

    await gated(t)('https://www.anitoysgk.com/lucy-p29358268.html', {
      transport: 'browser', egress: 'residential', access: 'cloudflare', sessionPrime: true,
    });

    expect(calls[0]).toEqual([
      'scrapePage',
      'https://www.anitoysgk.com/lucy-p29358268.html',
      { proxyServer: PROXY, challengeGated: true, primeUrl: 'https://www.anitoysgk.com' },
    ]);
  });

  it('honours an explicit primeUrl override, exactly like the search dispatcher', async () => {
    const { t, calls } = makeTransports();

    await gated(t)('https://sugotoys.com.au/wp-json/wc/store/products/1', {
      transport: 'browser', access: 'cloudflare', sessionPrime: { primeUrl: 'https://sugotoys.com.au/shop' },
    });

    expect(calls[0][2]).toEqual({ challengeGated: true, primeUrl: 'https://sugotoys.com.au/shop' });
  });

  it('a gated DIRECT store (no egress declared) still rides the gated browser, with NO proxyServer', async () => {
    const { t, calls } = makeTransports();

    await gated(t)('https://hobby-genki.com/item/1', { transport: 'browser', access: 'cloudflare' });

    expect(calls[0][2]).toEqual({ challengeGated: true });
    expect(calls[0][2]).not.toHaveProperty('proxyServer');
  });

  it('carries the gate onto the STEALTH lane too when the host has stored cookies', async () => {
    const { t, calls } = makeTransports();
    const store = { cookiesFor: () => ({ cf_clearance: 'FAKE_cf_1' }), userAgentFor: () => undefined };
    const fetch = createCapturingFetch(t, new CollectingCaptureSink(), {
      cookieStore: store, residentialProxyUrl: () => PROXY,
    });

    await fetch('https://www.anitoysgk.com/lucy-p29358268.html', {
      transport: 'browser', egress: 'residential', access: 'cloudflare', sessionPrime: true,
    });

    expect(calls[0][0]).toBe('scrapePageStealth');
    expect(calls[0][2]).toEqual({
      proxyServer: PROXY, challengeGated: true, primeUrl: 'https://www.anitoysgk.com',
    });
  });

  it('waitFor still rides alongside the gate', async () => {
    const { t, calls } = makeTransports();

    await gated(t)('https://www.anitoysgk.com/lucy-p29358268.html', {
      transport: 'browser', egress: 'residential', access: 'cloudflare', waitFor: { networkIdle: true },
    });

    expect(calls[0][2]).toEqual({
      proxyServer: PROXY, waitFor: { networkIdle: true }, challengeGated: true,
    });
  });

  it("adds neither key for an UNGATED browser store (access:'open' and undeclared are byte-identical)", async () => {
    const { t, calls } = makeTransports();

    await gated(t)('https://alpha.example.test/item/1', { transport: 'browser', access: 'open' });
    await gated(t)('https://alpha.example.test/item/2', { transport: 'browser' });
    await gated(t)('https://alpha.example.test/item/3', undefined);

    expect(calls).toEqual([
      ['scrapePage', 'https://alpha.example.test/item/1'],
      ['scrapePage', 'https://alpha.example.test/item/2'],
      ['scrapePage', 'https://alpha.example.test/item/3'],
    ]);
  });

  it('still REFUSES a residential gated store with no configured proxy — before any fetch, and ONCE', async () => {
    const { t, calls } = makeTransports();

    await expect(gatedNoProxy(t)('https://www.anitoysgk.com/lucy-p29358268.html', {
      transport: 'browser', egress: 'residential', access: 'cloudflare', sessionPrime: true,
    })).rejects.toThrow(ResidentialEgressUnavailableError);

    expect(calls).toHaveLength(0);
  });
});
