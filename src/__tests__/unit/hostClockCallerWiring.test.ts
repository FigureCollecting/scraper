/**
 * QB-U30b caller wiring, one caller at a time (plan-v3 rev 7, design.host_clock.callers): what each
 * caller does when the clock refuses it (the existing non-page outcome), when a challenge cooldown
 * opens while it waits (the veto), and how the transports that send more than one request per call
 * (a session prime, a re-prime) and the plugin-mounted routes pass the clock.
 * Fake clocks and fake transports; no network.
 */
import { assembleCatalog, type CatalogServices } from '../../driver/assembleCatalog';
import { assembleLookup } from '../../driver/assembleLookup';
import { assembleResolve } from '../../driver/assembleResolve';
import { ProfileRegistry } from '../../driver/profileRegistry';
import { ChallengeCooldown } from '../../services/challengeCooldown';
import { HostClock, parseHostClockScope, setHostClock } from '../../services/hostClock';
import { HostClockRefusedError, type HostClockPacer } from '../../services/hostClockSend';
import { buildExtractContext } from '../../services/engineServices/extractContext';
import { createImpitFetchDetailed, type ImpitLike } from '../../services/impitFetch';
import type { ExtractionRuleset, StoreCapabilities } from '@figurecollecting/scraper-plugin-contract';

const MFC = 'myfigurecollection.net';
const SHOP = 'shop.example';
const FLOOR = 7000;

function caps(siteId: string, domain: string, floor: number): StoreCapabilities {
  return {
    siteId,
    name: siteId,
    domains: [domain],
    rateLimit: { domain, baseDelayMs: floor, minDelayMs: floor, maxDelayMs: 180_000, backoffMultiplier: 2, recoveryDivisor: 1.5, successThreshold: 4 },
    requiresBrowser: false,
    allowedCookies: [],
    retrieval: {
      byId: { urlTemplate: `https://${domain}/item/{id}`, idKind: 'store-internal' },
      byListing: { urlTemplate: `https://${domain}/browse?page={page}`, order: 'newest' },
      bySearch: { urlTemplate: `https://${domain}/search?q={q}` },
      seedLists: [{ id: 'top', url: `https://${domain}/top`, cadence: 'weekly' }],
      rotatingSeedLists: [{ id: 'co-1', url: `https://${domain}/companies/1`, group: 'companies', order: 1 }],
    },
  } as StoreCapabilities;
}

const ruleset = {
  siteId: 'x',
  version: '1',
  extract: () => ({ source: { site: 'x', itemId: '1', url: 'u', extractedAt: 'n', rulesetVersion: '1' }, fields: {}, warnings: [] }),
  validate: () => ({ valid: true, errors: [], warnings: [] }),
  extractListing: () => ({ items: [{ itemId: '1' }] }),
  extractSeedList: () => ({ items: [{ itemId: '2' }] }),
  extractCandidates: () => [],
} as unknown as ExtractionRuleset;

/** A clock covering every host whose floor source knows MFC and the shop at 7000, MFC already booked for `bookedUntil`. */
function busyClock(): HostClock {
  const clock = new HostClock(parseHostClockScope('all'), 'all', { waitSlackMs: 0 });
  clock.setFloorSource(host => (host === MFC || host === SHOP ? FLOOR : undefined));
  return clock;
}

/** Book the host twice ahead from `now`, so one more blocking reservation is past the cap (floor + 0 + 0). */
function stack(clock: HostClock, host: string, now: number) {
  clock.tryAcquire(host, now, FLOOR);
  clock.reserve(host, now, FLOOR);
}

function services(clock: HostClock, fetch: jest.Mock, cooldown = new ChallengeCooldown()): CatalogServices {
  const profiles = new ProfileRegistry();
  profiles.register(caps('mfc', MFC, FLOOR));
  profiles.register(caps('shop', SHOP, FLOOR));
  return { profiles, getRulesetForUrl: () => ruleset, fetchSearch: fetch, challengeCooldown: cooldown, hostClock: clock };
}

describe('refusal = the caller\'s existing non-page outcome, no request', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.CATALOG_STORE_TIMEOUT_MS = '60000';
    process.env.LOOKUP_STORE_TIMEOUT_MS = '35000';
  });
  afterEach(() => { process.env = { ...saved }; setHostClock(null); });

  it('/catalog listing, seed and rotating answer cooldown (the crawler stops the store for the pass), counted per caller', async () => {
    const clock = busyClock();
    const fetch = jest.fn(async () => '<html></html>');
    const catalog = assembleCatalog(services(clock, fetch));
    stack(clock, MFC, Date.now());
    expect(await catalog.catalog('mfc', 1)).toMatchObject({ status: 'cooldown', siteId: 'mfc', host: MFC });
    expect(await catalog.seed('mfc', 'top')).toMatchObject({ status: 'cooldown', siteId: 'mfc', host: MFC });
    expect(await catalog.rotatingSeed('mfc', 'co-1')).toMatchObject({ status: 'cooldown', siteId: 'mfc', host: MFC });
    expect(fetch).not.toHaveBeenCalled();
    expect(clock.view(Date.now()).hosts.find(h => h.host === MFC)?.clockRefusals60m).toMatchObject({ catalogListing: 1, catalogSeed: 1, catalogRotating: 1 });
  });

  it('the remainingMs of a refused listing is the wait the clock would have imposed', async () => {
    const clock = busyClock();
    const now = Date.now();
    stack(clock, MFC, now);
    const out = await assembleCatalog(services(clock, jest.fn())).catalog('mfc', 1);
    expect(out.status).toBe('cooldown');
    expect((out as { remainingMs: number }).remainingMs).toBeGreaterThan(FLOOR);
    expect((out as { remainingMs: number }).remainingMs).toBeLessThanOrEqual(2 * FLOOR);
  });

  it('/lookup puts a refused store in its cooldown list, sends nothing and reports no fetch failure', async () => {
    const clock = busyClock();
    const fetch = jest.fn(async () => '');
    const reportFailure = jest.fn();
    stack(clock, SHOP, Date.now());
    const out = await assembleLookup({ ...services(clock, fetch), reportFailure }).lookup('figure', { stores: ['shop'] });
    expect(out.cooldown).toEqual(['shop']);
    expect(out.failed).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    expect(reportFailure).not.toHaveBeenCalled();
    expect(clock.view(Date.now()).hosts.find(h => h.host === SHOP)?.clockRefusals60m.lookup).toBe(1);
  });

  it('/resolve puts a refused id in its cooldown list and fetches nothing for it', async () => {
    const clock = busyClock();
    setHostClock(clock);
    const profiles = new ProfileRegistry();
    profiles.register(caps('mfc', MFC, FLOOR));
    const fetchDetail = jest.fn(async () => ({ html: '<html></html>', statusCode: 200 }));
    stack(clock, MFC, Date.now());
    const out = await assembleResolve({ profiles, getRulesetForUrl: () => ruleset, fetchDetail }).resolve('mfc', ['1']);
    expect(out).toMatchObject({ results: [], failed: [], cooldown: ['1'] });
    expect(fetchDetail).not.toHaveBeenCalled();
    expect(clock.view(Date.now()).hosts[0].clockRefusals60m.resolve).toBe(1);
  });

  it('a fetchBody follow-up is refused with a HostClockRefusedError the ruleset can catch, and sends nothing', async () => {
    const clock = busyClock();
    const capturingFetch = jest.fn(async () => ({ html: '{}' }));
    const ctx = buildExtractContext({
      config: caps('mfc', MFC, FLOOR),
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as any,
      scraping: { scrapePage: jest.fn(), scrapePageStealth: jest.fn() } as any,
      capturingFetch,
      searchFetch: undefined,
      primaryUrl: `https://${MFC}/item/1`,
      primaryFetchedAt: 0,
      baseDelayMs: 0,
      hostClock: clock,
    });
    stack(clock, MFC, Date.now());
    await expect(ctx.scraping.fetchBody!(`https://${MFC}/api/1`)).rejects.toBeInstanceOf(HostClockRefusedError);
    expect(capturingFetch).not.toHaveBeenCalled();
    expect(clock.view(Date.now()).hosts[0].clockRefusals60m.fetchBody).toBe(1);
  });
});

describe('a challenge cooldown that opens while a caller waits for its slot vetoes the send', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(1_000_000);
    process.env.CATALOG_STORE_TIMEOUT_MS = '60000';
    process.env.LOOKUP_STORE_TIMEOUT_MS = '35000';
  });
  afterEach(() => {
    jest.useRealTimers();
    process.env = { ...saved };
  });

  it('/catalog: cooldown, no fetch', async () => {
    const clock = new HostClock(parseHostClockScope(MFC), MFC);
    clock.setFloorSource(host => (host === MFC ? FLOOR : undefined));
    clock.tryAcquire(MFC, Date.now(), FLOOR);
    const cooldown = new ChallengeCooldown();
    const fetch = jest.fn(async () => '');
    const pending = assembleCatalog(services(clock, fetch, cooldown)).catalog('mfc', 1);
    await jest.advanceTimersByTimeAsync(1000);
    cooldown.open(MFC, 'a /lookup met a challenge');
    await jest.advanceTimersByTimeAsync(FLOOR);
    expect(await pending).toMatchObject({ status: 'cooldown', host: MFC });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('/lookup: the store goes to the cooldown list, no fetch', async () => {
    const clock = new HostClock(parseHostClockScope(SHOP), SHOP);
    clock.setFloorSource(host => (host === SHOP ? FLOOR : undefined));
    clock.tryAcquire(SHOP, Date.now(), FLOOR);
    const cooldown = new ChallengeCooldown();
    const fetch = jest.fn(async () => '');
    const pending = assembleLookup(services(clock, fetch, cooldown)).lookup('figure', { stores: ['shop'] });
    await jest.advanceTimersByTimeAsync(1000);
    cooldown.open(SHOP, 'challenge');
    await jest.advanceTimersByTimeAsync(FLOOR);
    expect((await pending).cooldown).toEqual(['shop']);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('/resolve: the id goes to the cooldown list, no fetch', async () => {
    const clock = new HostClock(parseHostClockScope(MFC), MFC);
    clock.setFloorSource(host => (host === MFC ? FLOOR : undefined));
    setHostClock(clock);
    clock.tryAcquire(MFC, Date.now(), FLOOR);
    const cooldown = new ChallengeCooldown();
    const profiles = new ProfileRegistry();
    profiles.register(caps('mfc', MFC, FLOOR));
    const fetchDetail = jest.fn(async () => ({ html: '', statusCode: 200 }));
    const pending = assembleResolve({ profiles, getRulesetForUrl: () => ruleset, fetchDetail, challengeCooldown: cooldown }).resolve('mfc', ['1']);
    await jest.advanceTimersByTimeAsync(1000);
    cooldown.open(MFC, 'challenge');
    await jest.advanceTimersByTimeAsync(FLOOR);
    expect(await pending).toMatchObject({ cooldown: ['1'], failed: [] });
    expect(fetchDetail).not.toHaveBeenCalled();
    setHostClock(null);
  });
});

describe('the /catalog listing on a host above the ceiling is recorded, not waited', () => {
  it('goes at once and spaces the next queue record a full floor after it', async () => {
    const saved = process.env.CATALOG_STORE_TIMEOUT_MS;
    process.env.CATALOG_STORE_TIMEOUT_MS = '60000';
    try {
      const clock = new HostClock(parseHostClockScope('all'), 'all');
      clock.setFloorSource(host => (host === 'slow.example' ? 45_000 : undefined));
      const profiles = new ProfileRegistry();
      profiles.register(caps('slow', 'slow.example', 45_000));
      const before = Date.now();
      const fetch = jest.fn(async () => '<html></html>');
      const out = await assembleCatalog({ profiles, getRulesetForUrl: () => ruleset, fetchSearch: fetch, hostClock: clock }).catalog('slow', 1);
      expect(out.status).toBe('ok');
      expect(fetch).toHaveBeenCalledTimes(1);
      // Nothing was booked for it; its RECORDED send alone holds the next record a full floor.
      expect(clock.tryAcquire('slow.example', before + 44_999, 45_000)).toBeGreaterThan(0);
      expect(clock.view(Date.now()).hosts[0].sends60m.catalogListing).toBe(1);
    } finally {
      process.env.CATALOG_STORE_TIMEOUT_MS = saved;
    }
  });
});

describe('the impit transport: every request after the first of a call passes the clock as sessionPrime', () => {
  function fakeImpit(bodies: string[]) {
    const calls: string[] = [];
    let n = 0;
    const impit: ImpitLike = {
      fetch: jest.fn(async (url: string) => {
        calls.push(url);
        const body = url.endsWith('/') ? 'home' : bodies[Math.min(n++, bodies.length - 1)];
        return { text: async () => body, status: 200 };
      }),
    };
    return { make: () => impit, calls };
  }

  function recordingPacer() {
    const events: string[] = [];
    const pacer: HostClockPacer = {
      first: (url: string) => { events.push(`first ${url}`); },
      send: async (url, caller, invoke) => {
        events.push(`send ${caller} ${url}`);
        return invoke();
      },
    };
    return { pacer, events };
  }

  const TARGET = `https://${MFC}/item/1`;
  const ORIGIN = `https://${MFC}/`;

  it('a fresh prime: the prime GET is the call\'s first request (stamped there), the target waits its turn', async () => {
    const impit = fakeImpit(['<html>item</html>']);
    const { pacer, events } = recordingPacer();
    const fetch = createImpitFetchDetailed(impit.make, { pacer, store: { cookiesFor: () => undefined, userAgentFor: () => undefined } as any });
    await fetch(TARGET, { prime: { url: ORIGIN } });
    expect(impit.calls).toEqual([ORIGIN, TARGET]);
    expect(events).toEqual([`first ${ORIGIN}`, `send sessionPrime ${TARGET}`]);
  });

  it('an already primed host: the target is the first request and is not paced again', async () => {
    const impit = fakeImpit(['<html>item</html>']);
    const { pacer, events } = recordingPacer();
    const fetch = createImpitFetchDetailed(impit.make, { pacer, store: { cookiesFor: () => undefined, userAgentFor: () => undefined } as any });
    await fetch(TARGET, { prime: { url: ORIGIN } });
    events.length = 0;
    await fetch(TARGET, { prime: { url: ORIGIN } });
    expect(events).toEqual([]);
  });

  it('a challenged target: the re-prime and the retried target both pass the clock', async () => {
    const impit = fakeImpit(['<html>Just a moment</html>', '<html>item</html>']);
    const { pacer, events } = recordingPacer();
    const fetch = createImpitFetchDetailed(impit.make, { pacer, store: { cookiesFor: () => undefined, userAgentFor: () => undefined } as any });
    const detail = await fetch(TARGET, { prime: { url: ORIGIN } });
    expect(detail.body).toBe('<html>item</html>');
    expect(impit.calls).toEqual([ORIGIN, TARGET, ORIGIN, TARGET]);
    expect(events).toEqual([`first ${ORIGIN}`, `send sessionPrime ${TARGET}`, `send sessionPrime ${ORIGIN}`, `send sessionPrime ${TARGET}`]);
  });

  it('no prime declared: nothing passes the pacer (byte-identical)', async () => {
    const impit = fakeImpit(['<html>item</html>']);
    const { pacer, events } = recordingPacer();
    await createImpitFetchDetailed(impit.make, { pacer, store: { cookiesFor: () => undefined, userAgentFor: () => undefined } as any })(TARGET);
    expect(events).toEqual([]);
  });

  it('by default the process clock paces it: a prime then the target, a full floor apart on a clocked host', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(1_000_000);
    try {
      const clock = new HostClock(parseHostClockScope(MFC), MFC);
      clock.setFloorSource(host => (host === MFC ? FLOOR : undefined));
      setHostClock(clock);
      // The outer caller (the queue) settled its send at the transport's invocation.
      clock.settle(MFC, Date.now(), FLOOR);
      const impit = fakeImpit(['<html>item</html>']);
      const stamps: number[] = [];
      (impit.make() as { fetch: jest.Mock }).fetch.mockImplementation(async (url: string) => {
        stamps.push(Date.now());
        return { text: async () => (url.endsWith('/') ? 'home' : 'item'), status: 200 };
      });
      const pending = createImpitFetchDetailed(impit.make, { store: { cookiesFor: () => undefined, userAgentFor: () => undefined } as any })(TARGET, { prime: { url: ORIGIN } });
      await jest.advanceTimersByTimeAsync(10);
      await jest.advanceTimersByTimeAsync(FLOOR);
      await pending;
      expect(stamps).toEqual([1_000_000, 1_000_000 + FLOOR]);
      expect(clock.view(Date.now()).hosts[0].sends60m.sessionPrime).toBe(1);
    } finally {
      setHostClock(null);
      jest.useRealTimers();
    }
  });
});
