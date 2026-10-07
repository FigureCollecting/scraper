/**
 * QB-U30b, edges the first mutation round showed were not pinned: the lost-slot boundary, the
 * nearest-rank percentile on a non-integer rank, the image lane's WAIT RULE (a valid slot pushed out
 * by another caller's late send is slept out, not re-booked) and the /lookup fetch-timeout shrink.
 */
import { HostClock, parseHostClockScope } from '../../services/hostClock';
import { HostRateLimiter } from '../../driver/hostRateLimiter';
import { paceImageBytesByHost } from '../../services/images/imageBytesPacing';
import type { ImageBytesResult } from '../../services/images/imageBytes';
import * as lookupModule from '../../driver/assembleLookup';
import { assembleLookup } from '../../driver/assembleLookup';
import { ProfileRegistry } from '../../driver/profileRegistry';
import type { ExtractionRuleset, StoreCapabilities } from '@figurecollecting/scraper-plugin-contract';

const MFC = 'myfigurecollection.net';
const FLOOR = 7000;

function mfcClock(): HostClock {
  const clock = new HostClock(parseHostClockScope(MFC), MFC);
  clock.setFloorSource(host => (host === MFC ? FLOOR : undefined));
  return clock;
}

it("sendWait: a slot is LOST once another booking is due at exactly this instant (the queue took the host now)", () => {
  const clock = mfcClock();
  expect(clock.reserve(MFC, 0, FLOOR)).toBe(0);
  expect(clock.tryAcquire(MFC, FLOOR, FLOOR)).toBe(0);
  // Sending on the old slot now would put two requests on the host in the same instant.
  expect(clock.sendWait(MFC, 0, FLOOR, FLOOR)).toBeNull();
});

it('the percentiles use the nearest rank (ceil), so a non-integer rank rounds up', () => {
  const clock = new HostClock(parseHostClockScope('all'), 'all');
  clock.setFloorSource(host => (host === MFC ? FLOOR : undefined));
  for (let i = 1; i <= 10; i++) {
    clock.noteLatency(MFC, 'listing', i * 100, i);
    clock.noteLatency(MFC, 'lookup', i * 100, i);
  }
  expect(clock.view(20).hosts[0]).toMatchObject({ listingFetchP99Ms60m: 1000, lookupP95Ms60m: 1000 });
});

it("the image lane's WAIT RULE: a valid slot whose gate the queue's late send pushed out is slept out (7600), not re-booked a floor later (14000)", async () => {
  const clock = mfcClock();
  expect(clock.tryAcquire(MFC, 0, FLOOR)).toBe(0);
  let now = 0;
  const calls: number[] = [];
  let first = true;
  const ok: ImageBytesResult = { ok: true, bytes: Buffer.from([0x89, 0x50]), contentType: 'image/png', status: 200, finalUrl: 'u', headers: {} };
  const paced = paceImageBytesByHost(async () => { calls.push(now); return ok; }, new HostRateLimiter(() => undefined), {
    now: () => now,
    sleep: async (ms: number) => {
      if (first) {
        first = false;
        // While the image sleeps toward its 7000 slot, the queue's record (granted at 0) really leaves at 600.
        clock.settle(MFC, 600, FLOOR);
      }
      now += ms;
    },
    cooldown: { remaining: () => 0 },
    hostClock: clock,
  });
  await paced(`https://${MFC}/?_tb=commit&commit=nsp&objectType=item&objectId=1&size=1`);
  expect(calls).toEqual([7600]);
});

describe('/lookup on a clocked host: the fetch gets the store timeout minus the clock wait', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(1_000_000);
  });
  afterEach(() => jest.useRealTimers());

  it('waits the slot, then gives the fetch the store timeout minus the wait', async () => {
    const shop: StoreCapabilities = {
      siteId: 'shop',
      name: 'shop',
      domains: ['shop.example'],
      rateLimit: { domain: 'shop.example', baseDelayMs: FLOOR, minDelayMs: FLOOR, maxDelayMs: 1, backoffMultiplier: 1, recoveryDivisor: 1, successThreshold: 1 },
      requiresBrowser: false,
      allowedCookies: [],
      retrieval: { bySearch: { urlTemplate: 'https://shop.example/search?q={q}' } },
    } as StoreCapabilities;
    const profiles = new ProfileRegistry();
    profiles.register(shop);
    const clock = new HostClock(parseHostClockScope('all'), 'all');
    clock.setFloorSource(host => (host === 'shop.example' ? FLOOR : undefined));
    clock.tryAcquire('shop.example', Date.now(), FLOOR);
    const ruleset = { siteId: 'shop', version: '1', extract: jest.fn(), validate: jest.fn(), extractCandidates: () => [] } as unknown as ExtractionRuleset;
    const sentAt: number[] = [];
    // A store that never answers: the lookup gives up when the fetch's own timeout runs out.
    const fetchSearch = jest.fn(() => {
      sentAt.push(Date.now());
      return new Promise<string>(() => undefined);
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      let settled = false;
      const pending = assembleLookup({ profiles, getRulesetForUrl: () => ruleset, fetchSearch, hostClock: clock }).lookup('figure');
      void pending.then(() => { settled = true; });
      await jest.advanceTimersByTimeAsync(FLOOR);
      expect(sentAt).toEqual([1_000_000 + FLOOR]);
      const budgetLeft = lookupModule.resolveLookupStoreTimeoutMs(process.env) - FLOOR;
      await jest.advanceTimersByTimeAsync(budgetLeft - 1);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      expect((await pending).failed).toEqual(['shop']);
      expect(warn.mock.calls.map(c => String(c[0])).some(line => line.includes(`timed out after ${budgetLeft}ms`))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("a ruleset's in-extraction page fetches (ctx.scraping.scrapePage / scrapePageStealth) pass the clock as fetchBody", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(1_000_000);
  });
  afterEach(() => jest.useRealTimers());

  it('waits the host\'s next slot on a clocked host, and goes at once elsewhere', async () => {
    // Imported here so the fake timers above are installed before the module's defaults are read.
    const { buildExtractContext } = await import('../../services/engineServices/extractContext');
    const clock = mfcClock();
    clock.tryAcquire(MFC, Date.now(), FLOOR);
    const at: Array<{ url: string; at: number }> = [];
    const page = (url: string) => {
      at.push({ url, at: Date.now() });
      return Promise.resolve({ html: '', url, title: '', statusCode: 200 });
    };
    const ctx = buildExtractContext({
      config: { siteId: 'mfc', name: 'mfc', domains: [MFC], rateLimit: { domain: MFC, baseDelayMs: 0, minDelayMs: 0, maxDelayMs: 0, backoffMultiplier: 1, recoveryDivisor: 1, successThreshold: 1 }, requiresBrowser: false, allowedCookies: [] },
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as any,
      scraping: { scrapePage: jest.fn(page), scrapePageStealth: jest.fn(page) },
      capturingFetch: jest.fn() as any,
      searchFetch: undefined,
      primaryUrl: `https://${MFC}/item/1`,
      primaryFetchedAt: Date.now(),
      hostClock: clock,
    });
    const elsewhere = ctx.scraping.scrapePage('https://other.example/x');
    const first = ctx.scraping.scrapePage(`https://${MFC}/item/2`);
    await jest.advanceTimersByTimeAsync(FLOOR);
    await Promise.all([elsewhere, first]);
    const second = ctx.scraping.scrapePageStealth(`https://${MFC}/item/3`);
    await jest.advanceTimersByTimeAsync(FLOOR);
    await second;
    expect(at).toEqual([
      { url: 'https://other.example/x', at: 1_000_000 },
      { url: `https://${MFC}/item/2`, at: 1_000_000 + FLOOR },
      { url: `https://${MFC}/item/3`, at: 1_000_000 + 2 * FLOOR },
    ]);
    expect(clock.view(Date.now()).hosts[0].sends60m.fetchBody).toBe(2);
  });
});

describe('the WAIT RULE yields to a timer on every iteration that does not send, a re-book included', () => {
  /** The waiter booked 7000, overslept to 21000; the queue took 14000 meanwhile and never sent: the re-booked slot is now. */
  function overslept(clock: HostClock) {
    let now = 0;
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
      if (sleeps.length === 1) {
        expect(clock.tryAcquire(MFC, 14_000, FLOOR)).toBe(0);
        now = 21_000;
        return;
      }
      now += ms;
    };
    return { now: () => now, sleep, sleeps };
  }

  it('the send helper', async () => {
    const { sendOnHostClock } = await import('../../services/hostClockSend');
    const clock = mfcClock();
    clock.tryAcquire(MFC, 0, FLOOR);
    const t = overslept(clock);
    const out = await sendOnHostClock({ host: MFC, caller: 'resolve' }, async () => 'x', { clock, now: t.now, sleep: t.sleep });
    expect(out).toMatchObject({ sent: true, waitedMs: 21_000 });
    expect(t.sleeps).toEqual([FLOOR, 0]);
  });

  it('the image lane', async () => {
    const clock = mfcClock();
    clock.tryAcquire(MFC, 0, FLOOR);
    const t = overslept(clock);
    const calls: number[] = [];
    const ok: ImageBytesResult = { ok: true, bytes: Buffer.from([0x89]), contentType: 'image/png', status: 200, finalUrl: 'u', headers: {} };
    const paced = paceImageBytesByHost(async () => { calls.push(t.now()); return ok; }, new HostRateLimiter(() => undefined), {
      now: t.now,
      sleep: t.sleep,
      cooldown: { remaining: () => 0 },
      hostClock: clock,
    });
    await paced(`https://${MFC}/?_tb=commit&commit=nsp&objectType=item&objectId=2&size=1`);
    expect(calls).toEqual([21_000]);
    expect(t.sleeps).toEqual([FLOOR, 0]);
  });
});
