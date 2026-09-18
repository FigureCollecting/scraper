/**
 * Ledger — the crawler's durable per-store state, one JSON file per store.
 *
 *   <dir>/<siteId>.json
 *   {
 *     version: 1,
 *     siteId,
 *     enqueued: { [itemId]: { at: ISO-8601, collectUrl,       // v1: enqueued-is-done, `at` = last observation
 *                             reobserveFailedAt?, reobserveFailures? } },
 *     backfill: { cursor: number|null,                          // next page to backfill
 *                 exhaustCandidateCursor?, exhaustCandidateAt?, // one empty sighting (unconfirmed)
 *                 exhaustedAt?, updatedAt? },                   // confirmed end-of-catalog
 *     recent:   { lastRunAt?, lastNewCount? },
 *     range?:   { cursor: number|null,      // next id to walk DOWNWARD; 0 = the id floor was reached
 *                 frontier?, seed?, updatedAt?,     // OPTIONAL: absent on a store that never range-walked
 *                 reanchoredAt?,                    // when the frontier was last moved up (D5)
 *                 gaps?: [{ from, to, next,         // KNOWN-GAP bands, swept ASCENDING from `next`
 *                           origin, createdAt, updatedAt?, closedAt? }] },
 *     updatedAt
 *   }
 *
 * LOAD: a missing file is a fresh ledger; unparseable JSON, a wrong version, a
 * wrong siteId, or a malformed section is 'corrupt' — the crawler refuses the
 * store and NEVER overwrites the file (an operator must inspect it).
 * SAVE: mkdir -p the dir, write `<siteId>.json.tmp-<pid>`, then rename over the
 * final name — a crash mid-write can never leave a torn ledger behind.
 */
import { promises as nodeFs } from 'fs';
import * as path from 'path';

export const LEDGER_VERSION = 1 as const;

export interface LedgerEntry {
  /** ISO-8601 instant of the last accepted enqueue (202) — the item's LAST OBSERVATION. */
  at: string;
  /**
   * The item's ABSOLUTE url at the store: its byId url where the store declares that axis, else the
   * item link the listing parser emitted (`withCollectUrl`). It is what /ingest/scrape is given, and
   * it is what the RE-OBSERVATION lane re-drives — which is why a store with no byId axis
   * (hobby-genki, bbts, gkloot, akimomo, anitoys) can be re-observed at all.
   */
  collectUrl: string;
  /**
   * RE-OBSERVE: when the last re-observation POST for this id was DETERMINISTICALLY refused (4xx from
   * /ingest/scrape — typically no ruleset matches the url). `at` is deliberately NOT advanced by a
   * refusal, because nothing was observed; this field is what keeps the id from sitting at the head
   * of the oldest-first queue every single run. Cleared by the next success.
   */
  reobserveFailedAt?: string;
  /** RE-OBSERVE: consecutive refusals since the last success. Cleared by the next success. */
  reobserveFailures?: number;
}

export interface LedgerBackfill {
  /** The next page to backfill; null until the first backfill pass initialises it. */
  cursor: number | null;
  /** Set when a page at `exhaustCandidateCursor` came back empty / hasMore:false once (unconfirmed). */
  exhaustCandidateCursor?: number;
  exhaustCandidateAt?: string;
  /** Set once TWO consecutive runs saw the same cursor empty; cleared when items reappear. */
  exhaustedAt?: string;
  updatedAt?: string;
}

/**
 * ID-RANGE backfill state for a store whose ids are sequential. `cursor` is the NEXT id to walk
 * downward (null = never walked, 0 = the walk reached id 1 and is done); `frontier` records the id
 * the walk started from. OPTIONAL on the document: a ledger written before the axis existed — or by
 * a store that never walks one — simply has no `range`, and is neither corrupt nor migrated.
 */
/** Where a known-gap band came from: the daily frontier re-anchor, or an operator's CRAWLER_RANGE_GAPS declaration. */
export type LedgerGapOrigin = 'reanchor' | 'operator';

/**
 * ONE known-gap band: a contiguous id range the DESCENT will never reach, because it sits ABOVE the
 * frontier the descent started from. Swept ASCENDING, which is why `next` is a low-water mark and not
 * the descent's high-water cursor: `next` is the lowest id in the band still to be swept, and the
 * band is exhausted (and stamped `closedAt`) once it passes `to`.
 *
 * A single id is a band of width 1 (`from === to`) — the operator's "several ids" and their "cluster
 * ranges" are the same shape, so nothing has to decide which of two representations a band is in.
 */
export interface LedgerGapBand {
  /** Lowest id in the band, inclusive. */
  from: number;
  /** Highest id in the band, inclusive. */
  to: number;
  /** The next id to sweep, ASCENDING. Equal to `from` before any sweep; `to + 1` once exhausted. */
  next: number;
  origin: LedgerGapOrigin;
  createdAt: string;
  updatedAt?: string;
  /** Set once `next` passed `to`. A closed band is kept as the RECORD that the band was filled — and it is what stops an unchanged CRAWLER_RANGE_GAPS declaration from re-opening it every run. */
  closedAt?: string;
}

export interface LedgerRange {
  cursor: number | null;
  frontier?: number;
  /**
   * The `CRAWLER_RANGE_FRONTIER_<SITEID>` value this walk was seeded (or re-seeded) with. Recorded so
   * a CHANGE to that env var is detectable: it is the operator's only lever over a walk already under
   * way — correcting a wrong seed, or re-entering an id space that has grown above the frontier.
   */
  seed?: number;
  /**
   * When the frontier was last RE-ANCHORED (D5). It is the cadence clock for
   * CRAWLER_RANGE_REANCHOR_H: absent means the re-anchor has never run, so the first pass after this
   * lane ships moves a frontier that may have been frozen for weeks.
   */
  reanchoredAt?: string;
  /**
   * KNOWN-GAP bands for this store, open and closed, in the order they were created. Closed bands are
   * retained: a band is ~150 bytes beside an `enqueued` map that holds every id the store ever
   * enqueued, so the record costs nothing measurable and answers "was that band ever filled?".
   */
  gaps?: LedgerGapBand[];
  updatedAt?: string;
}

export interface LedgerRecent {
  lastRunAt?: string;
  lastNewCount?: number;
}

export interface Ledger {
  version: typeof LEDGER_VERSION;
  siteId: string;
  enqueued: Record<string, LedgerEntry>;
  backfill: LedgerBackfill;
  recent: LedgerRecent;
  range?: LedgerRange;
  updatedAt?: string;
}

export interface LedgerStore {
  /** The store's ledger, a fresh one when none exists yet, or 'corrupt' when the persisted one is unusable. */
  load(siteId: string): Promise<Ledger | 'corrupt'>;
  /** Persist atomically. */
  save(ledger: Ledger): Promise<void>;
}

/** The fs surface the file store needs — `fs.promises` in production, a fake in tests. */
export interface FsLike {
  readFile(filePath: string, encoding: 'utf8'): Promise<string>;
  writeFile(filePath: string, data: string, encoding: 'utf8'): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  mkdir(dirPath: string, options: { recursive: true }): Promise<string | undefined>;
}

export function createEmptyLedger(siteId: string): Ledger {
  return { version: LEDGER_VERSION, siteId, enqueued: {}, backfill: { cursor: null }, recent: {} };
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const isPositiveInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;

const isNonNegInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** A well-formed band: positive ids, `from <= to`, and a `next` at or above `from` (`to + 1` = exhausted). */
const isGapBand = (v: unknown): v is LedgerGapBand => {
  if (!isPlainObject(v)) return false;
  if (!isPositiveInt(v.from) || !isPositiveInt(v.to) || !isPositiveInt(v.next)) return false;
  if (v.to < v.from || v.next < v.from || v.next > v.to + 1) return false;
  if (v.origin !== 'reanchor' && v.origin !== 'operator') return false;
  if (typeof v.createdAt !== 'string') return false;
  if (v.updatedAt !== undefined && typeof v.updatedAt !== 'string') return false;
  if (v.closedAt !== undefined && typeof v.closedAt !== 'string') return false;
  return true;
};

const isGapBandList = (v: unknown): v is LedgerGapBand[] => Array.isArray(v) && v.every(isGapBand);

/**
 * Validate a parsed document as a v1 ledger for `siteId`. Missing optional sections
 * are normalised; anything structurally wrong is 'corrupt'.
 */
function coerceLedger(doc: unknown, siteId: string): Ledger | 'corrupt' {
  if (!isPlainObject(doc)) return 'corrupt';
  if (doc.version !== LEDGER_VERSION || doc.siteId !== siteId) return 'corrupt';
  if (!isPlainObject(doc.enqueued)) return 'corrupt';
  const backfill = doc.backfill ?? { cursor: null };
  if (!isPlainObject(backfill)) return 'corrupt';
  const rawCursor: unknown = backfill.cursor ?? null;
  const cursor: number | null = isPositiveInt(rawCursor) ? rawCursor : null;
  if (rawCursor !== null && cursor === null) return 'corrupt';
  const recent = doc.recent ?? {};
  if (!isPlainObject(recent)) return 'corrupt';
  // The id-range section is OPTIONAL, but a PRESENT one must be well formed: a malformed cursor
  // would otherwise be silently reset to null and re-walk the whole id space from the frontier, and a
  // malformed frontier would reach the operator-facing summary typed as a number.
  let range: LedgerRange | undefined;
  if (doc.range !== undefined) {
    if (!isPlainObject(doc.range)) return 'corrupt';
    const rawRangeCursor: unknown = doc.range.cursor ?? null;
    if (rawRangeCursor !== null && !isNonNegInt(rawRangeCursor)) return 'corrupt';
    if (doc.range.frontier !== undefined && !isPositiveInt(doc.range.frontier)) return 'corrupt';
    if (doc.range.seed !== undefined && !isPositiveInt(doc.range.seed)) return 'corrupt';
    // A malformed re-anchor stamp would make the cadence unreadable, and `ageMs` treats an unreadable
    // timestamp as infinitely old — so a bad one would silently re-anchor on EVERY run.
    if (doc.range.reanchoredAt !== undefined && typeof doc.range.reanchoredAt !== 'string') return 'corrupt';
    // A malformed band is 'corrupt' rather than dropped: dropping it would lose a gap nobody is
    // tracking any more, and coercing it would sweep whatever the bad numbers happen to say.
    if (doc.range.gaps !== undefined && !isGapBandList(doc.range.gaps)) return 'corrupt';
    range = { ...(doc.range as unknown as LedgerRange), cursor: rawRangeCursor as number | null };
  }
  return {
    version: LEDGER_VERSION,
    siteId,
    enqueued: doc.enqueued as Record<string, LedgerEntry>,
    backfill: { ...(backfill as unknown as LedgerBackfill), cursor },
    recent: recent as LedgerRecent,
    ...(range !== undefined ? { range } : {}),
    ...(doc.updatedAt !== undefined ? { updatedAt: doc.updatedAt as string } : {}),
  };
}

/** A siteId doubles as a file stem: refuse anything that is not a plain token (no separators, no traversal). */
const assertSafeSiteId = (siteId: string): void => {
  if (!/^[A-Za-z0-9_-]+$/.test(siteId)) throw new Error(`refusing ledger access for unsafe siteId ${JSON.stringify(siteId)}`);
};

export function createFileLedgerStore(dir: string, fsLike: FsLike = nodeFs, pid: number = process.pid): LedgerStore {
  const fileFor = (siteId: string): string => path.join(dir, `${siteId}.json`);

  const load = async (siteId: string): Promise<Ledger | 'corrupt'> => {
    assertSafeSiteId(siteId);
    let raw: string;
    try {
      raw = await fsLike.readFile(fileFor(siteId), 'utf8');
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return createEmptyLedger(siteId);
      throw error;
    }
    let doc: unknown;
    try {
      doc = JSON.parse(raw);
    } catch {
      return 'corrupt';
    }
    return coerceLedger(doc, siteId);
  };

  const save = async (ledger: Ledger): Promise<void> => {
    assertSafeSiteId(ledger.siteId);
    const final = fileFor(ledger.siteId);
    const tmp = `${final}.tmp-${pid}`;
    await fsLike.mkdir(dir, { recursive: true });
    await fsLike.writeFile(tmp, JSON.stringify(ledger, null, 2), 'utf8');
    await fsLike.rename(tmp, final);
  };

  return { load, save };
}

export interface MemoryLedgerStore extends LedgerStore {
  /** The last saved ledger per siteId (deep copies). */
  files: Map<string, Ledger>;
  /** siteId of every save, in order. */
  saveLog: string[];
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** In-memory LedgerStore for tests; seed a store with a ledger or with 'corrupt'. */
export function createMemoryLedgerStore(seed: Record<string, Ledger | 'corrupt'> = {}): MemoryLedgerStore {
  const files = new Map<string, Ledger>();
  const corrupt = new Set<string>();
  for (const [siteId, v] of Object.entries(seed)) {
    if (v === 'corrupt') corrupt.add(siteId);
    else files.set(siteId, clone(v));
  }
  const saveLog: string[] = [];
  return {
    files,
    saveLog,
    load: async (siteId) => {
      if (corrupt.has(siteId)) return 'corrupt';
      const l = files.get(siteId);
      return l ? clone(l) : createEmptyLedger(siteId);
    },
    save: async (ledger) => {
      files.set(ledger.siteId, clone(ledger));
      saveLog.push(ledger.siteId);
    },
  };
}
