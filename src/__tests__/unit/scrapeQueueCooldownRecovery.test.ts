/**
 * ScrapeQueue × challenge cooldown — recovery / pacing / clear-race semantics (findings F2, F3, F4).
 *
 * The base cooldown behavior (fail-fast, open, fast-fail, expiry) is covered by
 * scrapeQueueChallengeCooldown.test.ts. This file pins the three secondary defects a cooling host
 * must NOT cause:
 *
 *   F2 — a cooldown fast-fail (zero network) must be NEUTRAL to the adaptive lane: it must not reset
 *        the global success streak, or a trickle of same-host cooling items would block the recovery
 *        a real challenge escalated, holding the ×1.4 backoff + rateLimited flag open for the window.
 *   F3 — a cooldown fast-fail must NOT consume a global pacing slot: N cooling items ahead of a
 *        healthy host's item must not delay it by N×currentDelay for no-op failures.
 *   F4 — a clean body that lands AFTER the other lane opened the host's cooldown mid-flight must NOT
 *        clear the still-live window (clear is for an EXPIRED entry only).
 *
 * Harness mirrors scrapeQueueChallengeCooldown.test.ts, extended to two hosts; the cooldown clock is
 * injected, the queue's own timers are jest-faked.
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

const CLEAN_HTML = '<html><body><h1 class="title">Frieren</h1></body></html>';
const CHALLENGE_HTML = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
const MIN = 60_000;
const BASE_DELAY = 2067; // RATE_LIMIT.BASE_DELAY
const BACKOFF = 1.4; // RATE_LIMIT.BACKOFF_MULTIPLIER == RECOVERY_DIVISOR
const COOL = 'coolhost.example.test'; // the host that serves challenges / is cooling
const OK = 'okhost.example.test'; // a healthy sibling host

function rulesetFor(siteId: string): ExtractionRuleset {
  return {
    siteId,
    version: '1.0.0',
    extract: (_html: string, url: string) => ({
      source: { site: siteId, itemId: url.split('/').pop() ?? 'x', url, extractedAt: '2026-08-31T00:00:00.000Z', rulesetVersion: '1.0.0' },
      fields: { name: 'Frieren' },
      warnings: [],
    }),
    validate: () => ({ valid: true, errors: [], warnings: [] }),
  };
}
function addStore(r: ExtractionRegistryImpl, siteId: string, domain: string): void {
  const caps: StoreCapabilities = {
    siteId, name: siteId, domains: [domain],
    rateLimit: { domain, baseDelayMs: 500, minDelayMs: 250, maxDelayMs: 5000, backoffMultiplier: 1.5, recoveryDivisor: 1.5, successThreshold: 3 },
    requiresBrowser: false, allowedCookies: [], searchFetch: { transport: 'http' },
  };
  r.registerSite(caps);
  r.registerRuleset(rulesetFor(siteId));
}
const zC = (o: Record<string, number> = {}) => ({ emitted: 0, inserted: 0, deduped: 0, quarantined: 0, dropped: 0, ...o });
const zT = (o: Record<string, number> = {}) => ({ emitted: 0, inserted: 0, deduped: 0, dropped: 0, ...o });
const zP = () => ({ emitted: 0, inserted: 0, deduped: 0, skipped: 0, dropped: 0 });
const NOTHING_PERSISTED = () => ({ sourceId: 's', productId: 'p', claims: zC(), identifiers: zT(), prices: zP(), availability: zT(), warnings: [] as string[], registeredNewAttrs: 0, emptyFields: 6 });
const ROWS_PERSISTED = () => ({ sourceId: 's', productId: 'p', claims: zC({ emitted: 2, inserted: 2 }), identifiers: zT({ emitted: 1, inserted: 1 }), prices: zP(), availability: zT(), warnings: [] as string[], registeredNewAttrs: 0, emptyFields: 0 });

describe('ScrapeQueue × challenge cooldown — recovery / pacing / clear-race (F2/F3/F4)', () => {
  let queue: ScrapeQueue;
  let cdNow: number;
  let cd: ChallengeCooldown;
  let warn: jest.SpyInstance;
  let rejections: string[];

  beforeEach(() => {
    jest.clearAllMocks();
    mockNotifyItemFailed.mockResolvedValue(true);
    jest.useFakeTimers({ advanceTimers: true });
    resetScrapeQueue();
    resetSessionManager();
    resetChallengeCooldown();
    cdNow = 5_000_000;
    rejections = [];
    cd = new ChallengeCooldown({ now: () => cdNow, windowMs: MIN });
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    if (queue) { queue.stop(); queue.clear(); }
    resetScrapeQueue();
    resetSessionManager();
    resetChallengeCooldown();
    jest.useRealTimers();
  });

  const warnLines = () => warn.mock.calls.map((c) => String(c[0]));
  async function advanceUntil(pred: () => boolean, stepMs = 100, maxSteps = 4000): Promise<void> {
    for (let i = 0; i < maxSteps && !pred(); i++) { jest.advanceTimersByTime(stepMs); await jest.advanceTimersByTimeAsync(20); }
  }
  function build(http: jest.Mock, send: jest.Mock, hosts: Array<[string, string]>): ScrapeQueue {
    const r = createExtractionRegistry();
    for (const [site, domain] of hosts) addStore(r, site, domain);
    const q = new ScrapeQueue(false);
    q.setPluginRegistry(r);
    q.setIngestEmitter({ send });
    q.setScrapingService({ scrapePage: jest.fn(), scrapePageStealth: jest.fn() } as any);
    q.setIngestTransports({ http });
    q.setChallengeCooldown(cd);
    return q;
  }
  const enq = (u: string) => { queue.enqueue(u, { url: u }).promise.catch((e: Error) => { rejections.push(e.message); }); };
  const failClasses = () => rejections.map((m) => m.replace(/^Scrape failed: /, '').split(' - ')[0]);

  // ---- F2: a cooldown fast-fail is neutral to the success streak → recovery still happens --------
  it('F2: 3 clean successes recover the escalated global delay even while same-host cooling items fast-fail between them', async () => {
    const http = jest.fn(async (url: string) => (url.includes(COOL) ? CHALLENGE_HTML : CLEAN_HTML));
    const send = jest.fn(async (rec: any) => (rec.source.site === 'cool' ? NOTHING_PERSISTED() : ROWS_PERSISTED()));
    queue = build(http, send, [['cool', COOL], ['ok', OK]]);

    // One genuine challenge → ChallengePageError → rate_limited → backoff ×1.4 + cooldown opened.
    enq(`https://${COOL}/p/0`);
    await advanceUntil(() => queue.getStats().failed === 1);
    const escalated = queue.getStats().currentDelay;
    expect(escalated).toBeCloseTo(BASE_DELAY * BACKOFF, 3);
    expect(queue.getStats().rateLimited).toBe(true);
    expect(cd.isOpen(COOL)).toBe(true);

    // 3 clean OK successes interleaved with 3 COOL fast-fails (zero fetch, by design).
    for (let i = 1; i <= 3; i++) { enq(`https://${OK}/p/${i}`); enq(`https://${COOL}/p/${i}`); }
    await advanceUntil(() => queue.getStats().completed === 3 && queue.getStats().failed === 4);

    expect(http).toHaveBeenCalledTimes(4); // COOL/0 + 3×OK; COOL/1..3 never fetched
    await Promise.resolve();
    // Class semantics preserved: the fast-fails are challenge_cooldown, the challenge is rate_limited.
    expect(failClasses()).toEqual(['rate_limited', 'challenge_cooldown', 'challenge_cooldown', 'challenge_cooldown']);
    // RECOVERY: 3 successes reached SUCCESS_THRESHOLD because the fast-fails did NOT reset the streak.
    expect(queue.getStats().currentDelay).toBe(Math.floor(escalated / BACKOFF));
    expect(queue.getStats().rateLimited).toBe(false);
  });

  // ---- F3: a cooldown fast-fail does not burn a global pacing slot -------------------------------
  it('F3: a healthy host queued behind 3 cooling-host items is dispatched inside the first slot, not after 3×delay', async () => {
    cd.open(COOL, 'challenge page via http transport');
    let tFetchOk = -1;
    const http = jest.fn(async (url: string) => { if (url.includes(OK)) tFetchOk = Date.now(); return CLEAN_HTML; });
    const send = jest.fn(async () => ROWS_PERSISTED());
    queue = build(http, send, [['cool', COOL], ['ok', OK]]);

    const t0 = Date.now();
    for (let i = 1; i <= 3; i++) enq(`https://${COOL}/p/${i}`);
    enq(`https://${OK}/p/1`);
    await advanceUntil(() => queue.getStats().completed === 1);

    expect(http).toHaveBeenCalledTimes(1); // only OK reached the transport
    expect(tFetchOk - t0).toBeLessThan(BASE_DELAY); // FIX: not delayed behind 3 no-op fast-fails

    // The cooling items still all FAIL eventually (no starvation) and are NEVER fetched; fast-fails
    // never escalate the delay (they are challenge_cooldown, not rate_limited).
    await advanceUntil(() => queue.getStats().failed === 3);
    expect(queue.getStats().failed).toBe(3);
    expect(http).toHaveBeenCalledTimes(1);
    expect(queue.getStats().currentDelay).toBe(BASE_DELAY);
  });

  // ---- F4: a clean body landing mid-flight does not clear a cooldown the other lane just opened ---
  it('F4: a clean fetch in flight when the search lane opens the cooldown does NOT clear the live window', async () => {
    let land: (html: string) => void = () => {};
    const http = jest.fn(() => new Promise<string>((res) => { land = res; }));
    const send = jest.fn(async () => ROWS_PERSISTED());
    queue = build(http, send, [['cool', COOL]]);

    enq(`https://${COOL}/p/1`);
    await advanceUntil(() => http.mock.calls.length === 1); // product fetch in flight (passed isOpen while closed)
    cd.open(COOL, 'search challenge page'); // the fan-out sees a search challenge NOW, mid-flight
    expect(cd.isOpen(COOL)).toBe(true);
    expect(cd.remaining(COOL)).toBe(MIN);
    land(CLEAN_HTML); // the older clean response lands
    await advanceUntil(() => queue.getStats().completed === 1);

    // The live window (clock untouched, full MIN left) SURVIVES; no spurious "cleared" line.
    expect(cd.isOpen(COOL)).toBe(true);
    expect(cd.remaining(COOL)).toBe(MIN);
    expect(warnLines()).not.toContain(`[COOLDOWN] cleared ${COOL}`);

    // The next item for the host is therefore FAST-FAILED (skipped, no fetch), not fetched again.
    http.mockImplementation(async () => CHALLENGE_HTML);
    send.mockImplementation(async () => NOTHING_PERSISTED());
    enq(`https://${COOL}/p/2`);
    await advanceUntil(() => queue.getStats().failed === 1);
    expect(http).toHaveBeenCalledTimes(1); // still only the first fetch; the cooling host was not touched
    expect(warnLines().some((l) => l.startsWith('[COOLDOWN] skipped'))).toBe(true);
  });

  // ---- F4 control: a clean fetch AFTER the window expired DOES clear (the intended behavior) -------
  it('F4 control: a clean fetch of a host whose window has EXPIRED clears the stale entry', async () => {
    cd.open(COOL, 'challenge page'); // opened at cdNow, until = cdNow + MIN
    cdNow += MIN + 1; // advance PAST the window on the injected clock
    const http = jest.fn(async () => CLEAN_HTML);
    const send = jest.fn(async () => ROWS_PERSISTED());
    queue = build(http, send, [['cool', COOL]]);

    enq(`https://${COOL}/p/1`);
    await advanceUntil(() => queue.getStats().completed === 1);

    expect(http).toHaveBeenCalledTimes(1); // fetch proceeded (window expired)
    expect(cd.isOpen(COOL)).toBe(false);
    expect(warnLines()).toContain(`[COOLDOWN] cleared ${COOL}`);
    expect(cd.list()).toEqual([]);
  });
});
