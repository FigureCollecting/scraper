import path from 'path';
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
});
