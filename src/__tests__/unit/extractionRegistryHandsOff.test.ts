/**
 * The hands-off surface of the engine registry (plugin contract 0.17.0). The rulesets plugin
 * registers, at register() time, which hosts Claude and its tools must never contact (a
 * HandsOffPolicy per store, plus host-only entries), the robots pins, a robots classifier, and each
 * store's required cookie names. The engine only indexes and answers lookups: no engine file names
 * a store, a host or an AI token, so every host below is an example.test / .invalid placeholder.
 */
import { createExtractionRegistry } from '../../services/extractionRegistry';
import type {
  AiBarSummary,
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
    pins: [{ url: 'https://www.alpha.example.test/robots.txt', sha256: 'a'.repeat(64), fetchedAt: '2026-09-29T00:00:00.000Z' }],
    routeSamples: ['https://www.alpha.example.test/item/1'],
    policyVersion: 'policy-2026-09-29',
    ...over,
  };
}

function site(over: Partial<SiteConfig> = {}): SiteConfig {
  return {
    siteId: 'alpha',
    name: 'Alpha',
    domains: ['alpha.example.test'],
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
    allowedCookies: ['cf_clearance', 'session', 'pref'],
    ...over,
  };
}

const classifier = (tokenListDate = '2026-09-29'): RobotsClassifier => ({
  tokenListDate,
  classify: () => SUMMARY,
});

describe('ExtractionRegistry.handsOffPolicyFor — parent-domain match', () => {
  it('finds a registered policy for the host itself and for a subdomain at any depth', () => {
    const registry = createExtractionRegistry();
    registry.registerHandsOffPolicy(policy());

    for (const url of [
      'https://alpha.example.test/robots.txt',
      'https://www.alpha.example.test/item/1',
      'https://static.img.alpha.example.test/a.jpg',
    ]) {
      expect(registry.handsOffPolicyFor(url)?.siteId).toBe('alpha');
    }
  });

  it('never matches a look-alike suffix, a look-alike prefix or a host that only contains the name', () => {
    const registry = createExtractionRegistry();
    registry.registerHandsOffPolicy(policy());

    for (const url of [
      'https://notalpha.example.test/',
      'https://alpha.example.testx/',
      'https://alpha.example.test.evil.invalid/',
      'https://example.test/',
      'https://evil.invalid/alpha.example.test/',
      'https://evil.invalid/?u=https://alpha.example.test/',
    ]) {
      expect(registry.handsOffPolicyFor(url)).toBeUndefined();
    }
  });

  it('normalises the URL host the way a fetch would: case, trailing dots, port, userinfo, %-escapes, IDNA dots', () => {
    const registry = createExtractionRegistry();
    registry.registerHandsOffPolicy(policy());

    for (const url of [
      'https://WWW.ALPHA.EXAMPLE.TEST/',
      'https://www.alpha.example.test./',
      'https://www.alpha.example.test../',
      'https://user:pw@www.alpha.example.test:8443/x',
      'https://www.alpha%2Eexample.test/',
      'https://www.alpha。example.test/',
      'https://www.alpha.example.test\\@evil.invalid/',
      'https://.alpha.example.test/',
      'https://a..www.alpha.example.test/',
    ]) {
      expect(registry.handsOffPolicyFor(url)?.siteId).toBe('alpha');
    }
  });

  it('answers with the MOST specific registered host, whatever the registration order', () => {
    for (const order of [['parent', 'child'], ['child', 'parent']]) {
      const registry = createExtractionRegistry();
      const parent = policy({ siteId: 'parent', hosts: ['example.test'], handsOff: false, tier: 'NOT_NAMED' });
      const child = policy({ siteId: 'child', hosts: ['shop.example.test'] });
      for (const which of order) registry.registerHandsOffPolicy(which === 'parent' ? parent : child);

      expect(registry.handsOffPolicyFor('https://shop.example.test/x')?.siteId).toBe('child');
      expect(registry.handsOffPolicyFor('https://cdn.shop.example.test/x')?.siteId).toBe('child');
      expect(registry.handsOffPolicyFor('https://www.example.test/x')?.siteId).toBe('parent');
    }
  });

  it('throws for a malformed URL rather than answering "not hands-off"', () => {
    const registry = createExtractionRegistry();
    registry.registerHandsOffPolicy(policy());

    expect(() => registry.handsOffPolicyFor('alpha.example.test')).toThrow();
  });

  it('answers undefined for a URL with no DNS host (an IP literal, a mailto)', () => {
    const registry = createExtractionRegistry();
    registry.registerHandsOffPolicy(policy());

    expect(registry.handsOffPolicyFor('http://192.0.2.1/')).toBeUndefined();
    expect(registry.handsOffPolicyFor('http://[::1]/')).toBeUndefined();
    expect(registry.handsOffPolicyFor('mailto:someone@alpha.example.test')).toBeUndefined();
  });
});

describe('ExtractionRegistry.registerHandsOffPolicy — validation', () => {
  it('rejects a second registration for the same host, naming the host and the policy that holds it', () => {
    const registry = createExtractionRegistry();
    registry.registerHandsOffPolicy(policy());

    expect(() =>
      registry.registerHandsOffPolicy(policy({ siteId: 'beta', hosts: ['beta.example.test', 'ALPHA.example.test.'] }))
    ).toThrow(/"alpha\.example\.test".*"alpha"/);

    // Atomic: the rejected policy left nothing behind, not even its valid first host.
    expect(registry.handsOffPolicyFor('https://beta.example.test/')).toBeUndefined();
    expect(registry.handsOffView().map(v => v.siteId)).toEqual(['alpha']);
  });

  it('names a host-only entry as the holder when it is the one already registered', () => {
    const registry = createExtractionRegistry();
    registry.registerHandsOffPolicy(policy({ siteId: undefined, hosts: ['denied.example.test'], denied: true }));

    expect(() => registry.registerHandsOffPolicy(policy({ hosts: ['denied.example.test'] }))).toThrow(
      /"denied\.example\.test".*host-only/
    );
  });

  it('rejects a host listed twice inside one policy, by name', () => {
    const registry = createExtractionRegistry();

    expect(() => registry.registerHandsOffPolicy(policy({ hosts: ['alpha.example.test', 'Alpha.Example.Test.'] }))).toThrow(
      /"alpha\.example\.test"/
    );
    expect(registry.handsOffView()).toEqual([]);
  });

  it('rejects a second policy for the same siteId, by name', () => {
    const registry = createExtractionRegistry();
    registry.registerHandsOffPolicy(policy());

    expect(() => registry.registerHandsOffPolicy(policy({ hosts: ['other.example.test'] }))).toThrow(/"alpha"/);
    expect(registry.handsOffPolicyFor('https://other.example.test/')).toBeUndefined();
  });

  it.each([
    ['an empty string', ''],
    ['a single label', 'localhost'],
    ['a URL', 'https://alpha.example.test'],
    ['a path', 'alpha.example.test/item'],
    ['a port', 'alpha.example.test:443'],
    ['userinfo', 'user@alpha.example.test'],
    ['a query', 'alpha.example.test?x'],
    ['a fragment', 'alpha.example.test#x'],
    ['a backslash', 'alpha.example.test\\x'],
    ['a %-escape', 'alpha%2Eexample.test'],
    ['a wildcard', '*.alpha.example.test'],
    ['a leading dot', '.alpha.example.test'],
    ['an empty label', 'alpha..example.test'],
    ['whitespace', 'alpha.example.test '],
    ['an IPv4 literal', '192.0.2.1'],
    ['an IPv6 literal', '[::1]'],
  ])('rejects a host that is not a DNS hostname: %s, naming it', (_label, host) => {
    const registry = createExtractionRegistry();

    expect(() => registry.registerHandsOffPolicy(policy({ hosts: [host] }))).toThrow(JSON.stringify(host));
    expect(registry.handsOffView()).toEqual([]);
  });

  it('rejects a host that is not a string, even one whose string form is a hostname', () => {
    const registry = createExtractionRegistry();

    expect(() => registry.registerHandsOffPolicy(policy({ hosts: [42 as unknown as string] }))).toThrow(/42/);
    expect(() => registry.registerHandsOffPolicy(policy({ hosts: [['alpha.example.test'] as unknown as string] }))).toThrow(
      '["alpha.example.test"] is not a DNS hostname'
    );
    expect(registry.handsOffView()).toEqual([]);
  });

  it('rejects a policy with no hosts, or hosts that is not an array', () => {
    const registry = createExtractionRegistry();

    expect(() => registry.registerHandsOffPolicy(policy({ hosts: [] }))).toThrow(/hosts/);
    expect(() => registry.registerHandsOffPolicy(policy({ hosts: 'alpha.example.test' as unknown as string[] }))).toThrow(/hosts/);
  });

  it('rejects a policy whose handsOff is not a boolean (the decision is never inferred)', () => {
    const registry = createExtractionRegistry();

    for (const handsOff of ['true', 1, undefined, null]) {
      expect(() => registry.registerHandsOffPolicy(policy({ handsOff: handsOff as unknown as boolean }))).toThrow(/handsOff/);
    }
    expect(registry.handsOffView()).toEqual([]);
  });

  it('rejects a siteId that is present but not a non-empty string', () => {
    const registry = createExtractionRegistry();

    expect(() => registry.registerHandsOffPolicy(policy({ siteId: '' }))).toThrow(/siteId/);
    expect(() => registry.registerHandsOffPolicy(policy({ siteId: 7 as unknown as string }))).toThrow(/siteId/);
  });

  it('rejects a value that is not an object', () => {
    const registry = createExtractionRegistry();

    for (const value of [null, undefined, 'alpha.example.test']) {
      expect(() => registry.registerHandsOffPolicy(value as unknown as HandsOffPolicy)).toThrow('hands-off policy: expected an object');
    }
  });

  it('stores registered hosts normalised (case, trailing dot, IDNA) and matches on them', () => {
    const registry = createExtractionRegistry();
    registry.registerHandsOffPolicy(policy({ hosts: ['Alpha.EXAMPLE.test.', 'bücher.example.test'] }));

    expect(registry.handsOffView()[0].hosts).toEqual(['alpha.example.test', 'xn--bcher-kva.example.test']);
    expect(registry.handsOffPolicyFor('https://www.alpha.example.test/')?.siteId).toBe('alpha');
    expect(registry.handsOffPolicyFor('https://bücher.example.test/')?.siteId).toBe('alpha');
  });
});

describe('ExtractionRegistry — a registered policy is a frozen snapshot', () => {
  it('ignores later changes to the object the plugin passed in', () => {
    const registry = createExtractionRegistry();
    const passed = policy();
    registry.registerHandsOffPolicy(passed);

    passed.handsOff = false;
    passed.hosts.push('late.example.test');
    passed.pins[0].sha256 = 'b'.repeat(64);

    expect(registry.handsOffPolicyFor('https://alpha.example.test/')?.handsOff).toBe(true);
    expect(registry.handsOffPolicyFor('https://late.example.test/')).toBeUndefined();
    expect(registry.robotsPinsFor('alpha')?.[0].sha256).toBe('a'.repeat(64));
  });

  it('refuses a mutation through a returned policy or its pins', () => {
    const registry = createExtractionRegistry();
    registry.registerHandsOffPolicy(policy());
    const got = registry.handsOffPolicyFor('https://alpha.example.test/')!;

    // (The snapshot's arrays come from structuredClone, i.e. the host realm under jest, so their
    // TypeError is not this vm's TypeError: assert the refusal and the unchanged state instead.)
    expect(() => { (got as { handsOff: boolean }).handsOff = false; }).toThrow(TypeError);
    expect(() => got.hosts.push('late.example.test')).toThrow(/not extensible/);
    expect(() => registry.robotsPinsFor('alpha')!.pop()).toThrow(/Cannot delete/);
    expect(registry.handsOffPolicyFor('https://alpha.example.test/')?.handsOff).toBe(true);
    expect(registry.handsOffPolicyFor('https://late.example.test/')).toBeUndefined();
    expect(registry.robotsPinsFor('alpha')).toHaveLength(1);
  });

});

describe('ExtractionRegistry.robotsPinsFor', () => {
  it("returns the pins of the siteId's policy, and undefined for a siteId with no policy", () => {
    const registry = createExtractionRegistry();
    registry.registerHandsOffPolicy(policy());

    expect(registry.robotsPinsFor('alpha')).toEqual([
      { url: 'https://www.alpha.example.test/robots.txt', sha256: 'a'.repeat(64), fetchedAt: '2026-09-29T00:00:00.000Z' },
    ]);
    expect(registry.robotsPinsFor('beta')).toBeUndefined();
  });

  it('never reaches a host-only entry through a siteId', () => {
    const registry = createExtractionRegistry();
    registry.registerHandsOffPolicy(policy({ siteId: undefined, hosts: ['denied.example.test'], denied: true }));

    expect(registry.handsOffPolicyFor('https://denied.example.test/')?.denied).toBe(true);
    expect(registry.robotsPinsFor('undefined')).toBeUndefined();
  });
});

describe('ExtractionRegistry.robotsClassifier', () => {
  it('returns the registered classifier, whose classify is the plugin\'s own (this intact)', () => {
    const registry = createExtractionRegistry();
    class TokenClassifier implements RobotsClassifier {
      readonly tokenListDate = '2026-09-29';
      private readonly seen: string[] = [];
      classify(body: string, routeUrls: string[]): AiBarSummary {
        this.seen.push(body);
        return { ...SUMMARY, routeBarTokens: routeUrls };
      }
    }
    registry.registerRobotsClassifier(new TokenClassifier());

    const got = registry.robotsClassifier();
    expect(got?.tokenListDate).toBe('2026-09-29');
    expect(got?.classify('User-agent: *', ['https://alpha.example.test/x']).routeBarTokens).toEqual(['https://alpha.example.test/x']);
  });

  it('rejects a second classifier, naming the token list already registered', () => {
    const registry = createExtractionRegistry();
    registry.registerRobotsClassifier(classifier('2026-09-29'));

    expect(() => registry.registerRobotsClassifier(classifier('2026-10-01'))).toThrow(/2026-09-29/);
    expect(registry.robotsClassifier()?.tokenListDate).toBe('2026-09-29');
  });

  it('rejects a classifier without a classify function or a tokenListDate string', () => {
    const registry = createExtractionRegistry();

    expect(() => registry.registerRobotsClassifier({ tokenListDate: '2026-09-29' } as unknown as RobotsClassifier)).toThrow(/classify/);
    expect(() => registry.registerRobotsClassifier({ classify: () => SUMMARY } as unknown as RobotsClassifier)).toThrow(/tokenListDate/);
    for (const value of [undefined, null, 'classify']) {
      expect(() => registry.registerRobotsClassifier(value as unknown as RobotsClassifier)).toThrow('robots classifier: expected an object');
    }
    expect(registry.robotsClassifier()).toBeUndefined();
  });
});

describe('ExtractionRegistry.requiredCookiesFor', () => {
  it("returns the declared names for the site's domain and its subdomains (case and trailing dot normalised)", () => {
    const registry = createExtractionRegistry();
    registry.registerSite(site({ requiredCookies: ['cf_clearance', 'session'] }));

    expect(registry.requiredCookiesFor('alpha.example.test')).toEqual(['cf_clearance', 'session']);
    expect(registry.requiredCookiesFor('STATIC.Alpha.Example.Test.')).toEqual(['cf_clearance', 'session']);
  });

  it('returns a copy, so a caller cannot change the declared set', () => {
    const registry = createExtractionRegistry();
    registry.registerSite(site({ requiredCookies: ['cf_clearance'] }));

    registry.requiredCookiesFor('alpha.example.test')!.push('injected');
    expect(registry.requiredCookiesFor('alpha.example.test')).toEqual(['cf_clearance']);
  });

  it('keeps "declared none" ([]) apart from "not declared" (undefined)', () => {
    const registry = createExtractionRegistry();
    registry.registerSite(site({ requiredCookies: [] }));
    registry.registerSite(site({ siteId: 'beta', domains: ['beta.example.test'] }));

    expect(registry.requiredCookiesFor('alpha.example.test')).toEqual([]);
    expect(registry.requiredCookiesFor('beta.example.test')).toBeUndefined();
  });

  it('answers undefined for a host no site covers, and for a non-array value from an untyped plugin', () => {
    const registry = createExtractionRegistry();
    registry.registerSite(site({ requiredCookies: 'cf_clearance' as unknown as string[] }));

    expect(registry.requiredCookiesFor('alpha.example.test')).toBeUndefined();
    expect(registry.requiredCookiesFor('nowhere.example.test')).toBeUndefined();
  });
});

describe('ExtractionRegistry — an engine with no hands-off registrations', () => {
  it('reports handsOff [] and no classifier, and finds no policy and no pins', () => {
    const registry = createExtractionRegistry();
    registry.registerSite(site());

    expect(registry.handsOffView()).toEqual([]);
    expect(registry.robotsClassifier()).toBeUndefined();
    expect(registry.handsOffPolicyFor('https://alpha.example.test/')).toBeUndefined();
    expect(registry.robotsPinsFor('alpha')).toBeUndefined();
  });
});

describe('ExtractionRegistry.handsOffView', () => {
  it('lists every policy in registration order as {siteId, hosts, tier, handsOff, denied, policyVersion} and nothing else', () => {
    const registry = createExtractionRegistry();
    registry.registerHandsOffPolicy(policy());
    registry.registerHandsOffPolicy(policy({ siteId: 'beta', hosts: ['beta.example.test'], handsOff: false, tier: 'NOT_NAMED' }));
    registry.registerHandsOffPolicy(policy({ siteId: undefined, hosts: ['denied.example.test', 'denied2.example.test'], denied: true }));

    expect(registry.handsOffView()).toEqual([
      { siteId: 'alpha', hosts: ['alpha.example.test'], tier: 'FULL_BAR', handsOff: true, denied: false, policyVersion: 'policy-2026-09-29' },
      { siteId: 'beta', hosts: ['beta.example.test'], tier: 'NOT_NAMED', handsOff: false, denied: false, policyVersion: 'policy-2026-09-29' },
      { siteId: null, hosts: ['denied.example.test', 'denied2.example.test'], tier: 'FULL_BAR', handsOff: true, denied: true, policyVersion: 'policy-2026-09-29' },
    ]);
  });

  it('reports denied only for a literal true (an untyped plugin may send "yes" or null)', () => {
    const registry = createExtractionRegistry();
    registry.registerHandsOffPolicy(policy({ denied: 'yes' as unknown as boolean }));
    registry.registerHandsOffPolicy(policy({ siteId: 'beta', hosts: ['beta.example.test'], denied: null as unknown as boolean }));

    expect(registry.handsOffView().map(v => v.denied)).toEqual([false, false]);
  });
});
