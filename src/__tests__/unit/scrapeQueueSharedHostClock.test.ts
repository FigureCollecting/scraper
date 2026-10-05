/**
 * QB-U8 (Ross QB-4 "yes", 2026-10-04): ONE per-host clock for the queue's record dispatch and the
 * image lane on a store's main host.
 *
 * Today the queue paces a host on its private `hostLastDispatch` map and the image lane on a separate
 * HostRateLimiter, so an MFC record and an MFC main-host image (an explicit item's plate on the
 * `?_tb=commit&commit=nsp` route) can leave back to back. A host in SCRAPE_HOST_CLOCK's scope is
 * paced on the shared clock instead; every other host keeps the private map, byte for byte.
 *
 * Fake timers, a stubbed page fetch, a stubbed bytes fetcher: no network.
 */

const mockNotifyItemSuccess = jest.fn().mockResolvedValue(true);
const mockNotifyItemFailed = jest.fn().mockResolvedValue(true);
const mockNotifyItemSkipped = jest.fn().mockResolvedValue(true);

jest.mock('../../services/genericScraper', () => ({
  BrowserPool: {
    getStealthBrowser: jest.fn(),
    getBrowser: jest.fn(),
    returnBrowser: jest.fn(),
    getPoolSize: jest.fn().mockReturnValue(2),
    getPoolCapacity: jest.fn().mockReturnValue(3),
    reset: jest.fn(),
  },
}));

jest.mock('../../services/webhookClient', () => ({
  notifyItemSuccess: (...args: any[]) => mockNotifyItemSuccess(...args),
  notifyItemFailed: (...args: any[]) => mockNotifyItemFailed(...args),
  notifyItemSkipped: (...args: any[]) => mockNotifyItemSkipped(...args),
}));

import { ScrapeQueue, resetScrapeQueue } from '../../services/scrapeQueue';
import { createExtractionRegistry, ExtractionRegistryImpl } from '../../services/extractionRegistry';
import { ChallengeCooldown } from '../../services/challengeCooldown';
import { HostClock, getHostClock, parseHostClockScope, setHostClock } from '../../services/hostClock';
import { HostRateLimiter } from '../../driver/hostRateLimiter';
import { paceImageBytesByHost } from '../../services/images/imageBytesPacing';
import type { ImageBytesFetcher, ImageBytesResult } from '../../services/images/imageBytes';
import type { ImageCaptureHook, ImageCaptureRequest } from '../../services/images/imageCaptureHook';
import { okWriteStats } from '../helpers/ingestWriteStats';

const MFC = 'myfigurecollection.net';
const FLOOR = 7000;

interface SiteSpec {
  siteId: string;
  domain: string;
  baseDelayMs: number;
}

function makeRegistry(sites: SiteSpec[]): ExtractionRegistryImpl {
  const registry = createExtractionRegistry();
  for (const s of sites) {
    registry.registerSite({
      siteId: s.siteId,
      name: s.siteId,
      domains: [s.domain],
      rateLimit: {
        domain: s.domain,
        baseDelayMs: s.baseDelayMs,
        minDelayMs: s.baseDelayMs,
        maxDelayMs: 180_000,
        backoffMultiplier: 2,
        recoveryDivisor: 1.5,
        successThreshold: 4,
      },
      requiresBrowser: false,
      allowedCookies: [],
    });
    registry.registerRuleset({
      siteId: s.siteId,
      version: '1.0.0',
      extract: (_html: string, url: string) => ({
        source: {
          site: s.siteId,
          itemId: new URL(url).pathname.split('/').pop() as string,
          url,
          extractedAt: '2026-10-04T00:00:00.000Z',
          rulesetVersion: '1.0.0',
        },
        fields: { name: `Figure-${s.siteId}` },
        warnings: [],
      }),
      validate: () => ({ valid: true, errors: [], warnings: [] }),
    });
  }
  return registry;
}

const SITES: SiteSpec[] = [
  { siteId: 'mfc', domain: MFC, baseDelayMs: FLOOR },
  { siteId: 'other', domain: 'other.test', baseDelayMs: 1000 },
];

const ok = (): ImageBytesResult => ({
  ok: true,
  bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  contentType: 'image/png',
  status: 200,
  finalUrl: 'https://example.invalid/i.png',
  headers: {},
});
const throttled = (): ImageBytesResult => ({ ok: false, reason: 'http-status', status: 429, detail: 'HTTP 429' });

/** The smallest gap between consecutive times (Infinity for fewer than two). */
function minGap(times: number[]): number {
  const sorted = [...times].sort((a, b) => a - b);
  let min = Infinity;
  for (let i = 1; i < sorted.length; i++) min = Math.min(min, sorted[i] - sorted[i - 1]);
  return min;
}

/** A capture hook that fetches the given image urls for each record through the paced fetcher. */
function pacedHook(paced: ImageBytesFetcher, imagesFor: (request: ImageCaptureRequest) => string[]): ImageCaptureHook {
  const inFlight: Promise<void>[] = [];
  return {
    capture: (request: ImageCaptureRequest) => {
      const job = (async () => {
        for (const url of imagesFor(request)) {
          try {
            await paced(url);
          } catch {
            // a faulted fetch is the lane's to count; the hook never rejects
          }
        }
      })();
      inFlight.push(job);
      return job;
    },
    drain: async () => {
      await Promise.all(inFlight);
    },
    stats: () => ({ enabled: true }) as any,
  };
}

describe('ScrapeQueue on the shared host clock (QB-U8)', () => {
  let queue: ScrapeQueue;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(1_000_000);
    resetScrapeQueue();
    setHostClock(null);
  });

  afterEach(() => {
    if (queue) {
      queue.stop();
      queue.clear();
    }
    resetScrapeQueue();
    setHostClock(null);
    jest.useRealTimers();
  });

  async function advance(ms: number, step = 250) {
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      await jest.advanceTimersByTimeAsync(step);
    }
  }

  function makeQueue(clock?: HostClock) {
    const pageCalls: Array<{ url: string; at: number }> = [];
    const scraping = {
      scrapePage: jest.fn().mockImplementation((url: string) => {
        pageCalls.push({ url, at: Date.now() });
        return Promise.resolve({ html: '<html></html>', url, title: 'Item', statusCode: 200 });
      }),
      scrapePageStealth: jest.fn(),
    };
    queue = new ScrapeQueue(false);
    queue.setPluginRegistry(makeRegistry(SITES));
    queue.setIngestEmitter({ send: jest.fn().mockResolvedValue(okWriteStats()) });
    queue.setScrapingService(scraping);
    if (clock) queue.setHostClock(clock);
    return { pageCalls };
  }

  const mfcTimes = (pageCalls: Array<{ url: string; at: number }>) =>
    pageCalls.filter(c => new URL(c.url).hostname === MFC).map(c => c.at);

  describe('storeHostFloorMs (the floor source the composition root binds)', () => {
    it("is the queue's own per-host floor for a store's host", () => {
      makeQueue();
      expect(queue.storeHostFloorMs(MFC)).toBe(FLOOR);
      expect(queue.storeHostFloorMs('www.myfigurecollection.net')).toBe(FLOOR);
      expect(queue.storeHostFloorMs('other.test')).toBe(1000);
    });

    it('is undefined for a host no store declares (a CDN, the static image host)', () => {
      makeQueue();
      expect(queue.storeHostFloorMs('cdn.shopify.com')).toBeUndefined();
      expect(queue.storeHostFloorMs('static.myfigurecollection.net')).toBeUndefined();
    });

    it('is undefined before a registry is set', () => {
      queue = new ScrapeQueue(false);
      expect(queue.storeHostFloorMs(MFC)).toBeUndefined();
    });
  });

  it('books an in-scope host\'s record dispatch on the shared clock', async () => {
    const clock = new HostClock(parseHostClockScope(MFC));
    makeQueue(clock);
    queue.enqueue('m1', { priority: 'WARM', url: `https://${MFC}/item/1` });
    await advance(500);
    expect(clock.tryAcquire(MFC, Date.now(), FLOOR)).toBeGreaterThan(6000);
  });

  it("paces an in-scope host's records by the queue's own floor on the shared clock", async () => {
    const clock = new HostClock(parseHostClockScope(MFC));
    const { pageCalls } = makeQueue(clock);
    queue.enqueue('m1', { priority: 'WARM', url: `https://${MFC}/item/1` });
    queue.enqueue('m2', { priority: 'WARM', url: `https://${MFC}/item/2` });
    queue.enqueue('m3', { priority: 'WARM', url: `https://${MFC}/item/3` });
    await advance(15_000);
    const times = mfcTimes(pageCalls);
    expect(times).toHaveLength(3);
    expect([times[1] - times[0], times[2] - times[1]]).toEqual([FLOOR, FLOOR]);
    // ...and an image asking the clock with a smaller floor still waits the records' 7000.
    expect(clock.reserve(MFC, times[2] + 10, 1000)).toBe(times[2] + FLOOR);
  });

  it('holds the next record behind an image slot booked on the shared clock', async () => {
    const clock = new HostClock(parseHostClockScope(MFC));
    const { pageCalls } = makeQueue(clock);
    queue.enqueue('m1', { priority: 'WARM', url: `https://${MFC}/item/1` });
    await advance(500);
    // An image books the next slot (t0 + 7000) while record 1 is done.
    const t0 = mfcTimes(pageCalls)[0];
    expect(clock.reserve(MFC, Date.now(), FLOOR)).toBe(t0 + FLOOR);
    queue.enqueue('m2', { priority: 'HOT', url: `https://${MFC}/item/2` });
    await advance(13_000);
    expect(mfcTimes(pageCalls)).toEqual([t0]);
    await advance(2000);
    expect(mfcTimes(pageCalls)).toEqual([t0, t0 + 2 * FLOOR]);
  });

  it('keeps an out-of-scope host on its private floor and books nothing on the clock', async () => {
    const clock = new HostClock(parseHostClockScope(MFC));
    const { pageCalls } = makeQueue(clock);
    queue.enqueue('o1', { priority: 'WARM', url: 'https://other.test/item/1' });
    queue.enqueue('o2', { priority: 'WARM', url: 'https://other.test/item/2' });
    await advance(2000);
    const times = pageCalls.map(c => c.at);
    expect(times).toHaveLength(2);
    expect(times[1] - times[0]).toBe(1000);
    // At the very instant of o2's dispatch the clock still grants other.test: nothing was booked.
    expect(clock.tryAcquire('other.test', times[1], 1000)).toBe(0);
  });

  it('with the clock OFF (the default process clock) records keep today\'s private floor and the clock books nothing', async () => {
    const { pageCalls } = makeQueue();
    queue.enqueue('m1', { priority: 'WARM', url: `https://${MFC}/item/1` });
    queue.enqueue('m2', { priority: 'WARM', url: `https://${MFC}/item/2` });
    await advance(8000);
    const times = mfcTimes(pageCalls);
    expect(times).toHaveLength(2);
    expect(times[1] - times[0]).toBe(FLOOR);
    // At the very instant of m2's dispatch the process clock still grants the host: nothing was booked.
    expect(getHostClock().tryAcquire(MFC, times[1], FLOOR)).toBe(0);
  });

  it("re-stamps a record's booking with the instant its fetch really leaves, so the next image is a full floor after the send", async () => {
    const clock = new HostClock(parseHostClockScope(MFC));
    const { pageCalls } = makeQueue(clock);
    // Synchronous work between the dispatch decision and the transport call (a durable lease write, a
    // long scan of the tiers) is modelled as 40 ms the fake clock moves while the queue checks the
    // challenge cooldown, which it does after booking and before fetching.
    const cooldown = new ChallengeCooldown();
    const isOpen = cooldown.isOpen.bind(cooldown);
    jest.spyOn(cooldown, 'isOpen').mockImplementation((host: string) => {
      jest.setSystemTime(Date.now() + 40);
      return isOpen(host);
    });
    queue.setChallengeCooldown(cooldown);
    queue.enqueue('m1', { priority: 'WARM', url: `https://${MFC}/item/1` });
    await advance(500);
    const [sent] = mfcTimes(pageCalls);
    expect(sent).toBeDefined();
    expect(clock.reserve(MFC, Date.now(), FLOOR)).toBe(sent + FLOOR);
  });

  describe('behaviour: records and main-host images on one clock', () => {
    /**
     * Each MFC record names two explicit plates on the main host (nsp route) and one plate on the
     * static CDN; each `other.test` record one image on its own host. Every fourth image GET is
     * throttled (429), the rest succeed, so the image limiter backs off and recovers along the way.
     */
    async function run(clock: HostClock | undefined) {
      const imageCalls: Array<{ url: string; at: number }> = [];
      let n = 0;
      const fetcher: ImageBytesFetcher = async (url: string) => {
        imageCalls.push({ url, at: Date.now() });
        n += 1;
        return n % 4 === 0 ? throttled() : ok();
      };
      const paced = paceImageBytesByHost(fetcher, new HostRateLimiter(() => undefined), {
        cooldown: { remaining: () => 0 },
        ...(clock ? { hostClock: clock } : {}),
      });
      const { pageCalls } = makeQueue(clock);
      if (clock) clock.setFloorSource(host => queue.storeHostFloorMs(host));
      queue.setImageCaptureHook(
        pacedHook(paced, request => {
          const id = request.itemId;
          if (new URL(request.pageUrl).hostname === MFC) {
            return [
              `https://${MFC}/?_tb=commit&commit=nsp&objectType=item&objectId=${id}&size=1`,
              `https://${MFC}/?_tb=commit&commit=nsp&objectType=item&objectId=${id}&size=2`,
              `https://static.myfigurecollection.net/upload/items/1/${id}-abc.jpg`,
            ];
          }
          return [`https://other.test/img/${id}.jpg`];
        }),
      );
      for (let i = 1; i <= 8; i++) queue.enqueue(`m${i}`, { priority: i % 3 === 0 ? 'HOT' : 'WARM', url: `https://${MFC}/item/${i}` });
      for (let i = 1; i <= 4; i++) queue.enqueue(`o${i}`, { priority: 'COLD', url: `https://other.test/item/${i}` });
      await advance(260_000, 500);
      const host = (u: string) => new URL(u).hostname;
      return {
        records: mfcTimes(pageCalls),
        otherRecords: pageCalls.filter(c => host(c.url) === 'other.test').map(c => c.at),
        mainImages: imageCalls.filter(c => host(c.url) === MFC).map(c => c.at),
        staticImages: imageCalls.filter(c => host(c.url) === 'static.myfigurecollection.net').map(c => c.at),
      };
    }

    it('in scope: no two MFC main-host requests (records or images) are closer than 7000 ms; other hosts are not held', async () => {
      const r = await run(new HostClock(parseHostClockScope(MFC)));

      expect(r.records).toHaveLength(8);
      expect(r.mainImages).toHaveLength(16);
      expect(minGap([...r.records, ...r.mainImages])).toBeGreaterThanOrEqual(FLOOR);
      // other.test is never held behind MFC: its four records go at its own 1000 ms floor.
      expect(r.otherRecords).toHaveLength(4);
      expect(minGap(r.otherRecords)).toBe(1000);
      // The static CDN is not on the main host's clock: each plate there goes straight after its
      // record's main-host plates (its own limiter is long ready), closer to them than the floor.
      expect(r.staticImages).toHaveLength(8);
      expect(minGap([...r.mainImages, ...r.staticImages])).toBeLessThan(FLOOR);
    });

    it('OFF (today): records keep 7000 ms but main-host images land closer to records and to each other', async () => {
      const r = await run(undefined);

      expect(r.records).toHaveLength(8);
      expect(minGap(r.records)).toBeGreaterThanOrEqual(FLOOR);
      expect(r.mainImages).toHaveLength(16);
      expect(minGap([...r.records, ...r.mainImages])).toBeLessThan(FLOOR);
    });
  });
});
