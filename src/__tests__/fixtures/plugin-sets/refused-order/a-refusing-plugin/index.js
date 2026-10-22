/**
 * Fixture: a well-formed ScraperPlugin that imports fine and then throws in register(), so the
 * bootstrap refuses it while it registers (pluginBootstrap.test.ts, the refused order).
 */
module.exports = {
  name: 'a-refusing-plugin',
  version: '2.0.0',
  async register() {
    throw new Error('a-refusing-plugin refuses to register');
  },
};
