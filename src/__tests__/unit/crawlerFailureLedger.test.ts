/**
 * runCrawlerPass × the fetch-failure ledger (E6–E11).
 *
 * The crawler's failures are terminal per store/axis by construction — a failed catalog GET stops
 * that store's axis for the run — so each exit reports exactly one row.
 *
 * IDENTITY: a listing failure is keyed on `fc:listing/<site>?axis=…&page=…`, NEVER on the real
 * fetched URL. The crawler fetches `${SCRAPER_SERVICE_URL}/catalog?…`, the scraper's OWN address,
 * which differs between the WSL dev tier and fc-app-01 — keying on it would split one store's
 * failures across environments and break the ledger's dedupe.
 *
 * NOT reported, deliberately: the catalog 422 (the store does not serve this axis — a declared
 * coverage gap, not a failed fetch) and a budget stop (nothing was ever dispatched).
 */
import { runCrawlerPass, type CrawlerConfig, type FetchLike, type HttpResponseLike } from '../../crawler/crawler';
import { createMemoryLedgerStore } from '../../crawler/ledger';
import type { FetchFailureReport } from '../../services/failureReporter';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-09-08T12:00:00.000Z');

const mkCfg = (over: Partial<CrawlerConfig> = {}): CrawlerConfig => ({
  scraperServiceUrl: 'http://scraper.test',
  mode: 'recent',
  stores: ['orzgk'],
  ledgerDir: '/unused',
  recentMaxPages: 2,
  backfillPagesPerRun: 0,
  maxRequests: 100,
  maxEnqueuePerStore: 50,
  maxConcurrency: 2,
  requestSpacingMs: 0,
  requestTimeoutMs: 5000,
  reobserveAfterMs: 0,
  exhaustedRecheckMs: WEEK_MS,
  storeEnqueueCaps: {},
  rangeStores: [],
  rangeIdsPerRun: 50,
  rangeFrontiers: {},
  seedSpacingMs: 10_000,
  ...over,
});

const collectUrl = (id: string): string => `https://orzgk.test/api/${id}`;

const resp = (status: number, body: unknown): HttpResponseLike => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

interface Handlers {
  catalog?: () => Promise<HttpResponseLike>;
  ingest?: () => Promise<HttpResponseLike>;
}

function harness(h: Handlers) {
  const reports: FetchFailureReport[] = [];
  const fetch: FetchLike = async (url) => {
    if (url.includes('/catalog')) {
      return h.catalog ? h.catalog() : resp(200, { siteId: 'orzgk', items: [{ itemId: '1', collectUrl: collectUrl('1') }], hasMore: false });
    }
    return h.ingest ? h.ingest() : resp(202, { success: true, deduplicated: false });
  };
  return {
    reports,
    deps: {
      fetch,
      ledgerStore: createMemoryLedgerStore(),
      now: () => T0,
      sleep: async () => {},
      reportFailure: async (r: FetchFailureReport) => { reports.push(r); },
    },
  };
}

describe('runCrawlerPass × fetch-failure ledger', () => {
  it('E6: a catalog GET that throws is reported as a network failure on the fc: listing target', async () => {
    const { reports, deps } = harness({ catalog: async () => { throw new Error('fetch failed'); } });

    await runCrawlerPass(mkCfg(), deps);

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      site: 'orzgk',
      kind: 'listing',
      origin: 'crawler',
      reasonClass: 'network',
      target: 'fc:listing/orzgk?axis=recent&page=1',
    });
    expect(reports[0].target).not.toContain('scraper.test');
  });

  it('E6: an aborted catalog GET is reported as a timeout', async () => {
    const { reports, deps } = harness({ catalog: async () => { throw new Error('This operation was aborted'); } });

    await runCrawlerPass(mkCfg(), deps);

    expect(reports[0].reasonClass).toBe('timeout');
  });

  it('E7: a 503 cooldown is reported as cooldown, carrying the scraper-reported window', async () => {
    const { reports, deps } = harness({
      catalog: async () => resp(503, { error: 'cooldown', host: 'orzgk.test', remainingMs: 900_000 }),
    });

    await runCrawlerPass(mkCfg(), deps);

    expect(reports).toHaveLength(1);
    expect(reports[0].reasonClass).toBe('cooldown');
    expect(Date.parse(reports[0].nextRetryHint!)).toBe(T0 + 900_000);
  });

  it('E7: a 503 that is NOT the engine cooldown envelope is http_5xx, never a phantom CF cooldown', async () => {
    // A rollout or a scaled-to-zero Deployment answers 503 from the ingress with no envelope.
    // Claiming the STORE is cooling after a Cloudflare challenge would fabricate an observation.
    const { reports, deps } = harness({ catalog: async () => resp(503, { error: 'no healthy upstream' }) });

    await runCrawlerPass(mkCfg(), deps);

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ reasonClass: 'http_5xx', httpStatus: 503 });
    expect(reports[0].nextRetryHint).toBeUndefined();
  });

  it('E7: a 503 whose body will not parse at all is http_5xx too', async () => {
    const { reports, deps } = harness({
      catalog: async () => ({ ok: false, status: 503, json: async () => { throw new SyntaxError('Unexpected token <'); }, text: async () => '<html>' }),
    });

    await runCrawlerPass(mkCfg(), deps);

    expect(reports[0].reasonClass).toBe('http_5xx');
  });

  it('the listing target names the AXIS that failed — recent and backfill are distinct rows', async () => {
    let page = 0;
    const { reports, deps } = harness({
      catalog: async () => {
        page++;
        // recent page 1 succeeds with more to come; every later fetch (recent p2, backfill p2) fails.
        return page === 1
          ? resp(200, { siteId: 'orzgk', items: [{ itemId: '1', collectUrl: collectUrl('1') }], hasMore: true })
          : resp(502, { error: 'boom' });
      },
    });

    await runCrawlerPass(mkCfg({ mode: 'both', recentMaxPages: 2, backfillPagesPerRun: 1 }), deps);

    expect(reports.map((r) => r.target)).toContain('fc:listing/orzgk?axis=recent&page=2');
  });

  it('E8: a 5xx is reported as http_5xx with the status; a non-5xx !ok lands in the triage bucket', async () => {
    const a = harness({ catalog: async () => resp(502, { error: 'boom' }) });
    await runCrawlerPass(mkCfg(), a.deps);
    expect(a.reports[0]).toMatchObject({ reasonClass: 'http_5xx', httpStatus: 502 });

    const b = harness({ catalog: async () => resp(400, { error: "query parameter 'page' must be a positive integer" }) });
    await runCrawlerPass(mkCfg(), b.deps);
    expect(b.reports[0]).toMatchObject({ reasonClass: 'other', httpStatus: 400 });
  });

  it('E9: an unparseable or malformed catalog body is reported as parse', async () => {
    const a = harness({
      catalog: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token < in JSON'); }, text: async () => '<html>' }),
    });
    await runCrawlerPass(mkCfg(), a.deps);
    expect(a.reports[0]).toMatchObject({ reasonClass: 'parse', kind: 'listing' });

    const b = harness({ catalog: async () => resp(200, { siteId: 'orzgk', notItems: [] }) });
    await runCrawlerPass(mkCfg(), b.deps);
    expect(b.reports[0]).toMatchObject({ reasonClass: 'parse' });
  });

  it('E10: an ingest POST the scraper deterministically rejects is a RECORD row on the item URL', async () => {
    const { reports, deps } = harness({ ingest: async () => resp(400, { error: 'no ruleset matches' }) });

    await runCrawlerPass(mkCfg(), deps);

    const record = reports.filter((r) => r.kind === 'record');
    expect(record).toHaveLength(1);
    expect(record[0]).toMatchObject({
      site: 'orzgk',
      kind: 'record',
      origin: 'crawler',
      reasonClass: 'ruleset',
      target: collectUrl('1'),
      itemId: '1',
    });
    // The 400 came from OUR /ingest/scrape, not from the store the target names: recording it as
    // the row's http_status would assert a response that store never gave.
    expect(record[0].httpStatus).toBeUndefined();
    expect(record[0].message).toContain('400');
  });

  it('does NOT report a 5xx from the ingest POST — the scraper is unwell, the item is re-driven next run', async () => {
    const { reports, deps } = harness({ ingest: async () => resp(503, { error: 'unwell' }) });

    await runCrawlerPass(mkCfg(), deps);

    expect(reports.filter((r) => r.kind === 'record')).toHaveLength(0);
  });

  it('does NOT report the catalog 422 — an unserved axis is a coverage gap, not a failed fetch', async () => {
    const { reports, deps } = harness({ catalog: async () => resp(422, { error: 'unsupported', reason: 'no listing axis' }) });

    await runCrawlerPass(mkCfg(), deps);

    expect(reports).toHaveLength(0);
  });

  it('reports nothing on a clean pass, and runs unchanged with no reporter wired', async () => {
    const { reports, deps } = harness({});
    const summary = await runCrawlerPass(mkCfg(), deps);
    expect(reports).toHaveLength(0);
    expect(summary.stores[0].enqueued).toBe(1);

    const bare = harness({ catalog: async () => { throw new Error('fetch failed'); } });
    const { reportFailure, ...withoutReporter } = bare.deps;
    const bareSummary = await runCrawlerPass(mkCfg(), withoutReporter);
    expect(bareSummary.stores[0].errors).toBe(1);
  });

  it('never lets a throwing reporter break the pass', async () => {
    const { deps } = harness({ catalog: async () => { throw new Error('fetch failed'); } });
    const summary = await runCrawlerPass(mkCfg(), {
      ...deps,
      reportFailure: () => { throw new Error('reporter exploded'); },
    });

    expect(summary.stores[0].errors).toBe(1);
  });

  it('E11: an id-range window the engine did not serve descending is reported as ruleset on the range target', async () => {
    const reports: FetchFailureReport[] = [];
    const fetch: FetchLike = async (url) => {
      if (url.includes('range=1')) {
        // ids that are NOT the requested descending window
        return resp(200, { siteId: 'orzgk', from: 500, items: [{ itemId: '9999', collectUrl: collectUrl('9999') }], hasMore: false });
      }
      if (url.includes('/catalog')) return resp(200, { siteId: 'orzgk', items: [], hasMore: false });
      return resp(202, { success: true });
    };

    await runCrawlerPass(
      mkCfg({ mode: 'backfill', backfillPagesPerRun: 0, rangeStores: ['orzgk'], rangeIdsPerRun: 10, rangeFrontiers: { orzgk: 500 } }),
      {
        fetch,
        ledgerStore: createMemoryLedgerStore(),
        now: () => T0,
        sleep: async () => {},
        reportFailure: async (r: FetchFailureReport) => { reports.push(r); },
      },
    );

    const listing = reports.filter((r) => r.kind === 'listing');
    expect(listing).toHaveLength(1);
    expect(listing[0]).toMatchObject({ reasonClass: 'ruleset', target: 'fc:listing/orzgk?axis=range&from=500&count=10' });
  });
});
