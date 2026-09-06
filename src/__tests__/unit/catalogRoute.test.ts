/**
 * GET /catalog route — parses store + page, calls the injected Catalog, maps its discriminated
 * result onto HTTP: 200 ok (minus `status`) / 400 bad input / 422 unsupported / 503 cooldown
 * (+ Retry-After) / 502 failed or thrown. Never a 500.
 */
import express from 'express';
import request from 'supertest';
import { createCatalogRoute } from '../../routes/catalog';
import type { Catalog, CatalogResult } from '../../driver/assembleCatalog';

const OK: CatalogResult = {
  status: 'ok',
  siteId: 'orzgk',
  page: 1,
  url: 'https://www.orzgk.com/wp-json/wc/store/v1/products?orderby=date&order=desc&per_page=100&page=1',
  items: [{ itemId: '68064530', collectUrl: 'https://www.orzgk.com/wp-json/wc/store/v1/products/68064530' }],
  collectUrls: ['https://www.orzgk.com/wp-json/wc/store/v1/products/68064530'],
  hasMore: true,
  nextPage: 2,
  count: 1,
};

const appWith = (catalog: Catalog) => {
  const app = express();
  app.use('/', createCatalogRoute(catalog));
  return app;
};

const mk = (result: CatalogResult | (() => Promise<CatalogResult>) = OK): Catalog => ({
  catalog: jest.fn(typeof result === 'function' ? result : async () => result),
});

describe('GET /catalog', () => {
  it('200: returns the ok result minus `status`, passing store + page through', async () => {
    const catalog = mk();
    const res = await request(appWith(catalog)).get('/catalog?store=orzgk&page=1');

    expect(res.status).toBe(200);
    const { status: _s, ...body } = OK;
    expect(res.body).toEqual(body);
    expect(res.body.status).toBeUndefined();
    expect(catalog.catalog).toHaveBeenCalledWith('orzgk', 1);
  });

  it('page absent → undefined (the runtime applies the store\'s pageStart); store is trimmed', async () => {
    const catalog = mk();
    await request(appWith(catalog)).get('/catalog?store=' + encodeURIComponent(' orzgk '));
    expect(catalog.catalog).toHaveBeenCalledWith('orzgk', undefined);
  });

  it('a large page number is passed as a number', async () => {
    const catalog = mk();
    await request(appWith(catalog)).get('/catalog?store=goodsmileus&page=409');
    expect(catalog.catalog).toHaveBeenCalledWith('goodsmileus', 409);
  });

  it('400 when store is missing or blank', async () => {
    const catalog = mk();
    for (const q of ['', '?store=', '?store=%20%20', '?page=1']) {
      const res = await request(appWith(catalog)).get('/catalog' + q);
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('store');
    }
    expect(catalog.catalog).not.toHaveBeenCalled();
  });

  it('400 when page is present but not a positive integer', async () => {
    const catalog = mk();
    for (const p of ['0', '-1', '1.5', 'abc', '', '%20', '1e3', '2&page=3', '0x10', '99999999999999999999']) {
      const res = await request(appWith(catalog)).get(`/catalog?store=orzgk&page=${p}`);
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('page');
    }
    expect(catalog.catalog).not.toHaveBeenCalled();
  });

  it('422 unsupported → { error, siteId, reason }', async () => {
    const res = await request(appWith(mk({ status: 'unsupported', siteId: 'cdjapan', reason: 'no byListing axis' }))).get('/catalog?store=cdjapan');
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: 'unsupported', siteId: 'cdjapan', reason: 'no byListing axis' });
  });

  it('503 cooldown → Retry-After = ceil(remainingMs / 1000) + { error, siteId, host, remainingMs }', async () => {
    const res = await request(appWith(mk({ status: 'cooldown', siteId: 'orzgk', host: 'orzgk.com', remainingMs: 90_001 }))).get('/catalog?store=orzgk');
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('91');
    expect(res.body).toEqual({ error: 'cooldown', siteId: 'orzgk', host: 'orzgk.com', remainingMs: 90_001 });
  });

  it('502 failed → { error: "catalog failed", siteId, reason }', async () => {
    const res = await request(appWith(mk({ status: 'failed', siteId: 'orzgk', reason: 'challenge page' }))).get('/catalog?store=orzgk');
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'catalog failed', siteId: 'orzgk', reason: 'challenge page' });
  });

  it('502 (never 500) when the catalog throws — Error and non-Error alike', async () => {
    const err = await request(appWith(mk(async () => { throw new Error('CF wall'); }))).get('/catalog?store=orzgk');
    expect(err.status).toBe(502);
    expect(err.body).toEqual({ error: 'catalog failed', siteId: 'orzgk', reason: 'CF wall' });

    const str = await request(appWith(mk(async () => { throw 'boom-string'; }))).get('/catalog?store=orzgk');
    expect(str.status).toBe(502);
    expect(str.body.reason).toBe('boom-string');
  });

  it('502 for an unrecognised result status (defensive: an unknown shape is a failure, not a hang or a 500)', async () => {
    const weird = { status: 'weird', siteId: 'orzgk' } as unknown as CatalogResult;
    const res = await request(appWith(mk(weird))).get('/catalog?store=orzgk');
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('catalog failed');
  });
});
