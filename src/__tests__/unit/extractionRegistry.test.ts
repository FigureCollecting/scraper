import { createExtractionRegistry } from '../../services/extractionRegistry';
import { SiteConfig, StoreCapabilities, ExtractionRuleset, ExtractedData, ValidationResult } from '@figurecollecting/scraper-plugin-contract';

function buildSiteConfig(overrides: Partial<SiteConfig> = {}): SiteConfig {
  return {
    siteId: 'alpha',
    name: 'Alpha Site',
    domains: ['alpha.example.test', 'www.alpha.example.test'],
    rateLimit: {
      domain: 'alpha.example.test',
      baseDelayMs: 1000,
      minDelayMs: 500,
      maxDelayMs: 5000,
      backoffMultiplier: 1.5,
      recoveryDivisor: 1.5,
      successThreshold: 3,
    },
    requiresBrowser: false,
    allowedCookies: [],
    ...overrides,
  };
}

function buildRuleset(siteId: string): ExtractionRuleset {
  return {
    siteId,
    version: '1.0.0',
    extract(html: string, url: string): ExtractedData {
      return {
        source: { site: siteId, itemId: '1', url, extractedAt: new Date().toISOString(), rulesetVersion: '1.0.0' },
        fields: { html },
        warnings: [],
      };
    },
    validate(): ValidationResult {
      return { valid: true, errors: [], warnings: [] };
    },
  };
}

describe('ExtractionRegistry', () => {
  it('resolves a site config by exact hostname', () => {
    const registry = createExtractionRegistry();
    registry.registerSite(buildSiteConfig());

    const config = registry.getSiteConfigForUrl('https://alpha.example.test/item/1');
    expect(config?.siteId).toBe('alpha');
  });

  it('resolves a site config for a registered subdomain-style host', () => {
    const registry = createExtractionRegistry();
    registry.registerSite(buildSiteConfig());

    const config = registry.getSiteConfigForUrl('https://www.alpha.example.test/item/1');
    expect(config?.siteId).toBe('alpha');
  });

  it('matches hostnames case-insensitively', () => {
    const registry = createExtractionRegistry();
    registry.registerSite(buildSiteConfig());

    const config = registry.getSiteConfigForUrl('https://ALPHA.EXAMPLE.TEST/item/1');
    expect(config?.siteId).toBe('alpha');
  });

  it('returns undefined for an unregistered hostname', () => {
    const registry = createExtractionRegistry();
    registry.registerSite(buildSiteConfig());

    expect(registry.getSiteConfigForUrl('https://unregistered.example.test/item/1')).toBeUndefined();
  });

  it('resolves the ruleset registered for the same siteId as the matched hostname', async () => {
    const registry = createExtractionRegistry();
    registry.registerSite(buildSiteConfig());
    registry.registerRuleset(buildRuleset('alpha'));

    const ruleset = registry.getRulesetForUrl('https://alpha.example.test/item/42');
    expect(ruleset?.siteId).toBe('alpha');

    // extract() is async-capable (E1) — consumers always await the result.
    const extracted = await ruleset!.extract('<html></html>', 'https://alpha.example.test/item/42');
    expect(extracted.source.site).toBe('alpha');
  });

  it('returns undefined from getRulesetForUrl when no site matches the hostname', () => {
    const registry = createExtractionRegistry();
    expect(registry.getRulesetForUrl('https://nowhere.example.test/x')).toBeUndefined();
  });

  it('keeps sites isolated by domain — one registration does not leak into another', () => {
    const registry = createExtractionRegistry();
    registry.registerSite(buildSiteConfig({ siteId: 'alpha', domains: ['alpha.example.test'] }));
    registry.registerSite(
      buildSiteConfig({
        siteId: 'beta',
        domains: ['beta.example.test'],
        rateLimit: { ...buildSiteConfig().rateLimit, domain: 'beta.example.test' },
      })
    );
    registry.registerRuleset(buildRuleset('alpha'));
    registry.registerRuleset(buildRuleset('beta'));

    expect(registry.getSiteConfigForUrl('https://beta.example.test/x')?.siteId).toBe('beta');
    expect(registry.getRulesetForUrl('https://beta.example.test/x')?.siteId).toBe('beta');
    expect(registry.getSiteConfigForUrl('https://alpha.example.test/x')?.siteId).toBe('alpha');
  });

  it('throws a clear error for a malformed URL rather than crashing silently', () => {
    const registry = createExtractionRegistry();
    expect(() => registry.getSiteConfigForUrl('not-a-url')).toThrow();
  });
});

describe('ExtractionRegistry.allStores', () => {
  it('returns every registered store (the ProfileRegistry source — all of them, no subset)', () => {
    const registry = createExtractionRegistry();
    registry.registerSite(buildSiteConfig({ siteId: 'alpha', domains: ['alpha.example.test'] }));
    registry.registerSite(buildSiteConfig({ siteId: 'beta', domains: ['beta.example.test'] }));

    expect(registry.allStores().map((s) => s.siteId).sort()).toEqual(['alpha', 'beta']);
  });

  it('is empty before any registration', () => {
    expect(createExtractionRegistry().allStores()).toEqual([]);
  });

  it("preserves a store's retrieval axis so it rides through to the ProfileRegistry", () => {
    const registry = createExtractionRegistry();
    const caps: StoreCapabilities = {
      ...buildSiteConfig({ siteId: 'amiami', domains: ['amiami.com'] }),
      retrieval: { byId: { urlTemplate: 'https://amiami.com/detail/{id}' } },
    };
    registry.registerSite(caps);

    const stored = registry.allStores().find((s) => s.siteId === 'amiami');
    expect(stored?.retrieval?.byId?.urlTemplate).toBe('https://amiami.com/detail/{id}');
  });
});
