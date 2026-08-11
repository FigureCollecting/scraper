/**
 * createEngineResolve — builds a Resolve from the engine registry (allStores → ProfileRegistry) + a
 * detail fetch, and byId-confirms an id into full ExtractedData.
 */
import { createEngineResolve } from '../../services/engineResolve';
import type { LookupRegistry } from '../../services/engineLookup';
import type { ExtractionRuleset, StoreCapabilities } from '@figurecollecting/scraper-plugin-contract';

const STORE: StoreCapabilities = {
  siteId: 'amiami', name: 'AmiAmi', domains: ['api.amiami.com'], requiresBrowser: false, allowedCookies: [],
  rateLimit: { domain: 'api.amiami.com', baseDelayMs: 0, minDelayMs: 0, maxDelayMs: 100, backoffMultiplier: 2, recoveryDivisor: 2, successThreshold: 3 },
  retrieval: { byId: { urlTemplate: 'https://www.amiami.com/eng/detail/?gcode={id}', idKind: 'store-internal' } },
};

const RULESET: ExtractionRuleset = {
  siteId: 'amiami', version: '1.0.0',
  extract: () => ({ source: { site: 'amiami', itemId: 'x', extractedAt: '2026-08-11T00:00:00.000Z' }, fields: { gtin14: '04570232591424' }, warnings: [] }),
  validate: () => ({ valid: true, errors: [], warnings: [] }),
};

describe('createEngineResolve', () => {
  it('builds a Resolve from the registry that byId-confirms via the injected fetchDetail', async () => {
    const registry: LookupRegistry = { allStores: () => [STORE], getRulesetForUrl: () => RULESET };
    const fetchDetail = jest.fn(async () => ({ html: '<html/>', statusCode: 200 }));

    const out = await createEngineResolve(registry, fetchDetail).resolve('amiami', ['FIGURE-206235']);

    expect(fetchDetail).toHaveBeenCalledWith('https://www.amiami.com/eng/detail/?gcode=FIGURE-206235');
    expect(out.unsupported).toBe(false);
    expect(out.results[0]?.data?.fields.gtin14).toBe('04570232591424');
  });
});
