/**
 * Challenge cooldown across the SCREEN(/lookup) → CONFIRM(/resolve) legs (finding F1).
 *
 * The cooldown goal — "a challenged host must be left alone for a cooldown window" — must hold on
 * the LIVE /resolve leg too, not only the ingest queue and the search fan-out:
 *
 *   1. LOOKUP detail plan: a record-mode lookup must NOT hand out a cooling byId-barcode host as a
 *      resolveTarget (the caller's /resolve confirm would fetch the cooling host). The store is
 *      listed under the additive `cooldown` list, never resolveTargets/failed.
 *   2. RESOLVE skip: assembleResolve must skip an id whose host is cooling WITHOUT fetching, and
 *      report it under an additive `cooldown` list (not `failed`, which means fetch/extract errored).
 *   3. RESOLVE open: a detail body that IS a Cloudflare challenge (browser lane never sets the
 *      `challenge` flag) must OPEN the host's cooldown and fail the id — at 200 (challenge that
 *      rendered) and at 5xx alike — instead of posing an empty interstitial as a confirm.
 *   4. PROD composition: createEngineLookup / createEngineResolve consult the shared singleton, so a
 *      cooldown one lane opens is honored by the other with zero explicit wiring.
 *
 * Fakes only; injected cooldown clock; own hosts. No live fetches.
 */
import { assembleLookup } from '../../driver/assembleLookup';
import { assembleResolve } from '../../driver/assembleResolve';
import { buildProfileRegistry } from '../../driver/profileRegistry';
import { createEngineLookup, type LookupRegistry } from '../../services/engineLookup';
import { createEngineResolve } from '../../services/engineResolve';
import { isCloudflareChallenge } from '../../services/engineServices/challengeDetect';
import {
  ChallengeCooldown,
  getChallengeCooldown,
  resetChallengeCooldown,
} from '../../services/challengeCooldown';
import type {
  ExtractionRuleset,
  SearchCandidate,
  StoreCapabilities,
} from '@figurecollecting/scraper-plugin-contract';

const MIN = 60_000;
const BAR = 'barstore.example.test'; // byId idKind 'barcode' → composeStoreQuery detail plan
const SRCH = 'srch.example.test'; // bySearch acceptsGtin → search plan (contrast)
const GTIN = '04571245296085';
const CLEAN_HTML = '<html><body><h1 class="title">Frieren</h1></body></html>';
/** CF managed-challenge interstitial (title + _cf_chl_opt token → isCloudflareChallenge true). */
const CHALLENGE_HTML =
  '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

const capsOf = (siteId: string, host: string, retrieval: StoreCapabilities['retrieval']): StoreCapabilities => ({
  siteId,
  name: siteId,
  domains: [host],
  rateLimit: { domain: host, baseDelayMs: 0, minDelayMs: 0, maxDelayMs: 100, backoffMultiplier: 2, recoveryDivisor: 2, successThreshold: 3 },
  requiresBrowser: false,
  allowedCookies: [],
  searchFetch: { transport: 'http' },
  retrieval,
});
const BARSTORE = capsOf('bar', BAR, { byId: { urlTemplate: `https://${BAR}/item/{id}`, idKind: 'barcode' } });
const SRCHSTORE = capsOf('srch', SRCH, { bySearch: { urlTemplate: `https://${SRCH}/search?q={q}`, scope: 'listed', acceptsGtin: true } });
const CANDS: SearchCandidate[] = [{ itemId: 'c1', name: 'Frieren', available: true }];

function rulesetFor(siteId: string): ExtractionRuleset {
  return {
    siteId,
    version: '1.0.0',
    extract: (_html: string, url: string) => ({
      source: { site: siteId, itemId: url.split('/').pop() ?? 'x', url, extractedAt: '2026-08-31T00:00:00.000Z', rulesetVersion: '1.0.0' },
      fields: { name: 'Frieren' },
      warnings: [],
    }),
    validate: () => ({ valid: true, errors: [], warnings: [] }),
  };
}
const rsWithCandidates = (siteId: string): ExtractionRuleset => ({ ...rulesetFor(siteId), extractCandidates: () => CANDS });

describe('challenge cooldown — /lookup detail plan + /resolve confirm leg (F1)', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    resetChallengeCooldown();
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    resetChallengeCooldown();
  });
  const warnLines = () => warn.mock.calls.map((c) => String(c[0]));

  it('LOOKUP: a cooling byId-barcode host is listed under `cooldown`, NOT handed out as a resolveTarget, and is never fetched', async () => {
    const cd = new ChallengeCooldown({ now: () => 42, windowMs: MIN });
    cd.open(BAR, 'challenge page');
    cd.open(SRCH, 'challenge page');
    const fetchSearch = jest.fn(async () => '{}');

    const out = await assembleLookup({
      profiles: buildProfileRegistry([BARSTORE, SRCHSTORE]),
      getRulesetForUrl: (url) => (url.includes(SRCH) ? rsWithCandidates('srch') : rsWithCandidates('bar')),
      fetchSearch,
      challengeCooldown: cd,
    }).lookupByIdentity({ gtin14: GTIN });

    expect(fetchSearch).not.toHaveBeenCalled(); // neither host is touched
    expect([...out.cooldown].sort()).toEqual(['bar', 'srch']); // the byId host is cooling-listed too
    expect(out.resolveTargets).toEqual([]); // NOT handed to the caller as a confirm target
    expect(out.failed).not.toContain('bar');
    expect(warnLines().some((l) => l.startsWith('[COOLDOWN] skipped') && l.includes(BAR))).toBe(true);
  });

  it('LOOKUP control: the same barcode store while NOT cooling still yields its resolveTarget (gate absent, not mis-keyed)', async () => {
    const cd = new ChallengeCooldown({ now: () => 42, windowMs: MIN });
    const out = await assembleLookup({
      profiles: buildProfileRegistry([BARSTORE]),
      getRulesetForUrl: () => rsWithCandidates('bar'),
      fetchSearch: jest.fn(async () => '{}'),
      challengeCooldown: cd,
    }).lookupByIdentity({ gtin14: GTIN });
    expect(out.resolveTargets.map((t) => `${t.siteId}@${t.host}`)).toEqual([`bar@${BAR}`]);
    expect(out.cooldown).toEqual([]);
  });

  it('RESOLVE: a cooling host is skipped WITHOUT fetching; the ids land under `cooldown`, not `failed`', async () => {
    const cd = new ChallengeCooldown({ now: () => 42, windowMs: MIN });
    cd.open(BAR, 'challenge page');
    const fetchDetail = jest.fn(async () => ({ html: CLEAN_HTML, statusCode: 200 }));

    const out = await assembleResolve({
      profiles: buildProfileRegistry([BARSTORE]),
      getRulesetForUrl: () => rulesetFor('bar'),
      fetchDetail,
      challengeCooldown: cd,
    }).resolve('bar', ['1', '2', '3']);

    expect(fetchDetail).not.toHaveBeenCalled(); // the whole point: never touch the cooling host
    expect(out.results).toEqual([]);
    expect(out.failed).toEqual([]);
    expect(out.cooldown).toEqual(['1', '2', '3']);
    expect(warnLines().some((l) => l.startsWith('[COOLDOWN] skipped') && l.includes(BAR))).toBe(true);
  });

  it('RESOLVE: a detail body that IS a Cloudflare challenge OPENS the cooldown and fails the id — at 200 and at 5xx', async () => {
    const cd = new ChallengeCooldown({ now: () => 42, windowMs: MIN });
    const fetchDetail = jest.fn(async () => ({ html: CHALLENGE_HTML, statusCode: 200 }));
    expect(isCloudflareChallenge(CHALLENGE_HTML)).toBe(true);

    const resolve = assembleResolve({
      profiles: buildProfileRegistry([BARSTORE]),
      getRulesetForUrl: () => rulesetFor('bar'),
      fetchDetail,
      challengeCooldown: cd,
    });

    // 200 challenge (interstitial that rendered): fetched once, NOT posed as a confirm, opens cooldown.
    const out200 = await resolve.resolve('bar', ['9']);
    expect(fetchDetail).toHaveBeenCalledTimes(1);
    expect(out200.results).toEqual([]);
    expect(out200.failed).toEqual(['9']);
    expect(cd.isOpen(BAR)).toBe(true);
    expect(cd.list().map((v) => v.host)).toEqual([BAR]);

    // 5xx challenge body: still fails the id AND keeps the cooldown open (challenge detected pre-status).
    cd.clear(BAR);
    fetchDetail.mockResolvedValue({ html: CHALLENGE_HTML, statusCode: 503 });
    const out503 = await resolve.resolve('bar', ['7']);
    expect(out503.failed).toEqual(['7']);
    expect(cd.isOpen(BAR)).toBe(true);
  });

  it('RESOLVE: a site with no byId axis is unsupported, carrying an empty additive `cooldown` list', async () => {
    const NOBYID = capsOf('nobyid', 'nobyid.example.test', { bySearch: { urlTemplate: 'https://nobyid.example.test/s?q={q}', scope: 'listed' } });
    const fetchDetail = jest.fn(async () => ({ html: CLEAN_HTML, statusCode: 200 }));
    const out = await assembleResolve({
      profiles: buildProfileRegistry([NOBYID]),
      getRulesetForUrl: () => rulesetFor('nobyid'),
      fetchDetail,
      challengeCooldown: new ChallengeCooldown({ now: () => 42, windowMs: MIN }),
    }).resolve('nobyid', ['1']);
    expect(out.unsupported).toBe(true);
    expect(out.cooldown).toEqual([]);
    expect(out.failed).toEqual([]);
    expect(fetchDetail).not.toHaveBeenCalled();
  });

  it('RESOLVE: a non-challenge 5xx body fails the id WITHOUT opening a cooldown (status gate, not a challenge)', async () => {
    const cd = new ChallengeCooldown({ now: () => 42, windowMs: MIN });
    const fetchDetail = jest.fn(async () => ({ html: '<html><body>Internal Server Error</body></html>', statusCode: 500 }));
    const out = await assembleResolve({
      profiles: buildProfileRegistry([BARSTORE]),
      getRulesetForUrl: () => rulesetFor('bar'),
      fetchDetail,
      challengeCooldown: cd,
    }).resolve('bar', ['5']);
    expect(fetchDetail).toHaveBeenCalledTimes(1);
    expect(out.failed).toEqual(['5']);
    expect(out.results).toEqual([]);
    expect(cd.isOpen(BAR)).toBe(false); // a plain 5xx is not a challenge → no cooldown opened
    expect(cd.list()).toEqual([]);
  });

  it('PROD composition: createEngineLookup cooldown-lists the cooling host and createEngineResolve skips it — shared singleton, zero wiring', async () => {
    getChallengeCooldown().open(BAR, 'search challenge page');
    const registry: LookupRegistry = { allStores: () => [BARSTORE], getRulesetForUrl: () => rsWithCandidates('bar') };
    const http = jest.fn(async () => '{}');

    const look = await createEngineLookup(registry, { http }).lookupByIdentity({ gtin14: GTIN });
    expect(look.resolveTargets).toEqual([]); // not handed out
    expect(look.cooldown).toEqual(['bar']);
    expect(http).not.toHaveBeenCalled();

    const fetchDetail = jest.fn(async () => ({ html: CLEAN_HTML, statusCode: 200 }));
    const scraping = { scrapePage: jest.fn(), scrapePageStealth: jest.fn() } as any;
    const res = await createEngineResolve(registry, fetchDetail, {
      scraping,
      transports: { http },
      sink: { capture: jest.fn(async () => undefined) } as any,
    }).resolve('bar', [GTIN]);
    expect(fetchDetail).not.toHaveBeenCalled(); // the resolve leg honors the singleton cooldown
    expect(res.failed).toEqual([]);
    expect(res.cooldown).toEqual([GTIN]);
    expect(getChallengeCooldown().isOpen(BAR)).toBe(true);
  });
});
