/**
 * assembleCrawlDriver — the crawl driver's end-to-end runtime. These tests drive the WHOLE chain
 * with fakes (ProfileRegistry ← allStores → scheduler → ledger → worker → loop → emit) and assert
 * the composition runs a site's items through fetch → extract → emit and records coverage. The
 * loop/throttle mechanics themselves are covered by crawlLoop.test.ts; a zero-delay rate config
 * keeps these deterministic and focused on wiring.
 */
import { assembleCrawlDriver, type CrawlDriverServices } from '../assembleCrawlDriver';
import type {
  ExtractedData,
  ExtractionRuleset,
  ScrapePageResult,
  StoreCapabilities,
} from '@figurecollecting/scraper-plugin-contract';

const AMIAMI: StoreCapabilities = {
  siteId: 'amiami',
  name: 'AmiAmi',
  domains: ['www.amiami.com'],
  // zero-delay: the assembly test is about wiring, not throttle timing.
  rateLimit: {
    domain: 'www.amiami.com',
    baseDelayMs: 0,
    minDelayMs: 0,
    maxDelayMs: 100,
    backoffMultiplier: 2,
    recoveryDivisor: 2,
    successThreshold: 3,
  },
  requiresBrowser: false,
  allowedCookies: [],
  retrieval: { byId: { urlTemplate: 'https://www.amiami.com/eng/detail/?gcode={id}', idKind: 'store-internal' } },
};

const gcodeOf = (url: string) => new URL(url).searchParams.get('gcode') as string;

const extracted = (id: string): ExtractedData => ({
  source: { site: 'amiami', itemId: id, extractedAt: '2026-08-09T00:00:00.000Z' },
  fields: { name: `fig-${id}` },
  warnings: [],
});

const ruleset = (extract: ExtractionRuleset['extract']): ExtractionRuleset => ({
  siteId: 'amiami',
  version: '1.0.0',
  extract,
  validate: () => ({ valid: true, errors: [], warnings: [] }),
});

const build = (over: Partial<CrawlDriverServices> = {}) => {
  const sends: ExtractedData[] = [];
  const services: CrawlDriverServices = {
    extraction: {
      allStores: () => [AMIAMI],
      getRulesetForUrl: () => ruleset((_html, url) => extracted(gcodeOf(url))),
    },
    scrape: jest.fn(async (url: string): Promise<ScrapePageResult> => ({ html: '<html/>', url, title: '', statusCode: 200 })),
    emit: jest.fn(async (e: ExtractedData) => { sends.push(e); return {}; }),
    now: () => 0,
    sleep: async () => {},
    capacity: { browser: 1, fetch: 2 },
    ...over,
  };
  return { services, sends, driver: assembleCrawlDriver(services) };
};

describe('assembleCrawlDriver — end-to-end crawl runtime', () => {
  it('crawls a site: resolves byId, fetches, extracts, emits, marks coverage complete', async () => {
    const { services, sends, driver } = build();

    const result = await driver.crawlSite('amiami', ['A1', 'A2', 'A3']);

    expect(services.scrape).toHaveBeenCalledTimes(3);
    expect(services.scrape).toHaveBeenCalledWith('https://www.amiami.com/eng/detail/?gcode=A1');
    expect(sends.map((e) => e.source.itemId).sort()).toEqual(['A1', 'A2', 'A3']);
    expect(result.coverage.done).toBe(3);
    expect(result.coverage.total).toBe(3);
    expect(result.complete).toBe(true);
    expect(result.stats.dispatched).toBe(3);
  });

  it('a failed extract marks that item failed (coverage incomplete); the others still emit', async () => {
    const rs = ruleset((_html, url) => {
      const id = gcodeOf(url);
      if (id === 'A2') throw new Error('parse fail');
      return extracted(id);
    });
    const { sends, driver } = build({
      extraction: { allStores: () => [AMIAMI], getRulesetForUrl: () => rs },
    });

    const result = await driver.crawlSite('amiami', ['A1', 'A2', 'A3']);

    expect(sends.map((e) => e.source.itemId).sort()).toEqual(['A1', 'A3']);
    expect(result.coverage.done).toBe(2);
    expect(result.coverage.failed).toBe(1);
    expect(result.complete).toBe(false);
  });

  it('throws for a site with no registered profile', async () => {
    const { driver } = build();
    await expect(driver.crawlSite('nope', ['x'])).rejects.toThrow(/nope/);
  });

  it('exposes the ProfileRegistry built from allStores()', () => {
    const { driver } = build();
    expect(driver.profiles.retrievalFor('www.amiami.com')?.byId?.urlTemplate).toContain('{id}');
  });

  /**
   * B3 driver parity (spec.md orzgk Slice B D7): `resolveContext` on CrawlDriverServices reaches
   * the ruleset's `extractMany` through the full assembled chain (dormant until A3 — no
   * non-test importer wires a real resolveContext yet, but the seam must reach end-to-end now).
   */
  it("passes resolveContext through to the worker, reaching a ruleset's extractMany with the resolved ExtractContext", async () => {
    const ctx = { config: {}, scraping: {}, logger: {} } as never;
    const extractMany = jest.fn((_html: string, url: string) => [extracted(gcodeOf(url))]);
    const rs: ExtractionRuleset = {
      siteId: 'amiami',
      version: '1.1',
      extract: jest.fn(() => {
        throw new Error('extract() should not run when extractMany is present');
      }),
      extractMany,
      validate: () => ({ valid: true, errors: [], warnings: [] }),
    };
    const resolveContext = jest.fn().mockReturnValue(ctx);
    const { sends, driver } = build({
      extraction: { allStores: () => [AMIAMI], getRulesetForUrl: () => rs },
      resolveContext,
    });

    const result = await driver.crawlSite('amiami', ['A1']);

    expect(resolveContext).toHaveBeenCalledWith('amiami', { id: 'A1', host: 'www.amiami.com' }, expect.any(String));
    expect(extractMany).toHaveBeenCalledWith('<html/>', expect.any(String), ctx);
    expect(sends.map((e) => e.source.itemId)).toEqual(['A1']);
    expect(result.coverage.done).toBe(1);
  });

  /**
   * H1 seam 2 (spec.md orzgk Slice B D8 follow-on): a ruleset's in-slot `ctx.scraping.fetchBody`
   * follow-up must be routed through the SAME HostRateLimiter the scheduler paces primary
   * dispatches with — otherwise the NEXT primary dispatch to that host only knows about the
   * PRIMARY fetch's timing, understating how recently the host was really hit. A single fetch-pool
   * slot serializes A1/A2 so A2's dispatch time exposes exactly what the limiter believes host-a's
   * last-contact time is. A fully deterministic virtual clock (now/sleep linked, no real timers)
   * makes the two possible outcomes (1000ms vs 1500ms) an exact, non-flaky assertion.
   */
  it("routes a ruleset's ctx.scraping.fetchBody through the HostRateLimiter, so slot pacing for the NEXT item accounts for it", async () => {
    const PACED: StoreCapabilities = { ...AMIAMI, rateLimit: { ...AMIAMI.rateLimit, baseDelayMs: 1000 } };
    let clock = 0;
    const now = () => clock;
    const sleep = async (ms: number) => { clock += ms; };
    const scrapeTimes: number[] = [];

    const extractMany = jest.fn(async (_html: string, url: string, ctx: any) => {
      // Simulate real elapsed work BEFORE the in-slot follow-up fires, so the follow-up's own
      // dispatch time is provably later than the primary fetch's.
      await sleep(500);
      await ctx.scraping.fetchBody('https://www.amiami.com/api/follow-up');
      return [extracted(gcodeOf(url))];
    });
    const rs: ExtractionRuleset = {
      siteId: 'amiami',
      version: '2.0',
      extract: jest.fn(() => { throw new Error('extract() should not run when extractMany is present'); }),
      extractMany,
      validate: () => ({ valid: true, errors: [], warnings: [] }),
    };
    const resolveContext = jest.fn(() => ({
      config: {},
      logger: {},
      scraping: { fetchBody: jest.fn().mockResolvedValue({ html: 'follow-up' }) },
    } as never));

    const { driver } = build({
      extraction: { allStores: () => [PACED], getRulesetForUrl: () => rs },
      scrape: jest.fn(async (url: string): Promise<ScrapePageResult> => {
        scrapeTimes.push(now());
        return { html: '<html/>', url, title: '', statusCode: 200 };
      }),
      now,
      sleep,
      capacity: { browser: 0, fetch: 1 }, // one slot: serializes A1 then A2
      resolveContext,
    });

    await driver.crawlSite('amiami', ['A1', 'A2']);

    // A1 dispatches at t=0. Its extractMany advances the clock to t=500 before issuing the
    // in-slot fetchBody follow-up. Routed through the limiter, that becomes host-a's real
    // last-dispatch time — so A2 (same host, baseDelayMs=1000) cannot dispatch before t=1500.
    // (Unrouted, A2 would dispatch at t=1000 — gated only by the primary fetch at t=0.)
    expect(scrapeTimes).toEqual([0, 1500]);
  });

  it('resolveContext returning undefined is passed through untouched (nothing to wrap)', async () => {
    const rs: ExtractionRuleset = {
      siteId: 'amiami',
      version: '1.0',
      extract: jest.fn((_html: string, url: string) => extracted(gcodeOf(url))),
      validate: () => ({ valid: true, errors: [], warnings: [] }),
    };
    const resolveContext = jest.fn().mockReturnValue(undefined);
    const { sends, driver } = build({
      extraction: { allStores: () => [AMIAMI], getRulesetForUrl: () => rs },
      resolveContext,
    });

    const result = await driver.crawlSite('amiami', ['A1']);

    expect(rs.extract).toHaveBeenCalledWith('<html/>', expect.any(String), undefined);
    expect(sends.map((e) => e.source.itemId)).toEqual(['A1']);
    expect(result.coverage.done).toBe(1);
  });
});
