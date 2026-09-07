/**
 * runInitiatorPass — ONE bounded ingestion pass. The interim bridge between "no
 * continuous initiator, only manual POSTs" and the full 2b crawl driver.
 *
 * WHAT IT DOES (and deliberately no more):
 *   1. DISCOVER — for each configured term AND each configured store, GET
 *      {scraper}/lookup?q=&stores=<ONE store> (the scraper's own search, scoped to
 *      that one store). ONE LOOKUP PER STORE is deliberate: the scraper bounds each
 *      store's search by LOOKUP_STORE_TIMEOUT_MS, and a shared fan-out made the SLOWEST
 *      store the whole term's latency — one store hitting that bound tripped the
 *      initiator's own request timeout and zeroed EVERY store's discovery for the pass
 *      (2026-09-07 09:00Z, amiami). Scoped per store, a slow or failing store costs only
 *      its own lookup. Candidates are kept only for the store the call asked for, bounded
 *      to maxUrlsPerStore per store ACROSS terms.
 *      Each candidate carries the store's product PAGE link (`url`) and, from an engine
 *      that emits it, `collectUrl` — the collect-ready URL the engine derived from its
 *      retrieval axes (the byId Store-API URL where declared, else the page link
 *      absolutized). The initiator PREFERS collectUrl and falls back to url, so it
 *      works against an older engine and never POSTs a relative or CF-fronted page
 *      link when the engine knows a better one.
 *   2. ENQUEUE — POST each discovered URL to {scraper}/ingest/scrape. The queue does
 *      the real work (per-host pacing, honesty gate, extraction, spine emit) and
 *      dedups by URL, so re-running a pass is idempotent.
 *
 * GLOBAL EGRESS CEILING: every request — lookups AND ingests — passes through ONE
 * shared RequestGate, so the per-host pacing the queue already does is capped by a
 * cross-host concurrency limit and a total-request budget over the single egress IP.
 *
 * NOT the full driver: this imports nothing from src/driver/* (no coverage ledger,
 * scheduler, or crawl loop) and holds no internal recurrence — recurrence is the
 * K8s CronJob's schedule. One invocation = one pass, then exit.
 */
import { createRequestGate, type RequestGate } from './requestGate.js';
import { logger } from '../utils/logger.js';
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
}

export interface StoreSummary {
  siteId: string;
  /** Distinct candidate URLs kept for this store (capped at maxUrlsPerStore). */
  discovered: number;
  /** URLs the scraper accepted (HTTP 202). */
  enqueued: number;
  /** Of `enqueued`, how many the queue coalesced onto a pending item (dedup key hit). */
  deduplicated: number;
  /** Failed ingest POSTs + stores the fan-out reported as `failed`. */
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

  // Each lookup asks for exactly ONE store, so one store's latency or failure is charged to that
  // store alone (see the header: a shared fan-out let the slowest store zero the whole pass).
  const lookupUrl = (term: string, siteId: string): string =>
    `${config.scraperServiceUrl}/lookup?q=${encodeURIComponent(term)}&mode=${config.mode}&stores=${encodeURIComponent(siteId)}`;
  const ingestUrl = `${config.scraperServiceUrl}/ingest/scrape`;

  /** Consume ONE store-scoped lookup body; returns how many candidate URLs it contributed. */
  const consume = (siteId: string, body: LookupResponseBody): number => {
    const before = setFor(siteId).size;
    for (const sr of body.results ?? []) {
      if (sr.siteId !== siteId) continue; // a body may echo other stores; only the asked-for one counts
      for (const c of sr.candidates ?? []) {
        // Prefer the engine's collect-ready URL; fall back to the page url (older engine, or no
        // collectUrl derivable). Dedup (setFor/addUrl) keys on whichever was chosen.
        const u = typeof c.collectUrl === 'string' && c.collectUrl ? c.collectUrl : c.url;
        if (typeof u === 'string' && u) addUrl(siteId, u);
      }
    }
    for (const rt of body.resolveTargets ?? []) {
      if (rt.siteId === siteId && typeof rt.url === 'string' && rt.url) addUrl(siteId, rt.url);
    }
    const ss = perStore.get(siteId);
    if (ss) {
      if ((body.failed ?? []).includes(siteId)) ss.errors++;
      if ((body.cooldown ?? []).includes(siteId) || (body.unsupported ?? []).includes(siteId)) ss.skipped++;
    }
    return setFor(siteId).size - before;
  };

  /**
   * ONE lookup attempt. `retryable` = the fault a second call could survive (abort/timeout,
   * network error, HTTP 5xx); `fatal` = one it could not (4xx — the same request would be
   * rejected the same way — or a 2xx body that will not parse); `budget-exhausted` = never
   * dispatched, so it is neither an attempt nor a failure.
   */
  type AttemptOutcome = { kind: 'ok' } | { kind: 'retryable' | 'fatal'; reason: string } | { kind: 'budget-exhausted' };

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
      logger.info('[INITIATOR] lookup', { term, siteId, status: 0, ms: Date.now() - startedMs, candidates: 0 });
      return { kind: 'retryable', reason };
    }
    if (!res.ok) {
      logger.info('[INITIATOR] lookup', { term, siteId, status: res.status, ms: Date.now() - startedMs, candidates: 0 });
      return { kind: res.status >= 500 ? 'retryable' : 'fatal', reason: `status ${res.status}` };
    }
    try {
      const candidates = consume(siteId, (await res.json()) as LookupResponseBody);
      logger.info('[INITIATOR] lookup', { term, siteId, status: res.status, ms: Date.now() - startedMs, candidates });
      return { kind: 'ok' };
    } catch (error) {
      logger.info('[INITIATOR] lookup', { term, siteId, status: res.status, ms: Date.now() - startedMs, candidates: 0 });
      return { kind: 'fatal', reason: error instanceof Error ? error.message : String(error) };
    }
  };

  // Phase 1 — DISCOVERY (one lookup per term x store, each retried at most once).
  const discoverOne = async (term: string, siteId: string): Promise<void> => {
    const ss = perStore.get(siteId);
    if (!ss) return;
    const first = await attemptLookup(term, siteId, ss);
    if (first.kind === 'ok') return;
    if (first.kind === 'budget-exhausted') {
      budgetExhausted = true;
      return;
    }
    if (first.kind === 'fatal') {
      ss.lookupFailures++;
      logger.warn('[INITIATOR] lookup failed (not retried)', { term, siteId, reason: first.reason });
      return;
    }

    logger.warn('[INITIATOR] lookup failed, retrying once', { term, siteId, reason: first.reason, delayMs: config.lookupRetryDelayMs });
    if (config.lookupRetryDelayMs > 0) await sleep(config.lookupRetryDelayMs);
    const second = await attemptLookup(term, siteId, ss);
    if (second.kind === 'budget-exhausted') {
      budgetExhausted = true;
      ss.lookupFailures++;
      logger.warn('[INITIATOR] lookup retry skipped (request budget spent)', { term, siteId });
      return;
    }
    ss.lookupRetries++;
    if (second.kind === 'ok') return;
    ss.lookupFailures++;
    logger.warn('[INITIATOR] lookup failed after retry', { term, siteId, reason: second.reason });
  };
  await Promise.all(uniqueStores.flatMap((siteId) => config.terms.map((term) => discoverOne(term, siteId))));

  // Phase 2 — ENQUEUE (per store, per discovered URL). One bad store/URL is logged
  // and skipped; it never aborts the rest of the pass.
  const flat: Array<{ siteId: string; url: string }> = [];
  for (const siteId of config.stores) {
    for (const url of setFor(siteId)) flat.push({ siteId, url });
  }

  const enqueueOne = async ({ siteId, url }: { siteId: string; url: string }): Promise<void> => {
    const ss = perStore.get(siteId);
    if (!ss) return;
    try {
      const r = await gate.run(() => httpPostJson(deps.fetch, ingestUrl, { url }, config.requestTimeoutMs));
      if (r.status === 'budget-exhausted') {
        budgetExhausted = true;
        return;
      }
      const res = r.value;
      if (!res.ok) {
        ss.errors++;
        logger.warn('[INITIATOR] ingest rejected', { siteId, status: res.status });
        return;
      }
      const body = (await res.json().catch(() => ({}))) as IngestResponseBody;
      ss.enqueued++;
      if (body.deduplicated === true) ss.deduplicated++;
    } catch (error) {
      ss.errors++;
      logger.warn('[INITIATOR] ingest errored', { siteId, error: error instanceof Error ? error.message : String(error) });
    }
  };
  await Promise.all(flat.map((item) => enqueueOne(item)));

  const summary = summarize();
  logger.info('[INITIATOR] pass complete', summary as unknown as Record<string, unknown>);
  for (const s of summary.stores) {
    logger.info('[INITIATOR] store summary', s as unknown as Record<string, unknown>);
  }
  return summary;
}
