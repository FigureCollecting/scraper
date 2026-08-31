/**
 * ScrapeQueue B3 wiring — orzgk Slice B, spec.md D2/D7/D11: `processViaIngest` dispatches through
 * `extractRecords` (extractMany > extractAsync > extract, always an array) and emits every
 * record as a SEQUENTIAL UNARY `ingestEmitter.send()` call, parent/target-first, `await`ing each
 * — stopping at the FIRST failure so no later (dependent) record is ever sent ahead of a target
 * that never landed. `handleSuccess`/the caller's resolved promise still see `[0].fields` (the
 * page's own record), same as today's single-record path. Also covers `ExtractContext.scraping
 * .fetchBody` reaching the ingest path's real transport dispatch (D1/D8/D9) end-to-end.
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

import type { ExtractContext, ExtractedData, ExtractionRuleset, StoreCapabilities } from '@figurecollecting/scraper-plugin-contract';
import { ScrapeQueue, resetScrapeQueue } from '../../services/scrapeQueue';
import { createExtractionRegistry, ExtractionRegistryImpl } from '../../services/extractionRegistry';
import { okWriteStats } from '../helpers/ingestWriteStats';
import { CollectingCaptureSink } from '../../services/captureSink';

function makeRegistry(
  ruleset: ExtractionRuleset,
  domain: string,
  searchFetch?: StoreCapabilities['searchFetch'],
  baseDelayMs = 1000,
): ExtractionRegistryImpl {
  const registry = createExtractionRegistry();
  const caps: StoreCapabilities = {
    siteId: ruleset.siteId,
    name: 'Mock Multi Store',
    domains: [domain],
    rateLimit: {
      domain,
      baseDelayMs,
      minDelayMs: 500,
      maxDelayMs: 5000,
      backoffMultiplier: 1.5,
      recoveryDivisor: 1.5,
      successThreshold: 3,
    },
    requiresBrowser: false,
    allowedCookies: [],
    searchFetch,
  };
  registry.registerSite(caps);
  registry.registerRuleset(ruleset);
  return registry;
}

function rec(itemId: string, fields: Record<string, unknown>): ExtractedData {
  return {
    source: { site: 'mock-multi', itemId, url: 'https://orzgk.example.test/item/P', extractedAt: '2026-08-19T00:00:00.000Z' },
    fields,
    warnings: [],
  };
}

/** Three-record fixture: parent P, editions C1/C2 (editionOf=P) — mirrors the orzgk Vegito shape. */
function makeMultiRuleset(
  extractManyImpl?: jest.Mock,
): ExtractionRuleset & { extractMany: jest.Mock; extract: jest.Mock } {
  const extractMany =
    extractManyImpl ??
    jest.fn(async (_html: string, url: string) => [
      rec('P', { name: 'Parent Listing' }),
      rec('C1', { name: 'Edition 1', editionOf: 'P' }),
      rec('C2', { name: 'Edition 2', editionOf: 'P' }),
    ].map((r) => ({ ...r, source: { ...r.source, url } })));
  return {
    siteId: 'mock-multi',
    version: '1.1',
    extract: jest.fn(() => {
      throw new Error('extract() should not run when extractMany is present');
    }),
    extractMany,
    validate: () => ({ valid: true, errors: [], warnings: [] }),
  };
}

function makeScrapingStub(html = '{"variable":true}') {
  return {
    scrapePage: jest.fn().mockResolvedValue({ html, url: 'https://orzgk.example.test/item/P', title: 'Item', statusCode: 200 }),
    scrapePageStealth: jest.fn().mockResolvedValue({ html, url: 'https://orzgk.example.test/item/P', title: 'Item', statusCode: 200 }),
  };
}

describe('ScrapeQueue — extractRecords/emitAll wiring (B3)', () => {
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

  it('emits every extractMany record as a sequential unary send(), IN ARRAY ORDER, and resolves the caller with [0].fields', async () => {
    const ruleset = makeMultiRuleset();
    const scraping = makeScrapingStub();
    const send = jest.fn().mockResolvedValue(okWriteStats());

    queue = new ScrapeQueue(false);
    queue.setPluginRegistry(makeRegistry(ruleset, 'orzgk.example.test'));
    queue.setIngestEmitter({ send });
    queue.setScrapingService(scraping);

    const url = 'https://orzgk.example.test/item/P';
    const result = queue.enqueue(url, { url, priority: 'WARM', sessionId: 'session1' });
    await advanceAndFlush(500);
    const data = await result.promise;

    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[0][0].source.itemId).toBe('P');
    expect(send.mock.calls[1][0].source.itemId).toBe('C1');
    expect(send.mock.calls[2][0].source.itemId).toBe('C2');
    // send() calls happened in strict sequence (each awaited before the next fires) — verify via
    // invocation order matching array order (already implied by the assertions above, restated
    // for clarity against accidental Promise.all-style concurrent dispatch).
    const order = send.mock.invocationCallOrder;
    expect(order[0]).toBeLessThan(order[1]);
    expect(order[1]).toBeLessThan(order[2]);

    // handleSuccess / the waiting caller's promise resolve with the PARENT's fields, not the last
    // record's — same shape as today's single-record path.
    expect(data).toEqual({ name: 'Parent Listing' });
    expect(queue.getStats().completed).toBe(1);
  });

  it('stops at the FIRST send failure: later (dependent) records are never sent, and the item fails', async () => {
    const ruleset = makeMultiRuleset();
    const scraping = makeScrapingStub();
    const send = jest
      .fn()
      .mockResolvedValueOnce(okWriteStats({ sourceId: 'p' })) // P succeeds
      .mockRejectedValueOnce(new Error('spine unavailable')); // C1 fails — C2 must never be attempted

    queue = new ScrapeQueue(false);
    queue.setPluginRegistry(makeRegistry(ruleset, 'orzgk.example.test'));
    queue.setIngestEmitter({ send });
    queue.setScrapingService(scraping);

    const url = 'https://orzgk.example.test/item/P';
    const result = queue.enqueue(url, { url, maxRetries: 0 });
    const promiseRef = result.promise.catch((e: Error) => e);

    await advanceAndFlush(500);
    await advanceAndFlush(5000);

    const error = await promiseRef;
    expect(error).toBeInstanceOf(Error);
    // exactly 2 sends: P (ok) + C1 (failed) — C2 (the 3rd record) was NEVER sent
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0].source.itemId).toBe('P');
    expect(send.mock.calls[1][0].source.itemId).toBe('C1');
    expect(queue.getStats().failed).toBe(1);
  });

  it('logs a records-emitted count on success', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const ruleset = makeMultiRuleset();
    const scraping = makeScrapingStub();
    const send = jest.fn().mockResolvedValue(okWriteStats());

    queue = new ScrapeQueue(false);
    queue.setPluginRegistry(makeRegistry(ruleset, 'orzgk.example.test'));
    queue.setIngestEmitter({ send });
    queue.setScrapingService(scraping);

    const url = 'https://orzgk.example.test/item/P';
    const result = queue.enqueue(url, { url });
    await advanceAndFlush(500);
    await result.promise;

    const lines = logSpy.mock.calls.map((call) => String(call[0]));
    expect(lines.some((line) => /Ingest complete .*persisted=3 emitted=3\/3/.test(line))).toBe(true);
    logSpy.mockRestore();
  });

  it('logs how many records were emitted before a partial-emit failure (never silently swallowed)', async () => {
    const logSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const ruleset = makeMultiRuleset();
    const scraping = makeScrapingStub();
    const send = jest
      .fn()
      .mockResolvedValueOnce(okWriteStats({ sourceId: 'p' }))
      .mockRejectedValueOnce(new Error('spine unavailable'));

    queue = new ScrapeQueue(false);
    queue.setPluginRegistry(makeRegistry(ruleset, 'orzgk.example.test'));
    queue.setIngestEmitter({ send });
    queue.setScrapingService(scraping);

    const url = 'https://orzgk.example.test/item/P';
    const result = queue.enqueue(url, { url, maxRetries: 0 });
    const promiseRef = result.promise.catch((e: Error) => e);
    await advanceAndFlush(500);
    await advanceAndFlush(5000);
    await promiseRef;

    const lines = logSpy.mock.calls.map((call) => String(call[0]));
    expect(lines.some((line) => /1\/3 record/.test(line))).toBe(true);
    logSpy.mockRestore();
  });

  it('reports records SENT (not persisted) and rows persisted when the honesty gate trips mid-batch', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const ruleset = makeMultiRuleset();
    const scraping = makeScrapingStub();
    // P persists one row; C1 resolves all-zero (spine persisted nothing) → the honesty gate throws on
    // C1 AFTER it was sent. The failure log must report 2 SENT (P + C1) but persisted=1 (only P).
    const zeroStats = {
      sourceId: 'c1',
      claims: { emitted: 0, inserted: 0, deduped: 0, quarantined: 0, dropped: 0 },
      identifiers: { emitted: 0, inserted: 0, deduped: 0, dropped: 0 },
      prices: { emitted: 0, inserted: 0, deduped: 0, skipped: 0, dropped: 0 },
      availability: { emitted: 0, inserted: 0, deduped: 0, dropped: 0 },
      warnings: [] as string[],
    };
    const send = jest
      .fn()
      .mockResolvedValueOnce(okWriteStats({ sourceId: 'p' })) // P → persisted 1
      .mockResolvedValueOnce(zeroStats);                      // C1 → persisted 0 → gate throws

    queue = new ScrapeQueue(false);
    queue.setPluginRegistry(makeRegistry(ruleset, 'orzgk.example.test'));
    queue.setIngestEmitter({ send });
    queue.setScrapingService(scraping);

    const url = 'https://orzgk.example.test/item/P';
    const result = queue.enqueue(url, { url, maxRetries: 0 });
    const promiseRef = result.promise.catch((e: Error) => e);
    await advanceAndFlush(500);
    await advanceAndFlush(5000);
    await promiseRef;

    const failLine = errSpy.mock.calls.map((call) => String(call[0])).find((l) => l.includes('Ingest emit failed'));
    expect(failLine).toBeDefined();
    // 2 records were SENT (P + C1 both reached the emitter), even though only 1 PERSISTED
    expect(failLine).toMatch(/2\/3 records emitted/);
    expect(failLine).toMatch(/persisted=1/);
    expect(send).toHaveBeenCalledTimes(2); // C2 (3rd record) never sent — stopped at first gate failure
    errSpy.mockRestore();
  });

  it('passes a real ExtractContext to extractMany whose scraping.fetchBody dispatches via the store\'s declared searchFetch transport (captured, api lane)', async () => {
    const followUpUrl = 'https://orzgk.example.test/wc/store/v1/products?type=variation&parent=P';
    const extractMany = jest.fn(async (_html: string, url: string, ctx?: ExtractContext) => {
      const followUp = await ctx!.scraping.fetchBody!(followUpUrl);
      return [
        rec('P', { name: 'Parent Listing', followUpBody: followUp.html }),
      ].map((r) => ({ ...r, source: { ...r.source, url } }));
    });
    const ruleset = makeMultiRuleset(extractMany);
    const scraping = makeScrapingStub();
    const send = jest.fn().mockResolvedValue(okWriteStats());
    const http = jest.fn().mockResolvedValue('{"variations":[1,2]}');
    const sink = new CollectingCaptureSink();

    queue = new ScrapeQueue(false);
    queue.setPluginRegistry(makeRegistry(ruleset, 'orzgk.example.test', { transport: 'http' }));
    queue.setIngestEmitter({ send });
    queue.setScrapingService(scraping);
    queue.setIngestTransports({ http });
    queue.setCaptureSink(sink);

    const url = 'https://orzgk.example.test/item/P';
    const result = queue.enqueue(url, { url });
    await advanceAndFlush(500);
    await result.promise;

    expect(http).toHaveBeenCalledWith(followUpUrl);
    expect(send.mock.calls[0][0].fields.followUpBody).toBe('{"variations":[1,2]}');
    // both the primary AND the follow-up fetch were captured under the api lane
    const apiCaptures = sink.captures.filter((c) => c.lane === 'api');
    expect(apiCaptures.map((c) => c.url)).toEqual(expect.arrayContaining([url, followUpUrl]));
  });
});
