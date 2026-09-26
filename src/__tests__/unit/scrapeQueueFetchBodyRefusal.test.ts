/**
 * ScrapeQueue × a refused fetchBody request (plugin-contract 0.14.0). A malformed POST option
 * (FetchBodyRequestError) or a POST on the browser lane (FetchMethodUnsupportedError) is a ruleset or
 * store-config bug that no retry can fix, so it is booked extraction_unavailable: one primary fetch,
 * no retry. Harness mirrors scrapeQueueChallengeExtractThrow.test.ts (fake timers, no live fetches).
 */

const mockNotifyItemFailed = jest.fn().mockResolvedValue(true);

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
  notifyItemSuccess: jest.fn().mockResolvedValue(true),
  notifyItemFailed: (...args: any[]) => mockNotifyItemFailed(...args),
  notifyItemSkipped: jest.fn().mockResolvedValue(true),
}));

import type { ExtractionRuleset, ExtractedData, StoreCapabilities } from '@figurecollecting/scraper-plugin-contract';
import { ScrapeQueue, resetScrapeQueue } from '../../services/scrapeQueue';
import { resetChallengeCooldown } from '../../services/challengeCooldown';
import { createExtractionRegistry } from '../../services/extractionRegistry';
import { resetSessionManager } from '../../services/sessionManager';

const HOST = 'order.mandarake.example.test';
const SITE = 'mandarake-mock';
const HTML = '<html><body><h1>item</h1></body></html>';

function recordFor(url: string): ExtractedData {
  return {
    source: { site: SITE, itemId: '9', url, extractedAt: '2026-09-25T00:00:00.000Z', rulesetVersion: '1.0.0' },
    fields: { name: 'x' },
    warnings: [],
  };
}

/** A ruleset whose extract makes one fetchBody call with the given options, then would emit a record. */
function rulesetCalling(opts: Record<string, unknown>, refusals: string[]): ExtractionRuleset {
  return {
    siteId: SITE,
    version: '1.0.0',
    validate: () => ({ valid: true, errors: [], warnings: [] }),
    extract: (async (_html: string, url: string, ctx?: any) => {
      try {
        await ctx.scraping.fetchBody(`https://${HOST}/getInfo/`, opts);
      } catch (e) {
        refusals.push((e as Error).name);
        throw e;
      }
      return recordFor(url);
    }) as any,
  };
}

function registryFor(ruleset: ExtractionRuleset, searchFetch?: StoreCapabilities['searchFetch']) {
  const registry = createExtractionRegistry();
  registry.registerSite({
    siteId: SITE,
    name: 'Mock mandarake',
    domains: [HOST],
    rateLimit: { domain: HOST, baseDelayMs: 1000, minDelayMs: 500, maxDelayMs: 5000, backoffMultiplier: 1.5, recoveryDivisor: 1.5, successThreshold: 3 },
    requiresBrowser: false,
    allowedCookies: [],
    ...(searchFetch ? { searchFetch } : {}),
  } as StoreCapabilities);
  registry.registerRuleset(ruleset);
  return registry;
}

describe('ScrapeQueue × a refused fetchBody request is not retried', () => {
  let queue: ScrapeQueue;

  beforeEach(() => {
    jest.clearAllMocks();
    mockNotifyItemFailed.mockResolvedValue(true);
    jest.useFakeTimers({ advanceTimers: true });
    resetScrapeQueue();
    resetSessionManager();
    resetChallengeCooldown();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    if (queue) { queue.stop(); queue.clear(); }
    resetScrapeQueue();
    resetSessionManager();
    resetChallengeCooldown();
    jest.useRealTimers();
  });

  /** Drive the fake clock until the item fails, then well past any retry window. */
  async function failAndSettle(): Promise<void> {
    for (let i = 0; i < 400 && queue.getStats().failed !== 1; i++) {
      jest.advanceTimersByTime(250);
      await jest.advanceTimersByTimeAsync(50);
    }
    for (let t = 0; t < 30_000; t += 500) {
      jest.advanceTimersByTime(500);
      await jest.advanceTimersByTimeAsync(50);
    }
  }

  function run(ruleset: ExtractionRuleset, searchFetch: StoreCapabilities['searchFetch'] | undefined, http: jest.Mock, scraping: any) {
    queue = new ScrapeQueue(false);
    queue.setPluginRegistry(registryFor(ruleset, searchFetch));
    queue.setIngestEmitter({ send: jest.fn() });
    queue.setScrapingService(scraping);
    queue.setIngestTransports({ http });
    const url = `https://${HOST}/item/9`;
    return queue.enqueue(url, { url, sessionId: 's1' }).promise.catch((e: Error) => e);
  }

  it('a GET with a body (FetchBodyRequestError): one primary fetch, extraction_unavailable, no retry', async () => {
    const refusals: string[] = [];
    const http = jest.fn().mockResolvedValue(HTML);
    const scraping = { scrapePage: jest.fn(), scrapePageStealth: jest.fn() };
    const captured = run(rulesetCalling({ body: 'idx=1' }, refusals), { transport: 'http' }, http, scraping);
    await failAndSettle();
    const err = (await captured) as Error;
    expect(refusals).toEqual(['FetchBodyRequestError']);
    expect(http).toHaveBeenCalledTimes(1);
    expect(queue.getStats().failed).toBe(1);
    expect(err.message).toContain('extraction_unavailable');
    expect(mockNotifyItemFailed.mock.calls[0][2]).toContain('extraction_unavailable');
  });

  it('a POST on the browser lane (FetchMethodUnsupportedError): one navigation, extraction_unavailable, no retry', async () => {
    const refusals: string[] = [];
    const http = jest.fn();
    const page = { html: HTML, url: `https://${HOST}/item/9`, title: 'item', statusCode: 200 };
    const scraping = { scrapePage: jest.fn().mockResolvedValue(page), scrapePageStealth: jest.fn().mockResolvedValue(page) };
    const captured = run(rulesetCalling({ method: 'POST', body: 'idx=1' }, refusals), undefined, http, scraping);
    await failAndSettle();
    const err = (await captured) as Error;
    expect(refusals).toEqual(['FetchMethodUnsupportedError']);
    expect(scraping.scrapePage.mock.calls.length + scraping.scrapePageStealth.mock.calls.length).toBe(1);
    expect(http).not.toHaveBeenCalled();
    expect(queue.getStats().failed).toBe(1);
    expect(err.message).toContain('extraction_unavailable');
  });
});
