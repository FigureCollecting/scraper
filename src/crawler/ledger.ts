/**
 * Ledger — the crawler's durable per-store state, one JSON file per store.
 *
 *   <dir>/<siteId>.json
 *   {
 *     version: 1,
 *     siteId,
 *     enqueued: { [itemId]: { at: ISO-8601, collectUrl } },   // v1: enqueued-is-done
 *     backfill: { cursor: number|null,                          // next page to backfill
 *                 exhaustCandidateCursor?, exhaustCandidateAt?, // one empty sighting (unconfirmed)
 *                 exhaustedAt?, updatedAt? },                   // confirmed end-of-catalog
 *     recent:   { lastRunAt?, lastNewCount? },
 *     range?:   { cursor: number|null,      // next id to walk DOWNWARD; 0 = the id floor was reached
 *                 frontier?, updatedAt? },  // OPTIONAL: absent on a store that never range-walked
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
  /** ISO-8601 instant of the last accepted enqueue (202). */
  at: string;
  collectUrl: string;
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
export interface LedgerRange {
  cursor: number | null;
  frontier?: number;
  /**
   * The `CRAWLER_RANGE_FRONTIER_<SITEID>` value this walk was seeded (or re-seeded) with. Recorded so
   * a CHANGE to that env var is detectable: it is the operator's only lever over a walk already under
   * way — correcting a wrong seed, or re-entering an id space that has grown above the frontier.
   */
  seed?: number;
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
