/**
 * The gallery driver, red-team round 2 (MFC-GALLERY-2 fix round 2): what a settlement means when a memo hit, a lost put or the
 * store's own size cap is involved; per-origin allow-lists; credentials in a Location; a stop that reaches the dispatch of a hop.
 */
import { HostRateLimiter } from '../../driver/hostRateLimiter';
import { paceImageBytesByHost } from '../../services/images/imageBytesPacing';
import { buildImageHostPolicy } from '../../services/images/imageHostPolicy';
import type { ImageBytesFetcher, ImageBytesResult } from '../../services/images/imageBytes';
import { imageHostRateFor } from '../../services/images/imageHostRates';
import {
  createFetchObserver, createMemoryLedger, followAllowedRedirects, gateOnStop, judgeProbe, originAllowed, parseAllowedOrigin, runGalleryCapture,
  type ConfirmingSink, type GalleryLedger, type GalleryRunOptions, type Settled,
} from '../../services/images/galleryDriver';
import type { WorklistItem } from '../../services/images/galleryWorklist';

const STATIC = 'static.myfigurecollection.net';
const U = (n: number | string) => `https://${STATIC}/upload/pictures/2022/10/14/${n}.jpeg`;
const PAGE = (id: string) => `https://myfigurecollection.net/item/${id}`;
const PNG = (n: number, size = 11) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n, n, n]), Buffer.alloc(Math.max(0, size - 11))]);
const POLICY = buildImageHostPolicy({ [STATIC]: { lane: 'http', egress: 'direct' } });
const noop = () => undefined;
const K = (id: string) => `mfc/${id}`;

const item = (id: string, nums: number[], over: Partial<WorklistItem> = {}): WorklistItem => ({
  site: 'mfc', itemId: id, pageUrl: PAGE(id), rank: 0, entries: nums.map((n, i) => ({ position: i, src: U(n), w: 600, h: 600 })), ...over,
});
async function* feed(items: WorklistItem[]) { for (const it of items) yield { ok: true as const, item: it, dropped: 0 }; }
const ok200 = (n = 1, size = 11): ImageBytesResult => ({ ok: true, bytes: PNG(n, size), contentType: 'image/png', status: 200, finalUrl: 'x', headers: {} });
const baseOpts = (over: Partial<GalleryRunOptions> = {}): GalleryRunOptions => ({ allowedHosts: [STATIC], pauseAfter: 3, pauseMs: 6 * 3600_000, ...over });

type Counters = { assetFailed: number; dropped: number; droppedBytes: number; assetRefusedReserve: number; assetSkipped: { tooLarge: number; notImage: number; empty: number; disabled: number } };
const zero = (): Counters => ({ assetFailed: 0, dropped: 0, droppedBytes: 0, assetRefusedReserve: 0, assetSkipped: { tooLarge: 0, notImage: 0, empty: 0, disabled: 0 } });
/** A sink whose counters the test moves from inside `flush`, as a worker finishing (or failing) a put does. */
const scriptedSink = (onFlush: (n: number, c: Counters) => void): ConfirmingSink => {
  const c = zero();
  let n = 0;
  return { flush: async () => { onFlush(++n, c); }, stats: () => ({ ...c, assetSkipped: { ...c.assetSkipped } }) };
};

/**
 * A hook double with the real hook's memo semantics: a url fetched once is a MEMO hit for any later item (no request, a `memo` skip);
 * `forget` makes it fetch again. Remembering happens at admission, before the sink has put anything, as the real hook does.
 */
function memoHook(observer: ReturnType<typeof createFetchObserver>, script: (url: string) => ImageBytesResult = () => ok200(), opts: { preseeded?: string[]; noForget?: boolean; extraSkip?: (itemId: string) => string | undefined } = {}) {
  const remembered = new Set<string>(opts.preseeded ?? []);
  const forgotten: string[][] = [];
  const fetchedUrls: string[] = [];
  const skipped: Record<string, number> = { memo: 0, cap: 0, sinkQueueFull: 0, refused: 0 };
  const fetcher = observer.wrap(async url => script(url));
  const hook = {
    async capture(req: { itemId: string; ruleset: { describeImages?: (f: Record<string, unknown>) => Array<{ url: string }> }; fields: Record<string, unknown> }) {
      const extra = opts.extraSkip?.(req.itemId);
      if (extra !== undefined) skipped[extra] = (skipped[extra] ?? 0) + 1;
      for (const r of req.ruleset.describeImages!(req.fields)) {
        if (remembered.has(r.url)) { skipped.memo += 1; continue; }
        fetchedUrls.push(r.url);
        const res = await fetcher(r.url, {});
        if (res.ok) remembered.add(r.url);
      }
    },
    stats: () => ({ enabled: true, attempted: 0, stored: 0, deduped: 0, failed: 0, residentialBytesToday: 0, skipped: { ...skipped } }),
    ...(opts.noForget === true ? {} : { forget(urls: readonly string[]) { forgotten.push([...urls]); for (const u of urls) remembered.delete(u); } }),
  };
  return { hook: hook as never, forgotten, fetchedUrls };
}

/** A ledger that remembers HOW each pair was settled. */
function recordingLedger(): { ledger: GalleryLedger; how: Map<string, Settled> } {
  const inner = createMemoryLedger();
  const how = new Map<string, Settled>();
  return { how, ledger: { ...inner, has: inner.has, settle(i, u, h) { how.set(`${i} ${u.split('/').pop()}`, h); inner.settle(i, u, h); } } };
}
const gdeps = (hook: never, sink: ConfirmingSink, observer: ReturnType<typeof createFetchObserver>, ledger: GalleryLedger, items: WorklistItem[]) =>
  ({ hook, sink, observer, policy: POLICY, ledger, items: feed(items), now: () => 0, log: noop, requests: () => [] });

describe('R2-B1a (unit): a memo hit settles a file only if its put was CONFIRMED', () => {
  it('the winner\'s put was lost: its urls are forgotten, the sharer fetches the file itself, and only what the store confirms is settled', async () => {
    const observer = createFetchObserver({ pauseAfter: 9, now: () => 0 });
    const mh = memoHook(observer);
    const sink = scriptedSink((n, c) => { if (n === 1) c.assetFailed += 1; });
    const { ledger, how } = recordingLedger();
    const r = await runGalleryCapture(gdeps(mh.hook, sink, observer, ledger, [item('1', [1, 2]), item('2', [1])]), baseOpts());
    expect(mh.forgotten).toEqual([[U(1), U(2)]]);
    expect(mh.fetchedUrls).toEqual([U(1), U(2), U(1)]);
    expect([...how.entries()]).toEqual([[`${K('2')} 1.jpeg`, 'stored']]);
    expect(r).toMatchObject({ itemsWithFailures: 1, stored: 1, fetched: 3 });
  });

  it('X03: a memo hit nothing in this run confirmed is never settled, and counts as a failure', async () => {
    const observer = createFetchObserver({ pauseAfter: 9, now: () => 0 });
    const mh = memoHook(observer, () => ok200(), { preseeded: [U(5)] });
    const { ledger, how } = recordingLedger();
    const r = await runGalleryCapture(gdeps(mh.hook, scriptedSink(() => undefined), observer, ledger, [item('1', [5, 6])]), baseOpts());
    expect([...how.keys()]).toEqual([`${K('1')} 6.jpeg`]);
    expect(r).toMatchObject({ itemsWithFailures: 1, stored: 1 });
  });

  it('a memo hit on a file the store CONFIRMED is settled (and the memo is not disturbed)', async () => {
    const observer = createFetchObserver({ pauseAfter: 9, now: () => 0 });
    const mh = memoHook(observer);
    const { ledger, how } = recordingLedger();
    const r = await runGalleryCapture(gdeps(mh.hook, scriptedSink(() => undefined), observer, ledger, [item('1', [1]), item('2', [1])]), baseOpts());
    expect([...how.entries()]).toEqual([[`${K('1')} 1.jpeg`, 'stored'], [`${K('2')} 1.jpeg`, 'stored']]);
    expect(mh.forgotten).toEqual([]);
    expect(r).toMatchObject({ itemsWithFailures: 0, stored: 2, fetched: 1 });
  });

  it('X02: a memo hit while the hook ALSO skipped something else in the item is not settled (the skip is unexplained)', async () => {
    const observer = createFetchObserver({ pauseAfter: 9, now: () => 0 });
    const mh = memoHook(observer, () => ok200(), { extraSkip: id => (id === '2' ? 'thumbnailRole' : undefined) });
    const { ledger, how } = recordingLedger();
    await runGalleryCapture(gdeps(mh.hook, scriptedSink(() => undefined), observer, ledger, [item('1', [1]), item('2', [1])]), baseOpts());
    expect(how.get(`${K('1')} 1.jpeg`)).toBe('stored');
    expect(how.has(`${K('2')} 1.jpeg`)).toBe(false);
  });
});

describe('R2-B1b (unit): the raw store\'s own size cap', () => {
  it('an ok fetch over storeMaxBytes is settled skipped:too_large (once per pair), counted apart from stored, never as stored', async () => {
    const observer = createFetchObserver({ pauseAfter: 9, now: () => 0 });
    const mh = memoHook(observer, url => (url === U(1) ? ok200(1, 200) : ok200(2, 20)));
    const sink = scriptedSink((n, c) => { if (n === 1) c.assetSkipped.tooLarge += 1; }); // only item 1 sent the store an over-size body
    const { ledger, how } = recordingLedger();
    const r = await runGalleryCapture(gdeps(mh.hook, sink, observer, ledger, [item('1', [1, 2]), item('2', [1])]), baseOpts({ storeMaxBytes: 100 }));
    expect([...how.entries()].sort()).toEqual([
      [`${K('1')} 1.jpeg`, 'skipped:too_large'], [`${K('1')} 2.jpeg`, 'stored'], [`${K('2')} 1.jpeg`, 'skipped:too_large'],
    ]);
    expect(r).toMatchObject({ stored: 1, skippedTooLarge: 2, itemsWithFailures: 0 });
  });

  it('an unexplained store skip (notImage, empty, disabled, or a tooLarge the sizes do not explain) leaves the item unsettled and counted', async () => {
    for (const which of ['notImage', 'empty', 'disabled', 'tooLarge'] as const) {
      const observer = createFetchObserver({ pauseAfter: 9, now: () => 0 });
      const mh = memoHook(observer);
      const sink = scriptedSink((_n, c) => { c.assetSkipped[which] += 1; });
      const { ledger, how } = recordingLedger();
      const r = await runGalleryCapture(gdeps(mh.hook, sink, observer, ledger, [item('1', [1])]), baseOpts({ storeMaxBytes: 100 }));
      expect([which, how.size, r.itemsWithFailures]).toEqual([which, 0, 1]);
    }
  });

  it('without a known store cap a store-side tooLarge cannot be explained, so it is a failure rather than a guess', async () => {
    const observer = createFetchObserver({ pauseAfter: 9, now: () => 0 });
    const mh = memoHook(observer);
    const sink = scriptedSink((_n, c) => { c.assetSkipped.tooLarge += 1; });
    const { ledger, how } = recordingLedger();
    const r = await runGalleryCapture(gdeps(mh.hook, sink, observer, ledger, [item('1', [1])]), baseOpts());
    expect([how.size, r.itemsWithFailures]).toEqual([0, 1]);
  });
});

describe('N4 (unit): stored counts confirmed files only', () => {
  it('a lost item stores nothing in the report, whatever was fetched', async () => {
    const observer = createFetchObserver({ pauseAfter: 9, now: () => 0 });
    const mh = memoHook(observer);
    const sink = scriptedSink((n, c) => { if (n === 1) c.assetFailed += 1; });
    const r = await runGalleryCapture(gdeps(mh.hook, sink, observer, createMemoryLedger(), [item('1', [1, 2, 3])]), baseOpts());
    expect(r).toMatchObject({ fetched: 3, stored: 0, itemsWithFailures: 1 });
  });
});

describe('X15 (unit): the driver canonicalises whatever it is handed', () => {
  it('a hostile spelling given straight to the driver is asked for, settled and recognised under the canonical url', async () => {
    const observer = createFetchObserver({ pauseAfter: 9, now: () => 0 });
    const mh = memoHook(observer);
    const { ledger, how } = recordingLedger();
    const hostile = item('1', [], { entries: [{ position: 0, src: `https://${STATIC.toUpperCase()}.:443/upload/p/a%7e%41.jpeg#frag`, w: 1, h: 1 }] });
    await runGalleryCapture(gdeps(mh.hook, scriptedSink(() => undefined), observer, ledger, [hostile]), baseOpts());
    expect(mh.fetchedUrls).toEqual([`https://${STATIC}/upload/p/a~A.jpeg`]);
    expect(ledger.has(K('1'), `https://${STATIC}/upload/p/a~A.jpeg`)).toBe(true);
    expect([...how.values()]).toEqual(['stored']);
  });
});

describe('N1 (unit): the allow-list is per ORIGIN', () => {
  it.each([
    ['host', 'static.example', { host: 'static.example' }],
    ['a host in capitals with a root dot', ' STATIC.Example. ', { host: 'static.example' }],
    ['host:port', 'localhost:8080', { host: 'localhost', port: 8080 }],
    ['a high port', 'img.example:65535', { host: 'img.example', port: 65535 }],
  ])('parses %s', (_why, entry, want) => {
    expect(parseAllowedOrigin(entry)).toEqual(want);
  });

  it.each(['', 'localhost:0', 'localhost:65536', 'localhost:x', 'local host', 'a/b', 'http://localhost', 'user@host', ':80', 'host:80:90'])('rejects %j', entry => {
    expect(parseAllowedOrigin(entry)).toBeUndefined();
  });

  const allowed = (...entries: string[]) => entries.map(e => parseAllowedOrigin(e)!);
  it.each([
    ['https default port', 'https://img.example/a.jpg', ['img.example'], true],
    ['http default port', 'http://img.example/a.jpg', ['img.example'], true],
    ['an explicit default port', 'https://img.example:443/a.jpg', ['img.example'], true],
    ['another port on a bare host', 'https://img.example:8443/a.jpg', ['img.example'], false],
    ['https on the http default port number', 'https://img.example:80/a.jpg', ['img.example'], false],
    ['the listed port', 'http://localhost:18471/a.jpg', ['localhost:18471'], true],
    ['another port than the listed one', 'http://localhost:18472/a.jpg', ['localhost:18471'], false],
    ['the default port when another is listed', 'http://localhost/a.jpg', ['localhost:18471'], false],
    ['another host', 'https://other.example/a.jpg', ['img.example'], false],
    ['a subdomain', 'https://x.img.example/a.jpg', ['img.example'], false],
    ['a root dot and capitals', 'https://IMG.example./a.jpg', ['img.example'], true],
    ['either of two entries', 'http://localhost:2/a.jpg', ['localhost:1', 'localhost:2'], true],
    ['not a url', 'img.example/a.jpg', ['img.example'], false],
    ['not http(s)', 'ftp://img.example/a.jpg', ['img.example'], false],
  ])('%s', (_why, url, entries, want) => {
    expect(originAllowed(url, allowed(...entries))).toBe(want);
  });

  it('a redirect to another port of an allowed host is refused before a request', async () => {
    const calls: string[] = [];
    const paced: ImageBytesFetcher = async url => { calls.push(url); return { ok: false, reason: 'http-status', status: 302 } as ImageBytesResult; };
    const f = followAllowedRedirects(paced, { allowedHosts: ['localhost:18471'], locationOf: () => 'http://localhost:18472/stolen.jpg' });
    expect(await f('http://localhost:18471/a.jpg', {})).toMatchObject({ ok: false, reason: 'refused', detail: expect.stringMatching(/outside the allow-list/) });
    expect(calls).toEqual(['http://localhost:18471/a.jpg']);
  });

  it('judgeProbe flags bytes from another port of the allowed host', () => {
    const v = judgeProbe({
      observations: [{ url: 'http://localhost:18471/a.jpg', ok: true, status: 200, contentType: 'image/png', bytes: 5, finalUrl: 'http://localhost:18472/a.jpg', ms: 1 }],
      requests: [], allowedHosts: ['localhost:18471'], wanted: 1, exhausted: true,
    });
    expect(v.verdict).toBe('FAIL');
  });
});

describe('N2 (unit): credentials in a Location are refused, never echoed', () => {
  it('refuses the hop before a request and names no password', async () => {
    const calls: string[] = [];
    const paced: ImageBytesFetcher = async url => { calls.push(url); return { ok: false, reason: 'http-status', status: 302 } as ImageBytesResult; };
    const f = followAllowedRedirects(paced, { allowedHosts: [STATIC], locationOf: () => `https://user:hunter2@${STATIC}/b.jpg` });
    const res = await f(U(1), {});
    expect(res).toMatchObject({ ok: false, reason: 'refused' });
    expect(JSON.stringify(res)).not.toMatch(/hunter2|user:/);
    expect(calls).toEqual([U(1)]);
  });
});

describe('X13 (unit): a hop to another SCHEME on an allowed host is refused for its scheme', () => {
  it.each(['ftp', 'ws', 'wss', 'file', 'gopher'])('%s', async scheme => {
    const calls: string[] = [];
    const paced: ImageBytesFetcher = async url => { calls.push(url); return { ok: false, reason: 'http-status', status: 302 } as ImageBytesResult; };
    const f = followAllowedRedirects(paced, { allowedHosts: [STATIC], locationOf: () => `${scheme}://${STATIC}/a.jpg` });
    expect(await f(U(1), {})).toMatchObject({ ok: false, reason: 'refused' });
    expect(calls).toEqual([U(1)]);
  });
});

describe('R2-S3 (unit): a stop reaches the DISPATCH of a request, including one already waiting for its pacing slot', () => {
  it('gateOnStop refuses once stopped, with the stop detail, and passes through before', async () => {
    let stop: string | undefined;
    const calls: string[] = [];
    const inner: ImageBytesFetcher = async url => { calls.push(url); return ok200(); };
    const gated = gateOnStop(inner, () => stop);
    expect(await gated(U(1), {})).toMatchObject({ ok: true });
    stop = 'interrupted by a signal';
    expect(await gated(U(2), {})).toMatchObject({ ok: false, reason: 'refused', detail: 'gallery driver stopped: interrupted by a signal' });
    expect(calls).toEqual([U(1)]);
  });

  it('a request that was waiting for its slot when the stop came is refused at dispatch, and the refusal is not an observation', async () => {
    const observer = createFetchObserver({ pauseAfter: 1, now: () => 0 });
    const calls: string[] = [];
    const limiter = new HostRateLimiter(imageHostRateFor({ IMAGE_HOST_RATE_JSON: JSON.stringify({ [STATIC]: { intervalMs: 1000 } }) }, noop));
    const sleeps: number[] = [];
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const paced = paceImageBytesByHost(gateOnStop(async url => { calls.push(url); return ok200(); }, observer.stopped), limiter, {
      now: () => 0, sleep: async ms => { sleeps.push(ms); await held; }, cooldown: { remaining: () => 0 }, hostClock: { floorFor: () => undefined, recordSend: () => undefined } as never,
    });
    const fetchBytes = observer.wrap(paced);
    // the first call books the host's slot; the second must wait for it
    const first = fetchBytes(U(1), {});
    await first;
    const second = fetchBytes(U(2), {});
    await new Promise(r => setImmediate(r));
    observer.stop('interrupted by a signal');
    release();
    expect(await second).toMatchObject({ ok: false, reason: 'refused', detail: expect.stringMatching(/gallery driver stopped/) });
    expect(calls).toEqual([U(1)]);
    expect(observer.take().map(o => o.url)).toEqual([U(1)]);
    expect(observer.tripped()).toBeUndefined();
  });

  it('the observer reports why it was stopped', () => {
    const observer = createFetchObserver({ pauseAfter: 3, now: () => 0 });
    expect(observer.stopped()).toBeUndefined();
    observer.stop('x');
    expect(observer.stopped()).toBe('x');
  });
});
