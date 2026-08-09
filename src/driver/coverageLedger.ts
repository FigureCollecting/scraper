/**
 * CoverageLedger — the crawl driver's per-store, per-ID coverage record.
 *
 * Enumeration seeds the IDs to cover; the loop marks each done/failed as it processes them.
 * That makes a long crawl:
 *   - RESUMABLE — `restore(snapshot)` rebuilds the state, and `remaining()` re-enqueues only
 *     what's left (pending + retryable failed), so a crash or a multi-day backfill picks up
 *     where it stopped instead of re-fetching the world.
 *   - PROVABLY COMPLETE — `isComplete()` is true only when EVERY enumerated ID is done; a
 *     single failed ID keeps it incomplete until retried. No silent "looks done".
 *
 * Pure and JSON-serializable; WHERE the snapshot persists (a pg-spine table vs driver-local
 * state) is the caller's choice (the ADR's open question), not baked in here.
 */

export type CoverageState = 'pending' | 'done' | 'failed';

export interface CoverageCounts {
  pending: number;
  done: number;
  failed: number;
  total: number;
}

export interface LedgerSnapshot {
  siteId: string;
  entries: Array<[string, CoverageState]>;
}

export class CoverageLedger {
  private readonly states = new Map<string, CoverageState>();

  constructor(public readonly siteId: string) {}

  /** Seed IDs to cover. Idempotent: an already-tracked ID keeps its state (progress is never reset). */
  add(ids: Iterable<string>): void {
    for (const id of ids) if (!this.states.has(id)) this.states.set(id, 'pending');
  }

  markDone(id: string): void {
    this.states.set(id, 'done');
  }

  markFailed(id: string): void {
    this.states.set(id, 'failed');
  }

  state(id: string): CoverageState | undefined {
    return this.states.get(id);
  }

  /** IDs still needing work: pending + failed (failed are retried on resume). Done are excluded. */
  remaining(): string[] {
    const out: string[] = [];
    for (const [id, s] of this.states) if (s !== 'done') out.push(id);
    return out;
  }

  counts(): CoverageCounts {
    let done = 0;
    let failed = 0;
    for (const s of this.states.values()) {
      if (s === 'done') done += 1;
      else if (s === 'failed') failed += 1;
    }
    const total = this.states.size;
    return { pending: total - done - failed, done, failed, total };
  }

  /** Provable completeness: at least one ID tracked and every one of them is done. */
  isComplete(): boolean {
    return this.states.size > 0 && this.remaining().length === 0;
  }

  /** Serializable checkpoint of the full coverage state. */
  snapshot(): LedgerSnapshot {
    return { siteId: this.siteId, entries: [...this.states.entries()] };
  }

  /** Rebuild a ledger from a snapshot to resume a crawl. */
  static restore(snapshot: LedgerSnapshot): CoverageLedger {
    const ledger = new CoverageLedger(snapshot.siteId);
    for (const [id, s] of snapshot.entries) ledger.states.set(id, s);
    return ledger;
  }
}
