/**
 * TDD (red first) — emit honesty-gate: distinguish a VALID-EMPTY extraction (the extractor
 * successfully determined there are genuinely zero records — a well-formed empty listing/search
 * result) from an ERROR-empty (extraction failure / challenge page / a record the spine persisted
 * nothing for). Ross's directive: "differentiate between no data when none expected and no data as
 * error."
 *
 * The distinction is the EXTRACTOR'S OWN SIGNAL, never the row count alone: a ruleset opts in via
 * `emptyResultIsValid` (added to the in-repo plugin contract, packages/plugin-contract) AND returns
 * zero records from `extractMany`. Only THEN is a zero-record extraction on a NON-challenge page a
 * SUCCESS. Everything else stays a failure:
 *   - a NON-opting ruleset returning `[]` still throws (extractRecords' D11 empty-guard);
 *   - an emitted record the spine persisted nothing for still throws EmptyIngestRecordError;
 *   - a CHALLENGE page is never swept into valid-empty.
 *
 * Harness uses the http transport lane (like scrapeQueueCooldownRecovery.test.ts) so a challenge
 * page can be exercised via the returned body; fake timers throughout — no live fetches.
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
import { createExtractionRegistry, ExtractionRegistryImpl } from '../../services/extractionRegistry';
import { resetSessionManager } from '../../services/sessionManager';
import { resetChallengeCooldown } from '../../services/challengeCooldown';

/** The proposed opt-in, expressed locally so the test compiles whether or not the contract carries it yet. */
type OptInRuleset = ExtractionRuleset & { emptyResultIsValid?: boolean };

const DOMAIN = 'emptystore.test';
const CLEAN_HTML = '<html><body><h1 class="title">Results</h1></body></html>';
const CHALLENGE_HTML = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

const zClaim = (o: Record<string, number> = {}) => ({ emitted: 0, inserted: 0, deduped: 0, quarantined: 0, dropped: 0, ...o });
const zTable = (o: Record<string, number> = {}) => ({ emitted: 0, inserted: 0, deduped: 0, dropped: 0, ...o });
const zPrice = () => ({ emitted: 0, inserted: 0, deduped: 0, skipped: 0, dropped: 0 });
const EMPTY_STATS = () => ({ sourceId: 's', productId: 'p', claims: zClaim(), identifiers: zTable(), prices: zPrice(), availability: zTable(), warnings: [] as string[], emptyFields: 6 });
const HEALTHY_STATS = () => ({ sourceId: 's', productId: 'p', claims: zClaim({ emitted: 2, inserted: 2 }), identifiers: zTable({ emitted: 1, inserted: 1 }), prices: zPrice(), availability: zTable(), warnings: [] as string[], emptyFields: 0 });

function recordFor(url: string, itemId = 'r1'): ExtractedData {
  return {
    source: { site: 'empty-store', itemId, url, extractedAt: '2026-09-01T00:00:00.000Z', rulesetVersion: '1.0.0' },
    fields: { name: 'A Figure' },
    warnings: [],
  };
}

/** A ruleset whose extractMany returns `records`, with an explicit valid-empty opt-in flag. */
function makeRuleset(opts: { emptyResultIsValid?: boolean; records: ExtractedData[] }): OptInRuleset {
  const r: OptInRuleset = {
    siteId: 'empty-store',
    version: '1.0.0',
    extract: (_html: string, url: string) => recordFor(url),
    extractMany: (_html: string, _url: string) => opts.records,
    validate: () => ({ valid: true, errors: [], warnings: [] }),
  };
  if (opts.emptyResultIsValid !== undefined) r.emptyResultIsValid = opts.emptyResultIsValid;
  return r;
}

function makeRegistry(ruleset: OptInRuleset): ExtractionRegistryImpl {
  const registry = createExtractionRegistry();
  const caps: StoreCapabilities = {
    siteId: ruleset.siteId,
    name: ruleset.siteId,
    domains: [DOMAIN],
    rateLimit: { domain: DOMAIN, baseDelayMs: 200, minDelayMs: 100, maxDelayMs: 5000, backoffMultiplier: 1.5, recoveryDivisor: 1.5, successThreshold: 3 },
    requiresBrowser: false,
    allowedCookies: [],
    searchFetch: { transport: 'http' },
  };
  registry.registerSite(caps);
  registry.registerRuleset(ruleset as ExtractionRuleset);
  return registry;
}

describe('ScrapeQueue — valid-empty vs error-empty (emit honesty gate)', () => {
  let queue: ScrapeQueue;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockNotifyItemFailed.mockResolvedValue(true);
    jest.useFakeTimers({ advanceTimers: true });
    resetScrapeQueue();
    resetSessionManager();
    resetChallengeCooldown();
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    if (queue) { queue.stop(); queue.clear(); }
    resetScrapeQueue();
    resetSessionManager();
    resetChallengeCooldown();
    logSpy.mockRestore();
    jest.useRealTimers();
  });

  async function advanceUntil(pred: () => boolean, stepMs = 200, maxSteps = 200): Promise<void> {
    for (let i = 0; i < maxSteps && !pred(); i++) {
      jest.advanceTimersByTime(stepMs);
      await jest.advanceTimersByTimeAsync(30);
    }
  }

  function build(ruleset: OptInRuleset, send: jest.Mock, http: jest.Mock): ScrapeQueue {
    const q = new ScrapeQueue(false);
    q.setPluginRegistry(makeRegistry(ruleset));
    q.setIngestEmitter({ send });
    q.setScrapingService({ scrapePage: jest.fn(), scrapePageStealth: jest.fn() } as any);
    q.setIngestTransports({ http });
    return q;
  }

  const logLines = () => logSpy.mock.calls.map((c) => String(c[0]));

  // ---- (a) valid-empty → SUCCESS (the behavior change) ----------------------------------------
  it('records an OPTED-IN ruleset returning zero records on a clean page as a SUCCESS (persisted=0 emitted=0 valid-empty), never emitting', async () => {
    const send = jest.fn();
    const http = jest.fn(async () => CLEAN_HTML);
    queue = build(makeRuleset({ emptyResultIsValid: true, records: [] }), send, http);

    const result = queue.enqueue(`https://${DOMAIN}/search/none`, { url: `https://${DOMAIN}/search/none`, maxRetries: 0 });
    await advanceUntil(() => queue.getStats().completed === 1 || queue.getStats().failed === 1);

    const data = await result.promise;
    expect(queue.getStats().completed).toBe(1);
    expect(queue.getStats().failed).toBe(0);
    expect(send).not.toHaveBeenCalled(); // nothing to emit — never sent to the spine
    expect(data).toEqual({}); // empty result bag resolves the waiting caller
    expect(logLines().some((l) => l.includes('valid-empty') && l.includes('persisted=0 emitted=0'))).toBe(true);
    expect(mockNotifyItemFailed).not.toHaveBeenCalled();
  });

  // ---- (b) error-empty variants → STILL a failure ---------------------------------------------
  it('still FAILS an OPTED-IN ruleset whose emitted record the spine persisted nothing for (EmptyIngestRecordError — the opt-in never rescues the persist gate)', async () => {
    const send = jest.fn().mockResolvedValue(EMPTY_STATS());
    const http = jest.fn(async () => CLEAN_HTML);
    // Opts in, but RETURNS A REAL RECORD — so extraction is non-empty; the persist gate governs.
    queue = build(makeRuleset({ emptyResultIsValid: true, records: [recordFor(`https://${DOMAIN}/p/1`)] }), send, http);

    const result = queue.enqueue(`https://${DOMAIN}/p/1`, { url: `https://${DOMAIN}/p/1`, sessionId: 's1', maxRetries: 0 });
    const captured = result.promise.catch((e: Error) => e);
    await advanceUntil(() => queue.getStats().failed === 1);

    expect(queue.getStats().failed).toBe(1);
    expect(queue.getStats().completed).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
    const err = (await captured) as Error;
    expect(err.message).toMatch(/empty_record - EMPTY_INGEST_RECORD/);
  });

  it('still FAILS a NON-opting ruleset that returns zero records (extractRecords D11 empty-guard preserved)', async () => {
    const send = jest.fn();
    const http = jest.fn(async () => CLEAN_HTML);
    queue = build(makeRuleset({ records: [] }), send, http); // no emptyResultIsValid opt-in

    const result = queue.enqueue(`https://${DOMAIN}/search/none`, { url: `https://${DOMAIN}/search/none`, maxRetries: 0 });
    const captured = result.promise.catch((e: Error) => e);
    await advanceUntil(() => queue.getStats().failed === 1);

    expect(queue.getStats().failed).toBe(1);
    expect(queue.getStats().completed).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect((await captured)).toBeInstanceOf(Error);
  });

  it('never sweeps a CHALLENGE page into valid-empty, even for an opted-in ruleset that returns zero records', async () => {
    const send = jest.fn();
    const http = jest.fn(async () => CHALLENGE_HTML); // the fetched body is a Cloudflare challenge
    queue = build(makeRuleset({ emptyResultIsValid: true, records: [] }), send, http);

    const result = queue.enqueue(`https://${DOMAIN}/p/2`, { url: `https://${DOMAIN}/p/2`, maxRetries: 0 });
    const captured = result.promise.catch((e: Error) => e);
    await advanceUntil(() => queue.getStats().failed === 1);

    expect(queue.getStats().failed).toBe(1);
    expect(queue.getStats().completed).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect((await captured)).toBeInstanceOf(Error);
    expect(logLines().some((l) => l.includes('valid-empty'))).toBe(false); // NOT recorded as valid-empty
  });

  // ---- (c) normal non-empty → unchanged -------------------------------------------------------
  it('leaves a normal non-empty extraction unchanged (opt-in present but a record persists rows → SUCCESS)', async () => {
    const send = jest.fn().mockResolvedValue(HEALTHY_STATS());
    const http = jest.fn(async () => CLEAN_HTML);
    queue = build(makeRuleset({ emptyResultIsValid: true, records: [recordFor(`https://${DOMAIN}/p/3`)] }), send, http);

    const result = queue.enqueue(`https://${DOMAIN}/p/3`, { url: `https://${DOMAIN}/p/3`, maxRetries: 0 });
    await advanceUntil(() => queue.getStats().completed === 1 || queue.getStats().failed === 1);

    await result.promise;
    expect(queue.getStats().completed).toBe(1);
    expect(queue.getStats().failed).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(logLines().some((l) => l.includes('valid-empty'))).toBe(false);
  });
});
