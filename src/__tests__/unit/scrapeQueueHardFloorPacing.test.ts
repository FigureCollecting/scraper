/**
 * TDD (red first) — per-store DIFFERENTIATED pacing (two knobs, fail-safe preserved).
 *
 * Before this change hostBaseDelayMs was `max(declared ?? floor, floor)` with floor = 4000 ms
 * (SCRAPER_HOST_BASE_DELAY_MS): a store's declared rateLimit.baseDelayMs could only pace it
 * SLOWER than 4000 ms — a clean JSON-API store could not run faster without lowering the global
 * floor for EVERY host. This suite pins the new two-knob model:
 *
 *   - SCRAPER_HOST_BASE_DELAY_MS  = the DEFAULT applied to a host that DECLARES NO rate (no resolved
 *     profile). Unchanged budget-safety for the common case: unset/garbage → 4000 ms.
 *   - SCRAPER_HOST_HARD_FLOOR_MS  = an ABSOLUTE minimum clamping EVERY host, including deliberately
 *     declared ones (typo/misconfig protection). Unset/garbage/<=0 → 1000 ms, never 0/no-pacing.
 *
 *   effective = declared != null ? max(declared, hardFloor) : max(default, hardFloor)
 *
 * So: undeclared → default (4000, UNCHANGED); declared → its OWN value clamped to the hard floor
 * (can now be BELOW 4000 — the differentiation); a mis-declared fast value clamps UP to the floor.
 *
 * Fake timers throughout (the SAME pattern as scrapeQueuePrimaryPacing.test.ts /
 * scrapeQueueHostPacing.test.ts) — no real sleeps, no live fetches.
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
          extractedAt: '2026-09-02T00:00:00.000Z',
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

describe('ScrapeQueue — per-store differentiated pacing (hard floor + declared-governs)', () => {
  let queue: ScrapeQueue;
  const BASE_ENV = 'SCRAPER_HOST_BASE_DELAY_MS';
  const HARD_ENV = 'SCRAPER_HOST_HARD_FLOOR_MS';
  let savedBase: string | undefined;
  let savedHard: string | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ advanceTimers: true });
    savedBase = process.env[BASE_ENV];
    savedHard = process.env[HARD_ENV];
    delete process.env[BASE_ENV];
    delete process.env[HARD_ENV];
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
    if (savedBase === undefined) delete process.env[BASE_ENV]; else process.env[BASE_ENV] = savedBase;
    if (savedHard === undefined) delete process.env[HARD_ENV]; else process.env[HARD_ENV] = savedHard;
    resetScrapeQueue();
    jest.useRealTimers();
  });

  async function advanceAndFlush(ms: number, iterations: number = 4) {
    for (let i = 0; i < iterations; i++) {
      jest.advanceTimersByTime(Math.ceil(ms / iterations));
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

  // ---- (2) differentiation: a store's DECLARED delay governs, BELOW the 4000ms default ----------
  it('paces the SAME host at its DECLARED 1000ms — below the 4000ms undeclared default — so a clean-API store runs faster', async () => {
    const { scraping } = makeQueue([{ siteId: 'host-a', domain: 'host-a.test', baseDelayMs: 1000 }]);

    queue.enqueue('a1', { priority: 'WARM', url: 'https://host-a.test/item/a1' });
    queue.enqueue('a2', { priority: 'WARM', url: 'https://host-a.test/item/a2' });

    await advanceAndFlush(300);
    expect(scraping.scrapePage).toHaveBeenCalledTimes(1); // a1 dispatches immediately

    await advanceAndFlush(200); // still comfortably under the declared 1000ms → a2 held
    expect(scraping.scrapePage).toHaveBeenCalledTimes(1);

    // Past the store's declared 1000ms but FAR under the 4000ms default: the OLD max(declared,4000)
    // model would still be holding a2 here. It dispatches instead.
    await advanceAndFlush(700); // now past the declared 1000ms, still << 4000ms
    expect(scraping.scrapePage).toHaveBeenCalledTimes(2);
    expect(scraping.scrapePage.mock.calls[1][0]).toBe('https://host-a.test/item/a2');
  });

  it('paces the SAME host at a DECLARED 2500ms — proving the declared value governs across the fast band, NOT the hard floor (1000) and NOT the default (4000)', async () => {
    const { scraping } = makeQueue([{ siteId: 'host-a', domain: 'host-a.test', baseDelayMs: 2500 }]);

    queue.enqueue('a1', { priority: 'WARM', url: 'https://host-a.test/item/a1' });
    queue.enqueue('a2', { priority: 'WARM', url: 'https://host-a.test/item/a2' });

    await advanceAndFlush(300);
    expect(scraping.scrapePage).toHaveBeenCalledTimes(1);

    // Past the 1000ms hard floor but under the declared 2500ms: if the declared value were wrongly
    // clamped DOWN to the hard floor, a2 would already be out. It must still be held.
    await advanceAndFlush(1500); // total ~1800 (>1000, <2500)
    expect(scraping.scrapePage).toHaveBeenCalledTimes(1);

    // Past the declared 2500ms but under the 4000ms default: dispatches (proving declared, not default).
    await advanceAndFlush(1000); // total ~2800 > 2500
    expect(scraping.scrapePage).toHaveBeenCalledTimes(2);
    expect(scraping.scrapePage.mock.calls[1][0]).toBe('https://host-a.test/item/a2');
  });

  // ---- (3) typo protection: a mis-declared FAST value clamps UP to the hard floor ---------------
  it('clamps a mis-declared 40ms UP to the 1000ms hard floor — never honors the typo, never the 4000ms default', async () => {
    const { scraping } = makeQueue([{ siteId: 'host-a', domain: 'host-a.test', baseDelayMs: 40 }]);

    queue.enqueue('a1', { priority: 'WARM', url: 'https://host-a.test/item/a1' });
    queue.enqueue('a2', { priority: 'WARM', url: 'https://host-a.test/item/a2' });

    // By this point a2 must NOT have gone: if the 40ms typo were honored it would have fired almost
    // immediately (well before a1's dispatch clock advanced this far).
    await advanceAndFlush(300);
    expect(scraping.scrapePage).toHaveBeenCalledTimes(1);

    await advanceAndFlush(200); // still under the 1000ms hard floor → held (the 40ms typo is not honored)
    expect(scraping.scrapePage).toHaveBeenCalledTimes(1);

    // Past the 1000ms hard floor: a2 dispatches (clamped to the floor, not the 4000ms default).
    await advanceAndFlush(700); // now past the 1000ms hard floor, still << 4000ms
    expect(scraping.scrapePage).toHaveBeenCalledTimes(2);
    expect(scraping.scrapePage.mock.calls[1][0]).toBe('https://host-a.test/item/a2');
  });

  // ---- (1) fail-safe UNCHANGED: an undeclared host keeps the budget-safe 4000ms default ---------
  it('keeps the UNDECLARED-host fail-safe at the 4000ms default — a host with NO resolved profile is unchanged (not the sibling 1500ms, not the 1000ms floor)', async () => {
    // The registered store lives on host-a.test (declares 1500ms); the items hit a SUBDOMAIN the
    // ruleset resolves via its `.host-a.test` fallback but ProfileRegistry (exact-domain) does NOT —
    // so profiles.forHost is undefined → the DEFAULT branch (4000ms), never the declared 1500ms.
    const { scraping } = makeQueue([{ siteId: 'host-a', domain: 'host-a.test', baseDelayMs: 1500 }]);

    queue.enqueue('u1', { priority: 'WARM', url: 'https://sub.host-a.test/item/u1' });
    queue.enqueue('u2', { priority: 'WARM', url: 'https://sub.host-a.test/item/u2' });

    await advanceAndFlush(300);
    expect(scraping.scrapePage).toHaveBeenCalledTimes(1);

    // Past the sibling's 1500ms AND the 1000ms hard floor, but under 4000ms: u2 must STILL be held,
    // proving the no-profile fallback is the 4000ms default (not a faster nearby value).
    await advanceAndFlush(2200); // total ~2500 (>1500, >1000, <4000)
    expect(scraping.scrapePage).toHaveBeenCalledTimes(1);

    await advanceAndFlush(1800); // total ~4300 > 4000
    expect(scraping.scrapePage).toHaveBeenCalledTimes(2);
    expect(scraping.scrapePage.mock.calls[1][0]).toBe('https://sub.host-a.test/item/u2');
  });

  // ---- (hard-floor env) SCRAPER_HOST_HARD_FLOOR_MS raises the absolute minimum ------------------
  it('honors SCRAPER_HOST_HARD_FLOOR_MS as the absolute minimum: a 40ms declared clamps to the configured 2000ms floor', async () => {
    process.env[HARD_ENV] = '2000';
    const { scraping } = makeQueue([{ siteId: 'host-a', domain: 'host-a.test', baseDelayMs: 40 }]);

    queue.enqueue('a1', { priority: 'WARM', url: 'https://host-a.test/item/a1' });
    queue.enqueue('a2', { priority: 'WARM', url: 'https://host-a.test/item/a2' });

    await advanceAndFlush(300);
    expect(scraping.scrapePage).toHaveBeenCalledTimes(1);

    // Past the DEFAULT 1000ms hard floor but under the CONFIGURED 2000ms: if the env were ignored
    // a2 would have dispatched at ~1000ms. It is held to the configured floor instead.
    await advanceAndFlush(1200); // total ~1500 (>1000, <2000)
    expect(scraping.scrapePage).toHaveBeenCalledTimes(1);

    await advanceAndFlush(900); // total ~2400 > 2000
    expect(scraping.scrapePage).toHaveBeenCalledTimes(2);
    expect(scraping.scrapePage.mock.calls[1][0]).toBe('https://host-a.test/item/a2');
  });

  // ---- (4) fail-safe env parsing: garbage / <=0 → default hard floor, NEVER 0/no-pacing ---------
  it('falls back to the 1000ms default hard floor when SCRAPER_HOST_HARD_FLOOR_MS is garbage — never 0/no-pacing', async () => {
    process.env[HARD_ENV] = 'not-a-number';
    const { scraping } = makeQueue([{ siteId: 'host-a', domain: 'host-a.test', baseDelayMs: 40 }]);

    queue.enqueue('a1', { priority: 'WARM', url: 'https://host-a.test/item/a1' });
    queue.enqueue('a2', { priority: 'WARM', url: 'https://host-a.test/item/a2' });

    // Garbage env must NOT disable pacing: a2 is NOT out at ~300ms (the 40ms declared is clamped).
    await advanceAndFlush(300);
    expect(scraping.scrapePage).toHaveBeenCalledTimes(1);

    await advanceAndFlush(900); // total ~1200 > 1000 default hard floor
    expect(scraping.scrapePage).toHaveBeenCalledTimes(2);
    expect(scraping.scrapePage.mock.calls[1][0]).toBe('https://host-a.test/item/a2');
  });

  it('falls back to the 1000ms default hard floor when SCRAPER_HOST_HARD_FLOOR_MS is "0" (<=0) — never disables the clamp', async () => {
    process.env[HARD_ENV] = '0';
    const { scraping } = makeQueue([{ siteId: 'host-a', domain: 'host-a.test', baseDelayMs: 40 }]);

    queue.enqueue('a1', { priority: 'WARM', url: 'https://host-a.test/item/a1' });
    queue.enqueue('a2', { priority: 'WARM', url: 'https://host-a.test/item/a2' });

    await advanceAndFlush(300);
    expect(scraping.scrapePage).toHaveBeenCalledTimes(1); // NOT dispatched at ~40ms → 0 did not disable pacing

    await advanceAndFlush(900); // total ~1200 > 1000 default hard floor
    expect(scraping.scrapePage).toHaveBeenCalledTimes(2);
    expect(scraping.scrapePage.mock.calls[1][0]).toBe('https://host-a.test/item/a2');
  });

  it('paces an UNDECLARED host at the 4000ms default even when SCRAPER_HOST_BASE_DELAY_MS is garbage — the renamed knob keeps its fail-safe', async () => {
    process.env[BASE_ENV] = 'garbage';
    const { scraping } = makeQueue([{ siteId: 'host-a', domain: 'host-a.test', baseDelayMs: 1500 }]);

    queue.enqueue('u1', { priority: 'WARM', url: 'https://sub.host-a.test/item/u1' });
    queue.enqueue('u2', { priority: 'WARM', url: 'https://sub.host-a.test/item/u2' });

    await advanceAndFlush(300);
    expect(scraping.scrapePage).toHaveBeenCalledTimes(1);

    await advanceAndFlush(2200); // total ~2500 < 4000 → still held by the budget-safe default
    expect(scraping.scrapePage).toHaveBeenCalledTimes(1);

    await advanceAndFlush(1800); // total ~4300 > 4000
    expect(scraping.scrapePage).toHaveBeenCalledTimes(2);
    expect(scraping.scrapePage.mock.calls[1][0]).toBe('https://sub.host-a.test/item/u2');
  });
  // ---- (5) fail-safe: a NON-FINITE declared baseDelayMs must NOT fail OPEN (no-pacing) ----------
  // NaN ?? default = NaN (nullish coalescing catches only null/undefined), Math.max(NaN,floor) = NaN,
  // and the dispatch gate `NaN > 0` is false → the host would be paced at ZERO (fail-open, the exact
  // reputation-burn class the hard floor exists to prevent). A non-finite declared value must route
  // to the budget-safe 4000ms default, NEVER to no-pacing.
  it('routes a NON-FINITE (NaN) declared baseDelayMs to the 4000ms default — never fails OPEN to zero pacing', async () => {
    const { scraping } = makeQueue([{ siteId: 'host-a', domain: 'host-a.test', baseDelayMs: NaN }]);

    queue.enqueue('a1', { priority: 'WARM', url: 'https://host-a.test/item/a1' });
    queue.enqueue('a2', { priority: 'WARM', url: 'https://host-a.test/item/a2' });

    await advanceAndFlush(300);
    expect(scraping.scrapePage).toHaveBeenCalledTimes(1); // a1 out; a2 MUST be held (NaN must not fail open)

    // Past the 1000ms floor AND any sane fast band, but under 4000ms: a2 still held (proving the
    // non-finite value fell back to the budget-safe default, not to zero pacing).
    await advanceAndFlush(2200); // total ~2500 (>1000, <4000)
    expect(scraping.scrapePage).toHaveBeenCalledTimes(1);

    await advanceAndFlush(1800); // total ~4300 > 4000
    expect(scraping.scrapePage).toHaveBeenCalledTimes(2);
    expect(scraping.scrapePage.mock.calls[1][0]).toBe('https://host-a.test/item/a2');
  });

  // ---- (5) fail-safe: an INFINITE declared baseDelayMs must NOT deadlock the host ---------------
  // Math.max(Infinity,floor) = Infinity, and the gate `remaining = last + Infinity - now` stays > 0
  // forever → the host would NEVER dispatch again (a self-inflicted permanent stall). A non-finite
  // declared value must route to the 4000ms default so the host keeps making progress.
  it('routes an INFINITE declared baseDelayMs to the 4000ms default — never deadlocks the host', async () => {
    const { scraping } = makeQueue([{ siteId: 'host-a', domain: 'host-a.test', baseDelayMs: Infinity }]);

    queue.enqueue('a1', { priority: 'WARM', url: 'https://host-a.test/item/a1' });
    queue.enqueue('a2', { priority: 'WARM', url: 'https://host-a.test/item/a2' });

    await advanceAndFlush(300);
    expect(scraping.scrapePage).toHaveBeenCalledTimes(1); // a1 out (first item, no prior dispatch)

    // Under the 4000ms default a2 is held; past it a2 MUST dispatch (Infinity would deadlock forever).
    await advanceAndFlush(2200); // total ~2500 < 4000 → still held
    expect(scraping.scrapePage).toHaveBeenCalledTimes(1);

    await advanceAndFlush(1800); // total ~4300 > 4000 → a2 dispatches (no deadlock)
    expect(scraping.scrapePage).toHaveBeenCalledTimes(2);
    expect(scraping.scrapePage.mock.calls[1][0]).toBe('https://host-a.test/item/a2');
  });

});
