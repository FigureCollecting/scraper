/**
 * runCrawlerPass — ONE bounded catalog-crawl pass (the CronJob body). The feeder
 * that turns the scraper's per-store catalog listing into continuous collection.
 *
 * WHAT IT DOES (and deliberately no more):
 *   RECENT  — from page 1 of the store's newest-first listing (GET {scraper}/catalog
 *             ?store=&page=), up to recentMaxPages: POST every NEW item's collectUrl
 *             to {scraper}/ingest/scrape, and stop at the first page that yields
 *             nothing new. An item is "new" when it is not in the store's ledger, or
 *             (reobserveAfterMs > 0) its ledger entry is at least that old.
 *   ID-RANGE — for a store whose ids are SEQUENTIAL (retrieval.byRange, e.g. mfc's ~3.6M numeric
 *             item ids), the id space itself is the listing: after the listing phases, walk DOWN
 *             from a frontier through GET /catalog?store=&range=1&from=&count=, which SYNTHESIZES
 *             the window's {itemId, collectUrl} pairs from the store's byId template without
 *             fetching anything upstream. Only stores named in config.rangeStores walk. The
 *             frontier is the highest numeric itemId the ledger has seen, else the operator's
 *             CRAWLER_RANGE_FRONTIER_<SITEID> seed; with neither, the walk is skipped with a WARN.
 *             The window's cursor is durable (ledger.range.cursor) and moves DOWN only over ids
 *             actually handled, so nothing is ever re-walked and nothing is stranded; it shares the
 *             store's enqueue cap and the global budget. Ids in the window that do not exist at the
 *             store are EXPECTED — the ingest fetch 404s and the failure is recorded there, not here.
 *   REOBSERVE — the RE-OBSERVATION lane (D4, Ross 2026-09-18), which walks the LEDGER instead of the
 *             store's pages: the N oldest-observed ids whose last observation is older than
 *             config.reobserveMinAgeMs are re-driven through the ABSOLUTE item url the ledger already
 *             holds (the store's byId url where it has that axis, the listing's own item link where
 *             it does not), so an exhausted store keeps a live price/availability series instead of
 *             freezing on the day it was walked. It has its OWN per-store budget
 *             (config.storeReobserveCaps, default 0 = off, so the fleet opts in per store) spent from
 *             the SAME global gate, so neither lane can starve the other; it runs LAST, after every
 *             discovery phase, so discovery keeps its budget priority unchanged. Stores take turns
 *             one id at a time (round-robin), oldest first within a store. Its landings are
 *             `reobserveLanded`, its OWN counter — never `enqueued` (which `capApplied` bounds), and
 *             never the shared `reobserved`, which also carries the recent phase's window.
 *   BACKFILL — resume the store's durable page cursor and walk forward up to
 *             backfillPagesPerRun pages, enqueuing NEW ids only (never re-observing).
 *             The cursor advances ONLY when the page reported `hasMore: true` AND every
 *             new item on it was attempted — a page cut short by the per-store cap, the
 *             global budget, or a sick scraper is re-fetched next run (known ids skip).
 *             `nextPage` is ignored: a contradictory {hasMore:false, nextPage:N} exists.
 *
 * END-OF-CATALOG IS CONFIRMED, NEVER INFERRED FROM ONE PAGE. The LISTING lane is still
 * status-blind: /catalog rides the string-returning http fetch, so a Shopify page-cap
 * 400 or a transient 5xx parses as an empty listing here exactly as before. (The RECORD
 * lane no longer is — every ingest transport now surfaces {status, finalUrl} and the
 * queue's status gate fails a 404/410/403/429/5xx as the store's own answer — but that
 * says nothing about the page THIS pass just read.) So an empty / hasMore:false page
 * only records an EXHAUSTION CANDIDATE at that cursor and stops the run without
 * advancing. Only when the NEXT run sees the same cursor empty again is the store
 * marked exhausted (cursor kept); items reappearing clear the candidate. A last page CUT SHORT (cap / budget / sick
 * scraper) is neither a candidate nor a confirmation: its marks are kept as they were
 * and the page is re-fetched next run. An exhausted store is re-checked at its last
 * cursor once exhaustedRecheckMs has elapsed.
 *
 * PER-STORE ENQUEUE CAPS: a store may carry its own ceiling (config.storeEnqueueCaps) instead of the
 * global maxEnqueuePerStore — one Cloudflare-gated store that stalls above ~15 items/hour is held
 * back without throttling the rest. An explicit per-store 0 pulls that store OUT of the run (no
 * requests, no ledger access); the GLOBAL 0 keeps its discovery-only-dry-run meaning.
 *
 * MODE both (default) runs recent for EVERY store, THEN backfill — recent has budget
 * priority. Stores run in parallel under ONE global RequestGate (concurrency, total
 * budget over catalog GETs + ingest POSTs, spacing); pages within a store are
 * sequential. The ledger is saved after EVERY page (tmp file + rename), so a crash
 * or a budget stop loses nothing; the ID-RANGE axis saves once per WINDOW instead (its
 * ids are one bounded batch, not a page each), so a pod killed mid-window re-walks that
 * window next run — duplicate POSTs the queue coalesces, never a lost or skipped id.
 * A corrupt ledger refuses the store and is NEVER overwritten. Imports nothing from src/driver/* — this is a thin HTTP client.
 */
import { createRequestGate, type GateResult, type RequestGate } from '../initiator/requestGate.js';
import { logger } from '../utils/logger.js';
import { classifyFetchFailure } from '../services/failureClassifier.js';
import type { FetchFailureReport, ReportFetchFailure } from '../services/failureReporter.js';
import type { CrawlerConfig, CrawlerMode } from './config.js';
import type { Ledger, LedgerRange, LedgerStore } from './ledger.js';

export type { CrawlerConfig, CrawlerMode } from './config.js';

/** The minimal Fetch Response surface the crawler consumes (global fetch satisfies it). */
export interface HttpResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<any>;
  text(): Promise<string>;
}

/** The injectable HTTP surface — global fetch in production, a fake in tests. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<HttpResponseLike>;

export interface CrawlerDeps {
  fetch: FetchLike;
  ledgerStore: LedgerStore;
  /** Clock (epoch ms) — ledger timestamps, re-observe / re-check windows, summary times. Defaults to Date.now. */
  now?: () => number;
  /** Sleep used by the gate's spacing. */
  sleep?: (ms: number) => Promise<void>;
  /** Override the gate (tests); defaults to one built from the config. */
  gate?: RequestGate;
  /**
   * The durable fetch-failure ledger seam (createFailureReporterFromEnv). Optional — absent means
   * reporting is OFF and every emit point is a no-op. A crawler failure is terminal per store/axis
   * (a failed catalog GET stops that axis for the run), so each exit reports exactly one row.
   */
  reportFailure?: ReportFetchFailure;
}

/** What one declared seed list yielded this run (mode `seed` only), in the order the lists were polled. */
export interface SeedListStat {
  listId: string;
  /** Items with a usable itemId the list offered. */
  discovered: number;
  /** Of those, the ones the ledger had already enqueued (or this run had already handled). */
  known: number;
  /** POSTs the scraper accepted from this list. */
  enqueued: number;
  /**
   * Other declared ids that resolve to the SAME url as this one, and were therefore served by this
   * single fetch. Present only when the store's declaration actually repeats a url (an authoring
   * slip): the ids are credited here rather than dropped, so the summary still accounts for every id
   * the store declared without double-counting one page's items.
   */
  alsoDeclaredAs?: string[];
}

export interface CrawlerStoreSummary {
  siteId: string;
  /** Listing pages fetched with 200 (recent + backfill). */
  pagesFetched: number;
  recentPages: number;
  /** New (or re-observable) ids the recent phase found this run. */
  recentNew: number;
  backfillPages: number;
  /** Items with a usable itemId seen across fetched pages. */
  discovered: number;
  /** Items skipped as already enqueued (ledger) or already handled this run. */
  known: number;
  /** Items lacking a collectUrl (cannot be enqueued). */
  uncollectable: number;
  /**
   * POSTs the scraper accepted (HTTP 202) from the DISCOVERY phases — recent, backfill, id-range,
   * seed. Bounded by `capApplied`, and deliberately so: the RE-OBSERVATION lane's accepted POSTs are
   * counted in `reobserveLanded` and NEVER here, because a store summary reading
   * `enqueued: 5, capApplied: 2` reads as a breached discovery cap to anyone scanning the fleet logs.
   */
  enqueued: number;
  /** Of `enqueued`, how many the queue coalesced onto a pending item (discovery only — see `enqueued`). */
  deduplicated: number;
  /**
   * Re-observations of known items from BOTH mechanisms: the RECENT phase's `reobserveAfterMs` window
   * (a known item that reappears on listing pages 1..N, which spends the DISCOVERY cap) and the
   * re-observation lane. For the lane's own work — the number a live acceptance should read — use
   * `reobserveLanded`.
   */
  reobserved: number;
  /** RE-OBSERVE: POSTs the LANE landed (the scraper accepted), never the recent phase's. */
  reobserveLanded: number;
  /** RE-OBSERVE: ids the lane SELECTED this run (what it would have driven — the dry run reports only this). */
  reobserveSelected: number;
  /** RE-OBSERVE: known ids passed over because their last observation (or their last refusal) is inside the min-age window. */
  reobserveSkipped: number;
  /** RE-OBSERVE: selected ids whose POST was refused (4xx, backed off) or failed transiently. */
  reobserveFailed: number;
  /**
   * RE-OBSERVE: the ceiling the lane ACTUALLY ran under for this store — its
   * CRAWLER_STORE_REOBSERVE_CAPS override, else the global one, and 0 whenever the lane could not
   * touch the store at all. Deliberately not the CONFIGURED value: a store reading
   * `reobserveCapApplied: 8` beside zero activity sends an operator looking for a broken lane instead
   * of at whatever held the store back. The configured value is still reported once, at run level, in
   * `reobserveCapOverrides`; `reobserveLaneSkipped` names the reason.
   */
  reobserveCapApplied: number;
  /** RE-OBSERVE: why the lane did no work for this store, `null` when it considered the store. */
  reobserveLaneSkipped: ReobserveSkipReason | null;
  /** The enqueue ceiling this store ran under: its CRAWLER_STORE_ENQUEUE_CAPS override, else the global cap. */
  capApplied: number;
  /** Failed catalog GETs, rejected/failed ingest POSTs, ledger failures. */
  errors: number;
  /** Catalog GETs answered 503 cooldown (the store was left alone this run). */
  skipped: number;
  ledgerCorrupt: boolean;
  /** Ids the id-range backfill walked this run (POSTed + skipped as known). */
  rangeWalked: number;
  /** The store's id-range cursor after this run: the next id to walk (null = never walked, 0 = floor reached). */
  rangeCursor: number | null;
  /** The frontier the id-range walk started from (null until one is known). */
  rangeFrontier: number | null;
  /**
   * Why the id-range walk did not request a window this run, `null` when it did. Starvation
   * (`cap`, `budget`) otherwise looks exactly like a store that was never armed for the axis.
   */
  rangeSkipped: RangeSkipReason | null;
  /**
   * Per-list stats for a `seed`-mode run, in the order the lists were polled. Empty in every other
   * mode, and empty for a store whose seed pass never got a list (no declaration, or a stop).
   */
  seedLists: SeedListStat[];
  /**
   * Why the seed pass stopped this store early, `null` when it ran every declared list (or did not
   * run at all). A seed pass is a handful of requests, so a store that quietly did three of its five
   * lists must not look the same as one that did all five.
   */
  seedStopped: SeedStopReason | null;
  /** The store's backfill cursor after this run (null until backfill first runs). */
  backfillCursor: number | null;
  /** An empty page was seen at the cursor once; awaiting confirmation next run. */
  exhaustCandidate: boolean;
  /** End-of-catalog confirmed; re-checked after exhaustedRecheckMs. */
  exhausted: boolean;
}

export interface CrawlerSummary {
  scraperServiceUrl: string;
  mode: CrawlerMode;
  storesConfigured: number;
  maxConcurrency: number;
  requestBudget: number;
  requestsIssued: number;
  budgetExhausted: boolean;
  peakInFlight: number;
  totalPagesFetched: number;
  totalDiscovered: number;
  /** Accepted DISCOVERY POSTs across every store this run (the lane's are in `totalReobserveLanded`). */
  totalEnqueued: number;
  /** Re-observations across every store this run, from BOTH mechanisms — the recent phase's window AND the lane. */
  totalReobserved: number;
  /** RE-OBSERVE: POSTs the LANE landed across every store this run. */
  totalReobserveLanded: number;
  totalRangeWalked: number;
  totalErrors: number;
  totalSkipped: number;
  /** The per-store enqueue caps that actually applied this run, keyed by siteId (a cap for a store not crawled is not listed). */
  enqueueCapOverrides: Record<string, number>;
  /** The per-store RE-OBSERVE caps that actually applied this run, keyed by siteId. */
  reobserveCapOverrides: Record<string, number>;
  stores: CrawlerStoreSummary[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

interface CatalogItem {
  itemId: string;
  collectUrl?: string;
}

/** Why a /catalog GET stopped its axis — surfaced on the id-range summary, ignored by the listing phases. */
type StopReason = 'budget' | 'cooldown' | 'unsupported' | 'failed';

/**
 * Why the SEED pass stopped a store early. The fetch stop reasons, plus `cap`: the store's enqueue
 * ceiling was spent, so the lists after it were not fetched at all. Starvation by the cap otherwise
 * looks exactly like a store that simply declared fewer lists.
 */
export type SeedStopReason = StopReason | 'cap';

/**
 * Why the RE-OBSERVATION lane did no work for a store. `null` on the summary means the lane
 * considered the store (it built a selection, which may still have been empty because every id was
 * inside the min-age window).
 */
export type ReobserveSkipReason =
  /** CRAWLER_MODE does not name `reobserve`: the lane did not run at all this pass. */
  | 'mode-off'
  /** The lane ran, but this store has no cap of its own and the global default is 0. */
  | 'not-configured'
  /** An explicit DISCOVERY cap of 0 pulled the store out of the whole run, this lane included. */
  | 'store-out'
  /** The store's ledger was corrupt or could not be loaded, so there is nothing to walk. */
  | 'ledger'
  /** The store was stopped before the lane — a cooling host, a sick scraper, a spent budget. */
  | 'store-stopped';

/** Why the id-range walk made no window request this run. */
export type RangeSkipReason = StopReason | 'not-configured' | 'not-run' | 'store-stopped' | 'cap' | 'no-frontier' | 'floor' | 'window-malformed';

type PageOutcome = { kind: 'page'; items: CatalogItem[]; hasMore: boolean } | { kind: 'stopped'; reason: StopReason };

/** One seed list the pass will actually poll, plus the declared ids that collapsed onto its url. */
interface SeedListTarget {
  id: string;
  aliases: string[];
}

type PostOutcome = 'accepted' | 'accepted-dedup' | 'rejected' | 'transient' | 'budget';

type Phase = 'recent' | 'backfill' | 'range' | 'seed' | 'reobserve';

interface StoreState {
  siteId: string;
  summary: CrawlerStoreSummary;
  /** This store's enqueue ceiling for the run (override or global) — the only cap processPage consults. */
  enqueueCap: number;
  /** null when the ledger could not be loaded (corrupt / fs error) — the store does no work. */
  ledger: Ledger | null;
  /** itemIds POSTed this run (dedupe within a run, across pages and phases). */
  attempted: Set<string>;
  /** POSTs dispatched this run (the per-store cap). */
  posts: number;
  /** The RE-OBSERVATION lane's own ceiling for the run — SEPARATE from `enqueueCap`, so neither lane starves the other. */
  reobserveCap: number;
  /** No further requests for this store this run (cooldown, unsupported, failure, budget, ledger failure). */
  stopped: boolean;
  /** The per-store enqueue cap blocked a POST this run. */
  capReached: boolean;
  /** An explicit DISCOVERY cap of 0 pulled this store out of the whole run before any request. */
  pulledOut: boolean;
  /**
   * The store's LISTING axis answered 422 (no byListing / no extractListing). That stops the listing
   * phases only — the id-range axis is a different axis on the same store and still runs. Every
   * OTHER stop reason (cooldown, budget, a sick scraper, a ledger failure) applies to all axes.
   */
  listingUnsupported: boolean;
  /** Deepest listing page the recent phase fetched this run (backfill starts after it). */
  deepestRecentPage: number;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const errMsg = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** GET with an abort-based timeout; rejects on network error / timeout, resolves with the response otherwise. */
async function httpGet(fetchImpl: FetchLike, url: string, timeoutMs: number): Promise<HttpResponseLike> {
  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  try {
    return await fetchImpl(url, { method: 'GET', signal: controller.signal });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** POST JSON with an abort-based timeout. */
async function httpPostJson(fetchImpl: FetchLike, url: string, payload: unknown, timeoutMs: number): Promise<HttpResponseLike> {
  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  try {
    return await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Untrusted listing items → the usable subset: a non-empty string itemId; collectUrl only when a non-empty string. */
const sanitizeItems = (raw: unknown[]): CatalogItem[] => {
  const out: CatalogItem[] = [];
  for (const it of raw) {
    if (!isPlainObject(it) || typeof it.itemId !== 'string' || it.itemId.length === 0) continue;
    const collectUrl = typeof it.collectUrl === 'string' && it.collectUrl.length > 0 ? it.collectUrl : undefined;
    out.push({ itemId: it.itemId, collectUrl });
  }
  return out;
};

export async function runCrawlerPass(config: CrawlerConfig, deps: CrawlerDeps): Promise<CrawlerSummary> {
  const now = deps.now ?? Date.now;
  // The seed axis's own wait. Shares the injected seam with the gate's spacing so one fake clock
  // drives both in tests, but is a SEPARATE floor: the gate spaces every dispatch globally, this
  // spaces one store's seed fetches from each other.
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const iso = (): string => new Date(now()).toISOString();
  const startedAtMs = now();
  const gate =
    deps.gate ??
    createRequestGate({
      maxConcurrency: config.maxConcurrency,
      maxRequests: config.maxRequests,
      spacingMs: config.requestSpacingMs,
      now,
      sleep: deps.sleep,
    });

  const stores = config.stores.filter((s, i) => config.stores.indexOf(s) === i);
  const capOverrides = config.storeEnqueueCaps ?? {};
  // Only the overrides for stores actually crawled this run are reported — a cap naming a store that
  // is not in CRAWLER_STORES did nothing and must not read as if it had.
  const enqueueCapOverrides: Record<string, number> = {};
  for (const siteId of stores) {
    if (Object.prototype.hasOwnProperty.call(capOverrides, siteId)) enqueueCapOverrides[siteId] = capOverrides[siteId];
  }
  // A cap or a range entry naming a store that is NOT being crawled did nothing. Silently dropping it
  // makes a typo (or a store removed from CRAWLER_STORES) look like a throttle that is in force.
  for (const siteId of Object.keys(capOverrides)) {
    if (!stores.includes(siteId)) logger.warn('[CRAWLER] CRAWLER_STORE_ENQUEUE_CAPS names a store that is not being crawled — ignored', { siteId });
  }
  for (const siteId of config.rangeStores) {
    if (!stores.includes(siteId)) logger.warn('[CRAWLER] CRAWLER_RANGE_STORES names a store that is not in CRAWLER_STORES — no id-range walk', { siteId });
  }

  /**
   * Fire ONE ledger row. Best effort: no reporter is a no-op, and neither a synchronous throw nor a
   * rejected report may change the pass — the summary counters stay the caller's contract.
   */
  const emitFailure = (report: FetchFailureReport): void => {
    if (!deps.reportFailure) return;
    try {
      void Promise.resolve(deps.reportFailure(report)).catch(() => {});
    } catch {
      // bookkeeping never breaks a crawl
    }
  };

  /**
   * The CANONICAL, environment-free ledger target for one listing fetch (spec §1.1). Deliberately
   * NOT the fetched URL: that is `${SCRAPER_SERVICE_URL}/catalog?…`, the scraper's OWN address,
   * which differs between the dev tier and prod and would split one store's failures across
   * environments.
   */
  const listingTarget = (siteId: string, axis: Phase, where: Record<string, unknown>): string => {
    const params = Object.entries(where)
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
      .join('&');
    return `fc:listing/${siteId}?axis=${axis}${params ? `&${params}` : ''}`;
  };

  const capFor = (siteId: string): number =>
    Object.prototype.hasOwnProperty.call(capOverrides, siteId) ? capOverrides[siteId] : config.maxEnqueuePerStore;

  // The RE-OBSERVATION lane's budget, read exactly like the discovery cap but from its OWN vars. The
  // global default is 0, so a store re-observes nothing until the fleet config opts it in by name —
  // re-observation spends real requests at a gated store, where browser time is the scarcest resource.
  const reobserveCapOverridesAll = config.storeReobserveCaps ?? {};
  const reobserveCapFor = (siteId: string): number =>
    Object.prototype.hasOwnProperty.call(reobserveCapOverridesAll, siteId) ? reobserveCapOverridesAll[siteId] : config.maxReobservePerStore;
  const reobserveCapOverrides: Record<string, number> = {};
  for (const siteId of stores) {
    if (Object.prototype.hasOwnProperty.call(reobserveCapOverridesAll, siteId)) reobserveCapOverrides[siteId] = reobserveCapOverridesAll[siteId];
  }
  for (const siteId of Object.keys(reobserveCapOverridesAll)) {
    if (!stores.includes(siteId)) logger.warn('[CRAWLER] CRAWLER_STORE_REOBSERVE_CAPS names a store that is not being crawled — ignored', { siteId });
  }

  const states: StoreState[] = stores.map((siteId) => ({
    siteId,
    enqueueCap: capFor(siteId),
    reobserveCap: reobserveCapFor(siteId),
    summary: {
      siteId,
      pagesFetched: 0,
      recentPages: 0,
      recentNew: 0,
      backfillPages: 0,
      discovered: 0,
      known: 0,
      uncollectable: 0,
      enqueued: 0,
      deduplicated: 0,
      reobserved: 0,
      reobserveLanded: 0,
      reobserveSelected: 0,
      reobserveSkipped: 0,
      reobserveFailed: 0,
      // An APPLIED ceiling: 0 until the lane actually takes this store on (see reobservePhase).
      reobserveCapApplied: 0,
      reobserveLaneSkipped: config.phases.includes('reobserve') ? 'not-configured' : 'mode-off',
      capApplied: capFor(siteId),
      errors: 0,
      skipped: 0,
      ledgerCorrupt: false,
      rangeWalked: 0,
      rangeCursor: null,
      rangeFrontier: null,
      rangeSkipped: config.rangeStores.includes(siteId) ? 'not-run' : 'not-configured',
      seedLists: [],
      seedStopped: null,
      backfillCursor: null,
      exhaustCandidate: false,
      exhausted: false,
    },
    ledger: null,
    attempted: new Set<string>(),
    posts: 0,
    // An EXPLICIT per-store cap of 0 pulls the store out of the run before any request: the operator
    // is holding it back (anitoys mid-stall), not asking for a dry run. A GLOBAL 0 keeps its
    // existing discovery-only meaning — pages are fetched, nothing is POSTed.
    stopped: Object.prototype.hasOwnProperty.call(capOverrides, siteId) && capOverrides[siteId] === 0,
    capReached: false,
    pulledOut: Object.prototype.hasOwnProperty.call(capOverrides, siteId) && capOverrides[siteId] === 0,
    listingUnsupported: false,
    deepestRecentPage: 0,
  }));

  let budgetExhausted = false;

  const catalogUrl = (siteId: string, page: number): string =>
    `${config.scraperServiceUrl}/catalog?store=${encodeURIComponent(siteId)}&page=${page}`;
  const rangeUrl = (siteId: string, from: number, count: number): string =>
    `${config.scraperServiceUrl}/catalog?store=${encodeURIComponent(siteId)}&range=1&from=${from}&count=${count}`;
  const seedsUrl = (siteId: string): string => `${config.scraperServiceUrl}/catalog?store=${encodeURIComponent(siteId)}&seeds=1`;
  const seedUrl = (siteId: string, listId: string): string =>
    `${config.scraperServiceUrl}/catalog?store=${encodeURIComponent(siteId)}&seed=${encodeURIComponent(listId)}`;
  const ingestUrl = `${config.scraperServiceUrl}/ingest/scrape`;

  const summarize = (): CrawlerSummary => {
    for (const st of states) {
      if (!st.ledger) continue;
      st.summary.backfillCursor = st.ledger.backfill.cursor;
      st.summary.rangeCursor = st.ledger.range?.cursor ?? null;
      st.summary.rangeFrontier = st.ledger.range?.frontier ?? null;
      st.summary.exhaustCandidate = st.ledger.backfill.exhaustCandidateCursor !== undefined;
      st.summary.exhausted = st.ledger.backfill.exhaustedAt !== undefined;
    }
    const perStore = states.map((st) => st.summary);
    const finishedAtMs = now();
    return {
      scraperServiceUrl: config.scraperServiceUrl,
      mode: config.mode,
      storesConfigured: stores.length,
      maxConcurrency: config.maxConcurrency,
      requestBudget: config.maxRequests,
      requestsIssued: gate.issued(),
      budgetExhausted,
      peakInFlight: gate.peakInFlight(),
      totalPagesFetched: perStore.reduce((n, s) => n + s.pagesFetched, 0),
      totalDiscovered: perStore.reduce((n, s) => n + s.discovered, 0),
      totalEnqueued: perStore.reduce((n, s) => n + s.enqueued, 0),
      totalReobserved: perStore.reduce((n, s) => n + s.reobserved, 0),
      totalReobserveLanded: perStore.reduce((n, s) => n + s.reobserveLanded, 0),
      totalRangeWalked: perStore.reduce((n, s) => n + s.rangeWalked, 0),
      totalErrors: perStore.reduce((n, s) => n + s.errors, 0),
      totalSkipped: perStore.reduce((n, s) => n + s.skipped, 0),
      enqueueCapOverrides,
      reobserveCapOverrides,
      stores: perStore,
      startedAt: new Date(startedAtMs).toISOString(),
      finishedAt: new Date(finishedAtMs).toISOString(),
      durationMs: finishedAtMs - startedAtMs,
    };
  };

  // Guard: with no stores there is nothing to do — touch neither the network nor the ledgers.
  if (stores.length === 0) {
    const summary = summarize();
    logger.info('[CRAWLER] pass complete (nothing to do)', summary as unknown as Record<string, unknown>);
    return summary;
  }

  // --- ledger -----------------------------------------------------------------------------------

  const loadLedger = async (st: StoreState): Promise<void> => {
    if (st.stopped) return; // pulled out by an explicit per-store cap of 0 — its ledger is not even opened
    try {
      const l = await deps.ledgerStore.load(st.siteId);
      if (l === 'corrupt') {
        // Refuse the store. The file is left EXACTLY as found for an operator to inspect.
        st.summary.errors++;
        st.summary.ledgerCorrupt = true;
        logger.warn('[CRAWLER] ledger corrupt — store refused, file left untouched', { siteId: st.siteId });
        return;
      }
      st.ledger = l;
    } catch (error) {
      st.summary.errors++;
      logger.warn('[CRAWLER] ledger load failed — store skipped', { siteId: st.siteId, error: errMsg(error) });
    }
  };

  /** Save after EVERY page. A failed save stops the store: crawling on without durable state would re-enqueue next run. */
  const persist = async (st: StoreState): Promise<boolean> => {
    st.ledger!.updatedAt = iso();
    try {
      await deps.ledgerStore.save(st.ledger!);
      return true;
    } catch (error) {
      st.summary.errors++;
      st.stopped = true;
      logger.warn('[CRAWLER] ledger save failed — store stopped', { siteId: st.siteId, error: errMsg(error) });
      return false;
    }
  };

  // --- http -------------------------------------------------------------------------------------

  /**
   * One /catalog GET — the LISTING axis (`&page=`) or the ID-RANGE axis (`&range=1&from=&count=`).
   * Both answer the same `{ items: [...] }` shape, so one parser serves both; `where` only labels the
   * logs and decides whether a 422 is a listing-axis gap (which leaves the id-range axis alive).
   */
  const fetchCatalogAs = async <T>(
    st: StoreState,
    url: string,
    where: Record<string, unknown>,
    axis: Phase,
    shape: { label: string; parse: (body: Record<string, unknown>) => T | undefined },
  ): Promise<{ kind: 'ok'; value: T } | { kind: 'stopped'; reason: StopReason }> => {
    const stop = (reason: StopReason): { kind: 'stopped'; reason: StopReason } => {
      st.stopped = true;
      return { kind: 'stopped', reason };
    };
    let r: GateResult<HttpResponseLike>;
    try {
      r = await gate.run(() => httpGet(deps.fetch, url, config.requestTimeoutMs));
    } catch (error) {
      st.summary.errors++;
      logger.warn('[CRAWLER] catalog errored', { siteId: st.siteId, ...where, error: errMsg(error) });
      // E6 — the transport itself failed (DNS / reset / the abort timer). Terminal for this axis.
      emitFailure({
        site: st.siteId,
        target: listingTarget(st.siteId, axis, where),
        kind: 'listing',
        origin: 'crawler',
        reasonClass: classifyFetchFailure({ error }).reasonClass === 'timeout' ? 'timeout' : 'network',
        message: errMsg(error),
      });
      return stop('failed');
    }
    if (r.status === 'budget-exhausted') {
      budgetExhausted = true;
      return stop('budget');
    }
    const res = r.value;
    if (res.status === 503) {
      // The host is cooling from a challenge: leave the store alone this run, change nothing.
      const body = await res.json().catch(() => ({}));
      st.summary.skipped++;
      logger.warn('[CRAWLER] catalog cooldown — store skipped this run', { siteId: st.siteId, ...where, remainingMs: body?.remainingMs });
      // E7 — the SCRAPER reports the host cooling, and it says so in its OWN envelope
      // ({error:'cooldown', remainingMs}, routes/catalog.ts). A 503 WITHOUT that envelope is the
      // ingress or a scaled-to-zero Deployment, not a Cloudflare window: claiming a cooldown there
      // would fabricate an observation in the one surface built for the operator to read. The crawl
      // behaviour is the same either way — the store is left alone this run.
      const isCooldown = isPlainObject(body) && body.error === 'cooldown';
      const remainingMs = isCooldown ? Number(body.remainingMs) : Number.NaN;
      emitFailure({
        site: st.siteId,
        target: listingTarget(st.siteId, axis, where),
        kind: 'listing',
        origin: 'crawler',
        reasonClass: isCooldown ? 'cooldown' : 'http_5xx',
        httpStatus: 503,
        message: isCooldown
          ? 'the scraper reports this host cooling after a Cloudflare challenge'
          : 'catalog GET answered 503 without the scraper\'s cooldown envelope',
        ...(Number.isFinite(remainingMs) && remainingMs > 0
          ? { nextRetryHint: new Date(now() + remainingMs).toISOString() }
          : {}),
      });
      return stop('cooldown');
    }
    if (res.status === 422) {
      // The store does not serve THIS axis (no byListing / no extractListing; or no byRange / byId):
      // a configuration or coverage gap, NOT exhaustion. A listing gap leaves the id-range axis alive.
      st.summary.errors++;
      // ONLY the listing axes carry this flag: it is what lets the id-range walk survive a store with
      // no byListing. A 422 from the seed or range axis says nothing about the listing axis.
      if (axis === 'recent' || axis === 'backfill') st.listingUnsupported = true;
      logger.warn('[CRAWLER] catalog unsupported — axis stopped', { siteId: st.siteId, ...where, axis });
      return stop('unsupported');
    }
    if (!res.ok) {
      st.summary.errors++;
      logger.warn('[CRAWLER] catalog failed', { siteId: st.siteId, ...where, status: res.status });
      // E8 — the status here is the SCRAPER's, not the store's: 5xx = our own engine faulting,
      // anything else lands in the operator's triage bucket rather than posing as a store verdict.
      emitFailure({
        site: st.siteId,
        target: listingTarget(st.siteId, axis, where),
        kind: 'listing',
        origin: 'crawler',
        reasonClass: res.status >= 500 ? 'http_5xx' : 'other',
        httpStatus: res.status,
        message: `catalog GET answered ${res.status}`,
      });
      return stop('failed');
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch (error) {
      st.summary.errors++;
      logger.warn('[CRAWLER] catalog body unparseable', { siteId: st.siteId, ...where, error: errMsg(error) });
      // E9 — a 200 whose body is not JSON. OURS to fix, so it goes to the review queue as `parse`.
      emitFailure({
        site: st.siteId,
        target: listingTarget(st.siteId, axis, where),
        kind: 'listing',
        origin: 'crawler',
        reasonClass: 'parse',
        httpStatus: res.status,
        message: `catalog body unparseable: ${errMsg(error)}`,
      });
      return stop('failed');
    }
    const value = isPlainObject(body) ? shape.parse(body) : undefined;
    if (value === undefined) {
      // A 200 that is not what this axis asked for is a failure, never an exhaustion signal — and,
      // on the seed axis, never an empty poll (which would read as "the shelf has nothing new").
      st.summary.errors++;
      logger.warn('[CRAWLER] catalog body malformed', { siteId: st.siteId, ...where });
      emitFailure({
        site: st.siteId,
        target: listingTarget(st.siteId, axis, where),
        kind: 'listing',
        origin: 'crawler',
        reasonClass: 'parse',
        httpStatus: res.status,
        message: `catalog answered 200 with a body that is not ${shape.label}`,
      });
      return stop('failed');
    }
    return { kind: 'ok', value };
  };

  /** One /catalog GET on an axis that answers `{ items: [...] }` — the listing and id-range axes. */
  const fetchCatalog = async (st: StoreState, url: string, where: Record<string, unknown>, axis: Phase): Promise<PageOutcome> => {
    const out = await fetchCatalogAs(st, url, where, axis, {
      label: 'a listing',
      parse: (body) => (Array.isArray(body.items) ? { items: sanitizeItems(body.items), hasMore: body.hasMore === true } : undefined),
    });
    return out.kind === 'ok' ? { kind: 'page', ...out.value } : out;
  };

  /**
   * `phase` is not decoration: recent and backfill can fetch the SAME page number in one run (raise
   * recentMaxPages past a saved backfill cursor), and one shared axis label would collapse the two
   * axes' failures onto one row — one attempts counter, and no way to see which axis is broken.
   */
  const fetchPage = (st: StoreState, page: number, phase: 'recent' | 'backfill'): Promise<PageOutcome> =>
    fetchCatalog(st, catalogUrl(st.siteId, page), { page }, phase);

  const postOne = async (st: StoreState, collectUrl: string, itemId: string): Promise<PostOutcome> => {
    let r: GateResult<HttpResponseLike>;
    try {
      r = await gate.run(() => httpPostJson(deps.fetch, ingestUrl, { url: collectUrl }, config.requestTimeoutMs));
    } catch (error) {
      logger.warn('[CRAWLER] ingest errored', { siteId: st.siteId, error: errMsg(error) });
      return 'transient';
    }
    if (r.status === 'budget-exhausted') return 'budget';
    const res = r.value;
    if (res.ok) {
      const body = await res.json().catch(() => ({}));
      return body?.deduplicated === true ? 'accepted-dedup' : 'accepted';
    }
    logger.warn('[CRAWLER] ingest rejected', { siteId: st.siteId, status: res.status });
    // 4xx = the scraper deterministically rejected THIS url (retrying cannot help); 5xx = the scraper is unwell.
    if (res.status >= 500) return 'transient';
    // E10 — a DETERMINISTIC refusal of this url (typically no ruleset matches the store's byId
    // template): terminal, and ours to fix, so it lands in the review queue as a RECORD row keyed on
    // the real store URL. A 5xx above is NOT reported — the scraper is unwell and the crawler
    // re-drives the id next run.
    // NO httpStatus: the status is our own /ingest/scrape's, while the row's target is the STORE's
    // url — recording it would assert a response that store never gave. It stays in the message.
    emitFailure({
      site: st.siteId,
      ...(itemId ? { itemId } : {}),
      target: collectUrl,
      kind: 'record',
      origin: 'crawler',
      reasonClass: 'ruleset',
      message: `the scraper refused this url with ${res.status}`,
    });
    return 'rejected';
  };

  // --- page processing --------------------------------------------------------------------------

  /** Age of a ledger entry; an unreadable timestamp counts as infinitely old (re-observe is cheap and self-healing). */
  const ageMs = (at: string): number => {
    const t = Date.parse(at);
    return Number.isFinite(t) ? now() - t : Number.POSITIVE_INFINITY;
  };

  /**
   * Enqueue the page's new items sequentially. Returns how many were NEW (for recent's
   * stop rule) and whether every new item was actually attempted (for backfill's advance rule).
   */
  const processPage = async (
    st: StoreState,
    items: CatalogItem[],
    phase: Phase,
  ): Promise<{ newCount: number; allAttempted: boolean; handled: number; accepted: number; rejected: number; stopReason?: StopReason }> => {
    const ledger = st.ledger!;
    let newCount = 0;
    let allAttempted = true;
    let accepted = 0;
    let rejected = 0;
    // WHY this page stopped the store, when it did. `st.stopped` alone cannot tell a sick scraper
    // from a spent budget, and a caller that guesses would mislabel one as the other.
    let stopReason: StopReason | undefined;
    // Index of the FIRST item this run did not get through (cap / budget / a sick scraper). Everything
    // before it was dealt with — POSTed, deliberately skipped, or deterministically rejected — which is
    // exactly how far a durable cursor may move. Undefined ⇒ the whole page was handled.
    let firstUnhandled: number | undefined;
    for (const [index, item] of items.entries()) {
      st.summary.discovered++;
      if (!item.collectUrl) {
        st.summary.uncollectable++;
        continue;
      }
      if (st.attempted.has(item.itemId)) {
        st.summary.known++;
        continue;
      }
      const entry = ledger.enqueued[item.itemId];
      let reobserve = false;
      if (entry) {
        if (phase === 'recent' && config.reobserveAfterMs > 0 && ageMs(entry.at) >= config.reobserveAfterMs) {
          reobserve = true;
        } else {
          st.summary.known++;
          continue;
        }
      }
      newCount++;
      if (st.stopped) {
        allAttempted = false;
        firstUnhandled ??= index;
        continue;
      }
      if (st.posts >= st.enqueueCap) {
        st.capReached = true;
        allAttempted = false;
        firstUnhandled ??= index;
        continue;
      }
      st.posts++;
      st.attempted.add(item.itemId);
      const outcome = await postOne(st, item.collectUrl, item.itemId);
      switch (outcome) {
        case 'accepted':
        case 'accepted-dedup':
          ledger.enqueued[item.itemId] = { at: iso(), collectUrl: item.collectUrl };
          accepted++;
          st.summary.enqueued++;
          if (outcome === 'accepted-dedup') st.summary.deduplicated++;
          if (reobserve) st.summary.reobserved++;
          break;
        case 'rejected':
          rejected++;
          st.summary.errors++;
          break;
        case 'transient':
          st.summary.errors++;
          st.stopped = true;
          stopReason ??= 'failed';
          allAttempted = false;
          firstUnhandled ??= index; // the POST failed transiently: this id must be retried, not walked past
          break;
        case 'budget':
          // Not dispatched: undo the attempt bookkeeping; the run is over for this store.
          st.posts--;
          st.attempted.delete(item.itemId);
          budgetExhausted = true;
          st.stopped = true;
          stopReason ??= 'budget';
          allAttempted = false;
          firstUnhandled ??= index;
          break;
      }
    }
    return { newCount, allAttempted, handled: firstUnhandled ?? items.length, accepted, rejected, ...(stopReason ? { stopReason } : {}) };
  };

  // --- phases -----------------------------------------------------------------------------------

  const recentPhase = async (st: StoreState): Promise<void> => {
    if (!st.ledger || st.stopped) return;
    const ledger = st.ledger;
    for (let page = 1; page <= config.recentMaxPages; page++) {
      const out = await fetchPage(st, page, 'recent');
      if (out.kind !== 'page') return;
      st.summary.pagesFetched++;
      st.summary.recentPages++;
      st.deepestRecentPage = page;
      const { newCount, allAttempted } = await processPage(st, out.items, 'recent');
      st.summary.recentNew += newCount;
      ledger.recent.lastRunAt = iso();
      ledger.recent.lastNewCount = st.summary.recentNew;
      if (!(await persist(st))) return;
      // Stop at the first page with nothing new, at the end of the listing, or once capped / cut off.
      if (newCount === 0 || !out.hasMore || !allAttempted) return;
    }
  };

  const clearExhaustion = (ledger: Ledger): boolean => {
    const b = ledger.backfill;
    const had = b.exhaustedAt !== undefined || b.exhaustCandidateCursor !== undefined;
    delete b.exhaustedAt;
    delete b.exhaustCandidateCursor;
    delete b.exhaustCandidateAt;
    return had;
  };

  const backfillPhase = async (st: StoreState): Promise<void> => {
    if (!st.ledger || st.stopped || st.capReached) return;
    const ledger = st.ledger;
    const b = ledger.backfill;

    if (b.exhaustedAt !== undefined) {
      // Confirmed end-of-catalog: only re-check the kept cursor once the window has elapsed.
      const due = ageMs(b.exhaustedAt) >= config.exhaustedRecheckMs;
      if (!due) {
        logger.info('[CRAWLER] backfill exhausted — re-check not due', { siteId: st.siteId, cursor: b.cursor, exhaustedAt: b.exhaustedAt });
        return;
      }
    }

    // Resume the saved cursor; otherwise start just past the recent phase's deepest page (page 2 at minimum).
    let cursor = b.cursor ?? Math.max(2, st.deepestRecentPage + 1);
    for (let i = 0; i < config.backfillPagesPerRun; i++) {
      const out = await fetchPage(st, cursor, 'backfill');
      if (out.kind !== 'page') return;
      st.summary.pagesFetched++;
      st.summary.backfillPages++;
      const { allAttempted } = await processPage(st, out.items, 'backfill');

      const exhaustionSignal = out.items.length === 0 || !out.hasMore;
      if (exhaustionSignal && !allAttempted) {
        // The last page was cut short (per-store cap, global budget, sick scraper): its unattempted items
        // say nothing about the end of the catalog. Persist what was accepted, keep the cursor and any
        // existing marks untouched, and re-fetch the same page next run. Recording — or confirming —
        // exhaustion here would park the store for exhaustedRecheckMs with those items stranded.
        if (b.cursor !== cursor) {
          b.cursor = cursor; // first initialisation
          b.updatedAt = iso();
        }
        logger.info('[CRAWLER] backfill last page cut short — exhaustion not recorded', { siteId: st.siteId, cursor });
        await persist(st);
        return;
      }
      if (exhaustionSignal) {
        // Never trust one empty page (the LISTING fetch is still status-blind — see the header).
        // Confirm across runs at the SAME cursor.
        if (b.exhaustedAt !== undefined || b.exhaustCandidateCursor === cursor) {
          clearExhaustion(ledger);
          b.exhaustedAt = iso();
          logger.info('[CRAWLER] backfill exhausted — confirmed at the same cursor', { siteId: st.siteId, cursor });
        } else {
          clearExhaustion(ledger);
          b.exhaustCandidateCursor = cursor;
          b.exhaustCandidateAt = iso();
          logger.info('[CRAWLER] backfill exhaustion candidate — will confirm next run', { siteId: st.siteId, cursor });
        }
        b.cursor = cursor;
        b.updatedAt = iso();
        await persist(st);
        return;
      }

      // A real page: any exhaustion marks are stale. Advance ONLY on hasMore AND a fully-attempted page.
      let changed = clearExhaustion(ledger);
      if (b.cursor !== cursor) changed = true; // first initialisation
      if (allAttempted) {
        cursor++;
        changed = true;
      }
      b.cursor = cursor;
      if (changed) b.updatedAt = iso();
      if (!(await persist(st))) return;
      if (!allAttempted) return;
    }
  };

  /**
   * SEED PHASE (CRAWLER_MODE=seed) — a slow, bounded poll of the pages a store DECLARES.
   *
   * Two steps, and no walk in either: ask the engine which seed lists the store declares
   * (GET /catalog?store=&seeds=1 — pure, it fetches no store), then fetch each declared list in
   * DECLARED order (GET /catalog?store=&seed=<listId>) and enqueue the ids the ledger has never
   * seen. There is no cursor and no paging because a seed list is ONE page by construction: the
   * cost of the whole phase is (1 + the number of declared lists) catalog GETs plus at most the
   * store's enqueue cap in ingest POSTs, and that is knowable before the pass starts.
   *
   * Everything else is the crawler's existing machinery, unchanged: the same durable ledger for
   * dedup (a seed list re-shows the same items for weeks — the ledger is what stops the poll from
   * re-POSTing them), the same per-store enqueue cap, the same global budget and the same request
   * gate for spacing and concurrency. A seed pass never re-observes a known id however old the
   * ledger entry is: re-observation is the RECENT phase's job, and folding it in here would turn a
   * bounded poll into a periodic re-collection of a whole shelf.
   *
   * The store STOPS at the first list that challenges, cools, or answers a 4xx, and the summary
   * records the REAL reason — a sick scraper is `failed`, only a spent budget is `budget`. A seed
   * pass is a handful of requests against a store being treated gently; pushing on to the next list
   * after a challenge is exactly the behaviour that burns the egress IP's reputation for every other
   * store sharing it. Once the store's cap is spent the remaining lists are not fetched at all
   * (`cap`): a request guaranteed to enqueue nothing is the one this axis must not make.
   *
   * PACING is this phase's own, because the engine has none to lend: a store's declared rateLimit
   * governs the ingest queue's dispatch, NOT a /catalog fetch. config.seedSpacingMs therefore spaces
   * one store's consecutive seed fetches, independently of the gate's global dispatch spacing.
   */
  const seedPhase = async (st: StoreState): Promise<void> => {
    if (!st.ledger || st.stopped) return;
    const found = await fetchCatalogAs(st, seedsUrl(st.siteId), { seeds: 1 }, 'seed', {
      label: 'a seed-list declaration',
      parse: (body) => {
        if (!Array.isArray(body.seedLists)) return undefined;
        // UNTRUSTED: an entry without a usable id names no list this axis could ask for. A repeat is
        // dropped TWICE OVER — by id, and by url — because polling one page twice in a run is the one
        // thing a declared, bounded poll must never do, and two ids pointing at one url is an
        // authoring slip that would otherwise cost a real store a wholly redundant fetch every pass.
        // First occurrence wins and declared order is kept; the losing ids are CREDITED as aliases,
        // never silently dropped, so the summary still accounts for every id the store declared.
        const lists: SeedListTarget[] = [];
        const byId = new Set<string>();
        const byUrl = new Map<string, SeedListTarget>();
        for (const entry of body.seedLists) {
          if (!isPlainObject(entry) || typeof entry.id !== 'string' || entry.id.length === 0) continue;
          if (byId.has(entry.id)) continue;
          byId.add(entry.id);
          const url = typeof entry.url === 'string' && entry.url.length > 0 ? entry.url : undefined;
          // An entry with no url cannot be url-deduped; it is still addressable by id, so it polls.
          const twin = url !== undefined ? byUrl.get(url) : undefined;
          if (twin) {
            twin.aliases.push(entry.id);
            logger.warn('[CRAWLER] two declared seed lists share the same url — polled once, both ids credited', {
              siteId: st.siteId,
              polled: twin.id,
              alias: entry.id,
            });
            continue;
          }
          const target: SeedListTarget = { id: entry.id, aliases: [] };
          lists.push(target);
          if (url !== undefined) byUrl.set(url, target);
        }
        return lists;
      },
    });
    if (found.kind !== 'ok') {
      st.summary.seedStopped = found.reason;
      return;
    }

    let first = true;
    for (const list of found.value) {
      // The store's enqueue cap is already spent: every remaining list would be fetched only to
      // discover it may POST nothing. On the axis whose justification is a knowable cost, a fetch
      // guaranteed to yield zero is exactly the request not to make.
      if (st.capReached) {
        st.summary.seedStopped = 'cap';
        return;
      }
      // PER-STORE SEED FLOOR. The engine applies no per-host delay on this lane (a store's declared
      // rateLimit governs the ingest queue, not the catalog/seed fetch), so without this wait a
      // store's whole declared set leaves back to back. Not applied before the FIRST list: there is
      // nothing yet to be spaced from.
      if (!first && config.seedSpacingMs > 0) await sleep(config.seedSpacingMs);
      first = false;

      const out = await fetchCatalog(st, seedUrl(st.siteId, list.id), { seed: list.id }, 'seed');
      if (out.kind !== 'page') {
        st.summary.seedStopped = out.reason;
        return;
      }
      // The per-list numbers are DELTAS of the store's own counters: one list's yield is what the
      // operator reads to decide whether that list still earns its cadence.
      const before = { discovered: st.summary.discovered, known: st.summary.known, enqueued: st.summary.enqueued };
      const { stopReason } = await processPage(st, out.items, 'seed');
      st.summary.seedLists.push({
        listId: list.id,
        discovered: st.summary.discovered - before.discovered,
        known: st.summary.known - before.known,
        enqueued: st.summary.enqueued - before.enqueued,
        ...(list.aliases.length > 0 ? { alsoDeclaredAs: list.aliases } : {}),
      });
      // Saved after EVERY list, like the listing axis saves after every page: a pass killed between
      // two lists must not re-POST what the first one already enqueued.
      if (!(await persist(st))) {
        st.summary.seedStopped = 'failed';
        return;
      }
      // The POST loop stopped the store: report WHY it stopped, not what the next iteration would
      // have guessed. A sick scraper and a spent budget are different operator problems.
      if (stopReason) {
        st.summary.seedStopped = stopReason;
        return;
      }
    }
  };

  /** The highest itemId the ledger has seen for this store that reads as a positive integer. */
  const highestNumericId = (ledger: Ledger): number | undefined => {
    let best: number | undefined;
    for (const id of Object.keys(ledger.enqueued)) {
      if (!/^\d+$/.test(id)) continue;
      const n = Number(id);
      if (!Number.isSafeInteger(n) || n < 1) continue;
      if (best === undefined || n > best) best = n;
    }
    return best;
  };

  /**
   * ID-RANGE BACKFILL — walk the store's sequential id space DOWNWARD, one bounded window per run.
   *
   * The window comes from GET /catalog?range=1&from=&count=, which SYNTHESIZES {itemId, collectUrl}
   * from the store's byId template (no upstream fetch), so every id flows through exactly the same
   * ledger dedup, enqueue cap and global budget as a listing item — the crawler's semantics are
   * untouched, only the source of the ids differs.
   *
   * The cursor moves down by the number of ids HANDLED (POSTed, skipped as known, or deterministically
   * rejected), never by the window size: an id the cap or the budget cut off is left above the cursor
   * and picked up next run, so nothing is stranded and nothing is ever re-walked. A window that
   * /ingest/scrape rejected ENTIRELY moves the cursor not at all — that is the store's ruleset
   * missing, not this id band's fault, and the band would otherwise be spent collecting nothing. Ids in the window
   * that do not exist at the store are EXPECTED — the ingest fetch answers 404 and the miss is
   * recorded there; the crawler cannot see it and does not pretend to.
   */
  const rangePhase = async (st: StoreState): Promise<void> => {
    if (!config.rangeStores.includes(st.siteId)) return;
    const skip = (reason: RangeSkipReason): void => {
      st.summary.rangeSkipped = reason;
    };
    if (!st.ledger) return skip('store-stopped');
    // A 422 on the LISTING axis says nothing about this one — mfc has no byListing yet but a full id
    // space. Any other stop reason (cooldown, budget, a sick scraper, a ledger failure) still holds.
    if (st.stopped && !st.listingUnsupported) return skip('store-stopped');
    // The walk shares the store's enqueue cap and runs LAST, so a listing that spends the whole cap
    // starves it — reported, because it otherwise reads exactly like a store that never walks.
    if (st.capReached) return skip('cap');
    st.stopped = false;

    const ledger = st.ledger;
    const range = (ledger.range ??= { cursor: null });
    // The state as the LEDGER holds it. A save that fails is restored onto it, so the run summary
    // never reports a cursor the next run will not resume from.
    const durable: LedgerRange = { ...range };
    const seed = config.rangeFrontiers[st.siteId];
    let cursor = range.cursor;
    if (cursor === null) {
      const frontier = highestNumericId(ledger) ?? seed;
      if (frontier === undefined) {
        logger.warn('[CRAWLER] id-range walk skipped — no frontier (empty ledger and no CRAWLER_RANGE_FRONTIER_<SITEID>)', { siteId: st.siteId });
        return skip('no-frontier');
      }
      cursor = frontier;
      range.frontier = frontier;
      if (seed !== undefined) range.seed = seed;
    } else if (seed !== undefined && range.seed !== seed) {
      // The operator CHANGED the seed. Once a cursor exists the env var is otherwise dead config, so
      // a wrong seed could only be corrected by editing the ledger on the PVC by hand — and a walk
      // that has reached the floor could never re-enter an id space that has since grown. A changed
      // seed therefore restarts the walk at the new top; ids already in the ledger cost no POST.
      logger.warn('[CRAWLER] id-range walk re-seeded — CRAWLER_RANGE_FRONTIER_<SITEID> changed', {
        siteId: st.siteId,
        previousSeed: range.seed,
        seed,
        previousCursor: cursor,
      });
      cursor = seed;
      range.frontier = seed;
      range.seed = seed;
    }
    if (cursor < 1) {
      logger.info('[CRAWLER] id-range walk complete — the id floor was reached', { siteId: st.siteId, frontier: range.frontier });
      return skip('floor');
    }

    const count = Math.min(config.rangeIdsPerRun, cursor);
    const out = await fetchCatalog(st, rangeUrl(st.siteId, cursor, count), { from: cursor, count }, 'range');
    if (out.kind !== 'page') return skip(out.reason);
    st.summary.rangeSkipped = null;
    // The cursor moves by POSITION in this window, so the window must BE the descending run that was
    // asked for: ids `cursor, cursor-1, …`. A shorter one is fine (the engine clamps its window, and
    // the walk bottoms out at id 1); a reordered / gapped / short-of-the-top one is a malformed body,
    // and walking it would silently strand whichever ids it left out. Refuse it before POSTing.
    const contiguous = out.items.length > 0 && out.items.every((it, i) => it.itemId === String(cursor - i));
    if (!contiguous) {
      st.summary.errors++;
      logger.warn('[CRAWLER] id-range window is not the requested descending run — cursor kept', {
        siteId: st.siteId,
        from: cursor,
        count,
        received: out.items.length,
        firstId: out.items[0]?.itemId,
      });
      // E11 — the engine served a window that is not the requested descending run. Walking it would
      // silently strand ids, so the walk stops here and the ledger records WHY.
      emitFailure({
        site: st.siteId,
        target: listingTarget(st.siteId, 'range', { from: cursor, count }),
        kind: 'listing',
        origin: 'crawler',
        reasonClass: 'ruleset',
        message: `id-range window is not the requested descending run from ${cursor} (received ${out.items.length}, first ${out.items[0]?.itemId ?? 'none'})`,
      });
      return skip('window-malformed');
    }
    const { handled, accepted, rejected } = await processPage(st, out.items, 'range');
    st.summary.rangeWalked += handled;
    if (handled === 0) {
      // Not one id got through (the cap ran out on the window's very first id, or the budget did):
      // nothing durable changes, and the reason is worth reporting rather than reading as a walk.
      logger.info('[CRAWLER] id-range window yielded no walkable id — cursor kept', { siteId: st.siteId, from: cursor });
      return skip(st.capReached ? 'cap' : 'budget');
    }
    if (accepted === 0 && rejected > 0) {
      // Every id the window offered was deterministically refused by /ingest/scrape (4xx — typically
      // no ruleset matches the store's byId url, i.e. an engine/ruleset skew). That is a property of
      // the STORE, not of these ids: walking past them would spend the id space collecting nothing
      // and they are never re-walked. Keep the cursor and let the error count say so.
      logger.warn('[CRAWLER] id-range window entirely rejected by ingest — cursor kept', { siteId: st.siteId, from: cursor, rejected });
      // E11 — every id in the window was deterministically refused: a property of the STORE (an
      // engine/ruleset skew), not of these ids. This row names the WINDOW and the kept cursor; it
      // ACCOMPANIES the per-id E10 rows postOne already wrote (it does not replace them), because a
      // partly-rejected window still needs its individual ids on record.
      emitFailure({
        site: st.siteId,
        target: listingTarget(st.siteId, 'range', { from: cursor, count }),
        kind: 'listing',
        origin: 'crawler',
        reasonClass: 'ruleset',
        message: `every id in the window from ${cursor} was refused by /ingest/scrape (${rejected} rejected)`,
      });
      return;
    }
    range.cursor = Math.max(0, cursor - handled);
    range.updatedAt = iso();
    if (!(await persist(st))) ledger.range = durable;
  };

  /**
   * RE-OBSERVATION LANE (D4, Ross 2026-09-18) — the answer to "an exhausted store is a store whose
   * prices froze the day it was walked".
   *
   * Discovery asks the store what EXISTS; this lane asks what the things we already know COST NOW. It
   * therefore walks the LEDGER, not the store's pages, and costs no catalog GET at all: each store's
   * N oldest-observed ids are re-driven through the absolute item url the ledger already holds. That
   * url is the store's byId url where the store declares that axis and the listing parser's own item
   * link where it does not — which is the ONLY reason a store with no byId axis (hobby-genki, bbts,
   * gkloot, akimomo, anitoys) can be re-priced by any mechanism we have.
   *
   * SEPARATE BUDGET, SHARED PACING. The lane spends config.storeReobserveCaps / maxReobservePerStore
   * (default 0 — the fleet opts in per store), never the discovery cap, so a store whose discovery cap
   * is spent still re-observes and a store whose re-observe cap is spent still discovers. Every POST
   * still goes through the ONE global gate (concurrency, total request budget, dispatch spacing) and
   * the scraper's per-host pacing, cooldowns and honesty gate downstream are untouched.
   *
   * FAIRNESS. Stores take turns ONE id at a time and the oldest observation goes first within a store,
   * so a global budget that cannot cover every selection is split across the stores rather than spent
   * entirely on whichever one happens to run first.
   *
   * THE LEDGER IS STAMPED ONCE PER STORE at the end of the lane, not per POST: the same trade the
   * id-range axis already makes (a pod killed mid-lane re-drives those ids next run — duplicate POSTs
   * the queue coalesces, never a lost or skipped id), and the reason it matters here is that a big
   * store's ledger is a single large JSON document.
   */
  const reobservePhase = async (): Promise<void> => {
    interface Lane {
      st: StoreState;
      queue: Array<{ itemId: string; collectUrl: string }>;
      next: number;
      changed: boolean;
    }

    const lanes: Lane[] = [];
    for (const st of states) {
      const skip = (reason: ReobserveSkipReason): void => {
        st.summary.reobserveLaneSkipped = reason;
        st.summary.reobserveCapApplied = 0;
      };
      // Reasons in the order that is most useful to read. A store nobody armed says so first, even if
      // something else would also have held it back; after that, config beats circumstance.
      if (st.reobserveCap <= 0) {
        skip('not-configured');
        continue;
      }
      if (st.pulledOut) {
        skip('store-out');
        continue;
      }
      // A store with no ledger is refused everywhere (a corrupt file or a failed load).
      if (!st.ledger) {
        skip('ledger');
        continue;
      }
      // A 422 on the LISTING axis says nothing about this lane — the ledger needs no listing. Any
      // other stop (cooldown, a sick scraper, a spent budget, a ledger failure) still holds: a host
      // that is cooling must be left alone, whichever lane wants it.
      if (st.stopped && !st.listingUnsupported) {
        skip('store-stopped');
        continue;
      }
      st.stopped = false;
      // From here the lane HAS taken the store on: the ceiling it ran under is now a fact.
      st.summary.reobserveCapApplied = st.reobserveCap;
      st.summary.reobserveLaneSkipped = null;

      const ledger = st.ledger;
      const eligible: Array<{ itemId: string; collectUrl: string; age: number }> = [];
      for (const [itemId, entry] of Object.entries(ledger.enqueued)) {
        // Never the same id twice in one run: discovery may already have driven this one.
        if (st.attempted.has(itemId)) continue;
        const collectUrl = entry && typeof entry.collectUrl === 'string' ? entry.collectUrl : '';
        if (!collectUrl) {
          // No url to re-drive. Counted where a missing collect url is already counted, not silently dropped.
          st.summary.uncollectable++;
          continue;
        }
        const age = ageMs(entry.at);
        if (age < config.reobserveMinAgeMs) {
          st.summary.reobserveSkipped++;
          continue;
        }
        // BACKOFF. An id whose last re-observation was deterministically refused keeps its old
        // observation time (nothing was observed), so it would otherwise sit at the head of the
        // oldest-first queue every run and starve the rest of the store behind a url that cannot work.
        // One min-age window of quiet is enough to keep the queue moving and still retry it.
        if (entry.reobserveFailedAt !== undefined && ageMs(entry.reobserveFailedAt) < config.reobserveMinAgeMs) {
          st.summary.reobserveSkipped++;
          continue;
        }
        eligible.push({ itemId, collectUrl, age });
      }
      // Oldest first; ties by itemId — ledger keys are unique, so there is no third case.
      eligible.sort((a, b) => (b.age === a.age ? (a.itemId < b.itemId ? -1 : 1) : b.age - a.age));
      const queue = eligible.slice(0, st.reobserveCap).map(({ itemId, collectUrl }) => ({ itemId, collectUrl }));
      st.summary.reobserveSelected = queue.length;
      logger.info('[CRAWLER] reobserve selection', {
        siteId: st.siteId,
        cap: st.reobserveCap,
        known: Object.keys(ledger.enqueued).length,
        eligible: eligible.length,
        selected: queue.length,
        skipped: st.summary.reobserveSkipped,
        minAgeH: config.reobserveMinAgeMs / 3_600_000,
      });
      if (queue.length > 0) lanes.push({ st, queue, next: 0, changed: false });
    }

    if (lanes.length === 0) return;

    if (config.reobserveDryRun) {
      // The selection, and not one request: what the lane WOULD drive, for an operator arming a store.
      for (const lane of lanes) {
        const shown = lane.queue.slice(0, 50).map((q) => q.itemId);
        logger.info('[CRAWLER] reobserve DRY RUN — selection not enqueued', {
          siteId: lane.st.siteId,
          count: lane.queue.length,
          itemIds: shown,
          ...(lane.queue.length > shown.length ? { truncated: true } : {}),
        });
      }
      return;
    }

    // ROUND-ROBIN: one id per store per turn, until every queue is spent or the run stops.
    let budgetStop = false;
    let progress = true;
    while (progress && !budgetStop) {
      progress = false;
      for (const lane of lanes) {
        const st = lane.st;
        // No cap check here: the queue was SLICED to the store's cap at selection, so the cap is
        // enforced once, in the one place that can also report what it held back.
        if (lane.next >= lane.queue.length || st.stopped) continue;
        const { itemId, collectUrl } = lane.queue[lane.next++];
        progress = true;
        st.attempted.add(itemId);
        const outcome = await postOne(st, collectUrl, itemId);
        const entry = st.ledger!.enqueued[itemId];
        switch (outcome) {
          case 'accepted':
          case 'accepted-dedup':
            // The observation time IS the ledger's ordering key: stamping it sends the id to the back
            // of the oldest-first queue, which is what makes the lane rotate through a catalog.
            entry.at = iso();
            delete entry.reobserveFailedAt;
            delete entry.reobserveFailures;
            // The lane's landing is the lane's OWN number. `enqueued` and `deduplicated` stay the
            // DISCOVERY phases' counters — `enqueued` is what `capApplied` bounds — while `reobserved`
            // remains what it has always been: re-observations from both mechanisms. A coalesced
            // re-observation still landed, so it counts here and nowhere else.
            st.summary.reobserveLanded++;
            st.summary.reobserved++;
            lane.changed = true;
            break;
          case 'rejected':
            // Deterministic refusal of THIS url (postOne already filed the E10 row). `at` is left
            // alone — nothing was observed — and the refusal is recorded so the backoff can see it.
            entry.reobserveFailedAt = iso();
            entry.reobserveFailures = (entry.reobserveFailures ?? 0) + 1;
            st.summary.errors++;
            st.summary.reobserveFailed++;
            lane.changed = true;
            break;
          case 'transient':
            // OUR scraper is unwell, not this url: count it, stop the store for the run, and record
            // NOTHING durable — backing the id off here would punish it for our own outage.
            st.summary.errors++;
            st.summary.reobserveFailed++;
            st.stopped = true;
            break;
          case 'budget':
            // Not dispatched: undo the bookkeeping and end the lane — the gate is global, so every
            // other store is equally out of budget.
            st.attempted.delete(itemId);
            budgetExhausted = true;
            budgetStop = true;
            break;
        }
        if (budgetStop) break;
      }
    }

    for (const lane of lanes) {
      if (lane.changed) await persist(lane.st);
    }
    logger.info('[CRAWLER] reobserve lane complete', {
      perStore: Object.fromEntries(
        lanes.map((lane) => [
          lane.st.siteId,
          {
            cap: lane.st.reobserveCap,
            selected: lane.st.summary.reobserveSelected,
            // `landed`, not `reobserved`: the latter also carries the recent phase's window, so a lane
            // printing it would claim work it did not do — on exactly the stores where that window
            // fires today (jfigure).
            landed: lane.st.summary.reobserveLanded,
            failed: lane.st.summary.reobserveFailed,
            skipped: lane.st.summary.reobserveSkipped,
          },
        ]),
      ),
      total: lanes.reduce((n, lane) => n + lane.st.summary.reobserveLanded, 0),
    });
  };

  // --- run --------------------------------------------------------------------------------------

  await Promise.all(states.map((st) => loadLedger(st)));

  // `seed` is an EXCLUSIVE mode, not a fourth phase: its justification is the bounded, declared cost
  // of a small set of pages, and running it alongside an unbounded walk would hide that cost inside
  // the walk's. The listing and id-range phases are therefore untouched by it, in both directions.
  if (config.phases.includes('seed')) {
    await Promise.all(states.map((st) => seedPhase(st)));
    const summary = summarize();
    logger.info('[CRAWLER] seed pass complete', summary as unknown as Record<string, unknown>);
    for (const s of summary.stores) {
      logger.info('[CRAWLER] store summary', s as unknown as Record<string, unknown>);
    }
    return summary;
  }

  if (config.phases.includes('recent')) {
    await Promise.all(states.map((st) => recentPhase(st)));
  }
  if (config.phases.includes('backfill')) {
    await Promise.all(states.map((st) => backfillPhase(st)));
    // The id-range walk goes LAST of the discovery phases: the newest ids (listing) always outrank the
    // deep id space for the run's budget, and a store may serve this axis while serving no listing at all.
    await Promise.all(states.map((st) => rangePhase(st)));
  }
  // The RE-OBSERVATION lane runs after EVERY discovery phase, on its own per-store budget: discovery's
  // priority over the global request budget is therefore exactly what it was before this lane existed.
  if (config.phases.includes('reobserve')) {
    await reobservePhase();
  }

  const summary = summarize();
  logger.info('[CRAWLER] pass complete', summary as unknown as Record<string, unknown>);
  for (const s of summary.stores) {
    logger.info('[CRAWLER] store summary', s as unknown as Record<string, unknown>);
  }
  return summary;
}
