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
 *             frontier is the highest numeric itemId the ledger has seen (never one the gap sweep
 *             wrote), else the operator's
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
 *   LISTS   — inside the id-range phase (recent gaps → lists → older gaps → descent), for a store
 *             with a CRAWLER_LISTS_DRAIN_CAPS entry: at most ONE rotating company-list group per pass
 *             (in the UTC window, once per interval); its new ids drain COLD on their own budget.
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
import type { Ledger, LedgerGapBand, LedgerGapOrigin, LedgerRange, LedgerStore } from './ledger.js';
import { isSafeRotatingName } from '../utils/rotatingName.js';
import { createFileListsStateStore, setListsGroup, type ListsGroupOutcome, type ListsGroupState, type ListsState, type ListsStateStore } from './listsState.js';

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
  /** The rotating-lists step's own state files (default: `<siteId>.lists.json` beside the ledgers). */
  listsStore?: ListsStateStore;
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
   * RE-ANCHOR (D5): the id the frontier was moved UP to this run, `null` when it was not moved. The
   * frontier itself is `rangeFrontier`; this field is what says the move HAPPENED, which is the whole
   * acceptance signal for the lane (a frontier that merely reads high may never have moved at all).
   */
  rangeReanchoredTo: number | null;
  /**
   * RE-ANCHOR: the id the frontier would have moved to when CRAWLER_RANGE_REANCHOR_MAX_DELTA refused the
   * move this run, `null` otherwise. The refusal repeats every run until the ledger or the knob changes.
   */
  rangeReanchorRefused: number | null;
  /** GAP SWEEP: known-gap bands still open for this store AFTER this run (the backlog). */
  gapBandsOpen: number;
  /** GAP SWEEP: ids still unswept across those open bands (POSTed + skipped as known both count as swept). */
  gapIdsRemaining: number;
  /** GAP SWEEP: ids the sweep HANDLED this run — POSTed, skipped as known, or deterministically rejected. */
  gapIdsSwept: number;
  /**
   * GAP SWEEP: POSTs the sweep landed. Kept OUT of `enqueued` deliberately: `enqueued` is what
   * `capApplied` bounds, and a store reading `enqueued: 9, capApplied: 5` reads as a breached
   * discovery cap to anyone scanning the fleet logs (the D4 lesson, applied to a second lane).
   */
  gapEnqueued: number;
  /**
   * GAP SWEEP: the budget the sweep ACTUALLY ran under for this store, and 0 whenever it could not
   * sweep at all — not the CONFIGURED value, which would send an operator hunting a broken lane
   * instead of reading `gapSkipped`.
   */
  gapBudgetApplied: number;
  /** GAP SWEEP: why the sweep did no work this run, `null` when it swept. */
  gapSkipped: GapSkipReason | null;
  /** LISTS: the rotating-list group chosen this pass, `null` when none was. */
  listsGroup: string | null;
  /** LISTS: how that group's attempt was booked (`null` when no attempt was recorded). */
  listsOutcome: ListsGroupOutcome | null;
  /** LISTS: the group's lists that answered with a page, and those that failed. */
  listsFetched: number;
  listsFailed: number;
  /** LISTS: distinct ids the group's lists offered (their union). */
  listsIdsSeen: number;
  /** LISTS: of those, the ids neither the ledger nor the backlog held — queued for the drain. */
  listsIdsNew: number;
  /** LISTS: POSTs the drain landed this pass (COLD). Kept out of `enqueued`, which `capApplied` bounds. */
  listsEnqueued: number;
  /** LISTS: the drain backlog after this pass; `null` when the lists state was not read. */
  listsPending: number | null;
  /** LISTS: the drain budget the step ran under (0 when it did not run). */
  listsDrainApplied: number;
  /** LISTS: why no group was fetched this pass, `null` when one was. */
  listsSkipped: ListsSkipReason | null;
  /** LISTS: why the drain stopped short, `null` when it did not. */
  listsDrainStopped: ListsDrainStopReason | null;
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
  /** GAP SWEEP: ids swept across every store this run. */
  totalGapIdsSwept: number;
  /** GAP SWEEP: POSTs the sweep landed across every store this run (never counted in `totalEnqueued`). */
  totalGapEnqueued: number;
  /** LISTS: POSTs the lists drain landed across every store this run (never counted in `totalEnqueued`). */
  totalListsEnqueued: number;
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
export type RangeSkipReason =
  | StopReason
  | 'not-configured'
  | 'not-run'
  | 'store-stopped'
  | 'cap'
  | 'no-frontier'
  | 'floor'
  | 'window-malformed'
  | 'window-rejected';

/**
 * Why the KNOWN-GAP SWEEP made no window request this run. Starvation and an empty band list look
 * identical from the outside — both are "no gap window was fetched" — so the sweep names which.
 */
export type GapSkipReason =
  | StopReason
  /** The store is not in CRAWLER_RANGE_STORES, or CRAWLER_RANGE_GAP_BUDGET is 0: the sweep is off. */
  | 'not-configured'
  /** The id-range phases did not run this pass (CRAWLER_MODE does not name `backfill`). */
  | 'not-run'
  /** The store was stopped before the sweep — a cooling host, a sick scraper, a ledger failure. */
  | 'store-stopped'
  /** Nothing to sweep: every band this store has is closed (or it has none). */
  | 'no-gap'
  /** CRAWLER_RANGE_GAP_DRY_RUN: the bands were printed and nothing was fetched or POSTed. */
  | 'dry-run'
  /** A window came back as something other than the descending run it asked for. */
  | 'window-malformed'
  /** /ingest/scrape refused every id a window offered, so the band cursor was kept. */
  | 'window-rejected';

/** Why the LISTS step fetched no group this pass. */
export type ListsSkipReason =
  /** No drain cap for the store (or it is not id-range walked): the step is off. */
  | 'not-configured'
  /** The id-range phases did not run this pass. */
  | 'not-run'
  /** The store was stopped before the step. */
  | 'store-stopped'
  /** The lists state file is unreadable or malformed: refused, never overwritten. */
  | 'state-corrupt'
  | 'state-failed'
  /** CRAWLER_LISTS_WINDOW_UTC is unset: lists are never fetched (the backlog still drains). */
  | 'window-off'
  | 'outside-window'
  /** A blocked answer paused list fetching (`pausedUntil` in the lists state); the backlog still drains. */
  | 'paused'
  /** Every declared group was attempted within the interval. */
  | 'none-due'
  /** The engine does not serve rotating lists (404), or the store declares none (422). */
  | 'unsupported'
  | 'cooldown'
  | 'budget'
  | 'failed';

/** Why the lists DRAIN stopped short. */
export type ListsDrainStopReason = StopReason | 'store-stopped';

type PageOutcome = { kind: 'page'; items: CatalogItem[]; hasMore: boolean } | { kind: 'stopped'; reason: StopReason };

/** One seed list the pass will actually poll, plus the declared ids that collapsed onto its url. */
interface SeedListTarget {
  id: string;
  aliases: string[];
}

type PostOutcome = 'accepted' | 'accepted-dedup' | 'rejected' | 'transient' | 'budget';

/**
 * A POST budget one lane spends on its own. The DISCOVERY phases spend `StoreState.posts` against
 * `StoreState.enqueueCap`; a lane that passes one of these to `processPage` spends THIS instead, so a
 * discovery cap already exhausted cannot starve it and it cannot breach the discovery cap in return.
 */
interface LaneBudget {
  spent: number;
  cap: number;
}

type Phase = 'recent' | 'backfill' | 'range' | 'gap' | 'seed' | 'reobserve' | 'lists';

/** What a lane hands `processPage` beyond the items: its own budget, its band origin, its queue priority. */
interface LaneOptions {
  budget?: LaneBudget;
  sweptFrom?: LedgerGapOrigin;
  priority?: 'COLD';
}

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
  /** The KNOWN-GAP SWEEP's own budget for the run — SEPARATE from `enqueueCap`, so neither lane starves the other. */
  gapBudget: LaneBudget;
  /** The LISTS drain's own budget for the run (CRAWLER_LISTS_DRAIN_CAPS). */
  listsBudget: LaneBudget;
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
  // A declared gap band only means something on a store that WALKS its id space. Dropping one
  // silently would leave an operator believing a band they named is being filled.
  for (const siteId of Object.keys(config.rangeGaps)) {
    if (!stores.includes(siteId) || !config.rangeStores.includes(siteId)) {
      logger.warn('[CRAWLER] CRAWLER_RANGE_GAPS names a store that is not id-range walked — no band adopted', { siteId });
    }
  }
  // The lists step lives inside the id-range phase, so a drain cap anywhere else would do nothing.
  const listsDrainCaps = config.listsDrainCaps ?? {};
  const listsCapFor = (siteId: string): number =>
    config.rangeStores.includes(siteId) && Object.prototype.hasOwnProperty.call(listsDrainCaps, siteId) ? listsDrainCaps[siteId] : 0;
  for (const siteId of Object.keys(listsDrainCaps)) {
    if (!stores.includes(siteId) || !config.rangeStores.includes(siteId)) {
      logger.warn('[CRAWLER] CRAWLER_LISTS_DRAIN_CAPS names a store that is not id-range walked — no lists step', { siteId });
    }
  }
  const listsStore = deps.listsStore ?? createFileListsStateStore(config.ledgerDir);

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
      rangeReanchoredTo: null,
      rangeReanchorRefused: null,
      gapBandsOpen: 0,
      gapIdsRemaining: 0,
      gapIdsSwept: 0,
      gapEnqueued: 0,
      // An APPLIED budget: 0 until the sweep actually takes this store on (see gapSweep).
      gapBudgetApplied: 0,
      gapSkipped: config.rangeStores.includes(siteId) ? 'not-run' : 'not-configured',
      listsGroup: null,
      listsOutcome: null,
      listsFetched: 0,
      listsFailed: 0,
      listsIdsSeen: 0,
      listsIdsNew: 0,
      listsEnqueued: 0,
      listsPending: null,
      listsDrainApplied: 0,
      listsSkipped: listsCapFor(siteId) > 0 ? 'not-run' : 'not-configured',
      listsDrainStopped: null,
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
    gapBudget: { spent: 0, cap: config.rangeGapBudget },
    listsBudget: { spent: 0, cap: listsCapFor(siteId) },
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
      // Read off the LEDGER, not off whatever the sweep did: the backlog is worth reporting on a
      // store whose sweep is switched off entirely, which is exactly how mfc will first be armed.
      const open = (st.ledger.range?.gaps ?? []).filter((b) => b.closedAt === undefined && b.next <= b.to);
      st.summary.gapBandsOpen = open.length;
      st.summary.gapIdsRemaining = open.reduce((n, b) => n + (b.to - b.next + 1), 0);
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
      totalGapIdsSwept: perStore.reduce((n, s) => n + s.gapIdsSwept, 0),
      totalGapEnqueued: perStore.reduce((n, s) => n + s.gapEnqueued, 0),
      totalListsEnqueued: perStore.reduce((n, s) => n + s.listsEnqueued, 0),
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

  const postOne = async (st: StoreState, collectUrl: string, itemId: string, priority?: 'COLD'): Promise<PostOutcome> => {
    let r: GateResult<HttpResponseLike>;
    // No priority = the queue's default (WARM): every lane but the lists drain posts exactly what it always did.
    const payload = priority ? { url: collectUrl, priority } : { url: collectUrl };
    try {
      r = await gate.run(() => httpPostJson(deps.fetch, ingestUrl, payload, config.requestTimeoutMs));
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
    /**
     * `budget` = the lane's OWN POST budget (absent = the discovery budget); it swaps counter AND ceiling,
     * so lanes never spend each other's. `sweptFrom` is stamped on gap entries; `priority` rides the POST.
     */
    lane: LaneOptions = {},
  ): Promise<{ newCount: number; allAttempted: boolean; handled: number; accepted: number; rejected: number; stopReason?: StopReason }> => {
    const { budget, sweptFrom, priority } = lane;
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
      if ((budget ? budget.spent : st.posts) >= (budget ? budget.cap : st.enqueueCap)) {
        // Only the DISCOVERY budget can actually block here. A lane that brings its own sizes each
        // window to what is LEFT of that budget (see gapSweep), so it never offers this loop more ids
        // than it may spend — which is why the flag below is unconditionally the discovery one.
        st.capReached = true;
        allAttempted = false;
        firstUnhandled ??= index;
        continue;
      }
      if (budget) budget.spent++;
      else st.posts++;
      st.attempted.add(item.itemId);
      const outcome = await postOne(st, item.collectUrl, item.itemId, priority);
      switch (outcome) {
        case 'accepted':
        case 'accepted-dedup':
          ledger.enqueued[item.itemId] = { at: iso(), collectUrl: item.collectUrl, ...(sweptFrom ? { sweptFrom } : {}) };
          accepted++;
          // The SWEEP's landings are the sweep's own number. `enqueued` is what `capApplied` bounds,
          // and `deduplicated` is "of `enqueued`" — a sweep POST in either would make a store summary
          // read as a breached discovery cap. `gapEnqueued` counts coalesced POSTs too: they landed.
          if (phase === 'gap') st.summary.gapEnqueued++;
          else if (phase === 'lists') st.summary.listsEnqueued++;
          else {
            st.summary.enqueued++;
            if (outcome === 'accepted-dedup') st.summary.deduplicated++;
          }
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
          if (budget) budget.spent--;
          else st.posts--;
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

  /**
   * The highest positive-integer itemId in the ledger, IGNORING entries the gap sweep wrote: a swept id
   * was synthesized from the byId template, and /ingest/scrape accepts one whether or not the item
   * exists, so trusting it would let a declared band become the frontier.
   */
  const highestNumericId = (ledger: Ledger): number | undefined => {
    let best: number | undefined;
    for (const [id, entry] of Object.entries(ledger.enqueued)) {
      if (entry?.sweptFrom !== undefined) continue;
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
  /** A DEEP copy: `gaps` is an array of objects, so the spread the descent used alone would share it. */
  const cloneRange = (range: LedgerRange): LedgerRange => JSON.parse(JSON.stringify(range)) as LedgerRange;

  /**
   * The bands still to sweep, OLDEST FIRST — the order Ross asked for, and the order that keeps a
   * band the re-anchor recorded weeks ago from sitting behind every band recorded since. Ties break
   * on the low id, because a run that adopts two operator bands stamps both with the same instant.
   */
  const openBands = (range: LedgerRange): LedgerGapBand[] =>
    (range.gaps ?? [])
      .filter((b) => b.closedAt === undefined && b.next <= b.to)
      .sort((a, b) => (a.createdAt === b.createdAt ? a.from - b.from : a.createdAt < b.createdAt ? -1 : 1));

  /**
   * DAILY FRONTIER RE-ANCHOR (D5, Ross 2026-09-18) — the answer to "the descent walks away from a
   * frontier the store keeps growing past".
   *
   * The descent starts at a frontier and walks DOWN, so every id the store adds afterwards is above
   * everything it will ever reach. The only thing watching that end of the id space is the Latest
   * Additions tap: ONE page with no pager, which sees whatever turned over since the last run and
   * nothing else. mfc's frontier has been frozen at 3,765,215 while the cursor walks the 3.72M band.
   *
   * So once per CRAWLER_RANGE_REANCHOR_H the frontier is moved up to the newest id in the ledger that
   * the gap sweep did NOT write (see highestNumericId): above the frontier, that is what a listing (the
   * tap) has shown us. The band between the old frontier and the new one is recorded as a KNOWN GAP for
   * the sweep to fill. The descent's cursor is NOT touched: it is walking a different part of the id
   * space and owns its own progress.
   *
   * A move wider than CRAWLER_RANGE_REANCHOR_MAX_DELTA is refused with a WARN and tried again next run:
   * a jump that size is a bad id, and the band it would record could never be swept.
   *
   * Costs no request: it reads the ledger this pass has already loaded.
   */
  const reanchorFrontier = (st: StoreState, range: LedgerRange): boolean => {
    // A store that has never walked has no frontier to move. The descent seeds one from this very
    // number moments later, and a band recorded now would be the empty band above it.
    if (range.frontier === undefined) return false;
    // An unparseable stamp reads as infinitely old and re-anchors — the self-healing direction: the
    // worst case is one extra band, against a cadence that silently never fires again.
    if (range.reanchoredAt !== undefined && ageMs(range.reanchoredAt) < config.rangeReanchorMs) return false;
    const newest = highestNumericId(st.ledger!);
    if (newest === undefined || newest <= range.frontier) return false;
    const delta = newest - range.frontier;
    if (delta > config.rangeReanchorMaxDelta) {
      // Not stamped: the refusal repeats every run until the ledger or the knob changes.
      logger.warn('[CRAWLER] id-range re-anchor refused: the move exceeds CRAWLER_RANGE_REANCHOR_MAX_DELTA', {
        siteId: st.siteId,
        frontier: range.frontier,
        newest,
        delta,
        maxDelta: config.rangeReanchorMaxDelta,
      });
      st.summary.rangeReanchorRefused = newest;
      return false;
    }
    const band: LedgerGapBand = {
      from: range.frontier + 1,
      to: newest,
      next: range.frontier + 1,
      origin: 'reanchor',
      createdAt: iso(),
    };
    logger.info('[CRAWLER] id-range frontier re-anchored — the band it skipped is now a known gap', {
      siteId: st.siteId,
      previousFrontier: range.frontier,
      frontier: newest,
      band: `${band.from}-${band.to}`,
      width: band.to - band.from + 1,
    });
    (range.gaps ??= []).push(band);
    range.frontier = newest;
    range.reanchoredAt = iso();
    st.summary.rangeReanchoredTo = newest;
    return true;
  };

  /**
   * Adopt this store's `CRAWLER_RANGE_GAPS` declarations — "several ids or cluster ranges to track" —
   * as bands of its own, once. A band is matched on its endpoints against EVERY band the store has,
   * OPEN OR CLOSED: a declaration left in the manifest after its band was filled would otherwise
   * re-open it on every run, and the sweep would spend its budget re-walking ids it already has.
   *
   * A declared band must lie AT OR BELOW the frontier. Above it the re-anchor records bands from ids a
   * listing has shown us; a declared band up there is a typo the sweep would turn into ledger entries
   * for ids nobody has seen. It is refused, with a WARN, on every run that finds it above the frontier.
   */
  const adoptOperatorGaps = (st: StoreState, range: LedgerRange): boolean => {
    let added = false;
    for (const decl of config.rangeGaps[st.siteId] ?? []) {
      if ((range.gaps ?? []).some((b) => b.from === decl.from && b.to === decl.to)) continue;
      if (range.frontier === undefined || decl.to > range.frontier) {
        logger.warn('[CRAWLER] CRAWLER_RANGE_GAPS band not adopted: a declared band must lie at or below the id-range frontier', {
          siteId: st.siteId,
          band: `${decl.from}-${decl.to}`,
          frontier: range.frontier ?? null,
        });
        continue;
      }
      (range.gaps ??= []).push({ from: decl.from, to: decl.to, next: decl.from, origin: 'operator', createdAt: iso() });
      added = true;
      logger.info('[CRAWLER] known gap adopted from CRAWLER_RANGE_GAPS', {
        siteId: st.siteId,
        band: `${decl.from}-${decl.to}`,
        width: decl.to - decl.from + 1,
      });
    }
    return added;
  };

  // With the lists step on, the lanes below it (older gaps, descent) post COLD too, so FIFO within
  // COLD keeps the lane order at dispatch; a store without the step posts as it always did.
  const belowListsPriority = (st: StoreState): 'COLD' | undefined => (st.listsBudget.cap > 0 ? 'COLD' : undefined);

  /**
   * KNOWN-GAP SWEEP (D5) — fill the bands the descent will never reach, ASCENDING, oldest band first.
   *
   * SAME URL SHAPE, NO NEW ROUTE. A gap window is the SAME `GET /catalog?range=1&from=&count=` the
   * descent uses, which SYNTHESIZES {itemId, collectUrl} from the store's byId template: the sweep
   * introduces no path mfc's robots.txt has not already allowed, because it introduces no path.
   *
   * WHY THE WINDOW IS REVERSED. The engine serves a DESCENDING run from `from`, and `processPage`
   * hands back how far it got as a PREFIX of what it was given. A band is swept upward, so the prefix
   * has to start at the band's low-water mark: the window is validated as the exact descending run it
   * asked for (anything else would strand ids silently) and then reversed, so `handled` is a prefix
   * from `next` upward and `next += handled` can never skip an id the budget cut off.
   *
   * ITS OWN BUDGET, THE SAME GATE. `CRAWLER_RANGE_GAP_BUDGET` is the ids the sweep may touch per run
   * (default 0 = off) — and therefore also a ceiling on its ingest POSTs, since an id costs at most
   * one. It is SEPARATE from the discovery cap, so the descent cannot starve the sweep nor the sweep
   * the descent. Ids already in the ledger count against it even though they cost no request: without
   * that, a band the tap has largely covered would spend a whole run's GLOBAL budget on window GETs
   * discovering it. Every request still passes the ONE global gate — concurrency, total budget,
   * dispatch spacing — and the store's pacing downstream is untouched.
   */
  const gapSweep = async (st: StoreState, range: LedgerRange, commit: () => Promise<boolean>, origin: LedgerGapOrigin): Promise<void> => {
    // TWO TIERS, one budget: the recent gaps ('reanchor' bands) run before the company lists, the
    // older gaps ('operator' bands) after them. The older tier runs only once the recent tier swept or
    // found nothing, and never overwrites the reason an earlier tier recorded.
    const recentTier = origin === 'reanchor';
    if (!recentTier && st.summary.gapSkipped !== null && st.summary.gapSkipped !== 'no-gap') return;
    const idle = recentTier || st.summary.gapSkipped === 'no-gap';
    const skip = (reason: GapSkipReason): void => {
      if (idle) st.summary.gapSkipped = reason;
    };
    const budget = st.gapBudget;
    if (budget.cap <= 0) return skip('not-configured');
    const tierBands = (): LedgerGapBand[] => openBands(range).filter((b) => b.origin === origin);
    if (tierBands().length === 0) return skip('no-gap');
    // A cooling host, a sick scraper or a failed save stopped the store: the sweep wants the same
    // egress as everything else, so it waits for the next run like every other lane.
    if (st.stopped) return skip('store-stopped');

    if (config.rangeGapDryRun) {
      // The BACKLOG, and not one request: what the sweep would walk, for an operator arming a store.
      // Printed once for both tiers, in the order they sweep.
      const open = openBands(range);
      const bands = [...open.filter((b) => b.origin === 'reanchor'), ...open.filter((b) => b.origin !== 'reanchor')];
      const shown = bands.slice(0, 20);
      logger.info('[CRAWLER] id-range gap sweep DRY RUN — bands not swept', {
        siteId: st.siteId,
        budget: budget.cap,
        bandsOpen: bands.length,
        idsRemaining: bands.reduce((n, b) => n + (b.to - b.next + 1), 0),
        bands: shown.map((b) => ({ band: `${b.from}-${b.to}`, next: b.next, remaining: b.to - b.next + 1, origin: b.origin })),
        ...(bands.length > shown.length ? { truncated: true } : {}),
      });
      return skip('dry-run');
    }

    st.summary.gapBudgetApplied = budget.cap;
    st.summary.gapSkipped = null;

    // Why the sweep stopped EARLY, when it did. Running the budget out or closing the last band is
    // not a skip — it is the lane doing its work — so those leave the reason null.
    let stop: GapSkipReason | null = null;
    while (!st.stopped && budget.spent < budget.cap && st.summary.gapIdsSwept < budget.cap) {
      // Re-read each turn: the band just swept may have closed, and the next one is then the oldest.
      const band = tierBands()[0];
      if (band === undefined) break;
      // Bounded three ways: the engine's window ceiling, what is left of THIS band, and what is left
      // of the run's own allowance — so a generous CRAWLER_RANGE_IDS_PER_RUN cannot overshoot the
      // pacing budget the residential lane was sized for.
      const count = Math.min(config.rangeIdsPerRun, band.to - band.next + 1, budget.cap - st.summary.gapIdsSwept);
      const from = band.next + count - 1;
      const where = { from, count, band: `${band.from}-${band.to}` };
      const out = await fetchCatalog(st, rangeUrl(st.siteId, from, count), where, 'gap');
      if (out.kind !== 'page') {
        stop = out.reason;
        break;
      }
      // The sweep advances by POSITION, so the window must be EXACTLY the descending run it asked
      // for — full length included. A short window (unlike the descent's, which may bottom out at id
      // 1) would leave the band's lowest ids out of the slice entirely, and advancing over what came
      // back would strand them for good.
      const exact = out.items.length === count && out.items.every((it, i) => it.itemId === String(from - i));
      if (!exact) {
        st.summary.errors++;
        logger.warn('[CRAWLER] gap window is not the requested descending run — band cursor kept', {
          siteId: st.siteId,
          ...where,
          received: out.items.length,
          firstId: out.items[0]?.itemId,
        });
        // E11 — walking this would silently strand the band's lowest ids, so the sweep stops here.
        emitFailure({
          site: st.siteId,
          target: listingTarget(st.siteId, 'gap', where),
          kind: 'listing',
          origin: 'crawler',
          reasonClass: 'ruleset',
          message: `gap window is not the requested descending run from ${from} (received ${out.items.length}, first ${out.items[0]?.itemId ?? 'none'})`,
        });
        stop = 'window-malformed';
        break;
      }
      const { handled, rejected, stopReason } = await processPage(st, [...out.items].reverse(), 'gap', {
        budget,
        sweptFrom: band.origin,
        priority: recentTier ? undefined : belowListsPriority(st),
      });
      if (handled === 0) {
        // Not one id got through, so nothing durable changes. Only the GLOBAL gate can do this: the
        // window was sized to what this lane's own budget still allowed, which makes its first id one
        // the sweep was entitled to spend.
        logger.info('[CRAWLER] gap window yielded no walkable id — band cursor kept', { siteId: st.siteId, ...where });
        stop = stopReason ?? 'budget';
        break;
      }
      if (rejected > 0 && rejected === handled) {
        // Every id the window offered was deterministically refused (4xx — typically an engine /
        // ruleset skew on the store's byId url). That is a property of the STORE, not of this band:
        // sweeping past them would spend the band collecting nothing. A window that also held known
        // ids is not this case: it advances, and each refusal keeps its own E10 row.
        logger.warn('[CRAWLER] gap window entirely rejected by ingest — band cursor kept', { siteId: st.siteId, ...where, rejected });
        emitFailure({
          site: st.siteId,
          target: listingTarget(st.siteId, 'gap', where),
          kind: 'listing',
          origin: 'crawler',
          reasonClass: 'ruleset',
          message: `every id in the gap window from ${from} was refused by /ingest/scrape (${rejected} rejected)`,
        });
        stop = 'window-rejected';
        break;
      }
      // Credited only now, and deliberately NOT like `rangeWalked`: `gapIdsSwept` is ids the band
      // cursor MOVED over. A window the store refused entirely moves nothing, and counting it here
      // would report progress against a backlog that did not shrink.
      st.summary.gapIdsSwept += handled;
      band.next += handled;
      band.updatedAt = iso();
      if (band.next > band.to) {
        band.closedAt = iso();
        logger.info('[CRAWLER] known gap band closed — every id swept', {
          siteId: st.siteId,
          band: `${band.from}-${band.to}`,
          origin: band.origin,
          width: band.to - band.from + 1,
        });
      }
      // Saved after EVERY window, like the descent: a pod killed between two windows must not re-walk
      // a band it already swept.
      if (!(await commit())) {
        stop = 'failed';
        break;
      }
      if (stopReason) {
        stop = stopReason;
        break;
      }
    }
    if (stop) st.summary.gapSkipped = stop;
  };

  const descentPhase = async (st: StoreState, range: LedgerRange, commit: () => Promise<boolean>): Promise<void> => {
    const skip = (reason: RangeSkipReason): void => {
      st.summary.rangeSkipped = reason;
    };
    // A lane above it (a gap sweep, the lists step) stopped the store: same store, same egress.
    if (st.stopped) return skip('store-stopped');
    // The walk shares the store's enqueue cap and runs LAST, so a listing that spends the whole cap
    // starves it — reported, because it otherwise reads exactly like a store that never walks. The
    // GAP SWEEP is NOT held back by this: it spends its own budget.
    if (st.capReached) return skip('cap');

    const ledger = st.ledger!;
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
    const { handled, rejected } = await processPage(st, out.items, 'range', { priority: belowListsPriority(st) });
    st.summary.rangeWalked += handled;
    if (handled === 0) {
      // Not one id got through (the cap ran out on the window's very first id, or the budget did):
      // nothing durable changes, and the reason is worth reporting rather than reading as a walk.
      logger.info('[CRAWLER] id-range window yielded no walkable id — cursor kept', { siteId: st.siteId, from: cursor });
      return skip(st.capReached ? 'cap' : 'budget');
    }
    if (rejected > 0 && rejected === handled) {
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
      return skip('window-rejected');
    }
    range.cursor = Math.max(0, cursor - handled);
    range.updatedAt = iso();
    await commit();
  };

  // --- rotating company lists -----------------------------------------------------------------

  /** One declared rotating list, as GET /catalog/rotating reports it. */
  interface RotatingDecl {
    id: string;
    group: string;
    order: number;
  }

  /** How one list fetch ended, for the group's booking. */
  type ListFetch =
    | { kind: 'ok'; items: CatalogItem[] }
    | { kind: 'deterministic' | 'transient'; reason: string; blocked: boolean }
    | { kind: 'cooldown' }
    | { kind: 'budget' };

  const rotatingUrl = (siteId: string, listId?: string): string =>
    `${config.scraperServiceUrl}/catalog/rotating?store=${encodeURIComponent(siteId)}${listId === undefined ? '' : `&list=${encodeURIComponent(listId)}`}`;

  /** One GET through the gate, reported raw: the lists step reads statuses its own way. */
  const listsGet = async (
    url: string,
  ): Promise<{ kind: 'budget' } | { kind: 'error'; error: unknown } | { kind: 'res'; status: number; ok: boolean; body: unknown }> => {
    let r: GateResult<HttpResponseLike>;
    try {
      r = await gate.run(() => httpGet(deps.fetch, url, config.requestTimeoutMs));
    } catch (error) {
      return { kind: 'error', error };
    }
    if (r.status === 'budget-exhausted') {
      budgetExhausted = true;
      return { kind: 'budget' };
    }
    const body: unknown = await r.value.json().catch(() => undefined);
    return { kind: 'res', status: r.value.status, ok: r.value.ok, body };
  };

  /** The failure-ledger class for a failed list, from what the engine said about it. */
  const listReasonClass = (kind: 'deterministic' | 'transient', reason: string, upstream: number | undefined): FetchFailureReport['reasonClass'] => {
    if (reason === 'challenge page') return 'challenge';
    if (upstream !== undefined) {
      const byStatus: Record<number, FetchFailureReport['reasonClass']> = { 403: 'http_403', 404: 'gone_404', 410: 'gone_410', 429: 'http_429' };
      return byStatus[upstream] ?? (upstream >= 500 ? 'http_5xx' : 'other');
    }
    if (kind === 'deterministic') return 'parse';
    return /timed? ?out|timeout/i.test(reason) ? 'timeout' : 'network';
  };

  /** Fetch ONE rotating list and classify the answer. Every failure writes one ledger row. */
  const fetchRotatingList = async (st: StoreState, listId: string): Promise<ListFetch> => {
    const r = await listsGet(rotatingUrl(st.siteId, listId));
    const failed = (kind: 'deterministic' | 'transient', reason: string, blocked: boolean, reasonClass: FetchFailureReport['reasonClass'], httpStatus?: number): ListFetch => {
      st.summary.errors++;
      logger.warn('[CRAWLER] rotating list failed', { siteId: st.siteId, list: listId, failure: kind, reason });
      emitFailure({
        site: st.siteId,
        target: listingTarget(st.siteId, 'lists', { list: listId }),
        kind: 'listing',
        origin: 'crawler',
        reasonClass,
        ...(httpStatus !== undefined ? { httpStatus } : {}),
        message: reason,
      });
      return { kind, reason, blocked };
    };
    if (r.kind === 'budget') return { kind: 'budget' };
    if (r.kind === 'error') {
      const timeout = classifyFetchFailure({ error: r.error }).reasonClass === 'timeout';
      return failed('transient', errMsg(r.error), false, timeout ? 'timeout' : 'network');
    }
    const body = isPlainObject(r.body) ? r.body : {};
    if (r.ok) {
      if (!Array.isArray(body.items)) return failed('deterministic', 'catalog answered 200 with a body that is not a list', false, 'parse');
      return { kind: 'ok', items: sanitizeItems(body.items) };
    }
    if (r.status === 503 && body.error === 'cooldown') {
      st.summary.skipped++;
      logger.warn('[CRAWLER] rotating list host cooling — store left alone this run', { siteId: st.siteId, list: listId });
      return { kind: 'cooldown' };
    }
    if (r.status === 502 && (body.failure === 'deterministic' || body.failure === 'transient')) {
      const reason = typeof body.reason === 'string' ? body.reason : 'catalog failed';
      const upstream = typeof body.upstreamStatus === 'number' ? body.upstreamStatus : undefined;
      return failed(body.failure, reason, body.blocked === true, listReasonClass(body.failure, reason, upstream), upstream);
    }
    // An engine answer without a failure class: its own 4xx is deterministic, anything else a sick scraper.
    if (r.status >= 400 && r.status < 500) return failed('deterministic', `rotating list GET answered ${r.status}`, false, 'other');
    return failed('transient', `rotating list GET answered ${r.status}`, false, 'http_5xx');
  };

  /** Minutes after UTC midnight inside the window (start inclusive, end exclusive, wrapping midnight). */
  const inWindow = (w: { startMin: number; endMin: number }, atMs: number): boolean => {
    const m = Math.floor((((atMs % 86_400_000) + 86_400_000) % 86_400_000) / 60_000);
    return w.startMin < w.endMin ? m >= w.startMin && m < w.endMin : m >= w.startMin || m < w.endMin;
  };

  /** The instant the window holding `atMs` closes: a blocked answer pauses the lists for the rest of tonight only. */
  const windowEndMs = (w: { startMin: number; endMin: number }, atMs: number): number => {
    const midnight = atMs - (((atMs % 86_400_000) + 86_400_000) % 86_400_000);
    const end = midnight + w.endMin * 60_000;
    return w.startMin > w.endMin && atMs - midnight >= w.startMin * 60_000 ? end + 86_400_000 : end;
  };

  /** A transient failure is retried on the next pass, at most this many times before the slot is spent. */
  const MAX_LIST_RETRIES = 3;
  /** Consecutive blocked passes before a group's slot is spent, so one refused list cannot freeze the rotation. */
  const BLOCKED_STRIKES_TO_SPEND = 3;

  /**
   * ROTATE: fetch at most ONE due group and queue its new ids. Returns why no group was fetched, or
   * null when one was. The group's booking lands in `state`; the caller persists it before draining.
   */
  const rotate = async (st: StoreState, state: ListsState): Promise<ListsSkipReason | null> => {
    const window = config.listsWindow ?? null;
    if (!window) return 'window-off';
    const passAt = now();
    if (!inWindow(window, passAt)) return 'outside-window';
    if (state.pausedUntil !== undefined) {
      if (ageMs(state.pausedUntil) < 0) return 'paused';
      delete state.pausedUntil;
    }

    const found = await listsGet(rotatingUrl(st.siteId));
    if (found.kind === 'budget') {
      st.stopped = true;
      return 'budget';
    }
    if (found.kind === 'error') {
      st.summary.errors++;
      st.stopped = true;
      logger.warn('[CRAWLER] rotating-list declaration errored — store stopped', { siteId: st.siteId, error: errMsg(found.error) });
      return 'failed';
    }
    // 404: an engine that predates the route. 422: the store declares no rotating lists. Neither
    // costs the store anything, so the lanes below still run.
    if (found.status === 404 || found.status === 422) return 'unsupported';
    const raw = isPlainObject(found.body) ? found.body.rotatingSeedLists : undefined;
    if (!found.ok || !Array.isArray(raw)) {
      st.summary.errors++;
      logger.warn('[CRAWLER] rotating-list declaration unusable', { siteId: st.siteId, status: found.status });
      if (!found.ok) st.stopped = true;
      return 'failed';
    }

    // A group's `order` is the lowest any of its lists declares.
    const groups = new Map<string, { order: number; index: number; lists: string[] }>();
    const ids = new Set<string>();
    for (const entry of raw) {
      if (!isPlainObject(entry)) continue;
      const { id, group, order } = entry as Partial<RotatingDecl>;
      // The catalog route's own rule: a name it would never serve is never fetched nor made a state key.
      if (!isSafeRotatingName(id) || !isSafeRotatingName(group)) continue;
      if (typeof order !== 'number' || !Number.isFinite(order) || ids.has(id)) continue;
      ids.add(id);
      const g = groups.get(group);
      if (g) {
        g.lists.push(id);
        g.order = Math.min(g.order, order);
      } else groups.set(group, { order, index: groups.size, lists: [id] });
    }
    // Least recently attempted first (never = first; `order`, then declaration, break ties): with fewer
    // slots per interval than groups the cycle stretches instead of starving the tail.
    const interval = config.listsIntervalMs ?? 160 * 60 * 60 * 1000;
    // Own keys only: a group named like an Object.prototype member must not read the builtin.
    const groupState = (name: string): ListsGroupState | undefined =>
      Object.hasOwn(state.groups, name) ? state.groups[name] : undefined;
    const lastMs = (name: string): number => {
      const at = groupState(name)?.lastAttemptAt;
      return at === undefined ? Number.NEGATIVE_INFINITY : Date.parse(at);
    };
    const due = [...groups.entries()]
      .filter(([name]) => {
        const at = groupState(name)?.lastAttemptAt;
        return at === undefined || ageMs(at) >= interval;
      })
      .sort(([na, a], [nb, b]) => lastMs(na) - lastMs(nb) || a.order - b.order || a.index - b.index)[0];
    if (!due) return 'none-due';
    const [group, { lists }] = due;
    st.summary.listsGroup = group;

    // An open attempt resumes where it stopped: a list that already answered is not asked again.
    const prior = groupState(group);
    const answered: Record<string, 'ok' | 'failed'> = {};
    for (const id of lists) {
      if (prior?.answered && Object.hasOwn(prior.answered, id)) answered[id] = prior.answered[id];
    }
    const at = iso();
    const union = new Map<string, CatalogItem>();
    let fetched = 0;
    let failed = 0;
    let reason: string | undefined;
    let stop: 'transient' | 'blocked' | 'cooldown' | 'budget' | undefined;
    for (const [i, listId] of lists.filter((id) => !Object.hasOwn(answered, id)).entries()) {
      if (i > 0) await sleep(config.listsSpacingMs ?? 10_000);
      const out = await fetchRotatingList(st, listId);
      if (out.kind === 'budget' || out.kind === 'cooldown') {
        st.stopped = true;
        stop = out.kind;
        break;
      }
      if (out.kind === 'ok') {
        fetched++;
        answered[listId] = 'ok';
        for (const it of out.items) if (it.collectUrl && !union.has(it.itemId)) union.set(it.itemId, it);
        continue;
      }
      failed++;
      reason = out.reason;
      if (out.blocked || out.kind === 'transient') {
        st.stopped = true;
        stop = out.blocked ? 'blocked' : 'transient';
        break;
      }
      answered[listId] = 'failed';
    }
    st.summary.listsFetched = fetched;
    st.summary.listsFailed = failed;
    st.summary.listsIdsSeen = union.size;

    // Queue what neither the ledger, this run, nor the backlog (another group's copy) already holds.
    const queued = new Set(state.pending.map((p) => p.itemId));
    let fresh = 0;
    for (const it of union.values()) {
      if (st.ledger!.enqueued[it.itemId] || st.attempted.has(it.itemId) || queued.has(it.itemId)) continue;
      state.pending.push({ itemId: it.itemId, collectUrl: it.collectUrl as string, group });
      queued.add(it.itemId);
      fresh++;
    }
    st.summary.listsIdsNew = fresh;
    const interrupted = stop === 'cooldown' || stop === 'budget' ? stop : null;
    // The store answered nothing (a cooling host or a closed gate on the first list): nothing to book.
    if (interrupted && fetched + failed === 0) return interrupted;

    const g: ListsGroupState = prior ?? { lastTriedAt: at, outcome: 'ok', seen: 0, new: 0, enqueued: 0, strikes: 0, retries: 0 };
    const opening = g.answered === undefined;
    if (opening) {
      // A new attempt opens: its counters start from zero.
      g.seen = 0;
      g.new = 0;
      g.enqueued = 0;
    }
    // `seen` counts each id once per attempt, even when its lists answer on different passes.
    const attemptIds = new Set(opening ? [] : (g.seenIds ?? []));
    for (const id of union.keys()) {
      if (attemptIds.has(id)) continue;
      attemptIds.add(id);
      g.seen++;
    }
    g.seenIds = [...attemptIds];
    g.answered = answered;
    g.lastTriedAt = at;
    g.new += fresh;
    if (reason !== undefined) g.reason = reason;
    const spend = (outcome: ListsGroupOutcome): void => {
      g.outcome = outcome;
      g.lastAttemptAt = at;
      g.retries = 0;
      delete g.blockedStrikes;
      delete g.answered;
      delete g.seenIds;
    };
    // Any answer other than a refusal breaks the group's blocked streak and forgets a blocked spend.
    if (stop !== 'blocked') {
      delete g.blockedStrikes;
      delete g.spentBlocked;
    }
    if (stop === 'blocked') {
      // The store refused US, not this list: no list is asked for the rest of tonight, and the slot
      // is spent after BLOCKED_STRIKES_TO_SPEND refusals running — or the first, when the last spend
      // was one too — so a company refused for good costs one night a cycle.
      g.outcome = 'blocked';
      g.strikes++;
      g.blockedStrikes = (g.blockedStrikes ?? 0) + 1;
      state.pausedUntil = new Date(windowEndMs(window, passAt)).toISOString();
      if (g.spentBlocked === true || g.blockedStrikes >= BLOCKED_STRIKES_TO_SPEND) {
        spend('blocked');
        g.spentBlocked = true;
      }
    } else if (stop === 'transient') {
      g.outcome = 'transient';
      g.strikes++;
      g.retries++;
      if (g.retries >= MAX_LIST_RETRIES) spend('transient');
    } else if (interrupted) {
      g.outcome = 'interrupted';
    } else {
      const results = Object.values(answered);
      const ok = results.filter((r) => r === 'ok').length;
      if (ok === results.length) delete g.reason;
      g.strikes = ok === 0 ? g.strikes + 1 : 0;
      spend(ok === 0 ? 'failed' : ok < results.length ? 'partial' : 'ok');
    }
    setListsGroup(state, group, g);
    st.summary.listsOutcome = g.outcome;
    return interrupted;
  };

  const saveLists = async (st: StoreState, state: ListsState): Promise<boolean> => {
    state.updatedAt = iso();
    try {
      await listsStore.save(state);
      return true;
    } catch (error) {
      st.summary.errors++;
      logger.warn('[CRAWLER] lists state save failed — no drain this run', { siteId: st.siteId, error: errMsg(error) });
      return false;
    }
  };

  /**
   * COMPANY LISTS (Ross 2026-09-22/25/26): ROTATE at most one group, persist its booking, then DRAIN the
   * backlog oldest first, COLD. The ledger is saved before the backlog: a crash between them re-offers
   * ids the ledger holds, and the next drain drops them without a request.
   */
  const listsStep = async (st: StoreState, commit: () => Promise<boolean>): Promise<void> => {
    const budget = st.listsBudget;
    if (budget.cap <= 0) return;
    if (st.stopped) {
      st.summary.listsSkipped = 'store-stopped';
      return;
    }
    let loaded: ListsState | 'corrupt';
    try {
      loaded = await listsStore.load(st.siteId);
    } catch (error) {
      st.summary.errors++;
      st.summary.listsSkipped = 'state-failed';
      logger.warn('[CRAWLER] lists state load failed — lists step skipped', { siteId: st.siteId, error: errMsg(error) });
      return;
    }
    if (loaded === 'corrupt') {
      st.summary.errors++;
      st.summary.listsSkipped = 'state-corrupt';
      logger.warn('[CRAWLER] lists state corrupt — lists step refused, file left untouched', { siteId: st.siteId });
      return;
    }
    const state = loaded;
    st.summary.listsDrainApplied = budget.cap;
    st.summary.listsSkipped = await rotate(st, state);
    st.summary.listsPending = state.pending.length;
    if (!(await saveLists(st, state))) {
      st.summary.listsDrainStopped = 'failed';
      return;
    }

    const ledger = st.ledger!;
    state.pending = state.pending.filter((p) => !ledger.enqueued[p.itemId] && !st.attempted.has(p.itemId));
    if (st.stopped) st.summary.listsDrainStopped = 'store-stopped';
    else {
      const slice = state.pending.slice(0, Math.max(0, budget.cap - budget.spent));
      const { handled, stopReason } = await processPage(
        st,
        slice.map((p) => ({ itemId: p.itemId, collectUrl: p.collectUrl })),
        'lists',
        { budget, priority: 'COLD' },
      );
      for (const p of slice.slice(0, handled)) {
        const g = Object.hasOwn(state.groups, p.group) ? state.groups[p.group] : undefined;
        if (g && ledger.enqueued[p.itemId]) g.enqueued++;
      }
      state.pending.splice(0, handled);
      if (stopReason) st.summary.listsDrainStopped = stopReason;
      if (!(await commit())) {
        st.summary.listsDrainStopped = 'failed';
        return;
      }
    }
    st.summary.listsPending = state.pending.length;
    await saveLists(st, state);
  };

  /**
   * The store's ID-RANGE axis in Ross's precedence (2026-09-25), below the tap: re-anchor + adopt bands
   * (no requests) → recent gaps ('reanchor') → company lists → older gaps ('operator') → descent. Each
   * lane has its own budget; order decides the GLOBAL budget, and a stop in one lane stops those below.
   */
  const rangePhase = async (st: StoreState): Promise<void> => {
    if (!config.rangeStores.includes(st.siteId)) return;
    const skipBoth = (reason: RangeSkipReason & GapSkipReason): void => {
      st.summary.rangeSkipped = reason;
      st.summary.gapSkipped = reason;
      if (st.listsBudget.cap > 0) st.summary.listsSkipped = 'store-stopped';
    };
    if (!st.ledger) return skipBoth('store-stopped');
    // A 422 on the LISTING axis says nothing about this one — mfc has no byListing yet but a full id
    // space. Any other stop reason (cooldown, budget, a sick scraper, a ledger failure) still holds.
    if (st.stopped && !st.listingUnsupported) return skipBoth('store-stopped');
    st.stopped = false;

    const ledger = st.ledger;
    const range = (ledger.range ??= { cursor: null });
    // The state as the LEDGER holds it, refreshed after every successful save. A save that fails is
    // restored onto it, so the run summary never reports a cursor — or a band — that the next run
    // will not resume from.
    let durable: LedgerRange = cloneRange(range);
    const commit = async (): Promise<boolean> => {
      if (await persist(st)) {
        durable = cloneRange(range);
        return true;
      }
      ledger.range = durable;
      return false;
    };

    // Bookkeeping first, and PERSISTED on its own: a re-anchor that only reached the disk when the
    // descent happened to save would be lost on exactly the runs where the descent does nothing.
    // Re-anchor BEFORE adopting, so a declared band is checked against the freshest frontier.
    const reanchored = reanchorFrontier(st, range);
    const adopted = adoptOperatorGaps(st, range);
    if ((adopted || reanchored) && !(await commit())) return skipBoth('failed');

    await gapSweep(st, range, commit, 'reanchor');
    await listsStep(st, commit);
    await gapSweep(st, range, commit, 'operator');
    await descentPhase(st, range, commit);
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
