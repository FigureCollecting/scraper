/**
 * ScrapeQueue × the record lane's STATUS GATE (planner risk R1).
 *
 * The record fetch used to be status-blind: whatever bytes came back went to the ruleset, so a
 * store's 404 page, a busy 5xx and an item URL that bounced to the shop's front page were all
 * booked against OUR extraction — `parse`, `ruleset`, or the operator's `other` bucket — and a
 * terminal 404 was retried to exhaustion first. Now every lane surfaces {status, finalUrl}, so the
 * queue can name what the STORE said before extraction is attempted.
 *
 * What this proves, end to end through the real queue:
 *   1. 404 / 410 are TERMINAL — one fetch, no retries, and the ledger row says gone_404 / gone_410
 *      with the status echoed.
 *   2. 429 / 5xx are TRANSIENT — retried, then ONE row naming http_429 / http_5xx.
 *   3. A 200 that landed on the store's home page is redirect_home, terminal, and the ruleset is
 *      never handed the landing page.
 *   4. A Cloudflare interstitial keeps its OWN path (challenge + host cooldown) even though it
 *      carries a 403 — the status gate must never pre-empt the challenge discipline.
 *   5. A healthy 200 on a real path is untouched.
 *
 * Setup mirrors scrapeQueueFailureLedger.test.ts (same registry / scraping stub / WriteStats fakes).
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
const HOST = 'statushost.example.test';
const ITEM_URL = `https://${HOST}/product/12345`;

function makeRuleset(extract: jest.Mock): ExtractionRuleset {
  return {
    siteId: 'statusstore',
    version: '2.3.4',
    extract: extract as unknown as ExtractionRuleset['extract'],
    validate: () => ({ valid: true, errors: [], warnings: [] }),
  };
}

function makeExtract(): jest.Mock {
  return jest.fn((_html: string, url: string) => ({
    source: { site: 'statusstore', itemId: '12345', url, extractedAt: '2026-09-09T00:00:00.000Z', rulesetVersion: '2.3.4' },
    fields: { name: 'Kitagawa Marin' },
    warnings: [],
  }));
}

function makeRegistry(ruleset: ExtractionRuleset): ExtractionRegistryImpl {
  const registry = createExtractionRegistry();
  const caps: StoreCapabilities = {
    siteId: ruleset.siteId,
    name: 'Status Store',
    domains: [HOST],
    rateLimit: { domain: HOST, baseDelayMs: 1000, minDelayMs: 500, maxDelayMs: 5000, backoffMultiplier: 1.5, recoveryDivisor: 1.5, successThreshold: 3 },
    requiresBrowser: false,
    allowedCookies: [],
    searchFetch: { transport: 'http' },
  };
  registry.registerSite(caps);
  registry.registerRuleset(ruleset);
  return registry;
}

function makeScrapingStub() {
  const page = { html: FIXTURE_HTML, url: ITEM_URL, title: 'Item', statusCode: 200 };
  return { scrapePage: jest.fn().mockResolvedValue(page), scrapePageStealth: jest.fn().mockResolvedValue(page) };
}

const zClaim = (o: Record<string, number> = {}) => ({ emitted: 0, inserted: 0, deduped: 0, quarantined: 0, dropped: 0, ...o });
const zTable = (o: Record<string, number> = {}) => ({ emitted: 0, inserted: 0, deduped: 0, dropped: 0, ...o });
const zPrice = (o: Record<string, number> = {}) => ({ emitted: 0, inserted: 0, deduped: 0, skipped: 0, dropped: 0, ...o });
const baseStats = (o: Record<string, unknown> = {}) => ({
  sourceId: 's', productId: 'p', claims: zClaim(), identifiers: zTable(), prices: zPrice(), availability: zTable(),
  warnings: [] as string[], registeredNewAttrs: 0, emptyFields: 0, ...o,
});
const EMPTY_STATS = baseStats({ emptyFields: 6 });
const HEALTHY_STATS = baseStats({ claims: zClaim({ emitted: 3, inserted: 3 }) });

describe('ScrapeQueue × record-fetch status gate', () => {
  let queue: ScrapeQueue;
  let reports: FetchFailureReport[];
  let extract: jest.Mock;
  let cd: ChallengeCooldown;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ advanceTimers: true });
    resetScrapeQueue();
    resetSessionManager();
    resetChallengeCooldown();
    reports = [];
    extract = makeExtract();
    cd = new ChallengeCooldown({ now: () => 1_000_000, windowMs: 10 * 60_000 });
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

  function buildQueue(http: jest.Mock, send: jest.Mock): ScrapeQueue {
    const q = new ScrapeQueue(false);
    q.setPluginRegistry(makeRegistry(makeRuleset(extract)));
    q.setIngestEmitter({ send });
    q.setScrapingService(makeScrapingStub());
    q.setIngestTransports({ http });
    q.setChallengeCooldown(cd);
    q.setFailureReporter({ report: async (r: FetchFailureReport) => { reports.push(r); } });
    return q;
  }

  /** Run one item to its terminal outcome and hand back the http mock for call-count assertions. */
  async function runItem(body: unknown, opts: { maxRetries?: number; send?: jest.Mock } = {}) {
    const http = jest.fn().mockResolvedValue(body);
    const send = opts.send ?? jest.fn().mockResolvedValue(HEALTHY_STATS);
    queue = buildQueue(http, send);
    const result = queue.enqueue(ITEM_URL, { url: ITEM_URL, maxRetries: opts.maxRetries ?? 2 });
    result.promise.catch(() => {});
    await advanceUntil(() => queue.getStats().failed === 1 || queue.getStats().completed === 1);
    return { http, send, result };
  }

  it.each([
    [404, 'gone_404'],
    [410, 'gone_410'],
  ])('gives up IMMEDIATELY on HTTP %s and books it as %s', async (status, reasonClass) => {
    const { http } = await runItem({ body: 'not found', status, finalUrl: ITEM_URL });

    expect(queue.getStats().failed).toBe(1);
    expect(http).toHaveBeenCalledTimes(1);          // terminal: never re-fetched
    expect(extract).not.toHaveBeenCalled();         // the store's error page never reached the ruleset
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      site: 'statusstore',
      kind: 'record',
      origin: 'ingest',
      reasonClass,
      httpStatus: status,
      target: ITEM_URL,
      transport: 'http',
    });
  });

  it.each([
    [429, 'http_429'],
    [503, 'http_5xx'],
  ])('retries HTTP %s and books ONE row as %s', async (status, reasonClass) => {
    const { http } = await runItem({ body: 'busy', status, finalUrl: ITEM_URL });

    expect(queue.getStats().failed).toBe(1);
    expect(http.mock.calls.length).toBeGreaterThan(1); // transient: really retried
    expect(reports).toHaveLength(1);                   // still ONE ledger row per give-up
    expect(reports[0]).toMatchObject({ reasonClass, httpStatus: status });
  });

  it('books a 403 as http_403 and does not retry it (a repeated 403 only burns the egress IP)', async () => {
    const { http } = await runItem({ body: 'forbidden', status: 403, finalUrl: ITEM_URL });

    expect(http).toHaveBeenCalledTimes(1);
    expect(reports[0]).toMatchObject({ reasonClass: 'http_403', httpStatus: 403 });
  });

  it('books an item URL that landed on the store home page as redirect_home, terminal', async () => {
    const { http } = await runItem({ body: '<html>front page</html>', status: 200, finalUrl: `https://${HOST}/` });

    expect(queue.getStats().failed).toBe(1);
    expect(http).toHaveBeenCalledTimes(1);
    expect(extract).not.toHaveBeenCalled();
    expect(reports).toHaveLength(1);
    expect(reports[0].reasonClass).toBe('redirect_home');
    expect(reports[0].message).toContain('home');
  });

  it('leaves a Cloudflare interstitial on the CHALLENGE path even though it carries a 403', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const send = jest.fn().mockResolvedValue(EMPTY_STATS);
    await runItem({ body: CHALLENGE_HTML, status: 403, finalUrl: ITEM_URL }, { send });

    expect(reports).toHaveLength(1);
    expect(reports[0].reasonClass).toBe('challenge');   // NOT http_403
    expect(cd.isOpen(HOST)).toBe(true);                 // the host cooldown still opened
  });

  it('leaves a healthy 200 on a real path completely alone', async () => {
    const { http, send } = await runItem({ body: FIXTURE_HTML, status: 200, finalUrl: ITEM_URL });

    expect(queue.getStats().completed).toBe(1);
    expect(queue.getStats().failed).toBe(0);
    expect(http).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(reports).toHaveLength(0);
  });

  it('leaves a lane that surfaced NO status alone (a bare-string transport is not a failure)', async () => {
    const { send } = await runItem(FIXTURE_HTML);

    expect(queue.getStats().completed).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(reports).toHaveLength(0);
  });
});
