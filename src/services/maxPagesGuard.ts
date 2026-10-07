/**
 * QB-U24 engine maxPages guard — STUB (the red commit): the API the tests drive, with no behaviour yet.
 */
export const MAX_PAGES_GUARD_ENV = 'SCRAPE_CATALOG_MAX_PAGES_GUARD';
export const MAX_PAGES_GUARD_WINDOW_MS = 60 * 60_000;

export interface MaxPagesGuardStoreView {
  siteId: string;
  maxPagesGuarded60m: number;
  lastGuardedAt: string | null;
}

export interface MaxPagesGuardView {
  mode: 'off' | 'all' | 'stores';
  stores: MaxPagesGuardStoreView[];
}

export function declaredLastPage(_byListing: unknown): number | undefined {
  return undefined;
}

export class MaxPagesGuard {
  constructor(_raw: string | undefined) {}

  covers(_siteId: string): boolean {
    return false;
  }

  record(_siteId: string, _nowMs: number): void {}

  view(_nowMs: number): MaxPagesGuardView {
    return { mode: 'off', stores: [] };
  }

  warnings(): string[] {
    return [];
  }

  describe(): string {
    return '';
  }
}

let shared: MaxPagesGuard | undefined;

export function getMaxPagesGuard(): MaxPagesGuard {
  if (!shared) shared = new MaxPagesGuard(process.env[MAX_PAGES_GUARD_ENV]);
  return shared;
}

export function setMaxPagesGuard(guard: MaxPagesGuard | null): void {
  shared = guard ?? undefined;
}
