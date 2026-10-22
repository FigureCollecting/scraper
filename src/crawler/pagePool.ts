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
 * the bottom pages of a visited run above an unvisited page are read again, as many as the drift spans
 * (dropExposedMarks). The drift a recent read meets is added to `drift` IN THE SAME SAVE as its page, and is
 * spent by the next backfill save (which writes the marks with the drop applied and no `drift`): a pass whose
 * backfill never saves (a stop or a cap after the recent read, no backfill phase, a first pick that fails)
 * hands its drift on instead of losing it. `recent` is stored whole by every build, so an older build keeps
 * the field untouched and walks its cursor.
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

/**
 * Drift not yet applied to the marks: `ids` = the ids the recent reads met that the ledger did not hold, since
 * the last backfill save; `pageSize` = the item count of the latest recent read's page 1.
 */
export interface PendingDrift {
  ids: number;
  pageSize: number;
}

export interface LedgerPagePool {
  visited: VisitedMark[];
  drift?: PendingDrift;
}

/**
 * The widest mark accepted. A pass marks at most its own L pages, so a wider mark is not ours: reading it
 * would materialise a page per entry and could push the page set arbitrarily far from the cursor.
 */
export const MAX_MARK_SPAN = 1000;

/**
 * The largest set whose whole order is searched for (at most 7! orders per candidate, a few ms). L is the
 * pages per run (5 in production); a larger set falls back to POOL-SELECT's step-by-step guarantee.
 */
const MAX_ORDER_SEARCH = 8;

/**
 * The highest listing page the pool trusts from the ledger. The deepest listing a rulesets profile declares is
 * amiami's 5000 pages (the next deepest 2731, every other store far fewer), so this is 20 x headroom; and it keeps
 * every page well inside the safe integers, where `page++` always moves (at 2^53 it stops, and a loop over
 * such a page never ends). A pooled walk never asks for a page above it: a store that reached it would start
 * again from the top, because a cursor above it is dropped as corrupt.
 */
export const MAX_LEDGER_PAGE = 100_000;

/**
 * THE validator for every page number the pool reads from the persisted ledger (the visited marks here; the
 * backfill cursor and the end candidate in the crawler): an integer in [1, MAX_LEDGER_PAGE]. The ledger is a
 * file a crash, an older build or a hand edit can leave holding any JSON value; a value that fails this is a
 * corrupt entry, dropped by the caller with one WARN.
 */
export const isLedgerPage = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= MAX_LEDGER_PAGE;

/** A drift count (ids, page size): a safe integer >= 0, so adding to it stays exact. */
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

const isDrift = (v: unknown): v is PendingDrift =>
  typeof v === 'object' && v !== null && isCount((v as PendingDrift).ids) && isCount((v as PendingDrift).pageSize);

const isMark = (v: unknown): v is VisitedMark =>
  Array.isArray(v) &&
  v.length === 3 &&
  isLedgerPage(v[0]) &&
  isLedgerPage(v[1]) &&
  v[1] >= v[0] &&
  v[1] - v[0] < MAX_MARK_SPAN &&
  typeof v[2] === 'string';

/** The pool state if it is well formed (absent = empty), else undefined. */
const parsePool = (raw: unknown): LedgerPagePool | undefined => {
  if (raw === undefined) return { visited: [] };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const { visited, drift } = raw as { visited?: unknown; drift?: unknown };
  if (!Array.isArray(visited) || !visited.every(isMark)) return undefined;
  // A save writes disjoint marks, so a pool of ours covers at most MAX_LEDGER_PAGE pages in all. Checked
  // before any page is read: it bounds readVisited's work (and its Map) at MAX_LEDGER_PAGE pages.
  if (visited.reduce((n: number, [from, to]: VisitedMark) => n + to - from + 1, 0) > MAX_LEDGER_PAGE) return undefined;
  if (drift !== undefined && !isDrift(drift)) return undefined;
  return { visited, ...(drift ? { drift } : {}) };
};

const NO_DRIFT: PendingDrift = { ids: 0, pageSize: 0 };

/**
 * Read `ledger.recent.pagePool` into page -> visit time (epoch ms): the pages at or above `cursor` of every
 * mark younger than `ttlMs` at `nowMs`, and the drift not yet applied to them. Absent = nothing visited, no
 * drift. Anything structurally wrong (a page that fails isLedgerPage, a count that is not a safe integer, marks
 * covering more than MAX_LEDGER_PAGE pages in all) is ignored WHOLE and flagged `malformed` (the caller warns):
 * the pool is only a hint, so a bad one must not refuse the store the way a corrupt ledger does. So every page
 * returned is a ledger page, and the read sets at most MAX_LEDGER_PAGE of them. A mark whose time does not
 * parse counts as expired.
 */
export function readVisited(
  raw: unknown,
  cursor: number,
  nowMs: number,
  ttlMs: number,
): { visited: Map<number, number>; drift: PendingDrift; malformed: boolean } {
  const visited = new Map<number, number>();
  const pool = parsePool(raw);
  if (!pool) return { visited, drift: NO_DRIFT, malformed: true };
  for (const [from, to, at] of pool.visited) {
    const atMs = Date.parse(at);
    if (!(nowMs - atMs < ttlMs)) continue;
    for (let page = Math.max(from, cursor); page <= to; page++) visited.set(page, atMs);
  }
  return { visited, drift: pool.drift ?? NO_DRIFT, malformed: false };
}

/**
 * The pool state with `ids` more drift (met by a recent read page of a pass whose page 1 held `pageSize`
 * items) to apply at the next backfill save. A malformed state is returned unchanged: the backfill ignores it
 * whole, so it holds no marks to drop.
 */
export function addDrift(raw: LedgerPagePool | undefined, ids: number, pageSize: number): LedgerPagePool | undefined {
  const pool = parsePool(raw);
  if (!pool) return raw;
  return { visited: pool.visited, drift: { ids: (pool.drift?.ids ?? 0) + ids, pageSize } };
}

/**
 * Forget the bottom `depth` pages of every visited run that sits on an unvisited page (pages below `cursor`
 * count as visited). k new ids on top move every id down k places, so the unread ids of the unvisited page
 * below a run now sit up to ceil(k / page size) pages higher: on the run's bottom `depth` pages when the
 * caller passes that ceiling. A page further up the run only took ids from visited pages. A run shorter than
 * `depth` goes whole (what spills past its top lands on an unvisited page, or on a run that is itself
 * exposed). `depth` 0 forgets nothing. The drop stops at the run's top: `depth` comes from the ledger's
 * carried drift, which a corrupt ledger can make any safe integer, and every run is already in `exposed`. Each
 * step deletes a page, so the loop ends within `visited.size` steps (at most MAX_LEDGER_PAGE from readVisited).
 * Mutates `visited`.
 */
export function dropExposedMarks(visited: Map<number, number>, cursor: number, depth: number): void {
  const exposed = [...visited.keys()].filter((page) => page > cursor && !visited.has(page - 1));
  for (const bottom of exposed) {
    for (let page = bottom; page < bottom + depth && visited.has(page); page++) visited.delete(page);
  }
}

/**
 * The lowest page at or above `cursor` that is not visited: where the durable cursor belongs. The walk stops
 * past MAX_LEDGER_PAGE (a page above it is never trusted as visited), so it ends whatever the map holds.
 */
export function lowestUnvisited(cursor: number, visited: ReadonlyMap<number, number>): number {
  let page = cursor;
  while (page <= MAX_LEDGER_PAGE && visited.has(page)) page++;
  return page;
}

/**
 * The pass's page set: the `size` lowest unvisited pages at or above `cursor`, none above `endPage` and none
 * above MAX_LEDGER_PAGE. Ascending.
 */
export function passPageSet(cursor: number, size: number, visited: ReadonlyMap<number, number>, endPage?: number): number[] {
  const out: number[] = [];
  for (let page = cursor; out.length < size && page <= MAX_LEDGER_PAGE && (endPage === undefined || page <= endPage); page++) {
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
  if (pages.length === 0) return true;
  return pages.some(
    (p, i) => passesAntiSequence(p, history, DEFAULT_PAGE_PARAMS) && canOrder([...pages.slice(0, i), ...pages.slice(i + 1)], { prev: p, prev2: history.prev }),
  );
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
