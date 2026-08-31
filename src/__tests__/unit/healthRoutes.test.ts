/**
 * createHealthRoutes — the service health surface, extracted from index.ts so it is testable without
 * booting the server. Contract preserved: GET / , GET /health , GET /version (unchanged), and GET
 * /health/detailed now ADDITIVELY carries `challengeCooldowns: [{host, remainingMs, reason}]` beside
 * the existing browserPool block. Deps (version / browser-pool health / cooldown list) are injected.
 */
import express from 'express';
import request from 'supertest';
import { createHealthRoutes, type HealthDeps } from '../../routes/health';

const build = (over: Partial<HealthDeps> = {}) => {
  const app = express();
  app.use('/', createHealthRoutes({
    version: '9.9.9',
    getBrowserPoolHealth: async () => ({ available: 2, capacity: 3, healthy: true }),
    listChallengeCooldowns: () => [],
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
      listChallengeCooldowns: () => [{ host: 'anitoysgk.com', remainingMs: 1_740_000, reason: 'search challenge page' }],
    });

    const res = await request(app).get('/health/detailed');

    expect(res.status).toBe(200);
    expect(res.body.service).toBe('scraper');
    expect(res.body.status).toBe('healthy');
    expect(res.body.browserPool).toEqual({ available: 2, capacity: 3, healthy: true });
    expect(res.body.challengeCooldowns).toEqual([
      { host: 'anitoysgk.com', remainingMs: 1_740_000, reason: 'search challenge page' },
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
});
