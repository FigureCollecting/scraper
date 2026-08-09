/**
 * buildProfileRegistry — populates a driver ProfileRegistry from the public StoreCapabilities the
 * engine holds (ExtractionRegistryImpl.allStores()). Every store flows in: pool + rate come from
 * the SiteConfig base (so all stores are schedulable), retrieval rides through when present.
 */
import { buildProfileRegistry } from '../profileRegistry';
import type { StoreCapabilities } from '@figurecollecting/scraper-plugin-contract';

const caps = (over: Partial<StoreCapabilities> & { siteId: string; domains: string[] }): StoreCapabilities => ({
  name: over.siteId,
  rateLimit: {
    domain: over.domains[0],
    baseDelayMs: 1000,
    minDelayMs: 250,
    maxDelayMs: 60000,
    backoffMultiplier: 2,
    recoveryDivisor: 2,
    successThreshold: 3,
  },
  requiresBrowser: false,
  allowedCookies: [],
  ...over,
});

describe('buildProfileRegistry', () => {
  it('indexes every store by host for scheduling — pool from requiresBrowser, rate from rateLimit', () => {
    const reg = buildProfileRegistry([
      caps({ siteId: 'amiami', domains: ['www.amiami.com'], requiresBrowser: true }),
      caps({ siteId: 'hobbysearch', domains: ['hobbysearch.co.jp'] }),
    ]);

    expect(reg.size()).toBe(2);
    expect(reg.poolFor('www.amiami.com')).toBe('browser');
    expect(reg.poolFor('hobbysearch.co.jp')).toBe('fetch');
    expect(reg.rateConfigFor('www.amiami.com')?.baseDelayMs).toBe(1000);
  });

  it('carries retrieval through to retrievalFor', () => {
    const reg = buildProfileRegistry([
      caps({
        siteId: 'amiami',
        domains: ['www.amiami.com'],
        retrieval: { byId: { urlTemplate: 'https://www.amiami.com/eng/detail/?gcode={id}' } },
      }),
    ]);

    expect(reg.retrievalFor('www.amiami.com')?.byId?.urlTemplate).toContain('{id}');
  });

  it('empty input → empty registry', () => {
    expect(buildProfileRegistry([]).size()).toBe(0);
  });
});
