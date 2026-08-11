/**
 * GET /lookup route — parses q + mode, calls the injected Lookup, returns the result envelope.
 */
import express from 'express';
import request from 'supertest';
import { createLookupRoute } from '../../routes/lookup';
import type { Lookup, LookupResult } from '../../driver/assembleLookup';

const result = (over: Partial<LookupResult> = {}): LookupResult => ({
  query: 'tomie', mode: 'listed', results: [], unsupported: [], orderableOnly: [], failed: [], resolveTargets: [], ...over,
});

const appWith = (lookup: Lookup) => {
  const app = express();
  app.use(express.json());
  app.use('/', createLookupRoute(lookup));
  return app;
};

const mkLookup = (over: Partial<Lookup> = {}): Lookup => ({
  lookup: jest.fn(async () => result()),
  lookupByIdentity: jest.fn(async () => result()),
  ...over,
});

describe('GET /lookup (discovery)', () => {
  it('returns the lookup result and passes q + mode through', async () => {
    const lookup = mkLookup({ lookup: jest.fn(async (q, opts) => result({ query: q, mode: opts?.mode ?? 'listed' })) });

    const res = await request(appWith(lookup)).get('/lookup?q=tomie&mode=orderable');

    expect(res.status).toBe(200);
    expect(res.body.query).toBe('tomie');
    expect(res.body.mode).toBe('orderable');
    expect(lookup.lookup).toHaveBeenCalledWith('tomie', { mode: 'orderable' });
  });

  it('defaults mode to listed', async () => {
    const lookup = mkLookup();
    await request(appWith(lookup)).get('/lookup?q=tomie');
    expect(lookup.lookup).toHaveBeenCalledWith('tomie', { mode: 'listed' });
  });

  it('400 when q is missing or blank', async () => {
    const lookup = mkLookup();
    expect((await request(appWith(lookup)).get('/lookup')).status).toBe(400);
    expect((await request(appWith(lookup)).get('/lookup?q=%20')).status).toBe(400);
    expect(lookup.lookup).not.toHaveBeenCalled();
  });

  it('502 when the lookup throws (Error and non-Error alike)', async () => {
    const errLookup = mkLookup({ lookup: jest.fn(async () => { throw new Error('CF wall'); }) });
    const errRes = await request(appWith(errLookup)).get('/lookup?q=tomie');
    expect(errRes.status).toBe(502);
    expect(errRes.body.error).toBe('lookup failed');
    expect(errRes.body.detail).toBe('CF wall');

    const strLookup = mkLookup({ lookup: jest.fn(async () => { throw 'boom-string'; }) });
    const strRes = await request(appWith(strLookup)).get('/lookup?q=tomie');
    expect(strRes.status).toBe(502);
    expect(strRes.body.detail).toBe('boom-string');
  });
});

describe('POST /lookup (record-mode)', () => {
  it('parses the IdentityQuery body + mode and calls lookupByIdentity', async () => {
    const lookup = mkLookup({
      lookupByIdentity: jest.fn(async (id, opts) => result({ query: id.gtin14 ?? '', mode: opts?.mode ?? 'listed' })),
    });

    const res = await request(appWith(lookup)).post('/lookup').send({ gtin14: '4570232591424', name: 'Tomie', mode: 'orderable' });

    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('orderable');
    expect(lookup.lookupByIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ gtin14: '4570232591424', name: 'Tomie' }),
      { mode: 'orderable' },
    );
  });

  it('coerces a numeric gtin14 (JSON number) to a string instead of dropping it', async () => {
    const lookup = mkLookup({ lookupByIdentity: jest.fn(async () => result()) });
    const res = await request(appWith(lookup)).post('/lookup').send({ gtin14: 4570232591424, name: 'Tomie' });
    expect(res.status).toBe(200);
    expect(lookup.lookupByIdentity).toHaveBeenCalledWith(expect.objectContaining({ gtin14: '4570232591424' }), expect.anything());
  });

  it('400 when no usable key (scale/figureType alone, or studio without character/series)', async () => {
    const lookup = mkLookup();
    expect((await request(appWith(lookup)).post('/lookup').send({ scale: '1/7' })).status).toBe(400);
    expect((await request(appWith(lookup)).post('/lookup').send({ studio: 'GSC' })).status).toBe(400); // manufacturer alone too broad
    expect(lookup.lookupByIdentity).not.toHaveBeenCalled();
  });

  it('accepts studio paired with character or series', async () => {
    const lookup = mkLookup();
    const res = await request(appWith(lookup)).post('/lookup').send({ studio: 'GSC', character: 'Reze' });
    expect(res.status).toBe(200);
    expect(lookup.lookupByIdentity).toHaveBeenCalledWith(expect.objectContaining({ studio: 'GSC', character: 'Reze' }), expect.anything());
  });

  it('502 when lookupByIdentity throws', async () => {
    const lookup = mkLookup({ lookupByIdentity: jest.fn(async () => { throw new Error('boom'); }) });
    const res = await request(appWith(lookup)).post('/lookup').send({ name: 'Tomie' });
    expect(res.status).toBe(502);
    expect(res.body.detail).toBe('boom');
  });
});
