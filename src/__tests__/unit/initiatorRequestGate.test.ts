/**
 * createRequestGate — the GLOBAL egress ceiling. Per-host pacing in the scrape
 * queue has NO cross-host cap over the single OVH egress IP; this gate is the
 * interim global cap: (a) a max number of concurrent in-flight requests across
 * ALL stores, (b) a total-request budget per run, and (c) inter-dispatch spacing.
 */
import { createRequestGate } from '../../initiator/requestGate';

const waitFor = async (pred: () => boolean, timeoutMs = 2000): Promise<void> => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 1));
  }
};

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

describe('createRequestGate', () => {
  it('never runs more than maxConcurrency fns at once', async () => {
    const gate = createRequestGate({ maxConcurrency: 2, maxRequests: 100, spacingMs: 0 });
    let active = 0;
    let peak = 0;
    const barrier = deferred();
    const run = () =>
      gate.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await barrier.promise;
        active--;
        return 'ok';
      });
    const ps = [run(), run(), run(), run(), run()];
    await waitFor(() => active === 2);
    expect(active).toBe(2);
    expect(peak).toBeLessThanOrEqual(2);
    barrier.resolve();
    const results = await Promise.all(ps);
    expect(results.every((r) => r.status === 'ok')).toBe(true);
    expect(peak).toBeLessThanOrEqual(2);
    expect(gate.peakInFlight()).toBeLessThanOrEqual(2);
    expect(gate.issued()).toBe(5);
  });

  it('never dispatches more than maxRequests total; the rest are budget-exhausted and never call the fn', async () => {
    const gate = createRequestGate({ maxConcurrency: 5, maxRequests: 3, spacingMs: 0 });
    let calls = 0;
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map(() =>
        gate.run(async () => {
          calls++;
          return 1;
        }),
      ),
    );
    expect(calls).toBe(3);
    expect(gate.issued()).toBe(3);
    expect(results.filter((r) => r.status === 'ok').length).toBe(3);
    expect(results.filter((r) => r.status === 'budget-exhausted').length).toBe(2);
  });

  it('reserves budget synchronously so a burst can never overshoot even before any fn resolves', async () => {
    const gate = createRequestGate({ maxConcurrency: 10, maxRequests: 2, spacingMs: 0 });
    const barrier = deferred();
    let calls = 0;
    const ps = [1, 2, 3, 4].map(() =>
      gate.run(async () => {
        calls++;
        await barrier.promise;
        return 1;
      }),
    );
    // Nothing has resolved yet, but only the budget's worth may have been dispatched.
    await waitFor(() => calls === 2);
    expect(calls).toBe(2);
    barrier.resolve();
    const results = await Promise.all(ps);
    expect(calls).toBe(2);
    expect(results.filter((r) => r.status === 'budget-exhausted').length).toBe(2);
  });

  it('spaces consecutive dispatches by spacingMs using the injected clock + sleep', async () => {
    const sleeps: number[] = [];
    let t = 0;
    const gate = createRequestGate({
      maxConcurrency: 1,
      maxRequests: 5,
      spacingMs: 50,
      now: () => t,
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
    });
    await gate.run(async () => 1);
    await gate.run(async () => 1);
    await gate.run(async () => 1);
    expect(sleeps).toEqual([50, 50]);
  });

  it('reports remaining budget', async () => {
    const gate = createRequestGate({ maxConcurrency: 2, maxRequests: 3, spacingMs: 0 });
    expect(gate.remaining()).toBe(3);
    await gate.run(async () => 1);
    expect(gate.remaining()).toBe(2);
  });

  it('never exceeds maxConcurrency when a fresh request arrives during the release window', async () => {
    // Regression: releasing a slot must HAND it to a waiter, not drop the count and
    // let a woken waiter re-increment later. Otherwise a fresh fast-path acquire that
    // lands between two woken waiters' continuations steals a slot and breaches the cap.
    // Reproduced deterministically at max=2: two fns share a barrier so they release
    // adjacently; two park; a fresh fn is submitted from the first's completion.
    const gate = createRequestGate({ maxConcurrency: 2, maxRequests: 100, spacingMs: 0 });
    let inside = 0;
    let peak = 0;
    let started = 0;
    const barrier = deferred();
    const longFn = () =>
      gate.run(async () => {
        started++;
        inside++;
        peak = Math.max(peak, inside);
        await barrier.promise;
        inside--;
        return 'ab';
      });
    const shortFn = (tag: string) => () =>
      gate.run(async () => {
        inside++;
        peak = Math.max(peak, inside);
        await new Promise((r) => setTimeout(r, 5));
        inside--;
        return tag;
      });
    const pA = longFn();
    const pB = longFn();
    const pC = shortFn('c')();
    const pD = shortFn('d')();
    await waitFor(() => started === 2); // A,B in-flight; C,D parked as waiters
    const pE = pA.then(() => shortFn('e')()); // fresh submit in the release window
    barrier.resolve();
    await Promise.all([pB, pC, pD, pE]);
    expect(peak).toBeLessThanOrEqual(2);
    expect(gate.peakInFlight()).toBeLessThanOrEqual(2);
  });
});
