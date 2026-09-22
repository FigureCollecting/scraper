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

/**
 * One phase a pass may run.
 *
 * `recent` / `backfill` are the listing-and-id-space DISCOVERY feeder (the id-range walk rides
 * `backfill`). `reobserve` is the RE-OBSERVATION lane (D4, Ross 2026-09-18): it walks the ledger
 * instead of the store's pages and re-drives ids we already know, so an exhausted store keeps a live
 * price/availability series instead of freezing on the day it was walked. `seed` is a DIFFERENT,
 * EXCLUSIVE pass: ONLY the declared seed lists, and none of the other phases — its whole
 * justification is the bounded cost of a small declared set, and folding it into a walk would hide
 * that cost inside an unbounded one.
 */
export type CrawlerPhaseName = 'recent' | 'backfill' | 'reobserve' | 'seed';

/**
 * What `CRAWLER_MODE` named: one of the legacy single tokens (`recent`, `backfill`, `both`, `seed`),
 * the new `reobserve`, or a csv naming any subset of them (`both,reobserve`). `both` keeps meaning
 * recent+backfill exactly as before.
 */
export type CrawlerMode = CrawlerPhaseName | 'both' | `${string},${string}`;

/** The order phases run in, whatever order the operator named them. Discovery keeps its priority. */
export const PHASE_ORDER: readonly CrawlerPhaseName[] = ['recent', 'backfill', 'reobserve'] as const;

export interface CrawlerConfig {
  /** Base URL of the scraper's HTTP surface — the ONLY thing the crawler talks to. */
  scraperServiceUrl: string;
  /** What the operator named, normalised for the summary and the logs (`both` stays `both`). */
  mode: CrawlerMode;
  /** The phases this pass ACTUALLY runs, deduplicated and in PHASE_ORDER; `['seed']` for the exclusive seed pass. */
  phases: CrawlerPhaseName[];
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
  /**
   * SEED axis only: minimum wait, in ms, between one store's consecutive seed-list fetches. INDEPENDENT
   * of `requestSpacingMs`, which is a global dispatch spacing shared by every store and every axis.
   *
   * It exists because the engine applies NO per-host floor on the catalog/seed lane — a store's
   * declared `rateLimit` governs the ingest/record queue, not this one — so without this knob a
   * store's whole declared set would be fetched back to back at whatever the global gate allows.
   * The seed axis is a deliberately slow poll, so its floor is generous by default. `0` disables it.
   */
  seedSpacingMs: number;
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
  /**
   * RE-OBSERVE: an id is eligible only once its last observation is at least this old
   * (`CRAWLER_REOBSERVE_MIN_AGE_H`, hours). It is also the BACKOFF window for an id whose last
   * re-observation POST was refused: without it a permanently-refused id would sit at the head of
   * the oldest-first queue every run and starve the store's whole lane.
   */
  reobserveMinAgeMs: number;
  /**
   * RE-OBSERVE: the global per-store ceiling on re-observation POSTs per run. DEFAULT 0 = the lane is
   * OFF everywhere, so the fleet OPTS IN per store through `storeReobserveCaps`. Deliberately not the
   * discovery default: re-observation spends real requests at a gated store, where browser time is
   * the fleet's scarcest resource.
   */
  maxReobservePerStore: number;
  /**
   * RE-OBSERVE: per-store overrides of `maxReobservePerStore`, keyed by siteId — the same
   * `siteId:cap` shape as `storeEnqueueCaps`, and a SEPARATE budget from it, so discovery can never
   * be starved by re-observation nor re-observation by discovery.
   */
  storeReobserveCaps: Record<string, number>;
  /** RE-OBSERVE: print the selection and enqueue NOTHING (no POST, no ledger stamp). */
  reobserveDryRun: boolean;
  /**
   * ID-RANGE RE-ANCHOR (D5): how often the frontier is moved up to the newest id the ledger has seen,
   * from `CRAWLER_RANGE_REANCHOR_H` (hours). 0 = re-anchor on EVERY run. The descent walks DOWN from a
   * frontier frozen the day it began, so without this the ids the store adds above that frontier are
   * seen only by whatever the Latest Additions tap happens to catch between two runs.
   */
  rangeReanchorMs: number;
  /**
   * RE-ANCHOR sanity bound, from `CRAWLER_RANGE_REANCHOR_MAX_DELTA`: a re-anchor that would move the
   * frontier up by MORE than this many ids is refused with a WARN naming this knob. A jump that size is
   * more likely a bad id in the ledger than new items; raise it for a frontier frozen a long time.
   * 0 refuses every move.
   */
  rangeReanchorMaxDelta: number;
  /**
   * GAP SWEEP: the sweep's OWN per-run, per-store budget — at most this many ids touched AND at most
   * this many ingest POSTs. DEFAULT 0 = the sweep is OFF, so a store fills gaps only once the fleet
   * config asks it to. Deliberately SEPARATE from `maxEnqueuePerStore`: the descent must not be able
   * to starve the sweep, nor the sweep the descent.
   */
  rangeGapBudget: number;
  /**
   * GAP SWEEP: operator-declared bands per siteId, from `CRAWLER_RANGE_GAPS` — a csv of
   * `siteId:lo-hi` and `siteId:id` entries (a single id is a band of width 1). They are ADOPTED into
   * the store's ledger once, beside the bands the re-anchor records for itself.
   */
  rangeGaps: Record<string, GapBandDecl[]>;
  /** GAP SWEEP: print the open bands and their widths, and sweep NOTHING (no window GET, no POST). */
  rangeGapDryRun: boolean;
}

/** One operator-declared gap band, before it is adopted into a store's ledger. */
export interface GapBandDecl {
  from: number;
  to: number;
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
  seedSpacingMs: 10000,
  reobserveAfterMs: WEEK_MS,
  exhaustedRecheckMs: WEEK_MS,
  rangeIdsPerRun: 50,
  reobserveMinAgeH: 12,
  maxReobservePerStore: 0,
  rangeReanchorH: 24,
  rangeReanchorMaxDelta: 50000,
  rangeGapBudget: 0,
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
 * Parse a per-store cap var — `CRAWLER_STORE_ENQUEUE_CAPS` or `CRAWLER_STORE_REOBSERVE_CAPS` — a csv
 * of `siteId:cap` pairs. Every entry is validated on its own: a malformed one is DROPPED with a WARN
 * naming it AND the var it came from, and the well-formed entries still apply, so one typo can never
 * silently unthrottle a store nor void the whole declaration. A repeated siteId takes its LAST value.
 */
const parseStoreCaps = (raw: string | undefined, envName: string): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const entry of csv(raw ?? '')) {
    const at = entry.indexOf(':');
    const siteId = at === -1 ? '' : entry.slice(0, at).trim();
    const capRaw = at === -1 ? '' : entry.slice(at + 1).trim();
    const cap = Number(capRaw);
    if (!SAFE_SITE_ID.test(siteId) || !/^\d+$/.test(capRaw) || !Number.isSafeInteger(cap)) {
      logger.warn(`[CRAWLER] ${envName} entry ignored (expected siteId:nonNegativeInteger)`, { entry });
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

/**
 * Parse `CRAWLER_RANGE_GAPS` — a csv of `siteId:lo-hi` (a cluster range) or `siteId:id` (one id, a band
 * of width 1). Ross's ask was "several ids or cluster ranges to track", and one shape serves both.
 *
 * Every entry is validated on its own and a malformed one is DROPPED with a WARN naming it, exactly
 * like the per-store caps: a typo in one band must not void the operator's other declarations, and a
 * band silently coerced from a typo would be swept as though those were real ids.
 */
const parseRangeGaps = (raw: string | undefined): Record<string, GapBandDecl[]> => {
  const out: Record<string, GapBandDecl[]> = {};
  for (const entry of csv(raw ?? '')) {
    const at = entry.indexOf(':');
    const siteId = at === -1 ? '' : entry.slice(0, at).trim();
    const bandRaw = at === -1 ? '' : entry.slice(at + 1).trim();
    const m = /^(\d+)(?:-(\d+))?$/.exec(bandRaw);
    const from = m ? Number(m[1]) : Number.NaN;
    const to = m ? (m[2] === undefined ? from : Number(m[2])) : Number.NaN;
    if (!SAFE_SITE_ID.test(siteId) || !m || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from) {
      logger.warn('[CRAWLER] CRAWLER_RANGE_GAPS entry ignored (expected siteId:lowId-highId or siteId:id)', { entry });
      continue;
    }
    (out[siteId] ??= []).push({ from, to });
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

const PHASE_TOKENS = new Set<string>(['recent', 'backfill', 'reobserve', 'seed']);

/** What `CRAWLER_MODE` accepts, for the error message an operator will read at 01:30Z. */
const ACCEPTED_MODE = 'recent, backfill, both, seed, reobserve (csv for a subset, e.g. "both,reobserve")';

/**
 * Parse `CRAWLER_MODE` into the phases that will run.
 *
 * The var grew from ONE token into a csv naming any SUBSET, so the re-observation lane can be armed
 * beside discovery (`both,reobserve`) or run alone (`reobserve`). Every legacy value keeps its exact
 * meaning: `both`, and the unset or empty var, is recent+backfill.
 *
 * FAIL-CLOSED on a typo. An unrecognised token THROWS, naming the token and the accepted grammar,
 * because the alternative is what this var used to do: `both,reobserv` warned once into an hourly log
 * and then ran discovery-only, so the lane an operator believed they had armed simply did not exist
 * and the only other tell was a summary field nobody was reading. A CronJob that dies at config time
 * is loud, hourly, and harmless (`backoffLimit: 0`, no restart storm).
 *
 * What is NOT a typo, and must never be fatal: an ABSENT or EMPTY value (a blank or templated-away
 * env var must still run the default pass rather than fail every hour), and duplicates or whitespace,
 * which are normalised.
 *
 * `seed` stays EXCLUSIVE. Named alone it is the seed pass, unchanged; named ALONGSIDE another phase
 * it is DROPPED with a WARN rather than silently voiding the walk the operator also asked for — a
 * bounded declared poll whose whole point is a knowable cost must not be folded into an unbounded one.
 * It is a WARN and not a throw because every token there is one we recognise: the operator asked for
 * two things that cannot both happen, not for something we cannot read.
 */
export const phasesForMode = (raw: string | undefined): CrawlerPhaseName[] => {
  const tokens = csv(raw ?? '');
  const named = new Set<CrawlerPhaseName>();
  for (const token of tokens) {
    if (token === 'both') {
      named.add('recent');
      named.add('backfill');
      continue;
    }
    if (!PHASE_TOKENS.has(token)) {
      throw new Error(`CRAWLER_MODE names an unknown phase ${JSON.stringify(token)} — accepted: ${ACCEPTED_MODE}`);
    }
    named.add(token as CrawlerPhaseName);
  }
  if (named.has('seed')) {
    if (named.size === 1) return ['seed'];
    named.delete('seed');
    logger.warn('[CRAWLER] CRAWLER_MODE names `seed` alongside other phases — seed is an EXCLUSIVE pass and was dropped', { mode: raw });
  }
  const phases = PHASE_ORDER.filter((p) => named.has(p));
  // No tokens at all (unset, empty, whitespace, or only separators) is the DEFAULT, never a failure.
  return phases.length > 0 ? phases : ['recent', 'backfill'];
};

/** The phase set as ONE label for the summary and the logs: recent+backfill keeps reading `both`. */
const labelPhases = (phases: CrawlerPhaseName[]): CrawlerMode =>
  phases.length === 2 && phases[0] === 'recent' && phases[1] === 'backfill' ? 'both' : (phases.join(',') as CrawlerMode);

/** A boolean knob: `1` / `true` / `yes` / `on` (case-insensitive) is ON; anything else is OFF. */
const boolFlag = (raw: string | undefined): boolean => ['1', 'true', 'yes', 'on'].includes((raw ?? '').trim().toLowerCase());

/**
 * `argv` is read for ONE flag: `--dry-run`, the same switch as CRAWLER_REOBSERVE_DRY_RUN. A CronJob
 * operator reaches for a command-line flag when trying a store out by hand (`kubectl create job
 * --from=cronjob/ingest-crawler … -- node dist/crawler/run.js --dry-run`) and for an env var when
 * arming it in the manifest; both must reach the same knob.
 */
export function loadCrawlerConfig(env: Env = process.env, argv: string[] = process.argv): CrawlerConfig {
  // A csv var is defaulted ONLY when unset. An explicitly-set-but-empty value is
  // honored as an empty list — the operator's kill switch (zero stores → no work).
  const stores = env.CRAWLER_STORES === undefined ? [...DEFAULT_CRAWLER_STORES] : csv(env.CRAWLER_STORES);
  const phases = phasesForMode(env.CRAWLER_MODE);
  // CRAWLER_DRY_RUN (and `--dry-run`) is accepted as an ALIAS for the OPT-IN lanes' dry runs — the
  // re-observation lane and the id-range gap sweep — and warns about its scope. The DISCOVERY phases
  // have their own dry run (an enqueue cap of 0 — pages are fetched, nothing is POSTed), and a name
  // that promised a whole-pass dry run while discovery still POSTed would be the worst kind of safety
  // knob. Gating only ONE of the two opt-in lanes would be the second worst: an operator arming the
  // sweep with `--dry-run` would watch the re-observation selection print while the sweep enqueued.
  const aliasDryRun = boolFlag(env.CRAWLER_DRY_RUN);
  if (aliasDryRun) {
    logger.warn('[CRAWLER] CRAWLER_DRY_RUN gates the RE-OBSERVATION lane and the id-range GAP SWEEP — discovery still enqueues (use CRAWLER_MAX_ENQUEUE_PER_STORE=0 for that)');
  }

  const scraperServiceUrl = (env.SCRAPER_SERVICE_URL || DEFAULTS.scraperServiceUrl).replace(/\/+$/, '');
  const ledgerDir = (env.CRAWLER_LEDGER_DIR ?? '').trim() || DEFAULTS.ledgerDir;

  return {
    scraperServiceUrl,
    mode: labelPhases(phases),
    phases,
    stores,
    ledgerDir,
    recentMaxPages: posInt(env.CRAWLER_RECENT_MAX_PAGES, DEFAULTS.recentMaxPages),
    backfillPagesPerRun: posInt(env.CRAWLER_BACKFILL_PAGES_PER_RUN, DEFAULTS.backfillPagesPerRun),
    maxRequests: nonNegInt(env.CRAWLER_MAX_REQUESTS, DEFAULTS.maxRequests),
    maxEnqueuePerStore: nonNegInt(env.CRAWLER_MAX_ENQUEUE_PER_STORE, DEFAULTS.maxEnqueuePerStore),
    storeEnqueueCaps: parseStoreCaps(env.CRAWLER_STORE_ENQUEUE_CAPS, 'CRAWLER_STORE_ENQUEUE_CAPS'),
    maxConcurrency: posInt(env.CRAWLER_MAX_CONCURRENCY, DEFAULTS.maxConcurrency),
    requestSpacingMs: posInt(env.CRAWLER_REQUEST_SPACING_MS, DEFAULTS.requestSpacingMs),
    requestTimeoutMs: posInt(env.CRAWLER_REQUEST_TIMEOUT_MS, DEFAULTS.requestTimeoutMs),
    // nonNegInt, not posInt: an explicit 0 is the operator DISABLING the seed floor, and a pacing
    // knob must not fail open by reverting to its default at its most permissive setting.
    seedSpacingMs: nonNegInt(env.CRAWLER_SEED_SPACING_MS, DEFAULTS.seedSpacingMs),
    reobserveAfterMs: nonNegInt(env.CRAWLER_REOBSERVE_AFTER_MS, DEFAULTS.reobserveAfterMs),
    exhaustedRecheckMs: posInt(env.CRAWLER_EXHAUSTED_RECHECK_MS, DEFAULTS.exhaustedRecheckMs),
    rangeStores: csv(env.CRAWLER_RANGE_STORES ?? ''),
    rangeIdsPerRun: clampedPosInt(env.CRAWLER_RANGE_IDS_PER_RUN, DEFAULTS.rangeIdsPerRun, MAX_RANGE_IDS_PER_RUN, 'CRAWLER_RANGE_IDS_PER_RUN'),
    rangeFrontiers: parseFrontiers(env, stores),
    // Hours, not ms: the operator reasons about this window in hours ("re-price nothing twice in a
    // shift"), and an explicit 0 is honoured — it means "age is no bar", not "revert to 12 h".
    reobserveMinAgeMs: nonNegInt(env.CRAWLER_REOBSERVE_MIN_AGE_H, DEFAULTS.reobserveMinAgeH) * 60 * 60 * 1000,
    maxReobservePerStore: nonNegInt(env.CRAWLER_MAX_REOBSERVE_PER_STORE, DEFAULTS.maxReobservePerStore),
    storeReobserveCaps: parseStoreCaps(env.CRAWLER_STORE_REOBSERVE_CAPS, 'CRAWLER_STORE_REOBSERVE_CAPS'),
    reobserveDryRun: boolFlag(env.CRAWLER_REOBSERVE_DRY_RUN) || aliasDryRun || argv.includes('--dry-run'),
    // Hours, like the re-observe window and for the same reason: the operator reasons about this
    // cadence in hours ("once a day"), and an explicit 0 is honoured as "every run" rather than
    // reverting to a day — a cadence knob must not fail SLOW at its most eager setting.
    rangeReanchorMs: nonNegInt(env.CRAWLER_RANGE_REANCHOR_H, DEFAULTS.rangeReanchorH) * 60 * 60 * 1000,
    // nonNegInt: an explicit 0 is the bound at its tightest (refuse every move), never the default.
    rangeReanchorMaxDelta: nonNegInt(env.CRAWLER_RANGE_REANCHOR_MAX_DELTA, DEFAULTS.rangeReanchorMaxDelta),
    rangeGapBudget: nonNegInt(env.CRAWLER_RANGE_GAP_BUDGET, DEFAULTS.rangeGapBudget),
    rangeGaps: parseRangeGaps(env.CRAWLER_RANGE_GAPS),
    rangeGapDryRun: boolFlag(env.CRAWLER_RANGE_GAP_DRY_RUN) || aliasDryRun || argv.includes('--dry-run'),
  };
}
