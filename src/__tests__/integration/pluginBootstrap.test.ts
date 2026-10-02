/**
 * Integration test for the plugin bootstrap seam: discovers/registers
 * plugins against a real Express app and asserts a mock plugin's routes
 * actually mount and respond, and that shutdown hooks are wired correctly.
 */
import path from 'path';
import request from 'supertest';
import express from 'express';
import { jest } from '@jest/globals';
import { bootstrapPlugins, durableQueueHold, pluginsView, shutdownPlugins } from '../../services/pluginBootstrap';
import { ScraperPlugin, ExtractionRegistry, PluginContext, ExpressRouter } from '@figurecollecting/scraper-plugin-contract';

const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'plugins');

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  return app;
}

function buildSpyPlugin(overrides: Partial<ScraperPlugin> = {}): ScraperPlugin {
  return {
    name: 'spy-plugin',
    version: '1.0.0',
    register: jest.fn<ScraperPlugin['register']>().mockResolvedValue(undefined),
    registerRoutes: jest.fn<NonNullable<ScraperPlugin['registerRoutes']>>(),
    shutdown: jest.fn<NonNullable<ScraperPlugin['shutdown']>>().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('bootstrapPlugins', () => {
  it('discovers a real plugin package via node_modules keyword scan and mounts its routes', async () => {
    const app = buildApp();

    const { plugins } = await bootstrapPlugins(app, { nodeModulesDir: FIXTURES_DIR });

    expect(plugins.map(p => p.name)).toContain('mock-scraper-ruleset');

    const response = await request(app).get('/mock/ping');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, plugin: 'mock-scraper-ruleset' });
  });

  it('registers the plugin-provided site into the shared ExtractionRegistry', async () => {
    const app = buildApp();

    const { registry } = await bootstrapPlugins(app, { nodeModulesDir: FIXTURES_DIR });

    expect(registry.getSiteConfigForUrl('https://mock.example.test/item/1')?.siteId).toBe('mock');
    expect(registry.getRulesetForUrl('https://mock.example.test/item/1')?.siteId).toBe('mock');
  });

  it('calls register() with a PluginContext exposing logger/config/services', async () => {
    const app = buildApp();
    const plugin = buildSpyPlugin();

    await bootstrapPlugins(app, { discover: async () => [plugin] });

    expect(plugin.register).toHaveBeenCalledTimes(1);
    const [registry, context] = (plugin.register as jest.Mock).mock.calls[0] as [ExtractionRegistry, PluginContext];

    expect(typeof registry.registerSite).toBe('function');
    expect(typeof registry.registerRuleset).toBe('function');

    expect(typeof context.logger.info).toBe('function');
    expect(typeof context.logger.warn).toBe('function');
    expect(typeof context.logger.error).toBe('function');
    expect(typeof context.logger.debug).toBe('function');

    expect(typeof context.config.get).toBe('function');
    expect(typeof context.config.getFeatureFlag).toBe('function');

    expect(typeof context.services.scraping.scrapePage).toBe('function');
    expect(typeof context.services.queue.enqueue).toBe('function');
    expect(typeof context.services.sessions.getAllSessions).toBe('function');
    expect(typeof context.services.webhooks.notifyItemComplete).toBe('function');
  });

  it('calls registerRoutes() with a router that gets mounted on the app', async () => {
    const app = buildApp();
    const plugin = buildSpyPlugin({
      registerRoutes: jest.fn((router: ExpressRouter) => {
        router.get('/spy/hello', (req: any, res: any) => res.json({ hello: 'spy' }));
      }),
    });

    await bootstrapPlugins(app, { discover: async () => [plugin] });

    expect(plugin.registerRoutes).toHaveBeenCalledTimes(1);
    const response = await request(app).get('/spy/hello');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ hello: 'spy' });
  });

  it('does not fail bootstrap when a plugin has no registerRoutes or shutdown', async () => {
    const app = buildApp();
    const minimalPlugin: ScraperPlugin = {
      name: 'minimal-plugin',
      version: '1.0.0',
      register: jest.fn<ScraperPlugin['register']>().mockResolvedValue(undefined),
    };

    const { plugins } = await bootstrapPlugins(app, { discover: async () => [minimalPlugin] });

    expect(plugins).toHaveLength(1);
  });

  it('skips (does not throw for) a plugin whose register() rejects, and still loads the rest', async () => {
    const app = buildApp();
    const failingPlugin = buildSpyPlugin({
      name: 'failing-plugin',
      register: jest.fn<ScraperPlugin['register']>().mockRejectedValue(new Error('boom')),
    });
    const healthyPlugin = buildSpyPlugin({ name: 'healthy-plugin' });

    const { plugins } = await bootstrapPlugins(app, { discover: async () => [failingPlugin, healthyPlugin] });

    expect(plugins.map(p => p.name)).toEqual(['healthy-plugin']);
  });

  it('shutdownPlugins calls shutdown() on every loaded plugin', async () => {
    const pluginA = buildSpyPlugin({ name: 'a' });
    const pluginB = buildSpyPlugin({ name: 'b' });

    await shutdownPlugins([pluginA, pluginB]);

    expect(pluginA.shutdown).toHaveBeenCalledTimes(1);
    expect(pluginB.shutdown).toHaveBeenCalledTimes(1);
  });

  it('shutdownPlugins tolerates one plugin rejecting and still shuts down the others', async () => {
    const pluginA = buildSpyPlugin({
      name: 'a',
      shutdown: jest.fn<NonNullable<ScraperPlugin['shutdown']>>().mockRejectedValue(new Error('shutdown failed')),
    });
    const pluginB = buildSpyPlugin({ name: 'b' });

    await expect(shutdownPlugins([pluginA, pluginB])).resolves.not.toThrow();
    expect(pluginB.shutdown).toHaveBeenCalledTimes(1);
  });

  it('shutdownPlugins skips plugins with no shutdown() without error', async () => {
    const minimalPlugin: ScraperPlugin = {
      name: 'minimal-plugin',
      version: '1.0.0',
      register: jest.fn<ScraperPlugin['register']>().mockResolvedValue(undefined),
    };

    await expect(shutdownPlugins([minimalPlugin])).resolves.not.toThrow();
  });
});

describe('bootstrapPlugins PLUGIN_DIR environment override', () => {
  const ORIGINAL_PLUGIN_DIR = process.env.PLUGIN_DIR;

  afterEach(() => {
    if (ORIGINAL_PLUGIN_DIR === undefined) {
      delete process.env.PLUGIN_DIR;
    } else {
      process.env.PLUGIN_DIR = ORIGINAL_PLUGIN_DIR;
    }
  });

  it('scans the directory named by PLUGIN_DIR when no nodeModulesDir option is given', async () => {
    process.env.PLUGIN_DIR = FIXTURES_DIR;
    const app = buildApp();

    const { plugins } = await bootstrapPlugins(app);

    expect(plugins.map(p => p.name)).toContain('mock-scraper-ruleset');
  });

  it('falls back to default discovery (process node_modules) when PLUGIN_DIR is unset', async () => {
    delete process.env.PLUGIN_DIR;
    const app = buildApp();

    const { plugins } = await bootstrapPlugins(app);

    // The repo's real node_modules contains no scraper-ruleset packages.
    expect(plugins.map(p => p.name)).not.toContain('mock-scraper-ruleset');
  });

  it('treats an empty PLUGIN_DIR as unset', async () => {
    process.env.PLUGIN_DIR = '';
    const app = buildApp();

    const { plugins } = await bootstrapPlugins(app);

    expect(plugins.map(p => p.name)).not.toContain('mock-scraper-ruleset');
  });

  it('lets an explicit nodeModulesDir option take precedence over PLUGIN_DIR', async () => {
    process.env.PLUGIN_DIR = path.join(FIXTURES_DIR, 'does-not-exist');
    const app = buildApp();

    const { plugins } = await bootstrapPlugins(app, { nodeModulesDir: FIXTURES_DIR });

    expect(plugins.map(p => p.name)).toContain('mock-scraper-ruleset');
  });
});

/**
 * The hands-off surface across the plugin seam (contract 0.17.0). Every new registry method is
 * optional, so an older plugin registers nothing and still loads, and a newer plugin's registrations
 * reach the same registry the engine reads (/health/detailed's handsOff, the diag probes).
 */
describe('bootstrapPlugins — hands-off registrations', () => {
  const HANDS_OFF_SUMMARY = {
    tier: 'FULL_BAR' as const,
    namedTokens: ['examplebot'],
    fullBarTokens: ['examplebot'],
    routeBarTokens: [],
    crawlDelayTokens: [],
    contentSignals: [],
  };

  it('loads an older plugin (the fixture package predates the surface) with no policy and no classifier', async () => {
    const app = buildApp();

    const { registry, plugins } = await bootstrapPlugins(app, { nodeModulesDir: FIXTURES_DIR });

    expect(plugins.map(p => p.name)).toContain('mock-scraper-ruleset');
    expect(registry.getSiteConfigForUrl('https://mock.example.test/item/1')?.siteId).toBe('mock');
    expect(registry.handsOffView()).toEqual([]);
    expect(registry.robotsClassifier()).toBeUndefined();
    expect(registry.requiredCookiesFor('mock.example.test')).toBeUndefined();
  });

  it("delivers a newer plugin's policy, classifier and required cookies to the engine registry", async () => {
    const app = buildApp();
    const plugin = buildSpyPlugin({
      name: 'hands-off-plugin',
      register: async (registry: ExtractionRegistry) => {
        registry.registerSite({
          siteId: 'guarded',
          name: 'Guarded',
          domains: ['guarded.example.test'],
          rateLimit: { domain: 'guarded.example.test', baseDelayMs: 1000, minDelayMs: 500, maxDelayMs: 5000, backoffMultiplier: 1.5, recoveryDivisor: 1.5, successThreshold: 3 },
          requiresBrowser: false,
          allowedCookies: ['cf_clearance', 'session'],
          requiredCookies: ['cf_clearance', 'session'],
        });
        registry.registerHandsOffPolicy?.({
          siteId: 'guarded',
          hosts: ['guarded.example.test'],
          handsOff: true,
          tier: 'FULL_BAR',
          summary: HANDS_OFF_SUMMARY,
          pins: [],
          routeSamples: [],
          policyVersion: 'policy-test',
        });
        registry.registerRobotsClassifier?.({ tokenListDate: '2026-09-29', classify: () => HANDS_OFF_SUMMARY });
      },
    });

    const { registry, plugins } = await bootstrapPlugins(app, { discover: async () => [plugin] });

    expect(plugins.map(p => p.name)).toEqual(['hands-off-plugin']);
    expect(registry.handsOffPolicyFor('https://www.guarded.example.test/item/1')?.handsOff).toBe(true);
    expect(registry.robotsClassifier()?.tokenListDate).toBe('2026-09-29');
    expect(registry.requiredCookiesFor('guarded.example.test')).toEqual(['cf_clearance', 'session']);
  });

  it('skips a plugin whose policy claims a host another plugin already holds, keeping the first policy', async () => {
    const app = buildApp();
    const claim = (name: string, siteId: string, handsOff: boolean) =>
      buildSpyPlugin({
        name,
        register: async (registry: ExtractionRegistry) => {
          registry.registerHandsOffPolicy?.({
            siteId,
            hosts: ['contested.example.test'],
            handsOff,
            tier: 'FULL_BAR',
            summary: HANDS_OFF_SUMMARY,
            pins: [],
            routeSamples: [],
            policyVersion: 'policy-test',
          });
        },
      });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const { registry, plugins } = await bootstrapPlugins(app, {
      discover: async () => [claim('first', 'first-site', true), claim('second', 'second-site', false)],
    });

    expect(plugins.map(p => p.name)).toEqual(['first']);
    expect(registry.handsOffPolicyFor('https://contested.example.test/')?.siteId).toBe('first-site');
    expect(registry.handsOffPolicyFor('https://contested.example.test/')?.handsOff).toBe(true);
    expect(String(errorSpy.mock.calls[0]?.[1])).toContain('"contested.example.test"');
  });
});

/**
 * A plugin is loaded whole or not at all. Its registry calls are staged and committed only once
 * register() and registerRoutes() have both succeeded, so a refused hands-off policy can never leave
 * the plugin's stores live (crawled, scraped, looked up) without it, nor a partial policy list.
 */
describe('bootstrapPlugins — a plugin is loaded whole or not at all', () => {
  const SUMMARY = { tier: 'FULL_BAR' as const, namedTokens: [], fullBarTokens: [], routeBarTokens: [], crawlDelayTokens: [], contentSignals: [] };
  const handsOffPolicy = (siteId: string, host: string, handsOff = true) => ({
    siteId,
    hosts: [host],
    handsOff,
    tier: 'FULL_BAR' as const,
    summary: SUMMARY,
    pins: [],
    routeSamples: [],
    policyVersion: 'policy-test',
  });
  const storeSite = (siteId: string, domain: string) => ({
    siteId,
    name: siteId,
    domains: [domain],
    rateLimit: { domain, baseDelayMs: 1000, minDelayMs: 500, maxDelayMs: 5000, backoffMultiplier: 1.5, recoveryDivisor: 1.5, successThreshold: 3 },
    requiresBrowser: false,
    allowedCookies: [],
  });
  const storeRuleset = (siteId: string) => ({ siteId, version: '1', extract: () => ({}) }) as unknown as Parameters<ExtractionRegistry['registerRuleset']>[0];
  const routeOf = (path: string) => (router: ExpressRouter) => {
    router.get(path, (_req: any, res: any) => res.json({ ok: true }));
  };

  let errorSpy: ReturnType<typeof jest.spyOn>;
  beforeEach(() => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => errorSpy.mockRestore());

  it('keeps none of the sites, rulesets, policies, classifier or routes of a plugin whose policy is refused after it registered sites', async () => {
    const app = buildApp();
    const halfPlugin = buildSpyPlugin({
      name: 'half-plugin',
      register: async (registry: ExtractionRegistry) => {
        registry.registerSite(storeSite('barred', 'barred.example.test'));
        registry.registerSite(storeSite('other', 'other.example.test'));
        registry.registerRuleset(storeRuleset('barred'));
        registry.registerRobotsClassifier?.({ tokenListDate: '2026-09-29', classify: () => SUMMARY });
        registry.registerHandsOffPolicy?.(handsOffPolicy('other', 'other.example.test', false));
        registry.registerHandsOffPolicy?.(handsOffPolicy('typo', 'barred.example.test:443'));
        registry.registerHandsOffPolicy?.(handsOffPolicy('barred', 'barred.example.test'));
      },
      registerRoutes: jest.fn(routeOf('/half/ping')),
    });
    const healthyPlugin = buildSpyPlugin({
      name: 'healthy-plugin',
      register: async (registry: ExtractionRegistry) => {
        registry.registerSite(storeSite('healthy', 'healthy.example.test'));
        registry.registerHandsOffPolicy?.(handsOffPolicy('healthy', 'healthy.example.test'));
      },
      registerRoutes: jest.fn(routeOf('/healthy/ping')),
    });

    const { registry, plugins } = await bootstrapPlugins(app, { discover: async () => [halfPlugin, healthyPlugin] });

    expect(plugins.map(p => p.name)).toEqual(['healthy-plugin']);
    expect({
      sites: registry.allStores().map(s => s.siteId),
      siteForBarred: registry.getSiteConfigForUrl('https://barred.example.test/item/1')?.siteId,
      rulesetForBarred: registry.getRulesetForUrl('https://barred.example.test/item/1')?.siteId,
      policies: registry.handsOffView().map(v => v.siteId),
      classifier: registry.robotsClassifier(),
    }).toEqual({ sites: ['healthy'], siteForBarred: undefined, rulesetForBarred: undefined, policies: ['healthy'], classifier: undefined });
    expect((await request(app).get('/half/ping')).status).toBe(404);
    expect((await request(app).get('/healthy/ping')).status).toBe(200);
    expect(String(errorSpy.mock.calls[0]?.[0])).toBe(
      '[PLUGIN BOOTSTRAP] Failed to register plugin "half-plugin"; none of its sites, rulesets, policies or routes were kept:'
    );
    expect(String(errorSpy.mock.calls[0]?.[1])).toContain('"barred.example.test:443" is not a DNS hostname');
  });

  it('does not load a plugin that catches its refused policy and carries on', async () => {
    const app = buildApp();
    const swallowing = buildSpyPlugin({
      name: 'swallowing-plugin',
      register: async (registry: ExtractionRegistry) => {
        registry.registerSite(storeSite('barred', 'barred.example.test'));
        try {
          registry.registerHandsOffPolicy?.(handsOffPolicy('barred', '*.barred.example.test'));
        } catch {
          // carries on without its policy
        }
      },
      registerRoutes: jest.fn(routeOf('/swallowing/ping')),
    });

    const { registry, plugins } = await bootstrapPlugins(app, { discover: async () => [swallowing] });

    expect(plugins).toEqual([]);
    expect(registry.allStores()).toEqual([]);
    expect((await request(app).get('/swallowing/ping')).status).toBe(404);
    expect(String(errorSpy.mock.calls[0]?.[1])).toContain('plugin registration refused');
  });

  it('keeps nothing of a plugin whose register() rejects after it registered a site, or whose registerRoutes() throws', async () => {
    const app = buildApp();
    let kept: ExtractionRegistry | undefined;
    const rejects = buildSpyPlugin({
      name: 'rejects-plugin',
      register: async (registry: ExtractionRegistry) => {
        kept = registry;
        registry.registerSite(storeSite('rejected', 'rejected.example.test'));
        throw new Error('ruleset constructor failed');
      },
    });
    const badRoutes = buildSpyPlugin({
      name: 'bad-routes-plugin',
      register: async (registry: ExtractionRegistry) => {
        registry.registerSite(storeSite('routeless', 'routeless.example.test'));
        registry.registerHandsOffPolicy?.(handsOffPolicy('routeless', 'routeless.example.test'));
      },
      registerRoutes: jest.fn((router: ExpressRouter) => {
        router.get('/routeless/ping', (_req: any, res: any) => res.json({ ok: true }));
        throw new Error('route table failed');
      }),
    });

    const { registry, plugins } = await bootstrapPlugins(app, { discover: async () => [rejects, badRoutes] });

    expect(plugins).toEqual([]);
    expect(registry.allStores()).toEqual([]);
    expect(registry.handsOffView()).toEqual([]);
    expect((await request(app).get('/routeless/ping')).status).toBe(404);
    // A failed plugin that kept its registry (a timer, a late callback) cannot register later either.
    expect(() => kept?.registerSite(storeSite('late', 'late.example.test'))).toThrow('plugin registration was discarded');
    expect(registry.allStores()).toEqual([]);
  });

  it('refuses a call made after the plugin has loaded, so a late policy never takes effect', async () => {
    const app = buildApp();
    let kept: ExtractionRegistry | undefined;
    const late = buildSpyPlugin({
      name: 'late-plugin',
      register: async (registry: ExtractionRegistry) => {
        kept = registry;
        registry.registerSite(storeSite('guarded', 'guarded.example.test'));
      },
    });

    const { registry, plugins } = await bootstrapPlugins(app, { discover: async () => [late] });

    expect(plugins.map(p => p.name)).toEqual(['late-plugin']);
    // A valid policy and a malformed one alike: after the plugin has loaded, neither applies.
    expect(() => kept?.registerHandsOffPolicy?.(handsOffPolicy('guarded', 'guarded.example.test'))).toThrow(
      'plugin registration is closed: the plugin has loaded, so a registry call made after its register() resolved takes no effect'
    );
    expect(() => kept?.registerHandsOffPolicy?.(handsOffPolicy('guarded', 'guarded.example.test:443'))).toThrow('plugin registration is closed');
    expect(() => kept?.registerSite(storeSite('later', 'later.example.test'))).toThrow('plugin registration is closed');
    expect(registry.handsOffView()).toEqual([]);
    expect(registry.allStores().map(s => s.siteId)).toEqual(['guarded']);
  });

  it('hands register() only the four registry methods, so a plugin cannot commit its own registration early', async () => {
    const app = buildApp();
    let handedKeys: string[] = [];
    const early = buildSpyPlugin({
      name: 'early-plugin',
      register: async (registry: ExtractionRegistry) => {
        handedKeys = Object.keys(registry).sort();
        registry.registerSite(storeSite('barred', 'barred.example.test'));
        (registry as unknown as { commit?: () => void }).commit?.();
        try {
          registry.registerHandsOffPolicy?.(handsOffPolicy('barred', 'barred.example.test:443'));
        } catch {
          // swallowed, after trying to commit early
        }
      },
    });

    const { registry, plugins, refused } = await bootstrapPlugins(app, { discover: async () => [early] });

    expect(handedKeys).toEqual(['registerHandsOffPolicy', 'registerRobotsClassifier', 'registerRuleset', 'registerSite']);
    expect(plugins).toEqual([]);
    expect(refused.map(p => p.name)).toEqual(['early-plugin']);
    expect(registry.allStores()).toEqual([]);
    expect(String(errorSpy.mock.calls[0]?.[1])).toContain('plugin registration refused');
  });

  it('loads a plugin that registers only sites after another plugin registered the classifier', async () => {
    const app = buildApp();
    const classifying = buildSpyPlugin({
      name: 'classifying-plugin',
      register: async (registry: ExtractionRegistry) => {
        registry.registerRobotsClassifier?.({ tokenListDate: '2026-09-29', classify: () => SUMMARY });
      },
    });
    const sitesOnly = buildSpyPlugin({
      name: 'sites-only-plugin',
      register: async (registry: ExtractionRegistry) => {
        registry.registerSite(storeSite('beta', 'beta.example.test'));
      },
    });

    const { registry, plugins, refused } = await bootstrapPlugins(app, { discover: async () => [classifying, sitesOnly] });

    expect(plugins.map(p => p.name)).toEqual(['classifying-plugin', 'sites-only-plugin']);
    expect(refused).toEqual([]);
    expect(registry.getSiteConfigForUrl('https://beta.example.test/')?.siteId).toBe('beta');
    expect(registry.robotsClassifier()?.tokenListDate).toBe('2026-09-29');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('returns the refused plugins beside the loaded ones, in discovery order', async () => {
    const app = buildApp();
    const refusing = (name: string) =>
      buildSpyPlugin({
        name,
        version: `${name.length}.0.0`,
        register: async (registry: ExtractionRegistry) => {
          registry.registerHandsOffPolicy?.(handsOffPolicy(name, `${name}.example.test:443`));
        },
      });
    const healthy = buildSpyPlugin({
      name: 'healthy',
      register: async (registry: ExtractionRegistry) => registry.registerSite(storeSite('healthy', 'healthy.example.test')),
    });

    const result = await bootstrapPlugins(app, { discover: async () => [refusing('first'), healthy, refusing('third')] });

    expect(result.plugins.map(p => p.name)).toEqual(['healthy']);
    expect(result.refused.map(p => p.name)).toEqual(['first', 'third']);
    expect(pluginsView(result)).toEqual({
      loaded: [{ name: 'healthy', version: '1.0.0' }],
      refused: [{ name: 'first', version: '5.0.0' }, { name: 'third', version: '5.0.0' }],
    });
  });
});

/**
 * The durable scrape queue is restored only into a registry that came up whole. A restored row whose
 * store has no ruleset fails EXTRACTION_UNAVAILABLE, which is terminal, and is deleted from disk; so
 * when a plugin was refused, or no store registered at all, index.ts holds the queue instead.
 */
describe('durableQueueHold and pluginsView', () => {
  const site = (siteId: string) => ({
    siteId,
    name: siteId,
    domains: [`${siteId}.example.test`],
    rateLimit: { domain: `${siteId}.example.test`, baseDelayMs: 1000, minDelayMs: 500, maxDelayMs: 5000, backoffMultiplier: 1.5, recoveryDivisor: 1.5, successThreshold: 3 },
    requiresBrowser: false,
    allowedCookies: [],
  });
  const plugin = (name: string, sites: string[], refuse = false) =>
    buildSpyPlugin({
      name,
      register: async (registry: ExtractionRegistry) => {
        for (const siteId of sites) registry.registerSite(site(siteId));
        if (refuse) throw new Error(`${name} failed`);
      },
    });
  let errorSpy: ReturnType<typeof jest.spyOn>;
  beforeEach(() => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => errorSpy.mockRestore());

  it('lets the queue restore when every plugin loaded and at least one store registered', async () => {
    const result = await bootstrapPlugins(buildApp(), { discover: async () => [plugin('a', ['alpha']), plugin('b', [])] });

    expect(durableQueueHold(result)).toBeUndefined();
  });

  it('holds the queue when any plugin was refused, naming every refused plugin, even with other stores live', async () => {
    const result = await bootstrapPlugins(buildApp(), {
      discover: async () => [plugin('a', ['alpha']), plugin('broken-one', ['beta'], true), plugin('broken-two', [], true)],
    });

    expect(result.registry.allStores().map(s => s.siteId)).toEqual(['alpha']);
    expect(durableQueueHold(result)).toBe('plugin(s) refused at startup: broken-one, broken-two');
  });

  it('holds the queue when no store registered (no plugin, or plugins with no sites)', async () => {
    for (const candidates of [[], [plugin('empty', [])]]) {
      const result = await bootstrapPlugins(buildApp(), { discover: async () => candidates });

      expect(durableQueueHold(result)).toBe('no plugin registered a store');
    }
  });

  it('reports no plugins before the bootstrap has run', () => {
    expect(pluginsView(undefined)).toEqual({ loaded: [], refused: [] });
  });
});
