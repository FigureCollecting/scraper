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
 *     `residentialEgress: {configured, proxy?}` (the residential proxy, credentials stripped),
 *     `challengeCooldowns: [{host, remainingMs, reason}]` (the per-host CF cooldowns currently open)
 *     and `cfCookies: [{host, cookieNames, userAgentPinned, loadedAt, mintedAt?, expiresAt?, stale,
 *     staleSince?, staleReason?}]` (the stored-cookie jar's per-host view — cookie NAMES only, never a
 *     value; `stale` = the host still served a challenge with its stored cookies → re-mint).
 *     A browser-pool-health failure still degrades to 500, now carrying { status:'degraded',
 *     challengeCooldowns, cfCookies, error } — both lists survive (neither lister can throw).
 */
import { Router, type Request, type Response } from 'express';
import type { CooldownView } from '../services/challengeCooldown.js';
import type { CfCookieHostView } from '../services/cookieJar.js';

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
   * and, if so, its `scheme://host:port` — credentials are stripped at the source, since this
   * endpoint is unauthenticated and RESIDENTIAL_PROXY_URL may carry `user:password@`.
   */
  getResidentialEgress: () => { configured: boolean; proxy?: string };
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
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({
        ...healthResponse(),
        status: 'degraded',
        challengeCooldowns: deps.listChallengeCooldowns(),
        cfCookies: deps.listCfCookies(),
        residentialEgress: deps.getResidentialEgress(),
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
