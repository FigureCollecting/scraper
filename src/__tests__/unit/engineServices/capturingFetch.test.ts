/**
 * createCapturingFetch — the ingest path's transport-aware raw fetch. Dispatches on a store's
 * declared SearchFetch transport (impersonate | http | browser | undeclared) exactly like
 * fetchSearch's dispatcher, but ALWAYS captures the fetched bytes to the sink (today only the
 * browser lane's navigateAndCapture does that) and returns the ingest path's `{ html }` shape.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { createCapturingFetch, ChallengePageError, type CapturingFetchTransports } from '../../../services/engineServices/capturingFetch';
import { CollectingCaptureSink } from '../../../services/captureSink';

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
      scrapePage: jest.fn(async (url: string) => {
        calls.push(['scrapePage', url]);
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

  describe('Cloudflare challenge → ChallengePageError (transport failure, not empty success)', () => {
    // Title-form managed-challenge interstitial (same shape impitFetch's re-prime fixture uses).
    const CHALLENGE = '<html><head><title>Just a moment...</title></head><body>cf challenge</body></html>';

    it('throws ChallengePageError on the impersonate lane AFTER capturing the raw body (provenance preserved)', async () => {
      const sink = new CollectingCaptureSink();
      const t: CapturingFetchTransports = {
        http: jest.fn(),
        impersonate: jest.fn(async () => CHALLENGE),
        browser: { scrapePage: jest.fn(), scrapePageStealth: jest.fn() },
      };
      const fetch = createCapturingFetch(t, sink);
      const url = 'https://www.anitoysgk.com/lucy-p29358268.html';

      const err = await fetch(url, { transport: 'impersonate', browser: 'chrome142' }).then(
        () => { throw new Error('expected ChallengePageError'); },
        e => e,
      );
      expect(err).toBeInstanceOf(ChallengePageError);
      expect(err.name).toBe('ChallengePageError');
      expect(err.url).toBe(url);
      expect(err.transport).toBe('impersonate');
      // the challenge bytes STILL reached the sink before the throw (raw-capture integrity)
      expect(sink.captures).toHaveLength(1);
      expect(sink.captures[0]).toMatchObject({ url, lane: 'api' });
      expect(sink.captures[0].bytes.toString('utf8')).toBe(CHALLENGE);
    });

    it('throws ChallengePageError on the http lane AFTER capturing the raw body', async () => {
      const sink = new CollectingCaptureSink();
      const t: CapturingFetchTransports = {
        http: jest.fn(async () => CHALLENGE),
        impersonate: jest.fn(),
        browser: { scrapePage: jest.fn(), scrapePageStealth: jest.fn() },
      };
      const fetch = createCapturingFetch(t, sink);
      const url = 'https://json.example.test/item/1';

      const err = await fetch(url, { transport: 'http' }).then(
        () => { throw new Error('expected ChallengePageError'); },
        e => e,
      );
      expect(err).toBeInstanceOf(ChallengePageError);
      expect(err.transport).toBe('http');
      expect(sink.captures).toHaveLength(1);
      expect(sink.captures[0].bytes.toString('utf8')).toBe(CHALLENGE);
    });

    it('does NOT throw for a real body on the impersonate lane (only a challenge body throws)', async () => {
      const sink = new CollectingCaptureSink();
      const t: CapturingFetchTransports = {
        http: jest.fn(),
        impersonate: jest.fn(async () => '{"json":"REAL"}'),
        browser: { scrapePage: jest.fn(), scrapePageStealth: jest.fn() },
      };
      const fetch = createCapturingFetch(t, sink);
      await expect(
        fetch('https://api.sentai.example.test/item/1', { transport: 'impersonate' })
      ).resolves.toEqual({ html: '{"json":"REAL"}' });
      expect(sink.captures).toHaveLength(1);
    });

    it('does NOT throw on the browser lane even when its body looks like a challenge (browser lane owns its own detection — regression pin)', async () => {
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
      expect(result).toEqual({ html: CHALLENGE }); // returned, NOT thrown
      expect(sink.captures).toHaveLength(0);        // browser lane captures itself, not here
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
});
