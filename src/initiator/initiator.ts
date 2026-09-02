/**
 * runInitiatorPass — ONE bounded ingestion pass. The interim bridge between "no
 * continuous initiator, only manual POSTs" and the full 2b crawl driver.
 *
 * WHAT IT DOES (and deliberately no more):
 *   1. DISCOVER — for each configured term, GET {scraper}/lookup?q= (the scraper's
 *      own cross-store search). The fan-out returns candidates for every store it
 *      knows; the initiator keeps only candidates for the CONFIGURED stores, bounded
 *      to maxUrlsPerStore each. Lookups are issued once per TERM (shared across
 *      stores) rather than per store: one fan-out already covers every store, so a
 *      per-store loop would multiply the scraper's upstream search egress needlessly.
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
  /** Term-level /lookup failures (5xx / network / parse). */
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
  results?: Array<{ siteId?: string; candidates?: Array<{ url?: string }> }>;
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

  const storeSet = new Set(config.stores);
  const perStore = new Map<string, StoreSummary>();
  for (const siteId of config.stores) {
    if (!perStore.has(siteId)) perStore.set(siteId, { siteId, discovered: 0, enqueued: 0, deduplicated: 0, errors: 0, skipped: 0 });
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

  let lookupFailures = 0;
  let budgetExhausted = false;

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
      lookupFailures,
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

  const lookupUrl = (term: string): string => `${config.scraperServiceUrl}/lookup?q=${encodeURIComponent(term)}&mode=${config.mode}`;
  const ingestUrl = `${config.scraperServiceUrl}/ingest/scrape`;

  // Phase 1 — DISCOVERY (one shared fan-out per term).
  const discoverTerm = async (term: string): Promise<void> => {
    try {
      const r = await gate.run(() => httpGet(deps.fetch, lookupUrl(term), config.requestTimeoutMs));
      if (r.status === 'budget-exhausted') {
        budgetExhausted = true;
        return;
      }
      const res = r.value;
      if (!res.ok) {
        lookupFailures++;
        logger.warn('[INITIATOR] lookup failed', { term, status: res.status });
        return;
      }
      const body = (await res.json()) as LookupResponseBody;
      for (const sr of body.results ?? []) {
        if (!sr.siteId || !storeSet.has(sr.siteId)) continue;
        for (const c of sr.candidates ?? []) {
          if (typeof c.url === 'string' && c.url) addUrl(sr.siteId, c.url);
        }
      }
      for (const rt of body.resolveTargets ?? []) {
        if (rt.siteId && storeSet.has(rt.siteId) && typeof rt.url === 'string' && rt.url) addUrl(rt.siteId, rt.url);
      }
      for (const sid of body.failed ?? []) {
        const ss = perStore.get(sid);
        if (ss) ss.errors++;
      }
      for (const sid of [...(body.cooldown ?? []), ...(body.unsupported ?? [])]) {
        const ss = perStore.get(sid);
        if (ss) ss.skipped++;
      }
    } catch (error) {
      lookupFailures++;
      logger.warn('[INITIATOR] lookup errored', { term, error: error instanceof Error ? error.message : String(error) });
    }
  };
  await Promise.all(config.terms.map((term) => discoverTerm(term)));

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
