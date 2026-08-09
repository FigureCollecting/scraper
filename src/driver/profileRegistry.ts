/**
 * ProfileRegistry — the crawl driver's per-store capability index.
 *
 * Indexes public `StoreCapabilities` by host (every domain) and by siteId, and exposes the
 * three seams the scheduler consumes:
 *   - `rateConfigFor(host)` → HostRateLimiter (a `DomainRateLimit` is structurally a
 *      `HostRateConfig`, so it drops straight in).
 *   - `poolFor(host)`       → PoolRouter — `requiresBrowser` picks the expensive browser/mint
 *      pool vs the cheap fetch pool (the coarse D3 split; a finer mint-vs-fingerprint split can
 *      layer on later without changing this seam).
 *   - `retrievalFor(host)`  → the targeted on-request fetch path (undefined = enumeration-only).
 *
 * Populated by the plugin, which maps each PRIVATE StoreProfile down to public
 * StoreCapabilities at registration — so the engine schedules real stores without ever
 * importing the moat axes.
 */
import type {
  DomainRateLimit,
  RetrievalCapability,
  StoreCapabilities,
} from '@figurecollecting/scraper-plugin-contract';
import type { PoolKind } from './poolRouter.js';

/** Host key: lowercased, trimmed, `www.` stripped, so domain variants collapse to one store. */
const normalizeHost = (host: string): string => host.trim().toLowerCase().replace(/^www\./, '');

export class ProfileRegistry {
  private readonly byHost = new Map<string, StoreCapabilities>();
  private readonly bySite = new Map<string, StoreCapabilities>();

  /** Register (or replace, last-wins) a store's capabilities, indexing all of its domains. */
  register(caps: StoreCapabilities): void {
    this.bySite.set(caps.siteId, caps);
    for (const domain of caps.domains) this.byHost.set(normalizeHost(domain), caps);
  }

  forHost(host: string): StoreCapabilities | undefined {
    return this.byHost.get(normalizeHost(host));
  }

  forSite(siteId: string): StoreCapabilities | undefined {
    return this.bySite.get(siteId);
  }

  all(): StoreCapabilities[] {
    return [...this.bySite.values()];
  }

  size(): number {
    return this.bySite.size;
  }

  /** Per-host rate config for HostRateLimiter (undefined = unmapped host → its default). */
  rateConfigFor(host: string): DomainRateLimit | undefined {
    return this.forHost(host)?.rateLimit;
  }

  /** Pool for PoolRouter: browser-required stores → the browser/mint pool, else the fetch pool. */
  poolFor(host: string): PoolKind | undefined {
    const caps = this.forHost(host);
    return caps ? (caps.requiresBrowser ? 'browser' : 'fetch') : undefined;
  }

  /**
   * Whether a host needs the browser path (CF-fronted / SPA). Routes the lookup's search fetch
   * (browserFetch vs plain HTTP). Unknown host → false: default to the cheap fetch path, never
   * spin up a browser for a store we don't know needs one.
   */
  requiresBrowserFor(host: string): boolean {
    return this.forHost(host)?.requiresBrowser ?? false;
  }

  /** Targeted-retrieval capability for on-request fetches (undefined = enumeration-only). */
  retrievalFor(host: string): RetrievalCapability | undefined {
    return this.forHost(host)?.retrieval;
  }
}

/**
 * Build a ProfileRegistry from the engine's registered stores (ExtractionRegistryImpl.allStores()).
 * Every store is indexed — pool + rate from the SiteConfig base make it schedulable; retrieval
 * rides through for stores whose profile carries it. This is the driver's single population seam.
 */
export function buildProfileRegistry(stores: Iterable<StoreCapabilities>): ProfileRegistry {
  const registry = new ProfileRegistry();
  for (const caps of stores) registry.register(caps);
  return registry;
}
