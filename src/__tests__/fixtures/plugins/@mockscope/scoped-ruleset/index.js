/**
 * Fixture: a valid plugin published under a scoped package name, to prove
 * the loader recurses into @scope/* directories under node_modules.
 */
module.exports = {
  name: '@mockscope/scoped-ruleset',
  version: '2.0.0',
  async register(registry, context) {
    context.logger.info('scoped mock plugin registered');
  },
};
