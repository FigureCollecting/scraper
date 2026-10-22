/**
 * The hands-off surface of the engine registry (plugin contract 0.17.0). The rulesets plugin
 * registers, at register() time, which hosts Claude and its tools must never contact (a
 * HandsOffPolicy per store, plus host-only entries), the robots pins, a robots classifier, and each
 * store's required cookie names. The engine only indexes and answers lookups: no engine file names
 * a store, a host or an AI token, so every host below is an example.test / .invalid placeholder.
 */
import { createExtractionRegistry, isArrayOf } from '../../services/extractionRegistry';
import type {
  AiBarSummary,
  HandsOffPolicy,
  RobotsClassifier,
  RobotsPin,
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
    // JSON has no undefined: a generated policy that wrote null must not turn into a host-only entry.
    expect(() => registry.registerHandsOffPolicy(policy({ siteId: null as unknown as string }))).toThrow(/siteId.*null/);
    expect(registry.handsOffView()).toEqual([]);
  });

  it('rejects a denied that is present but not a boolean, naming it (the flag is never inferred either)', () => {
    const registry = createExtractionRegistry();

    for (const denied of ['yes', 'true', 'false', 1, 0, null]) {
      expect(() => registry.registerHandsOffPolicy(policy({ denied: denied as unknown as boolean }))).toThrow(
        `hands-off policy "alpha": denied must be a boolean when present, got ${JSON.stringify(denied)}`
      );
    }
    expect(registry.handsOffView()).toEqual([]);
  });

  it('accepts denied true, false or absent, and the lookup and the view report the same flag', () => {
    const registry = createExtractionRegistry();
    registry.registerHandsOffPolicy(policy({ siteId: 'yes', hosts: ['yes.example.test'], denied: true }));
    registry.registerHandsOffPolicy(policy({ siteId: 'no', hosts: ['no.example.test'], denied: false }));
    registry.registerHandsOffPolicy(policy({ siteId: 'absent', hosts: ['absent.example.test'] }));

    const viaLookup = ['yes', 'no', 'absent'].map(id => registry.handsOffPolicyFor(`https://${id}.example.test/`)?.denied === true);
    expect(viaLookup).toEqual([true, false, false]);
    expect(registry.handsOffView().map(v => v.denied)).toEqual(viaLookup);
  });

  it.each([
    ['a tier outside AiBarTier', { tier: 'PARTIAL_BAR' }, /tier must be one of FULL_BAR, .*UNREADABLE, got "PARTIAL_BAR"/],
    ['no tier', { tier: undefined }, /tier must be one of .*, got undefined/],
    ['no policyVersion', { policyVersion: undefined }, /policyVersion must be a non-empty string, got undefined/],
    ['an empty policyVersion', { policyVersion: '' }, /policyVersion must be a non-empty string, got ""/],
    ['a numeric policyVersion', { policyVersion: 3 }, /policyVersion must be a non-empty string, got 3/],
    ['no summary', { summary: undefined }, /summary must be an object/],
    ['a null summary', { summary: null }, /summary must be an object/],
    ['a summary that is a tier string', { summary: 'FULL_BAR' }, /summary must be an object/],
    ['a summary that is an array', { summary: [] }, /summary must be an object/],
    ['pins that is not an array', { pins: 'none' }, /pins must be an array of \{url, sha256, fetchedAt\}/],
    ['a null pin', { pins: [null] }, /pins must be an array of \{url, sha256, fetchedAt\}/],
    ['a pin without a url', { pins: [{ sha256: 'a'.repeat(64), fetchedAt: '2026-09-29T00:00:00.000Z' }] }, /pins must be an array/],
    ['a pin with a numeric sha256', { pins: [{ url: 'https://x.example.test/robots.txt', sha256: 1, fetchedAt: '2026-09-29T00:00:00.000Z' }] }, /pins must be an array/],
    ['a pin without fetchedAt', { pins: [{ url: 'https://x.example.test/robots.txt', sha256: 'a'.repeat(64) }] }, /pins must be an array/],
    ['routeSamples that is not an array', { routeSamples: 'https://x.example.test/' }, /routeSamples must be an array of strings/],
    ['a route sample that is not a string', { routeSamples: [7] }, /routeSamples must be an array of strings/],
  ])('rejects a policy with %s, naming the policy (the fields /health/detailed and the probes read)', (_label, over, message) => {
    const registry = createExtractionRegistry();

    expect(() => registry.registerHandsOffPolicy(policy(over as unknown as Partial<HandsOffPolicy>))).toThrow(message);
    expect(() => registry.registerHandsOffPolicy(policy(over as unknown as Partial<HandsOffPolicy>))).toThrow(/^hands-off policy "alpha": /);
    expect(registry.handsOffView()).toEqual([]);
  });

  it('accepts every AiBarTier and empty pins and route samples', () => {
    const registry = createExtractionRegistry();
    const tiers = ['FULL_BAR', 'ROUTE_BAR', 'NAMED_NO_ROUTE_BAR', 'CRAWL_DELAY_ONLY', 'NOT_NAMED', 'UNREADABLE'] as const;
    tiers.forEach((tier, i) =>
      registry.registerHandsOffPolicy(policy({ siteId: `s${i}`, hosts: [`s${i}.example.test`], tier, pins: [], routeSamples: [] }))
    );

    expect(registry.handsOffView().map(v => v.tier)).toEqual([...tiers]);
  });

  it('names the policy when a field cannot be copied (a function where plain data belongs)', () => {
    const registry = createExtractionRegistry();
    const withFunction = { ...SUMMARY, toString: () => 'x' } as unknown as AiBarSummary;

    expect(() => registry.registerHandsOffPolicy(policy({ summary: withFunction }))).toThrow(
      /^hands-off policy "alpha": the policy must be plain data \(.*could not be cloned/
    );
    expect(registry.handsOffView()).toEqual([]);
  });

  it('accepts and matches a host with an underscore label, as a URL parser does', () => {
    const registry = createExtractionRegistry();
    registry.registerHandsOffPolicy(policy({ hosts: ['a_b.example.test'] }));

    expect(registry.handsOffPolicyFor('https://www.a_b.example.test/x')?.siteId).toBe('alpha');
    expect(registry.handsOffPolicyFor('https://ab.example.test/x')).toBeUndefined();
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

/**
 * The registry reads a policy ONCE, as plain data: it copies the plugin's object first (its own
 * enumerable fields, each read once, through a structured clone) and then checks and stores that
 * copy. So what it checked is what it stores, and a field the copy cannot see is missing, never
 * trusted from a second read.
 */
describe('ExtractionRegistry.registerHandsOffPolicy — the policy is read once, as plain data', () => {
  /** A policy whose `field` is an own enumerable getter: `first` on the first read, `later` on every other. */
  function changing(field: keyof HandsOffPolicy, first: unknown, later: unknown, over: Partial<HandsOffPolicy> = {}) {
    const reads = { count: 0 };
    const target = { ...policy(over) } as Record<string, unknown>;
    delete target[field];
    Object.defineProperty(target, field, { enumerable: true, get: () => (++reads.count === 1 ? first : later) });
    return { policy: target as unknown as HandsOffPolicy, reads };
  }

  it('stores the denied flag it checked, so the lookup and /health/detailed agree', () => {
    const registry = createExtractionRegistry();
    const { policy: changingDenied, reads } = changing('denied', undefined, 'yes');
    registry.registerHandsOffPolicy(changingDenied);

    expect(registry.handsOffPolicyFor('https://alpha.example.test/')?.denied).toBeUndefined();
    expect(registry.handsOffView()[0].denied).toBe(false);
    expect(reads.count).toBe(1);
  });

  it('stores the tier and the decision it checked', () => {
    const registry = createExtractionRegistry();
    const tier = changing('tier', 'FULL_BAR', 'BOGUS');
    const decision = changing('handsOff', true, false, { siteId: 'beta', hosts: ['beta.example.test'] });
    registry.registerHandsOffPolicy(tier.policy);
    registry.registerHandsOffPolicy(decision.policy);

    expect(registry.handsOffView().map(v => [v.siteId, v.tier, v.handsOff])).toEqual([
      ['alpha', 'FULL_BAR', true],
      ['beta', 'FULL_BAR', true],
    ]);
    expect(registry.handsOffPolicyFor('https://beta.example.test/')?.handsOff).toBe(true);
    expect([tier.reads.count, decision.reads.count]).toEqual([1, 1]);
  });

  it('stores the siteId it checked (a second read cannot turn a store policy into a host-only one)', () => {
    const registry = createExtractionRegistry();
    const { policy: changingSiteId, reads } = changing('siteId', 'alpha', null);
    registry.registerHandsOffPolicy(changingSiteId);

    expect(registry.handsOffView()[0].siteId).toBe('alpha');
    expect(registry.robotsPinsFor('alpha')).toHaveLength(1);
    expect(reads.count).toBe(1);
  });

  it('refuses a policy whose fields come from a class getter, a prototype or a non-enumerable property, naming the missing field', () => {
    const registry = createExtractionRegistry();
    class GeneratedPolicy {
      readonly siteId = 'alpha';
      readonly hosts = ['alpha.example.test'];
      get handsOff(): boolean { return true; }
      get denied(): boolean { return true; }
      get tier(): 'FULL_BAR' { return 'FULL_BAR'; }
      get summary(): AiBarSummary { return SUMMARY; }
      get pins(): [] { return []; }
      get routeSamples(): [] { return []; }
      get policyVersion(): string { return 'generated-1'; }
    }
    const { handsOff: _handsOff, ...withoutDecision } = policy();
    const onPrototype = Object.assign(Object.create({ handsOff: true, denied: true }), withoutDecision);
    const nonEnumerable = Object.defineProperty({ ...withoutDecision }, 'handsOff', { value: true, enumerable: false });

    for (const unreadable of [new GeneratedPolicy(), onPrototype, nonEnumerable]) {
      expect(() => registry.registerHandsOffPolicy(unreadable as unknown as HandsOffPolicy)).toThrow(
        'hands-off policy "alpha": handsOff must be a boolean, got undefined'
      );
    }
    expect(registry.handsOffView()).toEqual([]);
    // Nothing was stored without its decision, so nothing can be lifted under it either.
    expect(registry.handsOffPolicyFor('https://alpha.example.test/')).toBeUndefined();
  });

  it('refuses pins or route samples with a hole (a hole reads as undefined, not as a pin or a URL)', () => {
    const registry = createExtractionRegistry();
    const holeyPins = new Array<RobotsPin>(2);
    holeyPins[1] = { url: 'https://alpha.example.test/robots.txt', sha256: 'a'.repeat(64), fetchedAt: '2026-09-29T00:00:00.000Z' };
    const holeySamples: string[] = [];
    holeySamples[1] = 'https://alpha.example.test/item/1';

    expect(() => registry.registerHandsOffPolicy(policy({ pins: holeyPins }))).toThrow(/pins must be an array of \{url, sha256, fetchedAt\}/);
    expect(() => registry.registerHandsOffPolicy(policy({ routeSamples: holeySamples }))).toThrow(/routeSamples must be an array of strings/);
    expect(registry.handsOffView()).toEqual([]);
  });

  it.each([
    ['an empty summary', {}, 'summary.tier must be one of FULL_BAR'],
    ['a summary tier outside AiBarTier', { ...SUMMARY, tier: 'PARTIAL_BAR' }, 'summary.tier must be one of FULL_BAR'],
    ['no namedTokens', { ...SUMMARY, namedTokens: undefined }, 'summary.namedTokens must be an array of strings'],
    ['no fullBarTokens', { ...SUMMARY, fullBarTokens: undefined }, 'summary.fullBarTokens must be an array of strings'],
    ['no routeBarTokens', { ...SUMMARY, routeBarTokens: undefined }, 'summary.routeBarTokens must be an array of strings'],
    ['no crawlDelayTokens', { ...SUMMARY, crawlDelayTokens: undefined }, 'summary.crawlDelayTokens must be an array of strings'],
    ['contentSignals that is a string', { ...SUMMARY, contentSignals: 'ai-train=no' }, 'summary.contentSignals must be an array of strings'],
    ['a token that is not a string', { ...SUMMARY, fullBarTokens: [1] }, 'summary.fullBarTokens must be an array of strings'],
  ])('rejects a policy whose summary has %s, naming the field (the robots probe reads every list)', (_label, summary, message) => {
    const registry = createExtractionRegistry();

    expect(() => registry.registerHandsOffPolicy(policy({ summary: summary as unknown as AiBarSummary }))).toThrow(
      `hands-off policy "alpha": ${message}`
    );
    expect(registry.handsOffView()).toEqual([]);
  });

  it('stores a policy whose extra data is cyclic, frozen through the cycle, instead of overflowing the stack', () => {
    const registry = createExtractionRegistry();
    const note: Record<string, unknown> = { text: 'generated' };
    note.self = note;
    const summaryNote: Record<string, unknown> = {};
    summaryNote.loop = [summaryNote];

    registry.registerHandsOffPolicy({ ...policy({ summary: { ...SUMMARY, note: summaryNote } as AiBarSummary }), note } as HandsOffPolicy);

    const stored = registry.handsOffPolicyFor('https://alpha.example.test/') as unknown as {
      note: { self: unknown };
      summary: { note: { loop: unknown[] } };
    };
    expect(stored.note.self).toBe(stored.note);
    expect(Object.isFrozen(stored.note)).toBe(true);
    expect(stored.summary.note.loop[0]).toBe(stored.summary.note);
    expect(Object.isFrozen(stored.summary.note.loop)).toBe(true);
  });
});

/**
 * The array check stops at the first element that fails, a hole included, so a sparse array of any
 * length costs one read rather than one per index (Array.from over a length of 2^32-1 runs out of memory).
 */
describe('isArrayOf', () => {
  const isText = (value: unknown): value is string => typeof value === 'string';

  /** A sparse array of the largest length that counts its index reads and refuses to go past the third. */
  function countingSparse(fill: Record<number, unknown> = {}) {
    const reads: string[] = [];
    const target = new Array<unknown>(2 ** 32 - 1);
    for (const [index, value] of Object.entries(fill)) target[Number(index)] = value;
    const array = new Proxy(target, {
      get(inner, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) {
          reads.push(key);
          if (reads.length > 3) throw new Error(`read index ${key}: past the first failing element`);
        }
        return Reflect.get(inner, key, receiver);
      },
    });
    return { array, reads };
  }

  it('stops at a leading hole', () => {
    const { array, reads } = countingSparse();

    expect(isArrayOf(array, isText)).toBe(false);
    expect(reads).toEqual(['0']);
  });

  it('stops at the first hole after elements that pass', () => {
    const { array, reads } = countingSparse({ 0: 'a', 1: 'b' });

    expect(isArrayOf(array, isText)).toBe(false);
    expect(reads).toEqual(['0', '1', '2']);
  });

  it('accepts a dense array whose every element passes, and refuses a non-array or a failing element', () => {
    expect(isArrayOf(['a', 'b'], isText)).toBe(true);
    expect(isArrayOf([], isText)).toBe(true);
    expect(isArrayOf(['a', 1], isText)).toBe(false);
    expect(isArrayOf({ length: 0 }, isText)).toBe(false);
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
    // Nor through a missing siteId from an untyped caller: a host-only entry is indexed by host alone.
    expect(registry.robotsPinsFor(undefined as unknown as string)).toBeUndefined();
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

  it('answers undefined for a host no site covers', () => {
    const registry = createExtractionRegistry();
    registry.registerSite(site({ requiredCookies: ['cf_clearance'] }));

    expect(registry.requiredCookiesFor('nowhere.example.test')).toBeUndefined();
  });

  it.each([
    ['a string', 'cf_clearance'],
    ['a name that is not a string', ['cf_clearance', 5]],
    ['a hole', [, 'session']],
    ['an object', { 0: 'cf_clearance', length: 1 }],
    ['null', null],
  ])('refuses a site whose requiredCookies is %s, naming the site, and registers none of it', (_label, requiredCookies) => {
    const registry = createExtractionRegistry();

    expect(() => registry.registerSite(site({ requiredCookies: requiredCookies as unknown as string[] }))).toThrow(
      'site "alpha": requiredCookies must be an array of cookie names (strings) when present'
    );
    expect(registry.requiredCookiesFor('alpha.example.test')).toBeUndefined();
    expect(registry.getSiteConfigForUrl('https://alpha.example.test/')).toBeUndefined();
  });

  /**
   * The names are copied once, at registerSite, and the copy is what was checked and what is answered.
   * The plugin keeps its own config object, so reading it again later could answer names the check
   * never saw (requiredCookiesFor is typed string[]).
   */
  it('keeps the names it checked at registration when the plugin later changes its own array or swaps it', () => {
    const registry = createExtractionRegistry();
    const names = ['cf_clearance'];
    const config = site({ requiredCookies: names });
    registry.registerSite(config);

    names.push(5 as unknown as string, { evil: 1 } as unknown as string);
    expect(registry.requiredCookiesFor('alpha.example.test')).toEqual(['cf_clearance']);
    (config as { requiredCookies: unknown }).requiredCookies = 'cf_clearance';
    expect(registry.requiredCookiesFor('alpha.example.test')).toEqual(['cf_clearance']);
  });

  it('reads requiredCookies once, so a getter that changes between reads cannot slip names past the check', () => {
    const registry = createExtractionRegistry();
    let reads = 0;
    const config = site();
    Object.defineProperty(config, 'requiredCookies', {
      enumerable: true,
      get: () => (++reads === 1 ? ['cf_clearance'] : [7, null]),
    });

    registry.registerSite(config);

    expect(registry.requiredCookiesFor('alpha.example.test')).toEqual(['cf_clearance']);
    expect(reads).toBe(1);
  });

  it('reads each name once, so an array that answers differently on a second read is kept as it was checked', () => {
    const registry = createExtractionRegistry();
    let reads = 0;
    const lying = new Proxy(['cf_clearance'], {
      get: (target, key, receiver) => (key === '0' ? (++reads === 1 ? 'cf_clearance' : 99) : Reflect.get(target, key, receiver)),
    });

    registry.registerSite(site({ requiredCookies: lying }));

    expect(registry.requiredCookiesFor('alpha.example.test')).toEqual(['cf_clearance']);
    expect(reads).toBe(1);
  });

  it('refuses a name that only the second read of an index would have shown', () => {
    const registry = createExtractionRegistry();
    let reads = 0;
    const lying = new Proxy(['cf_clearance'], {
      get: (target, key, receiver) => (key === '0' ? (++reads === 1 ? 99 : 'cf_clearance') : Reflect.get(target, key, receiver)),
    });

    expect(() => registry.registerSite(site({ requiredCookies: lying }))).toThrow(
      'site "alpha": requiredCookies must be an array of cookie names (strings) when present'
    );
    expect(registry.requiredCookiesFor('alpha.example.test')).toBeUndefined();
  });

  it('forgets the names when the site is registered again without requiredCookies', () => {
    const registry = createExtractionRegistry();
    registry.registerSite(site({ requiredCookies: ['cf_clearance'] }));
    registry.registerSite(site());

    expect(registry.requiredCookiesFor('alpha.example.test')).toBeUndefined();
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

});

/**
 * The lookup answers with the most specific registered host, so a policy on a subdomain decides for
 * that subdomain. A subdomain policy may therefore only be at least as strict as every policy above
 * it: one that would lift a parent's handsOff or denied is refused, whichever is registered first.
 */
describe('ExtractionRegistry.registerHandsOffPolicy — a subdomain policy never lifts its parent', () => {
  const barred = (over: Partial<HandsOffPolicy> = {}) => policy({ siteId: 'barred', hosts: ['barred.example.test'], ...over });
  const shop = (over: Partial<HandsOffPolicy> = {}) =>
    policy({ siteId: 'shop', hosts: ['shop.barred.example.test'], handsOff: false, tier: 'NOT_NAMED', ...over });
  const denied = (over: Partial<HandsOffPolicy> = {}) =>
    policy({ siteId: undefined, hosts: ['denied.example.test'], denied: true, tier: 'NOT_NAMED', ...over });

  it('refuses a subdomain policy that is not hands-off under a hands-off parent, naming both (parent first)', () => {
    const registry = createExtractionRegistry();
    registry.registerHandsOffPolicy(barred());

    expect(() => registry.registerHandsOffPolicy(shop())).toThrow(
      'hands-off policy "shop": "shop.barred.example.test" (policy "shop") sits under "barred.example.test" (policy "barred") but is not handsOff'
    );
    expect(registry.handsOffPolicyFor('https://shop.barred.example.test/item/1')?.siteId).toBe('barred');
    expect(registry.handsOffView().map(v => v.siteId)).toEqual(['barred']);
  });

  it('refuses a hands-off parent over a subdomain policy that is not, naming both (child first)', () => {
    const registry = createExtractionRegistry();
    registry.registerHandsOffPolicy(shop());

    expect(() => registry.registerHandsOffPolicy(barred())).toThrow(
      'hands-off policy "barred": "shop.barred.example.test" (policy "shop") sits under "barred.example.test" (policy "barred") but is not handsOff'
    );
    expect(registry.handsOffPolicyFor('https://www.barred.example.test/')).toBeUndefined();
    expect(registry.handsOffView().map(v => v.siteId)).toEqual(['shop']);
  });

  it.each([
    ['absent', undefined],
    ['false', false],
  ])('refuses a subdomain policy whose denied is %s under a denied host, in either order', (_label, childDenied) => {
    const child = policy({ siteId: 'store', hosts: ['www.denied.example.test'], denied: childDenied });
    const message =
      '"www.denied.example.test" (policy "store") sits under "denied.example.test" (a host-only entry) but is not denied';

    const parentFirst = createExtractionRegistry();
    parentFirst.registerHandsOffPolicy(denied());
    expect(() => parentFirst.registerHandsOffPolicy(child)).toThrow(`hands-off policy "store": ${message}`);
    expect(parentFirst.handsOffPolicyFor('https://www.denied.example.test/')?.denied).toBe(true);

    const childFirst = createExtractionRegistry();
    childFirst.registerHandsOffPolicy(child);
    expect(() => childFirst.registerHandsOffPolicy(denied())).toThrow(`hands-off a host-only entry: ${message}`);
    expect(childFirst.handsOffView().map(v => v.siteId)).toEqual(['store']);
  });

  it('checks every policy above, not only the nearest one', () => {
    const registry = createExtractionRegistry();
    registry.registerHandsOffPolicy(barred());
    registry.registerHandsOffPolicy(policy({ siteId: 'mid', hosts: ['mid.barred.example.test'] }));

    expect(() =>
      registry.registerHandsOffPolicy(policy({ siteId: 'deep', hosts: ['a.b.mid.barred.example.test'], handsOff: false }))
    ).toThrow('"a.b.mid.barred.example.test" (policy "deep") sits under "mid.barred.example.test" (policy "mid")');
    expect(() =>
      registry.registerHandsOffPolicy(policy({ siteId: 'skip', hosts: ['a.b.other.barred.example.test'], handsOff: false }))
    ).toThrow('"a.b.other.barred.example.test" (policy "skip") sits under "barred.example.test" (policy "barred")');
  });

  it('checks every policy below a new parent, at any depth', () => {
    const registry = createExtractionRegistry();
    registry.registerHandsOffPolicy(policy({ siteId: 'fine', hosts: ['fine.barred.example.test'] }));
    registry.registerHandsOffPolicy(policy({ siteId: 'deep', hosts: ['x.y.barred.example.test'], handsOff: false }));

    expect(() => registry.registerHandsOffPolicy(barred())).toThrow('"x.y.barred.example.test" (policy "deep") sits under "barred.example.test"');
    expect(registry.handsOffView().map(v => v.siteId)).toEqual(['fine', 'deep']);
  });

  it('accepts a subdomain policy as strict as or stricter than its parent, and a parent no stricter than its children', () => {
    const registry = createExtractionRegistry();
    registry.registerHandsOffPolicy(barred());
    registry.registerHandsOffPolicy(shop({ handsOff: true }));
    registry.registerHandsOffPolicy(denied({ handsOff: false }));
    registry.registerHandsOffPolicy(policy({ siteId: 'store', hosts: ['www.denied.example.test'], handsOff: true, denied: true }));
    registry.registerHandsOffPolicy(policy({ siteId: 'open', hosts: ['open.example.test'], handsOff: false }));
    registry.registerHandsOffPolicy(policy({ siteId: 'covers', hosts: ['example.test'], handsOff: false }));

    expect(registry.handsOffView().map(v => v.siteId)).toEqual(['barred', 'shop', null, 'store', 'open', 'covers']);
    expect(registry.handsOffPolicyFor('https://shop.barred.example.test/')?.handsOff).toBe(true);
    expect(registry.handsOffPolicyFor('https://www.denied.example.test/')?.denied).toBe(true);
  });

  it('does not treat a look-alike or a sibling as a parent or a child, whichever is registered first', () => {
    const weaker = [
      ['lookalike', 'notbarred.example.test'],
      ['suffix', 'shop.barredexample.test'],
      ['sibling', 'shop.other.example.test'],
    ].map(([siteId, host]) => policy({ siteId, hosts: [host], handsOff: false }));

    const strictFirst = createExtractionRegistry();
    strictFirst.registerHandsOffPolicy(barred());
    for (const p of weaker) strictFirst.registerHandsOffPolicy(p);
    expect(strictFirst.handsOffView()).toHaveLength(4);

    const strictLast = createExtractionRegistry();
    for (const p of weaker) strictLast.registerHandsOffPolicy(p);
    strictLast.registerHandsOffPolicy(barred());
    expect(strictLast.handsOffView()).toHaveLength(4);
  });

  it('lets one policy list a host and its own subdomain', () => {
    const registry = createExtractionRegistry();
    registry.registerHandsOffPolicy(barred({ hosts: ['barred.example.test', 'www.barred.example.test'] }));

    expect(registry.handsOffPolicyFor('https://www.barred.example.test/')?.siteId).toBe('barred');
  });
});
