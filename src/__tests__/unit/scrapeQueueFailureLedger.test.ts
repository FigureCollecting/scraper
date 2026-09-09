/**
 * ScrapeQueue × the fetch-failure ledger (E1 / E2).
 *
 * The queue's give-up branch is THE terminal seam of the record lane: every non-retryable class and
 * every exhausted retry funnels through it. What this proves:
 *
 *   1. ONE report per GIVE-UP, never one per attempt — the ledger's `attempts` drives the spine's
 *      backoff, so a retried item that is re-queued three times must still land exactly one row.
 *   2. A cooldown fast-fail is reported as `cooldown` carrying the next-retry hint (the operator
 *      asked to see hosts we are deliberately leaving alone).
 *   3. The row carries the store's siteId + ruleset version when a ruleset matched, and falls back
 *      to the reserved 'unmatched' site when none did (the target still names the url).
 *   4. A reporter that throws NEVER reaches the item's own outcome.
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

import type { ExtractionRuleset, StoreCapabilities } from '@figurecollecting/scraper-plugin-contract';
import { ScrapeQueue, resetScrapeQueue } from '../../services/scrapeQueue';
import { ChallengeCooldown, resetChallengeCooldown } from '../../services/challengeCooldown';
import { createExtractionRegistry, ExtractionRegistryImpl } from '../../services/extractionRegistry';
import { resetSessionManager } from '../../services/sessionManager';
import type { FetchFailureReport } from '../../services/failureReporter';

const FIXTURE_HTML = '<html><body><h1 class="title">Kitagawa Marin</h1></body></html>';
const CHALLENGE_HTML = '<html><head><title>Just a moment...</title></head><body>cf</body></html>';
const HOST = 'ledgerhost.example.test';

function makeRuleset(siteId: string): ExtractionRuleset {
  return {
    siteId,
    version: '2.3.4',
    extract: (_html: string, url: string) => ({
      source: { site: siteId, itemId: 'x', url, extractedAt: '2026-09-08T00:00:00.000Z', rulesetVersion: '2.3.4' },
      fields: { name: 'Kitagawa Marin' },
      warnings: [],
    }),
    validate: () => ({ valid: true, errors: [], warnings: [] }),
  };
}

function makeRegistry(ruleset: ExtractionRuleset, domain: string): ExtractionRegistryImpl {
  const registry = createExtractionRegistry();
  const caps: StoreCapabilities = {
    siteId: ruleset.siteId,
    name: 'Ledger Store',
    domains: [domain],
    rateLimit: { domain, baseDelayMs: 1000, minDelayMs: 500, maxDelayMs: 5000, backoffMultiplier: 1.5, recoveryDivisor: 1.5, successThreshold: 3 },
    requiresBrowser: false,
    allowedCookies: [],
    searchFetch: { transport: 'http' },
  };
  registry.registerSite(caps);
  registry.registerRuleset(ruleset);
  return registry;
}

function makeScrapingStub() {
  const page = { html: FIXTURE_HTML, url: `https://${HOST}/item/1`, title: 'Item', statusCode: 200 };
  return { scrapePage: jest.fn().mockResolvedValue(page), scrapePageStealth: jest.fn().mockResolvedValue(page) };
}

const zClaim = (o: Record<string, number> = {}) => ({ emitted: 0, inserted: 0, deduped: 0, quarantined: 0, dropped: 0, ...o });
const zTable = (o: Record<string, number> = {}) => ({ emitted: 0, inserted: 0, deduped: 0, dropped: 0, ...o });
const zPrice = (o: Record<string, number> = {}) => ({ emitted: 0, inserted: 0, deduped: 0, skipped: 0, dropped: 0, ...o });
const emptyStats = () => ({
  sourceId: 's', productId: 'p', claims: zClaim(), identifiers: zTable(), prices: zPrice(), availability: zTable(),
  warnings: [] as string[], registeredNewAttrs: 0, emptyFields: 6,
});

describe('ScrapeQueue × fetch-failure ledger', () => {
  let queue: ScrapeQueue;
  let reports: FetchFailureReport[];
  let cd: ChallengeCooldown;
  let cdNow: number;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ advanceTimers: true });
    resetScrapeQueue();
    resetSessionManager();
    resetChallengeCooldown();
    reports = [];
    cdNow = 1_000_000;
    cd = new ChallengeCooldown({ now: () => cdNow, windowMs: 10 * 60_000 });
  });

  afterEach(() => {
    if (queue) { queue.stop(); queue.clear(); }
    resetScrapeQueue();
    resetSessionManager();
    resetChallengeCooldown();
    jest.useRealTimers();
  });

  async function advanceUntil(pred: () => boolean, stepMs = 250, maxSteps = 400): Promise<void> {
    for (let i = 0; i < maxSteps && !pred(); i++) {
      jest.advanceTimersByTime(stepMs);
      await jest.advanceTimersByTimeAsync(50);
    }
  }

  function buildQueue(opts: {
    http: jest.Mock;
    send: jest.Mock;
    registry?: ExtractionRegistryImpl | null;
    report?: (r: FetchFailureReport) => Promise<void>;
  }): ScrapeQueue {
    const q = new ScrapeQueue(false);
    q.setPluginRegistry(opts.registry === null ? null : (opts.registry ?? makeRegistry(makeRuleset('ledgerstore'), HOST)));
    q.setIngestEmitter({ send: opts.send });
    q.setScrapingService(makeScrapingStub());
    q.setIngestTransports({ http: opts.http });
    q.setChallengeCooldown(cd);
    q.setFailureReporter({
      report: opts.report ?? (async (r: FetchFailureReport) => { reports.push(r); }),
    });
    return q;
  }

  it('reports ONE row per give-up, not one per retry attempt', async () => {
    const http = jest.fn().mockRejectedValue(new Error('ECONNRESET reading body'));
    const send = jest.fn();
    queue = buildQueue({ http, send });

    const url = `https://${HOST}/product/12345`;
    const result = queue.enqueue(url, { url, maxRetries: 2 });
    result.promise.catch(() => {});
    await advanceUntil(() => queue.getStats().failed === 1);

    expect(http.mock.calls.length).toBeGreaterThan(1); // the queue really did retry
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      site: 'ledgerstore',
      kind: 'record',
      origin: 'ingest',
      reasonClass: 'network',
      target: url,
      rulesetVersion: '2.3.4',
    });
  });

  it('reports a cooldown fast-fail as cooldown with a next-retry hint', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    cd.open(HOST, 'challenge page');
    const http = jest.fn().mockResolvedValue(FIXTURE_HTML);
    const send = jest.fn();
    queue = buildQueue({ http, send });

    const url = `https://${HOST}/product/999`;
    const result = queue.enqueue(url, { url });
    result.promise.catch(() => {});
    await advanceUntil(() => queue.getStats().failed === 1);

    expect(http).not.toHaveBeenCalled();
    expect(reports).toHaveLength(1);
    expect(reports[0].reasonClass).toBe('cooldown');
    expect(reports[0].nextRetryHint).toBeDefined();
    expect(Date.parse(reports[0].nextRetryHint!)).toBeGreaterThan(Date.now());
  });

  it('reports a challenge page as challenge, naming the lane that served it', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const http = jest.fn().mockResolvedValue(CHALLENGE_HTML);
    const send = jest.fn().mockResolvedValue(emptyStats());
    queue = buildQueue({ http, send });

    const url = `https://${HOST}/product/777`;
    const result = queue.enqueue(url, { url });
    result.promise.catch(() => {});
    await advanceUntil(() => queue.getStats().failed === 1);

    expect(reports).toHaveLength(1);
    expect(reports[0].reasonClass).toBe('challenge');
    expect(reports[0].transport).toBe('http');
  });

  it('files a url no ruleset claims under the reserved site, never its hostname', async () => {
    const http = jest.fn();
    const send = jest.fn();
    queue = buildQueue({ http, send, registry: null });

    const url = `https://www.${HOST}/product/55`;
    const result = queue.enqueue(url, { url });
    result.promise.catch(() => {});
    await advanceUntil(() => queue.getStats().failed === 1);

    expect(reports).toHaveLength(1);
    // A hostname as `site` would register a host-shaped source in the shared spine vocabulary and
    // split one store's ledger in two the moment a ruleset skew comes and goes.
    expect(reports[0].site).toBe('unmatched');
    expect(reports[0].target).toBe(url); // the host stays recoverable from the target
    expect(reports[0].reasonClass).toBe('ruleset');
    expect(reports[0].rulesetVersion).toBeUndefined();
  });

  it('a throwing reporter never changes the item outcome', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const http = jest.fn().mockRejectedValue(new Error('ECONNRESET'));
    const send = jest.fn();
    queue = buildQueue({
      http,
      send,
      report: () => { throw new Error('reporter exploded'); },
    });

    const url = `https://${HOST}/product/1`;
    const result = queue.enqueue(url, { url, maxRetries: 0 });
    const settled = result.promise.catch((e: Error) => e.message);
    await advanceUntil(() => queue.getStats().failed === 1);

    expect(queue.getStats().failed).toBe(1);
    await expect(settled).resolves.toContain('Scrape failed');
  });

  it('is a no-op with no reporter configured', async () => {
    const http = jest.fn().mockRejectedValue(new Error('ECONNRESET'));
    const send = jest.fn();
    queue = buildQueue({ http, send });
    queue.setFailureReporter(null);

    const url = `https://${HOST}/product/2`;
    const result = queue.enqueue(url, { url, maxRetries: 0 });
    result.promise.catch(() => {});
    await advanceUntil(() => queue.getStats().failed === 1);

    expect(reports).toHaveLength(0);
    expect(queue.getStats().failed).toBe(1);
  });
});
