/**
 * TDD (red first) — QB-U1: the queue's lane vocabulary and its per-(host, lane) counters.
 *
 * The vocabulary is FIXED: a caller may label work new, company or gap; 'other' is never a label, it
 * is the absence of one. The counters are what QB-U3's scheduler reads as "this class has work" and
 * what QB-U12's GetLaneDepth serves: resident and parked depth per (host, class), plus the two
 * since-boot coalesce counters. They live in memory; the queue keeps them in step with its tiers and
 * re-reads the parked side from the store.
 */
import { LaneCounters, QUEUE_LANES, QUEUE_LANE_CLASSES, isQueueLane } from '../../services/queueLane';

const ZERO = { resident: 0, parked: 0, relabeledLegacy: 0, coalescedCrossLane: 0 };

describe('queueLane — the fixed vocabulary', () => {
  it('names exactly three sendable lanes and four counted classes', () => {
    expect(QUEUE_LANES).toEqual(['new', 'company', 'gap']);
    expect(QUEUE_LANE_CLASSES).toEqual(['new', 'company', 'gap', 'other']);
  });

  it.each(['new', 'company', 'gap'])('accepts %s', (lane) => {
    expect(isQueueLane(lane)).toBe(true);
  });

  it.each([['other'], ['NEW'], [''], ['toString'], ['__proto__'], [undefined], [null], [1], [{}]])(
    'refuses %p (other is the absence of a lane, not a lane)',
    (value) => {
      expect(isQueueLane(value)).toBe(false);
    }
  );
});

describe('queueLane — LaneCounters', () => {
  it('reads all four classes as zero for a host it has never seen', () => {
    expect(new LaneCounters().forHost('myfigurecollection.net')).toEqual({
      new: ZERO,
      company: ZERO,
      gap: ZERO,
      other: ZERO,
    });
  });

  it('counts an unlabelled item as other', () => {
    const c = new LaneCounters();
    c.adjust('h', undefined, 'resident', 1);
    c.adjust('h', 'new', 'resident', 1);
    c.adjust('h', 'new', 'parked', 2);

    const h = c.forHost('h');
    expect(h.other).toEqual({ ...ZERO, resident: 1 });
    expect(h.new).toEqual({ ...ZERO, resident: 1, parked: 2 });
    expect(h.company).toEqual(ZERO);
  });

  it('keeps hosts apart', () => {
    const c = new LaneCounters();
    c.adjust('a', 'gap', 'resident', 3);
    c.adjust('b', 'gap', 'resident', 1);
    c.adjust('a', 'gap', 'resident', -1);

    expect(c.forHost('a').gap.resident).toBe(2);
    expect(c.forHost('b').gap.resident).toBe(1);
  });

  it('ignores an item with no host (an unparseable url cannot be on a laned host)', () => {
    const c = new LaneCounters();
    c.adjust(undefined, 'new', 'resident', 1);
    c.note(undefined, 'new', 'relabeledLegacy');

    expect(c.hosts()).toEqual([]);
  });

  it('notes the two coalesce events against the class the row ends in', () => {
    const c = new LaneCounters();
    c.note('h', 'company', 'relabeledLegacy');
    c.note('h', 'company', 'relabeledLegacy');
    c.note('h', 'gap', 'coalescedCrossLane');

    const h = c.forHost('h');
    expect(h.company.relabeledLegacy).toBe(2);
    expect(h.gap.coalescedCrossLane).toBe(1);
    expect(h.other).toEqual(ZERO);
  });

  it('replaceParked swaps in the store reading for parked depth only, summing duplicate classes', () => {
    const c = new LaneCounters();
    c.adjust('h', 'new', 'resident', 4);
    c.adjust('h', 'new', 'parked', 9);
    c.adjust('gone', 'gap', 'parked', 5);
    c.note('h', 'new', 'relabeledLegacy');

    c.replaceParked([
      { host: 'h', lane: 'new', n: 2 },
      { host: 'h', lane: undefined, n: 1 },
      { host: 'h', lane: undefined, n: 3 },
      { host: null, lane: 'gap', n: 7 },
    ]);

    const h = c.forHost('h');
    expect(h.new).toEqual({ ...ZERO, resident: 4, parked: 2, relabeledLegacy: 1 });
    expect(h.other.parked).toBe(4);
    // A host that is no longer parked anywhere reads zero, not its stale figure.
    expect(c.forHost('gone').gap.parked).toBe(0);
  });

  it('hands out a copy, so a reader cannot move the counters', () => {
    const c = new LaneCounters();
    c.adjust('h', 'new', 'resident', 1);
    const snapshot = c.forHost('h');
    snapshot.new.resident = 99;

    expect(c.forHost('h').new.resident).toBe(1);
  });

  it('lists the hosts it holds and forgets them all on reset', () => {
    const c = new LaneCounters();
    c.adjust('a', 'new', 'resident', 1);
    c.adjust('b', undefined, 'parked', 1);
    expect(c.hosts().sort()).toEqual(['a', 'b']);

    c.reset();
    expect(c.hosts()).toEqual([]);
    expect(c.forHost('a').new).toEqual(ZERO);
  });
});
