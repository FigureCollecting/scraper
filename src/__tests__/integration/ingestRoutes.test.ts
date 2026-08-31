/**
 * Ingest trigger route tests — POST /ingest/scrape {url} is the HTTP surface
 * that drives the queue's EXISTING ingest path (registry-resolve -> raw fetch
 * -> ruleset.extract -> ingestEmitter.send). The route only validates and
 * enqueues; fetch/extraction/emit/retry semantics all stay in the queue.
 *
 * Answer shape:
 *   400 - missing / malformed url
 *   503 - ingest not configured (no emitter; INGEST_BASE_URL unset)
 *   422 - no plugin ruleset matches the URL
 *   202 - enqueued (itemId, deduplicated, position)
 *
 * Fixtures mirror scrapeQueueIngest.test.ts (#221) so the wiring test proves
 * the enqueued item flows the same tested ingest path.
 */

// Persistent mock objects that survive clearAllMocks
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

import request from 'supertest';
import express from 'express';
import type { ExtractionRuleset } from '@figurecollecting/scraper-plugin-contract';
import { createIngestRouter } from '../../routes/ingest';
import { ScrapeQueue, resetScrapeQueue } from '../../services/scrapeQueue';
import { createExtractionRegistry, ExtractionRegistryImpl } from '../../services/extractionRegistry';
import { okWriteStats } from '../helpers/ingestWriteStats';

const FIXTURE_HTML = '<html><body><h1 class="title">Kitagawa Marin</h1></body></html>';
const FIXTURE_URL = 'https://figures.example.test/item/777';

/** Registry with the fixture site registered for the trigger URL's domain. */
function makeRegistry(ruleset: ExtractionRuleset, domain = 'figures.example.test'): ExtractionRegistryImpl {
  const registry = createExtractionRegistry();
  registry.registerSite({
    siteId: ruleset.siteId,
    name: 'Mock Site',
    domains: [domain],
    rateLimit: {
      domain,
      baseDelayMs: 1000,
      minDelayMs: 500,
      maxDelayMs: 5000,
      backoffMultiplier: 1.5,
      recoveryDivisor: 1.5,
      successThreshold: 3,
    },
    requiresBrowser: false,
    allowedCookies: [],
  });
  registry.registerRuleset(ruleset);
  return registry;
}

/** Fixture ruleset (same shape as fixtures/plugins/mock-scraper-ruleset). */
function makeRuleset(): ExtractionRuleset & { extract: jest.Mock } {
  const extractFn = jest.fn((html: string, url: string) => ({
    source: {
      site: 'mock-site',
      itemId: '777',
      url,
      extractedAt: '2026-07-25T00:00:00.000Z',
      rulesetVersion: '1.0.0',
    },
    fields: { name: 'Kitagawa Marin', jan: '4530956107891' },
    warnings: [],
  }));
  return {
    siteId: 'mock-site',
    version: '1.0.0',
    extract: extractFn,
    validate: () => ({ valid: true, errors: [], warnings: [] }),
  };
}

function makeScrapingStub() {
  return {
    scrapePage: jest.fn().mockResolvedValue({
      html: FIXTURE_HTML,
      url: FIXTURE_URL,
      title: 'Item',
      statusCode: 200,
    }),
    scrapePageStealth: jest.fn().mockResolvedValue({
      html: FIXTURE_HTML,
      url: FIXTURE_URL,
      title: 'Item',
      statusCode: 200,
    }),
  };
}

/** Poll (real timers) until the condition holds or the deadline passes. */
async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('waitFor: condition not met before timeout');
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

function makeApp(queue: ScrapeQueue): express.Application {
  const app = express();
  app.use(express.json());
  app.use('/', createIngestRouter(() => queue));
  return app;
}

describe('POST /ingest/scrape', () => {
  let queue: ScrapeQueue;

  beforeEach(() => {
    jest.clearAllMocks();
    resetScrapeQueue();
  });

  afterEach(() => {
    if (queue) {
      queue.stop();
      queue.clear();
    }
    resetScrapeQueue();
  });

  describe('validation', () => {
    beforeEach(() => {
      // Fully configured queue: validation failures must trip BEFORE config checks
      queue = new ScrapeQueue(true);
      queue.setPluginRegistry(makeRegistry(makeRuleset()));
      queue.setIngestEmitter({ send: jest.fn().mockResolvedValue(okWriteStats()) });
    });

    it('returns 400 when url is missing', async () => {
      const response = await request(makeApp(queue)).post('/ingest/scrape').send({}).expect(400);

      expect(response.body).toEqual({ success: false, message: 'URL is required' });
      expect(queue.getStats().total).toBe(0);
    });

    it('returns 400 when the request has no JSON body at all', async () => {
      const response = await request(makeApp(queue)).post('/ingest/scrape').expect(400);

      expect(response.body).toEqual({ success: false, message: 'URL is required' });
      expect(queue.getStats().total).toBe(0);
    });

    it('returns 400 when url is not a valid URL', async () => {
      const response = await request(makeApp(queue))
        .post('/ingest/scrape')
        .send({ url: 'not-a-url' })
        .expect(400);

      expect(response.body).toEqual({ success: false, message: 'Invalid URL format' });
      expect(queue.getStats().total).toBe(0);
    });
  });

  describe('configuration and ruleset checks', () => {
    it('returns 503 when no ingest emitter is configured (INGEST_BASE_URL unset)', async () => {
      queue = new ScrapeQueue(true);
      queue.setPluginRegistry(makeRegistry(makeRuleset()));
      queue.setIngestEmitter(null);

      const response = await request(makeApp(queue))
        .post('/ingest/scrape')
        .send({ url: FIXTURE_URL })
        .expect(503);

      expect(response.body).toEqual({
        success: false,
        message: 'Ingest not configured (INGEST_BASE_URL unset)',
      });
      expect(queue.getStats().total).toBe(0);
    });

    it('returns 422 when no plugin ruleset matches the URL', async () => {
      queue = new ScrapeQueue(true);
      // registry present but empty: nothing matches the URL's domain
      queue.setPluginRegistry(createExtractionRegistry());
      queue.setIngestEmitter({ send: jest.fn().mockResolvedValue(okWriteStats()) });

      const response = await request(makeApp(queue))
        .post('/ingest/scrape')
        .send({ url: FIXTURE_URL })
        .expect(422);

      expect(response.body).toEqual({
        success: false,
        message: 'No plugin ruleset matches this URL',
      });
      expect(queue.getStats().total).toBe(0);
    });
  });

  describe('happy path', () => {
    beforeEach(() => {
      queue = new ScrapeQueue(true); // test mode: enqueue without auto-processing
      queue.setPluginRegistry(makeRegistry(makeRuleset()));
      queue.setIngestEmitter({ send: jest.fn().mockResolvedValue(okWriteStats()) });
    });

    it('enqueues the URL (key = url, options.url = url) and answers 202', async () => {
      const enqueueSpy = jest.spyOn(queue, 'enqueue');

      const response = await request(makeApp(queue))
        .post('/ingest/scrape')
        .send({ url: FIXTURE_URL })
        .expect(202);

      expect(enqueueSpy).toHaveBeenCalledTimes(1);
      expect(enqueueSpy).toHaveBeenCalledWith(FIXTURE_URL, { url: FIXTURE_URL });
      expect(response.body).toEqual({
        success: true,
        itemId: expect.any(String),
        deduplicated: false,
        position: expect.any(Number),
      });
      expect(queue.isPending(FIXTURE_URL)).toBe(true);
    });

    it('deduplicates a repeat trigger for the same URL', async () => {
      const app = makeApp(queue);
      const first = await request(app).post('/ingest/scrape').send({ url: FIXTURE_URL }).expect(202);
      const second = await request(app).post('/ingest/scrape').send({ url: FIXTURE_URL }).expect(202);

      expect(first.body.deduplicated).toBe(false);
      expect(second.body.deduplicated).toBe(true);
      expect(second.body.itemId).toBe(first.body.itemId);
      expect(queue.getStats().total).toBe(1);
    });

    it('never lets a CRLF-bearing URL forge multi-line log entries (log injection)', async () => {
      // WHATWG URL parsing STRIPS tab/CR/LF, so this passes new URL()
      // validation while the original string (logged, used as dedup key,
      // embedded in the item id) still carries the raw control chars.
      const crlfUrl = 'https://figures.example.test/item/7\r\nFORGED admin login OK\r\n77';
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      const app = makeApp(queue);
      await request(app).post('/ingest/scrape').send({ url: crlfUrl }).expect(202);
      // repeat trigger: exercises the dedup/coalesce log lines too
      await request(app).post('/ingest/scrape').send({ url: crlfUrl }).expect(202);

      expect(logSpy).toHaveBeenCalled();
      for (const call of logSpy.mock.calls) {
        expect(String(call[0])).not.toMatch(/[\r\n]/);
      }
    });
  });

  describe('wiring: enqueued item flows the ingest path', () => {
    it('drives fetch -> ruleset.extract -> ingestEmitter.send for the triggered URL', async () => {
      const ruleset = makeRuleset();
      const scraping = makeScrapingStub();
      const send = jest.fn().mockResolvedValue(okWriteStats());

      queue = new ScrapeQueue(false); // real processing loop
      queue.setPluginRegistry(makeRegistry(ruleset));
      queue.setIngestEmitter({ send });
      queue.setScrapingService(scraping);

      await request(makeApp(queue)).post('/ingest/scrape').send({ url: FIXTURE_URL }).expect(202);

      await waitFor(() => send.mock.calls.length > 0);

      // engine fetched the raw page; extraction was the plugin's job
      expect(scraping.scrapePage).toHaveBeenCalledWith(FIXTURE_URL);
      // B3: extractRecords forwards the built ExtractContext as extract's 3rd arg.
      expect(ruleset.extract).toHaveBeenCalledWith(FIXTURE_HTML, FIXTURE_URL, expect.anything());
      // the extraction went to the spine, verbatim
      const sent = send.mock.calls[0][0];
      expect(sent.source.site).toBe('mock-site');
      expect(sent.fields).toEqual({ name: 'Kitagawa Marin', jan: '4530956107891' });
      // outcome observable via queue accounting (and completion log lines)
      await waitFor(() => queue.getStats().completed === 1);
      expect(queue.getStats().failed).toBe(0);
    });

    it('logs a failure line when the triggered item permanently fails (smoke observability)', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const ruleset = makeRuleset();
      const scraping = makeScrapingStub();
      // NOT_FOUND classifies as not_found -> non-retryable -> permanent failure
      const send = jest.fn().mockRejectedValue(new Error('NOT_FOUND: item vanished'));

      queue = new ScrapeQueue(false);
      queue.setPluginRegistry(makeRegistry(ruleset));
      queue.setIngestEmitter({ send });
      queue.setScrapingService(scraping);

      await request(makeApp(queue)).post('/ingest/scrape').send({ url: FIXTURE_URL }).expect(202);

      await waitFor(() => queue.getStats().failed === 1);
      await waitFor(() =>
        errorSpy.mock.calls.some(call =>
          String(call[0]).includes('[INGEST API] Ingest scrape failed for')
        )
      );
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('[INGEST API] Ingest scrape failed for https://figures.example.test/item/777')
      );
    });
  });
});
