/**
 * Integration test for the plugin bootstrap seam: discovers/registers
 * plugins against a real Express app and asserts a mock plugin's routes
 * actually mount and respond, and that shutdown hooks are wired correctly.
 */
import path from 'path';
import request from 'supertest';
import express from 'express';
import { jest } from '@jest/globals';
import { bootstrapPlugins, shutdownPlugins } from '../../services/pluginBootstrap';
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
