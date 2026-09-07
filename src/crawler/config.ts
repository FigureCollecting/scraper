/**
 * Config for the catalog crawler (the continuous-collection feeder).
 *
 * The crawler is a bounded, CronJob-driven pass over each configured store's
 * newest-first catalog listing (the scraper's own GET /catalog feed): a RECENT
 * sweep from page 1 that stops at the first page with nothing new, THEN a
 * BACKFILL that resumes a durable per-store page cursor, THEN — for the stores
 * named in CRAWLER_RANGE_STORES — an ID-RANGE backfill that walks the store's
 * sequential id space downward from a frontier. Every discovered item's
 * collectUrl goes to POST /ingest/scrape. Like the initiator, it is a thin HTTP
 * client of the scraper — NOT the full 2b crawl driver (src/driver/*).
 *
 * Every knob is an environment variable with a conservative, safe default so an
 * unconfigured invocation stays bounded and gentle on the single egress IP.
 */

import { logger } from '../utils/logger.js';

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
  /**
   * Per-store overrides of `maxEnqueuePerStore`, keyed by siteId. A store the operator has to hold
   * back (anitoys stalls above ~15/h behind its Cloudflare gate) gets its own ceiling without
   * throttling every other store; an explicit 0 pulls that store OUT of the run entirely (no
   * requests at all) — as opposed to a GLOBAL 0, which stays a discovery-only dry run.
   */
  storeEnqueueCaps: Record<string, number>;
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
  /**
   * siteIds whose SEQUENTIAL id space is walked downward after the listing phases (the id-range
   * backfill). Empty by default: no store walks its id space unless the operator names it, so the
   * crawler never spends a request discovering that a store has no `byRange` axis.
   */
  rangeStores: string[];
  /**
   * ID-RANGE: max ids walked per store per run (the window size asked of GET /catalog?range=1),
   * clamped to MAX_RANGE_IDS_PER_RUN — the engine would silently hand back a shorter window.
   */
  rangeIdsPerRun: number;
  /**
   * Seed frontiers per siteId, from `CRAWLER_RANGE_FRONTIER_<SITEID>`, used ONLY when the store's
   * ledger has no numeric itemId of its own to start from. `<SITEID>` is the siteId uppercased with
   * every non-alphanumeric character replaced by `_` (`good-smile` → `CRAWLER_RANGE_FRONTIER_GOOD_SMILE`).
   */
  rangeFrontiers: Record<string, number>;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The largest id-range window the engine will serve: GET /catalog?range=1 clamps `count` to 200
 * (MAX_ID_RANGE_COUNT in src/driver/assembleCatalog.ts — the crawler imports nothing from the driver,
 * so the two must be kept in step). Asking for more silently yields 200, so the operator's value is
 * clamped HERE, once, with a WARN, rather than being truncated invisibly on the wire.
 */
export const MAX_RANGE_IDS_PER_RUN = 200;

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
  rangeIdsPerRun: 50,
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

/** A siteId is a plain token (it doubles as a ledger file stem) — anything else is refused. */
const SAFE_SITE_ID = /^[A-Za-z0-9_-]+$/;

/**
 * Parse `CRAWLER_STORE_ENQUEUE_CAPS` — a csv of `siteId:cap` pairs. Every entry is validated on its
 * own: a malformed one is DROPPED with a WARN naming it, and the well-formed entries still apply, so
 * one typo can never silently unthrottle a store nor void the whole declaration. A repeated siteId
 * takes its LAST value.
 */
const parseStoreCaps = (raw: string | undefined): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const entry of csv(raw ?? '')) {
    const at = entry.indexOf(':');
    const siteId = at === -1 ? '' : entry.slice(0, at).trim();
    const capRaw = at === -1 ? '' : entry.slice(at + 1).trim();
    const cap = Number(capRaw);
    if (!SAFE_SITE_ID.test(siteId) || !/^\d+$/.test(capRaw) || !Number.isSafeInteger(cap)) {
      logger.warn('[CRAWLER] CRAWLER_STORE_ENQUEUE_CAPS entry ignored (expected siteId:nonNegativeInteger)', { entry });
      continue;
    }
    out[siteId] = cap;
  }
  return out;
};

/** The env-var suffix for a store's range frontier seed: uppercased, every non-alphanumeric → `_`. */
export const rangeFrontierEnvName = (siteId: string): string =>
  `CRAWLER_RANGE_FRONTIER_${siteId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;

/** Read one `CRAWLER_RANGE_FRONTIER_<SITEID>` seed per configured store; a non-positive / non-numeric value is simply absent. */
const parseFrontiers = (env: Env, stores: string[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const siteId of stores) {
    const raw = env[rangeFrontierEnvName(siteId)];
    if (raw === undefined) continue;
    const n = Number.parseInt(raw.trim(), 10);
    if (Number.isSafeInteger(n) && n > 0) out[siteId] = n;
  }
  return out;
};

/** Positive int, clamped to `max` with a WARN naming the env var when the operator asked for more. */
const clampedPosInt = (raw: string | undefined, fallback: number, max: number, envName: string): number => {
  const n = posInt(raw, fallback);
  if (n <= max) return n;
  logger.warn(`[CRAWLER] ${envName} clamped to the engine's window ceiling`, { requested: n, applied: max });
  return max;
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
    storeEnqueueCaps: parseStoreCaps(env.CRAWLER_STORE_ENQUEUE_CAPS),
    maxConcurrency: posInt(env.CRAWLER_MAX_CONCURRENCY, DEFAULTS.maxConcurrency),
    requestSpacingMs: posInt(env.CRAWLER_REQUEST_SPACING_MS, DEFAULTS.requestSpacingMs),
    requestTimeoutMs: posInt(env.CRAWLER_REQUEST_TIMEOUT_MS, DEFAULTS.requestTimeoutMs),
    reobserveAfterMs: nonNegInt(env.CRAWLER_REOBSERVE_AFTER_MS, DEFAULTS.reobserveAfterMs),
    exhaustedRecheckMs: posInt(env.CRAWLER_EXHAUSTED_RECHECK_MS, DEFAULTS.exhaustedRecheckMs),
    rangeStores: csv(env.CRAWLER_RANGE_STORES ?? ''),
    rangeIdsPerRun: clampedPosInt(env.CRAWLER_RANGE_IDS_PER_RUN, DEFAULTS.rangeIdsPerRun, MAX_RANGE_IDS_PER_RUN, 'CRAWLER_RANGE_IDS_PER_RUN'),
    rangeFrontiers: parseFrontiers(env, stores),
  };
}
