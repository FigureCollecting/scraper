/**
 * One plugin's registrations, all or nothing (ExtractionRegistryImpl.beginRegistration). Plugin
 * contract 0.17.0 made registry calls refusable (a hands-off policy or a robots classifier can be
 * refused), so bootstrapPlugins stages each plugin's calls and commits them only when the plugin has
 * loaded: a refused policy must never leave the plugin's sites live without it.
 */
import { createExtractionRegistry } from '../../services/extractionRegistry';
import type {
  AiBarSummary,
  ExtractionRuleset,
  HandsOffPolicy,
  RobotsClassifier,
  SiteConfig,
} from '@figurecollecting/scraper-plugin-contract';

const SUMMARY: AiBarSummary = {
  tier: 'FULL_BAR',
  namedTokens: ['examplebot'],
  fullBarTokens: ['examplebot'],
  routeBarTokens: [],
  crawlDelayTokens: [],
  contentSignals: [],
};

function policy(over: Partial<HandsOffPolicy> = {}): HandsOffPolicy {
  return {
    siteId: 'alpha',
    hosts: ['alpha.example.test'],
    handsOff: true,
    tier: 'FULL_BAR',
    summary: SUMMARY,
    pins: [],
    routeSamples: [],
    policyVersion: 'policy-test',
    ...over,
  };
}

function site(siteId: string, domain: string): SiteConfig {
  return {
    siteId,
    name: siteId,
    domains: [domain],
    rateLimit: { domain, baseDelayMs: 1000, minDelayMs: 500, maxDelayMs: 5000, backoffMultiplier: 1.5, recoveryDivisor: 1.5, successThreshold: 3 },
    requiresBrowser: false,
    allowedCookies: [],
    requiredCookies: ['session'],
  };
}

const ruleset = (siteId: string): ExtractionRuleset => ({ siteId, version: '1', extract: () => ({}) }) as unknown as ExtractionRuleset;
const classifier = (tokenListDate = '2026-09-29'): RobotsClassifier => ({ tokenListDate, classify: () => SUMMARY });

/** Everything a plugin's registrations can make visible, in one comparable value. */
function visible(registry: ReturnType<typeof createExtractionRegistry>) {
  return {
    sites: registry.allStores().map(s => s.siteId),
    siteForAlpha: registry.getSiteConfigForUrl('https://www.alpha.example.test/item/1')?.siteId,
    rulesetForAlpha: registry.getRulesetForUrl('https://www.alpha.example.test/item/1')?.siteId,
    policies: registry.handsOffView().map(v => v.siteId),
    classifier: registry.robotsClassifier()?.tokenListDate,
    requiredCookies: registry.requiredCookiesFor('alpha.example.test'),
  };
}
const NOTHING = { sites: [], siteForAlpha: undefined, rulesetForAlpha: undefined, policies: [], classifier: undefined, requiredCookies: undefined };

describe('ExtractionRegistry.beginRegistration — staged until commit', () => {
  it('keeps every staged call invisible until commit, then applies all of them', () => {
    const registry = createExtractionRegistry();
    const registration = registry.beginRegistration();

    registration.registerSite(site('alpha', 'alpha.example.test'));
    registration.registerRuleset(ruleset('alpha'));
    registration.registerHandsOffPolicy(policy());
    registration.registerRobotsClassifier(classifier());

    expect(visible(registry)).toEqual(NOTHING);

    registration.commit();

    expect(visible(registry)).toEqual({
      sites: ['alpha'],
      siteForAlpha: 'alpha',
      rulesetForAlpha: 'alpha',
      policies: ['alpha'],
      classifier: '2026-09-29',
      requiredCookies: ['session'],
    });
  });

  it('keeps the call order for repeated site and ruleset registrations (the last one wins, as before)', () => {
    const registry = createExtractionRegistry();
    const registration = registry.beginRegistration();
    const first = ruleset('alpha');
    const second = ruleset('alpha');

    registration.registerSite({ ...site('alpha', 'alpha.example.test'), name: 'first' });
    registration.registerSite({ ...site('alpha', 'alpha.example.test'), name: 'second' });
    registration.registerRuleset(first);
    registration.registerRuleset(second);
    registration.commit();

    expect(registry.getSiteConfigForUrl('https://alpha.example.test/')?.name).toBe('second');
    expect(registry.getRulesetForUrl('https://alpha.example.test/')).toBe(second);
  });

  it('commits nothing when discarded: sites and policies staged before a refused call are dropped with it', () => {
    const registry = createExtractionRegistry();
    const registration = registry.beginRegistration();

    registration.registerSite(site('alpha', 'alpha.example.test'));
    registration.registerRuleset(ruleset('alpha'));
    registration.registerHandsOffPolicy(policy({ siteId: 'other', hosts: ['other.example.test'], handsOff: false }));
    registration.registerRobotsClassifier(classifier());
    expect(() => registration.registerHandsOffPolicy(policy({ siteId: 'typo', hosts: ['alpha.example.test:443'] }))).toThrow(
      'hands-off policy "typo": "alpha.example.test:443" is not a DNS hostname'
    );
    registration.discard();

    expect(visible(registry)).toEqual(NOTHING);
    expect(registry.handsOffPolicyFor('https://other.example.test/')).toBeUndefined();
  });

  it('refuses at commit a plugin that caught a refused call and carried on, applying nothing', () => {
    const registry = createExtractionRegistry();
    const registration = registry.beginRegistration();

    registration.registerSite(site('alpha', 'alpha.example.test'));
    try {
      registration.registerHandsOffPolicy(policy({ handsOff: 'yes' as unknown as boolean }));
    } catch {
      // the plugin swallows the refusal and goes on registering
    }
    registration.registerRuleset(ruleset('alpha'));

    expect(() => registration.commit()).toThrow(
      /^plugin registration refused: a registry call threw during register\(\) \(hands-off policy "alpha": handsOff must be a boolean/
    );
    expect(visible(registry)).toEqual(NOTHING);
  });

  it('keeps the refused call as the cause of the commit error, and the first refusal when there are several', () => {
    const registry = createExtractionRegistry();
    const registration = registry.beginRegistration();
    let firstRefusal: unknown;

    try {
      registration.registerHandsOffPolicy(policy({ hosts: [] }));
    } catch (error) {
      firstRefusal = error;
    }
    expect(() => registration.registerRobotsClassifier({ tokenListDate: 'x' } as unknown as RobotsClassifier)).toThrow(/classify/);

    let commitError: Error | undefined;
    try {
      registration.commit();
    } catch (error) {
      commitError = error as Error;
    }
    expect(commitError?.cause).toBe(firstRefusal);
  });

  it('describes a refusal that is not an Error (a getter on the plugin\'s config can throw anything)', () => {
    const registry = createExtractionRegistry();
    const registration = registry.beginRegistration();
    const hostile = { siteId: 'odd', name: 'odd', get domains(): string[] { throw 'domains unreadable'; } } as unknown as SiteConfig;

    expect(() => registration.registerSite(hostile)).toThrow('domains unreadable');
    expect(() => registration.commit()).toThrow('plugin registration refused: a registry call threw during register() (domains unreadable)');
  });

  it('indexes a staged site by its domains in lowercase, as a direct registration does', () => {
    const registry = createExtractionRegistry();
    const registration = registry.beginRegistration();
    registration.registerSite(site('alpha', 'Alpha.Example.TEST'));
    registration.commit();
    registry.registerSite(site('beta', 'BETA.example.test'));

    expect(registry.getSiteConfigForUrl('https://www.alpha.example.test/')?.siteId).toBe('alpha');
    expect(registry.getSiteConfigForUrl('https://beta.example.test/')?.siteId).toBe('beta');
  });

  it('refuses a malformed site config at the call, not at commit (no half-registered site either)', () => {
    const registry = createExtractionRegistry();
    const registration = registry.beginRegistration();
    const noDomains = { ...site('alpha', 'alpha.example.test'), domains: undefined } as unknown as SiteConfig;

    expect(() => registration.registerSite(noDomains)).toThrow(TypeError);
    expect(() => registry.registerSite(noDomains)).toThrow(TypeError);
    expect(registry.allStores()).toEqual([]);
  });
});

describe('ExtractionRegistry.beginRegistration — every call checked against the registry and the staged calls', () => {
  it('refuses a policy that conflicts with one already in the registry, at the call', () => {
    const registry = createExtractionRegistry();
    registry.registerHandsOffPolicy(policy());
    const registration = registry.beginRegistration();

    expect(() => registration.registerHandsOffPolicy(policy({ siteId: 'beta', hosts: ['alpha.example.test'] }))).toThrow(
      'host "alpha.example.test" is already registered by policy "alpha"'
    );
    expect(() => registration.registerHandsOffPolicy(policy({ hosts: ['beta.example.test'] }))).toThrow('policy "alpha" is already registered');
    expect(() =>
      registration.registerHandsOffPolicy(policy({ siteId: 'shop', hosts: ['shop.alpha.example.test'], handsOff: false }))
    ).toThrow('sits under "alpha.example.test" (policy "alpha") but is not handsOff');
  });

  it("refuses a policy that conflicts with the plugin's own earlier staged call", () => {
    const registry = createExtractionRegistry();
    const registration = registry.beginRegistration();
    registration.registerHandsOffPolicy(policy());

    expect(() => registration.registerHandsOffPolicy(policy({ siteId: 'beta', hosts: ['ALPHA.example.test.'] }))).toThrow(
      'host "alpha.example.test" is already registered by policy "alpha"'
    );
    expect(() => registration.registerHandsOffPolicy(policy({ hosts: ['beta.example.test'] }))).toThrow('policy "alpha" is already registered');
    expect(() =>
      registration.registerHandsOffPolicy(policy({ siteId: 'shop', hosts: ['shop.alpha.example.test'], handsOff: false }))
    ).toThrow('sits under "alpha.example.test" (policy "alpha") but is not handsOff');
  });

  it('refuses a second classifier whether the first is in the registry or staged', () => {
    const inRegistry = createExtractionRegistry();
    inRegistry.registerRobotsClassifier(classifier('2026-01-01'));
    expect(() => inRegistry.beginRegistration().registerRobotsClassifier(classifier())).toThrow(
      'a robots classifier is already registered (token list 2026-01-01)'
    );

    const staged = createExtractionRegistry().beginRegistration();
    staged.registerRobotsClassifier(classifier('2026-02-02'));
    expect(() => staged.registerRobotsClassifier(classifier())).toThrow('a robots classifier is already registered (token list 2026-02-02)');
  });

  it('re-checks at commit against what another registration committed meanwhile, applying nothing on a conflict', () => {
    for (const conflict of ['host', 'weaker child', 'classifier'] as const) {
      const registry = createExtractionRegistry();
      const first = registry.beginRegistration();
      const second = registry.beginRegistration();

      first.registerHandsOffPolicy(policy());
      first.registerRobotsClassifier(classifier('2026-01-01'));
      second.registerSite(site('beta', 'beta.example.test'));
      if (conflict === 'host') second.registerHandsOffPolicy(policy({ siteId: 'beta', hosts: ['alpha.example.test'] }));
      if (conflict === 'weaker child') second.registerHandsOffPolicy(policy({ siteId: 'beta', hosts: ['beta.alpha.example.test'], handsOff: false }));
      if (conflict === 'classifier') second.registerRobotsClassifier(classifier('2026-02-02'));
      first.commit();

      expect(() => second.commit()).toThrow(conflict === 'classifier' ? /robots classifier is already registered/ : /"alpha"/);
      expect(registry.allStores()).toEqual([]);
      expect(registry.handsOffView().map(v => v.siteId)).toEqual(['alpha']);
      expect(registry.robotsClassifier()?.tokenListDate).toBe('2026-01-01');
    }
  });
});

describe('ExtractionRegistry.beginRegistration — after commit or discard', () => {
  it('refuses every call made after commit: the registration closes once the plugin has loaded, applying nothing late', () => {
    const registry = createExtractionRegistry();
    const registration = registry.beginRegistration();
    registration.registerSite(site('alpha', 'alpha.example.test'));
    registration.commit();

    for (const call of [
      () => registration.registerSite(site('beta', 'beta.example.test')),
      () => registration.registerRuleset(ruleset('alpha')),
      () => registration.registerHandsOffPolicy(policy()),
      () => registration.registerRobotsClassifier(classifier()),
    ]) {
      expect(call).toThrow('plugin registration is closed: the plugin has loaded, so a registry call made after its register() resolved takes no effect');
    }
    expect(visible(registry)).toEqual({ ...NOTHING, sites: ['alpha'], siteForAlpha: 'alpha', requiredCookies: ['session'] });
    // A late call is not a refusal of the loaded plugin: what it committed stays committed.
    expect(registry.allStores().map(s => s.siteId)).toEqual(['alpha']);
  });

  it('refuses every call made after discard, so a late call cannot bring the plugin back', () => {
    const registry = createExtractionRegistry();
    const registration = registry.beginRegistration();
    registration.discard();

    for (const call of [
      () => registration.registerSite(site('alpha', 'alpha.example.test')),
      () => registration.registerRuleset(ruleset('alpha')),
      () => registration.registerHandsOffPolicy(policy()),
      () => registration.registerRobotsClassifier(classifier()),
    ]) {
      expect(call).toThrow('plugin registration was discarded: the plugin is not loaded');
    }
    expect(visible(registry)).toEqual(NOTHING);
  });

  it('commits once: a second commit, or a commit after discard, throws; discard after commit changes nothing', () => {
    const registry = createExtractionRegistry();
    const committed = registry.beginRegistration();
    committed.registerSite(site('alpha', 'alpha.example.test'));
    committed.commit();

    expect(() => committed.commit()).toThrow('plugin registration is already committed');
    committed.discard();
    expect(registry.allStores().map(s => s.siteId)).toEqual(['alpha']);
    // Still committed, not discarded: a later call is refused as late, not as a discarded plugin.
    expect(() => committed.registerSite(site('beta', 'beta.example.test'))).toThrow('plugin registration is closed');
    expect(registry.allStores().map(s => s.siteId)).toEqual(['alpha']);

    const discarded = registry.beginRegistration();
    discarded.discard();
    expect(() => discarded.commit()).toThrow('plugin registration is already discarded');
  });

  it('is discarded by a failed commit, so a retry cannot apply it', () => {
    const registry = createExtractionRegistry();
    const registration = registry.beginRegistration();
    expect(() => registration.registerHandsOffPolicy(policy({ hosts: ['*.alpha.example.test'] }))).toThrow();

    expect(() => registration.commit()).toThrow(/refused/);
    expect(() => registration.commit()).toThrow('plugin registration is already discarded');
  });
});

describe('ExtractionRegistry.beginRegistration — what the plugin is handed', () => {
  it('hands the plugin only the four registry methods (forPlugin), so it cannot commit, discard or reach the registry', () => {
    const registry = createExtractionRegistry();
    const registration = registry.beginRegistration();
    const handed = registration.forPlugin();

    expect(Object.keys(handed).sort()).toEqual(['registerHandsOffPolicy', 'registerRobotsClassifier', 'registerRuleset', 'registerSite']);
    expect(Object.getPrototypeOf(handed)).toBe(Object.prototype);
    expect(Object.isFrozen(handed)).toBe(true);
    for (const reach of ['commit', 'discard', 'registry', 'target', 'staged']) {
      expect((handed as unknown as Record<string, unknown>)[reach]).toBeUndefined();
    }
  });

  it('stages every call made through it, and a refused one poisons the registration as a direct call does', () => {
    const registry = createExtractionRegistry();
    const registration = registry.beginRegistration();
    const { registerSite, registerRuleset, registerHandsOffPolicy, registerRobotsClassifier } = registration.forPlugin();

    // Detached calls work: the methods do not depend on how the plugin calls them.
    registerSite(site('alpha', 'alpha.example.test'));
    registerRuleset(ruleset('alpha'));
    registerHandsOffPolicy?.(policy());
    registerRobotsClassifier?.(classifier());
    expect(visible(registry)).toEqual(NOTHING);
    registration.commit();
    expect(visible(registry)).toEqual({
      sites: ['alpha'], siteForAlpha: 'alpha', rulesetForAlpha: 'alpha', policies: ['alpha'], classifier: '2026-09-29', requiredCookies: ['session'],
    });

    const refused = registry.beginRegistration();
    const handed = refused.forPlugin();
    handed.registerSite(site('beta', 'beta.example.test'));
    expect(() => handed.registerHandsOffPolicy?.(policy({ siteId: 'beta', hosts: ['beta.example.test:443'] }))).toThrow('is not a DNS hostname');
    expect(() => refused.commit()).toThrow(/plugin registration refused/);
    expect(registry.allStores().map(s => s.siteId)).toEqual(['alpha']);
  });

  it('commits a registration with no classifier after another plugin committed one', () => {
    const registry = createExtractionRegistry();
    const first = registry.beginRegistration();
    first.registerRobotsClassifier(classifier('2026-01-01'));
    first.commit();

    const second = registry.beginRegistration();
    second.registerSite(site('beta', 'beta.example.test'));
    expect(() => second.commit()).not.toThrow();

    expect(registry.allStores().map(s => s.siteId)).toEqual(['beta']);
    expect(registry.robotsClassifier()?.tokenListDate).toBe('2026-01-01');
  });

  it('refuses at commit a plugin that caught a throw from reading its own ruleset', () => {
    const registry = createExtractionRegistry();
    const registration = registry.beginRegistration();
    const unreadable = { get siteId(): string { throw new Error('siteId unreadable'); }, version: '1' } as unknown as ExtractionRuleset;
    registration.registerSite(site('alpha', 'alpha.example.test'));

    expect(() => registration.registerRuleset(unreadable)).toThrow('siteId unreadable');
    expect(() => registration.commit()).toThrow('plugin registration refused: a registry call threw during register() (siteId unreadable)');
    expect(visible(registry)).toEqual(NOTHING);
  });
});
