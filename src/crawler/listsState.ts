/**
 * The rotating-lists step's state, one `<dir>/<siteId>.lists.json` per store. Its OWN file: the ledger
 * loader drops sections it does not know and the seed Job also writes the ledger. Missing = fresh;
 * unreadable or malformed = 'corrupt' (never overwritten); written via tmp file + rename.
 */
import { promises as nodeFs } from 'fs';
import * as path from 'path';
import type { FsLike } from './ledger.js';

export const LISTS_STATE_VERSION = 1 as const;

/**
 * Slot spent: `ok` every list answered, `partial` some did, `failed` none did. Slot open: `transient`
 * (retried next pass), `blocked` (the store refused us; lists paused), `interrupted` (cooldown or budget).
 */
export type ListsGroupOutcome = 'ok' | 'partial' | 'failed' | 'transient' | 'blocked' | 'interrupted';

export interface ListsGroupState {
  /** The last attempt that SPENT the group's slot. Absent = never. */
  lastAttemptAt?: string;
  /** The last pass that asked any of the group's lists. */
  lastTriedAt: string;
  outcome: ListsGroupOutcome;
  /** The most recent failure's reason; cleared when a spent attempt had no failed list. */
  reason?: string;
  /** Ids the attempt's lists offered (the union within a pass, summed across the attempt's passes). */
  seen: number;
  /** Of those, the ids neither the ledger nor the backlog already held — what was queued for the drain. */
  new: number;
  /** Of those, the ids the drain has landed so far. */
  enqueued: number;
  /** Consecutive failed passes (deterministic, transient or blocked); 0 after a spent attempt with a page. */
  strikes: number;
  /** Transient passes charged to the open attempt; the slot is spent when these reach the retry ceiling. */
  retries: number;
  /** The OPEN attempt's lists that already answered — never asked again before the slot is spent. */
  answered?: Record<string, 'ok' | 'failed'>;
}

export interface ListsPendingEntry {
  itemId: string;
  collectUrl: string;
  group: string;
}

export interface ListsState {
  version: typeof LISTS_STATE_VERSION;
  siteId: string;
  groups: Record<string, ListsGroupState>;
  pending: ListsPendingEntry[];
  /** After a blocked answer no list is fetched before this instant (the backlog still drains). */
  pausedUntil?: string;
  updatedAt?: string;
}

export interface ListsStateStore {
  load(siteId: string): Promise<ListsState | 'corrupt'>;
  save(state: ListsState): Promise<void>;
}

export function createEmptyListsState(siteId: string): ListsState {
  return { version: LISTS_STATE_VERSION, siteId, groups: {}, pending: [] };
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown): boolean => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isNonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isInstant = (v: unknown): boolean => typeof v === 'string' && Number.isFinite(Date.parse(v));
const OUTCOMES = new Set<unknown>(['ok', 'partial', 'failed', 'transient', 'blocked', 'interrupted']);

const isGroupState = (v: unknown): boolean =>
  isPlainObject(v) &&
  (v.lastAttemptAt === undefined || isInstant(v.lastAttemptAt)) &&
  isInstant(v.lastTriedAt) &&
  OUTCOMES.has(v.outcome) &&
  (v.reason === undefined || typeof v.reason === 'string') &&
  [v.seen, v.new, v.enqueued, v.strikes, v.retries].every(isCount) &&
  (v.answered === undefined || (isPlainObject(v.answered) && Object.values(v.answered).every((a) => a === 'ok' || a === 'failed')));

const isPendingEntry = (v: unknown): boolean =>
  isPlainObject(v) && isNonEmpty(v.itemId) && isNonEmpty(v.collectUrl) && typeof v.group === 'string';

function coerceListsState(doc: unknown, siteId: string): ListsState | 'corrupt' {
  if (!isPlainObject(doc) || doc.version !== LISTS_STATE_VERSION || doc.siteId !== siteId) return 'corrupt';
  if (!isPlainObject(doc.groups) || !Object.values(doc.groups).every(isGroupState)) return 'corrupt';
  if (!Array.isArray(doc.pending) || !doc.pending.every(isPendingEntry)) return 'corrupt';
  if (doc.pausedUntil !== undefined && !isInstant(doc.pausedUntil)) return 'corrupt';
  if (doc.updatedAt !== undefined && typeof doc.updatedAt !== 'string') return 'corrupt';
  return doc as unknown as ListsState;
}

const assertSafeSiteId = (siteId: string): void => {
  if (!/^[A-Za-z0-9_-]+$/.test(siteId)) throw new Error(`refusing lists-state access for unsafe siteId ${JSON.stringify(siteId)}`);
};

export function createFileListsStateStore(dir: string, fsLike: FsLike = nodeFs, pid: number = process.pid): ListsStateStore {
  const fileFor = (siteId: string): string => path.join(dir, `${siteId}.lists.json`);
  return {
    async load(siteId) {
      assertSafeSiteId(siteId);
      let raw: string;
      try {
        raw = await fsLike.readFile(fileFor(siteId), 'utf8');
      } catch (error) {
        if ((error as { code?: string }).code === 'ENOENT') return createEmptyListsState(siteId);
        throw error;
      }
      try {
        return coerceListsState(JSON.parse(raw), siteId);
      } catch {
        return 'corrupt';
      }
    },
    async save(state) {
      assertSafeSiteId(state.siteId);
      const final = fileFor(state.siteId);
      const tmp = `${final}.tmp-${pid}`;
      await fsLike.mkdir(dir, { recursive: true });
      await fsLike.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
      await fsLike.rename(tmp, final);
    },
  };
}

export interface MemoryListsStateStore extends ListsStateStore {
  files: Map<string, ListsState>;
  saveLog: string[];
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** In-memory ListsStateStore for tests; seed a store with a state or with 'corrupt'. */
export function createMemoryListsStateStore(seed: Record<string, ListsState | 'corrupt'> = {}): MemoryListsStateStore {
  const files = new Map<string, ListsState>();
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
      const s = files.get(siteId);
      return s ? clone(s) : createEmptyListsState(siteId);
    },
    save: async (state) => {
      files.set(state.siteId, clone(state));
      saveLog.push(state.siteId);
    },
  };
}
