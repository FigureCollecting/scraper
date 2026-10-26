/**
 * GAL-IMPIT: the gallery driver on the impit lane (browser 'chrome'), with direct egress only.
 *
 * Lane selection (the policy row's lane is honoured: http or impit, never the browser lane), the residential exit refused
 * unless GALLERY_EGRESS=direct overrides it to direct (never to residential), the dispatch guard (no proxy, no AI crawler
 * UA), the recorder over impit (probe evidence, manual redirects), and the gallery's impit session (no cookie jar, no
 * stored cookies, no proxy). The last block drives the REAL impit against a 127.0.0.1 server; nothing here leaves loopback.
 */
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resetCfCookieStore } from '../../services/cookieJar';
import type { ImpitLike, ImpitResponseLike } from '../../services/impitFetch';
import {
  GALLERY_LANES, createFetchObserver, createMemoryLedger, createRecordingFetch, guardGalleryDispatch, judgeProbe, runGalleryCapture, withDirectEgress,
} from '../../services/images/galleryDriver';
import { GALLERY_IMPIT_BROWSER, createGalleryImpitFetch, galleryImpitFactory, impitReadyFirst } from '../../services/images/galleryImpitLane';
import { IMAGE_CHROME_UA, type ImageBytesFetcher, type ImageFetchOptions } from '../../services/images/imageBytes';
import { buildImageHostPolicy, chooseImageLane } from '../../services/images/imageHostPolicy';
import { AI_CRAWLER_UA, PAGE, STATIC, U, baseOpts, feed, item, memoHook, noop, ok200, scriptedSink } from '../helpers/galleryDriverDoubles';

const RESIDENTIAL_ROW = { lane: 'impit' as const, egress: 'residential' as const, referer: false, ua: 'chrome' as const, placeholders: { ['a'.repeat(64)]: 'display_gated' } };

describe('lane selection: the policy row decides the lane, the gallery decides only that egress is direct', () => {
  const start = (policy: ReturnType<typeof buildImageHostPolicy>) => {
    const observer = createFetchObserver({ pauseAfter: 3, now: () => 0 });
    const h = memoHook(observer, () => ok200());
    return {
      h,
      report: runGalleryCapture(
        { hook: h.hook, sink: scriptedSink(noop), observer, policy, ledger: createMemoryLedger(), items: feed([item('1', [1, 2])]), now: () => 0, log: noop, requests: () => [] },
        baseOpts(),
      ),
    };
  };

  it('the lanes it may fetch on are http and impit, never the browser lane', () => {
    expect([...GALLERY_LANES].sort()).toEqual(['http', 'impit']);
  });

  it('runs on an impit row with direct egress', async () => {
    const { h, report } = start(buildImageHostPolicy({ [STATIC]: { lane: 'impit', egress: 'direct', referer: false, ua: 'chrome' } }));
    const r = await report;
    expect(r.refusal).toBeUndefined();
    expect(r).toMatchObject({ stopped: 'done', fetched: 2, stored: 2 });
    expect(h.fetchedUrls).toEqual([U(1), U(2)]);
  });

  it('still refuses a browser row', async () => {
    const { h, report } = start(buildImageHostPolicy({ [STATIC]: { lane: 'browser', egress: 'direct' } }));
    const r = await report;
    expect(r.stopped).toBe('refused');
    expect(r.refusal).toMatch(/lane browser/);
    expect(r.refusal).toMatch(/http or impit/);
    expect(h.fetchedUrls).toEqual([]);
  });

  it('refuses a residential row, says why (the home line) and names the override, and sends nothing', async () => {
    const { h, report } = start(buildImageHostPolicy({ [STATIC]: RESIDENTIAL_ROW }));
    const r = await report;
    expect(r.stopped).toBe('refused');
    expect(r.refusal).toMatch(/residential/);
    expect(r.refusal).toMatch(/home/);
    expect(r.refusal).toMatch(/GALLERY_EGRESS=direct/);
    expect(h.fetchedUrls).toEqual([]);
  });

  it('withDirectEgress turns the residential row into a direct one and keeps everything else the row says', () => {
    const base = buildImageHostPolicy({ [STATIC]: RESIDENTIAL_ROW });
    const before = chooseImageLane(PAGE('1'), U(1), undefined, base);
    const after = chooseImageLane(PAGE('1'), U(1), undefined, withDirectEgress(base));
    expect(before).toMatchObject({ ok: true, lane: 'impit', egress: 'residential' });
    expect(after).toEqual({ ...before, egress: 'direct' });
    expect(after).toMatchObject({ ua: 'chrome', placeholders: RESIDENTIAL_ROW.placeholders });
    expect(after).not.toHaveProperty('referer');
  });

  it('withDirectEgress leaves a direct row and a deny row exactly as they were', () => {
    const base = buildImageHostPolicy({ [STATIC]: { lane: 'http', egress: 'direct', referer: true }, 'deny.example': { deny: true } });
    const wrapped = withDirectEgress(base);
    expect(wrapped.ruleFor(STATIC)).toEqual(base.ruleFor(STATIC));
    expect(wrapped.ruleFor('deny.example')).toEqual(base.ruleFor('deny.example'));
  });

  it('a residential row overridden to direct runs on its impit lane', async () => {
    const { h, report } = start(withDirectEgress(buildImageHostPolicy({ [STATIC]: RESIDENTIAL_ROW })));
    expect(await report).toMatchObject({ stopped: 'done', fetched: 2, stored: 2 });
    expect(h.fetchedUrls).toEqual([U(1), U(2)]);
  });
});

describe('guardGalleryDispatch: checked on every request, under the pacer', () => {
  const rig = () => {
    const calls: Array<{ url: string; options?: ImageFetchOptions }> = [];
    const inner: ImageBytesFetcher = async (url, options) => { calls.push({ url, ...(options !== undefined ? { options } : {}) }); return ok200(); };
    return { calls, guarded: guardGalleryDispatch(inner) };
  };

  it.each([
    ['residential egress', { egress: 'residential' as const }],
    ['a proxy url', { proxyUrl: 'socks5://home.invalid:1080' }],
    ['a proxy url on a request that says direct', { egress: 'direct' as const, proxyUrl: 'http://proxy.invalid:3128' }],
  ])('refuses %s without a request', async (_label, options) => {
    const { calls, guarded } = rig();
    const res = await guarded(U(1), options);
    expect(res).toMatchObject({ ok: false, reason: 'refused', detail: expect.stringMatching(/residential/) });
    expect(JSON.stringify(res)).not.toContain('home.invalid');
    expect(calls).toEqual([]);
  });

  it.each([
    'ClaudeBot/1.0', 'Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)', 'Claude-User/1.0', 'anthropic-ai', 'GPTBot/1.1', 'ChatGPT-User/1.0',
    'CCBot/2.0', 'Bytespider', 'Amazonbot/0.1', 'Google-Extended', 'meta-externalagent/1.1', 'Applebot-Extended', 'PerplexityBot/1.0',
  ])('refuses to identify as an AI crawler (%s)', async ua => {
    const { calls, guarded } = rig();
    expect(AI_CRAWLER_UA.test(ua)).toBe(true);
    expect(await guarded(U(1), { userAgent: ua })).toMatchObject({ ok: false, reason: 'refused', detail: expect.stringMatching(/Chrome user agent or none/) });
    expect(calls).toEqual([]);
  });

  it.each(['curl/8.5.0', 'node', `${IMAGE_CHROME_UA} extra`, ''])('refuses any user agent but the lanes\' Chrome string (%j)', async ua => {
    const { calls, guarded } = rig();
    expect(await guarded(U(1), { userAgent: ua })).toMatchObject({ ok: false, reason: 'refused' });
    expect(calls).toEqual([]);
  });

  it("passes a direct request with the lanes' Chrome UA, or with none, through untouched", async () => {
    const { calls, guarded } = rig();
    expect(AI_CRAWLER_UA.test(IMAGE_CHROME_UA)).toBe(false);
    expect(await guarded(U(1), { egress: 'direct', userAgent: IMAGE_CHROME_UA })).toMatchObject({ ok: true });
    expect(await guarded(U(2))).toMatchObject({ ok: true });
    expect(calls).toEqual([{ url: U(1), options: { egress: 'direct', userAgent: IMAGE_CHROME_UA } }, { url: U(2) }]);
  });
});

/** An impit double: answers by path, records what it was asked. */
function fakeImpit(answer: (url: string) => { status: number; headers?: Record<string, string>; body?: Buffer } = () => ({ status: 200, headers: { 'content-type': 'image/png' }, body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]) })) {
  const calls: Array<{ url: string; init: Parameters<ImpitLike['fetch']>[1] }> = [];
  const impit: ImpitLike = {
    async fetch(url, init) {
      calls.push({ url, init });
      const a = answer(url);
      const body = a.body ?? Buffer.alloc(0);
      const res: ImpitResponseLike = { status: a.status, url, headers: new Headers(a.headers ?? {}), text: async () => body.toString('latin1'), bytes: async () => new Uint8Array(body) };
      return res;
    },
  };
  return { impit, calls };
}

describe('createRecordingFetch over impit: the same records and redirect bookkeeping as the http lane', () => {
  it('records the lane, header NAMES, status and the response signals, never a value', async () => {
    const rec = createRecordingFetch(async () => { throw new Error('the http lane is not used here'); });
    const f = fakeImpit(() => ({ status: 403, headers: { 'set-cookie': '__cf_bm=SECRETVALUE; Path=/', 'cf-mitigated': 'challenge', 'cf-ray': '8f00-IAD' } }));
    const impit = rec.wrapImpit(f.impit);
    const res = await impit.fetch(U(1), { method: 'GET', headers: { accept: '*/*', 'User-Agent': 'Mozilla/5.0 Chrome/124' } });
    expect(res.status).toBe(403);
    expect(rec.records).toEqual([{ url: U(1), lane: 'impit', egress: 'direct', sentHeaderNames: ['accept', 'user-agent'], status: 403, redirected: false, setCookie: true, cfMitigated: 'challenge', cfRay: '8f00-IAD' }]);
    expect(JSON.stringify(rec.records)).not.toContain('SECRETVALUE');
  });

  it('never lets impit follow a redirect, and keeps the absolute Location for the follower', async () => {
    const rec = createRecordingFetch();
    const f = fakeImpit(() => ({ status: 302, headers: { location: '/upload/pictures/elsewhere.jpeg' } }));
    await rec.wrapImpit(f.impit).fetch(U(1), { method: 'GET', headers: {} });
    expect(f.calls[0]!.init.redirect).toBe('manual');
    expect(rec.records[0]).toMatchObject({ lane: 'impit', status: 302, redirected: true, setCookie: false });
    expect(rec.takeLocation(U(1))).toBe(`https://${STATIC}/upload/pictures/elsewhere.jpeg`);
    expect(rec.takeLocation(U(1))).toBeUndefined();
  });

  it('a 3xx with no Location, or an unparseable one, is no hop', async () => {
    const rec = createRecordingFetch();
    await rec.wrapImpit(fakeImpit(() => ({ status: 301 })).impit).fetch(U(1), { method: 'GET' });
    await rec.wrapImpit(fakeImpit(() => ({ status: 307, headers: { location: 'http://[bad' } })).impit).fetch(U(2), { method: 'GET' });
    expect(rec.takeLocation(U(1))).toBeUndefined();
    expect(rec.takeLocation(U(2))).toBeUndefined();
    expect(rec.records.map(r => r.sentHeaderNames)).toEqual([[], []]);
  });

  it('a response with no Headers bag records no signal, and one with no status counts as a 200', async () => {
    const rec = createRecordingFetch();
    const bare: ImpitLike = { fetch: async url => ({ url, text: async () => '' }) };
    await rec.wrapImpit(bare).fetch(U(1), { method: 'GET' });
    expect(rec.records).toEqual([{ url: U(1), lane: 'impit', egress: 'direct', sentHeaderNames: [], status: 200, redirected: false, setCookie: false, cfMitigated: undefined, cfRay: undefined }]);
  });

  it('the http lane records say lane http, so a probe shows which lane carried each request', async () => {
    const rec = createRecordingFetch(async url => ({ status: 200, url, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) }));
    await rec.fetchImpl(U(1), { headers: { accept: '*/*' } });
    expect(rec.records[0]).toMatchObject({ lane: 'http' });
  });
});

describe('the probe evidence names the lane of each request', () => {
  it('carries lane from the request record into the evidence row', () => {
    const v = judgeProbe({
      observations: [{ url: U(1), ok: true, status: 200, contentType: 'image/jpeg', bytes: 10, finalUrl: U(1), ms: 5 }],
      requests: [{ url: U(1), lane: 'impit', sentHeaderNames: ['accept', 'user-agent'], status: 200, redirected: false, setCookie: false }],
      allowedHosts: [STATIC], wanted: 1,
    });
    expect(v.verdict).toBe('PASS');
    expect(v.evidence).toEqual([{ path: new URL(U(1)).pathname, ms: 5, outcome: 'ok', status: 200, contentType: 'image/jpeg', bytes: 10, lane: 'impit', sentHeaderNames: ['accept', 'user-agent'], setCookie: false, redirected: false }]);
  });

  it('says, when impit carried a request, that the wire held more header names than the evidence lists (and no cookie jar)', () => {
    const judge = (lane: 'http' | 'impit') => judgeProbe({
      observations: [{ url: U(1), ok: true, status: 200, contentType: 'image/jpeg', bytes: 10, finalUrl: U(1), ms: 5 }],
      requests: [{ url: U(1), lane, sentHeaderNames: ['accept'], status: 200, redirected: false, setCookie: false }],
      allowedHosts: [STATIC], wanted: 1,
    });
    const impit = judge('impit');
    expect(impit.verdict).toBe('PASS');
    expect(impit.notes.join(' ')).toMatch(/over impit\b.*profile's own browser headers.*no cookie jar/);
    expect(judge('http').notes).toEqual([]);
  });

  it('an impit request that met a challenge is a FAIL whose evidence still says impit', () => {
    const v = judgeProbe({
      observations: [{ url: U(1), ok: false, reason: 'http-status', status: 403, signals: { 'cf-mitigated': 'challenge' }, ms: 5 }],
      requests: [{ url: U(1), lane: 'impit', sentHeaderNames: ['accept'], status: 403, redirected: false, setCookie: false, cfMitigated: 'challenge', cfRay: '1-IAD' }],
      allowedHosts: [STATIC], wanted: 1,
    });
    expect(v.verdict).toBe('FAIL');
    expect(v.reasons.join(' ')).toMatch(/cf-mitigated challenge/);
    expect(v.evidence[0]).toMatchObject({ lane: 'impit', status: 403, cfRay: '1-IAD', outcome: 'blocked' });
  });
});

describe('createGalleryImpitFetch: the shared impit image transport, with the gallery rules', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'gal-impit-')); });
  afterEach(() => {
    delete process.env.CF_COOKIE_FILE;
    resetCfCookieStore();
    rmSync(dir, { recursive: true, force: true });
  });

  it('builds ONE session for the run, on the chrome profile, and fetches through it', async () => {
    const f = fakeImpit();
    const made: string[] = [];
    const fetcher = createGalleryImpitFetch({ makeImpit: browser => { made.push(browser); return f.impit; } });
    expect(await fetcher(U(1), { userAgent: 'Mozilla/5.0 Chrome/124' })).toMatchObject({ ok: true, status: 200, contentType: 'image/png' });
    expect(await fetcher(U(2), {})).toMatchObject({ ok: true });
    expect(GALLERY_IMPIT_BROWSER).toBe('chrome');
    expect(made).toEqual(['chrome']);
    expect(f.calls.map(c => c.url)).toEqual([U(1), U(2)]);
  });

  it('sends no stored cookie and no minted UA, even for a host the cookie store holds a clearance for', async () => {
    const file = path.join(dir, 'cf-cookies.json');
    writeFileSync(file, JSON.stringify({ [STATIC]: { cookies: { cf_clearance: 'MINTEDVALUE' }, userAgent: 'MintUA/9.9' } }));
    process.env.CF_COOKIE_FILE = file;
    resetCfCookieStore();
    const f = fakeImpit();
    const fetcher = createGalleryImpitFetch({ makeImpit: () => f.impit });
    await fetcher(U(1), {});
    const headers = f.calls[0]!.init.headers ?? {};
    expect(Object.keys(headers).map(h => h.toLowerCase())).not.toContain('cookie');
    expect(JSON.stringify(headers)).not.toContain('MintUA');
    expect(JSON.stringify(headers)).not.toContain('MINTEDVALUE');
  });

  it('routes every request through the wrapper it is given (the recorder)', async () => {
    const f = fakeImpit();
    const rec = createRecordingFetch();
    const fetcher = createGalleryImpitFetch({ makeImpit: () => f.impit, wrap: rec.wrapImpit });
    await fetcher(U(1), {});
    expect(rec.records.map(r => [r.url, r.lane])).toEqual([[U(1), 'impit']]);
  });

  it('never builds a proxied session', async () => {
    const made: string[] = [];
    const fetcher = createGalleryImpitFetch({ makeImpit: b => { made.push(b); return fakeImpit().impit; } });
    await expect(fetcher(U(1), { proxyUrl: 'socks5://home.invalid:1080' })).rejects.toThrow(/never leaves through a proxy/);
    expect(made).toEqual([]);
  });

  it('ready() builds the session ahead of any request, once', async () => {
    const f = fakeImpit();
    const made: string[] = [];
    const fetcher = createGalleryImpitFetch({ makeImpit: b => { made.push(b); return f.impit; } });
    await fetcher.ready();
    await fetcher.ready();
    expect(made).toEqual(['chrome']);
    expect(f.calls).toEqual([]);
    await fetcher(U(1), {});
    expect(made).toEqual(['chrome']);
  });

  it('impitReadyFirst builds the session before an impit request reaches the pacer, and leaves the http lane alone', async () => {
    const order: string[] = [];
    const paced: ImageBytesFetcher = async (url, options) => { order.push(`paced ${(options as { lane?: string } | undefined)?.lane ?? 'none'} ${url}`); return ok200(); };
    let built = false;
    const wrapped = impitReadyFirst(paced, { ready: async () => { order.push('ready'); built = true; } });
    await wrapped(U(1), { lane: 'http' } as ImageFetchOptions);
    await wrapped(U(2));
    expect(built).toBe(false);
    await wrapped(U(3), { lane: 'impit' } as ImageFetchOptions);
    expect(order).toEqual([`paced http ${U(1)}`, `paced none ${U(2)}`, 'ready', `paced impit ${U(3)}`]);
  });

  it('impitReadyFirst: a session that cannot be built fails the request before the pacer sees it', async () => {
    const paced = jest.fn(async () => ok200());
    const wrapped = impitReadyFirst(paced, { ready: async () => { throw new Error('native module missing'); } });
    await expect(wrapped(U(1), { lane: 'impit' } as ImageFetchOptions)).rejects.toThrow(/native module missing/);
    expect(paced).not.toHaveBeenCalled();
  });

  it('a session that failed to build is built again on the next request', async () => {
    let n = 0;
    const f = fakeImpit();
    const fetcher = createGalleryImpitFetch({ makeImpit: async () => { if (++n === 1) throw new Error('native module missing'); return f.impit; } });
    await expect(fetcher(U(1), {})).rejects.toThrow(/native module missing/);
    expect(await fetcher(U(2), {})).toMatchObject({ ok: true });
    expect(n).toBe(2);
  });
});

describe('galleryImpitFactory: the REAL impit, against 127.0.0.1 only', () => {
  type Seen = { path: string; headers: http.IncomingHttpHeaders };
  let server: http.Server;
  let seen: Seen[];
  let base: string;
  beforeAll(async () => {
    seen = [];
    server = http.createServer((req, res) => {
      seen.push({ path: req.url ?? '', headers: req.headers });
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);
      if (req.url === '/cookie.png') { res.writeHead(200, { 'set-cookie': 'sid=SERVERSET; Path=/', 'content-type': 'image/png' }); return void res.end(png); }
      if (req.url === '/redir.png') { res.writeHead(302, { location: '/target.png' }); return void res.end(); }
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(png);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  beforeEach(() => { seen.length = 0; });

  it('keeps no cookie: a Set-Cookie is never sent back', async () => {
    const impit = await galleryImpitFactory(5000)(GALLERY_IMPIT_BROWSER);
    const first = await impit.fetch(`${base}/cookie.png`, { method: 'GET', headers: { accept: '*/*' } });
    expect(first.status).toBe(200);
    await first.bytes!();
    const second = await impit.fetch(`${base}/next.png`, { method: 'GET', headers: { accept: '*/*' } });
    await second.bytes!();
    expect(seen.map(s => s.path)).toEqual(['/cookie.png', '/next.png']);
    for (const s of seen) expect(s.headers.cookie).toBeUndefined();
  });

  it('does not follow a redirect: the 3xx comes back and the target is never asked', async () => {
    const impit = await galleryImpitFactory(5000)(GALLERY_IMPIT_BROWSER);
    const res = await impit.fetch(`${base}/redir.png`, { method: 'GET', headers: { accept: '*/*' } });
    expect(res.status).toBe(302);
    expect(seen.map(s => s.path)).toEqual(['/redir.png']);
  });

  it("identifies as the chrome profile's Chrome, never as an AI crawler, and sends no Referer", async () => {
    const impit = await galleryImpitFactory()(GALLERY_IMPIT_BROWSER);
    await (await impit.fetch(`${base}/a.png`, { method: 'GET', headers: { accept: '*/*' } })).bytes!();
    const ua = String(seen[0]!.headers['user-agent']);
    expect(ua).toMatch(/Chrome\/\d+/);
    expect(AI_CRAWLER_UA.test(ua)).toBe(false);
    expect(seen[0]!.headers.referer).toBeUndefined();
    expect(seen[0]!.headers['sec-ch-ua']).toMatch(/Google Chrome/);
  });
});
