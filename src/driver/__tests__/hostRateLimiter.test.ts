/**
 * TDD (red first): HostRateLimiter — the new driver's PER-HOST throttle,
 * replacing the legacy queue's single global delay. Each host carries its own
 * delay/backoff/recovery seeded from that store's rate config (StoreProfile
 * `rateLimit`), so parallel stores never share a throttle and a Cloudflare
 * block on one host cannot slow another.
 */
import { HostRateLimiter, wrapFetchBodyWithLimiter, type HostRateConfig } from '../hostRateLimiter';
import { DispatchScheduler } from '../dispatchScheduler';
import { PoolRouter } from '../poolRouter';
import type { ExtractContext } from '@figurecollecting/scraper-plugin-contract';

const cfg = (over: Partial<HostRateConfig> = {}): HostRateConfig => ({
  baseDelayMs: 1000,
  minDelayMs: 250,
  maxDelayMs: 60000,
  backoffMultiplier: 2,
  recoveryDivisor: 2,
  successThreshold: 3,
  ...over,
});

describe('HostRateLimiter — per-host throttle', () => {
  it('starts each host at its own base delay (independent config)', () => {
    const rl = new HostRateLimiter((host) =>
      host === 'a.com' ? cfg({ baseDelayMs: 1000 }) : cfg({ baseDelayMs: 5000 }),
    );
    expect(rl.currentDelay('a.com')).toBe(1000);
    expect(rl.currentDelay('b.com')).toBe(5000);
  });

  it('a rate-limit backoff on host A does not affect host B', () => {
    const rl = new HostRateLimiter(() => cfg({ baseDelayMs: 1000, backoffMultiplier: 2 }));
    rl.recordRateLimited('a.com');
    expect(rl.currentDelay('a.com')).toBe(2000); // backed off
    expect(rl.currentDelay('b.com')).toBe(1000); // untouched — separate host state
  });

  it('recovers per host after successThreshold consecutive successes', () => {
    const rl = new HostRateLimiter(() =>
      cfg({ baseDelayMs: 4000, recoveryDivisor: 2, successThreshold: 3 }),
    );
    rl.recordRateLimited('a.com'); // 8000
    rl.recordSuccess('a.com');
    rl.recordSuccess('a.com');
    expect(rl.currentDelay('a.com')).toBe(8000); // not yet at threshold
    rl.recordSuccess('a.com'); // 3rd → one recovery step
    expect(rl.currentDelay('a.com')).toBe(4000); // 8000 / 2
  });

  it('clamps delay to [minDelayMs, maxDelayMs]', () => {
    const rl = new HostRateLimiter(() => cfg({ baseDelayMs: 1000, maxDelayMs: 1500, backoffMultiplier: 2 }));
    rl.recordRateLimited('a.com'); // 2000 → clamp 1500
    rl.recordRateLimited('a.com'); // 3000 → clamp 1500
    expect(rl.currentDelay('a.com')).toBe(1500);
  });

  it('msUntilReady counts down the per-host delay from the last dispatch', () => {
    const rl = new HostRateLimiter(() => cfg({ baseDelayMs: 1000 }));
    rl.recordDispatch('a.com', 10_000);
    expect(rl.msUntilReady('a.com', 10_400)).toBe(600); // 1000 - 400 elapsed
    expect(rl.msUntilReady('a.com', 11_000)).toBe(0); // delay elapsed → ready
    expect(rl.msUntilReady('never-dispatched.com', 11_000)).toBe(0); // fresh host is ready
  });

  it('falls back to the default config for a host with no profile', () => {
    const rl = new HostRateLimiter(() => undefined, cfg({ baseDelayMs: 2067 }));
    expect(rl.currentDelay('unmapped.example')).toBe(2067);
  });

  it('resets the success streak on a rate-limit (no accidental recovery)', () => {
    const rl = new HostRateLimiter(() => cfg({ baseDelayMs: 1000, successThreshold: 3, recoveryDivisor: 2 }));
    rl.recordSuccess('a.com');
    rl.recordSuccess('a.com');
    rl.recordRateLimited('a.com'); // streak reset + backoff → 2000
    rl.recordSuccess('a.com'); // only 1 toward threshold now
    expect(rl.currentDelay('a.com')).toBe(2000); // no recovery yet
  });

  it('treats a dispatch at now=0 as real (0 is a valid time, not the never-dispatched sentinel)', () => {
    const rl = new HostRateLimiter(() => cfg({ baseDelayMs: 1000 }));
    rl.recordDispatch('a.com', 0);
    expect(rl.msUntilReady('a.com', 400)).toBe(600); // throttled from t=0, not treated as fresh
  });

  /**
   * Challenger H1 finding (blocker, seam-2 host-key mismatch): every writer/reader keys by the
   * RAW string a caller happened to pass — CrawlTask.host comes from StoreCapabilities.domains[0]
   * (e.g. 'amiami.com'), while wrapFetchBodyWithLimiter's follow-up dispatch is keyed by the
   * fetched URL's own hostname (e.g. 'www.amiami.com'). This repo's own fixtures already mix both
   * conventions for the SAME siteId ('amiami') across assembleScheduler.test.ts (no www) and
   * assembleCrawlDriver.test.ts (www) — proving the two never being guaranteed equal is not a
   * hypothetical. The limiter must collapse both forms to ONE host entry so a fetchBody follow-up
   * always lands on the same state a primary dispatch already created, regardless of which form
   * each side used.
   */
  it('collapses a www-prefixed host and its bare form to the SAME internal state (trimmed, lowercased)', () => {
    const rl = new HostRateLimiter(() => cfg({ baseDelayMs: 1000 }));
    rl.recordDispatch('amiami.com', 1000);
    // Read back through the www-prefixed form a fetchBody follow-up's hostnameOf() would produce.
    expect(rl.msUntilReady('www.amiami.com', 1000)).toBe(1000);
    expect(rl.currentDelay('www.amiami.com')).toBe(1000);

    // And the reverse direction, plus stray whitespace/casing a URL hostname never has but a
    // config string might.
    rl.recordDispatch('  WWW.AmiAmi.com  ', 1500);
    expect(rl.msUntilReady('amiami.com', 1500)).toBe(1000);
  });
});

/**
 * TDD (red first): H1 seam 2 — the crawl driver's in-slot `ctx.scraping.fetchBody` follow-up is
 * invisible to HostRateLimiter today (it is issued mid-slot, entirely outside DispatchScheduler's
 * dispatch/settle cycle), so slot pacing for the NEXT primary dispatch to that host only knows
 * about the PRIMARY fetch's own timing, understating how recently the host was actually hit.
 * `wrapFetchBodyWithLimiter` closes that gap: it wraps an ExtractContext's `fetchBody` so every
 * call also records a dispatch on the limiter for the target host.
 */
const STUB_SCRAPING = {
  scrapePage: jest.fn(),
  scrapePageStealth: jest.fn(),
  browserFetch: jest.fn(),
  withBrowser: jest.fn(),
  withPage: jest.fn(),
};

describe('wrapFetchBodyWithLimiter — routes driver fetchBody dispatches through the limiter', () => {
  it("records a dispatch on the limiter, at the call's own time, when fetchBody is invoked", async () => {
    const rl = new HostRateLimiter(() => cfg({ baseDelayMs: 1000 }));
    const fetchBody = jest.fn().mockResolvedValue({ html: 'x' });
    const ctx = { config: {}, logger: {}, scraping: { ...STUB_SCRAPING, fetchBody } } as unknown as ExtractContext;

    const wrapped = wrapFetchBodyWithLimiter(ctx, rl, () => 5000);
    expect(rl.msUntilReady('orzgk.com', 5000)).toBe(0); // never dispatched yet

    const result = await wrapped.scraping.fetchBody!('https://orzgk.com/api/x');

    expect(result).toEqual({ html: 'x' });
    expect(fetchBody).toHaveBeenCalledWith('https://orzgk.com/api/x', undefined);
    expect(rl.msUntilReady('orzgk.com', 5000)).toBe(1000); // just recorded as dispatched at t=5000
  });

  it('leaves an ExtractContext with no fetchBody unchanged (same reference — nothing to wrap)', () => {
    const rl = new HostRateLimiter(() => cfg());
    const ctx = { config: {}, logger: {}, scraping: { ...STUB_SCRAPING } } as unknown as ExtractContext;

    expect(wrapFetchBodyWithLimiter(ctx, rl)).toBe(ctx);
  });

  it('never throws and skips recording for an unparseable url', async () => {
    const rl = new HostRateLimiter(() => cfg());
    const fetchBody = jest.fn().mockResolvedValue({ html: 'x' });
    const ctx = { config: {}, logger: {}, scraping: { ...STUB_SCRAPING, fetchBody } } as unknown as ExtractContext;
    const wrapped = wrapFetchBodyWithLimiter(ctx, rl, () => 1000);

    await expect(wrapped.scraping.fetchBody!('not a url')).resolves.toEqual({ html: 'x' });
  });

  it('passes opts through to the original fetchBody untouched', async () => {
    const rl = new HostRateLimiter(() => cfg());
    const fetchBody = jest.fn().mockResolvedValue({ html: 'x' });
    const ctx = { config: {}, logger: {}, scraping: { ...STUB_SCRAPING, fetchBody } } as unknown as ExtractContext;
    const wrapped = wrapFetchBodyWithLimiter(ctx, rl, () => 1000);

    await wrapped.scraping.fetchBody!('https://orzgk.com/api/x', { cookies: { a: 'b' } });

    expect(fetchBody).toHaveBeenCalledWith('https://orzgk.com/api/x', { cookies: { a: 'b' } });
  });

  /**
   * Challenger H1 finding (blocker, seam-2 dispatch-time race): recordDispatch must happen when
   * the follow-up is SENT, not once it resolves — otherwise a same-host primary dispatch decided
   * WHILE the follow-up is still in flight sees a stale lastRequestTime and wrongly proceeds
   * (DispatchScheduler.dispatch's OWN primary recordDispatch already does this correctly, BEFORE
   * its await — this seam must match that convention). Proven end-to-end against the real
   * DispatchScheduler + PoolRouter (capacity fetch:2, so a second same-host task CAN take a free
   * slot concurrently — the exact precondition the finding calls out), with the follow-up's
   * promise deliberately left unresolved to prove the recording cannot be waiting on it.
   */
  it("records the fetchBody follow-up's dispatch on the limiter BEFORE it resolves, so a same-host primary dispatch decided while it is still in flight is correctly paced", () => {
    const rl = new HostRateLimiter(() => cfg({ baseDelayMs: 1000 }));
    const router = new PoolRouter({ browser: 0, fetch: 2 });
    const scheduler = new DispatchScheduler(rl, router, () => 'fetch');

    scheduler.enqueue({ id: 'A1', host: 'host-a.test' });
    scheduler.enqueue({ id: 'A2', host: 'host-a.test' });

    // A1 dispatches at t=0 (primary): takes a fetch slot, records lastRequestTime=0.
    expect(scheduler.dispatch(0)).not.toBeNull();
    // A2 correctly deferred at t=0 by A1's OWN primary dispatch (host throttled until t=1000).
    expect(scheduler.dispatch(0)).toBeNull();

    // Simulate A1's in-slot worker: once its own primary floor clears (t=1000) it issues an
    // in-slot fetchBody follow-up to the SAME host — never resolved here, so any correct behavior
    // MUST come from recording at call time, not from awaiting the promise.
    const fetchBody = jest.fn(() => new Promise(() => {})); // never settles
    const ctx = { config: {}, logger: {}, scraping: { ...STUB_SCRAPING, fetchBody } } as unknown as ExtractContext;
    const wrapped = wrapFetchBodyWithLimiter(ctx, rl, () => 1000);
    void wrapped.scraping.fetchBody!('https://host-a.test/api/follow-up'); // fire-and-forget, still pending

    // A2's dispatch decision, made right after the follow-up was sent (but before it could ever
    // resolve), must already see the follow-up's dispatch — host-a was just contacted at t=1000,
    // so A2 must not be dispatchable until t=2000.
    expect(scheduler.dispatch(1000)).toBeNull();
    expect(scheduler.dispatch(1999)).toBeNull();
    expect(scheduler.dispatch(2000)).not.toBeNull();
  });
});
