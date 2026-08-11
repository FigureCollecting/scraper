/**
 * engineResolve — wires the byId CONFIRM runtime (assembleResolve) to the engine's registry + a
 * detail fetch. Mirrors createEngineLookup: the ProfileRegistry is built from the plugin-populated
 * `allStores()`, rulesets resolve via `getRulesetForUrl`, and `fetchDetail` is the pooled
 * ScrapingService's scrapePage (wired at the mount). Result: a ready `Resolve` the /resolve route calls.
 */
import { buildProfileRegistry } from '../driver/profileRegistry.js';
import { assembleResolve, type Resolve } from '../driver/assembleResolve.js';
import type { LookupRegistry } from './engineLookup.js';

/** Build the byId-confirm Resolve from the engine's registered stores + a detail fetch. */
export function createEngineResolve(
  registry: LookupRegistry,
  fetchDetail: (url: string) => Promise<{ html: string; statusCode?: number }>,
): Resolve {
  const profiles = buildProfileRegistry(registry.allStores());
  return assembleResolve({ profiles, getRulesetForUrl: (url) => registry.getRulesetForUrl(url), fetchDetail });
}
