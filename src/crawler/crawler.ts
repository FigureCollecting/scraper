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
 *   BACKFILL — resume the store's durable page cursor and walk forward up to
 *             backfillPagesPerRun pages, enqueuing NEW ids only (never re-observing).
 *             The cursor advances ONLY when the page reported `hasMore: true` AND every
 *             new item on it was attempted — a page cut short by the per-store cap, the
 *             global budget, or a sick scraper is re-fetched next run (known ids skip).
 *             `nextPage` is ignored: a contradictory {hasMore:false, nextPage:N} exists.
 *
 * END-OF-CATALOG IS CONFIRMED, NEVER INFERRED FROM ONE PAGE. The engine's http fetch
 * is status-blind (a Shopify page-cap 400 or a transient 5xx parses as an empty
 * listing), so an empty / hasMore:false page only records an EXHAUSTION CANDIDATE at
 * that cursor and stops the run without advancing. Only when the NEXT run sees the
 * same cursor empty again is the store marked exhausted (cursor kept); items
 * reappearing clear the candidate. A last page CUT SHORT (cap / budget / sick
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
 * or a budget stop loses nothing. A corrupt ledger refuses the store and is NEVER
 * overwritten. Imports nothing from src/driver/* — this is a thin HTTP client.
 */
import { createRequestGate, type GateResult, type RequestGate } from '../initiator/requestGate.js';
import { logger } from '../utils/logger.js';
import type { CrawlerConfig, CrawlerMode } from './config.js';
import type { Ledger, LedgerStore } from './ledger.js';

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
  /** POSTs the scraper accepted (HTTP 202). */
  enqueued: number;
  /** Of `enqueued`, how many the queue coalesced onto a pending item. */
  deduplicated: number;
  /** Of `enqueued`, how many were re-observations of known items (recent only). */
  reobserved: number;
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
  totalEnqueued: number;
  totalRangeWalked: number;
  totalErrors: number;
  totalSkipped: number;
  /** The per-store enqueue caps that actually applied this run, keyed by siteId (a cap for a store not crawled is not listed). */
  enqueueCapOverrides: Record<string, number>;
  stores: CrawlerStoreSummary[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

interface CatalogItem {
  itemId: string;
  collectUrl?: string;
}

type PageOutcome = { kind: 'page'; items: CatalogItem[]; hasMore: boolean } | { kind: 'stopped' };

type PostOutcome = 'accepted' | 'accepted-dedup' | 'rejected' | 'transient' | 'budget';

type Phase = 'recent' | 'backfill' | 'range';

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
  /** No further requests for this store this run (cooldown, unsupported, failure, budget, ledger failure). */
  stopped: boolean;
  /** The per-store enqueue cap blocked a POST this run. */
  capReached: boolean;
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
  const capFor = (siteId: string): number =>
    Object.prototype.hasOwnProperty.call(capOverrides, siteId) ? capOverrides[siteId] : config.maxEnqueuePerStore;

  const states: StoreState[] = stores.map((siteId) => ({
    siteId,
    enqueueCap: capFor(siteId),
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
      capApplied: capFor(siteId),
      errors: 0,
      skipped: 0,
      ledgerCorrupt: false,
      rangeWalked: 0,
      rangeCursor: null,
      rangeFrontier: null,
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
    listingUnsupported: false,
    deepestRecentPage: 0,
  }));

  let budgetExhausted = false;

  const catalogUrl = (siteId: string, page: number): string =>
    `${config.scraperServiceUrl}/catalog?store=${encodeURIComponent(siteId)}&page=${page}`;
  const rangeUrl = (siteId: string, from: number, count: number): string =>
    `${config.scraperServiceUrl}/catalog?store=${encodeURIComponent(siteId)}&range=1&from=${from}&count=${count}`;
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
      totalRangeWalked: perStore.reduce((n, s) => n + s.rangeWalked, 0),
      totalErrors: perStore.reduce((n, s) => n + s.errors, 0),
      totalSkipped: perStore.reduce((n, s) => n + s.skipped, 0),
      enqueueCapOverrides,
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
  const fetchCatalog = async (st: StoreState, url: string, where: Record<string, unknown>, axis: 'listing' | 'range'): Promise<PageOutcome> => {
    const stop = (): PageOutcome => {
      st.stopped = true;
      return { kind: 'stopped' };
    };
    let r: GateResult<HttpResponseLike>;
    try {
      r = await gate.run(() => httpGet(deps.fetch, url, config.requestTimeoutMs));
    } catch (error) {
      st.summary.errors++;
      logger.warn('[CRAWLER] catalog errored', { siteId: st.siteId, ...where, error: errMsg(error) });
      return stop();
    }
    if (r.status === 'budget-exhausted') {
      budgetExhausted = true;
      return stop();
    }
    const res = r.value;
    if (res.status === 503) {
      // The host is cooling from a challenge: leave the store alone this run, change nothing.
      const body = await res.json().catch(() => ({}));
      st.summary.skipped++;
      logger.warn('[CRAWLER] catalog cooldown — store skipped this run', { siteId: st.siteId, ...where, remainingMs: body?.remainingMs });
      return stop();
    }
    if (res.status === 422) {
      // The store does not serve THIS axis (no byListing / no extractListing; or no byRange / byId):
      // a configuration or coverage gap, NOT exhaustion. A listing gap leaves the id-range axis alive.
      st.summary.errors++;
      if (axis === 'listing') st.listingUnsupported = true;
      logger.warn('[CRAWLER] catalog unsupported — axis stopped', { siteId: st.siteId, ...where, axis });
      return stop();
    }
    if (!res.ok) {
      st.summary.errors++;
      logger.warn('[CRAWLER] catalog failed', { siteId: st.siteId, ...where, status: res.status });
      return stop();
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch (error) {
      st.summary.errors++;
      logger.warn('[CRAWLER] catalog body unparseable', { siteId: st.siteId, ...where, error: errMsg(error) });
      return stop();
    }
    if (!isPlainObject(body) || !Array.isArray(body.items)) {
      // A 200 that is not a listing is a failure, never an exhaustion signal.
      st.summary.errors++;
      logger.warn('[CRAWLER] catalog body malformed', { siteId: st.siteId, ...where });
      return stop();
    }
    return { kind: 'page', items: sanitizeItems(body.items), hasMore: body.hasMore === true };
  };

  const fetchPage = (st: StoreState, page: number): Promise<PageOutcome> =>
    fetchCatalog(st, catalogUrl(st.siteId, page), { page }, 'listing');

  const postOne = async (st: StoreState, collectUrl: string): Promise<PostOutcome> => {
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
    return res.status >= 500 ? 'transient' : 'rejected';
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
  ): Promise<{ newCount: number; allAttempted: boolean; handled: number; accepted: number; rejected: number }> => {
    const ledger = st.ledger!;
    let newCount = 0;
    let allAttempted = true;
    let accepted = 0;
    let rejected = 0;
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
      const outcome = await postOne(st, item.collectUrl);
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
          allAttempted = false;
          firstUnhandled ??= index; // the POST failed transiently: this id must be retried, not walked past
          break;
        case 'budget':
          // Not dispatched: undo the attempt bookkeeping; the run is over for this store.
          st.posts--;
          st.attempted.delete(item.itemId);
          budgetExhausted = true;
          st.stopped = true;
          allAttempted = false;
          firstUnhandled ??= index;
          break;
      }
    }
    return { newCount, allAttempted, handled: firstUnhandled ?? items.length, accepted, rejected };
  };

  // --- phases -----------------------------------------------------------------------------------

  const recentPhase = async (st: StoreState): Promise<void> => {
    if (!st.ledger || st.stopped) return;
    const ledger = st.ledger;
    for (let page = 1; page <= config.recentMaxPages; page++) {
      const out = await fetchPage(st, page);
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
      const out = await fetchPage(st, cursor);
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
        // Never trust one empty page (status-blind upstream fetch). Confirm across runs at the SAME cursor.
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
    if (!st.ledger) return;
    // A 422 on the LISTING axis says nothing about this one — mfc has no byListing yet but a full id
    // space. Any other stop reason (cooldown, budget, a sick scraper, a ledger failure) still holds.
    if (st.stopped && !st.listingUnsupported) return;
    if (st.capReached) return;
    st.stopped = false;

    const ledger = st.ledger;
    const range = (ledger.range ??= { cursor: null });
    let cursor = range.cursor;
    if (cursor === null) {
      const frontier = highestNumericId(ledger) ?? config.rangeFrontiers[st.siteId];
      if (frontier === undefined) {
        logger.warn('[CRAWLER] id-range walk skipped — no frontier (empty ledger and no CRAWLER_RANGE_FRONTIER_<SITEID>)', { siteId: st.siteId });
        return;
      }
      cursor = frontier;
      range.frontier = frontier;
    }
    if (cursor < 1) {
      logger.info('[CRAWLER] id-range walk complete — the id floor was reached', { siteId: st.siteId, frontier: range.frontier });
      return;
    }

    const count = Math.min(config.rangeIdsPerRun, cursor);
    const out = await fetchCatalog(st, rangeUrl(st.siteId, cursor, count), { from: cursor, count }, 'range');
    if (out.kind !== 'page') return;
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
      return;
    }
    const { handled, accepted, rejected } = await processPage(st, out.items, 'range');
    st.summary.rangeWalked += handled;
    if (handled === 0) {
      logger.info('[CRAWLER] id-range window yielded no walkable id — cursor kept', { siteId: st.siteId, from: cursor });
      return;
    }
    if (accepted === 0 && rejected > 0) {
      // Every id the window offered was deterministically refused by /ingest/scrape (4xx — typically
      // no ruleset matches the store's byId url, i.e. an engine/ruleset skew). That is a property of
      // the STORE, not of these ids: walking past them would spend the id space collecting nothing
      // and they are never re-walked. Keep the cursor and let the error count say so.
      logger.warn('[CRAWLER] id-range window entirely rejected by ingest — cursor kept', { siteId: st.siteId, from: cursor, rejected });
      return;
    }
    range.cursor = Math.max(0, cursor - handled);
    range.updatedAt = iso();
    await persist(st);
  };

  // --- run --------------------------------------------------------------------------------------

  await Promise.all(states.map((st) => loadLedger(st)));

  if (config.mode !== 'backfill') {
    await Promise.all(states.map((st) => recentPhase(st)));
  }
  if (config.mode !== 'recent') {
    await Promise.all(states.map((st) => backfillPhase(st)));
    // The id-range walk goes LAST: the newest ids (listing) always outrank the deep id space for the
    // run's budget, and a store may serve this axis while serving no listing at all.
    await Promise.all(states.map((st) => rangePhase(st)));
  }

  const summary = summarize();
  logger.info('[CRAWLER] pass complete', summary as unknown as Record<string, unknown>);
  for (const s of summary.stores) {
    logger.info('[CRAWLER] store summary', s as unknown as Record<string, unknown>);
  }
  return summary;
}
