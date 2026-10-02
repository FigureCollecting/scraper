/**
 * Plugin Loader
 *
 * Scans node_modules for packages that advertise the "scraper-ruleset"
 * keyword in their package.json, dynamic-imports each candidate, and
 * type-guards the result against the ScraperPlugin contract. Generic by
 * design: no site names, no knowledge of any specific ruleset package.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { ScraperPlugin, isScraperPlugin } from '@figurecollecting/scraper-plugin-contract';

const PLUGIN_KEYWORD = 'scraper-ruleset';

export interface DiscoverPluginsOptions {
  /** Directory to scan for candidate packages. Defaults to the process's node_modules. */
  nodeModulesDir?: string;
}

interface CandidatePackageJson {
  name?: unknown;
  version?: unknown;
  main?: string;
  keywords?: unknown;
}

/**
 * A package that advertised the keyword but did not load: its entry file failed to import (it threw,
 * or it is missing), or what it exports is not a ScraperPlugin. The engine came up without it, so the
 * bootstrap lists it as refused rather than as not installed.
 */
export interface FailedPluginCandidate {
  /** package.json `name`; the package's directory under the scanned one when that is not a non-empty string. */
  name: string;
  /** package.json `version`; 'unknown' when that is not a non-empty string. */
  version: string;
  /** The package directory (the loader's warning names it too). */
  dir: string;
  reason: 'import_failed' | 'not_a_plugin';
}

/** What a scan found: the plugins that loaded and the candidates that did not, each in scan order. */
export interface PluginDiscovery {
  plugins: ScraperPlugin[];
  failed: FailedPluginCandidate[];
}

function defaultNodeModulesDir(): string {
  return path.resolve(process.cwd(), 'node_modules');
}

async function readPackageJson(dir: string): Promise<CandidatePackageJson | null> {
  try {
    const raw = await fs.readFile(path.join(dir, 'package.json'), 'utf-8');
    return JSON.parse(raw) as CandidatePackageJson;
  } catch {
    return null;
  }
}

/**
 * List every directory under node_modules that could be a package,
 * expanding one level into @scope/* directories for scoped packages.
 */
async function listCandidateDirs(nodeModulesDir: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(nodeModulesDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const candidates: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    if (entry.name.startsWith('@')) {
      const scopeDir = path.join(nodeModulesDir, entry.name);
      let scopedEntries;
      try {
        scopedEntries = await fs.readdir(scopeDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const scoped of scopedEntries) {
        if (scoped.isDirectory()) {
          candidates.push(path.join(scopeDir, scoped.name));
        }
      }
      continue;
    }

    candidates.push(path.join(nodeModulesDir, entry.name));
  }

  return candidates;
}

/**
 * Resolve the ScraperPlugin object out of a dynamically imported module,
 * tolerating every interop shape a plugin package can compile to:
 *
 * - native ESM `export default plugin`        -> mod.default
 * - CJS `module.exports = plugin`             -> mod.default (Node wraps the
 *   whole module.exports as the namespace's `default`)
 * - CJS `exports.default = plugin` (tsc emit  -> mod.default.default (the
 *   of `export default plugin`)                  namespace's `default` is the
 *                                                entire exports bag, so the
 *                                                plugin sits one level deeper)
 *
 * The second unwrap is bounded: exactly one extra level, only when the first
 * candidate fails the type guard and exposes an object `default` property.
 */
export function resolvePluginExport(mod: unknown): ScraperPlugin | null {
  let candidate: unknown = (mod as { default?: unknown })?.default ?? mod;

  if (!isScraperPlugin(candidate) && candidate !== null && typeof candidate === 'object') {
    const inner = (candidate as { default?: unknown }).default;
    if (inner !== null && typeof inner === 'object') {
      candidate = inner;
    }
  }

  return isScraperPlugin(candidate) ? candidate : null;
}

/** A package.json string field, or undefined when it is missing, not a string, or empty. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

async function importPlugin(packageDir: string, pkg: CandidatePackageJson): Promise<ScraperPlugin | FailedPluginCandidate['reason']> {
  let mod: unknown;
  try {
    // Inside the try: a `main` that is not a string makes path.join throw, and that candidate fails
    // to import like any other whose entry file will not load.
    const entryFile = path.join(packageDir, pkg.main || 'index.js');
    mod = await import(pathToFileURL(entryFile).href);
  } catch (error) {
    console.warn(`[PLUGIN LOADER] Failed to import candidate plugin at ${packageDir}:`, error);
    return 'import_failed';
  }

  const plugin = resolvePluginExport(mod);
  if (!plugin) {
    console.warn(`[PLUGIN LOADER] Skipping ${packageDir}: does not implement the ScraperPlugin contract`);
    return 'not_a_plugin';
  }

  return plugin;
}

/**
 * Scan node_modules (or a provided directory) for packages whose
 * package.json advertises the "scraper-ruleset" keyword, dynamic-import
 * each candidate, and return those that structurally satisfy the
 * ScraperPlugin contract beside those that did not load (logged, never
 * thrown, so a single bad plugin can't take down the engine). A package
 * without the keyword, or with no readable package.json, is not a candidate.
 */
export async function discoverPluginCandidates(options: DiscoverPluginsOptions): Promise<PluginDiscovery> {
  const nodeModulesDir = options.nodeModulesDir ?? defaultNodeModulesDir();
  const candidateDirs = await listCandidateDirs(nodeModulesDir);

  const plugins: ScraperPlugin[] = [];
  const failed: FailedPluginCandidate[] = [];

  for (const dir of candidateDirs) {
    const pkg = await readPackageJson(dir);
    // `keywords` is an array by the package.json spec, but any package here can carry anything there:
    // anything else is not the keyword (and a string is not searched for it as a substring).
    if (!pkg || !Array.isArray(pkg.keywords) || !pkg.keywords.includes(PLUGIN_KEYWORD)) continue;

    const outcome = await importPlugin(dir, pkg);
    if (typeof outcome === 'string') {
      failed.push({
        name: nonEmptyString(pkg.name) ?? path.relative(nodeModulesDir, dir),
        version: nonEmptyString(pkg.version) ?? 'unknown',
        dir,
        reason: outcome,
      });
    } else {
      plugins.push(outcome);
    }
  }

  return { plugins, failed };
}

/** The plugins discoverPluginCandidates finds, without the candidates that did not load. */
export async function discoverPlugins(options: DiscoverPluginsOptions = {}): Promise<ScraperPlugin[]> {
  return (await discoverPluginCandidates(options)).plugins;
}
