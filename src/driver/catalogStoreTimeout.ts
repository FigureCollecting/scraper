/** Listing-fetch timeout (ms) used when CATALOG_STORE_TIMEOUT_MS is unset/invalid, and the clamp any override rides within. */
const DEFAULT_CATALOG_TIMEOUT_MS = 30000;
const MIN_CATALOG_TIMEOUT_MS = 1000;
const MAX_CATALOG_TIMEOUT_MS = 120000;

/**
 * Resolve the listing-fetch timeout (ms) from the environment. CATALOG_STORE_TIMEOUT_MS overrides the
 * 30s default (a catalog page is a 1.5–2MB body on orzgk — wider than a search hit); a missing,
 * empty, non-numeric, or non-positive value falls back to the default, and any usable value is
 * clamped to [1000, 120000]. Pure (env in → number out) — mirrors resolveLookupStoreTimeoutMs.
 *
 * Its own module (moved from assembleCatalog, which re-exports it) because the host clock reads it
 * too: it is the budget a blocking caller's wait and fetch share (QB-U30b wait cap).
 */
export function resolveCatalogStoreTimeoutMs(env: NodeJS.ProcessEnv): number {
  const n = Number(env.CATALOG_STORE_TIMEOUT_MS);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_CATALOG_TIMEOUT_MS;
  return Math.min(MAX_CATALOG_TIMEOUT_MS, Math.max(MIN_CATALOG_TIMEOUT_MS, n));
}
