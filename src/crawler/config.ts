/**
 * Config for the catalog crawler (the continuous-collection feeder).
 *
 * The crawler is a bounded, CronJob-driven pass over each configured store's
 * newest-first catalog listing (the scraper's own GET /catalog feed): a RECENT
 * sweep from page 1 that stops at the first page with nothing new, THEN a
 * BACKFILL that resumes a durable per-store page cursor. Every discovered item's
 * collectUrl goes to POST /ingest/scrape. Like the initiator, it is a thin HTTP
 * client of the scraper — NOT the full 2b crawl driver (src/driver/*).
 *
 * Every knob is an environment variable with a conservative, safe default so an
 * unconfigured invocation stays bounded and gentle on the single egress IP.
 */

export type CrawlerMode = 'recent' | 'backfill' | 'both';

export interface CrawlerConfig {
  /** Base URL of the scraper's HTTP surface — the ONLY thing the crawler talks to. */
  scraperServiceUrl: string;
  /** Which phases run: `recent`, `backfill`, or `both` (recent THEN backfill, one process). */
  mode: CrawlerMode;
  /** siteIds to crawl this pass. */
  stores: string[];
  /** Directory holding one `<siteId>.json` ledger per store (a PVC in the cluster). */
  ledgerDir: string;
  /** RECENT: max pages walked from page 1 per store per run. */
  recentMaxPages: number;
  /** BACKFILL: max pages advanced per store per run. */
  backfillPagesPerRun: number;
  /** GLOBAL total-requests budget for the run (catalog GETs + ingest POSTs). 0 = kill switch. */
  maxRequests: number;
  /** Upper bound on ingest POSTs per store per run (recent + backfill). 0 = discovery-only dry run. */
  maxEnqueuePerStore: number;
  /** GLOBAL max concurrent in-flight requests across ALL stores. */
  maxConcurrency: number;
  /** Minimum spacing, in ms, between consecutive request dispatches (global). */
  requestSpacingMs: number;
  /** Per-request timeout, in ms (must exceed the engine's CATALOG_STORE_TIMEOUT_MS). */
  requestTimeoutMs: number;
  /** RECENT only: re-POST a known item once its ledger entry is at least this old. 0 = never. */
  reobserveAfterMs: number;
  /** BACKFILL: re-check an exhausted store's last cursor once this long has elapsed since exhaustion. */
  exhaustedRecheckMs: number;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** The first store armed for continuous collection (orzgk: Woo Store API, 100/page, newest-first). */
export const DEFAULT_CRAWLER_STORES = ['orzgk'];

const DEFAULTS = {
  scraperServiceUrl: 'http://localhost:3050',
  ledgerDir: '/var/lib/ingest-crawler',
  recentMaxPages: 3,
  backfillPagesPerRun: 5,
  maxRequests: 100,
  maxEnqueuePerStore: 50,
  maxConcurrency: 2,
  requestSpacingMs: 1000,
  requestTimeoutMs: 45000,
  reobserveAfterMs: WEEK_MS,
  exhaustedRecheckMs: WEEK_MS,
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

/**
 * Parse a non-negative integer; fall back only on absent / non-numeric / negative
 * input. Used for the BUDGET knobs (maxRequests, maxEnqueuePerStore) and the
 * re-observe window, so an explicit 0 is honored as a hard clamp / "never" — a
 * safety limit must not fail OPEN by reverting to a generous default at its
 * most-conservative setting.
 */
const nonNegInt = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

const parseMode = (raw: string | undefined): CrawlerMode => (raw === 'recent' || raw === 'backfill' ? raw : 'both');

export function loadCrawlerConfig(env: Env = process.env): CrawlerConfig {
  // A csv var is defaulted ONLY when unset. An explicitly-set-but-empty value is
  // honored as an empty list — the operator's kill switch (zero stores → no work).
  const stores = env.CRAWLER_STORES === undefined ? [...DEFAULT_CRAWLER_STORES] : csv(env.CRAWLER_STORES);

  const scraperServiceUrl = (env.SCRAPER_SERVICE_URL || DEFAULTS.scraperServiceUrl).replace(/\/+$/, '');
  const ledgerDir = (env.CRAWLER_LEDGER_DIR ?? '').trim() || DEFAULTS.ledgerDir;

  return {
    scraperServiceUrl,
    mode: parseMode(env.CRAWLER_MODE),
    stores,
    ledgerDir,
    recentMaxPages: posInt(env.CRAWLER_RECENT_MAX_PAGES, DEFAULTS.recentMaxPages),
    backfillPagesPerRun: posInt(env.CRAWLER_BACKFILL_PAGES_PER_RUN, DEFAULTS.backfillPagesPerRun),
    maxRequests: nonNegInt(env.CRAWLER_MAX_REQUESTS, DEFAULTS.maxRequests),
    maxEnqueuePerStore: nonNegInt(env.CRAWLER_MAX_ENQUEUE_PER_STORE, DEFAULTS.maxEnqueuePerStore),
    maxConcurrency: posInt(env.CRAWLER_MAX_CONCURRENCY, DEFAULTS.maxConcurrency),
    requestSpacingMs: posInt(env.CRAWLER_REQUEST_SPACING_MS, DEFAULTS.requestSpacingMs),
    requestTimeoutMs: posInt(env.CRAWLER_REQUEST_TIMEOUT_MS, DEFAULTS.requestTimeoutMs),
    reobserveAfterMs: nonNegInt(env.CRAWLER_REOBSERVE_AFTER_MS, DEFAULTS.reobserveAfterMs),
    exhaustedRecheckMs: posInt(env.CRAWLER_EXHAUSTED_RECHECK_MS, DEFAULTS.exhaustedRecheckMs),
  };
}
