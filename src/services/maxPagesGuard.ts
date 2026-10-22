/**
 * The ENGINE's maxPages guard (QB-U24): `SCRAPE_CATALOG_MAX_PAGES_GUARD` = off (default) | all | a csv of
 * siteIds. For a guarded store, GET /catalog?store=&page=p with p above the last page the store's profile
 * declares (`byListing.maxPages`, counted from `pageStart`) is answered by assembleCatalog with the existing
 * EXHAUSTED page — no items, hasMore false, no new field — and NO store fetch. The crawler then learns the end
 * exactly as at a real catalog end (a candidate, then the two-run confirmation), at zero store GETs.
 *
 * Why here and not in the crawler: the crawler has no rulesets profiles and no channel that carries maxPages.
 * The rulesets plugin carries `maxPages` across the injection boundary as an EXTRA property of `byListing`
 * (the contract's byListing has no such field), so it is read here as untrusted input: only a positive safe
 * integer bounds anything, and only with a `pageStart` that is absent or a non-negative safe integer. Some
 * profiles call their maxPages inert (gkloot.ts), so QB-U26 audits every listing store's maxPages against
 * the deepest page its ledger visited before naming the store here.
 *
 * The guard keeps, per store, the engine answers of the trailing hour for /health/detailed
 * (`maxPagesGuarded60m`). In memory, per process, like the host clock: one scraper replica serves /catalog.
 */

/** Env var naming the guarded stores: `off` (default) | `all` | `siteId,siteId,...`. */
export const MAX_PAGES_GUARD_ENV = 'SCRAPE_CATALOG_MAX_PAGES_GUARD';

/** The /health/detailed window. */
export const MAX_PAGES_GUARD_WINDOW_MS = 60 * 60_000;

export interface MaxPagesGuardStoreView {
  siteId: string;
  /** Pages above maxPages answered exhausted without a store fetch in the trailing hour. */
  maxPagesGuarded60m: number;
  /** When the last such answer was given (ISO-8601), null if never. */
  lastGuardedAt: string | null;
}

export interface MaxPagesGuardView {
  mode: 'off' | 'all' | 'stores';
  stores: MaxPagesGuardStoreView[];
}

/** A siteId is a plain token, as the crawler's per-store knobs require. */
const SAFE_SITE_ID = /^[A-Za-z0-9_-]+$/;

const isSafeInt = (v: unknown, min: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min;

/**
 * The last page a `byListing` declaration allows, or undefined when it declares no usable bound. Untrusted
 * input: `maxPages` must be a positive safe integer and `pageStart` absent or a non-negative safe integer.
 */
export function declaredLastPage(byListing: unknown): number | undefined {
  if (typeof byListing !== 'object' || byListing === null) return undefined;
  const { maxPages, pageStart } = byListing as { maxPages?: unknown; pageStart?: unknown };
  if (!isSafeInt(maxPages, 1)) return undefined;
  if (pageStart !== undefined && !isSafeInt(pageStart, 0)) return undefined;
  return (pageStart ?? 1) + maxPages - 1;
}

export class MaxPagesGuard {
  private readonly mode: MaxPagesGuardView['mode'];
  private readonly stores: string[] = [];
  private readonly warningLines: string[] = [];
  private readonly answers = new Map<string, number[]>();

  constructor(private readonly raw: string | undefined) {
    const keyword = (raw ?? '').trim().toLowerCase();
    if (keyword === 'all' || keyword === '' || keyword === 'off') {
      this.mode = keyword === 'all' ? 'all' : 'off';
      return;
    }
    for (const entry of (raw as string).split(',').map((part) => part.trim())) {
      if (entry === '') continue;
      if (['all', 'off'].includes(entry.toLowerCase())) {
        this.warningLines.push(`[CATALOG] WARN ${MAX_PAGES_GUARD_ENV} entry "${entry}" is a keyword, not a store, inside a store list; ignored`);
      } else if (!SAFE_SITE_ID.test(entry)) {
        this.warningLines.push(`[CATALOG] WARN ${MAX_PAGES_GUARD_ENV} entry "${entry}" is not a siteId; ignored`);
      } else if (!this.stores.includes(entry)) {
        this.stores.push(entry);
      }
    }
    this.mode = this.stores.length > 0 ? 'stores' : 'off';
  }

  /** Whether a page above this store's declared maxPages is answered by the engine. */
  covers(siteId: string): boolean {
    return this.mode === 'all' || this.stores.includes(siteId);
  }

  /** Count one engine answer for the store at `nowMs`. */
  record(siteId: string, nowMs: number): void {
    const times = this.answers.get(siteId) ?? [];
    times.push(nowMs);
    this.answers.set(siteId, times.filter((t) => nowMs - t < MAX_PAGES_GUARD_WINDOW_MS));
  }

  /** /health/detailed's block at `nowMs`: every listed store (zeros while idle) and every store answered for. */
  view(nowMs: number): MaxPagesGuardView {
    const ids = new Set([...this.stores, ...this.answers.keys()]);
    return {
      mode: this.mode,
      stores: [...ids].sort().map((siteId) => {
        const times = this.answers.get(siteId) ?? [];
        return {
          siteId,
          maxPagesGuarded60m: times.filter((t) => nowMs - t < MAX_PAGES_GUARD_WINDOW_MS).length,
          lastGuardedAt: times.length > 0 ? new Date(times[times.length - 1]).toISOString() : null,
        };
      }),
    };
  }

  /** One boot WARN line per listed entry the scope ignores. */
  warnings(): string[] {
    return [...this.warningLines];
  }

  /** One boot log line naming the scope. */
  describe(): string {
    if (this.mode === 'off') return `[CATALOG] ${MAX_PAGES_GUARD_ENV} off: every listing page is fetched from the store`;
    const scope = this.mode === 'all' ? 'all' : this.stores.join(', ');
    return `[CATALOG] ${MAX_PAGES_GUARD_ENV}=${scope}: a page above the profile's maxPages is answered exhausted without a store fetch`;
  }
}

let shared: MaxPagesGuard | undefined;

/** The process guard: scope read from `SCRAPE_CATALOG_MAX_PAGES_GUARD` once, at first use. */
export function getMaxPagesGuard(): MaxPagesGuard {
  if (!shared) shared = new MaxPagesGuard(process.env[MAX_PAGES_GUARD_ENV]);
  return shared;
}

/** Test seam: replace (or with `null`, forget) the process guard. */
export function setMaxPagesGuard(guard: MaxPagesGuard | null): void {
  shared = guard ?? undefined;
}
