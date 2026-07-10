/**
 * Fixture: a well-formed mock ScraperPlugin used by pluginLoader.test.ts and
 * pluginBootstrap.test.ts. Deliberately plain CommonJS (no site-specific
 * logic) so it can stand in for any real plugin package.
 */
module.exports = {
  name: 'mock-scraper-ruleset',
  version: '1.0.0',

  async register(registry, context) {
    context.logger.info('mock plugin registered');

    registry.registerSite({
      siteId: 'mock',
      name: 'Mock Site',
      domains: ['mock.example.test'],
      rateLimit: {
        domain: 'mock.example.test',
        baseDelayMs: 1000,
        minDelayMs: 500,
        maxDelayMs: 5000,
        backoffMultiplier: 1.5,
        recoveryDivisor: 1.5,
        successThreshold: 3,
      },
      requiresBrowser: false,
      allowedCookies: [],
    });

    registry.registerRuleset({
      siteId: 'mock',
      version: '1.0.0',
      extract(html, url) {
        return {
          source: { site: 'mock', itemId: '1', url, extractedAt: new Date(), rulesetVersion: '1.0.0' },
          fields: {},
          warnings: [],
        };
      },
      validate() {
        return { valid: true, errors: [], warnings: [] };
      },
    });
  },

  registerRoutes(router) {
    router.get('/mock/ping', (req, res) => {
      res.json({ ok: true, plugin: 'mock-scraper-ruleset' });
    });
  },

  async shutdown() {
    // no-op; presence is what integration tests assert on
  },
};
