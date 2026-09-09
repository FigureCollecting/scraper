/**
 * runInitiatorPass × the fetch-failure ledger (E12 / E13).
 *
 * The initiator's TERMINAL branches are the three that give up on a (term, store) lookup — a fatal
 * 4xx, a transient failure whose store retry is already spent, and a retry that also failed — plus
 * a rejected enqueue POST. The retry ITSELF stays silent: the producer has not stopped trying, and
 * reporting it would inflate the ledger row's `attempts`, which drives the spine's backoff.
 *
 * The search target is the environment-free `fc:search/<siteId>?q=…&mode=…`, the SAME identity the
 * engine's own fan-out reports, so the two views of one failing store search converge on one row
 * instead of forking.
 */
import { runInitiatorPass, type FetchLike, type HttpResponseLike, type InitiatorConfig } from '../../initiator/initiator';
import type { FetchFailureReport } from '../../services/failureReporter';

const mkCfg = (over: Partial<InitiatorConfig> = {}): InitiatorConfig => ({
  scraperServiceUrl: 'http://scraper.test',
  stores: ['amiami'],
  terms: ['lucy'],
  mode: 'listed',
  maxConcurrency: 2,
  maxRequests: 100,
  maxUrlsPerStore: 10,
  requestSpacingMs: 0,
  requestTimeoutMs: 5000,
  lookupRetryDelayMs: 0,
  passDeadlineMs: 0,
  ...over,
});

const ITEM_URL = 'https://amiami.test/p/1';

const resp = (status: number, body: unknown): HttpResponseLike => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const lookupBody = (urls: string[]) => ({
  query: 'lucy',
  mode: 'listed',
  results: [
    {
      siteId: 'amiami',
      host: 'amiami.test',
      url: 'https://amiami.test/search',
      storeQuery: 'lucy',
      candidates: urls.map((u, i) => ({ itemId: String(i), name: `n${i}`, url: u })),
    },
  ],
  unsupported: [],
  orderableOnly: [],
  failed: [],
  cooldown: [],
  resolveTargets: [],
});

function harness(h: { lookup?: () => Promise<HttpResponseLike>; ingest?: () => Promise<HttpResponseLike> }) {
  const reports: FetchFailureReport[] = [];
  let lookupCalls = 0;
  const fetch: FetchLike = async (url) => {
    if (url.includes('/lookup')) {
      lookupCalls++;
      return h.lookup ? h.lookup() : resp(200, lookupBody([ITEM_URL]));
    }
    return h.ingest ? h.ingest() : resp(202, { success: true, deduplicated: false });
  };
  return {
    reports,
    lookupCalls: () => lookupCalls,
    deps: {
      fetch,
      sleep: async () => {},
      reportFailure: async (r: FetchFailureReport) => { reports.push(r); },
    },
  };
}

describe('runInitiatorPass × fetch-failure ledger', () => {
  it('E12: a fatal (not retried) lookup is ONE search row on the canonical fc: target', async () => {
    const { reports, deps, lookupCalls } = harness({ lookup: async () => resp(404, { error: 'nope' }) });

    await runInitiatorPass(mkCfg(), deps);

    expect(lookupCalls()).toBe(1); // fatal → never retried
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      site: 'amiami',
      kind: 'search',
      origin: 'initiator',
      reasonClass: 'other',
      httpStatus: 404,
      target: 'fc:search/amiami?q=lucy&mode=listed',
    });
  });

  it('E12: no status from OUR OWN /lookup may ever be filed as a store verdict', async () => {
    // /lookup is the scraper's own endpoint (it answers 400/502/200, never 404). A 404/403/410 there
    // is route drift or a rolled-back deploy — infrastructure, not "the store removed its search".
    // gone_* closes a row as 'gone': never retried, never in the review queue.
    for (const status of [403, 404, 410]) {
      const { reports, deps } = harness({ lookup: async () => resp(status, { error: 'nope' }) });
      await runInitiatorPass(mkCfg(), deps);
      expect(reports).toHaveLength(1);
      expect(reports[0].reasonClass).toBe('other');
    }
  });

  it('E12: a 429 and a 408 from our own /lookup keep their transient classes', async () => {
    const { reports: r429, deps: d429 } = harness({ lookup: async () => resp(429, {}) });
    await runInitiatorPass(mkCfg(), d429);
    expect(r429.map((r) => r.reasonClass)).toEqual(['http_429']);

    const { reports: r408, deps: d408 } = harness({ lookup: async () => resp(408, {}) });
    await runInitiatorPass(mkCfg(), d408);
    expect(r408.map((r) => r.reasonClass)).toEqual(['timeout']);
  });

  it('E12: a transient lookup is reported ONCE, after the retry also failed — never per attempt', async () => {
    const { reports, deps, lookupCalls } = harness({ lookup: async () => resp(503, { error: 'unwell' }) });

    await runInitiatorPass(mkCfg(), deps);

    expect(lookupCalls()).toBe(2); // first attempt + the store's one retry
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ reasonClass: 'http_5xx', httpStatus: 503, kind: 'search' });
  });

  it('E12: the second term is reported too, once the store retry is already spent', async () => {
    const { reports, deps } = harness({ lookup: async () => resp(500, { error: 'unwell' }) });

    await runInitiatorPass(mkCfg({ terms: ['lucy', 'marin'] }), deps);

    expect(reports.map((r) => r.target)).toEqual([
      'fc:search/amiami?q=lucy&mode=listed',
      'fc:search/amiami?q=marin&mode=listed',
    ]);
  });

  it('E12: a transport throw is reported as a network failure', async () => {
    const { reports, deps } = harness({ lookup: async () => { throw new Error('fetch failed'); } });

    await runInitiatorPass(mkCfg(), deps);

    expect(reports).toHaveLength(1);
    expect(reports[0].reasonClass).toBe('network');
  });

  it('E12: a 2xx body that will not parse is reported as parse', async () => {
    const { reports, deps } = harness({
      lookup: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); }, text: async () => '<html>' }),
    });

    await runInitiatorPass(mkCfg(), deps);

    expect(reports).toHaveLength(1);
    expect(reports[0].reasonClass).toBe('parse');
  });

  it('E13: a rejected enqueue POST is a RECORD row on the discovered URL', async () => {
    const { reports, deps } = harness({ ingest: async () => resp(400, { error: 'no ruleset matches' }) });

    await runInitiatorPass(mkCfg(), deps);

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      site: 'amiami',
      kind: 'record',
      origin: 'initiator',
      reasonClass: 'ruleset',
      target: ITEM_URL,
    });
    // The 400 is OUR /ingest/scrape's answer, while the row's target is the STORE's url: recording
    // it as the row's http_status would assert a response that store never gave.
    expect(reports[0].httpStatus).toBeUndefined();
    expect(reports[0].message).toContain('400');
  });

  it('E13: a 5xx from the enqueue POST is reported as http_5xx, a throw as network', async () => {
    const a = harness({ ingest: async () => resp(502, { error: 'unwell' }) });
    await runInitiatorPass(mkCfg(), a.deps);
    expect(a.reports[0]).toMatchObject({ reasonClass: 'http_5xx', kind: 'record' });
    expect(a.reports[0].httpStatus).toBeUndefined();

    const b = harness({ ingest: async () => { throw new Error('socket hang up'); } });
    await runInitiatorPass(mkCfg(), b.deps);
    expect(b.reports[0]).toMatchObject({ reasonClass: 'network', kind: 'record' });
  });

  it('reports nothing on a clean pass, runs with no reporter, and survives a throwing one', async () => {
    const clean = harness({});
    const summary = await runInitiatorPass(mkCfg(), clean.deps);
    expect(clean.reports).toHaveLength(0);
    expect(summary.totalEnqueued).toBe(1);

    const bare = harness({ lookup: async () => resp(404, {}) });
    const { reportFailure, ...withoutReporter } = bare.deps;
    await expect(runInitiatorPass(mkCfg(), withoutReporter)).resolves.toMatchObject({ lookupFailures: 1 });

    const throwing = harness({ lookup: async () => resp(404, {}) });
    await expect(
      runInitiatorPass(mkCfg(), { ...throwing.deps, reportFailure: () => { throw new Error('reporter exploded'); } }),
    ).resolves.toMatchObject({ lookupFailures: 1 });
  });
});
