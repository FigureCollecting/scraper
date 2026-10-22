/**
 * POOL-SELECT v1.1 (QB-U18): which candidate to fetch next, chosen from a prioritised pool instead of
 * walking ids or pages in sequence.
 *
 * Ross (2026-10-04, fleet-wide): "for fetches in general, where walking, we really should do a
 * prioritized pool approach (favor more recently collected new IDs but still all in new id backlog
 * are eligible) so our walks aren't simply sequential". This module is that pick, and nothing else:
 * queue dispatch (QB-U19), the crawler's id-range supply (QB-U20a/b) and listing backfill page order
 * (QB-U24) will call it. It is PURE: no clock, no Math.random, no I/O, no logger, no env. The caller
 * passes the time (nowMs), a seeded rng and the history, and owns every piece of state (the history,
 * skip marks, retries).
 *
 * Seeded streams. mulberry32(seed) is the stream; deriveStream(seed, ...labels) gives one stream per
 * use: FNV-1a 32 over the UTF-8 bytes of `${seed}|${labels.join('|')}`, then mulberry32. Callers use
 * (host, 'pick'), (host, 'jitter') and (store, 'page').
 *
 * Rank order: tier ascending (0 is best), recency descending (larger = more recent), key ascending
 * (code-unit order, never locale). Keys must be unique within a pool.
 *
 * Anti-sequence (history = the last two picked numIds): a candidate with a numId is rejected when
 * |id - prev| <= minIdDistance, or when prev2 -> prev -> id keep one direction with both steps
 * <= runStep. A candidate without a numId always passes.
 *
 * select(pool, params, {rng, nowMs, history}), first rule that applies:
 * - R1 HARD AGING (hardCapMs set). A_H = candidates with nowMs - classEnteredAtMs >= hardCapMs. If
 *   A_H is non-empty, o = its oldest by (classEnteredAtMs, key). o passes anti-sequence: pick o ('R1').
 *   Else o is already marked skipped: pick o ('R1-forced'). Else return markSkip = o.key (the caller
 *   marks o) and pick the oldest of A_H that passes ('R1'), or o itself if none passes ('R1-forced').
 * - R2 SOFT AGING (ageCapMs set). A = candidates with age >= ageCapMs. If A is non-empty, with
 *   probability pAged draw uniformly from A (A in rank order), redrawing up to maxRedraws times on an
 *   anti-sequence failure ('R2'); then scan A oldest first for the first acceptable ('scan'); then
 *   scan the whole pool in rank order for the first acceptable ('scan', stage R3: not an aged pick);
 *   only when no candidate at all passes, the largest |id - prev| in A, ties to the older ('fallback').
 *   With probability 1 - pAged the pick goes on to R3.
 * - R3 RECENCY. With probability uniformFloor a uniform rank over the pool ('uniform'); otherwise a
 *   bucket b with probability proportional to bucketDecay^b among the non-empty buckets, then a
 *   uniform rank inside it ('R3'). Bucket b holds ranks [ceil(h (g^b - 1)), ceil(h (g^(b+1) - 1))),
 *   h = headSize, g = growth, the last one cut at n (so b = floor(log_g(1 + rank / h))). Up to
 *   maxRedraws redraws (each repeats the whole R3 draw), then a deterministic scan in rank order for
 *   the first acceptable ('scan', lazy for implicit pools), then the largest |id - prev|, ties to the
 *   lower rank ('fallback').
 * Empty pool: null. Candidates without classEnteredAtMs are never aged. Implicit pools (already in
 * rank order, never materialised) take no aging parameters.
 *
 * Draw order (part of the contract, so a logged seed replays): R1 draws nothing. R2 draws its pAged
 * coin first, then one draw per attempt. Each R3 attempt draws the uniform-floor coin, then either one
 * draw (uniform rank) or two (bucket, rank inside it). Scans and fallbacks draw nothing.
 *
 * Guarantees. Every R2 and R3 pick respects anti-sequence whenever some candidate in the pool passes;
 * only R1 may break it, on a 'R1-forced' pick. The R2 whole-pool scan is what makes that true for R2:
 * the brief's text went from the scan of A straight to the fallback in A, which picks an
 * unacceptable aged item even when a fresh candidate passes. STARVATION BOUND (for any rng): in a
 * class K ordered by (classEnteredAtMs, key), let x enter at a, B(a) = older items not completed at a
 * and A(a) = their remaining dispatch attempts (<= (maxRetries + 1) B(a)). If the caller applies
 * markSkip, keeps a mark across the item's retries, and clears marks only on completion, give-up or a
 * restart, then x is picked within A(a) + B(a) + 2 + r picks of K made after a + H, r = restarts in
 * that time. The tests pin it (poolSelect.starvation.test.ts).
 */

export type Rng = () => number;

// Builtins bound once: inside a vm context (jest's node environment) every global lookup (Math,
// Number, even NaN) is slow, and the simulations make millions of picks.
const { abs, ceil, floor, imul, max, min, pow } = Math;
const { isFinite: finite, isInteger: integer, NaN: NAN } = Number;

export interface Candidate {
  readonly key: string;
  /** 0 is the best tier. */
  readonly tier: number;
  /** Larger is more recent. */
  readonly recency: number;
  /** Id for anti-sequence (pages use the page number). */
  readonly numId?: number;
  /** When the candidate entered its class (aging). */
  readonly classEnteredAtMs?: number;
  /** R1 skip mark, owned by the caller. */
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

/** The last two picked numIds, owned by the caller per (host, class) or per store. */
export interface History {
  readonly prev?: number;
  readonly prev2?: number;
}

export type PickRule = 'R1' | 'R1-forced' | 'R2' | 'R3' | 'uniform' | 'scan' | 'fallback';
/** Which rule's branch made the pick ('scan' and 'fallback' occur under R2 and R3). */
export type PickStage = 'R1' | 'R2' | 'R3';

export interface Pick {
  readonly candidate: Candidate;
  /** Position of the candidate in the rank order (tier asc, recency desc, key asc). */
  readonly rank: number;
  readonly rule: PickRule;
  readonly stage: PickStage;
  /** Redraws used (maxRedraws when the pick came from a scan or fallback; 0 for R1). */
  readonly redraws: number;
  /** R1: the caller marks this candidate skipped (until it completes, gives up or the process restarts). */
  readonly markSkip?: string;
}

export interface SelectContext {
  readonly rng: Rng;
  readonly nowMs: number;
  readonly history: History;
}

/** The two parameters the anti-sequence rule reads. */
export interface AntiSequenceParams {
  readonly minIdDistance: number;
  readonly runStep: number;
}

/** Queue dispatch and crawler ids. Aging caps are set per call site. */
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

/** Backfill pages: never two adjacent pages in a row, no monotone 3-run at any step. */
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

function checkSeed(seed: number): number {
  if (!integer(seed) || seed < 0 || seed > 0xffffffff) {
    throw new RangeError(`poolSelect: seed must be an integer in [0, 2^32), got ${seed}`);
  }
  return seed;
}

/** mulberry32: a 32-bit seeded stream of numbers in [0, 1). */
export function mulberry32(seed: number): Rng {
  let a = checkSeed(seed) | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = imul(t ^ (t >>> 15), t | 1);
    t ^= t + imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const utf8 = new TextEncoder();

/** FNV-1a 32 over the UTF-8 bytes of `text`. */
export function fnv1a32(text: string): number {
  let h = 0x811c9dc5;
  for (const byte of utf8.encode(text)) {
    h = imul(h ^ byte, 0x01000193);
  }
  return h >>> 0;
}

/** One stream per use: mulberry32(FNV-1a 32 of `${seed}|label|label...`). */
export function deriveStream(seed: number, ...labels: string[]): Rng {
  return mulberry32(fnv1a32([String(checkSeed(seed)), ...labels].join('|')));
}

export function passesAntiSequence(numId: number | undefined, history: History, params: AntiSequenceParams): boolean {
  const { prev, prev2 } = history;
  if (numId === undefined || prev === undefined) return true;
  const step = numId - prev;
  if (abs(step) <= params.minIdDistance) return false;
  if (prev2 === undefined) return true;
  const lastStep = prev - prev2;
  // Same direction twice (a zero step is no direction), both steps short: a monotone run.
  return !(lastStep * step > 0 && abs(lastStep) <= params.runStep && abs(step) <= params.runStep);
}

function checkParams(p: Params): void {
  const fail = (what: string): never => {
    throw new RangeError(`poolSelect: ${what}`);
  };
  if (!(finite(p.headSize) && p.headSize > 0)) fail(`headSize must be a finite number > 0, got ${p.headSize}`);
  if (!(finite(p.growth) && p.growth > 1)) fail(`growth must be a finite number > 1, got ${p.growth}`);
  if (!(p.bucketDecay > 0 && p.bucketDecay <= 1)) fail(`bucketDecay must be in (0, 1], got ${p.bucketDecay}`);
  if (!(p.uniformFloor >= 0 && p.uniformFloor <= 1)) fail(`uniformFloor must be in [0, 1], got ${p.uniformFloor}`);
  if (!(p.pAged >= 0 && p.pAged <= 1)) fail(`pAged must be in [0, 1], got ${p.pAged}`);
  if (!(p.minIdDistance >= 0)) fail(`minIdDistance must be >= 0, got ${p.minIdDistance}`);
  if (!(p.runStep >= 0)) fail(`runStep must be >= 0, got ${p.runStep}`);
  if (!(integer(p.maxRedraws) && p.maxRedraws >= 0)) fail(`maxRedraws must be an integer >= 0, got ${p.maxRedraws}`);
  if (p.ageCapMs !== undefined && !(p.ageCapMs >= 0)) fail(`ageCapMs must be >= 0, got ${p.ageCapMs}`);
  if (p.hardCapMs !== undefined && !(p.hardCapMs >= 0)) fail(`hardCapMs must be >= 0, got ${p.hardCapMs}`);
}

function rankCmp(a: Candidate, b: Candidate): number {
  if (a.tier !== b.tier) return a.tier < b.tier ? -1 : 1;
  if (a.recency !== b.recency) return a.recency > b.recency ? -1 : 1;
  if (a.key === b.key) return 0;
  return a.key < b.key ? -1 : 1;
}

/** Strictly older by (classEnteredAtMs, key); both must carry classEnteredAtMs. */
function olderThan(a: Candidate, b: Candidate): boolean {
  const ta = a.classEnteredAtMs as number;
  const tb = b.classEnteredAtMs as number;
  return ta < tb || (ta === tb && a.key < b.key);
}

/** A draw u in [0, 1) mapped to an index in [0, len); a draw of exactly 1 stays in range. */
function indexOf(u: number, len: number): number {
  return min(len - 1, max(0, floor(u * len)));
}

interface View {
  readonly n: number;
  at(rank: number): Candidate;
}

type Ok = (c: Candidate) => boolean;

export function select(pool: Pool, params: Params, ctx: SelectContext): Pick | null {
  checkParams(params);
  if (!finite(ctx.nowMs)) throw new RangeError(`poolSelect: nowMs must be finite, got ${ctx.nowMs}`);
  const ok: Ok = (c) => passesAntiSequence(c.numId, ctx.history, params);
  if (pool.kind === 'implicit') {
    const { n, rankToCandidate } = pool;
    if (!(integer(n) && n >= 0)) throw new RangeError(`poolSelect: implicit pool size must be an integer >= 0, got ${n}`);
    if (params.ageCapMs !== undefined || params.hardCapMs !== undefined) {
      throw new RangeError('poolSelect: aging parameters (ageCapMs, hardCapMs) need an explicit pool');
    }
    return n === 0 ? null : recencyPick({ n, at: rankToCandidate }, params, ctx, ok);
  }
  return pool.candidates.length === 0 ? null : explicitPick(pool.candidates, params, ctx, ok);
}

/**
 * Age against a cap. An unset cap is NaN and an undated candidate has age NaN; NaN never compares
 * true, so neither ages anything.
 */
function ageOf(c: Candidate, nowMs: number): number {
  return nowMs - (c.classEnteredAtMs ?? NAN);
}

/** a may stand before b in the rank order (tier asc, recency desc, key asc). */
function inOrder(a: Candidate, b: Candidate): boolean {
  return a.tier < b.tier || (a.tier === b.tier && (a.recency > b.recency || (a.recency === b.recency && a.key <= b.key)));
}

/**
 * Explicit pool: use it as is when it is already in rank order (else sort a copy of the indices
 * once), find the oldest hard-aged candidate and count the soft-aged ones.
 */
function explicitPick(c: readonly Candidate[], p: Params, ctx: SelectContext, ok: Ok): Pick {
  const n = c.length;
  let i = 1;
  while (i < n && inOrder(c[i - 1], c[i])) i++;
  const order = i < n ? c.map((_, j) => j).sort((x, y) => rankCmp(c[x], c[y]) || x - y) : null;
  const view: View = { n, at: order === null ? (r) => c[r] : (r) => c[order[r]] };
  const hardCap = p.hardCapMs ?? NAN;
  const softCap = p.ageCapMs ?? NAN;
  const now = ctx.nowMs;
  let oldestHard = -1;
  let softCount = 0;
  for (let j = 0; j < n; j++) {
    const age = now - (c[j].classEnteredAtMs ?? NAN); // ageOf, inlined: this loop is the hot path
    if (age >= hardCap) {
      if (oldestHard < 0 || olderThan(c[j], c[oldestHard])) oldestHard = j;
    } else if (age >= softCap) softCount++; // only read when nothing is hard-aged
  }
  if (oldestHard >= 0) {
    const rankOf = (k: number) => (order === null ? k : order.indexOf(k));
    return hardPick(c, ctx, ok, hardCap, oldestHard, rankOf);
  }
  const soft = softCount > 0 ? softPick(view, p, ctx, ok, softCap) : null;
  return soft ?? recencyPick(view, p, ctx, ok);
}

/** R1: o is the oldest hard-aged candidate (an index into c). */
function hardPick(c: readonly Candidate[], ctx: SelectContext, ok: Ok, hardCap: number, o: number, rankOf: (i: number) => number): Pick {
  const oc = c[o];
  if (ok(oc)) return { candidate: oc, rank: rankOf(o), rule: 'R1', stage: 'R1', redraws: 0 };
  if (oc.skipped === true) return { candidate: oc, rank: rankOf(o), rule: 'R1-forced', stage: 'R1', redraws: 0 };
  let q = -1;
  for (let i = 0; i < c.length; i++) {
    const x = c[i];
    if (ageOf(x, ctx.nowMs) >= hardCap && ok(x) && (q < 0 || olderThan(x, c[q]))) q = i;
  }
  if (q < 0) return { candidate: oc, rank: rankOf(o), rule: 'R1-forced', stage: 'R1', redraws: 0, markSkip: oc.key };
  return { candidate: c[q], rank: rankOf(q), rule: 'R1', stage: 'R1', redraws: 0, markSkip: oc.key };
}

/** R2. Null when the pAged coin sends the pick on to R3. */
function softPick(view: View, p: Params, ctx: SelectContext, ok: Ok, softCap: number): Pick | null {
  if (!(ctx.rng() < p.pAged)) return null;
  const agedRanks: number[] = [];
  for (let r = 0; r < view.n; r++) if (ageOf(view.at(r), ctx.nowMs) >= softCap) agedRanks.push(r);
  for (let d = 0; d <= p.maxRedraws; d++) {
    const r = agedRanks[indexOf(ctx.rng(), agedRanks.length)];
    const c = view.at(r);
    if (ok(c)) return { candidate: c, rank: r, rule: 'R2', stage: 'R2', redraws: d };
  }
  const byAge = [...agedRanks].sort((x, y) => (olderThan(view.at(x), view.at(y)) ? -1 : olderThan(view.at(y), view.at(x)) ? 1 : x - y));
  for (const r of byAge) {
    const c = view.at(r);
    if (ok(c)) return { candidate: c, rank: r, rule: 'scan', stage: 'R2', redraws: p.maxRedraws };
  }
  // No aged item is acceptable: an R3-style scan of the whole pool in rank order (not an aged pick).
  for (let r = 0; r < view.n; r++) {
    const c = view.at(r);
    if (ok(c)) return { candidate: c, rank: r, rule: 'scan', stage: 'R3', redraws: p.maxRedraws };
  }
  // Nothing in the pool passes, so every candidate has a numId and prev is set.
  const prev = ctx.history.prev as number;
  let best = byAge[0];
  for (const r of byAge) {
    if (abs((view.at(r).numId as number) - prev) > abs((view.at(best).numId as number) - prev)) best = r;
  }
  return { candidate: view.at(best), rank: best, rule: 'fallback', stage: 'R2', redraws: p.maxRedraws };
}

interface Buckets {
  readonly lo: number[];
  readonly hi: number[];
  readonly w: number[];
  readonly total: number;
}

function bucketStart(b: number, p: Params): number {
  return ceil(p.headSize * (pow(p.growth, b) - 1));
}

/** The non-empty buckets over ranks [0, n) and their weights bucketDecay^b. */
function bucketsOf(n: number, p: Params): Buckets {
  const lo: number[] = [];
  const hi: number[] = [];
  const w: number[] = [];
  let total = 0;
  for (let b = 0; bucketStart(b, p) < n; b++) {
    const start = bucketStart(b, p);
    const end = min(bucketStart(b + 1, p), n);
    if (end > start) {
      const weight = pow(p.bucketDecay, b);
      lo.push(start);
      hi.push(end);
      w.push(weight);
      total += weight;
    }
  }
  return { lo, hi, w, total };
}

function bucketRank(bk: Buckets, rng: Rng): number {
  let x = rng() * bk.total;
  let k = 0;
  for (; k < bk.w.length - 1; k++) {
    if (x < bk.w[k]) break;
    x -= bk.w[k];
  }
  return bk.lo[k] + indexOf(rng(), bk.hi[k] - bk.lo[k]);
}

function recencyPick(view: View, p: Params, ctx: SelectContext, ok: Ok): Pick {
  const bk = bucketsOf(view.n, p);
  for (let d = 0; d <= p.maxRedraws; d++) {
    const uniform = ctx.rng() < p.uniformFloor;
    const r = uniform ? indexOf(ctx.rng(), view.n) : bucketRank(bk, ctx.rng);
    const c = view.at(r);
    if (ok(c)) return { candidate: c, rank: r, rule: uniform ? 'uniform' : 'R3', stage: 'R3', redraws: d };
  }
  // Deterministic scan in rank order; it also finds the fallback if nothing passes.
  const prev = ctx.history.prev as number;
  let best: Candidate | undefined;
  let bestRank = -1;
  let bestDist = -1;
  for (let r = 0; r < view.n; r++) {
    const c = view.at(r);
    if (ok(c)) return { candidate: c, rank: r, rule: 'scan', stage: 'R3', redraws: p.maxRedraws };
    const dist = abs((c.numId as number) - prev);
    if (dist > bestDist) {
      best = c;
      bestRank = r;
      bestDist = dist;
    }
  }
  return { candidate: best as Candidate, rank: bestRank, rule: 'fallback', stage: 'R3', redraws: p.maxRedraws };
}
