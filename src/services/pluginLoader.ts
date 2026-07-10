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
import { ScraperPlugin, isScraperPlugin } from './pluginTypes.js';

const PLUGIN_KEYWORD = 'scraper-ruleset';

export interface DiscoverPluginsOptions {
  /** Directory to scan for candidate packages. Defaults to the process's node_modules. */
  nodeModulesDir?: string;
}

interface CandidatePackageJson {
  name?: string;
  main?: string;
  keywords?: string[];
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

async function importPlugin(packageDir: string, pkg: CandidatePackageJson): Promise<ScraperPlugin | null> {
  const entryFile = path.join(packageDir, pkg.main || 'index.js');

  let mod: unknown;
  try {
    mod = await import(pathToFileURL(entryFile).href);
  } catch (error) {
    console.warn(`[PLUGIN LOADER] Failed to import candidate plugin at ${packageDir}:`, error);
    return null;
  }

  const candidate = (mod as { default?: unknown })?.default ?? mod;
  if (!isScraperPlugin(candidate)) {
    console.warn(`[PLUGIN LOADER] Skipping ${packageDir}: does not implement the ScraperPlugin contract`);
    return null;
  }

  return candidate;
}

/**
 * Scan node_modules (or a provided directory) for packages whose
 * package.json advertises the "scraper-ruleset" keyword, dynamic-import
 * each candidate, and return only those that structurally satisfy the
 * ScraperPlugin contract. Malformed or non-matching packages are skipped
 * (logged, never thrown) so a single bad plugin can't take down the engine.
 */
export async function discoverPlugins(options: DiscoverPluginsOptions = {}): Promise<ScraperPlugin[]> {
  const nodeModulesDir = options.nodeModulesDir ?? defaultNodeModulesDir();
  const candidateDirs = await listCandidateDirs(nodeModulesDir);

  const plugins: ScraperPlugin[] = [];

  for (const dir of candidateDirs) {
    const pkg = await readPackageJson(dir);
    if (!pkg || !pkg.keywords?.includes(PLUGIN_KEYWORD)) continue;

    const plugin = await importPlugin(dir, pkg);
    if (plugin) {
      plugins.push(plugin);
    }
  }

  return plugins;
}
