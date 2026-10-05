/**
 * hostClock — ONE dispatch clock per host, shared by the lanes that reach a store's own host
 * (Ross QB-4 "yes", 2026-10-04; plan-v3 QB-U8, the image half of design.host_clock).
 *
 * The queue's record dispatch is non-blocking (tryAcquire: grant now or say how long), the image
 * bytes lane blocks (reserve: book the next slot at once, so the queue sees it while the image
 * waits). Every booking on a host keeps at least the larger of its own floor and the previous
 * booking's floor from the previous booking. Scope is SCRAPE_HOST_CLOCK (off | all | host csv),
 * default off.
 */
import { HostClock, getHostClock, parseHostClockScope, setHostClock } from '../../services/hostClock';

const MFC = 'myfigurecollection.net';

describe('parseHostClockScope', () => {
  it.each([undefined, '', '   ', 'off', 'OFF', ' Off '])('reads %p as OFF: no host is in scope', raw => {
    const inScope = parseHostClockScope(raw);
    expect(inScope(MFC)).toBe(false);
    expect(inScope('cdn.shopify.com')).toBe(false);
    // `off` is the keyword, never a host named "off".
    expect(inScope('off')).toBe(false);
  });

  it.each(['all', 'ALL', ' all '])('reads %p as every host', raw => {
    const inScope = parseHostClockScope(raw);
    expect(inScope(MFC)).toBe(true);
    expect(inScope('cdn.shopify.com')).toBe(true);
  });

  it('reads a csv as exactly those hosts, normalised (case, www., trailing dot, blanks)', () => {
    const inScope = parseHostClockScope(' MyFigureCollection.net. , ,www.example.com,');
    expect(inScope(MFC)).toBe(true);
    expect(inScope('www.myfigurecollection.net')).toBe(true);
    expect(inScope('MYFIGURECOLLECTION.NET.')).toBe(true);
    expect(inScope('example.com')).toBe(true);
    // A subdomain is a different host: the image CDN stays out of a main-host scope.
    expect(inScope('static.myfigurecollection.net')).toBe(false);
    expect(inScope('hpoi.net')).toBe(false);
    expect(inScope('')).toBe(false);
  });

  it('treats a csv of blanks as off', () => {
    expect(parseHostClockScope(' , ,')(MFC)).toBe(false);
    expect(new HostClock(parseHostClockScope(' , ,'), ' , ,').describe()).toContain('SCRAPE_HOST_CLOCK off');
  });
});

describe('HostClock', () => {
  const clockFor = (scope = MFC) => new HostClock(parseHostClockScope(scope));

  it('grants the first request on an idle host at once and books it', () => {
    const clock = clockFor();
    expect(clock.tryAcquire(MFC, 1_000, 7000)).toBe(0);
    expect(clock.tryAcquire(MFC, 1_001, 7000)).toBe(6999);
  });

  it('refuses until the full floor has passed, then grants exactly at the floor', () => {
    const clock = clockFor();
    clock.tryAcquire(MFC, 0, 7000);
    expect(clock.tryAcquire(MFC, 6999, 7000)).toBe(1);
    expect(clock.tryAcquire(MFC, 7000, 7000)).toBe(0);
    expect(clock.tryAcquire(MFC, 13_999, 7000)).toBe(1);
  });

  it('books nothing on a refusal: the wait is still measured from the last grant', () => {
    const clock = clockFor();
    clock.tryAcquire(MFC, 0, 7000);
    expect(clock.tryAcquire(MFC, 3000, 7000)).toBe(4000);
    expect(clock.tryAcquire(MFC, 5000, 7000)).toBe(2000);
  });

  it('reserve books the earliest slot at once, ahead of time, so a later tryAcquire sees it', () => {
    const clock = clockFor();
    expect(clock.reserve(MFC, 0, 7000)).toBe(0);
    expect(clock.reserve(MFC, 100, 7000)).toBe(7000);
    // The second reservation is booked for 7000 although "now" is still 100.
    expect(clock.tryAcquire(MFC, 200, 7000)).toBe(13_800);
    expect(clock.tryAcquire(MFC, 14_000, 7000)).toBe(0);
    expect(clock.reserve(MFC, 14_500, 7000)).toBe(21_000);
  });

  it('reserve on a host idle for longer than the floor is ready at the asked time', () => {
    const clock = clockFor();
    clock.tryAcquire(MFC, 0, 7000);
    expect(clock.reserve(MFC, 9000, 7000)).toBe(9000);
  });

  it('keeps consecutive bookings at least the LARGER of their two floors apart', () => {
    const clock = clockFor();
    clock.tryAcquire(MFC, 0, 7000);
    // A caller with a smaller floor still waits out the previous booking's 7000.
    expect(clock.tryAcquire(MFC, 2000, 1000)).toBe(5000);
    expect(clock.reserve(MFC, 2000, 1000)).toBe(7000);
    // ...and a caller with a larger floor than the previous booking waits out its own.
    expect(clock.tryAcquire(MFC, 9000, 4000)).toBe(2000);
    expect(clock.reserve(MFC, 9000, 4000)).toBe(11_000);
  });

  it('collapses host spellings onto one booking', () => {
    const clock = clockFor();
    clock.tryAcquire('WWW.MyFigureCollection.net.', 0, 7000);
    expect(clock.tryAcquire(MFC, 10, 7000)).toBe(6990);
  });

  it('keeps hosts independent', () => {
    const clock = clockFor('all');
    clock.tryAcquire(MFC, 0, 7000);
    expect(clock.tryAcquire('hpoi.net', 10, 7000)).toBe(0);
  });

  describe('settle (a blocking caller stamps its own slot with the instant it really sends)', () => {
    it('moves its own booking to a late send, so the next request is spaced from when it really left', () => {
      const clock = clockFor();
      clock.tryAcquire(MFC, 0, 7000);
      expect(clock.reserve(MFC, 100, 7000)).toBe(7000);
      // The timer fired 600 ms late: the image really left at 7600, not at its slot.
      expect(clock.settle('WWW.MyFigureCollection.net.', 7000, 7600)).toBe(true);
      expect(clock.tryAcquire(MFC, 14_000, 7000)).toBe(600);
      expect(clock.reserve(MFC, 8000, 7000)).toBe(14_600);
    });

    it('on time, changes nothing', () => {
      const clock = clockFor();
      clock.tryAcquire(MFC, 0, 7000);
      clock.reserve(MFC, 100, 7000);
      expect(clock.settle(MFC, 7000, 7000)).toBe(true);
      expect(clock.tryAcquire(MFC, 13_999, 7000)).toBe(1);
      expect(clock.tryAcquire(MFC, 14_000, 7000)).toBe(0);
    });

    it('refuses a send before its slot (an early timer) and never moves the booking earlier', () => {
      const clock = clockFor();
      clock.tryAcquire(MFC, 0, 7000);
      clock.reserve(MFC, 100, 7000);
      expect(clock.settle(MFC, 7000, 6999)).toBe(false);
      expect(clock.tryAcquire(MFC, 13_999, 7000)).toBe(1);
    });

    it("refuses a slot that is no longer the host's latest booking, and changes nothing", () => {
      const clock = clockFor();
      expect(clock.reserve(MFC, 0, 7000)).toBe(0);
      // The image slept through its slot; the queue took the host at 7000.
      expect(clock.tryAcquire(MFC, 7000, 7000)).toBe(0);
      expect(clock.settle(MFC, 0, 7100)).toBe(false);
      expect(clock.tryAcquire(MFC, 13_999, 7000)).toBe(1);
    });

    it('refuses on a host with no booking', () => {
      const clock = clockFor('all');
      expect(clock.settle('hpoi.net', 0, 0)).toBe(false);
      expect(clock.tryAcquire('hpoi.net', 0, 7000)).toBe(0);
    });
  });

  it('says which hosts are in scope', () => {
    const clock = clockFor();
    expect(clock.inScope('www.MyFigureCollection.net')).toBe(true);
    expect(clock.inScope('static.myfigurecollection.net')).toBe(false);
  });

  describe('floorFor (the floor a blocking caller paces a store host by)', () => {
    it('is undefined while no floor source is bound, even in scope', () => {
      expect(clockFor().floorFor(MFC)).toBeUndefined();
    });

    it("is the bound source's floor for an in-scope host, asked with the normalised host", () => {
      const clock = clockFor();
      const source = jest.fn((host: string) => (host === MFC ? 7000 : undefined));
      clock.setFloorSource(source);
      expect(clock.floorFor('WWW.myfigurecollection.net.')).toBe(7000);
      expect(source).toHaveBeenCalledWith(MFC);
    });

    it('is undefined for a host out of scope, without asking the source', () => {
      const clock = clockFor();
      const source = jest.fn(() => 7000);
      clock.setFloorSource(source);
      expect(clock.floorFor('static.myfigurecollection.net')).toBeUndefined();
      expect(source).not.toHaveBeenCalled();
    });

    it('is undefined when the source does not know the host as a store host', () => {
      const clock = clockFor('all');
      clock.setFloorSource(() => undefined);
      expect(clock.floorFor('cdn.shopify.com')).toBeUndefined();
    });

    it('is undefined again once the source is unbound', () => {
      const clock = clockFor();
      clock.setFloorSource(() => 7000);
      clock.setFloorSource(null);
      expect(clock.floorFor(MFC)).toBeUndefined();
    });
  });

  describe('describe (the boot log line)', () => {
    it('says off when nothing is in scope', () => {
      expect(new HostClock(parseHostClockScope(undefined)).describe()).toBe('[HOST-CLOCK] SCRAPE_HOST_CLOCK off: every host keeps its own lane pacing');
    });

    it('names each csv host with the floor its images are paced by', () => {
      const clock = new HostClock(parseHostClockScope('myfigurecollection.net,example.com'), 'myfigurecollection.net,example.com');
      clock.setFloorSource(host => (host === MFC ? 7000 : undefined));
      expect(clock.describe()).toBe(
        '[HOST-CLOCK] SCRAPE_HOST_CLOCK=myfigurecollection.net,example.com: one clock per host for queue dispatch and main-host images; myfigurecollection.net floor 7000 ms, example.com no store floor (queue only)',
      );
    });

    it('says all for the all scope', () => {
      expect(new HostClock(parseHostClockScope('all'), 'all').describe()).toBe(
        '[HOST-CLOCK] SCRAPE_HOST_CLOCK=all: one clock per host for queue dispatch and main-host images',
      );
    });
  });
});

describe('the process clock', () => {
  const saved = process.env.SCRAPE_HOST_CLOCK;
  afterEach(() => {
    if (saved === undefined) delete process.env.SCRAPE_HOST_CLOCK;
    else process.env.SCRAPE_HOST_CLOCK = saved;
    setHostClock(null);
  });

  it('is off by default: no host is in scope', () => {
    delete process.env.SCRAPE_HOST_CLOCK;
    setHostClock(null);
    expect(getHostClock().inScope(MFC)).toBe(false);
  });

  it('reads SCRAPE_HOST_CLOCK once, at first use, and is one instance', () => {
    process.env.SCRAPE_HOST_CLOCK = MFC;
    setHostClock(null);
    const clock = getHostClock();
    expect(clock.inScope(MFC)).toBe(true);
    expect(clock.describe()).toContain(`SCRAPE_HOST_CLOCK=${MFC}`);
    process.env.SCRAPE_HOST_CLOCK = 'off';
    expect(getHostClock()).toBe(clock);
  });

  it('can be replaced (test seam)', () => {
    const custom = new HostClock(parseHostClockScope('all'));
    setHostClock(custom);
    expect(getHostClock()).toBe(custom);
  });
});
