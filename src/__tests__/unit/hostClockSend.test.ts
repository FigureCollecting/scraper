/**
 * hostClockSend — the SEND BLOCK every QB-U30b blocking caller runs (plan-v3 rev 7,
 * design.host_clock.split_interface): reserve (refused past the cap), the WAIT RULE (sleep the
 * remainder of a valid slot, re-book only a LOST one, every non-sending iteration yields to a timer),
 * then in one synchronous block: the gate, settle, INVOKE the transport, record the send, then await.
 * A host above the ceiling is recorded only; a host off the clock only feeds the observer.
 * Fake time and a recording fake transport: no network.
 */
import { HostClock, parseHostClockScope, type HostClockCaller, type HostClockOptions } from '../../services/hostClock';
import {
  HostClockRefusedError,
  hostOfUrl,
  processHostClockPacer,
  sendOnHostClock,
  sendOnHostClockOrThrow,
  type ClockedSendDeps,
} from '../../services/hostClockSend';
import { setHostClock } from '../../services/hostClock';

const MFC = 'myfigurecollection.net';
const FLOOR = 7000;

/** A fake time line: sleep(ms) moves it by ms (plus any scripted lateness). */
function timeline(start = 0) {
  let t = start;
  const sleeps: number[] = [];
  const deps = (clock: HostClock, late: (n: number) => number = () => 0): ClockedSendDeps => ({
    clock,
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms + late(sleeps.length);
    },
  });
  return { now: () => t, set: (v: number) => { t = v; }, sleeps, deps };
}

function clockOn(raw = MFC, options: HostClockOptions = {}, floors: Record<string, number> = { [MFC]: FLOOR }): HostClock {
  const clock = new HostClock(parseHostClockScope(raw), raw, options);
  clock.setFloorSource(host => floors[host]);
  return clock;
}

const sends = (clock: HostClock, at: number, caller: HostClockCaller) => clock.view(at).hosts[0]?.sends60m[caller] ?? 0;

describe('hostOfUrl', () => {
  it('is the hostname, or undefined for an unparseable url', () => {
    expect(hostOfUrl(`https://www.${MFC}/item/1`)).toBe(`www.${MFC}`);
    expect(hostOfUrl('not a url')).toBeUndefined();
  });
});

describe('sendOnHostClock', () => {
  it('a host off the clock: invoked at once with the whole budget, recorded for the observer only', async () => {
    const clock = clockOn('off');
    const tl = timeline(1000);
    const invoke = jest.fn(async (timeoutMs: number | undefined) => `body ${timeoutMs}`);
    const result = await sendOnHostClock({ host: MFC, caller: 'catalogListing', budgetMs: 60_000 }, invoke, tl.deps(clock));
    expect(result).toEqual({ sent: true, value: 'body 60000', waitedMs: 0 });
    expect(tl.sleeps).toEqual([]);
    expect(sends(clock, 1000, 'catalogListing')).toBe(1);
    // Nothing booked or stamped on the clock.
    expect(clock.tryAcquire(MFC, 1000, FLOOR)).toBe(0);
  });

  it('a clocked host: waits for the slot after the last send, then invokes, records and awaits', async () => {
    const clock = clockOn();
    clock.tryAcquire(MFC, 0, FLOOR);
    clock.settle(MFC, 0, FLOOR);
    const tl = timeline(2000);
    const entries: number[] = [];
    const gateInside: number[] = [];
    const result = await sendOnHostClock(
      { host: MFC, caller: 'catalogListing', budgetMs: 60_000 },
      async timeoutMs => {
        entries.push(tl.now());
        // Settled BEFORE the transport is invoked: inside it the gate is already shut for a floor.
        gateInside.push(clock.msUntilSendable(MFC, tl.now(), tl.now(), FLOOR));
        return timeoutMs;
      },
      tl.deps(clock),
    );
    expect(entries).toEqual([FLOOR]);
    expect(gateInside).toEqual([FLOOR]);
    // The fetch's timeout is the budget minus the wait actually spent.
    expect(result).toEqual({ sent: true, value: 60_000 - 5000, waitedMs: 5000 });
    expect(tl.sleeps).toEqual([5000]);
    const [mfc] = clock.view(FLOOR).hosts;
    expect(mfc.sends60m.catalogListing).toBe(1);
    expect(mfc.lastSendAt).toBe(new Date(FLOOR).toISOString());
    // A send that waited for the clock is a constrained one.
    expect(mfc.constrainedGaps60m).toBe(0); // its predecessor (t=0) was never recorded: no gap
  });

  it('records the instant AFTER the transport was invoked: 1 ms of synchronous work before the transport entry moves the stamp with it', async () => {
    const clock = clockOn();
    const tl = timeline(0);
    const entries: number[] = [];
    await sendOnHostClock(
      { host: MFC, caller: 'resolve' },
      () => {
        tl.set(tl.now() + 1); // dispatcher work between the gate and the transport's entry
        entries.push(tl.now());
        return Promise.resolve('ok');
      },
      tl.deps(clock),
    );
    expect(entries).toEqual([1]);
    expect(clock.view(1).hosts[0].lastSendAt).toBe(new Date(1).toISOString());
    // The next request is a full floor after the transport entry, not after the gate.
    expect(clock.tryAcquire(MFC, FLOOR, FLOOR)).toBe(1);
    expect(clock.tryAcquire(MFC, FLOOR + 1, FLOOR)).toBe(0);
  });

  it('a mutant that records before invoking would leave the next send 1 ms short (the order is load-bearing)', async () => {
    // The first caller does 1 ms of synchronous work before its transport entry, the second none.
    const clock = clockOn();
    const tl = timeline(0);
    const wire: number[] = [];
    const slow = () => {
      tl.set(tl.now() + 1);
      wire.push(tl.now());
      return Promise.resolve('ok');
    };
    const fast = () => {
      wire.push(tl.now());
      return Promise.resolve('ok');
    };
    await sendOnHostClock({ host: MFC, caller: 'resolve' }, slow, tl.deps(clock));
    await sendOnHostClock({ host: MFC, caller: 'catalogListing' }, fast, tl.deps(clock));
    expect(wire).toEqual([1, 1 + FLOOR]);
  });

  it('a transport that rejects still counts as sent, and the error reaches the caller', async () => {
    const clock = clockOn();
    const tl = timeline(0);
    await expect(sendOnHostClock({ host: MFC, caller: 'lookup', latency: 'lookup' }, () => Promise.reject(new Error('socket hang up')), tl.deps(clock))).rejects.toThrow('socket hang up');
    expect(sends(clock, 0, 'lookup')).toBe(1);
    expect(clock.tryAcquire(MFC, 1, FLOOR)).toBe(FLOOR - 1);
  });

  it('two stacked blocking reservations beyond the cap: the second is refused, sends nothing and is counted under its caller', async () => {
    const clock = clockOn(MFC, { jitterMs: () => 2000, waitSlackMs: 3000, jitterRng: () => () => 0 });
    const tl = timeline(0);
    clock.tryAcquire(MFC, 0, FLOOR);
    clock.settle(MFC, 0, FLOOR);
    // The first blocking caller books 7000 (and sleeps).
    expect(clock.reserve(MFC, 0, FLOOR)).toBe(FLOOR);
    const invoke = jest.fn(async () => 'x');
    const result = await sendOnHostClock({ host: MFC, caller: 'catalogSeed', budgetMs: 60_000 }, invoke, tl.deps(clock));
    expect(result).toEqual({ sent: false, refused: true, waitMs: 2 * FLOOR });
    expect(invoke).not.toHaveBeenCalled();
    expect(tl.sleeps).toEqual([]);
    expect(clock.view(0).hosts[0].clockRefusals60m.catalogSeed).toBe(1);
    // ...and booked nothing: the next free slot is still 14000.
    expect(clock.reserve(MFC, 1, FLOOR)).toBe(2 * FLOOR);
  });

  it('sendOnHostClockOrThrow turns a refusal into a HostClockRefusedError naming host, caller and wait', async () => {
    const clock = clockOn(MFC, { waitSlackMs: 0 });
    const tl = timeline(0);
    clock.tryAcquire(MFC, 0, FLOOR);
    clock.reserve(MFC, 0, FLOOR);
    const error = await sendOnHostClockOrThrow({ host: MFC, caller: 'fetchBody' }, async () => 'x', tl.deps(clock)).catch(e => e);
    expect(error).toBeInstanceOf(HostClockRefusedError);
    expect(error).toMatchObject({ host: MFC, caller: 'fetchBody', waitMs: 2 * FLOOR });
    expect(error.message).toBe(`[HOST-CLOCK] ${MFC} refused a fetchBody send: its slot is 14000 ms away, past the 7000 ms cap`);
    await expect(sendOnHostClockOrThrow({ host: 'other.example', caller: 'fetchBody' }, async () => 'y', tl.deps(clock))).resolves.toBe('y');
  });

  it('sendOnHostClockOrThrow rejects with the veto reason when the gate vetoes the send', async () => {
    const clock = clockOn();
    const tl = timeline(0);
    clock.tryAcquire(MFC, 0, FLOOR);
    await expect(sendOnHostClockOrThrow({ host: MFC, caller: 'scrape', veto: () => 'cooling' }, async () => 'x', tl.deps(clock))).rejects.toThrow('cooling');
  });

  it('a host above the ceiling (sugotoys-like, floor 45000) is recorded only: no wait, and the queue then waits a full floor', async () => {
    const floors = { 'sugotoys.example': 45_000 };
    const clock = clockOn('all', { blockingBudgetMs: 60_000 }, floors);
    expect(clock.blockingRole('sugotoys.example')).toBe('recorded');
    const tl = timeline(0);
    clock.tryAcquire('sugotoys.example', 0, 45_000);
    tl.set(2000);
    const result = await sendOnHostClock({ host: 'sugotoys.example', caller: 'lookup', budgetMs: 35_000 }, async t => t, tl.deps(clock));
    expect(result).toEqual({ sent: true, value: 35_000, waitedMs: 0 });
    expect(tl.sleeps).toEqual([]);
    expect(clock.tryAcquire('sugotoys.example', 46_999, 45_000)).toBe(1);
    expect(clock.tryAcquire('sugotoys.example', 47_000, 45_000)).toBe(0);
    expect(clock.view(47_000).hosts[0].sends60m.lookup).toBe(1);
  });

  describe('the WAIT RULE', () => {
    it("a valid slot whose gate another caller's late send pushed out sleeps the remainder and is NOT re-booked (7000, not 14000)", async () => {
      const clock = clockOn();
      const tl = timeline(0);
      clock.tryAcquire(MFC, 0, FLOOR);
      const reserve = jest.spyOn(clock, 'reserve');
      const entries: number[] = [];
      const pending = sendOnHostClock({ host: MFC, caller: 'catalogListing' }, async () => { entries.push(tl.now()); return 'x'; }, {
        ...tl.deps(clock),
        sleep: async (ms: number) => {
          tl.sleeps.push(ms);
          if (tl.sleeps.length === 1) clock.settle(MFC, 600, FLOOR); // the queue's record really left at 600
          tl.set(tl.now() + ms);
        },
      });
      await pending;
      expect(entries).toEqual([7600]);
      expect(tl.sleeps).toEqual([7000, 600]);
      expect(reserve).toHaveBeenCalledTimes(1);
    });

    it('a LOST slot (the queue took the host while this caller slept) is booked again behind it', async () => {
      const clock = clockOn();
      const tl = timeline(0);
      clock.tryAcquire(MFC, 0, FLOOR);
      const entries: number[] = [];
      await sendOnHostClock({ host: MFC, caller: 'resolve' }, async () => { entries.push(tl.now()); return 'x'; }, {
        ...tl.deps(clock),
        sleep: async (ms: number) => {
          tl.sleeps.push(ms);
          if (tl.sleeps.length === 1) {
            // Woken very late: the queue polled at 14050 and dispatched first.
            tl.set(14_050);
            expect(clock.tryAcquire(MFC, 14_050, FLOOR)).toBe(0);
            clock.settle(MFC, 14_050, FLOOR);
            tl.set(14_100);
            return;
          }
          tl.set(tl.now() + ms);
        },
      });
      expect(entries).toEqual([21_050]);
    });

    it('an early timer never sends before the slot', async () => {
      const clock = clockOn();
      const tl = timeline(0);
      clock.tryAcquire(MFC, 0, FLOOR);
      const entries: number[] = [];
      await sendOnHostClock({ host: MFC, caller: 'scrape' }, async () => { entries.push(tl.now()); return 'x'; }, tl.deps(clock, n => (n === 1 ? -1 : 0)));
      expect(entries).toEqual([FLOOR]);
      expect(tl.sleeps).toEqual([FLOOR, 1]);
    });

    it('every iteration that does not send yields to a timer (a clock that never advances never spins in microtasks)', async () => {
      const clock = clockOn();
      clock.tryAcquire(MFC, 0, FLOOR);
      let sleeps = 0;
      const invoke = jest.fn(async () => 'x');
      const result = sendOnHostClock({ host: MFC, caller: 'pluginRoute' }, invoke, {
        clock,
        now: () => 0,
        sleep: async () => {
          sleeps += 1;
          if (sleeps === 5) throw new Error('stop');
        },
      });
      await expect(result).rejects.toThrow('stop');
      expect(sleeps).toBe(5);
      expect(invoke).not.toHaveBeenCalled();
    });

    it('a cooldown that opened while waiting vetoes the send: no request, no stamp, no refusal counted', async () => {
      const clock = clockOn();
      const tl = timeline(0);
      clock.tryAcquire(MFC, 0, FLOOR);
      const invoke = jest.fn(async () => 'x');
      const settle = jest.spyOn(clock, 'settle');
      let cooling = false;
      const result = await sendOnHostClock({ host: MFC, caller: 'catalogRotating', veto: () => (cooling ? 'host cooling' : undefined) }, invoke, {
        ...tl.deps(clock),
        sleep: async (ms: number) => { cooling = true; tl.set(tl.now() + ms); },
      });
      expect(result).toEqual({ sent: false, refused: false, reason: 'host cooling' });
      expect(invoke).not.toHaveBeenCalled();
      expect(settle).not.toHaveBeenCalled();
      expect(clock.view(FLOOR).hosts[0].clockRefusals60m.catalogRotating).toBe(0);
    });

    it('a re-booked lost slot whose total wait passes the cap is refused at the gate (so wait + fetch stays within the budget)', async () => {
      const clock = clockOn(MFC, { minFetchMs: 30_000, blockingBudgetMs: 60_000 });
      const tl = timeline(0);
      clock.tryAcquire(MFC, 0, FLOOR);
      const invoke = jest.fn(async () => 'x');
      const result = await sendOnHostClock({ host: MFC, caller: 'catalogListing', budgetMs: 60_000 }, invoke, {
        ...tl.deps(clock),
        sleep: async (ms: number) => {
          tl.sleeps.push(ms);
          if (tl.sleeps.length === 1) {
            tl.set(25_000); // a very late wake: the queue took the host meanwhile
            clock.tryAcquire(MFC, 25_000, FLOOR);
            clock.settle(MFC, 25_000, FLOOR);
            return;
          }
          tl.set(tl.now() + ms);
        },
      });
      // Re-booked for 32000: a 32 s wait is past the 10 s cap (it would leave 28 s of the 60 s budget).
      expect(result).toEqual({ sent: false, refused: true, waitMs: 32_000 });
      expect(invoke).not.toHaveBeenCalled();
      expect(clock.view(32_000).hosts[0].clockRefusals60m.catalogListing).toBe(1);
    });

    it('a wait exactly at the cap still sends', async () => {
      const clock = clockOn(MFC, { minFetchMs: 53_000, blockingBudgetMs: 60_000, waitSlackMs: 0 });
      const tl = timeline(0);
      clock.tryAcquire(MFC, 0, FLOOR);
      const result = await sendOnHostClock({ host: MFC, caller: 'catalogListing', budgetMs: 60_000 }, async t => t, tl.deps(clock));
      expect(result).toEqual({ sent: true, value: 53_000, waitedMs: FLOOR });
    });
  });

  describe("the caller's own budget (closeout round 1: /lookup's 15 s / 35 s budget against the catalog's 60 s)", () => {
    const ANITOYS = 'anitoys.example';
    const clock = () => clockOn('all', { blockingBudgetMs: 60_000 }, { [ANITOYS]: 20_000 });

    it('a host the caller cannot wait for and keep its minimum fetch is RECORDED: sent at once with the whole budget, the queue then waits a full floor', async () => {
      const c = clock();
      const tl = timeline(1_000_000);
      c.tryAcquire(ANITOYS, 1_000_000, 20_000);
      c.settle(ANITOYS, 1_000_000, 20_000);
      tl.set(1_000_500);
      const invoke = jest.fn(async (timeoutMs: number | undefined) => timeoutMs);
      // 15 s budget, 15 s minimum fetch: 15000 - 3000 - 15000 < 20000, so /lookup does not wait here.
      const result = await sendOnHostClock({ host: ANITOYS, caller: 'lookup', budgetMs: 15_000, minFetchMs: 15_000 }, invoke, tl.deps(c));
      expect(result).toEqual({ sent: true, value: 15_000, waitedMs: 0 });
      expect(tl.sleeps).toEqual([]);
      expect(c.tryAcquire(ANITOYS, 1_020_499, 20_000)).toBe(1);
      expect(c.tryAcquire(ANITOYS, 1_020_500, 20_000)).toBe(0);
      expect(c.view(1_020_500).hosts[0].sends60m.lookup).toBe(1);
    });

    it('the same host with a budget that keeps the minimum fetch after the cap is clocked: it waits, and the fetch gets the budget minus the wait', async () => {
      const c = clock();
      const tl = timeline(1_000_000);
      c.tryAcquire(ANITOYS, 1_000_000, 20_000);
      c.settle(ANITOYS, 1_000_000, 20_000);
      tl.set(1_000_500);
      // 45000 - 3000 - 15000 = 27000 >= 20000: clocked.
      const result = await sendOnHostClock({ host: ANITOYS, caller: 'lookup', budgetMs: 45_000, minFetchMs: 15_000 }, async t => t, tl.deps(c));
      expect(result).toEqual({ sent: true, value: 45_000 - 19_500, waitedMs: 19_500 });
    });

    it("without a minimum fetch of its own a caller keeps the clock's (SCRAPE_CATALOG_MIN_FETCH_MS): its budget alone decides", async () => {
      const c = clockOn('all', { blockingBudgetMs: 60_000, minFetchMs: 30_000 }, { [ANITOYS]: 20_000 });
      const tl = timeline(0);
      c.tryAcquire(ANITOYS, 0, 20_000);
      // 35000 - 3000 - 30000 = 2000 < 20000: recorded, at once.
      const result = await sendOnHostClock({ host: ANITOYS, caller: 'catalogListing', budgetMs: 35_000 }, async t => t, tl.deps(c));
      expect(result).toEqual({ sent: true, value: 35_000, waitedMs: 0 });
    });

    it('a send whose wait would leave the fetch no time at all is refused at the gate, never invoked with a timeout <= 0', async () => {
      // slack 0 and min fetch 0: the cap (floor) equals the budget, so a full-floor wait leaves 0 ms.
      const c = clockOn(MFC, { waitSlackMs: 0, minFetchMs: 0, blockingBudgetMs: 60_000 });
      const tl = timeline(0);
      c.tryAcquire(MFC, 0, FLOOR);
      c.settle(MFC, 0, FLOOR);
      const invoke = jest.fn(async (t: number | undefined) => t);
      const result = await sendOnHostClock({ host: MFC, caller: 'lookup', budgetMs: FLOOR, minFetchMs: 0 }, invoke, tl.deps(c));
      expect(result).toEqual({ sent: false, refused: true, waitMs: FLOOR });
      expect(invoke).not.toHaveBeenCalled();
      expect(c.view(FLOOR).hosts[0].clockRefusals60m.lookup).toBe(1);
      // One ms more budget: sent with 1 ms (behind the refused send's booking, a floor later).
      const sent = await sendOnHostClock({ host: MFC, caller: 'lookup', budgetMs: FLOOR + 1, minFetchMs: 0 }, invoke, tl.deps(c));
      expect(sent).toEqual({ sent: true, value: 1, waitedMs: FLOOR });
    });
  });

  it("notes the caller's whole latency (wait + fetch) for the listing and /lookup percentiles, success or failure", async () => {
    const clock = clockOn('all', {}, { [MFC]: FLOOR, 'shop.example': 1000 });
    const tl = timeline(0);
    clock.tryAcquire(MFC, 0, FLOOR);
    await sendOnHostClock({ host: MFC, caller: 'catalogListing', latency: 'listing' }, async () => { tl.set(tl.now() + 400); return 'x'; }, tl.deps(clock));
    await sendOnHostClock({ host: 'shop.example', caller: 'lookup', latency: 'lookup' }, async () => { tl.set(tl.now() + 250); throw new Error('boom'); }, tl.deps(clock)).catch(() => undefined);
    const view = clock.view(tl.now());
    expect(view.hosts.find(h => h.host === MFC)?.listingFetchP99Ms60m).toBe(FLOOR + 400);
    expect(view.hosts.find(h => h.host === 'shop.example')?.lookupP95Ms60m).toBe(250);
  });

  it('defaults to the process clock, Date.now and a real timer', async () => {
    const clock = clockOn('off');
    setHostClock(clock);
    try {
      await expect(sendOnHostClock({ host: MFC, caller: 'scrape' }, async () => 'x')).resolves.toMatchObject({ sent: true, value: 'x' });
      expect(sends(clock, Date.now(), 'scrape')).toBe(1);
    } finally {
      setHostClock(null);
    }
  });
});

describe('processHostClockPacer (a transport that sends more than one request per call)', () => {
  afterEach(() => setHostClock(null));

  it('send() runs the full send block under the given caller and throws on a refusal', async () => {
    const clock = clockOn(MFC, { waitSlackMs: 0 });
    setHostClock(clock);
    const pacer = processHostClockPacer();
    await expect(pacer.send(`https://${MFC}/`, 'sessionPrime', async () => 'primed')).resolves.toBe('primed');
    expect(clock.view(Date.now()).hosts[0].sends60m.sessionPrime).toBe(1);
    clock.reserve(MFC, Date.now(), FLOOR);
    await expect(pacer.send(`https://${MFC}/`, 'sessionPrime', async () => 'x')).rejects.toBeInstanceOf(HostClockRefusedError);
  });

  it('send() on an unparseable url just invokes', async () => {
    setHostClock(clockOn());
    await expect(processHostClockPacer().send('not a url', 'sessionPrime', async () => 'y')).resolves.toBe('y');
  });

  it('holds(url) answers whether the clock covers the url\'s host; holds() whether it covers any host', () => {
    setHostClock(clockOn(MFC));
    const pacer = processHostClockPacer();
    expect(pacer.holds(`https://www.${MFC}/item/1`)).toBe(true);
    expect(pacer.holds('https://hpoi.net/x')).toBe(false);
    expect(pacer.holds('not a url')).toBe(false);
    expect(pacer.holds()).toBe(true);
    setHostClock(clockOn('all,-hpoi.net'));
    expect(pacer.holds('https://hpoi.net/x')).toBe(false);
    expect(pacer.holds('https://late.example/x')).toBe(true);
    expect(pacer.holds()).toBe(true);
    setHostClock(clockOn('off'));
    expect(pacer.holds(`https://${MFC}/`)).toBe(false);
    expect(pacer.holds()).toBe(false);
  });

  it('observe() feeds the observer at its instant, waiting and booking nothing', () => {
    const clock = clockOn('off');
    setHostClock(clock);
    const pacer = processHostClockPacer({ now: () => 4000 });
    pacer.observe(`https://${MFC}/item/1`, 'pluginRoute');
    pacer.observe('not a url', 'pluginRoute');
    const [mfc] = clock.view(4000).hosts;
    expect(mfc.sends60m.pluginRoute).toBe(1);
    expect(mfc.lastSendAt).toBe(new Date(4000).toISOString());
    expect(clock.tryAcquire(MFC, 4000, FLOOR)).toBe(0);
  });

  it('first() raises the last send to the instant the first request of a call really leaves', () => {
    const clock = clockOn();
    setHostClock(clock);
    clock.settle(MFC, 1000, FLOOR);
    const pacer = processHostClockPacer({ now: () => 1500 });
    pacer.first(`https://www.${MFC}/`);
    pacer.first('not a url');
    expect(clock.tryAcquire(MFC, 8499, FLOOR)).toBe(1);
    expect(clock.tryAcquire(MFC, 8500, FLOOR)).toBe(0);
  });
});
