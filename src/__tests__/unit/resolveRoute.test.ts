/**
 * POST /resolve route — parses { site, ids }, calls the injected Resolve, returns the result;
 * 400 on missing/empty, 502 on throw.
 */
import express from 'express';
import request from 'supertest';
import { createResolveRoute } from '../../routes/resolve';
import type { Resolve, ResolveResult } from '../../driver/assembleResolve';

const result = (over: Partial<ResolveResult> = {}): ResolveResult => ({
  site: 'amiami', results: [], unsupported: false, failed: [], ...over,
});

const appWith = (resolve: Resolve) => {
  const app = express();
  app.use(express.json());
  app.use('/', createResolveRoute(resolve));
  return app;
};

describe('POST /resolve', () => {
  it('parses { site, ids } and returns the resolve result', async () => {
    const resolve: Resolve = {
      resolve: jest.fn(async (site, ids) => result({ site, results: ids.map((itemId) => ({ itemId, url: `u/${itemId}` })) })),
    };

    const res = await request(appWith(resolve)).post('/resolve').send({ site: 'amiami', ids: ['FIGURE-1', 'FIGURE-2'] });

    expect(res.status).toBe(200);
    expect(res.body.site).toBe('amiami');
    expect(res.body.results.map((r: { itemId: string }) => r.itemId)).toEqual(['FIGURE-1', 'FIGURE-2']);
    expect(resolve.resolve).toHaveBeenCalledWith('amiami', ['FIGURE-1', 'FIGURE-2']);
  });

  it('trims + drops non-string ids', async () => {
    const resolve: Resolve = { resolve: jest.fn(async () => result()) };
    await request(appWith(resolve)).post('/resolve').send({ site: 'amiami', ids: [' FIGURE-1 ', 3, '', 'FIGURE-2'] });
    expect(resolve.resolve).toHaveBeenCalledWith('amiami', ['FIGURE-1', 'FIGURE-2']);
  });

  it('400 when site or ids are missing/empty', async () => {
    const resolve: Resolve = { resolve: jest.fn() };
    expect((await request(appWith(resolve)).post('/resolve').send({ ids: ['x'] })).status).toBe(400);
    expect((await request(appWith(resolve)).post('/resolve').send({ site: 'amiami' })).status).toBe(400);
    expect((await request(appWith(resolve)).post('/resolve').send({ site: 'amiami', ids: [] })).status).toBe(400);
    expect((await request(appWith(resolve)).post('/resolve').send({ site: 'amiami', ids: [' ', 3] })).status).toBe(400);
    expect(resolve.resolve).not.toHaveBeenCalled();
  });

  it('400 when ids exceeds the per-call cap (pool protection)', async () => {
    const resolve: Resolve = { resolve: jest.fn() };
    const ids = Array.from({ length: 26 }, (_, i) => `FIGURE-${i}`);
    const res = await request(appWith(resolve)).post('/resolve').send({ site: 'amiami', ids });
    expect(res.status).toBe(400);
    expect(resolve.resolve).not.toHaveBeenCalled();
  });

  it('502 when resolve throws', async () => {
    const resolve: Resolve = { resolve: jest.fn(async () => { throw new Error('pool dead'); }) };
    const res = await request(appWith(resolve)).post('/resolve').send({ site: 'amiami', ids: ['x'] });
    expect(res.status).toBe(502);
    expect(res.body.detail).toBe('pool dead');
  });
});
