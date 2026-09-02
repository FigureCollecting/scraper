/**
 * Config for the interim ingestion initiator (v0).
 *
 * The initiator is a deliberately minimal bridge: a bounded, CronJob-driven pass
 * that feeds the scraper's existing ingest queue. It is NOT the full 2b crawl
 * driver (src/driver/*) — no coverage ledger, no scheduler, no internal loop.
 *
 * Every knob is an environment variable with a conservative, safe default so an
 * unconfigured invocation stays bounded and gentle on the single egress IP.
 */

export type LookupMode = 'listed' | 'orderable';

export interface InitiatorConfig {
  /** Base URL of the scraper's HTTP surface — the ONLY thing the initiator talks to. */
  scraperServiceUrl: string;
  /** Proven-GO siteIds to feed this pass. */
  stores: string[];
  /** Discovery terms fanned through GET /lookup?q=. */
  terms: string[];
  /** Lookup scope: `listed` (all, incl. sold-out) or `orderable` (in-stock only). */
  mode: LookupMode;
  /** GLOBAL max concurrent in-flight requests across ALL stores (the interim cross-host cap). */
  maxConcurrency: number;
  /** GLOBAL total-requests budget for the whole run (lookups + ingests share it). */
  maxRequests: number;
  /** Upper bound on candidate URLs enqueued per store. */
  maxUrlsPerStore: number;
  /** Minimum spacing, in ms, between consecutive request dispatches (global). */
  requestSpacingMs: number;
  /** Per-request timeout, in ms, before the request is aborted (treated as a failure). */
  requestTimeoutMs: number;
}

/** The proven-GO route inventory (tonight's run) — the safe default store set. */
export const DEFAULT_STORES = ['orzgk', 'amiami', 'gkloot', 'goodsmileus', 'fnc', 'solaris', 'projectke'];

/** A small, conservative default discovery term. Operators override via INITIATOR_TERMS. */
export const DEFAULT_TERMS = ['nendoroid'];

const DEFAULTS = {
  scraperServiceUrl: 'http://localhost:3050',
  maxConcurrency: 2,
  maxRequests: 40,
  maxUrlsPerStore: 5,
  requestSpacingMs: 1000,
  requestTimeoutMs: 15000,
};

type Env = Record<string, string | undefined>;

const csv = (raw: string): string[] =>
  raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

/** Parse a positive integer; fall back to `fallback` on absent / non-numeric / non-positive input. */
const posInt = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export function loadInitiatorConfig(env: Env = process.env): InitiatorConfig {
  // A csv var is defaulted ONLY when unset. An explicitly-set-but-empty value is
  // honored as an empty list — the operator's kill switch (zero stores → no work).
  const stores = env.INITIATOR_STORES === undefined ? [...DEFAULT_STORES] : csv(env.INITIATOR_STORES);
  const terms = env.INITIATOR_TERMS === undefined ? [...DEFAULT_TERMS] : csv(env.INITIATOR_TERMS);

  const scraperServiceUrl = (env.SCRAPER_SERVICE_URL || DEFAULTS.scraperServiceUrl).replace(/\/+$/, '');

  return {
    scraperServiceUrl,
    stores,
    terms,
    mode: env.INITIATOR_LOOKUP_MODE === 'orderable' ? 'orderable' : 'listed',
    maxConcurrency: posInt(env.INITIATOR_MAX_CONCURRENCY, DEFAULTS.maxConcurrency),
    maxRequests: posInt(env.INITIATOR_MAX_REQUESTS, DEFAULTS.maxRequests),
    maxUrlsPerStore: posInt(env.INITIATOR_MAX_URLS_PER_STORE, DEFAULTS.maxUrlsPerStore),
    requestSpacingMs: posInt(env.INITIATOR_REQUEST_SPACING_MS, DEFAULTS.requestSpacingMs),
    requestTimeoutMs: posInt(env.INITIATOR_REQUEST_TIMEOUT_MS, DEFAULTS.requestTimeoutMs),
  };
}
