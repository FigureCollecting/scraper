/**
 * assembleLookup × the fetch-failure ledger (E3 / E4 / E5).
 *
 * The search fan-out is terminal by construction: one pass, one attempt per store, and a store that
 * drops out is simply absent from `results`. So each of its three exits is a terminal outcome and
 * gets exactly one row, keyed on the environment-free `fc:search/<siteId>?q=…&mode=…` target (the
 * store's real search URL is a fine label, but the ledger needs one identity per store+query).
 *
 * NOT reported, deliberately: `unsupported` — a store with a bySearch URL and no parser is a
 * declared coverage gap re-asserted every pass, already tracked by the store matrix. The ledger
 * records fetches that were ATTEMPTED and failed.
 */
import { assembleLookup, type LookupServices } from '../assembleLookup';
import { buildProfileRegistry } from '../profileRegistry';
import { ChallengeCooldown, resetChallengeCooldown } from '../../services/challengeCooldown';
import type { ExtractionRuleset, SearchCandidate, StoreCapabilities } from '@figurecollecting/scraper-plugin-contract';
import type { FetchFailureReport } from '../../services/failureReporter';

const caps = (siteId: string, host: string, retrieval: StoreCapabilities['retrieval']): StoreCapabilities => ({
  siteId,
  name: siteId,
  domains: [host],
  rateLimit: { domain: host, baseDelayMs: 0, minDelayMs: 0, maxDelayMs: 100, backoffMultiplier: 2, recoveryDivisor: 2, successThreshold: 3 },
  requiresBrowser: false,
  allowedCookies: [],
  retrieval,
});

const STORE = caps('anitoysgk', 'anitoysgk.com', {
  bySearch: { urlTemplate: 'https://anitoysgk.com/search?q={q}', scope: 'listed' },
});

const CANDIDATES: SearchCandidate[] = [{ itemId: 'a1', name: 'Tomie', url: '/products/a1', available: true }];

const stub = (): ExtractionRuleset => ({
  siteId: 'anitoysgk',
  version: '0.9.15',
  extract: () => ({ source: { site: 'anitoysgk', itemId: 'x', extractedAt: '2026-09-08T00:00:00.000Z' }, fields: {}, warnings: [] }),
  validate: () => ({ valid: true, errors: [], warnings: [] }),
  extractCandidates: () => CANDIDATES,
});

const CHALLENGE_BODY = '<html><head><title>Just a moment...</title></head><body>cf</body></html>';

function build(over: Partial<LookupServices> = {}) {
  const reports: FetchFailureReport[] = [];
  const services: LookupServices = {
    profiles: buildProfileRegistry([STORE]),
    getRulesetForUrl: () => stub(),
    fetchSearch: jest.fn(async () => '{}'),
    reportFailure: async (r: FetchFailureReport) => { reports.push(r); },
    ...over,
  };
  return { reports, services, lookup: assembleLookup(services) };
}

describe('assembleLookup × fetch-failure ledger', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    // A challenge body opens the MODULE SINGLETON cooldown when no register is injected — reset it
    // so one test's challenge cannot make the next test's store read as cooling.
    resetChallengeCooldown();
  });

  afterEach(() => warn.mockRestore());

  it('E3: a cooling store is reported as cooldown with the remaining window as the hint', async () => {
    let clock = 5_000_000;
    const cd = new ChallengeCooldown({ now: () => clock, windowMs: 10 * 60_000 });
    cd.open('anitoysgk.com', 'challenge page');
    const { reports, lookup } = build({ challengeCooldown: cd });

    const result = await lookup.lookup('tomie');

    expect(result.cooldown).toEqual(['anitoysgk']);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      site: 'anitoysgk',
      kind: 'search',
      origin: 'lookup',
      reasonClass: 'cooldown',
      target: 'fc:search/anitoysgk?q=tomie&mode=listed',
    });
    // The hint is the END of the window: the remaining time (from the cooldown's own clock) added to
    // the wall clock the spine will compare against.
    const aheadMs = Date.parse(reports[0].nextRetryHint!) - Date.now();
    expect(aheadMs).toBeGreaterThan(9 * 60_000);
    expect(aheadMs).toBeLessThanOrEqual(10 * 60_000);
  });

  it('E4: a challenge search body is reported as challenge, naming the lane', async () => {
    const { reports, lookup } = build({ fetchSearch: jest.fn(async () => CHALLENGE_BODY) });

    const result = await lookup.lookup('tomie', { mode: 'orderable' });

    expect(result.failed).toEqual(['anitoysgk']);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      site: 'anitoysgk',
      kind: 'search',
      origin: 'lookup',
      reasonClass: 'challenge',
      target: 'fc:search/anitoysgk?q=tomie&mode=orderable',
      rulesetVersion: '0.9.15',
    });
  });

  it('E5: a store timeout is reported as timeout', async () => {
    const { reports, lookup } = build({
      fetchSearch: jest.fn(async () => { throw new Error('search timed out after 15000ms'); }),
    });

    await lookup.lookup('tomie');

    expect(reports).toHaveLength(1);
    expect(reports[0].reasonClass).toBe('timeout');
  });

  it('E5: an extraction throw is reported as parse, not as a transport fault', async () => {
    const { reports, lookup } = build({
      getRulesetForUrl: () => ({ ...stub(), extractCandidates: () => { throw new Error('Cannot read properties of undefined'); } }),
    });

    await lookup.lookup('tomie');

    expect(reports).toHaveLength(1);
    expect(reports[0].reasonClass).toBe('parse');
  });

  it('urlencodes the query in the canonical target', async () => {
    const { reports, lookup } = build({
      fetchSearch: jest.fn(async () => { throw new Error('boom'); }),
    });

    await lookup.lookup('tomie & marin');

    expect(reports[0].target).toBe('fc:search/anitoysgk?q=tomie%20%26%20marin&mode=listed');
  });

  it('does NOT report an unsupported store — a declared coverage gap is not a failed fetch', async () => {
    const { reports, lookup } = build({ getRulesetForUrl: () => undefined });

    const result = await lookup.lookup('tomie');

    expect(result.unsupported).toEqual(['anitoysgk']);
    expect(reports).toHaveLength(0);
  });

  it('reports nothing when a store succeeds', async () => {
    const { reports, lookup } = build();

    await lookup.lookup('tomie');

    expect(reports).toHaveLength(0);
  });

  it('runs unchanged with no reporter wired, and never lets a reporter throw break the fan-out', async () => {
    const noReporter = assembleLookup({
      profiles: buildProfileRegistry([STORE]),
      getRulesetForUrl: () => stub(),
      fetchSearch: jest.fn(async () => { throw new Error('boom'); }),
    });
    await expect(noReporter.lookup('tomie')).resolves.toMatchObject({ failed: ['anitoysgk'] });

    const throwing = assembleLookup({
      profiles: buildProfileRegistry([STORE]),
      getRulesetForUrl: () => stub(),
      fetchSearch: jest.fn(async () => { throw new Error('boom'); }),
      reportFailure: () => { throw new Error('reporter exploded'); },
    });
    await expect(throwing.lookup('tomie')).resolves.toMatchObject({ failed: ['anitoysgk'] });
  });
});
