/**
 * createEngineResolve — builds a Resolve from the engine registry (allStores → ProfileRegistry) + a
 * detail fetch, and byId-confirms an id into full ExtractedData.
 *
 * Extraction dispatches through the SAME machinery as the ingest path (extractRecords +
 * buildExtractContext): extractAsync/extractMany rulesets get a real ExtractContext whose
 * `scraping.fetchBody` rides the store's OWN declared transport (impersonate for amiami) through
 * the capturing fetch (raw bytes → capture sink, 'api' lane) with the D8 courtesy gap. All
 * transports, sink, clock, and sleep are injected fakes — no live fetches, no real waiting.
 */
import { createEngineResolve } from '../../services/engineResolve';
import { DEFAULT_FETCH_BODY_GAP_MS } from '../../services/engineServices/extractContext';
import type { LookupRegistry } from '../../services/engineLookup';
import type {
  ExtractContext,
  ExtractedData,
  ExtractionRuleset,
  StoreCapabilities,
} from '@figurecollecting/scraper-plugin-contract';

const AMIAMI: StoreCapabilities = {
  siteId: 'amiami', name: 'AmiAmi', domains: ['amiami.com', 'api.amiami.com'], requiresBrowser: false, allowedCookies: [],
  rateLimit: { domain: 'amiami.com', baseDelayMs: 3000, minDelayMs: 500, maxDelayMs: 10000, backoffMultiplier: 2, recoveryDivisor: 2, successThreshold: 3 },
  retrieval: { byId: { urlTemplate: 'https://www.amiami.com/eng/detail/?gcode={id}', idKind: 'store-internal' } },
  searchFetch: { transport: 'impersonate', browser: 'chrome142' },
};

const ORZGK: StoreCapabilities = {
  siteId: 'orzgk', name: 'orzgk', domains: ['orzgk.com'], requiresBrowser: false, allowedCookies: [],
  rateLimit: { domain: 'orzgk.com', baseDelayMs: 3000, minDelayMs: 500, maxDelayMs: 10000, backoffMultiplier: 1.5, recoveryDivisor: 1.5, successThreshold: 3 },
  retrieval: { byId: { urlTemplate: 'https://orzgk.com/product/{id}', idKind: 'store-internal' } },
  searchFetch: { transport: 'http' },
};

const record = (site: string, itemId: string, fields: Record<string, unknown>): ExtractedData => ({
  source: { site, itemId, extractedAt: '2026-08-25T00:00:00.000Z' },
  fields,
  warnings: [],
});

const fakeScraping = () => ({
  scrapePage: jest.fn(async () => ({ html: '<page/>', url: '', title: '', statusCode: 200 })),
  scrapePageStealth: jest.fn(async () => ({ html: '<page/>', url: '', title: '', statusCode: 200 })),
});

/** Fake clock: now() reads a mutable instant, sleep(ms) advances it — zero real waiting. */
const fakeClock = (t0: number) => {
  const state = { clock: t0 };
  return {
    state,
    now: jest.fn(() => state.clock),
    sleep: jest.fn(async (ms: number) => {
      state.clock += ms;
    }),
  };
};

describe('createEngineResolve', () => {
  it('builds a Resolve from the registry that byId-confirms via the injected fetchDetail', async () => {
    const ruleset: ExtractionRuleset = {
      siteId: 'amiami', version: '1.0.0',
      extract: () => record('amiami', 'x', { gtin14: '04570232591424' }),
      validate: () => ({ valid: true, errors: [], warnings: [] }),
    };
    const registry: LookupRegistry = { allStores: () => [AMIAMI], getRulesetForUrl: () => ruleset };
    const fetchDetail = jest.fn(async () => ({ html: '<html/>', statusCode: 200 }));

    const out = await createEngineResolve(registry, fetchDetail, { scraping: fakeScraping() })
      .resolve('amiami', ['FIGURE-206235']);

    expect(fetchDetail).toHaveBeenCalledWith('https://www.amiami.com/eng/detail/?gcode=FIGURE-206235');
    expect(out.unsupported).toBe(false);
    expect(out.results[0]?.data?.fields.gtin14).toBe('04570232591424');
  });

  it('gives extractAsync a buildExtractContext ctx whose fetchBody rides the store\'s declared impersonate transport into the capture sink', async () => {
    const apiUrl = 'https://api.amiami.com/api/v1.0/item?gcode=FIGURE-190355-R';
    let seenCtx: ExtractContext | undefined;
    const ruleset: ExtractionRuleset & {
      extractAsync?: (html: string, url: string, ctx?: ExtractContext) => Promise<ExtractedData>;
    } = {
      siteId: 'amiami',
      version: '1.0.0',
      extract: () => record('amiami', 'FIGURE-190355-R', {}),
      extractAsync: async (_html, _url, ctx) => {
        seenCtx = ctx;
        const api = await ctx!.scraping.fetchBody!(apiUrl);
        const parsed = JSON.parse(api.html) as { name: string; jan: string };
        return record('amiami', 'FIGURE-190355-R', { name: parsed.name, jan: parsed.jan });
      },
      validate: () => ({ valid: true, errors: [], warnings: [] }),
    };
    const registry: LookupRegistry = { allStores: () => [AMIAMI], getRulesetForUrl: () => ruleset };
    const impersonate = jest.fn(async () => JSON.stringify({ name: 'Gyaru Tomie x Hello Kitty', jan: '4570232591424' }));
    const sink = { capture: jest.fn(async () => undefined) };
    const { now, sleep } = fakeClock(1_000_000);

    const out = await createEngineResolve(
      registry,
      jest.fn(async () => ({ html: '<div id="__nuxt"></div>', statusCode: 200 })),
      { scraping: fakeScraping(), transports: { impersonate }, sink, now, sleep },
    ).resolve('amiami', ['FIGURE-190355-R']);

    // The confirm is FULL — the item API populated the fields (prod red: {} + Nuxt warning).
    expect(out.failed).toEqual([]);
    expect(out.results[0]?.data?.fields).toEqual({ name: 'Gyaru Tomie x Hello Kitty', jan: '4570232591424' });

    // Transport: the store's declared searchFetch (impersonate, chrome142) carried the follow-up.
    expect(impersonate).toHaveBeenCalledWith(apiUrl, expect.objectContaining({ browser: 'chrome142' }));

    // Capture: the follow-up's raw bytes landed in the sink under the 'api' lane.
    expect(sink.capture).toHaveBeenCalledTimes(1);
    expect(sink.capture).toHaveBeenCalledWith(expect.objectContaining({ url: apiUrl, lane: 'api' }));

    // api.amiami.com ≠ the detail page's host (amiami.com) — a cross-host follow-up owes no
    // courtesy gap (extractContext's same-host gate), so no wait happened.
    expect(sleep).not.toHaveBeenCalled();

    // Structural proof the ctx came from buildExtractContext: config resolved from the store's
    // caps, and the members it deliberately does not provide throw its loud not-supported error.
    expect(seenCtx?.config.siteId).toBe('amiami');
    expect(() => seenCtx!.scraping.browserFetch('https://x/')).toThrow(/not available via ExtractContext/);
  });

  it('courtesy-gaps a SAME-host extractMany follow-up against the primary detail fetch, and surfaces children via records[]', async () => {
    const followUpUrl = 'https://orzgk.com/wp-json/wc/store/v1/products?type=variation&parent=77';
    const parent = record('orzgk', '77', { name: 'WLOP GK' });
    const edition = record('orzgk', '77__a', { name: 'WLOP GK — 1/4', editionOf: '77' });
    const ruleset: ExtractionRuleset = {
      siteId: 'orzgk',
      version: '1.0.0',
      extract: () => parent,
      extractMany: async (_html, _url, ctx) => {
        await ctx!.scraping.fetchBody!(followUpUrl);
        return [parent, edition];
      },
      validate: () => ({ valid: true, errors: [], warnings: [] }),
    };
    const registry: LookupRegistry = { allStores: () => [ORZGK], getRulesetForUrl: () => ruleset };
    const http = jest.fn(async () => '{"variations":[]}');
    const sink = { capture: jest.fn(async () => undefined) };
    const { now, sleep } = fakeClock(1_000_000);

    const out = await createEngineResolve(
      registry,
      jest.fn(async () => ({ html: '<html/>', statusCode: 200 })),
      { scraping: fakeScraping(), transports: { http }, sink, now, sleep },
    ).resolve('orzgk', ['77']);

    // D8: the follow-up waited the store's OWN baseDelayMs (3000) against primaryFetchedAt,
    // on the fake clock — sleep BEFORE the transport dispatch, zero real waiting.
    expect(sleep).toHaveBeenCalledWith(3000);
    expect(sleep.mock.invocationCallOrder[0]).toBeLessThan(http.mock.invocationCallOrder[0]);
    expect(http).toHaveBeenCalledWith(followUpUrl);

    // Multi-record shape: data stays the parent (today's shape); records[] is the additive extra.
    expect(out.results[0]?.data).toEqual(parent);
    expect(out.results[0]?.records).toEqual([edition]);
  });

  it('degrades to the synthesized SiteConfig + browser-lane fetchBody when the ruleset has no registered profile', async () => {
    // Unparseable byId URL (no hostname) + a ruleset whose siteId is NOT a registered store —
    // the ctx must still build: default gap, undeclared transport → browser lane, no crash.
    const GHOST_STORE: StoreCapabilities = {
      siteId: 'ghost-store', name: 'ghost-store', domains: ['ghost.example'], requiresBrowser: false, allowedCookies: [],
      rateLimit: { domain: 'ghost.example', baseDelayMs: 100, minDelayMs: 0, maxDelayMs: 100, backoffMultiplier: 2, recoveryDivisor: 2, successThreshold: 3 },
      retrieval: { byId: { urlTemplate: 'not-a-url-{id}', idKind: 'store-internal' } },
    };
    let seenCtx: ExtractContext | undefined;
    const ruleset: ExtractionRuleset = {
      siteId: 'ghost',
      version: '1.0.0',
      extract: async (_html, _url, ctx) => {
        seenCtx = ctx;
        const followUp = await ctx!.scraping.fetchBody!('https://elsewhere.example/data.json');
        return record('ghost', 'X1', { name: followUp.html });
      },
      validate: () => ({ valid: true, errors: [], warnings: [] }),
    };
    const registry: LookupRegistry = { allStores: () => [GHOST_STORE], getRulesetForUrl: () => ruleset };
    const scraping = fakeScraping();
    const { now, sleep } = fakeClock(1_000_000);

    const out = await createEngineResolve(
      registry,
      jest.fn(async () => ({ html: '<html/>', statusCode: 200 })),
      { scraping, sink: { capture: jest.fn(async () => undefined) }, now, sleep },
    ).resolve('ghost-store', ['X1']);

    expect(out.failed).toEqual([]);
    expect(out.results[0]?.data?.fields.name).toBe('<page/>');
    // Synthesized config: the ruleset's own siteId, no domains (unparseable URL), the default gap.
    expect(seenCtx?.config.siteId).toBe('ghost');
    expect(seenCtx?.config.domains).toEqual([]);
    expect(seenCtx?.config.rateLimit.baseDelayMs).toBe(DEFAULT_FETCH_BODY_GAP_MS);
    // Undeclared searchFetch → the capturing fetch's browser lane served the follow-up.
    expect(scraping.scrapePage).toHaveBeenCalledWith('https://elsewhere.example/data.json');
    // No primary host to owe courtesy to → no wait.
    expect(sleep).not.toHaveBeenCalled();
  });
});
