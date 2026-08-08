/**
 * TDD (red first): PoolRouter — routes each store to the browser/mint pool vs the cheap
 * fetch pool by its access tier, and bounds each pool's concurrency against the crawl-rate
 * budget (the binding constraint per infra-budget, NOT connection count).
 *
 * The access->pool classifier is INJECTED so the private access taxonomy (StoreProfile.access)
 * never enters the public engine — same seam as HostRateLimiter's `configFor`. Pure + synchronous.
 */
import { PoolRouter, type PoolKind } from '../poolRouter';

// A stand-in classifier: challenge / anti-bot tiers need a real browser; the rest fetch cheaply.
const classify = (access: string): PoolKind =>
  ['cloudflare', 'datadome', 'robotchecker', 'aws-waf', 'headless-fingerprint'].includes(access)
    ? 'browser'
    : 'fetch';

describe('PoolRouter — access-tier routing + per-pool capacity', () => {
  it('routes access tiers to pools via the injected classifier', () => {
    const r = new PoolRouter({ browser: 2, fetch: 4 }, classify);
    expect(r.poolFor('cloudflare')).toBe('browser');
    expect(r.poolFor('datadome')).toBe('browser');
    expect(r.poolFor('none')).toBe('fetch');
    expect(r.poolFor('age-cookie')).toBe('fetch');
  });

  it('acquires slots up to the pool capacity, then reports saturation', () => {
    const r = new PoolRouter({ browser: 2, fetch: 4 }, classify);
    expect(r.tryAcquire('cloudflare')).toEqual({ ok: true, pool: 'browser' });
    expect(r.tryAcquire('datadome')).toEqual({ ok: true, pool: 'browser' });
    expect(r.hasCapacity('browser')).toBe(false);
    expect(r.tryAcquire('aws-waf')).toEqual({ ok: false, pool: 'browser' }); // saturated
  });

  it('keeps pool capacities independent (browser saturation does not block fetch)', () => {
    const r = new PoolRouter({ browser: 1, fetch: 2 }, classify);
    expect(r.tryAcquire('cloudflare').ok).toBe(true); // browser now full
    expect(r.tryAcquire('cloudflare').ok).toBe(false);
    expect(r.tryAcquire('none').ok).toBe(true); // fetch pool unaffected
    expect(r.tryAcquire('auth').ok).toBe(true);
    expect(r.hasCapacity('fetch')).toBe(false);
  });

  it('release frees a slot for reuse', () => {
    const r = new PoolRouter({ browser: 1, fetch: 1 }, classify);
    expect(r.tryAcquire('cloudflare').ok).toBe(true);
    expect(r.tryAcquire('cloudflare').ok).toBe(false);
    r.release('browser');
    expect(r.available('browser')).toBe(1);
    expect(r.tryAcquire('cloudflare').ok).toBe(true);
  });

  it('release never underflows below zero', () => {
    const r = new PoolRouter({ browser: 1, fetch: 1 }, classify);
    r.release('browser'); // nothing in flight
    r.release('browser');
    expect(r.inFlightOf('browser')).toBe(0);
    expect(r.available('browser')).toBe(1);
  });

  it('available reflects in-flight and never reports negative', () => {
    const r = new PoolRouter({ browser: 3, fetch: 1 }, classify);
    r.tryAcquire('cloudflare');
    r.tryAcquire('datadome');
    expect(r.inFlightOf('browser')).toBe(2);
    expect(r.available('browser')).toBe(1);
  });
});
