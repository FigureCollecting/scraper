/**
 * PER-IMAGE-HOST pacing. The driver already paces a store's own host; an image usually is not on it.
 * A CDN is the shared resource — cdn.shopify.com serves hundreds of the stores in this engine — so
 * the budget that matters is the one keyed on the IMAGE host, and it must be ONE budget across every
 * store that happens to point at that CDN. Pacing the store instead would let a dozen stores hammer
 * one CDN at their own individual rates.
 */
import { ChallengeCooldown } from '../../services/challengeCooldown';
import { HostRateLimiter } from '../../driver/hostRateLimiter';
import { paceImageBytesByHost } from '../../services/images/imageBytesPacing';
import type { ImageBytesResult } from '../../services/images/imageBytes';

/** A round base delay, and a success threshold high enough that ONE success never moves it. */
const config = {
  baseDelayMs: 1000,
  minDelayMs: 100,
  maxDelayMs: 60_000,
  backoffMultiplier: 2,
  recoveryDivisor: 2,
  successThreshold: 3,
};

/** The same, with recovery on the FIRST success — for the backoff/recovery assertions. */
const quickRecovery = { ...config, successThreshold: 1 };

const ok = (): ImageBytesResult => ({
  ok: true,
  bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  contentType: 'image/png',
  status: 200,
  finalUrl: 'https://cdn.shopify.com/i/1.png',
  headers: {},
});

const harness = () => {
  let clock = 0;
  const slept: number[] = [];
  const limiter = new HostRateLimiter(() => config, config);
  const fetcher = jest.fn(async (_url: string) => ok());
  const paced = paceImageBytesByHost(fetcher, limiter, {
    now: () => clock,
    sleep: async (ms: number) => { slept.push(ms); clock += ms; },
  });
  return { paced, fetcher, slept, limiter, advance: (ms: number) => { clock += ms; }, clockNow: () => clock };
};

describe('paceImageBytesByHost', () => {
  it('gives a SHARED CDN one budget across stores — the second store waits for the first', async () => {
    const { paced, slept, fetcher } = harness();

    // Two different stores, the same CDN host.
    await paced('https://cdn.shopify.com/s/files/store-a/1.png');
    await paced('https://cdn.shopify.com/s/files/store-b/2.png');

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(slept).toEqual([1000]);
  });

  it('keys on the IMAGE host, so a different CDN is an independent budget', async () => {
    const { paced, slept } = harness();

    await paced('https://cdn.shopify.com/i/1.png');
    await paced('https://cdn11.bigcommerce.com/i/2.png');

    expect(slept).toEqual([]);
  });

  it('collapses host spellings (case, www.) onto the one budget', async () => {
    const { paced, slept } = harness();

    await paced('https://CDN.shopify.com/i/1.png');
    await paced('https://www.cdn.shopify.com/i/2.png');

    expect(slept).toEqual([1000]);
  });

  it('collapses the trailing-dot FQDN spelling onto the same budget', async () => {
    const { paced, slept } = harness();

    await paced('https://cdn.shopify.com./i/1.png');
    await paced('https://cdn.shopify.com/i/2.png');

    expect(slept).toEqual([1000]);
  });

  it('needs no wait once the budget has elapsed on its own', async () => {
    const { paced, slept, advance } = harness();

    await paced('https://cdn.shopify.com/i/1.png');
    advance(1500);
    await paced('https://cdn.shopify.com/i/2.png');

    expect(slept).toEqual([]);
  });

  it('backs the image host off when the CDN answers 429, and recovers on success', async () => {
    let clock = 0;
    const limiter = new HostRateLimiter(() => quickRecovery, quickRecovery);
    const rateLimited = jest.fn(async (_url: string): Promise<ImageBytesResult> => ({ ok: false, reason: 'http-status', status: 429 }));
    const paced = paceImageBytesByHost(rateLimited, limiter, { now: () => clock, sleep: async (ms: number) => { clock += ms; } });

    await paced('https://cdn.shopify.com/i/1.png');
    expect(limiter.currentDelay('cdn.shopify.com')).toBe(2000);

    const succeeding = paceImageBytesByHost(jest.fn(async (_url: string) => ok()), limiter, { now: () => clock, sleep: async (ms: number) => { clock += ms; } });
    await succeeding('https://cdn.shopify.com/i/2.png');
    expect(limiter.currentDelay('cdn.shopify.com')).toBe(1000);
  });

  /** Runs one outcome through a fresh limiter and reports the host's delay afterwards. */
  const delayAfter = async (result: ImageBytesResult): Promise<number> => {
    let clock = 0;
    const limiter = new HostRateLimiter(() => config, config);
    const paced = paceImageBytesByHost(async () => result, limiter, { now: () => clock, sleep: async (ms: number) => { clock += ms; } });
    await paced('https://cdn.shopify.com/i/1.png');
    return limiter.currentDelay('cdn.shopify.com');
  };

  it('leaves the budget alone for a plain 404 and for a BARE 403 (a per-URL hotlink verdict)', async () => {
    expect(await delayAfter({ ok: false, reason: 'http-status', status: 404 })).toBe(1000);
    // A hotlink guard or an expired signed URL answers 403 for THAT url and would answer it for
    // every image of that store. Backing a SHARED CDN off on it spends every other store's budget.
    expect(await delayAfter({ ok: false, reason: 'http-status', status: 403 })).toBe(1000);
  });

  it('backs off on 429/503, and on a 403 that carries a Cloudflare mitigation signal', async () => {
    expect(await delayAfter({ ok: false, reason: 'http-status', status: 429 })).toBe(2000);
    expect(await delayAfter({ ok: false, reason: 'http-status', status: 503 })).toBe(2000);
    expect(await delayAfter({ ok: false, reason: 'http-status', status: 403, signals: { 'cf-mitigated': 'challenge' } })).toBe(2000);
    expect(await delayAfter({ ok: false, reason: 'http-status', status: 403, signals: { 'retry-after': '120' } })).toBe(2000);
  });

  it('backs off on a 2xx interstitial served at an image URL, and on a timeout', async () => {
    // A managed challenge frequently answers 200 with an HTML body — the one case the backoff is for.
    expect(await delayAfter({ ok: false, reason: 'not-image', status: 200, contentType: 'text/html' })).toBe(2000);
    expect(await delayAfter({ ok: false, reason: 'timeout' })).toBe(2000);
    // A refusal never reached the host, so it says nothing about the host's rate.
    expect(await delayAfter({ ok: false, reason: 'refused', detail: 'no proxy' })).toBe(1000);
  });

  it('SERIALIZES concurrent fetches on one host — N images are spread over N budgets, not one burst', async () => {
    // On the REAL clock and timer, because the race is between the msUntilReady check and the
    // recordDispatch that follows it across an await: under a check-then-act gap every concurrent
    // caller reads the same budget and they all wake together (a PDP's images hitting one CDN in one
    // instant). A small base delay keeps the test fast while still being a real interval.
    // successThreshold high enough that recovery never shortens the delay mid-run.
    const paced6 = { ...config, baseDelayMs: 60, minDelayMs: 10, successThreshold: 100 };
    const limiter = new HostRateLimiter(() => paced6, paced6);
    // jest.spyOn keeps the real implementation, so the limiter still books each dispatch.
    const recordDispatch = jest.spyOn(limiter, 'recordDispatch');
    const paced = paceImageBytesByHost(jest.fn(async (_url: string) => ok()), limiter);

    await Promise.all(Array.from({ length: 6 }, (_v, i) => paced(`https://cdn.shopify.com/i/${i}.png`)));

    const dispatchedAt = recordDispatch.mock.calls.map(call => call[1] as number).sort((a, b) => a - b);
    expect(dispatchedAt).toHaveLength(6);
    for (let i = 1; i < dispatchedAt.length; i += 1) {
      // Timer slop is one-sided (a timer never fires early), so the floor is the assertion.
      expect(dispatchedAt[i] - dispatchedAt[i - 1]).toBeGreaterThanOrEqual(paced6.baseDelayMs - 5);
    }
  });

  it('REFUSES a host that is cooling from a challenge, without fetching it', async () => {
    let clock = 0;
    const cooldown = new ChallengeCooldown({ now: () => clock, windowMs: 60_000 });
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    cooldown.open('cdn.shopify.com', 'challenge page');
    const limiter = new HostRateLimiter(() => config, config);
    const fetcher = jest.fn(async (_url: string) => ok());
    const paced = paceImageBytesByHost(fetcher, limiter, { now: () => clock, sleep: async (ms: number) => { clock += ms; }, cooldown });

    const result = await paced('https://cdn.shopify.com/i/1.png');
    expect(result).toMatchObject({ ok: false, reason: 'refused' });
    expect((result as { detail?: string }).detail).toMatch(/cooling/);
    expect(fetcher).not.toHaveBeenCalled();

    // Once the window has passed the host is fetched again.
    clock += 60_001;
    await expect(paced('https://cdn.shopify.com/i/1.png')).resolves.toMatchObject({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
    (console.warn as jest.Mock).mockRestore();
  });

  it('passes the options through and fetches an unparseable URL without pacing it', async () => {
    const { paced, fetcher, slept } = harness();

    await paced('https://cdn.shopify.com/i/1.png', { referer: 'https://shop.test/p/1' });
    expect(fetcher).toHaveBeenCalledWith('https://cdn.shopify.com/i/1.png', { referer: 'https://shop.test/p/1' });

    await paced('not a url');
    await paced('not a url');
    expect(slept).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('paces on the real clock and timer when no clock is injected', async () => {
    const tiny = { ...config, baseDelayMs: 5, minDelayMs: 1 };
    const limiter = new HostRateLimiter(() => tiny, tiny);
    const fetcher = jest.fn(async (_url: string) => ok());
    const paced = paceImageBytesByHost(fetcher, limiter);

    const started = Date.now();
    await paced('https://cdn.shopify.com/i/1.png');
    await paced('https://cdn.shopify.com/i/2.png');

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1);
  });

  it('records the dispatch even when the fetch throws, so a fault does not un-pace the host', async () => {
    let clock = 0;
    const limiter = new HostRateLimiter(() => config, config);
    const slept: number[] = [];
    const faulty = jest.fn(async (_url: string): Promise<ImageBytesResult> => { throw new Error('ECONNRESET'); });
    const paced = paceImageBytesByHost(faulty, limiter, { now: () => clock, sleep: async (ms: number) => { slept.push(ms); clock += ms; } });

    await expect(paced('https://cdn.shopify.com/i/1.png')).rejects.toThrow(/ECONNRESET/);
    expect(limiter.msUntilReady('cdn.shopify.com', clock)).toBe(1000);
  });
});
