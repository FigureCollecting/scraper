/**
 * The IMAGE CAPTURE HOOK — the seam where an extraction that already succeeded turns into stored
 * originals, and the several ways it declines to.
 *
 * Two properties are load-bearing, and most of what follows tests one of them:
 *
 *   1. it is BEST-EFFORT. The item's fate was decided before this ran. A CDN that 403s, a fetcher
 *      that throws, a sink that is down, a ruleset whose describeImages is broken — none of it may
 *      reach the item, because an item that extracted fine did extract fine.
 *   2. it declines LOUDLY. Every refusal lands in a named counter, because the failure mode of a
 *      best-effort lane is silence: an image lane that stores nothing at all looks exactly like an
 *      idle one until somebody asks why the bucket is empty.
 */
import { createImageCaptureHook } from '../../services/images/imageCaptureHook';
import { buildImageHostPolicy } from '../../services/images/imageHostPolicy';
import { CollectingCaptureSink, type RawCapture } from '../../services/captureSink';
import type { ImageBytesFetcher, ImageBytesResult, ImageFetchOptions } from '../../services/images/imageBytes';
import type { ImageFetchPlan } from '../../services/images/imageCaptureHook';
import type { FetchFailureReport } from '../../services/failureReporter';
import type { ExtractionRuleset, ImageRef, SearchFetch } from '@figurecollecting/scraper-plugin-contract';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const OTHER_PNG = Buffer.concat([PNG, Buffer.from([9, 9, 9])]);
const PAGE = 'https://store.test/products/lucy';

const okBytes = (bytes: Buffer = PNG, finalUrl = 'https://cdn.test/a.jpg'): ImageBytesResult => ({
  ok: true,
  bytes,
  contentType: 'image/png',
  status: 200,
  finalUrl,
  headers: {},
});

/** A ruleset that describes exactly the refs it was built with — the private field shapes stay private. */
function rulesetDescribing(refs: ImageRef[] | (() => ImageRef[])): Pick<ExtractionRuleset, 'describeImages'> {
  return { describeImages: () => (typeof refs === 'function' ? refs() : refs) };
}

const gallery = (url: string, position = 0): ImageRef => ({ url, role: 'gallery', position });

interface HookHarness {
  sink: CollectingCaptureSink;
  calls: Array<{ url: string; plan: ImageFetchPlan }>;
  reports: FetchFailureReport[];
  warnings: string[];
  hook: ReturnType<typeof createImageCaptureHook>;
  clock: { now: number };
}

function harness(options: {
  fetch?: ImageBytesFetcher;
  policy?: Parameters<typeof buildImageHostPolicy>[0];
  maxPerItem?: number;
  memoSize?: number;
  residentialBytesPerDay?: number;
  enabled?: boolean;
} = {}): HookHarness {
  const sink = new CollectingCaptureSink();
  const calls: Array<{ url: string; plan: ImageFetchPlan }> = [];
  const reports: FetchFailureReport[] = [];
  const warnings: string[] = [];
  const clock = { now: 1_000_000 };
  const fetchBytes: ImageBytesFetcher = async (url: string, opts?: ImageFetchOptions) => {
    calls.push({ url, plan: opts as ImageFetchPlan });
    return (options.fetch ?? (async () => okBytes()))(url, opts);
  };
  const hook = createImageCaptureHook({
    sink,
    policy: buildImageHostPolicy(options.policy ?? {}),
    fetchBytes,
    proxyUrlFor: () => 'http://proxy.test:1080',
    reportFailure: async (report: FetchFailureReport) => void reports.push(report),
    warn: (message: string) => void warnings.push(message),
    now: () => clock.now,
    enabled: options.enabled ?? true,
    maxPerItem: options.maxPerItem ?? 12,
    memoSize: options.memoSize ?? 50_000,
    residentialBytesPerDay: options.residentialBytesPerDay ?? 1024 * 1024 * 1024,
  });
  return { sink, calls, reports, warnings, hook, clock };
}

const capture = (
  h: HookHarness,
  ruleset: Pick<ExtractionRuleset, 'describeImages'>,
  searchFetch?: SearchFetch,
): Promise<void> =>
  h.hook.capture({ site: 'examplestore', itemId: 'lucy-1', pageUrl: PAGE, fields: {}, ruleset, searchFetch, origin: 'ingest' });

describe('the image capture hook', () => {
  describe('when it does nothing at all', () => {
    it('is inert while PERSIST_RAW_IMAGES is off', async () => {
      const h = harness({ enabled: false });
      await capture(h, rulesetDescribing([gallery('https://cdn.test/a.jpg')]));
      expect(h.calls).toHaveLength(0);
      expect(h.hook.stats().enabled).toBe(false);
    });

    it('captures nothing for a ruleset that does not describe its images', async () => {
      const h = harness();
      await capture(h, {});
      expect(h.calls).toHaveLength(0);
      expect(h.hook.stats().attempted).toBe(0);
    });

    it('captures nothing for an item that has no images', async () => {
      const h = harness();
      await capture(h, rulesetDescribing([]));
      expect(h.calls).toHaveLength(0);
    });
  });

  describe('the happy path', () => {
    it('stores every gallery plate with the provenance that says where it came from', async () => {
      const h = harness({ fetch: async (url: string) => okBytes(url.endsWith('b.jpg') ? OTHER_PNG : PNG, url) });
      await capture(h, rulesetDescribing([gallery('https://cdn.test/a.jpg', 0), gallery('/img/b.jpg', 1)]));

      expect(h.calls.map(c => c.url)).toEqual(['https://cdn.test/a.jpg', 'https://store.test/img/b.jpg']);
      expect(h.sink.captures).toHaveLength(2);
      const [first] = h.sink.captures as RawCapture[];
      expect(first.lane).toBe('asset');
      expect(first.sourceItem).toEqual({ site: 'examplestore', itemId: 'lucy-1' });
      expect(first.sourceUrl).toBe(PAGE);
      expect(first.position).toBe(0);
      expect(first.role).toBe('gallery');
      expect(first.bytes).toEqual(PNG);
      expect(h.hook.stats()).toMatchObject({ enabled: true, attempted: 2, stored: 2, failed: 0, deduped: 0 });
    });

    it('sends the page as Referer and the policy user agent', async () => {
      const h = harness({ policy: { 'cdn.test': { lane: 'impit', ua: 'chrome' } } });
      await capture(h, rulesetDescribing([gallery('https://cdn.test/a.jpg')]));
      expect(h.calls[0].plan.referer).toBe(PAGE);
      expect(h.calls[0].plan.lane).toBe('impit');
      expect(h.calls[0].plan.userAgent).toMatch(/Chrome\/\d+/);
    });

    it('hands the browser lane the STORE host and the store gate, not the CDN host', async () => {
      // The gated browser is keyed on the store whose clearance it holds; the image lives elsewhere.
      const h = harness({ policy: { 'cdn.test': { lane: 'browser' } } });
      await capture(h, rulesetDescribing([gallery('https://cdn.test/a.jpg')]), { transport: 'browser', access: 'cloudflare' });
      expect(h.calls[0].plan).toMatchObject({ lane: 'browser', storeHost: 'store.test', challengeGated: true });
    });
  });

  describe('what it refuses to fetch', () => {
    it('never fetches a thumbnail or a user upload', async () => {
      const h = harness();
      await capture(
        h,
        rulesetDescribing([
          { url: 'https://cdn.test/t.jpg', role: 'thumbnail', position: 0 },
          { url: 'https://cdn.test/u.jpg', role: 'user', position: 1 },
          gallery('https://cdn.test/g.jpg', 2),
        ]),
      );
      expect(h.calls.map(c => c.url)).toEqual(['https://cdn.test/g.jpg']);
      expect(h.hook.stats().skipped).toMatchObject({ thumbnailRole: 1, userRole: 1 });
    });

    it('stops at the per-item ceiling', async () => {
      const h = harness({ maxPerItem: 3, fetch: async (url: string) => okBytes(Buffer.from(url), url) });
      await capture(h, rulesetDescribing(Array.from({ length: 10 }, (_, i) => gallery(`https://cdn.test/${i}.jpg`, i))));
      expect(h.calls).toHaveLength(3);
      expect(h.hook.stats().skipped.cap).toBe(7);
    });

    it('never fetches a permanently banned host, whatever the table says', async () => {
      const h = harness({ policy: { 'img.otakumode.com': { lane: 'http' } } });
      await capture(h, rulesetDescribing([gallery('https://img.otakumode.com/a.jpg')]));
      expect(h.calls).toHaveLength(0);
      expect(h.hook.stats().skipped.policyDeny).toBe(1);
    });

    it('counts a lane the policy cannot serve as a refusal, not a failure', async () => {
      // Plain HTTP cannot proxy, so http + residential has no transport at all.
      const h = harness({ policy: { 'cdn.test': { lane: 'http', egress: 'residential' } } });
      await capture(h, rulesetDescribing([gallery('https://cdn.test/a.jpg')]));
      expect(h.calls).toHaveLength(0);
      expect(h.hook.stats()).toMatchObject({ failed: 0, skipped: expect.objectContaining({ policyDeny: 1 }) });
    });
  });

  describe('the redirect guard', () => {
    // `chooseImageLane` only ever saw the url that was REQUESTED, and every lane follows redirects.
    // So the decision is re-asserted on the url the bytes actually came from — otherwise an allowed
    // CDN answering a 302 delivers a banned host's bytes, or carries a residential fetch off the
    // store whose home line it is spending.
    const allowFinalUrl = async (options: { policy?: Parameters<typeof buildImageHostPolicy>[0] } = {}) => {
      const h = harness(options);
      await capture(h, rulesetDescribing([gallery('https://cdn.test/a.jpg')]));
      return h.calls[0].plan.allowFinalUrl as (finalUrl: string) => boolean;
    };

    it('accepts bytes that came from an allowed host', async () => {
      expect((await allowFinalUrl())('https://cdn.test/redirected.jpg')).toBe(true);
    });

    it('refuses bytes a redirect fetched from the permanently banned host', async () => {
      expect((await allowFinalUrl())('https://img.otakumode.com/a.jpg')).toBe(false);
    });

    it('refuses bytes that carried a residential fetch off the declaring store', async () => {
      const guard = await allowFinalUrl({ policy: { 'cdn.test': { lane: 'impit', egress: 'residential' } } });
      expect(guard('https://store.test/img/a.jpg')).toBe(true);
      expect(guard('https://elsewhere.test/img/a.jpg')).toBe(false);
    });
  });

  describe('the memo', () => {
    it('does not re-fetch a url it already has', async () => {
      const h = harness();
      const ruleset = rulesetDescribing([gallery('https://cdn.test/a.jpg')]);
      await capture(h, ruleset);
      await capture(h, ruleset);
      expect(h.calls).toHaveLength(1);
      expect(h.hook.stats()).toMatchObject({ attempted: 1, stored: 1, skipped: expect.objectContaining({ memo: 1 }) });
    });

    it('recognizes bytes it already stored arriving under a second url', async () => {
      const h = harness({ fetch: async (url: string) => okBytes(PNG, url) });
      await capture(h, rulesetDescribing([gallery('https://cdn.test/a.jpg?v=1', 0), gallery('https://cdn.test/a.jpg?v=2', 1)]));
      expect(h.calls).toHaveLength(2);
      expect(h.sink.captures).toHaveLength(1);
      expect(h.hook.stats()).toMatchObject({ stored: 1, deduped: 1 });
    });

    it('re-fetches once the memo has forgotten', async () => {
      const h = harness({ memoSize: 1, fetch: async (url: string) => okBytes(Buffer.from(url), url) });
      await capture(h, rulesetDescribing([gallery('https://cdn.test/a.jpg', 0), gallery('https://cdn.test/b.jpg', 1)]));
      await capture(h, rulesetDescribing([gallery('https://cdn.test/a.jpg', 0)]));
      expect(h.calls).toHaveLength(3);
    });
  });

  describe('the residential budget', () => {
    const residential = { 'cdn.test': { lane: 'impit' as const, egress: 'residential' as const } };

    it('spends the home line and books what it spent', async () => {
      const h = harness({ policy: residential });
      await capture(h, rulesetDescribing([gallery('https://cdn.test/a.jpg')]));
      expect(h.calls[0].plan).toMatchObject({ egress: 'residential', proxyUrl: 'http://proxy.test:1080' });
      expect(h.hook.stats().residentialBytesToday).toBe(PNG.length);
    });

    it('stops fetching residentially once the day is spent, without failing the item', async () => {
      const h = harness({ policy: residential, residentialBytesPerDay: PNG.length, fetch: async (url: string) => okBytes(Buffer.from(url), url) });
      await capture(h, rulesetDescribing([gallery('https://cdn.test/a.jpg', 0), gallery('https://cdn.test/b.jpg', 1)]));
      expect(h.calls).toHaveLength(1);
      expect(h.hook.stats()).toMatchObject({ failed: 0, skipped: expect.objectContaining({ residentialBudget: 1 }) });
    });

    it('gates only the residential lane — a DIRECT image is untouched by the ceiling', async () => {
      const h = harness({ policy: { 'cdn.test': { lane: 'impit', egress: 'residential' }, 'other.test': {} }, residentialBytesPerDay: 0 });
      await capture(h, rulesetDescribing([gallery('https://cdn.test/a.jpg', 0), gallery('https://other.test/b.jpg', 1)]));
      expect(h.calls.map(c => c.url)).toEqual(['https://other.test/b.jpg']);
    });

    it('spends again once the rolling day has rolled', async () => {
      const h = harness({ policy: residential, residentialBytesPerDay: PNG.length, fetch: async (url: string) => okBytes(Buffer.from(url), url) });
      await capture(h, rulesetDescribing([gallery('https://cdn.test/a.jpg')]));
      h.clock.now += 25 * 3_600_000;
      await capture(h, rulesetDescribing([gallery('https://cdn.test/b.jpg')]));
      expect(h.calls).toHaveLength(2);
      expect(h.hook.stats().residentialBytesToday).toBe(Buffer.from('https://cdn.test/b.jpg').length);
    });

    it('refuses residentially when no proxy resolves, rather than leaving through the node', async () => {
      const h = harness({ policy: residential });
      const noProxy = createImageCaptureHook({
        sink: h.sink,
        policy: buildImageHostPolicy(residential),
        fetchBytes: async (url: string, opts?: ImageFetchOptions) => {
          h.calls.push({ url, plan: opts as ImageFetchPlan });
          return okBytes();
        },
        proxyUrlFor: () => undefined,
        now: () => h.clock.now,
      });
      await noProxy.capture({ site: 'examplestore', itemId: 'lucy-1', pageUrl: PAGE, fields: {}, ruleset: rulesetDescribing([gallery('https://cdn.test/a.jpg')]), origin: 'ingest' });
      expect(h.calls).toHaveLength(0);
      expect(noProxy.stats().skipped.policyDeny).toBe(1);
    });
  });

  describe('when the fetch does not yield an image', () => {
    it('counts a body that is not an image as a skip, and does not report it', async () => {
      const h = harness({ fetch: async () => ({ ok: false, reason: 'not-image', status: 200, contentType: 'text/html' }) });
      await capture(h, rulesetDescribing([gallery('https://cdn.test/a.jpg')]));
      expect(h.hook.stats()).toMatchObject({ attempted: 1, failed: 0, skipped: expect.objectContaining({ notImage: 1 }) });
      expect(h.reports).toHaveLength(0);
    });

    it('counts an oversized body as a skip', async () => {
      const h = harness({ fetch: async () => ({ ok: false, reason: 'too-large', detail: 'huge' }) });
      await capture(h, rulesetDescribing([gallery('https://cdn.test/a.jpg')]));
      expect(h.hook.stats().skipped.tooLarge).toBe(1);
    });

    it('reports a 404 to the failure ledger under the image kind, named by the image url', async () => {
      const h = harness({ fetch: async () => ({ ok: false, reason: 'http-status', status: 404 }) });
      await capture(h, rulesetDescribing([gallery('https://cdn.test/a.jpg')]));
      expect(h.hook.stats().failed).toBe(1);
      expect(h.reports).toHaveLength(1);
      expect(h.reports[0]).toMatchObject({
        site: 'examplestore',
        itemId: 'lucy-1',
        target: 'https://cdn.test/a.jpg',
        kind: 'image',
        origin: 'ingest',
        reasonClass: 'gone_404',
        httpStatus: 404,
      });
    });

    it('names the reason class the upstream status actually justifies', async () => {
      const cases: Array<[ImageBytesResult, string]> = [
        [{ ok: false, reason: 'http-status', status: 403 }, 'http_403'],
        [{ ok: false, reason: 'http-status', status: 429 }, 'http_429'],
        [{ ok: false, reason: 'http-status', status: 503 }, 'http_5xx'],
        [{ ok: false, reason: 'http-status', status: 418 }, 'other'],
        [{ ok: false, reason: 'timeout' }, 'timeout'],
        [{ ok: false, reason: 'unsupported', detail: 'no bytes on this lane' }, 'other'],
      ];
      for (const [result, reasonClass] of cases) {
        const h = harness({ fetch: async () => result });
        await capture(h, rulesetDescribing([gallery('https://cdn.test/a.jpg')]));
        expect(h.reports[0]?.reasonClass).toBe(reasonClass);
      }
    });

    it('reports a transport fault as a network failure without letting it escape', async () => {
      const h = harness({ fetch: async () => { throw new Error('ECONNRESET'); } });
      await expect(capture(h, rulesetDescribing([gallery('https://cdn.test/a.jpg')]))).resolves.toBeUndefined();
      expect(h.hook.stats().failed).toBe(1);
      expect(h.reports[0]).toMatchObject({ reasonClass: 'network', kind: 'image' });
    });

    it('logs a failing host once an hour, however many of its images fail', async () => {
      const h = harness({ fetch: async () => ({ ok: false, reason: 'http-status', status: 403 }) });
      await capture(h, rulesetDescribing(Array.from({ length: 5 }, (_, i) => gallery(`https://cdn.test/${i}.jpg`, i))));
      expect(h.warnings).toHaveLength(1);
      h.clock.now += 61 * 60_000;
      await capture(h, rulesetDescribing([gallery('https://cdn.test/later.jpg')]));
      expect(h.warnings).toHaveLength(2);
    });
  });

  describe('best-effort isolation', () => {
    it('survives a ruleset whose describeImages throws', async () => {
      const h = harness();
      await expect(capture(h, rulesetDescribing(() => { throw new Error('bad ruleset'); }))).resolves.toBeUndefined();
      expect(h.hook.stats().failed).toBe(1);
      expect(h.calls).toHaveLength(0);
    });

    it('survives a sink that is down, and keeps trying the rest of the gallery', async () => {
      const sink = { capture: jest.fn(async () => { throw new Error('bucket unreachable'); }) };
      const hook = createImageCaptureHook({
        sink,
        policy: buildImageHostPolicy({}),
        fetchBytes: async (url: string) => okBytes(Buffer.from(url), url),
        now: () => 0,
      });
      await expect(
        hook.capture({
          site: 'examplestore',
          itemId: 'lucy-1',
          pageUrl: PAGE,
          fields: {},
          ruleset: rulesetDescribing([gallery('https://cdn.test/a.jpg', 0), gallery('https://cdn.test/b.jpg', 1)]),
          origin: 'ingest',
        }),
      ).resolves.toBeUndefined();
      expect(sink.capture).toHaveBeenCalledTimes(2);
      expect(hook.stats()).toMatchObject({ stored: 0, failed: 2 });
    });

    it('survives a failure reporter that itself fails', async () => {
      const hook = createImageCaptureHook({
        sink: new CollectingCaptureSink(),
        policy: buildImageHostPolicy({}),
        fetchBytes: async () => ({ ok: false, reason: 'timeout' }),
        reportFailure: async () => { throw new Error('ledger down'); },
        now: () => 0,
      });
      await expect(
        hook.capture({ site: 's', itemId: 'i', pageUrl: PAGE, fields: {}, ruleset: rulesetDescribing([gallery('https://cdn.test/a.jpg')]), origin: 'crawler' }),
      ).resolves.toBeUndefined();
      expect(hook.stats().failed).toBe(1);
    });

    it('survives a policy that throws while the gallery is being walked', async () => {
      const hook = createImageCaptureHook({
        sink: new CollectingCaptureSink(),
        policy: { ruleFor: () => { throw new Error('policy table exploded'); } },
        fetchBytes: async () => okBytes(),
        now: () => 0,
        warn: () => undefined,
      });
      await expect(
        hook.capture({ site: 's', itemId: 'i', pageUrl: PAGE, fields: {}, ruleset: rulesetDescribing([gallery('https://cdn.test/a.jpg')]), origin: 'ingest' }),
      ).resolves.toBeUndefined();
      expect(hook.stats().failed).toBe(1);
    });

    it('drains the captures a caller fired and forgot', async () => {
      const h = harness();
      void capture(h, rulesetDescribing([gallery('https://cdn.test/a.jpg')]));
      expect(h.sink.captures).toHaveLength(0);
      await h.hook.drain();
      expect(h.sink.captures).toHaveLength(1);
    });
  });
});
