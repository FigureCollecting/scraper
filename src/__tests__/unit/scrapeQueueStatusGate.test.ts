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
import { sessionCanaryView, resetSessionCanary } from '../../services/sessionCanary';
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

function makeRegistry(ruleset: ExtractionRuleset, transport: 'http' | 'impersonate' = 'http', domain = HOST): ExtractionRegistryImpl {
  const registry = createExtractionRegistry();
  const caps: StoreCapabilities = {
    siteId: ruleset.siteId,
    name: 'Status Store',
    domains: [domain],
    rateLimit: { domain, baseDelayMs: 1000, minDelayMs: 500, maxDelayMs: 5000, backoffMultiplier: 1.5, recoveryDivisor: 1.5, successThreshold: 3 },
    requiresBrowser: false,
    allowedCookies: [],
    searchFetch: { transport },
  };
  registry.registerSite(caps);
  registry.registerRuleset(ruleset);
  return registry;
}

/** A registry declaring NO searchFetch — the ingest dispatcher defaults such a store to the browser lane. */
function makeBrowserRegistry(ruleset: ExtractionRuleset): ExtractionRegistryImpl {
  const registry = createExtractionRegistry();
  registry.registerSite({
    siteId: ruleset.siteId,
    name: 'Rendered Store',
    domains: [HOST],
    rateLimit: { domain: HOST, baseDelayMs: 1000, minDelayMs: 500, maxDelayMs: 5000, backoffMultiplier: 1.5, recoveryDivisor: 1.5, successThreshold: 3 },
    requiresBrowser: true,
    allowedCookies: [],
  });
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

  function buildQueue(http: jest.Mock, send: jest.Mock, transport: 'http' | 'impersonate' = 'http', domain = HOST): ScrapeQueue {
    const q = new ScrapeQueue(false);
    q.setPluginRegistry(makeRegistry(makeRuleset(extract), transport, domain));
    q.setIngestEmitter({ send });
    q.setScrapingService(makeScrapingStub());
    q.setIngestTransports(transport === 'http' ? { http } : { impersonate: http });
    q.setChallengeCooldown(cd);
    q.setFailureReporter({ report: async (r: FetchFailureReport) => { reports.push(r); } });
    return q;
  }

  /** Run one item to its terminal outcome and hand back the http mock for call-count assertions. */
  /** Stop whatever queue the previous call built, so a multi-item case leaves nothing running. */
  async function runItem(
    body: unknown,
    opts: { maxRetries?: number; send?: jest.Mock; transport?: 'http' | 'impersonate'; domain?: string; url?: string } = {},
  ) {
    if (queue) { queue.stop(); queue.clear(); }
    const http = jest.fn().mockResolvedValue(body);
    const send = opts.send ?? jest.fn().mockResolvedValue(HEALTHY_STATS);
    queue = buildQueue(http, send, opts.transport ?? 'http', opts.domain ?? HOST);
    const url = opts.url ?? ITEM_URL;
    const result = queue.enqueue(url, { url, maxRetries: opts.maxRetries ?? 2 });
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

  /**
   * THE LIVE CASE (prod 2026-09-09 04:34Z, engine f8e8ebba): POST /ingest/scrape for
   * myfigurecollection.net/item/999999999 — an item that does not exist — completed as an INGEST
   * SUCCESS with `claims=3/0/0/0 ... persisted=3 emitted=1/1` and no ledger row, because the lane
   * handed the store's not-found page to the ruleset, which lifted three claims off its chrome.
   *
   * These cases pin the gate AHEAD of extraction and persistence, on the lane mfc actually rides
   * (impersonate / impit residential — impit 0.14.4 exposes `status` and `url` on every response):
   * a ruleset that WOULD have produced a full record never gets the chance, the emitter is never
   * called, and the ledger gets the terminal row instead.
   */
  describe('a not-found page the ruleset would happily lift claims from', () => {
    it('rejects a 404 BEFORE extraction and BEFORE any emit, on the impersonate lane', async () => {
      const { http, send } = await runItem(
        { body: '<html><body>The item you are looking for does not exist</body></html>', status: 404, finalUrl: ITEM_URL },
        { transport: 'impersonate' },
      );

      expect(extract).not.toHaveBeenCalled();   // the ruleset never saw the not-found page
      expect(send).not.toHaveBeenCalled();      // ZERO claims reached the spine
      expect(http).toHaveBeenCalledTimes(1);    // terminal: not retried
      expect(queue.getStats().completed).toBe(0);
      expect(queue.getStats().failed).toBe(1);
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({
        reasonClass: 'gone_404',
        httpStatus: 404,
        kind: 'record',
        origin: 'ingest',
        target: ITEM_URL,
        transport: 'impersonate',
      });
    });

    it('rejects a 410 on the impersonate lane the same way', async () => {
      const { send } = await runItem({ body: 'gone', status: 410, finalUrl: ITEM_URL }, { transport: 'impersonate' });

      expect(extract).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      expect(reports[0]).toMatchObject({ reasonClass: 'gone_410', httpStatus: 410, transport: 'impersonate' });
    });

    it('rejects a bounce to the store root on the impersonate lane before anything is written', async () => {
      const { send } = await runItem(
        { body: '<html>front page</html>', status: 200, finalUrl: `https://${HOST}/` },
        { transport: 'impersonate' },
      );

      expect(extract).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      expect(reports[0]).toMatchObject({ reasonClass: 'redirect_home', transport: 'impersonate' });
    });
  });

  /**
   * THE AMBIGUOUS 404 (owner rule, 2026-09-09). On myfigurecollection.net a 404 is served both for
   * an item that never existed AND for an NSFW / NSFW+ item the session is not entitled to see —
   * an age gate, or scrape-account cookies gone stale. Booking that as gone_404 would auto-close a
   * live item as removed and hide a session that needs re-minting. The row is http_403 instead:
   * reviewable, carrying the hint, and never retried (a retry cannot re-mint a cookie).
   */
  describe('myfigurecollection.net — a 404 that may be a denial', () => {
    const MFC_HOST = 'myfigurecollection.net';
    const MFC_ITEM = `https://${MFC_HOST}/item/999999999`;

    it('books an mfc 404 as http_403 with the re-mint hint, never gone_404', async () => {
      const { http, send } = await runItem(
        { body: '<html>does not exist</html>', status: 404, finalUrl: MFC_ITEM },
        { transport: 'impersonate', domain: MFC_HOST, url: MFC_ITEM },
      );

      expect(extract).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      expect(http).toHaveBeenCalledTimes(1);          // never retried: a retry cannot re-mint a session
      expect(reports).toHaveLength(1);
      expect(reports[0].reasonClass).toBe('http_403');
      expect(reports[0].reasonClass).not.toBe('gone_404');
      expect(reports[0].httpStatus).toBe(404);        // the real status is still on the row
      expect(reports[0].message).toContain('denied-or-gone');
      expect(reports[0].message).toContain('session may need re-minting');
    });

    it('still books an mfc 410 as gone_410 — an explicit Gone is not ambiguous', async () => {
      await runItem(
        { body: 'gone', status: 410, finalUrl: MFC_ITEM },
        { transport: 'impersonate', domain: MFC_HOST, url: MFC_ITEM },
      );

      expect(reports[0].reasonClass).toBe('gone_410');
    });

    it('keeps gone_404 for a store where a 404 IS unambiguous', async () => {
      await runItem({ body: 'not found', status: 404, finalUrl: ITEM_URL });
      expect(reports[0].reasonClass).toBe('gone_404');
    });
  });

  /**
   * THE SESSION CANARY, driven by ordinary ingest traffic. A 404 on the configured NSFW+ canary id
   * plus a 200 on any other mfc item inside the hour is the only pair that proves the scrape
   * session lost its entitlement — and both halves are fetches the queue was making anyway.
   */
  describe('mfc session canary', () => {
    const MFC_HOST = 'myfigurecollection.net';
    const CANARY_ID = '777777';
    const CANARY_URL = `https://${MFC_HOST}/item/${CANARY_ID}`;
    const OTHER_URL = `https://${MFC_HOST}/item/12345`;
    const priorEnv = process.env.MFC_SESSION_CANARY_ITEM;

    beforeEach(() => {
      process.env.MFC_SESSION_CANARY_ITEM = CANARY_ID;
      resetSessionCanary();
      jest.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
      if (priorEnv === undefined) delete process.env.MFC_SESSION_CANARY_ITEM;
      else process.env.MFC_SESSION_CANARY_ITEM = priorEnv;
      resetSessionCanary();
    });

    it('flags the session stale after a served mfc item and a 404 on the canary item', async () => {
      await runItem({ body: FIXTURE_HTML, status: 200, finalUrl: OTHER_URL },
        { transport: 'impersonate', domain: MFC_HOST, url: OTHER_URL });
      expect(sessionCanaryView().stale).toBe(false);   // one healthy fetch proves nothing on its own

      await runItem({ body: '<html>does not exist</html>', status: 404, finalUrl: CANARY_URL },
        { transport: 'impersonate', domain: MFC_HOST, url: CANARY_URL });

      expect(sessionCanaryView().stale).toBe(true);
      expect(sessionCanaryView().staleReason).toContain('entitle');
    });

    it('does NOT flag on a 404 for an ordinary mfc item — that ambiguity is exactly the point', async () => {
      await runItem({ body: FIXTURE_HTML, status: 200, finalUrl: OTHER_URL },
        { transport: 'impersonate', domain: MFC_HOST, url: OTHER_URL });
      await runItem({ body: '<html>does not exist</html>', status: 404, finalUrl: OTHER_URL },
        { transport: 'impersonate', domain: MFC_HOST, url: OTHER_URL });

      expect(sessionCanaryView().stale).toBe(false);
    });

    it('leaves the flag alone for another store entirely', async () => {
      await runItem({ body: FIXTURE_HTML, status: 200, finalUrl: ITEM_URL });
      await runItem({ body: 'not found', status: 404, finalUrl: `https://${HOST}/item/${CANARY_ID}` },
        { url: `https://${HOST}/item/${CANARY_ID}` });

      expect(sessionCanaryView().stale).toBe(false);
    });
  });

  /**
   * THE BROWSER LANE (review of PR #295). It is the DEFAULT lane for any store that declares no
   * transport, and it was the one lane whose redirect signal could never fire: the result's `url` is
   * the url that was REQUESTED, so the gate was comparing the request against itself. With the
   * navigation's real post-redirect location on its own field, a rendered store that bounces a dead
   * item to its front page finally lands in the ledger as redirect_home.
   */
  describe('browser lane — the default lane for an undeclared transport', () => {
    /** Build the queue around a browser stub whose navigation ENDS somewhere other than the request. */
    function buildBrowserQueue(page: Record<string, unknown>, send: jest.Mock): ScrapeQueue {
      const q = new ScrapeQueue(false);
      q.setPluginRegistry(makeBrowserRegistry(makeRuleset(extract)));
      q.setIngestEmitter({ send });
      q.setScrapingService({
        scrapePage: jest.fn().mockResolvedValue(page),
        scrapePageStealth: jest.fn().mockResolvedValue(page),
      });
      q.setChallengeCooldown(cd);
      q.setFailureReporter({ report: async (r: FetchFailureReport) => { reports.push(r); } });
      return q;
    }

    it('books a rendered item that landed on the store root as redirect_home', async () => {
      const send = jest.fn().mockResolvedValue(HEALTHY_STATS);
      queue = buildBrowserQueue(
        { html: '<html>front page</html>', url: ITEM_URL, finalUrl: `https://${HOST}/`, title: 'Home', statusCode: 200 },
        send,
      );
      const result = queue.enqueue(ITEM_URL, { url: ITEM_URL, maxRetries: 2 });
      result.promise.catch(() => {});
      await advanceUntil(() => queue.getStats().failed === 1 || queue.getStats().completed === 1);

      expect(extract).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({ reasonClass: 'redirect_home', transport: 'browser' });
    });

    it('leaves a rendered item that stayed on its own url completely alone', async () => {
      const send = jest.fn().mockResolvedValue(HEALTHY_STATS);
      queue = buildBrowserQueue(
        { html: FIXTURE_HTML, url: ITEM_URL, finalUrl: ITEM_URL, title: 'Item', statusCode: 200 },
        send,
      );
      const result = queue.enqueue(ITEM_URL, { url: ITEM_URL, maxRetries: 2 });
      await advanceUntil(() => queue.getStats().completed === 1 || queue.getStats().failed === 1);
      await result.promise;

      expect(queue.getStats().completed).toBe(1);
      expect(send).toHaveBeenCalledTimes(1);
      expect(reports).toHaveLength(0);
    });

    it('does not invent a redirect for a navigation that reported no final url at all', async () => {
      const send = jest.fn().mockResolvedValue(HEALTHY_STATS);
      queue = buildBrowserQueue({ html: FIXTURE_HTML, url: ITEM_URL, title: 'Item', statusCode: 200 }, send);
      const result = queue.enqueue(ITEM_URL, { url: ITEM_URL, maxRetries: 2 });
      await advanceUntil(() => queue.getStats().completed === 1 || queue.getStats().failed === 1);
      await result.promise;

      expect(queue.getStats().completed).toBe(1);
      expect(reports).toHaveLength(0);
    });
  });
});
