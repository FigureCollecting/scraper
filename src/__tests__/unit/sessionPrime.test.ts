/**
 * resolvePrime — maps a store's `searchFetch.sessionPrime` declaration + the target URL to the
 * concrete prime target the impersonate transport consumes (`{ url }`), or undefined when the store
 * declares no prime. Origin-by-default; explicit primeUrl overrides.
 */
import { resolvePrime } from '../../services/sessionPrime';
import type { SearchFetch } from '@figurecollecting/scraper-plugin-contract';

const TARGET = 'https://www.anitoysgk.com/Star-Origin-Studio-1-6-Lucy-p29358268.html';

describe('resolvePrime', () => {
  it('sessionPrime true → primes the target URL ORIGIN', () => {
    const sf: SearchFetch = { transport: 'impersonate', sessionPrime: true };
    expect(resolvePrime(sf, TARGET)).toEqual({ url: 'https://www.anitoysgk.com' });
  });

  it('sessionPrime {} (object, no primeUrl) → primes the origin', () => {
    const sf: SearchFetch = { transport: 'impersonate', sessionPrime: {} };
    expect(resolvePrime(sf, TARGET)).toEqual({ url: 'https://www.anitoysgk.com' });
  });

  it('sessionPrime { primeUrl } → primes the explicit URL', () => {
    const sf: SearchFetch = { transport: 'impersonate', sessionPrime: { primeUrl: 'https://www.anitoysgk.com/home' } };
    expect(resolvePrime(sf, TARGET)).toEqual({ url: 'https://www.anitoysgk.com/home' });
  });

  it('sessionPrime false → no prime (undefined)', () => {
    expect(resolvePrime({ transport: 'impersonate', sessionPrime: false }, TARGET)).toBeUndefined();
  });

  it('no sessionPrime declared → no prime (undefined) — undeclared stores are untouched', () => {
    expect(resolvePrime({ transport: 'impersonate' }, TARGET)).toBeUndefined();
  });

  it('undefined searchFetch → no prime (undefined)', () => {
    expect(resolvePrime(undefined, TARGET)).toBeUndefined();
  });

  it('an unparseable target URL with origin-default → undefined (never throws)', () => {
    expect(resolvePrime({ sessionPrime: true }, 'not a url')).toBeUndefined();
  });
});
