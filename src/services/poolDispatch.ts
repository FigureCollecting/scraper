/**
 * POOL-SELECT QUEUE DISPATCH (QB-U19): the per-process state the scrape queue keeps around the pure
 * POOL-SELECT v1.1 module (poolSelect.ts) to pick WHICH item of a dispatch class goes next.
 *
 * Ross (2026-10-04, fleet-wide): "for fetches in general, where walking, we really should do a
 * prioritized pool approach (favor more recently collected new IDs but still all in new id backlog
 * are eligible) so our walks aren't simply sequential". Queue dispatch is the first of the three call
 * sites (the crawler's id ranges and backfill pages follow in QB-U20 / QB-U24).
 *
 * A dispatch CLASS is a host plus a tier (WARM or COLD) today; QB-U3 passes host plus lane through the
 * same seam. HOT never comes here: it stays FIFO and first. The queue asks pick() only for a host whose
 * mode is 'pool', with every DISPATCHABLE row of the class (resident and parked), and only after the
 * host's floor (or the shared host clock) granted the dispatch, so pooling changes which item goes,
 * never when or how often the host is sent to.
 *
 * What lives here:
 *  - SCRAPE_POOL_SELECT, read with the host-scope grammar (hostScope.ts): off | host,host | all |
 *    all,-host[,-host]; default off; malformed = off plus one boot warning. Membership is asked per
 *    dispatch, so 'all,-host' covers a host first seen after boot. Per-host mode pool | fifo-excluded |
 *    fifo-off.
 *  - SCRAPE_POOL_AGE_CAP_H / SCRAPE_POOL_HARD_CAP_H: host=hours csv; the age cap (R2) defaults to 12 h,
 *    the hard cap (R1) to 2 x the host's age cap. A bad entry, or a hard cap below the age cap, is
 *    ignored with a boot warning. Every other parameter is POOL-SELECT's DEFAULT_ID_PARAMS.
 *  - ONE 32-bit seed per process (crypto), logged at boot; each host draws from deriveStream(seed,
 *    host, 'pick'), so a logged seed and the same arrivals replay the same picks.
 *  - Per class: the anti-sequence history (the last two picked ids) and the R1 skip marks. A mark is
 *    keyed by the row's dedup key, survives the item's retries and is dropped when the item completes,
 *    gives up or is cancelled (forget) or the queue is cleared (forgetAll); a restart starts with none,
 *    which the starvation bound counts (r).
 *  - The trailing hour of picks per host, for the /health/detailed pool block (hostStats).
 *
 * The candidate KEY is the row's dedup key, not its row id: row ids carry a random suffix, so ties at
 * one class entry (and in rank) would fall in a different order on every run and a logged seed would not
 * replay. The dedup key is unique per row (idx_queue_mfc_unique); an all-digit key is compared as a
 * number (zero-padded), so '9' is older than '10' at the same instant.
 */
import { randomInt } from 'node:crypto';
import { DEFAULT_ID_PARAMS, deriveStream, select, type Candidate, type History, type Pick as PoolSelectPick, type PickRule, type PickStage, type Rng } from './poolSelect.js';
import { bareScopeHost, normalizeScopeHost, parseHostScope, type HostScope, type HostScopeKind } from './hostScope.js';
import { sanitizeForLog } from '../utils/security.js';

export const POOL_SELECT_ENV = 'SCRAPE_POOL_SELECT';
export const POOL_AGE_CAP_ENV = 'SCRAPE_POOL_AGE_CAP_H';
export const POOL_HARD_CAP_ENV = 'SCRAPE_POOL_HARD_CAP_H';
export const DEFAULT_POOL_AGE_CAP_H = 12;
/** The pool block's window: its counters cover the trailing hour. */
export const POOL_WINDOW_MS = 60 * 60_000;

const HOUR_MS = 3_600_000;

export type PoolHostMode = 'pool' | 'fifo-excluded' | 'fifo-off';

/** One dispatchable row of a class, as the queue hands it over. */
export interface PoolCandidate {
  /** The row's dedup key (QueueItem.mfcId): unique per row. */
  readonly key: string;
  /** R3 recency: the row's FIRST enqueue (enqueued_at). */
  readonly recencyMs: number;
  /** R1/R2 age: when the row entered this class (class_entered_at). */
  readonly classEnteredAtMs: number;
  /** The id anti-sequence compares (from the URL), when it has one. */
  readonly numId?: number;
  /** Whether this dispatch is a retry (the row has spent attempts). */
  readonly retry: boolean;
}

/** One pooled pick, as tests and the stats see it. */
export interface PoolPickEvent {
  readonly host: string;
  readonly classKey: string;
  readonly nowMs: number;
  readonly key: string;
  readonly rule: PickRule;
  readonly stage: PickStage;
  readonly rank: number;
  readonly redraws: number;
  /** The dedup key R1 marked skipped on this pick. */
  readonly markSkip?: string;
  /** How many rows the class offered (resident and parked). */
  readonly poolSize: number;
  /** nowMs - classEnteredAtMs of the picked row. */
  readonly waitMs: number;
  readonly retry: boolean;
}

/** One host's picks over the trailing hour. */
export interface PoolHostStats {
  picks60m: number;
  /** Of the recency (R3-stage) picks, the share whose rank lies in the top bucket (rank < headSize). */
  topBucketShare60m: number;
  uniformPicks60m: number;
  /** Picks drawn from the aged set (R2 stage). */
  agedPicks60m: number;
  agedShare60m: number;
  /** R1 picks of a skipped item that still fails anti-sequence. */
  forcedPicks60m: number;
  /** Wait (now - class entry) at dispatch, hours. */
  p99WaitH60m: number;
  maxWaitH60m: number;
  /** Sum of redraws (a scan or fallback counts maxRedraws). */
  redraws60m: number;
  /** Scan and fallback picks in a class that offered more than one row (one row leaves no choice). */
  scanFallbacks60m: number;
  /** Picks of a row that had already spent an attempt. */
  retryPicks60m: number;
}

/** One host in /health/detailed's pool block. */
export interface PoolHostView {
  host: string;
  mode: PoolHostMode;
  picks60m: number;
  topBucketShare60m: number;
  uniformPicks60m: number;
  agedPicks60m: number;
  agedShare60m: number;
  forcedPicks60m: number;
  /** Rows of the host's pooled classes (resident and parked) at or past the age cap right now. */
  agedCount: number;
  p99WaitH60m: number;
  maxWaitH60m: number;
  redraws60m: number;
  scanFallbacks60m: number;
  retryPicks60m: number;
}

/** /health/detailed's pool block. */
export interface PoolView {
  /** SCRAPE_POOL_SELECT as parsed ('off' also when it was malformed). */
  scope: HostScopeKind;
  malformed: boolean;
  hosts: PoolHostView[];
}

export interface PoolDispatchOptions {
  /** SCRAPE_POOL_SELECT's raw value (default: the env). */
  select?: string;
  /** SCRAPE_POOL_AGE_CAP_H's raw value (default: the env). */
  ageCaps?: string;
  /** SCRAPE_POOL_HARD_CAP_H's raw value (default: the env). */
  hardCaps?: string;
  /** The process seed (default: 32 crypto bits). */
  seed?: number;
  /** Tests: the rng a host draws from, instead of deriveStream(seed, host, 'pick'). */
  rngFor?: (host: string) => Rng;
  /** Tests: every pooled pick. */
  onPick?: (event: PoolPickEvent) => void;
}

interface ClassState {
  history: History;
  skips: Set<string>;
}

interface PickRecord {
  at: number;
  stage: PickStage;
  rule: PickRule;
  rank: number;
  redraws: number;
  waitMs: number;
  retry: boolean;
  poolSize: number;
}

const ZERO_STATS: Readonly<PoolHostStats> = Object.freeze({
  picks60m: 0,
  topBucketShare60m: 0,
  uniformPicks60m: 0,
  agedPicks60m: 0,
  agedShare60m: 0,
  forcedPicks60m: 0,
  p99WaitH60m: 0,
  maxWaitH60m: 0,
  redraws60m: 0,
  scanFallbacks60m: 0,
  retryPicks60m: 0,
});

const round3 = (x: number): number => Math.round(x * 1000) / 1000;

/** An all-digit key compares as a number at equal length; the raw key keeps it unique. */
function sortKey(key: string): string {
  return /^\d{1,20}$/.test(key) ? `${key.padStart(20, '0')}:${key}` : key;
}

/** `host=hours` csv: hours a finite number > 0. Bad entries are reported and skipped. */
function parseCaps(raw: string | undefined, envName: string, warnings: string[]): Map<string, number> {
  const caps = new Map<string, number>();
  const value = (raw ?? '').trim();
  if (value === '') return caps;
  for (const entry of value.split(',').map((e) => e.trim())) {
    if (entry === '') continue;
    const eq = entry.indexOf('=');
    const host = eq > 0 ? bareScopeHost(entry.slice(0, eq)) : null;
    const text = eq > 0 ? entry.slice(eq + 1).trim() : '';
    const hours = Number(text);
    // Number('') is 0, so an empty value is refused by hours <= 0 like a zero.
    if (host === null || !Number.isFinite(hours) || hours <= 0) {
      warnings.push(`[POOL] WARN ${envName} entry "${sanitizeForLog(entry)}" is not host=hours with hours > 0; ignored`);
      continue;
    }
    caps.set(host, hours);
  }
  return caps;
}

export class PoolDispatch {
  readonly seed: number;
  private readonly rawSelect: string;
  private readonly scope: HostScope;
  private readonly ageCapsH: Map<string, number>;
  private readonly hardCapsH: Map<string, number>;
  private readonly bootWarnings: string[] = [];
  private readonly rngs = new Map<string, Rng>();
  private readonly classes = new Map<string, ClassState>();
  private readonly picks = new Map<string, PickRecord[]>();
  private readonly rngFor: ((host: string) => Rng) | undefined;
  private readonly onPick: ((event: PoolPickEvent) => void) | undefined;

  constructor(opts: PoolDispatchOptions = {}) {
    this.rawSelect = (opts.select ?? process.env[POOL_SELECT_ENV] ?? '').trim();
    this.scope = parseHostScope(this.rawSelect, POOL_SELECT_ENV);
    if (this.scope.warning !== null) this.bootWarnings.push(`[POOL] ${this.scope.warning}`);
    this.ageCapsH = parseCaps(opts.ageCaps ?? process.env[POOL_AGE_CAP_ENV], POOL_AGE_CAP_ENV, this.bootWarnings);
    this.hardCapsH = parseCaps(opts.hardCaps ?? process.env[POOL_HARD_CAP_ENV], POOL_HARD_CAP_ENV, this.bootWarnings);
    for (const [host, hard] of [...this.hardCapsH]) {
      const age = this.ageCapsH.get(host) ?? DEFAULT_POOL_AGE_CAP_H;
      if (hard < age) {
        this.hardCapsH.delete(host);
        this.bootWarnings.push(
          `[POOL] WARN ${POOL_HARD_CAP_ENV} entry "${host}=${hard}" is below the host's age cap (${age} h); ignored, the hard cap is ${2 * age} h`
        );
      }
    }
    const seed = opts.seed ?? randomInt(0, 2 ** 32);
    if (!Number.isInteger(seed) || seed < 0 || seed >= 2 ** 32) {
      throw new RangeError(`PoolDispatch: seed must be an integer in [0, 2^32), got ${seed}`);
    }
    this.seed = seed;
    this.rngFor = opts.rngFor;
    this.onPick = opts.onPick;
  }

  /** Whether the queue pools this host (asked per dispatch, never from a boot-time list). */
  modeFor(host: string): PoolHostMode {
    const membership = this.scope.membership(host);
    return membership === 'in' ? 'pool' : membership === 'excluded' ? 'fifo-excluded' : 'fifo-off';
  }

  capsFor(host: string): { ageCapMs: number; hardCapMs: number } {
    const key = normalizeScopeHost(host);
    const ageH = this.ageCapsH.get(key) ?? DEFAULT_POOL_AGE_CAP_H;
    const hardH = this.hardCapsH.get(key) ?? 2 * ageH;
    return { ageCapMs: ageH * HOUR_MS, hardCapMs: hardH * HOUR_MS };
  }

  /**
   * Pick the next row of one class: the index into `candidates`, or -1 for an empty class. Applies R1's
   * skip mark, moves the class's anti-sequence history and records the pick for the pool block.
   */
  pick(host: string, classKey: string, candidates: readonly PoolCandidate[], nowMs: number): number {
    if (candidates.length === 0) return -1;
    const cls = this.classOf(classKey);
    const byKey = new Map<string, number>();
    const pool: Candidate[] = candidates.map((c, i) => {
      const key = sortKey(c.key);
      byKey.set(key, i);
      return { key, tier: 0, recency: c.recencyMs, numId: c.numId, classEnteredAtMs: c.classEnteredAtMs, skipped: cls.skips.has(c.key) };
    });
    const { ageCapMs, hardCapMs } = this.capsFor(host);
    // A non-empty explicit pool always yields a pick (select returns null only for an empty one).
    const picked = select({ kind: 'explicit', candidates: pool }, { ...DEFAULT_ID_PARAMS, ageCapMs, hardCapMs }, {
      rng: this.rngOf(host),
      nowMs,
      history: cls.history,
    }) as PoolSelectPick;
    const index = byKey.get(picked.candidate.key) as number;
    const chosen = candidates[index];
    const markSkip = picked.markSkip === undefined ? undefined : candidates[byKey.get(picked.markSkip) as number].key;
    if (markSkip !== undefined) cls.skips.add(markSkip);
    cls.history = { prev: chosen.numId, prev2: cls.history.prev };
    const waitMs = nowMs - chosen.classEnteredAtMs;
    this.record(normalizeScopeHost(host), {
      at: nowMs,
      stage: picked.stage,
      rule: picked.rule,
      rank: picked.rank,
      redraws: picked.redraws,
      waitMs,
      retry: chosen.retry,
      poolSize: candidates.length,
    });
    this.onPick?.({
      host,
      classKey,
      nowMs,
      key: chosen.key,
      rule: picked.rule,
      stage: picked.stage,
      rank: picked.rank,
      redraws: picked.redraws,
      ...(markSkip !== undefined ? { markSkip } : {}),
      poolSize: candidates.length,
      waitMs,
      retry: chosen.retry,
    });
    return index;
  }

  /** The row left the queue (completed, gave up, cancelled): its skip mark goes, in whichever class. */
  forget(key: string): void {
    for (const cls of this.classes.values()) cls.skips.delete(key);
  }

  /** The queue was cleared: every skip mark goes. */
  forgetAll(): void {
    for (const cls of this.classes.values()) cls.skips.clear();
  }

  /** One host's picks over the trailing hour (zeros when it made none). */
  hostStats(host: string, nowMs: number): PoolHostStats {
    const recent = this.windowOf(normalizeScopeHost(host), nowMs);
    if (recent.length === 0) return { ...ZERO_STATS };
    let uniform = 0;
    let aged = 0;
    let forced = 0;
    let recency = 0;
    let top = 0;
    let redraws = 0;
    let scans = 0;
    let retries = 0;
    const waits: number[] = [];
    for (const p of recent) {
      if (p.rule === 'uniform') uniform++;
      if (p.stage === 'R2') aged++;
      if (p.rule === 'R1-forced') forced++;
      if (p.stage === 'R3') {
        recency++;
        if (p.rank < DEFAULT_ID_PARAMS.headSize) top++;
      }
      redraws += p.redraws;
      if ((p.rule === 'scan' || p.rule === 'fallback') && p.poolSize > 1) scans++;
      if (p.retry) retries++;
      waits.push(p.waitMs);
    }
    waits.sort((a, b) => a - b);
    const n = recent.length;
    return {
      picks60m: n,
      topBucketShare60m: recency > 0 ? round3(top / recency) : 0,
      uniformPicks60m: uniform,
      agedPicks60m: aged,
      agedShare60m: round3(aged / n),
      forcedPicks60m: forced,
      p99WaitH60m: round3(waits[Math.min(n - 1, Math.floor(0.99 * n))] / HOUR_MS),
      maxWaitH60m: round3(waits[n - 1] / HOUR_MS),
      redraws60m: redraws,
      scanFallbacks60m: scans,
      retryPicks60m: retries,
    };
  }

  /** Hosts with a pick in the trailing hour, sorted. */
  hostsSeen(nowMs: number): string[] {
    return [...this.picks.keys()].filter((host) => this.windowOf(host, nowMs).length > 0).sort();
  }

  scopeView(): { scope: HostScopeKind; malformed: boolean; hosts: readonly string[] } {
    return { scope: this.scope.kind, malformed: this.scope.malformed, hosts: [...this.scope.hosts] };
  }

  /** The boot warnings: a malformed SCRAPE_POOL_SELECT, bad cap entries. Logged once at boot. */
  warnings(): string[] {
    return [...this.bootWarnings];
  }

  /** The boot line: the knob as given, what it means, the caps and the seed (to replay picks). */
  describe(): string {
    const { kind, malformed, hosts } = this.scope;
    const meaning = malformed
      ? ' (malformed: treated as off)'
      : kind === 'all-except'
        ? ` except=${hosts.join(',')}`
        : kind === 'hosts'
          ? ` hosts=${hosts.join(',')}`
          : '';
    const overridden = [...new Set([...this.ageCapsH.keys(), ...this.hardCapsH.keys()])].sort();
    const caps = overridden
      .map((host) => {
        const { ageCapMs, hardCapMs } = this.capsFor(host);
        return `${host}=${ageCapMs / HOUR_MS}/${hardCapMs / HOUR_MS}`;
      })
      .join(',');
    return (
      `[POOL] ${POOL_SELECT_ENV}="${sanitizeForLog(this.rawSelect)}" scope=${kind}${meaning} ` +
      `ageCapH=${DEFAULT_POOL_AGE_CAP_H} hardCapH=${2 * DEFAULT_POOL_AGE_CAP_H}${caps === '' ? '' : ` caps(age/hard h)=${caps}`} ` +
      `seed=${this.seed}`
    );
  }

  private classOf(classKey: string): ClassState {
    let cls = this.classes.get(classKey);
    if (cls === undefined) {
      cls = { history: {}, skips: new Set() };
      this.classes.set(classKey, cls);
    }
    return cls;
  }

  private rngOf(host: string): Rng {
    const key = normalizeScopeHost(host);
    let rng = this.rngs.get(key);
    if (rng === undefined) {
      rng = this.rngFor !== undefined ? this.rngFor(key) : deriveStream(this.seed, key, 'pick');
      this.rngs.set(key, rng);
    }
    return rng;
  }

  private record(host: string, rec: PickRecord): void {
    let ring = this.picks.get(host);
    if (ring === undefined) {
      ring = [];
      this.picks.set(host, ring);
    }
    ring.push(rec);
    // Picks arrive in time order, so the expired ones are at the front.
    while (ring.length > 0 && rec.at - ring[0].at >= POOL_WINDOW_MS) ring.shift();
  }

  private windowOf(host: string, nowMs: number): PickRecord[] {
    return (this.picks.get(host) ?? []).filter((p) => nowMs - p.at < POOL_WINDOW_MS);
  }
}

let processPool: PoolDispatch | null = null;

/** The process instance, built from the env on first use. */
export function getPoolDispatch(): PoolDispatch {
  if (processPool === null) processPool = new PoolDispatch();
  return processPool;
}

/** Replace (tests, DI) or, with null, drop the process instance so the next use re-reads the env. */
export function setPoolDispatch(pool: PoolDispatch | null): void {
  processPool = pool;
}

/** Boot: each warning once, then the describe() line with the seed. */
export function announcePoolDispatch(pool: PoolDispatch, log: Pick<Console, 'log' | 'warn'> = console): void {
  for (const warning of pool.warnings()) log.warn(warning);
  log.log(pool.describe());
}
