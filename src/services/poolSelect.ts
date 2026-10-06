/**
 * POOL-SELECT v1.1 (QB-U18): STUB. The API is in place so the tests compile and fail by assertion;
 * the algorithm lands in the next commit.
 */

export type Rng = () => number;

export interface Candidate {
  readonly key: string;
  readonly tier: number;
  readonly recency: number;
  readonly numId?: number;
  readonly classEnteredAtMs?: number;
  readonly skipped?: boolean;
}

export type Pool =
  | { readonly kind: 'explicit'; readonly candidates: readonly Candidate[] }
  | { readonly kind: 'implicit'; readonly n: number; readonly rankToCandidate: (rank: number) => Candidate };

export interface Params {
  readonly headSize: number;
  readonly growth: number;
  readonly bucketDecay: number;
  readonly uniformFloor: number;
  readonly minIdDistance: number;
  readonly runStep: number;
  readonly maxRedraws: number;
  readonly pAged: number;
  readonly ageCapMs?: number;
  readonly hardCapMs?: number;
}

export interface History {
  readonly prev?: number;
  readonly prev2?: number;
}

export type PickRule = 'R1' | 'R1-forced' | 'R2' | 'R3' | 'uniform' | 'scan' | 'fallback';
export type PickStage = 'R1' | 'R2' | 'R3';

export interface Pick {
  readonly candidate: Candidate;
  readonly rank: number;
  readonly rule: PickRule;
  readonly stage: PickStage;
  readonly redraws: number;
  readonly markSkip?: string;
}

export interface SelectContext {
  readonly rng: Rng;
  readonly nowMs: number;
  readonly history: History;
}

export const DEFAULT_ID_PARAMS: Readonly<Params> = Object.freeze({
  headSize: 25,
  growth: 2,
  bucketDecay: 0.5,
  uniformFloor: 0.1,
  minIdDistance: 3,
  runStep: 50,
  maxRedraws: 8,
  pAged: 0.9,
});

export const DEFAULT_PAGE_PARAMS: Readonly<Params> = Object.freeze({
  headSize: 2,
  growth: 2,
  bucketDecay: 0.5,
  uniformFloor: 0.1,
  minIdDistance: 1,
  runStep: Infinity,
  maxRedraws: 8,
  pAged: 0,
});

export function mulberry32(_seed: number): Rng {
  return () => 0;
}

export function fnv1a32(_text: string): number {
  return 0;
}

export function deriveStream(_seed: number, ..._labels: string[]): Rng {
  return () => 0;
}

/** The two parameters the anti-sequence rule reads. */
export interface AntiSequenceParams {
  readonly minIdDistance: number;
  readonly runStep: number;
}

export function passesAntiSequence(
  _numId: number | undefined,
  _history: History,
  _params: AntiSequenceParams,
): boolean {
  return false;
}

export function select(_pool: Pool, _params: Params, _ctx: SelectContext): Pick | null {
  return null;
}
