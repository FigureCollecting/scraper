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
});
