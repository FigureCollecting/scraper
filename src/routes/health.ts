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
 *     `challengeCooldowns: [{host, remainingMs, reason}]` (the per-host CF cooldowns currently open).
 *     A browser-pool-health failure still degrades to 500, now carrying { status:'degraded',
 *     challengeCooldowns, error } — the cooldown list survives (listChallengeCooldowns cannot throw).
 */
import { Router, type Request, type Response } from 'express';
import type { CooldownView } from '../services/challengeCooldown.js';

export interface HealthDeps {
  /** The service version (package.json). */
  version: string;
  /** Browser-pool health snapshot (BrowserPool.getHealth). Awaited; a throw → 500 degraded. */
  getBrowserPoolHealth: () => Promise<unknown>;
  /** Currently-open per-host challenge cooldowns (getChallengeCooldown().list()). */
  listChallengeCooldowns: () => CooldownView[];
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

  // Detailed health endpoint with browser pool status + open challenge cooldowns (for debugging)
  router.get('/health/detailed', async (_req: Request, res: Response) => {
    try {
      const browserPool = await deps.getBrowserPoolHealth();
      res.json({
        ...healthResponse(),
        browserPool,
        challengeCooldowns: deps.listChallengeCooldowns(),
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({
        ...healthResponse(),
        status: 'degraded',
        challengeCooldowns: deps.listChallengeCooldowns(),
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
