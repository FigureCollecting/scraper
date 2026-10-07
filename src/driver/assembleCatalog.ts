/**
 * assembleCatalog — the newest-first CATALOG LISTING runtime: the enumeration feed behind
 * GET /catalog that the crawler (recent + backfill modes) walks page by page. One store, one page
 * per call: `catalog(siteId, page)` resolves the store's `retrieval.byListing` page url, fetches it
 * through the store's declared search transport under the shared challenge-cooldown gate, parses it
 * via the ruleset's `extractListing`, and decorates every listed id with its collect-ready URL
 * (`withCollectUrl` — the same byId-else-page-link rule /lookup applies to candidates).
 *
 * The same runtime also serves the ID-RANGE axis (`idRange`, GET /catalog?store=&range=1&from=&count=):
 * for a store whose `retrieval.byRange` declares its ids sequential, a descending window of the id
 * space IS the listing, so the window is SYNTHESIZED from `byId.urlTemplate` with no fetch at all.
 * The capability resolution lives here (where the profile registry is); the frontier, the cursor and
 * the dedup stay with the crawler.
 *
 * The result is a DISCRIMINATED UNION, never a throw: `ok` (items + paging signals), `unsupported`
 * (unknown store / no byListing axis / no extractListing parser — a coverage gap, not a failure),
 * `cooldown` (the listing host is cooling from a recent CF challenge — skipped WITHOUT fetching), or
 * `failed` (challenge page → the host cooldown is opened; fetch error; timeout; parser throw).
 * A challenge on a host WITH stored cookies (CfCookieStore) also marks that host's cookie stale; a
 * clean listing marks it fresh — the operator's re-mint signal, surfaced on /health/detailed.
 * Plugin output is UNTRUSTED at runtime and guarded field by field. Everything is injected
 * (LookupServices shape) so the flow is deterministic in tests.
 */
import { resolveByIdUrl, resolveListingUrl } from './retrievalPlanner.js';
import { withCollectUrl, withTimeout, type LookupServices } from './assembleLookup.js';
import { sanitizeForLog } from '../utils/security.js';
import { isSafeRotatingName } from '../utils/rotatingName.js';
import { isCloudflareChallenge } from '../services/engineServices/challengeDetect.js';
import { getChallengeCooldown, normalizeHost } from '../services/challengeCooldown.js';
import { getCfCookieStore, markStaleIfStored, markFreshIfStored } from '../services/cookieJar.js';
import { observeGate, gateOutcomeOf, gateFailureReason } from '../services/gateSignal.js';
import type { ListingPage, RetrievalCapability, RotatingSeedList, SearchFetch, SeedList } from '@figurecollecting/scraper-plugin-contract';
import type { FetchBodyOutcome } from '../services/engineServices/capturingFetch.js';
import { declaredLastPage, getMaxPagesGuard, type MaxPagesGuard } from '../services/maxPagesGuard.js';
import { sendOnHostClock, type ClockedSendResult } from '../services/hostClockSend.js';
import type { HostClockCaller } from '../services/hostClock.js';
import { resolveCatalogStoreTimeoutMs } from './catalogStoreTimeout.js';

export { resolveCatalogStoreTimeoutMs } from './catalogStoreTimeout.js';

/**
 * The lookup's injected services, including its optional STATUS-AWARE fetch on the same lanes
 * (`fetchSearchDetail`). Every catalog axis reads it when present: the gate needs the status, and
 * the declared-page axes tell a store's 4xx (spend the slot) from its 5xx (retry) with it.
 */
export type CatalogServices = LookupServices & {
  /**
   * The maxPages guard (SCRAPE_CATALOG_MAX_PAGES_GUARD, QB-U24). Optional — defaults to the process-wide
   * guard, read from the env once; tests inject one.
   */
  maxPagesGuard?: MaxPagesGuard;
};

/** A listed item as /catalog returns it: the contract's listing item plus the engine-derived `collectUrl`. */
export type CatalogItem = ListingPage['items'][number] & { collectUrl?: string };

export type CatalogResult =
  | {
      status: 'ok';
      siteId: string;
      page: number;
      url: string;
      items: CatalogItem[];
      /** The collect-ready urls of `items` (those that have one), in listing order — the crawler's enqueue list. */
      collectUrls: string[];
      hasMore: boolean;
      nextPage?: number;
      count: number;
    }
  | { status: 'unsupported'; siteId: string; reason: string }
  | { status: 'cooldown'; siteId: string; host: string; remainingMs: number }
  | { status: 'failed'; siteId: string; reason: string };

/**
 * One SYNTHESIZED window of a `byRange` store's id space, walking DOWN from `from`. Shaped like the
 * listing result (`items` + `collectUrls` + a paging signal) so the crawler consumes both axes with
 * one parser; `nextFrom` is the next id below the window (absent once the walk reaches id 1).
 */
export type IdRangeResult =
  | {
      status: 'ok';
      siteId: string;
      from: number;
      items: CatalogItem[];
      collectUrls: string[];
      hasMore: boolean;
      nextFrom?: number;
      count: number;
    }
  | { status: 'unsupported'; siteId: string; reason: string }
  | { status: 'cooldown'; siteId: string; host: string; remainingMs: number }
  | { status: 'failed'; siteId: string; reason: string };

/**
 * One declared seed list as DISCOVERY reports it: the id it is addressed by, the url it resolves to,
 * and the operator-facing metadata. The url is reported (rather than kept engine-side) because a
 * poller has to be able to tell that TWO declared ids resolve to the SAME page — an authoring slip
 * that would otherwise cost a store one wholly redundant fetch per pass, on the one axis whose whole
 * justification is that its cost is knowable in advance. Fetching a list is still the seed axis's
 * job, never the caller's.
 */
export type SeedListSummary = { id: string; url: string; cadence: SeedList['cadence']; note?: string };

export type SeedListsResult =
  | { status: 'ok'; siteId: string; seedLists: SeedListSummary[]; count: number }
  | { status: 'unsupported'; siteId: string; reason: string };

/**
 * One fetched seed list. Shaped like the listing result so a caller consumes both with one parser —
 * except that `hasMore` is the literal `false`: a seed list is ONE declared page, so there is no
 * next page to signal and no `nextPage` to walk.
 */
export type SeedResult =
  | {
      status: 'ok';
      siteId: string;
      listId: string;
      url: string;
      items: CatalogItem[];
      collectUrls: string[];
      hasMore: false;
      count: number;
    }
  | { status: 'unsupported'; siteId: string; reason: string }
  | { status: 'cooldown'; siteId: string; host: string; remainingMs: number }
  | { status: 'failed'; siteId: string; reason: string };

/** One declared rotating seed list as discovery reports it. */
export type RotatingSeedListSummary = RotatingSeedList;

export type RotatingSeedListsResult =
  | { status: 'ok'; siteId: string; rotatingSeedLists: RotatingSeedListSummary[]; count: number }
  | { status: 'unsupported'; siteId: string; reason: string };

/**
 * A failed rotating fetch: `deterministic` would fail the same way again (parser throw, store 4xx,
 * challenge), `transient` may not (5xx, network, timeout); `blocked` = the store refuses us (challenge,
 * 401/403/429); `upstreamStatus` = the store's own status, when the lane observed one.
 */
export type RotatingFailure = { failure: 'deterministic' | 'transient'; blocked?: true; upstreamStatus?: number };

/** One fetched rotating seed list: a seed result that also names the list's group. */
export type RotatingSeedResult =
  | {
      status: 'ok';
      siteId: string;
      listId: string;
      group: string;
      url: string;
      items: CatalogItem[];
      collectUrls: string[];
      hasMore: false;
      count: number;
    }
  | { status: 'unsupported'; siteId: string; reason: string }
  | { status: 'cooldown'; siteId: string; host: string; remainingMs: number }
  | ({ status: 'failed'; siteId: string; reason: string } & RotatingFailure);

/**
 * The store's WELL-FORMED declared seed lists, in declared order. A store profile is plugin-supplied
 * and therefore untrusted at runtime: an entry that is not an object, carries a blank id or url, or
 * declares a cadence outside the contract's two is DROPPED rather than trusted — an unusable entry
 * would otherwise reach the operator's summary as a list that simply never yields anything. A
 * REPEATED id keeps its first entry: the id is how the axis is addressed, so a second one is
 * unreachable by construction and its presence must not make the run poll the same name twice.
 */
function declaredSeedLists(retrieval: RetrievalCapability | undefined): SeedList[] {
  const raw: unknown = retrieval?.seedLists;
  if (!Array.isArray(raw)) return [];
  const out: SeedList[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const { id, url, cadence, note } = entry as Partial<SeedList>;
    if (typeof id !== 'string' || id.length === 0) continue;
    if (typeof url !== 'string' || url.length === 0) continue;
    if (cadence !== 'weekly' && cadence !== 'daily') continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, url, cadence, ...(typeof note === 'string' && note.length > 0 ? { note } : {}) });
  }
  return out;
}

/**
 * The store's WELL-FORMED rotating seed lists, in declared order. Untrusted like `seedLists`: an
 * entry without a safe id or group, a url or a finite numeric order is dropped, a repeated id keeps
 * its first entry, and an id a seed list already uses is dropped (the two fields share one namespace).
 */
function declaredRotatingSeedLists(retrieval: RetrievalCapability | undefined): RotatingSeedList[] {
  const raw: unknown = retrieval?.rotatingSeedLists;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>(declaredSeedLists(retrieval).map((l) => l.id));
  const out: RotatingSeedList[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const { id, url, group, order } = entry as Partial<RotatingSeedList>;
    if (!isSafeRotatingName(id) || !isSafeRotatingName(group)) continue;
    if (typeof url !== 'string' || url.length === 0) continue;
    if (typeof order !== 'number' || !Number.isFinite(order)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, url, group, order });
  }
  return out;
}

/**
 * Default and clamp for an id-range window's size (ids per call). The crawler clamps its own
 * CRAWLER_RANGE_IDS_PER_RUN to the same ceiling (MAX_RANGE_IDS_PER_RUN in src/crawler/config.ts) so
 * an operator asking for more is warned there instead of silently receiving a shorter window here.
 */
const DEFAULT_ID_RANGE_COUNT = 50;
const MAX_ID_RANGE_COUNT = 200;

export interface Catalog {
  /** One page of `siteId`'s newest-first listing; `page` defaults to the store's `byListing.pageStart` (else 1). */
  catalog(siteId: string, page?: number): Promise<CatalogResult>;
  /**
   * One descending window of `siteId`'s SEQUENTIAL id space — `count` ids from `from` down, each
   * decorated with the collect URL its `byId.urlTemplate` builds. It fetches nothing and parses
   * nothing, because a store that declares `retrieval.byRange` has already told us its ids are
   * enumerable — the id space IS the listing. It DOES consult the challenge cooldown of the host the
   * window's urls point at: every id in a window handed out while that host is cooling would be
   * POSTed, ledgered as done and walked past, only to fast-fail in the ingest queue — the ids would
   * be burned, and this axis walks each id exactly once. Ids in the window that do not exist at the
   * store are EXPECTED and surface downstream as the ingest fetch's own 404; this surface never
   * probes them. `count` defaults to 50 and is clamped to [1, 200].
   */
  idRange(siteId: string, from: number, count?: number): IdRangeResult;
  /**
   * The seed lists `siteId` DECLARES, in declared order — the discovery half of the seed axis. Pure:
   * it reads the store's profile and fetches nothing. A caller polling a store's seed lists has to
   * learn WHICH lists exist and in what order before it can ask for one, and the declaration is the
   * only place that is recorded; an operator env var naming them would be a second, divergable copy.
   */
  seedLists(siteId: string): SeedListsResult;
  /**
   * ONE declared seed list, fetched and parsed. The lane is EXACTLY the listing axis's — the store's
   * own declared search transport (and with it its egress, session prime and access declarations),
   * under the same per-host challenge cooldown, with the same challenge detection and the same
   * stored-cookie stale/fresh signals. A seed list is not a cheaper way into a store; it is a
   * smaller, declared set of pages reached down the identical path.
   */
  seed(siteId: string, listId: string): Promise<SeedResult>;
  /**
   * The ROTATING seed lists `siteId` declares, in declared order. Pure, like `seedLists`, and
   * deliberately a separate call: the seed axis never lists these pages.
   */
  rotatingSeedLists(siteId: string): RotatingSeedListsResult;
  /**
   * ONE declared rotating seed list, fetched down the seed axis's lane and parsed by `extractSeedList`.
   * A failure says whether it is deterministic or transient, and whether the store is blocking us.
   */
  rotatingSeed(siteId: string, listId: string): Promise<RotatingSeedResult>;
}

/** An untrusted listing item is kept only as `{ itemId, url? }` with a non-empty string itemId. */
const normalizeItem = (raw: unknown): ListingPage['items'][number] | undefined => {
  if (!raw || typeof raw !== 'object') return undefined;
  const { itemId, url } = raw as { itemId?: unknown; url?: unknown };
  if (typeof itemId !== 'string' || itemId.length === 0) return undefined;
  return typeof url === 'string' ? { itemId, url } : { itemId };
};

export function assembleCatalog(services: CatalogServices): Catalog {
  // Resolved ONCE per assembly (not per call), like the lookup's module-load resolution.
  const timeoutMs = resolveCatalogStoreTimeoutMs(process.env);
  const cd = services.challengeCooldown ?? getChallengeCooldown();
  const cfStore = services.cfCookieStore ?? getCfCookieStore();
  const pagesGuard = services.maxPagesGuard ?? getMaxPagesGuard();

  /**
   * THE HOST CLOCK (QB-U30b): every listing, seed and rotating fetch reserves the host's next slot on
   * the shared per-host clock BEFORE its timeout starts, waits for it, and runs the send block there;
   * the fetch then gets CATALOG_STORE_TIMEOUT_MS minus the wait, so wait + fetch stays within it and the
   * crawler's 75 s request keeps its margin. A slot past the wait cap is refused, and so is a send a
   * challenge cooldown closed while it waited: both answer `cooldown`, which the crawler reads as "stop
   * this store for the pass" (no request is sent). Off the clock: fetched at once, as before.
   */
  const onClock = <T>(host: string, caller: HostClockCaller, fetch: (ms: number) => Promise<T>): Promise<ClockedSendResult<T>> =>
    sendOnHostClock(
      {
        host,
        caller,
        budgetMs: timeoutMs,
        ...(caller === 'catalogListing' ? { latency: 'listing' as const } : {}),
        veto: () => (cd.isOpen(host) ? 'cooling' : undefined),
      },
      ms => fetch(ms ?? timeoutMs),
      services.hostClock ? { clock: services.hostClock } : {},
    );
  /** A send the clock did not make: `cooldown` with the wait it refused, or the cooldown that vetoed it. */
  const notSent = (host: string, out: Exclude<ClockedSendResult<unknown>, { sent: true }>) => {
    const remainingMs = out.refused ? out.waitMs : cd.remaining(host);
    // eslint-disable-next-line no-console
    console.warn(`[HOST-CLOCK] ${sanitizeForLog(host)} ${out.refused ? `refused the fetch: its slot is ${remainingMs} ms away` : 'began cooling while the fetch waited for its slot'}; store left alone this pass`);
    return { status: 'cooldown' as const, host, remainingMs };
  };

  /**
   * Fetch and parse ONE declared page (a seed list or a rotating seed list) down the listing lane:
   * the store's declared transport, its host cooldown, challenge detection and cookie signals.
   * `fetch` may answer with the store's status; when it does, a 4xx/5xx is reported rather than parsed.
   */
  const fetchDeclaredPage = async (
    siteId: string,
    listId: string,
    url: string,
    label: 'seed' | 'rotating seed',
    fetch: (url: string, searchFetch: SearchFetch) => Promise<FetchBodyOutcome>,
  ): Promise<
    | { status: 'ok'; items: CatalogItem[]; collectUrls: string[]; hasMore: false; count: number }
    | { status: 'unsupported'; reason: string }
    | { status: 'cooldown'; host: string; remainingMs: number }
    | ({ status: 'failed'; reason: string } & RotatingFailure)
  > => {
    const caps = services.profiles.forSite(siteId)!;
    let host: string;
    try {
      host = normalizeHost(new URL(url).hostname);
    } catch {
      return { status: 'unsupported', reason: `malformed ${label} list url` };
    }
    const ruleset = services.getRulesetForUrl(url);
    if (!ruleset?.extractSeedList) return { status: 'unsupported', reason: 'ruleset has no extractSeedList parser' };

    // The listing axis's cooldown gate, unchanged: a cooling host is skipped WITHOUT fetching,
    // because a challenge fetch degrades the egress IP's reputation for every other store on it.
    if (cd.isOpen(host)) {
      const remainingMs = cd.remaining(host);
      const minsLeft = Math.max(1, Math.ceil(remainingMs / 60_000));
      // eslint-disable-next-line no-console
      console.warn(`[COOLDOWN] skipped ${sanitizeForLog(url)} (${host} cooling, ${minsLeft} min left)`);
      return { status: 'cooldown', host, remainingMs };
    }

    const fail = (why: string, f: RotatingFailure) => {
      const reason = sanitizeForLog(why);
      // eslint-disable-next-line no-console
      console.warn(`[catalog] ${sanitizeForLog(siteId)} ${label} ${sanitizeForLog(listId)} failed: ${reason}`);
      return { status: 'failed' as const, reason, ...f };
    };
    const transport = services.profiles.searchTransportFor(caps.domains[0] ?? host);
    let gate: ReturnType<typeof gateOutcomeOf>;
    try {
      const sent = await onClock(host, label === 'seed' ? 'catalogSeed' : 'catalogRotating', ms => withTimeout(fetch(url, transport), ms, `${label} list fetch`));
      if (!sent.sent) return notSent(host, sent);
      gate = gateOutcomeOf(sent.value);
    } catch (err) {
      // The request never produced a page (network, proxy, timeout): nothing says the next try fails.
      return fail(err instanceof Error ? err.message : String(err), { failure: 'transient' });
    }
    const body = gate.body;
    const upstream = gate.status;
    // A challenge body is NOT an empty shelf: parsing it would report the list as yielding
    // nothing, which on a SLOW-cadence axis is a silence nobody would question for a week.
    if (isCloudflareChallenge(body)) {
      cd.open(host, `${label} list challenge page`);
      markStaleIfStored(cfStore, url, host, transport.transport ?? 'http', `${label} list challenge page`);
      return fail('challenge page', { failure: 'deterministic', blocked: true });
    }
    // CLEAN means a 2xx the lane SAW with a real body (gateSignal): an empty body or a 5xx from a
    // gated host is a refused gate — stale mark + a strike toward the host's cooldown — and a
    // status-blind body proves nothing either way. Neither marks the host FRESH.
    const lane = transport.transport ?? 'http';
    const verdict = observeGate({ cooldown: cd, store: cfStore }, { url, host, lane, searchFetch: transport, ...gate });
    if (upstream !== undefined && upstream >= 400) {
      const blocked = upstream === 401 || upstream === 403 || upstream === 429;
      const failure = upstream >= 500 || upstream === 429 ? 'transient' : 'deterministic';
      return fail(`store answered ${upstream}`, { failure, ...(blocked ? { blocked: true as const } : {}), upstreamStatus: upstream });
    }
    // A refused gate that still answered 2xx (an empty body) is not an empty shelf either. It is
    // `transient` and not `blocked`: the crawler stops the store for this pass on a transient, so the
    // next list of the same refusing host is not fetched in the same pass.
    if (verdict === 'gate_failure') return fail(gateFailureReason(gate, lane), { failure: 'transient' });
    // A clean page inside an OPEN window (opened while this fetch was in flight) is not FRESH either.
    if (verdict === 'clean' && !cd.isOpen(host)) markFreshIfStored(cfStore, url, host);
    try {
      // UNTRUSTED plugin output, guarded exactly as the listing axis guards it. `hasMore` and
      // `nextPage` are NOT read at all: a declared list is one page, so a parser claiming a
      // further page is claiming something this axis has no way to fetch.
      const parsed: unknown = await ruleset.extractSeedList(body, listId);
      const raw = parsed && typeof parsed === 'object' ? (parsed as Partial<ListingPage>) : {};
      const items = Array.isArray(raw.items)
        ? raw.items.map(normalizeItem).filter((it): it is ListingPage['items'][number] => it !== undefined)
        : [];
      const decorated: CatalogItem[] = items.map((it) => withCollectUrl(it, caps.retrieval, url));
      const collectUrls = decorated.map((it) => it.collectUrl).filter((u): u is string => typeof u === 'string' && u.length > 0);
      return { status: 'ok', items: decorated, collectUrls, hasMore: false, count: decorated.length };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err), { failure: 'deterministic' });
    }
  };

  return {
    seedLists(siteId) {
      const caps = services.profiles.forSite(siteId);
      if (!caps) return { status: 'unsupported', siteId, reason: 'unknown store' };
      const lists = declaredSeedLists(caps.retrieval);
      if (lists.length === 0) return { status: 'unsupported', siteId, reason: 'store declares no seed lists' };
      const seedLists: SeedListSummary[] = lists.map((l) => ({ id: l.id, url: l.url, cadence: l.cadence, ...(l.note ? { note: l.note } : {}) }));
      return { status: 'ok', siteId, seedLists, count: seedLists.length };
    },

    async seed(siteId, listId) {
      const caps = services.profiles.forSite(siteId);
      if (!caps) return { status: 'unsupported', siteId, reason: 'unknown store' };
      const lists = declaredSeedLists(caps.retrieval);
      if (lists.length === 0) return { status: 'unsupported', siteId, reason: 'store declares no seed lists' };
      const list = lists.find((l) => l.id === listId);
      // An UNDECLARED id is a coverage gap, never a fetch: the whole point of the axis is that the
      // set of pages it may reach was written down in advance.
      if (!list) return { status: 'unsupported', siteId, reason: `store declares no seed list ${JSON.stringify(listId)}` };
      const out = await fetchDeclaredPage(siteId, listId, list.url, 'seed', services.fetchSearchDetail ?? services.fetchSearch);
      if (out.status !== 'failed') return out.status === 'ok' ? { ...out, siteId, listId, url: list.url } : { ...out, siteId };
      return { status: 'failed', siteId, reason: out.reason };
    },

    rotatingSeedLists(siteId) {
      const caps = services.profiles.forSite(siteId);
      if (!caps) return { status: 'unsupported', siteId, reason: 'unknown store' };
      const lists = declaredRotatingSeedLists(caps.retrieval);
      if (lists.length === 0) return { status: 'unsupported', siteId, reason: 'store declares no rotating seed lists' };
      return { status: 'ok', siteId, rotatingSeedLists: lists, count: lists.length };
    },

    async rotatingSeed(siteId, listId) {
      const caps = services.profiles.forSite(siteId);
      if (!caps) return { status: 'unsupported', siteId, reason: 'unknown store' };
      const lists = declaredRotatingSeedLists(caps.retrieval);
      if (lists.length === 0) return { status: 'unsupported', siteId, reason: 'store declares no rotating seed lists' };
      const list = lists.find((l) => l.id === listId);
      if (!list) return { status: 'unsupported', siteId, reason: `store declares no rotating seed list ${JSON.stringify(listId)}` };
      const out = await fetchDeclaredPage(siteId, listId, list.url, 'rotating seed', services.fetchSearchDetail ?? services.fetchSearch);
      if (out.status === 'ok') return { ...out, siteId, listId, group: list.group, url: list.url };
      return { ...out, siteId };
    },

    idRange(siteId, from, count) {
      const caps = services.profiles.forSite(siteId);
      if (!caps) return { status: 'unsupported', siteId, reason: 'unknown store' };
      // byRange is the store's DECLARATION that its ids are sequential/enumerable; byId is what turns
      // one of those ids into a fetchable URL. Neither alone makes a walk valid.
      if (caps.retrieval?.byRange !== true) return { status: 'unsupported', siteId, reason: 'store declares no byRange axis' };
      const byIdTemplate = caps.retrieval?.byId?.urlTemplate;
      if (!byIdTemplate) return { status: 'unsupported', siteId, reason: 'store declares no byId axis to build item urls from' };
      // Without the placeholder every id in the window resolves to the SAME url: the queue would
      // coalesce them onto one fetch while the crawler ledgered each id as done and walked past it.
      if (!byIdTemplate.includes('{id}')) return { status: 'unsupported', siteId, reason: 'byId urlTemplate has no {id} placeholder to walk' };
      if (!Number.isSafeInteger(from) || from < 1) {
        return { status: 'failed', siteId, reason: `invalid from ${from} (must be a positive integer)` };
      }
      // CHALLENGE COOLDOWN gate, keyed by the host the window's own item urls point at — the same
      // gate the listing axis applies before fetching. A window handed out now would be enqueued in
      // full, ledgered and walked past while every item fast-fails on the cooling host.
      const first = resolveByIdUrl(caps.retrieval, String(from));
      let host: string;
      try {
        host = normalizeHost(new URL(first as string).hostname);
      } catch {
        return { status: 'unsupported', siteId, reason: 'malformed byId url template' };
      }
      if (cd.isOpen(host)) return { status: 'cooldown', siteId, host, remainingMs: cd.remaining(host) };
      const size = Math.min(MAX_ID_RANGE_COUNT, Math.max(1, Number.isSafeInteger(count) ? (count as number) : DEFAULT_ID_RANGE_COUNT));
      const lowest = Math.max(1, from - size + 1);
      const items: CatalogItem[] = [];
      for (let id = from; id >= lowest; id--) {
        const collectUrl = resolveByIdUrl(caps.retrieval, String(id));
        items.push(collectUrl ? { itemId: String(id), collectUrl } : { itemId: String(id) });
      }
      const collectUrls = items.map((it) => it.collectUrl).filter((u): u is string => typeof u === 'string' && u.length > 0);
      const hasMore = lowest > 1;
      return {
        status: 'ok',
        siteId,
        from,
        items,
        collectUrls,
        hasMore,
        ...(hasMore ? { nextFrom: lowest - 1 } : {}),
        count: items.length,
      };
    },

    async catalog(siteId, page) {
      const caps = services.profiles.forSite(siteId);
      if (!caps) return { status: 'unsupported', siteId, reason: 'unknown store' };
      const byListing = caps.retrieval?.byListing;
      if (!byListing) return { status: 'unsupported', siteId, reason: 'store declares no byListing axis' };
      const pageNo = page ?? byListing.pageStart ?? 1;
      const url = resolveListingUrl(caps.retrieval, pageNo);
      if (!url) return { status: 'failed', siteId, reason: `invalid page ${pageNo} (must be a positive integer)` };
      let host: string;
      try {
        host = normalizeHost(new URL(url).hostname);
      } catch {
        return { status: 'unsupported', siteId, reason: 'malformed byListing url template' };
      }
      const ruleset = services.getRulesetForUrl(url);
      if (!ruleset?.extractListing) return { status: 'unsupported', siteId, reason: 'ruleset has no extractListing parser' };

      // MAXPAGES GUARD (SCRAPE_CATALOG_MAX_PAGES_GUARD, QB-U24): a page above the last page the profile
      // declares is answered with the existing exhausted page and NO store fetch, for a guarded store. It is
      // a fact about the declaration, not about the host, so it is answered ahead of the cooldown gate.
      const lastPage = declaredLastPage(byListing);
      if (lastPage !== undefined && pageNo > lastPage && pagesGuard.covers(siteId)) {
        pagesGuard.record(siteId, Date.now());
        return { status: 'ok', siteId, page: pageNo, url, items: [], collectUrls: [], hasMore: false, count: 0 };
      }

      // CHALLENGE COOLDOWN gate, keyed by the host actually fetched (a sibling api. host cools on its
      // own): a cooling host is skipped WITHOUT fetching — a challenge fetch degrades the egress IP's
      // CF reputation — and reported as `cooldown` (the store is fine; we are leaving it alone).
      if (cd.isOpen(host)) {
        const remainingMs = cd.remaining(host);
        const minsLeft = Math.max(1, Math.ceil(remainingMs / 60_000));
        // eslint-disable-next-line no-console
        console.warn(`[COOLDOWN] skipped ${sanitizeForLog(url)} (${host} cooling, ${minsLeft} min left)`);
        return { status: 'cooldown', siteId, host, remainingMs };
      }

      try {
        // The STORE's declared search transport (impersonate / browser / http), resolved from its
        // primary domain exactly as /lookup does — the listing may live on a sibling host (api.)
        // the store's domains don't list. BOUNDED so a hung / CF-stalled store fails, not stalls.
        const transport = services.profiles.searchTransportFor(caps.domains[0] ?? host);
        const sent = await onClock(host, 'catalogListing', ms =>
          withTimeout(services.fetchSearchDetail ? services.fetchSearchDetail(url, transport) : services.fetchSearch(url, transport), ms, 'catalog fetch'),
        );
        if (!sent.sent) return { ...notSent(host, sent), siteId };
        const gate = gateOutcomeOf(sent.value);
        const body = gate.body;
        // HONEST LISTING: a CF challenge/block body is NOT a catalog page — extractListing would
        // lift 0 items and pose the page as "end of catalog". Detect it BEFORE parsing, open the
        // host's cooldown so the queue and the next crawl leave it alone, and report failed.
        if (isCloudflareChallenge(body)) {
          // eslint-disable-next-line no-console
          console.warn(`[catalog] ${sanitizeForLog(siteId)} page ${pageNo} failed: challenge page`);
          cd.open(host, 'catalog challenge page');
          // STORED-COOKIE STALE signal: a host WITH stored cookies still challenged → dead cookie,
          // marked once via the lane that fetched (a host without stored cookies is never marked).
          markStaleIfStored(cfStore, url, host, transport.transport ?? 'http', 'catalog challenge page');
          return { status: 'failed', siteId, reason: 'challenge page' };
        }
        // A clean listing for a host WITH stored cookies is the FRESH signal (clears a stale mark).
        // CLEAN means a 2xx the lane SAW with a real body (gateSignal): an empty body or a 5xx from a
        // gated host is a refused gate — stale mark + a strike toward the host's cooldown — and a
        // status-blind body proves nothing either way. Neither marks the host FRESH.
        const lane = transport.transport ?? 'http';
        const verdict = observeGate({ cooldown: cd, store: cfStore }, { url, host, lane, searchFetch: transport, ...gate });
        // HONEST LISTING, as for a challenge: a refused gate is not a catalog page — parsing it would
        // pose the store as "end of catalog". Report it failed; the strike above already counted.
        if (verdict === 'gate_failure') {
          const reason = gateFailureReason(gate, lane);
          // eslint-disable-next-line no-console
          console.warn(`[catalog] ${sanitizeForLog(siteId)} page ${pageNo} failed: ${reason}`);
          return { status: 'failed', siteId, reason };
        }
        // A clean page inside an OPEN window (opened while this fetch was in flight) is not FRESH either.
        if (verdict === 'clean' && !cd.isOpen(host)) markFreshIfStored(cfStore, url, host);
        // UNTRUSTED plugin output: a non-object page → no items; a non-array `items` → none; each
        // item must be an object with a non-empty string itemId (else dropped); paging signals are
        // used only when well-typed, else derived (non-empty page ⇒ more; next = page + 1).
        const listing: unknown = await ruleset.extractListing(body, url);
        const raw = listing && typeof listing === 'object' ? (listing as Partial<ListingPage>) : {};
        const items = Array.isArray(raw.items)
          ? raw.items.map(normalizeItem).filter((it): it is ListingPage['items'][number] => it !== undefined)
          : [];
        const hasMore = typeof raw.hasMore === 'boolean' ? raw.hasMore : items.length > 0;
        const nextPage = Number.isInteger(raw.nextPage) && (raw.nextPage as number) > pageNo
          ? (raw.nextPage as number)
          : hasMore ? pageNo + 1 : undefined;
        const decorated: CatalogItem[] = items.map((it) => withCollectUrl(it, caps.retrieval, url));
        const collectUrls = decorated.map((it) => it.collectUrl).filter((u): u is string => typeof u === 'string' && u.length > 0);
        return {
          status: 'ok',
          siteId,
          page: pageNo,
          url,
          items: decorated,
          collectUrls,
          hasMore,
          ...(nextPage !== undefined ? { nextPage } : {}),
          count: decorated.length,
        };
      } catch (err) {
        // Surface WHY the page dropped (CF block / transport error / timeout / parser throw) — sanitized.
        const reason = sanitizeForLog(err instanceof Error ? err.message : String(err));
        // eslint-disable-next-line no-console
        console.warn(`[catalog] ${sanitizeForLog(siteId)} page ${pageNo} failed: ${reason}`);
        return { status: 'failed', siteId, reason };
      }
    },
  };
}
