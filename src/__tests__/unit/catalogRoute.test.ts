/**
 * GET /catalog route — parses store + page, calls the injected Catalog, maps its discriminated
 * result onto HTTP: 200 ok (minus `status`) / 400 bad input / 422 unsupported / 503 cooldown
 * (+ Retry-After) / 502 failed or thrown. Never a 500.
 */
import express from 'express';
import request from 'supertest';
import { createCatalogRoute } from '../../routes/catalog';
import type { Catalog, CatalogResult, IdRangeResult, SeedListsResult, SeedResult } from '../../driver/assembleCatalog';

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

const SEED_OK: SeedResult = {
  status: 'ok',
  siteId: 'examplestore',
  listId: 'new-arrivals',
  url: 'https://example.test/new',
  items: [{ itemId: '11', collectUrl: 'https://example.test/item/11' }],
  collectUrls: ['https://example.test/item/11'],
  hasMore: false,
  count: 1,
};

const SEEDS_OK: SeedListsResult = {
  status: 'ok',
  siteId: 'examplestore',
  seedLists: [{ id: 'new-arrivals', cadence: 'daily', note: 'front shelf' }, { id: 'staff-picks', cadence: 'weekly' }],
  count: 2,
};

const mk = (
  result: CatalogResult | (() => Promise<CatalogResult>) = OK,
  range: IdRangeResult | (() => IdRangeResult) = RANGE_OK,
  seed: SeedResult | (() => Promise<SeedResult>) = SEED_OK,
  seedLists: SeedListsResult | (() => SeedListsResult) = SEEDS_OK,
): Catalog => ({
  catalog: jest.fn(typeof result === 'function' ? result : async () => result),
  idRange: jest.fn(typeof range === 'function' ? range : () => range),
  seed: jest.fn(typeof seed === 'function' ? seed : async () => seed),
  seedLists: jest.fn(typeof seedLists === 'function' ? seedLists : () => seedLists),
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

describe('GET /catalog?seed= (declared seed list)', () => {
  it('200: passes store + listId to seed and returns its ok result minus `status`', async () => {
    const catalog = mk();
    const res = await request(appWith(catalog)).get('/catalog?store=examplestore&seed=new-arrivals');

    expect(res.status).toBe(200);
    const { status: _s, ...body } = SEED_OK;
    expect(res.body).toEqual(body);
    expect(res.body.hasMore).toBe(false);
    expect(catalog.seed).toHaveBeenCalledWith('examplestore', 'new-arrivals');
    expect(catalog.catalog).not.toHaveBeenCalled();
    expect(catalog.idRange).not.toHaveBeenCalled();
  });

  it('trims the listId, and store, before dispatching', async () => {
    const catalog = mk();
    await request(appWith(catalog)).get('/catalog?store=' + encodeURIComponent(' examplestore ') + '&seed=' + encodeURIComponent(' new-arrivals '));
    expect(catalog.seed).toHaveBeenCalledWith('examplestore', 'new-arrivals');
  });

  it('400 when seed is present but blank — a seed list is addressed by NAME, never by default', async () => {
    const catalog = mk();
    for (const q of ['', '%20%20']) {
      const res = await request(appWith(catalog)).get(`/catalog?store=examplestore&seed=${q}`);
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('seed');
    }
    expect(catalog.seed).not.toHaveBeenCalled();
  });

  it('400 when seed is combined with page or with range — the three axes are mutually exclusive', async () => {
    const catalog = mk();
    const withPage = await request(appWith(catalog)).get('/catalog?store=examplestore&seed=new-arrivals&page=2');
    expect(withPage.status).toBe(400);
    expect(withPage.body.error).toContain('seed');

    const withRange = await request(appWith(catalog)).get('/catalog?store=examplestore&seed=new-arrivals&range=1&from=5');
    expect(withRange.status).toBe(400);
    expect(withRange.body.error).toContain('seed');

    expect(catalog.seed).not.toHaveBeenCalled();
    expect(catalog.catalog).not.toHaveBeenCalled();
    expect(catalog.idRange).not.toHaveBeenCalled();
  });

  it('422 unsupported when the store declares no such seed list', async () => {
    const res = await request(appWith(mk(OK, RANGE_OK, { status: 'unsupported', siteId: 'examplestore', reason: 'store declares no seed list "nope"' })))
      .get('/catalog?store=examplestore&seed=nope');
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: 'unsupported', siteId: 'examplestore', reason: 'store declares no seed list "nope"' });
  });

  it('503 cooldown + Retry-After, and 502 failed', async () => {
    const cool = await request(appWith(mk(OK, RANGE_OK, { status: 'cooldown', siteId: 'examplestore', host: 'example.test', remainingMs: 90_001 })))
      .get('/catalog?store=examplestore&seed=new-arrivals');
    expect(cool.status).toBe(503);
    expect(cool.headers['retry-after']).toBe('91');
    expect(cool.body).toEqual({ error: 'cooldown', siteId: 'examplestore', host: 'example.test', remainingMs: 90_001 });

    const fail = await request(appWith(mk(OK, RANGE_OK, { status: 'failed', siteId: 'examplestore', reason: 'challenge page' })))
      .get('/catalog?store=examplestore&seed=new-arrivals');
    expect(fail.status).toBe(502);
    expect(fail.body).toEqual({ error: 'catalog failed', siteId: 'examplestore', reason: 'challenge page' });
  });

  it('502 (never 500) when seed throws, and for an unrecognised result status', async () => {
    const threw = await request(appWith(mk(OK, RANGE_OK, async () => { throw new Error('boom'); })))
      .get('/catalog?store=examplestore&seed=new-arrivals');
    expect(threw.status).toBe(502);
    expect(threw.body).toEqual({ error: 'catalog failed', siteId: 'examplestore', reason: 'boom' });

    const weird = { status: 'weird', siteId: 'examplestore' } as unknown as SeedResult;
    const res = await request(appWith(mk(OK, RANGE_OK, weird))).get('/catalog?store=examplestore&seed=new-arrivals');
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('catalog failed');
  });
});

describe('GET /catalog?seeds=1 (seed-list discovery)', () => {
  it('200: returns the store\'s declared lists, in declared order, minus `status`', async () => {
    const catalog = mk();
    const res = await request(appWith(catalog)).get('/catalog?store=examplestore&seeds=1');

    expect(res.status).toBe(200);
    const { status: _s, ...body } = SEEDS_OK;
    expect(res.body).toEqual(body);
    expect(res.body.seedLists.map((l: { id: string }) => l.id)).toEqual(['new-arrivals', 'staff-picks']);
    expect(catalog.seedLists).toHaveBeenCalledWith('examplestore');
  });

  it('400 when seeds is present but not `1`, or is combined with another axis', async () => {
    const catalog = mk();
    for (const v of ['0', 'true', '']) {
      const res = await request(appWith(catalog)).get(`/catalog?store=examplestore&seeds=${v}`);
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('seeds');
    }
    for (const extra of ['page=2', 'range=1&from=5', 'seed=new-arrivals']) {
      const res = await request(appWith(catalog)).get(`/catalog?store=examplestore&seeds=1&${extra}`);
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('seeds');
    }
    expect(catalog.seedLists).not.toHaveBeenCalled();
  });

  it('422 unsupported when the store declares no seed lists, and 502 (never 500) when it throws', async () => {
    const unsup = await request(appWith(mk(OK, RANGE_OK, SEED_OK, { status: 'unsupported', siteId: 'orzgk', reason: 'store declares no seed lists' })))
      .get('/catalog?store=orzgk&seeds=1');
    expect(unsup.status).toBe(422);
    expect(unsup.body).toEqual({ error: 'unsupported', siteId: 'orzgk', reason: 'store declares no seed lists' });

    const threw = await request(appWith(mk(OK, RANGE_OK, SEED_OK, () => { throw new Error('boom'); }))).get('/catalog?store=orzgk&seeds=1');
    expect(threw.status).toBe(502);
    expect(threw.body).toEqual({ error: 'catalog failed', siteId: 'orzgk', reason: 'boom' });

    const weird = { status: 'weird', siteId: 'orzgk' } as unknown as SeedListsResult;
    const odd = await request(appWith(mk(OK, RANGE_OK, SEED_OK, weird))).get('/catalog?store=orzgk&seeds=1');
    expect(odd.status).toBe(502);
    expect(odd.body.error).toBe('catalog failed');
  });
});
