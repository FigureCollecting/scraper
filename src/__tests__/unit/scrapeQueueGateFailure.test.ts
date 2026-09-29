/**
 * ScrapeQueue × GATE FAILURES — a gated host answering an EMPTY body or a 5xx is a gate signal.
 *
 * The 2026-09-29 mfc incident, replayed through the real queue: impit (impersonate lane) against a
 * host WITH stored cookies answered HTTP 500 with a 0-byte body. Before this fix the queue read that
 * as a clean fetch (it was not a flagged challenge): it cleared the host's cooldown, marked the
 * stored cookies FRESH, retried every item to exhaustion and booked http_5xx — ~700 refused
 * requests an hour, invisible to /health/detailed.
 *
 *   1. An empty 500 never marks FRESH and never clears the cooldown; it marks the host STALE with a
 *      reason naming the gate failure (→ /health/detailed cfCookies[].stale).
 *   2. N consecutive gate failures open the EXISTING host cooldown; the next attempt fast-fails as
 *      challenge_cooldown and the ledger books it `cooldown` with a nextRetryHint — and so does a
 *      brand-new item for the same host, with ZERO fetches.
 *   3. A clean fetch resets the run: failures must be consecutive.
 *   4. A NON-gated host (no stored cookies, no access 'cloudflare') behaves exactly as today: a 5xx is
 *      retried to exhaustion and booked http_5xx; no strike, no cooldown, no stale mark.
 *   5. The singleton CfCookieStore (CF_COOKIE_FILE fixture) shows the stale mark in view().
 *   6. The session canary goes stale when the canary item answers an empty 500 through the queue.
 *
 * Harness mirrors scrapeQueueStatusGate.test.ts / scrapeQueueCfCookieStale.test.ts.
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

import { join } from 'path';
import type { ExtractionRuleset, StoreCapabilities } from '@figurecollecting/scraper-plugin-contract';
import { ScrapeQueue, resetScrapeQueue } from '../../services/scrapeQueue';
import { ChallengeCooldown, resetChallengeCooldown } from '../../services/challengeCooldown';
import { createExtractionRegistry, ExtractionRegistryImpl } from '../../services/extractionRegistry';
import { resetSessionManager } from '../../services/sessionManager';
import { getCfCookieStore, resetCfCookieStore } from '../../services/cookieJar';
import { sessionCanaryView, resetSessionCanary, observeMfcItemFetch } from '../../services/sessionCanary';
import { assembleCatalog } from '../../driver/assembleCatalog';
import { ProfileRegistry } from '../../driver/profileRegistry';
import { createImpitFetchers } from '../../services/impitFetch';
import type { FetchFailureReport } from '../../services/failureReporter';

const HOST = 'gated.example.test';
const SITE = 'gatedstore';
const ITEM = (n: number) => `https://${HOST}/item/${n}`;
const FIXTURE_HTML = '<html><body><h1 class="title">Kitagawa Marin</h1></body></html>';
const EMPTY_500 = { body: '', status: 500 };
const CLEAN_200 = { body: FIXTURE_HTML, status: 200 };
const MIN = 60_000;
const GATE_REASON = 'gate failure via impersonate transport: HTTP 500 with an empty body';

const zClaim = (o: Record<string, number> = {}) => ({ emitted: 0, inserted: 0, deduped: 0, quarantined: 0, dropped: 0, ...o });
const zTable = (o: Record<string, number> = {}) => ({ emitted: 0, inserted: 0, deduped: 0, dropped: 0, ...o });
const zPrice = () => ({ emitted: 0, inserted: 0, deduped: 0, skipped: 0, dropped: 0 });
const HEALTHY_STATS = {
  sourceId: 's', productId: 'p', claims: zClaim({ emitted: 3, inserted: 3 }), identifiers: zTable(), prices: zPrice(),
  availability: zTable(), warnings: [] as string[], registeredNewAttrs: 0, emptyFields: 0,
};

function makeRuleset(): ExtractionRuleset {
  return {
    siteId: SITE,
    version: '1.2.3',
    extract: ((_html: string, url: string) => ({
      source: { site: SITE, itemId: url.split('/').pop() ?? 'x', url, extractedAt: '2026-09-29T00:00:00.000Z', rulesetVersion: '1.2.3' },
      fields: { name: 'Kitagawa Marin' },
      warnings: [],
    })) as unknown as ExtractionRuleset['extract'],
    validate: () => ({ valid: true, errors: [], warnings: [] }),
  };
}

function makeRegistry(domain: string, searchFetch: StoreCapabilities['searchFetch'] = { transport: 'impersonate', browser: 'chrome142' }): ExtractionRegistryImpl {
  const registry = createExtractionRegistry();
  const caps: StoreCapabilities = {
    siteId: SITE,
    name: 'Gated Store',
    domains: [domain],
    rateLimit: { domain, baseDelayMs: 1000, minDelayMs: 500, maxDelayMs: 5000, backoffMultiplier: 1.5, recoveryDivisor: 1.5, successThreshold: 3 },
    requiresBrowser: false,
    allowedCookies: [],
    searchFetch,
  };
  registry.registerSite(caps);
  registry.registerRuleset(makeRuleset());
  return registry;
}

/** A fake CfCookieStore with cookies for `hosts`, recording the stale / fresh signals. */
function fakeStore(hosts: string[]) {
  const has = (url: string) => {
    try { return hosts.includes(new URL(url).hostname.toLowerCase().replace(/^www\./, '')); } catch { return false; }
  };
  return {
    cookiesFor: jest.fn((url: string) => (has(url) ? { cf_clearance: 'FAKE_cf_1' } : undefined)),
    userAgentFor: jest.fn(() => undefined),
    markStale: jest.fn(() => true),
    markFresh: jest.fn(() => true),
  };
}

describe('ScrapeQueue × gate failures (empty body / 5xx from a gated host)', () => {
  let queue: ScrapeQueue | undefined;
  let reports: FetchFailureReport[];
  let cdNow: number;

  beforeEach(() => {
    jest.clearAllMocks();
    mockNotifyItemFailed.mockResolvedValue(true);
    jest.useFakeTimers({ advanceTimers: true });
    resetScrapeQueue();
    resetSessionManager();
    resetChallengeCooldown();
    resetCfCookieStore();
    resetSessionCanary();
    reports = [];
    cdNow = 1_000_000;
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    if (queue) { queue.stop(); queue.clear(); }
    queue = undefined;
    resetScrapeQueue();
    resetSessionManager();
    resetChallengeCooldown();
    resetCfCookieStore();
    resetSessionCanary();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  async function advanceUntil(pred: () => boolean, stepMs = 250, maxSteps = 600): Promise<void> {
    for (let i = 0; i < maxSteps && !pred(); i++) {
      jest.advanceTimersByTime(stepMs);
      await jest.advanceTimersByTimeAsync(50);
    }
  }

  function buildQueue(opts: {
    impersonate: jest.Mock;
    cd: ChallengeCooldown;
    store: ReturnType<typeof fakeStore> | null;
    domain?: string;
    searchFetch?: StoreCapabilities['searchFetch'];
  }): ScrapeQueue {
    const q = new ScrapeQueue(false);
    q.setPluginRegistry(makeRegistry(opts.domain ?? HOST, opts.searchFetch));
    q.setIngestEmitter({ send: jest.fn().mockResolvedValue(HEALTHY_STATS) });
    q.setScrapingService({ scrapePage: jest.fn(), scrapePageStealth: jest.fn() } as any);
    q.setIngestTransports({ impersonate: opts.impersonate });
    q.setChallengeCooldown(opts.cd);
    if (opts.store) q.setCfCookieStore(opts.store);
    q.setFailureReporter({ report: async (r: FetchFailureReport) => { reports.push(r); } });
    return q;
  }

  /** Enqueue one item and drive it to a terminal state (failed or completed). */
  async function runOne(q: ScrapeQueue, url: string, maxRetries: number): Promise<void> {
    const before = q.getStats();
    q.enqueue(url, { url, maxRetries }).promise.catch(() => {});
    await advanceUntil(() => {
      const s = q.getStats();
      return s.failed + s.completed > before.failed + before.completed;
    });
  }

  it('(1) an EMPTY 500 never marks FRESH, never clears the cooldown, and marks the host STALE with the gate reason', async () => {
    const cd = new ChallengeCooldown({ now: () => cdNow, windowMs: MIN, gateFailureThreshold: 99 });
    // A cooldown opened earlier (by a real challenge) and since EXPIRED — exactly the state the
    // incident's first empty 500 found, and "cleared" in the log.
    cd.open(HOST, 'challenge page via impersonate transport');
    cdNow += 2 * MIN;
    const clear = jest.spyOn(cd, 'clear');
    const store = fakeStore([HOST]);
    const impersonate = jest.fn().mockResolvedValue(EMPTY_500);
    queue = buildQueue({ impersonate, cd, store });

    await runOne(queue, ITEM(1), 0);

    expect(impersonate).toHaveBeenCalledTimes(1);
    expect(store.markFresh).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    expect(store.markStale).toHaveBeenCalledWith(HOST, 'impersonate', GATE_REASON);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ reasonClass: 'http_5xx', httpStatus: 500 });
  });

  it('(2) N consecutive gate failures open the host cooldown; the next attempt and a NEW item fast-fail as `cooldown` with a nextRetryHint', async () => {
    const cd = new ChallengeCooldown({ now: () => cdNow, windowMs: 30 * MIN, gateFailureThreshold: 3 });
    const store = fakeStore([HOST]);
    const impersonate = jest.fn().mockResolvedValue(EMPTY_500);
    queue = buildQueue({ impersonate, cd, store });

    // One item with a budget of 4 attempts (maxRetries): attempts 1-3 are gate failures (the third opens the
    // cooldown), attempt 4 is refused BEFORE any fetch and is terminal.
    await runOne(queue, ITEM(1), 4);

    expect(impersonate).toHaveBeenCalledTimes(3);
    expect(cd.isOpen(HOST)).toBe(true);
    expect(cd.list()).toEqual([{ host: HOST, remainingMs: 30 * MIN, reason: `3 consecutive gate failures (${GATE_REASON})` }]);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ target: ITEM(1), reasonClass: 'cooldown' });
    expect(reports[0].message).toMatch(/^challenge_cooldown: /);
    expect(reports[0].nextRetryHint).toBeDefined();
    expect(Date.parse(reports[0].nextRetryHint!)).toBeGreaterThan(Date.now());

    // A brand-new item for the cooling host: ZERO fetches, booked `cooldown` with a hint.
    await runOne(queue, ITEM(2), 4);
    expect(impersonate).toHaveBeenCalledTimes(3);
    expect(reports).toHaveLength(2);
    expect(reports[1]).toMatchObject({ target: ITEM(2), reasonClass: 'cooldown' });
    expect(reports[1].nextRetryHint).toBeDefined();
  });

  it('(3) a clean fetch resets the run: two failures, a success, two failures never reach a threshold of 3', async () => {
    const cd = new ChallengeCooldown({ now: () => cdNow, windowMs: 30 * MIN, gateFailureThreshold: 3 });
    const store = fakeStore([HOST]);
    const impersonate = jest.fn()
      .mockResolvedValueOnce(EMPTY_500)
      .mockResolvedValueOnce(EMPTY_500)
      .mockResolvedValueOnce(CLEAN_200)
      .mockResolvedValueOnce(EMPTY_500)
      .mockResolvedValueOnce(EMPTY_500);
    queue = buildQueue({ impersonate, cd, store });

    await runOne(queue, ITEM(1), 2); // attempts 500, 500 → terminal http_5xx
    expect(cd.gateFailureCount(HOST)).toBe(2);
    await runOne(queue, ITEM(2), 0); // 200 clean → completed, run reset
    expect(cd.gateFailureCount(HOST)).toBe(0);
    expect(store.markFresh).toHaveBeenCalledWith(HOST);
    await runOne(queue, ITEM(3), 2); // attempts 500, 500 → terminal http_5xx

    expect(impersonate).toHaveBeenCalledTimes(5);
    expect(cd.isOpen(HOST)).toBe(false);
    expect(cd.gateFailureCount(HOST)).toBe(2);
    expect(reports.map((r) => r.reasonClass)).toEqual(['http_5xx', 'http_5xx']);
    expect(queue.getStats().completed).toBe(1);
  });

  it('(4) a NON-gated host behaves as today: a 5xx is retried to exhaustion and booked http_5xx, no strike, no cooldown, no stale', async () => {
    const cd = new ChallengeCooldown({ now: () => cdNow, windowMs: 30 * MIN, gateFailureThreshold: 1 });
    const store = fakeStore([]); // no stored cookies for HOST, and the profile declares no access gate
    const impersonate = jest.fn().mockResolvedValue(EMPTY_500);
    queue = buildQueue({ impersonate, cd, store });

    await runOne(queue, ITEM(1), 4); // maxRetries is the attempt budget: 4 fetches

    expect(impersonate).toHaveBeenCalledTimes(4);
    expect(cd.isOpen(HOST)).toBe(false);
    expect(cd.gateFailureCount(HOST)).toBe(0);
    expect(store.markStale).not.toHaveBeenCalled();
    expect(store.markFresh).not.toHaveBeenCalled();
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ reasonClass: 'http_5xx', httpStatus: 500 });
  });

  it('(5) the SINGLETON store (CF_COOKIE_FILE fixture) shows the stale mark with the gate reason in view()', async () => {
    const ORIGINAL = process.env.CF_COOKIE_FILE;
    process.env.CF_COOKIE_FILE = join(__dirname, '../fixtures/cfCookies/cf-cookies.json');
    resetCfCookieStore();
    try {
      const MFC = 'myfigurecollection.net';
      const cd = new ChallengeCooldown({ now: () => cdNow, windowMs: 30 * MIN, gateFailureThreshold: 99 });
      const impersonate = jest.fn().mockResolvedValue(EMPTY_500);
      queue = buildQueue({ impersonate, cd, store: null, domain: MFC });

      await runOne(queue, `https://${MFC}/item/2253259`, 0);

      const rows = getCfCookieStore().view();
      expect(rows.find((r) => r.host === MFC)).toMatchObject({ stale: true, staleReason: GATE_REASON, sessionLost: false });
      expect(rows.find((r) => r.host === 'anitoysgk.com')).toMatchObject({ stale: false });
    } finally {
      if (ORIGINAL === undefined) delete process.env.CF_COOKIE_FILE; else process.env.CF_COOKIE_FILE = ORIGINAL;
      resetCfCookieStore();
    }
  });

  it('(6) the session canary goes STALE when the canary item answers an empty 500 through the queue', async () => {
    const ORIGINAL = process.env.MFC_SESSION_CANARY_ITEM;
    process.env.MFC_SESSION_CANARY_ITEM = '2253259';
    try {
      const MFC = 'myfigurecollection.net';
      const cd = new ChallengeCooldown({ now: () => cdNow, windowMs: 30 * MIN, gateFailureThreshold: 99 });
      const impersonate = jest.fn().mockResolvedValue(EMPTY_500);
      queue = buildQueue({ impersonate, cd, store: fakeStore([MFC]), domain: MFC });

      await runOne(queue, `https://${MFC}/item/2253259`, 0);

      expect(sessionCanaryView().stale).toBe(true);
      expect(sessionCanaryView().staleReason).toMatch(/5xx or an empty body/);
    } finally {
      if (ORIGINAL === undefined) delete process.env.MFC_SESSION_CANARY_ITEM; else process.env.MFC_SESSION_CANARY_ITEM = ORIGINAL;
    }
  });

  // ── Challenger round 1 on PR #334 ────────────────────────────────────────────────────────────

  it('(7) a store DECLARING searchFetch.access "cloudflare" with NO stored jar strikes through the queue (the profile, not the Secret, gates it)', async () => {
    const cd = new ChallengeCooldown({ now: () => cdNow, windowMs: 30 * MIN, gateFailureThreshold: 1 });
    const impersonate = jest.fn().mockResolvedValue(EMPTY_500);
    queue = buildQueue({ impersonate, cd, store: fakeStore([]), searchFetch: { transport: 'impersonate', browser: 'chrome142', access: 'cloudflare' } });

    await runOne(queue, ITEM(1), 0);

    expect(cd.gateFailureCount(HOST)).toBe(1);
    expect(cd.isOpen(HOST)).toBe(true);
  });

  it('(8) an EMPTY 200 on the canary item through the queue turns the session canary STALE (the body reaches the canary)', async () => {
    const ORIGINAL = process.env.MFC_SESSION_CANARY_ITEM;
    process.env.MFC_SESSION_CANARY_ITEM = '2253259';
    try {
      const MFC = 'myfigurecollection.net';
      const cd = new ChallengeCooldown({ now: () => cdNow, windowMs: 30 * MIN, gateFailureThreshold: 99 });
      queue = buildQueue({ impersonate: jest.fn().mockResolvedValue({ status: 200, body: '' }), cd, store: fakeStore([MFC]), domain: MFC });

      await runOne(queue, `https://${MFC}/item/2253259`, 0);

      expect(sessionCanaryView().stale).toBe(true);
      expect(sessionCanaryView().staleReason).toMatch(/5xx or an empty body/);
    } finally {
      if (ORIGINAL === undefined) delete process.env.MFC_SESSION_CANARY_ITEM; else process.env.MFC_SESSION_CANARY_ITEM = ORIGINAL;
    }
  });

  /**
   * (9) The queue and the crawler's /catalog listing share ONE run on the host. A listing poll that
   * lands between the queue's refused fetches must not reset that run or flip the stale mark back —
   * whether the listing lane saw a 403 "Security check" status (status-aware impit, production
   * wiring) or saw no status at all (a bare-body lane, e.g. the browser lane).
   */
  it.each([
    ['status-aware impit lane (production wiring)', true],
    ['status-blind lane (browser / bare body)', false],
  ])('(9) a non-empty 403 "Security check" /catalog listing between queue failures neither resets the shared run nor clears stale — %s', async (_lane, statusAware) => {
    const ORIGINAL = process.env.CF_COOKIE_FILE;
    process.env.CF_COOKIE_FILE = join(__dirname, '../fixtures/cfCookies/cf-cookies.json');
    resetCfCookieStore();
    try {
      const MFC = 'myfigurecollection.net';
      const SECURITY_CHECK = '<html><head><title>Security check | MyFigure</title></head><body>' + 'x'.repeat(37_000) + '</body></html>';
      const cd = new ChallengeCooldown({ now: () => cdNow, windowMs: 30 * MIN, gateFailureThreshold: 5 });
      const impersonate = jest.fn().mockResolvedValue(EMPTY_500);
      queue = buildQueue({ impersonate, cd, store: null, domain: MFC });
      const caps: StoreCapabilities = {
        siteId: SITE, name: 'Gated Store', domains: [MFC],
        rateLimit: { domain: MFC, baseDelayMs: 0, minDelayMs: 0, maxDelayMs: 100, backoffMultiplier: 2, recoveryDivisor: 2, successThreshold: 3 },
        requiresBrowser: false, allowedCookies: [], searchFetch: { transport: 'impersonate', browser: 'chrome142' },
        retrieval: { byListing: { urlTemplate: `https://${MFC}/item/browse/figure/?page={page}`, order: 'newest' } },
      };
      const profiles = new ProfileRegistry();
      profiles.register(caps);
      const lane = createImpitFetchers(async () => ({ fetch: async () => ({ status: 403, text: async () => SECURITY_CHECK }) }) as never, {
        store: { cookiesFor: () => undefined, userAgentFor: () => undefined },
      });
      const cat = assembleCatalog({
        profiles,
        getRulesetForUrl: () => ({ siteId: SITE, version: '1', extract: jest.fn(), validate: jest.fn(), extractListing: () => ({ items: [], hasMore: false }) }) as unknown as ExtractionRuleset,
        fetchSearch: (url) => lane.body(url),
        ...(statusAware ? { fetchSearchDetail: (url: string) => lane.detailed(url) } : {}),
        challengeCooldown: cd,
        cfCookieStore: getCfCookieStore(),
      });
      const staleOf = () => getCfCookieStore().view().find((r) => r.host === MFC)?.stale;

      await runOne(queue, `https://${MFC}/item/1`, 4); // 4 refused fetches: run 4, stale
      expect({ run: cd.gateFailureCount(MFC), open: cd.isOpen(MFC), stale: staleOf() }).toEqual({ run: 4, open: false, stale: true });
      await cat.catalog(SITE, 1); // the crawler's listing poll
      expect({ run: cd.gateFailureCount(MFC), stale: staleOf() }).toEqual({ run: 4, stale: true });
      await runOne(queue, `https://${MFC}/item/2`, 4); // the 5th refused fetch opens the cooldown

      expect(cd.isOpen(MFC)).toBe(true);
      expect(impersonate).toHaveBeenCalledTimes(5);
    } finally {
      if (ORIGINAL === undefined) delete process.env.CF_COOKIE_FILE; else process.env.CF_COOKIE_FILE = ORIGINAL;
      resetCfCookieStore();
    }
  });

  // ── Challenger round 2 on PR #334 ────────────────────────────────────────────────────────────

  it('(10) a CHALLENGE page answering 200 on the canary item through the queue leaves a standing canary stale flag standing', async () => {
    const ORIGINAL = process.env.MFC_SESSION_CANARY_ITEM;
    process.env.MFC_SESSION_CANARY_ITEM = '2253259';
    try {
      const MFC = 'myfigurecollection.net';
      const url = `https://${MFC}/item/2253259`;
      expect(observeMfcItemFetch(url, 500, { body: '' })).toBe('stale'); // the incident already flagged it
      const since = sessionCanaryView().staleSince;
      const CF_200 = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
      const cd = new ChallengeCooldown({ now: () => cdNow, windowMs: 30 * MIN, gateFailureThreshold: 5 });
      const impersonate = jest.fn().mockResolvedValue({ status: 200, body: CF_200 });
      queue = buildQueue({ impersonate, cd, store: fakeStore([MFC]), domain: MFC });

      await runOne(queue, url, 0);

      expect(impersonate).toHaveBeenCalledTimes(1);
      expect(sessionCanaryView()).toMatchObject({ stale: true, staleSince: since });
    } finally {
      if (ORIGINAL === undefined) delete process.env.MFC_SESSION_CANARY_ITEM; else process.env.MFC_SESSION_CANARY_ITEM = ORIGINAL;
    }
  });
});
