/**
 * ScrapeQueue × GATE FAILURES on the RESIDENTIAL exit — the incident host's real capability shape.
 *
 * rulesets 0.9.31 ships mfc as `searchFetch: { transport: 'impersonate', browser: 'chrome142',
 * egress: 'residential' }` and projects `access` onto searchFetch only for browser-lane profiles. So
 * before this fix mfc was a GATED host only while the cf-cookies Secret held a jar for it: with no jar
 * an empty-500 storm from Ross's home IP drew no strike, no cooldown, and was booked http_5xx.
 * A store on the residential exit is gated by its egress — the thing at risk is the home IP.
 *
 * Own file: the residential proxy is resolved ONCE at module load (residentialEgress BOOT_PROXY_URL),
 * so the queue is loaded in an isolated module registry after RESIDENTIAL_PROXY_URL is set.
 */
jest.mock('../../services/genericScraper', () => ({
  BrowserPool: {
    getStealthBrowser: jest.fn(), getBrowser: jest.fn(), returnBrowser: jest.fn(),
    getPoolSize: jest.fn().mockReturnValue(2), getPoolCapacity: jest.fn().mockReturnValue(3), reset: jest.fn(),
  },
}));
jest.mock('../../services/webhookClient', () => ({
  notifyItemSuccess: jest.fn().mockResolvedValue(true),
  notifyItemFailed: jest.fn().mockResolvedValue(true),
  notifyItemSkipped: jest.fn().mockResolvedValue(true),
}));

import type { FetchFailureReport } from '../../services/failureReporter';

const MFC = 'myfigurecollection.net';
const MIN = 60_000;

describe('ScrapeQueue × gate failures — the mfc capability shape on the residential exit, NO stored jar', () => {
  const ORIGINAL_PROXY = process.env.RESIDENTIAL_PROXY_URL;

  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    if (ORIGINAL_PROXY === undefined) delete process.env.RESIDENTIAL_PROXY_URL; else process.env.RESIDENTIAL_PROXY_URL = ORIGINAL_PROXY;
  });

  it('an empty-500 storm through the residential exit opens the cooldown and books `cooldown`, not http_5xx', async () => {
    process.env.RESIDENTIAL_PROXY_URL = 'socks5h://127.0.0.1:1';
    const m: Record<string, any> = {};
    jest.isolateModules(() => {
      m.sq = require('../../services/scrapeQueue');
      m.cc = require('../../services/challengeCooldown');
      m.er = require('../../services/extractionRegistry');
      m.egress = require('../../services/residentialEgress');
    });
    expect(m.egress.getResidentialProxyUrl()).toBe('socks5://127.0.0.1:1');
    jest.useFakeTimers({ advanceTimers: true });

    const registry = m.er.createExtractionRegistry();
    registry.registerSite({
      siteId: 'mfc', name: 'MFC', domains: [MFC],
      rateLimit: { domain: MFC, baseDelayMs: 1000, minDelayMs: 500, maxDelayMs: 5000, backoffMultiplier: 1.5, recoveryDivisor: 1.5, successThreshold: 3 },
      requiresBrowser: true, allowedCookies: [],
      // exactly toStoreCapabilities(MFC_PROFILE).searchFetch at rulesets 0.9.31 — no `access`
      searchFetch: { transport: 'impersonate', browser: 'chrome142', egress: 'residential' },
    });
    registry.registerRuleset({ siteId: 'mfc', version: '1', extract: () => { throw new Error('nothing to lift'); }, validate: () => ({ valid: true, errors: [], warnings: [] }) });
    const cd = new m.cc.ChallengeCooldown({ now: () => 1_000_000, windowMs: 30 * MIN, gateFailureThreshold: 3 });
    const impersonate = jest.fn().mockResolvedValue({ status: 500, body: '' });
    const reports: FetchFailureReport[] = [];
    const q = new m.sq.ScrapeQueue(false);
    q.setPluginRegistry(registry);
    q.setIngestEmitter({ send: jest.fn() });
    q.setScrapingService({ scrapePage: jest.fn(), scrapePageStealth: jest.fn() });
    q.setIngestTransports({ impersonate });
    q.setChallengeCooldown(cd);
    // NO jar for mfc: the Secret holds nothing for it.
    q.setCfCookieStore({ cookiesFor: () => undefined, userAgentFor: () => undefined, markStale: jest.fn(() => true), markFresh: jest.fn(() => true) });
    q.setFailureReporter({ report: async (r: FetchFailureReport) => { reports.push(r); } });

    try {
      for (const id of [1, 2, 3]) {
        const before = q.getStats();
        q.enqueue(`https://${MFC}/item/${id}`, { url: `https://${MFC}/item/${id}`, maxRetries: 4 }).promise.catch(() => {});
        for (let i = 0; i < 600; i++) {
          const s = q.getStats();
          if (s.failed + s.completed > before.failed + before.completed) break;
          jest.advanceTimersByTime(250);
          await jest.advanceTimersByTimeAsync(50);
        }
      }
    } finally {
      q.stop();
      q.clear();
    }

    expect(impersonate.mock.calls[0]?.[1]?.proxyUrl).toBe('socks5://127.0.0.1:1'); // it really left via the residential exit
    expect(impersonate).toHaveBeenCalledTimes(3); // three refused fetches open the window; nothing more leaves the home IP
    expect(cd.isOpen(MFC)).toBe(true);
    expect(reports.map((r) => r.reasonClass)).toEqual(['cooldown', 'cooldown', 'cooldown']);
  });
});
