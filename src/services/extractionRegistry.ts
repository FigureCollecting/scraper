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
 *
 * ALL OR NOTHING PER PLUGIN. Those two methods can refuse a call, so bootstrapPlugins never hands a
 * plugin this registry: it hands it a PluginRegistration (beginRegistration()), which checks each
 * call as it is made and applies them all only at commit(), once the plugin has loaded. A refused
 * policy therefore cannot leave the plugin's sites live without it.
 */

import {
  AI_BAR_TIERS,
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

const KNOWN_TIERS: ReadonlySet<string> = new Set(AI_BAR_TIERS);

function policyLabel(siteId: string | undefined): string {
  return siteId === undefined ? 'a host-only entry' : `policy "${siteId}"`;
}

function refused(owner: string, problem: string): Error {
  return new Error(`hands-off ${owner}: ${problem}`);
}

/** An error's message, or the thrown value itself when a plugin threw something that is not an Error. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Freeze a plain-data snapshot all the way down. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function isRobotsPin(value: unknown): value is RobotsPin {
  if (value === null || typeof value !== 'object') return false;
  const pin = value as Record<string, unknown>;
  return typeof pin.url === 'string' && typeof pin.sha256 === 'string' && typeof pin.fetchedAt === 'string';
}

/**
 * Check a plugin's policy on its own and return a frozen snapshot with canonical hosts: the plugin can
 * no longer change the decision through its own object, and a caller cannot change it through a
 * returned one. Throws, naming the policy and the value, when a field is not of its declared shape —
 * `handsOff` and `denied` are never inferred from a missing or truthy value, and the fields
 * /health/detailed and the probes read (`tier`, `policyVersion`, `summary`, `pins`, `routeSamples`)
 * are checked here rather than trusted to the plugin's types.
 */
function snapshotPolicy(policy: HandsOffPolicy): HandsOffPolicy {
  if (policy === null || typeof policy !== 'object') {
    throw new Error('hands-off policy: expected an object');
  }
  const { siteId } = policy;
  if (siteId !== undefined && (typeof siteId !== 'string' || siteId === '')) {
    throw new Error(`hands-off policy: siteId must be a non-empty string when present, got ${JSON.stringify(siteId)}`);
  }
  const owner = policyLabel(siteId);
  if (typeof policy.handsOff !== 'boolean') {
    throw refused(owner, `handsOff must be a boolean, got ${JSON.stringify(policy.handsOff)}`);
  }
  if (policy.denied !== undefined && typeof policy.denied !== 'boolean') {
    throw refused(owner, `denied must be a boolean when present, got ${JSON.stringify(policy.denied)}`);
  }
  if (!KNOWN_TIERS.has(policy.tier)) {
    throw refused(owner, `tier must be one of ${AI_BAR_TIERS.join(', ')}, got ${JSON.stringify(policy.tier)}`);
  }
  if (typeof policy.policyVersion !== 'string' || policy.policyVersion === '') {
    throw refused(owner, `policyVersion must be a non-empty string, got ${JSON.stringify(policy.policyVersion)}`);
  }
  if (policy.summary === null || typeof policy.summary !== 'object' || Array.isArray(policy.summary)) {
    throw refused(owner, 'summary must be an object (an AiBarSummary)');
  }
  if (!Array.isArray(policy.pins) || !policy.pins.every(isRobotsPin)) {
    throw refused(owner, 'pins must be an array of {url, sha256, fetchedAt}, each a string');
  }
  if (!Array.isArray(policy.routeSamples) || !policy.routeSamples.every(sample => typeof sample === 'string')) {
    throw refused(owner, 'routeSamples must be an array of strings');
  }
  if (!Array.isArray(policy.hosts) || policy.hosts.length === 0) {
    throw refused(owner, 'hosts must be a non-empty array of hostnames');
  }

  const hosts: string[] = [];
  for (const raw of policy.hosts) {
    const host = normalisePolicyHost(raw);
    if (host === undefined) {
      throw refused(
        owner,
        `${JSON.stringify(raw)} is not a DNS hostname (no scheme, port, path, wildcard or IP literal; at least two labels)`
      );
    }
    if (hosts.includes(host)) {
      throw refused(owner, `host ${JSON.stringify(host)} is listed twice`);
    }
    hosts.push(host);
  }

  let snapshot: HandsOffPolicy;
  try {
    snapshot = structuredClone({ ...policy, hosts });
  } catch (error) {
    throw new Error(`hands-off ${owner}: the policy must be plain data (${describeError(error)})`, { cause: error });
  }
  return deepFreeze(snapshot);
}

/** The policies a check runs against, by canonical host and by siteId. */
interface PolicyIndex {
  readonly byHost: Map<string, HandsOffPolicy>;
  readonly bySite: Map<string, HandsOffPolicy>;
}

function emptyPolicyIndex(): PolicyIndex {
  return { byHost: new Map(), bySite: new Map() };
}

function indexPolicy(index: PolicyIndex, policy: HandsOffPolicy): void {
  for (const host of policy.hosts) index.byHost.set(host, policy);
  if (policy.siteId !== undefined) index.bySite.set(policy.siteId, policy);
}

/** The parent domains of a canonical host, nearest first (`a.b.test` → `b.test`, `test`). */
function parentDomains(host: string): string[] {
  const parents: string[] = [];
  for (let dot = host.indexOf('.'); dot >= 0; dot = host.indexOf('.', dot + 1)) parents.push(host.slice(dot + 1));
  return parents;
}

/** The decision a policy on a subdomain would lift from the policy on its parent, if any. */
function liftedDecision(parent: HandsOffPolicy, child: HandsOffPolicy): 'handsOff' | 'denied' | undefined {
  if (parent.handsOff && !child.handsOff) return 'handsOff';
  if (parent.denied === true && child.denied !== true) return 'denied';
  return undefined;
}

function refuseIfLifted(owner: string, parent: HandsOffPolicy, parentHost: string, child: HandsOffPolicy, childHost: string): void {
  const lifted = liftedDecision(parent, child);
  if (lifted !== undefined) {
    throw refused(
      owner,
      `${JSON.stringify(childHost)} (${policyLabel(child.siteId)}) sits under ${JSON.stringify(parentHost)} ` +
        `(${policyLabel(parent.siteId)}) but is not ${lifted}; a policy on a subdomain must be at least as strict as its parent's`
    );
  }
}

/**
 * Throw, naming both policies, when `policy` conflicts with one in `index`: its siteId or one of its
 * hosts is already held, or a host of one sits under a host of the other and the policy below is the
 * less strict. handsOffPolicyFor answers with the most specific host, so a weaker policy on a
 * subdomain would silently lift its parent's handsOff or denied there; whichever of the two is
 * registered second is refused.
 */
function checkPolicyAgainst(policy: HandsOffPolicy, index: PolicyIndex): void {
  const owner = policyLabel(policy.siteId);
  if (policy.siteId !== undefined && index.bySite.has(policy.siteId)) {
    throw new Error(`hands-off ${owner} is already registered`);
  }
  for (const host of policy.hosts) {
    const holder = index.byHost.get(host);
    if (holder !== undefined) {
      throw refused(owner, `host ${JSON.stringify(host)} is already registered by ${policyLabel(holder.siteId)}`);
    }
    for (const parentHost of parentDomains(host)) {
      const parent = index.byHost.get(parentHost);
      if (parent !== undefined) refuseIfLifted(owner, parent, parentHost, policy, host);
    }
    for (const [childHost, child] of index.byHost) {
      if (childHost.endsWith(`.${host}`)) refuseIfLifted(owner, policy, host, child, childHost);
    }
  }
}

function checkClassifierShape(classifier: RobotsClassifier): void {
  if (classifier === null || typeof classifier !== 'object') {
    throw new Error('robots classifier: expected an object');
  }
  if (typeof classifier.classify !== 'function') {
    throw new Error('robots classifier: classify must be a function');
  }
  if (typeof classifier.tokenListDate !== 'string') {
    throw new Error('robots classifier: tokenListDate must be a string');
  }
}

function refuseSecondClassifier(held: RobotsClassifier | undefined): void {
  if (held !== undefined) {
    throw new Error(`a robots classifier is already registered (token list ${held.tokenListDate})`);
  }
}

/** A site config with its index keys read once, at the call, so applying it later cannot throw. */
interface PreparedSite {
  config: SiteConfig;
  siteId: string;
  domains: string[];
}

function prepareSite(config: SiteConfig): PreparedSite {
  return { config, siteId: config.siteId, domains: Array.from(config.domains, domain => domain.toLowerCase()) };
}

/** Everything one plugin staged, applied to the registry in one step by PluginRegistration.commit(). */
interface StagedRegistrations {
  sites: PreparedSite[];
  rulesets: Array<[string, ExtractionRuleset]>;
  policies: HandsOffPolicy[];
  classifier: RobotsClassifier | undefined;
}

/** What a PluginRegistration needs from its registry: checks against what is committed, and the apply. */
interface RegistrationTarget {
  checkPolicy(policy: HandsOffPolicy): void;
  checkClassifier(): void;
  apply(staged: StagedRegistrations): void;
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
  /** canonical host -> the policy that lists it; siteId -> its policy (a host-only entry has none) */
  private readonly policyIndex = emptyPolicyIndex();
  private classifier: RobotsClassifier | undefined;

  registerSite(config: SiteConfig): void {
    // Read the config's keys before indexing anything, so a malformed config registers nothing.
    this.addSite(prepareSite(config));
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
   * Register a hands-off policy (contract 0.17.0). Checked and committed as a whole: a policy that is
   * refused leaves nothing behind. Throws, naming the policy and the value, when a field is not of its
   * declared shape (snapshotPolicy), a host or the siteId is already held by another policy, or the
   * policy would lift a stricter one across a parent domain (checkPolicyAgainst).
   */
  registerHandsOffPolicy(policy: HandsOffPolicy): void {
    const stored = snapshotPolicy(policy);
    checkPolicyAgainst(stored, this.policyIndex);
    this.addPolicy(stored);
  }

  /**
   * The hands-off policy covering a URL's host: the most specific registered host that is the URL's
   * host or a parent domain of it (`www.a.test` → `a.test`; `nota.test` never matches `a.test`). The
   * host is compared the way a fetch resolves it (WHATWG URL: case, %-escapes, IDNA; trailing dots
   * dropped). A malformed URL throws rather than answering "not hands-off". Registration refuses a
   * subdomain policy weaker than its parent's, so the most specific answer is never the weaker one.
   */
  handsOffPolicyFor(url: string): HandsOffPolicy | undefined {
    let host = canonicalHost(new URL(url).hostname);
    for (;;) {
      const policy = this.policyIndex.byHost.get(host);
      if (policy !== undefined) return policy;
      const dot = host.indexOf('.');
      if (dot < 0) return undefined;
      host = host.slice(dot + 1);
    }
  }

  /** The robots pins of the siteId's policy; undefined when no policy carries that siteId. */
  robotsPinsFor(siteId: string): RobotsPin[] | undefined {
    return this.policyIndex.bySite.get(siteId)?.pins;
  }

  /** Register the plugin's robots classifier (contract 0.17.0). One per engine: a second one throws. */
  registerRobotsClassifier(classifier: RobotsClassifier): void {
    checkClassifierShape(classifier);
    refuseSecondClassifier(this.classifier);
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

  /**
   * Open one plugin's registration: what bootstrapPlugins hands the plugin's register() instead of this
   * registry. Nothing the plugin registers through it is visible here until commit().
   */
  beginRegistration(): PluginRegistration {
    return new PluginRegistration(this, {
      checkPolicy: policy => checkPolicyAgainst(policy, this.policyIndex),
      checkClassifier: () => refuseSecondClassifier(this.classifier),
      apply: staged => {
        for (const site of staged.sites) this.addSite(site);
        for (const [siteId, ruleset] of staged.rulesets) this.rulesets.set(siteId, ruleset);
        for (const policy of staged.policies) this.addPolicy(policy);
        if (staged.classifier !== undefined) this.classifier = staged.classifier;
      },
    });
  }

  private addSite(site: PreparedSite): void {
    this.sites.set(site.siteId, site.config);
    for (const domain of site.domains) this.hostnameIndex.set(domain, site.siteId);
  }

  private addPolicy(policy: HandsOffPolicy): void {
    this.policies.push(policy);
    indexPolicy(this.policyIndex, policy);
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

/**
 * One plugin's registry calls, all or nothing. Each call is checked when it is made, against the
 * registry and the plugin's own earlier calls, so a refusal throws inside the plugin's register()
 * and names the value. commit() checks the staged policies and classifier against the registry once
 * more (another registration may have committed in between), then applies every call at once, or
 * none. A refused call poisons the registration: commit() refuses it even when the plugin caught the
 * throw and carried on, because the plugin's stores must never go live without the policy it meant
 * to register. After commit() calls go straight to the registry; after discard() or a failed
 * commit() they throw.
 */
export class PluginRegistration implements ExtractionRegistry {
  private state: 'open' | 'committed' | 'discarded' = 'open';
  /** The first call that threw, boxed so that even `throw undefined` counts. */
  private refusal: { error: unknown } | undefined;
  private readonly staged: StagedRegistrations = { sites: [], rulesets: [], policies: [], classifier: undefined };
  private readonly stagedIndex = emptyPolicyIndex();

  constructor(
    private readonly registry: ExtractionRegistryImpl,
    private readonly target: RegistrationTarget
  ) {}

  registerSite(config: SiteConfig): void {
    if (this.isCommitted()) return this.registry.registerSite(config);
    this.stage(() => this.staged.sites.push(prepareSite(config)));
  }

  registerRuleset(ruleset: ExtractionRuleset): void {
    if (this.isCommitted()) return this.registry.registerRuleset(ruleset);
    this.stage(() => this.staged.rulesets.push([ruleset.siteId, ruleset]));
  }

  registerHandsOffPolicy(policy: HandsOffPolicy): void {
    if (this.isCommitted()) return this.registry.registerHandsOffPolicy(policy);
    this.stage(() => {
      const stored = snapshotPolicy(policy);
      this.target.checkPolicy(stored);
      checkPolicyAgainst(stored, this.stagedIndex);
      this.staged.policies.push(stored);
      indexPolicy(this.stagedIndex, stored);
    });
  }

  registerRobotsClassifier(classifier: RobotsClassifier): void {
    if (this.isCommitted()) return this.registry.registerRobotsClassifier(classifier);
    this.stage(() => {
      checkClassifierShape(classifier);
      this.target.checkClassifier();
      refuseSecondClassifier(this.staged.classifier);
      this.staged.classifier = classifier;
    });
  }

  /** Apply every staged call to the registry, or throw and apply none (the registration is then discarded). */
  commit(): void {
    if (this.state !== 'open') {
      throw new Error(`plugin registration is already ${this.state}`);
    }
    try {
      if (this.refusal !== undefined) {
        throw new Error(
          `plugin registration refused: a registry call threw during register() (${describeError(this.refusal.error)})`,
          { cause: this.refusal.error }
        );
      }
      for (const policy of this.staged.policies) this.target.checkPolicy(policy);
      if (this.staged.classifier !== undefined) this.target.checkClassifier();
    } catch (error) {
      this.state = 'discarded';
      throw error;
    }
    this.target.apply(this.staged);
    this.state = 'committed';
  }

  /** Drop every staged call (the plugin did not load). A no-op once committed. */
  discard(): void {
    if (this.state === 'open') this.state = 'discarded';
  }

  /** True once committed (calls then go straight to the registry); throws once discarded. */
  private isCommitted(): boolean {
    if (this.state === 'discarded') {
      throw new Error('plugin registration was discarded: the plugin is not loaded');
    }
    return this.state === 'committed';
  }

  private stage(call: () => void): void {
    try {
      call();
    } catch (error) {
      this.refusal ??= { error };
      throw error;
    }
  }
}

export function createExtractionRegistry(): ExtractionRegistryImpl {
  return new ExtractionRegistryImpl();
}
