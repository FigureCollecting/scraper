/**
 * The PRODUCTION wiring of /lookup and /catalog (src/index.ts → createEngineLookup / createEngineCatalog
 * → wireServices) with NO injected impersonate transport: the engine's default impit session. Before
 * challenger round 1 on PR #334, the search fan-out, the listing axis and the seed axis read the BODY
 * lane (impitFetchBody), which drops the status the lane saw — so a gated host answering 500 "Internal
 * Server Error" counted as clean: FRESH, and the shared gate-failure run reset.
 *
 * The native impit is faked underneath the REAL createImpitFetchers, so both default surfaces
 * (impitFetchBody / impitFetchBodyDetailed) are the genuine lanes over one fake session; the singleton
 * cooldown and the singleton CfCookieStore (CF_COOKIE_FILE fixture, which holds an mfc jar) are the
 * ones the engine really uses.
 */
let mockAnswer = { status: 200, text: '' };
jest.mock('../../services/impitFetch', () => {
  const actual = jest.requireActual('../../services/impitFetch');
  const lanes = actual.createImpitFetchers(
    async () => ({ fetch: async () => ({ status: mockAnswer.status, text: async () => mockAnswer.text }) }),
    { store: { cookiesFor: () => undefined, userAgentFor: () => undefined } },
  );
  return { ...actual, impitFetchBody: lanes.body, impitFetchBodyDetailed: lanes.detailed };
});

import { join } from 'path';
import type { ExtractionRuleset, StoreCapabilities } from '@figurecollecting/scraper-plugin-contract';
import { createEngineLookup, createEngineCatalog, type LookupRegistry } from '../../services/engineLookup';
import { getChallengeCooldown, resetChallengeCooldown } from '../../services/challengeCooldown';
import { getCfCookieStore, resetCfCookieStore } from '../../services/cookieJar';

const MFC = 'myfigurecollection.net';
const INTERNAL_ERROR = 'Internal Server Error';
const SECURITY_CHECK = '<html><head><title>Security check | MyFigure</title></head><body>' + 'x'.repeat(37_000) + '</body></html>';

const STORE: StoreCapabilities = {
  siteId: 'mfc', name: 'MFC', domains: [MFC],
  rateLimit: { domain: MFC, baseDelayMs: 0, minDelayMs: 0, maxDelayMs: 100, backoffMultiplier: 2, recoveryDivisor: 2, successThreshold: 3 },
  requiresBrowser: false, allowedCookies: [],
  searchFetch: { transport: 'impersonate', browser: 'chrome142' },
  retrieval: {
    bySearch: { urlTemplate: `https://${MFC}/search?q={q}`, scope: 'listed' },
    byListing: { urlTemplate: `https://${MFC}/item/browse/figure/?page={page}`, order: 'newest' },
    seedLists: [{ id: 'top', url: `https://${MFC}/item/browse/top/`, cadence: 'weekly' }],
  },
};
const RULESET = {
  siteId: 'mfc', version: '1', extract: jest.fn(), validate: jest.fn(),
  extractCandidates: () => [], extractListing: () => ({ items: [{ itemId: '1' }], hasMore: false }), extractSeedList: () => ({ items: [{ itemId: '1' }] }),
} as unknown as ExtractionRuleset;
const registry: LookupRegistry = { allStores: () => [STORE], getRulesetForUrl: () => RULESET };

describe('production wiring: /lookup and /catalog read the status-aware impit lane', () => {
  const ORIGINAL_FILE = process.env.CF_COOKIE_FILE;
  const ORIGINAL_THRESHOLD = process.env.GATE_FAILURE_COOLDOWN_THRESHOLD;

  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    process.env.CF_COOKIE_FILE = join(__dirname, '../fixtures/cfCookies/cf-cookies.json');
    delete process.env.GATE_FAILURE_COOLDOWN_THRESHOLD; // the production default, 5
    resetCfCookieStore();
    resetChallengeCooldown();
  });
  afterEach(() => {
    resetCfCookieStore();
    resetChallengeCooldown();
    if (ORIGINAL_FILE === undefined) delete process.env.CF_COOKIE_FILE; else process.env.CF_COOKIE_FILE = ORIGINAL_FILE;
    if (ORIGINAL_THRESHOLD === undefined) delete process.env.GATE_FAILURE_COOLDOWN_THRESHOLD; else process.env.GATE_FAILURE_COOLDOWN_THRESHOLD = ORIGINAL_THRESHOLD;
    jest.restoreAllMocks();
  });

  const mfcRow = () => getCfCookieStore().view().find((r) => r.host === MFC);
  const strike = (n: number) => { for (let i = 0; i < n; i++) getChallengeCooldown().recordGateFailure(MFC, 'queue empty 500'); };

  it.each([
    ['/lookup search', () => createEngineLookup(registry).lookup('marin')],
    ['/catalog listing', () => createEngineCatalog(registry).catalog('mfc', 1)],
    ['/catalog seed', () => createEngineCatalog(registry).seed('mfc', 'top')],
  ])('%s: a 500 "Internal Server Error" from the jar-holding mfc host is the 5th strike — the cooldown opens, the jar goes stale', async (_site, run) => {
    strike(4);
    mockAnswer = { status: 500, text: INTERNAL_ERROR };
    await run();
    expect({ run: getChallengeCooldown().gateFailureCount(MFC), open: getChallengeCooldown().isOpen(MFC) }).toEqual({ run: 5, open: true });
    expect(mfcRow()).toMatchObject({ stale: true, staleReason: 'gate failure via impersonate transport: HTTP 500' });
  });

  it.each([
    ['/lookup search', () => createEngineLookup(registry).lookup('marin')],
    ['/catalog listing', () => createEngineCatalog(registry).catalog('mfc', 1)],
    ['/catalog seed', () => createEngineCatalog(registry).seed('mfc', 'top')],
  ])('%s: a 403 "Security check" page neither resets the run nor clears a standing stale mark', async (_site, run) => {
    strike(4);
    getCfCookieStore().markStale(MFC, 'impersonate', 'queue gate failure');
    mockAnswer = { status: 403, text: SECURITY_CHECK };
    await run();
    expect({ run: getChallengeCooldown().gateFailureCount(MFC), stale: mfcRow()?.stale }).toEqual({ run: 4, stale: true });
  });

  it.each([
    ['/lookup search', () => createEngineLookup(registry).lookup('marin')],
    ['/catalog listing', () => createEngineCatalog(registry).catalog('mfc', 1)],
    ['/catalog seed', () => createEngineCatalog(registry).seed('mfc', 'top')],
  ])('%s: a real 200 still proves the host — run reset, stale mark cleared', async (_site, run) => {
    strike(2);
    getCfCookieStore().markStale(MFC, 'impersonate', 'queue gate failure');
    mockAnswer = { status: 200, text: '<html><body>page</body></html>' };
    await run();
    expect({ run: getChallengeCooldown().gateFailureCount(MFC), stale: mfcRow()?.stale }).toEqual({ run: 0, stale: false });
  });
});

/**
 * Challenger round 2 on PR #334: the PLAIN-HTTP default is status-aware too. wireServices builds
 * fetchSearchDetail over `httpFetchBodyDetailed`; the body-only `httpFetchBody` there would hand the
 * gate a status-blind "Internal Server Error" page, which proves nothing — no strike, no stale mark.
 * Global fetch is faked underneath the REAL http lane; anitoysgk.com holds a jar in the fixture and
 * declares no transport, so it takes the http lane.
 */
describe('production wiring: /lookup and /catalog read the status-aware http lane', () => {
  const ANITOYS = 'anitoysgk.com';
  const HTTP_STORE: StoreCapabilities = {
    siteId: 'anitoysgk', name: 'AniToys GK', domains: [ANITOYS],
    rateLimit: { domain: ANITOYS, baseDelayMs: 0, minDelayMs: 0, maxDelayMs: 100, backoffMultiplier: 2, recoveryDivisor: 2, successThreshold: 3 },
    requiresBrowser: false, allowedCookies: [],
    retrieval: {
      bySearch: { urlTemplate: `https://${ANITOYS}/search?q={q}`, scope: 'listed' },
      byListing: { urlTemplate: `https://${ANITOYS}/collections/all?page={page}`, order: 'newest' },
      seedLists: [{ id: 'new', url: `https://${ANITOYS}/collections/new`, cadence: 'weekly' }],
    },
  };
  const httpRegistry: LookupRegistry = { allStores: () => [HTTP_STORE], getRulesetForUrl: () => RULESET };
  const ORIGINAL_FILE = process.env.CF_COOKIE_FILE;
  const ORIGINAL_THRESHOLD = process.env.GATE_FAILURE_COOLDOWN_THRESHOLD;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    process.env.CF_COOKIE_FILE = join(__dirname, '../fixtures/cfCookies/cf-cookies.json');
    delete process.env.GATE_FAILURE_COOLDOWN_THRESHOLD;
    resetCfCookieStore();
    resetChallengeCooldown();
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(
      async () => ({ status: 500, url: '', text: async () => INTERNAL_ERROR }) as unknown as Response,
    );
  });
  afterEach(() => {
    resetCfCookieStore();
    resetChallengeCooldown();
    if (ORIGINAL_FILE === undefined) delete process.env.CF_COOKIE_FILE; else process.env.CF_COOKIE_FILE = ORIGINAL_FILE;
    if (ORIGINAL_THRESHOLD === undefined) delete process.env.GATE_FAILURE_COOLDOWN_THRESHOLD; else process.env.GATE_FAILURE_COOLDOWN_THRESHOLD = ORIGINAL_THRESHOLD;
    jest.restoreAllMocks();
  });

  it.each([
    ['/lookup search', () => createEngineLookup(httpRegistry).lookup('marin')],
    ['/catalog listing', () => createEngineCatalog(httpRegistry).catalog('anitoysgk', 1)],
    ['/catalog seed', () => createEngineCatalog(httpRegistry).seed('anitoysgk', 'new')],
  ])('%s: a 500 "Internal Server Error" over plain http from the jar-holding host is the 5th strike — the cooldown opens, the jar goes stale', async (_site, run) => {
    for (let i = 0; i < 4; i++) getChallengeCooldown().recordGateFailure(ANITOYS, 'queue 500');
    await run();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect({ run: getChallengeCooldown().gateFailureCount(ANITOYS), open: getChallengeCooldown().isOpen(ANITOYS) }).toEqual({ run: 5, open: true });
    expect(getCfCookieStore().view().find((r) => r.host === ANITOYS)).toMatchObject({ stale: true, staleReason: 'gate failure via http transport: HTTP 500' });
  });
});
