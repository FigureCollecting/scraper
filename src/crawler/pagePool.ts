/**
 * QB-U24 backfill page pool — STUB (the red commit): the API the tests drive, with no behaviour yet.
 */
import type { History, Rng } from '../services/poolSelect.js';

export type VisitedMark = [from: number, to: number, at: string];

export interface LedgerPagePool {
  visited: VisitedMark[];
}

export const MAX_MARK_SPAN = 1000;

export function readVisited(_raw: unknown, _cursor: number, _nowMs: number, _ttlMs: number): { visited: Map<number, number>; malformed: boolean } {
  return { visited: new Map(), malformed: false };
}

export function lowestUnvisited(cursor: number, _visited: ReadonlyMap<number, number>): number {
  return cursor;
}

export function passPageSet(_cursor: number, _size: number, _visited: ReadonlyMap<number, number>, _endPage?: number): number[] {
  return [];
}

export function writeVisited(_visited: ReadonlyMap<number, number>, _cursor: number): LedgerPagePool {
  return { visited: [] };
}

export function nextPage(remaining: readonly number[], _history: History, _rng: Rng, _nowMs: number): number {
  return remaining[0];
}
