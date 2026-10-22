/**
 * Ruleset request headers on the real lanes (plugin-contract 0.15.0): the plain-HTTP and impit
 * fetchers send the allowlisted headers with every engine-owned header kept (stored cookie, pinned
 * UA, the POST's Content-Type), a ruleset `accept` replaces the lane's default rather than riding
 * beside it, a session prime never carries them, and the raw store records their hash.
 */
import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHttpFetch, createHttpFetchDetailed, httpFetchBody } from '../../services/engineLookup';
import { createImpitFetch, createImpitFetchDetailed, type ImpitLike } from '../../services/impitFetch';
import { buildRawCapture } from '../../services/captureSink';
import { ObjectStoreCaptureSink, type ObjectStore, type PutOptions, type RawStoreConfig } from '../../services/objectStoreCaptureSink';
import type { CfCookieSource } from '../../services/cookieJar';

const URL_ = 'https://my.mandarake.co.jp/ItemDetailInfo/getInfo/';
const ORIGIN = 'https://order.mandarake.co.jp';
const REFERER = 'https://order.mandarake.co.jp/order/detailPage/item?itemCode=1315522194&lang=en';
const FORM = 'application/x-www-form-urlencoded; charset=UTF-8';
const HEADERS = { origin: ORIGIN, referer: REFERER };
const GET_H = { method: 'GET' as const, headers: HEADERS };
const POST_H = { method: 'POST' as const, body: 'idx=1315522194&lang=en', contentType: FORM, headers: HEADERS };
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

const store = (cookies?: Record<string, string>, userAgent?: string): CfCookieSource => ({
  cookiesFor: () => (cookies ? { ...cookies } : undefined),
  userAgentFor: () => userAgent,
});

describe('plain-HTTP lane: ruleset headers', () => {
  const orig = global.fetch;
  let calls: Array<[string, RequestInit]>;
  beforeEach(() => {
    calls = [];
    global.fetch = jest.fn(async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return { text: async () => '{"status":"ok"}', status: 200, url };
    }) as unknown as typeof fetch;
  });
  afterEach(() => { global.fetch = orig; });

  it('a POST sends them beside the stored cookie, the pinned UA and its Content-Type', async () => {
    await createHttpFetchDetailed({ store: store({ tr_mndrk_user: 'v' }, 'MintUA/1') })(URL_, POST_H);
    const init = calls[0][1];
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('manual');
    expect(init.headers).toEqual({
      'user-agent': 'MintUA/1',
      accept: 'application/json, text/html',
      origin: ORIGIN,
      referer: REFERER,
      cookie: 'tr_mndrk_user=v',
      'content-type': FORM,
    });
  });

  it('a GET with headers sends them and stays a GET that follows redirects (no method, body or redirect key)', async () => {
    await createHttpFetchDetailed({ store: store() })(URL_, GET_H);
    const init = calls[0][1];
    expect(Object.keys(init).sort()).toEqual(['headers', 'signal']);
    expect(init.headers).toEqual({ 'user-agent': expect.any(String), accept: 'application/json, text/html', ...HEADERS });
  });

  it("a ruleset accept replaces the lane's default Accept", async () => {
    await createHttpFetchDetailed({ store: store() })(URL_, { method: 'GET', headers: { accept: 'application/json' } });
    expect((calls[0][1].headers as Record<string, string>).accept).toBe('application/json');
  });

  it('the body projections forward the request with its headers', async () => {
    await createHttpFetch({ store: store() })(URL_, GET_H);
    await httpFetchBody(URL_, POST_H);
    expect((calls[0][1].headers as Record<string, string>).origin).toBe(ORIGIN);
    expect((calls[1][1].headers as Record<string, string>).referer).toBe(REFERER);
    expect(calls[1][1].method).toBe('POST');
  });
});

describe('plain-HTTP lane on a real socket: the headers are on the wire, once each', () => {
  let server: http.Server;
  let base: string;
  const seen: Array<{ method?: string; raw: string[] }> = [];
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        seen.push({ method: req.method, raw: req.rawHeaders });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"status":"ok"}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await new Promise((r) => server.close(r)); });

  const valuesOf = (raw: string[], name: string) => {
    const out: string[] = [];
    for (let i = 0; i < raw.length; i += 2) if (raw[i].toLowerCase() === name) out.push(raw[i + 1]);
    return out;
  };

  it('a POST carries one Origin, one Referer and one Accept (the ruleset one)', async () => {
    seen.length = 0;
    await createHttpFetchDetailed({ store: store() })(`${base}/getInfo/`, {
      ...POST_H,
      headers: { ...HEADERS, accept: 'application/json' },
    });
    const { method, raw } = seen[0];
    expect(method).toBe('POST');
    expect(valuesOf(raw, 'origin')).toEqual([ORIGIN]);
    expect(valuesOf(raw, 'referer')).toEqual([REFERER]);
    expect(valuesOf(raw, 'accept')).toEqual(['application/json']);
  });
});

describe('impit lane: ruleset headers', () => {
  function recorder() {
    const seen: Array<{ url: string; init: any }> = [];
    const fake = (): ImpitLike => ({
      fetch: async (url, init) => { seen.push({ url, init }); return { text: async () => 'ok', status: 200 }; },
    });
    return { seen, fake };
  }

  it('a POST sends them after the store decoration, with the pinned UA and the Content-Type kept', async () => {
    const { seen, fake } = recorder();
    await createImpitFetchDetailed(fake, { store: store(undefined, 'MintUA/1') })(URL_, { headers: { 'X-K': 'k' }, request: POST_H });
    expect(seen[0].init).toEqual({
      method: 'POST',
      headers: { 'X-K': 'k', 'User-Agent': 'MintUA/1', origin: ORIGIN, referer: REFERER, 'Content-Type': FORM },
      body: POST_H.body,
      redirect: 'manual',
    });
  });

  it('a GET with headers is a GET carrying them (no body, no Content-Type, redirects followed)', async () => {
    const { seen, fake } = recorder();
    await createImpitFetchDetailed(fake, { store: store() })(URL_, { request: GET_H });
    expect(seen[0].init).toEqual({ method: 'GET', headers: HEADERS });
  });

  it("a ruleset header replaces the store's declaration of the same name, whatever its case", async () => {
    const { seen, fake } = recorder();
    await createImpitFetchDetailed(fake, { store: store() })(URL_, {
      headers: { Accept: 'text/html', 'X-K': 'k' },
      request: { method: 'GET', headers: { accept: 'application/json' } },
    });
    expect(seen[0].init.headers).toEqual({ 'X-K': 'k', accept: 'application/json' });
  });

  it('the session prime is a plain GET without them; a challenged GET is re-primed and resent WITH them', async () => {
    const seen: Array<{ url: string; init: any }> = [];
    let targetCalls = 0;
    const fake = (): ImpitLike => ({
      fetch: async (url, init) => {
        seen.push({ url, init });
        if (url !== URL_) return { text: async () => 'home' };
        targetCalls += 1;
        return { text: async () => (targetCalls === 1 ? '<title>Just a moment...</title>' : 'ok') };
      },
    });
    const prime = { url: 'https://my.mandarake.co.jp/' };
    const detail = await createImpitFetchDetailed(fake, { store: store() })(URL_, { headers: { 'X-K': 'k' }, prime, request: GET_H });
    expect(detail.body).toBe('ok');
    expect(seen.map((s) => [s.url, s.init.method])).toEqual([
      [prime.url, 'GET'],
      [URL_, 'GET'],
      [prime.url, 'GET'],
      [URL_, 'GET'],
    ]);
    expect(seen[0].init.headers).toEqual({ 'X-K': 'k' });
    expect(seen[2].init.headers).toEqual({ 'X-K': 'k' });
    expect(seen[1].init.headers).toEqual({ 'X-K': 'k', ...HEADERS });
    expect(seen[3].init.headers).toEqual({ 'X-K': 'k', ...HEADERS });
  });

  it('a challenged POST with headers is still not replayed', async () => {
    const seen: string[] = [];
    const fake = (): ImpitLike => ({
      fetch: async (url, init) => {
        seen.push(`${init.method} ${url}`);
        return { text: async () => (init.method === 'POST' ? '<title>Just a moment...</title>' : 'home') };
      },
    });
    await createImpitFetchDetailed(fake, { store: store() })(URL_, { prime: { url: 'https://my.mandarake.co.jp/' }, request: POST_H });
    expect(seen).toEqual(['GET https://my.mandarake.co.jp/', `POST ${URL_}`]);
  });

  it('the body projection forwards the request with its headers', async () => {
    const { seen, fake } = recorder();
    await createImpitFetch(fake, { store: store() })(URL_, { request: GET_H });
    expect(seen[0].init.headers).toEqual(HEADERS);
  });
});

describe('raw store metadata names the request headers hash', () => {
  class FakeStore implements ObjectStore {
    readonly puts: Array<{ key: string; opts: PutOptions }> = [];
    async exists(): Promise<boolean> { return false; }
    async put(key: string, _b: Buffer, opts: PutOptions): Promise<void> { this.puts.push({ key, opts }); }
  }
  const CONFIG: RawStoreConfig = {
    endpoint: 'https://hel1.your-objectstorage.com',
    region: 'hel1',
    bucket: 'mindsignals-raw',
    prefix: 'raw-html/',
    keyScheme: 'sha256-v1',
    putTimeoutMs: 100,
  };
  const canon = `origin:${ORIGIN}\nreferer:${REFERER}\n`;

  it('a capture with headers writes request-headers-sha256; one without writes none', async () => {
    const fake = new FakeStore();
    const sink = new ObjectStoreCaptureSink(fake, CONFIG);
    const withH = buildRawCapture({ url: URL_, lane: 'api', bytes: Buffer.from('{"zaiko":1}'), method: 'POST', requestBody: POST_H.body, requestHeaders: HEADERS });
    const without = buildRawCapture({ url: URL_, lane: 'api', bytes: Buffer.from('{"status":"error"}'), method: 'POST', requestBody: POST_H.body });
    await sink.capture(withH);
    await sink.capture(without);
    await sink.flush();
    const byKey = (c: { sha256: string }) => fake.puts.find((p) => p.key.includes(c.sha256))!;
    expect(byKey(withH).opts.metadata).toMatchObject({ method: 'POST', 'request-body-sha256': sha(POST_H.body), 'request-headers-sha256': sha(canon) });
    expect(byKey(without).opts.metadata).not.toHaveProperty('request-headers-sha256');
  });

  it('a GET with headers writes the headers hash and no method', async () => {
    const fake = new FakeStore();
    const sink = new ObjectStoreCaptureSink(fake, CONFIG);
    await sink.capture(buildRawCapture({ url: URL_, lane: 'api', bytes: Buffer.from('{}'), requestHeaders: HEADERS }));
    await sink.flush();
    expect(fake.puts[0].opts.metadata).toMatchObject({ 'request-headers-sha256': sha(canon) });
    expect(fake.puts[0].opts.metadata).not.toHaveProperty('method');
  });

  it('the headers hash survives the metadata budget when the url is long', async () => {
    const fake = new FakeStore();
    const sink = new ObjectStoreCaptureSink(fake, CONFIG);
    const long = `${URL_}?${'q'.repeat(1500)}`;
    await sink.capture(buildRawCapture({ url: long, lane: 'api', bytes: Buffer.from('{}'), method: 'POST', requestBody: 'a=1', requestHeaders: HEADERS }));
    await sink.flush();
    expect(fake.puts[0].opts.metadata).toMatchObject({ method: 'POST', 'request-body-sha256': sha('a=1'), 'request-headers-sha256': sha(canon) });
  });
});
