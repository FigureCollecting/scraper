/**
 * hostClock, QB-U30b additions (plan-v3 rev 7, design.host_clock): the 'all,-host' scope, per-host
 * dispatch jitter (SCRAPE_DISPATCH_JITTER_MS, drawn from the (host, 'jitter') stream of the process
 * seed), the blocking caller's wait cap (floor + J + SCRAPE_CATALOG_CLOCK_WAIT_SLACK_MS) and its
 * ceiling (hosts with floor + J > CATALOG_STORE_TIMEOUT_MS - slack - SCRAPE_CATALOG_MIN_FETCH_MS are
 * recorded only), the lost-slot gate of the WAIT RULE, record() for callers that do not pass the
 * gate (RECORD RULE), markSent() for the after-invoke stamp, and the observer's new fields.
 * QB-U30a's names and signatures are untouched (hostClock.test.ts).
 */
import {
  HOST_CLOCK_CALLERS,
  HostClock,
  getHostClock,
  parseHostClockScope,
  parseJitterMs,
  setHostClock,
  type HostClockCaller,
  type HostClockOptions,
} from '../../services/hostClock';
import { deriveStream } from '../../services/poolSelect';
import { getProcessSeed, setProcessSeed } from '../../services/processSeed';

const MFC = 'myfigurecollection.net';
const FLOOR = 7000;
const MIN = 60_000;

/** Every caller's count, zero unless given. */
function callers(counts: Partial<Record<HostClockCaller, number>> = {}): Record<HostClockCaller, number> {
  return Object.fromEntries(HOST_CLOCK_CALLERS.map(c => [c, counts[c] ?? 0])) as Record<HostClockCaller, number>;
}

/** A stream that replays the given draws in [0, 1), then repeats the last. */
function script(...draws: number[]) {
  let i = 0;
  const rng = jest.fn(() => draws[Math.min(i++, draws.length - 1)]);
  return rng;
}

function clockWith(raw: string, options: HostClockOptions = {}, floors: Record<string, number> = { [MFC]: FLOOR }): HostClock {
  const clock = new HostClock(parseHostClockScope(raw), raw, options);
  clock.setFloorSource(host => floors[host]);
  return clock;
}

describe('the caller names', () => {
  it('are the two QB-U30a callers and the nine QB-U30b adds, in that order', () => {
    expect(HOST_CLOCK_CALLERS).toEqual([
      'queue', 'image', 'catalogListing', 'catalogSeed', 'catalogRotating', 'resolve', 'scrape', 'lookup', 'fetchBody', 'sessionPrime', 'pluginRoute',
    ]);
  });
});

describe("SCRAPE_HOST_CLOCK = 'all,-host' (QB-U30b (e), the grammar shared with SCRAPE_POOL_SELECT)", () => {
  it('covers every host but the excluded ones, including a host first seen after boot', () => {
    const inScope = parseHostClockScope(`all,-${MFC}`);
    expect(inScope(MFC)).toBe(false);
    expect(inScope('WWW.MyFigureCollection.net.')).toBe(false);
    expect(inScope('hpoi.net')).toBe(true);
    expect(inScope('store-added-after-boot.example')).toBe(true);
  });

  it('the clock reports the mode, says what it excludes and keeps an excluded host off the clock', () => {
    const raw = `all,-${MFC},-hpoi.net`;
    const clock = clockWith(raw, {}, { [MFC]: FLOOR, 'hpoi.net': 3000, 'amiami.com': 4000 });
    expect(clock.inScope(MFC)).toBe(false);
    expect(clock.floorFor(MFC)).toBeUndefined();
    expect(clock.floorFor('amiami.com')).toBe(4000);
    expect(clock.view(0).mode).toBe('all-except');
    expect(clock.describe()).toBe(
      `[HOST-CLOCK] SCRAPE_HOST_CLOCK=${raw}: one clock per host for queue dispatch and main-host images; except ${MFC}, hpoi.net`,
    );
    expect(clock.warnings()).toEqual([]);
  });

  it('a malformed exclusion is off, with one WARN naming the value', () => {
    const raw = 'all,-x.com,y.com';
    const clock = new HostClock(parseHostClockScope(raw), raw);
    expect(clock.inScope('x.com')).toBe(false);
    expect(clock.inScope('y.com')).toBe(false);
    expect(clock.inScope('z.com')).toBe(false);
    expect(clock.view(0).mode).toBe('off');
    expect(clock.warnings()).toEqual([
      '[HOST-CLOCK] WARN SCRAPE_HOST_CLOCK="all,-x.com,y.com" is malformed ("all" mixes -host exclusions with listed hosts); treated as off',
    ]);
  });
});

describe('parseJitterMs (SCRAPE_DISPATCH_JITTER_MS = host=ms csv, default 0)', () => {
  it('reads each host=ms, normalising the host', () => {
    const parsed = parseJitterMs(' MyFigureCollection.net.=2000 , www.hpoi.net = 500,,');
    expect([...parsed.byHost]).toEqual([[MFC, 2000], ['hpoi.net', 500]]);
    expect(parsed.warnings).toEqual([]);
  });

  it.each([undefined, '', ' ', 'off', '0'])('reads %p as no jitter for any host', raw => {
    const parsed = parseJitterMs(raw);
    expect(parsed.byHost.size).toBe(0);
  });

  it('ignores an entry that is not host=ms with a whole ms in [0, 60000], one WARN each', () => {
    const parsed = parseJitterMs('a.com,b.com=-1,c.com=1.5,d.com=abc,https://e.com=5,f.com=60001,g.com=60000,=5,h.com=');
    expect([...parsed.byHost]).toEqual([['g.com', 60000]]);
    expect(parsed.warnings).toEqual([
      '[HOST-CLOCK] WARN SCRAPE_DISPATCH_JITTER_MS entry "a.com" is not host=ms; ignored',
      '[HOST-CLOCK] WARN SCRAPE_DISPATCH_JITTER_MS entry "b.com=-1" is not a whole number of ms in [0, 60000]; ignored',
      '[HOST-CLOCK] WARN SCRAPE_DISPATCH_JITTER_MS entry "c.com=1.5" is not a whole number of ms in [0, 60000]; ignored',
      '[HOST-CLOCK] WARN SCRAPE_DISPATCH_JITTER_MS entry "d.com=abc" is not a whole number of ms in [0, 60000]; ignored',
      '[HOST-CLOCK] WARN SCRAPE_DISPATCH_JITTER_MS entry "https://e.com=5" is not a bare hostname; ignored',
      '[HOST-CLOCK] WARN SCRAPE_DISPATCH_JITTER_MS entry "f.com=60001" is not a whole number of ms in [0, 60000]; ignored',
      '[HOST-CLOCK] WARN SCRAPE_DISPATCH_JITTER_MS entry "=5" is not a bare hostname; ignored',
      '[HOST-CLOCK] WARN SCRAPE_DISPATCH_JITTER_MS entry "h.com=" is not a whole number of ms in [0, 60000]; ignored',
    ]);
  });

  it("'0' for a host is no jitter for it", () => {
    expect([...parseJitterMs('a.com=0').byHost]).toEqual([['a.com', 0]]);
  });
});

describe('dispatch jitter (QB-U30b (a))', () => {
  it('J = 0 draws nothing: every gap is exactly the floor', () => {
    const rng = script(0.99);
    const clock = clockWith(MFC, { jitterMs: () => 0, jitterRng: () => rng });
    expect(clock.jitterMsFor(MFC)).toBe(0);
    expect(clock.tryAcquire(MFC, 0, FLOOR)).toBe(0);
    clock.settle(MFC, 0, FLOOR);
    expect(clock.tryAcquire(MFC, 6999, FLOOR)).toBe(1);
    expect(clock.tryAcquire(MFC, 7000, FLOOR)).toBe(0);
    clock.record(MFC, 7000, 'lookup');
    expect(rng).not.toHaveBeenCalled();
  });

  it("each send draws floor(rand x J) once, and the next request waits floor + that send's jitter", () => {
    const rng = script(0.5, 0.25, 0.9995);
    const clock = clockWith(MFC, { jitterMs: host => (host === MFC ? 2000 : 0), jitterRng: () => rng });
    expect(clock.jitterMsFor('WWW.MyFigureCollection.net.')).toBe(2000);
    expect(clock.tryAcquire(MFC, 0, FLOOR)).toBe(0);
    clock.settle(MFC, 0, FLOOR); // draws 0.5 -> 1000
    expect(rng).toHaveBeenCalledTimes(1);
    // The after-invoke stamp of the SAME send raises its instant and keeps its jitter: no new draw.
    clock.markSent(MFC, 1);
    expect(rng).toHaveBeenCalledTimes(1);
    expect(clock.tryAcquire(MFC, 8000, FLOOR)).toBe(1);
    expect(clock.msUntilSendable(MFC, 8001, 8000, FLOOR)).toBe(1);
    expect(clock.reserve(MFC, 2000, FLOOR)).toBe(8001);
    clock.settle(MFC, 8001, FLOOR); // draws 0.25 -> 500
    expect(clock.reserve(MFC, 8002, FLOOR)).toBe(15_501);
    clock.settle(MFC, 15_501, FLOOR); // draws 0.9995 -> 1999 (never J itself)
    expect(clock.tryAcquire(MFC, 24_499, FLOOR)).toBe(1);
    expect(clock.tryAcquire(MFC, 24_500, FLOOR)).toBe(0);
    expect(rng).toHaveBeenCalledTimes(3);
  });

  it('a stamp that does not replace the last send (older, or same instant and floor) draws nothing', () => {
    const rng = script(0.5);
    const clock = clockWith(MFC, { jitterMs: () => 2000, jitterRng: () => rng });
    clock.settle(MFC, 5000, FLOOR);
    clock.settle(MFC, 4000, FLOOR);
    clock.settle(MFC, 5000, FLOOR);
    expect(rng).toHaveBeenCalledTimes(1);
  });

  it('a host on no jitter list draws nothing even with a jittered neighbour', () => {
    const rng = script(0.5);
    const clock = clockWith('all', { jitterMs: host => (host === MFC ? 2000 : 0), jitterRng: () => rng }, { [MFC]: FLOOR, 'hpoi.net': 3000 });
    clock.settle('hpoi.net', 0, 3000);
    expect(clock.tryAcquire('hpoi.net', 3000, 3000)).toBe(0);
    expect(rng).not.toHaveBeenCalled();
  });

  it("defaults to one mulberry32 stream per host, derived from the seed with (host, 'jitter')", () => {
    const seed = 123_456;
    const a = clockWith(MFC, { jitterMs: () => 2000, seed });
    a.settle(MFC, 0, FLOOR);
    const expected = Math.floor(deriveStream(seed, MFC, 'jitter')() * 2000);
    expect(a.tryAcquire(MFC, FLOOR + expected - 1, FLOOR)).toBe(1);
    expect(a.tryAcquire(MFC, FLOOR + expected, FLOOR)).toBe(0);
  });
});

describe('reserve with a cap (the blocking caller wait cap, QB-U30b (c)-(d))', () => {
  it('books and returns the slot while its wait is at most the cap, the boundary included', () => {
    const clock = clockWith(MFC);
    clock.tryAcquire(MFC, 0, FLOOR);
    expect(clock.reserve(MFC, 0, FLOOR, FLOOR)).toBe(FLOOR);
  });

  it('refuses (null) a slot further than the cap and books nothing', () => {
    const clock = clockWith(MFC);
    clock.tryAcquire(MFC, 0, FLOOR);
    expect(clock.reserve(MFC, 0, FLOOR, FLOOR - 1)).toBeNull();
    // Nothing was booked: the next free slot is still the floor after the grant.
    expect(clock.reserve(MFC, 100, FLOOR)).toBe(FLOOR);
  });

  it('two stacked blocking reservations: the second is refused at the cap floor + J + slack', () => {
    const clock = clockWith(MFC, { jitterMs: () => 2000, waitSlackMs: 3000, jitterRng: () => () => 0.5 });
    const cap = clock.capMsFor(MFC);
    expect(cap).toBe(FLOOR + 2000 + 3000);
    clock.tryAcquire(MFC, 0, FLOOR);
    clock.settle(MFC, 0, FLOOR); // jitter 1000
    expect(clock.reserve(MFC, 10, FLOOR, cap!)).toBe(8000);
    expect(clock.reserve(MFC, 20, FLOOR, cap!)).toBeNull();
  });
});

describe('sendWait (the WAIT RULE gate: null = the slot is LOST)', () => {
  it('is null with no booking', () => {
    expect(clockWith(MFC).sendWait(MFC, 0, 0, FLOOR)).toBeNull();
  });

  it("is null once the host's latest booking is another one that is already due", () => {
    const clock = clockWith(MFC);
    expect(clock.reserve(MFC, 0, FLOOR)).toBe(0);
    // The waiter slept through; the queue took the host at 7000.
    expect(clock.tryAcquire(MFC, 7000, FLOOR)).toBe(0);
    expect(clock.sendWait(MFC, 0, 7100, FLOOR)).toBeNull();
  });

  it('is the remainder (not null) for a valid slot that a later, not yet due booking follows', () => {
    const clock = clockWith(MFC);
    expect(clock.reserve(MFC, 0, FLOOR)).toBe(0);
    expect(clock.reserve(MFC, 10, FLOOR)).toBe(FLOOR);
    expect(clock.sendWait(MFC, 0, 0, FLOOR)).toBe(0);
  });

  it("is the remainder for a valid slot whose gate another caller's late send pushed out: sleep it, never re-book", () => {
    const clock = clockWith(MFC);
    clock.tryAcquire(MFC, 0, FLOOR);
    const slot = clock.reserve(MFC, 100, FLOOR);
    // The queue's record (granted at 0) really left 600 ms late.
    clock.settle(MFC, 600, FLOOR);
    expect(clock.sendWait(MFC, slot, 7000, FLOOR)).toBe(600);
    expect(clock.sendWait(MFC, slot, 7600, FLOOR)).toBe(0);
  });

  it('refuses an early timer (the rest of the wait until the slot)', () => {
    const clock = clockWith(MFC);
    clock.tryAcquire(MFC, 0, FLOOR);
    const slot = clock.reserve(MFC, 100, FLOOR);
    expect(clock.sendWait(MFC, slot, 6999, FLOOR)).toBe(1);
  });
});

describe('record (a send that did not pass the gate) and markSent (the after-invoke stamp)', () => {
  it('RECORD RULE, review 5 executed case: floor 45000, queue 0, image 45000, /lookup recorded at 2000 -> next queue record not before 90000', () => {
    const floors = { 'sugotoys.example': 45_000 };
    const clock = clockWith('all', {}, floors);
    expect(clock.tryAcquire('sugotoys.example', 0, 45_000)).toBe(0);
    expect(clock.reserve('sugotoys.example', 10, 45_000)).toBe(45_000);
    clock.record('sugotoys.example', 2000, 'lookup');
    // A naive overwrite would allow the next record at 47000, 2000 ms after the image.
    expect(clock.tryAcquire('sugotoys.example', 89_999, 45_000)).toBe(1);
    expect(clock.tryAcquire('sugotoys.example', 90_000, 45_000)).toBe(0);
    expect(clock.view(2000).hosts[0].sends60m).toEqual(callers({ lookup: 1 }));
  });

  it("record spaces the queue's next record a full floor after it (the store's floor from the floor source)", () => {
    const clock = clockWith('all', {}, { 'sugotoys.example': 45_000 });
    clock.record('sugotoys.example', 1000, 'lookup');
    expect(clock.tryAcquire('sugotoys.example', 45_999, 45_000)).toBe(1);
    expect(clock.tryAcquire('sugotoys.example', 46_000, 45_000)).toBe(0);
  });

  it('record on a host off the clock only feeds the observer', () => {
    const clock = clockWith('off');
    clock.record(MFC, 1000, 'catalogListing');
    expect(clock.tryAcquire(MFC, 1001, FLOOR)).toBe(0);
    expect(clock.view(1001).hosts[0]).toMatchObject({ clocked: false, sends60m: callers({ catalogListing: 1 }) });
  });

  it('markSent raises the last send to the instant the transport was invoked, never earlier, and records nothing', () => {
    const clock = clockWith(MFC);
    clock.settle(MFC, 1000, FLOOR);
    clock.markSent(MFC, 1003);
    expect(clock.tryAcquire(MFC, 8002, FLOOR)).toBe(1);
    clock.markSent(MFC, 1001);
    expect(clock.tryAcquire(MFC, 8002, FLOOR)).toBe(1);
    expect(clock.tryAcquire(MFC, 8003, FLOOR)).toBe(0);
    expect(clock.view(8003).hosts[0].sends60m).toEqual(callers());
  });

  it('markSent on a host with no send stamped does nothing', () => {
    const clock = clockWith(MFC);
    clock.markSent(MFC, 5000);
    expect(clock.tryAcquire(MFC, 5001, FLOOR)).toBe(0);
  });
});

describe('the blocking-caller role, wait cap and ceiling (design.host_clock.wait_cap)', () => {
  const floors = { [MFC]: FLOOR, 'anitoys.example': 20_000, 'edge.example': 27_000, 'over.example': 27_001, 'sugotoys.example': 45_000 };
  const clock = () => clockWith('all', { jitterMs: host => (host === MFC ? 2000 : 0), waitSlackMs: 3000, minFetchMs: 30_000, blockingBudgetMs: 60_000 }, floors);

  it('cap = floor + J + slack; the ceiling is budget - slack - min fetch (27000 at the deployed 60 s)', () => {
    const c = clock();
    expect(c.capMsFor(MFC)).toBe(12_000);
    expect(c.capMsFor('anitoys.example')).toBe(23_000);
    expect(c.ceilingMs()).toBe(27_000);
  });

  it('clocks a host with floor + J <= ceiling, records only a host above it, and leaves an unclocked host off', () => {
    const c = clock();
    expect(c.blockingRole(MFC)).toBe('clocked');
    expect(c.blockingRole('anitoys.example')).toBe('clocked');
    expect(c.blockingRole('edge.example')).toBe('clocked');
    expect(c.blockingRole('over.example')).toBe('recorded');
    expect(c.blockingRole('sugotoys.example')).toBe('recorded');
    // Not a store host (a CDN), or not in scope: off (observer only).
    expect(c.blockingRole('cdn.example')).toBe('off');
    expect(c.capMsFor('cdn.example')).toBeUndefined();
    const scoped = clockWith(MFC, {}, floors);
    expect(scoped.blockingRole('anitoys.example')).toBe('off');
  });

  it('the jitter counts toward the ceiling', () => {
    const c = clockWith('all', { jitterMs: () => 1, blockingBudgetMs: 60_000, waitSlackMs: 3000, minFetchMs: 30_000 }, { 'edge.example': 27_000 });
    expect(c.blockingRole('edge.example')).toBe('recorded');
  });

  it('defaults: slack 3000, min fetch 30000, budget 60000', () => {
    const c = clockWith('all', {}, floors);
    expect(c.capMsFor(MFC)).toBe(10_000);
    expect(c.ceilingMs()).toBe(27_000);
  });

  it('bootLines name the jitter per host with the seed, and every store host recorded only', () => {
    const c = clockWith('all', { jitterMs: host => (host === MFC ? 2000 : 0), seed: 42, blockingBudgetMs: 60_000 }, floors);
    expect(c.bootLines(['sugotoys.example', MFC, 'anitoys.example', 'over.example', 'cdn.example'])).toEqual([
      `[HOST-CLOCK] jitter SCRAPE_DISPATCH_JITTER_MS: ${MFC} 0-1999 ms; process seed 42, one stream per (host, 'jitter')`,
      '[HOST-CLOCK] blocking callers wait at most floor + jitter + 3000 ms; hosts above the 27000 ms ceiling are recorded only: over.example (floor 27001 ms), sugotoys.example (floor 45000 ms)',
    ]);
  });

  it('bootLines when nothing is jittered or excluded', () => {
    const c = clockWith(MFC, { seed: 7 });
    expect(c.bootLines([MFC])).toEqual([
      '[HOST-CLOCK] jitter SCRAPE_DISPATCH_JITTER_MS off: every gap is the floor',
      '[HOST-CLOCK] blocking callers wait at most floor + jitter + 3000 ms; hosts above the 27000 ms ceiling are recorded only: none',
    ]);
  });
});

describe('the observer, QB-U30b fields (design.host_clock.observe)', () => {
  it('shows every caller, the constrained gaps, refusals and latencies as zeros while idle, under 1 KB', () => {
    const clock = clockWith(MFC);
    const [mfc] = clock.view(0).hosts;
    expect(mfc).toEqual({
      host: MFC,
      floorMs: FLOOR,
      clocked: true,
      sends60m: callers(),
      minGapMs60m: 0,
      underFloor60m: 0,
      constrainedGaps60m: 0,
      meanConstrainedGapMs60m: 0,
      clockRefusals60m: callers(),
      listingFetchP99Ms60m: 0,
      lookupP95Ms60m: 0,
      lastSendAt: null,
    });
    expect(JSON.stringify(mfc).length).toBeLessThan(1024);
  });

  it('a send is constrained when some caller had to wait for the clock since the previous send', () => {
    const clock = clockWith(MFC);
    // Idle host: granted at once, not constrained.
    expect(clock.tryAcquire(MFC, 0, FLOOR)).toBe(0);
    clock.settle(MFC, 0, FLOOR);
    clock.recordSend(MFC, 'queue', 0);
    // A queue item skipped as paced, then granted: constrained.
    expect(clock.tryAcquire(MFC, 3000, FLOOR)).toBe(4000);
    expect(clock.tryAcquire(MFC, 7000, FLOOR)).toBe(0);
    clock.settle(MFC, 7000, FLOOR);
    clock.recordSend(MFC, 'queue', 7000);
    // A reservation in the future: constrained (its send left 300 ms late).
    expect(clock.reserve(MFC, 8000, FLOOR)).toBe(14_000);
    clock.settle(MFC, 14_300, FLOOR);
    clock.recordSend(MFC, 'catalogListing', 14_300);
    // A send after a long idle stretch: a reservation at the asked time is not constrained.
    expect(clock.reserve(MFC, 30_000, FLOOR)).toBe(30_000);
    clock.settle(MFC, 30_000, FLOOR);
    clock.recordSend(MFC, 'resolve', 30_000);
    // A waiter books 37000; another caller (not constrained) sends late at 37500, so the waiter's gate
    // is closed (sendWait > 0) and the send it then makes is constrained.
    const slot = clock.reserve(MFC, 37_000, FLOOR);
    expect(slot).toBe(37_000);
    clock.settle(MFC, 37_500, FLOOR);
    clock.recordSend(MFC, 'image', 37_500);
    expect(clock.sendWait(MFC, slot, 37_600, FLOOR)).toBe(6900);
    clock.settle(MFC, 44_500, FLOOR);
    clock.recordSend(MFC, 'lookup', 44_500);
    const [mfc] = clock.view(44_500).hosts;
    expect(mfc.sends60m).toEqual(callers({ queue: 2, catalogListing: 1, resolve: 1, image: 1, lookup: 1 }));
    // Constrained: 7000 (gap 7000), 14300 (gap 7300), 44500 (gap 7000).
    expect(mfc.constrainedGaps60m).toBe(3);
    expect(mfc.meanConstrainedGapMs60m).toBe(7100);
    expect(mfc.minGapMs60m).toBe(7000);
  });

  it('counts clock refusals per caller in the trailing hour', () => {
    const clock = clockWith(MFC);
    clock.noteRefusal(MFC, 'catalogListing', 0);
    clock.noteRefusal('WWW.MyFigureCollection.net.', 'catalogListing', 10);
    clock.noteRefusal(MFC, 'lookup', 20);
    expect(clock.view(60 * MIN - 1).hosts[0].clockRefusals60m).toEqual(callers({ catalogListing: 2, lookup: 1 }));
    expect(clock.view(60 * MIN + 15).hosts[0].clockRefusals60m).toEqual(callers({ lookup: 1 }));
    expect(clock.view(60 * MIN + 20).hosts[0].clockRefusals60m).toEqual(callers());
  });

  it('a refusal or a latency on a non-store host is not kept', () => {
    const clock = clockWith('all');
    clock.noteRefusal('cdn.example', 'lookup', 0);
    clock.noteLatency('cdn.example', 'lookup', 100, 0);
    expect(clock.view(1).hosts).toEqual([]);
  });

  it('listing fetch p99 and /lookup p95 per host over the trailing hour (nearest rank), AC-R1 and AC-R2', () => {
    const clock = clockWith('all', {}, { [MFC]: FLOOR, 'shop.example': 1000 });
    for (let i = 1; i <= 100; i++) clock.noteLatency(MFC, 'listing', i * 10, i);
    for (let i = 1; i <= 20; i++) clock.noteLatency('shop.example', 'lookup', i * 100, i);
    const view = clock.view(200);
    expect(view.hosts.find(h => h.host === MFC)).toMatchObject({ listingFetchP99Ms60m: 990, lookupP95Ms60m: 0 });
    expect(view.hosts.find(h => h.host === 'shop.example')).toMatchObject({ listingFetchP99Ms60m: 0, lookupP95Ms60m: 1900 });
    // Out of the window: gone.
    expect(clock.view(60 * MIN + 101).hosts.find(h => h.host === MFC)).toMatchObject({ listingFetchP99Ms60m: 0 });
  });

  it('summaryLines count the sends of every caller', () => {
    const clock = clockWith(MFC);
    clock.recordSend(MFC, 'queue', 0);
    clock.recordSend(MFC, 'catalogListing', 7000);
    clock.recordSend(MFC, 'fetchBody', 14_000);
    expect(clock.summaryLines(14_000)).toEqual([`[HOST-CLOCK] summary host=${MFC} sends=3 minGapMs=7000 underFloor=0`]);
  });
});

describe('the process clock and the process seed', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    setHostClock(null);
    setProcessSeed(null);
  });

  it('a process seed is one 32-bit integer, the same for the whole process, replaceable in tests', () => {
    const seed = getProcessSeed();
    expect(Number.isInteger(seed)).toBe(true);
    expect(seed).toBeGreaterThanOrEqual(0);
    expect(seed).toBeLessThan(2 ** 32);
    expect(getProcessSeed()).toBe(seed);
    setProcessSeed(99);
    expect(getProcessSeed()).toBe(99);
  });

  it('reads the jitter, slack, min fetch and catalog timeout from the environment, with the process seed', () => {
    setProcessSeed(5);
    process.env.SCRAPE_HOST_CLOCK = 'all';
    process.env.SCRAPE_DISPATCH_JITTER_MS = `${MFC}=2000,bad`;
    process.env.SCRAPE_CATALOG_CLOCK_WAIT_SLACK_MS = '1000';
    process.env.SCRAPE_CATALOG_MIN_FETCH_MS = '20000';
    process.env.CATALOG_STORE_TIMEOUT_MS = '45000';
    const clock = getHostClock();
    clock.setFloorSource(host => (host === MFC ? FLOOR : undefined));
    expect(clock.jitterMsFor(MFC)).toBe(2000);
    expect(clock.capMsFor(MFC)).toBe(10_000);
    expect(clock.ceilingMs()).toBe(24_000);
    expect(clock.warnings()).toEqual(['[HOST-CLOCK] WARN SCRAPE_DISPATCH_JITTER_MS entry "bad" is not host=ms; ignored']);
    expect(clock.bootLines([MFC])[0]).toContain('process seed 5');
  });

  it('a slack or min fetch that is not a non-negative whole number falls back to the default', () => {
    process.env.SCRAPE_HOST_CLOCK = 'all';
    process.env.SCRAPE_CATALOG_CLOCK_WAIT_SLACK_MS = '-5';
    process.env.SCRAPE_CATALOG_MIN_FETCH_MS = 'abc';
    process.env.CATALOG_STORE_TIMEOUT_MS = '60000';
    const clock = getHostClock();
    clock.setFloorSource(host => (host === MFC ? FLOOR : undefined));
    expect(clock.capMsFor(MFC)).toBe(10_000);
    expect(clock.ceilingMs()).toBe(27_000);
  });

  it('with CATALOG_STORE_TIMEOUT_MS unset the budget is the catalog default (30 s), so every host is recorded only', () => {
    process.env.SCRAPE_HOST_CLOCK = 'all';
    delete process.env.CATALOG_STORE_TIMEOUT_MS;
    const clock = getHostClock();
    clock.setFloorSource(host => (host === MFC ? FLOOR : undefined));
    expect(clock.ceilingMs()).toBe(-3000);
    expect(clock.blockingRole(MFC)).toBe('recorded');
  });
});
