/**
 * TDD (red first) — D-11: the PRIMARY dispatch must pace PER-HOST, retiring the global blanket
 * delay (DECISIONS-PENDING.md D-11 / PRE-INGEST-READINESS.md §4). Today processNext gates EVERY
 * dispatch behind ONE global `currentDelay` (RATE_LIMIT.BASE_DELAY = 2067 ms), so two items for
 * DIFFERENT hosts are serialized behind that shared delay even though neither host has been touched
 * — 1.7x over the measured per-host budget, against every host at once. These tests pin the fix:
 *
 *   (a) the base per-host delay is CONFIGURABLE (env SCRAPER_HOST_BASE_DELAY_MS) so the initiator
 *       can tune it (D-11 soak = 4000 ms/host), applied as a floor over a store's declared delay;
 *   (b) items for DIFFERENT hosts pace INDEPENDENTLY — they are NOT serialized behind one another
 *       by a global blanket delay (the D-11 core);
 *   (c) a cooling host is still FAST-FAILED before any fetch (no network), preserved under the new
 *       per-host pacing.
 *
 * Fake timers throughout (the SAME pattern as scrapeQueueHostPacing.test.ts / *Processing.test.ts)
 * — no real sleeps, no live fetches.
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
import { ChallengeCooldown, resetChallengeCooldown } from '../../services/challengeCooldown';
import { resetSessionManager } from '../../services/sessionManager';
import { okWriteStats } from '../helpers/ingestWriteStats';

interface SiteSpec {
  siteId: string;
  domain: string;
  baseDelayMs: number;
}

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
          extractedAt: '2026-09-01T00:00:00.000Z',
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

describe('ScrapeQueue — primary-dispatch per-host pacing (D-11)', () => {
  let queue: ScrapeQueue;
  const ENV_KEY = 'SCRAPER_HOST_BASE_DELAY_MS';
  let savedEnv: string | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ advanceTimers: true });
    savedEnv = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
    resetScrapeQueue();
    resetSessionManager();
    resetChallengeCooldown();
    mockNotifyItemSuccess.mockResolvedValue(true);
    mockNotifyItemFailed.mockResolvedValue(true);
    mockNotifyItemSkipped.mockResolvedValue(true);
  });

  afterEach(() => {
    if (queue) {
      queue.stop();
      queue.clear();
    }
    if (savedEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedEnv;
    resetScrapeQueue();
    resetSessionManager();
    resetChallengeCooldown();
    jest.useRealTimers();
  });

  async function advanceAndFlush(ms: number, iterations: number = 4) {
    for (let i = 0; i < iterations; i++) {
      jest.advanceTimersByTime(Math.ceil(ms / iterations));
      await jest.advanceTimersByTimeAsync(50);
    }
  }

  /** Advance in small steps until pred() holds or the budget elapses; returns virtual ms consumed. */
  async function advanceUntil(pred: () => boolean, stepMs = 100, maxSteps = 60): Promise<number> {
    let elapsed = 0;
    for (let i = 0; i < maxSteps && !pred(); i++) {
      jest.advanceTimersByTime(stepMs);
      await jest.advanceTimersByTimeAsync(20);
      elapsed += stepMs;
    }
    return elapsed;
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

  // ---- (b) DIFFERENT hosts pace independently — the D-11 core --------------------------------
  it('dispatches items for THREE different hosts without serializing them behind a global blanket delay', async () => {
    // Each host declares a short per-host delay. Under the OLD global blanket (2067 ms) the 2nd and
    // 3rd hosts would only dispatch at ~2067 ms and ~4134 ms; under per-host-only pacing all three
    // (each host untouched) dispatch promptly, well inside a single old-blanket window.
    const { scraping } = makeQueue([
      { siteId: 'host-a', domain: 'host-a.test', baseDelayMs: 200 },
      { siteId: 'host-b', domain: 'host-b.test', baseDelayMs: 200 },
      { siteId: 'host-c', domain: 'host-c.test', baseDelayMs: 200 },
    ]);

    queue.enqueue('a1', { priority: 'WARM', url: 'https://host-a.test/item/a1' });
    queue.enqueue('b1', { priority: 'WARM', url: 'https://host-b.test/item/b1' });
    queue.enqueue('c1', { priority: 'WARM', url: 'https://host-c.test/item/c1' });

    // Stop as soon as all three landed; the loop caps at 1500 ms of virtual time — comfortably
    // under the OLD blanket's 2nd-item wait (~2067 ms), so reaching 3 here PROVES independence.
    await advanceUntil(() => scraping.scrapePage.mock.calls.length >= 3, 100, 15);

    expect(scraping.scrapePage).toHaveBeenCalledTimes(3);
    const hosts = scraping.scrapePage.mock.calls.map((c: any[]) => new URL(c[0]).hostname).sort();
    expect(hosts).toEqual(['host-a.test', 'host-b.test', 'host-c.test']);
  });

  // ---- (a) SCRAPER_HOST_BASE_DELAY_MS is the configurable DEFAULT for an UNDECLARED host --------
  // Per-store differentiated pacing changed this knob's role: it is the DEFAULT for hosts that
  // declare no rate, NOT a floor stacked ABOVE a store's own declared delay (that would prevent a
  // clean-API store from ever running faster than the default). This test pins the surviving,
  // corrected intent — the env still CONFIGURES the per-host default — on the undeclared path.
  it('applies SCRAPER_HOST_BASE_DELAY_MS as the configurable per-host default for an UNDECLARED host (no resolved profile)', async () => {
    // The registered store lives on host-a.test; the items hit a SUBDOMAIN the ruleset resolves via
    // its `.host-a.test` fallback but ProfileRegistry (exact-domain) does NOT — so the host is
    // UNDECLARED and takes the env default (6000 ms here), not the sibling's declared 200 ms.
    process.env[ENV_KEY] = '6000';
    const { scraping } = makeQueue([{ siteId: 'host-a', domain: 'host-a.test', baseDelayMs: 200 }]);

    queue.enqueue('u1', { priority: 'WARM', url: 'https://sub.host-a.test/item/u1' });
    queue.enqueue('u2', { priority: 'WARM', url: 'https://sub.host-a.test/item/u2' });

    await advanceAndFlush(300);
    expect(scraping.scrapePage).toHaveBeenCalledTimes(1); // u1 dispatches immediately

    // Past the retired 2067 ms global blanket but under the configured 6000 ms default: u2 is held.
    await advanceAndFlush(3200);
    expect(scraping.scrapePage).toHaveBeenCalledTimes(1);

    // Once 6000 ms since u1 has elapsed, u2 proceeds — the env configured the undeclared default.
    await advanceAndFlush(3200);
    expect(scraping.scrapePage).toHaveBeenCalledTimes(2);
    expect(scraping.scrapePage.mock.calls[1][0]).toBe('https://sub.host-a.test/item/u2');
  });

  // ---- (a2) a DECLARED fast store differentiates below the default even with the env UNSET -------
  // Under the old model a store declaring a FASTER delay was forced up to the default floor; that is
  // exactly the limitation per-store differentiation removes. Now an env-unset deploy still paces
  // UNDECLARED hosts at the budget-safe 4000 ms, but a store that DECLARES its own rate is paced by
  // THAT value (clamped only to the 1000 ms hard floor), not the 4000 ms default.
  it("lets a store's DECLARED fast delay differentiate it below the 4000ms default when SCRAPER_HOST_BASE_DELAY_MS is UNSET (clamped only to the hard floor)", async () => {
    expect(process.env[ENV_KEY]).toBeUndefined();
    const { scraping } = makeQueue([{ siteId: 'host-a', domain: 'host-a.test', baseDelayMs: 2000 }]);

    queue.enqueue('a1', { priority: 'WARM', url: 'https://host-a.test/item/a1' });
    queue.enqueue('a2', { priority: 'WARM', url: 'https://host-a.test/item/a2' });

    await advanceAndFlush(300);
    expect(scraping.scrapePage).toHaveBeenCalledTimes(1); // a1 dispatches immediately

    // Past the 1000 ms hard floor but under the declared 2000 ms: a2 held (proves NOT clamped down).
    await advanceAndFlush(800);
    expect(scraping.scrapePage).toHaveBeenCalledTimes(1);

    // Past the declared 2000 ms but well under the 4000 ms default: a2 dispatches — the OLD
    // max(declared, default) model would still be holding it here.
    await advanceAndFlush(1000);
    expect(scraping.scrapePage).toHaveBeenCalledTimes(2);
    expect(scraping.scrapePage.mock.calls[1][0]).toBe('https://host-a.test/item/a2');
  });

  // ---- (c) a cooling host is fast-failed BEFORE any fetch, under the new pacing (preservation) -
  it('fast-fails a cooling host BEFORE any fetch and never lets it delay a ready different host', async () => {
    const COOL = 'cool.test';
    const cd = new ChallengeCooldown({ now: () => Date.now(), windowMs: 60_000 });
    cd.open(COOL, 'challenge page via http transport');

    const { scraping } = makeQueue([
      { siteId: 'cool', domain: COOL, baseDelayMs: 200 },
      { siteId: 'ok', domain: 'ok.test', baseDelayMs: 200 },
    ]);
    queue.setChallengeCooldown(cd);

    const cool = queue.enqueue('c1', { priority: 'WARM', url: `https://${COOL}/item/c1`, maxRetries: 0 });
    const coolOutcome = cool.promise.catch((e: Error) => e);
    queue.enqueue('o1', { priority: 'WARM', url: 'https://ok.test/item/o1' });

    await advanceUntil(() => queue.getStats().completed === 1 && queue.getStats().failed === 1, 100, 40);

    // The healthy host's item was fetched and completed; the cooling host's item was NEVER fetched.
    expect(scraping.scrapePage).toHaveBeenCalledTimes(1);
    expect(scraping.scrapePage.mock.calls[0][0]).toBe('https://ok.test/item/o1');
    expect(queue.getStats().completed).toBe(1);

    // The cooling item fast-failed (challenge_cooldown), was not retried, and rejected cleanly.
    const err = (await coolOutcome) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/challenge_cooldown/);
  });
});
