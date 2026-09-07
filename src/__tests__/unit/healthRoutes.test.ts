/**
 * createHealthRoutes — the service health surface, extracted from index.ts so it is testable without
 * booting the server. Contract preserved: GET / , GET /health , GET /version (unchanged), and GET
 * /health/detailed now ADDITIVELY carries `challengeCooldowns: [{host, remainingMs, reason}]` beside
 * the existing browserPool block. Deps (version / browser-pool health / cooldown list) are injected.
 */
import express from 'express';
import request from 'supertest';
import { createHealthRoutes, type HealthDeps } from '../../routes/health';
import { CfCookieStore } from '../../services/cookieJar';

const build = (over: Partial<HealthDeps> = {}) => {
  const app = express();
  app.use('/', createHealthRoutes({
    version: '9.9.9',
    getBrowserPoolHealth: async () => ({ available: 2, capacity: 3, healthy: true }),
    listChallengeCooldowns: () => [],
    listCfCookies: () => [],
    getResidentialEgress: () => ({ configured: false }),
    getBrowserLane: () => ({ launchMode: 'headless', residentialTimezone: null, directTimezone: null, persistentContexts: 0 }),
    ...over,
  }));
  return app;
};

describe('createHealthRoutes', () => {
  it('GET / and GET /health return service/version/status', async () => {
    for (const path of ['/', '/health']) {
      const res = await request(build()).get(path);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ service: 'scraper', version: '9.9.9', status: 'healthy' });
    }
  });

  it('GET /version returns name/version/status', async () => {
    const res = await request(build()).get('/version');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ name: 'scraper', version: '9.9.9', status: 'ok' });
  });

  it('GET /health/detailed carries browserPool AND challengeCooldowns [{host, remainingMs, reason}]', async () => {
    const app = build({
      listChallengeCooldowns: () => [{ host: 'coolhost.example.test', remainingMs: 1_740_000, reason: 'search challenge page' }],
    });

    const res = await request(app).get('/health/detailed');

    expect(res.status).toBe(200);
    expect(res.body.service).toBe('scraper');
    expect(res.body.status).toBe('healthy');
    expect(res.body.browserPool).toEqual({ available: 2, capacity: 3, healthy: true });
    expect(res.body.challengeCooldowns).toEqual([
      { host: 'coolhost.example.test', remainingMs: 1_740_000, reason: 'search challenge page' },
    ]);
    expect(typeof res.body.timestamp).toBe('string');
  });

  it('GET /health/detailed defaults challengeCooldowns to [] when nothing is cooling', async () => {
    const res = await request(build()).get('/health/detailed');
    expect(res.status).toBe(200);
    expect(res.body.challengeCooldowns).toEqual([]);
  });

  it('GET /health/detailed degrades to 500 when browser-pool health throws (challengeCooldowns still additive elsewhere)', async () => {
    const app = build({ getBrowserPoolHealth: async () => { throw new Error('pool down'); } });
    const res = await request(app).get('/health/detailed');
    expect(res.status).toBe(500);
    expect(res.body.status).toBe('degraded');
    expect(res.body.error).toBe('pool down');
  });

  it('GET /health/detailed reports "Unknown error" when the browser-pool health rejects with a non-Error', async () => {
    const app = build({ getBrowserPoolHealth: async () => { throw 'boom-string'; } });
    const res = await request(app).get('/health/detailed');
    expect(res.status).toBe(500);
    expect(res.body.status).toBe('degraded');
    expect(res.body.error).toBe('Unknown error');
  });

  it('GET /health/detailed keeps challengeCooldowns on the degraded (500) branch (listChallengeCooldowns cannot throw)', async () => {
    const app = build({
      getBrowserPoolHealth: async () => { throw new Error('pool down'); },
      listChallengeCooldowns: () => [{ host: 'coolhost.example.test', remainingMs: 1_740_000, reason: 'search challenge page' }],
    });
    const res = await request(app).get('/health/detailed');
    expect(res.status).toBe(500);
    expect(res.body.status).toBe('degraded');
    expect(res.body.error).toBe('pool down');
    expect(res.body.challengeCooldowns).toEqual([
      { host: 'coolhost.example.test', remainingMs: 1_740_000, reason: 'search challenge page' },
    ]);
  });

  /**
   * Additive `cfCookies` view (CfCookieStore.view()): per-host cookie NAMES, UA-pin flag, load /
   * mint / expiry timestamps and the stale mark — driven by a REAL store over an in-memory file whose
   * values are obviously fake, so the leak assertion greps the whole JSON for them.
   */
  describe('cfCookies (stored-cookie view)', () => {
    const VALUES = ['FAKE_cf_1', 'FAKE_sess_1', 'FAKE-MINT-UA'];
    const FILE = JSON.stringify({
      'myfigurecollection.net': {
        cookies: { cf_clearance: 'FAKE_cf_1', PHPSESSID: 'FAKE_sess_1' },
        userAgent: 'Mozilla/5.0 FAKE-MINT-UA',
        mintedAt: '2026-09-06T00:00:00.000Z',
        expiresAt: '2026-09-07T00:00:00.000Z',
      },
    });
    const realStore = () => {
      const store = new CfCookieStore({
        path: '/x/cf-cookies.json',
        fs: { openSync: () => 7, fstatSync: () => ({ mtimeMs: 1 }), readFileSync: () => FILE, closeSync: () => {} },
        now: () => 1_700_000_000_000,
      });
      store.load();
      return store;
    };

    it('GET /health/detailed carries cfCookies with the view shape and NO cookie/UA value anywhere in the JSON', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const store = realStore();
      store.markStale('myfigurecollection.net', 'browser', 'challenge page via browser transport');
      const res = await request(build({ listCfCookies: () => store.view() })).get('/health/detailed');

      expect(res.status).toBe(200);
      expect(res.body.cfCookies).toEqual([{
        host: 'myfigurecollection.net',
        cookieNames: ['cf_clearance', 'PHPSESSID'],
        userAgentPinned: true,
        loadedAt: '2023-11-14T22:13:20.000Z',
        mintedAt: '2026-09-06T00:00:00.000Z',
        expiresAt: '2026-09-07T00:00:00.000Z',
        stale: true,
        staleSince: '2023-11-14T22:13:20.000Z',
        staleReason: 'challenge page via browser transport',
      }]);
      const json = JSON.stringify(res.body);
      for (const v of VALUES) expect(json).not.toContain(v);
      // the pre-existing fields are untouched (additive)
      expect(res.body.challengeCooldowns).toEqual([]);
      expect(res.body.browserPool).toEqual({ available: 2, capacity: 3, healthy: true });
      warn.mockRestore();
    });

    it('GET /health/detailed defaults cfCookies to [] when the store is disabled / empty', async () => {
      const res = await request(build()).get('/health/detailed');
      expect(res.status).toBe(200);
      expect(res.body.cfCookies).toEqual([]);
    });

    it('GET /health/detailed keeps cfCookies on the degraded (500) branch', async () => {
      const store = realStore();
      const res = await request(build({
        getBrowserPoolHealth: async () => { throw new Error('pool down'); },
        listCfCookies: () => store.view(),
      })).get('/health/detailed');
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('degraded');
      expect(res.body.cfCookies).toEqual([expect.objectContaining({ host: 'myfigurecollection.net', cookieNames: ['cf_clearance', 'PHPSESSID'], stale: false })]);
      for (const v of VALUES) expect(JSON.stringify(res.body)).not.toContain(v);
    });
  });
});

/**
 * RESIDENTIAL EGRESS view (contract 0.7.0): /health/detailed additively reports whether the engine
 * has a residential proxy configured, so an operator can tell "the cohort store is refused" from
 * "the proxy is down" without shelling into the pod. The proxy string is REDACTED to
 * scheme://host:port — RESIDENTIAL_PROXY_URL may legitimately carry `user:password@`, and this
 * endpoint is not an authenticated surface.
 */
describe('createHealthRoutes — residentialEgress', () => {
  it('GET /health/detailed reports configured:false when no residential proxy is set', async () => {
    const res = await request(build()).get('/health/detailed');
    expect(res.status).toBe(200);
    expect(res.body.residentialEgress).toEqual({ configured: false });
  });

  it('GET /health/detailed reports the configured proxy as scheme://host:port', async () => {
    const app = build({
      getResidentialEgress: () => ({ configured: true, proxy: 'socks5://egress-proxy.fc.svc.cluster.local:1055' }),
    });
    const res = await request(app).get('/health/detailed');
    expect(res.body.residentialEgress).toEqual({
      configured: true,
      proxy: 'socks5://egress-proxy.fc.svc.cluster.local:1055',
    });
  });

  it('never leaks credentials even when RESIDENTIAL_PROXY_URL carries user:pass (the view redacts at the source)', async () => {
    const { residentialEgressView } = require('../../services/residentialEgress') as typeof import('../../services/residentialEgress');
    const app = build({
      getResidentialEgress: () => residentialEgressView('socks5://tsuser:FAKE_PASS@egress-proxy.fc.svc.cluster.local:1055', { RESIDENTIAL_EGRESS_HEALTH_DETAIL: 'true' } as NodeJS.ProcessEnv),
    });

    const res = await request(app).get('/health/detailed');

    expect(res.body.residentialEgress).toEqual({
      configured: true,
      proxy: 'socks5://egress-proxy.fc.svc.cluster.local:1055',
    });
    expect(JSON.stringify(res.body)).not.toContain('FAKE_PASS');
    expect(JSON.stringify(res.body)).not.toContain('tsuser');
  });

  it('keeps the residentialEgress view on the degraded (500) response too', async () => {
    const app = build({
      getBrowserPoolHealth: async () => { throw new Error('pool down'); },
      getResidentialEgress: () => ({ configured: true, proxy: 'socks5://p.test:1055' }),
    });
    const res = await request(app).get('/health/detailed');
    expect(res.status).toBe(500);
    expect(res.body.residentialEgress).toEqual({ configured: true, proxy: 'socks5://p.test:1055' });
  });
});

/**
 * BROWSER LANE view: which launch profile this process actually uses, the timezone each egress
 * emulates, and how many challenge-gated contexts are being kept alive. All four are the difference
 * between "Cloudflare passes" and "Cloudflare never clears", and none of them are visible from
 * outside the pod otherwise.
 */
describe('createHealthRoutes — browserLane', () => {
  it('GET /health/detailed reports the launch mode, both egress timezones and the kept-context count', async () => {
    const app = build({
      getBrowserLane: () => ({
        launchMode: 'clean-headful',
        residentialTimezone: 'America/Chicago',
        directTimezone: 'America/New_York',
        persistentContexts: 2,
      }),
    });

    const res = await request(app).get('/health/detailed');

    expect(res.status).toBe(200);
    expect(res.body.browserLane).toEqual({
      launchMode: 'clean-headful',
      residentialTimezone: 'America/Chicago',
      directTimezone: 'America/New_York',
      persistentContexts: 2,
    });
  });

  it('reports nulls for timezones nobody configured', async () => {
    const res = await request(build()).get('/health/detailed');

    expect(res.body.browserLane).toEqual({
      launchMode: 'headless',
      residentialTimezone: null,
      directTimezone: null,
      persistentContexts: 0,
    });
  });

  it('keeps the browserLane view on the degraded (500) response too', async () => {
    const app = build({
      getBrowserPoolHealth: async () => { throw new Error('pool down'); },
      getBrowserLane: () => ({ launchMode: 'clean-headful', residentialTimezone: 'America/Chicago', directTimezone: null, persistentContexts: 1 }),
    });

    const res = await request(app).get('/health/detailed');

    expect(res.status).toBe(500);
    expect(res.body.browserLane.launchMode).toBe('clean-headful');
    expect(res.body.browserLane.persistentContexts).toBe(1);
  });
});

/** The view builder itself: it reads the same env the launch profile and the lane read. */
describe('browserLaneView', () => {
  const { browserLaneView } = require('../../services/genericScraper') as typeof import('../../services/genericScraper');

  it('reports the clean-headful profile and both configured zones', () => {
    expect(browserLaneView({
      BROWSER_LAUNCH_MODE: 'clean-headful',
      RESIDENTIAL_EGRESS_TIMEZONE: 'America/Chicago',
      DIRECT_EGRESS_TIMEZONE: 'America/New_York',
    } as NodeJS.ProcessEnv)).toEqual({
      launchMode: 'clean-headful',
      residentialTimezone: 'America/Chicago',
      directTimezone: 'America/New_York',
      persistentContexts: 0,
    });
  });

  it('reports the headless default with no zones configured', () => {
    expect(browserLaneView({} as NodeJS.ProcessEnv)).toEqual({
      launchMode: 'headless',
      residentialTimezone: null,
      directTimezone: null,
      persistentContexts: 0,
    });
  });
});
