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
import { HostClock, getHostClock, parseHostClockScope, setHostClock, type HostFloorSource } from '../../services/hostClock';
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

/** How many consecutive gaps (sorted times) are under the floor. */
function gapsUnder(times: number[], floor: number): number {
  const sorted = [...times].sort((a, b) => a - b);
  let n = 0;
  for (let i = 1; i < sorted.length; i++) if (sorted[i] - sorted[i - 1] < floor) n++;
  return n;
}

/** The registry's floors, as a floor source the test owns (the observer reads it as index.ts's binding would). */
const FLOORS: HostFloorSource = host => ({ [MFC]: FLOOR, 'other.test': 1000 } as Record<string, number | undefined>)[host];

const nspUrl = (id: string | number, size: number) => `https://${MFC}/?_tb=commit&commit=nsp&objectType=item&objectId=${id}&size=${size}`;

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
    if (clock) setHostClock(clock);
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
    const settle = jest.spyOn(clock, 'settle');
    const recordSend = jest.spyOn(clock, 'recordSend');
    queue.enqueue('m1', { priority: 'WARM', url: `https://${MFC}/item/1` });
    await advance(500);
    const [sent] = mfcTimes(pageCalls);
    expect(sent).toBe(1_000_040);
    // The send, not the dispatch decision 40 ms earlier, is what the clock and the observer stamp.
    expect(settle.mock.calls).toEqual([[MFC, sent, FLOOR]]);
    expect(recordSend.mock.calls).toEqual([[MFC, 'queue', sent]]);
    expect(clock.reserve(MFC, Date.now(), FLOOR)).toBe(sent + FLOOR);
  });

  it('an injected clock on the queue (DI) wins over the process clock', async () => {
    const clock = new HostClock(parseHostClockScope(MFC));
    const { pageCalls } = makeQueue();
    queue.setHostClock(clock);
    queue.enqueue('m1', { priority: 'WARM', url: `https://${MFC}/item/1` });
    await advance(500);
    expect(mfcTimes(pageCalls)).toHaveLength(1);
    expect(clock.tryAcquire(MFC, Date.now(), FLOOR)).toBeGreaterThan(6000);
    expect(getHostClock().tryAcquire(MFC, Date.now(), FLOOR)).toBe(0);
  });

  describe('the send-time gate at the transport hand-off', () => {
    /**
     * Whatever runs between the queue's dispatch decision and its transport call is modelled inside
     * the challenge-cooldown check, the last step before the fetch: `between(n)` runs on the n-th check.
     */
    function gated(clock: HostClock, between: (n: number, cooldown: ChallengeCooldown) => void) {
      const { pageCalls } = makeQueue(clock);
      const cooldown = new ChallengeCooldown();
      const isOpen = cooldown.isOpen.bind(cooldown);
      const checks: number[] = [];
      jest.spyOn(cooldown, 'isOpen').mockImplementation((host: string) => {
        checks.push(Date.now());
        between(checks.length, cooldown);
        return isOpen(host);
      });
      queue.setChallengeCooldown(cooldown);
      return { pageCalls, checks };
    }

    it('an image that left after the dispatch decision holds the record a full floor after it; the cooldown is checked again before the send', async () => {
      const clock = new HostClock(parseHostClockScope(MFC), MFC);
      let imageAt = -1;
      const { pageCalls, checks } = gated(clock, n => {
        if (n !== 1) return;
        jest.setSystemTime(Date.now() + 40);
        imageAt = Date.now();
        clock.settle(MFC, imageAt, FLOOR);
      });
      queue.enqueue('m1', { priority: 'WARM', url: `https://${MFC}/item/1` });
      await advance(FLOOR - 250);
      expect(pageCalls).toEqual([]);
      await advance(1000);
      expect(mfcTimes(pageCalls)).toEqual([imageAt + FLOOR]);
      expect(checks).toEqual([imageAt - 40, imageAt + FLOOR]);
    });

    it('a challenge cooldown that opens while the record waits at the gate fails it fast, with no fetch', async () => {
      const clock = new HostClock(parseHostClockScope(MFC), MFC);
      const { pageCalls, checks } = gated(clock, (n, cooldown) => {
        if (n === 1) clock.settle(MFC, Date.now(), FLOOR);
        if (n === 2) cooldown.open(MFC, 'challenge page via impersonate transport');
      });
      const settle = jest.spyOn(clock, 'settle');
      queue.enqueue('m1', { priority: 'WARM', url: `https://${MFC}/item/1` });
      await advance(FLOOR + 1000);
      expect(checks).toHaveLength(2);
      expect(pageCalls).toEqual([]);
      // Only the test's own stamp: the refused record stamped nothing.
      expect(settle).toHaveBeenCalledTimes(1);
    });

    it('a host off the clock never waits at the gate, and the observer still stamps its send', async () => {
      const off = new HostClock(parseHostClockScope(undefined));
      off.setFloorSource(FLOORS);
      const { pageCalls } = gated(off, n => {
        if (n === 1) off.settle(MFC, Date.now(), FLOOR);
      });
      queue.enqueue('m1', { priority: 'WARM', url: `https://${MFC}/item/1` });
      await advance(500);
      expect(mfcTimes(pageCalls)).toEqual([1_000_000]);
      expect(off.view(Date.now()).hosts[0]).toMatchObject({ host: MFC, clocked: false, sends60m: { queue: 1, image: 0 }, lastSendAt: new Date(1_000_000).toISOString() });
    });
  });

  describe('behaviour: records and main-host images on one clock', () => {
    /**
     * Each MFC record names two explicit plates on the main host (nsp route) and one plate on the
     * static CDN; each `other.test` record one image on its own host. Every fourth image GET is
     * throttled (429), the rest succeed, so the image limiter backs off and recovers along the way.
     */
    async function run(clock: HostClock | undefined, floorSource?: HostFloorSource) {
      const imageCalls: Array<{ url: string; at: number }> = [];
      let n = 0;
      const fetcher: ImageBytesFetcher = async (url: string) => {
        imageCalls.push({ url, at: Date.now() });
        n += 1;
        return n % 4 === 0 ? throttled() : ok();
      };
      const { pageCalls } = makeQueue(clock);
      // index.ts's binding, unless the test brings its own source.
      getHostClock().setFloorSource(floorSource ?? (host => queue.storeHostFloorMs(host)));
      // The image lane takes the process clock when it is built, as in production (assembleImageCapture
      // injects none), so it is built after makeQueue has installed the test's clock.
      const paced = paceImageBytesByHost(fetcher, new HostRateLimiter(() => undefined), {
        cooldown: { remaining: () => 0 },
      });
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

    it('the observer, clock OFF (the live negative control): it measures where records and images really left, under the floor', async () => {
      const r = await run(undefined, FLOORS);
      const view = getHostClock().view(Date.now());
      const truth = [...r.records, ...r.mainImages];

      expect(view.mode).toBe('off');
      const mfc = view.hosts.find(h => h.host === MFC);
      expect(mfc).toMatchObject({ floorMs: FLOOR, clocked: false, sends60m: { queue: 8, image: 16 } });
      expect(mfc?.minGapMs60m).toBe(minGap(truth));
      expect(mfc?.underFloor60m).toBe(gapsUnder(truth, FLOOR));
      expect(mfc?.underFloor60m).toBeGreaterThan(0);
      // The static CDN is no store host: not observed.
      expect(view.hosts.map(h => h.host)).toEqual(['other.test', MFC]);
    });

    it('the observer, clock ON: both callers counted, no gap under the floor, the smallest gap is the true one', async () => {
      const clock = new HostClock(parseHostClockScope(MFC), MFC);
      const r = await run(clock, FLOORS);
      const view = clock.view(Date.now());
      const mfc = view.hosts.find(h => h.host === MFC);

      expect(view.mode).toBe('hosts');
      expect(mfc).toMatchObject({ floorMs: FLOOR, clocked: true, sends60m: { queue: 8, image: 16 }, underFloor60m: 0 });
      expect(mfc?.minGapMs60m).toBeGreaterThanOrEqual(FLOOR);
      expect(mfc?.minGapMs60m).toBe(minGap([...r.records, ...r.mainImages]));
      expect(clock.summaryLines(Date.now())).toContain(`[HOST-CLOCK] summary host=${MFC} sends=24 minGapMs=${mfc?.minGapMs60m} underFloor=0`);
      // other.test is observed but not clocked: its records keep their own 1000 ms floor.
      expect(view.hosts.find(h => h.host === 'other.test')).toMatchObject({ clocked: false, sends60m: { queue: 4, image: 4 }, floorMs: 1000 });
    });
  });

  describe('injected hand-off delays (review 6\'s R6 harness on a fake clock: floor 2500, 5 records x 2 main-host images)', () => {
    const R6_FLOOR = 2500;

    /**
     * A record fetch takes 150 ms and an image 80 ms on the wire. `stallMs` of synchronous work lands
     * either in the 3rd emission (extraction/emit, while earlier images sleep: their timers fire late)
     * or in the 3rd MFC record's hand-off (between its dispatch decision and its transport call).
     */
    async function r6(stallMs: number, where: 'emit' | 'handoff', clockOn: boolean) {
      const clock = clockOn ? new HostClock(parseHostClockScope(MFC), MFC) : new HostClock(parseHostClockScope(undefined));
      clock.setFloorSource(host => (host === MFC ? R6_FLOOR : undefined));
      setHostClock(clock);
      const sends: number[] = [];
      const scraping = {
        scrapePage: jest.fn().mockImplementation(async (url: string) => {
          sends.push(Date.now());
          await new Promise(resolve => setTimeout(resolve, 150));
          return { html: '<html></html>', url, title: 'Item', statusCode: 200 };
        }),
        scrapePageStealth: jest.fn(),
      };
      const paced = paceImageBytesByHost(async () => {
        sends.push(Date.now());
        await new Promise(resolve => setTimeout(resolve, 80));
        return ok();
      }, new HostRateLimiter(() => undefined), { cooldown: { remaining: () => 0 } });
      queue = new ScrapeQueue(false);
      queue.setPluginRegistry(makeRegistry([{ siteId: 'mfc', domain: MFC, baseDelayMs: R6_FLOOR }]));
      let emits = 0;
      queue.setIngestEmitter({ send: jest.fn().mockImplementation(async () => {
        emits += 1;
        if (where === 'emit' && emits === 3) jest.setSystemTime(Date.now() + stallMs);
        return okWriteStats();
      }) });
      const cooldown = new ChallengeCooldown();
      const isOpen = cooldown.isOpen.bind(cooldown);
      let checks = 0;
      jest.spyOn(cooldown, 'isOpen').mockImplementation((host: string) => {
        checks += 1;
        if (where === 'handoff' && checks === 3) jest.setSystemTime(Date.now() + stallMs);
        return isOpen(host);
      });
      queue.setChallengeCooldown(cooldown);
      queue.setScrapingService(scraping);
      queue.setImageCaptureHook(pacedHook(paced, request => [nspUrl(request.itemId, 1), nspUrl(request.itemId, 2)]));
      for (let i = 1; i <= 5; i++) queue.enqueue(`m${i}`, { priority: 'WARM', url: `https://${MFC}/item/${i}` });
      await advance(60_000);
      return { sends, mfc: clock.view(Date.now()).hosts.find(h => h.host === MFC) };
    }

    it.each([
      [1, 'emit'],
      [1500, 'emit'],
      [1, 'handoff'],
      [1500, 'handoff'],
    ] as const)('clock ON, a %i ms stall in the %s path: every send gap >= the floor and underFloor60m 0', async (stallMs, where) => {
      const { sends, mfc } = await r6(stallMs, where, true);
      expect(sends).toHaveLength(15);
      expect(minGap(sends)).toBeGreaterThanOrEqual(R6_FLOOR);
      expect(mfc).toMatchObject({ sends60m: { queue: 5, image: 10 }, underFloor60m: 0, minGapMs60m: minGap(sends) });
    });

    it('clock OFF, the same 1500 ms stall: the observer sees gaps under the floor (the harness can fail)', async () => {
      const { sends, mfc } = await r6(1500, 'emit', false);
      expect(sends).toHaveLength(15);
      expect(mfc?.underFloor60m).toBe(gapsUnder(sends, R6_FLOOR));
      expect(mfc?.underFloor60m).toBeGreaterThan(0);
      expect(mfc?.minGapMs60m).toBe(minGap(sends));
    });
  });

  describe('real timers (no fake clock): the real queue and the real image pacer under a busy event loop', () => {
    const savedHardFloor = process.env.SCRAPER_HOST_HARD_FLOOR_MS;
    beforeEach(() => {
      jest.useRealTimers();
      process.env.SCRAPER_HOST_HARD_FLOOR_MS = '50';
    });
    afterEach(() => {
      if (savedHardFloor === undefined) delete process.env.SCRAPER_HOST_HARD_FLOOR_MS;
      else process.env.SCRAPER_HOST_HARD_FLOOR_MS = savedHardFloor;
    });

    it('a 400 ms block of the loop across an image slot: every MFC send is still >= the 300 ms floor after the previous one', async () => {
      const floor = 300;
      // A fast limiter, so the clock (not the limiter's 2067 ms default) is what spaces the images.
      const fast = { baseDelayMs: 50, minDelayMs: 50, maxDelayMs: 1000, backoffMultiplier: 2, recoveryDivisor: 2, successThreshold: 3 };
      const clock = new HostClock(parseHostClockScope(MFC), MFC);
      clock.setFloorSource(host => (host === MFC ? floor : undefined));
      setHostClock(clock);
      const sends: number[] = [];
      const busy = (ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { /* a long synchronous parse */ } };
      const paced = paceImageBytesByHost(async () => {
        sends.push(Date.now());
        await new Promise(resolve => setTimeout(resolve, 20));
        return ok();
      }, new HostRateLimiter(() => fast, fast), { cooldown: { remaining: () => 0 } });
      queue = new ScrapeQueue(false);
      queue.setPluginRegistry(makeRegistry([{ siteId: 'mfc', domain: MFC, baseDelayMs: floor }]));
      queue.setIngestEmitter({ send: jest.fn().mockResolvedValue(okWriteStats()) });
      let records = 0;
      queue.setScrapingService({
        scrapePage: jest.fn().mockImplementation(async (url: string) => {
          sends.push(Date.now());
          records += 1;
          // Record 1's first image sleeps toward its slot a floor later; the loop is blocked across it.
          if (records === 1) setTimeout(() => busy(400), floor - 50);
          await new Promise(resolve => setTimeout(resolve, 30));
          return { html: '<html></html>', url, title: 'Item', statusCode: 200 };
        }),
        scrapePageStealth: jest.fn(),
      });
      queue.setImageCaptureHook(pacedHook(paced, request => [nspUrl(request.itemId, 1), nspUrl(request.itemId, 2)]));
      for (let i = 1; i <= 3; i++) queue.enqueue(`m${i}`, { priority: 'WARM', url: `https://${MFC}/item/${i}` });
      const t0 = Date.now();
      while (sends.length < 9 && Date.now() - t0 < 15_000) await new Promise(resolve => setTimeout(resolve, 50));

      expect(sends).toHaveLength(9);
      // Whole milliseconds on both sides of each stamp: a gap may read one ms short of the floor.
      expect(minGap(sends)).toBeGreaterThanOrEqual(floor - 1);
      const mfc = clock.view(Date.now()).hosts.find(h => h.host === MFC);
      expect(mfc).toMatchObject({ sends60m: { queue: 3, image: 6 }, underFloor60m: 0 });
    });
  });
});
