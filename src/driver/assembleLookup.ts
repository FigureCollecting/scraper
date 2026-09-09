/**
 * assembleLookup — the cross-store SEARCH runtime: the buy-decision fan-out. Two entrypoints over
 * one shared fan-out:
 *   - `lookup(query)`            — DISCOVERY: a free-text query fanned across every store's bySearch.
 *   - `lookupByIdentity(identity)` — RECORD-MODE: a typed IdentityQuery (the caller has a catalogued
 *     figure); the planner composes EACH store's query server-side — JAN-exact where the store's
 *     bySearch `acceptsGtin`, a barcode-byId detail plan (plazajapan), else a composed name/ER query.
 *
 * TWO MODES over ONE fetch: `listed` (all, incl. sold-out) vs `orderable` (drop `available === false`).
 * A barcode-byId store yields a single "direct-hit" candidate (itemId = the gtin14) the caller
 * confirms via /resolve — no search/parse. Everything is injected so the fan-out is deterministic.
 *
 * SUBSTRING-MATCH stores (Ueeshop/gkloot, `bySearch.queryMatch === 'substring'`) are issued the single
 * most selective identity term and their candidates are POST-FILTERED by the remaining identity tokens
 * (a multi-term phrase would match nothing). Each per-store result reports `storeQuery` (the exact `{q}`
 * issued to that store) and, when that post-filter ran, `filtered` (how many candidates it removed).
 *
 * COLLECT URL vs PAGE URL: a candidate's `url` is the store's product PAGE link exactly as the plugin
 * emitted it (contract semantics, never rewritten). The ENGINE owns retrieval-axis knowledge, so each
 * candidate is additionally decorated with `collectUrl` — the URL the ingest path should fetch: the
 * store's `retrieval.byId` URL for its `itemId` where one is declared (orzgk's Store-API JSON collects
 * where its CF-challenged HTML page does not), else the page link absolutized against the store's
 * search URL (Shopify hits are RELATIVE `/products/<handle>`), else omitted. Callers that ingest
 * (the initiator) prefer `collectUrl` and fall back to `url`.
 */
import { planRetrieval, composeNameQuery, normalizeText, resolveByIdUrl } from './retrievalPlanner.js';
import { sanitizeForLog } from '../utils/security.js';
import { isCloudflareChallenge } from '../services/engineServices/challengeDetect.js';
import { getChallengeCooldown, normalizeHost, type ChallengeCooldown } from '../services/challengeCooldown.js';
import { getCfCookieStore, markStaleIfStored, markFreshIfStored, type CfCookieStoreLike } from '../services/cookieJar.js';
import { classifyFetchFailure } from '../services/failureClassifier.js';
import type { FetchFailureReport, ReportFetchFailure } from '../services/failureReporter.js';
import type { ProfileRegistry } from './profileRegistry.js';
import type {
  ExtractionRuleset,
  IdentityQuery,
  RetrievalCapability,
  SearchCandidate,
  SearchFetch,
} from '@figurecollecting/scraper-plugin-contract';

export type LookupMode = 'listed' | 'orderable';

/**
 * A search hit as /lookup returns it: the contract's SearchCandidate plus the engine-derived
 * `collectUrl` (see the header). Absent when neither a byId URL nor a usable page link exists.
 */
export type LookupCandidate = SearchCandidate & { collectUrl?: string };

/**
 * Decorate one candidate with `collectUrl`. Plugin output is untrusted at runtime: a non-string /
 * empty itemId skips the byId rule, a non-string / empty / malformed `url` skips the page rule, and
 * nothing here ever throws — the candidate is always kept, with every existing field untouched.
 * Generic over the candidate shape so the catalog-listing runtime (assembleCatalog) decorates its
 * `{ itemId, url? }` listing items with the very same rules.
 */
export function withCollectUrl<T extends Pick<SearchCandidate, 'itemId' | 'url'>>(
  c: T,
  retrieval: RetrievalCapability | undefined,
  searchUrl: string,
): T & { collectUrl?: string } {
  const byId = typeof c.itemId === 'string' && c.itemId ? resolveByIdUrl(retrieval, c.itemId) : undefined;
  if (byId) return { ...c, collectUrl: byId };
  const trimmed = typeof c.url === 'string' ? c.url.trim() : '';
  // A whitespace-only url, or one that is only a fragment/query (no path to resolve), would otherwise
  // resolve to the store's own search url — not a real collect target — so skip it. Resolve against
  // the TRIMMED value; `url` itself is returned untouched below.
  if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('?')) {
    try {
      const resolved = new URL(trimmed, searchUrl);
      // Only a fetchable scheme is a usable collect target — a javascript:/data:/mailto: link (or any
      // other non-http(s) scheme) is rejected; a protocol-relative "//host/x" resolves to http(s) and
      // is allowed same as any other relative link (no host special-casing).
      if (resolved.protocol === 'http:' || resolved.protocol === 'https:') {
        return { ...c, collectUrl: resolved.href };
      }
    } catch {
      // malformed page link → no collectUrl, but the candidate itself is still returned
    }
  }
  return c;
}

/** Per-store search-fetch timeout (ms) used when LOOKUP_STORE_TIMEOUT_MS is unset/invalid, and the clamp any override rides within. */
const DEFAULT_STORE_TIMEOUT_MS = 15000;
const MIN_STORE_TIMEOUT_MS = 1000;
const MAX_STORE_TIMEOUT_MS = 60000;

/**
 * Resolve the per-store search-fetch timeout (ms) from the environment. LOOKUP_STORE_TIMEOUT_MS
 * overrides the 15s default; a missing, empty, non-numeric, or non-positive value falls back to that
 * default, and any usable value is clamped to [1000, 60000] so a typo can neither strangle a slow
 * session-gated store nor let one hung/CF-stalled store pin the whole fan-out open. Pure (env in →
 * number out) so it is unit-testable without touching process.env — mirrors resolveImpitTimeoutMs.
 */
export function resolveLookupStoreTimeoutMs(env: NodeJS.ProcessEnv): number {
  const n = Number(env.LOOKUP_STORE_TIMEOUT_MS);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_STORE_TIMEOUT_MS;
  return Math.min(MAX_STORE_TIMEOUT_MS, Math.max(MIN_STORE_TIMEOUT_MS, n));
}

/** Per-store search-fetch timeout applied to every fan-out fetch. Resolved ONCE at module load. */
const STORE_TIMEOUT_MS = resolveLookupStoreTimeoutMs(process.env);

/**
 * Bound a per-store fetch: resolve with its value if it wins, else REJECT once `ms` elapses so a
 * single slow / hanging / CF-stalled store can never keep Promise.all pending. The timer is ALWAYS
 * cleared (whether the fetch or the timeout wins) so a settled fan-out leaves no dangling timer.
 * `what` names the bounded work in the rejection (default `search`; the catalog runtime reuses this
 * with its own label).
 */
export function withTimeout<T>(work: Promise<T>, ms: number, what = 'search'): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export interface LookupServices {
  /** The store registry (built from the engine's registered capabilities). */
  profiles: ProfileRegistry;
  /** URL → ruleset (engine ExtractionRegistryImpl.getRulesetForUrl); the ruleset parses candidates. */
  getRulesetForUrl: (url: string) => ExtractionRuleset | undefined;
  /**
   * Fetch a store's search-results body given the store's resolved search transport (http /
   * impersonate / browser + its per-store headers/profile). Built by the engine (makeFetchSearch)
   * and injected here, so the fan-out stays deterministic in tests.
   */
  fetchSearch: (url: string, searchFetch: SearchFetch) => Promise<string>;
  /**
   * Per-host Cloudflare-challenge cooldown register (shared with the ingest queue and
   * /health/detailed). Optional — defaults to the process-wide singleton; tests inject a
   * clock-controlled instance. A cooling store is skipped WITHOUT fetching; a search body that IS a
   * challenge opens its host's cooldown.
   */
  challengeCooldown?: ChallengeCooldown;
  /**
   * Per-host STORED-COOKIE store (CfCookieStore, CF_COOKIE_FILE) for the stale / fresh signals: a
   * host the store has cookies for that STILL serves a challenge is marked stale (the operator must
   * re-mint — the engine cannot); a clean search body marks it fresh. Optional — defaults to the
   * process-wide singleton; tests inject a fake. Never read for the fetch itself (the lanes do that).
   */
  cfCookieStore?: CfCookieStoreLike;
  /**
   * The durable fetch-failure ledger seam (createFailureReporterFromEnv). Optional — absent means
   * reporting is OFF and every emit point is a no-op. The fan-out is terminal by construction (one
   * pass, one attempt per store), so each of its exits reports exactly once, keyed on the
   * environment-free `fc:search/<siteId>?q=…&mode=…` target.
   */
  reportFailure?: ReportFetchFailure;
}

export interface StoreLookupResult {
  siteId: string;
  host: string;
  url: string;
  /** The exact `{q}` issued to this store: a substring store's selective term, else the composed phrase. */
  storeQuery: string;
  candidates: LookupCandidate[];
  /** Candidates the substring-store identity post-filter removed (present ONLY when that filter ran). */
  filtered?: number;
}

/**
 * A barcode-byId direct hit (record-mode): a store whose byId URL IS the barcode, so a JAN resolves
 * straight to a product page. It is NOT a screen candidate — it is UNVERIFIED (never fetched), so it
 * is segregated here rather than surfaced as a phantom candidate; the caller confirms it via /resolve.
 */
export interface ResolveTarget {
  siteId: string;
  host: string;
  itemId: string;
  url: string;
}

export interface LookupResult {
  query: string;
  mode: LookupMode;
  results: StoreLookupResult[];
  /** Stores that cannot serve the search: no `bySearch` axis, or no `extractCandidates` parser. */
  unsupported: string[];
  /**
   * Stores that DID return results but whose search is `orderable`-scope — a `listed` query can't
   * confirm their sold-out items (coverage caveat, not a failure). Always empty in `orderable` mode.
   */
  orderableOnly: string[];
  /** Stores whose search fetch or parse errored (transparency, not silent drop). */
  failed: string[];
  /**
   * Stores SKIPPED without fetching because their host is cooling from a recent Cloudflare challenge
   * (additive — distinct from `failed`/`unsupported`: the store is fine, we are deliberately leaving
   * its host alone until the cooldown expires).
   */
  cooldown: string[];
  /**
   * Barcode-byId direct hits (record-mode only): stores where the JAN resolves straight to a byId
   * URL. UNVERIFIED — the caller confirms each via /resolve (which returns the full record incl
   * price/availability). Kept OUT of `results` so an unfetched hit never poses as a real candidate.
   */
  resolveTargets: ResolveTarget[];
}

export interface Lookup {
  /**
   * DISCOVERY: fan a free-text query across every store's bySearch. `stores` (siteIds) narrows the
   * fan-out to just those stores — the interim initiator's scope knob; absent/empty → every store
   * (unchanged).
   */
  lookup(query: string, opts?: { mode?: LookupMode; stores?: string[] }): Promise<LookupResult>;
  /** RECORD-MODE: fan a typed identity across stores, composing each store's query server-side. */
  lookupByIdentity(identity: IdentityQuery, opts?: { mode?: LookupMode; stores?: string[] }): Promise<LookupResult>;
}

/**
 * The CANONICAL ledger target for one store's search of one query (spec §1.1). Not the store's real
 * search URL: the ledger needs one stable identity per (store, query, mode) so a repeat failure
 * bumps `attempts` instead of forking a second row when a template changes.
 */
export function searchFailureTarget(siteId: string, query: string, mode: LookupMode): string {
  return `fc:search/${siteId}?q=${encodeURIComponent(query)}&mode=${mode}`;
}

/**
 * The reason for something thrown inside the fan-out's per-store try. The classifier recognizes the
 * transport shapes (withTimeout's rejection, a socket fault, a challenge); anything it cannot name
 * got past the fetch and died in the parser, which is `parse` — OUR fault, the operator's queue —
 * never the catch-all `other` triage bucket.
 */
function parseOrClassified(err: unknown): FetchFailureReport['reasonClass'] {
  const { reasonClass } = classifyFetchFailure({ error: err });
  return reasonClass === 'other' ? 'parse' : reasonClass;
}

/** Representative `query` label for a record-mode result: the JAN if present, else the composed name. */
const identityLabel = (identity: IdentityQuery): string => identity.gtin14 ?? composeNameQuery(identity) ?? '';

export function assembleLookup(services: LookupServices): Lookup {
  const runFanout = async (
    plan: ReturnType<typeof planRetrieval>,
    mode: LookupMode,
    query: string,
    stores?: string[],
  ): Promise<LookupResult> => {
    // Optional store scope (the interim initiator's knob): narrow the fan-out to just the requested
    // siteIds — and narrow the coverage envelope to match, so `unsupported` reflects only requested
    // stores. Absent OR empty → NO filtering (the backward-compat contract: full fan-out, unchanged).
    const scopeSet = stores && stores.length > 0 ? new Set(stores) : undefined;
    const plans = scopeSet ? plan.plans.filter((p) => scopeSet.has(p.siteId)) : plan.plans;
    const unsupported = scopeSet ? plan.unsupported.filter((s) => scopeSet.has(s)) : [...plan.unsupported];
    const orderableOnly: string[] = [];
    const failed: string[] = [];
    const cooldown: string[] = [];
    const resolveTargets: ResolveTarget[] = [];
    const cd = services.challengeCooldown ?? getChallengeCooldown();
    const cfStore = services.cfCookieStore ?? getCfCookieStore();
    /**
     * Fire ONE ledger row. Best effort in every direction: no reporter is a no-op, and neither a
     * synchronous throw nor a rejected report may take a store — let alone the whole fan-out —
     * down. The fan-out's own `failed`/`cooldown` lists are the caller's contract and never move.
     */
    const emitFailure = (report: FetchFailureReport): void => {
      if (!services.reportFailure) return;
      try {
        void Promise.resolve(services.reportFailure(report)).catch(() => {});
      } catch {
        // bookkeeping never breaks a search
      }
    };
    // CHALLENGE COOLDOWN gate (shared by detail AND search plans): this host is cooling from a recent
    // CF challenge — SKIP it WITHOUT fetching (a challenge fetch degrades the egress IP's CF
    // reputation) and list it under the additive `cooldown` list (the store is fine, we are
    // deliberately leaving its host alone). A cooling byId host must be gated HERE too, so its detail
    // target is never handed to the caller as a /resolve confirm that would fetch the cooling host.
    const skipCooling = (p: { host: string; url: string; siteId: string }, kind: 'search' | 'record'): boolean => {
      if (!cd.isOpen(p.host)) return false;
      const remainingMs = cd.remaining(p.host);
      const minsLeft = Math.max(1, Math.ceil(remainingMs / 60_000));
      // eslint-disable-next-line no-console
      console.warn(`[COOLDOWN] skipped ${sanitizeForLog(p.url)} (${normalizeHost(p.host)} cooling, ${minsLeft} min left)`);
      cooldown.push(p.siteId);
      // E3 — a cooldown SKIP is reported (the operator asked to see hosts we are deliberately
      // leaving alone), carrying the window's end so the spine's backoff is never pulled forward.
      emitFailure({
        site: p.siteId,
        target: kind === 'search' ? searchFailureTarget(p.siteId, query, mode) : p.url,
        kind,
        origin: 'lookup',
        reasonClass: 'cooldown',
        message: `host ${normalizeHost(p.host)} is cooling after a Cloudflare challenge; ${minsLeft} min remaining`,
        nextRetryHint: new Date(Date.now() + remainingMs).toISOString(),
      });
      return true;
    };

    const settled = await Promise.all(
      plans.map(async (p): Promise<StoreLookupResult | null> => {
        // Barcode-byId direct hit (record-mode): a RESOLVE TARGET, not a screen candidate. It is
        // UNVERIFIED (we haven't fetched it), so segregate it into resolveTargets — never surface it
        // as a phantom candidate (no name=barcode into the matcher, no unfetched hit in orderable mode).
        if (p.kind === 'detail') {
          if (skipCooling(p, 'record')) return null; // cooling host → cooldown list, never a resolveTarget
          resolveTargets.push({ siteId: p.siteId, host: p.host, itemId: p.itemId ?? '', url: p.url });
          return null;
        }

        const ruleset = services.getRulesetForUrl(p.url);
        if (!ruleset?.extractCandidates) {
          unsupported.push(p.siteId); // has a bySearch URL but no parser yet
          return null;
        }
        if (skipCooling(p, 'search')) return null;
        const retrieval = services.profiles.retrievalFor(p.host);
        const scope = retrieval?.bySearch?.scope ?? 'listed';
        if (mode === 'listed' && scope === 'orderable') orderableOnly.push(p.siteId);
        try {
          // BOUNDED per store: race the fetch against a timeout so one slow / hanging / CF-stalled
          // store can't keep the whole Promise.all pending. A timeout REJECTS → the catch below treats
          // it exactly like any other fetch failure (siteId → `failed`, reason logged, returns null).
          const transport = services.profiles.searchTransportFor(p.host);
          const body = await withTimeout(services.fetchSearch(p.url, transport), STORE_TIMEOUT_MS);
          // HONEST SEARCH LANE: a CF challenge/block body is NOT parseable content — extractCandidates
          // would silently lift 0 candidates and pose the store as "carries nothing". Detect it BEFORE
          // parsing: report the store `failed` with a logged reason, and OPEN its host's cooldown so
          // the ingest queue and a later lookup leave it alone. Raw-capture stays inside fetchSearch.
          if (isCloudflareChallenge(body)) {
            // eslint-disable-next-line no-console
            console.warn(`[lookup] ${sanitizeForLog(p.siteId)} search failed: challenge page`);
            cd.open(p.host, 'search challenge page');
            // STORED-COOKIE STALE signal: a host WITH stored cookies still challenged → dead cookie,
            // marked once via the lane that fetched (a host without stored cookies is never marked).
            markStaleIfStored(cfStore, p.url, normalizeHost(p.host), transport.transport ?? 'http', 'search challenge page');
            failed.push(p.siteId);
            // E4 — the body WAS fetched and it was an interstitial: a real, attempted failure.
            emitFailure({
              site: p.siteId,
              target: searchFailureTarget(p.siteId, query, mode),
              kind: 'search',
              origin: 'lookup',
              reasonClass: 'challenge',
              message: `search returned a Cloudflare challenge page for ${p.url}`,
              transport: transport.transport ?? 'http',
              ...(ruleset.version !== undefined ? { rulesetVersion: ruleset.version } : {}),
            });
            return null;
          }
          // A clean body for a host WITH stored cookies is the FRESH signal (clears a stale mark).
          markFreshIfStored(cfStore, p.url, normalizeHost(p.host));
          let candidates = await ruleset.extractCandidates(body, p.url);
          // Substring-store identity post-filter (record-mode): the store matched only the single
          // selective term issued as `{q}`, so drop candidates whose normalized name lacks any remaining
          // identity token. Runs BEFORE the orderable cut so `filtered` counts identity mismatches only.
          let filtered: number | undefined;
          if (p.filter?.length) {
            const kept = candidates.filter((c) => {
              // Plugin output is untrusted at runtime: a non-string name can't match identity, so
              // drop it as a non-match — never let it throw and take the WHOLE store into `failed`.
              const name = typeof c.name === 'string' ? normalizeText(c.name) : '';
              // Also test the space-collapsed name so an identity token that spans punctuation the
              // store wrote but the identity didn't ("girls" vs "GIRL'S HOUSE") still matches — the
              // same cross-store title variance the substring gate exists to see through.
              const compact = name.replace(/ /g, '');
              return p.filter!.every((tok) => name.includes(tok) || compact.includes(tok));
            });
            filtered = candidates.length - kept.length;
            candidates = kept;
          }
          if (mode === 'orderable') candidates = candidates.filter((c) => c.available !== false);
          // Decorate every RETURNED candidate with its collect-ready URL (byId where declared, else the
          // absolutized page link) — after the filters, so only survivors are touched. Plugin output is
          // untrusted at runtime: a non-array result passes through UNCHANGED (the pre-existing shape),
          // and a null/non-object element inside an array passes through UNCHANGED too — neither throws
          // and takes the whole store into `failed`.
          const decorated = Array.isArray(candidates)
            ? candidates.map((c) => (c && typeof c === 'object' ? withCollectUrl(c, retrieval, p.url) : c))
            : candidates;
          return { siteId: p.siteId, host: p.host, url: p.url, storeQuery: p.query ?? '', candidates: decorated, ...(filtered !== undefined ? { filtered } : {}) };
        } catch (err) {
          // Surface WHY a store dropped out (CF block / invalid impersonation profile / parse error).
          // eslint-disable-next-line no-console
          console.warn(`[lookup] ${sanitizeForLog(p.siteId)} search failed: ${sanitizeForLog(err instanceof Error ? err.message : String(err))}`);
          failed.push(p.siteId);
          // E5 — the fan-out's own catch: a bounded-fetch timeout, a transport fault, or the
          // ruleset's extractCandidates throwing on a body we DID fetch. The classifier separates
          // withTimeout's rejection from the rest; anything that reached the parser is `parse`
          // (our selector, our problem) rather than a transport class.
          emitFailure({
            site: p.siteId,
            target: searchFailureTarget(p.siteId, query, mode),
            kind: 'search',
            origin: 'lookup',
            reasonClass: parseOrClassified(err),
            message: err instanceof Error ? err.message : String(err),
            ...(ruleset.version !== undefined ? { rulesetVersion: ruleset.version } : {}),
          });
          return null;
        }
      }),
    );

    return {
      query,
      mode,
      results: settled.filter((r): r is StoreLookupResult => r !== null),
      unsupported,
      orderableOnly,
      failed,
      cooldown,
      resolveTargets,
    };
  };

  return {
    async lookup(query, opts = {}) {
      return runFanout(planRetrieval(services.profiles, { mode: 'lookup', query }), opts.mode ?? 'listed', query, opts.stores);
    },
    async lookupByIdentity(identity, opts = {}) {
      return runFanout(planRetrieval(services.profiles, { mode: 'record', identity }), opts.mode ?? 'listed', identityLabel(identity), opts.stores);
    },
  };
}
