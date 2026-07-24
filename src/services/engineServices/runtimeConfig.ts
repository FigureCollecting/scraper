/**
 * RuntimeConfig adapter — env-backed implementation of the generic
 * RuntimeConfig contract. Dotted keys (e.g. "vndb.apiToken") map to
 * uppercased, underscore-joined env vars (VNDB_APITOKEN). Values that parse
 * as JSON (booleans, numbers, objects) are returned parsed; anything else is
 * returned as the raw string.
 */
import { RuntimeConfig } from '@figurecollecting/scraper-plugin-contract';

function toEnvKey(key: string): string {
  return key.toUpperCase().replace(/[.\-]/g, '_');
}

export class EnvRuntimeConfig implements RuntimeConfig {
  get(key: string): unknown {
    const raw = process.env[toEnvKey(key)];
    if (raw === undefined) return undefined;

    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  getFeatureFlag(site: string, feature: string): boolean {
    const key = toEnvKey(`FEATURE_${site}_${feature}`);
    return process.env[key] === 'true';
  }
}

export function createRuntimeConfig(): RuntimeConfig {
  return new EnvRuntimeConfig();
}
