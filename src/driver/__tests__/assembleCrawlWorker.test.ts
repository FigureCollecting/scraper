/**
 * assembleCrawlWorker — the I3 adapter that composes the real engine services into the
 * CrawlWorkerDeps that makeCrawlWorker consumes. These tests verify the WIRING (URL resolution,
 * the ScrapePageResult→FetchResult mapping, the CF-status throttle default, port delegation) —
 * the per-item outcome table itself is already covered by crawlWorker.test.ts.
 */
import { assembleCrawlWorker, type CrawlWorkerServices } from '../assembleCrawlWorker';
import type { CrawlTask } from '../dispatchScheduler';
import type {
  ExtractedData,
  ExtractionRuleset,
  RetrievalCapability,
  ScrapePageResult,
} from '@figurecollecting/scraper-plugin-contract';

const TASK: CrawlTask = { id: 'FIGURE-42', host: 'www.amiami.com' };
const RETRIEVAL: RetrievalCapability = { byId: { urlTemplate: 'https://www.amiami.com/eng/detail/?gcode={id}' } };
const EXPECTED_URL = 'https://www.amiami.com/eng/detail/?gcode=FIGURE-42';

const extracted = (): ExtractedData => ({
  source: { site: 'amiami', itemId: 'FIGURE-42', extractedAt: '2026-08-08T00:00:00.000Z' },
  fields: { name: 'Fig' },
  warnings: [],
});

const ruleset = (extract = jest.fn().mockReturnValue(extracted())): ExtractionRuleset => ({
  siteId: 'amiami',
  version: '1.0.0',
  extract,
  validate: jest.fn().mockReturnValue({ valid: true, errors: [], warnings: [] }),
});

const scrapeResult = (over: Partial<ScrapePageResult> = {}): ScrapePageResult => ({
  html: '<html>ok</html>',
  url: EXPECTED_URL,
  title: 'Fig',
  statusCode: 200,
  ...over,
});

const fakeLedger = () => {
  const done: string[] = [];
  const failed: string[] = [];
  return { done, failed, markDone: (id: string) => done.push(id), markFailed: (id: string) => failed.push(id) };
};

const build = (over: Partial<CrawlWorkerServices> = {}) => {
  const ledger = fakeLedger();
  const rs = ruleset();
  const services: CrawlWorkerServices = {
    scrape: jest.fn().mockResolvedValue(scrapeResult()),
    getRulesetForUrl: jest.fn().mockReturnValue(rs),
    retrievalFor: jest.fn().mockReturnValue(RETRIEVAL),
    emit: jest.fn().mockResolvedValue({ sourceId: 's1' }),
    ledger,
    ...over,
  };
  return { services, ledger, rs, worker: assembleCrawlWorker(services) };
};

describe('assembleCrawlWorker — engine services → crawl worker', () => {
  it('resolves the byId URL, fetches, extracts, emits, and marks the item done', async () => {
    const { services, ledger, rs, worker } = build();

    const outcome = await worker(TASK);

    expect(services.retrievalFor).toHaveBeenCalledWith('www.amiami.com');
    expect(services.scrape).toHaveBeenCalledWith(EXPECTED_URL);
    expect(services.getRulesetForUrl).toHaveBeenCalledWith(EXPECTED_URL);
    expect(rs.extract).toHaveBeenCalledWith('<html>ok</html>', EXPECTED_URL, undefined);
    expect(services.emit).toHaveBeenCalledWith(extracted());
    expect(ledger.done).toEqual(['FIGURE-42']);
    expect(outcome).toBe('success');
  });

  it('routes a 403 (Cloudflare block) to rate-limited — no extract, no emit, item stays pending', async () => {
    const { services, ledger, rs, worker } = build({
      scrape: jest.fn().mockResolvedValue(scrapeResult({ statusCode: 403 })),
    });

    const outcome = await worker(TASK);

    expect(rs.extract).not.toHaveBeenCalled();
    expect(services.emit).not.toHaveBeenCalled();
    expect(ledger.done).toEqual([]);
    expect(ledger.failed).toEqual([]);
    expect(outcome).toBe('rate-limited');
  });

  it('routes a 503 (Cloudflare "checking your browser") to rate-limited', async () => {
    const { services, worker } = build({
      scrape: jest.fn().mockResolvedValue(scrapeResult({ statusCode: 503 })),
    });

    expect(await worker(TASK)).toBe('rate-limited');
    expect(services.emit).not.toHaveBeenCalled();
  });

  it('a host with no byId retrieval → markFailed + success, without scraping', async () => {
    const { services, ledger, worker } = build({ retrievalFor: jest.fn().mockReturnValue(undefined) });

    const outcome = await worker(TASK);

    expect(services.scrape).not.toHaveBeenCalled();
    expect(ledger.failed).toEqual(['FIGURE-42']);
    expect(outcome).toBe('success');
  });

  it('threads a resolved ExtractContext into the ruleset extract', async () => {
    const ctx = { config: {}, scraping: {}, logger: {} } as never;
    const rs = ruleset();
    const resolveContext = jest.fn().mockReturnValue(ctx);
    const { worker } = build({ getRulesetForUrl: jest.fn().mockReturnValue(rs), resolveContext });

    await worker(TASK);

    expect(resolveContext).toHaveBeenCalledWith(TASK, EXPECTED_URL);
    expect(rs.extract).toHaveBeenCalledWith('<html>ok</html>', EXPECTED_URL, ctx);
  });

  it('a custom throttleStatuses replaces the CF default (403 then flows through to emit)', async () => {
    const { services, worker } = build({
      throttleStatuses: [429],
      scrape: jest.fn().mockResolvedValue(scrapeResult({ statusCode: 403 })),
    });

    await worker(TASK);

    expect(services.emit).toHaveBeenCalled();
  });
});
