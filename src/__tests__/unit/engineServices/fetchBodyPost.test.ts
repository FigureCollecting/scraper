/**
 * `ctx.scraping.fetchBody` POST (plugin-contract 0.14.0): method / body / contentType from the
 * contract boundary down through the capturing fetch's lanes. Omitted ⇒ the pre-0.14.0 GET, called
 * exactly as before. The browser lane cannot POST and refuses before touching the network.
 */
import { createHash } from 'node:crypto';
import { buildExtractContext, FetchBodyRequestError } from '../../../services/engineServices/extractContext';
import {
  createCapturingFetch,
  FetchMethodUnsupportedError,
  DEFAULT_POST_CONTENT_TYPE,
  type CapturingFetchTransports,
} from '../../../services/engineServices/capturingFetch';
import { CollectingCaptureSink } from '../../../services/captureSink';
import { HostRateLimiter, wrapFetchBodyWithLimiter } from '../../../driver/hostRateLimiter';
import type { SearchFetch, SiteConfig } from '@figurecollecting/scraper-plugin-contract';

const CONFIG = { siteId: 'mandarake', baseUrl: 'https://order.mandarake.co.jp' } as unknown as SiteConfig;
const LOGGER = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
const PRIMARY = 'https://order.mandarake.co.jp/order/detailPage/item?itemCode=1315522194&lang=en';
const GETINFO = 'https://my.mandarake.co.jp/ItemDetailInfo/getInfo/';
const SAME_HOST = 'https://order.mandarake.co.jp/order/other';
const FORM = 'application/x-www-form-urlencoded; charset=UTF-8';
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

function ctx(over: {
  searchFetch?: SearchFetch;
  cookies?: Record<string, string>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
} = {}) {
  const capturingFetch = jest.fn(async (_url: string, _sf: SearchFetch | undefined, _o?: unknown) => ({
    html: '{"status":"ok","zaiko":1}',
    status: 200,
  }));
  const sleep = over.sleep ?? jest.fn(async () => {});
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
    residentialProxyUrl: () => 'socks5://exit:1080',
  });
  return { c, capturingFetch, sleep };
}

describe('fetchBody request options at the contract boundary', () => {
  it('omitted options call the capturing fetch exactly as before (a GET, no request key)', async () => {
    const { c, capturingFetch } = ctx();
    await c.scraping.fetchBody!(GETINFO);
    expect(capturingFetch).toHaveBeenCalledWith(GETINFO, { transport: 'http' }, {});
  });

  it("an explicit method 'GET' is the same call as an omitted one (a ruleset cookie map is refused since 0.15.0)", async () => {
    const { c, capturingFetch } = ctx();
    await c.scraping.fetchBody!(GETINFO, { method: 'GET' });
    expect(capturingFetch).toHaveBeenCalledWith(GETINFO, { transport: 'http' }, {});
    await expect(c.scraping.fetchBody!(GETINFO, { method: 'GET', cookies: { a: '1' } })).rejects.toBeInstanceOf(FetchBodyRequestError);
  });

  it('a POST reaches the capturing fetch with its method, body and Content-Type', async () => {
    const { c, capturingFetch } = ctx({ cookies: { tr_mndrk_user: 'x' } });
    const res = await c.scraping.fetchBody!(GETINFO, { method: 'POST', body: 'idx=1315522194&lang=en', contentType: FORM });
    expect(capturingFetch).toHaveBeenCalledWith(GETINFO, { transport: 'http' }, {
      cookies: { tr_mndrk_user: 'x' },
      request: { method: 'POST', body: 'idx=1315522194&lang=en', contentType: FORM },
    });
    expect(res).toMatchObject({ html: '{"status":"ok","zaiko":1}', statusCode: 200 });
  });

  it('a POST with no contentType is sent as a form post; with no body, an empty one', async () => {
    const { c, capturingFetch } = ctx();
    await c.scraping.fetchBody!(GETINFO, { method: 'POST' });
    expect(capturingFetch.mock.calls[0][2]).toEqual({
      request: { method: 'POST', body: '', contentType: DEFAULT_POST_CONTENT_TYPE },
    });
    expect(DEFAULT_POST_CONTENT_TYPE).toBe('application/x-www-form-urlencoded; charset=UTF-8');
  });

  it.each([
    ['a GET with a body', { method: 'GET', body: 'idx=1' }, /GET carries no body/],
    ['an omitted method with a body', { body: 'idx=1' }, /GET carries no body/],
    ['a GET with a contentType', { contentType: FORM }, /GET carries no body/],
    ['an unsupported method', { method: 'PUT' }, /method 'PUT' is not supported/],
    ['a lower-case post', { method: 'post' }, /method 'post' is not supported/],
    ['a non-string body', { method: 'POST', body: { idx: 1 } }, /body must be a string/],
    ['a non-string contentType', { method: 'POST', body: 'a', contentType: 1 }, /contentType must be a string/],
  ])('%s is refused before any wait or fetch', async (_name, opts, message) => {
    // Same host as the primary and inside its courtesy gap, so a check placed after the wait would sleep.
    const { c, capturingFetch, sleep } = ctx({ now: () => 1000 });
    const call = c.scraping.fetchBody!(SAME_HOST, opts as never);
    await expect(call).rejects.toBeInstanceOf(FetchBodyRequestError);
    await expect(c.scraping.fetchBody!(SAME_HOST, opts as never)).rejects.toThrow(message);
    expect(capturingFetch).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('a same-host POST is courtesy-gapped like a GET, and gaps the next call', async () => {
    let clock = 1000;
    const sleep = jest.fn(async (ms: number) => { clock += ms; });
    const { c } = ctx({ now: () => clock, sleep });
    const sameHost = 'https://order.mandarake.co.jp/order/api/x';
    await c.scraping.fetchBody!(sameHost, { method: 'POST', body: 'a=1' });
    expect(sleep).toHaveBeenLastCalledWith(2000); // primary at 0, gap 3000, now 1000
    await c.scraping.fetchBody!(sameHost, { method: 'POST', body: 'a=2' });
    expect(sleep).toHaveBeenLastCalledWith(3000); // gapped against the POST just sent
  });

  it("an off-store POST keeps the store's transport but never its residential exit", async () => {
    const declared: SearchFetch = { transport: 'impersonate', egress: 'residential' };
    const { c, capturingFetch } = ctx({ searchFetch: declared });
    await c.scraping.fetchBody!('https://third-party.example/api', { method: 'POST', body: 'q=1' });
    expect(capturingFetch.mock.calls[0][1]).toEqual({ transport: 'impersonate' });
    await c.scraping.fetchBody!('https://order.mandarake.co.jp/api', { method: 'POST', body: 'q=1' });
    expect(capturingFetch.mock.calls[1][1]).toEqual(declared);
  });

  it('the host rate limiter wrapper records the POST and hands its options through untouched', async () => {
    const { c, capturingFetch } = ctx();
    const limiter = new HostRateLimiter(() => undefined);
    const spy = jest.spyOn(limiter, 'recordDispatch');
    const wrapped = wrapFetchBodyWithLimiter(c, limiter, () => 42);
    await wrapped.scraping.fetchBody!(GETINFO, { method: 'POST', body: 'idx=1', contentType: FORM });
    expect(spy).toHaveBeenCalledWith('my.mandarake.co.jp', 42);
    expect(capturingFetch.mock.calls[0][2]).toEqual({ request: { method: 'POST', body: 'idx=1', contentType: FORM } });
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

const POST = { method: 'POST' as const, body: 'idx=1315522194&lang=en', contentType: FORM };

describe('capturingFetch lanes for a POST', () => {
  it('http: the transport is handed the request, and the capture records the method and the body it answered', async () => {
    const t = transports();
    const sink = new CollectingCaptureSink();
    const res = await createCapturingFetch(t, sink)(GETINFO, { transport: 'http' }, { request: POST });
    expect(t.http).toHaveBeenCalledWith(GETINFO, POST);
    expect(res).toEqual({ html: '{"status":"ok","zaiko":1}', status: 200 });
    expect(sink.captures).toHaveLength(1);
    expect(sink.captures[0]).toMatchObject({ url: GETINFO, lane: 'api', method: 'POST', requestBodySha256: sha(POST.body) });
  });

  it('http: a GET is still called with the url alone and its capture carries no method', async () => {
    const t = transports();
    const sink = new CollectingCaptureSink();
    await createCapturingFetch(t, sink)(GETINFO, { transport: 'http' });
    expect((t.http as jest.Mock).mock.calls[0]).toEqual([GETINFO]);
    expect(sink.captures[0].method).toBeUndefined();
    expect(sink.captures[0].requestBodySha256).toBeUndefined();
  });

  it('two POSTs of one url with different bodies are told apart in their captures', async () => {
    const sink = new CollectingCaptureSink();
    const f = createCapturingFetch(transports(), sink);
    await f(GETINFO, { transport: 'http' }, { request: { ...POST, body: 'idx=1&lang=en' } });
    await f(GETINFO, { transport: 'http' }, { request: { ...POST, body: 'idx=2&lang=en' } });
    expect(sink.captures[0].requestBodySha256).not.toBe(sink.captures[1].requestBodySha256);
  });

  it('impersonate: the request rides the impit options beside the store decoration', async () => {
    const t = transports();
    const sink = new CollectingCaptureSink();
    await createCapturingFetch(t, sink)(GETINFO, { transport: 'impersonate', browser: 'chrome142' }, { request: POST });
    expect(t.impersonate).toHaveBeenCalledWith(GETINFO, {
      browser: 'chrome142',
      headers: undefined,
      userAgent: undefined,
      request: POST,
    });
    expect(sink.captures[0]).toMatchObject({ lane: 'api', method: 'POST', requestBodySha256: sha(POST.body) });
  });

  it('impersonate: a GET carries no request key (byte-identical options)', async () => {
    const t = transports();
    await createCapturingFetch(t, new CollectingCaptureSink())(GETINFO, { transport: 'impersonate' });
    expect((t.impersonate as jest.Mock).mock.calls[0][1]).not.toHaveProperty('request');
  });

  it('a challenge answer to a POST is still flagged', async () => {
    const t = transports('<title>Just a moment...</title><div id="cf-chl-widget"></div>window._cf_chl_opt={}');
    const res = await createCapturingFetch(t, new CollectingCaptureSink())(GETINFO, { transport: 'http' }, { request: POST });
    expect(res.challenge).toBe(true);
  });

  it.each([
    ['a declared browser transport', { transport: 'browser' } as SearchFetch],
    ['an undeclared transport', undefined],
  ])('browser lane: %s refuses a POST before any navigation or capture', async (_name, sf) => {
    const t = transports();
    const sink = new CollectingCaptureSink();
    const call = createCapturingFetch(t, sink)(GETINFO, sf, { request: POST, cookies: { a: '1' } });
    await expect(call).rejects.toBeInstanceOf(FetchMethodUnsupportedError);
    await expect(createCapturingFetch(t, sink)(GETINFO, sf, { request: POST })).rejects.toThrow(
      /browser lane cannot send a POST/,
    );
    expect(t.browser.scrapePage).not.toHaveBeenCalled();
    expect(t.browser.scrapePageStealth).not.toHaveBeenCalled();
    expect(sink.captures).toHaveLength(0);
  });
});
