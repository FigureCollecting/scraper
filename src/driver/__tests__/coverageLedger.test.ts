/**
 * TDD (red first): CoverageLedger — per-store, per-ID coverage tracking that makes a crawl
 * RESUMABLE (restore from a snapshot → re-enqueue only what's left) and completeness PROVABLE
 * (complete only when every enumerated ID is done). Failed IDs stay retryable. Pure + serializable.
 */
import { CoverageLedger, type LedgerSnapshot } from '../coverageLedger';

describe('CoverageLedger — per-store coverage with checkpoint/resume', () => {
  it('seeds ids as pending and is idempotent (re-adding never resets progress)', () => {
    const l = new CoverageLedger('amiami');
    l.add(['a', 'b', 'c']);
    expect(l.counts()).toEqual({ pending: 3, done: 0, failed: 0, total: 3 });
    l.markDone('a');
    l.add(['a', 'b', 'd']); // 'a' is done (must not reset), 'b' pending, 'd' new
    expect(l.state('a')).toBe('done');
    expect(l.counts()).toEqual({ pending: 3, done: 1, failed: 0, total: 4 });
  });

  it('remaining() = pending + failed (failed are retryable); done are excluded', () => {
    const l = new CoverageLedger('s');
    l.add(['a', 'b', 'c']);
    l.markDone('a');
    l.markFailed('b');
    expect(l.remaining().sort()).toEqual(['b', 'c']);
    expect(l.isComplete()).toBe(false);
  });

  it('isComplete() only when every id is done (failed blocks completeness until retried)', () => {
    const l = new CoverageLedger('s');
    l.add(['a', 'b']);
    l.markDone('a');
    l.markFailed('b');
    expect(l.isComplete()).toBe(false);
    l.markDone('b'); // retry succeeds
    expect(l.isComplete()).toBe(true);
    expect(l.remaining()).toEqual([]);
  });

  it('snapshot() + restore() round-trips for resume', () => {
    const l = new CoverageLedger('mfc');
    l.add(['1', '2', '3', '4']);
    l.markDone('1');
    l.markDone('2');
    l.markFailed('3'); // 4 stays pending
    const resumed = CoverageLedger.restore(l.snapshot());
    expect(resumed.siteId).toBe('mfc');
    expect(resumed.counts()).toEqual({ pending: 1, done: 2, failed: 1, total: 4 });
    expect(resumed.remaining().sort()).toEqual(['3', '4']); // resume = retry 3 + do 4
    expect(resumed.isComplete()).toBe(false);
  });

  it('the snapshot survives a JSON round-trip (persistable to pg-spine or disk)', () => {
    const l = new CoverageLedger('s');
    l.add(['x', 'y']);
    l.markDone('x');
    const viaJson: LedgerSnapshot = JSON.parse(JSON.stringify(l.snapshot()));
    const resumed = CoverageLedger.restore(viaJson);
    expect(resumed.state('x')).toBe('done');
    expect(resumed.remaining()).toEqual(['y']);
  });
});
