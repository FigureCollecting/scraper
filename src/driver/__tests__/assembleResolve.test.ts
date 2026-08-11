/**
 * assembleResolve — byId CONFIRM: fetch each id's detail page + run the store ruleset's extract() →
 * full ExtractedData (incl fields.gtin14). Returns the data, never emits. Fakes model the fetch +
 * ruleset so the composition (resolveByIdUrl → fetchDetail → extract, per-id failure isolation) is
 * deterministic.
 */
import { assembleResolve, type ResolveServices } from '../assembleResolve';
import { buildProfileRegistry } from '../profileRegistry';
import type { ExtractedData, ExtractionRuleset, RetrievalCapability, StoreCapabilities } from '@figurecollecting/scraper-plugin-contract';

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

  it('an id with no matching ruleset is failed (not fetched)', async () => {
    const fetchDetail = jest.fn(async () => ({ html: 'x' }));
    const out = await assembleResolve({ profiles: buildProfileRegistry([AMIAMI]), getRulesetForUrl: () => undefined, fetchDetail })
      .resolve('amiami', ['x']);

    expect(out.failed).toEqual(['x']);
    expect(out.results).toEqual([]);
    expect(fetchDetail).not.toHaveBeenCalled();
  });
});
