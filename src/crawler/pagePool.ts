/**
 * The BACKFILL PAGE POOL's pure parts (QB-U24; Ross 2026-10-04, fleet-wide: "for fetches in general,
 * where walking, we really should do a prioritized pool approach ... so our walks aren't simply
 * sequential"). The crawler's backfill phase calls these for a store named in CRAWLER_PAGE_POOL.
 *
 * STATE. `ledger.recent.pagePool = {visited: [[from, to, at], ...]}`: the pages ABOVE the backfill cursor
 * that a pass fully attempted (`at` = ISO-8601 of the visit). The cursor stays the LOWEST unvisited page,
 * so everything below it is visited by definition. With the lookahead equal to the pages per run, marks
 * arise only from a pass that was cut short (cap, budget, a stop) after it fully attempted a page above
 * the one it could not finish. A mark expires after CRAWLER_PAGE_POOL_VISITED_TTL_H: listing pages drift
 * (new items push every item down), so an old visit no longer says what the page holds; and after a drift
 * the bottom page of a visited run above an unvisited page is read again (dropExposedMarks). `recent` is
 * stored whole by every build, so an older build keeps the field untouched and walks its cursor.
 *
 * ORDER. A pass's page set is the L lowest unvisited pages at or above the cursor, none above a known or
 * candidate end. POOL-SELECT (src/services/poolSelect.ts, DEFAULT_PAGE_PARAMS) picks the next page from
 * what is left: lower page = more recent, never two adjacent pages in a row (minIdDistance 1), and no
 * strictly monotone 3-run (runStep Infinity). Picking one page at a time can paint itself into a corner
 * (6, 4 leaves {2, 3, 5}, and every one of those breaks the rule), so the candidates are first narrowed
 * to the pages from which the rest of the set can still be ordered without a break; only when no such
 * order exists does the pick fall back to POOL-SELECT's own scan and fallback. Pure: no clock, no I/O.
 */
import { DEFAULT_PAGE_PARAMS, passesAntiSequence, select, type Candidate, type History, type Rng } from '../services/poolSelect.js';

/** One visited mark: pages `from`..`to` (inclusive) fully attempted at `at` (ISO-8601). */
export type VisitedMark = [from: number, to: number, at: string];

export interface LedgerPagePool {
  visited: VisitedMark[];
}

/**
 * The widest mark accepted. A pass marks at most its own L pages, so a wider mark is not ours: reading it
 * would materialise a page per entry and could push the page set arbitrarily far from the cursor.
 */
export const MAX_MARK_SPAN = 1000;

/**
 * The largest set whose whole order is searched for (2^n states per history pair). L defaults to the
 * pages per run (5); a larger set falls back to POOL-SELECT's step-by-step guarantee.
 */
const MAX_ORDER_SEARCH = 12;

const isPositiveInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;

const isMark = (v: unknown): v is VisitedMark =>
  Array.isArray(v) &&
  v.length === 3 &&
  isPositiveInt(v[0]) &&
  isPositiveInt(v[1]) &&
  v[1] >= v[0] &&
  v[1] - v[0] < MAX_MARK_SPAN &&
  typeof v[2] === 'string';

/**
 * Read `ledger.recent.pagePool` into page -> visit time (epoch ms): the pages at or above `cursor` of every
 * mark younger than `ttlMs` at `nowMs`. Absent = nothing visited. Anything structurally wrong is ignored
 * WHOLE and flagged `malformed` (the caller warns): the pool is only a hint, so a bad one must never refuse
 * the store the way a corrupt ledger does. A mark whose time does not parse counts as expired.
 */
export function readVisited(raw: unknown, cursor: number, nowMs: number, ttlMs: number): { visited: Map<number, number>; malformed: boolean } {
  const visited = new Map<number, number>();
  if (raw === undefined) return { visited, malformed: false };
  const marks = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as { visited?: unknown }).visited : undefined;
  if (!Array.isArray(marks) || !marks.every(isMark)) return { visited: new Map(), malformed: true };
  for (const [from, to, at] of marks) {
    const atMs = Date.parse(at);
    if (!(nowMs - atMs < ttlMs)) continue;
    for (let page = Math.max(from, cursor); page <= to; page++) visited.set(page, atMs);
  }
  return { visited, malformed: false };
}

/**
 * Forget the BOTTOM page of every visited run that sits on an unvisited page (pages below `cursor` count as
 * visited). After new ids land on top, that page holds the slid-down tail of the unvisited page below it,
 * which nothing has read; the pages above it in the run only took ids from visited pages. Mutates `visited`.
 */
export function dropExposedMarks(_visited: Map<number, number>, _cursor: number): void {
  // STUB: the drift rule's failing tests come first.
}

/** The lowest page at or above `cursor` that is not visited: where the durable cursor belongs. */
export function lowestUnvisited(cursor: number, visited: ReadonlyMap<number, number>): number {
  let page = cursor;
  while (visited.has(page)) page++;
  return page;
}

/** The pass's page set: the `size` lowest unvisited pages at or above `cursor`, none above `endPage`. Ascending. */
export function passPageSet(cursor: number, size: number, visited: ReadonlyMap<number, number>, endPage?: number): number[] {
  const out: number[] = [];
  for (let page = cursor; out.length < size && (endPage === undefined || page <= endPage); page++) {
    if (!visited.has(page)) out.push(page);
  }
  return out;
}

/** The visited marks above `cursor`, adjacent pages merged into one mark that keeps its OLDEST visit time. */
export function writeVisited(visited: ReadonlyMap<number, number>, cursor: number): LedgerPagePool {
  const pages = [...visited.keys()].filter((p) => p > cursor).sort((a, b) => a - b);
  const marks: VisitedMark[] = [];
  let from = 0;
  let to = 0;
  let at = 0;
  const flush = (): void => {
    if (from > 0) marks.push([from, to, new Date(at).toISOString()]);
  };
  for (const page of pages) {
    const atMs = visited.get(page) as number;
    if (from > 0 && page === to + 1) {
      to = page;
      at = Math.min(at, atMs);
      continue;
    }
    flush();
    from = page;
    to = page;
    at = atMs;
  }
  flush();
  return { visited: marks };
}

/** Whether `pages` can still be fetched, in some order, without breaking anti-sequence after `history`. */
function canOrder(pages: readonly number[], history: History): boolean {
  const memo = new Map<string, boolean>();
  const go = (left: number, prev: number | undefined, prev2: number | undefined): boolean => {
    if (left === 0) return true;
    const key = `${left}|${prev}|${prev2}`;
    const known = memo.get(key);
    if (known !== undefined) return known;
    let ok = false;
    for (let i = 0; i < pages.length && !ok; i++) {
      const bit = 1 << i;
      if ((left & bit) !== 0 && passesAntiSequence(pages[i], { prev, prev2 }, DEFAULT_PAGE_PARAMS)) ok = go(left & ~bit, pages[i], prev);
    }
    memo.set(key, ok);
    return ok;
  };
  return go((1 << pages.length) - 1, history.prev, history.prev2);
}

const asCandidate = (page: number): Candidate => ({ key: String(page), tier: 0, recency: -page, numId: page });

/**
 * POOL-SELECT's choice of the next page to fetch from `remaining` (non-empty), given the pages this pass
 * fetched last (`history`). The candidates are the pages that pass anti-sequence AND leave a remainder that
 * can still be ordered without a break; with none (no valid order exists), every remaining page.
 */
export function nextPage(remaining: readonly number[], history: History, rng: Rng, nowMs: number): number {
  let pool: readonly number[] = remaining;
  if (remaining.length <= MAX_ORDER_SEARCH) {
    const viable = remaining.filter(
      (p) => passesAntiSequence(p, history, DEFAULT_PAGE_PARAMS) && canOrder(remaining.filter((q) => q !== p), { prev: p, prev2: history.prev }),
    );
    if (viable.length > 0) pool = viable;
  }
  const pick = select({ kind: 'explicit', candidates: pool.map(asCandidate) }, DEFAULT_PAGE_PARAMS, { rng, nowMs, history });
  return (pick as NonNullable<typeof pick>).candidate.numId as number;
}
