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
 *     `browserLane: {launchMode, residentialTimezone, directTimezone, processTimezone, gatedBrowsers}`,
 *     `challengeCooldowns: [{host, remainingMs, reason}]` (the per-host CF cooldowns currently open)
 *     `rawStore: {configured, stats?}` (the raw-capture sink's counters — page + asset lanes)
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
