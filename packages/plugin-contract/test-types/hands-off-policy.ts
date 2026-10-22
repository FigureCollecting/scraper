/**
 * Type-test fixture: the hands-off surface (contract 0.17.0) — `HandsOffPolicy`, `RobotsClassifier`,
 * `AiBarSummary`, `AiBarTier`, `RobotsPin`, the optional `ExtractionRegistry.registerHandsOffPolicy` /
 * `registerRobotsClassifier`, and `SiteConfig.requiredCookies`. RED before the 0.17.0 bump (none of
 * these exist); GREEN after. `hands-off-old-shape.ts` guards that the older shapes still compile.
 */
import { AI_BAR_TIERS } from '../src/index';
import type {
  AiBarSummary,
  AiBarTier,
  ExtractionRegistry,
  HandsOffPolicy,
  PluginContext,
  RobotsClassifier,
  RobotsPin,
  ScraperPlugin,
  SiteConfig,
} from '../src/index';

const summary: AiBarSummary = {
  tier: 'FULL_BAR',
  namedTokens: ['examplebot'],
  fullBarTokens: ['examplebot'],
  routeBarTokens: [],
  crawlDelayTokens: [],
  contentSignals: ['ai-train=no'],
};

const pin: RobotsPin = {
  url: 'https://www.example.test/robots.txt',
  sha256: '0'.repeat(64),
  fetchedAt: '2026-09-29T00:00:00.000Z',
};

const policy: HandsOffPolicy = {
  siteId: 'examplestore',
  hosts: ['example.test'],
  handsOff: true,
  tier: 'FULL_BAR',
  summary,
  pins: [pin],
  routeSamples: ['https://www.example.test/item/1'],
  policyVersion: 'policy-2026-09-29',
};

// A host-only entry: no siteId (a denied host with no store behind it).
const hostOnly: HandsOffPolicy = {
  hosts: ['denied.example.test'],
  handsOff: true,
  denied: true,
  tier: 'NOT_NAMED',
  summary: { ...summary, tier: 'NOT_NAMED', namedTokens: [], fullBarTokens: [] },
  pins: [],
  routeSamples: [],
  policyVersion: 'policy-2026-09-29',
};

const classifier: RobotsClassifier = {
  tokenListDate: '2026-09-29',
  classify(_body: string, _routeUrls: string[]): AiBarSummary {
    return summary;
  },
};

const site: SiteConfig = {
  siteId: 'examplestore',
  name: 'Example Store',
  domains: ['example.test'],
  rateLimit: {
    domain: 'example.test',
    baseDelayMs: 3000,
    minDelayMs: 1500,
    maxDelayMs: 30000,
    backoffMultiplier: 2,
    recoveryDivisor: 2,
    successThreshold: 3,
  },
  requiresBrowser: false,
  allowedCookies: ['cf_clearance', 'session'],
  requiredCookies: ['cf_clearance', 'session'],
};

// A plugin written for 0.17.0: calls the new methods with `?.`, so an older engine (which lacks
// them) turns each call into a no-op instead of a TypeError.
const newPlugin: ScraperPlugin = {
  name: 'new-plugin',
  version: '1.0.0',
  async register(registry: ExtractionRegistry, _context: PluginContext): Promise<void> {
    registry.registerSite(site);
    registry.registerHandsOffPolicy?.(policy);
    registry.registerHandsOffPolicy?.(hostOnly);
    registry.registerRobotsClassifier?.(classifier);
  },
};

// The plugin's calls MUST be optional calls: an old engine has no such method.
function callsWithoutOptionalChaining(registry: ExtractionRegistry): void {
  // @ts-expect-error — registerHandsOffPolicy is optional (possibly undefined on an older engine)
  registry.registerHandsOffPolicy(policy);
  // @ts-expect-error — registerRobotsClassifier is optional (possibly undefined on an older engine)
  registry.registerRobotsClassifier(classifier);
}

// An engine registry written for 0.17.0 implements both; one without them is still a registry.
const newEngineRegistry: ExtractionRegistry = {
  registerSite(): void {},
  registerRuleset(): void {},
  registerHandsOffPolicy(_policy: HandsOffPolicy): void {},
  registerRobotsClassifier(_classifier: RobotsClassifier): void {},
};
const oldEngineRegistry: ExtractionRegistry = {
  registerSite(): void {},
  registerRuleset(): void {},
};
void newPlugin.register(newEngineRegistry, {} as PluginContext);
void newPlugin.register(oldEngineRegistry, {} as PluginContext);

// Every tier the classifier can return.
const tiers: AiBarTier[] = ['FULL_BAR', 'ROUTE_BAR', 'NAMED_NO_ROUTE_BAR', 'CRAWL_DELAY_ONLY', 'NOT_NAMED', 'UNREADABLE'];

// @ts-expect-error — a tier outside the union is refused
const unknownTier: AiBarTier = 'PARTIAL_BAR';

// The runtime list the engine validates a registered tier against is exactly the union.
const runtimeTiers: readonly AiBarTier[] = AI_BAR_TIERS;
const everyTierListed: (typeof AI_BAR_TIERS)[number][] = tiers;
// @ts-expect-error — the list is read-only: an engine cannot widen it at runtime
AI_BAR_TIERS.push('PARTIAL_BAR');

// @ts-expect-error — `pins` is required: the robots probe reports drift against them
const missingPins: HandsOffPolicy = { hosts: ['example.test'], handsOff: true, tier: 'FULL_BAR', summary, routeSamples: [], policyVersion: 'v' };

// @ts-expect-error — `tier` is an AiBarTier, not any string
const stringTier: HandsOffPolicy = { ...policy, tier: 'PARTIAL_BAR' as string };

// @ts-expect-error — `handsOff` is required: it is the decision itself
const missingHandsOff: HandsOffPolicy = { hosts: ['example.test'], tier: 'FULL_BAR', summary, pins: [], routeSamples: [], policyVersion: 'v' };

// @ts-expect-error — `hosts` is required: a policy names the hosts it covers
const missingHosts: HandsOffPolicy = { handsOff: true, tier: 'FULL_BAR', summary, pins: [], routeSamples: [], policyVersion: 'v' };

// @ts-expect-error — `policyVersion` is required: /health/detailed reports which policy is live
const missingPolicyVersion: HandsOffPolicy = { hosts: ['example.test'], handsOff: true, tier: 'FULL_BAR', summary, pins: [], routeSamples: [] };

const badClassifier: RobotsClassifier = {
  tokenListDate: '2026-09-29',
  // @ts-expect-error — classify returns an AiBarSummary, not a bare tier
  classify(): AiBarTier {
    return 'FULL_BAR';
  },
};

// @ts-expect-error — requiredCookies are cookie NAMES (strings)
const numericRequiredCookies: SiteConfig = { ...site, requiredCookies: [1, 2] };

// @ts-expect-error — `denied` is a boolean when present, never a string a generator wrote
const stringDenied: HandsOffPolicy = { ...policy, denied: 'yes' };

// The classifier a plugin registers is a RobotsClassifier, not any value.
function registersAClassifier(registry: ExtractionRegistry): void {
  // @ts-expect-error — no classify: not a RobotsClassifier
  registry.registerRobotsClassifier?.({ tokenListDate: '2026-09-29' });
}

void callsWithoutOptionalChaining;
void tiers;
void unknownTier;
void runtimeTiers;
void everyTierListed;
void missingPins;
void stringTier;
void missingHandsOff;
void missingHosts;
void missingPolicyVersion;
void badClassifier;
void numericRequiredCookies;
void stringDenied;
void registersAClassifier;
