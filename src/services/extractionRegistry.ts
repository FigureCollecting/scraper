/**
 * Extraction Registry
 *
 * The engine-side implementation of the ExtractionRegistry contract. Plugins
 * call registerSite()/registerRuleset() during register(); the engine uses
 * getSiteConfigForUrl()/getRulesetForUrl() to resolve a request's hostname to
 * the plugin-provided site config and ruleset. Pure indexing/lookup — no
 * knowledge of any specific site lives here.
 */

import {
  ExtractionRegistry,
  SiteConfig,
  ExtractionRuleset,
} from './pluginTypes.js';

export class ExtractionRegistryImpl implements ExtractionRegistry {
  private readonly sites = new Map<string, SiteConfig>();
  private readonly rulesets = new Map<string, ExtractionRuleset>();
  /** hostname (lowercased) -> siteId */
  private readonly hostnameIndex = new Map<string, string>();

  registerSite(config: SiteConfig): void {
    this.sites.set(config.siteId, config);
    for (const domain of config.domains) {
      this.hostnameIndex.set(domain.toLowerCase(), config.siteId);
    }
  }

  registerRuleset(ruleset: ExtractionRuleset): void {
    this.rulesets.set(ruleset.siteId, ruleset);
  }

  getSiteConfigForUrl(url: string): SiteConfig | undefined {
    const siteId = this.resolveSiteId(url);
    return siteId ? this.sites.get(siteId) : undefined;
  }

  getRulesetForUrl(url: string): ExtractionRuleset | undefined {
    const siteId = this.resolveSiteId(url);
    return siteId ? this.rulesets.get(siteId) : undefined;
  }

  private resolveSiteId(url: string): string | undefined {
    // Let URL's own validation error propagate — callers get a clear
    // "Invalid URL" failure rather than a silently-undefined match.
    const hostname = new URL(url).hostname.toLowerCase();

    if (this.hostnameIndex.has(hostname)) {
      return this.hostnameIndex.get(hostname);
    }

    // Fall back to registered-domain matching so an unlisted subdomain of a
    // registered domain still resolves (e.g. "cdn.alpha.example.test"
    // matching a registered "alpha.example.test").
    for (const [domain, siteId] of this.hostnameIndex.entries()) {
      if (hostname.endsWith(`.${domain}`)) {
        return siteId;
      }
    }

    return undefined;
  }
}

export function createExtractionRegistry(): ExtractionRegistryImpl {
  return new ExtractionRegistryImpl();
}
