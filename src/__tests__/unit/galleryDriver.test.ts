/**
 * The GALLERY DRIVER (MFC-GALLERY-2): feeds an ordered work list of stored-page gallery urls through the SAME image
 * capture hook every other image takes, so the capture guards, the content-addressed raw original, the spine report
 * and the media derivative path all apply unchanged. What it adds is only WHICH urls, in what order, and when to stop:
 * a ledger so a restart fetches nothing twice, an auto-pause on the first sign of a block, a 20-file probe that proves
 * the host serves us cookie-less, and a refusal to start on a lane or policy that would not be the plain one.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HostRateLimiter } from '../../driver/hostRateLimiter';
import { CollectingCaptureSink } from '../../services/captureSink';
import { createHttpBytesFetch, type BytesResponseLike } from '../../services/images/httpBytesFetch';
import { paceImageBytesByHost } from '../../services/images/imageBytesPacing';
import { createImageBytesRouter, createImageCaptureHook } from '../../services/images/imageCaptureHook';
import { buildImageHostPolicy } from '../../services/images/imageHostPolicy';
import type { ImageBytesFetcher, ImageBytesResult } from '../../services/images/imageBytes';
import { imageHostRateFor } from '../../services/images/imageHostRates';
import {
  classifyObservation, createFetchObserver, createFileLedger, createMemoryLedger, createRecordingFetch, followAllowedRedirects, judgeProbe, normalizeHost, runGalleryCapture,
  type ConfirmingSink, type FetchObservation, type GalleryLedger, type GalleryRunOptions,
} from '../../services/images/galleryDriver';
import { parseWorklist, type WorklistItem } from '../../services/images/galleryWorklist';

const STATIC = 'static.myfigurecollection.net';
const U = (n: number | string) => `https://${STATIC}/upload/pictures/2022/10/14/${n}.jpeg`;
const PAGE = (id: string) => `https://myfigurecollection.net/item/${id}`;
const PNG = (n: number) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n, n, n]);
const POLICY = buildImageHostPolicy({ [STATIC]: { lane: 'http', egress: 'direct' } });

const item = (id: string, nums: number[], over: Partial<WorklistItem> = {}): WorklistItem => ({
  site: 'mfc', itemId: id, pageUrl: PAGE(id), rank: 0,
  entries: nums.map((n, i) => ({ position: i, src: U(n), w: 600, h: 600 })), ...over,
});
async function* feed(items: WorklistItem[], bad = 0) {
  for (let i = 0; i < bad; i++) yield { ok: false as const, line: i + 1, error: 'bad' };
  for (const it of items) yield { ok: true as const, item: it, dropped: 0 };
}
const ok200 = (n = 1): ImageBytesResult => ({ ok: true, bytes: PNG(n), contentType: 'image/png', status: 200, finalUrl: 'x', headers: {} });
const fail = (status: number, extra: Record<string, unknown> = {}): ImageBytesResult => ({ ok: false, reason: 'http-status', status, ...extra }) as ImageBytesResult;

/** A hook double that fetches every described ref through the (observed) fetcher, like the real hook's loop. */
function fakeHook(fetcher: ImageBytesFetcher, opts: { enabled?: boolean; failedPerCapture?: number } = {}) {
  const calls: Array<{ itemId: string; urls: string[]; positions: number[]; sourceClasses: unknown[]; contentLevels: unknown[]; origin: string }> = [];
  const counters = { failed: 0 };
  return {
    calls,
    hook: {
      async capture(req: { itemId: string; fields: Record<string, unknown>; ruleset: { describeImages?: (f: Record<string, unknown>) => Array<{ url: string; position: number; sourceClass?: unknown; contentLevel?: unknown }> }; origin: string }) {
        const refs = req.ruleset.describeImages!(req.fields);
        calls.push({ itemId: req.itemId, urls: refs.map(r => r.url), positions: refs.map(r => r.position), sourceClasses: refs.map(r => r.sourceClass), contentLevels: refs.map(r => r.contentLevel), origin: req.origin });
        for (const r of refs) await fetcher(r.url, {});
        counters.failed += opts.failedPerCapture ?? 0;
      },
      stats() {
        return { enabled: opts.enabled ?? true, attempted: 0, stored: 0, deduped: 0, failed: counters.failed, residentialBytesToday: 0, skipped: { sinkQueueFull: 0 } };
      },
    } as never,
  };
}

/** The key an item's files are settled under (`site/itemId`; the helper `item` below is site 'mfc'). */
const K = (id: string) => `mfc/${id}`;
const okSink = (): ConfirmingSink => ({ flush: async () => undefined, stats: () => ({ assetFailed: 0, dropped: 0, droppedBytes: 0, assetRefusedReserve: 0 }) });

const baseOpts = (over: Partial<GalleryRunOptions> = {}): GalleryRunOptions => ({ allowedHosts: [STATIC], pauseAfter: 3, pauseMs: 6 * 3600_000, ...over });
const noop = () => undefined;

function run(items: WorklistItem[], script: (url: string) => ImageBytesResult, opts: Partial<GalleryRunOptions> = {}, extra: { sink?: ConfirmingSink; ledger?: GalleryLedger; bad?: number; enabled?: boolean; failedPerCapture?: number; now?: () => number } = {}) {
  const observer = createFetchObserver({ pauseAfter: opts.pauseAfter ?? 3, now: extra.now ?? (() => 0) });
  const inner: ImageBytesFetcher = async url => script(url);
  const fh = fakeHook(observer.wrap(inner), { enabled: extra.enabled, failedPerCapture: extra.failedPerCapture });
  const ledger = extra.ledger ?? createMemoryLedger();
  const report = runGalleryCapture(
    { hook: fh.hook, sink: extra.sink ?? okSink(), observer, policy: POLICY, ledger, items: feed(items, extra.bad ?? 0), now: extra.now ?? (() => 0), log: noop, requests: () => [] },
    baseOpts(opts),
  );
  return { report, fh, ledger, observer };
}

describe('classifyObservation', () => {
  const o = (over: Partial<FetchObservation>): FetchObservation => ({ url: U(1), ok: false, ms: 1, ...over });
  it.each([
    ['a stored image', o({ ok: true, status: 200 }), 'ok'],
    ['403', o({ status: 403, reason: 'http-status' }), 'blocked'],
    ['429', o({ status: 429, reason: 'http-status' }), 'blocked'],
    ['503', o({ status: 503, reason: 'http-status' }), 'blocked'],
    ['a 2xx that is not an image (a challenge or an age gate has this shape)', o({ status: 200, reason: 'not-image' }), 'blocked'],
    ['a cloudflare mitigation header', o({ status: 403, reason: 'http-status', signals: { 'cf-mitigated': 'challenge' } }), 'blocked'],
    ['a host cooling from a challenge', o({ reason: 'refused' }), 'blocked'],
    ['404', o({ status: 404, reason: 'http-status' }), 'gone'],
    ['410', o({ status: 410, reason: 'http-status' }), 'gone'],
    ['a body over the cap', o({ reason: 'too-large' }), 'oversize'],
    ['a timeout', o({ reason: 'timeout' }), 'trouble'],
    ['a 500', o({ status: 500, reason: 'http-status' }), 'trouble'],
    ['an unsupported lane', o({ reason: 'unsupported' }), 'trouble'],
  ])('%s -> %s', (_label, obs, want) => {
    expect(classifyObservation(obs)).toBe(want);
  });
});

describe('createFetchObserver', () => {
  it('records every fetch with its outcome and hands them out once', async () => {
    const obs = createFetchObserver({ pauseAfter: 3, now: () => 5 });
    const f = obs.wrap(async url => (url.endsWith('1.jpeg') ? ok200() : fail(404)));
    await f(U(1), {});
    await f(U(2), {});
    const taken = obs.take();
    expect(taken.map(t => [t.url, t.ok, t.status])).toEqual([[U(1), true, 200], [U(2), false, 404]]);
    expect(obs.take()).toEqual([]);
  });

  it('trips after N consecutive blocked fetches, then refuses without touching the network', async () => {
    const inner = jest.fn(async () => fail(403));
    const obs = createFetchObserver({ pauseAfter: 3, now: () => 0 });
    const f = obs.wrap(inner);
    await f(U(1), {}); await f(U(2), {});
    expect(obs.tripped()).toBeUndefined();
    await f(U(3), {});
    expect(obs.tripped()).toMatch(/3 consecutive/);
    const after = await f(U(4), {});
    expect(after).toMatchObject({ ok: false, reason: 'refused' });
    expect(inner).toHaveBeenCalledTimes(3);
  });

  it('a success resets the streak; gone and oversize neither count nor reset it', async () => {
    const script: ImageBytesResult[] = [fail(403), fail(403), ok200(), fail(403), fail(404), { ok: false, reason: 'too-large' } as ImageBytesResult, fail(403)];
    const obs = createFetchObserver({ pauseAfter: 3, now: () => 0 });
    const f = obs.wrap(async () => script.shift()!);
    for (let i = 0; i < 7; i++) await f(U(i), {});
    expect(obs.tripped()).toBeUndefined(); // two blocks, a success, then 403 / [404, too-large ignored] / 403 is only two again
    await obs.wrap(async () => fail(429))(U(99), {});
    expect(obs.tripped()).toMatch(/3 consecutive/);
  });

  // S5: a dead or throttling origin is one streak, blocked or erring
  it.each([
    ['500s', () => fail(500)],
    ['502s', () => fail(502)],
    ['504s', () => fail(504)],
    ['timeouts', () => ({ ok: false, reason: 'timeout' }) as ImageBytesResult],
  ])('trips after N consecutive %s, exactly as a block does', async (_label, bad) => {
    const inner = jest.fn(async () => bad());
    const obs = createFetchObserver({ pauseAfter: 3, now: () => 0 });
    const f = obs.wrap(inner);
    await f(U(1), {}); await f(U(2), {});
    expect(obs.tripped()).toBeUndefined();
    await f(U(3), {});
    expect(obs.tripped()).toMatch(/3 consecutive blocked or failed/);
    expect(await f(U(4), {})).toMatchObject({ ok: false, reason: 'refused' });
    expect(inner).toHaveBeenCalledTimes(3);
  });

  it('mixed blocks and errors are one streak, and a success breaks it', async () => {
    const script: ImageBytesResult[] = [fail(429), fail(500), ok200(), fail(500), fail(403)];
    const obs = createFetchObserver({ pauseAfter: 3, now: () => 0 });
    const f = obs.wrap(async () => script.shift()!);
    for (let i = 0; i < 5; i++) await f(U(i), {});
    expect(obs.tripped()).toBeUndefined();
    await obs.wrap(async () => fail(503))(U(9), {});
    expect(obs.tripped()).toMatch(/3 consecutive/);
  });

  it('a thrown transport fault (a refused connection) counts too, and is still thrown', async () => {
    const obs = createFetchObserver({ pauseAfter: 2, now: () => 0 });
    const f = obs.wrap(async () => { throw new Error('ECONNREFUSED'); });
    await expect(f(U(1), {})).rejects.toThrow('ECONNREFUSED');
    await expect(f(U(2), {})).rejects.toThrow('ECONNREFUSED');
    expect(obs.tripped()).toMatch(/2 consecutive/);
    expect(obs.take().map(o => o.reason)).toEqual(['threw', 'threw']);
  });

  // S7: a stop is not a block and is not an observation
  it('stop() refuses every later call without touching the network, records nothing, and never opens the breaker', async () => {
    const inner = jest.fn(async () => ok200());
    const obs = createFetchObserver({ pauseAfter: 1, now: () => 0 });
    const f = obs.wrap(inner);
    await f(U(1), {});
    obs.stop('interrupted by a signal');
    expect(await f(U(2), {})).toMatchObject({ ok: false, reason: 'refused', detail: expect.stringMatching(/interrupted/) });
    expect(inner).toHaveBeenCalledTimes(1);
    expect(obs.take().length).toBe(1);
    expect(obs.tripped()).toBeUndefined();
  });
});

describe('the ledger', () => {
  it('remembers settled urls and a pause, in memory', () => {
    const l = createMemoryLedger();
    expect(l.has(K('1'), U(1))).toBe(false);
    l.settle(K('1'), U(1), 'stored');
    expect(l.has(K('1'), U(1))).toBe(true);
    expect(l.pausedUntil()).toBeUndefined();
    l.pause(1000, 'blocked');
    expect(l.pausedUntil()).toBe(1000);
    l.clearPause();
    expect(l.pausedUntil()).toBeUndefined();
  });

  // S1: a url settled for one item says nothing about another item that lists it
  it('settles per (item, url): the same url under another item is still to do', () => {
    const l = createMemoryLedger();
    l.settle(K('1'), U(1), 'stored');
    expect(l.has(K('2'), U(1))).toBe(false);
    expect(l.has(K('1'), U(2))).toBe(false);
  });

  it('is append-only JSONL on disk and a new process reads it back', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'gallery-ledger-'));
    try {
      const file = path.join(dir, 'ledger.jsonl');
      const a = createFileLedger(file);
      a.settle(K('1'), U(1), 'stored'); a.settle(K('1'), U(2), 'gone'); a.pause(9000, '3 consecutive blocked fetches');
      const b = createFileLedger(file);
      expect(b.has(K('1'), U(1))).toBe(true);
      expect(b.has(K('1'), U(2))).toBe(true);
      expect(b.has(K('1'), U(3))).toBe(false);
      expect(b.has(K('2'), U(1))).toBe(false);
      expect(b.pausedUntil()).toBe(9000);
      b.clearPause();
      expect(createFileLedger(file).pausedUntil()).toBeUndefined();
      expect(readFileSync(file, 'utf8').trim().split('\n').length).toBe(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores a torn or foreign line instead of failing the run', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'gallery-ledger-'));
    try {
      const file = path.join(dir, 'ledger.jsonl');
      writeFileSync(file, `{"i":"mfc/1","u":"${U(1)}","s":"stored"}\n{"i":"mfc/1","u":"${U(2)}","s":"sto\n[1,2]\n{"x":1}\n{"i":"mfc/1","u":"${U(3)}","s":"gone"}\n{"u":"${U(4)}","s":"stored"}\n`);
      const l = createFileLedger(file);
      // the url-only format of the first cut is skipped (fetched again; the store dedupes), a torn line too
      expect([l.has(K('1'), U(1)), l.has(K('1'), U(2)), l.has(K('1'), U(3)), l.has(K('1'), U(4))]).toEqual([true, false, true, false]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runGalleryCapture', () => {
  it('feeds items in file order, each url with its own position, as role-gallery refs carrying the item content level', async () => {
    const { report, fh } = run([item('1', [10, 11]), item('2', [20], { contentLevel: 'explicit' })], () => ok200());
    const r = await report;
    expect(fh.calls.map(c => [c.itemId, c.urls])).toEqual([['1', [U(10), U(11)]], ['2', [U(20)]]]);
    expect(fh.calls[0]!.positions).toEqual([0, 1]);
    expect(fh.calls[1]!.contentLevels).toEqual(['explicit']);
    expect(fh.calls[0]!.contentLevels).toEqual(['unknown', 'unknown']); // an item with NO level is gated, never defaulted to general
    expect(fh.calls[0]!.sourceClasses).toEqual(['unknown', 'unknown']);
    expect(fh.calls[0]!.origin).toBe('ingest');
    expect(r).toMatchObject({ stopped: 'done', items: 2, fetched: 3, stored: 3, blocked: 0 });
  });

  it('carries the configured source class', async () => {
    const { report, fh } = run([item('1', [1])], () => ok200(), { sourceClass: 'manufacturer_press' });
    await report;
    expect(fh.calls[0]!.sourceClasses).toEqual(['manufacturer_press']);
  });

  it('settles what was stored or is gone, and nothing else', async () => {
    const script = (u: string) => (u === U(1) ? ok200() : u === U(2) ? fail(404) : u === U(3) ? { ok: false, reason: 'too-large' } as ImageBytesResult : u === U(4) ? fail(500) : { ok: false, reason: 'timeout' } as ImageBytesResult);
    const { report, ledger } = run([item('1', [1, 2, 3, 4, 5])], script);
    const r = await report;
    expect([1, 2, 3, 4, 5].map(n => ledger.has(K('1'), U(n)))).toEqual([true, true, true, false, false]);
    expect(r).toMatchObject({ stored: 1, gone: 1, oversize: 1, trouble: 2, blocked: 0 });
  });

  it('skips settled urls on a later run and keeps the others at their original positions', async () => {
    const ledger = createMemoryLedger();
    ledger.settle(K('1'), U(10), 'stored');
    const { report, fh } = run([item('1', [10, 11, 12])], () => ok200(), {}, { ledger });
    const r = await report;
    expect(fh.calls[0]!.urls).toEqual([U(11), U(12)]);
    expect(fh.calls[0]!.positions).toEqual([1, 2]);
    expect(r.skippedLedger).toBe(1);
  });

  it('does not call the hook for an item whose urls are all settled', async () => {
    const ledger = createMemoryLedger();
    ledger.settle(K('1'), U(10), 'stored');
    const { report, fh } = run([item('1', [10])], () => ok200(), {}, { ledger });
    await report;
    expect(fh.calls).toEqual([]);
  });

  it('never fetches a host that is not allowed, and counts it', async () => {
    const it = item('1', [1]);
    it.entries.push({ position: 1, src: 'https://evil.example/a.jpg', w: null, h: null }, { position: 2, src: 'https://otakumode.com/a.jpg', w: null, h: null });
    const { report, fh } = run([it], () => ok200());
    const r = await report;
    expect(fh.calls[0]!.urls).toEqual([U(1)]);
    expect(r.notAllowedHost).toBe(2);
  });

  it('counts bad worklist lines and carries on', async () => {
    const { report } = run([item('1', [1])], () => ok200(), {}, { bad: 3 });
    expect(await report).toMatchObject({ badLines: 3, items: 1, stored: 1 });
  });

  it('stops after --max-files', async () => {
    const { report, fh } = run([item('1', [1, 2, 3]), item('2', [4, 5, 6])], () => ok200(), { maxFiles: 4 });
    const r = await report;
    expect(fh.calls.map(c => c.urls.length)).toEqual([3, 1]);
    expect(r).toMatchObject({ stopped: 'limit', fetched: 4 });
  });

  it('stops between items when the time budget is spent', async () => {
    let t = 0;
    const { report, fh } = run([item('1', [1]), item('2', [2]), item('3', [3])], () => { t += 40 * 60_000; return ok200(); }, { maxMs: 60 * 60_000 }, { now: () => t });
    const r = await report;
    expect(fh.calls.length).toBe(2);
    expect(r.stopped).toBe('time');
  });

  describe('auto-pause', () => {
    it('stops on N consecutive blocks, writes the pause marker and leaves the blocked urls unsettled', async () => {
      const ledger = createMemoryLedger();
      const { report, fh } = run([item('1', [1, 2, 3, 4]), item('2', [5])], () => fail(429), {}, { ledger, now: () => 1000 });
      const r = await report;
      expect(r.stopped).toBe('paused');
      expect(r.pauseReason).toMatch(/3 consecutive/);
      expect(r.pausedUntil).toBe(1000 + 6 * 3600_000);
      expect(ledger.pausedUntil()).toBe(1000 + 6 * 3600_000);
      expect(fh.calls.length).toBe(1);
      expect([1, 2, 3, 4].some(n => ledger.has(K('1'), U(n)))).toBe(false);
      expect(r.blocked).toBe(3);
    });

    it('refuses to start while a pause marker has not lapsed, and says until when', async () => {
      const ledger = createMemoryLedger();
      ledger.pause(5000, 'earlier block');
      const { report, fh } = run([item('1', [1])], () => ok200(), {}, { ledger, now: () => 100 });
      const r = await report;
      expect(r).toMatchObject({ stopped: 'paused-marker', pausedUntil: 5000 });
      expect(fh.calls).toEqual([]);
    });

    it('runs once the pause has lapsed, and clears the marker', async () => {
      const ledger = createMemoryLedger();
      ledger.pause(50, 'earlier block');
      const { report } = run([item('1', [1])], () => ok200(), {}, { ledger, now: () => 100 });
      expect((await report).stopped).toBe('done');
      expect(ledger.pausedUntil()).toBeUndefined();
    });

    it('--resume clears a live marker', async () => {
      const ledger = createMemoryLedger();
      ledger.pause(5000, 'earlier block');
      const { report } = run([item('1', [1])], () => ok200(), { resume: true }, { ledger, now: () => 100 });
      expect((await report).stopped).toBe('done');
      expect(ledger.pausedUntil()).toBeUndefined();
    });
  });

  describe('refusals', () => {
    it('refuses to run when the image lane is off (never fetch what would be dropped)', async () => {
      const { report, fh } = run([item('1', [1])], () => ok200(), {}, { enabled: false });
      expect(await report).toMatchObject({ stopped: 'refused' });
      expect(fh.calls).toEqual([]);
    });

    it.each([
      ['no row: the static host would inherit the store lane', buildImageHostPolicy({}), /lane/i],
      ['a browser row', buildImageHostPolicy({ [STATIC]: { lane: 'browser' } }), /http/i],
      // (an impit row with direct egress is a gallery lane since GAL-IMPIT: galleryImpitLane.test.ts)
      ['a residential row', buildImageHostPolicy({ [STATIC]: { lane: 'impit', egress: 'residential' } }), /direct|http/i],
    ])('refuses to start on %s', async (_label, policy, why) => {
      const observer = createFetchObserver({ pauseAfter: 3, now: () => 0 });
      const fh = fakeHook(observer.wrap(async () => ok200()));
      const r = await runGalleryCapture(
        { hook: fh.hook, sink: okSink(), observer, policy, ledger: createMemoryLedger(), items: feed([item('1', [1])]), now: () => 0, log: noop, requests: () => [] },
        baseOpts({ allowedHosts: [STATIC] }),
      );
      expect(r.stopped).toBe('refused');
      expect(r.refusal).toMatch(why);
      expect(fh.calls).toEqual([]);
    });

    it('--dry-run reads the list and the ledger and calls nothing', async () => {
      const { report, fh } = run([item('1', [1, 2])], () => ok200(), { dryRun: true });
      const r = await report;
      expect(fh.calls).toEqual([]);
      expect(r).toMatchObject({ stopped: 'done', items: 1, planned: 2, fetched: 0 });
    });
  });

  describe('a sink failure inside an item', () => {
    it('does not settle that item (it is re-driven), so a stored-but-lost file is never forgotten', async () => {
      const { report, ledger } = run([item('1', [1, 2])], () => ok200(), {}, { failedPerCapture: 1 });
      const r = await report;
      expect(ledger.has(K('1'), U(1))).toBe(false);
      expect(r.stored).toBe(0); // N4: stored counts files the store confirmed; this item's two were downloaded (fetched 2) and lost
      expect(r.fetched).toBe(2);
      expect(r.itemsWithFailures).toBe(1);
    });
  });
});

describe('judgeProbe', () => {
  const good = (n: number): FetchObservation => ({ url: U(n), ok: true, status: 200, contentType: 'image/jpeg', bytes: 1000, finalUrl: U(n), ms: 5 });
  const req = (over: Record<string, unknown> = {}) => ({ url: U(1), sentHeaderNames: ['accept', 'user-agent', 'referer'], status: 200, redirected: false, setCookie: false, cfMitigated: undefined, cfRay: undefined, ...over });

  it('passes when every request is a 200 image on the allowed host, no cookie was sent and nothing looks like a challenge', () => {
    const v = judgeProbe({ observations: [good(1), good(2)], requests: [req(), req({ url: U(2) })], allowedHosts: [STATIC], wanted: 2 });
    expect(v.verdict).toBe('PASS');
    expect(v.reasons).toEqual([]);
  });

  it.each([
    ['a cookie header was sent', { requests: [req({ sentHeaderNames: ['accept', 'cookie'] })] }, /cookie/i],
    ['an authorization header was sent', { requests: [req({ sentHeaderNames: ['authorization'] })] }, /authorization/i],
    ['the response was redirected', { requests: [req({ redirected: true })] }, /redirect/i],
    ['cloudflare mitigated', { requests: [req({ cfMitigated: 'challenge' })] }, /challenge|mitigat/i],
    ['a non-200 status', { observations: [{ url: U(1), ok: false, status: 403, reason: 'http-status', ms: 1 } as FetchObservation] }, /403|status/i],
    ['a 2xx that is not an image', { observations: [{ url: U(1), ok: false, status: 200, reason: 'not-image', contentType: 'text/html', ms: 1 } as FetchObservation] }, /not an image|html/i],
    ['bytes from another origin', { observations: [{ ...good(1), finalUrl: 'https://elsewhere.example/a.jpg' }] }, /another origin.*elsewhere\.example/i],
  ])('fails when %s', (_label, over, why) => {
    const v = judgeProbe({ observations: [good(1)], requests: [req()], allowedHosts: [STATIC], wanted: 1, ...over } as never);
    expect(v.verdict).toBe('FAIL');
    expect(v.reasons.join(' ')).toMatch(why);
  });

  it('is inconclusive with no observations, and passes with fewer than wanted only when the list ran out', () => {
    expect(judgeProbe({ observations: [], requests: [], allowedHosts: [STATIC], wanted: 20 }).verdict).toBe('INCONCLUSIVE');
    expect(judgeProbe({ observations: [good(1)], requests: [req()], allowedHosts: [STATIC], wanted: 20 }).verdict).toBe('INCONCLUSIVE');
    expect(judgeProbe({ observations: [good(1)], requests: [req()], allowedHosts: [STATIC], wanted: 20, exhausted: true }).verdict).toBe('PASS');
  });

  it('is inconclusive when it cannot show what was sent (a fetched file with no request record)', () => {
    const v = judgeProbe({ observations: [good(1), good(2)], requests: [req()], allowedHosts: [STATIC], wanted: 2 });
    expect(v.verdict).toBe('INCONCLUSIVE');
    expect(v.reasons.join(' ')).toMatch(/no request record/);
  });

  it('notes a Set-Cookie as information, not as a failure', () => {
    const v = judgeProbe({ observations: [good(1)], requests: [req({ setCookie: true })], allowedHosts: [STATIC], wanted: 1 });
    expect(v.verdict).toBe('PASS');
    expect(v.notes.join(' ')).toMatch(/set-cookie/i);
  });
});

describe('probe mode through the driver', () => {
  it('fetches only the first N files and reports a verdict with per-request evidence (header names, never values)', async () => {
    const observer = createFetchObserver({ pauseAfter: 3, now: () => 0 });
    const recorded: Array<{ url: string; sentHeaderNames: string[]; status: number; redirected: boolean; setCookie: boolean; cfMitigated?: string; cfRay?: string }> = [];
    const fh = fakeHook(observer.wrap(async url => { recorded.push({ url, sentHeaderNames: ['accept', 'user-agent', 'referer'], status: 200, redirected: false, setCookie: false }); return { ok: true, bytes: PNG(1), contentType: 'image/png', status: 200, finalUrl: url, headers: {} }; }));
    const many = Array.from({ length: 5 }, (_, i) => item(String(i + 1), [i * 10 + 1, i * 10 + 2, i * 10 + 3, i * 10 + 4]));
    const r = await runGalleryCapture(
      { hook: fh.hook, sink: okSink(), observer, policy: POLICY, ledger: createMemoryLedger(), items: feed(many), now: () => 0, log: noop, requests: () => recorded },
      baseOpts({ probe: 6 }),
    );
    expect(r.mode).toBe('probe');
    expect(r.fetched).toBe(6);
    expect(r.stopped).toBe('limit');
    expect(r.probe?.verdict).toBe('PASS');
    expect(JSON.stringify(r.probe)).not.toMatch(/cookie=|authorization:/i);
    expect(r.probe?.evidence.length).toBe(6);
  });

  it('a probe that meets a challenge ends FAIL and pauses', async () => {
    const observer = createFetchObserver({ pauseAfter: 3, now: () => 0 });
    const fh = fakeHook(observer.wrap(async () => fail(403, { signals: { 'cf-mitigated': 'challenge' } })));
    const r = await runGalleryCapture(
      { hook: fh.hook, sink: okSink(), observer, policy: POLICY, ledger: createMemoryLedger(), items: feed([item('1', [1, 2, 3, 4, 5])]), now: () => 0, log: noop, requests: () => [] },
      baseOpts({ probe: 20 }),
    );
    expect(r.probe?.verdict).toBe('FAIL');
    expect(r.stopped).toBe('paused');
  });

  it('a probe does not settle its files (a later real run still collects them through the normal path)', async () => {
    const ledger = createMemoryLedger();
    const observer = createFetchObserver({ pauseAfter: 3, now: () => 0 });
    const fh = fakeHook(observer.wrap(async url => ({ ok: true, bytes: PNG(2), contentType: 'image/png', status: 200, finalUrl: url, headers: {} })));
    await runGalleryCapture({ hook: fh.hook, sink: okSink(), observer, policy: POLICY, ledger, items: feed([item('1', [1, 2])]), now: () => 0, log: noop, requests: () => [] }, baseOpts({ probe: 2 }));
    expect(ledger.has(K('1'), U(1))).toBe(false);
  });
});

describe('the real hook underneath (the NORMAL process, not a shortcut)', () => {
  const NOW0 = 1_700_000_000_000;
  type Reply = { status: number; type?: string; body?: Buffer; headers?: Record<string, string> };
  function rig(opts: { respond?: (url: string, headers: Record<string, string>) => Reply; maxPerItem?: number } = {}) {
    const clock = { t: NOW0 };
    const sink = new CollectingCaptureSink();
    const sent: Array<{ url: string; headers: Record<string, string> }> = [];
    const respond: (url: string, headers: Record<string, string>) => Reply = opts.respond ?? ((url: string) => ({ status: 200, type: 'image/png', body: PNG(Number(/(\d+)\.jpeg/.exec(url)![1]) % 200) }));
    const recording = createRecordingFetch(async (url, init) => {
      sent.push({ url, headers: init.headers });
      const r = respond(url, init.headers);
      const body = r.body ?? Buffer.alloc(0);
      const headers = new Map<string, string>(Object.entries({ ...(r.type ? { 'content-type': r.type } : {}), ...(r.headers ?? {}) }));
      return { status: r.status, url, headers: { get: (n: string) => headers.get(n.toLowerCase()) ?? null }, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) } as BytesResponseLike;
    });
    const limiter = new HostRateLimiter(imageHostRateFor({ IMAGE_HOST_RATE_JSON: JSON.stringify({ [STATIC]: { intervalMs: 1000 } }) }, noop));
    const observer = createFetchObserver({ pauseAfter: 3, now: () => clock.t });
    const waits: number[] = [];
    const fetchBytes = observer.wrap(paceImageBytesByHost(
      createImageBytesRouter({ http: createHttpBytesFetch({ fetchImpl: recording.fetchImpl }) }), limiter,
      { now: () => clock.t, sleep: async ms => { waits.push(ms); clock.t += ms; }, cooldown: { remaining: () => 0 } },
    ));
    const hook = createImageCaptureHook({
      sink, policy: POLICY, fetchBytes, maxPerItem: opts.maxPerItem ?? 100, now: () => clock.t,
      warn: noop,
    });
    return { hook, observer, sink, sent, waits, recording, clock };
  }
  const go = (r: ReturnType<typeof rig>, items: WorklistItem[], o: Partial<GalleryRunOptions> = {}) =>
    runGalleryCapture({ hook: r.hook, sink: okSink(), observer: r.observer, policy: POLICY, ledger: createMemoryLedger(), items: feed(items), now: () => r.clock.t, log: noop, requests: () => r.recording.records }, baseOpts(o));

  it('stores every entry of a 16-photo gallery through the sink, each as a gallery depiction at its position of its item', async () => {
    const r = rig();
    const nums = Array.from({ length: 16 }, (_, i) => i + 1);
    const rep = await go(r, [item('1005999', nums, { contentLevel: 'general' })]);
    expect(rep).toMatchObject({ stopped: 'done', fetched: 16, stored: 16, blocked: 0 });
    expect(r.sink.captures.length).toBe(16);
    expect(r.sink.captures.every(c => c.lane === 'asset' && c.sha256.length === 64)).toBe(true);
    expect(r.sink.captures.map(x => x.position)).toEqual(nums.map((_, i) => i));
    expect(r.sink.captures.every(x => x.role === 'gallery' && x.sourceItem?.site === 'mfc' && x.sourceItem?.itemId === '1005999' && x.sourceUrl === PAGE('1005999') && x.contentLevel === 'general' && x.sourceClass === 'unknown')).toBe(true);
  });

  it('an item whose work list line has no content level is stored as unknown (the most restrictive), never general', async () => {
    const r = rig();
    await go(r, [item('77', [1, 2])]);
    expect(r.sink.captures.map(x => x.contentLevel)).toEqual(['unknown', 'unknown']);
  });

  it('sends no cookie and no authorization header, ever', async () => {
    const r = rig();
    await go(r, [item('1', [1, 2, 3])]);
    expect(r.sent.length).toBe(3);
    for (const s of r.sent) expect(Object.keys(s.headers).map(h => h.toLowerCase())).not.toEqual(expect.arrayContaining(['cookie']));
    for (const s of r.sent) expect(Object.keys(s.headers).map(h => h.toLowerCase())).not.toContain('authorization');
    expect(r.recording.records.every(x => !x.sentHeaderNames.includes('cookie'))).toBe(true);
  });

  it('paces the static host at the configured gap: one file per second, no speed-up', async () => {
    const r = rig();
    await go(r, [item('1', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])]);
    expect(r.waits).toEqual(Array(9).fill(1000));
  });

  it('runs every file through the normal guards: a 2xx HTML body is refused as not-an-image, not stored, and counted as a block', async () => {
    const r = rig({ respond: () => ({ status: 200, type: 'text/html', body: Buffer.from('<html>age gate</html>') }) });
    const rep = await go(r, [item('1', [1, 2, 3, 4])]);
    expect(r.sink.captures).toEqual([]);
    expect(rep).toMatchObject({ stored: 0, blocked: 3, stopped: 'paused' });
    expect(r.hook.stats().skipped.notImage).toBe(3);
  });

  it('refuses a body over the size cap and an SVG, and stores neither', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const r = rig({ respond: url => (url.includes('/1.jpeg') ? { status: 200, type: 'image/svg+xml', body: svg } : { status: 200, type: 'image/png', body: PNG(7) }) });
    const rep = await go(r, [item('1', [1, 2])]);
    expect(r.sink.captures.length).toBe(1);
    expect(rep.stored).toBe(1);
  });

  it('a 404 is gone and settled; a 429 is a block', async () => {
    const r = rig({ respond: url => (url.includes('/1.jpeg') ? { status: 404 } : { status: 200, type: 'image/png', body: PNG(9) }) });
    const rep = await go(r, [item('1', [1, 2])]);
    expect(rep).toMatchObject({ gone: 1, stored: 1 });
  });

  it('an item with more than the default 12 photos is not capped by this process', async () => {
    const r = rig();
    const rep = await go(r, [item('1', Array.from({ length: 40 }, (_, i) => i + 1))]);
    expect(rep.stored).toBe(40);
    expect(r.hook.stats().skipped.cap).toBe(0);
  });
});

describe('createRecordingFetch', () => {
  it('records header NAMES sent and the response signals, and passes the response through untouched', async () => {
    const rec = createRecordingFetch(async url => ({ status: 200, url: url + '?moved', headers: { get: (n: string) => ({ 'set-cookie': 'a=b; Path=/', 'cf-ray': 'abc-123', 'cf-mitigated': null } as Record<string, string | null>)[n.toLowerCase()] ?? null }, arrayBuffer: async () => new ArrayBuffer(0) }));
    const res = await rec.fetchImpl(U(1), { headers: { Accept: 'image/*', Cookie: 'sid=SECRETVALUE' } });
    expect(res.status).toBe(200);
    expect(rec.records).toEqual([{ url: U(1), lane: 'http', egress: 'direct', sentHeaderNames: ['accept', 'cookie'], status: 200, redirected: true, setCookie: true, cfMitigated: undefined, cfRay: 'abc-123' }]);
    expect(JSON.stringify(rec.records)).not.toContain('SECRETVALUE');
    expect(JSON.stringify(rec.records)).not.toContain('a=b');
  });
});

describe('the worklist helper stays in step with the driver', () => {
  it('a parsed list feeds straight in', async () => {
    const text = JSON.stringify({ site: 'mfc', itemId: '9', pageUrl: PAGE('9'), rank: 0, entries: [{ position: 0, src: U(9) }] }) + '\n';
    const parsed = parseWorklist(text);
    const { report } = run(parsed.items, () => ok200());
    expect((await report).stored).toBe(1);
  });
});

describe('B2 (unit): a file is settled only once the sink has confirmed its put', () => {
  /** A sink whose put outcomes the test scripts: `lose` moves its failure counter during the flush, as a failed put does. */
  const scripted = (lose: () => boolean) => {
    const c = { assetFailed: 0, dropped: 0, droppedBytes: 0, assetRefusedReserve: 0 };
    const calls: string[] = [];
    const sink: ConfirmingSink = { flush: async () => { calls.push('flush'); if (lose()) c.assetFailed += 1; }, stats: () => ({ ...c }) };
    return { sink, calls };
  };

  it('flushes the sink after each item and before anything is settled', async () => {
    const order: string[] = [];
    const ledger = createMemoryLedger();
    const settle = ledger.settle;
    ledger.settle = (i, u, h) => { order.push('settle'); settle(i, u, h); };
    const { sink } = scripted(() => false);
    const flush = sink.flush;
    sink.flush = async () => { order.push('flush'); await flush(); };
    await run([item('1', [1, 2]), item('2', [3])], () => ok200(), {}, { sink, ledger }).report;
    expect(order).toEqual(['flush', 'settle', 'settle', 'flush', 'settle']);
  });

  it.each([
    ['assetFailed', { assetFailed: 1 }],
    ['dropped', { dropped: 1 }],
    ['droppedBytes', { droppedBytes: 1 }],
    ['assetRefusedReserve', { assetRefusedReserve: 1 }],
  ])('a put lost to the sink (%s) leaves the whole item unsettled, counts it, and the next item is unaffected', async (_which, delta) => {
    const c = { assetFailed: 0, dropped: 0, droppedBytes: 0, assetRefusedReserve: 0 };
    let n = 0;
    const sink: ConfirmingSink = { flush: async () => { if (++n === 1) Object.assign(c, delta); }, stats: () => ({ ...c }) };
    const ledger = createMemoryLedger();
    const r = await run([item('1', [1, 2]), item('2', [3])], () => ok200(), {}, { sink, ledger }).report;
    expect([ledger.has(K('1'), U(1)), ledger.has(K('1'), U(2)), ledger.has(K('2'), U(3))]).toEqual([false, false, true]);
    // N4: stored is what the store confirmed (item 2's one file); the other two were downloaded and lost
    expect(r).toMatchObject({ itemsWithFailures: 1, stored: 1, fetched: 3 });
  });

  it('refuses to fetch at all when the sink cannot confirm a write (a dry run is left alone)', async () => {
    const observer = createFetchObserver({ pauseAfter: 3, now: () => 0 });
    const fh = fakeHook(observer.wrap(async () => ok200()));
    const deps = { hook: fh.hook, observer, policy: POLICY, ledger: createMemoryLedger(), items: feed([item('1', [1])]), now: () => 0, log: noop, requests: () => [] };
    const refused = await runGalleryCapture(deps, baseOpts());
    expect(refused).toMatchObject({ stopped: 'refused' });
    expect(refused.refusal).toMatch(/cannot confirm/);
    expect(fh.calls).toEqual([]);
    const dry = await runGalleryCapture({ ...deps, items: feed([item('1', [1])]) }, baseOpts({ dryRun: true }));
    expect(dry).toMatchObject({ stopped: 'done', planned: 1 });
  });

  it('a probe flushes too, and still settles nothing', async () => {
    const { sink, calls } = scripted(() => false);
    const ledger = createMemoryLedger();
    await run([item('1', [1, 2])], () => ok200(), { probe: 2 }, { sink, ledger }).report;
    expect(calls).toEqual(['flush']);
    expect(ledger.has(K('1'), U(1))).toBe(false);
  });
});

describe('S1 (unit): an unfetched file the memo explains is settled for its own item', () => {
  /** A hook that, like the real one, serves a url another item already fetched from its memo: no request, a `memo` skip. */
  function memoHook(observer: ReturnType<typeof createFetchObserver>, extraSkip?: string) {
    const fetched = new Set<string>();
    const skipped: Record<string, number> = { memo: 0, cap: 0, sinkQueueFull: 0 };
    const fetcher = observer.wrap(async () => ok200());
    return {
      async capture(req: { ruleset: { describeImages?: (f: Record<string, unknown>) => Array<{ url: string }> }; fields: Record<string, unknown> }) {
        for (const r of req.ruleset.describeImages!(req.fields)) {
          if (fetched.has(r.url)) { skipped.memo += 1; continue; }
          if (extraSkip !== undefined && r.url === extraSkip) { skipped.cap += 1; continue; }
          fetched.add(r.url);
          await fetcher(r.url, {});
        }
      },
      stats: () => ({ enabled: true, attempted: 0, stored: 0, deduped: 0, failed: 0, residentialBytesToday: 0, skipped: { ...skipped } }),
    } as never;
  }
  const feedAll = (items: WorklistItem[]) => feed(items);

  it('items sharing a picture are each settled for it, with one fetch', async () => {
    const observer = createFetchObserver({ pauseAfter: 3, now: () => 0 });
    const hook = memoHook(observer);
    const ledger = createMemoryLedger();
    const r = await runGalleryCapture({ hook, sink: okSink(), observer, policy: POLICY, ledger, items: feedAll([item('1', [1, 2]), item('2', [1]), item('3', [1, 3])]), now: () => 0, log: noop, requests: () => [] }, baseOpts());
    // fetched 3 files; stored counts the five (item, picture) pairs the store has now been told about and confirmed
    expect(r).toMatchObject({ fetched: 3, stored: 5, items: 3, planned: 5 });
    expect([ledger.has(K('1'), U(1)), ledger.has(K('2'), U(1)), ledger.has(K('3'), U(1)), ledger.has(K('3'), U(3))]).toEqual([true, true, true, true]);
  });

  it('a file left out for any other reason is not settled, and is planned again', async () => {
    const observer = createFetchObserver({ pauseAfter: 3, now: () => 0 });
    const hook = memoHook(observer, U(2));
    const ledger = createMemoryLedger();
    await runGalleryCapture({ hook, sink: okSink(), observer, policy: POLICY, ledger, items: feedAll([item('1', [1, 2])]), now: () => 0, log: noop, requests: () => [] }, baseOpts());
    expect([ledger.has(K('1'), U(1)), ledger.has(K('1'), U(2))]).toEqual([true, false]);
  });
});

describe('S2 (unit): the driver reports the entries the cap left out', () => {
  it('sums them, and names the item in the log', async () => {
    const logs: string[] = [];
    const observer = createFetchObserver({ pauseAfter: 3, now: () => 0 });
    const fh = fakeHook(observer.wrap(async () => ok200()));
    async function* withCap() {
      yield { ok: true as const, item: item('7', [1, 2]), dropped: 0, capped: 50 };
      yield { ok: true as const, item: item('8', [3]), dropped: 0, capped: 0 };
      yield { ok: true as const, item: item('9', [4]), dropped: 0, capped: 5 };
    }
    const r = await runGalleryCapture({ hook: fh.hook, sink: okSink(), observer, policy: POLICY, ledger: createMemoryLedger(), items: withCap(), now: () => 0, log: l => void logs.push(l), requests: () => [] }, baseOpts());
    expect(r.entriesCapped).toBe(55);
    expect(logs.filter(l => /over the .* cap left out/.test(l)).map(l => l.split(':')[0])).toEqual(['[gallery] mfc/7', '[gallery] mfc/9']);
  });
});

describe('S3 and M34 (unit): one spelling of a host and of a url', () => {
  it.each([['Static.Example.NET.', 'static.example.net'], [' static.example.net ', 'static.example.net'], ['static.example.net...', 'static.example.net']])('normalizeHost(%j)', (input, want) => {
    expect(normalizeHost(input)).toBe(want);
  });

  it('an allow-list entry and a url host are compared in the same spelling (a trailing dot on either)', async () => {
    const r = await run([item('1', [1])], () => ok200(), { allowedHosts: [`${STATIC}.`.toUpperCase()] }).report;
    expect(r).toMatchObject({ stored: 1, notAllowedHost: 0 });
    const dotted = item('2', [2]);
    dotted.entries[0]!.src = `https://${STATIC}./upload/pictures/2022/10/14/2.jpeg`;
    const r2 = await run([dotted], () => ok200()).report;
    expect(r2).toMatchObject({ stored: 1, notAllowedHost: 0 });
  });

  it('judgeProbe takes a trailing-dot allow-list entry for the same host', () => {
    const o: FetchObservation = { url: U(1), ok: true, status: 200, contentType: 'image/jpeg', bytes: 10, finalUrl: U(1), ms: 1 };
    const req = { url: U(1), sentHeaderNames: ['accept'], status: 200, redirected: false, setCookie: false };
    expect(judgeProbe({ observations: [o], requests: [req], allowedHosts: [`${STATIC}.`], wanted: 1 }).verdict).toBe('PASS');
  });
});

describe('M03 (unit): a cloudflare mitigation is a block whatever the status', () => {
  it.each([401, 403, 500, 502, 503])('status %i with cf-mitigated', status => {
    expect(classifyObservation({ url: U(1), ok: false, status, reason: 'http-status', signals: { 'cf-mitigated': 'challenge' }, ms: 1 })).toBe('blocked');
  });
});

describe('S7 (unit): an abort stops the run and says so', () => {
  it('an abort before the next item stops there: later items are not started, the interrupted one is settled for what it confirmed', async () => {
    const ac = new AbortController();
    const observer = createFetchObserver({ pauseAfter: 3, now: () => 0 });
    const fh = fakeHook(observer.wrap(async () => { ac.abort(); return ok200(); }));
    const ledger = createMemoryLedger();
    const r = await runGalleryCapture(
      { hook: fh.hook, sink: okSink(), observer, policy: POLICY, ledger, items: feed([item('1', [1, 2]), item('2', [3])]), now: () => 0, log: noop, requests: () => [] },
      baseOpts({ signal: ac.signal }),
    );
    expect(r.stopped).toBe('interrupted');
    expect(fh.calls.map(c => c.itemId)).toEqual(['1']);
    // the first file was fetched before the stop; the second was refused by the stopped observer, never requested
    expect([ledger.has(K('1'), U(1)), ledger.has(K('1'), U(2)), ledger.has(K('2'), U(3))]).toEqual([true, false, false]);
    expect(r.fetched).toBe(1);
  });

  it('an abort that has already happened refuses the first item and fetches nothing', async () => {
    const ac = new AbortController();
    ac.abort();
    const { report, fh } = run([item('1', [1])], () => ok200(), { signal: ac.signal });
    expect((await report).stopped).toBe('interrupted');
    expect(fh.calls).toEqual([]);
  });
});

describe('B1 (unit): followAllowedRedirects', () => {
  const OK = (url: string): ImageBytesResult => ({ ok: true, bytes: PNG(1), contentType: 'image/png', status: 200, finalUrl: url, headers: {} });
  const redirect = (status = 302): ImageBytesResult => ({ ok: false, reason: 'http-status', status }) as ImageBytesResult;
  /** A paced fetcher over a script of url -> result, remembering the options each call got. */
  function over(script: Record<string, ImageBytesResult>, locations: Record<string, string> = {}, allowed: string[] = [STATIC, 'other.example']) {
    const calls: Array<{ url: string; referer?: string }> = [];
    const paced: ImageBytesFetcher = async (url, o) => { calls.push({ url, ...(o?.referer !== undefined ? { referer: o.referer } : {}) }); return script[url] ?? ({ ok: false, reason: 'http-status', status: 404 } as ImageBytesResult); };
    const taken = { ...locations };
    return { calls, fetcher: followAllowedRedirects(paced, { allowedHosts: allowed, locationOf: u => { const l = taken[u]; delete taken[u]; return l; } }) };
  }

  it('passes a plain 200 through, and a non-redirect failure untouched', async () => {
    const a = over({ [U(1)]: OK(U(1)) });
    expect(await a.fetcher(U(1), {})).toMatchObject({ ok: true });
    const b = over({ [U(2)]: { ok: false, reason: 'http-status', status: 403 } as ImageBytesResult });
    expect(await b.fetcher(U(2), {})).toMatchObject({ ok: false, status: 403 });
  });

  it('follows a same-host hop, paced as a call of its own', async () => {
    const a = over({ [U(1)]: redirect(301), [U(2)]: OK(U(2)) }, { [U(1)]: U(2) });
    expect(await a.fetcher(U(1), { referer: 'https://page.example/item/1' })).toMatchObject({ ok: true, finalUrl: U(2) });
    expect(a.calls.map(c => c.url)).toEqual([U(1), U(2)]);
    expect(a.calls[1]!.referer).toBe('https://page.example/item/1');
  });

  it('refuses a hop to a host outside the allow-list before any request is sent to it', async () => {
    const a = over({ [U(1)]: redirect(302) }, { [U(1)]: 'http://127.0.0.1:9/stolen.jpg' });
    expect(await a.fetcher(U(1), {})).toMatchObject({ ok: false, reason: 'refused', detail: expect.stringMatching(/127\.0\.0\.1.*outside the allow-list/) });
    expect(a.calls.length).toBe(1);
  });

  it.each([['a non-http scheme', 'ftp://static.example/a.jpg'], ['an unparseable Location', 'http://']])('refuses %s', async (_why, location) => {
    const a = over({ [U(1)]: redirect(307) }, { [U(1)]: location });
    expect(await a.fetcher(U(1), {})).toMatchObject({ ok: false, reason: 'refused' });
    expect(a.calls.length).toBe(1);
  });

  it('a hop to ANOTHER allowed origin is followed and carries no Referer', async () => {
    const other = 'https://other.example/a.jpg';
    const a = over({ [U(1)]: redirect(302), [other]: OK(other) }, { [U(1)]: other });
    expect(await a.fetcher(U(1), { referer: 'https://page.example/item/1' })).toMatchObject({ ok: true });
    expect(a.calls[0]!.referer).toBe('https://page.example/item/1');
    expect(a.calls[1]!.referer).toBeUndefined();
  });

  it('a redirect with no Location is the ordinary non-2xx it always was', async () => {
    const a = over({ [U(1)]: redirect(302) });
    expect(await a.fetcher(U(1), {})).toMatchObject({ ok: false, reason: 'http-status', status: 302 });
  });

  it('gives up after the hop limit', async () => {
    const script: Record<string, ImageBytesResult> = {};
    const loc: Record<string, string> = {};
    for (let i = 1; i <= 12; i++) { script[U(i)] = redirect(302); loc[U(i)] = U(i + 1); }
    const a = over(script, loc);
    expect(await a.fetcher(U(1), {})).toMatchObject({ ok: false, reason: 'refused', detail: expect.stringMatching(/more than 5 redirects/) });
    expect(a.calls.length).toBe(6);
  });

  it('refuses bytes whose final url is off the list even when no redirect was seen (defence in depth)', async () => {
    const a = over({ [U(1)]: OK('https://elsewhere.example/x.jpg') });
    expect(await a.fetcher(U(1), {})).toMatchObject({ ok: false, reason: 'refused', detail: expect.stringMatching(/elsewhere\.example.*outside the allow-list/) });
  });
});

describe('B1 (unit): the recording transport never lets the runtime follow a redirect', () => {
  it('asks for redirect: manual, keeps each 3xx Location once, and counts a 3xx as redirected', async () => {
    const seen: Array<string | undefined> = [];
    const rec = createRecordingFetch(async (url, init) => {
      seen.push(init.redirect);
      return { status: 302, url, headers: { get: (n: string) => (n.toLowerCase() === 'location' ? '/moved/a.jpg' : null) }, arrayBuffer: async () => new ArrayBuffer(0) };
    });
    await rec.fetchImpl(U(1), { headers: {} });
    expect(seen).toEqual(['manual']);
    expect(rec.records[0]).toMatchObject({ status: 302, redirected: true });
    expect(rec.takeLocation(U(1))).toBe(`https://${STATIC}/moved/a.jpg`);
    expect(rec.takeLocation(U(1))).toBeUndefined();
  });
});
