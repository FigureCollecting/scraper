/**
 * The POST request on the real lanes (plugin-contract 0.14.0): the plain-HTTP and impit fetchers
 * send the method, body and Content-Type with every existing guard kept (stored cookies, pinned UA,
 * abort bound, prime), a POST's redirect is returned rather than followed, and the raw store
 * records the method on the object a POST writes. Objects are content-addressed and write-once, so
 * on a dedup hit the first writer's metadata stands (pinned below).
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
const FORM = 'application/x-www-form-urlencoded; charset=UTF-8';
const POST = { method: 'POST' as const, body: 'idx=1315522194&lang=en', contentType: FORM };
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

const store = (cookies?: Record<string, string>, userAgent?: string): CfCookieSource => ({
  cookiesFor: () => (cookies ? { ...cookies } : undefined),
  userAgentFor: () => userAgent,
});

describe('plain-HTTP lane POST', () => {
  const orig = global.fetch;
  let calls: Array<[string, RequestInit]>;
  beforeEach(() => {
    calls = [];
    global.fetch = jest.fn(async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return { text: async () => '{"status":"ok","zaiko":1}', status: 200, url };
    }) as unknown as typeof fetch;
  });
  afterEach(() => { global.fetch = orig; });

  it('sends the method, body and Content-Type, with the stored cookie, pinned UA and abort bound kept', async () => {
    const detail = await createHttpFetchDetailed({ store: store({ tr_mndrk_user: 'v' }, 'MintUA/1') })(URL_, POST);
    expect(detail).toEqual({ body: '{"status":"ok","zaiko":1}', status: 200, finalUrl: URL_ });
    const [url, init] = calls[0];
    expect(url).toBe(URL_);
    expect(init.method).toBe('POST');
    expect(init.body).toBe('idx=1315522194&lang=en');
    expect(init.redirect).toBe('manual');
    expect(init.headers).toEqual({
      'user-agent': 'MintUA/1',
      accept: 'application/json, text/html',
      cookie: 'tr_mndrk_user=v',
      'content-type': FORM,
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('a GET sends no method, body or Content-Type (the pre-0.14.0 request)', async () => {
    await createHttpFetchDetailed({ store: store() })(URL_);
    const init = calls[0][1];
    expect(Object.keys(init).sort()).toEqual(['headers', 'signal']);
    expect(init.headers).not.toHaveProperty('content-type');
  });

  it('the body projection forwards the request', async () => {
    await expect(createHttpFetch({ store: store() })(URL_, POST)).resolves.toBe('{"status":"ok","zaiko":1}');
    expect(calls[0][1].method).toBe('POST');
    expect(calls[0][1].body).toBe(POST.body);
  });

  it("the engine's default body fetcher (the /resolve lane) forwards the request", async () => {
    await httpFetchBody(URL_, POST);
    expect(calls[0][1].method).toBe('POST');
    expect((calls[0][1].headers as Record<string, string>)['content-type']).toBe(FORM);
  });
});

describe('plain-HTTP lane POST on a real socket: a redirect is returned, never followed', () => {
  let server: http.Server;
  let base: string;
  const seen: string[] = [];
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        seen.push(`${req.method} ${req.url} ${body}`);
        const to = req.url === '/r302' ? 302 : req.url === '/r307' ? 307 : 0;
        if (to) { res.writeHead(to, { location: '/landing' }); res.end(); return; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"landing":true}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await new Promise((r) => server.close(r)); });
  beforeEach(() => { seen.length = 0; });

  it.each(['/r302', '/r307'])('a POST answered %s gets the 3xx itself, and the Location is not requested', async (path) => {
    const detail = await createHttpFetchDetailed({ store: store() })(`${base}${path}`, { ...POST, body: 'idx=1' });
    expect(detail.status).toBe(path === '/r302' ? 302 : 307);
    expect(detail.finalUrl).toBe(`${base}${path}`);
    expect(seen).toEqual([`POST ${path} idx=1`]);
  });

  it('a GET still follows a redirect (unchanged)', async () => {
    const detail = await createHttpFetchDetailed({ store: store() })(`${base}/r302`);
    expect(detail.body).toBe('{"landing":true}');
    expect(seen).toEqual(['GET /r302 ', 'GET /landing ']);
  });
});

describe('impit lane POST', () => {
  it('sends the method, body and Content-Type after the store decoration and the pinned UA', async () => {
    const seen: Array<{ url: string; init: any }> = [];
    const fake = (): ImpitLike => ({
      fetch: async (url, init) => { seen.push({ url, init }); return { text: async () => 'ok', status: 200 }; },
    });
    const f = createImpitFetchDetailed(fake, { store: store(undefined, 'MintUA/1') });
    await f(URL_, { headers: { 'content-type': 'text/plain', 'X-K': 'k' }, request: POST });
    expect(seen).toHaveLength(1);
    expect(seen[0].init).toEqual({
      method: 'POST',
      headers: { 'X-K': 'k', 'User-Agent': 'MintUA/1', 'Content-Type': FORM },
      body: 'idx=1315522194&lang=en',
      redirect: 'manual',
    });
  });

  it('a GET is sent exactly as before (no body, no Content-Type)', async () => {
    const seen: any[] = [];
    const fake = (): ImpitLike => ({ fetch: async (_u, init) => { seen.push(init); return { text: async () => 'ok' }; } });
    await createImpitFetchDetailed(fake, { store: store() })(URL_, {});
    expect(seen[0]).toEqual({ method: 'GET', headers: {} });
  });

  it('seeds the stored cookies into the session jar for a POST too', async () => {
    const set: string[] = [];
    const fake = (_b: string, jar: { setCookie: (c: string, u: string) => unknown }): ImpitLike => {
      const orig = jar.setCookie.bind(jar);
      jar.setCookie = (c: string, u: string) => { set.push(c); return orig(c, u); };
      return { fetch: async () => ({ text: async () => 'ok' }) };
    };
    await createImpitFetchDetailed(fake as never, { store: store({ tr_mndrk_user: 'v' }) })(URL_, { request: POST });
    expect(set.some((c) => c.startsWith('tr_mndrk_user=v'))).toBe(true);
  });

  it('a primed POST: the prime is a GET, and a challenged POST is NOT replayed (the prime is dropped for next time)', async () => {
    const seen: Array<{ url: string; method: string }> = [];
    const challenge = '<title>Just a moment...</title>';
    const fake = (): ImpitLike => ({
      fetch: async (url, init) => {
        seen.push({ url, method: init.method });
        return { text: async () => (init.method === 'POST' ? challenge : 'home') };
      },
    });
    const f = createImpitFetchDetailed(fake, { store: store() });
    const prime = { url: 'https://my.mandarake.co.jp/' };
    const first = await f(URL_, { prime, request: POST });
    expect(first.body).toBe(challenge);
    expect(seen).toEqual([
      { url: 'https://my.mandarake.co.jp/', method: 'GET' },
      { url: URL_, method: 'POST' },
    ]);
    await f(URL_, { prime, request: POST });
    // invalidated ⇒ the next call primes again before its one POST
    expect(seen.slice(2)).toEqual([
      { url: 'https://my.mandarake.co.jp/', method: 'GET' },
      { url: URL_, method: 'POST' },
    ]);
  });

  it('the body projection forwards the request', async () => {
    const seen: any[] = [];
    const fake = (): ImpitLike => ({ fetch: async (_u, init) => { seen.push(init); return { text: async () => 'ok' }; } });
    await createImpitFetch(fake, { store: store() })(URL_, { request: POST });
    expect(seen[0].method).toBe('POST');
    expect(seen[0].body).toBe(POST.body);
  });
});

describe('raw capture records the request method', () => {
  it('buildRawCapture carries the method and a hash of the request body for a POST', () => {
    const c = buildRawCapture({ url: URL_, lane: 'api', bytes: Buffer.from('{}'), method: 'POST', requestBody: POST.body });
    expect(c.method).toBe('POST');
    expect(c.requestBodySha256).toBe(sha(POST.body));
  });

  it('a POST with no request body hashes the empty body', () => {
    const c = buildRawCapture({ url: URL_, lane: 'api', bytes: Buffer.from('{}'), method: 'POST' });
    expect(c.requestBodySha256).toBe(sha(''));
  });

  it('a GET capture carries neither (unchanged shape)', () => {
    const c = buildRawCapture({ url: URL_, lane: 'api', bytes: Buffer.from('{}') });
    expect(c).not.toHaveProperty('method');
    expect(c).not.toHaveProperty('requestBodySha256');
  });

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

  it("the stored object's metadata names a POST and its request body; a GET's does not", async () => {
    const fake = new FakeStore();
    const sink = new ObjectStoreCaptureSink(fake, CONFIG);
    const postCap = buildRawCapture({ url: URL_, lane: 'api', bytes: Buffer.from('{"zaiko":1}'), method: 'POST', requestBody: POST.body });
    const getCap = buildRawCapture({ url: URL_, lane: 'api', bytes: Buffer.from('{"status":"error"}') });
    await sink.capture(postCap);
    await sink.capture(getCap);
    await sink.flush();
    // PUTs run on concurrent workers: find each by its content address, never by completion order.
    const byKey = (c: { sha256: string }) => fake.puts.find((p) => p.key.includes(c.sha256))!;
    const post = byKey(postCap);
    const get = byKey(getCap);
    expect(fake.puts).toHaveLength(2);
    expect(post.opts.metadata).toMatchObject({ url: URL_, lane: 'api', method: 'POST', 'request-body-sha256': sha(POST.body) });
    expect(get.opts.metadata).not.toHaveProperty('method');
    expect(get.opts.metadata).not.toHaveProperty('request-body-sha256');
    expect(post.key).not.toBe(get.key);
  });

  /** HEAD answers from what was actually PUT, as the real bucket does. */
  class TruthfulStore implements ObjectStore {
    readonly objects = new Map<string, PutOptions>();
    readonly puts: Array<{ key: string; opts: PutOptions }> = [];
    async exists(key: string): Promise<boolean> { return this.objects.has(key); }
    async put(key: string, _b: Buffer, opts: PutOptions): Promise<void> { this.objects.set(key, opts); this.puts.push({ key, opts }); }
  }

  it('dedup is by bytes: a POST answering what a GET of the url already stored adds nothing, so the object reads as the GET', async () => {
    const truthful = new TruthfulStore();
    const sink = new ObjectStoreCaptureSink(truthful, CONFIG);
    const bytes = Buffer.from('{"status":"error","error":"Request denied."}');
    await sink.capture(buildRawCapture({ url: URL_, lane: 'api', bytes }));
    await sink.flush();
    await sink.capture(buildRawCapture({ url: URL_, lane: 'api', bytes, method: 'POST', requestBody: POST.body }));
    await sink.flush();
    expect(truthful.puts).toHaveLength(1);
    expect(truthful.puts[0].opts.metadata).not.toHaveProperty('method');
    expect(sink.stats().deduped).toBe(1);
  });

  it('two POSTs with different bodies and the same answer leave one object naming the first body only', async () => {
    const truthful = new TruthfulStore();
    const sink = new ObjectStoreCaptureSink(truthful, CONFIG);
    const bytes = Buffer.from('{"status":"ok","zaiko":0,"price":500,"price_with_tax":550}');
    await sink.capture(buildRawCapture({ url: URL_, lane: 'api', bytes, method: 'POST', requestBody: 'idx=1&lang=en' }));
    await sink.flush();
    await sink.capture(buildRawCapture({ url: URL_, lane: 'api', bytes, method: 'POST', requestBody: 'idx=2&lang=en' }));
    await sink.flush();
    expect(truthful.puts).toHaveLength(1);
    expect(truthful.puts[0].opts.metadata).toMatchObject({ method: 'POST', 'request-body-sha256': sha('idx=1&lang=en') });
  });

  it('a hand-built POST capture without a body hash still records the method', async () => {
    const fake = new FakeStore();
    const sink = new ObjectStoreCaptureSink(fake, CONFIG);
    await sink.capture({ ...buildRawCapture({ url: URL_, lane: 'api', bytes: Buffer.from('{"a":1}') }), method: 'POST' });
    await sink.flush();
    expect(fake.puts[0].opts.metadata).toMatchObject({ method: 'POST' });
    expect(fake.puts[0].opts.metadata).not.toHaveProperty('request-body-sha256');
  });

  it('the method survives the metadata budget when the url is long', async () => {
    const fake = new FakeStore();
    const sink = new ObjectStoreCaptureSink(fake, CONFIG);
    const long = `${URL_}?${'q'.repeat(1500)}`;
    await sink.capture(buildRawCapture({ url: long, lane: 'api', bytes: Buffer.from('{}'), method: 'POST', requestBody: 'a=1' }));
    await sink.flush();
    expect(fake.puts[0].opts.metadata).toMatchObject({ method: 'POST', 'request-body-sha256': sha('a=1') });
  });
});
