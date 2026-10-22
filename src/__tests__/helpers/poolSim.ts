/**
 * Simulation harness for the POOL-SELECT tests (QB-U18). Test-only.
 *
 * It drives select() the way its callers will (QB-U19 queue dispatch): the caller owns the history
 * (the last two picked numIds), applies markSkip, re-queues a retryable failure at once with the
 * same classEnteredAt (the skip mark survives the retry), and clears every skip mark on a restart.
 * One pick per tick while the class has an item. Ports:
 *  - v3-work/challenger-r2/sim/agingfix.py and agingsim.py (queue SLO: steady, draining, growing),
 *  - v3-work/challenger/poolsim.py (the scenario shapes),
 *  - v3-work/challenger-r3/sim/theorem_retry.py (R1 with retries and priority raises),
 *  - v3-work/challenger/antiseq.py (the anti-sequence oracle).
 * Scenario randomness comes from a local reference PRNG (refMulberry32), never from the module under
 * test, so a broken module cannot shape its own inputs. Every check here is written independently
 * of src/services/poolSelect.ts (oracle anti-sequence, reference R1, own rank comparator).
 */

import {
  DEFAULT_ID_PARAMS,
  deriveStream,
  select,
  type Candidate,
  type Params,
  type Pick,
  type Rng,
} from '../../services/poolSelect';

// Builtins bound once: global lookups inside jest's vm context are slow, and these run per pick.
const { abs, floor, imul, min } = Math;

/** Reference mulberry32 (the published one-liner), for scenario generation and as a test oracle. */
export function refMulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = imul(t ^ (t >>> 15), t | 1);
    t ^= t + imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Reference FNV-1a 32 over the UTF-8 bytes of `text`. */
export function refFnv1a32(text: string): number {
  let h = 0x811c9dc5;
  for (const byte of Buffer.from(text, 'utf8')) {
    h ^= byte;
    h = imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Anti-sequence oracle, written as antiseq.py states it (step signs), not as the module does. */
export function antiSeqOk(
  id: number | undefined,
  prev: number | undefined,
  prev2: number | undefined,
  minIdDistance: number,
  runStep: number,
): boolean {
  if (id === undefined || prev === undefined) return true;
  if (abs(id - prev) <= minIdDistance) return false;
  if (prev2 !== undefined) {
    const s1 = prev - prev2;
    const s2 = id - prev;
    const sameDirection = (s1 > 0 && s2 > 0) || (s1 < 0 && s2 < 0);
    if (sameDirection && abs(s1) <= runStep && abs(s2) <= runStep) return false;
  }
  return true;
}

/** Rank order the module must use: tier asc, recency desc, key asc (code-unit order). */
export function refRankCmp(a: Candidate, b: Candidate): number {
  if (a.tier !== b.tier) return a.tier < b.tier ? -1 : 1;
  if (a.recency !== b.recency) return a.recency > b.recency ? -1 : 1;
  if (a.key === b.key) return 0;
  return a.key < b.key ? -1 : 1;
}

/** Age order for R1/R2: classEnteredAt asc, then key asc. */
function refAgeBefore(a: SimItem, b: SimItem): boolean {
  return a.ceaTick < b.ceaTick || (a.ceaTick === b.ceaTick && a.key < b.key);
}

/**
 * Adversarial rng: steers R2 and R3 away from the oldest items. It relies on the documented draw
 * order (R1 draws nothing; R2 draws its pAged coin first when the aged set is non-empty; every R3
 * attempt draws the uniform-floor coin, then the bucket, then the rank inside it). Before each pick
 * the harness says whether the R2 coin will be drawn; the coin is then 0.999 (R2 never fires) and
 * every R3 attempt draws (0.999, 0, 0): no uniform, bucket 0, rank 0 = the NEWEST item. A pick that
 * the adversary failed to steer is counted (adversaryMisses) so the test can prove it really steered.
 */
export interface AdversarialRng {
  readonly rng: Rng;
  beginPick(r2CoinDrawn: boolean): void;
}

export function adversarialRng(): AdversarialRng {
  let i = 0;
  let offset = 0;
  return {
    rng: () => {
      const j = i - offset;
      i += 1;
      if (j < 0) return 0.999;
      return j % 3 === 0 ? 0.999 : 0;
    },
    beginPick(r2CoinDrawn: boolean) {
      i = 0;
      offset = r2CoinDrawn ? 1 : 0;
    },
  };
}

export interface SimItemSpec {
  key: string;
  /** Tick the item entered the class (its classEnteredAt). */
  ceaTick: number;
  /** R3 recency (the first enqueue time). A raised row keeps its OLD one. */
  recency: number;
  tier?: number;
  numId?: number;
  /** Retryable failures before the item completes (0..maxAttempts-1). */
  fails?: number;
  /** A priority raise: entered the class at ceaTick with an old recency. */
  raised?: boolean;
}

interface SimItem extends SimItemSpec {
  tier: number;
  classEnteredAtMs: number;
  skipped: boolean;
  failsLeft: number;
  spent: number;
  totalAttempts: number;
  rec: ItemRecord;
}

export interface ItemRecord {
  key: string;
  ceaTick: number;
  raised: boolean;
  /** Older class items not completed when the item entered. */
  B: number;
  /** Their remaining dispatches as they actually happen (failures scheduled + 1 - spent). */
  Areal: number;
  /** Their remaining dispatch ALLOWANCE, the theorem's A(a): maxAttempts - spent. */
  Acap: number;
  checked: boolean;
  picksAfter?: number;
  restarts?: number;
  bound?: number;
}

export interface ClassSimOptions {
  /** ageCapMs / hardCapMs are in ms; one tick is msPerTick ms. */
  params: Params;
  msPerTick?: number;
  items: SimItemSpec[];
  /** Ticks at which a restart clears every skip mark (before that tick's pick). */
  restarts?: number[];
  firstPickTick?: number;
  /** Last tick (inclusive). Default: run until every item is done. */
  endTick?: number;
  rng: Rng | AdversarialRng;
  /** Compare every pick against the reference R1 (O(n) per pick). */
  checkR1?: boolean;
  maxAttempts?: number;
  initialHistory?: { prev?: number; prev2?: number };
}

export interface ClassSimResult {
  picks: number;
  dispatchWaitsTicks: number[];
  ruleCounts: Record<string, number>;
  stageCounts: Record<string, number>;
  records: ItemRecord[];
  theoremChecked: number;
  theoremViolations: string[];
  maxTheoremRatio: number;
  r1Mismatches: number;
  r1MismatchSamples: string[];
  raisedAheadViolations: number;
  raisedR1Picks: number;
  raisedSkipPicks: number;
  skipPicks: number;
  adversaryMisses: number;
  /** select() returned null, or a candidate that is not the pool item at the returned rank. */
  brokenPicks: number;
  left: number;
  maxPoolSize: number;
  pickLog: Array<{ tick: number; key: string; rule: string; markSkip?: string }>;
  logPicks: boolean;
}

function lowerBound(sorted: number[], x: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function insertByRank(pool: SimItem[], item: SimItem): void {
  let lo = 0;
  let hi = pool.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (refRankCmp(pool[mid], item) <= 0) lo = mid + 1;
    else hi = mid;
  }
  pool.splice(lo, 0, item);
}

/**
 * Event simulation of ONE dispatch class K. Records, for every item x, the K-picks made at ticks
 * >= a + H up to and including x's first dispatch at or after a + H, and checks them against the
 * theorem bound A(a) + B(a) + 2 + r (A counted as realised remaining dispatches, which is <= the
 * theorem's allowance, so the check is the stronger one).
 */
export function runClassSim(opts: ClassSimOptions & { logPicks?: boolean }): ClassSimResult {
  const params = opts.params;
  const msPerTick = opts.msPerTick ?? 1;
  const maxAttempts = opts.maxAttempts ?? 4;
  const hTicks = params.hardCapMs === undefined ? Infinity : Math.ceil(params.hardCapMs / msPerTick);
  const softTicks = params.ageCapMs === undefined ? Infinity : Math.ceil(params.ageCapMs / msPerTick);
  const adversary = typeof opts.rng === 'function' ? undefined : opts.rng;
  const rng: Rng = typeof opts.rng === 'function' ? opts.rng : opts.rng.rng;
  const restarts = [...(opts.restarts ?? [])].sort((a, b) => a - b);
  const specs = [...opts.items].sort((a, b) => a.ceaTick - b.ceaTick || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const res: ClassSimResult = {
    picks: 0,
    dispatchWaitsTicks: [],
    ruleCounts: {},
    stageCounts: {},
    records: [],
    theoremChecked: 0,
    theoremViolations: [],
    maxTheoremRatio: 0,
    r1Mismatches: 0,
    r1MismatchSamples: [],
    raisedAheadViolations: 0,
    raisedR1Picks: 0,
    raisedSkipPicks: 0,
    skipPicks: 0,
    adversaryMisses: 0,
    brokenPicks: 0,
    left: 0,
    maxPoolSize: 0,
    pickLog: [],
    logPicks: opts.logPicks === true,
  };
  const pool: SimItem[] = [];
  const byKey = new Map<string, SimItem>();
  const pickTicks: number[] = [];
  let prev = opts.initialHistory?.prev;
  let prev2 = opts.initialHistory?.prev2;
  let nextSpec = 0;
  let restartIdx = 0;
  // Running sums over the pending items, for B(a) and A(a) at each arrival.
  let sumReal = 0;
  let sumCap = 0;
  const firstTick = min(0, specs.length > 0 ? specs[0].ceaTick : 0);
  const ok = (id: number | undefined) => antiSeqOk(id, prev, prev2, params.minIdDistance, params.runStep);

  for (let t = firstTick; ; t++) {
    if (opts.endTick !== undefined && t > opts.endTick) break;
    while (nextSpec < specs.length && specs[nextSpec].ceaTick <= t) {
      const s = specs[nextSpec++];
      const fails = s.fails ?? 0;
      const rec: ItemRecord = { key: s.key, ceaTick: s.ceaTick, raised: s.raised === true, B: pool.length, Areal: sumReal, Acap: sumCap, checked: false };
      const item: SimItem = {
        ...s,
        tier: s.tier ?? 0,
        classEnteredAtMs: s.ceaTick * msPerTick,
        skipped: false,
        failsLeft: fails,
        spent: 0,
        totalAttempts: fails + 1,
        rec,
      };
      res.records.push(rec);
      insertByRank(pool, item);
      byKey.set(item.key, item);
      sumReal += item.totalAttempts;
      sumCap += maxAttempts;
    }
    while (restartIdx < restarts.length && restarts[restartIdx] < t) restartIdx++;
    if (restartIdx < restarts.length && restarts[restartIdx] === t) {
      for (const it of pool) it.skipped = false;
    }
    if (nextSpec >= specs.length && pool.length === 0) break;
    if (pool.length === 0 || (opts.firstPickTick !== undefined && t < opts.firstPickTick)) continue;
    if (pool.length > res.maxPoolSize) res.maxPoolSize = pool.length;

    const nowMs = t * msPerTick;
    // Reference R1 (theorem_retry.py) and the soft-aged test, needed by the adversary and checkR1.
    let refR1: { key: string; rule: string; markSkip?: string } | undefined;
    let softNonEmpty = false;
    if (adversary !== undefined || opts.checkR1 === true) {
      let o: SimItem | undefined;
      for (const it of pool) {
        const age = t - it.ceaTick;
        if (age >= hTicks && (o === undefined || refAgeBefore(it, o))) o = it;
        if (age >= softTicks) softNonEmpty = true;
      }
      if (o !== undefined) {
        if (ok(o.numId)) refR1 = { key: o.key, rule: 'R1' };
        else if (o.skipped) refR1 = { key: o.key, rule: 'R1-forced' };
        else {
          let q: SimItem | undefined;
          for (const it of pool) {
            if (t - it.ceaTick >= hTicks && ok(it.numId) && (q === undefined || refAgeBefore(it, q))) q = it;
          }
          refR1 = q === undefined ? { key: o.key, rule: 'R1-forced', markSkip: o.key } : { key: q.key, rule: 'R1', markSkip: o.key };
        }
      }
    }
    if (adversary !== undefined) adversary.beginPick(refR1 === undefined && softNonEmpty);

    const pick: Pick | null = select({ kind: 'explicit', candidates: pool }, params, {
      rng,
      nowMs,
      history: { prev, prev2 },
    });
    const item = pick === null ? undefined : pool[pick.rank];
    if (pick === null || item === undefined || item !== pick.candidate) {
      res.brokenPicks++;
      break;
    }
    if (opts.checkR1 === true) {
      const got = { key: item.key, rule: pick.rule, markSkip: pick.markSkip };
      const r1Stage = pick.rule === 'R1' || pick.rule === 'R1-forced';
      if (refR1 === undefined ? r1Stage : got.key !== refR1.key || got.rule !== refR1.rule || got.markSkip !== refR1.markSkip) {
        res.r1Mismatches++;
        if (res.r1MismatchSamples.length < 5) res.r1MismatchSamples.push(`t=${t} want ${JSON.stringify(refR1)} got ${JSON.stringify(got)}`);
      }
    }
    if (adversary !== undefined) {
      // Steered: never R2; an R3-stage pick is the newest acceptable item.
      let steered = pick.stage !== 'R2';
      if (steered && pick.stage === 'R3') {
        const firstOk = pool.findIndex((it) => ok(it.numId));
        steered = firstOk === -1 ? pick.rule === 'fallback' : pick.rank === firstOk;
      }
      if (!steered) res.adversaryMisses++;
    }
    if (item.raised === true && pick.stage === 'R1') {
      res.raisedR1Picks++;
      if (pick.markSkip !== undefined) res.raisedSkipPicks++;
      else {
        // An R1 pick that is not a skip pick must be the oldest hard-aged item: no older item waits.
        for (const it of pool) {
          if (it !== item && t - it.ceaTick >= hTicks && refAgeBefore(it, item)) {
            res.raisedAheadViolations++;
            break;
          }
        }
      }
    }
    if (pick.markSkip !== undefined) {
      res.skipPicks++;
      const marked = byKey.get(pick.markSkip);
      if (marked !== undefined) marked.skipped = true;
    }
    res.ruleCounts[pick.rule] = (res.ruleCounts[pick.rule] ?? 0) + 1;
    res.stageCounts[pick.stage] = (res.stageCounts[pick.stage] ?? 0) + 1;
    if (res.logPicks) res.pickLog.push({ tick: t, key: item.key, rule: pick.rule, markSkip: pick.markSkip });
    res.picks++;
    pickTicks.push(t);
    res.dispatchWaitsTicks.push(t - item.ceaTick);

    const rec = item.rec;
    if (!rec.checked && t >= item.ceaTick + hTicks) {
      const from = item.ceaTick + hTicks;
      const picksAfter = pickTicks.length - lowerBound(pickTicks, from);
      const r = lowerBound(restarts, t + 1) - lowerBound(restarts, from);
      const bound = rec.Areal + rec.B + 2 + r;
      rec.checked = true;
      rec.picksAfter = picksAfter;
      rec.restarts = r;
      rec.bound = bound;
      res.theoremChecked++;
      res.maxTheoremRatio = Math.max(res.maxTheoremRatio, picksAfter / bound);
      if (picksAfter > bound) res.theoremViolations.push(`${item.key}: ${picksAfter} picks after a+H > bound ${bound} (A=${rec.Areal} B=${rec.B} r=${r})`);
    }
    item.spent++;
    sumReal--;
    sumCap--;
    prev2 = prev;
    prev = item.numId;
    if (item.failsLeft > 0) {
      item.failsLeft--; // retryable failure: re-queued at once, classEnteredAt and skip mark kept
    } else {
      pool.splice(pick.rank, 1);
      byKey.delete(item.key);
      sumCap -= maxAttempts - item.spent; // its unused allowance leaves with it
    }
  }
  // Items still waiting at the end: the picks they have seen after a + H must already fit the bound.
  for (const it of pool) {
    const rec = it.rec;
    const end = opts.endTick ?? Infinity;
    if (!rec.checked && Number.isFinite(end) && end >= it.ceaTick + hTicks) {
      const from = it.ceaTick + hTicks;
      const picksAfter = pickTicks.length - lowerBound(pickTicks, from);
      const r = lowerBound(restarts, end + 1) - lowerBound(restarts, from);
      const bound = rec.Areal + rec.B + 2 + r;
      if (picksAfter > bound) res.theoremViolations.push(`${it.key} (still waiting): ${picksAfter} > ${bound}`);
    }
  }
  res.left = pool.length;
  return res;
}

/** Quantile as the Python sims take it: sorted[min(len-1, floor(p*len))]. */
export function quantile(sorted: number[], p: number): number {
  return sorted[min(sorted.length - 1, floor(p * sorted.length))];
}

export interface QueueScenario {
  name: string;
  initialBacklog: number;
  inflowPerPick: number;
  days: number;
  picksPerHour: number;
  ageCapH: number;
  hardCapH: number;
  pAged: number;
  /** Share of dispatch ATTEMPTS that fail retryably (re-queued at once, classEnteredAt kept). */
  failRate?: number;
  /** 'tap': increasing ids, spacing 1..47 (mean ~24.5, a tap page's spacing); 'none': no numId. */
  ids: 'tap' | 'none';
  seed: number;
}

export interface QueueResult {
  name: string;
  picks: number;
  left: number;
  p50H: number;
  p90H: number;
  p99H: number;
  maxH: number;
  meanH: number;
  agedShare: number;
  r1Share: number;
  forcedPicks: number;
  skipPicks: number;
  maxPoolSize: number;
  theoremChecked: number;
  theoremViolations: number;
  maxTheoremRatio: number;
  ruleCounts: Record<string, number>;
  brokenPicks: number;
}

/**
 * agingfix.py's queue on one class: initial backlog enqueued at ticks -(n0-1)..0, inflow per pick
 * through a fractional accumulator, one pick per tick for `days` at `picksPerHour`. Time runs in
 * ticks of 1000 ms so the caps are exact (ageCap 12 h = 12 * picksPerHour ticks, as agingsim.py's
 * AGE). Waits are per dispatch from classEnteredAt; with failures a retry's wait includes its earlier
 * attempts (the conservative reading).
 */
export function runQueueScenario(s: QueueScenario): QueueResult {
  const msPerTick = 1000;
  const totalTicks = s.picksPerHour * 24 * s.days;
  const gen = refMulberry32(s.seed ^ 0x5bd1e995);
  const items: SimItemSpec[] = [];
  let seq = 0;
  let id = 1_000_000;
  const add = (tick: number) => {
    id += 1 + floor(gen() * 47);
    let fails = 0;
    const fr = s.failRate ?? 0;
    while (fails < 3 && gen() < fr) fails++;
    items.push({
      key: `q${String(seq++).padStart(8, '0')}`,
      ceaTick: tick,
      recency: tick,
      numId: s.ids === 'tap' ? id : undefined,
      fails,
    });
  };
  for (let i = s.initialBacklog - 1; i >= 0; i--) add(-i);
  let frac = 0;
  for (let t = 1; t <= totalTicks; t++) {
    frac += s.inflowPerPick;
    while (frac >= 1) {
      add(t);
      frac -= 1;
    }
  }
  const params: Params = {
    ...DEFAULT_ID_PARAMS,
    pAged: s.pAged,
    ageCapMs: s.ageCapH * s.picksPerHour * msPerTick,
    hardCapMs: s.hardCapH * s.picksPerHour * msPerTick,
  };
  const sim = runClassSim({
    params,
    msPerTick,
    items,
    firstPickTick: 1,
    endTick: totalTicks,
    rng: deriveStream(s.seed, 'queue-sim', 'pick'),
  });
  const waits = [...sim.dispatchWaitsTicks].sort((a, b) => a - b);
  const h = (ticks: number) => ticks / s.picksPerHour;
  const picks = Math.max(1, sim.picks);
  const count = (rule: string) => sim.ruleCounts[rule] ?? 0;
  return {
    name: s.name,
    picks: sim.picks,
    left: sim.left,
    p50H: waits.length > 0 ? h(quantile(waits, 0.5)) : NaN,
    p90H: waits.length > 0 ? h(quantile(waits, 0.9)) : NaN,
    p99H: waits.length > 0 ? h(quantile(waits, 0.99)) : NaN,
    maxH: waits.length > 0 ? h(waits[waits.length - 1]) : NaN,
    meanH: waits.length > 0 ? h(waits.reduce((a, b) => a + b, 0) / waits.length) : NaN,
    agedShare: (sim.stageCounts.R2 ?? 0) / picks,
    r1Share: (sim.stageCounts.R1 ?? 0) / picks,
    forcedPicks: count('R1-forced'),
    skipPicks: sim.skipPicks,
    maxPoolSize: sim.maxPoolSize,
    theoremChecked: sim.theoremChecked,
    theoremViolations: sim.theoremViolations.length,
    maxTheoremRatio: sim.maxTheoremRatio,
    ruleCounts: sim.ruleCounts,
    brokenPicks: sim.brokenPicks,
  };
}

/** One line per scenario for the PR and the report. */
export function formatQueueResult(r: QueueResult): string {
  const f = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : String(x));
  return (
    `${r.name}: picks=${r.picks} left=${r.left} wait p50=${f(r.p50H)} h p90=${f(r.p90H)} h p99=${f(r.p99H)} h ` +
    `max=${f(r.maxH)} h mean=${r.meanH.toFixed(2)} h agedShare=${r.agedShare.toFixed(3)} r1Share=${r.r1Share.toFixed(3)} ` +
    `forcedPicks=${r.forcedPicks} skipPicks=${r.skipPicks} maxPool=${r.maxPoolSize} theorem checked=${r.theoremChecked} violations=${r.theoremViolations} ` +
    `maxRatio=${r.maxTheoremRatio.toFixed(3)} rules=${JSON.stringify(r.ruleCounts)}`
  );
}
