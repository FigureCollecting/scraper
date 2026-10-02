import path from 'path';
import os from 'os';
import { promises as fsPromises, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { jest } from '@jest/globals';
import { discoverPluginCandidates, discoverPlugins, resolvePluginExport } from '../../services/pluginLoader';

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

/**
 * A package that advertises the keyword but does not load is not simply absent: the engine came up
 * WITHOUT a plugin it was given. discoverPluginCandidates returns those candidates beside the plugins,
 * named from their package.json, so the bootstrap can list them as refused and hold the durable queue.
 */
describe('discoverPluginCandidates', () => {
  it('returns the same plugins as discoverPlugins, and the candidates that did not load beside them', async () => {
    const { plugins, failed } = await discoverPluginCandidates({ nodeModulesDir: FIXTURES_DIR });

    expect(plugins.map(p => p.name).sort()).toEqual((await discoverPlugins({ nodeModulesDir: FIXTURES_DIR })).map(p => p.name).sort());
    expect(failed.map(f => f.name).sort()).toEqual(['broken-plugin', 'missing-entry-plugin', 'throwing-entry-plugin']);
    // A package without the keyword is not a candidate at all, so it is not a failed one either.
    expect(failed.find(f => f.name === 'not-a-ruleset')).toBeUndefined();
  });

  it('reports a candidate whose entry file throws as it is imported', async () => {
    const { failed } = await discoverPluginCandidates({ nodeModulesDir: FIXTURES_DIR });

    expect(failed.find(f => f.name === 'throwing-entry-plugin')).toEqual({
      name: 'throwing-entry-plugin',
      version: '4.0.0',
      dir: path.join(FIXTURES_DIR, 'throwing-entry-plugin'),
      reason: 'import_failed',
    });
  });

  it('reports a candidate whose entry file is missing', async () => {
    const { failed } = await discoverPluginCandidates({ nodeModulesDir: FIXTURES_DIR });

    expect(failed.find(f => f.name === 'missing-entry-plugin')).toEqual({
      name: 'missing-entry-plugin',
      version: '1.0.0',
      dir: path.join(FIXTURES_DIR, 'missing-entry-plugin'),
      reason: 'import_failed',
    });
  });

  it('reports a candidate that imports but fails the ScraperPlugin shape check', async () => {
    const { failed } = await discoverPluginCandidates({ nodeModulesDir: FIXTURES_DIR });

    expect(failed.find(f => f.name === 'broken-plugin')).toEqual({
      name: 'broken-plugin',
      version: '1.0.0',
      dir: path.join(FIXTURES_DIR, 'broken-plugin'),
      reason: 'not_a_plugin',
    });
  });

  it('names a candidate whose package.json has no usable name or version by its directory and "unknown"', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'plugin-loader-'));
    try {
      const write = (rel: string, pkg: Record<string, unknown>) => {
        mkdirSync(path.join(dir, rel), { recursive: true });
        writeFileSync(path.join(dir, rel, 'package.json'), JSON.stringify({ main: 'gone.js', keywords: ['scraper-ruleset'], ...pkg }));
      };
      write('nameless', {});
      write(path.join('@anon', 'blank'), { name: '', version: 7 });

      const { plugins, failed } = await discoverPluginCandidates({ nodeModulesDir: dir });

      expect(plugins).toEqual([]);
      expect(failed.map(({ name, version, reason }) => [name, version, reason]).sort()).toEqual([
        ['@anon/blank', 'unknown', 'import_failed'],
        ['nameless', 'unknown', 'import_failed'],
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * One package's package.json must not take the scan down with it. `keywords` is an array by the
   * package.json spec, but any package in the directory can carry anything there; a non-array is not
   * the plugin keyword, and a string is not searched for it as a substring. A candidate whose `main`
   * is not a path fails to import like any other candidate whose entry file will not load.
   */
  describe('a package.json of an unexpected shape', () => {
    let dir: string;
    const write = (rel: string, pkg: Record<string, unknown>, entry?: string) => {
      mkdirSync(path.join(dir, rel), { recursive: true });
      writeFileSync(path.join(dir, rel, 'package.json'), JSON.stringify(pkg));
      if (entry !== undefined) writeFileSync(path.join(dir, rel, 'index.js'), entry);
    };
    const OK_PLUGIN = "module.exports = { name: 'ok-plugin', version: '1.0.0', register: async () => {} };";
    beforeEach(() => {
      dir = mkdtempSync(path.join(os.tmpdir(), 'plugin-loader-shape-'));
      write('zz-ok-plugin', { name: 'ok-plugin', version: '1.0.0', main: 'index.js', keywords: ['scraper-ruleset'] }, OK_PLUGIN);
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it.each([
      ['a number', 7],
      ['an object', { 0: 'scraper-ruleset' }],
      ['null', null],
    ])('skips a package whose keywords is %s, and still loads the plugins beside it', async (_label, keywords) => {
      write('aaa-unrelated', { name: 'aaa-unrelated', version: '1.0.0', main: 'gone.js', keywords });
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

      const { plugins, failed } = await discoverPluginCandidates({ nodeModulesDir: dir });

      expect(plugins.map(p => p.name)).toEqual(['ok-plugin']);
      expect(failed).toEqual([]);
      warnSpy.mockRestore();
    });

    it('does not treat a keywords string that merely contains the keyword as the keyword', async () => {
      write('aaa-stringy', { name: 'aaa-stringy', version: '1.0.0', main: 'gone.js', keywords: 'not-a-scraper-ruleset-package' });
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

      const { plugins, failed } = await discoverPluginCandidates({ nodeModulesDir: dir });

      expect(plugins.map(p => p.name)).toEqual(['ok-plugin']);
      expect(failed).toEqual([]);
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('reports a candidate whose main is not a string as failing to import, and still loads the plugins beside it', async () => {
      write('aaa-bad-main', { name: 'aaa-bad-main', version: '2.0.0', main: 7, keywords: ['scraper-ruleset'] });
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

      const { plugins, failed } = await discoverPluginCandidates({ nodeModulesDir: dir });

      expect(plugins.map(p => p.name)).toEqual(['ok-plugin']);
      expect(failed).toEqual([{ name: 'aaa-bad-main', version: '2.0.0', dir: path.join(dir, 'aaa-bad-main'), reason: 'import_failed' }]);
      expect(String(warnSpy.mock.calls[0]?.[0])).toBe(`[PLUGIN LOADER] Failed to import candidate plugin at ${path.join(dir, 'aaa-bad-main')}:`);
      warnSpy.mockRestore();
    });
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
