/**
 * POST /resolve route — parses { site, ids }, calls the injected Resolve, returns the result;
 * 400 on missing/empty, 502 on throw.
 */
import express from 'express';
import request from 'supertest';
import { createResolveRoute } from '../../routes/resolve';
import { createEngineResolve } from '../../services/engineResolve';
import type { LookupRegistry } from '../../services/engineLookup';
import type { Resolve, ResolveResult } from '../../driver/assembleResolve';
import type {
  ExtractContext,
  ExtractedData,
  ExtractionRuleset,
  StoreCapabilities,
} from '@figurecollecting/scraper-plugin-contract';

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

/**
 * Full route → engine chain (createResolveRoute over createEngineResolve): extraction must
 * dispatch through extractRecords (extractMany > extractAsync > extract), same as the ingest
 * path. Pins the prod bug: POST /resolve {site:'amiami', ids:[...]} returned fields {} + a
 * "use extractAsync()" warning because the resolve leg called bare extract().
 */
describe('POST /resolve — engine-wired extraction dispatch', () => {
  const AMIAMI: StoreCapabilities = {
    siteId: 'amiami', name: 'AmiAmi', domains: ['amiami.com'], requiresBrowser: false, allowedCookies: [],
    rateLimit: { domain: 'amiami.com', baseDelayMs: 0, minDelayMs: 0, maxDelayMs: 100, backoffMultiplier: 2, recoveryDivisor: 2, successThreshold: 3 },
    retrieval: { byId: { urlTemplate: 'https://www.amiami.com/eng/detail/?gcode={id}', idKind: 'store-internal' } },
    searchFetch: { transport: 'impersonate', browser: 'chrome142' },
  };

  const record = (itemId: string, fields: Record<string, unknown>, warnings: string[] = []): ExtractedData => ({
    source: { site: 'amiami', itemId, extractedAt: '2026-08-25T00:00:00.000Z' },
    fields,
    warnings,
  });

  const engineApp = (ruleset: ExtractionRuleset) => {
    const registry: LookupRegistry = { allStores: () => [AMIAMI], getRulesetForUrl: () => ruleset };
    const scraping = {
      scrapePage: jest.fn(async () => ({ html: '<page/>', url: '', title: '', statusCode: 200 })),
      scrapePageStealth: jest.fn(async () => ({ html: '<page/>', url: '', title: '', statusCode: 200 })),
    };
    const resolve = createEngineResolve(
      registry,
      jest.fn(async () => ({ html: '<div id="__nuxt"></div>', statusCode: 200 })),
      { scraping, sink: { capture: jest.fn(async () => undefined) }, now: () => 1_000_000, sleep: jest.fn(async () => undefined) },
    );
    return appWith(resolve);
  };

  it('an async-only store (amiami) confirms with POPULATED fields — no Nuxt warning, no empty bag', async () => {
    const ruleset: ExtractionRuleset & {
      extractAsync?: (html: string, url: string, ctx?: ExtractContext) => Promise<ExtractedData>;
    } = {
      siteId: 'amiami',
      version: '1.0.0',
      extract: () => record('FIGURE-190355-R', {}, ['AmiAmi product pages render client-side (Nuxt) — use extractAsync() so the item API is used']),
      extractAsync: async () => record('FIGURE-190355-R', { name: 'Gyaru Tomie x Hello Kitty', jan: '4570232591424' }),
      validate: () => ({ valid: true, errors: [], warnings: [] }),
    };

    const res = await request(engineApp(ruleset)).post('/resolve').send({ site: 'amiami', ids: ['FIGURE-190355-R'] });

    expect(res.status).toBe(200);
    expect(res.body.failed).toEqual([]);
    expect(res.body.results[0].data.fields).toEqual({ name: 'Gyaru Tomie x Hello Kitty', jan: '4570232591424' });
    expect(res.body.results[0].data.warnings).toEqual([]);
    // Single record → today's response shape exactly: no additive records field.
    expect('records' in res.body.results[0]).toBe(false);
  });

  it('an extractMany store returns data=record[0] plus the additive records[] through the route JSON', async () => {
    const parent = record('LISTING-9', { name: 'GK Statue' });
    const edition = record('LISTING-9__a', { name: 'GK Statue — 1/4', editionOf: 'LISTING-9' });
    const ruleset: ExtractionRuleset = {
      siteId: 'amiami',
      version: '1.0.0',
      extract: () => record('LISTING-9', { name: 'WRONG — extractMany must win' }),
      extractMany: () => [parent, edition],
      validate: () => ({ valid: true, errors: [], warnings: [] }),
    };

    const res = await request(engineApp(ruleset)).post('/resolve').send({ site: 'amiami', ids: ['LISTING-9'] });

    expect(res.status).toBe(200);
    expect(res.body.results[0].data.fields.name).toBe('GK Statue');
    expect(res.body.results[0].records).toEqual([edition]);
  });
});
