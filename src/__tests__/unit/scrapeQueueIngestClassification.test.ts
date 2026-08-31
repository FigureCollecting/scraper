/**
 * ScrapeQueue ingest FAILURE-CLASSIFICATION tests — the queue's retry/backoff taxonomy for the two
 * typed ingest errors (EmptyIngestRecordError, ChallengePageError) must key on the error CLASS, never
 * on free text (itemId / URL / server warnings) that happens to live in the message. classifyError's
 * substring matching (`404` > `Cloudflare` > …) otherwise mis-routes:
 *   - an itemId containing "404" → not_found → 1 attempt instead of the bounded empty-record retries
 *   - a ChallengePageError whose URL contains "404" → not_found → no backoff (a CF block booked as 404)
 *   - a server warning mentioning "Cloudflare" → rate_limited → GLOBAL queue backoff from page content
 *
 * These pin the class-based classification (RS-2). Setup mirrors scrapeQueueIngestHonesty.test.ts.
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
import { createExtractionRegistry, ExtractionRegistryImpl } from '../../services/extractionRegistry';
import { getSessionManager, resetSessionManager } from '../../services/sessionManager';

const FIXTURE_HTML = '<html><body><h1 class="title">Kitagawa Marin</h1></body></html>';
/** The CF managed-challenge title interstitial (what capturingFetch's http lane rejects). */
const CHALLENGE_HTML = '<html><head><title>Just a moment...</title></head><body>cf</body></html>';

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
    searchFetch,
  };
  registry.registerSite(caps);
  registry.registerRuleset(ruleset);
  return registry;
}

/** A ruleset whose extracted record reports a caller-chosen itemId (used to smuggle "404" into it). */
function makeRuleset(itemId: string): ExtractionRuleset & { extract: jest.Mock } {
  const extract = jest.fn((html: string, url: string) => ({
    source: { site: 'mock-mfc', itemId, url, extractedAt: '2026-07-24T00:00:00.000Z', rulesetVersion: '1.0.0' },
    fields: { name: 'Kitagawa Marin' },
    warnings: [],
  }));
  return { siteId: 'mock-mfc', version: '1.0.0', extract, validate: () => ({ valid: true, errors: [], warnings: [] }) };
}

function makeScrapingStub() {
  const page = { html: FIXTURE_HTML, url: 'https://x.test/item/1', title: 'Item', statusCode: 200 };
  return {
    scrapePage: jest.fn().mockResolvedValue(page),
    scrapePageStealth: jest.fn().mockResolvedValue(page),
  };
}

const zClaim = (o: Record<string, number> = {}) => ({ emitted: 0, inserted: 0, deduped: 0, quarantined: 0, dropped: 0, ...o });
const zTable = (o: Record<string, number> = {}) => ({ emitted: 0, inserted: 0, deduped: 0, dropped: 0, ...o });
const zPrice = (o: Record<string, number> = {}) => ({ emitted: 0, inserted: 0, deduped: 0, skipped: 0, dropped: 0, ...o });
const emptyStats = (warnings: string[] = []) => ({
  sourceId: 'src-1', productId: 'prod-1',
  claims: zClaim(), identifiers: zTable(), prices: zPrice(), availability: zTable(),
  warnings, registeredNewAttrs: 0, emptyFields: 6,
});
/** A healthy first-write: rows actually landed (the ruleset recovered the record). */
const healthyStats = (warnings: string[] = []) => ({
  sourceId: 'src-1', productId: 'prod-1',
  claims: zClaim({ emitted: 3, inserted: 3 }), identifiers: zTable({ emitted: 1, inserted: 1 }),
  prices: zPrice(), availability: zTable(),
  warnings, registeredNewAttrs: 0, emptyFields: 0,
});

describe('ScrapeQueue - ingest failure classification (by class, not message text) [RS-2]', () => {
  let queue: ScrapeQueue;

  beforeEach(() => {
    jest.clearAllMocks();
    mockNotifyItemFailed.mockResolvedValue(true);
    jest.useFakeTimers({ advanceTimers: true });
    resetScrapeQueue();
    resetSessionManager();
  });

  afterEach(() => {
    if (queue) { queue.stop(); queue.clear(); }
    resetScrapeQueue();
    resetSessionManager();
    jest.useRealTimers();
  });

  async function advanceUntil(pred: () => boolean, stepMs = 250, maxSteps = 400): Promise<void> {
    for (let i = 0; i < maxSteps && !pred(); i++) {
      jest.advanceTimersByTime(stepMs);
      await jest.advanceTimersByTimeAsync(50);
    }
  }

  it('an empty record whose itemId contains "404" still gets the bounded empty-record retries (not not_found→1 attempt)', async () => {
    // itemId "1404123" embeds "404"; message-based classifyError booked it not_found (no retry).
    const send = jest.fn().mockResolvedValue(emptyStats());
    queue = new ScrapeQueue(false);
    queue.setPluginRegistry(makeRegistry(makeRuleset('1404123'), 'myfigurecollection.net'));
    queue.setIngestEmitter({ send });
    queue.setScrapingService(makeScrapingStub());

    const result = queue.enqueue('1404123', { priority: 'WARM', sessionId: 's1' }); // default maxRetries = 3
    result.promise.catch(() => {});
    await advanceUntil(() => queue.getStats().failed === 1);

    expect(send).toHaveBeenCalledTimes(3); // bounded empty-record retries, NOT a single not_found attempt
    expect(queue.getStats().failed).toBe(1);
    const reason = mockNotifyItemFailed.mock.calls[0][2] as string;
    expect(reason).toContain('empty_record');
    expect(reason).not.toContain('not_found');
  });

  it('a flagged challenge page whose URL contains "404" and persists nothing classifies as rate_limited (not not_found), with backoff', async () => {
    // URL ".../figure-4045" embeds "404". The http lane FLAGS the challenge (it no longer throws at
    // fetch); the ruleset lifts a record the spine persists nothing for, so the honesty gate raises a
    // ChallengePageError — class-based classifyError routes it rate_limited BEFORE the "404" substring
    // in the URL could book it not_found.
    const send = jest.fn().mockResolvedValue(emptyStats()); // spine persists nothing from the challenge body
    const http = jest.fn().mockResolvedValue(CHALLENGE_HTML); // http lane → flagged challenge (challenge:true)
    queue = new ScrapeQueue(false);
    queue.setPluginRegistry(makeRegistry(makeRuleset('x'), 'fnc.example.test', { transport: 'http' }));
    queue.setIngestEmitter({ send });
    queue.setScrapingService(makeScrapingStub());
    queue.setIngestTransports({ http });

    const url = 'https://fnc.example.test/product/figure-4045';
    const result = queue.enqueue(url, { url, sessionId: 's1' }); // default maxRetries = 3
    result.promise.catch(() => {});
    await advanceUntil(() => queue.getStats().failed === 1);

    expect(http).toHaveBeenCalledTimes(3);           // rate_limited is retryable → bounded 3 attempts
    expect(send).toHaveBeenCalledTimes(3);           // reached the emitter each attempt (flag, not fetch-throw)
    expect(queue.getStats().rateLimited).toBe(true); // CF block escalated backoff, not booked as 404
    const reason = mockNotifyItemFailed.mock.calls[0][2] as string;
    expect(reason).toContain('rate_limited');
    expect(reason).not.toContain('not_found');
  });

  it('a server warning mentioning "Cloudflare" does NOT trip global rate-limit backoff for an empty record', async () => {
    // The warning text is page/producer content — it must not drive the queue's classification.
    const send = jest.fn().mockResolvedValue(emptyStats(['upstream body looked like a Cloudflare interstitial']));
    queue = new ScrapeQueue(false);
    queue.setPluginRegistry(makeRegistry(makeRuleset('55555'), 'myfigurecollection.net'));
    queue.setIngestEmitter({ send });
    queue.setScrapingService(makeScrapingStub());

    const result = queue.enqueue('55555', { priority: 'WARM', sessionId: 's1' });
    result.promise.catch(() => {});
    await advanceUntil(() => queue.getStats().failed === 1);

    expect(queue.getStats().rateLimited).toBe(false); // warning text must NOT escalate global backoff
    const reason = mockNotifyItemFailed.mock.calls[0][2] as string;
    expect(reason).toContain('empty_record');
    expect(reason).not.toContain('rate_limited');
  });
});

describe('ScrapeQueue - cookie-authenticated empty record lands FAILED, never an auth pause [RS-3]', () => {
  let queue: ScrapeQueue;

  beforeEach(() => {
    jest.clearAllMocks();
    mockNotifyItemFailed.mockResolvedValue(true);
    jest.useFakeTimers({ advanceTimers: true });
    resetScrapeQueue();
    resetSessionManager();
  });

  afterEach(() => {
    if (queue) { queue.stop(); queue.clear(); }
    resetScrapeQueue();
    resetSessionManager();
    jest.useRealTimers();
  });

  async function advanceUntil(pred: () => boolean, stepMs = 500, maxSteps = 600): Promise<void> {
    for (let i = 0; i < maxSteps && !pred(); i++) {
      jest.advanceTimersByTime(stepMs);
      await jest.advanceTimersByTimeAsync(50);
    }
  }

  it('a permanently-empty record on a COOKIE session exhausts retries → FAILED (not held as auth_failures)', async () => {
    // An empty record is a store/content failure, not a bad-cookie fault. Booking it as a cookie
    // failure paused the user's whole sync session (reason 'auth_failures') and left the item held
    // for user action forever — no webhook, promise pending. It must fall through to FAILED instead.
    const send = jest.fn().mockResolvedValue(emptyStats());
    queue = new ScrapeQueue(false);
    queue.setPluginRegistry(makeRegistry(makeRuleset('12345'), 'myfigurecollection.net'));
    queue.setIngestEmitter({ send });
    queue.setScrapingService(makeScrapingStub());

    const result = queue.enqueue('12345', {
      cookies: { PHPSESSID: 'abc' },
      sessionId: 'sess-1',
      userId: 'u1',
    }); // default maxRetries = 3
    result.promise.catch(() => {});

    // Trip on EITHER terminal outcome so the wait ends promptly in both the buggy and fixed worlds.
    await advanceUntil(() => queue.getStats().failed === 1 || getSessionManager().isSessionPaused('sess-1'));

    expect(send).toHaveBeenCalledTimes(3);                              // bounded attempts, no infinite hold
    expect(queue.getStats().failed).toBe(1);                           // terminal FAILED, not held
    expect(getSessionManager().isSessionPaused('sess-1')).toBe(false); // the user's session is NOT paused
    expect(mockNotifyItemFailed).toHaveBeenCalledTimes(1);             // permanent-failure webhook fired
    const reason = mockNotifyItemFailed.mock.calls[0][2] as string;
    expect(reason).toContain('empty_record');
    expect(reason).toContain('mock-mfc:12345');
    await expect(result.promise).rejects.toThrow(/Scrape failed: empty_record - EMPTY_INGEST_RECORD/);
  });

  it('a genuine cookie/auth failure STILL pauses the session (regression pin — empty-record carve-out is narrow)', async () => {
    // The carve-out must be limited to empty records: a real scrape failure on a cookie session keeps
    // its existing session-pause behavior.
    const scraping = makeScrapingStub();
    scraping.scrapePageStealth.mockRejectedValue(new Error('AUTH: session cookie rejected'));
    const send = jest.fn();
    queue = new ScrapeQueue(false);
    queue.setPluginRegistry(makeRegistry(makeRuleset('999'), 'myfigurecollection.net'));
    queue.setIngestEmitter({ send });
    queue.setScrapingService(scraping);

    const result = queue.enqueue('999', { cookies: { PHPSESSID: 'z' }, sessionId: 'sess-auth', userId: 'u2' });
    result.promise.catch(() => {});
    await advanceUntil(() => getSessionManager().isSessionPaused('sess-auth') || queue.getStats().failed === 1);

    expect(getSessionManager().isSessionPaused('sess-auth')).toBe(true); // auth failures still pause
    expect(send).not.toHaveBeenCalled();
  });
});

describe('ScrapeQueue - challenge page: flag → honesty gate (recover vs fail) [CHANGE 1-2]', () => {
  let queue: ScrapeQueue;

  beforeEach(() => {
    jest.clearAllMocks();
    mockNotifyItemFailed.mockResolvedValue(true);
    jest.useFakeTimers({ advanceTimers: true });
    resetScrapeQueue();
    resetSessionManager();
  });

  afterEach(() => {
    if (queue) { queue.stop(); queue.clear(); }
    resetScrapeQueue();
    resetSessionManager();
    jest.useRealTimers();
  });

  async function advanceUntil(pred: () => boolean, stepMs = 250, maxSteps = 400): Promise<void> {
    for (let i = 0; i < maxSteps && !pred(); i++) {
      jest.advanceTimersByTime(stepMs);
      await jest.advanceTimersByTimeAsync(50);
    }
  }

  it('a challenge-flagged page the ruleset RECOVERED rows from → SUCCESS + recovered-rows log line (amiami case)', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    // The http lane serves a CF challenge body (flagged challenge:true), yet the emitter reports
    // inserted>0 — the ruleset recovered the real record through its OWN follow-up transport. The
    // honesty gate's persist-or-fail passes: an honest success, never a ChallengePageError.
    const send = jest.fn().mockResolvedValue(healthyStats());
    const http = jest.fn().mockResolvedValue(CHALLENGE_HTML);
    queue = new ScrapeQueue(false);
    queue.setPluginRegistry(makeRegistry(makeRuleset('107714'), 'amiami.example.test', { transport: 'http' }));
    queue.setIngestEmitter({ send });
    queue.setScrapingService(makeScrapingStub());
    queue.setIngestTransports({ http });

    const url = 'https://amiami.example.test/product/107714';
    const result = queue.enqueue(url, { url });
    await advanceUntil(() => queue.getStats().completed === 1 || queue.getStats().failed === 1);
    const data = await result.promise;

    expect(queue.getStats().completed).toBe(1);
    expect(queue.getStats().failed).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(data).toEqual({ name: 'Kitagawa Marin' });
    // the recovered-rows success line names site:itemId and the row count the ruleset landed
    const lines = logSpy.mock.calls.map(c => String(c[0]));
    expect(lines.some(l =>
      /\[INGEST STATS\] challenge page received for mock-mfc:107714 but the ruleset recovered 4 rows via its own transport/.test(l),
    )).toBe(true);
    logSpy.mockRestore();
  });

  it('a challenge-flagged page that persisted NOTHING → FAILS as ChallengePageError (rate_limited), never EmptyIngestRecordError', async () => {
    const send = jest.fn().mockResolvedValue(emptyStats());
    const http = jest.fn().mockResolvedValue(CHALLENGE_HTML);
    queue = new ScrapeQueue(false);
    queue.setPluginRegistry(makeRegistry(makeRuleset('12345'), 'fnc.example.test', { transport: 'http' }));
    queue.setIngestEmitter({ send });
    queue.setScrapingService(makeScrapingStub());
    queue.setIngestTransports({ http });

    const url = 'https://fnc.example.test/product/12345';
    const result = queue.enqueue(url, { url, sessionId: 's1' }); // default maxRetries = 3
    const captured = result.promise.catch((e: Error) => e);
    await advanceUntil(() => queue.getStats().failed === 1);

    expect(http).toHaveBeenCalledTimes(3);            // bounded rate_limited retries
    expect(queue.getStats().rateLimited).toBe(true);  // CF block escalated backoff (not empty_record)
    const reason = mockNotifyItemFailed.mock.calls[0][2] as string;
    expect(reason).toContain('rate_limited');
    expect(reason).toContain('Cloudflare challenge page received');
    expect(reason).toContain('via http transport');
    expect(reason).not.toContain('EMPTY_INGEST_RECORD');
    const err = (await captured) as Error;
    expect(err.message).toContain('Cloudflare challenge page received');
  });
});
