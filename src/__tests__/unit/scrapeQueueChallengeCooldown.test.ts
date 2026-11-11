/**
 * ScrapeQueue × challenge cooldown — the queue must NOT retry a Cloudflare challenge in a tight loop
 * (each attempt fetches another challenge page and degrades the egress IP's CF reputation), and once
 * a host has served a genuine challenge it must be left alone for a cooldown window:
 *
 *   1. FAIL-FAST: a ChallengePageError (challenge-flagged page that persisted nothing) is ONE attempt
 *      then FAILED — never the old 3× retry storm — even though its class stays rate_limited.
 *   2. OPEN: raising a ChallengePageError opens the host's cooldown.
 *   3. FAST-FAIL: while a host is cooling, the next item for it fails IMMEDIATELY without fetching
 *      (ChallengeCooldownError → challenge_cooldown, not retried, reason names the minutes left).
 *   4. EXPIRY + CLEAR: after the window a request proceeds again, and a clean (non-challenge) fetch
 *      clears the cooldown.
 *   5. cookie sessions never enter the auth-pause path for either challenge error; other hosts are
 *      untouched.
 *
 * Harness mirrors scrapeQueueIngestClassification.test.ts; the cooldown clock is injected so time is
 * deterministic (no real timers), decoupled from the queue's own jest-faked processing timers.
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
import { getSessionManager, resetSessionManager } from '../../services/sessionManager';

const FIXTURE_HTML = '<html><body><h1 class="title">Kitagawa Marin</h1></body></html>';
/** The CF managed-challenge title interstitial (what capturingFetch's http lane flags challenge:true). */
const CHALLENGE_HTML = '<html><head><title>Just a moment...</title></head><body>cf</body></html>';
const MIN = 60_000;

function makeRegistry(
  ruleset: ExtractionRuleset,
  domain: string,
  searchFetch?: StoreCapabilities['searchFetch'],
): ExtractionRegistryImpl {
  const registry = createExtractionRegistry();
  const caps: StoreCapabilities = {
    siteId: ruleset.siteId,
    name: 'Mock Store',
    domains: [domain],
    rateLimit: { domain, baseDelayMs: 1000, minDelayMs: 500, maxDelayMs: 5000, backoffMultiplier: 1.5, recoveryDivisor: 1.5, successThreshold: 3 },
    requiresBrowser: false,
    allowedCookies: [],
    searchFetch,
  };
  registry.registerSite(caps);
  registry.registerRuleset(ruleset);
  return registry;
}

function makeRuleset(siteId: string, itemId: string): ExtractionRuleset {
  return {
    siteId,
    version: '1.0.0',
    extract: (html: string, url: string) => ({
      source: { site: siteId, itemId, url, extractedAt: '2026-07-24T00:00:00.000Z', rulesetVersion: '1.0.0' },
      fields: { name: 'Kitagawa Marin' },
      warnings: [],
    }),
    validate: () => ({ valid: true, errors: [], warnings: [] }),
  };
}

function makeScrapingStub() {
  const page = { html: FIXTURE_HTML, url: 'https://x.test/item/1', title: 'Item', statusCode: 200 };
  return { scrapePage: jest.fn().mockResolvedValue(page), scrapePageStealth: jest.fn().mockResolvedValue(page) };
}

const zClaim = (o: Record<string, number> = {}) => ({ emitted: 0, inserted: 0, deduped: 0, quarantined: 0, dropped: 0, ...o });
const zTable = (o: Record<string, number> = {}) => ({ emitted: 0, inserted: 0, deduped: 0, dropped: 0, ...o });
const zPrice = (o: Record<string, number> = {}) => ({ emitted: 0, inserted: 0, deduped: 0, skipped: 0, dropped: 0, ...o });
const emptyStats = (warnings: string[] = []) => ({
  sourceId: 'src-1', productId: 'prod-1', claims: zClaim(), identifiers: zTable(), prices: zPrice(), availability: zTable(),
  warnings, registeredNewAttrs: 0, emptyFields: 6,
});
const healthyStats = () => ({
  sourceId: 'src-1', productId: 'prod-1', claims: zClaim({ emitted: 3, inserted: 3 }), identifiers: zTable({ emitted: 1, inserted: 1 }),
  prices: zPrice(), availability: zTable(), warnings: [] as string[], registeredNewAttrs: 0, emptyFields: 0,
});

describe('ScrapeQueue × challenge cooldown', () => {
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
    cdNow = 1_000_000;
    cd = new ChallengeCooldown({ now: () => cdNow, windowMs: MIN });
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

  function buildQueue(opts: { http: jest.Mock; send: jest.Mock; registry?: ExtractionRegistryImpl; domain?: string }): ScrapeQueue {
    const q = new ScrapeQueue(false);
    q.setPluginRegistry(opts.registry ?? makeRegistry(makeRuleset('coolstore', 'x'), opts.domain ?? 'coolhost.example.test', { transport: 'http' }));
    q.setIngestEmitter({ send: opts.send });
    q.setScrapingService(makeScrapingStub());
    q.setIngestTransports({ http: opts.http });
    q.setChallengeCooldown(cd);
    return q;
  }

  it('FAIL-FAST: a challenge that persists nothing is ONE fetch/send then FAILED, and opens the cooldown', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const http = jest.fn().mockResolvedValue(CHALLENGE_HTML);
    const send = jest.fn().mockResolvedValue(emptyStats());
    queue = buildQueue({ http, send }); // default maxRetries = 3 → proves fail-fast despite retries allowed

    const url = 'https://coolhost.example.test/product/12345';
    const result = queue.enqueue(url, { url, sessionId: 's1' });
    result.promise.catch(() => {});
    await advanceUntil(() => queue.getStats().failed === 1);

    expect(http).toHaveBeenCalledTimes(1);            // EXACTLY ONE fetch — no 3× retry storm
    expect(send).toHaveBeenCalledTimes(1);            // EXACTLY ONE emit
    expect(queue.getStats().failed).toBe(1);
    expect(queue.getStats().completed).toBe(0);
    expect(queue.getStats().rateLimited).toBe(true);  // class stays rate_limited → global backoff preserved
    // the permanent-failure webhook names the challenge (existing reason/class kept)
    const reason = mockNotifyItemFailed.mock.calls[0][2] as string;
    expect(reason).toContain('rate_limited');
    expect(reason).toContain('Cloudflare challenge page received');
    // the cooldown is now OPEN for the host
    expect(cd.isOpen('coolhost.example.test')).toBe(true);
    expect(warn.mock.calls.map((c) => String(c[0])).some((l) => l.startsWith('[COOLDOWN] opened coolhost.example.test'))).toBe(true);
    warn.mockRestore();
  });

  it('FAST-FAIL: a second item for a cooling host fails immediately WITHOUT fetching, reason names the minutes left', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    cd.open('coolhost.example.test', 'challenge page'); // host already cooling (opened by an earlier attempt)
    const http = jest.fn().mockResolvedValue(FIXTURE_HTML); // would succeed IF it were allowed to fetch
    const send = jest.fn().mockResolvedValue(healthyStats());
    queue = buildQueue({ http, send }); // default maxRetries = 3

    const url = 'https://coolhost.example.test/product/999';
    const result = queue.enqueue(url, { url, sessionId: 's2' });
    result.promise.catch(() => {});
    await advanceUntil(() => queue.getStats().failed === 1);

    expect(http).not.toHaveBeenCalled();  // NO fetch — the whole point: don't touch the cooling host
    expect(send).not.toHaveBeenCalled();
    expect(queue.getStats().failed).toBe(1);
    const reason = mockNotifyItemFailed.mock.calls[0][2] as string;
    expect(reason).toContain('challenge_cooldown');
    expect(reason).toContain('min remaining'); // remaining minutes surfaced to the operator
    expect(reason).toContain('coolhost.example.test');
    // the skipped line was logged with the url + host + minutes-left
    const skipped = warn.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith('[COOLDOWN] skipped'));
    expect(skipped).toContain('https://coolhost.example.test/product/999');
    expect(skipped).toContain('coolhost.example.test cooling');
    expect(skipped).toContain('min left');
    warn.mockRestore();
  });

  it('EXPIRY + CLEAR: after the window a clean fetch proceeds and clears the cooldown', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    cd.open('coolhost.example.test', 'challenge page'); // opened at cdNow=1_000_000, until=1_060_000
    cdNow += MIN + 1; // advance PAST the window — the host is no longer cooling
    const http = jest.fn().mockResolvedValue(FIXTURE_HTML); // a clean, non-challenge body now
    const send = jest.fn().mockResolvedValue(healthyStats());
    queue = buildQueue({ http, send });

    const url = 'https://coolhost.example.test/product/1';
    const result = queue.enqueue(url, { url });
    await advanceUntil(() => queue.getStats().completed === 1 || queue.getStats().failed === 1);
    await result.promise;

    expect(http).toHaveBeenCalledTimes(1);   // fetch proceeded (cooldown expired)
    expect(queue.getStats().completed).toBe(1);
    expect(queue.getStats().failed).toBe(0);
    expect(cd.isOpen('coolhost.example.test')).toBe(false);
    // the clean fetch cleared the (now-expired) cooldown entry
    expect(warn.mock.calls.map((c) => String(c[0]))).toContain('[COOLDOWN] cleared coolhost.example.test');
    expect(cd.list()).toEqual([]);
    warn.mockRestore();
  });

  it('a cookie-session item under cooldown lands FAILED and never enters the auth-pause path', async () => {
    cd.open('coolhost.example.test', 'challenge page');
    const http = jest.fn().mockResolvedValue(FIXTURE_HTML);
    const send = jest.fn().mockResolvedValue(healthyStats());
    queue = buildQueue({ http, send });

    const url = 'https://coolhost.example.test/product/777';
    const result = queue.enqueue(url, { url, cookies: { PHPSESSID: 'abc' }, sessionId: 'sess-cf', userId: 'u1' });
    result.promise.catch(() => {});
    await advanceUntil(() => queue.getStats().failed === 1 || getSessionManager().isSessionPaused('sess-cf'));

    expect(getSessionManager().isSessionPaused('sess-cf')).toBe(false); // cooldown is a transport fault, not a cookie fault
    expect(queue.getStats().failed).toBe(1);
    expect(http).not.toHaveBeenCalled();
    const reason = mockNotifyItemFailed.mock.calls[0][2] as string;
    expect(reason).toContain('challenge_cooldown');
  });

  it('other hosts are unaffected: a cooling host does not block a different host', async () => {
    cd.open('coolhost.example.test', 'challenge page'); // hostA cooling
    const http = jest.fn().mockResolvedValue(FIXTURE_HTML);
    const send = jest.fn().mockResolvedValue(healthyStats());
    // registry serves hostB (fnc.example.test) only; hostA isn't even registered — cooldown is host-keyed.
    const registry = makeRegistry(makeRuleset('fnc', 'b1'), 'fnc.example.test', { transport: 'http' });
    queue = buildQueue({ http, send, registry });

    const url = 'https://fnc.example.test/product/1';
    const result = queue.enqueue(url, { url });
    await advanceUntil(() => queue.getStats().completed === 1 || queue.getStats().failed === 1);
    await result.promise;

    expect(http).toHaveBeenCalledTimes(1);   // hostB fetched normally
    expect(queue.getStats().completed).toBe(1);
    expect(cd.isOpen('coolhost.example.test')).toBe(true); // hostA's cooldown untouched
  });

  describe('per-lane window (ANCF a)', () => {
    const IMPIT_HOST = 'impithost.example.test';
    function buildImpitQueue(impersonate: jest.Mock, send: jest.Mock, ruleset = makeRuleset('impitstore', 'x')): ScrapeQueue {
      const q = new ScrapeQueue(false);
      q.setPluginRegistry(makeRegistry(ruleset, IMPIT_HOST, { transport: 'impersonate' }));
      q.setIngestEmitter({ send });
      q.setScrapingService(makeScrapingStub());
      q.setIngestTransports({ impersonate });
      q.setChallengeCooldown(cd);
      return q;
    }

    it('an impit-lane challenge that persists nothing opens 30 min; the next one after expiry opens 60 min', async () => {
      jest.spyOn(console, 'warn').mockImplementation(() => {});
      const impersonate = jest.fn().mockResolvedValue(CHALLENGE_HTML);
      queue = buildImpitQueue(impersonate, jest.fn().mockResolvedValue(emptyStats()));

      const first = queue.enqueue(`https://${IMPIT_HOST}/product/1`, { url: `https://${IMPIT_HOST}/product/1` });
      first.promise.catch(() => {});
      await advanceUntil(() => queue.getStats().failed === 1);
      expect(cd.remaining(IMPIT_HOST)).toBe(30 * MIN);

      cdNow += 30 * MIN; // expired, no clean fetch in between
      const second = queue.enqueue(`https://${IMPIT_HOST}/product/2`, { url: `https://${IMPIT_HOST}/product/2` });
      second.promise.catch(() => {});
      await advanceUntil(() => queue.getStats().failed === 2);
      expect(impersonate).toHaveBeenCalledTimes(2);
      expect(cd.remaining(IMPIT_HOST)).toBe(60 * MIN);
    });

    it('an impit-lane challenge whose extraction THROWS also opens the lane\'s 30-minute first step', async () => {
      jest.spyOn(console, 'warn').mockImplementation(() => {});
      jest.spyOn(console, 'error').mockImplementation(() => {});
      const throwing: ExtractionRuleset = { ...makeRuleset('impitstore', 'x'), extract: () => { throw new Error('Unexpected token <'); } };
      queue = buildImpitQueue(jest.fn().mockResolvedValue(CHALLENGE_HTML), jest.fn(), throwing);

      const r = queue.enqueue(`https://${IMPIT_HOST}/product/3`, { url: `https://${IMPIT_HOST}/product/3` });
      r.promise.catch(() => {});
      await advanceUntil(() => queue.getStats().failed === 1);
      expect(cd.remaining(IMPIT_HOST)).toBe(30 * MIN);
    });

    it('an undeclared-transport store rides the browser lane, so its challenge opens 3 h (Q1)', async () => {
      jest.spyOn(console, 'warn').mockImplementation(() => {});
      const HOSTB = 'browserhost.example.test';
      const q = new ScrapeQueue(false);
      q.setPluginRegistry(makeRegistry(makeRuleset('bstore', 'x'), HOSTB));
      q.setIngestEmitter({ send: jest.fn().mockResolvedValue(emptyStats()) });
      const page = { html: CHALLENGE_HTML, url: `https://${HOSTB}/p/1`, title: 'x', statusCode: 403 };
      q.setScrapingService({ scrapePage: jest.fn().mockResolvedValue(page), scrapePageStealth: jest.fn().mockResolvedValue(page) } as any);
      q.setChallengeCooldown(cd);
      queue = q;
      const r = q.enqueue(`https://${HOSTB}/p/1`, { url: `https://${HOSTB}/p/1` });
      r.promise.catch(() => {});
      await advanceUntil(() => q.getStats().failed === 1);
      expect(cd.remaining(HOSTB)).toBe(180 * MIN);
    });

    it('an impit 403 "error code: 1020" block is a challenge: it steps the back-off instead of clearing it (Q2)', async () => {
      jest.spyOn(console, 'warn').mockImplementation(() => {});
      jest.spyOn(console, 'error').mockImplementation(() => {});
      const impersonate = jest.fn().mockResolvedValue({ body: 'error code: 1020', status: 403 });
      queue = buildImpitQueue(impersonate, jest.fn().mockResolvedValue(emptyStats()));
      cdNow = cd.open(IMPIT_HOST, 'r', 'impersonate').until;
      cdNow = cd.open(IMPIT_HOST, 'r', 'impersonate').until; // 60-minute step, expired

      const r = queue.enqueue(`https://${IMPIT_HOST}/p/9`, { url: `https://${IMPIT_HOST}/p/9` });
      r.promise.catch(() => {});
      await advanceUntil(() => queue.getStats().failed === 1);
      expect(impersonate).toHaveBeenCalledTimes(1);
      expect(cd.remaining(IMPIT_HOST)).toBe(120 * MIN);
    });

    it('a plain 503 (not a CF page) is not clean: it leaves the expired impit window, so the back-off continues', async () => {
      jest.spyOn(console, 'warn').mockImplementation(() => {});
      jest.spyOn(console, 'error').mockImplementation(() => {});
      const impersonate = jest.fn().mockResolvedValue({ body: '<html><body><h1>503 Service Unavailable</h1></body></html>', status: 503 });
      queue = buildImpitQueue(impersonate, jest.fn().mockResolvedValue(healthyStats()));
      cdNow = cd.open(IMPIT_HOST, 'r', 'impersonate').until;
      cdNow = cd.open(IMPIT_HOST, 'r', 'impersonate').until; // 60-minute step, expired

      const r = queue.enqueue(`https://${IMPIT_HOST}/p/503`, { url: `https://${IMPIT_HOST}/p/503` });
      r.promise.catch(() => {});
      await advanceUntil(() => queue.getStats().failed === 1);
      expect(impersonate).toHaveBeenCalled();
      expect((console.warn as jest.Mock).mock.calls.map((c) => String(c[0]))).not.toContain(`[COOLDOWN] cleared ${IMPIT_HOST}`);
      const next = cd.open(IMPIT_HOST, 'r', 'impersonate');
      expect(next.until - next.openedAt).toBe(120 * MIN);
    });

    it('a 2xx clean page still clears the expired impit window and resets the back-off', async () => {
      jest.spyOn(console, 'warn').mockImplementation(() => {});
      const impersonate = jest.fn().mockResolvedValue({ body: FIXTURE_HTML, status: 200 });
      queue = buildImpitQueue(impersonate, jest.fn().mockResolvedValue(healthyStats()));
      cdNow = cd.open(IMPIT_HOST, 'r', 'impersonate').until;
      cdNow = cd.open(IMPIT_HOST, 'r', 'impersonate').until;

      const r = queue.enqueue(`https://${IMPIT_HOST}/p/ok`, { url: `https://${IMPIT_HOST}/p/ok` });
      await advanceUntil(() => queue.getStats().completed === 1 || queue.getStats().failed === 1);
      await r.promise;
      const next = cd.open(IMPIT_HOST, 'r', 'impersonate');
      expect(next.until - next.openedAt).toBe(30 * MIN);
    });
  });
});
