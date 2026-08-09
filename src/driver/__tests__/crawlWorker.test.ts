/**
 * crawlWorker — the crawl driver's I2 worker: the `(task) => Outcome` function the CrawlLoop
 * launches per dispatch. It composes injected ports — resolveUrl → fetch → catch-gated extract →
 * emit — and records each item's fate on the CoverageLedger, returning ONLY the host-mood Outcome
 * ('success' recovers the host delay, 'rate-limited' backs it off). The two axes are independent:
 * the ledger carries item done/failed; the Outcome carries whether the host cooperated.
 *
 * Outcome table under test:
 *   no URL / no ruleset      → markFailed + 'success'      (config gap; host not contacted)
 *   fetch throws / 429 / 503 → (pending) + 'rate-limited'  (host throttled/blocked → back off)
 *   extract throws           → markFailed + 'success'      (page OK, content failed — not throttle)
 *   emit throws              → (pending) + 'rate-limited'  (delivery failed → backpressure, retry)
 *   emit OK                  → markDone   + 'success'      (covered)
 */
import { makeCrawlWorker, type CrawlWorkerDeps, type FetchResult } from '../crawlWorker';
import type { CrawlTask } from '../dispatchScheduler';
import type { ExtractedData, ExtractionRuleset } from '@figurecollecting/scraper-plugin-contract';

const TASK: CrawlTask = { id: 'abc123', host: 'www.amiami.com' };
const URL = 'https://www.amiami.com/eng/detail/?gcode=abc123';

const extracted = (over: Partial<ExtractedData> = {}): ExtractedData => ({
  source: { site: 'amiami', itemId: 'abc123', extractedAt: '2026-08-08T00:00:00.000Z' },
  fields: { name: 'Some Figure' },
  warnings: [],
  ...over,
});

const ruleset = (over: Partial<ExtractionRuleset> = {}): ExtractionRuleset => ({
  siteId: 'amiami',
  version: '1.0.0',
  extract: jest.fn().mockReturnValue(extracted()),
  validate: jest.fn().mockReturnValue({ valid: true, errors: [], warnings: [] }),
  ...over,
});

/** Minimal ledger double recording the two calls the worker makes. */
const fakeLedger = () => {
  const done: string[] = [];
  const failed: string[] = [];
  return { done, failed, markDone: (id: string) => done.push(id), markFailed: (id: string) => failed.push(id) };
};

const build = (over: Partial<CrawlWorkerDeps> = {}) => {
  const ledger = fakeLedger();
  const rs = ruleset();
  const deps: CrawlWorkerDeps = {
    resolveUrl: jest.fn().mockReturnValue(URL),
    fetch: jest.fn<Promise<FetchResult>, [string]>().mockResolvedValue({ html: '<html>ok</html>', statusCode: 200 }),
    lookupRuleset: jest.fn().mockReturnValue(rs),
    emit: jest.fn().mockResolvedValue({ sourceId: 's1' }),
    ledger,
    ...over,
  };
  return { deps, ledger, rs, worker: makeCrawlWorker(deps) };
};

describe('makeCrawlWorker — per-item fetch → extract → emit', () => {
  it('covers an item: fetch, extract, emit, markDone, and returns success', async () => {
    const { deps, ledger, rs, worker } = build();

    const outcome = await worker(TASK);

    expect(deps.resolveUrl).toHaveBeenCalledWith(TASK);
    expect(deps.fetch).toHaveBeenCalledWith(URL);
    expect(deps.lookupRuleset).toHaveBeenCalledWith(URL);
    expect(rs.extract).toHaveBeenCalledWith('<html>ok</html>', URL, undefined);
    expect(deps.emit).toHaveBeenCalledWith(extracted());
    expect(ledger.done).toEqual(['abc123']);
    expect(ledger.failed).toEqual([]);
    expect(outcome).toBe('success');
  });

  it('no retrieval URL → markFailed + success, without contacting the host', async () => {
    const { deps, ledger, worker } = build({ resolveUrl: jest.fn().mockReturnValue(undefined) });

    const outcome = await worker(TASK);

    expect(deps.fetch).not.toHaveBeenCalled();
    expect(ledger.failed).toEqual(['abc123']);
    expect(ledger.done).toEqual([]);
    expect(outcome).toBe('success');
  });

  it('no ruleset for the URL → markFailed + success, without fetching', async () => {
    const { deps, ledger, worker } = build({ lookupRuleset: jest.fn().mockReturnValue(undefined) });

    const outcome = await worker(TASK);

    expect(deps.fetch).not.toHaveBeenCalled();
    expect(ledger.failed).toEqual(['abc123']);
    expect(outcome).toBe('success');
  });

  it('fetch throwing (network/CF block) → rate-limited, item left pending', async () => {
    const { deps, ledger, rs, worker } = build({ fetch: jest.fn().mockRejectedValue(new Error('CF challenge')) });

    const outcome = await worker(TASK);

    expect(rs.extract).not.toHaveBeenCalled();
    expect(deps.emit).not.toHaveBeenCalled();
    expect(ledger.done).toEqual([]);
    expect(ledger.failed).toEqual([]); // pending — a resume retries it
    expect(outcome).toBe('rate-limited');
  });

  it.each([429, 503])('throttle status %i → rate-limited, no extract, item pending', async (status) => {
    const { deps, ledger, rs, worker } = build({
      fetch: jest.fn().mockResolvedValue({ html: '<html>challenge</html>', statusCode: status }),
    });

    const outcome = await worker(TASK);

    expect(rs.extract).not.toHaveBeenCalled();
    expect(deps.emit).not.toHaveBeenCalled();
    expect(ledger.done).toEqual([]);
    expect(ledger.failed).toEqual([]);
    expect(outcome).toBe('rate-limited');
  });

  it('extract throwing (coverage-block / parse failure) → markFailed + success (host cooperated)', async () => {
    const rs = ruleset({ extract: jest.fn().mockRejectedValue(new Error('coverage blocked')) });
    const { deps, ledger, worker } = build({ lookupRuleset: jest.fn().mockReturnValue(rs) });

    const outcome = await worker(TASK);

    expect(deps.emit).not.toHaveBeenCalled();
    expect(ledger.failed).toEqual(['abc123']);
    expect(ledger.done).toEqual([]);
    expect(outcome).toBe('success');
  });

  it('emit throwing (delivery failure) → rate-limited, item left pending (not marked failed)', async () => {
    const { deps, ledger, worker } = build({ emit: jest.fn().mockRejectedValue(new Error('spine UNAVAILABLE')) });

    const outcome = await worker(TASK);

    expect(ledger.done).toEqual([]);
    expect(ledger.failed).toEqual([]); // pending — delivery, not the item, failed
    expect(outcome).toBe('rate-limited');
  });

  it('threads an ExtractContext from resolveContext into extract (multi-query rulesets)', async () => {
    const ctx = { config: {}, scraping: {}, logger: {} } as never;
    const rs = ruleset();
    const resolveContext = jest.fn().mockReturnValue(ctx);
    const { worker } = build({ lookupRuleset: jest.fn().mockReturnValue(rs), resolveContext });

    await worker(TASK);

    expect(resolveContext).toHaveBeenCalledWith(TASK, URL);
    expect(rs.extract).toHaveBeenCalledWith('<html>ok</html>', URL, ctx);
  });

  it('a non-throttle error status (e.g. 404) still runs extract — the ruleset judges the content', async () => {
    const rs = ruleset();
    const { deps, worker } = build({
      lookupRuleset: jest.fn().mockReturnValue(rs),
      fetch: jest.fn().mockResolvedValue({ html: '<html>not found</html>', statusCode: 404 }),
    });

    await worker(TASK);

    expect(rs.extract).toHaveBeenCalled();
    expect(deps.emit).toHaveBeenCalled();
  });

  it('honors custom throttleStatuses (e.g. treat 202 as throttle)', async () => {
    const { deps, worker } = build({
      throttleStatuses: [202],
      fetch: jest.fn().mockResolvedValue({ html: '<html/>', statusCode: 202 }),
    });

    const outcome = await worker(TASK);

    expect(deps.emit).not.toHaveBeenCalled();
    expect(outcome).toBe('rate-limited');
  });
});
