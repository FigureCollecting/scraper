/**
 * runInitiatorPass — ONE bounded ingestion pass. The interim bridge between "no
 * continuous initiator, only manual POSTs" and the full 2b crawl driver.
 *
 * WHAT IT DOES (and deliberately no more):
 *   1. DISCOVER — for each configured store, and within a store for each term IN SEQUENCE,
 *      GET {scraper}/lookup?q=&stores=<ONE store> (the scraper's own search, scoped to that
 *      one store). ONE LOOKUP PER STORE is deliberate: the scraper bounds each store's search
 *      by LOOKUP_STORE_TIMEOUT_MS, and a shared fan-out made the SLOWEST store the whole
 *      term's latency — one store hitting that bound tripped the initiator's own request
 *      timeout and zeroed EVERY store's discovery for the pass (2026-09-07 09:00Z, amiami).
 *      Scoped per store, a slow or failing store costs only its own lookup. The stores run in
 *      parallel while a store's terms run one at a time, so the concurrent gate slots hold
 *      DISTINCT stores (store-major submission let one hung store hold them all) and a term
 *      whose store has already filled maxUrlsPerStore is skipped — its results could only be
 *      discarded. Candidates are kept only for the store the call asked for, bounded to
 *      maxUrlsPerStore per store ACROSS terms. A lookup that fails TRANSIENTLY — abort/timeout,
 *      network error, HTTP 5xx, 429 or 408 — is retried ONCE after
 *      INITIATOR_LOOKUP_RETRY_DELAY_MS; any other 4xx is NOT retried (the same request would be
 *      refused the same way), and neither is a 2xx body that will not parse. A store gets ONE
 *      retry for the whole pass, not one per term. The retry is an ordinary request — same
 *      gate, same budget.
 *      Each candidate carries the store's product PAGE link (`url`) and, from an engine
 *      that emits it, `collectUrl` — the collect-ready URL the engine derived from its
 *      retrieval axes (the byId Store-API URL where declared, else the page link
 *      absolutized). The initiator PREFERS collectUrl and falls back to url, so it
 *      works against an older engine and never POSTs a relative or CF-fronted page
 *      link when the engine knows a better one.
 *   2. ENQUEUE — POST each discovered URL to {scraper}/ingest/scrape, ROUND-ROBIN across
 *      stores so a spent budget costs every store its Nth URL rather than erasing the tail
 *      of the store list. The queue does the real work (per-host pacing, honesty gate,
 *      extraction, spine emit) and dedups by URL, so re-running a pass is idempotent.
 *
 * GLOBAL EGRESS CEILING: every request — lookups AND ingests — passes through ONE
 * shared RequestGate, so the per-host pacing the queue already does is capped by a
 * cross-host concurrency limit and a total-request budget over the single egress IP.
 * Discovery spends that shared budget FIRST, so an under-sized budget drops discovered
 * URLs: size it as stores x terms + stores (retries) + stores x maxUrlsPerStore — the pass
 * logs an ERROR when it is below that, and again when a spent budget actually dropped work.
 * The pass is bounded in wall clock too (INITIATOR_PASS_DEADLINE_MS), so an over-running
 * pass cannot overlap the next CronJob tick and double the egress the gate caps.
 *
 * NOT the full driver: this imports nothing from src/driver/* (no coverage ledger,
 * scheduler, or crawl loop) and holds no internal recurrence — recurrence is the
 * K8s CronJob's schedule. One invocation = one pass, then exit.
 */
import { createRequestGate, type RequestGate } from './requestGate.js';
import { logger } from '../utils/logger.js';
import { classifyFetchFailure } from '../services/failureClassifier.js';
import type { FetchFailureReport, ReportFetchFailure } from '../services/failureReporter.js';
import type { InitiatorConfig } from './config.js';

export type { InitiatorConfig } from './config.js';

/** The minimal Fetch Response surface the initiator consumes (global fetch satisfies it). */
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

export interface InitiatorDeps {
  fetch: FetchLike;
  /** Override the gate (tests); defaults to one built from the config. */
  gate?: RequestGate;
  /** Injectable delay used between a lookup and its retry (tests); defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock for the pass deadline (tests); defaults to Date.now. */
  now?: () => number;
  /**
   * The durable fetch-failure ledger seam (createFailureReporterFromEnv). Optional — absent means
   * reporting is OFF and every emit point is a no-op. Only the pass's TERMINAL branches report: the
   * one retry a store gets stays silent, because the producer has not stopped trying yet.
   */
  reportFailure?: ReportFetchFailure;
}

export interface StoreSummary {
  siteId: string;
  /** Distinct candidate URLs kept for this store (capped at maxUrlsPerStore). */
  discovered: number;
  /** URLs the scraper accepted (HTTP 202). */
  enqueued: number;
  /** Of `enqueued`, how many the queue coalesced onto a pending item (dedup key hit). */
  deduplicated: number;
  /** Failed ingest POSTs, terminal lookup failures, and stores the fan-out reported as `failed`. */
  errors: number;
  /** Stores the fan-out reported as cooling / unsupported (deliberately left alone). */
  skipped: number;
  /** Lookup calls actually dispatched for this store (retries included). */
  lookupAttempts: number;
  /** Of those, second attempts issued after a transient failure. */
  lookupRetries: number;
  /** Lookups that ended in failure — a 4xx, or a transient failure whose retry also failed. */
  lookupFailures: number;
}

export interface RunSummary {
  scraperServiceUrl: string;
  storesConfigured: number;
  termsConfigured: number;
  maxConcurrency: number;
  requestBudget: number;
  requestsIssued: number;
  budgetExhausted: boolean;
  /** True when the pass stopped dispatching because INITIATOR_PASS_DEADLINE_MS was reached. */
  deadlineExceeded: boolean;
  peakInFlight: number;
  /** Sum of the per-store lookupFailures (a failure is charged to its own store). */
  lookupFailures: number;
  totalDiscovered: number;
  totalEnqueued: number;
  totalErrors: number;
  stores: StoreSummary[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

interface LookupResponseBody {
  results?: Array<{ siteId?: string; candidates?: Array<{ url?: string; collectUrl?: string }> }>;
  resolveTargets?: Array<{ siteId?: string; url?: string }>;
  failed?: string[];
  cooldown?: string[];
  unsupported?: string[];
}

interface IngestResponseBody {
  success?: boolean;
  deduplicated?: boolean;
  itemId?: string;
}

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

export async function runInitiatorPass(config: InitiatorConfig, deps: InitiatorDeps): Promise<RunSummary> {
  const startedAt = new Date();
  const gate =
    deps.gate ??
    createRequestGate({
      maxConcurrency: config.maxConcurrency,
      maxRequests: config.maxRequests,
      spacingMs: config.requestSpacingMs,
    });

  const uniqueStores = config.stores.filter((s, i) => config.stores.indexOf(s) === i);
  const perStore = new Map<string, StoreSummary>();
  for (const siteId of config.stores) {
    if (!perStore.has(siteId))
      perStore.set(siteId, {
        siteId,
        discovered: 0,
        enqueued: 0,
        deduplicated: 0,
        errors: 0,
        skipped: 0,
        lookupAttempts: 0,
        lookupRetries: 0,
        lookupFailures: 0,
      });
  }
  // Distinct, capped candidate URLs per store.
  const discovered = new Map<string, Set<string>>();
  const setFor = (siteId: string): Set<string> => {
    let s = discovered.get(siteId);
    if (!s) {
      s = new Set<string>();
      discovered.set(siteId, s);
    }
    return s;
  };
  const addUrl = (siteId: string, url: string): void => {
    const s = setFor(siteId);
    if (s.size >= config.maxUrlsPerStore) return;
    s.add(url);
  };

  let budgetExhausted = false;
  let deadlineExceeded = false;
  /** Discovered URLs never POSTed because the budget or the deadline ran out (silent data loss). */
  let droppedUrls = 0;
  const now = deps.now ?? Date.now;
  const passStartedMs = now();
  /**
   * The pass has a wall clock, not just a request budget: an hourly CronJob whose pass
   * outruns its schedule puts two passes — two independent gates — on the single egress
   * IP at once, which is exactly what the gate exists to prevent. Past the deadline
   * nothing further is dispatched; what already ran is still summarized.
   */
  const pastDeadline = (): boolean => {
    if (config.passDeadlineMs <= 0) return false;
    if (now() - passStartedMs < config.passDeadlineMs) return false;
    if (!deadlineExceeded) {
      deadlineExceeded = true;
      logger.warn(`[INITIATOR] pass deadline ${config.passDeadlineMs}ms reached — dispatching nothing further`);
    }
    return true;
  };
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const summarize = (): RunSummary => {
    for (const [siteId, s] of discovered) {
      const ss = perStore.get(siteId);
      if (ss) ss.discovered = s.size;
    }
    const stores = config.stores
      .filter((s, i) => config.stores.indexOf(s) === i)
      .map((siteId) => perStore.get(siteId)!)
      .filter(Boolean);
    const finishedAt = new Date();
    return {
      scraperServiceUrl: config.scraperServiceUrl,
      storesConfigured: config.stores.length,
      termsConfigured: config.terms.length,
      maxConcurrency: config.maxConcurrency,
      requestBudget: config.maxRequests,
      requestsIssued: gate.issued(),
      budgetExhausted,
      deadlineExceeded,
      peakInFlight: gate.peakInFlight(),
      lookupFailures: stores.reduce((n, s) => n + s.lookupFailures, 0),
      totalDiscovered: stores.reduce((n, s) => n + s.discovered, 0),
      totalEnqueued: stores.reduce((n, s) => n + s.enqueued, 0),
      totalErrors: stores.reduce((n, s) => n + s.errors, 0),
      stores,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
    };
  };

  // Guard: with no stores or no terms there is nothing to do — make NO requests.
  if (config.stores.length === 0 || config.terms.length === 0) {
    const summary = summarize();
    logger.info('[INITIATOR] pass complete (nothing to do)', summary as unknown as Record<string, unknown>);
    return summary;
  }

  // Lookups and ingests share ONE budget and discovery spends it FIRST, so an under-sized
  // budget silently drops discovered URLs instead of failing loudly. Say so, loudly.
  const budgetNeeded =
    uniqueStores.length * config.terms.length + uniqueStores.length + uniqueStores.length * config.maxUrlsPerStore;
  if (config.maxRequests > 0 && config.maxRequests < budgetNeeded) {
    logger.error(
      `[INITIATOR] request budget ${config.maxRequests} is below the configured fan-out: ` +
        `${budgetNeeded} needed (stores x terms lookups + one retry per store + stores x maxUrlsPerStore ingests). ` +
        'Discovered URLs will be dropped unenqueued — raise INITIATOR_MAX_REQUESTS.',
    );
  }

  // Each lookup asks for exactly ONE store, so one store's latency or failure is charged to that
  // store alone (see the header: a shared fan-out let the slowest store zero the whole pass).
  const lookupUrl = (term: string, siteId: string): string =>
    `${config.scraperServiceUrl}/lookup?q=${encodeURIComponent(term)}&mode=${config.mode}&stores=${encodeURIComponent(siteId)}`;
  const ingestUrl = `${config.scraperServiceUrl}/ingest/scrape`;

  /**
   * Fire ONE ledger row. Best effort: no reporter is a no-op, and neither a synchronous throw nor a
   * rejected report may change the pass — the summary counters stay the caller's contract.
   */
  const emitFailure = (report: FetchFailureReport): void => {
    if (!deps.reportFailure) return;
    try {
      void Promise.resolve(deps.reportFailure(report)).catch(() => {});
    } catch {
      // bookkeeping never breaks a pass
    }
  };

  /**
   * The CANONICAL ledger target for one store's search of one term — the SAME identity the engine's
   * own fan-out reports, so the two views of one failing store search land on ONE row. Never the
   * real /lookup URL: that is the scraper's own address, which differs between environments.
   */
  const searchTarget = (term: string, siteId: string): string =>
    `fc:search/${siteId}?q=${encodeURIComponent(term)}&mode=${config.mode}`;

  /**
   * The reason class for a status THE SCRAPER ITSELF answered. /lookup is our own endpoint (it emits
   * 400, 502 or 200 — never 404), so a 404/403/410 there is route drift, a rolled-back deploy, or a
   * mis-pointed SCRAPER_SERVICE_URL. Routing it through the store-verdict table would file it as
   * gone_404, which the spine closes as 'gone': never retried, never in the review queue — a whole
   * discovery outage recording itself as "the stores removed these searches". Only a 5xx names a
   * fault we can attribute; the two genuinely transient 4xx keep their classes; everything else is
   * triage. Same rule the crawler applies to /catalog (E8).
   */
  const ourOwnStatusClass = (status: number): FetchFailureReport['reasonClass'] => {
    if (status >= 500) return 'http_5xx';
    if (status === 429) return 'http_429';
    if (status === 408) return 'timeout';
    return 'other';
  };

  /** One terminal lookup failure → one row. `parseFailure` is a 2xx we could not read: ours to fix. */
  const reportLookupFailure = (term: string, siteId: string, outcome: { reason: string; status?: number; parseFailure?: boolean }): void => {
    const reasonClass: FetchFailureReport['reasonClass'] = outcome.parseFailure
      ? 'parse'
      : outcome.status !== undefined
        ? ourOwnStatusClass(outcome.status)
        // No status at all: the transport threw, and the message is the only signal there is.
        : classifyFetchFailure({ error: outcome.reason }).reasonClass;
    emitFailure({
      site: siteId,
      target: searchTarget(term, siteId),
      kind: 'search',
      origin: 'initiator',
      reasonClass,
      // The status IS honest here: the target of a `fc:search` row is the lookup we issued, and the
      // status is the answer that lookup got. Only the CLASS must not pose as a store verdict.
      ...(outcome.status !== undefined && !outcome.parseFailure ? { httpStatus: outcome.status } : {}),
      message: outcome.reason,
    });
  };

  /**
   * Consume ONE store-scoped lookup body. Returns `candidates` (usable URLs the store
   * actually returned) and `kept` (how many the per-store cap let through) — a capped
   * store returning results must not look, in the log, like a store returning nothing.
   */
  const consume = (siteId: string, body: LookupResponseBody): { candidates: number; kept: number } => {
    const before = setFor(siteId).size;
    let candidates = 0;
    for (const sr of body.results ?? []) {
      if (sr.siteId !== siteId) continue; // a body may echo other stores; only the asked-for one counts
      for (const c of sr.candidates ?? []) {
        // Prefer the engine's collect-ready URL; fall back to the page url (older engine, or no
        // collectUrl derivable). Dedup (setFor/addUrl) keys on whichever was chosen.
        const u = typeof c.collectUrl === 'string' && c.collectUrl ? c.collectUrl : c.url;
        if (typeof u === 'string' && u) {
          candidates++;
          addUrl(siteId, u);
        }
      }
    }
    for (const rt of body.resolveTargets ?? []) {
      if (rt.siteId === siteId && typeof rt.url === 'string' && rt.url) {
        candidates++;
        addUrl(siteId, rt.url);
      }
    }
    const ss = perStore.get(siteId);
    if (ss) {
      if ((body.failed ?? []).includes(siteId)) ss.errors++;
      if ((body.cooldown ?? []).includes(siteId) || (body.unsupported ?? []).includes(siteId)) ss.skipped++;
    }
    return { candidates, kept: setFor(siteId).size - before };
  };

  /**
   * ONE lookup attempt. `retryable` = the fault a second call could survive (abort/timeout,
   * network error, HTTP 5xx); `fatal` = one it could not (4xx — the same request would be
   * rejected the same way — or a 2xx body that will not parse); `budget-exhausted` = never
   * dispatched, so it is neither an attempt nor a failure.
   */
  type AttemptOutcome =
    | { kind: 'ok' }
    | { kind: 'retryable' | 'fatal'; reason: string; status?: number; parseFailure?: boolean }
    | { kind: 'budget-exhausted' };

  const attemptLookup = async (term: string, siteId: string, ss: StoreSummary): Promise<AttemptOutcome> => {
    const startedMs = Date.now();
    let res: HttpResponseLike;
    try {
      const r = await gate.run(() => httpGet(deps.fetch, lookupUrl(term, siteId), config.requestTimeoutMs));
      if (r.status === 'budget-exhausted') return { kind: 'budget-exhausted' };
      ss.lookupAttempts++;
      res = r.value;
    } catch (error) {
      ss.lookupAttempts++; // dispatched, then aborted / failed in transport
      const reason = error instanceof Error ? error.message : String(error);
      logger.info(`[INITIATOR] lookup store=${siteId} term=${term} status=0 ms=${Date.now() - startedMs} candidates=0 kept=0 error=${reason}`);
      return { kind: 'retryable', reason };
    }
    if (!res.ok) {
      logger.info(`[INITIATOR] lookup store=${siteId} term=${term} status=${res.status} ms=${Date.now() - startedMs} candidates=0 kept=0`);
      // 5xx is the engine/upstream faulting; 429 and 408 are the two 4xx a second call after a
      // delay genuinely survives. Every other 4xx is a fault the same request would repeat.
      const transient = res.status >= 500 || res.status === 429 || res.status === 408;
      return { kind: transient ? 'retryable' : 'fatal', reason: `status ${res.status}`, status: res.status };
    }
    try {
      const { candidates, kept } = consume(siteId, (await res.json()) as LookupResponseBody);
      logger.info(`[INITIATOR] lookup store=${siteId} term=${term} status=${res.status} ms=${Date.now() - startedMs} candidates=${candidates} kept=${kept}`);
      return { kind: 'ok' };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.info(`[INITIATOR] lookup store=${siteId} term=${term} status=${res.status} ms=${Date.now() - startedMs} candidates=0 kept=0 error=${reason}`);
      // A 2xx whose body will not parse (or whose consumption threw): OURS, not the store's.
      return { kind: 'fatal', reason, status: res.status, parseFailure: true };
    }
  };

  // Phase 1 — DISCOVERY. Per store: its terms run SEQUENTIALLY, and the stores run in
  // parallel under the gate. Store-major submission put every concurrent gate slot on the
  // SAME store, so one hung store held them all and delayed every other store's first
  // lookup by a whole request timeout. Running one term at a time per store keeps the
  // in-flight set on distinct stores, lets a term see what the previous term already
  // discovered, and caps a store's retries at one for the pass.
  const discoverOne = async (term: string, siteId: string, ss: StoreSummary, state: { retryUsed: boolean }): Promise<void> => {
    const first = await attemptLookup(term, siteId, ss);
    if (first.kind === 'ok') return;
    if (first.kind === 'budget-exhausted') {
      budgetExhausted = true;
      return;
    }
    if (first.kind === 'fatal') {
      ss.lookupFailures++;
      ss.errors++;
      logger.warn(`[INITIATOR] lookup store=${siteId} term=${term} failed (not retried): ${first.reason}`);
      reportLookupFailure(term, siteId, first);
      return;
    }
    // Transient — but a store gets ONE retry for the whole pass, not one per term: a store
    // that is already failing would otherwise double the discovery budget and the wall clock.
    if (state.retryUsed) {
      ss.lookupFailures++;
      ss.errors++;
      logger.warn(`[INITIATOR] lookup store=${siteId} term=${term} failed (store retry already spent): ${first.reason}`);
      reportLookupFailure(term, siteId, first);
      return;
    }

    logger.warn(`[INITIATOR] lookup store=${siteId} term=${term} failed, retrying once in ${config.lookupRetryDelayMs}ms: ${first.reason}`);
    if (config.lookupRetryDelayMs > 0) await sleep(config.lookupRetryDelayMs);
    const second = await attemptLookup(term, siteId, ss);
    if (second.kind === 'budget-exhausted') {
      budgetExhausted = true;
      ss.lookupFailures++;
      ss.errors++;
      logger.warn(`[INITIATOR] lookup store=${siteId} term=${term} retry skipped (request budget spent)`);
      return;
    }
    state.retryUsed = true;
    ss.lookupRetries++;
    if (second.kind === 'ok') return;
    ss.lookupFailures++;
    ss.errors++;
    logger.warn(`[INITIATOR] lookup store=${siteId} term=${term} failed after retry: ${second.reason}`);
    // ONE row for the whole cycle: the retry itself above is deliberately silent.
    reportLookupFailure(term, siteId, second);
  };

  const discoverStore = async (siteId: string): Promise<void> => {
    const ss = perStore.get(siteId);
    if (!ss) return;
    const state = { retryUsed: false };
    for (const term of config.terms) {
      // A full URL cap makes another term's lookup pure waste — everything it returns is
      // discarded by addUrl. (Cap 0 is the documented discovery-only dry run: still look up.)
      if (config.maxUrlsPerStore > 0 && setFor(siteId).size >= config.maxUrlsPerStore) break;
      if (pastDeadline()) break;
      await discoverOne(term, siteId, ss, state);
    }
  };
  await Promise.all(uniqueStores.map((siteId) => discoverStore(siteId)));

  // Phase 2 — ENQUEUE (per store, per discovered URL). One bad store/URL is logged
  // and skipped; it never aborts the rest of the pass.
  //
  // ROUND-ROBIN, not store-major: the gate reserves its budget slot in submission
  // order, so a store-major list makes a spent budget erase the TAIL stores entirely
  // (deterministically, every pass). Interleaved, an exhausted budget costs each store
  // its Nth URL instead. The store list is deduped so a siteId repeated in
  // INITIATOR_STORES cannot POST the same URL twice.
  const perStoreUrls = uniqueStores.map((siteId) => ({ siteId, urls: [...setFor(siteId)] }));
  const flat: Array<{ siteId: string; url: string }> = [];
  const deepest = perStoreUrls.reduce((n, s) => Math.max(n, s.urls.length), 0);
  for (let i = 0; i < deepest; i++) {
    for (const { siteId, urls } of perStoreUrls) {
      if (i < urls.length) flat.push({ siteId, url: urls[i] });
    }
  }

  const enqueueOne = async ({ siteId, url }: { siteId: string; url: string }): Promise<void> => {
    const ss = perStore.get(siteId);
    if (!ss) return;
    if (pastDeadline()) {
      droppedUrls++;
      return;
    }
    try {
      const r = await gate.run(() => httpPostJson(deps.fetch, ingestUrl, { url }, config.requestTimeoutMs));
      if (r.status === 'budget-exhausted') {
        budgetExhausted = true;
        droppedUrls++;
        logger.warn(`[INITIATOR] ingest skipped store=${siteId} (request budget spent) url=${url}`);
        return;
      }
      const res = r.value;
      if (!res.ok) {
        ss.errors++;
        logger.warn(`[INITIATOR] ingest rejected store=${siteId} status=${res.status} url=${url}`);
        // E13 — a 4xx is a DETERMINISTIC refusal of this url (typically no ruleset matches): ours,
        // and terminal. A 5xx is the scraper faulting, which the ledger retries on its own schedule.
        // NO httpStatus: the status is our own /ingest/scrape's, while the row's target is the
        // STORE's url — recording it would assert a response that store never gave. It stays in the
        // message, where it reads as what it is.
        emitFailure({
          site: siteId,
          target: url,
          kind: 'record',
          origin: 'initiator',
          reasonClass: res.status >= 500 ? 'http_5xx' : 'ruleset',
          message: `the scraper refused this url with ${res.status}`,
        });
        return;
      }
      const body = (await res.json().catch(() => ({}))) as IngestResponseBody;
      ss.enqueued++;
      if (body.deduplicated === true) ss.deduplicated++;
    } catch (error) {
      ss.errors++;
      logger.warn(`[INITIATOR] ingest errored store=${siteId} url=${url}: ${error instanceof Error ? error.message : String(error)}`);
      emitFailure({
        site: siteId,
        target: url,
        kind: 'record',
        origin: 'initiator',
        reasonClass: classifyFetchFailure({ error }).reasonClass === 'timeout' ? 'timeout' : 'network',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };
  await Promise.all(flat.map((item) => enqueueOne(item)));

  const summary = summarize();
  if (droppedUrls > 0) {
    logger.error(
      `[INITIATOR] pass dropped ${droppedUrls} discovered URL(s) unenqueued: ` +
        `${summary.budgetExhausted ? `the request budget (${summary.requestBudget}) ran out after ${summary.requestsIssued} requests` : ''}` +
        `${summary.budgetExhausted && summary.deadlineExceeded ? ' and ' : ''}` +
        `${summary.deadlineExceeded ? `the pass deadline (${config.passDeadlineMs}ms) was reached` : ''}. ` +
        'Raise INITIATOR_MAX_REQUESTS or narrow the store/term set.',
    );
  }
  logger.info('[INITIATOR] pass complete', summary as unknown as Record<string, unknown>);
  for (const s of summary.stores) {
    logger.info('[INITIATOR] store summary', s as unknown as Record<string, unknown>);
  }
  return summary;
}
