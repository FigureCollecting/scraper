/**
 * Guard — the interactive /lookup path (assembleLookup Promise.all fan-out) is NOT gated by the
 * ingest queue's per-host pacing floor. Per-store differentiated pacing (SCRAPER_HOST_BASE_DELAY_MS
 * / SCRAPER_HOST_HARD_FLOOR_MS) governs ONLY the bulk ingest queue's getNextProcessableItem; the
 * buy-decision search must stay a full concurrent fan-out so a user's lookup is not paced like a
 * background crawl. This pins that boundary: even with BOTH pacing knobs set to absurd values, the
 * fan-out issues every store's search CONCURRENTLY and returns without any floor delay.
 *
 * Real timers (no queue harness): the assertion is on concurrency of the injected fetchSearch.
 */
import { assembleLookup, type LookupServices } from '../../driver/assembleLookup';
import { buildProfileRegistry } from '../../driver/profileRegistry';
import type {
  ExtractionRuleset,
  SearchCandidate,
  StoreCapabilities,
} from '@figurecollecting/scraper-plugin-contract';

const caps = (siteId: string, host: string, retrieval: StoreCapabilities['retrieval']): StoreCapabilities => ({
  siteId,
  name: siteId,
  domains: [host],
  rateLimit: { domain: host, baseDelayMs: 3000, minDelayMs: 0, maxDelayMs: 100, backoffMultiplier: 2, recoveryDivisor: 2, successThreshold: 3 },
  requiresBrowser: false,
  allowedCookies: [],
  retrieval,
});

const GOODSMILEUS = caps('goodsmileus', 'www.goodsmileus.com', {
  bySearch: { urlTemplate: 'https://www.goodsmileus.com/search?q={q}&type=product', scope: 'listed' },
});
const SOLARIS = caps('solaris', 'solarisjapan.com', {
  bySearch: { urlTemplate: 'https://solarisjapan.com/search/suggest.json?q={q}&resources[type]=product', scope: 'listed' },
});

const CANDS: SearchCandidate[] = [{ itemId: 'x', name: 'Figure X', url: '/p/x', available: true }];

const stub = (siteId: string): ExtractionRuleset => ({
  siteId,
  version: '1.0.0',
  extract: () => ({ source: { site: siteId, itemId: 'x', extractedAt: '2026-09-02T00:00:00.000Z' }, fields: {}, warnings: [] }),
  validate: () => ({ valid: true, errors: [], warnings: [] }),
  extractCandidates: () => CANDS,
});

describe('assembleLookup (/lookup) — interactive path is NOT gated by the queue per-host pacing floor', () => {
  const BASE_ENV = 'SCRAPER_HOST_BASE_DELAY_MS';
  const HARD_ENV = 'SCRAPER_HOST_HARD_FLOOR_MS';
  let savedBase: string | undefined;
  let savedHard: string | undefined;

  beforeEach(() => {
    savedBase = process.env[BASE_ENV];
    savedHard = process.env[HARD_ENV];
  });
  afterEach(() => {
    if (savedBase === undefined) delete process.env[BASE_ENV]; else process.env[BASE_ENV] = savedBase;
    if (savedHard === undefined) delete process.env[HARD_ENV]; else process.env[HARD_ENV] = savedHard;
  });

  it('fans out every store search CONCURRENTLY even with both pacing knobs set to 999999ms — no per-host floor reaches the lookup path', async () => {
    // If the interactive path consulted the queue's per-host floor, these absurd values would
    // serialize (or stall) the fan-out. They must have NO effect here.
    process.env[BASE_ENV] = '999999';
    process.env[HARD_ENV] = '999999';

    let inFlight = 0;
    let maxInFlight = 0;
    const release: Array<() => void> = [];

    // Each fetchSearch parks until we release it, so all concurrent calls pile up before ANY returns
    // — maxInFlight then equals the number of stores fanned out (2) iff nothing paced them apart.
    const fetchSearch = jest.fn(async (_url: string) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => release.push(resolve));
      inFlight -= 1;
      return '{}';
    });

    const services: LookupServices = {
      profiles: buildProfileRegistry([GOODSMILEUS, SOLARIS]),
      getRulesetForUrl: (url) =>
        url.includes('goodsmileus') ? stub('goodsmileus')
        : url.includes('solaris') ? stub('solaris')
        : undefined,
      fetchSearch,
    };

    const out = assembleLookup(services).lookup('tomie');

    // Let both fan-out branches reach their (parked) fetchSearch, then release them.
    await Promise.resolve();
    await Promise.resolve();
    expect(maxInFlight).toBe(2); // BOTH stores' searches were in flight at once — no floor serialized them
    release.forEach((r) => r());

    const result = await out;
    expect(result.results.map((r) => r.siteId).sort()).toEqual(['goodsmileus', 'solaris']);
    expect(fetchSearch).toHaveBeenCalledTimes(2);
  });
});
