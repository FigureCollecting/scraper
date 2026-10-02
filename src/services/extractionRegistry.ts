/**
 * Extraction Registry
 *
 * The engine-side implementation of the ExtractionRegistry contract. Plugins
 * call registerSite()/registerRuleset() during register(); the engine uses
 * getSiteConfigForUrl()/getRulesetForUrl() to resolve a request's hostname to
 * the plugin-provided site config and ruleset. Pure indexing/lookup — no
 * knowledge of any specific site lives here.
 *
 * HANDS-OFF SURFACE (plugin contract 0.17.0). A plugin may also register hands-off policies
 * (registerHandsOffPolicy), one robots classifier (registerRobotsClassifier) and each store's
 * required cookie names (SiteConfig.requiredCookies). The engine answers handsOffPolicyFor(url),
 * robotsPinsFor(siteId), robotsClassifier() and requiredCookiesFor(host), and lists the policies on
 * /health/detailed (handsOffView). Both register methods are optional on the contract, so an older
 * plugin registers none of this and the engine reports handsOff [] and no classifier. Which hosts
 * are hands-off is the plugin's data: no host, store or AI token is named here.
 */

import {
  AiBarTier,
  ExtractionRegistry,
  HandsOffPolicy,
  RobotsClassifier,
  RobotsPin,
  SiteConfig,
  StoreCapabilities,
  ExtractionRuleset,
} from '@figurecollecting/scraper-plugin-contract';

/** One registered policy as /health/detailed lists it: the decision and its provenance, no robots detail. */
export interface HandsOffView {
  /** null for a host-only entry. */
  siteId: string | null;
  hosts: string[];
  tier: AiBarTier;
  handsOff: boolean;
  denied: boolean;
  policyVersion: string;
}

/** Characters that make a registered host part of a URL (scheme, port, userinfo, path, query, %-escape). */
const NOT_IN_A_HOSTNAME = /[\s/:@?#\\%]/;
/** One DNS label after IDNA (URL parsing turns a Unicode label into its xn-- form). */
const HOSTNAME_LABEL = /^[a-z0-9_-]+$/;
const IPV4_LITERAL = /^\d+(\.\d+){3}$/;

/** A host as every lookup compares it: lowercase, without trailing dots (`a.test.` is `a.test`). */
function canonicalHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.+$/, '');
}

/**
 * A plugin-registered host in canonical form (IDNA ASCII, lowercase, no trailing dot), or undefined
 * when it is not a DNS hostname of at least two labels: a wildcard, an IP literal, an empty label or
 * anything URL parsing would silently drop (a port, a path, userinfo) is refused, not trimmed.
 */
function normalisePolicyHost(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || NOT_IN_A_HOSTNAME.test(raw)) return undefined;
  let hostname: string;
  try {
    hostname = new URL(`https://${raw}`).hostname;
  } catch {
    return undefined;
  }
  const host = canonicalHost(hostname);
  const labels = host.split('.');
  if (labels.length < 2 || !labels.every(label => HOSTNAME_LABEL.test(label)) || IPV4_LITERAL.test(host)) {
    return undefined;
  }
  return host;
}

function policyLabel(siteId: string | undefined): string {
  return siteId === undefined ? 'a host-only entry' : `policy "${siteId}"`;
}

/** Freeze a plain-data snapshot all the way down. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export class ExtractionRegistryImpl implements ExtractionRegistry {
  // Stored as StoreCapabilities (SiteConfig + optional retrieval): a plain SiteConfig registered
  // via registerSite is a valid StoreCapabilities, and a retrieval-bearing one rides through
  // unchanged — so allStores() can seed the driver's ProfileRegistry without a second registry.
  private readonly sites = new Map<string, StoreCapabilities>();
  private readonly rulesets = new Map<string, ExtractionRuleset>();
  /** hostname (lowercased) -> siteId */
  private readonly hostnameIndex = new Map<string, string>();
  /** Hands-off policies in registration order (frozen snapshots). */
  private readonly policies: HandsOffPolicy[] = [];
  /** canonical host -> the policy that lists it */
  private readonly policyByHost = new Map<string, HandsOffPolicy>();
  /** siteId -> its policy (a host-only entry has no siteId and is reachable by host only) */
  private readonly policyBySite = new Map<string, HandsOffPolicy>();
  private classifier: RobotsClassifier | undefined;

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

  /**
   * Every registered store as public StoreCapabilities — the source the crawl driver builds its
   * ProfileRegistry from (all stores, no subset). `retrieval` is present for stores whose plugin
   * registered a retrieval-bearing capability, absent (enumeration-only) otherwise.
   */
  allStores(): StoreCapabilities[] {
    return [...this.sites.values()];
  }

  getRulesetForUrl(url: string): ExtractionRuleset | undefined {
    const siteId = this.resolveSiteId(url);
    return siteId ? this.rulesets.get(siteId) : undefined;
  }

  /**
   * Register a hands-off policy (contract 0.17.0). Validated and committed as a whole: a policy that
   * is refused leaves nothing behind. Throws, naming the value, when a host or the siteId is already
   * held by another policy, a host is listed twice, a host is not a DNS hostname, or `handsOff` is
   * not a boolean — the decision is never inferred from a missing field.
   */
  registerHandsOffPolicy(policy: HandsOffPolicy): void {
    if (policy === null || typeof policy !== 'object') {
      throw new Error('hands-off policy: expected an object');
    }
    const { siteId } = policy;
    if (siteId !== undefined && (typeof siteId !== 'string' || siteId === '')) {
      throw new Error(`hands-off policy: siteId must be a non-empty string when present, got ${JSON.stringify(siteId)}`);
    }
    const owner = policyLabel(siteId);
    if (typeof policy.handsOff !== 'boolean') {
      throw new Error(`hands-off ${owner}: handsOff must be a boolean, got ${JSON.stringify(policy.handsOff)}`);
    }
    if (!Array.isArray(policy.hosts) || policy.hosts.length === 0) {
      throw new Error(`hands-off ${owner}: hosts must be a non-empty array of hostnames`);
    }
    if (siteId !== undefined && this.policyBySite.has(siteId)) {
      throw new Error(`hands-off ${owner} is already registered`);
    }

    const hosts: string[] = [];
    for (const raw of policy.hosts) {
      const host = normalisePolicyHost(raw);
      if (host === undefined) {
        throw new Error(
          `hands-off ${owner}: ${JSON.stringify(raw)} is not a DNS hostname (no scheme, port, path, wildcard or IP literal; at least two labels)`
        );
      }
      const holder = this.policyByHost.get(host);
      if (holder !== undefined) {
        throw new Error(`hands-off ${owner}: host ${JSON.stringify(host)} is already registered by ${policyLabel(holder.siteId)}`);
      }
      if (hosts.includes(host)) {
        throw new Error(`hands-off ${owner}: host ${JSON.stringify(host)} is listed twice`);
      }
      hosts.push(host);
    }

    // A snapshot: the plugin can no longer change the decision through its own object, and a caller
    // cannot change it through a returned one.
    const stored = deepFreeze(structuredClone({ ...policy, hosts }));
    this.policies.push(stored);
    for (const host of hosts) this.policyByHost.set(host, stored);
    if (siteId !== undefined) this.policyBySite.set(siteId, stored);
  }

  /**
   * The hands-off policy covering a URL's host: the most specific registered host that is the URL's
   * host or a parent domain of it (`www.a.test` → `a.test`; `nota.test` never matches `a.test`). The
   * host is compared the way a fetch resolves it (WHATWG URL: case, %-escapes, IDNA; trailing dots
   * dropped). A malformed URL throws rather than answering "not hands-off".
   */
  handsOffPolicyFor(url: string): HandsOffPolicy | undefined {
    let host = canonicalHost(new URL(url).hostname);
    for (;;) {
      const policy = this.policyByHost.get(host);
      if (policy !== undefined) return policy;
      const dot = host.indexOf('.');
      if (dot < 0) return undefined;
      host = host.slice(dot + 1);
    }
  }

  /** The robots pins of the siteId's policy; undefined when no policy carries that siteId. */
  robotsPinsFor(siteId: string): RobotsPin[] | undefined {
    return this.policyBySite.get(siteId)?.pins;
  }

  /** Register the plugin's robots classifier (contract 0.17.0). One per engine: a second one throws. */
  registerRobotsClassifier(classifier: RobotsClassifier): void {
    if (classifier === null || typeof classifier !== 'object') {
      throw new Error('robots classifier: expected an object');
    }
    if (typeof classifier.classify !== 'function') {
      throw new Error('robots classifier: classify must be a function');
    }
    if (typeof classifier.tokenListDate !== 'string') {
      throw new Error('robots classifier: tokenListDate must be a string');
    }
    if (this.classifier !== undefined) {
      throw new Error(`a robots classifier is already registered (token list ${this.classifier.tokenListDate})`);
    }
    this.classifier = classifier;
  }

  /** The registered robots classifier; undefined when no plugin registered one. */
  robotsClassifier(): RobotsClassifier | undefined {
    return this.classifier;
  }

  /**
   * The cookie names a healthy session jar for this host must hold (SiteConfig.requiredCookies of the
   * site covering the host, parent-domain match as for the site lookups). A copy; undefined when no
   * site covers the host or the site declares no required set.
   */
  requiredCookiesFor(host: string): string[] | undefined {
    const siteId = this.resolveSiteIdForHost(canonicalHost(host));
    const declared = siteId === undefined ? undefined : this.sites.get(siteId)?.requiredCookies;
    return Array.isArray(declared) ? [...declared] : undefined;
  }

  /** Every registered policy, in registration order, as /health/detailed lists it (hosts frozen). */
  handsOffView(): HandsOffView[] {
    return this.policies.map(policy => ({
      siteId: policy.siteId ?? null,
      hosts: policy.hosts,
      tier: policy.tier,
      handsOff: policy.handsOff,
      denied: policy.denied === true,
      policyVersion: policy.policyVersion,
    }));
  }

  private resolveSiteId(url: string): string | undefined {
    // Let URL's own validation error propagate — callers get a clear
    // "Invalid URL" failure rather than a silently-undefined match.
    return this.resolveSiteIdForHost(new URL(url).hostname.toLowerCase());
  }

  private resolveSiteIdForHost(hostname: string): string | undefined {
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
