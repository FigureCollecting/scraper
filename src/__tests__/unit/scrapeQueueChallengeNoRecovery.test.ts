/**
 * ScrapeQueue × a challenge-flagged page whose ruleset extracted a record WITHOUT recovering it —
 * NAME-ERRPAGE-1. A Cloudflare 52x error page carries `cf-error-details`, so capturingFetch flags it
 * `challenge` (challengeDetect's block marker) and the status gate stands aside for the challenge
 * path. The MFC ruleset then lifted the page's own <h1> ("Connection timed out Error code 522") as
 * the item's name, extraction SUCCEEDED, and the record was SENT before any gate looked at it: the
 * post-emit honesty gate saw persisted>0 and logged the "amiami recovery". 827 spine products carry
 * such a name, and the ledger booked every one of those fetches a success.
 *
 * The amiami recovery is real, but it is a FOLLOW-UP: the ruleset reaches the record through its own
 * transport (ctx.scraping.fetchBody, or the scrapePage passthroughs) and that answer is a real page.
 * So a challenge-flagged page now needs that evidence BEFORE anything is emitted:
 *   1. browser lane, CF 522 page, ruleset extracts from it, no follow-up → nothing sent, ONE fetch,
 *      ChallengePageError (rate_limited), host cooldown opened.
 *   2. http lane, challenge body, extraction from the body alone → same.
 *   3. a follow-up fetchBody that answers a REAL body → recovered: sent, success (amiami).
 *   4. a follow-up fetchBody that is itself a challenge → not recovered: nothing sent.
 *   5. a follow-up through the scrapePage passthrough answering a real page → recovered.
 *   6. a follow-up fetchBody answering 5xx → not recovered.
 *   7. a NON-challenge page is untouched by any of this (no follow-up needed).
 *   8. a scrapePage passthrough that answers a CF interstitial recovers nothing.
 *   9. a scrapePageStealth passthrough answering a real page recovers.
 *  10. a follow-up whose status the lane did not observe counts as recovered.
 *  11. a follow-up answered, but the record is the challenge page's own h1 → nothing sent.
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

import type { ExtractContext, ExtractionRuleset, ExtractedData, StoreCapabilities } from '@figurecollecting/scraper-plugin-contract';
import { ScrapeQueue, resetScrapeQueue } from '../../services/scrapeQueue';
import { ChallengeCooldown, resetChallengeCooldown } from '../../services/challengeCooldown';
import { createExtractionRegistry, ExtractionRegistryImpl } from '../../services/extractionRegistry';
import { resetSessionManager } from '../../services/sessionManager';

const HOST = 'store.example.test';
const SITE = 'errpage-mock';
const MIN = 60_000;
/** Cloudflare's 522 page as the browser renders it (trimmed): the h1 a ruleset reads as a name, and cf-error-details. */
const CF_522_HTML =
  '<html><head><title>store.example.test | 522: Connection timed out</title></head><body>'
  + '<div id="cf-wrapper"><div id="cf-error-details" class="p-0"><header><h1><span>Connection timed out</span>'
  + '<span>Error code 522</span></h1></header></div></div></body></html>';
const CHALLENGE_HTML = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
const CLEAN_HTML = '<html><body><h1 class="title">Matoi Ryuuko Onsen Ver.</h1></body></html>';
const API_JSON = '{"item":{"name":"Matoi Ryuuko Onsen Ver."}}';

const zClaim = (o: Record<string, number> = {}) => ({ emitted: 0, inserted: 0, deduped: 0, quarantined: 0, dropped: 0, ...o });
const zTable = (o: Record<string, number> = {}) => ({ emitted: 0, inserted: 0, deduped: 0, dropped: 0, ...o });
const zPrice = () => ({ emitted: 0, inserted: 0, deduped: 0, skipped: 0, dropped: 0 });
const healthyStats = () => ({
  sourceId: 'src-1', productId: 'prod-1', claims: zClaim({ emitted: 3, inserted: 3 }), identifiers: zTable({ emitted: 1, inserted: 1 }),
  prices: zPrice(), availability: zTable(), warnings: [] as string[], registeredNewAttrs: 0, emptyFields: 0,
});

/** What the pre-guard MFC ruleset did with any body: the first <h1>'s text is the name. */
function h1Record(html: string, url: string): ExtractedData {
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1]?.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() ?? '';
  return {
    source: { site: SITE, itemId: url.split('/').pop() ?? '1', url, extractedAt: '2026-10-20T00:00:00.000Z', rulesetVersion: '3.1' },
    fields: { name: h1 },
    warnings: [],
  };
}

type FollowUp = (ctx: ExtractContext | undefined, url: string) => Promise<unknown>;

/** A ruleset that optionally makes one follow-up through its context, then extracts from the primary body. */
function ruleset(followUp?: FollowUp): ExtractionRuleset {
  return {
    siteId: SITE,
    version: '3.1',
    extract: (html: string, url: string) => h1Record(html, url),
    async extractAsync(html: string, url: string, ctx?: ExtractContext) {
      if (followUp) await followUp(ctx, url);
      return h1Record(html, url);
    },
    validate: () => ({ valid: true, errors: [], warnings: [] }),
  } as ExtractionRuleset;
}

function makeRegistry(rs: ExtractionRuleset, transport: 'http' | 'browser'): ExtractionRegistryImpl {
  const registry = createExtractionRegistry();
  const caps: StoreCapabilities = {
    siteId: rs.siteId,
    name: 'Mock store',
    domains: [HOST],
    rateLimit: { domain: HOST, baseDelayMs: 1000, minDelayMs: 500, maxDelayMs: 5000, backoffMultiplier: 1.5, recoveryDivisor: 1.5, successThreshold: 3 },
    requiresBrowser: transport === 'browser',
    allowedCookies: [],
    searchFetch: { transport },
  };
  registry.registerSite(caps);
  registry.registerRuleset(rs);
  return registry;
}

describe('ScrapeQueue × challenge-flagged page: no emit without a recovered follow-up (NAME-ERRPAGE-1)', () => {
  let queue: ScrapeQueue;
  let cd: ChallengeCooldown;

  beforeEach(() => {
    jest.clearAllMocks();
    mockNotifyItemFailed.mockResolvedValue(true);
    jest.useFakeTimers({ advanceTimers: true });
    resetScrapeQueue();
    resetSessionManager();
    resetChallengeCooldown();
    cd = new ChallengeCooldown({ now: () => 1_000_000, windowMs: MIN });
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    if (queue) { queue.stop(); queue.clear(); }
    resetScrapeQueue();
    resetSessionManager();
    resetChallengeCooldown();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  async function advanceUntil(pred: () => boolean, stepMs = 250, maxSteps = 400): Promise<void> {
    for (let i = 0; i < maxSteps && !pred(); i++) {
      jest.advanceTimersByTime(stepMs);
      await jest.advanceTimersByTimeAsync(50);
    }
  }

  async function settle(ms = 30_000): Promise<void> {
    for (let t = 0; t < ms; t += 500) {
      jest.advanceTimersByTime(500);
      await jest.advanceTimersByTimeAsync(50);
    }
  }

  function build(rs: ExtractionRuleset, transport: 'http' | 'browser', fetchers: {
    http?: jest.Mock; scrapePage?: jest.Mock; scrapePageStealth?: jest.Mock;
  }, send: jest.Mock): ScrapeQueue {
    const q = new ScrapeQueue(false);
    q.setPluginRegistry(makeRegistry(rs, transport));
    q.setIngestEmitter({ send });
    q.setScrapingService({ scrapePage: fetchers.scrapePage ?? jest.fn(), scrapePageStealth: fetchers.scrapePageStealth ?? jest.fn() } as any);
    if (fetchers.http) q.setIngestTransports({ http: fetchers.http });
    q.setChallengeCooldown(cd);
    return q;
  }

  async function expectRefused(fetches: jest.Mock, send: jest.Mock, captured: Promise<unknown>, lane: string): Promise<void> {
    await advanceUntil(() => queue.getStats().failed === 1);
    await settle();
    expect(send).not.toHaveBeenCalled();             // nothing reached the spine
    expect(fetches).toHaveBeenCalledTimes(1);          // one shot: no retry storm on the gated host
    expect(queue.getStats().failed).toBe(1);
    expect(queue.getStats().rateLimited).toBe(true);
    const err = (await captured) as Error;
    expect(err.message).toContain('Cloudflare challenge page received');
    expect(err.message).toContain(`via ${lane} transport`);
    expect(cd.isOpen(HOST)).toBe(true);
    expect(cd.list()[0]?.reason).toContain('not recovered');
  }

  it('(1) browser lane: the CF 522 page itself is extracted (its h1 as the name) → nothing sent, ChallengePageError, cooldown', async () => {
    const page = { html: CF_522_HTML, url: `https://${HOST}/item/1`, finalUrl: `https://${HOST}/item/1`, title: '522', statusCode: 522 };
    const scrapePage = jest.fn().mockResolvedValue(page);
    const send = jest.fn().mockResolvedValue(healthyStats());
    queue = build(ruleset(), 'browser', { scrapePage }, send);
    const url = `https://${HOST}/item/1`;
    const captured = queue.enqueue(url, { url, sessionId: 's1' }).promise.catch((e: Error) => e);
    await expectRefused(scrapePage, send, captured, 'browser');
  });

  it('(2) http lane: a challenge body extracted without any follow-up → nothing sent', async () => {
    const http = jest.fn().mockResolvedValue(CHALLENGE_HTML);
    const send = jest.fn().mockResolvedValue(healthyStats());
    queue = build(ruleset(), 'http', { http }, send);
    const url = `https://${HOST}/item/2`;
    const captured = queue.enqueue(url, { url, sessionId: 's1' }).promise.catch((e: Error) => e);
    await expectRefused(http, send, captured, 'http');
  });

  it('(3) a follow-up fetchBody that answers a real body RECOVERS the record → sent, success (amiami)', async () => {
    const http = jest.fn((u: string) => Promise.resolve(u.includes('/api/') ? { body: API_JSON, status: 200 } : CHALLENGE_HTML));
    const send = jest.fn().mockResolvedValue(healthyStats());
    queue = build(ruleset((ctx, url) => ctx!.scraping.fetchBody!(url.replace('/item/', '/api/'))), 'http', { http }, send);
    const url = `https://${HOST}/item/3`;
    const result = queue.enqueue(url, { url, sessionId: 's1' });
    await advanceUntil(() => queue.getStats().completed === 1 || queue.getStats().failed === 1);
    await result.promise;
    expect(http).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(1);
    expect(queue.getStats().completed).toBe(1);
    expect(cd.isOpen(HOST)).toBe(false);
  });

  it('(4) a follow-up that is itself a challenge recovers nothing → nothing sent', async () => {
    const http = jest.fn().mockResolvedValue(CHALLENGE_HTML);
    const send = jest.fn().mockResolvedValue(healthyStats());
    queue = build(ruleset((ctx, url) => ctx!.scraping.fetchBody!(url.replace('/item/', '/api/'))), 'http', { http }, send);
    const url = `https://${HOST}/item/4`;
    const captured = queue.enqueue(url, { url, sessionId: 's1' }).promise.catch((e: Error) => e);
    await advanceUntil(() => queue.getStats().failed === 1);
    await settle();
    expect(send).not.toHaveBeenCalled();
    expect(http).toHaveBeenCalledTimes(2);             // the page and its one follow-up, never retried
    expect(((await captured) as Error).message).toContain('Cloudflare challenge page received');
  });

  it('(5) a follow-up through the scrapePage passthrough answering a real page RECOVERS', async () => {
    const http = jest.fn().mockResolvedValue(CHALLENGE_HTML);
    const scrapePage = jest.fn().mockResolvedValue({ html: CLEAN_HTML, url: 'x', title: 'Item', statusCode: 200 });
    const send = jest.fn().mockResolvedValue(healthyStats());
    queue = build(ruleset((ctx, url) => ctx!.scraping.scrapePage(url.replace('/item/', '/m/'))), 'http', { http, scrapePage }, send);
    const url = `https://${HOST}/item/5`;
    const result = queue.enqueue(url, { url, sessionId: 's1' });
    await advanceUntil(() => queue.getStats().completed === 1 || queue.getStats().failed === 1);
    await result.promise;
    expect(scrapePage).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('(6) a follow-up answering a 5xx (or an empty body) recovers nothing', async () => {
    const http = jest.fn((u: string) => Promise.resolve(u.includes('/api/') ? { body: 'upstream down', status: 503 } : CHALLENGE_HTML));
    const scrapePageStealth = jest.fn().mockResolvedValue({ html: '   ', url: 'x', title: '', statusCode: 200 });
    const send = jest.fn().mockResolvedValue(healthyStats());
    queue = build(ruleset(async (ctx, url) => {
      await ctx!.scraping.fetchBody!(url.replace('/item/', '/api/'));
      await ctx!.scraping.scrapePageStealth(url.replace('/item/', '/m/'));
    }), 'http', { http, scrapePageStealth }, send);
    const url = `https://${HOST}/item/6`;
    const captured = queue.enqueue(url, { url, sessionId: 's1' }).promise.catch((e: Error) => e);
    await advanceUntil(() => queue.getStats().failed === 1);
    expect(send).not.toHaveBeenCalled();
    expect(((await captured) as Error).message).toContain('Cloudflare challenge page received');
  });

  it('(7) a NON-challenge page needs no follow-up: sent as before', async () => {
    const http = jest.fn().mockResolvedValue(CLEAN_HTML);
    const send = jest.fn().mockResolvedValue(healthyStats());
    queue = build(ruleset(), 'http', { http }, send);
    const url = `https://${HOST}/item/7`;
    const result = queue.enqueue(url, { url, sessionId: 's1' });
    await advanceUntil(() => queue.getStats().completed === 1 || queue.getStats().failed === 1);
    await result.promise;
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].fields.name).toBe('Matoi Ryuuko Onsen Ver.');
    expect(cd.isOpen(HOST)).toBe(false);
  });

  it('(8) a scrapePage passthrough that answers a CF interstitial (status 200) recovers nothing', async () => {
    const http = jest.fn().mockResolvedValue(CHALLENGE_HTML);
    const scrapePage = jest.fn().mockResolvedValue({ html: CHALLENGE_HTML, url: 'x', title: 'Just a moment...', statusCode: 200 });
    const send = jest.fn().mockResolvedValue(healthyStats());
    queue = build(ruleset((ctx, url) => ctx!.scraping.scrapePage(url.replace('/item/', '/m/'))), 'http', { http, scrapePage }, send);
    const url = `https://${HOST}/item/8`;
    const captured = queue.enqueue(url, { url, sessionId: 's1' }).promise.catch((e: Error) => e);
    await advanceUntil(() => queue.getStats().failed === 1);
    expect(scrapePage).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    expect(((await captured) as Error).message).toContain('Cloudflare challenge page received');
  });

  it('(9) a scrapePageStealth passthrough answering a real page RECOVERS', async () => {
    const http = jest.fn().mockResolvedValue(CHALLENGE_HTML);
    const scrapePageStealth = jest.fn().mockResolvedValue({ html: CLEAN_HTML, url: 'x', title: 'Item', statusCode: 200 });
    const send = jest.fn().mockResolvedValue(healthyStats());
    queue = build(ruleset((ctx, url) => ctx!.scraping.scrapePageStealth(url.replace('/item/', '/m/'))), 'http', { http, scrapePageStealth }, send);
    const url = `https://${HOST}/item/9`;
    const result = queue.enqueue(url, { url, sessionId: 's1' });
    await advanceUntil(() => queue.getStats().completed === 1 || queue.getStats().failed === 1);
    await result.promise;
    expect(scrapePageStealth).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('(10) a follow-up whose status the lane did not observe (bare body) counts as recovered', async () => {
    const http = jest.fn((u: string) => Promise.resolve(u.includes('/api/') ? API_JSON : CHALLENGE_HTML));
    const send = jest.fn().mockResolvedValue(healthyStats());
    queue = build(ruleset((ctx, url) => ctx!.scraping.fetchBody!(url.replace('/item/', '/api/'))), 'http', { http }, send);
    const url = `https://${HOST}/item/10`;
    const result = queue.enqueue(url, { url, sessionId: 's1' });
    await advanceUntil(() => queue.getStats().completed === 1 || queue.getStats().failed === 1);
    await result.promise;
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('(11) a follow-up answered but the record is still the challenge page\'s own h1 (amiami "no item" fallback) → nothing sent', async () => {
    const http = jest.fn((u: string) => Promise.resolve(u.includes('/api/') ? { body: '{"RSuccess":false,"item":null}', status: 200 } : { body: CF_522_HTML, status: 522 }));
    const send = jest.fn().mockResolvedValue(healthyStats());
    queue = build(ruleset((ctx, url) => ctx!.scraping.fetchBody!(url.replace('/item/', '/api/'))), 'http', { http }, send);
    const url = `https://${HOST}/item/11`;
    const captured = queue.enqueue(url, { url, sessionId: 's1' }).promise.catch((e: Error) => e);
    await advanceUntil(() => queue.getStats().failed === 1 || queue.getStats().completed === 1);
    expect(send).not.toHaveBeenCalled();
    expect(((await captured) as Error).message).toContain('Cloudflare challenge page received');
    expect(cd.isOpen(HOST)).toBe(false);               // the host served the follow-up: no cooldown for this one
  });
});
