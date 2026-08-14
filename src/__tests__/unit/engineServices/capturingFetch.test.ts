/**
 * createCapturingFetch — the ingest path's transport-aware raw fetch. Dispatches on a store's
 * declared SearchFetch transport (impersonate | http | browser | undeclared) exactly like
 * fetchSearch's dispatcher, but ALWAYS captures the fetched bytes to the sink (today only the
 * browser lane's navigateAndCapture does that) and returns the ingest path's `{ html }` shape.
 */
import { createCapturingFetch, type CapturingFetchTransports } from '../../../services/engineServices/capturingFetch';
import { CollectingCaptureSink } from '../../../services/captureSink';

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
});
