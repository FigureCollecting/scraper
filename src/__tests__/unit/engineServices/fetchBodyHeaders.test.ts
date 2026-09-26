/**
 * `ctx.scraping.fetchBody` request headers (plugin-contract 0.15.0): a closed allowlist a ruleset may
 * set (origin, referer, accept, accept-language, x-requested-with, case-insensitive), everything else
 * refused before any wait or fetch; the http/impersonate lanes carry them, the browser lane refuses
 * them; the capture records a hash of them beside the method/body hash. And the `cookies` option is
 * refused: the engine owns cookies, exactly as it owns the Cookie header.
 */
import { createHash } from 'node:crypto';
import { buildExtractContext, FetchBodyRequestError } from '../../../services/engineServices/extractContext';
import {
  createCapturingFetch,
  FetchHeadersUnsupportedError,
  FetchMethodUnsupportedError,
  DEFAULT_POST_CONTENT_TYPE,
  type CapturingFetchTransports,
} from '../../../services/engineServices/capturingFetch';
import { buildRawCapture, canonicalRequestHeaders, CollectingCaptureSink } from '../../../services/captureSink';
import { FETCH_BODY_ALLOWED_HEADERS, type SearchFetch, type SiteConfig } from '@figurecollecting/scraper-plugin-contract';

const CONFIG = { siteId: 'mandarake', baseUrl: 'https://order.mandarake.co.jp' } as unknown as SiteConfig;
const LOGGER = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
const PRIMARY = 'https://order.mandarake.co.jp/order/detailPage/item?itemCode=1315522194&lang=en';
const GETINFO = 'https://my.mandarake.co.jp/ItemDetailInfo/getInfo/';
const SAME_HOST = 'https://order.mandarake.co.jp/order/other';
const ORIGIN = 'https://order.mandarake.co.jp';
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

function ctx(over: { searchFetch?: SearchFetch; cookies?: Record<string, string>; now?: () => number } = {}) {
  const capturingFetch = jest.fn(async (_url: string, _sf: SearchFetch | undefined, _o?: unknown) => ({
    html: '{"status":"ok","zaiko":1}',
    status: 200,
  }));
  const sleep = jest.fn(async () => {});
  const c = buildExtractContext({
    config: CONFIG,
    logger: LOGGER,
    scraping: {
      scrapePage: jest.fn(async () => ({ html: '', url: '', title: '' })),
      scrapePageStealth: jest.fn(async () => ({ html: '', url: '', title: '' })),
    },
    capturingFetch,
    searchFetch: over.searchFetch ?? { transport: 'http' },
    ...(over.cookies ? { cookies: over.cookies } : {}),
    primaryUrl: PRIMARY,
    primaryFetchedAt: 0,
    baseDelayMs: 3000,
    now: over.now ?? (() => 10_000_000),
    sleep,
  });
  return { c, capturingFetch, sleep };
}

describe('the fetchBody header allowlist (contract 0.15.0)', () => {
  it('is exactly origin, referer, accept, accept-language and x-requested-with', () => {
    expect([...FETCH_BODY_ALLOWED_HEADERS]).toEqual(['origin', 'referer', 'accept', 'accept-language', 'x-requested-with']);
  });

  it.each([
    ['origin', ORIGIN],
    ['Origin', ORIGIN],
    ['ORIGIN', ORIGIN],
    ['referer', PRIMARY],
    ['Referer', PRIMARY],
    ['accept', 'application/json'],
    ['Accept', 'application/json'],
    ['accept-language', 'en'],
    ['Accept-Language', 'ja,en;q=0.8'],
    ['x-requested-with', 'XMLHttpRequest'],
    ['X-Requested-With', 'XMLHttpRequest'],
  ])('%s is accepted, and reaches the lane under its lowercase name', async (name, value) => {
    const { c, capturingFetch } = ctx();
    await c.scraping.fetchBody!(GETINFO, { headers: { [name]: value } } as never);
    expect(capturingFetch).toHaveBeenCalledWith(GETINFO, { transport: 'http' }, {
      request: { method: 'GET', headers: { [name.toLowerCase()]: value } },
    });
  });

  it('a POST carries its headers beside the method, body and Content-Type', async () => {
    const { c, capturingFetch } = ctx();
    await c.scraping.fetchBody!(GETINFO, {
      method: 'POST',
      body: 'idx=1315522194&lang=en',
      headers: { Origin: ORIGIN, Referer: PRIMARY },
    });
    expect(capturingFetch.mock.calls[0][2]).toEqual({
      request: {
        method: 'POST',
        body: 'idx=1315522194&lang=en',
        contentType: DEFAULT_POST_CONTENT_TYPE,
        headers: { origin: ORIGIN, referer: PRIMARY },
      },
    });
  });

  it('an empty headers object is the same call as none (a bare GET, no request key)', async () => {
    const { c, capturingFetch } = ctx();
    await c.scraping.fetchBody!(GETINFO, { headers: {} });
    expect(capturingFetch).toHaveBeenCalledWith(GETINFO, { transport: 'http' }, {});
  });

  it('a null-prototype object is a plain object too', async () => {
    const { c, capturingFetch } = ctx();
    const headers = Object.assign(Object.create(null) as Record<string, string>, { origin: ORIGIN });
    await c.scraping.fetchBody!(GETINFO, { headers });
    expect(capturingFetch.mock.calls[0][2]).toEqual({ request: { method: 'GET', headers: { origin: ORIGIN } } });
  });

  it('surrounding spaces and tabs are not part of a value (RFC 9110 OWS) and are dropped', async () => {
    const { c, capturingFetch } = ctx();
    await c.scraping.fetchBody!(GETINFO, { headers: { origin: ` \t${ORIGIN} ` } });
    expect(capturingFetch.mock.calls[0][2]).toEqual({ request: { method: 'GET', headers: { origin: ORIGIN } } });
  });

  it.each([
    ['cookie', { cookie: 'a=1' }, /header 'cookie' is not one a ruleset may set/],
    ['Cookie', { Cookie: 'a=1' }, /header 'Cookie' is not one a ruleset may set/],
    ['authorization', { authorization: 'Bearer x' }, /header 'authorization' is not one/],
    ['host', { host: 'evil.test' }, /header 'host' is not one/],
    ['user-agent', { 'User-Agent': 'x' }, /header 'User-Agent' is not one/],
    ['content-length', { 'content-length': '1' }, /header 'content-length' is not one/],
    ['content-type', { 'content-type': 'text/plain' }, /header 'content-type' is not one/],
    ['proxy-authorization', { 'proxy-authorization': 'Basic x' }, /header 'proxy-authorization' is not one/],
    ['proxy-connection', { 'Proxy-Connection': 'keep-alive' }, /header 'Proxy-Connection' is not one/],
    ['sec-fetch-site', { 'sec-fetch-site': 'same-origin' }, /header 'sec-fetch-site' is not one/],
    ['sec-ch-ua', { 'Sec-CH-UA': '"x"' }, /header 'Sec-CH-UA' is not one/],
    ['x-forwarded-for', { 'x-forwarded-for': '1.2.3.4' }, /header 'x-forwarded-for' is not one/],
    ['an unlisted store header', { 'x-user-key': 'amiami_dev' }, /header 'x-user-key' is not one/],
    ['CR/LF in a name', { 'origin\r\nx-evil': '1' }, /header name contains CR or LF/],
    ['LF in a name', { 'origin\nx': '1' }, /header name contains CR or LF/],
    ['CR/LF in a value', { origin: `${ORIGIN}\r\nCookie: a=1` }, /header 'origin' value contains CR or LF/],
    ['a bare LF in a value', { referer: `${PRIMARY}\nx` }, /header 'referer' value contains CR or LF/],
    ['a bare CR in a value', { accept: 'a\rb' }, /header 'accept' value contains CR or LF/],
    ['NUL in a value', { accept: 'a\u0000b' }, /header 'accept' value must be printable ASCII/],
    ['non-ASCII in a value', { 'accept-language': 'jaあ' }, /header 'accept-language' value must be printable ASCII/],
    ['a non-string value', { origin: 1 }, /header 'origin' value must be a string/],
    ['one name given twice in two cases', { origin: ORIGIN, Origin: ORIGIN }, /header 'origin' is given twice/],
  ])('%s is refused before any wait or fetch', async (_name, headers, message) => {
    // Same host as the primary and inside its courtesy gap, so a check placed after the wait would sleep.
    const { c, capturingFetch, sleep } = ctx({ now: () => 1000 });
    const call = c.scraping.fetchBody!(SAME_HOST, { method: 'POST', body: 'a=1', headers } as never);
    await expect(call).rejects.toBeInstanceOf(FetchBodyRequestError);
    await expect(c.scraping.fetchBody!(SAME_HOST, { headers } as never)).rejects.toThrow(message);
    expect(capturingFetch).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('the refusal names the allowlist and never echoes a control character', async () => {
    const { c } = ctx();
    const err = await c.scraping.fetchBody!(GETINFO, { headers: { 'x-a\u001b[31m': '1' } } as never).catch((e: Error) => e);
    expect((err as Error).message).toContain('origin, referer, accept, accept-language, x-requested-with');
    expect((err as Error).message).not.toMatch(/[\u0000-\u001f]/);
  });

  it.each([
    ['a string', 'origin: x'],
    ['an array', [['origin', ORIGIN]]],
    ['null', null],
    ['a Map (which has no own entries, so would be dropped silently)', new Map([['origin', ORIGIN]])],
    ['a WHATWG Headers', new Headers({ origin: ORIGIN })],
  ])('headers given as %s are refused', async (_name, headers) => {
    const { c, capturingFetch } = ctx();
    await expect(c.scraping.fetchBody!(GETINFO, { headers } as never)).rejects.toThrow(/headers must be a plain object/);
    expect(capturingFetch).not.toHaveBeenCalled();
  });
});

describe('the fetchBody cookies option is refused (contract 0.15.0)', () => {
  it('a ruleset cookie map is refused before any wait or fetch', async () => {
    const { c, capturingFetch, sleep } = ctx({ now: () => 1000 });
    await expect(c.scraping.fetchBody!(SAME_HOST, { cookies: { session: 'abc' } })).rejects.toThrow(
      /cookies are not a fetchBody option: the engine owns the cookie jar/,
    );
    await expect(c.scraping.fetchBody!(SAME_HOST, { method: 'POST', cookies: {} })).rejects.toBeInstanceOf(FetchBodyRequestError);
    expect(capturingFetch).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("the item's own cookies (engine-supplied, not the ruleset's) still reach the lane as before", async () => {
    const { c, capturingFetch } = ctx({ cookies: { PHPSESSID: 'item' } });
    await c.scraping.fetchBody!(GETINFO, { headers: { origin: ORIGIN } });
    expect(capturingFetch.mock.calls[0][2]).toEqual({
      cookies: { PHPSESSID: 'item' },
      request: { method: 'GET', headers: { origin: ORIGIN } },
    });
  });
});

function transports(body = '{"status":"ok","zaiko":1}') {
  const t: CapturingFetchTransports = {
    http: jest.fn(async (..._args: unknown[]) => ({ body, status: 200 })),
    impersonate: jest.fn(async (..._args: unknown[]) => ({ body, status: 200 })),
    browser: {
      scrapePage: jest.fn(async (url: string) => ({ html: '<html/>', url, title: '' })),
      scrapePageStealth: jest.fn(async (url: string) => ({ html: '<html/>', url, title: '' })),
    },
  };
  return t;
}

const HEADERS = { origin: ORIGIN, referer: PRIMARY };
const GET_H = { method: 'GET' as const, headers: HEADERS };
const POST_H = { method: 'POST' as const, body: 'idx=1315522194&lang=en', contentType: DEFAULT_POST_CONTENT_TYPE, headers: HEADERS };
const canon = `origin:${ORIGIN}\nreferer:${PRIMARY}\n`;

describe('capturingFetch lanes for a request with headers', () => {
  it('http: a GET with headers hands the transport the request; its capture hashes the headers and names no method', async () => {
    const t = transports();
    const sink = new CollectingCaptureSink();
    await createCapturingFetch(t, sink)(GETINFO, { transport: 'http' }, { request: GET_H });
    expect(t.http).toHaveBeenCalledWith(GETINFO, GET_H);
    expect(sink.captures[0]).toMatchObject({ url: GETINFO, lane: 'api', requestHeadersSha256: sha(canon) });
    expect(sink.captures[0]).not.toHaveProperty('method');
    expect(sink.captures[0]).not.toHaveProperty('requestBodySha256');
  });

  it('http: a POST with headers records the method, the body hash and the headers hash', async () => {
    const t = transports();
    const sink = new CollectingCaptureSink();
    await createCapturingFetch(t, sink)(GETINFO, { transport: 'http' }, { request: POST_H });
    expect(t.http).toHaveBeenCalledWith(GETINFO, POST_H);
    expect(sink.captures[0]).toMatchObject({
      method: 'POST',
      requestBodySha256: sha(POST_H.body),
      requestHeadersSha256: sha(canon),
    });
  });

  it('a POST without headers records no headers hash (the 0.14.0 capture, unchanged)', async () => {
    const sink = new CollectingCaptureSink();
    const { headers: _h, ...bare } = POST_H;
    await createCapturingFetch(transports(), sink)(GETINFO, { transport: 'http' }, { request: bare });
    expect(sink.captures[0]).toHaveProperty('method', 'POST');
    expect(sink.captures[0]).not.toHaveProperty('requestHeadersSha256');
  });

  it('the same url and body sent with and without an Origin are told apart in their captures', async () => {
    const sink = new CollectingCaptureSink();
    const f = createCapturingFetch(transports(), sink);
    const { headers: _h, ...bare } = POST_H;
    await f(GETINFO, { transport: 'http' }, { request: bare });
    await f(GETINFO, { transport: 'http' }, { request: { ...bare, headers: { origin: ORIGIN } } });
    await f(GETINFO, { transport: 'http' }, { request: { ...bare, headers: { origin: 'https://other.test' } } });
    const hashes = sink.captures.map((c) => c.requestHeadersSha256);
    expect(sink.captures.map((c) => c.requestBodySha256)).toEqual([sha(bare.body), sha(bare.body), sha(bare.body)]);
    expect(new Set(hashes).size).toBe(3);
  });

  it('impersonate: the request rides the impit options with its headers', async () => {
    const t = transports();
    const sink = new CollectingCaptureSink();
    await createCapturingFetch(t, sink)(GETINFO, { transport: 'impersonate', headers: { 'X-K': 'k' } }, { request: GET_H });
    expect(t.impersonate).toHaveBeenCalledWith(GETINFO, {
      browser: undefined,
      headers: { 'X-K': 'k' },
      userAgent: undefined,
      request: GET_H,
    });
    expect(sink.captures[0]).toMatchObject({ lane: 'api', requestHeadersSha256: sha(canon) });
  });

  it.each([
    ['a declared browser transport', { transport: 'browser' } as SearchFetch],
    ['an undeclared transport', undefined],
  ])('browser lane: %s refuses headers before any navigation or capture', async (_name, sf) => {
    const t = transports();
    const sink = new CollectingCaptureSink();
    const call = createCapturingFetch(t, sink)(GETINFO, sf, { request: GET_H, cookies: { a: '1' } });
    await expect(call).rejects.toBeInstanceOf(FetchHeadersUnsupportedError);
    await expect(createCapturingFetch(t, sink)(GETINFO, sf, { request: GET_H })).rejects.toThrow(
      /browser lane cannot send request headers \(origin, referer\)/,
    );
    expect(t.browser.scrapePage).not.toHaveBeenCalled();
    expect(t.browser.scrapePageStealth).not.toHaveBeenCalled();
    expect(sink.captures).toHaveLength(0);
  });

  it('browser lane: a POST with headers is refused as a POST (the method is the first thing it cannot do)', async () => {
    const t = transports();
    await expect(createCapturingFetch(t, new CollectingCaptureSink())(GETINFO, undefined, { request: POST_H })).rejects.toBeInstanceOf(
      FetchMethodUnsupportedError,
    );
    expect(t.browser.scrapePage).not.toHaveBeenCalled();
  });

  it('the headers refusal carries the url and the names it could not send', () => {
    const err = new FetchHeadersUnsupportedError(GETINFO, ['origin']);
    expect(err.name).toBe('FetchHeadersUnsupportedError');
    expect(err.url).toBe(GETINFO);
    expect(err.headerNames).toEqual(['origin']);
  });
});

describe('the capture identity of request headers', () => {
  it('is a sha256 of the lowercase names sorted, one `name:value` line each', () => {
    expect(canonicalRequestHeaders({ Referer: PRIMARY, origin: ORIGIN })).toBe(canon);
    expect(canonicalRequestHeaders({ origin: ORIGIN, Referer: PRIMARY })).toBe(canon);
    // Never produced by the lanes (a name given twice is refused), but still a stable string.
    expect(canonicalRequestHeaders({ Origin: 'a', origin: 'a' })).toBe('origin:a\norigin:a\n');
    const c = buildRawCapture({ url: GETINFO, lane: 'api', bytes: Buffer.from('{}'), requestHeaders: { referer: PRIMARY, Origin: ORIGIN } });
    expect(c.requestHeadersSha256).toBe(sha(canon));
  });

  it('an absent or empty header set adds nothing to the capture', () => {
    expect(buildRawCapture({ url: GETINFO, lane: 'api', bytes: Buffer.from('{}') })).not.toHaveProperty('requestHeadersSha256');
    expect(buildRawCapture({ url: GETINFO, lane: 'api', bytes: Buffer.from('{}'), requestHeaders: {} })).not.toHaveProperty(
      'requestHeadersSha256',
    );
  });
});
