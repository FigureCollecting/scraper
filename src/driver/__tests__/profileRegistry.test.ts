/**
 * TDD (red first): ProfileRegistry — indexes public StoreCapabilities by host and feeds the
 * crawl driver's scheduler seams: rateLimit → HostRateLimiter, requiresBrowser → PoolRouter
 * pool, retrieval → targeted on-request fetches. Populated by the plugin (each private
 * StoreProfile mapped down to StoreCapabilities); the engine never sees the moat axes.
 */
import type { StoreCapabilities } from '@figurecollecting/scraper-plugin-contract';
import { ProfileRegistry } from '../profileRegistry';

const caps = (over: Partial<StoreCapabilities> = {}): StoreCapabilities => ({
  siteId: 'amiami',
  name: 'AmiAmi',
  domains: ['www.amiami.com', 'amiami.com'],
  rateLimit: {
    domain: 'amiami.com', baseDelayMs: 2000, minDelayMs: 300, maxDelayMs: 180_000,
    backoffMultiplier: 1.4, recoveryDivisor: 1.4, successThreshold: 3,
  },
  requiresBrowser: true,
  allowedCookies: [],
  retrieval: { byId: { urlTemplate: 'https://www.amiami.com/eng/detail/?gcode={id}', idKind: 'store-internal' } },
  ...over,
});

describe('ProfileRegistry — host-indexed store capabilities', () => {
  it('indexes by every domain (host-normalized) and by siteId', () => {
    const r = new ProfileRegistry();
    r.register(caps());
    expect(r.forHost('www.amiami.com')?.siteId).toBe('amiami');
    expect(r.forHost('amiami.com')?.siteId).toBe('amiami'); // both domains resolve
    expect(r.forHost('AMIAMI.com')?.siteId).toBe('amiami'); // case-insensitive
    expect(r.forSite('amiami')?.siteId).toBe('amiami');
    expect(r.forHost('unknown.com')).toBeUndefined();
    expect(r.size()).toBe(1);
  });

  it('feeds the scheduler seams: rate config, pool (from requiresBrowser), retrieval', () => {
    const r = new ProfileRegistry();
    r.register(caps({ requiresBrowser: true })); // amiami → browser pool
    r.register(caps({ siteId: 'hlj', name: 'HLJ', domains: ['hlj.com'], requiresBrowser: false, retrieval: undefined }));
    expect(r.rateConfigFor('www.amiami.com')?.baseDelayMs).toBe(2000);
    expect(r.poolFor('www.amiami.com')).toBe('browser');
    expect(r.poolFor('hlj.com')).toBe('fetch'); // requiresBrowser=false → cheap fetch pool
    expect(r.retrievalFor('www.amiami.com')?.byId?.urlTemplate).toContain('{id}');
    expect(r.retrievalFor('hlj.com')).toBeUndefined(); // enumeration-only
  });

  it('returns undefined seams for an unknown host (never throws)', () => {
    const r = new ProfileRegistry();
    expect(r.rateConfigFor('nope.com')).toBeUndefined();
    expect(r.poolFor('nope.com')).toBeUndefined();
    expect(r.retrievalFor('nope.com')).toBeUndefined();
  });

  it('requiresBrowserFor: true for browser hosts, false for fetch hosts, false (never routes to browser) for unknown', () => {
    const r = new ProfileRegistry();
    r.register(caps({ requiresBrowser: true })); // amiami → browser
    r.register(caps({ siteId: 'hlj', name: 'HLJ', domains: ['hlj.com'], requiresBrowser: false }));
    expect(r.requiresBrowserFor('www.amiami.com')).toBe(true);
    expect(r.requiresBrowserFor('hlj.com')).toBe(false);
    expect(r.requiresBrowserFor('nope.com')).toBe(false); // unknown host defaults to the cheap fetch path
  });

  it('all() returns one entry per registered site', () => {
    const r = new ProfileRegistry();
    r.register(caps());
    r.register(caps({ siteId: 'hlj', domains: ['hlj.com'] }));
    expect(r.all().map((c) => c.siteId).sort()).toEqual(['amiami', 'hlj']);
  });

  it('re-registering a siteId replaces it (last wins)', () => {
    const r = new ProfileRegistry();
    r.register(caps({ requiresBrowser: true }));
    r.register(caps({ requiresBrowser: false })); // same siteId, now fetch
    expect(r.poolFor('www.amiami.com')).toBe('fetch');
    expect(r.size()).toBe(1);
  });
});
