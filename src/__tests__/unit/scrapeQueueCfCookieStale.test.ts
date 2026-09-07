/**
 * ScrapeQueue × stored-cookie STALE signal (CfCookieStore). A host whose hand-minted cookies live in
 * the jar and that STILL serves a Cloudflare challenge has a dead cookie — the engine cannot re-mint
 * (cf_clearance is IP+UA-bound to Ross's mint), so it SIGNALS: at the two existing cooldown.open
 * sites (the honesty gate and the extraction-throw door) it calls markStale(host, lane, reason) iff
 * the store has cookies for that host; at the clean-fetch clear site it calls markFresh(host).
 *
 *   1. honesty gate: challenge + persisted 0 on a host WITH cookies → markStale ONCE (lane http),
 *      still one fetch / ChallengePageError / cooldown opened (storm protection unchanged).
 *   2. extraction-throw door: same signal, reason names "(extraction failed)".
 *   3. host WITHOUT stored cookies → markStale NEVER called (cooldown still opens).
 *   4. clean body → markFresh(host), markStale never.
 *   5. amiami recovery (challenge + persisted>0) → neither mark: not stale, not a clean primary.
 *   6. browser lane (undeclared transport) with stored cookies → stealth browser chosen, a browser
 *      interstitial is flagged transport 'browser' and marked stale via that lane.
 *   7. NO injected store → the queue signals the CfCookieStore SINGLETON (CF_COOKIE_FILE fixture with
 *      FAKE values): the fixture host's view() row flips stale, an unknown host's does not.
 *
 * Harness mirrors scrapeQueueChallengeExtractThrow.test.ts (http lane, injected cooldown clock,
 * fake timers). The store fake is built per test (the harness runs resetMocks).
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
import { ChallengeCooldown, resetChallengeCooldown } from '../../services/challengeCooldown';
import { createExtractionRegistry, ExtractionRegistryImpl } from '../../services/extractionRegistry';
import { resetSessionManager } from '../../services/sessionManager';
import { join } from 'path';
import { getCfCookieStore, resetCfCookieStore } from '../../services/cookieJar';

const HOST = 'cohort.example.test';
const SITE = 'cohort-mock';
const CLEAN_HTML = '<html><body><h1 class="title">Lucy</h1></body></html>';
const CHALLENGE_HTML = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
const MIN = 60_000;

const zClaim = (o: Record<string, number> = {}) => ({ emitted: 0, inserted: 0, deduped: 0, quarantined: 0, dropped: 0, ...o });
const zTable = (o: Record<string, number> = {}) => ({ emitted: 0, inserted: 0, deduped: 0, dropped: 0, ...o });
const zPrice = () => ({ emitted: 0, inserted: 0, deduped: 0, skipped: 0, dropped: 0 });
const emptyStats = () => ({
  sourceId: 'src-1', productId: 'prod-1', claims: zClaim(), identifiers: zTable(), prices: zPrice(), availability: zTable(),
  warnings: [] as string[], registeredNewAttrs: 0, emptyFields: 6,
});
const healthyStats = () => ({
  sourceId: 'src-1', productId: 'prod-1', claims: zClaim({ emitted: 3, inserted: 3 }), identifiers: zTable({ emitted: 1, inserted: 1 }),
  prices: zPrice(), availability: zTable(), warnings: [] as string[], registeredNewAttrs: 0, emptyFields: 0,
});

function recordFor(url: string): ExtractedData {
  return {
    source: { site: SITE, itemId: 'l1', url, extractedAt: '2026-09-06T00:00:00.000Z', rulesetVersion: '1.0.0' },
    fields: { name: 'Lucy' },
    warnings: [],
  };
}

function ruleset(extract: (html: string, url: string) => ExtractedData = (_h, url) => recordFor(url)): ExtractionRuleset {
  return { siteId: SITE, version: '1.0.0', extract, validate: () => ({ valid: true, errors: [], warnings: [] }) };
}

function makeRegistry(rs: ExtractionRuleset, searchFetch?: StoreCapabilities['searchFetch'], domain = HOST): ExtractionRegistryImpl {
  const registry = createExtractionRegistry();
  registry.registerSite({
    siteId: rs.siteId,
    name: 'Mock cohort store',
    domains: [domain],
    rateLimit: { domain, baseDelayMs: 1000, minDelayMs: 500, maxDelayMs: 5000, backoffMultiplier: 1.5, recoveryDivisor: 1.5, successThreshold: 3 },
    requiresBrowser: false,
    allowedCookies: [],
    ...(searchFetch ? { searchFetch } : {}),
  });
  registry.registerRuleset(rs);
  return registry;
}

/** A fake CfCookieStore that has cookies for `hosts` and records the stale/fresh signals. */
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

describe('ScrapeQueue × stored-cookie stale / fresh signals', () => {
  let queue: ScrapeQueue;
  let cdNow: number;
  let cd: ChallengeCooldown;

  beforeEach(() => {
    jest.clearAllMocks();
    mockNotifyItemFailed.mockResolvedValue(true);
    jest.useFakeTimers({ advanceTimers: true });
    resetScrapeQueue();
    resetSessionManager();
    resetChallengeCooldown();
    resetCfCookieStore();
    cdNow = 1_000_000;
    cd = new ChallengeCooldown({ now: () => cdNow, windowMs: MIN });
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    if (queue) { queue.stop(); queue.clear(); }
    resetScrapeQueue();
    resetSessionManager();
    resetChallengeCooldown();
    resetCfCookieStore();
    jest.useRealTimers();
  });

  async function advanceUntil(pred: () => boolean, stepMs = 250, maxSteps = 400): Promise<void> {
    for (let i = 0; i < maxSteps && !pred(); i++) {
      jest.advanceTimersByTime(stepMs);
      await jest.advanceTimersByTimeAsync(50);
    }
  }

  /** Keep driving the fake clock well past any retry window to prove NOTHING else happens. */
  async function settle(ms = 30_000): Promise<void> {
    for (let t = 0; t < ms; t += 500) {
      jest.advanceTimersByTime(500);
      await jest.advanceTimersByTimeAsync(50);
    }
  }

  function buildQueue(opts: {
    ruleset?: ExtractionRuleset;
    http?: jest.Mock;
    send: jest.Mock;
    /** The injected store; `null` leaves the queue on the CfCookieStore singleton (case 7). */
    store: ReturnType<typeof fakeStore> | null;
    searchFetch?: StoreCapabilities['searchFetch'];
    scraping?: { scrapePage: jest.Mock; scrapePageStealth: jest.Mock };
    domain?: string;
  }): ScrapeQueue {
    const q = new ScrapeQueue(false);
    // An EXPLICIT `searchFetch: undefined` registers the store with NO declared transport (→ the
    // browser lane); an omitted key keeps the http default the other cases ride.
    q.setPluginRegistry(makeRegistry(opts.ruleset ?? ruleset(), 'searchFetch' in opts ? opts.searchFetch : { transport: 'http' }, opts.domain));
    q.setIngestEmitter({ send: opts.send });
    q.setScrapingService((opts.scraping ?? { scrapePage: jest.fn(), scrapePageStealth: jest.fn() }) as any);
    if (opts.http) q.setIngestTransports({ http: opts.http });
    q.setChallengeCooldown(cd);
    if (opts.store) q.setCfCookieStore(opts.store);
    return q;
  }

  it('(1) honesty gate: a challenge that persisted nothing on a host WITH stored cookies → markStale ONCE (lane http), still one fetch + ChallengePageError + cooldown', async () => {
    const http = jest.fn().mockResolvedValue(CHALLENGE_HTML);
    const send = jest.fn().mockResolvedValue(emptyStats());
    const store = fakeStore([HOST]);
    queue = buildQueue({ http, send, store });

    const url = `https://${HOST}/product/1`;
    const result = queue.enqueue(url, { url });
    const captured = result.promise.catch((e: Error) => e);
    await advanceUntil(() => queue.getStats().failed === 1);
    await settle();

    expect(store.markStale).toHaveBeenCalledTimes(1);
    expect(store.markStale).toHaveBeenCalledWith(HOST, 'http', 'challenge page via http transport');
    expect(store.markFresh).not.toHaveBeenCalled();
    // storm protection UNCHANGED: one fetch, one-shot typed failure, cooldown open
    expect(http).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(queue.getStats().failed).toBe(1);
    expect(((await captured) as Error).message).toContain('Cloudflare challenge page received');
    expect(cd.isOpen(HOST)).toBe(true);
  });

  it('(2) extraction-throw door: extract THROWS on a challenge page on a host WITH stored cookies → markStale ONCE, reason names "(extraction failed)"', async () => {
    const http = jest.fn().mockResolvedValue(CHALLENGE_HTML);
    const send = jest.fn();
    const store = fakeStore([HOST]);
    queue = buildQueue({ ruleset: ruleset(() => { throw new Error('Unexpected token < in JSON'); }), http, send, store });

    const url = `https://${HOST}/product/2`;
    const result = queue.enqueue(url, { url });
    result.promise.catch(() => {});
    await advanceUntil(() => queue.getStats().failed === 1);
    await settle();

    expect(store.markStale).toHaveBeenCalledTimes(1);
    expect(store.markStale).toHaveBeenCalledWith(HOST, 'http', 'challenge page via http transport (extraction failed)');
    expect(store.markFresh).not.toHaveBeenCalled();
    expect(http).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    expect(cd.isOpen(HOST)).toBe(true);
  });

  it('(3) a challenge on a host WITHOUT stored cookies → markStale NEVER called; the cooldown still opens (both doors)', async () => {
    const store = fakeStore([]); // the store knows no host
    // door (a): honesty gate
    const http = jest.fn().mockResolvedValue(CHALLENGE_HTML);
    queue = buildQueue({ http, send: jest.fn().mockResolvedValue(emptyStats()), store });
    const a = `https://${HOST}/product/3`;
    queue.enqueue(a, { url: a }).promise.catch(() => {});
    await advanceUntil(() => queue.getStats().failed === 1);
    expect(cd.isOpen(HOST)).toBe(true);
    expect(store.markStale).not.toHaveBeenCalled();
    queue.stop(); queue.clear();
    resetChallengeCooldown();
    cd = new ChallengeCooldown({ now: () => cdNow, windowMs: MIN });

    // door (b): extraction throws
    queue = buildQueue({ ruleset: ruleset(() => { throw new Error('boom'); }), http: jest.fn().mockResolvedValue(CHALLENGE_HTML), send: jest.fn(), store });
    const b = `https://${HOST}/product/4`;
    queue.enqueue(b, { url: b }).promise.catch(() => {});
    await advanceUntil(() => queue.getStats().failed === 1);
    expect(cd.isOpen(HOST)).toBe(true);
    expect(store.markStale).not.toHaveBeenCalled();
    expect(store.markFresh).not.toHaveBeenCalled();
  });

  it('(4) a clean body → markFresh(host) at the clear site; markStale never', async () => {
    const http = jest.fn().mockResolvedValue(CLEAN_HTML);
    const send = jest.fn().mockResolvedValue(healthyStats());
    const store = fakeStore([HOST]);
    queue = buildQueue({ http, send, store });

    const url = `https://${HOST}/product/5`;
    const result = queue.enqueue(url, { url });
    await advanceUntil(() => queue.getStats().completed === 1 || queue.getStats().failed === 1);
    await result.promise;

    expect(queue.getStats().completed).toBe(1);
    expect(store.markFresh).toHaveBeenCalledTimes(1);
    expect(store.markFresh).toHaveBeenCalledWith(HOST);
    expect(store.markStale).not.toHaveBeenCalled();
  });

  it('(5) amiami recovery (challenge page but persisted>0) → neither stale nor fresh: not a dead cookie, not a clean primary', async () => {
    const http = jest.fn().mockResolvedValue(CHALLENGE_HTML);
    const send = jest.fn().mockResolvedValue(healthyStats());
    const store = fakeStore([HOST]);
    queue = buildQueue({ http, send, store });

    const url = `https://${HOST}/product/6`;
    const result = queue.enqueue(url, { url });
    await advanceUntil(() => queue.getStats().completed === 1 || queue.getStats().failed === 1);
    await result.promise;

    expect(queue.getStats().completed).toBe(1);
    expect(store.markStale).not.toHaveBeenCalled();
    expect(store.markFresh).not.toHaveBeenCalled();
    expect(cd.isOpen(HOST)).toBe(false);
  });

  it('(6) browser lane (undeclared transport) with stored cookies → stealth browser, interstitial flagged transport browser, markStale via "browser"', async () => {
    const scraping = {
      scrapePage: jest.fn(),
      scrapePageStealth: jest.fn().mockResolvedValue({ html: CHALLENGE_HTML, url: `https://${HOST}/product/7`, title: 'Just a moment...', statusCode: 200 }),
    };
    const send = jest.fn().mockResolvedValue(emptyStats());
    const store = fakeStore([HOST]);
    queue = buildQueue({ send, store, searchFetch: undefined, scraping }); // no searchFetch → browser lane

    const url = `https://${HOST}/product/7`;
    const result = queue.enqueue(url, { url });
    const captured = result.promise.catch((e: Error) => e);
    await advanceUntil(() => queue.getStats().failed === 1);
    await settle();

    expect(scraping.scrapePageStealth).toHaveBeenCalledTimes(1); // stored cookies ⇒ stealth
    expect(scraping.scrapePage).not.toHaveBeenCalled();
    expect(store.markStale).toHaveBeenCalledTimes(1);
    expect(store.markStale).toHaveBeenCalledWith(HOST, 'browser', 'challenge page via browser transport');
    expect(((await captured) as Error).message).toContain('via browser transport');
    expect(cd.isOpen(HOST)).toBe(true);
    expect(cd.list()[0].reason).toContain('browser');
  });

  it('(7) no injected store → the SINGLETON (CF_COOKIE_FILE fixture) is signalled: the fixture host flips stale in view(), an unknown host does not', async () => {
    const ORIGINAL = process.env.CF_COOKIE_FILE;
    process.env.CF_COOKIE_FILE = join(__dirname, '../fixtures/cfCookies/cf-cookies.json');
    resetCfCookieStore();
    try {
      const FIXTURE_HOST = 'anitoysgk.com';
      const http = jest.fn().mockResolvedValue(CHALLENGE_HTML);
      queue = buildQueue({ http, send: jest.fn().mockResolvedValue(emptyStats()), store: null, domain: FIXTURE_HOST });

      const url = `https://www.${FIXTURE_HOST}/product/8`;
      queue.enqueue(url, { url }).promise.catch(() => {});
      await advanceUntil(() => queue.getStats().failed === 1);
      await settle();

      expect(http).toHaveBeenCalledTimes(1);
      expect(cd.isOpen(FIXTURE_HOST)).toBe(true);
      const rows = getCfCookieStore().view();
      expect(rows.find((r) => r.host === FIXTURE_HOST)).toMatchObject({ stale: true, staleReason: 'challenge page via http transport' });
      expect(rows.find((r) => r.host === 'myfigurecollection.net')).toMatchObject({ stale: false });
      // the view never carries a value
      expect(JSON.stringify(rows)).not.toContain('FAKE_cf_fixture');
    } finally {
      if (ORIGINAL === undefined) delete process.env.CF_COOKIE_FILE; else process.env.CF_COOKIE_FILE = ORIGINAL;
      resetCfCookieStore();
    }
  });
});
