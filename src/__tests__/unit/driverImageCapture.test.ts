/**
 * The DRIVER legs' image capture seam — the crawl worker and the byId confirm.
 *
 * Both dispatch extraction through the same `extractRecords` the ingest queue uses, so both reach
 * the same moment: an extraction has succeeded and the store's own plates are nameable. The seam is
 * an INJECTED callback rather than the hook itself, because the driver is a pure composition unit —
 * it owns no services, and giving it one would put a browser and a bucket behind a unit test.
 *
 * The property under test in both is the same one: capture is offered when, and only when, the
 * extraction succeeded, and offering it can never change the leg's outcome.
 */
import { makeCrawlWorker } from '../../driver/crawlWorker';
import { assembleResolve } from '../../driver/assembleResolve';
import { ChallengeCooldown } from '../../services/challengeCooldown';
import type { ExtractedData, ExtractionRuleset, StoreCapabilities } from '@figurecollecting/scraper-plugin-contract';
import type { CrawlTask } from '../../driver/dispatchScheduler';

const record = (itemId: string): ExtractedData => ({
  source: { site: 'imgstore', itemId, extractedAt: '2026-09-09T00:00:00.000Z' },
  fields: { plates: [`${itemId}.jpg`] },
  warnings: [],
});

const ruleset = (extractMany?: ExtractionRuleset['extractMany']): ExtractionRuleset => ({
  siteId: 'imgstore',
  version: '1.0',
  extract: () => record('1'),
  extractMany: extractMany ?? (async () => [record('1'), record('2')]),
  validate: () => ({ valid: true, errors: [], warnings: [] }),
});

const task: CrawlTask = { host: 'imgstore.test', id: '1' } as CrawlTask;

describe('crawlWorker — image capture', () => {
  const base = () => ({
    resolveUrl: () => 'https://imgstore.test/item/1',
    fetch: async () => ({ html: '<html></html>', statusCode: 200 }),
    lookupRuleset: () => ruleset(),
    emit: jest.fn(async () => undefined),
    ledger: { markDone: jest.fn(), markFailed: jest.fn() },
  });

  it('offers every extracted record, with the url it was fetched from', async () => {
    const captureImages = jest.fn();
    const worker = makeCrawlWorker({ ...base(), captureImages });

    await expect(worker(task)).resolves.toBe('success');

    expect(captureImages).toHaveBeenCalledTimes(1);
    const [records, url, rs] = captureImages.mock.calls[0];
    expect((records as ExtractedData[]).map(r => r.source.itemId)).toEqual(['1', '2']);
    expect(url).toBe('https://imgstore.test/item/1');
    expect((rs as ExtractionRuleset).siteId).toBe('imgstore');
  });

  it('offers nothing when the extraction failed', async () => {
    const captureImages = jest.fn();
    const worker = makeCrawlWorker({
      ...base(),
      lookupRuleset: () => ruleset(async () => { throw new Error('parse failed'); }),
      captureImages,
    });

    await expect(worker(task)).resolves.toBe('success');

    expect(captureImages).not.toHaveBeenCalled();
  });

  it('covers the item even when the capture callback throws', async () => {
    const deps = base();
    const worker = makeCrawlWorker({ ...deps, captureImages: () => { throw new Error('image lane broken'); } });

    await expect(worker(task)).resolves.toBe('success');

    expect(deps.emit).toHaveBeenCalledTimes(2);
    expect(deps.ledger.markDone).toHaveBeenCalledWith('1');
  });

  it('is entirely optional — a worker wired without it behaves exactly as before', async () => {
    const deps = base();
    await expect(makeCrawlWorker(deps)(task)).resolves.toBe('success');
    expect(deps.ledger.markDone).toHaveBeenCalledWith('1');
  });
});

describe('assembleResolve — image capture', () => {
  const caps: StoreCapabilities = {
    siteId: 'imgstore',
    name: 'Image Store',
    domains: ['imgstore.test'],
    rateLimit: { domain: 'imgstore.test', baseDelayMs: 0, minDelayMs: 0, maxDelayMs: 0, backoffMultiplier: 1, recoveryDivisor: 1, successThreshold: 1 },
    requiresBrowser: false,
    allowedCookies: [],
    retrieval: { byId: { urlTemplate: 'https://imgstore.test/item/{id}', idKind: 'store-internal' } },
  };

  const services = (over: Record<string, unknown> = {}) => ({
    profiles: { forHost: () => caps, forSite: () => caps, all: () => [caps] } as never,
    getRulesetForUrl: () => ruleset(),
    fetchDetail: async () => ({ html: '<html></html>', statusCode: 200 }),
    now: () => 0,
    sleep: async () => undefined,
    challengeCooldown: new ChallengeCooldown({ now: () => 0 }),
    ...over,
  });

  it('offers the confirmed records, with the detail page they came from', async () => {
    const captureImages = jest.fn();
    const resolve = assembleResolve(services({ captureImages }));

    const out = await resolve.resolve('imgstore', ['1']);

    expect(out.failed).toEqual([]);
    expect(captureImages).toHaveBeenCalledTimes(1);
    const [records, url] = captureImages.mock.calls[0];
    expect((records as ExtractedData[])).toHaveLength(2);
    expect(url).toBe('https://imgstore.test/item/1');
  });

  it('offers nothing for an id whose extraction failed', async () => {
    const captureImages = jest.fn();
    const resolve = assembleResolve(
      services({ getRulesetForUrl: () => ruleset(async () => { throw new Error('parse failed'); }), captureImages }),
    );

    const out = await resolve.resolve('imgstore', ['1']);

    expect(out.failed).toEqual(['1']);
    expect(captureImages).not.toHaveBeenCalled();
  });

  it('confirms the id even when the capture callback throws', async () => {
    const resolve = assembleResolve(services({ captureImages: () => { throw new Error('image lane broken'); } }));

    const out = await resolve.resolve('imgstore', ['1']);

    expect(out.failed).toEqual([]);
    expect(out.results[0].data?.source.itemId).toBe('1');
  });
});
