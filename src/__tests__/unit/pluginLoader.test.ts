import path from 'path';
import { promises as fsPromises } from 'fs';
import { jest } from '@jest/globals';
import { discoverPlugins, resolvePluginExport } from '../../services/pluginLoader';

const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'plugins');

describe('discoverPlugins', () => {
  it('discovers a well-formed plugin package advertising the scraper-ruleset keyword', async () => {
    const plugins = await discoverPlugins({ nodeModulesDir: FIXTURES_DIR });

    const mock = plugins.find(p => p.name === 'mock-scraper-ruleset');
    expect(mock).toBeDefined();
    expect(mock!.version).toBe('1.0.0');
    expect(typeof mock!.register).toBe('function');
    expect(typeof mock!.registerRoutes).toBe('function');
    expect(typeof mock!.shutdown).toBe('function');
  });

  it('recurses into scoped (@scope/name) packages under node_modules', async () => {
    const plugins = await discoverPlugins({ nodeModulesDir: FIXTURES_DIR });

    const scoped = plugins.find(p => p.name === '@mockscope/scoped-ruleset');
    expect(scoped).toBeDefined();
    expect(scoped!.version).toBe('2.0.0');
  });

  it('loads a plugin compiled the tsc way: exports.default = plugin with __esModule marker (real artifact shape)', async () => {
    // Regression guard for the real published artifact shape. NOTE: under
    // ts-jest's CommonJS downlevel, import() becomes require()+__importStar,
    // which honors __esModule and masks the native-ESM double-`default`
    // wrapping — so the faithful red/green for the interop bug lives in the
    // resolvePluginExport tests below (exact namespace shapes) and in the
    // real-runtime probe against the built dist.
    const plugins = await discoverPlugins({ nodeModulesDir: FIXTURES_DIR });

    const cjsDefault = plugins.find(p => p.name === 'cjs-default-export-ruleset');
    expect(cjsDefault).toBeDefined();
    expect(cjsDefault!.version).toBe('3.0.0');
    expect(typeof cjsDefault!.register).toBe('function');
    expect(typeof cjsDefault!.registerRoutes).toBe('function');
    expect(typeof cjsDefault!.shutdown).toBe('function');
  });

  it('rejects a package that has the keyword but does not implement the ScraperPlugin contract', async () => {
    const plugins = await discoverPlugins({ nodeModulesDir: FIXTURES_DIR });

    expect(plugins.find(p => p.name === 'broken-plugin')).toBeUndefined();
  });

  it('never imports packages that lack the scraper-ruleset keyword', async () => {
    // not-a-ruleset/index.js throws synchronously if imported — a passing
    // (non-throwing) discoverPlugins call proves it was filtered by
    // package.json keyword before any dynamic import was attempted.
    await expect(discoverPlugins({ nodeModulesDir: FIXTURES_DIR })).resolves.not.toThrow();

    const plugins = await discoverPlugins({ nodeModulesDir: FIXTURES_DIR });
    expect(plugins.find(p => p.name === 'not-a-ruleset')).toBeUndefined();
  });

  it('returns an empty array when the directory does not exist', async () => {
    const plugins = await discoverPlugins({ nodeModulesDir: path.join(FIXTURES_DIR, 'does-not-exist') });
    expect(plugins).toEqual([]);
  });

  it('returns an empty array when node_modules has no candidate packages', async () => {
    const plugins = await discoverPlugins({ nodeModulesDir: path.join(__dirname, '..', 'fixtures') });
    expect(plugins).toEqual([]);
  });

  it('defaults to the real process node_modules directory when none is provided', async () => {
    // Smoke test for the no-args path (defaultNodeModulesDir()) — the repo's
    // real node_modules has no scraper-ruleset packages, so this just
    // proves it scans without throwing and returns an array.
    await expect(discoverPlugins()).resolves.toEqual(expect.any(Array));
  });

  it('skips a scoped package directory whose contents cannot be read, without failing the whole scan', async () => {
    const realReaddir = fsPromises.readdir.bind(fsPromises);
    const spy = jest.spyOn(fsPromises, 'readdir').mockImplementation(((dir: any, opts?: any) => {
      if (typeof dir === 'string' && dir.includes('@mockscope')) {
        return Promise.reject(new Error('EACCES simulated'));
      }
      return realReaddir(dir, opts);
    }) as typeof fsPromises.readdir);

    try {
      const plugins = await discoverPlugins({ nodeModulesDir: FIXTURES_DIR });
      expect(plugins.find(p => p.name === 'mock-scraper-ruleset')).toBeDefined();
      expect(plugins.find(p => p.name === '@mockscope/scoped-ruleset')).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it('skips a candidate whose entry file fails to import (e.g. missing main), without failing the whole scan', async () => {
    const plugins = await discoverPlugins({ nodeModulesDir: FIXTURES_DIR });

    expect(plugins.find(p => p.name === 'missing-entry-plugin')).toBeUndefined();
    // Sibling valid plugins are still discovered.
    expect(plugins.find(p => p.name === 'mock-scraper-ruleset')).toBeDefined();
  });
});

describe('resolvePluginExport', () => {
  const plugin = {
    name: 'shape-test-ruleset',
    version: '9.9.9',
    register: async () => {},
  };

  it('resolves a native ESM default export (namespace.default = plugin)', () => {
    const namespace = { default: plugin };
    expect(resolvePluginExport(namespace)).toBe(plugin);
  });

  it('resolves CJS module.exports = plugin imported as ESM (namespace.default = plugin, lexer-hoisted names)', () => {
    const namespace = { default: plugin, name: plugin.name, register: plugin.register };
    expect(resolvePluginExport(namespace)).toBe(plugin);
  });

  it('resolves the tsc-compiled CJS default export: plugin at namespace.default.default (real artifact shape)', () => {
    // Node's ESM import() of a CJS module exposes the ENTIRE module.exports
    // as the namespace's `default`. For a tsc-compiled `export default plugin`
    // (exports.default = plugin + __esModule marker + named exports), the
    // plugin object therefore lands at namespace.default.default.
    const cjsModuleExports = Object.defineProperty(
      { register: plugin.register, default: plugin },
      '__esModule',
      { value: true }
    );
    const namespace = { __esModule: true, default: cjsModuleExports, register: plugin.register };
    expect(resolvePluginExport(namespace)).toBe(plugin);
  });

  it('resolves a bare plugin object (require-style module.exports seen directly)', () => {
    expect(resolvePluginExport(plugin)).toBe(plugin);
  });

  it('does not unwrap more than one extra level (bounded, no unbounded descent)', () => {
    const triplyNested = { default: { default: { default: plugin } } };
    expect(resolvePluginExport(triplyNested)).toBeNull();
  });

  it('returns null for non-plugin values', () => {
    expect(resolvePluginExport(null)).toBeNull();
    expect(resolvePluginExport(undefined)).toBeNull();
    expect(resolvePluginExport('nope')).toBeNull();
    expect(resolvePluginExport({})).toBeNull();
    expect(resolvePluginExport({ default: { name: 'x' } })).toBeNull();
  });
});
