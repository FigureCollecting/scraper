/**
 * PoolRouter — a pure by-pool concurrency semaphore. Callers pass the resolved PoolKind (the
 * driver derives it from a store's public `requiresBrowser`, so the private access taxonomy
 * never reaches the engine). Capacity is sized against the crawl-rate budget.
 */
import { PoolRouter } from '../poolRouter';

describe('PoolRouter — per-pool capacity', () => {
  it('acquires slots up to the pool capacity, then reports saturation', () => {
    const r = new PoolRouter({ browser: 2, fetch: 4 });
    expect(r.tryAcquire('browser')).toBe(true);
    expect(r.tryAcquire('browser')).toBe(true);
    expect(r.hasCapacity('browser')).toBe(false);
    expect(r.tryAcquire('browser')).toBe(false); // saturated
  });

  it('keeps pool capacities independent (browser saturation does not block fetch)', () => {
    const r = new PoolRouter({ browser: 1, fetch: 2 });
    expect(r.tryAcquire('browser')).toBe(true);
    expect(r.tryAcquire('browser')).toBe(false); // browser full
    expect(r.tryAcquire('fetch')).toBe(true); // fetch unaffected
    expect(r.tryAcquire('fetch')).toBe(true);
    expect(r.hasCapacity('fetch')).toBe(false);
  });

  it('release frees a slot for reuse', () => {
    const r = new PoolRouter({ browser: 1, fetch: 1 });
    expect(r.tryAcquire('browser')).toBe(true);
    expect(r.tryAcquire('browser')).toBe(false);
    r.release('browser');
    expect(r.available('browser')).toBe(1);
    expect(r.tryAcquire('browser')).toBe(true);
  });

  it('release never underflows below zero', () => {
    const r = new PoolRouter({ browser: 1, fetch: 1 });
    r.release('browser');
    r.release('browser');
    expect(r.inFlightOf('browser')).toBe(0);
    expect(r.available('browser')).toBe(1);
  });

  it('available reflects in-flight and never reports negative', () => {
    const r = new PoolRouter({ browser: 3, fetch: 1 });
    r.tryAcquire('browser');
    r.tryAcquire('browser');
    expect(r.inFlightOf('browser')).toBe(2);
    expect(r.available('browser')).toBe(1);
    expect(r.capacityOf('browser')).toBe(3);
  });
});
