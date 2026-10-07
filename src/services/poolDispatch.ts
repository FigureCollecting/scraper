/**
 * POOL-SELECT queue dispatch (QB-U19). STUB: the red commit's API only.
 */
import type { Rng, PickRule, PickStage } from './poolSelect.js';
import type { HostScopeKind } from './hostScope.js';

export const POOL_SELECT_ENV = 'SCRAPE_POOL_SELECT';
export const POOL_AGE_CAP_ENV = 'SCRAPE_POOL_AGE_CAP_H';
export const POOL_HARD_CAP_ENV = 'SCRAPE_POOL_HARD_CAP_H';
export const DEFAULT_POOL_AGE_CAP_H = 12;
export const POOL_WINDOW_MS = 60 * 60_000;

export type PoolHostMode = 'pool' | 'fifo-excluded' | 'fifo-off';

export interface PoolCandidate {
  readonly key: string;
  readonly recencyMs: number;
  readonly classEnteredAtMs: number;
  readonly numId?: number;
  readonly retry: boolean;
}

export interface PoolPickEvent {
  readonly host: string;
  readonly classKey: string;
  readonly nowMs: number;
  readonly key: string;
  readonly rule: PickRule;
  readonly stage: PickStage;
  readonly rank: number;
  readonly redraws: number;
  readonly markSkip?: string;
  readonly poolSize: number;
  readonly waitMs: number;
  readonly retry: boolean;
}

export interface PoolHostStats {
  picks60m: number;
  topBucketShare60m: number;
  uniformPicks60m: number;
  agedPicks60m: number;
  agedShare60m: number;
  forcedPicks60m: number;
  p99WaitH60m: number;
  maxWaitH60m: number;
  redraws60m: number;
  scanFallbacks60m: number;
  retryPicks60m: number;
}

export interface PoolHostView {
  host: string;
  mode: PoolHostMode;
  picks60m: number;
  topBucketShare60m: number;
  uniformPicks60m: number;
  agedPicks60m: number;
  agedShare60m: number;
  forcedPicks60m: number;
  agedCount: number;
  p99WaitH60m: number;
  maxWaitH60m: number;
  redraws60m: number;
  scanFallbacks60m: number;
  retryPicks60m: number;
}

export interface PoolView {
  scope: HostScopeKind;
  malformed: boolean;
  hosts: PoolHostView[];
}

export interface PoolDispatchOptions {
  select?: string;
  ageCaps?: string;
  hardCaps?: string;
  seed?: number;
  rngFor?: (host: string) => Rng;
  onPick?: (event: PoolPickEvent) => void;
}

export class PoolDispatch {
  readonly seed: number;

  constructor(opts: PoolDispatchOptions = {}) {
    this.seed = opts.seed ?? 0;
  }

  modeFor(_host: string): PoolHostMode {
    return 'fifo-off';
  }

  capsFor(_host: string): { ageCapMs: number; hardCapMs: number } {
    return { ageCapMs: 0, hardCapMs: 0 };
  }

  pick(_host: string, _classKey: string, _candidates: readonly PoolCandidate[], _nowMs: number): number {
    return 0;
  }

  forget(_key: string): void {}

  forgetAll(): void {}

  hostStats(_host: string, _nowMs: number): PoolHostStats {
    return {
      picks60m: 0, topBucketShare60m: 0, uniformPicks60m: 0, agedPicks60m: 0, agedShare60m: 0, forcedPicks60m: 0,
      p99WaitH60m: 0, maxWaitH60m: 0, redraws60m: 0, scanFallbacks60m: 0, retryPicks60m: 0,
    };
  }

  hostsSeen(_nowMs: number): string[] {
    return [];
  }

  scopeView(): { scope: HostScopeKind; malformed: boolean; hosts: readonly string[] } {
    return { scope: 'off', malformed: false, hosts: [] };
  }

  warnings(): string[] {
    return [];
  }

  describe(): string {
    return '';
  }
}

let processPool: PoolDispatch | null = null;

export function getPoolDispatch(): PoolDispatch {
  if (processPool === null) processPool = new PoolDispatch();
  return processPool;
}

export function setPoolDispatch(pool: PoolDispatch | null): void {
  processPool = pool;
}

export function announcePoolDispatch(_pool: PoolDispatch, _log: Pick<Console, 'log' | 'warn'> = console): void {}
