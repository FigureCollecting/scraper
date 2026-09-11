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
import type { ImageCaptureStats } from '../../services/images/imageCaptureHook';
import type { SinkStats } from '../../services/objectStoreCaptureSink';

const NO_IMAGE_CAPTURE: ImageCaptureStats = {
  enabled: false,
  reason: 'PERSIST_RAW_IMAGES is not true',
  attempted: 0,
  stored: 0,
  deduped: 0,
  skipped: { policyDeny: 0, memo: 0, thumbnailRole: 0, userRole: 0, cap: 0, residentialBudget: 0, notImage: 0, tooLarge: 0, refused: 0, unsupported: 0, inFlight: 0, sinkQueueFull: 0 },
  failed: 0,
  residentialBytesToday: 0,
};

const build = (over: Partial<HealthDeps> = {}) => {
  const app = express();
  app.use('/', createHealthRoutes({
    version: '9.9.9',
    getBrowserPoolHealth: async () => ({ available: 2, capacity: 3, healthy: true }),
    listChallengeCooldowns: () => [],
    listCfCookies: () => [],
    getResidentialEgress: () => ({ configured: false }),
    getBrowserLane: () => ({ launchMode: 'headless', residentialTimezone: null, directTimezone: null, processTimezone: null, navigationTimeoutMs: 20000, gatedBrowsers: [] }),
    getRawStore: () => ({ configured: false }),
    getFailureLedger: () => ({ enabled: false, reported: 0, failed: 0, suppressed: 0 }),
    getImageCapture: () => NO_IMAGE_CAPTURE,
    getSessionCanary: () => ({ site: 'mfc', configured: false, stale: false }),
    getCpuThrottling: () => ({ available: false }),
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
 * BROWSER LANE view: which launch profile this process actually uses, the PROCESS timezone (the one
 * the challenge actually reads), the zone each egress emulates, and the live per-egress challenge
 * browsers. Each is the difference between "Cloudflare passes" and "Cloudflare never clears", and
 * none of them is visible from outside the pod otherwise.
 */
describe('createHealthRoutes — browserLane', () => {
  it('GET /health/detailed reports the launch mode, the timezones and the live gated browsers', async () => {
    const app = build({
      getBrowserLane: () => ({
        launchMode: 'clean-headful',
        residentialTimezone: null,
        directTimezone: null,
        processTimezone: 'America/Chicago',
        navigationTimeoutMs: 20000,
        gatedBrowsers: [
          { egress: 'residential', launchedAt: '2026-09-07T12:00:00.000Z', pagesOpen: 1, primedHosts: 2, lastRelaunchAt: null, relaunchCount: 0, relaunchFailures: 0, drainedTabsAtRelaunch: 0, firstNavigationRetries: 0, firstNavigationRecoveries: 0, lastRelaunchReason: null, navFailureStreak: 0, rssMb: null },
          { egress: 'direct', launchedAt: '2026-09-07T12:05:00.000Z', pagesOpen: 0, primedHosts: 0, lastRelaunchAt: null, relaunchCount: 0, relaunchFailures: 0, drainedTabsAtRelaunch: 0, firstNavigationRetries: 0, firstNavigationRecoveries: 0, lastRelaunchReason: null, navFailureStreak: 0, rssMb: null },
        ],
      }),
    });

    const res = await request(app).get('/health/detailed');

    expect(res.status).toBe(200);
    expect(res.body.browserLane).toEqual({
      launchMode: 'clean-headful',
      residentialTimezone: null,
      directTimezone: null,
      processTimezone: 'America/Chicago',
      navigationTimeoutMs: 20000,
      gatedBrowsers: [
        { egress: 'residential', launchedAt: '2026-09-07T12:00:00.000Z', pagesOpen: 1, primedHosts: 2, lastRelaunchAt: null, relaunchCount: 0, relaunchFailures: 0, drainedTabsAtRelaunch: 0, firstNavigationRetries: 0, firstNavigationRecoveries: 0, lastRelaunchReason: null, navFailureStreak: 0, rssMb: null },
        { egress: 'direct', launchedAt: '2026-09-07T12:05:00.000Z', pagesOpen: 0, primedHosts: 0, lastRelaunchAt: null, relaunchCount: 0, relaunchFailures: 0, drainedTabsAtRelaunch: 0, firstNavigationRetries: 0, firstNavigationRecoveries: 0, lastRelaunchReason: null, navFailureStreak: 0, rssMb: null },
      ],
    });
  });

  it('reports nulls for timezones nobody configured, and no gated browsers before the first gated fetch', async () => {
    const res = await request(build()).get('/health/detailed');

    expect(res.body.browserLane).toEqual({
      launchMode: 'headless',
      residentialTimezone: null,
      directTimezone: null,
      processTimezone: null,
      navigationTimeoutMs: 20000,
      gatedBrowsers: [],
    });
  });

  it('keeps the browserLane view on the degraded (500) response too', async () => {
    const app = build({
      getBrowserPoolHealth: async () => { throw new Error('pool down'); },
      getBrowserLane: () => ({
        launchMode: 'clean-headful',
        residentialTimezone: 'America/Chicago',
        directTimezone: null,
        processTimezone: 'America/Chicago',
        navigationTimeoutMs: 20000,
        gatedBrowsers: [{ egress: 'residential', launchedAt: '2026-09-07T12:00:00.000Z', pagesOpen: 0, primedHosts: 1, lastRelaunchAt: null, relaunchCount: 0, relaunchFailures: 0, drainedTabsAtRelaunch: 0, firstNavigationRetries: 0, firstNavigationRecoveries: 0, lastRelaunchReason: null, navFailureStreak: 0, rssMb: null }],
      }),
    });

    const res = await request(app).get('/health/detailed');

    expect(res.status).toBe(500);
    expect(res.body.browserLane.launchMode).toBe('clean-headful');
    expect(res.body.browserLane.processTimezone).toBe('America/Chicago');
    expect(res.body.browserLane.gatedBrowsers).toHaveLength(1);
  });
});

/** The view builder itself: it reads the same env the launch profile and the lane read. */
describe('browserLaneView', () => {
  const { browserLaneView } = require('../../services/genericScraper') as typeof import('../../services/genericScraper');

  it('reports the clean-headful profile, the process zone and both configured zones', () => {
    expect(browserLaneView({
      BROWSER_LAUNCH_MODE: 'clean-headful',
      TZ: 'America/Chicago',
      RESIDENTIAL_EGRESS_TIMEZONE: 'America/Chicago',
      DIRECT_EGRESS_TIMEZONE: 'America/New_York',
    } as NodeJS.ProcessEnv)).toEqual({
      launchMode: 'clean-headful',
      residentialTimezone: 'America/Chicago',
      directTimezone: 'America/New_York',
      processTimezone: 'America/Chicago',
      navigationTimeoutMs: 20000,
      gatedBrowsers: [],
    });
  });

  /**
   * The deployment sets only TZ and leaves the emulation vars empty: the challenge reads the PROCESS
   * zone (a UTC process never clears, whatever the page emulates), so `processTimezone: null` is the
   * silent-failure the operator is looking for — nulls in the other two are the normal state.
   */
  it('reports the headless default with nothing configured', () => {
    expect(browserLaneView({} as NodeJS.ProcessEnv)).toEqual({
      launchMode: 'headless',
      residentialTimezone: null,
      directTimezone: null,
      processTimezone: null,
      navigationTimeoutMs: 20000,
      gatedBrowsers: [],
    });
  });
});

// The raw-capture sink's counters are the ONLY signal that the asset lane is
// working: a store that answers every image request with a challenge page shows up
// as assetSkipped.notImage and nothing else. They have to reach an ops surface.
describe('createHealthRoutes — rawStore counters', () => {
  // Typed, so the fixture cannot drift from the sink: a counter added to SinkStats must
  // reach this surface, and a counter this fixture invents must exist on the sink.
  const STATS: SinkStats = {
    stored: 12,
    deduped: 3,
    failed: 0,
    skippedDisabled: 0,
    assetStored: 40,
    assetDeduped: 7,
    assetSkipped: { notImage: 118, tooLarge: 1, empty: 0, disabled: 0 },
    assetFailed: 2,
    // The admission queue's view: a backlog and a drop count are what separate
    // "the bucket is slow" from "we are dropping captures on the floor".
    queued: 9,
    // …by lane, so "375 images parked behind pages" reads differently from "375 pages backed up".
    queuedPages: 6,
    queuedAssets: 3,
    inFlight: 4,
    dropped: 2,
    droppedBytes: 1,
    // The reservation's refusals, split by the budget that held the asset: a depth
    // problem and a payload problem want different settings raised.
    assetRefusedReserve: 7,
    assetRefusedReserveDepth: 4,
    assetRefusedReserveBytes: 3,
    queuedBytes: 3145728,
    queueWaitP50: 40,
    queueWaitP95: 900,
    putP50: 310,
    putP95: 1200,
    headP50: 90,
    headP95: 400,
    // What ENDED the slow ops, and whether this process was even on the CPU while it
    // timed them: a fat putP95 over a flat lag is the bucket, over a fat lag it is us.
    timedOut: 5,
    eventLoopLagP50: 2,
    eventLoopLagP95: 180,
    eventLoopLagMax: 3100,
  };

  it('publishes the sink counters on GET /health/detailed', async () => {
    const res = await request(build({ getRawStore: () => ({ configured: true, stats: STATS }) })).get('/health/detailed');
    expect(res.status).toBe(200);
    expect(res.body.rawStore).toEqual({ configured: true, stats: STATS });
    expect(res.body.rawStore.stats).toMatchObject({ queued: 9, queuedPages: 6, queuedAssets: 3 });
    // The two readings that make a slow putP95 diagnosable rather than merely visible.
    expect(res.body.rawStore.stats).toMatchObject({ timedOut: 5, eventLoopLagP50: 2, eventLoopLagP95: 180 });
    // The high-water mark specifically: a single 3.1 s stall that no percentile can show.
    expect(res.body.rawStore.stats).toMatchObject({ eventLoopLagMax: 3100 });
  });

  it('reports the unconfigured sink rather than omitting the block', async () => {
    const res = await request(build()).get('/health/detailed');
    expect(res.body.rawStore).toEqual({ configured: false });
  });

  it('keeps rawStore on the degraded (500) response', async () => {
    const app = build({
      getBrowserPoolHealth: async () => { throw new Error('pool down'); },
      getRawStore: () => ({ configured: true, stats: STATS }),
    });
    const res = await request(app).get('/health/detailed');
    expect(res.status).toBe(500);
    expect(res.body.rawStore).toEqual({ configured: true, stats: STATS });
  });
});

/**
 * FETCH-FAILURE LEDGER counters: whether the engine is reporting terminal fetch failures at all,
 * and how that reporting is going. A ledger nobody is writing to looks exactly like a healthy crawl
 * from outside the pod, which is the failure mode this block exists to make visible.
 */
describe('createHealthRoutes — failureLedger', () => {
  it('GET /health/detailed reports the ledger counters', async () => {
    const app = build({ getFailureLedger: () => ({ enabled: true, reported: 12, failed: 1, suppressed: 4 }) });

    const res = await request(app).get('/health/detailed');

    expect(res.status).toBe(200);
    expect(res.body.failureLedger).toEqual({ enabled: true, reported: 12, failed: 1, suppressed: 4 });
  });

  it('shows reporting OFF when no reporter was built', async () => {
    const res = await request(build()).get('/health/detailed');

    expect(res.body.failureLedger).toEqual({ enabled: false, reported: 0, failed: 0, suppressed: 0 });
  });

  it('keeps the counters on the degraded (500) response too', async () => {
    const app = build({
      getBrowserPoolHealth: async () => { throw new Error('pool down'); },
      getFailureLedger: () => ({ enabled: true, reported: 3, failed: 0, suppressed: 0 }),
    });

    const res = await request(app).get('/health/detailed');

    expect(res.status).toBe(500);
    expect(res.body.failureLedger).toEqual({ enabled: true, reported: 3, failed: 0, suppressed: 0 });
  });

  /**
   * The mfc session canary (owner rule, 2026-09-09). A stale scrape session shows up ONLY as 404s
   * that look like missing items, so the flag has to be visible somewhere an operator or the cookie
   * runbook can read it. It carries flags and timestamps, never the canary item id.
   */
  it('GET /health/detailed carries sessionCanary {site, configured, stale}', async () => {
    const app = build({ getSessionCanary: () => ({ site: 'mfc', configured: true, stale: false }) });
    const res = await request(app).get('/health/detailed');

    expect(res.status).toBe(200);
    expect(res.body.sessionCanary).toEqual({ site: 'mfc', configured: true, stale: false });
    expect(res.body.mfcSessionStale).toBe(false);   // the flat form an alert rule keys on
  });

  it('surfaces a STALE session with its reason and timestamp', async () => {
    const app = build({
      getSessionCanary: () => ({
        site: 'mfc',
        configured: true,
        stale: true,
        staleSince: '2026-09-09T04:34:00.000Z',
        staleReason: 'the NSFW canary item answered 404 while a SFW control was served',
      }),
    });
    const res = await request(app).get('/health/detailed');

    expect(res.body.sessionCanary.stale).toBe(true);
    expect(res.body.sessionCanary.staleSince).toBe('2026-09-09T04:34:00.000Z');
    expect(res.body.sessionCanary.staleReason).toContain('404');
    expect(res.body.mfcSessionStale).toBe(true);
  });

  it('keeps the session canary visible on the DEGRADED response (a stale session outlives a sick pool)', async () => {
    const app = build({
      getBrowserPoolHealth: async () => { throw new Error('pool down'); },
      getSessionCanary: () => ({ site: 'mfc', configured: true, stale: true }),
    });
    const res = await request(app).get('/health/detailed');

    expect(res.status).toBe(500);
    expect(res.body.status).toBe('degraded');
    expect(res.body.sessionCanary).toEqual({ site: 'mfc', configured: true, stale: true });
  });
});

/**
 * IMAGE CAPTURE counters. The lane is best-effort by design — it never fails an item — so its own
 * counters are the ONLY way to tell a store that publishes no images from one whose every plate is
 * being refused. The named skips carry that difference, and they have to survive the degraded
 * response too, since a browser pool that is down is exactly when an operator goes looking.
 */
describe('createHealthRoutes — imageCapture', () => {
  const busy: ImageCaptureStats = {
    enabled: true,
    attempted: 40,
    stored: 31,
    deduped: 4,
    skipped: { policyDeny: 2, memo: 9, thumbnailRole: 12, userRole: 3, cap: 1, residentialBudget: 5, notImage: 2, tooLarge: 1, refused: 4, unsupported: 1, inFlight: 7, sinkQueueFull: 6 },
    failed: 3,
    residentialBytesToday: 12_345,
  };

  it('GET /health/detailed reports the capture counters and every named skip', async () => {
    const res = await request(build({ getImageCapture: () => busy })).get('/health/detailed');

    expect(res.status).toBe(200);
    expect(res.body.imageCapture).toEqual(busy);
  });

  it('shows the lane OFF, and WHICH half of its configuration is missing', async () => {
    const res = await request(build()).get('/health/detailed');

    expect(res.body.imageCapture).toEqual(NO_IMAGE_CAPTURE);
    // The half that is missing is the whole point: `enabled: false` next to a switch an operator
    // can see is set to `true` is otherwise an hour of staring at a ConfigMap.
    expect(res.body.imageCapture.reason).toBe('PERSIST_RAW_IMAGES is not true');
  });

  it('keeps the counters on the degraded (500) response too', async () => {
    const app = build({
      getBrowserPoolHealth: async () => { throw new Error('pool down'); },
      getImageCapture: () => busy,
    });

    const res = await request(app).get('/health/detailed');

    expect(res.status).toBe(500);
    expect(res.body.imageCapture).toEqual(busy);
  });
});


/**
 * `cpuThrottling` — the kernel's own answer to "is this pod being given the CPU?".
 *
 * The sink's event-loop lag says this PROCESS was slow; only the cgroup counters say
 * whether that was the process's own doing or a quota stopping it. The two are read
 * together, so both have to reach the same surface.
 */
describe('createHealthRoutes — cpuThrottling', () => {
  const THROTTLED = { available: true, nrPeriods: 8102, nrThrottled: 941, throttledUsec: 20719353, readAt: '2026-09-10T18:00:00.000Z' };

  it('publishes the cgroup counters on GET /health/detailed', async () => {
    const res = await request(build({ getCpuThrottling: () => THROTTLED })).get('/health/detailed');
    expect(res.status).toBe(200);
    expect(res.body.cpuThrottling).toEqual(THROTTLED);
  });

  it('reports the absence of a cgroup rather than omitting the block', async () => {
    const res = await request(build()).get('/health/detailed');
    expect(res.body.cpuThrottling).toEqual({ available: false });
  });

  it('keeps cpuThrottling on the degraded (500) response', async () => {
    const app = build({
      getBrowserPoolHealth: async () => {
        throw new Error('pool down');
      },
      getCpuThrottling: () => THROTTLED,
    });
    const res = await request(app).get('/health/detailed');
    expect(res.status).toBe(500);
    // A pod that is being throttled is exactly the pod whose browser pool is failing,
    // so this reading has to survive the degraded response that reports it.
    expect(res.body.cpuThrottling).toEqual(THROTTLED);
  });
});
