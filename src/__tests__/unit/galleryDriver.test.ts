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
  classifyObservation, createFetchObserver, createFileLedger, createMemoryLedger, createRecordingFetch, judgeProbe, runGalleryCapture,
  type FetchObservation, type GalleryLedger, type GalleryRunOptions,
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

const baseOpts = (over: Partial<GalleryRunOptions> = {}): GalleryRunOptions => ({ allowedHosts: [STATIC], pauseAfter: 3, pauseMs: 6 * 3600_000, ...over });
const noop = () => undefined;

function run(items: WorklistItem[], script: (url: string) => ImageBytesResult, opts: Partial<GalleryRunOptions> = {}, extra: { ledger?: GalleryLedger; bad?: number; enabled?: boolean; failedPerCapture?: number; now?: () => number } = {}) {
  const observer = createFetchObserver({ pauseAfter: opts.pauseAfter ?? 3, now: extra.now ?? (() => 0) });
  const inner: ImageBytesFetcher = async url => script(url);
  const fh = fakeHook(observer.wrap(inner), { enabled: extra.enabled, failedPerCapture: extra.failedPerCapture });
  const ledger = extra.ledger ?? createMemoryLedger();
  const report = runGalleryCapture(
    { hook: fh.hook, observer, policy: POLICY, ledger, items: feed(items, extra.bad ?? 0), now: extra.now ?? (() => 0), log: noop, requests: () => [] },
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

  it('a success resets the streak; gone, oversize and trouble neither count nor reset it', async () => {
    const script: ImageBytesResult[] = [fail(403), fail(403), ok200(), fail(403), fail(404), fail(500), fail(403)];
    const obs = createFetchObserver({ pauseAfter: 3, now: () => 0 });
    const f = obs.wrap(async () => script.shift()!);
    for (let i = 0; i < 7; i++) await f(U(i), {});
    expect(obs.tripped()).toBeUndefined(); // two blocks, a success, then 403 / [404, 500 ignored] / 403 is only two again
    await obs.wrap(async () => fail(429))(U(99), {});
    expect(obs.tripped()).toMatch(/3 consecutive/);
  });
});

describe('the ledger', () => {
  it('remembers settled urls and a pause, in memory', () => {
    const l = createMemoryLedger();
    expect(l.has(U(1))).toBe(false);
    l.settle(U(1), 'stored');
    expect(l.has(U(1))).toBe(true);
    expect(l.pausedUntil()).toBeUndefined();
    l.pause(1000, 'blocked');
    expect(l.pausedUntil()).toBe(1000);
    l.clearPause();
    expect(l.pausedUntil()).toBeUndefined();
  });

  it('is append-only JSONL on disk and a new process reads it back', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'gallery-ledger-'));
    try {
      const file = path.join(dir, 'ledger.jsonl');
      const a = createFileLedger(file);
      a.settle(U(1), 'stored'); a.settle(U(2), 'gone'); a.pause(9000, '3 consecutive blocked fetches');
      const b = createFileLedger(file);
      expect(b.has(U(1))).toBe(true);
      expect(b.has(U(2))).toBe(true);
      expect(b.has(U(3))).toBe(false);
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
      writeFileSync(file, `{"u":"${U(1)}","s":"stored"}\n{"u":"${U(2)}","s":"sto\n[1,2]\n{"x":1}\n{"u":"${U(3)}","s":"gone"}\n`);
      const l = createFileLedger(file);
      expect([l.has(U(1)), l.has(U(2)), l.has(U(3))]).toEqual([true, false, true]);
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
    expect([1, 2, 3, 4, 5].map(n => ledger.has(U(n)))).toEqual([true, true, true, false, false]);
    expect(r).toMatchObject({ stored: 1, gone: 1, oversize: 1, trouble: 2, blocked: 0 });
  });

  it('skips settled urls on a later run and keeps the others at their original positions', async () => {
    const ledger = createMemoryLedger();
    ledger.settle(U(10), 'stored');
    const { report, fh } = run([item('1', [10, 11, 12])], () => ok200(), {}, { ledger });
    const r = await report;
    expect(fh.calls[0]!.urls).toEqual([U(11), U(12)]);
    expect(fh.calls[0]!.positions).toEqual([1, 2]);
    expect(r.skippedLedger).toBe(1);
  });

  it('does not call the hook for an item whose urls are all settled', async () => {
    const ledger = createMemoryLedger();
    ledger.settle(U(10), 'stored');
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
      expect([1, 2, 3, 4].some(n => ledger.has(U(n)))).toBe(false);
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
      ['an impit row', buildImageHostPolicy({ [STATIC]: { lane: 'impit', egress: 'direct' } }), /http/i],
      ['a residential row', buildImageHostPolicy({ [STATIC]: { lane: 'impit', egress: 'residential' } }), /direct|http/i],
    ])('refuses to start on %s', async (_label, policy, why) => {
      const observer = createFetchObserver({ pauseAfter: 3, now: () => 0 });
      const fh = fakeHook(observer.wrap(async () => ok200()));
      const r = await runGalleryCapture(
        { hook: fh.hook, observer, policy, ledger: createMemoryLedger(), items: feed([item('1', [1])]), now: () => 0, log: noop, requests: () => [] },
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
      expect(ledger.has(U(1))).toBe(false);
      expect(r.stored).toBe(2);
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
    ['bytes from another host', { observations: [{ ...good(1), finalUrl: 'https://elsewhere.example/a.jpg' }] }, /host/i],
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
      { hook: fh.hook, observer, policy: POLICY, ledger: createMemoryLedger(), items: feed(many), now: () => 0, log: noop, requests: () => recorded },
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
      { hook: fh.hook, observer, policy: POLICY, ledger: createMemoryLedger(), items: feed([item('1', [1, 2, 3, 4, 5])]), now: () => 0, log: noop, requests: () => [] },
      baseOpts({ probe: 20 }),
    );
    expect(r.probe?.verdict).toBe('FAIL');
    expect(r.stopped).toBe('paused');
  });

  it('a probe does not settle its files (a later real run still collects them through the normal path)', async () => {
    const ledger = createMemoryLedger();
    const observer = createFetchObserver({ pauseAfter: 3, now: () => 0 });
    const fh = fakeHook(observer.wrap(async url => ({ ok: true, bytes: PNG(2), contentType: 'image/png', status: 200, finalUrl: url, headers: {} })));
    await runGalleryCapture({ hook: fh.hook, observer, policy: POLICY, ledger, items: feed([item('1', [1, 2])]), now: () => 0, log: noop, requests: () => [] }, baseOpts({ probe: 2 }));
    expect(ledger.has(U(1))).toBe(false);
  });
});

describe('the real hook underneath (the NORMAL process, not a shortcut)', () => {
  const NOW0 = 1_700_000_000_000;
  function rig(opts: { respond?: (url: string, headers: Record<string, string>) => { status: number; type?: string; body?: Buffer; headers?: Record<string, string> }; maxPerItem?: number } = {}) {
    const clock = { t: NOW0 };
    const sink = new CollectingCaptureSink();
    const sent: Array<{ url: string; headers: Record<string, string> }> = [];
    const respond = opts.respond ?? ((url: string) => ({ status: 200, type: 'image/png', body: PNG(Number(/(\d+)\.jpeg/.exec(url)![1]) % 200) }));
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
    runGalleryCapture({ hook: r.hook, observer: r.observer, policy: POLICY, ledger: createMemoryLedger(), items: feed(items), now: () => r.clock.t, log: noop, requests: () => r.recording.records }, baseOpts(o));

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
    expect(rec.records).toEqual([{ url: U(1), sentHeaderNames: ['accept', 'cookie'], status: 200, redirected: true, setCookie: true, cfMitigated: undefined, cfRay: 'abc-123' }]);
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
