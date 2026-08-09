/**
 * GET /lookup route — parses q + mode, calls the injected Lookup, returns the result envelope.
 */
import express from 'express';
import request from 'supertest';
import { createLookupRoute } from '../../routes/lookup';
import type { Lookup, LookupResult } from '../../driver/assembleLookup';

const result = (over: Partial<LookupResult> = {}): LookupResult => ({
  query: 'tomie', mode: 'listed', results: [], unsupported: [], orderableOnly: [], failed: [], ...over,
});

const appWith = (lookup: Lookup) => {
  const app = express();
  app.use('/', createLookupRoute(lookup));
  return app;
};

describe('GET /lookup', () => {
  it('returns the lookup result and passes q + mode through', async () => {
    const lookup: Lookup = { lookup: jest.fn(async (q, opts) => result({ query: q, mode: opts?.mode ?? 'listed' })) };

    const res = await request(appWith(lookup)).get('/lookup?q=tomie&mode=orderable');

    expect(res.status).toBe(200);
    expect(res.body.query).toBe('tomie');
    expect(res.body.mode).toBe('orderable');
    expect(lookup.lookup).toHaveBeenCalledWith('tomie', { mode: 'orderable' });
  });

  it('defaults mode to listed', async () => {
    const lookup: Lookup = { lookup: jest.fn(async () => result()) };
    await request(appWith(lookup)).get('/lookup?q=tomie');
    expect(lookup.lookup).toHaveBeenCalledWith('tomie', { mode: 'listed' });
  });

  it('400 when q is missing or blank', async () => {
    const lookup: Lookup = { lookup: jest.fn() };
    expect((await request(appWith(lookup)).get('/lookup')).status).toBe(400);
    expect((await request(appWith(lookup)).get('/lookup?q=%20')).status).toBe(400);
    expect(lookup.lookup).not.toHaveBeenCalled();
  });

  it('502 when the lookup throws (Error and non-Error alike)', async () => {
    const errLookup: Lookup = { lookup: jest.fn(async () => { throw new Error('CF wall'); }) };
    const errRes = await request(appWith(errLookup)).get('/lookup?q=tomie');
    expect(errRes.status).toBe(502);
    expect(errRes.body.error).toBe('lookup failed');
    expect(errRes.body.detail).toBe('CF wall');

    const strLookup: Lookup = { lookup: jest.fn(async () => { throw 'boom-string'; }) };
    const strRes = await request(appWith(strLookup)).get('/lookup?q=tomie');
    expect(strRes.status).toBe(502);
    expect(strRes.body.detail).toBe('boom-string');
  });
});
