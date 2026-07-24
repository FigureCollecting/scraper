/**
 * Fixture: a plugin compiled the way tsc emits `export default plugin` to
 * CommonJS — `exports.default = plugin` plus named exports and the
 * `__esModule` marker. This is the exact shape of the real published ruleset
 * artifact. Node's ESM import of a CJS module wraps the ENTIRE
 * `module.exports` as the namespace's `default`, so the plugin object lands
 * at `mod.default.default` — the loader must unwrap that second level.
 */
'use strict';
Object.defineProperty(exports, '__esModule', { value: true });
exports.shutdown = exports.registerRoutes = exports.register = void 0;

const register = async (registry, context) => {
  context.logger.info('cjs default-export plugin registered');
};
exports.register = register;

const registerRoutes = router => {
  router.get('/cjs-default/ping', (req, res) => {
    res.json({ ok: true, plugin: 'cjs-default-export-ruleset' });
  });
};
exports.registerRoutes = registerRoutes;

const shutdown = async () => {
  // no-op
};
exports.shutdown = shutdown;

const plugin = {
  name: 'cjs-default-export-ruleset',
  version: '3.0.0',
  register,
  registerRoutes,
  shutdown,
};
exports.default = plugin;
