/**
 * The gallery driver, red-team round 3 (MFC-GALLERY-2 fix round 3): R3-S1, a body the lane accepts and the store will not keep.
 * The lane trusts a declared image/* type; the sink sniffs magic bytes and SKIPS what is not JPEG, PNG, GIF, WebP or AVIF (counting it
 * notImage / empty) while still calling it admitted. Such a file is real, will never be at rest, and must not be fetched again.
 */
import type { ImageBytesResult } from '../../services/images/imageBytes';
import { galleryExitCode } from '../../services/images/galleryCapture';
import { classifyObservation, createFetchObserver, followAllowedRedirects, judgeProbe, originAllowed, parseAllowedOrigin, runGalleryCapture, type FetchObservation } from '../../services/images/galleryDriver';
import type { ImageBytesFetcher } from '../../services/images/imageBytes';
import { K, PNG, U, baseOpts, gdeps, item, memoHook, ok200, recordingLedger, scriptedSink } from '../helpers/galleryDriverDoubles';

const body = (bytes: Buffer, contentType: string): ImageBytesResult => ({ ok: true, bytes, contentType, status: 200, finalUrl: 'x', headers: {} });
const html = (): ImageBytesResult => body(Buffer.from('<html><body>hotlink protected</body></html>'), 'image/jpeg');
const bmp = (): ImageBytesResult => body(Buffer.concat([Buffer.from('BM'), Buffer.alloc(30, 7)]), 'image/bmp');
const empty = (): ImageBytesResult => body(Buffer.alloc(0), 'image/jpeg');
/** Which of the three goes with which url. */
const scripted = (map: Record<string, () => ImageBytesResult>) => (url: string): ImageBytesResult => (map[url] ?? (() => ok200(3)))();

describe('R3-S1 (unit): the observation', () => {
  const obs = (over: Partial<FetchObservation>): FetchObservation => ({ url: U(1), ok: true, status: 200, contentType: 'image/jpeg', bytes: 40, ms: 1, ...over });

  it('an ok fetch whose body is not an image is its own class; an ordinary ok stays ok', () => {
    expect(classifyObservation(obs({ notImage: true }))).toBe('notimage');
    expect(classifyObservation(obs({}))).toBe('ok');
  });

  it('the observer marks a body the store would not keep: an HTML page, a BMP, an empty body; never a PNG', async () => {
    const observer = createFetchObserver({ pauseAfter: 9, now: () => 0 });
    const f = observer.wrap(async url => scripted({ [U(1)]: html, [U(2)]: bmp, [U(3)]: empty, [U(4)]: () => ok200(1) })(url));
    for (const n of [1, 2, 3, 4]) await f(U(n), {});
    expect(observer.take().map(o => o.notImage === true)).toEqual([true, true, true, false]);
  });

  it('it counts toward the pause streak like a block, and a good file resets it', async () => {
    const run = async (urls: Array<() => ImageBytesResult>) => {
      const observer = createFetchObserver({ pauseAfter: 3, now: () => 0 });
      const f = observer.wrap(async url => urls[Number(/(\d+)\.jpeg$/.exec(url)![1]) - 1]!());
      for (let i = 1; i <= urls.length; i++) await f(U(i), {});
      return observer.tripped();
    };
    expect(await run([html, bmp, html])).toMatch(/3 consecutive blocked or failed fetches \(last: a body that is not an image/);
    expect(await run([html, html, () => ok200(1), html])).toBeUndefined();
  });
});

describe('R3-S1 (unit): the driver settles it', () => {
  it('an HTML page, a BMP and an empty body are settled skipped:not_image (the sink counted notImage / empty), counted, and the item has no failure', async () => {
    for (const [name, make, kind] of [['html', html, 'notImage'], ['bmp', bmp, 'notImage'], ['empty', empty, 'empty']] as const) {
      const observer = createFetchObserver({ pauseAfter: 9, now: () => 0 });
      const mh = memoHook(observer, scripted({ [U(2)]: make }));
      const sink = scriptedSink((_n, c) => { c.assetSkipped[kind] += 1; });
      const { ledger, how } = recordingLedger();
      const r = await runGalleryCapture(gdeps(mh.hook, sink, observer, ledger, [item('1', [1, 2])]), baseOpts({ storeMaxBytes: 1000 }));
      expect([name, [...how.entries()].sort()]).toEqual([name, [[`${K('1')} 1.jpeg`, 'stored'], [`${K('1')} 2.jpeg`, 'skipped:not_image']]]);
      expect([name, r.itemsWithFailures, r.stored, r.skippedNotImage]).toEqual([name, 0, 1, 1]);
    }
  });

  it('a sharing item gets the same verdict through the memo, with nothing fetched for it', async () => {
    const observer = createFetchObserver({ pauseAfter: 9, now: () => 0 });
    const mh = memoHook(observer, scripted({ [U(1)]: html }));
    const sink = scriptedSink((n, c) => { if (n === 1) c.assetSkipped.notImage += 1; });
    const { ledger, how } = recordingLedger();
    const r = await runGalleryCapture(gdeps(mh.hook, sink, observer, ledger, [item('1', [1]), item('2', [1])]), baseOpts({ storeMaxBytes: 1000 }));
    expect([...how.entries()]).toEqual([[`${K('1')} 1.jpeg`, 'skipped:not_image'], [`${K('2')} 1.jpeg`, 'skipped:not_image']]);
    expect(mh.fetchedUrls).toEqual([U(1)]);
    expect(r).toMatchObject({ skippedNotImage: 2, itemsWithFailures: 0 });
  });

  it('three of them in a row pause the run (the settled files stay settled)', async () => {
    const observer = createFetchObserver({ pauseAfter: 3, now: () => 0 });
    const mh = memoHook(observer, scripted({ [U(1)]: html, [U(2)]: bmp, [U(3)]: html }));
    const sink = scriptedSink((_n, c) => { c.assetSkipped.notImage += 3; });
    const { ledger, how } = recordingLedger();
    const r = await runGalleryCapture(gdeps(mh.hook, sink, observer, ledger, [item('1', [1, 2, 3, 4])]), baseOpts({ storeMaxBytes: 1000 }));
    expect(r.stopped).toBe('paused');
    expect([...how.values()]).toEqual(['skipped:not_image', 'skipped:not_image', 'skipped:not_image']);
  });

  it('the sink checks size before type: an HTML body over the ceiling is skipped:too_large', async () => {
    const observer = createFetchObserver({ pauseAfter: 9, now: () => 0 });
    const mh = memoHook(observer, scripted({ [U(1)]: html }));
    const sink = scriptedSink((_n, c) => { c.assetSkipped.tooLarge += 1; });
    const { ledger, how } = recordingLedger();
    await runGalleryCapture(gdeps(mh.hook, sink, observer, ledger, [item('1', [1])]), baseOpts({ storeMaxBytes: 10 }));
    expect([...how.values()]).toEqual(['skipped:too_large']);
  });

  it('a sink skip the fetched bodies do not explain (it says notImage, the body is a PNG) is still a lost put', async () => {
    const observer = createFetchObserver({ pauseAfter: 9, now: () => 0 });
    const mh = memoHook(observer);
    const sink = scriptedSink((_n, c) => { c.assetSkipped.notImage += 1; });
    const { ledger, how } = recordingLedger();
    const r = await runGalleryCapture(gdeps(mh.hook, sink, observer, ledger, [item('1', [1])]), baseOpts({ storeMaxBytes: 1000 }));
    expect([how.size, r.itemsWithFailures]).toEqual([0, 1]);
  });

  it('two bodies the store would not keep but the hook sent only once (same bytes) are both settled', async () => {
    const observer = createFetchObserver({ pauseAfter: 9, now: () => 0 });
    const mh = memoHook(observer, scripted({ [U(1)]: html, [U(2)]: html }));
    const sink = scriptedSink((n, c) => { if (n === 1) c.assetSkipped.notImage += 1; }); // the second never reached the sink
    const { ledger, how } = recordingLedger();
    const r = await runGalleryCapture(gdeps(mh.hook, sink, observer, ledger, [item('1', [1, 2])]), baseOpts({ storeMaxBytes: 1000 }));
    expect([...how.values()]).toEqual(['skipped:not_image', 'skipped:not_image']);
    expect(r.itemsWithFailures).toBe(0);
  });

  it('a body that is a real image is stored, whatever its declared type', async () => {
    const observer = createFetchObserver({ pauseAfter: 9, now: () => 0 });
    const mh = memoHook(observer, scripted({ [U(1)]: () => body(PNG(1), 'application/octet-stream') }));
    const { ledger, how } = recordingLedger();
    await runGalleryCapture(gdeps(mh.hook, scriptedSink(() => undefined), observer, ledger, [item('1', [1])]), baseOpts({ storeMaxBytes: 1000 }));
    expect([...how.values()]).toEqual(['stored']);
  });
});

describe('R3-S1 (unit): the probe', () => {
  const obsOk = (over: Partial<FetchObservation> = {}): FetchObservation => ({ url: U(1), ok: true, status: 200, contentType: 'image/jpeg', bytes: 40, ms: 1, ...over });
  const rec = (url: string) => ({ url, sentHeaderNames: ['accept'], status: 200, redirected: false, setCookie: false });

  it('judgeProbe fails a body the store would not keep', () => {
    const v = judgeProbe({ observations: [obsOk({ notImage: true })], requests: [rec(U(1))], allowedHosts: ['static.myfigurecollection.net'], wanted: 1, exhausted: true });
    expect(v.verdict).toBe('FAIL');
    expect(v.reasons.join(' ')).toMatch(/not an image/i);
  });

  const probeRun = async (script: Parameters<typeof scripted>[0], flush: Parameters<typeof scriptedSink>[0], storeMaxBytes = 1000) => {
    const observer = createFetchObserver({ pauseAfter: 9, now: () => 0 });
    const answer = scripted(script);
    const mh = memoHook(observer, url => { const r = answer(url); return r.ok ? { ...r, finalUrl: url } : r; });
    const deps = { ...gdeps(mh.hook, scriptedSink(flush), observer, recordingLedger().ledger, [item('1', [1, 2])]), requests: () => [U(1), U(2)].map(rec) };
    return runGalleryCapture(deps, baseOpts({ probe: 2, storeMaxBytes }));
  };

  it('a clean probe is a PASS', async () => {
    expect((await probeRun({}, () => undefined)).probe?.verdict).toBe('PASS');
  });

  it('the exit code is 0 exactly when the printed verdict is PASS, in every scenario', async () => {
    const runs = [
      await probeRun({}, () => undefined),
      await probeRun({}, (n, c) => { if (n === 1) c.assetFailed += 1; }),
      await probeRun({ [U(1)]: () => ok200(1, 200) }, (_n, c) => { c.assetSkipped.tooLarge += 1; }, 100),
      await probeRun({ [U(2)]: html }, (_n, c) => { c.assetSkipped.notImage += 1; }),
      await probeRun({ [U(1)]: () => ({ ok: false, reason: 'http-status', status: 403 }) as ImageBytesResult }, () => undefined),
    ];
    expect(runs.map(r => r.probe?.verdict)).toEqual(['PASS', 'FAIL', 'FAIL', 'FAIL', 'FAIL']);
    expect(runs.map(r => galleryExitCode(r) === 0)).toEqual(runs.map(r => r.probe?.verdict === 'PASS'));
  });

  it('FAIL when the store did not confirm a write', async () => {
    const r = await probeRun({}, (n, c) => { if (n === 1) c.assetFailed += 1; });
    expect(r.probe?.verdict).toBe('FAIL');
    expect(r.probe?.reasons.join(' ')).toMatch(/did not confirm/i);
    expect(r.itemsWithFailures).toBe(1);
  });

  it('FAIL when the store skipped a file as over its ceiling', async () => {
    const r = await probeRun({ [U(1)]: () => ok200(1, 200) }, (_n, c) => { c.assetSkipped.tooLarge += 1; }, 100);
    expect(r.probe?.verdict).toBe('FAIL');
    expect(r.probe?.reasons.join(' ')).toMatch(/ceiling/i);
  });

  it('FAIL when the store skipped a file as not an image', async () => {
    const r = await probeRun({ [U(2)]: html }, (_n, c) => { c.assetSkipped.notImage += 1; });
    expect(r.probe?.verdict).toBe('FAIL');
    expect(r.probe?.reasons.join(' ')).toMatch(/not an image/i);
  });
});

describe('R3-N4 (unit): the scheme is part of the origin', () => {
  it.each([
    ['a bare host is https', 'img.example', { scheme: 'https', host: 'img.example' }],
    ['host:port is https on that port', 'img.example:8443', { scheme: 'https', host: 'img.example', port: 8443 }],
    ['an explicit https://', 'https://IMG.example.', { scheme: 'https', host: 'img.example' }],
    ['an explicit https://host:port', 'https://img.example:8443', { scheme: 'https', host: 'img.example', port: 8443 }],
    ['an explicit http://', 'http://img.example', { scheme: 'http', host: 'img.example' }],
    ['http:// with a port', 'HTTP://localhost:18471', { scheme: 'http', host: 'localhost', port: 18471 }],
  ])('parses %s', (_why, entry, want) => {
    expect(parseAllowedOrigin(entry)).toEqual(want);
  });

  it.each(['ftp://img.example', 'ws://img.example', 'http://', 'https://', 'http://img.example/path', 'http://img.example?x=1', 'http://img.example#f', 'http://user@img.example', 'http://:80', 'http://img.example:0', 'http://img.example:70000', 'http:/img.example', 'http//img.example'])('rejects %j', entry => {
    expect(parseAllowedOrigin(entry)).toBeUndefined();
  });

  const allowed = (...entries: string[]) => entries.map(e => parseAllowedOrigin(e)!);
  it.each([
    ['a bare host: https on its default port', 'https://img.example/a.jpg', ['img.example'], true],
    ['a bare host: NOT cleartext http', 'http://img.example/a.jpg', ['img.example'], false],
    ['a bare host: not another https port', 'https://img.example:8443/a.jpg', ['img.example'], false],
    ['host:443 is https, so http on port 443 is not allowed', 'http://img.example:443/a.jpg', ['img.example:443'], false],
    ['host:443 allows https on 443', 'https://img.example/a.jpg', ['img.example:443'], true],
    ['host:8443 allows https on 8443', 'https://img.example:8443/a.jpg', ['img.example:8443'], true],
    ['an http:// entry allows http on port 80', 'http://img.example/a.jpg', ['http://img.example'], true],
    ['an http:// entry does not allow https', 'https://img.example/a.jpg', ['http://img.example'], false],
    ['an http:// entry does not allow another port', 'http://img.example:8080/a.jpg', ['http://img.example'], false],
    ['an http:// entry naming port 80 allows the default', 'http://img.example/a.jpg', ['http://img.example:80'], true],
    ['an https entry naming port 443 allows the default', 'https://img.example/a.jpg', ['https://img.example:443'], true],
    ['http://host:port allows exactly that', 'http://localhost:18471/a.jpg', ['http://localhost:18471'], true],
    ['http://host:port not with https', 'https://localhost:18471/a.jpg', ['http://localhost:18471'], false],
    ['both entries allow both', 'http://img.example/a.jpg', ['img.example', 'http://img.example'], true],
  ])('%s', (_why, url, entries, want) => {
    expect(originAllowed(url, allowed(...entries))).toBe(want);
  });

  it('an https -> http redirect on an allowed host is refused unless http:// is listed', async () => {
    const calls: string[] = [];
    const paced: ImageBytesFetcher = async url => {
      calls.push(url);
      return url.startsWith('https:') ? ({ ok: false, reason: 'http-status', status: 302 } as ImageBytesResult) : { ...ok200(1), finalUrl: url };
    };
    const to = () => 'http://img.example/b.jpg';
    expect(await followAllowedRedirects(paced, { allowedHosts: ['img.example'], locationOf: to })('https://img.example/a.jpg', {}))
      .toMatchObject({ ok: false, reason: 'refused', detail: expect.stringMatching(/outside the allow-list/) });
    expect(calls).toEqual(['https://img.example/a.jpg']);
    calls.length = 0;
    const res = await followAllowedRedirects(paced, { allowedHosts: ['img.example', 'http://img.example'], locationOf: to })('https://img.example/a.jpg', {});
    expect(res).toMatchObject({ ok: true });
    expect(calls).toEqual(['https://img.example/a.jpg', 'http://img.example/b.jpg']);
  });

  it('the probe fails bytes that came over cleartext http from a host listed bare', () => {
    const v = judgeProbe({
      observations: [{ url: 'https://img.example/a.jpg', ok: true, status: 200, contentType: 'image/png', bytes: 5, finalUrl: 'http://img.example/a.jpg', ms: 1 }],
      requests: [], allowedHosts: ['img.example'], wanted: 1, exhausted: true,
    });
    expect(v.verdict).toBe('FAIL');
  });
});
