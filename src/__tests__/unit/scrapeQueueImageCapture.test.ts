/**
 * The ingest path's IMAGE CAPTURE seam.
 *
 * It sits after `extractRecords` and beside the emit, and everything about the wiring exists to keep
 * it there: the item's fate was decided by the extraction and the emit, and capturing images can
 * neither improve it nor spoil it. So the queue hands the hook one request per record and moves on
 * WITHOUT awaiting — an item must not wait on a CDN — and a hook that explodes is swallowed at the
 * call site, because a broken image lane failing live ingest is the exact outcome this design is
 * arranged to prevent.
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

import type { ExtractedData, ExtractionRuleset, StoreCapabilities } from '@figurecollecting/scraper-plugin-contract';
import { ScrapeQueue, resetScrapeQueue } from '../../services/scrapeQueue';
import { createExtractionRegistry, ExtractionRegistryImpl } from '../../services/extractionRegistry';
import { okWriteStats } from '../helpers/ingestWriteStats';
import type { ImageCaptureRequest } from '../../services/images/imageCaptureHook';

const URL_ = 'https://imgstore.example.test/item/P';

function makeRegistry(ruleset: ExtractionRuleset, searchFetch?: StoreCapabilities['searchFetch']): ExtractionRegistryImpl {
  const registry = createExtractionRegistry();
  const caps: StoreCapabilities = {
    siteId: ruleset.siteId,
    name: 'Image Store',
    domains: ['imgstore.example.test'],
    rateLimit: {
      domain: 'imgstore.example.test',
      baseDelayMs: 1000,
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

const rec = (itemId: string, fields: Record<string, unknown>): ExtractedData => ({
  source: { site: 'imgstore', itemId, url: URL_, extractedAt: '2026-09-09T00:00:00.000Z' },
  fields,
  warnings: [],
});

function makeRuleset(describeImages?: ExtractionRuleset['describeImages']): ExtractionRuleset {
  return {
    siteId: 'imgstore',
    version: '2.0',
    extractMany: async () => [rec('P', { plates: ['a.jpg'] }), rec('C1', { plates: ['b.jpg'] })],
    extract: () => rec('P', { plates: ['a.jpg'] }),
    validate: () => ({ valid: true, errors: [], warnings: [] }),
    ...(describeImages ? { describeImages } : {}),
  };
}

const makeScrapingStub = () => ({
  scrapePage: jest.fn().mockResolvedValue({ html: '<html></html>', url: URL_, title: 'Item', statusCode: 200 }),
  scrapePageStealth: jest.fn().mockResolvedValue({ html: '<html></html>', url: URL_, title: 'Item', statusCode: 200 }),
});

describe('ScrapeQueue — image capture after extraction', () => {
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

  async function advanceAndFlush(ms = 500, iterations = 3) {
    for (let i = 0; i < iterations; i++) {
      jest.advanceTimersByTime(ms / iterations);
      await jest.advanceTimersByTimeAsync(50);
    }
  }

  async function runOne(hook: { capture: jest.Mock }, searchFetch?: StoreCapabilities['searchFetch']) {
    queue = new ScrapeQueue(false);
    queue.setPluginRegistry(makeRegistry(makeRuleset(() => []), searchFetch));
    queue.setIngestEmitter({ send: jest.fn().mockResolvedValue(okWriteStats()) });
    queue.setScrapingService(makeScrapingStub());
    queue.setImageCaptureHook(hook as never);
    const result = queue.enqueue(URL_, { url: URL_, priority: 'WARM', sessionId: 's1' });
    await advanceAndFlush();
    return result.promise;
  }

  it('offers EVERY extracted record to the hook, with the page it was fetched from', async () => {
    const capture = jest.fn(async (_req: ImageCaptureRequest) => undefined);
    await runOne({ capture }, { transport: 'browser' });

    expect(capture).toHaveBeenCalledTimes(2);
    const requests = capture.mock.calls.map(c => c[0]);
    expect(requests.map(r => r.itemId)).toEqual(['P', 'C1']);
    expect(requests[0]).toMatchObject({
      site: 'imgstore',
      pageUrl: URL_,
      origin: 'ingest',
      fields: { plates: ['a.jpg'] },
      searchFetch: { transport: 'browser' },
    });
    expect(requests[0].ruleset.describeImages).toBeInstanceOf(Function);
  });

  it('does not wait for the capture before finishing the item', async () => {
    let release: (() => void) | undefined;
    const capture = jest.fn(() => new Promise<void>(resolve => { release = resolve; }));

    const data = await runOne({ capture });

    // The item is complete while the capture is still hanging on a CDN that never answers.
    expect(data).toEqual({ plates: ['a.jpg'] });
    expect(queue.getStats().completed).toBe(1);
    expect(release).toBeDefined();
    release?.();
  });

  it('completes the item even when the hook throws outright', async () => {
    const capture = jest.fn(() => { throw new Error('image lane is broken'); });

    const data = await runOne({ capture });

    expect(data).toEqual({ plates: ['a.jpg'] });
    expect(queue.getStats().completed).toBe(1);
    expect(queue.getStats().failed).toBe(0);
  });

  it('completes the item even when the capture rejects later', async () => {
    const capture = jest.fn(async () => { throw new Error('bucket unreachable'); });

    const data = await runOne({ capture });
    await advanceAndFlush();

    expect(data).toEqual({ plates: ['a.jpg'] });
    expect(queue.getStats().failed).toBe(0);
  });

  it('offers nothing when the extraction itself failed', async () => {
    const capture = jest.fn(async () => undefined);
    const ruleset = makeRuleset(() => []);
    ruleset.extractMany = async () => { throw new Error('parse failed'); };

    queue = new ScrapeQueue(false);
    queue.setPluginRegistry(makeRegistry(ruleset));
    queue.setIngestEmitter({ send: jest.fn().mockResolvedValue(okWriteStats()) });
    queue.setScrapingService(makeScrapingStub());
    queue.setImageCaptureHook({ capture } as never);
    const result = queue.enqueue(URL_, { url: URL_, maxRetries: 0 });
    const settled = result.promise.catch((e: Error) => e);
    await advanceAndFlush();
    await settled;

    expect(capture).not.toHaveBeenCalled();
  });
});
