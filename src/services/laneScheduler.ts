/**
 * Lane scheduler: shares ONE host's dispatch slot between work classes by weight (QB-U2).
 *
 * Ross (2026-09-29) wants MFC work split between classes: new ids, company lists and gap fill,
 * 40 / 40 / 20. The host has one pacing floor and one serial dispatcher, so the classes cannot run
 * as separate pipelines. Instead, when the host's floor opens, this scheduler picks WHICH class's
 * item takes the slot. It never decides WHEN: the pacing floor stays the only clock, so no weight,
 * however malformed, can make a host's dispatch faster. This module is pure (no I/O, no clock, no
 * randomness); the queue wiring is a later unit.
 *
 * Algorithm: stride scheduling (weighted fair queueing).
 * - Each class has a stride inversely proportional to its weight and a pass value. A pick takes the
 *   class with work that has the lowest pass (ties go to the fixed order new, company, gap, other);
 *   a CHARGE advances that class's pass by its stride. Picking and charging are separate calls so a
 *   pick that cost no network request (a cooldown fast-fail) can go uncharged.
 * - Work-conserving: only classes with work compete, so an empty class's share goes to the others
 *   in proportion to their weights, and the slot never idles while any class has work.
 * - No saved-up burst: a class that comes back after being empty has its pass raised to the
 *   host's current virtual time, the weight-averaged pass of the classes that kept their work
 *   (rounded up to a whole unit, see `scaledSpan`). It re-enters level with them instead of
 *   spending the credit it "earned" while it had nothing to send: counted from its return, in the
 *   first n picks it gets at most its weight's share of n plus one, for every n. That bounds windows
 *   that START at the return; a window starting later can read up to about 3 picks over share + 1,
 *   as plain stride scheduling does even when no class ever empties. (Raising it only to the
 *   MINIMUM pass, the first design, is not enough: the minimum sits below the others' average, and
 *   a returning class then overshot share + 1 by up to about one more pick in 1,111 of 7,880
 *   simulated returns. The weighted average never did.)
 * - The price of that rule, and a contract for the caller: the average is never below the lowest
 *   pass, so a class reported empty for single picks while it still has work loses its place each
 *   time it comes back. Reported empty on every other pick it can get no service at all (company,
 *   gap and other get none at 40/40/20/10), and at some weights 1 pick in 3 does the same (1/1/1/1;
 *   even new at 100/1/1/1). So `withWork` must name every class that has a queued item (resident
 *   or parked), never leave one out for a transient state such as a paused session. A class that
 *   really was empty is not affected: once it has work it keeps it until it is served, and its pass
 *   stays put while the others' advance.
 * - Weight 0 is a filler: served only when every positive-weight class is empty. Several weight-0
 *   classes with work share the slot evenly between themselves.
 * - Exact and bounded: strides are whole numbers (the span, a multiple of the least common
 *   multiple of the positive weights, divided by each weight), and after every step the passes are
 *   shifted so the lowest active pass is 0. Every stride is at most 2^20. When every charge goes to
 *   the class just picked, no pass exceeds the largest stride; a charge to another class (shadow
 *   mode) adds at most one stride of debt, so even then the weighted sums stay exact integers below
 *   2^53 for over 20 million charges. Every comparison is between whole numbers, so the same pick
 *   sequence always gives the same picks.
 *
 * Share measurement (the review's note on 'other'): the fourth class 'other' (unlabeled work such as
 * the spine retry job's re-drives) is not part of Ross's split. While it has work, weights
 * 40/40/20/10 give 36.4/36.4/18.2/9.1, so a reading taken over all picks mixes two bases. Every
 * charge is therefore tallied twice: over all picks, and over the picks made while 'other' had no
 * work. `shares('ross-three')` reads new/company/gap from the second tally only, which is the basis
 * Ross's 40/40/20 is stated on; `shares('all')` reads all four classes from every pick.
 * `targetLaneShares` gives the matching expected share for a given set of classes with work.
 */

import { logger } from '../utils/logger.js';

/** The fixed class vocabulary, in tie-break order. */
export const LANE_CLASSES = ['new', 'company', 'gap', 'other'] as const;
export type LaneClass = (typeof LANE_CLASSES)[number];

/** Ross's three classes: the basis his 40/40/20 split is stated on. 'other' is not part of it. */
export const ROSS_LANE_CLASSES = ['new', 'company', 'gap'] as const satisfies readonly LaneClass[];

export type LaneWeights = Readonly<Record<LaneClass, number>>;
export type LaneMode = 'off' | 'shadow' | 'on';

/** Which picks and classes a share reading is taken over. */
export type LaneShareBasis = 'all' | 'ross-three';

export const LANE_MODE_ENV = 'SCRAPE_LANE_MODE';
export const LANE_WEIGHTS_ENV = 'SCRAPE_LANE_WEIGHTS';

/** Weights are relative, so whole numbers 0-100 express any split; the cap keeps strides exact. */
export const MAX_LANE_WEIGHT = 100;

const LANE_MODES: readonly LaneMode[] = ['off', 'shadow', 'on'];

const isLaneClass = (value: string): value is LaneClass => (LANE_CLASSES as readonly string[]).includes(value);

/**
 * The class a lane label names. Anything outside the vocabulary (no label, or one this build does
 * not know) is 'other', the class for unlabeled work: an unknown label must never make an item's
 * work invisible to the scheduler.
 */
export const laneClassOf = (label: string | null | undefined): LaneClass =>
  typeof label === 'string' && isLaneClass(label) ? label : 'other';

const zeroCounts = (): Record<LaneClass, number> => ({ new: 0, company: 0, gap: 0, other: 0 });

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/** The span is scaled up to about this many units (between 2^19 and 2^20 unless the multiple is larger). */
const SPAN_UNITS = 2 ** 20;

/**
 * The span for a tier whose weights have least common multiple `lcm`: a multiple of it, so every
 * stride stays a whole number, scaled up to about 2^20 units. The virtual time is rounded up to a
 * whole unit, and at the bare multiple a unit can be a whole stride (40/40/20/10 has span 40 and
 * strides 1/1/2/4): a class reported empty on 1 pick in 3 then lost all its service to the rounding.
 * Scaled, a unit is under 1/5,000 of any stride. The span stays below 2^27 (the multiple of four
 * weights of at most 100), and span / weight is at most 2^20.
 */
const scaledSpan = (lcm: number): number => lcm * Math.max(1, Math.floor(SPAN_UNITS / lcm));

// ---------------------------------------------------------------------------------------------
// the scheduler
// ---------------------------------------------------------------------------------------------

/**
 * Stride scheduling over one tier of classes. The positive-weight classes form one tier; the
 * weight-0 fillers form another, with equal weights among themselves.
 */
class StrideTier {
  private readonly pass = new Map<LaneClass, number>();
  private active: LaneClass[] = [];

  /** `weights` are positive; each member's stride is `span / weight`, a whole number. */
  constructor(
    private readonly members: readonly LaneClass[],
    private readonly weights: ReadonlyMap<LaneClass, number>,
    private readonly span: number,
  ) {
    for (const c of members) this.pass.set(c, 0);
  }

  private passOf(c: LaneClass): number {
    return this.pass.get(c) as number;
  }

  private weightOf(c: LaneClass): number {
    return this.weights.get(c) as number;
  }

  /**
   * Record which members have work now. A member coming back from empty re-enters at the tier's
   * virtual time: the weight-averaged pass of the members that kept their work, rounded up to a
   * whole unit (the passes are whole numbers). It keeps its own pass if that is higher (a debt is
   * not forgiven).
   */
  observe(withWork: ReadonlySet<LaneClass>): void {
    const was = new Set(this.active);
    const now = this.members.filter((c) => withWork.has(c));
    const staying = now.filter((c) => was.has(c));
    if (staying.length > 0) {
      const weight = staying.reduce((acc, c) => acc + this.weightOf(c), 0);
      const weighted = staying.reduce((acc, c) => acc + this.weightOf(c) * this.passOf(c), 0);
      const virtualTime = Math.ceil(weighted / weight);
      for (const c of now) if (!was.has(c)) this.pass.set(c, Math.max(this.passOf(c), virtualTime));
    }
    this.active = now;
    this.normalize();
  }

  /** The member with work and the lowest pass; ties go to member order. */
  pick(): LaneClass | undefined {
    let best: LaneClass | undefined;
    for (const c of this.active) if (best === undefined || this.passOf(c) < this.passOf(best)) best = c;
    return best;
  }

  charge(c: LaneClass): void {
    this.pass.set(c, this.passOf(c) + this.span / this.weightOf(c));
    this.normalize();
  }

  /**
   * Shift every pass so the lowest active pass is 0 (every comparison is preserved), and lift any
   * idle member below that to 0. A member returning while others kept their work is raised to at
   * least the virtual time anyway, so the lift changes no pick then; when every member was empty
   * and several return together, it applies the same no-burst rule to them.
   */
  private normalize(): void {
    if (this.active.length === 0) return;
    const min = Math.min(...this.active.map((c) => this.passOf(c)));
    for (const c of this.members) this.pass.set(c, Math.max(this.passOf(c) - min, 0));
  }
}

/** Per-class charge counts: over every charge, and over the charges made while 'other' had no work. */
export interface LaneTally {
  all: Record<LaneClass, number>;
  whileOtherIdle: Record<LaneClass, number>;
}

/** What one charge was: its class, and whether 'other' had no work at the time (for bucketing). */
export interface LaneCharge {
  cls: LaneClass;
  otherIdle: boolean;
}

export class LaneScheduler {
  private readonly positive: StrideTier;
  private readonly filler: StrideTier;
  private readonly tierOf: ReadonlyMap<LaneClass, StrideTier>;
  private otherHasWork = false;
  private readonly counts: LaneTally = { all: zeroCounts(), whileOtherIdle: zeroCounts() };

  constructor(weights: LaneWeights) {
    for (const c of LANE_CLASSES) {
      const w = weights[c];
      if (!Number.isInteger(w) || w < 0 || w > MAX_LANE_WEIGHT) {
        throw new RangeError(`lane weight for ${c} must be a whole number 0-${MAX_LANE_WEIGHT}, got ${String(w)}`);
      }
    }
    const positive = LANE_CLASSES.filter((c) => weights[c] > 0);
    if (positive.length === 0) throw new RangeError('at least one lane weight must be positive');
    const zero = LANE_CLASSES.filter((c) => weights[c] === 0);

    const lcm = positive.reduce((acc, c) => (acc * weights[c]) / gcd(acc, weights[c]), 1);
    this.positive = new StrideTier(positive, new Map(positive.map((c) => [c, weights[c]])), scaledSpan(lcm));
    // the fillers share their slot evenly: equal weights among themselves
    this.filler = new StrideTier(zero, new Map(zero.map((c) => [c, 1])), scaledSpan(1));
    this.tierOf = new Map(LANE_CLASSES.map((c) => [c, weights[c] > 0 ? this.positive : this.filler]));
  }

  /**
   * The class that should take the host's next slot, given which classes have work; undefined only
   * when none has. Charges nothing: call `charge` once the dispatch actually costs a request.
   * `withWork` must name every class that has a queued item, resident or parked; leaving a class
   * out for a transient state costs it its place (see the module note). A name outside the
   * vocabulary counts as 'other' (see `laneClassOf`).
   */
  pick(withWork: Iterable<LaneClass>): LaneClass | undefined {
    const set = new Set<LaneClass>();
    for (const c of withWork) set.add(laneClassOf(c));
    this.positive.observe(set);
    this.filler.observe(set);
    this.otherHasWork = set.has('other');
    return this.positive.pick() ?? this.filler.pick();
  }

  /**
   * Charge one dispatch (one network attempt) to `label`'s class, whether or not the last pick
   * chose it; a name outside the vocabulary is charged to 'other'. Whether 'other' had work comes
   * from the most recent `pick`, so call `pick` with the current classes before each charge
   * (before any pick, 'other' counts as idle). A charge to 'other' itself always means it had work.
   */
  charge(label: LaneClass): LaneCharge {
    const cls = laneClassOf(label);
    (this.tierOf.get(cls) as StrideTier).charge(cls);
    const otherIdle = cls !== 'other' && !this.otherHasWork;
    this.counts.all[cls]++;
    if (otherIdle) this.counts.whileOtherIdle[cls]++;
    return { cls, otherIdle };
  }

  /** A copy of the charge counts since construction. */
  tally(): LaneTally {
    return { all: { ...this.counts.all }, whileOtherIdle: { ...this.counts.whileOtherIdle } };
  }

  /** Realized shares since construction on the given basis (see the module note). */
  shares(basis: LaneShareBasis = 'all'): Partial<Record<LaneClass, number>> {
    return laneShares(this.counts, basis);
  }
}

const basisClasses = (basis: LaneShareBasis): readonly LaneClass[] =>
  basis === 'all' ? LANE_CLASSES : ROSS_LANE_CLASSES;

/**
 * Shares from a tally. `all`: every charge, all four classes. `ross-three`: only the charges made
 * while 'other' had no work, over new/company/gap. An empty tally reads as zeros, never NaN.
 */
export function laneShares(tally: LaneTally, basis: LaneShareBasis): Partial<Record<LaneClass, number>> {
  const classes = basisClasses(basis);
  const counts = basis === 'all' ? tally.all : tally.whileOtherIdle;
  const total = classes.reduce((acc, c) => acc + counts[c], 0);
  const out: Partial<Record<LaneClass, number>> = {};
  for (const c of classes) out[c] = total === 0 ? 0 : counts[c] / total;
  return out;
}

/**
 * The share each class should get when `withWork` are the classes that have work: weight over the
 * sum of the positive weights with work; if only weight-0 classes have work, they split evenly.
 * Classes without work (and weight-0 classes beside a positive one) get 0. A name outside the
 * vocabulary counts as 'other', as in `pick`.
 */
export function targetLaneShares(
  weights: LaneWeights,
  withWork: Iterable<LaneClass>,
  basis: LaneShareBasis,
): Partial<Record<LaneClass, number>> {
  const classes = basisClasses(basis);
  const busy = new Set<LaneClass>();
  for (const c of withWork) busy.add(laneClassOf(c));
  const competing = classes.filter((c) => busy.has(c));
  const positive = competing.filter((c) => weights[c] > 0);
  const total = positive.reduce((acc, c) => acc + weights[c], 0);
  const out: Partial<Record<LaneClass, number>> = {};
  for (const c of classes) {
    if (!busy.has(c)) out[c] = 0;
    else if (positive.length > 0) out[c] = weights[c] / total;
    else out[c] = 1 / competing.length;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// env parsing
// ---------------------------------------------------------------------------------------------

type Env = Readonly<Record<string, string | undefined>>;

/**
 * `SCRAPE_LANE_MODE`: off (default: dispatch exactly as today), shadow (compute and count the
 * pick, dispatch as today), on. Unset or blank is off; anything else is refused with a WARN and is
 * off, the one mode that changes nothing.
 */
export function parseLaneMode(raw: string | undefined): LaneMode {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '') return 'off';
  if ((LANE_MODES as readonly string[]).includes(value)) return value as LaneMode;
  logger.warn(`[SCRAPE LANES] ${LANE_MODE_ENV} value ignored (expected off|shadow|on); lanes stay off`, {
    value: raw,
  });
  return 'off';
}

/** The queue's host key: lowercased, `www.`-stripped (same normalization as the dispatcher). */
export const normalizeLaneHost = (host: string): string => host.trim().toLowerCase().replace(/^www\./, '');

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const SAFE_HOST = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`);

/** A class:weight list, all or nothing: the weights, or why the list is refused. */
function parseClassWeights(spec: string): LaneWeights | string {
  const weights = zeroCounts();
  const seen = new Set<LaneClass>();
  for (const part of spec.split(',')) {
    const pair = part.trim();
    if (pair === '') continue;
    const at = pair.indexOf(':');
    if (at === -1) return `"${pair}" has no weight (expected class:weight)`;
    const cls = pair.slice(0, at).trim().toLowerCase();
    const raw = pair.slice(at + 1).trim();
    if (!isLaneClass(cls)) return `unknown class "${cls}" (expected ${LANE_CLASSES.join('|')})`;
    if (seen.has(cls)) return `class "${cls}" is named twice`;
    if (!/^\d+$/.test(raw) || Number(raw) > MAX_LANE_WEIGHT) {
      return `weight for ${cls} must be a whole number 0-${MAX_LANE_WEIGHT}`;
    }
    seen.add(cls);
    weights[cls] = Number(raw);
  }
  if (LANE_CLASSES.every((c) => weights[c] === 0)) return 'no class has a positive weight';
  return Object.freeze(weights);
}

/**
 * `SCRAPE_LANE_WEIGHTS`: per host, hosts separated by ';', e.g.
 * `myfigurecollection.net=new:40,company:40,gap:20,other:10`. A class left out gets weight 0.
 *
 * Fail-safe: a host entry is taken whole or not at all. A malformed one (no '=', a bad host, an
 * unknown or repeated class, a weight that is not a whole number 0-100, no positive weight) is
 * DROPPED with a WARN naming it, so that host stays unlaned and dispatches exactly as today; the
 * other hosts' entries still apply. A host named twice keeps its last entry, with a WARN.
 */
export function parseLaneWeights(raw: string | undefined): ReadonlyMap<string, LaneWeights> {
  const out = new Map<string, LaneWeights>();
  for (const segment of (raw ?? '').split(';')) {
    const entry = segment.trim();
    if (entry === '') continue;
    const eq = entry.indexOf('=');
    const host = eq === -1 ? '' : normalizeLaneHost(entry.slice(0, eq));
    const parsed = eq === -1 ? 'expected host=class:weight,...' : SAFE_HOST.test(host) ? parseClassWeights(entry.slice(eq + 1)) : 'not a host name';
    if (typeof parsed === 'string') {
      logger.warn(`[SCRAPE LANES] ${LANE_WEIGHTS_ENV} entry ignored; that host keeps today's dispatch`, {
        entry,
        reason: parsed,
      });
      continue;
    }
    if (out.has(host)) {
      logger.warn(`[SCRAPE LANES] ${LANE_WEIGHTS_ENV} names a host twice; the last entry wins`, { host });
    }
    out.set(host, parsed);
  }
  return out;
}

export interface LaneConfig {
  mode: LaneMode;
  /** Every well-formed host entry, whatever the mode. */
  hosts: ReadonlyMap<string, LaneWeights>;
}

/** Read `SCRAPE_LANE_MODE` and `SCRAPE_LANE_WEIGHTS` (from `process.env` unless given). */
export function resolveLaneConfig(env: Env = process.env): LaneConfig {
  return { mode: parseLaneMode(env[LANE_MODE_ENV]), hosts: parseLaneWeights(env[LANE_WEIGHTS_ENV]) };
}

/** The weights that lane `host`, or undefined (mode off, or host not declared): dispatch as today. */
export function laneWeightsForHost(config: LaneConfig, host: string): LaneWeights | undefined {
  if (config.mode === 'off') return undefined;
  return config.hosts.get(normalizeLaneHost(host));
}
