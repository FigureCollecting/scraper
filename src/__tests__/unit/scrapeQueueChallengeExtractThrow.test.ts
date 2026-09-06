/**
 * ScrapeQueue × challenge page whose EXTRACTION THROWS — the second door into the challenge-retry
 * storm (live 2026-09-06, orzgk): capturingFetch FLAGS a Cloudflare interstitial ({challenge:true})
 * and never throws; a JSON-only ruleset then can't parse the HTML body and extractRecords' D11
 * guard throws a PLAIN Error ("record[0] has no source.itemId"). Before this fix the ingest catch
 * rethrew it as-is → classifyError 'unknown' → shouldRetry re-fetched the challenge page up to
 * maxRetries, and cooldown.open (reachable only at the post-emit honesty gate) never ran — so
 * /health/detailed listed no cooldown after a 15-fetch storm.
 *
 * The fix routes an extraction throw ON A CHALLENGE-FLAGGED PAGE through the same fail-fast seam as
 * the honesty gate: one fetch, ChallengePageError (rate_limited, one-shot), host cooldown opened.
 *
 *   1. extract THROWS on a challenge page → ONE fetch, ChallengePageError, cooldown open (reason
 *      names the transport), no retry.
 *   1b. the live shape: a record with no source.itemId (D11 guard throws) → same.
 *   2. EmptyExtractionError from a NON-opting ruleset on a challenge page → same.
 *   3. EmptyExtractionError from an OPTING ruleset (emptyResultIsValid) on a challenge page → still
 *      a FAILURE (the !page.challenge guard) and now one-shot + cooldown, not retried.
 *   4. NON-challenge page + extract throws → UNCHANGED: 'unknown', bounded retries, no cooldown.
 *   5. challenge page + extraction SUCCEEDS + persisted>0 → UNCHANGED success, no cooldown (amiami).
 *   6. after (1), a second item for the same host is skipped by the pre-fetch cooldown gate WITHOUT
 *      any fetch (the shared seam).
 *
 * Harness mirrors scrapeQueueChallengeCooldown.test.ts: http transport lane so the challenge body
 * is flagged; the cooldown clock is injected; fake timers throughout — no live fetches.
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

type OptInRuleset = ExtractionRuleset & { emptyResultIsValid?: boolean };

const HOST = 'orzgk.example.test';
const SITE = 'orzgk-mock';
const CLEAN_HTML = '<html><body><h1 class="title">Vegito</h1></body></html>';
/** The CF managed-challenge interstitial (what capturingFetch's http lane flags challenge:true). */
const CHALLENGE_HTML = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
const MIN = 60_000;

const zClaim = (o: Record<string, number> = {}) => ({ emitted: 0, inserted: 0, deduped: 0, quarantined: 0, dropped: 0, ...o });
const zTable = (o: Record<string, number> = {}) => ({ emitted: 0, inserted: 0, deduped: 0, dropped: 0, ...o });
const zPrice = () => ({ emitted: 0, inserted: 0, deduped: 0, skipped: 0, dropped: 0 });
const healthyStats = () => ({
  sourceId: 'src-1', productId: 'prod-1', claims: zClaim({ emitted: 3, inserted: 3 }), identifiers: zTable({ emitted: 1, inserted: 1 }),
  prices: zPrice(), availability: zTable(), warnings: [] as string[], registeredNewAttrs: 0, emptyFields: 0,
});

function recordFor(url: string, itemId = 'v1'): ExtractedData {
  return {
    source: { site: SITE, itemId, url, extractedAt: '2026-09-06T00:00:00.000Z', rulesetVersion: '1.0.0' },
    fields: { name: 'Vegito' },
    warnings: [],
  };
}

/** A ruleset whose single-record `extract` is caller-supplied (throwing, malformed, or healthy). */
function extractRuleset(extract: (html: string, url: string) => ExtractedData): OptInRuleset {
  return { siteId: SITE, version: '1.0.0', extract, validate: () => ({ valid: true, errors: [], warnings: [] }) };
}

/** A ruleset whose `extractMany` returns `[]` (→ EmptyExtractionError), optionally opting into valid-empty. */
function emptyManyRuleset(emptyResultIsValid?: boolean): OptInRuleset {
  const r: OptInRuleset = {
    siteId: SITE,
    version: '1.0.0',
    extract: (_html: string, url: string) => recordFor(url),
    extractMany: () => [],
    validate: () => ({ valid: true, errors: [], warnings: [] }),
  };
  if (emptyResultIsValid !== undefined) r.emptyResultIsValid = emptyResultIsValid;
  return r;
}

function makeRegistry(ruleset: OptInRuleset): ExtractionRegistryImpl {
  const registry = createExtractionRegistry();
  const caps: StoreCapabilities = {
    siteId: ruleset.siteId,
    name: 'Mock orzgk',
    domains: [HOST],
    rateLimit: { domain: HOST, baseDelayMs: 1000, minDelayMs: 500, maxDelayMs: 5000, backoffMultiplier: 1.5, recoveryDivisor: 1.5, successThreshold: 3 },
    requiresBrowser: false,
    allowedCookies: [],
    searchFetch: { transport: 'http' },
  };
  registry.registerSite(caps);
  registry.registerRuleset(ruleset as ExtractionRuleset);
  return registry;
}

describe('ScrapeQueue × challenge page whose extraction THROWS (fail fast + open cooldown)', () => {
  let queue: ScrapeQueue;
  let cdNow: number;
  let cd: ChallengeCooldown;
  let errorSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockNotifyItemFailed.mockResolvedValue(true);
    jest.useFakeTimers({ advanceTimers: true });
    resetScrapeQueue();
    resetSessionManager();
    resetChallengeCooldown();
    cdNow = 1_000_000;
    cd = new ChallengeCooldown({ now: () => cdNow, windowMs: MIN });
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
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

  /** Keep driving the fake clock well past any retry window to prove NOTHING else happens. */
  async function settle(ms = 30_000): Promise<void> {
    for (let t = 0; t < ms; t += 500) {
      jest.advanceTimersByTime(500);
      await jest.advanceTimersByTimeAsync(50);
    }
  }

  function buildQueue(ruleset: OptInRuleset, http: jest.Mock, send: jest.Mock = jest.fn()): ScrapeQueue {
    const q = new ScrapeQueue(false);
    q.setPluginRegistry(makeRegistry(ruleset));
    q.setIngestEmitter({ send });
    q.setScrapingService({ scrapePage: jest.fn(), scrapePageStealth: jest.fn() } as any);
    q.setIngestTransports({ http });
    q.setChallengeCooldown(cd);
    return q;
  }

  const errorLines = () => errorSpy.mock.calls.map((c) => String(c[0]));
  const logLines = () => logSpy.mock.calls.map((c) => String(c[0]));

  /** Shared assertions for the one-shot + cooldown outcome. */
  async function expectOneShotChallengeFailure(http: jest.Mock, send: jest.Mock, captured: Promise<unknown>): Promise<void> {
    await advanceUntil(() => queue.getStats().failed === 1);
    await settle(); // any retry would land another fetch inside this window
    expect(http).toHaveBeenCalledTimes(1);            // EXACTLY ONE fetch — no retry storm
    expect(send).not.toHaveBeenCalled();              // extraction threw → nothing reached the emitter
    expect(queue.getStats().failed).toBe(1);
    expect(queue.getStats().completed).toBe(0);
    expect(queue.getStats().rateLimited).toBe(true);  // class stays rate_limited → global backoff fires once
    const err = (await captured) as Error;
    expect(err.message).toContain('rate_limited');
    expect(err.message).toContain('Cloudflare challenge page received');
    expect(err.message).toContain('via http transport');
    const reason = mockNotifyItemFailed.mock.calls[0][2] as string;
    expect(reason).toContain('rate_limited');
    expect(reason).not.toContain('unknown');
    // the cooldown is OPEN for the host and its reason names the transport
    expect(cd.isOpen(HOST)).toBe(true);
    expect(cd.list()).toHaveLength(1);
    expect(cd.list()[0].host).toBe(HOST);
    expect(cd.list()[0].reason).toContain('http');
    // the one-shot line was logged
    expect(errorLines().some((l) => l.includes('Extraction failed on a challenge page') && l.includes('host cooldown opened'))).toBe(true);
  }

  it('(1) extract THROWS on a challenge page → one fetch, ChallengePageError (rate_limited), cooldown opened, no retry', async () => {
    const http = jest.fn().mockResolvedValue(CHALLENGE_HTML);
    const send = jest.fn();
    const boom = jest.fn(() => { throw new Error('Unexpected token < in JSON at position 0'); });
    queue = buildQueue(extractRuleset(boom as any), http, send); // default maxRetries = 3 → proves fail-fast despite retries allowed

    const url = `https://${HOST}/product/12345`;
    const result = queue.enqueue(url, { url, sessionId: 's1' });
    const captured = result.promise.catch((e: Error) => e);

    await expectOneShotChallengeFailure(http, send, captured);
    expect(boom).toHaveBeenCalledTimes(1);
  });

  it('(1b) the live orzgk shape: a record with no source.itemId (D11 guard throws) on a challenge page → same one-shot + cooldown', async () => {
    const http = jest.fn().mockResolvedValue(CHALLENGE_HTML);
    const send = jest.fn();
    // extractRecords' D11 guard throws a PLAIN Error for this: "record[0] has no source.itemId"
    const malformed = extractRuleset((_html, url) => ({ source: { site: SITE, url } as any, fields: {}, warnings: [] }));
    queue = buildQueue(malformed, http, send);

    const url = `https://${HOST}/product/67890`;
    const result = queue.enqueue(url, { url, sessionId: 's1' });
    const captured = result.promise.catch((e: Error) => e);

    await expectOneShotChallengeFailure(http, send, captured);
    // the original D11 message still reached the extraction-failed log line (not swallowed)
    expect(errorLines().some((l) => l.includes('has no source.itemId'))).toBe(true);
  });

  it('(2) EmptyExtractionError from a NON-opting ruleset on a challenge page → one-shot + cooldown', async () => {
    const http = jest.fn().mockResolvedValue(CHALLENGE_HTML);
    const send = jest.fn();
    queue = buildQueue(emptyManyRuleset(), http, send); // no emptyResultIsValid opt-in

    const url = `https://${HOST}/search/none`;
    const result = queue.enqueue(url, { url, sessionId: 's1' });
    const captured = result.promise.catch((e: Error) => e);

    await expectOneShotChallengeFailure(http, send, captured);
    expect(logLines().some((l) => l.includes('valid-empty'))).toBe(false);
  });

  it('(3) EmptyExtractionError from an OPTING ruleset on a challenge page → still a FAILURE, now one-shot + cooldown (not retried)', async () => {
    const http = jest.fn().mockResolvedValue(CHALLENGE_HTML);
    const send = jest.fn();
    queue = buildQueue(emptyManyRuleset(true), http, send); // emptyResultIsValid: true — the !page.challenge guard still rejects it

    const url = `https://${HOST}/search/none`;
    const result = queue.enqueue(url, { url, sessionId: 's1' });
    const captured = result.promise.catch((e: Error) => e);

    await expectOneShotChallengeFailure(http, send, captured);
    expect(logLines().some((l) => l.includes('valid-empty'))).toBe(false); // never swept into valid-empty
  });

  it('(4) NON-challenge page + extract throws → UNCHANGED: unknown, bounded retries, cooldown NOT opened, no ChallengePageError', async () => {
    const http = jest.fn().mockResolvedValue(CLEAN_HTML);
    const send = jest.fn();
    const boom = jest.fn(() => { throw new Error("Cannot read properties of undefined (reading 'price')"); });
    queue = buildQueue(extractRuleset(boom as any), http, send); // default maxRetries = 3

    const url = `https://${HOST}/product/1`;
    const result = queue.enqueue(url, { url, sessionId: 's1' });
    const captured = result.promise.catch((e: Error) => e);
    await advanceUntil(() => queue.getStats().failed === 1);
    await settle();

    expect(http).toHaveBeenCalledTimes(3);            // bounded 'unknown' retries (default maxRetries = 3), exactly as before
    expect(boom).toHaveBeenCalledTimes(3);
    expect(send).not.toHaveBeenCalled();
    expect(queue.getStats().failed).toBe(1);
    expect(queue.getStats().rateLimited).toBe(false); // not a rate-limit class
    const err = (await captured) as Error;
    expect(err.message).toContain('unknown');
    expect(err.message).not.toContain('Cloudflare challenge page received');
    const reason = mockNotifyItemFailed.mock.calls[0][2] as string;
    expect(reason).toContain('unknown');
    expect(cd.isOpen(HOST)).toBe(false);              // cooldown untouched
    expect(cd.list()).toEqual([]);
    expect(errorLines().some((l) => l.includes('host cooldown opened'))).toBe(false);
  });

  it('(5) challenge page + extraction SUCCEEDS + persisted>0 → UNCHANGED success, cooldown NOT opened (amiami recovery)', async () => {
    const http = jest.fn().mockResolvedValue(CHALLENGE_HTML);
    const send = jest.fn().mockResolvedValue(healthyStats()); // the ruleset recovered the record via its own transport
    queue = buildQueue(extractRuleset((_html, url) => recordFor(url)), http, send);

    const url = `https://${HOST}/product/amiami-1`;
    const result = queue.enqueue(url, { url, sessionId: 's1' });
    await advanceUntil(() => queue.getStats().completed === 1 || queue.getStats().failed === 1);
    await result.promise;

    expect(http).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(queue.getStats().completed).toBe(1);
    expect(queue.getStats().failed).toBe(0);
    expect(cd.isOpen(HOST)).toBe(false);              // recovered → no cooldown
    expect(cd.list()).toEqual([]);
    expect(mockNotifyItemFailed).not.toHaveBeenCalled();
    expect(errorLines()).toEqual([]);
  });

  it('(6) after (1), a SECOND item for the same host is skipped by the pre-fetch cooldown gate WITHOUT any fetch (shared seam)', async () => {
    const http = jest.fn().mockResolvedValue(CHALLENGE_HTML);
    const send = jest.fn();
    const boom = jest.fn(() => { throw new Error('Unexpected token < in JSON at position 0'); });
    queue = buildQueue(extractRuleset(boom as any), http, send);

    const first = `https://${HOST}/product/1`;
    const r1 = queue.enqueue(first, { url: first, sessionId: 's1' });
    r1.promise.catch(() => {});
    await advanceUntil(() => queue.getStats().failed === 1);
    expect(http).toHaveBeenCalledTimes(1);
    expect(cd.isOpen(HOST)).toBe(true);

    const second = `https://${HOST}/product/2`;
    const r2 = queue.enqueue(second, { url: second, sessionId: 's1' });
    const captured2 = r2.promise.catch((e: Error) => e);
    await advanceUntil(() => queue.getStats().failed === 2);
    await settle();

    expect(http).toHaveBeenCalledTimes(1);            // STILL one — the second item never fetched
    expect(boom).toHaveBeenCalledTimes(1);
    expect(queue.getStats().failed).toBe(2);
    const err2 = (await captured2) as Error;
    expect(err2.message).toContain('challenge_cooldown');
    expect(err2.message).toContain(HOST);
    expect(err2.message).toContain('min remaining');
    const reason2 = mockNotifyItemFailed.mock.calls[1][2] as string;
    expect(reason2).toContain('challenge_cooldown');
  });
});
