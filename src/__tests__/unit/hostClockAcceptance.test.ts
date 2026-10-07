/**
 * QB-U30b acceptance (plan-v3 rev 7): EVERY caller that reaches a store's main host books on the one
 * per-host clock, and send spacing is measured where it matters, at the FAKE TRANSPORT (review 7):
 * the queue's record dispatch and main-host images (QB-U30a), the /catalog listing, seed and rotating
 * fetches, POST /resolve, the legacy /scrape route, /lookup on a clocked bySearch host and a fetchBody
 * follow-up (QB-U30b), each running the rev-7 send block (gate, settle, INVOKE, record, then await).
 *
 * Fake timers (Date.now and setTimeout), recording fake transports, no network.
 */
const mockNotifyItemSuccess = jest.fn().mockResolvedValue(true);
const mockNotifyItemFailed = jest.fn().mockResolvedValue(true);
const mockNotifyItemSkipped = jest.fn().mockResolvedValue(true);
const mockScrapeGeneric = jest.fn();

jest.mock('../../services/genericScraper', () => ({
  BrowserPool: {
    getStealthBrowser: jest.fn(),
    getBrowser: jest.fn(),
    returnBrowser: jest.fn(),
    getPoolSize: jest.fn().mockReturnValue(2),
    getPoolCapacity: jest.fn().mockReturnValue(3),
    reset: jest.fn(),
  },
  scrapeGeneric: (...args: any[]) => mockScrapeGeneric(...args),
}));

jest.mock('../../services/webhookClient', () => ({
  notifyItemSuccess: (...args: any[]) => mockNotifyItemSuccess(...args),
  notifyItemFailed: (...args: any[]) => mockNotifyItemFailed(...args),
  notifyItemSkipped: (...args: any[]) => mockNotifyItemSkipped(...args),
}));

import { ScrapeQueue, resetScrapeQueue } from '../../services/scrapeQueue';
import { createExtractionRegistry, type ExtractionRegistryImpl } from '../../services/extractionRegistry';
import { HOST_CLOCK_CALLERS, HostClock, parseHostClockScope, setHostClock, type HostClockCaller, type HostClockOptions } from '../../services/hostClock';
import { HostRateLimiter } from '../../driver/hostRateLimiter';
import { paceImageBytesByHost } from '../../services/images/imageBytesPacing';
import type { ImageBytesResult } from '../../services/images/imageBytes';
import { assembleCatalog, type CatalogServices } from '../../driver/assembleCatalog';
import * as lookupModule from '../../driver/assembleLookup';
import { assembleLookup } from '../../driver/assembleLookup';
import { assembleResolve } from '../../driver/assembleResolve';
import { buildProfileRegistry } from '../../driver/profileRegistry';
import { buildExtractContext } from '../../services/engineServices/extractContext';
import { scrapeOnHostClock } from '../../routes/scraper';
import { deriveStream } from '../../services/poolSelect';
import { okWriteStats } from '../helpers/ingestWriteStats';
import type { ExtractionRuleset, SiteConfig, StoreCapabilities } from '@figurecollecting/scraper-plugin-contract';

const MFC = 'myfigurecollection.net';
const FLOOR = 7000;
const START = 1_000_000;

interface Wire {
  caller: HostClockCaller;
  url: string;
  at: number;
}

/** A store's caps (and its SiteConfig): main host, floor, and the axes the callers use. */
function store(siteId: string, domain: string, floor: number, axes: Partial<StoreCapabilities['retrieval']> = {}): StoreCapabilities {
  return {
    siteId,
    name: siteId,
    domains: [domain],
    rateLimit: { domain, baseDelayMs: floor, minDelayMs: floor, maxDelayMs: 180_000, backoffMultiplier: 2, recoveryDivisor: 1.5, successThreshold: 4 },
    requiresBrowser: false,
    allowedCookies: [],
    retrieval: {
      byId: { urlTemplate: `https://${domain}/item/{id}`, idKind: 'store-internal' },
      byListing: { urlTemplate: `https://${domain}/browse?page={page}`, order: 'newest' },
      seedLists: [{ id: 'top', url: `https://${domain}/top`, cadence: 'weekly' }],
      rotatingSeedLists: [{ id: 'co-1', url: `https://${domain}/companies/1`, group: 'companies', order: 1 }],
      ...axes,
    },
  } as StoreCapabilities;
}

function ruleset(siteId: string): ExtractionRuleset {
  return {
    siteId,
    version: '1.0.0',
    extract: (_html: string, url: string) => ({
      source: { site: siteId, itemId: new URL(url).pathname.split('/').pop() as string, url, extractedAt: '2026-10-07T00:00:00.000Z', rulesetVersion: '1.0.0' },
      fields: { name: `Figure-${siteId}` },
      warnings: [],
    }),
    validate: () => ({ valid: true, errors: [], warnings: [] }),
    extractListing: () => ({ items: [{ itemId: '1' }], hasMore: true }),
    extractSeedList: () => ({ items: [{ itemId: '2' }] }),
    extractCandidates: () => [{ itemId: '3', name: 'Figure', url: '/item/3' }],
  } as unknown as ExtractionRuleset;
}

/** The smallest gap between consecutive times. */
function gaps(times: number[]): number[] {
  const sorted = [...times].sort((a, b) => a - b);
  return sorted.slice(1).map((t, i) => t - sorted[i]);
}

describe('QB-U30b: every caller on one per-host clock, spacing measured at the transport', () => {
  let queue: ScrapeQueue | undefined;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(START);
    resetScrapeQueue();
    setHostClock(null);
    process.env.CATALOG_STORE_TIMEOUT_MS = '60000';
    process.env.LOOKUP_STORE_TIMEOUT_MS = '35000';
  });

  afterEach(() => {
    queue?.stop();
    queue?.clear();
    queue = undefined;
    resetScrapeQueue();
    setHostClock(null);
    process.env = { ...savedEnv };
    jest.useRealTimers();
  });

  async function advance(ms: number, step = 250) {
    for (let elapsed = 0; elapsed < ms; elapsed += step) await jest.advanceTimersByTimeAsync(step);
  }

  /** Advance until `work` settles (or the budget runs out); work that settles at once moves no time. */
  async function drive<T>(work: Promise<T>, budgetMs: number, step = 250): Promise<T> {
    let done = false;
    let value: T | undefined;
    let error: unknown;
    work.then(v => { done = true; value = v; }, e => { done = true; error = e; });
    for (let elapsed = 0; ; elapsed += step) {
      for (let i = 0; i < 50 && !done; i++) await Promise.resolve();
      if (done) break;
      if (elapsed >= budgetMs) throw new Error(`work did not settle within ${budgetMs} ms`);
      await jest.advanceTimersByTimeAsync(step);
    }
    if (error) throw error;
    return value as T;
  }

  /**
   * The rig: one clock installed as the process clock, every caller wired to a fake transport that
   * stamps its entry. `delayMs(caller)` is synchronous work the transport does BEFORE its entry
   * (dispatcher work, a hand-off): the fake time moves and the stamp is taken after it.
   */
  function rig(opts: { scope?: string; clock?: HostClockOptions; delayMs?: (caller: HostClockCaller) => number; stores?: StoreCapabilities[] } = {}) {
    const stores = opts.stores ?? [store('mfc', MFC, FLOOR)];
    const wire: Wire[] = [];
    const stamp = (caller: HostClockCaller, url: string) => {
      const delay = opts.delayMs?.(caller) ?? 0;
      if (delay > 0) jest.setSystemTime(Date.now() + delay);
      wire.push({ caller, url, at: Date.now() });
    };
    const raw = opts.scope ?? MFC;
    const clock = new HostClock(parseHostClockScope(raw), raw, opts.clock ?? {});
    setHostClock(clock);

    // The queue (records) and its floor source, as index.ts binds them.
    const registry: ExtractionRegistryImpl = createExtractionRegistry();
    for (const s of stores) {
      registry.registerSite(s as SiteConfig);
      registry.registerRuleset(ruleset(s.siteId));
    }
    const q = new ScrapeQueue(false);
    queue = q;
    q.setPluginRegistry(registry);
    q.setIngestEmitter({ send: jest.fn().mockResolvedValue(okWriteStats()) });
    q.setScrapingService({
      scrapePage: jest.fn().mockImplementation((url: string) => {
        stamp('queue', url);
        return Promise.resolve({ html: '<html></html>', url, title: 'Item', statusCode: 200 });
      }),
      scrapePageStealth: jest.fn(),
    });
    clock.setFloorSource(host => q.storeHostFloorMs(host));

    const profiles = buildProfileRegistry(registry.allStores());
    const getRulesetForUrl = (url: string) => registry.getRulesetForUrl(url);
    const callerOf = (url: string): HostClockCaller => {
      const path = new URL(url).pathname;
      if (path.startsWith('/browse')) return 'catalogListing';
      if (path.startsWith('/top')) return 'catalogSeed';
      if (path.startsWith('/companies')) return 'catalogRotating';
      if (path.startsWith('/search')) return 'lookup';
      return 'resolve';
    };
    const catalogServices: CatalogServices = {
      profiles,
      getRulesetForUrl,
      fetchSearch: async () => '',
      fetchSearchDetail: (url: string) => {
        stamp(callerOf(url), url);
        return Promise.resolve({ body: '<html>listing</html>', status: 200 });
      },
    };
    const catalog = assembleCatalog(catalogServices);
    const lookup = assembleLookup(catalogServices);
    const resolve = assembleResolve({
      profiles,
      getRulesetForUrl,
      fetchDetail: (url: string) => {
        stamp('resolve', url);
        return Promise.resolve({ html: '<html>item</html>', statusCode: 200 });
      },
    });
    const images = paceImageBytesByHost(
      async (url: string): Promise<ImageBytesResult> => {
        stamp('image', url);
        return { ok: true, bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]), contentType: 'image/png', status: 200, finalUrl: url, headers: {} };
      },
      new HostRateLimiter(() => undefined),
      { cooldown: { remaining: () => 0 } },
    );
    mockScrapeGeneric.mockImplementation(async (url: string) => {
      stamp('scrape', url);
      return { name: 'x' };
    });
    const fetchBodyContext = (primaryUrl: string) =>
      buildExtractContext({
        config: stores[0] as SiteConfig,
        logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as any,
        scraping: { scrapePage: jest.fn(), scrapePageStealth: jest.fn() } as any,
        capturingFetch: (url: string) => {
          stamp('fetchBody', url);
          return Promise.resolve({ html: '{}', status: 200 });
        },
        searchFetch: undefined,
        primaryUrl,
        primaryFetchedAt: Date.now(),
        baseDelayMs: 0,
      });
    const scrape = (url: string) => scrapeOnHostClock(url, { selectors: {} });
    return { clock, wire, q, catalog, lookup, resolve, images, scrape, fetchBodyContext };
  }

  const mfcWire = (wire: Wire[]) => wire.filter(w => new URL(w.url).hostname === MFC);

  /** Every caller once, interleaved with queue records and images; idle pauses let the queue in. */
  async function everyCaller(r: ReturnType<typeof rig>) {
    for (let i = 1; i <= 4; i++) r.q.enqueue(`m${i}`, { priority: i === 1 ? 'HOT' : i === 2 ? 'WARM' : 'COLD', url: `https://${MFC}/item/${100 + i}` });
    const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
    const chain = (async () => {
      const results: unknown[] = [];
      results.push(await r.catalog.catalog('mfc', 1));
      results.push(await r.catalog.seed('mfc', 'top'));
      await pause(9000);
      results.push(await r.catalog.rotatingSeed('mfc', 'co-1'));
      results.push(await r.resolve.resolve('mfc', ['1', '2', '3']));
      await pause(9000);
      results.push(await r.scrape(`https://${MFC}/item/9`));
      results.push(await r.images(`https://${MFC}/?_tb=commit&commit=nsp&objectType=item&objectId=1&size=1`));
      results.push(await r.fetchBodyContext(`https://${MFC}/item/1`).scraping.fetchBody!(`https://${MFC}/api/item/1`));
      results.push(await r.images(`https://${MFC}/?_tb=commit&commit=nsp&objectType=item&objectId=1&size=2`));
      return results;
    })();
    const results = await drive(chain, 400_000);
    await advance(60_000);
    return results;
  }

  it('ON: queue, images, /catalog listing, seed, rotating, /resolve x3, /scrape and fetchBody are never closer than 7000 ms at the transport', async () => {
    const r = rig();
    const results = await everyCaller(r);
    expect(results.slice(0, 3).map(x => (x as { status: string }).status)).toEqual(['ok', 'ok', 'ok']);
    expect((results[3] as { results: unknown[] }).results).toHaveLength(3);
    const wire = mfcWire(r.wire);
    const callersSeen = new Set(wire.map(w => w.caller));
    expect([...callersSeen].sort()).toEqual(['catalogListing', 'catalogRotating', 'catalogSeed', 'fetchBody', 'image', 'queue', 'resolve', 'scrape']);
    expect(wire.filter(w => w.caller === 'queue')).toHaveLength(4);
    expect(Math.min(...gaps(wire.map(w => w.at)))).toBeGreaterThanOrEqual(FLOOR);
    // The queue really interleaved with the blocking callers (it was not simply left to the end).
    const order = [...wire].sort((a, b) => a.at - b.at).map(w => w.caller);
    expect(order.indexOf('queue')).toBeLessThan(order.lastIndexOf('resolve'));
    const [mfc] = r.clock.view(Date.now()).hosts;
    expect(mfc.underFloor60m).toBe(0);
    expect(mfc.minGapMs60m).toBeGreaterThanOrEqual(FLOOR);
    for (const caller of ['queue', 'image', 'catalogListing', 'catalogSeed', 'catalogRotating', 'resolve', 'scrape', 'fetchBody'] as const) {
      expect(mfc.sends60m[caller]).toBe(wire.filter(w => w.caller === caller).length);
    }
    expect(Object.values(mfc.clockRefusals60m).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("every caller's recorded send instant is its record() instant, at or after the transport's invocation", async () => {
    const r = rig({ delayMs: () => 1 });
    const recorded: Array<{ caller: HostClockCaller; at: number }> = [];
    const recordSend = r.clock.recordSend.bind(r.clock);
    jest.spyOn(r.clock, 'recordSend').mockImplementation((host, caller, at) => {
      if (host === MFC) recorded.push({ caller, at });
      recordSend(host, caller, at);
    });
    await everyCaller(r);
    const wire = mfcWire(r.wire).sort((a, b) => a.at - b.at);
    expect(recorded.map(x => x.caller)).toEqual(wire.map(w => w.caller));
    // With 1 ms of synchronous work before each transport entry, the stamp IS the entry instant.
    expect(recorded.map(x => x.at)).toEqual(wire.map(w => w.at));
  });

  it.each([
    ['a 1 ms synchronous delay', 1],
    ['a 1,500 ms hand-off delay', 1500],
  ])('%s before EVERY caller\'s transport entry leaves no transport-side gap under the floor', async (_name, delay) => {
    const r = rig({ delayMs: () => delay });
    await everyCaller(r);
    const wire = mfcWire(r.wire);
    // 4 records, 2 images, listing, seed, rotating, 3 resolves, scrape, fetchBody.
    expect(wire).toHaveLength(14);
    expect(Math.min(...gaps(wire.map(w => w.at)))).toBeGreaterThanOrEqual(FLOOR);
  });

  it.each([
    ['queue', 1500], ['image', 1500], ['catalogListing', 1500], ['resolve', 1500], ['scrape', 1], ['fetchBody', 1], ['catalogSeed', 1], ['catalogRotating', 1500],
  ] as const)('a delay before only the %s transport (%d ms) leaves no transport-side gap under floor + that send\'s jitter (J = 2000)', async (who, delay) => {
    const drawn: number[] = [];
    const base = deriveStream(4242, MFC, 'jitter');
    const r = rig({
      clock: { jitterMs: host => (host === MFC ? 2000 : 0), jitterRng: () => () => { const v = base(); drawn.push(v); return v; } },
      delayMs: caller => (caller === who ? delay : 0),
    });
    await everyCaller(r);
    const times = mfcWire(r.wire).map(w => w.at).sort((a, b) => a - b);
    // One draw per send, in send order: send k's jitter spaces send k+1.
    expect(drawn).toHaveLength(times.length);
    for (let k = 1; k < times.length; k++) {
      expect(times[k] - times[k - 1]).toBeGreaterThanOrEqual(FLOOR + Math.floor(drawn[k - 1] * 2000));
    }
  });

  it('J = 2000 with the clock binding: every gap in [7000, 9000) and meanConstrainedGapMs60m within 5 % of 8000', async () => {
    const r = rig({ clock: { jitterMs: host => (host === MFC ? 2000 : 0), seed: 20261007 } });
    for (let i = 1; i <= 90; i++) r.q.enqueue(`m${i}`, { priority: 'WARM', url: `https://${MFC}/item/${i}` });
    const chain = (async () => {
      for (let p = 1; p <= 20; p++) await r.catalog.catalog('mfc', p);
    })();
    await drive(chain, 400_000, 2000);
    await advance(800_000, 2000);
    const wire = mfcWire(r.wire);
    expect(wire.length).toBe(110);
    const all = gaps(wire.map(w => w.at));
    expect(Math.min(...all)).toBeGreaterThanOrEqual(7000);
    expect(Math.max(...all)).toBeLessThan(9000);
    const [mfc] = r.clock.view(Date.now()).hosts;
    expect(mfc.constrainedGaps60m).toBeGreaterThan(100);
    expect(Math.abs(mfc.meanConstrainedGapMs60m - 8000)).toBeLessThanOrEqual(400);
    expect(mfc.sends60m.catalogListing).toBe(20);
    expect(mfc.sends60m.queue).toBe(90);
  }, 120_000);

  it('OFF (the default): /catalog, /resolve and /scrape go at once, the observer still records every caller, and a listing interleaved with queue records is under the floor (the negative control)', async () => {
    const r = rig({ scope: 'off' });
    r.q.enqueue('m1', { priority: 'WARM', url: `https://${MFC}/item/1` });
    await advance(500);
    const t0 = Date.now();
    await drive(r.catalog.catalog('mfc', 1), 1000);
    await drive(r.resolve.resolve('mfc', ['5']), 1000);
    await drive(r.scrape(`https://${MFC}/item/9`), 1000);
    await drive(r.catalog.seed('mfc', 'top'), 1000);
    await drive(r.catalog.rotatingSeed('mfc', 'co-1'), 1000);
    await drive(r.fetchBodyContext(`https://${MFC}/item/1`).scraping.fetchBody!(`https://${MFC}/api/1`), 1000);
    const blocking = mfcWire(r.wire).filter(w => w.caller !== 'queue');
    // Unpaced, as today: every one of them left in the same instant.
    expect(blocking.map(w => w.at)).toEqual(blocking.map(() => t0));
    const [mfc] = r.clock.view(Date.now()).hosts;
    expect(mfc.clocked).toBe(false);
    expect(mfc.sends60m).toMatchObject({ queue: 1, catalogListing: 1, catalogSeed: 1, catalogRotating: 1, resolve: 1, scrape: 1, fetchBody: 1 });
    expect(mfc.underFloor60m).toBeGreaterThan(0);
    expect(mfc.constrainedGaps60m).toBe(0);
  });

  it('/lookup on a clocked bySearch host (floor 7000) reserves and is spaced from that host\'s queue records', async () => {
    const shop = store('shop', 'shop.example', FLOOR, { bySearch: { urlTemplate: 'https://shop.example/search?q={q}' } });
    const r = rig({ scope: 'all', stores: [shop] });
    r.q.enqueue('s1', { priority: 'WARM', url: 'https://shop.example/item/1' });
    await advance(500);
    const out = await drive(r.lookup.lookup('figure'), 20_000);
    expect(out.results).toHaveLength(1);
    const times = r.wire.filter(w => new URL(w.url).hostname === 'shop.example');
    expect(times.map(w => w.caller)).toEqual(['queue', 'lookup']);
    expect(times[1].at - times[0].at).toBe(FLOOR);
    expect(r.clock.view(Date.now()).hosts[0].sends60m.lookup).toBe(1);
  });

  it('an anitoys-like host (floor 20000, J 0) with a busy queue: every listing page of the pass, zero refusals, wait + fetch timeout <= 60000 on every call', async () => {
    const anitoys = store('anitoys', 'anitoys.example', 20_000);
    const pass = async (scope: string) => {
      const r = rig({ scope, stores: [anitoys] });
      for (let i = 1; i <= 12; i++) r.q.enqueue(`a${i}`, { priority: 'WARM', url: `https://anitoys.example/item/${i}` });
      await advance(500);
      const timeouts: number[] = [];
      const withTimeout = lookupModule.withTimeout;
      const spy = jest.spyOn(lookupModule, 'withTimeout').mockImplementation((work, ms, what) => {
        timeouts.push(ms);
        return withTimeout(work, ms, what);
      });
      const starts: number[] = [];
      const pages = (async () => {
        const out: string[] = [];
        for (let p = 1; p <= 5; p++) {
          starts.push(Date.now());
          out.push((await r.catalog.catalog('anitoys', p)).status);
        }
        return out;
      })();
      const statuses = await drive(pages, 400_000);
      spy.mockRestore();
      r.q.stop();
      r.q.clear();
      const listing = r.wire.filter(w => w.caller === 'catalogListing').map(w => w.at);
      return { statuses, timeouts, starts, listing, view: r.clock.view(Date.now()) };
    };
    const off = await pass('off');
    const on = await pass('all');
    expect(on.statuses).toEqual(off.statuses);
    expect(on.statuses).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    const host = on.view.hosts.find(h => h.host === 'anitoys.example')!;
    expect(Object.values(host.clockRefusals60m).reduce((a, b) => a + b, 0)).toBe(0);
    on.listing.forEach((sentAt, i) => {
      const waited = sentAt - on.starts[i];
      expect(waited).toBeLessThanOrEqual(20_000 + 3000);
      expect(waited + on.timeouts[i]).toBeLessThanOrEqual(60_000);
      expect(on.timeouts[i]).toBe(60_000 - waited);
    });
    // The clock really bound: at least one listing waited for the queue.
    expect(Math.max(...on.listing.map((t, i) => t - on.starts[i]))).toBeGreaterThan(0);
  });

  it('two stacked blocking reservations beyond the cap: the second is refused as a cooldown, sends nothing, and is counted under its caller', async () => {
    const r = rig();
    r.q.enqueue('m1', { priority: 'WARM', url: `https://${MFC}/item/1` });
    await advance(500);
    const [first, second] = await drive(Promise.all([r.catalog.catalog('mfc', 1), r.catalog.seed('mfc', 'top')]), 20_000);
    expect(first.status).toBe('ok');
    expect(second).toMatchObject({ status: 'cooldown', siteId: 'mfc', host: MFC });
    expect(mfcWire(r.wire).map(w => w.caller)).toEqual(['queue', 'catalogListing']);
    const [mfc] = r.clock.view(Date.now()).hosts;
    expect(mfc.clockRefusals60m).toEqual(Object.fromEntries(HOST_CLOCK_CALLERS.map(c => [c, c === 'catalogSeed' ? 1 : 0])));
  });

  it("a sugotoys-like bySearch host (floor 45000) is excluded from blocking callers under 'all', logged at boot, and its /lookup is RECORDED so the queue's next record waits a full floor", async () => {
    const sugo = store('sugotoys', 'sugotoys.example', 45_000, { bySearch: { urlTemplate: 'https://sugotoys.example/search?q={q}' } });
    const r = rig({ scope: 'all', stores: [sugo] });
    expect(r.clock.bootLines(['sugotoys.example'])[1]).toContain('sugotoys.example (floor 45000 ms)');
    r.q.enqueue('s1', { priority: 'WARM', url: 'https://sugotoys.example/item/1' });
    await advance(500);
    jest.setSystemTime(Date.now() + 1500);
    await drive(r.lookup.lookup('figure'), 1000);
    r.q.enqueue('s2', { priority: 'WARM', url: 'https://sugotoys.example/item/2' });
    await advance(100_000);
    const times = r.wire.filter(w => new URL(w.url).hostname === 'sugotoys.example');
    expect(times.map(w => w.caller)).toEqual(['queue', 'lookup', 'queue']);
    // Recorded, not waited: the lookup went 2000 ms after the record (under its floor) ...
    expect(times[1].at - times[0].at).toBe(2000);
    // ... and the queue's next record waited a full floor after the lookup.
    expect(times[2].at - times[1].at).toBe(45_000);
  });

  it("'all,-host' clocks a store host first seen after boot and leaves the excluded one unpaced", async () => {
    const hpoi = store('hpoi', 'hpoi.example', 3000);
    const late = store('late', 'late.example', FLOOR);
    const r = rig({ scope: 'all,-hpoi.example', stores: [hpoi, late] });
    r.q.enqueue('h1', { priority: 'WARM', url: 'https://hpoi.example/item/1' });
    r.q.enqueue('l1', { priority: 'WARM', url: 'https://late.example/item/1' });
    await advance(500);
    await drive(r.catalog.catalog('hpoi', 1), 1000);
    await drive(r.catalog.catalog('late', 1), 20_000);
    const byHost = (h: string) => r.wire.filter(w => new URL(w.url).hostname === h).map(w => w.at);
    expect(gaps(byHost('hpoi.example'))).toEqual([500]);
    expect(gaps(byHost('late.example'))).toEqual([FLOOR]);
  });

  it("under 'all' a CDN or static image host keeps its own limiter: never on the clock", async () => {
    const r = rig({ scope: 'all' });
    await drive(r.images('https://static.myfigurecollection.net/upload/1.jpg'), 1000);
    await drive(r.images('https://static.myfigurecollection.net/upload/2.jpg'), 10_000);
    expect(r.clock.floorFor('static.myfigurecollection.net')).toBeUndefined();
    expect(r.clock.view(Date.now()).hosts.map(h => h.host)).not.toContain('static.myfigurecollection.net');
  });
});
