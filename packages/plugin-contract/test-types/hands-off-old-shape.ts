/**
 * Type-test fixture: the shapes that predate the hands-off surface (contract 0.17.0) keep compiling
 * unchanged — a plugin that never calls registerHandsOffPolicy / registerRobotsClassifier, a
 * SiteConfig without requiredCookies, and an engine registry that implements neither method. This
 * file imports nothing new, so it must NEVER go red: it is the old-plugin / old-engine guard for
 * `hands-off-policy.ts`.
 */
import type { ExtractionRegistry, PluginContext, ScraperPlugin, SiteConfig } from '../src/index';

const site: SiteConfig = {
  siteId: 'oldstore',
  name: 'Old Store',
  domains: ['old.example.test'],
  rateLimit: {
    domain: 'old.example.test',
    baseDelayMs: 3000,
    minDelayMs: 1500,
    maxDelayMs: 30000,
    backoffMultiplier: 2,
    recoveryDivisor: 2,
    successThreshold: 3,
  },
  requiresBrowser: false,
  allowedCookies: ['session'],
};

// A plugin written before 0.17.0: registers its site and nothing else.
const oldPlugin: ScraperPlugin = {
  name: 'old-plugin',
  version: '1.0.0',
  async register(registry: ExtractionRegistry, _context: PluginContext): Promise<void> {
    registry.registerSite(site);
  },
};

// An engine registry written before 0.17.0: only the two original methods.
const oldEngineRegistry: ExtractionRegistry = {
  registerSite(_config: SiteConfig): void {},
  registerRuleset(): void {},
};

void oldPlugin;
void oldEngineRegistry;
