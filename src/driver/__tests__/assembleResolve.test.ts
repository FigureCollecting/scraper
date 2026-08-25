/**
 * assembleResolve — byId CONFIRM: fetch each id's detail page + run the store ruleset's extract() →
 * full ExtractedData (incl fields.gtin14). Returns the data, never emits. Fakes model the fetch +
 * ruleset so the composition (resolveByIdUrl → fetchDetail → extract, per-id failure isolation) is
 * deterministic.
 */
import { assembleResolve, type ResolveServices } from '../assembleResolve';
import { buildProfileRegistry } from '../profileRegistry';
import type { ExtractContext, ExtractedData, ExtractionRuleset, RetrievalCapability, StoreCapabilities } from '@figurecollecting/scraper-plugin-contract';

const caps = (siteId: string, host: string, retrieval?: RetrievalCapability): StoreCapabilities => ({
  siteId, name: siteId, domains: [host], requiresBrowser: false, allowedCookies: [],
  rateLimit: { domain: host, baseDelayMs: 0, minDelayMs: 0, maxDelayMs: 100, backoffMultiplier: 2, recoveryDivisor: 2, successThreshold: 3 },
  retrieval,
});

const extracted = (gtin14: string): ExtractedData => ({
  source: { site: 'amiami', itemId: 'x', extractedAt: '2026-08-11T00:00:00.000Z' },
  fields: { gtin14, name: 'Gyaru Tomie x Hello Kitty' },
  warnings: [],
});

const stub = (extract: ExtractionRuleset['extract']): ExtractionRuleset => ({
  siteId: 'amiami', version: '1.0.0', extract, validate: () => ({ valid: true, errors: [], warnings: [] }),
});

const AMIAMI = caps('amiami', 'api.amiami.com', { byId: { urlTemplate: 'https://www.amiami.com/eng/detail/?gcode={id}', idKind: 'store-internal' } });

describe('assembleResolve — byId confirm', () => {
  it('fetches each id detail + extracts full ExtractedData (incl fields.gtin14)', async () => {
    const fetchDetail = jest.fn(async (url: string) => ({ html: `<html>${url}</html>`, statusCode: 200 }));
    const services: ResolveServices = {
      profiles: buildProfileRegistry([AMIAMI]),
      getRulesetForUrl: () => stub(() => extracted('04570232591424')),
      fetchDetail,
    };

    const out = await assembleResolve(services).resolve('amiami', ['FIGURE-206235']);

    expect(fetchDetail).toHaveBeenCalledWith('https://www.amiami.com/eng/detail/?gcode=FIGURE-206235');
    expect(out.unsupported).toBe(false);
    expect(out.results[0]?.itemId).toBe('FIGURE-206235');
    expect(out.results[0]?.url).toBe('https://www.amiami.com/eng/detail/?gcode=FIGURE-206235');
    expect(out.results[0]?.data?.fields.gtin14).toBe('04570232591424');
    expect(out.results[0]?.gtin14).toBe('04570232591424'); // surfaced for the matcher
    expect(out.failed).toEqual([]);
  });

  it('gates on HTTP status — a 4xx/5xx detail page is a failure, not an empty "confirm"', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    // A CF challenge / 404 page returns a body a contract-compliant extract() parses to empty fields
    // WITHOUT throwing — so without the status gate it would land in results with no gtin14.
    const fetchDetail = jest.fn(async () => ({ html: '<html>Just a moment...</html>', statusCode: 403 }));
    const out = await assembleResolve({
      profiles: buildProfileRegistry([AMIAMI]),
      getRulesetForUrl: () => stub(() => ({ source: { site: 'amiami', itemId: 'x', extractedAt: 'z' }, fields: {}, warnings: ['empty'] })),
      fetchDetail,
    }).resolve('amiami', ['FIGURE-1']);

    expect(out.results).toEqual([]);
    expect(out.failed).toEqual(['FIGURE-1']);
    warn.mockRestore();
  });

  it('a 200 confirm with no barcode surfaces gtin14: undefined (confirmed-but-unanchored, not a failure)', async () => {
    const out = await assembleResolve({
      profiles: buildProfileRegistry([AMIAMI]),
      getRulesetForUrl: () => stub(() => ({ source: { site: 'amiami', itemId: 'x', extractedAt: 'z' }, fields: { name: 'WLOP Statue' }, warnings: [] })),
      fetchDetail: jest.fn(async () => ({ html: 'ok', statusCode: 200 })),
    }).resolve('amiami', ['STATUE-1']);

    expect(out.results[0]?.gtin14).toBeUndefined();
    expect(out.results[0]?.data?.fields.name).toBe('WLOP Statue'); // still a real confirm
    expect(out.failed).toEqual([]);
  });

  it('a site with no byId axis is unsupported — nothing fetched', async () => {
    const noById = caps('shopify', 'shopify.com', { bySearch: { urlTemplate: 'https://x/s?q={q}' } });
    const fetchDetail = jest.fn(async () => ({ html: 'x' }));
    const out = await assembleResolve({ profiles: buildProfileRegistry([noById]), getRulesetForUrl: () => stub(() => extracted('1')), fetchDetail })
      .resolve('shopify', ['h1']);

    expect(out.unsupported).toBe(true);
    expect(out.results).toEqual([]);
    expect(fetchDetail).not.toHaveBeenCalled();
  });

  it('an id whose fetch/extract throws is reported failed; the rest still resolve', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchDetail = jest.fn(async (url: string) => {
      if (url.includes('BAD')) throw new Error('CF wall');
      return { html: 'ok' };
    });
    const services: ResolveServices = {
      profiles: buildProfileRegistry([AMIAMI]),
      getRulesetForUrl: () => stub(() => extracted('123')),
      fetchDetail,
    };

    const out = await assembleResolve(services).resolve('amiami', ['GOOD', 'BAD']);

    expect(out.results.map((r) => r.itemId)).toEqual(['GOOD']);
    expect(out.failed).toEqual(['BAD']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('BAD'));
    warn.mockRestore();
  });

  it('processes ids SEQUENTIALLY — the next id\'s detail fetch waits for the previous id to finish (no same-host burst)', async () => {
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => { releaseFirst = r; });
    const fetchDetail = jest.fn(async (url: string) => {
      if (url.includes('ID-1')) await gate;
      return { html: 'ok', statusCode: 200 };
    });

    const pending = assembleResolve({
      profiles: buildProfileRegistry([AMIAMI]),
      getRulesetForUrl: () => stub(() => extracted('1')),
      fetchDetail,
    }).resolve('amiami', ['ID-1', 'ID-2']);

    await new Promise((r) => setImmediate(r));
    // Only ID-1's fetch may be in flight — a Promise.all fan-out would have fired both already.
    expect(fetchDetail).toHaveBeenCalledTimes(1);

    releaseFirst();
    const out = await pending;
    expect(fetchDetail).toHaveBeenCalledTimes(2);
    expect(out.results.map((r) => r.itemId)).toEqual(['ID-1', 'ID-2']);
  });

  it('courtesy-gaps sibling ids\' SAME-HOST primary fetches by the store\'s baseDelayMs (H1 parity), on the injected clock', async () => {
    const store: StoreCapabilities = {
      ...caps('amiami', 'amiami.com', { byId: { urlTemplate: 'https://www.amiami.com/eng/detail/?gcode={id}', idKind: 'store-internal' } }),
      rateLimit: { domain: 'amiami.com', baseDelayMs: 3000, minDelayMs: 500, maxDelayMs: 10000, backoffMultiplier: 2, recoveryDivisor: 2, successThreshold: 3 },
    };
    let clock = 1_000_000;
    const now = jest.fn(() => clock);
    const sleep = jest.fn(async (ms: number) => { clock += ms; });
    const fetchedAt: number[] = [];
    const fetchDetail = jest.fn(async () => { fetchedAt.push(now()); return { html: 'ok', statusCode: 200 }; });

    const out = await assembleResolve({
      profiles: buildProfileRegistry([store]),
      getRulesetForUrl: () => stub(() => extracted('1')),
      fetchDetail,
      now,
      sleep,
    }).resolve('amiami', ['A-1', 'A-2']);

    expect(out.failed).toEqual([]);
    expect(sleep).toHaveBeenCalledWith(3000);
    // The per-host floor held: the second primary dispatched >= baseDelayMs after the first.
    expect(fetchedAt[1]! - fetchedAt[0]!).toBeGreaterThanOrEqual(3000);
  });

  it('paces with REAL time when no clock/sleep are injected (the default now/sleep path) — the same-host gap is measurable', async () => {
    const store: StoreCapabilities = {
      ...caps('amiami', 'amiami.com', { byId: { urlTemplate: 'https://www.amiami.com/eng/detail/?gcode={id}', idKind: 'store-internal' } }),
      rateLimit: { domain: 'amiami.com', baseDelayMs: 25, minDelayMs: 0, maxDelayMs: 100, backoffMultiplier: 2, recoveryDivisor: 2, successThreshold: 3 },
    };
    const fetchedAt: number[] = [];
    const fetchDetail = jest.fn(async () => { fetchedAt.push(Date.now()); return { html: 'ok', statusCode: 200 }; });

    const out = await assembleResolve({
      profiles: buildProfileRegistry([store]),
      getRulesetForUrl: () => stub(() => extracted('1')),
      fetchDetail,
    }).resolve('amiami', ['R-1', 'R-2']);

    expect(out.failed).toEqual([]);
    // Real setTimeout floor — allow scheduler slack, but the ~25ms courtesy gap must be visible.
    expect(fetchedAt[1]! - fetchedAt[0]!).toBeGreaterThanOrEqual(20);
  });

  it('a throw from URL building / ruleset lookup fails THAT id only — siblings still resolve (no batch poisoning)', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    // getRulesetForUrl deliberately propagates new URL() throws (extractionRegistry), and
    // resolveByIdUrl's encodeURIComponent throws URIError on a lone-surrogate id — either must
    // land in failed[] through the per-id isolation, not reject the whole resolve() batch.
    const out = await assembleResolve({
      profiles: buildProfileRegistry([AMIAMI]),
      getRulesetForUrl: (url) => {
        if (url.includes('BOOM')) throw new Error('Invalid URL');
        return stub(() => extracted('123'));
      },
      fetchDetail: jest.fn(async () => ({ html: 'ok', statusCode: 200 })),
    }).resolve('amiami', ['GOOD', 'BOOM']);

    expect(out.results.map((r) => r.itemId)).toEqual(['GOOD']);
    expect(out.failed).toEqual(['BOOM']);
    warn.mockRestore();
  });

  it('an id with no matching ruleset is failed (not fetched)', async () => {
    const fetchDetail = jest.fn(async () => ({ html: 'x' }));
    const out = await assembleResolve({ profiles: buildProfileRegistry([AMIAMI]), getRulesetForUrl: () => undefined, fetchDetail })
      .resolve('amiami', ['x']);

    expect(out.failed).toEqual(['x']);
    expect(out.results).toEqual([]);
    expect(fetchDetail).not.toHaveBeenCalled();
  });
});

/**
 * Extraction dispatch parity with the ingest path (extractRecords: extractMany > extractAsync >
 * extract). The prod bug this pins: /resolve called bare extract(), so async-only stores (amiami)
 * confirmed with EMPTY fields + a "use extractAsync()" warning while the ingest path resolved the
 * same page fully.
 */
describe('assembleResolve — extraction dispatch parity (extractRecords)', () => {
  type AsyncCapableRuleset = ExtractionRuleset & {
    extractAsync?: (html: string, url: string, ctx?: ExtractContext) => Promise<ExtractedData>;
  };

  const record = (itemId: string, fields: Record<string, unknown>, warnings: string[] = []): ExtractedData => ({
    source: { site: 'amiami', itemId, extractedAt: '2026-08-25T00:00:00.000Z' },
    fields,
    warnings,
  });

  it('dispatches an async-only ruleset via extractAsync — fields POPULATED, not bare extract()\'s empty bag', async () => {
    // Mirrors prod amiami: extract() cannot parse the client-rendered page; extractAsync can.
    const ruleset: AsyncCapableRuleset = {
      siteId: 'amiami',
      version: '1.0.0',
      extract: () => record('FIGURE-190355-R', {}, ['AmiAmi product pages render client-side (Nuxt) — use extractAsync() so the item API is used']),
      extractAsync: async () => record('FIGURE-190355-R', { name: 'Gyaru Tomie x Hello Kitty', jan: '4570232591424' }),
      validate: () => ({ valid: true, errors: [], warnings: [] }),
    };

    const out = await assembleResolve({
      profiles: buildProfileRegistry([AMIAMI]),
      getRulesetForUrl: () => ruleset,
      fetchDetail: jest.fn(async () => ({ html: '<div id="__nuxt"></div>', statusCode: 200 })),
    }).resolve('amiami', ['FIGURE-190355-R']);

    expect(out.failed).toEqual([]);
    expect(out.results[0]?.data?.fields).toEqual({ name: 'Gyaru Tomie x Hello Kitty', jan: '4570232591424' });
    expect(out.results[0]?.data?.warnings).toEqual([]);
  });

  it('extractMany: data = record[0] (the listing) and the additive records[] carries the children', async () => {
    const parent = record('LISTING-1', { name: 'GK Statue', gtin14: '04570232591424' });
    const editionA = record('LISTING-1__a', { name: 'GK Statue — 1/4', editionOf: 'LISTING-1' });
    const editionB = record('LISTING-1__b', { name: 'GK Statue — 1/6', editionOf: 'LISTING-1' });
    const ruleset: ExtractionRuleset = {
      siteId: 'amiami',
      version: '1.0.0',
      extract: () => record('LISTING-1', { name: 'WRONG — extractMany must win' }),
      extractMany: () => [parent, editionA, editionB],
      validate: () => ({ valid: true, errors: [], warnings: [] }),
    };

    const out = await assembleResolve({
      profiles: buildProfileRegistry([AMIAMI]),
      getRulesetForUrl: () => ruleset,
      fetchDetail: jest.fn(async () => ({ html: '<html/>', statusCode: 200 })),
    }).resolve('amiami', ['LISTING-1']);

    expect(out.failed).toEqual([]);
    expect(out.results[0]?.data).toEqual(parent);
    expect(out.results[0]?.gtin14).toBe('04570232591424');
    expect(out.results[0]?.records).toEqual([editionA, editionB]);
  });

  it('threads the resolveContext seam: ctx built per id (ruleset, url, primaryFetchedAt=now(), shared host map) and handed to the extraction', async () => {
    const ctx = { marker: 'built-by-buildExtractContext' } as unknown as ExtractContext;
    const resolveContext = jest.fn(() => ctx);
    const extract = jest.fn(() => record('FIGURE-1', { name: 'x' }));
    const ruleset: ExtractionRuleset = {
      siteId: 'amiami', version: '1.0.0', extract, validate: () => ({ valid: true, errors: [], warnings: [] }),
    };

    const out = await assembleResolve({
      profiles: buildProfileRegistry([AMIAMI]),
      getRulesetForUrl: () => ruleset,
      fetchDetail: jest.fn(async () => ({ html: '<html/>', statusCode: 200 })),
      resolveContext,
      now: () => 777_000,
    }).resolve('amiami', ['FIGURE-1']);

    expect(out.failed).toEqual([]);
    expect(resolveContext).toHaveBeenCalledWith(ruleset, 'https://www.amiami.com/eng/detail/?gcode=FIGURE-1', 777_000, expect.any(Map));
    expect(extract).toHaveBeenCalledWith('<html/>', 'https://www.amiami.com/eng/detail/?gcode=FIGURE-1', ctx);
  });

  it('a single-record ruleset keeps today\'s response shape exactly — NO records field', async () => {
    const out = await assembleResolve({
      profiles: buildProfileRegistry([AMIAMI]),
      getRulesetForUrl: () => stub(() => extracted('04570232591424')),
      fetchDetail: jest.fn(async () => ({ html: '<html/>', statusCode: 200 })),
    }).resolve('amiami', ['FIGURE-1']);

    expect(out.results[0]?.data?.fields.gtin14).toBe('04570232591424');
    expect(out.results[0] && 'records' in out.results[0]).toBe(false);
  });

  it('a D11 guard violation (duplicate itemIds from extractMany) fails THAT id only — others still resolve', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const good = record('GOOD', { name: 'ok' });
    const dup = record('BAD', { name: 'dup' });
    const ruleset: ExtractionRuleset = {
      siteId: 'amiami',
      version: '1.0.0',
      extract: () => good,
      extractMany: (_html, url) => (url.includes('BAD') ? [dup, dup] : [good]),
      validate: () => ({ valid: true, errors: [], warnings: [] }),
    };

    const out = await assembleResolve({
      profiles: buildProfileRegistry([AMIAMI]),
      getRulesetForUrl: () => ruleset,
      fetchDetail: jest.fn(async () => ({ html: '<html/>', statusCode: 200 })),
    }).resolve('amiami', ['GOOD', 'BAD']);

    expect(out.results.map((r) => r.itemId)).toEqual(['GOOD']);
    expect(out.failed).toEqual(['BAD']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('duplicate source.itemId'));
    warn.mockRestore();
  });
});
