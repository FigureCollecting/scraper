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
import { HostClock, getHostClock, parseHostClockScope, setHostClock, startHostClockSummary } from '../../services/hostClock';

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

  it('ignores a listed entry that is not a bare hostname, and the keywords off and all inside a list', () => {
    const inScope = parseHostClockScope('https://mock.example.test, off ,ALL,example.com/path,shop.test:8080,MyFigureCollection.net.');
    expect(inScope('mock.example.test')).toBe(false);
    expect(inScope('https://mock.example.test')).toBe(false);
    expect(inScope('off')).toBe(false);
    expect(inScope('all')).toBe(false);
    // `all` inside a list is not the all scope.
    expect(inScope('cdn.shopify.com')).toBe(false);
    expect(inScope('example.com')).toBe(false);
    expect(inScope('shop.test')).toBe(false);
    expect(inScope(MFC)).toBe(true);
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

  describe('settle (stamp the instant a request REALLY leaves) and the send-time gate', () => {
    it('spaces the next request from a late send, not from the slot it was booked for', () => {
      const clock = clockFor();
      clock.tryAcquire(MFC, 0, 7000);
      expect(clock.reserve(MFC, 100, 7000)).toBe(7000);
      // The timer fired 600 ms late: the image really left at 7600, not at its slot.
      clock.settle('WWW.MyFigureCollection.net.', 7600, 7000);
      expect(clock.tryAcquire(MFC, 14_000, 7000)).toBe(600);
      expect(clock.reserve(MFC, 8000, 7000)).toBe(14_600);
    });

    it('on time, changes nothing', () => {
      const clock = clockFor();
      clock.tryAcquire(MFC, 0, 7000);
      clock.reserve(MFC, 100, 7000);
      clock.settle(MFC, 7000, 7000);
      expect(clock.tryAcquire(MFC, 13_999, 7000)).toBe(1);
      expect(clock.tryAcquire(MFC, 14_000, 7000)).toBe(0);
    });

    it('never moves the next allowed time earlier (RECORD RULE: floor 45000, queue 0, image 45000, a send recorded at 2000)', () => {
      const clock = clockFor();
      expect(clock.tryAcquire(MFC, 0, 45_000)).toBe(0);
      expect(clock.reserve(MFC, 10, 45_000)).toBe(45_000);
      clock.settle(MFC, 2000, 45_000);
      // A naive overwrite would allow the next record at 47000, 2000 ms after the image.
      expect(clock.tryAcquire(MFC, 89_999, 45_000)).toBe(1);
      expect(clock.tryAcquire(MFC, 90_000, 45_000)).toBe(0);
    });

    it('keeps the later of two sends when a stamp arrives out of order', () => {
      const clock = clockFor();
      clock.settle(MFC, 7600, 7000);
      clock.settle(MFC, 7000, 7000);
      expect(clock.tryAcquire(MFC, 14_599, 7000)).toBe(1);
    });

    it("stamps with the host's booked floor when none is given", () => {
      const clock = clockFor();
      clock.tryAcquire(MFC, 0, 7000);
      clock.settle(MFC, 100);
      expect(clock.tryAcquire(MFC, 7099, 1000)).toBe(1);
      expect(clock.tryAcquire(MFC, 7100, 1000)).toBe(0);
    });

    it('a stamp with no floor on a host never booked still holds an asker to its own floor', () => {
      const clock = clockFor('all');
      clock.settle('hpoi.net', 0);
      expect(clock.tryAcquire('hpoi.net', 6999, 7000)).toBe(1);
    });

    describe('msUntilSendable(host, slot, now, floorMs)', () => {
      it('is 0 once the slot has come and no request left within the floor', () => {
        const clock = clockFor();
        expect(clock.reserve(MFC, 0, 7000)).toBe(0);
        expect(clock.msUntilSendable(MFC, 0, 0, 7000)).toBe(0);
      });

      it('refuses an early timer: the rest of the wait until the slot', () => {
        const clock = clockFor();
        clock.tryAcquire(MFC, 0, 7000);
        const slot = clock.reserve(MFC, 100, 7000);
        expect(clock.msUntilSendable(MFC, slot, 6999, 7000)).toBe(1);
        expect(clock.msUntilSendable(MFC, slot, 7000, 7000)).toBe(0);
      });

      it('refuses while another request left within the floor (a slot lost to another caller), opening exactly at the floor', () => {
        const clock = clockFor();
        expect(clock.reserve(MFC, 0, 7000)).toBe(0);
        // The image slept through its slot; the queue took the host and sent at 7000.
        expect(clock.tryAcquire(MFC, 7000, 7000)).toBe(0);
        clock.settle(MFC, 7000, 7000);
        expect(clock.msUntilSendable(MFC, 0, 7100, 7000)).toBe(6900);
        expect(clock.msUntilSendable(MFC, 0, 13_999, 7000)).toBe(1);
        expect(clock.msUntilSendable(MFC, 0, 14_000, 7000)).toBe(0);
      });

      it('holds the larger of the last send\'s floor and the asker\'s', () => {
        const clock = clockFor();
        clock.settle(MFC, 0, 7000);
        expect(clock.msUntilSendable(MFC, 0, 1000, 1000)).toBe(6000);
        clock.settle(MFC, 10_000, 1000);
        expect(clock.msUntilSendable(MFC, 0, 10_500, 7000)).toBe(6500);
      });

      it('collapses host spellings onto one gate', () => {
        const clock = clockFor();
        clock.settle('WWW.MyFigureCollection.net.', 0, 7000);
        expect(clock.msUntilSendable(MFC, 0, 10, 7000)).toBe(6990);
      });
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

  describe('warnings (one boot WARN line per listed entry that is ignored)', () => {
    it('names each ignored entry as it was written', () => {
      const raw = 'https://Mock.example.test, off , ALL ,example.com/x,MOCK.Example.Test.,myfigurecollection.net';
      expect(new HostClock(parseHostClockScope(raw), raw).warnings()).toEqual([
        '[HOST-CLOCK] WARN SCRAPE_HOST_CLOCK entry "https://Mock.example.test" is not a bare hostname; ignored',
        '[HOST-CLOCK] WARN SCRAPE_HOST_CLOCK entry "off" is a keyword, not a host, inside a host list; ignored',
        '[HOST-CLOCK] WARN SCRAPE_HOST_CLOCK entry "ALL" is a keyword, not a host, inside a host list; ignored',
        '[HOST-CLOCK] WARN SCRAPE_HOST_CLOCK entry "example.com/x" is not a bare hostname; ignored',
      ]);
    });

    it.each([undefined, 'off', 'all', ' , ', 'myfigurecollection.net, www.Example.com.'])('is empty for %p', raw => {
      expect(new HostClock(parseHostClockScope(raw), raw).warnings()).toEqual([]);
    });

    it('describe names only the hosts kept', () => {
      const raw = 'off,https://x.test,mock.example.test';
      expect(new HostClock(parseHostClockScope(raw), raw).describe()).toBe(
        '[HOST-CLOCK] SCRAPE_HOST_CLOCK=off,https://x.test,mock.example.test: one clock per host for queue dispatch and main-host images; mock.example.test no store floor (queue only)',
      );
    });

    it('a list of nothing but ignored entries is off', () => {
      const raw = 'https://mock.example.test';
      const clock = new HostClock(parseHostClockScope(raw), raw);
      expect(clock.describe()).toBe('[HOST-CLOCK] SCRAPE_HOST_CLOCK off: every host keeps its own lane pacing');
      expect(clock.warnings()).toHaveLength(1);
    });
  });

  describe('the send-time observer (recordSend, view, summaryLines)', () => {
    const MIN = 60_000;
    /** A clock whose floor source knows MFC (7000) and hpoi.net (3000) as store hosts. */
    function observed(raw = MFC): HostClock {
      const clock = new HostClock(parseHostClockScope(raw), raw);
      clock.setFloorSource(host => (host === MFC ? 7000 : host === 'hpoi.net' ? 3000 : undefined));
      return clock;
    }
    const idle = { sends60m: { queue: 0, image: 0 }, minGapMs60m: 0, underFloor60m: 0, lastSendAt: null };

    it('shows a listed store host with zeros while idle', () => {
      expect(observed().view(0)).toEqual({ mode: 'hosts', hosts: [{ host: MFC, floorMs: 7000, clocked: true, ...idle }] });
    });

    it('is empty while off or all and idle', () => {
      expect(observed('off').view(0)).toEqual({ mode: 'off', hosts: [] });
      expect(observed('all').view(0)).toEqual({ mode: 'all', hosts: [] });
    });

    it('records the sends of every caller and measures each gap from the previous send of ANY caller', () => {
      const clock = observed();
      clock.recordSend(MFC, 'queue', 0);
      clock.recordSend('www.MyFigureCollection.net.', 'image', 5000);
      clock.recordSend(MFC, 'image', 12_000);
      clock.recordSend(MFC, 'queue', 19_000);
      expect(clock.view(20_000).hosts).toEqual([{
        host: MFC, floorMs: 7000, clocked: true,
        sends60m: { queue: 2, image: 2 }, minGapMs60m: 5000, underFloor60m: 1, lastSendAt: new Date(19_000).toISOString(),
      }]);
    });

    it('counts a gap of exactly the floor as not under it, and one ms less as under', () => {
      const clock = observed();
      clock.recordSend(MFC, 'queue', 0);
      clock.recordSend(MFC, 'image', 7000);
      expect(clock.view(7000).hosts[0]).toMatchObject({ minGapMs60m: 7000, underFloor60m: 0 });
      clock.recordSend(MFC, 'queue', 13_999);
      expect(clock.view(13_999).hosts[0]).toMatchObject({ minGapMs60m: 6999, underFloor60m: 1 });
    });

    it('records whatever the scope says (clock off = the live negative control), with the floor read from the floor source', () => {
      const clock = observed('off');
      clock.recordSend(MFC, 'queue', 0);
      clock.recordSend(MFC, 'image', 0);
      expect(clock.view(0)).toEqual({ mode: 'off', hosts: [{
        host: MFC, floorMs: 7000, clocked: false,
        sends60m: { queue: 1, image: 1 }, minGapMs60m: 0, underFloor60m: 1, lastSendAt: new Date(0).toISOString(),
      }] });
    });

    it('records only a store host: a CDN, the static image host, or anything while no floor source is bound records nothing', () => {
      const clock = observed('all');
      clock.recordSend('cdn.shopify.com', 'image', 0);
      clock.recordSend('static.myfigurecollection.net', 'image', 0);
      expect(clock.view(0)).toEqual({ mode: 'all', hosts: [] });
      const unbound = new HostClock(parseHostClockScope('all'), 'all');
      unbound.recordSend(MFC, 'queue', 0);
      expect(unbound.view(0).hosts).toEqual([]);
    });

    it('counts the trailing 60 minutes only, keeping the gap of a send to a predecessor that has left the window', () => {
      const clock = observed();
      clock.recordSend(MFC, 'queue', 0);
      clock.recordSend(MFC, 'queue', 1000);
      clock.recordSend(MFC, 'image', 60 * MIN + 500);
      expect(clock.view(60 * MIN + 999).hosts[0]).toMatchObject({ sends60m: { queue: 1, image: 1 }, minGapMs60m: 1000, underFloor60m: 1 });
      expect(clock.view(60 * MIN + 1000).hosts[0]).toMatchObject({ sends60m: { queue: 0, image: 1 }, minGapMs60m: 60 * MIN - 500, underFloor60m: 0 });
      // An hour after the last send: zeros again, the last send still named.
      expect(clock.view(120 * MIN + 500).hosts[0]).toEqual({ host: MFC, floorMs: 7000, clocked: true, ...idle, lastSendAt: new Date(60 * MIN + 500).toISOString() });
    });

    it('lists every store host that sent, sorted, each line under 1 KB', () => {
      const clock = observed('all');
      for (let i = 0; i < 2000; i++) clock.recordSend(i % 2 ? MFC : 'hpoi.net', i % 3 ? 'queue' : 'image', i * 1000);
      const { hosts } = clock.view(2000 * 1000);
      expect(hosts.map(h => h.host)).toEqual(['hpoi.net', MFC]);
      expect(hosts.map(h => h.clocked)).toEqual([true, true]);
      for (const h of hosts) expect(JSON.stringify(h).length).toBeLessThan(1024);
    });

    it('summaryLines: one line per host with sends in the window, carrying the numbers of the block', () => {
      const clock = observed('myfigurecollection.net,hpoi.net,example.com');
      clock.recordSend(MFC, 'queue', 0);
      clock.recordSend(MFC, 'image', 5000);
      clock.recordSend(MFC, 'queue', 12_000);
      const view = clock.view(13_000);
      expect(view.hosts.map(h => h.host)).toEqual(['hpoi.net', MFC]);
      const mfc = view.hosts[1];
      expect(clock.summaryLines(13_000)).toEqual([
        `[HOST-CLOCK] summary host=${MFC} sends=${mfc.sends60m.queue + mfc.sends60m.image} minGapMs=${mfc.minGapMs60m} underFloor=${mfc.underFloor60m}`,
      ]);
      expect(clock.summaryLines(13_000)).toEqual([`[HOST-CLOCK] summary host=${MFC} sends=3 minGapMs=5000 underFloor=1`]);
    });

    it('startHostClockSummary logs the summary every 10 minutes until stopped', () => {
      jest.useFakeTimers();
      jest.setSystemTime(0);
      const clock = observed();
      const lines: string[] = [];
      const stop = startHostClockSummary(clock, line => lines.push(line));
      clock.recordSend(MFC, 'queue', 0);
      jest.advanceTimersByTime(10 * MIN - 1);
      expect(lines).toEqual([]);
      jest.advanceTimersByTime(1);
      expect(lines).toEqual([`[HOST-CLOCK] summary host=${MFC} sends=1 minGapMs=0 underFloor=0`]);
      stop();
      jest.advanceTimersByTime(10 * MIN);
      expect(lines).toHaveLength(1);
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
