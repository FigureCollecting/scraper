/**
 * queueLane — the scrape queue's lane vocabulary and its per-(host, lane) counters (QB-U1).
 *
 * Ross (2026-09-29) splits one host's dispatch slot between work classes: new ids, company lists and
 * gap fill. A caller labels an enqueue with one of those three LANES. 'other' is not a lane: it is the
 * class of work that carries no lane (retry re-drives, initiator work, and rows queued before labels
 * went live). So a lane is stored as new | company | gap or NULL, and counted in four classes.
 *
 * The counters are what QB-U3's scheduler reads as "this class has work for this host" and what
 * QB-U12's GetLaneDepth serves. They live in memory: ScrapeQueue keeps the resident side in step with
 * its tiers and re-reads the parked side from the store (at boot, after a claim and after a page-in).
 */

/** The labels a caller may send. Fixed: a label outside this list is not a lane. */
export const QUEUE_LANES = ['new', 'company', 'gap'] as const;
export type QueueLane = (typeof QUEUE_LANES)[number];

/** The classes depth is counted in: the three lanes, then 'other' for work with no lane. */
export const QUEUE_LANE_CLASSES = ['new', 'company', 'gap', 'other'] as const;
export type QueueLaneClass = (typeof QUEUE_LANE_CLASSES)[number];

/**
 * Whether a value is one of the three lanes. An array membership test, not an object lookup, so a
 * value such as 'toString' or '__proto__' can never pass for a lane (and a non-string never matches).
 */
export function isQueueLane(value: unknown): value is QueueLane {
  return (QUEUE_LANES as readonly unknown[]).includes(value);
}

/** One class's reading for one host. */
export interface LaneClassCounts {
  /** Items in an in-memory tier, waiting for dispatch. */
  resident: number;
  /** Items on disk only (the bounded-working-set overflow). */
  parked: number;
  /** Since boot: an unlabelled row adopted this class from a later enqueue of the same URL. */
  relabeledLegacy: number;
  /** Since boot: an enqueue with a different label coalesced onto a row of this class, which kept it. */
  coalescedCrossLane: number;
}

export type HostLaneCounts = Record<QueueLaneClass, LaneClassCounts>;

/** One row of the store's per-(host, lane) reading. A null host is a url that would not parse. */
export interface HostLaneRow {
  host: string | null;
  lane: QueueLane | undefined;
  n: number;
}

const zero = (): LaneClassCounts => ({ resident: 0, parked: 0, relabeledLegacy: 0, coalescedCrossLane: 0 });
const zeroHost = (): HostLaneCounts => ({ new: zero(), company: zero(), gap: zero(), other: zero() });

/**
 * Per-(host, class) depth and coalesce counters. Hosts are taken as given: the queue passes its
 * normalized host key. An item with no host (an unparseable url) is not counted; it cannot belong to
 * a laned host.
 */
export class LaneCounters {
  private readonly byHost = new Map<string, HostLaneCounts>();

  private entry(host: string, lane: QueueLane | undefined): LaneClassCounts {
    let counts = this.byHost.get(host);
    if (counts === undefined) {
      counts = zeroHost();
      this.byHost.set(host, counts);
    }
    return counts[lane ?? 'other'];
  }

  /** Move resident or parked depth for one (host, lane) by `delta`. */
  adjust(host: string | undefined, lane: QueueLane | undefined, field: 'resident' | 'parked', delta: number): void {
    if (host === undefined) return;
    this.entry(host, lane)[field] += delta;
  }

  /** Count one coalesce event against the class the row ends in. */
  note(host: string | undefined, lane: QueueLane | undefined, event: 'relabeledLegacy' | 'coalescedCrossLane'): void {
    if (host === undefined) return;
    this.entry(host, lane)[event]++;
  }

  /** Replace every parked figure with the store's reading. Resident depth and the events are kept. */
  replaceParked(rows: readonly HostLaneRow[]): void {
    for (const counts of this.byHost.values()) {
      for (const c of QUEUE_LANE_CLASSES) counts[c].parked = 0;
    }
    for (const row of rows) {
      if (row.host === null) continue;
      this.entry(row.host, row.lane).parked += row.n;
    }
  }

  /** A copy of one host's four classes; zeros for a host never seen. */
  forHost(host: string): HostLaneCounts {
    const counts = this.byHost.get(host);
    const out = zeroHost();
    if (counts === undefined) return out;
    for (const c of QUEUE_LANE_CLASSES) out[c] = { ...counts[c] };
    return out;
  }

  /** Every host with an entry. */
  hosts(): string[] {
    return [...this.byHost.keys()];
  }

  /** Forget everything (the queue's emergency clear). */
  reset(): void {
    this.byHost.clear();
  }
}
