/**
 * GET /catalog route — parses store + page, calls the injected Catalog, maps its discriminated
 * result onto HTTP: 200 ok (minus `status`) / 400 bad input / 422 unsupported / 503 cooldown
 * (+ Retry-After) / 502 failed or thrown. Never a 500.
 */
import express from 'express';
import request from 'supertest';
import { createCatalogRoute } from '../../routes/catalog';
import type { Catalog, CatalogResult, IdRangeResult } from '../../driver/assembleCatalog';

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

const RANGE_OK: IdRangeResult = {
  status: 'ok',
  siteId: 'mfc',
  from: 3630000,
  items: [{ itemId: '3630000', collectUrl: 'https://myfigurecollection.net/item/3630000' }],
  collectUrls: ['https://myfigurecollection.net/item/3630000'],
  hasMore: true,
  nextFrom: 3629999,
  count: 1,
};

const mk = (result: CatalogResult | (() => Promise<CatalogResult>) = OK, range: IdRangeResult | (() => IdRangeResult) = RANGE_OK): Catalog => ({
  catalog: jest.fn(typeof result === 'function' ? result : async () => result),
  idRange: jest.fn(typeof range === 'function' ? range : () => range),
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

describe('GET /catalog?range=1 (id-range window)', () => {
  it('200: passes store, from and count to idRange and returns its ok result minus `status`', async () => {
    const catalog = mk();
    const res = await request(appWith(catalog)).get('/catalog?store=mfc&range=1&from=3630000&count=25');

    expect(res.status).toBe(200);
    const { status: _s, ...body } = RANGE_OK;
    expect(res.body).toEqual(body);
    expect(catalog.idRange).toHaveBeenCalledWith('mfc', 3630000, 25);
    expect(catalog.catalog).not.toHaveBeenCalled();
  });

  it('count absent → undefined (the runtime applies its default)', async () => {
    const catalog = mk();
    await request(appWith(catalog)).get('/catalog?store=mfc&range=1&from=42');
    expect(catalog.idRange).toHaveBeenCalledWith('mfc', 42, undefined);
  });

  it('400 when range is present but not `1`', async () => {
    const catalog = mk();
    for (const r of ['0', 'true', 'yes', '']) {
      const res = await request(appWith(catalog)).get(`/catalog?store=mfc&range=${r}&from=1`);
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('range');
    }
    expect(catalog.idRange).not.toHaveBeenCalled();
  });

  it('400 when `from` is missing, or present but not a positive integer', async () => {
    const catalog = mk();
    const res = await request(appWith(catalog)).get('/catalog?store=mfc&range=1');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('from');
    for (const f of ['0', '-1', '1.5', 'abc', '', '1e3']) {
      const bad = await request(appWith(catalog)).get(`/catalog?store=mfc&range=1&from=${f}`);
      expect(bad.status).toBe(400);
      expect(bad.body.error).toContain('from');
    }
    expect(catalog.idRange).not.toHaveBeenCalled();
  });

  it('400 when `count` is present but not a positive integer, and when `page` is combined with `range`', async () => {
    const catalog = mk();
    const badCount = await request(appWith(catalog)).get('/catalog?store=mfc&range=1&from=10&count=0');
    expect(badCount.status).toBe(400);
    expect(badCount.body.error).toContain('count');

    const both = await request(appWith(catalog)).get('/catalog?store=mfc&range=1&from=10&page=2');
    expect(both.status).toBe(400);
    expect(both.body.error).toContain('range');
    expect(catalog.idRange).not.toHaveBeenCalled();
  });

  it('`from` without `range` is ignored — the listing path still runs', async () => {
    const catalog = mk();
    const res = await request(appWith(catalog)).get('/catalog?store=orzgk&page=1&from=99');
    expect(res.status).toBe(200);
    expect(catalog.catalog).toHaveBeenCalledWith('orzgk', 1);
    expect(catalog.idRange).not.toHaveBeenCalled();
  });

  it('422 unsupported / 502 failed / 502 (never 500) when idRange throws', async () => {
    const unsup = await request(appWith(mk(OK, { status: 'unsupported', siteId: 'orzgk', reason: 'store declares no byRange axis' })))
      .get('/catalog?store=orzgk&range=1&from=5');
    expect(unsup.status).toBe(422);
    expect(unsup.body).toEqual({ error: 'unsupported', siteId: 'orzgk', reason: 'store declares no byRange axis' });

    const fail = await request(appWith(mk(OK, { status: 'failed', siteId: 'mfc', reason: 'invalid from' }))).get('/catalog?store=mfc&range=1&from=5');
    expect(fail.status).toBe(502);
    expect(fail.body).toEqual({ error: 'catalog failed', siteId: 'mfc', reason: 'invalid from' });

    const threw = await request(appWith(mk(OK, () => { throw new Error('boom'); }))).get('/catalog?store=mfc&range=1&from=5');
    expect(threw.status).toBe(502);
    expect(threw.body).toEqual({ error: 'catalog failed', siteId: 'mfc', reason: 'boom' });
  });

  it('503 cooldown + Retry-After — the crawler must skip the store, not walk its id space into a challenge', async () => {
    const res = await request(appWith(mk(OK, { status: 'cooldown', siteId: 'mfc', host: 'myfigurecollection.net', remainingMs: 90_001 })))
      .get('/catalog?store=mfc&range=1&from=5');
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('91');
    expect(res.body).toEqual({ error: 'cooldown', siteId: 'mfc', host: 'myfigurecollection.net', remainingMs: 90_001 });
  });
});
