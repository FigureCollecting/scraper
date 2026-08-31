/**
 * ScrapeQueue ingest HONESTY tests — the queue must key ingest success on what the spine actually
 * PERSISTED (server WriteStats), never on "the send() call didn't throw". A record whose server
 * stats show inserted+deduped == 0 across all four tables (claims/identifiers/prices/availability)
 * persisted NOTHING and MUST fail (flow through the queue's attempts/backoff/FAILED handling),
 * while an all-deduped re-run (idempotent) MUST stay success. The queue also logs a per-record
 * [INGEST STATS] line and folds a persisted= aggregate into the "Ingest complete" line.
 *
 * Setup mirrors scrapeQueueIngest.test.ts (same mock ruleset / registry / scraping stub).
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

import type { ExtractionRuleset } from '@figurecollecting/scraper-plugin-contract';
import { ScrapeQueue, resetScrapeQueue } from '../../services/scrapeQueue';
import { createExtractionRegistry, ExtractionRegistryImpl } from '../../services/extractionRegistry';

const FIXTURE_HTML = '<html><body><h1 class="title">Kitagawa Marin</h1></body></html>';

function makeRegistry(ruleset: ExtractionRuleset, domain = 'myfigurecollection.net'): ExtractionRegistryImpl {
  const registry = createExtractionRegistry();
  registry.registerSite({
    siteId: ruleset.siteId,
    name: 'Mock MFC',
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

function makeRuleset(): ExtractionRuleset & { extract: jest.Mock } {
  const extract = jest.fn((html: string, url: string) => ({
    source: { site: 'mock-mfc', itemId: '12345', url, extractedAt: '2026-07-24T00:00:00.000Z', rulesetVersion: '1.0.0' },
    fields: { name: 'Kitagawa Marin', jan: '4530956107891' },
    warnings: [],
  }));
  return { siteId: 'mock-mfc', version: '1.0.0', extract, validate: () => ({ valid: true, errors: [], warnings: [] }) };
}

function makeScrapingStub() {
  const page = { html: FIXTURE_HTML, url: 'https://myfigurecollection.net/item/12345', title: 'Item', statusCode: 200 };
  return {
    scrapePage: jest.fn().mockResolvedValue(page),
    scrapePageStealth: jest.fn().mockResolvedValue(page),
  };
}

// --- WriteStats-shaped fakes (the emitter resolves the ingest-contract WriteStats) --------------
const zClaim = (o: Record<string, number> = {}) => ({ emitted: 0, inserted: 0, deduped: 0, quarantined: 0, dropped: 0, ...o });
const zTable = (o: Record<string, number> = {}) => ({ emitted: 0, inserted: 0, deduped: 0, dropped: 0, ...o });
const zPrice = (o: Record<string, number> = {}) => ({ emitted: 0, inserted: 0, deduped: 0, skipped: 0, dropped: 0, ...o });
const statsWith = (o: Record<string, unknown>) => ({
  sourceId: 'src-1', productId: 'prod-1',
  claims: zClaim(), identifiers: zTable(), prices: zPrice(), availability: zTable(),
  warnings: [] as string[], registeredNewAttrs: 0, emptyFields: 0, ...o,
});
/** All four tables present, all zero — the anitoysgk "OK WriteStats, all-zero counts" bug shape. */
const EMPTY_STATS = statsWith({ warnings: ['anchor identifier unstorable; claims unbound'], emptyFields: 6 });
/** inserted=0 but deduped>0 — a legitimate idempotent re-run; MUST stay success. */
const DEDUP_STATS = statsWith({ claims: zClaim({ emitted: 20, deduped: 20 }) });
/** A healthy first-write: some inserted. */
const HEALTHY_STATS = statsWith({ claims: zClaim({ emitted: 3, inserted: 3 }), identifiers: zTable({ emitted: 1, inserted: 1 }) });

describe('ScrapeQueue - ingest honesty (persist-or-fail)', () => {
  let queue: ScrapeQueue;

  beforeEach(() => {
    jest.clearAllMocks();
    mockNotifyItemFailed.mockResolvedValue(true); // clearAllMocks wipes the resolved value; re-arm it
    jest.useFakeTimers({ advanceTimers: true });
    resetScrapeQueue();
  });

  afterEach(() => {
    if (queue) { queue.stop(); queue.clear(); }
    resetScrapeQueue();
    jest.useRealTimers();
  });

  async function advanceUntil(pred: () => boolean, stepMs = 250, maxSteps = 200): Promise<void> {
    for (let i = 0; i < maxSteps && !pred(); i++) {
      jest.advanceTimersByTime(stepMs);
      await jest.advanceTimersByTimeAsync(50);
    }
  }

  function buildQueue(send: jest.Mock): ScrapeQueue {
    const q = new ScrapeQueue(false);
    q.setPluginRegistry(makeRegistry(makeRuleset()));
    q.setIngestEmitter({ send });
    q.setScrapingService(makeScrapingStub());
    return q;
  }

  it('FAILS a record the spine persisted nothing for (all-zero stats) — EmptyIngestRecordError, not success', async () => {
    const send = jest.fn().mockResolvedValue(EMPTY_STATS);
    queue = buildQueue(send);

    const result = queue.enqueue('12345', { priority: 'WARM', sessionId: 'session1', maxRetries: 0 });
    result.promise.catch(() => {}); // avoid unhandled rejection noise
    await advanceUntil(() => queue.getStats().failed === 1);

    expect(send).toHaveBeenCalledTimes(1);
    expect(queue.getStats().failed).toBe(1);
    expect(queue.getStats().completed).toBe(0); // NEVER counted a success
    await expect(result.promise).rejects.toThrow(/EMPTY_INGEST_RECORD|Scrape failed/);
    // permanent-failure webhook fired with a clear, specific reason
    expect(mockNotifyItemFailed).toHaveBeenCalledTimes(1);
    const reason = mockNotifyItemFailed.mock.calls[0][2] as string;
    expect(reason).toContain('EMPTY_INGEST_RECORD');
    expect(reason).toContain('mock-mfc:12345');
  });

  it('treats a bare stats response with no per-table accounting as EMPTY (no persisted rows, no warnings)', async () => {
    // A WriteStats that reports NO table accounting persisted nothing we can account for — fail it
    // the same as an all-zero response (the honesty gate never assumes success from silence).
    const send = jest.fn().mockResolvedValue({ sourceId: 'bare' });
    queue = buildQueue(send);

    const result = queue.enqueue('12345', { priority: 'WARM', sessionId: 'session1', maxRetries: 0 });
    result.promise.catch(() => {});
    await advanceUntil(() => queue.getStats().failed === 1);

    expect(queue.getStats().failed).toBe(1);
    expect(queue.getStats().completed).toBe(0);
    const reason = mockNotifyItemFailed.mock.calls[0][2] as string;
    expect(reason).toContain('EMPTY_INGEST_RECORD');
    expect(reason).toContain('(no server warnings)'); // no-warnings branch of the error message
  });

  it('treats an undefined send() result as an EMPTY record (typed EmptyIngestRecordError + zeroed [INGEST STATS]), never a TypeError', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const send = jest.fn().mockResolvedValue(undefined); // emitter resolved nothing (no WriteStats object)
    queue = buildQueue(send);

    const result = queue.enqueue('12345', { priority: 'WARM', sessionId: 'session1', maxRetries: 0 });
    const captured = result.promise.catch((e: Error) => e);
    await advanceUntil(() => queue.getStats().failed === 1);

    expect(queue.getStats().failed).toBe(1);
    expect(queue.getStats().completed).toBe(0);
    const err = (await captured) as Error;
    // a typed empty-record failure — NOT a TypeError from reading stats.claims on undefined
    expect(err).not.toBeInstanceOf(TypeError);
    expect(err.message).toMatch(/Scrape failed: empty_record - EMPTY_INGEST_RECORD/);
    const reason = mockNotifyItemFailed.mock.calls[0][2] as string;
    expect(reason).toContain('EMPTY_INGEST_RECORD');
    // a zeroed [INGEST STATS] line was still emitted (accounting, not skipped by an early throw)
    const stat = logSpy.mock.calls.map(c => String(c[0])).find(l => l.startsWith('[INGEST STATS] mock-mfc:12345'));
    expect(stat).toBe('[INGEST STATS] mock-mfc:12345 claims=0/0/0/0 prices=0/0/0/0 identifiers=0/0/0 availability=0/0/0 warnings=0');
    logSpy.mockRestore();
  });

  it('counts partial per-table stats (missing count fields default to 0) — persists what landed', async () => {
    // claims reports only deduped, identifiers reports only inserted (other count fields undefined):
    // persistedRows must treat the absent fields as 0 and still total 5 + 3 = 8 (a SUCCESS).
    const send = jest.fn().mockResolvedValue({ sourceId: 'partial', claims: { deduped: 5 }, identifiers: { inserted: 3 } });
    queue = buildQueue(send);

    const result = queue.enqueue('12345', { priority: 'WARM', maxRetries: 0 });
    await advanceUntil(() => queue.getStats().completed === 1 || queue.getStats().failed === 1);
    await result.promise;

    expect(queue.getStats().completed).toBe(1);
    expect(queue.getStats().failed).toBe(0);
  });

  it('rethrows a NON-Error send rejection cleanly (wrapped as Error) and fails the item', async () => {
    const send = jest.fn().mockRejectedValue('spine string fault'); // rejects with a bare string, not an Error
    queue = buildQueue(send);

    const result = queue.enqueue('12345', { priority: 'WARM', sessionId: 'session1', maxRetries: 0 });
    const captured = result.promise.catch((e: unknown) => e);
    await advanceUntil(() => queue.getStats().failed === 1);

    expect(queue.getStats().failed).toBe(1);
    expect(queue.getStats().completed).toBe(0);
    const err = await captured;
    expect(err).toBeInstanceOf(Error);
    expect(mockNotifyItemFailed).toHaveBeenCalledTimes(1);
  });

  it('SUCCEEDS on an all-deduped re-run (inserted=0, deduped=20) — idempotent, not empty', async () => {
    const send = jest.fn().mockResolvedValue(DEDUP_STATS);
    queue = buildQueue(send);

    const result = queue.enqueue('12345', { priority: 'WARM', sessionId: 'session1', maxRetries: 0 });
    await advanceUntil(() => queue.getStats().completed === 1 || queue.getStats().failed === 1);

    const data = await result.promise;
    expect(data).toEqual({ name: 'Kitagawa Marin', jan: '4530956107891' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(queue.getStats().completed).toBe(1);
    expect(queue.getStats().failed).toBe(0);
    expect(mockNotifyItemFailed).not.toHaveBeenCalled();
  });

  it('logs a per-record [INGEST STATS] line and folds persisted= into the "Ingest complete" line', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const send = jest.fn().mockResolvedValue(HEALTHY_STATS);
    queue = buildQueue(send);

    const result = queue.enqueue('12345', { priority: 'WARM', maxRetries: 0 });
    await advanceUntil(() => queue.getStats().completed === 1 || queue.getStats().failed === 1);
    await result.promise;

    const lines = logSpy.mock.calls.map(c => String(c[0]));
    // claims=ins/dedup/drop/quar  prices=ins/dedup/skip/drop  identifiers=ins/dedup/drop  availability=ins/dedup/drop
    const stat = lines.find(l => l.startsWith('[INGEST STATS] mock-mfc:12345'));
    expect(stat).toBe('[INGEST STATS] mock-mfc:12345 claims=3/0/0/0 prices=0/0/0/0 identifiers=1/0/0 availability=0/0/0 warnings=0');
    // persisted = (claims inserted+deduped) + (identifiers inserted+deduped) = 3 + 1 = 4
    const complete = lines.find(l => l.includes('Ingest complete'));
    expect(complete).toContain('persisted=4 emitted=1/1');

    logSpy.mockRestore();
  });

  it('logs up to the first 3 server warnings (sanitized) under the stats line', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const send = jest.fn().mockResolvedValue(
      statsWith({
        claims: zClaim({ emitted: 1, inserted: 1 }),
        warnings: ['first warning', 'second\nwith-newline', 'third warning', 'fourth warning (dropped)'],
      }),
    );
    queue = buildQueue(send);

    const result = queue.enqueue('12345', { priority: 'WARM', maxRetries: 0 });
    await advanceUntil(() => queue.getStats().completed === 1 || queue.getStats().failed === 1);
    await result.promise;

    const warnLines = logSpy.mock.calls.map(c => String(c[0])).filter(l => l.includes('[INGEST STATS]') && l.includes('warn:'));
    expect(warnLines).toHaveLength(3); // first 3 only
    expect(warnLines[0]).toContain('first warning');
    expect(warnLines[1]).toContain('second with-newline'); // newline sanitized to space
    expect(warnLines[1]).not.toContain('\n');
    expect(warnLines.some(l => l.includes('fourth warning'))).toBe(false);

    logSpy.mockRestore();
  });

  it('a permanently-empty store EXHAUSTS attempts then lands FAILED (default retries, no infinite loop)', async () => {
    const send = jest.fn().mockResolvedValue(EMPTY_STATS); // every attempt persists nothing
    queue = buildQueue(send);

    const result = queue.enqueue('12345', { priority: 'WARM', sessionId: 'session1' }); // default maxRetries = 3
    result.promise.catch(() => {});
    // Drive until terminal FAILED; if it looped forever this predicate never trips and the assertions below fail.
    await advanceUntil(() => queue.getStats().failed === 1, 250, 400);

    expect(queue.getStats().failed).toBe(1);
    expect(queue.getStats().completed).toBe(0);
    // Bounded: exactly (default maxRetries=3) attempts — never an unbounded retry storm
    expect(send).toHaveBeenCalledTimes(3);
    expect(mockNotifyItemFailed).toHaveBeenCalledTimes(1);
  });
});
