/**
 * QB-U8 (Ross QB-4 "yes", 2026-10-04): MFC main-host image fetches on the SHARED per-host clock.
 *
 * The defect: the image lane builds `new HostRateLimiter(() => undefined)`, so myfigurecollection.net
 * (explicit items' plates ride the main host's `?_tb=commit&commit=nsp` route) is paced by the
 * limiter's DEFAULT config: 2067 ms, recovering /1.4 every 3 successes down to 274 ms. After about 18
 * clean GETs the image gap is ~274 ms while MFC records are 7 s apart.
 *
 * The fix under test: a host the clock covers (SCRAPE_HOST_CLOCK scope + a store floor) books every
 * image on the same clock as the queue's record dispatch, at the store's floor. Everything the clock
 * does not cover keeps today's limiter pacing exactly. Fake clocks throughout, no network.
 */
import { HostRateLimiter } from '../../driver/hostRateLimiter';
import { ChallengeCooldown } from '../../services/challengeCooldown';
import { HostClock, parseHostClockScope, setHostClock } from '../../services/hostClock';
import { paceImageBytesByHost } from '../../services/images/imageBytesPacing';
import type { ImageBytesResult } from '../../services/images/imageBytes';
import { U30B_FIELDS, U30B_SENDS } from '../helpers/hostClockU30bFields';

const MFC = 'myfigurecollection.net';
const FLOOR = 7000;
const nsp = (id: number) => `https://${MFC}/?_tb=commit&commit=nsp&objectType=item&objectId=${id}&size=1`;
const noCooldown = { remaining: () => 0 };

const ok = (): ImageBytesResult => ({
  ok: true,
  bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  contentType: 'image/png',
  status: 200,
  finalUrl: nsp(1),
  headers: {},
});
const throttled = (): ImageBytesResult => ({ ok: false, reason: 'http-status', status: 429, detail: 'HTTP 429' });

/** An MFC-scoped clock whose floor source knows the main host as a store host at 7000 ms. */
function mfcClock(scope = MFC): HostClock {
  const clock = new HostClock(parseHostClockScope(scope), scope);
  clock.setFloorSource(host => (host === MFC ? FLOOR : undefined));
  return clock;
}

/** The smallest gap between consecutive times (Infinity for fewer than two). */
function minGap(times: number[]): number {
  const sorted = [...times].sort((a, b) => a - b);
  let min = Infinity;
  for (let i = 1; i < sorted.length; i++) min = Math.min(min, sorted[i] - sorted[i - 1]);
  return min;
}

/**
 * The production limiter (DEFAULT config, as assembleImageCapture builds it), a scripted fetcher that
 * stamps each call with the fake time, and a sleeper that advances that time.
 */
function harness(hostClock: HostClock, script: (url: string, n: number) => ImageBytesResult = () => ok()) {
  let now = 0;
  const calls: Array<{ url: string; at: number }> = [];
  const slept: number[] = [];
  const fetcher = jest.fn(async (url: string) => {
    calls.push({ url, at: now });
    return script(url, calls.length);
  });
  const paced = paceImageBytesByHost(fetcher, new HostRateLimiter(() => undefined), {
    now: () => now,
    sleep: async (ms: number) => { slept.push(ms); now += ms; },
    cooldown: noCooldown,
    hostClock,
  });
  return { paced, calls, slept, fetcher, advance: (ms: number) => { now += ms; }, now: () => now };
}

describe('paceImageBytesByHost on the shared host clock (QB-U8)', () => {
  it('never lets two MFC main-host images closer than the 7000 ms floor through successes, failures and recovery', async () => {
    // 20 clean GETs (the limiter alone would recover toward 274 ms), 5 throttles (backoff), 15 clean
    // again (recovery): the clock's floor must hold at every step.
    const outcome = (n: number) => (n > 20 && n <= 25 ? throttled() : ok());
    const { paced, calls } = harness(mfcClock(), (_url, n) => outcome(n));

    for (let id = 1; id <= 40; id++) await paced(nsp(id));

    expect(calls).toHaveLength(40);
    expect(minGap(calls.map(c => c.at))).toBeGreaterThanOrEqual(FLOOR);
  });

  it('shares the clock with record dispatch: the merged MFC timeline has no gap under the floor', async () => {
    const clock = mfcClock();
    const { paced, calls, advance, now } = harness(clock, (_url, n) => (n % 7 === 0 ? throttled() : ok()));
    const records: number[] = [];
    // The queue polls without blocking; an image books its slot and waits for it. Every third poll
    // comes after the floor has passed, so records and images genuinely interleave.
    for (let id = 1; id <= 25; id++) {
      advance(id % 3 === 0 ? 9000 : 1500);
      if (clock.tryAcquire(MFC, now(), FLOOR) === 0) records.push(now());
      await paced(nsp(id));
    }

    expect(records.length).toBeGreaterThanOrEqual(8);
    expect(calls).toHaveLength(25);
    expect(minGap([...records, ...calls.map(c => c.at)])).toBeGreaterThanOrEqual(FLOOR);
  });

  it('books the image slot BEFORE it waits, so a record poll during the wait is refused', async () => {
    const clock = mfcClock();
    expect(clock.tryAcquire(MFC, 0, FLOOR)).toBe(0); // a record dispatched at t=0
    let release!: () => void;
    let now = 1000;
    const paced = paceImageBytesByHost(jest.fn(async () => ok()), new HostRateLimiter(() => undefined), {
      now: () => now,
      sleep: () => new Promise<void>(resolve => { release = () => { now = 7000; resolve(); }; }),
      cooldown: noCooldown,
      hostClock: clock,
    });

    const pending = paced(nsp(1));
    for (let i = 0; i < 5; i++) await Promise.resolve();
    // The image is asleep until 7000 and already holds that slot: the next record waits to 14000.
    expect(clock.tryAcquire(MFC, 2000, FLOOR)).toBe(12_000);
    release();
    await pending;
    expect(clock.tryAcquire(MFC, 13_999, FLOOR)).toBe(1);
  });

  it('serialises concurrent main-host images on the floor (real timers faked, default sleep)', async () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(0);
      const calls: number[] = [];
      const paced = paceImageBytesByHost(jest.fn(async () => { calls.push(Date.now()); return ok(); }), new HostRateLimiter(() => undefined), {
        cooldown: noCooldown,
        hostClock: mfcClock(),
      });
      const all = Promise.all([1, 2, 3, 4, 5].map(id => paced(nsp(id))));
      await jest.advanceTimersByTimeAsync(40_000);
      await all;
      expect(calls).toEqual([0, 7000, 14_000, 21_000, 28_000]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps the booking when the fetch throws: the next image still waits the floor', async () => {
    const { paced, calls } = harness(mfcClock(), (_url, n) => {
      if (n === 1) throw new Error('socket hang up');
      return ok();
    });
    await expect(paced(nsp(1))).rejects.toThrow('socket hang up');
    await paced(nsp(2));
    expect(calls.map(c => c.at)).toEqual([0, 7000]);
  });

  it('books nothing for a host cooling from a challenge', async () => {
    const clock = mfcClock();
    const fetcher = jest.fn(async () => ok());
    const paced = paceImageBytesByHost(fetcher, new HostRateLimiter(() => undefined), {
      now: () => 0,
      sleep: async () => undefined,
      cooldown: { remaining: host => (host === MFC ? 60_000 : 0) },
      hostClock: clock,
    });
    const result = await paced(nsp(1));
    expect(result.ok).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    expect(clock.tryAcquire(MFC, 0, FLOOR)).toBe(0);
  });

  it('waits the longer of the limiter and the clock: a backed-off limiter still governs past the floor', async () => {
    const clock = mfcClock();
    let now = 0;
    const calls: number[] = [];
    const slow = { baseDelayMs: 20_000, minDelayMs: 20_000, maxDelayMs: 60_000, backoffMultiplier: 2, recoveryDivisor: 2, successThreshold: 3 };
    const paced = paceImageBytesByHost(jest.fn(async () => { calls.push(now); return ok(); }), new HostRateLimiter(() => slow, slow), {
      now: () => now,
      sleep: async (ms: number) => { now += ms; },
      cooldown: noCooldown,
      hostClock: clock,
    });
    await paced(nsp(1));
    await paced(nsp(2));
    expect(calls).toEqual([0, 20_000]);
    // ...and the clock booked the limiter's later slot, not the floor's earlier one.
    expect(clock.tryAcquire(MFC, 26_999, FLOOR)).toBe(1);
  });

  describe('spacing is kept from when an image REALLY leaves (late and early timers, lost slots, cooldowns)', () => {
    /** An MFC-scoped clock with a record dispatched at t=0, and a pacer whose sleeper the test scripts. */
    function scripted(sleep: (ms: number, at: () => number, set: (t: number) => void) => void, cooldown = noCooldown as { remaining(host: string): number }) {
      const clock = mfcClock();
      expect(clock.tryAcquire(MFC, 0, FLOOR)).toBe(0);
      let now = 500;
      const calls: number[] = [];
      const fetcher = jest.fn(async () => { calls.push(now); return ok(); });
      const limiter = new HostRateLimiter(() => undefined);
      const paced = paceImageBytesByHost(fetcher, limiter, {
        now: () => now,
        sleep: async (ms: number) => sleep(ms, () => now, t => { now = t; }),
        cooldown,
        hostClock: clock,
      });
      return { clock, paced, calls, fetcher, limiter };
    }

    it('a late timer: the next image and the next record wait a full floor after the image really left', async () => {
      // The first wake-up is 600 ms late (an event loop busy with a big parse or a GC pause).
      let late = 600;
      const { clock, paced, calls } = scripted((ms, at, set) => { set(at() + ms + late); late = 0; });
      // One after the other: this fake sleeper moves the shared time the moment a sleep begins.
      await paced(nsp(1));
      await paced(nsp(2));
      expect(calls).toEqual([7600, 14_600]);
      expect(clock.tryAcquire(MFC, 21_599, FLOOR)).toBe(1);
    });

    it('an early timer: an image never leaves before its slot', async () => {
      // Node can fire a timer a millisecond before Date.now() reaches its due time.
      let early = 1;
      const { paced, calls } = scripted((ms, at, set) => { set(at() + ms - early); early = 0; });
      await paced(nsp(1));
      expect(calls).toEqual([FLOOR]);
    });

    it('a slot lost while asleep (the queue took the host first) is booked again behind that record', async () => {
      const records = [0];
      let first = true;
      let pollOnNewSlot = -1;
      let clockRef!: HostClock;
      const { clock, paced, calls } = scripted((ms, at, set) => {
        if (first) {
          first = false;
          // The image's timer is so late that the queue polls at 14050 and dispatches record 2 first,
          // stamping it at its transport hand-off as the queue does.
          set(14_050);
          if (clockRef.tryAcquire(MFC, 14_050, FLOOR) === 0) {
            clockRef.settle(MFC, 14_050, FLOOR);
            records.push(14_050);
          }
          set(14_100);
          return;
        }
        // Asleep again on its NEW booking, which the queue sees: a poll at that slot is refused.
        pollOnNewSlot = clockRef.tryAcquire(MFC, 21_050, FLOOR);
        set(at() + ms);
      });
      clockRef = clock;
      await paced(nsp(1));
      expect(records).toEqual([0, 14_050]);
      expect(pollOnNewSlot).toBe(FLOOR);
      expect(calls).toEqual([21_050]);
      expect(minGap([...records, ...calls])).toBeGreaterThanOrEqual(FLOOR);
    });

    it('a challenge cooldown that opens while images wait their turn: they are refused, not fetched', async () => {
      const cooldown = new ChallengeCooldown();
      const { paced, fetcher } = scripted((ms, at, set) => {
        set(at() + ms);
        // e.g. the next record or a /lookup hit a Cloudflare challenge on the host meanwhile
        if (!cooldown.isOpen(MFC)) cooldown.open(MFC, 'challenge page via impersonate transport');
      }, cooldown);
      const results = await Promise.all([paced(nsp(1)), paced(nsp(2))]);
      expect(results.map(r => (r.ok ? 'fetched' : (r as { reason: string }).reason))).toEqual(['refused', 'refused']);
      expect(fetcher).not.toHaveBeenCalled();
    });

    it('stamps the clock and the observer with the instant the image really leaves (booked 7000, timer 600 ms late: 7600)', async () => {
      let late = 600;
      const { clock, paced, calls } = scripted((ms, at, set) => { set(at() + ms + late); late = 0; });
      const settle = jest.spyOn(clock, 'settle');
      const recordSend = jest.spyOn(clock, 'recordSend');
      await paced(nsp(1));
      expect(calls).toEqual([7600]);
      expect(settle.mock.calls).toEqual([[MFC, 7600, FLOOR]]);
      expect(recordSend.mock.calls).toEqual([[MFC, 'image', 7600]]);
      expect(clock.view(7600).hosts).toEqual([{
        host: MFC, floorMs: FLOOR, clocked: true, sends60m: { queue: 0, image: 1, ...U30B_SENDS }, minGapMs60m: 0, underFloor60m: 0, ...U30B_FIELDS,
        lastSendAt: new Date(7600).toISOString(),
      }]);
    });

    it('the send is stamped before the transport is called: inside the fetch the gate is already shut for a floor', async () => {
      const clock = mfcClock();
      const gateInsideFetch: number[] = [];
      const paced = paceImageBytesByHost(jest.fn(async () => { gateInsideFetch.push(clock.msUntilSendable(MFC, 0, 0, FLOOR)); return ok(); }), new HostRateLimiter(() => undefined), {
        now: () => 0,
        sleep: async () => undefined,
        cooldown: noCooldown,
        hostClock: clock,
      });
      await paced(nsp(1));
      expect(gateInsideFetch).toEqual([FLOOR]);
    });

    it('an image refused after its wait stamps nothing, records nothing and books no limiter dispatch', async () => {
      const cooldown = new ChallengeCooldown();
      const { clock, paced, fetcher, limiter } = scripted((ms, at, set) => {
        set(at() + ms);
        if (!cooldown.isOpen(MFC)) cooldown.open(MFC, 'challenge page via impersonate transport');
      }, cooldown);
      const settle = jest.spyOn(clock, 'settle');
      const recordSend = jest.spyOn(clock, 'recordSend');
      const result = await paced(nsp(1));
      expect(result).toMatchObject({ ok: false, reason: 'refused' });
      expect((result as { detail: string }).detail).toMatch(/myfigurecollection\.net began cooling from a Cloudflare challenge while this image waited; another \d+s/);
      expect(fetcher).not.toHaveBeenCalled();
      expect(settle).not.toHaveBeenCalled();
      expect(recordSend).not.toHaveBeenCalled();
      expect(clock.view(7000).hosts[0].sends60m).toEqual({ queue: 0, image: 0, ...U30B_SENDS });
      // The limiter never saw a dispatch either: the host is still "never dispatched" there.
      expect(limiter.msUntilReady(MFC, 7000)).toBe(0);
    });

    it('real timers: a busy event loop delays an image, and the next image and record still wait a full floor after it', async () => {
      // A short floor and a fast limiter keep this to about a second; the clock is what binds.
      const floor = 400;
      const fast = { baseDelayMs: 50, minDelayMs: 50, maxDelayMs: 1000, backoffMultiplier: 2, recoveryDivisor: 2, successThreshold: 3 };
      const clock = new HostClock(parseHostClockScope(MFC));
      clock.setFloorSource(host => (host === MFC ? floor : undefined));
      const sends: number[] = [];
      const paced = paceImageBytesByHost(jest.fn(async () => { sends.push(Date.now()); return ok(); }), new HostRateLimiter(() => fast, fast), {
        cooldown: noCooldown,
        hostClock: clock,
      });
      const busy = (ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { /* a long synchronous parse */ } };

      const t0 = Date.now();
      expect(clock.tryAcquire(MFC, t0, floor)).toBe(0); // record 1
      sends.push(t0);
      const images = Promise.all([paced(nsp(1)), paced(nsp(2))]);
      setTimeout(() => busy(250), floor - 50); // the loop is blocked across image 1's slot
      await images;
      // Record 2, polled the way the queue polls: at the exact wait the clock names.
      for (;;) {
        const wait = clock.tryAcquire(MFC, Date.now(), floor);
        if (wait === 0) break;
        await new Promise(resolve => setTimeout(resolve, wait));
      }
      sends.push(Date.now());

      expect(sends).toHaveLength(4);
      expect(sends[1] - t0).toBeGreaterThanOrEqual(floor + 150); // image 1 really was late
      // Date.now() counts whole milliseconds: a request stamped at the end of one millisecond can be
      // measured in the next, so the measured gap may read one ms short of the floor (the exact
      // guarantee is the fake-clock tests above). Without the fix the gap is ~200 ms short.
      expect(minGap(sends)).toBeGreaterThanOrEqual(floor - 1);
    });
  });

  describe('every other host keeps today\'s pacing exactly', () => {
    /** Run the same script through a wrapper on an OFF clock and on the MFC-scoped clock. */
    async function compare(urls: string[], scope = MFC) {
      const script = (_url: string, n: number) => (n % 5 === 0 ? throttled() : ok());
      const today = harness(new HostClock(parseHostClockScope(undefined)), script);
      const scoped = harness(mfcClock(scope), script);
      for (const url of urls) {
        await today.paced(url);
        await scoped.paced(url);
      }
      return { today, scoped };
    }

    it.each([
      ['static.myfigurecollection.net (the image CDN)', 'https://static.myfigurecollection.net/upload/items/1/1-abc.jpg'],
      ['a shared CDN', 'https://cdn.shopify.com/s/files/1.png'],
      ['another store host', 'https://www.hpoi.net/pictures/1.jpg'],
    ])('%s', async (_label, url) => {
      const urls = Array.from({ length: 30 }, (_v, i) => `${url}?n=${i}`);
      const { today, scoped } = await compare(urls);
      expect(scoped.slept).toEqual(today.slept);
      expect(scoped.calls.map(c => c.at)).toEqual(today.calls.map(c => c.at));
      // Sanity: today's limiter really does recover well under the MFC floor on these hosts.
      expect(minGap(today.calls.map(c => c.at))).toBeLessThan(FLOOR);
    });

    it('a host in an ALL scope that is not a store host (a CDN) stays on its limiter', async () => {
      const urls = Array.from({ length: 30 }, (_v, i) => `https://cdn.shopify.com/s/files/${i}.png`);
      const { today, scoped } = await compare(urls, 'all');
      expect(scoped.slept).toEqual(today.slept);
    });

    it('MFC main-host images too, while the clock is OFF (the default)', async () => {
      const urls = Array.from({ length: 30 }, (_v, i) => nsp(i));
      const off = harness(new HostClock(parseHostClockScope(undefined)));
      for (const url of urls) await off.paced(url);
      // Today's defect, unchanged with the knob off: the limiter recovers to its 274 ms minimum.
      expect(minGap(off.calls.map(c => c.at))).toBe(274);
    });

    it('with the clock OFF the observer still records each main-host image at the instant it is handed to the transport', async () => {
      const off = new HostClock(parseHostClockScope(undefined));
      off.setFloorSource(host => (host === MFC ? FLOOR : undefined));
      const { paced, calls } = harness(off);
      for (let id = 1; id <= 4; id++) await paced(nsp(id));
      await paced('https://static.myfigurecollection.net/upload/items/1/1-abc.jpg');
      const times = calls.filter(c => new URL(c.url).hostname === MFC).map(c => c.at);
      expect(times).toHaveLength(4);
      // Today's limiter pacing, untouched: the first gap is its 2067 ms default.
      expect(times[1] - times[0]).toBe(2067);
      expect(off.view(times[3])).toEqual({ mode: 'off', hosts: [{
        host: MFC, floorMs: FLOOR, clocked: false, sends60m: { queue: 0, image: 4, ...U30B_SENDS }, minGapMs60m: minGap(times), underFloor60m: 3, ...U30B_FIELDS,
        lastSendAt: new Date(times[3]).toISOString(),
      }] });
    });

    it('an in-scope host with no bound floor source stays on its limiter', async () => {
      const unbound = new HostClock(parseHostClockScope(MFC));
      const { paced, calls } = harness(unbound);
      for (let id = 1; id <= 30; id++) await paced(nsp(id));
      expect(minGap(calls.map(c => c.at))).toBe(274);
      expect(unbound.tryAcquire(MFC, 0, FLOOR)).toBe(0);
    });
  });

  it('uses the process clock when none is injected', async () => {
    const clock = mfcClock();
    setHostClock(clock);
    try {
      let now = 0;
      const calls: number[] = [];
      const paced = paceImageBytesByHost(jest.fn(async () => { calls.push(now); return ok(); }), new HostRateLimiter(() => undefined), {
        now: () => now,
        sleep: async (ms: number) => { now += ms; },
        cooldown: noCooldown,
      });
      clock.tryAcquire(MFC, 0, FLOOR);
      await paced(nsp(1));
      expect(calls).toEqual([FLOOR]);
    } finally {
      setHostClock(null);
    }
  });
});
