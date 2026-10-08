/**
 * PASS-STRATEGY OBSERVABILITY (QB-U36 parts A and B; Ross MS-1 2026-10-07: assess the 2:1 lists/tap trial).
 *
 * For a store in CRAWLER_LISTS_ALTERNATE every pass yields ONE record of what its retrieval strategy did:
 * the strategy and its parameters, the company lists it read (per list: domain, outcome, ids), the ids it
 * discovered and how many were new, the challenges and cooldowns it met, how long its lists step and its
 * whole pass took, and the store host's reading of the scraper's own host clock at pass end. The crawler
 * adds the fields to the store summary, logs the record as one `[CRAWLER] pass-strategy {json}` line and
 * appends it to a ring file beside the ledgers, so the history outlives the Job's pod.
 *
 * Observability adds fields, never requests (Ross 2026-10-07: politeness over throughput): the host clock
 * is read from OUR scraper's /health/detailed, once per pass, and nothing here talks to a store.
 *
 * FIELD NAMES ARE STABLE. A rename or a change of meaning bumps PASS_STRATEGY_VERSION.
 */
import { promises as nodeFs } from 'fs';
import * as path from 'path';
import { normalizeSelectHost } from '../services/hostSelect.js';
import type { FetchLike, ListsAlternation } from './crawler.js';
import type { FsLike, Ledger } from './ledger.js';

/** The record's schema version (`strategyVersion`). */
export const PASS_STRATEGY_VERSION = 1;
/** The ring keeps the last 30 days of records... */
export const PASS_RING_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** ...and at most about 1 MB of them (oldest dropped first; the newest record is always kept). */
export const PASS_RING_MAX_BYTES = 1024 * 1024;

/** How one company list of the pass's group ended: answered, failed, or not fetched this pass. */
export type PassListStatus = 'ok' | 'failed' | 'skipped';

export interface PassListStat {
  listId: string;
  /** The domain the list id names (`company-<entryId>-d<domainId>`), null when it names none. */
  domainId: number | null;
  status: PassListStatus;
  /** Distinct ids with a url the list offered (0 unless `ok`). */
  ids: number;
}

/** The store host's entry of /health/detailed's hostClock block, as read at pass end. */
export interface PassHostClock {
  host: string;
  floorMs: number;
  clocked: boolean;
  minGapMs60m: number;
  underFloor60m: number;
  /** Sends in the trailing hour, per caller. */
  sends60m: Record<string, number>;
  /** `sends60m.catalogListing`: the trailing hour's listing (tap and backfill page) sends. */
  catalogListing: number;
  listingFetchP99Ms60m: number;
}

/** The fields a store summary gains (and the record carries) for a store in CRAWLER_LISTS_ALTERNATE. */
export interface PassStrategyFields {
  /** The pass's alternation value: `lists`, `tap`, `fallback-tap`, `outside-window` or `off`. */
  strategy: ListsAlternation;
  /** The alternation ratio (`2:1`) and this pass's 1-based step; both null outside the window or when off. */
  strategyParams: { ratio: string | null; step: number | null };
  /** The company (group) whose lists the pass read: one entry, or none. */
  listsCompanies: Array<{ entryId: string }>;
  /** The distinct domain ids of that group's lists, in declaration order. */
  listsDomains: number[];
  listsPerList: PassListStat[];
  /** Distinct ids the pass's retrieval offered: the tap's listing pages and the group's lists (with a url). */
  idsDiscovered: number;
  /** Of those, the ids neither the ledger, this run nor the lists backlog held. */
  idsNew: number;
  /** idsDiscovered - idsNew. */
  idsDup: number;
  /** Challenge pages the tap or a company list answered. */
  challenges: number;
  /** The scraper's cooldown answers to the tap or a company list (each stops the store for the pass). */
  cooldowns: number;
  /** Wall time of the store's lists step (rotate + drain); 0 when it did not run. */
  listsStepMs: number;
  /** Pass start to the end of the store's last discovery phase (the cross-store re-observe lane excluded). */
  storePassMs: number;
  /** The store host's hostClock reading at pass end; null when it could not be read or matched. */
  hostClock: PassHostClock | null;
}

/** One `[CRAWLER] pass-strategy` line, and one line of the ring file. */
export interface PassStrategyRecord extends PassStrategyFields {
  strategyVersion: typeof PASS_STRATEGY_VERSION;
  siteId: string;
  /** The pass's start instant (ISO-8601). */
  at: string;
}

/** What one ring append kept and dropped. */
export interface PassRingAppend {
  kept: number;
  droppedAged: number;
  droppedOversize: number;
  /** Lines that were not records (a torn write, garbage): dropped on rewrite. */
  droppedMalformed: number;
}

export interface PassRingStore {
  append(siteId: string, record: PassStrategyRecord): Promise<PassRingAppend | void>;
}

/** Reads the scraper's hostClock block (the `hostClock` member of /health/detailed). */
export type HostClockReader = () => Promise<unknown>;

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The domain id a list id names (`...-d<n>`), null when it names none. */
export function domainIdOf(listId: string): number | null {
  const m = /-d(\d+)$/.exec(listId);
  return m ? Number(m[1]) : null;
}

/**
 * The store's host, from the url of the first ledger entry that has a parseable one (every id of a store
 * collects from its own host). Null for an empty ledger. Iterates lazily: mfc's ledger is large.
 */
export function storeHostOf(ledger: Ledger): string | null {
  for (const id in ledger.enqueued) {
    try {
      return normalizeSelectHost(new URL(ledger.enqueued[id].collectUrl).hostname);
    } catch {
      // not a url: try the next entry
    }
  }
  return null;
}

/** The host's entry of a hostClock block, validated; null when the block, the entry or a field is unusable. */
export function pickHostClock(block: unknown, host: string | null): PassHostClock | null {
  if (!isPlainObject(block) || !Array.isArray(block.hosts)) return null;
  const v = block.hosts.find((h: unknown) => isPlainObject(h) && typeof h.host === 'string' && normalizeSelectHost(h.host) === host);
  if (!isPlainObject(v)) return null;
  const sends = v.sends60m;
  if (!isPlainObject(sends) || !Object.values(sends).every(isCount)) return null;
  const { floorMs, clocked, minGapMs60m, underFloor60m, listingFetchP99Ms60m } = v;
  if (!isCount(floorMs) || typeof clocked !== 'boolean' || !isCount(minGapMs60m) || !isCount(underFloor60m) || !isCount(listingFetchP99Ms60m)) return null;
  return {
    host: v.host as string,
    floorMs,
    clocked,
    minGapMs60m,
    underFloor60m,
    sends60m: { ...(sends as Record<string, number>) },
    catalogListing: isCount(sends.catalogListing) ? sends.catalogListing : 0,
    listingFetchP99Ms60m,
  };
}

/**
 * The production reader: ONE GET of our own scraper's /health/detailed, with an abort timeout. The block is
 * read off a degraded 500 too (the route keeps it there on purpose); a body without it reads as undefined.
 */
export function createHealthHostClockReader(scraperServiceUrl: string, fetchImpl: FetchLike, timeoutMs: number): HostClockReader {
  return async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${scraperServiceUrl}/health/detailed`, { method: 'GET', signal: controller.signal });
      const body: unknown = await res.json().catch(() => undefined);
      return isPlainObject(body) ? body.hostClock : undefined;
    } finally {
      clearTimeout(timer);
    }
  };
}

export interface FilePassRingOptions {
  fs?: FsLike;
  now?: () => number;
  maxAgeMs?: number;
  maxBytes?: number;
  pid?: number;
}

const assertSafeSiteId = (siteId: string): void => {
  if (!/^[A-Za-z0-9_-]+$/.test(siteId)) throw new Error(`refusing pass-ring access for unsafe siteId ${JSON.stringify(siteId)}`);
};

/** A ring line's instant, or undefined when the line is not a record. */
const lineInstant = (line: string): number | undefined => {
  let doc: unknown;
  try {
    doc = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isPlainObject(doc) || typeof doc.at !== 'string') return undefined;
  const ms = Date.parse(doc.at);
  return Number.isFinite(ms) ? ms : undefined;
};

/**
 * The ring file `<dir>/<siteId>.passes.ndjson`: read, drop what is older than maxAgeMs and what is not a
 * record, add the new line, drop the oldest lines while the file would exceed maxBytes (never the new one),
 * write through a tmp file and a rename. A file that cannot be READ is left exactly as found and the append
 * rejects; a missing one is created.
 */
export function createFilePassRingStore(dir: string, opts: FilePassRingOptions = {}): PassRingStore {
  const fsLike = opts.fs ?? nodeFs;
  const now = opts.now ?? Date.now;
  const maxAgeMs = opts.maxAgeMs ?? PASS_RING_MAX_AGE_MS;
  const maxBytes = opts.maxBytes ?? PASS_RING_MAX_BYTES;
  const pid = opts.pid ?? process.pid;
  return {
    async append(siteId, record) {
      assertSafeSiteId(siteId);
      const final = path.join(dir, `${siteId}.passes.ndjson`);
      let raw = '';
      try {
        raw = await fsLike.readFile(final, 'utf8');
      } catch (error) {
        if ((error as { code?: string }).code !== 'ENOENT') throw error;
      }
      const cutoff = now() - maxAgeMs;
      let droppedAged = 0;
      let droppedMalformed = 0;
      const kept: string[] = [];
      for (const line of raw.split('\n')) {
        if (line === '') continue;
        const ms = lineInstant(line);
        if (ms === undefined) droppedMalformed++;
        else if (ms < cutoff) droppedAged++;
        else kept.push(line);
      }
      kept.push(JSON.stringify(record));
      let bytes = kept.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0);
      let droppedOversize = 0;
      while (bytes > maxBytes && kept.length > 1) {
        bytes -= Buffer.byteLength(kept.shift() as string) + 1;
        droppedOversize++;
      }
      const tmp = `${final}.tmp-${pid}`;
      await fsLike.mkdir(dir, { recursive: true });
      await fsLike.writeFile(tmp, `${kept.join('\n')}\n`, 'utf8');
      await fsLike.rename(tmp, final);
      return { kept: kept.length, droppedAged, droppedOversize, droppedMalformed };
    },
  };
}
