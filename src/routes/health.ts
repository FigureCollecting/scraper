/**
 * Health routes — the service's liveness/health surface, extracted from index.ts as an injected
 * route factory (the same shape as createLookupRoute / createIngestRouter / createResolveRoute) so it
 * can be unit-tested without booting the server or the browser pool.
 *
 * Contract preserved exactly:
 *   - GET /         → { service, version, status:'healthy' }   (Docker health check)
 *   - GET /health   → same
 *   - GET /version  → { name, version, status:'ok' }
 *   - GET /health/detailed → the above + browserPool health + a timestamp, and ADDITIVELY
 *     `residentialEgress: {configured, proxy?}` (the residential proxy; its host:port only under
 *     RESIDENTIAL_EGRESS_HEALTH_DETAIL, credentials always stripped),
 *     `browserLane: {launchMode, residentialTimezone, directTimezone, processTimezone,
 *     navigationTimeoutMs, gatedBrowsers}`,
 *     `challengeCooldowns: [{host, remainingMs, reason}]` (the per-host CF cooldowns currently open),
 *     `rawStore: {configured, stats?}` (the raw-capture sink's counters — page + asset lanes,
 *     plus its admission queue: `queued`, `inFlight`, `dropped`, and the `queueWaitP50/P95` vs
 *     `putP50/P95` split that says whether a slow lane is a slow BUCKET or a backlog behind it),
 *     `imageCapture: {enabled, attempted, stored, deduped, skipped{…}, failed, residentialBytesToday}`
 *     (the image capture hook's counters — a best-effort lane that stores nothing looks exactly like
 *     an idle one from outside, so the NAMED skips are the signal: a deny list, an exhausted home
 *     line, or a CDN answering every plate with a block page each read differently here),
 *     `failureLedger: {enabled, reported, failed, suppressed}` (the durable fetch-failure ledger's
 *     reporting counters — a ledger nobody is writing to is otherwise invisible),
 *     `sessionCanary: {site, configured, stale, staleSince?, staleReason?}` plus the flat
 *     `mfcSessionStale` boolean it mirrors (the mfc scrape session's entitlement flag — a session
 *     that lost its NSFW entitlement shows up ONLY as 404s that look like missing items, so the
 *     operator needs it named; the flat form is what an alert rule keys on, and the canary item id
 *     is never exposed)
 *     and `cfCookies: [{host, cookieNames, userAgentPinned, loadedAt, mintedAt?, expiresAt?, stale,
 *     staleSince?, staleReason?}]` (the stored-cookie jar's per-host view — cookie NAMES only, never a
 *     value; `stale` = the host still served a challenge with its stored cookies → re-mint).
 *     A browser-pool-health failure still degrades to 500, now carrying { status:'degraded',
 *     challengeCooldowns, cfCookies, error } — both lists survive (neither lister can throw).
 */
import { Router, type Request, type Response } from 'express';
import type { CooldownView } from '../services/challengeCooldown.js';
import type { CfCookieHostView } from '../services/cookieJar.js';
import type { BrowserLaneView } from '../services/genericScraper.js';
import type { RawStoreView } from '../services/s3ObjectStore.js';
import type { FetchFailureReportView } from '../services/failureReporter.js';
import type { ImageCaptureStats } from '../services/images/imageCaptureHook.js';
import type { SessionCanaryView } from '../services/sessionCanary.js';

export interface HealthDeps {
  /** The service version (package.json). */
  version: string;
  /** Browser-pool health snapshot (BrowserPool.getHealth). Awaited; a throw → 500 degraded. */
  getBrowserPoolHealth: () => Promise<unknown>;
  /** Currently-open per-host challenge cooldowns (getChallengeCooldown().list()). */
  listChallengeCooldowns: () => CooldownView[];
  /** The stored-cookie jar's per-host view (getCfCookieStore().view()) — names and flags, never values. */
  listCfCookies: () => CfCookieHostView[];
  /**
   * The residential-egress view (residentialEgressView()): whether a residential proxy is configured
   * and — only under RESIDENTIAL_EGRESS_HEALTH_DETAIL — its `scheme://host:port`. This endpoint is
   * unauthenticated, so the egress ENDPOINT is opt-in, and credentials are stripped at the source
   * since RESIDENTIAL_PROXY_URL may carry `user:password@`.
   */
  getResidentialEgress: () => { configured: boolean; proxy?: string };
  /**
   * The browser lane's live configuration (browserLaneView()): the launch profile, the PROCESS
   * timezone (the one a Cloudflare challenge actually reads), the zone each egress emulates on top
   * of it, and the live per-egress challenge browsers. Pure config + counters — nothing secret.
   */
  getBrowserLane: () => BrowserLaneView;
  /**
   * The raw-capture sink's view (rawStoreView()): whether a sink was built at all and
   * its counters. These are the only signal that the capture lanes are working — an
   * asset lane whose every body is refused as notImage otherwise looks exactly like an
   * idle one. Counters only, nothing secret; the reader never throws.
   */
  getRawStore: () => RawStoreView;
  /**
   * The fetch-failure ledger's reporting counters (fetchFailureReportView()): whether reporting is
   * wired at all (INGEST_BASE_URL + the REPORT_FETCH_FAILURES kill switch), how many rows the spine
   * took, how many reports it never took, and how many cooldown skips were deliberately not
   * re-reported inside an open window. Pure counters — a silent ledger is otherwise invisible.
   */
  getFailureLedger: () => FetchFailureReportView;
  /**
   * The image capture hook's counters (imageCaptureView()): whether the lane is switched on at all
   * (PERSIST_RAW_IMAGES), how many originals it stored, and — the part that matters — WHY the rest
   * were not fetched. Image capture is deliberately best-effort and never fails an item, so an
   * operator has no other way to tell "no store publishes images" from "every image is being denied".
   * Counters only, nothing secret; the reader never throws.
   */
  getImageCapture: () => ImageCaptureStats;
  /**
   * The mfc session canary's flag (sessionCanaryView()): whether an entitlement canary is configured
   * and whether the last conclusive round showed the session had lost its entitlement (→ re-mint the
   * cookies). Flags and timestamps only — never the canary item id.
   */
  getSessionCanary: () => SessionCanaryView;
}

export function createHealthRoutes(deps: HealthDeps): Router {
  const router = Router();

  const healthResponse = () => ({ service: 'scraper', version: deps.version, status: 'healthy' });

  // Root endpoint for health checks (Docker health checks hit this)
  router.get('/', (_req: Request, res: Response) => {
    res.json(healthResponse());
  });

  router.get('/health', (_req: Request, res: Response) => {
    res.json(healthResponse());
  });

  // Detailed health endpoint with browser pool status + open challenge cooldowns + the stored-cookie
  // view (for debugging / the operator's re-mint signal)
  router.get('/health/detailed', async (_req: Request, res: Response) => {
    try {
      const browserPool = await deps.getBrowserPoolHealth();
      res.json({
        ...healthResponse(),
        browserPool,
        challengeCooldowns: deps.listChallengeCooldowns(),
        cfCookies: deps.listCfCookies(),
        residentialEgress: deps.getResidentialEgress(),
        browserLane: deps.getBrowserLane(),
        rawStore: deps.getRawStore(),
        imageCapture: deps.getImageCapture(),
        failureLedger: deps.getFailureLedger(),
        sessionCanary: deps.getSessionCanary(),
        mfcSessionStale: deps.getSessionCanary().stale,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({
        ...healthResponse(),
        status: 'degraded',
        challengeCooldowns: deps.listChallengeCooldowns(),
        cfCookies: deps.listCfCookies(),
        residentialEgress: deps.getResidentialEgress(),
        browserLane: deps.getBrowserLane(),
        rawStore: deps.getRawStore(),
        imageCapture: deps.getImageCapture(),
        failureLedger: deps.getFailureLedger(),
        sessionCanary: deps.getSessionCanary(),
        mfcSessionStale: deps.getSessionCanary().stale,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // Version endpoint
  router.get('/version', (_req: Request, res: Response) => {
    res.json({ name: 'scraper', version: deps.version, status: 'ok' });
  });

  return router;
}
