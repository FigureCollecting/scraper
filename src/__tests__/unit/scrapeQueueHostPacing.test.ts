/**
 * TDD (red first) — H1: live-queue per-host pacing (spec.md orzgk Slice B D8, §4 Rate row,
 * §6 B6 H1). Today processNext paces only the GLOBAL lane on `currentDelay`, so two items for
 * the SAME host are separated only by that shared delay — the store's own declared
 * `rateLimit.baseDelayMs` (the store-caps index the ingest path already builds from
 * setPluginRegistry) is never consulted for spacing between successive dispatches to the same
 * host. These tests add a per-host floor: a host whose baseDelayMs exceeds the current global
 * lane delay must still be respected; a different, never-touched host must NOT be penalized by
 * another host's floor; and a HOT item whose host is paced must not block a WARM item for a
 * ready, different host (ordering preserved BETWEEN other hosts under deferral).
 *
 * Fake timers throughout (jest.useFakeTimers({ advanceTimers: true }), the SAME pattern already
 * used by scrapeQueueProcessing.test.ts) — no real sleeps, no live fetches.
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
import { okWriteStats } from '../helpers/ingestWriteStats';

interface SiteSpec {
  siteId: string;
  domain: string;
  baseDelayMs: number;
}

/** Registry with N sites, each on its own domain and its own declared baseDelayMs. */
function makeMultiHostRegistry(sites: SiteSpec[]): ExtractionRegistryImpl {
  const registry = createExtractionRegistry();
  for (const s of sites) {
    registry.registerSite({
      siteId: s.siteId,
      name: s.siteId,
      domains: [s.domain],
      rateLimit: {
        domain: s.domain,
        baseDelayMs: s.baseDelayMs,
        minDelayMs: 100,
        maxDelayMs: 60000,
        backoffMultiplier: 1.5,
        recoveryDivisor: 1.5,
        successThreshold: 3,
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
          extractedAt: '2026-08-19T00:00:00.000Z',
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

function makeScrapingStub() {
  return {
    scrapePage: jest.fn().mockImplementation((url: string) =>
      Promise.resolve({ html: '<html></html>', url, title: 'Item', statusCode: 200 }),
    ),
    scrapePageStealth: jest.fn().mockImplementation((url: string) =>
      Promise.resolve({ html: '<html></html>', url, title: 'Item', statusCode: 200 }),
    ),
  };
}

describe('ScrapeQueue — live queue per-host pacing (H1)', () => {
  let queue: ScrapeQueue;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ advanceTimers: true });
    resetScrapeQueue();
    mockNotifyItemSuccess.mockResolvedValue(true);
    mockNotifyItemFailed.mockResolvedValue(true);
    mockNotifyItemSkipped.mockResolvedValue(true);
  });

  afterEach(() => {
    if (queue) {
      queue.stop();
      queue.clear();
    }
    resetScrapeQueue();
    jest.useRealTimers();
  });

  async function advanceAndFlush(ms: number, iterations: number = 3) {
    for (let i = 0; i < iterations; i++) {
      jest.advanceTimersByTime(ms / iterations);
      await jest.advanceTimersByTimeAsync(50);
    }
  }

  function makeQueue(sites: SiteSpec[]) {
    const scraping = makeScrapingStub();
    const send = jest.fn().mockResolvedValue(okWriteStats());
    queue = new ScrapeQueue(false);
    queue.setPluginRegistry(makeMultiHostRegistry(sites));
    queue.setIngestEmitter({ send });
    queue.setScrapingService(scraping);
    return { scraping, send };
  }

  it('defers the SECOND item for the SAME host until the store baseDelayMs has elapsed, even though the global lane delay is shorter', async () => {
    // Store declares a 5000ms floor — well above the default global lane delay (2067ms).
    const { scraping } = makeQueue([{ siteId: 'host-a', domain: 'host-a.test', baseDelayMs: 5000 }]);

    queue.enqueue('a1', { priority: 'WARM', url: 'https://host-a.test/item/a1' });
    queue.enqueue('a2', { priority: 'WARM', url: 'https://host-a.test/item/a2' });

    // First item dispatches immediately (lastRequestTime starts at 0 — always past due).
    await advanceAndFlush(100);
    expect(scraping.scrapePage).toHaveBeenCalledTimes(1);

    // Global lane's own delay (2067ms) has now elapsed — a global-lane-only implementation would
    // dispatch item 2 here. The store's 5000ms floor must still hold it back.
    await advanceAndFlush(2200);
    expect(scraping.scrapePage).toHaveBeenCalledTimes(1);

    // Once the store's declared 5000ms has elapsed since item 1's dispatch, item 2 may proceed.
    await advanceAndFlush(3200);
    expect(scraping.scrapePage).toHaveBeenCalledTimes(2);
    expect(scraping.scrapePage.mock.calls[1][0]).toBe('https://host-a.test/item/a2');
  });

  it('does NOT penalize a different, never-touched host by another host\'s floor (independent per-host pacing, no global blanket — D-11)', async () => {
    const { scraping } = makeQueue([
      { siteId: 'host-a', domain: 'host-a.test', baseDelayMs: 5000 },
      { siteId: 'host-b', domain: 'host-b.test', baseDelayMs: 1000 },
    ]);

    queue.enqueue('a1', { priority: 'WARM', url: 'https://host-a.test/item/a1' });
    queue.enqueue('b1', { priority: 'WARM', url: 'https://host-b.test/item/b1' });

    // D-11: primary dispatch paces PER-HOST with NO global blanket, so host-b (never dispatched to)
    // is NOT held behind host-a — both dispatch promptly, well inside the retired 2067ms global
    // lane's window. host-a's 5000ms floor must not leak onto host-b.
    await advanceAndFlush(600);
    expect(scraping.scrapePage).toHaveBeenCalledTimes(2);
    const urls = scraping.scrapePage.mock.calls.map((c: any[]) => c[0]).sort();
    expect(urls).toEqual(['https://host-a.test/item/a1', 'https://host-b.test/item/b1']);
  });

  it('a HOT item whose host is still paced does not block a WARM item for a different, ready host', async () => {
    const { scraping } = makeQueue([
      { siteId: 'host-a', domain: 'host-a.test', baseDelayMs: 5000 },
      { siteId: 'host-b', domain: 'host-b.test', baseDelayMs: 500 },
    ]);

    // Prime host-a's pacing clock with an initial dispatch.
    queue.enqueue('a0', { priority: 'WARM', url: 'https://host-a.test/item/a0' });
    await advanceAndFlush(100);
    expect(scraping.scrapePage).toHaveBeenCalledTimes(1);

    // Global lane clears at +2067ms. At that point queue a HOT item for the still-paced host-a
    // (needs the full 5000ms from a0's dispatch) alongside a WARM item for the ready host-b.
    await advanceAndFlush(2100);
    queue.enqueue('a1', { priority: 'HOT', url: 'https://host-a.test/item/a1' });
    queue.enqueue('b1', { priority: 'WARM', url: 'https://host-b.test/item/b1' });

    // host-a's HOT item cannot dispatch yet (only ~2200ms since a0 < 5000ms floor); the WARM
    // host-b item, whose host has never been touched, must be free to go instead.
    await advanceAndFlush(100);
    expect(scraping.scrapePage).toHaveBeenCalledTimes(2);
    expect(scraping.scrapePage.mock.calls[1][0]).toBe('https://host-b.test/item/b1');

    // host-a's HOT item still lands once its own floor clears.
    await advanceAndFlush(3000);
    await advanceAndFlush(3000);
    expect(scraping.scrapePage).toHaveBeenCalledTimes(3);
    expect(scraping.scrapePage.mock.calls[2][0]).toBe('https://host-a.test/item/a1');
  });

  it("falls back to DEFAULT_FETCH_BODY_GAP_MS (2000ms) — not the store's declared baseDelayMs — when the item's host has no resolved store profile, even though its ruleset matched via the subdomain fallback", async () => {
    // The registered store's declared floor is 5000ms, but the items below hit a SUBDOMAIN
    // ('sub.host-a.test') that extractionRegistry's own subdomain fallback resolves to the
    // 'host-a' ruleset, while ProfileRegistry's byHost index (exact-domain only, no subdomain
    // wildcard) does NOT resolve it — so profiles.forHost('sub.host-a.test') is undefined and
    // hostBaseDelayMs() must take the `?? DEFAULT_FETCH_BODY_GAP_MS` branch, not the 5000ms one.
    const { scraping } = makeQueue([{ siteId: 'host-a', domain: 'host-a.test', baseDelayMs: 5000 }]);

    queue.enqueue('u1', { priority: 'WARM', url: 'https://sub.host-a.test/item/u1' });
    queue.enqueue('u2', { priority: 'WARM', url: 'https://sub.host-a.test/item/u2' });

    await advanceAndFlush(100);
    expect(scraping.scrapePage).toHaveBeenCalledTimes(1); // u1 dispatches (ruleset DID match)

    // Past the DEFAULT gap (2000ms) but well short of the store's declared 5000ms floor: if the
    // fallback were wrongly reading the store's own baseDelayMs, u2 would still be blocked here.
    await advanceAndFlush(2200);
    expect(scraping.scrapePage).toHaveBeenCalledTimes(2);
    expect(scraping.scrapePage.mock.calls[1][0]).toBe('https://sub.host-a.test/item/u2');
  });

  it('treats an item with an unparseable URL as having no host — never blocks on the pacing floor, never crashes or hangs', async () => {
    makeQueue([{ siteId: 'host-a', domain: 'host-a.test', baseDelayMs: 5000 }]);

    const result = queue.enqueue('bad1', { priority: 'WARM', url: 'not a url at all', maxRetries: 0 });
    const outcome = result.promise.catch((e: Error) => e);

    await advanceAndFlush(500);

    // No ruleset matches an unparseable URL — the item fails cleanly (EXTRACTION_UNAVAILABLE)
    // rather than hanging forever behind a pacing check that can't resolve a host.
    expect(await outcome).toBeInstanceOf(Error);
  });
});
