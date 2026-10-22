/**
 * Test-only bookkeeping for QB-U19's starvation-theorem and SLO runs THROUGH THE REAL QUEUE.
 *
 * It mirrors one dispatch class K (host + WARM) from the outside: when each item entered K (its enqueue
 * at WARM, or the dedup enqueue that raised it from COLD), how many attempts it has spent and whether it
 * is done (completed, or given up after its last allowed attempt). For every item x it records, at x's
 * class entry a, B(a) = the K items ordered before x by (class entry, key) and not done, and their
 * remaining attempts: A(a) as they actually happen (Areal) and the theorem's allowance (Acap,
 * maxRetries + 1 - spent). Every pooled pick the queue reports (PoolDispatch onPick) is checked:
 *   - poolSize equals the K items not done (the pool saw the whole class: resident AND parked rows);
 *   - an R1 pick without a skip mark is the oldest hard-aged K item, and an R1 skip mark names it
 *     (so a raised row is never taken by R1 ahead of an older hard-aged item, except as the one skip
 *     the theorem allows);
 *   - at x's first dispatch at or after a + H: the K-picks made in [a + H, that dispatch] are within
 *     A(a) + B(a) + 2 + r, r = restarts in that interval (Areal is used: the stronger check).
 * Written independently of src/services/poolSelect.ts and poolDispatch.ts.
 */
import type { PoolPickEvent } from '../../services/poolDispatch';

export interface ModelItem {
  key: string;
  url: string;
  /** Planned retryable failures before success; at maxRetries or more the queue gives up instead. */
  plannedFails: number;
  spent: number;
  done: boolean;
  inK: boolean;
  /** Class entry (ms), set when the item enters K. */
  a?: number;
  raised: boolean;
  rec?: Rec;
}

interface Rec {
  B: number;
  Areal: number;
  Acap: number;
  checked: boolean;
}

export interface ClassModelResult {
  picks: number;
  theoremChecked: number;
  theoremViolations: string[];
  maxRatio: number;
  maxRatioCap: number;
  poolSizeMismatches: string[];
  r1Violations: string[];
  raisedR1Picks: number;
  raisedSkipPicks: number;
  skipPicks: number;
  forcedPicks: number;
  rules: Record<string, number>;
  stages: Record<string, number>;
  restartsInWindows: number;
  waitsMs: number[];
}

/** First index whose value is >= x in an ascending array. */
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

const before = (x: { a?: number; key: string }, y: { a?: number; key: string }) =>
  (x.a as number) < (y.a as number) || ((x.a as number) === (y.a as number) && x.key < y.key);

export class ClassModel {
  readonly items = new Map<string, ModelItem>();
  private readonly pickTimes: number[] = [];
  private readonly restarts: number[] = [];
  private readonly res: ClassModelResult = {
    picks: 0,
    theoremChecked: 0,
    theoremViolations: [],
    maxRatio: 0,
    maxRatioCap: 0,
    poolSizeMismatches: [],
    r1Violations: [],
    raisedR1Picks: 0,
    raisedSkipPicks: 0,
    skipPicks: 0,
    forcedPicks: 0,
    rules: {},
    stages: {},
    restartsInWindows: 0,
    waitsMs: [],
  };

  constructor(
    private readonly classKey: string,
    private readonly hMs: number,
    private readonly maxRetries = 3,
  ) {}

  add(key: string, url: string, plannedFails: number): ModelItem {
    const item: ModelItem = { key, url, plannedFails, spent: 0, done: false, inK: false, raised: false };
    this.items.set(key, item);
    return item;
  }

  /** Attempts the queue gives this item: it succeeds after plannedFails failures, or gives up at maxRetries. */
  private totalAttempts(it: ModelItem): number {
    return Math.min(it.plannedFails + 1, this.maxRetries);
  }

  /** x enters K at t (an enqueue at WARM, or a raise). */
  enter(key: string, t: number, raised: boolean): void {
    const x = this.items.get(key) as ModelItem;
    x.inK = true;
    x.a = t;
    x.raised = raised;
    let B = 0;
    let Areal = 0;
    let Acap = 0;
    for (const y of this.items.values()) {
      if (y === x || !y.inK || y.done || !before(y, x)) continue;
      B++;
      Areal += this.totalAttempts(y) - y.spent;
      Acap += this.maxRetries + 1 - y.spent;
    }
    x.rec = { B, Areal, Acap, checked: false };
  }

  restart(t: number): void {
    this.restarts.push(t);
  }

  /** The transport saw an attempt of `key`: returns the status to answer with. */
  attempt(key: string): 200 | 500 {
    const it = this.items.get(key) as ModelItem;
    it.spent++;
    const ok = it.spent > it.plannedFails;
    if (ok || it.spent >= this.maxRetries) it.done = true;
    return ok ? 200 : 500;
  }

  pending(): ModelItem[] {
    return [...this.items.values()].filter((y) => y.inK && !y.done);
  }

  onPick(e: PoolPickEvent): void {
    if (e.classKey !== this.classKey) return;
    const res = this.res;
    const x = this.items.get(e.key) as ModelItem;
    const t = e.nowMs;
    res.picks++;
    res.rules[e.rule] = (res.rules[e.rule] ?? 0) + 1;
    res.stages[e.stage] = (res.stages[e.stage] ?? 0) + 1;
    if (e.markSkip !== undefined) res.skipPicks++;
    if (e.rule === 'R1-forced') res.forcedPicks++;
    res.waitsMs.push(t - (x.a as number));
    this.pickTimes.push(t);

    const live = this.pending();
    if (e.poolSize !== live.length && res.poolSizeMismatches.length < 5) {
      res.poolSizeMismatches.push(`t=${t} ${e.key}: poolSize ${e.poolSize}, the class holds ${live.length}`);
    }
    if (e.stage === 'R1') {
      let oldest: ModelItem | undefined;
      for (const y of live) if (t - (y.a as number) >= this.hMs && (oldest === undefined || before(y, oldest))) oldest = y;
      const expectOldest = e.markSkip ?? e.key;
      if (oldest === undefined || oldest.key !== expectOldest) {
        if (res.r1Violations.length < 5) res.r1Violations.push(`t=${t} ${e.rule} ${e.key} skip=${e.markSkip}: the oldest hard-aged is ${oldest?.key}`);
      }
      if (x.raised) {
        res.raisedR1Picks++;
        if (e.markSkip !== undefined) res.raisedSkipPicks++;
      }
    }
    const rec = x.rec as Rec;
    const from = (x.a as number) + this.hMs;
    if (!rec.checked && t >= from) {
      rec.checked = true;
      const picksAfter = this.pickTimes.length - lowerBound(this.pickTimes, from);
      const r = this.restarts.filter((s) => s >= from && s <= t).length;
      if (r > 0) res.restartsInWindows++;
      const bound = rec.Areal + rec.B + 2 + r;
      const boundCap = rec.Acap + rec.B + 2 + r;
      res.theoremChecked++;
      res.maxRatio = Math.max(res.maxRatio, picksAfter / bound);
      res.maxRatioCap = Math.max(res.maxRatioCap, picksAfter / boundCap);
      if (picksAfter > bound) res.theoremViolations.push(`${x.key}: ${picksAfter} picks after a+H > ${bound} (A=${rec.Areal} B=${rec.B} r=${r})`);
    }
  }

  result(): ClassModelResult {
    return this.res;
  }
}

/** sorted[min(n - 1, floor(p n))], as the simulations take quantiles. */
export function quantileOf(values: number[], p: number): number {
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}
