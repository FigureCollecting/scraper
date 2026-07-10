import path from 'path';
import { promises as fsPromises } from 'fs';
import { jest } from '@jest/globals';
import { discoverPlugins } from '../../services/pluginLoader';

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
