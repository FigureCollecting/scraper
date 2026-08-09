/**
 * TDD: CrawlLoop — the dispatch → worker → settle runtime. Driven by a VIRTUAL clock (sleep
 * advances a counter; time only moves when the loop sleeps) and microtask-yield workers, so the
 * async behaviour is fully deterministic — no real timers.
 */
import type { StoreCapabilities } from '@figurecollecting/scraper-plugin-contract';
import type { Outcome } from '../dispatchScheduler';
import { ProfileRegistry } from '../profileRegistry';
import { assembleScheduler } from '../assembleScheduler';
import { CrawlLoop } from '../crawlLoop';

const makeClock = () => {
  let t = 0;
  return { now: () => t, sleep: async (ms: number): Promise<void> => { t += ms; }, at: () => t };
};

const caps = (siteId: string, host: string, requiresBrowser: boolean, baseDelayMs = 1000): StoreCapabilities => ({
  siteId, name: siteId, domains: [host], requiresBrowser, allowedCookies: [],
  rateLimit: {
    domain: host, baseDelayMs, minDelayMs: 100, maxDelayMs: 60_000,
    backoffMultiplier: 2, recoveryDivisor: 2, successThreshold: 3,
  },
});

describe('CrawlLoop — dispatch → worker → settle runtime', () => {
  it('processes every queued task and reports stats', async () => {
    const clk = makeClock();
    const { scheduler } = assembleScheduler(new ProfileRegistry(), { browser: 2, fetch: 4 });
    const seen: string[] = [];
    const worker = async (t: { id: string }): Promise<Outcome> => { seen.push(t.id); return 'success'; };
    scheduler.enqueue({ id: 'a', host: 'h1.com' });
    scheduler.enqueue({ id: 'b', host: 'h2.com' });
    const stats = await new CrawlLoop(scheduler, { ...clk, worker }).run();
    expect(seen.sort()).toEqual(['a', 'b']);
    expect(stats).toMatchObject({ dispatched: 2, completed: 2, failed: 0 });
  });

  it('runs distinct fetch-pool tasks concurrently up to capacity', async () => {
    const clk = makeClock();
    const { scheduler } = assembleScheduler(new ProfileRegistry(), { browser: 1, fetch: 4 });
    let concurrent = 0;
    let max = 0;
    const worker = async (): Promise<Outcome> => {
      concurrent += 1; max = Math.max(max, concurrent);
      await Promise.resolve();
      concurrent -= 1; return 'success';
    };
    for (const id of ['a', 'b', 'c']) scheduler.enqueue({ id, host: `${id}.com` }); // 3 distinct fetch hosts
    await new CrawlLoop(scheduler, { ...clk, worker }).run();
    expect(max).toBe(3); // all three in flight at once (fetch cap 4)
  });

  it('caps concurrency at the browser pool size', async () => {
    const clk = makeClock();
    const reg = new ProfileRegistry();
    reg.register(caps('a', 'a.com', true));
    reg.register(caps('b', 'b.com', true)); // both browser
    const { scheduler } = assembleScheduler(reg, { browser: 1, fetch: 4 });
    let concurrent = 0;
    let max = 0;
    const worker = async (): Promise<Outcome> => {
      concurrent += 1; max = Math.max(max, concurrent);
      await Promise.resolve();
      concurrent -= 1; return 'success';
    };
    scheduler.enqueue({ id: '1', host: 'a.com' });
    scheduler.enqueue({ id: '2', host: 'b.com' });
    const stats = await new CrawlLoop(scheduler, { ...clk, worker }).run();
    expect(max).toBe(1); // browser cap 1 serialized them
    expect(stats.completed).toBe(2);
  });

  it('serializes same-host tasks across the throttle, advancing the clock', async () => {
    const clk = makeClock();
    const reg = new ProfileRegistry();
    reg.register(caps('s', 'h.com', false, 1000)); // fetch pool, 1000ms base delay
    const { scheduler } = assembleScheduler(reg, { browser: 1, fetch: 4 });
    const times: number[] = [];
    const worker = async (): Promise<Outcome> => { times.push(clk.at()); return 'success'; };
    scheduler.enqueue({ id: '1', host: 'h.com' });
    scheduler.enqueue({ id: '2', host: 'h.com' });
    await new CrawlLoop(scheduler, { ...clk, worker }).run();
    expect(times.length).toBe(2);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(1000); // second waited out the throttle
  });

  it('a thrown worker settles as rate-limited (backs the host off) and counts as failed', async () => {
    const clk = makeClock();
    const reg = new ProfileRegistry();
    reg.register(caps('s', 'h.com', false, 1000));
    const { scheduler, limiter } = assembleScheduler(reg, { browser: 1, fetch: 4 });
    const worker = async (): Promise<Outcome> => { throw new Error('boom'); };
    scheduler.enqueue({ id: '1', host: 'h.com' });
    const stats = await new CrawlLoop(scheduler, { ...clk, worker }).run();
    expect(stats.failed).toBe(1);
    expect(limiter.currentDelay('h.com')).toBe(2000); // 1000 * backoff 2
  });
});
