/**
 * runInitiatorPass — ONE bounded ingestion pass (the interim CronJob body). Over
 * a configured list of proven-GO stores it discovers candidate product URLs via
 * the scraper's OWN HTTP surface (one GET /lookup?q=&stores=<ONE store> per term ×
 * store), then feeds a bounded number of them to POST /ingest/scrape — all throttled
 * by the global egress gate.
 *
 * Every test drives a MOCKED http surface (a fake fetch returning canned /lookup +
 * /ingest responses). No real network, no live store, no real scraper.
 */
import { runInitiatorPass, type FetchLike, type HttpResponseLike, type InitiatorConfig } from '../../initiator/initiator';
import { logger } from '../../utils/logger';

const waitFor = async (pred: () => boolean, timeoutMs = 3000): Promise<void> => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 1));
  }
};

const mkCfg = (over: Partial<InitiatorConfig>): InitiatorConfig => ({
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
  ...over,
});

/** Build a canned LookupResult body: a map of siteId → candidate product URLs, plus optional envelopes. */
const lookupWith = (
  perStore: Record<string, string[]>,
  extra: { unsupported?: string[]; orderableOnly?: string[]; failed?: string[]; cooldown?: string[] } = {},
) => ({
  query: '',
  mode: 'listed',
  results: Object.entries(perStore).map(([siteId, urls]) => ({
    siteId,
    host: `${siteId}.test`,
    url: `https://${siteId}.test/search`,
    storeQuery: 'q',
    candidates: urls.map((u, i) => ({ itemId: String(i), name: `n${i}`, url: u })),
  })),
  unsupported: extra.unsupported ?? [],
  orderableOnly: extra.orderableOnly ?? [],
  failed: extra.failed ?? [],
  cooldown: extra.cooldown ?? [],
  resolveTargets: [] as unknown[],
});

interface Reply {
  status: number;
  body?: unknown;
  throwErr?: boolean;
  /** When throwErr is set, throw this exact value (defaults to an Error) — exercises non-Error paths. */
  throwValue?: unknown;
}

interface FakeOpts {
  lookup: (term: string, store: string) => Reply;
  ingest?: (url: string) => Reply;
  holdIngest?: boolean;
}

const makeFake = (opts: FakeOpts) => {
  let active = 0;
  let peak = 0;
  const calls: { method: string; url: string; body?: any }[] = [];
  let releaseIngest!: () => void;
  const ingestBarrier = new Promise<void>((r) => (releaseIngest = r));
  const resp = (status: number, body: unknown): HttpResponseLike => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  const fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body) : undefined;
    active++;
    peak = Math.max(peak, active);
    calls.push({ method, url, body });
    try {
      if (url.includes('/lookup')) {
        const params = new URL(url).searchParams;
        const term = params.get('q') ?? '';
        const r = opts.lookup(term, params.get('stores') ?? '');
        if (r.throwErr) throw r.throwValue !== undefined ? r.throwValue : new Error('lookup network error');
        return resp(r.status, r.body ?? {});
      }
      // /ingest/scrape
      const u = body?.url as string;
      if (opts.holdIngest) await ingestBarrier;
      const r = opts.ingest ? opts.ingest(u) : { status: 202, body: { success: true, itemId: u, deduplicated: false, position: 1 } };
      if (r.throwErr) throw r.throwValue !== undefined ? r.throwValue : new Error('ingest timeout');
      return resp(r.status, r.body ?? { success: true, itemId: u, deduplicated: false, position: 1 });
    } finally {
      active--;
    }
  };
  return {
    fetch,
    calls,
    releaseIngest,
    get peak() {
      return peak;
    },
    get active() {
      return active;
    },
    ingestCalls: () => calls.filter((c) => c.url.includes('/ingest')),
    lookupCalls: () => calls.filter((c) => c.url.includes('/lookup')),
  };
};

describe('runInitiatorPass', () => {
  // (4) discovered URLs are posted to /ingest/scrape and the per-run summary counts are correct
  it('discovers per-store candidate URLs and POSTs each to /ingest/scrape with correct summary counts', async () => {
    const fake = makeFake({
      lookup: () =>
        ({
          status: 200,
          body: lookupWith({
            amiami: ['https://amiami.test/p/1', 'https://amiami.test/p/2'],
            gkloot: ['https://gkloot.test/p/9'],
          }),
        }),
    });
    const s = await runInitiatorPass(mkCfg({ stores: ['amiami', 'gkloot'], terms: ['lucy'] }), { fetch: fake.fetch });

    expect(fake.lookupCalls().length).toBe(2); // one per term x store
    expect(fake.lookupCalls()[0].url).toContain('q=lucy');
    expect(fake.lookupCalls()[0].url).toContain('mode=listed');

    const posted = fake.ingestCalls().map((c) => c.body.url).sort();
    expect(posted).toEqual(['https://amiami.test/p/1', 'https://amiami.test/p/2', 'https://gkloot.test/p/9']);
    expect(fake.ingestCalls().every((c) => c.method === 'POST')).toBe(true);

    const amiami = s.stores.find((x) => x.siteId === 'amiami')!;
    const gkloot = s.stores.find((x) => x.siteId === 'gkloot')!;
    expect(amiami.discovered).toBe(2);
    expect(amiami.enqueued).toBe(2);
    expect(gkloot.discovered).toBe(1);
    expect(gkloot.enqueued).toBe(1);
    expect(s.totalDiscovered).toBe(3);
    expect(s.totalEnqueued).toBe(3);
    expect(s.requestsIssued).toBe(5); // 2 lookups + 3 ingests
    expect(s.budgetExhausted).toBe(false);
  });

  it('counts a coalesced (deduplicated) enqueue distinctly from a fresh one', async () => {
    const fake = makeFake({
      lookup: () => ({ status: 200, body: lookupWith({ amiami: ['https://amiami.test/a', 'https://amiami.test/b'] }) }),
      ingest: (u) =>
        u.endsWith('/b')
          ? { status: 202, body: { success: true, itemId: u, deduplicated: true, position: 0 } }
          : { status: 202, body: { success: true, itemId: u, deduplicated: false, position: 1 } },
    });
    const s = await runInitiatorPass(mkCfg({ stores: ['amiami'], terms: ['t'] }), { fetch: fake.fetch });
    const amiami = s.stores[0];
    expect(amiami.enqueued).toBe(2);
    expect(amiami.deduplicated).toBe(1);
  });

  it('caps discovered URLs per store at maxUrlsPerStore', async () => {
    const fake = makeFake({
      lookup: () => ({ status: 200, body: lookupWith({ amiami: ['a', 'b', 'c', 'd', 'e'].map((x) => `https://amiami.test/${x}`) }) }),
    });
    const s = await runInitiatorPass(mkCfg({ stores: ['amiami'], terms: ['t'], maxUrlsPerStore: 2 }), { fetch: fake.fetch });
    expect(fake.ingestCalls().length).toBe(2);
    expect(s.stores[0].discovered).toBe(2);
  });

  it('coalesces the same URL discovered across multiple terms (queue dedup key)', async () => {
    const fake = makeFake({ lookup: () => ({ status: 200, body: lookupWith({ amiami: ['https://amiami.test/p/1'] }) }) });
    const s = await runInitiatorPass(mkCfg({ stores: ['amiami'], terms: ['t1', 't2'] }), { fetch: fake.fetch });
    expect(fake.lookupCalls().length).toBe(2);
    expect(fake.ingestCalls().length).toBe(1);
    expect(s.stores[0].discovered).toBe(1);
  });

  it('consumes only configured stores from the fan-out (ignores other stores in the lookup body)', async () => {
    const fake = makeFake({
      lookup: () => ({ status: 200, body: lookupWith({ amiami: ['https://amiami.test/x'], surugaya: ['https://surugaya.test/y'] }) }),
    });
    const s = await runInitiatorPass(mkCfg({ stores: ['amiami'], terms: ['t'] }), { fetch: fake.fetch });
    expect(fake.ingestCalls().map((c) => c.body.url)).toEqual(['https://amiami.test/x']);
    expect(s.stores.map((x) => x.siteId)).toEqual(['amiami']);
  });

  // (1) global concurrency NEVER exceeds INITIATOR_MAX_CONCURRENCY across stores
  it('never exceeds maxConcurrency in-flight requests across all stores', async () => {
    const urlsA = Array.from({ length: 4 }, (_, i) => `https://amiami.test/${i}`);
    const urlsB = Array.from({ length: 4 }, (_, i) => `https://gkloot.test/${i}`);
    const fake = makeFake({ holdIngest: true, lookup: () => ({ status: 200, body: lookupWith({ amiami: urlsA, gkloot: urlsB }) }) });
    const p = runInitiatorPass(mkCfg({ stores: ['amiami', 'gkloot'], terms: ['t'], maxConcurrency: 2, maxUrlsPerStore: 10 }), { fetch: fake.fetch });
    await waitFor(() => fake.active === 2 && fake.ingestCalls().length === 2);
    expect(fake.active).toBe(2);
    expect(fake.peak).toBeLessThanOrEqual(2);
    // the semaphore is holding the rest back: only maxConcurrency have actually called fetch
    expect(fake.ingestCalls().length).toBe(2);
    fake.releaseIngest();
    const s = await p;
    expect(fake.peak).toBeLessThanOrEqual(2);
    expect(fake.ingestCalls().length).toBe(8);
    expect(s.peakInFlight).toBeLessThanOrEqual(2);
    expect(s.totalEnqueued).toBe(8);
  });

  // (2) total requests NEVER exceed INITIATOR_MAX_REQUESTS
  it('never exceeds maxRequests total requests per run (lookups + ingests share the budget)', async () => {
    const fake = makeFake({
      lookup: () => ({ status: 200, body: lookupWith({ amiami: ['1', '2', '3', '4', '5'].map((x) => `https://amiami.test/${x}`) }) }),
    });
    const s = await runInitiatorPass(mkCfg({ stores: ['amiami'], terms: ['t'], maxRequests: 3, maxUrlsPerStore: 10 }), { fetch: fake.fetch });
    expect(fake.calls.length).toBe(3); // 1 lookup + 2 ingests
    expect(fake.lookupCalls().length).toBe(1);
    expect(fake.ingestCalls().length).toBe(2);
    expect(s.requestsIssued).toBe(3);
    expect(s.budgetExhausted).toBe(true);
    expect(s.stores[0].enqueued).toBe(2);
  });

  // (3) a store whose /lookup returns 5xx / times out is logged and skipped without aborting others
  it('isolates a per-term /lookup 5xx: logged, that term yields nothing, other terms still enqueue', async () => {
    const fake = makeFake({
      lookup: (term) => (term === 'bad' ? { status: 500, body: { error: 'boom' } } : { status: 200, body: lookupWith({ amiami: ['https://amiami.test/ok'] }) }),
    });
    const s = await runInitiatorPass(mkCfg({ stores: ['amiami'], terms: ['good', 'bad'] }), { fetch: fake.fetch });
    expect(s.lookupFailures).toBe(1);
    expect(fake.ingestCalls().map((c) => c.body.url)).toEqual(['https://amiami.test/ok']);
    expect(s.stores[0].enqueued).toBe(1);
  });

  it('isolates a /lookup network throw (timeout): logged as a lookup failure, run still completes', async () => {
    const fake = makeFake({
      lookup: (term) => (term === 'bad' ? { status: 0, throwErr: true } : { status: 200, body: lookupWith({ amiami: ['https://amiami.test/ok'] }) }),
    });
    const s = await runInitiatorPass(mkCfg({ stores: ['amiami'], terms: ['bad', 'good'] }), { fetch: fake.fetch });
    expect(s.lookupFailures).toBe(1);
    expect(fake.ingestCalls().map((c) => c.body.url)).toEqual(['https://amiami.test/ok']);
  });

  // (3) a store whose /ingest returns 5xx / times out is logged and skipped without aborting others
  it('isolates a per-store /ingest 5xx: that store errors, other stores still enqueue', async () => {
    const fake = makeFake({
      lookup: () => ({ status: 200, body: lookupWith({ amiami: ['https://amiami.test/x'], gkloot: ['https://gkloot.test/y'] }) }),
      ingest: (u) => (u.includes('amiami') ? { status: 500, body: { success: false, message: 'err' } } : { status: 202, body: { success: true, itemId: u, deduplicated: false, position: 1 } }),
    });
    const s = await runInitiatorPass(mkCfg({ stores: ['amiami', 'gkloot'], terms: ['t'] }), { fetch: fake.fetch });
    const amiami = s.stores.find((x) => x.siteId === 'amiami')!;
    const gkloot = s.stores.find((x) => x.siteId === 'gkloot')!;
    expect(amiami.errors).toBe(1);
    expect(amiami.enqueued).toBe(0);
    expect(gkloot.enqueued).toBe(1);
    expect(gkloot.errors).toBe(0);
    expect(fake.ingestCalls().length).toBe(2); // both were attempted
    expect(s.totalErrors).toBe(1);
  });

  it('isolates a per-store /ingest network throw (timeout): that store errors, others proceed', async () => {
    const fake = makeFake({
      lookup: () => ({ status: 200, body: lookupWith({ amiami: ['https://amiami.test/x'], gkloot: ['https://gkloot.test/y'] }) }),
      ingest: (u) => (u.includes('amiami') ? { status: 0, throwErr: true } : { status: 202, body: { success: true, itemId: u, deduplicated: false, position: 1 } }),
    });
    const s = await runInitiatorPass(mkCfg({ stores: ['amiami', 'gkloot'], terms: ['t'] }), { fetch: fake.fetch });
    expect(s.stores.find((x) => x.siteId === 'amiami')!.errors).toBe(1);
    expect(s.stores.find((x) => x.siteId === 'gkloot')!.enqueued).toBe(1);
  });

  // (5) empty config / zero stores exits cleanly
  it('zero stores → makes no requests and returns an all-zero summary', async () => {
    const fake = makeFake({ lookup: () => ({ status: 200, body: lookupWith({ amiami: ['https://amiami.test/x'] }) }) });
    const s = await runInitiatorPass(mkCfg({ stores: [], terms: ['t'] }), { fetch: fake.fetch });
    expect(fake.calls.length).toBe(0);
    expect(s.stores).toEqual([]);
    expect(s.totalDiscovered).toBe(0);
    expect(s.totalEnqueued).toBe(0);
    expect(s.requestsIssued).toBe(0);
  });

  it('zero terms → makes no lookups and no ingests', async () => {
    const fake = makeFake({ lookup: () => ({ status: 200, body: lookupWith({ amiami: ['https://amiami.test/x'] }) }) });
    const s = await runInitiatorPass(mkCfg({ stores: ['amiami'], terms: [] }), { fetch: fake.fetch });
    expect(fake.calls.length).toBe(0);
    expect(s.stores[0].discovered).toBe(0);
    expect(s.stores[0].enqueued).toBe(0);
  });

  it('records a store the scraper reports as failed / cooling in the fan-out envelope', async () => {
    const fake = makeFake({
      lookup: () => ({ status: 200, body: lookupWith({ amiami: ['https://amiami.test/x'] }, { failed: ['gkloot'], cooldown: ['solaris'] }) }),
    });
    const s = await runInitiatorPass(mkCfg({ stores: ['amiami', 'gkloot', 'solaris'], terms: ['t'] }), { fetch: fake.fetch });
    expect(s.stores.find((x) => x.siteId === 'gkloot')!.errors).toBe(1);
    expect(s.stores.find((x) => x.siteId === 'solaris')!.skipped).toBe(1);
  });

  it('tolerates a completely empty lookup body (all envelope arrays absent)', async () => {
    const fake = makeFake({ lookup: () => ({ status: 200, body: {} }) });
    const s = await runInitiatorPass(mkCfg({ stores: ['amiami'], terms: ['t'] }), { fetch: fake.fetch });
    expect(fake.ingestCalls().length).toBe(0);
    expect(s.stores[0].discovered).toBe(0);
    expect(s.lookupFailures).toBe(0);
  });

  it('tolerates a sparse body: skips candidates without a usable url, resolveTargets, and envelope entries for unconfigured stores', async () => {
    const fake = makeFake({
      lookup: () => ({
        status: 200,
        body: {
          results: [
            { siteId: 'amiami' }, // no candidates key
            { candidates: [{ url: 'https://amiami.test/no-siteid' }] }, // no siteId
            {
              siteId: 'amiami',
              candidates: [
                { itemId: 'a', name: 'A' }, // no url
                { itemId: 'b', name: 'B', url: '' }, // empty url
                { itemId: 'c', name: 'C', url: 'https://amiami.test/c' }, // kept
              ],
            },
          ],
          resolveTargets: [
            { siteId: 'amiami', itemId: 'd', url: 'https://amiami.test/d' }, // kept
            { siteId: 'amiami', itemId: 'e' }, // no url
            { siteId: 'other', itemId: 'z', url: 'https://other.test/z' }, // unconfigured store
          ],
          failed: ['unlisted-1'],
          cooldown: ['unlisted-2'],
          unsupported: ['unlisted-3'],
        },
      }),
    });
    const s = await runInitiatorPass(mkCfg({ stores: ['amiami'], terms: ['t'] }), { fetch: fake.fetch });
    expect(fake.ingestCalls().map((c) => c.body.url).sort()).toEqual(['https://amiami.test/c', 'https://amiami.test/d']);
    expect(s.stores[0].discovered).toBe(2);
    expect(s.stores).toHaveLength(1); // envelope entries for unconfigured stores add no rows
  });

  it('budget exhausted before the first request (maxRequests 0): makes no calls, flags budgetExhausted', async () => {
    const fake = makeFake({ lookup: () => ({ status: 200, body: lookupWith({ amiami: ['https://amiami.test/x'] }) }) });
    const s = await runInitiatorPass(mkCfg({ stores: ['amiami'], terms: ['t'], maxRequests: 0 }), { fetch: fake.fetch });
    expect(fake.calls.length).toBe(0);
    expect(s.budgetExhausted).toBe(true);
    expect(s.requestsIssued).toBe(0);
    expect(s.lookupFailures).toBe(0);
  });

  it('runs with timeouts disabled (requestTimeoutMs 0 → no abort timer)', async () => {
    const fake = makeFake({ lookup: () => ({ status: 200, body: lookupWith({ amiami: ['https://amiami.test/x'] }) }) });
    const s = await runInitiatorPass(mkCfg({ stores: ['amiami'], terms: ['t'], requestTimeoutMs: 0 }), { fetch: fake.fetch });
    expect(fake.ingestCalls().length).toBe(1);
    expect(s.stores[0].enqueued).toBe(1);
  });

  it('handles a non-Error thrown by the http surface on both lookup and ingest', async () => {
    const lookupThrow = makeFake({ lookup: () => ({ status: 0, throwErr: true, throwValue: 'kaboom-string' }) });
    const sl = await runInitiatorPass(mkCfg({ stores: ['amiami'], terms: ['t'] }), { fetch: lookupThrow.fetch });
    expect(sl.lookupFailures).toBe(1);

    const ingestThrow = makeFake({
      lookup: () => ({ status: 200, body: lookupWith({ amiami: ['https://amiami.test/x'] }) }),
      ingest: () => ({ status: 0, throwErr: true, throwValue: 'kaboom-string' }),
    });
    const si = await runInitiatorPass(mkCfg({ stores: ['amiami'], terms: ['t'] }), { fetch: ingestThrow.fetch });
    expect(si.stores[0].errors).toBe(1);
    expect(si.stores[0].enqueued).toBe(0);
  });

  it('scopes every lookup to exactly ONE store (&stores= carries a single siteId)', async () => {
    const fake = makeFake({ lookup: () => ({ status: 200, body: lookupWith({}) }) });
    await runInitiatorPass(mkCfg({ stores: ['orzgk', 'amiami'], terms: ['lucy'] }), { fetch: fake.fetch });

    const stores = fake.lookupCalls().map((c) => new URL(c.url).searchParams.get('stores'));
    expect(stores.sort()).toEqual(['amiami', 'orzgk']);
    expect(stores.every((v) => !v!.includes(','))).toBe(true);
  });

  it('uses an injected gate when provided', async () => {
    const { createRequestGate } = await import('../../initiator/requestGate');
    const gate = createRequestGate({ maxConcurrency: 1, maxRequests: 100, spacingMs: 0 });
    const fake = makeFake({ lookup: () => ({ status: 200, body: lookupWith({ amiami: ['https://amiami.test/x'] }) }) });
    const s = await runInitiatorPass(mkCfg({ stores: ['amiami'], terms: ['t'] }), { fetch: fake.fetch, gate });
    expect(s.requestsIssued).toBe(2); // 1 lookup + 1 ingest, counted by the injected gate
    expect(gate.issued()).toBe(2);
  });
});

describe('runInitiatorPass — collectUrl preference (the engine-owned collect-ready URL)', () => {
  /** A /lookup body for ONE store whose candidates are given raw (so collectUrl can be present, absent, or junk). */
  const bodyWith = (siteId: string, candidates: Array<Record<string, unknown>>) => ({
    query: 'lucy',
    mode: 'listed',
    results: [{ siteId, host: `${siteId}.test`, url: `https://${siteId}.test/search`, storeQuery: 'lucy', candidates }],
    unsupported: [],
    orderableOnly: [],
    failed: [],
    cooldown: [],
    resolveTargets: [],
  });

  it('(8) prefers collectUrl over url when both are present', async () => {
    const fake = makeFake({
      lookup: () => ({
        status: 200,
        body: bodyWith('orzgk', [
          { itemId: '1', name: 'Lucy', url: 'https://orzgk.test/product/lucy/', collectUrl: 'https://orzgk.test/wp-json/wc/store/v1/products/1' },
        ]),
      }),
    });
    const s = await runInitiatorPass(mkCfg({ stores: ['orzgk'], terms: ['lucy'] }), { fetch: fake.fetch });

    expect(fake.ingestCalls().map((c) => c.body.url)).toEqual(['https://orzgk.test/wp-json/wc/store/v1/products/1']);
    expect(s.stores[0].discovered).toBe(1);
    expect(s.stores[0].enqueued).toBe(1);
  });

  it('(9) falls back to url when collectUrl is absent, empty, or not a string (older engine)', async () => {
    const fake = makeFake({
      lookup: () => ({
        status: 200,
        body: bodyWith('orzgk', [
          { itemId: '1', name: 'A', url: 'https://orzgk.test/a' }, // no collectUrl (pre-collectUrl engine)
          { itemId: '2', name: 'B', url: 'https://orzgk.test/b', collectUrl: '' }, // empty
          { itemId: '3', name: 'C', url: 'https://orzgk.test/c', collectUrl: 7 }, // junk
        ]),
      }),
    });
    const s = await runInitiatorPass(mkCfg({ stores: ['orzgk'], terms: ['lucy'] }), { fetch: fake.fetch });

    expect(fake.ingestCalls().map((c) => c.body.url).sort()).toEqual(['https://orzgk.test/a', 'https://orzgk.test/b', 'https://orzgk.test/c']);
    expect(s.stores[0].discovered).toBe(3);
  });

  it('(10) two candidates with different url but the same collectUrl dedupe to ONE ingest POST', async () => {
    const byId = 'https://orzgk.test/wp-json/wc/store/v1/products/1';
    const fake = makeFake({
      lookup: () => ({
        status: 200,
        body: bodyWith('orzgk', [
          { itemId: '1', name: 'Lucy', url: 'https://orzgk.test/product/lucy/', collectUrl: byId },
          { itemId: '1', name: 'Lucy (variant)', url: 'https://orzgk.test/product/lucy/?variant=2', collectUrl: byId },
        ]),
      }),
    });
    const s = await runInitiatorPass(mkCfg({ stores: ['orzgk'], terms: ['lucy'] }), { fetch: fake.fetch });

    expect(fake.ingestCalls().map((c) => c.body.url)).toEqual([byId]); // exactly one POST
    expect(s.stores[0].discovered).toBe(1);
    expect(s.stores[0].enqueued).toBe(1);
  });
});

describe('runInitiatorPass — per-store lookups (one slow store must not zero the pass)', () => {
  it('fans out ONE lookup per term x store, each scoped to a single siteId', async () => {
    const fake = makeFake({
      lookup: (term, store) => ({ status: 200, body: lookupWith({ [store]: [`https://${store}.test/${term}`] }) }),
    });
    const s = await runInitiatorPass(mkCfg({ stores: ['amiami', 'gkloot'], terms: ['t1', 't2'] }), { fetch: fake.fetch });

    const issued = fake.lookupCalls().map((c) => {
      const p = new URL(c.url).searchParams;
      return `${p.get('q')}|${p.get('stores')}`;
    });
    expect(issued.sort()).toEqual(['t1|amiami', 't1|gkloot', 't2|amiami', 't2|gkloot']);
    expect(s.stores.find((x) => x.siteId === 'amiami')!.discovered).toBe(2);
    expect(s.stores.find((x) => x.siteId === 'gkloot')!.discovered).toBe(2);
  });

  it('keeps only the requested store from a lookup body (no cross-attribution between per-store calls)', async () => {
    // Every call answers with BOTH stores' candidates; only the store the call asked
    // for may be consumed, or a candidate would be counted once per store's call.
    const fake = makeFake({
      lookup: () => ({ status: 200, body: lookupWith({ amiami: ['https://amiami.test/a'], gkloot: ['https://gkloot.test/g'] }) }),
    });
    const s = await runInitiatorPass(mkCfg({ stores: ['amiami', 'gkloot'], terms: ['t'] }), { fetch: fake.fetch });

    expect(s.stores.find((x) => x.siteId === 'amiami')!.discovered).toBe(1);
    expect(s.stores.find((x) => x.siteId === 'gkloot')!.discovered).toBe(1);
    expect(fake.ingestCalls().map((c) => c.body.url).sort()).toEqual(['https://amiami.test/a', 'https://gkloot.test/g']);
  });

  it('a store whose lookup aborts (the 09:00Z amiami defect) does NOT zero the other stores', async () => {
    const fake = makeFake({
      lookup: (_term, store) =>
        store === 'amiami'
          ? { status: 0, throwErr: true, throwValue: new Error('This operation was aborted') }
          : { status: 200, body: lookupWith({ [store]: [`https://${store}.test/ok`] }) },
    });
    const s = await runInitiatorPass(mkCfg({ stores: ['amiami', 'gkloot', 'orzgk'], terms: ['t'] }), { fetch: fake.fetch });

    expect(s.stores.find((x) => x.siteId === 'amiami')!.discovered).toBe(0);
    expect(s.stores.find((x) => x.siteId === 'gkloot')!.discovered).toBe(1);
    expect(s.stores.find((x) => x.siteId === 'orzgk')!.discovered).toBe(1);
    expect(fake.ingestCalls().map((c) => c.body.url).sort()).toEqual(['https://gkloot.test/ok', 'https://orzgk.test/ok']);
    expect(s.totalDiscovered).toBe(2);
    expect(s.totalEnqueued).toBe(2);
  });

  it('caps maxUrlsPerStore per STORE across terms, not per lookup call', async () => {
    const fake = makeFake({
      lookup: (term, store) => ({ status: 200, body: lookupWith({ [store]: [`https://${store}.test/${term}-1`, `https://${store}.test/${term}-2`] }) }),
    });
    const s = await runInitiatorPass(mkCfg({ stores: ['amiami'], terms: ['t1', 't2'], maxUrlsPerStore: 3 }), { fetch: fake.fetch });
    expect(s.stores[0].discovered).toBe(3);
    expect(fake.ingestCalls().length).toBe(3);
  });
});

describe('runInitiatorPass — lookup retry (once, on a transient failure only)', () => {
  /** A lookup responder that answers by attempt number for a given store. */
  const byAttempt = (replies: Reply[]) => {
    let n = 0;
    return () => replies[Math.min(n++, replies.length - 1)];
  };

  it('retries a 5xx lookup ONCE after the configured delay and keeps the retry candidates', async () => {
    const slept: number[] = [];
    const fake = makeFake({
      lookup: byAttempt([
        { status: 503, body: { error: 'upstream' } },
        { status: 200, body: lookupWith({ amiami: ['https://amiami.test/ok'] }) },
      ]),
    });
    const s = await runInitiatorPass(mkCfg({ stores: ['amiami'], terms: ['t'], lookupRetryDelayMs: 5000 }), {
      fetch: fake.fetch,
      sleep: async (ms) => { slept.push(ms); },
    });

    expect(fake.lookupCalls().length).toBe(2);
    expect(slept).toEqual([5000]);
    const amiami = s.stores[0];
    expect(amiami.lookupAttempts).toBe(2);
    expect(amiami.lookupRetries).toBe(1);
    expect(amiami.lookupFailures).toBe(0);
    expect(amiami.discovered).toBe(1);
    expect(s.lookupFailures).toBe(0);
  });

  it('retries an aborted / timed-out lookup ONCE', async () => {
    const fake = makeFake({
      lookup: byAttempt([
        { status: 0, throwErr: true, throwValue: new Error('This operation was aborted') },
        { status: 200, body: lookupWith({ amiami: ['https://amiami.test/ok'] }) },
      ]),
    });
    const s = await runInitiatorPass(mkCfg({ stores: ['amiami'], terms: ['t'] }), { fetch: fake.fetch });
    expect(fake.lookupCalls().length).toBe(2);
    expect(s.stores[0].lookupRetries).toBe(1);
    expect(s.stores[0].lookupFailures).toBe(0);
    expect(s.stores[0].discovered).toBe(1);
  });

  it('does NOT retry a 4xx (a client-side / config fault the same call would repeat)', async () => {
    const fake = makeFake({ lookup: () => ({ status: 422, body: { error: 'unsupported store' } }) });
    const s = await runInitiatorPass(mkCfg({ stores: ['amiami'], terms: ['t'] }), { fetch: fake.fetch });
    expect(fake.lookupCalls().length).toBe(1);
    expect(s.stores[0].lookupAttempts).toBe(1);
    expect(s.stores[0].lookupRetries).toBe(0);
    expect(s.stores[0].lookupFailures).toBe(1);
    expect(s.lookupFailures).toBe(1);
  });

  it('counts a failed lookup once when the retry also fails', async () => {
    const fake = makeFake({ lookup: () => ({ status: 500, body: { error: 'boom' } }) });
    const s = await runInitiatorPass(mkCfg({ stores: ['amiami'], terms: ['t'] }), { fetch: fake.fetch });
    expect(fake.lookupCalls().length).toBe(2);
    expect(s.stores[0].lookupAttempts).toBe(2);
    expect(s.stores[0].lookupRetries).toBe(1);
    expect(s.stores[0].lookupFailures).toBe(1);
    expect(s.stores[0].discovered).toBe(0);
  });

  it('charges the retry to the global request budget', async () => {
    const fake = makeFake({
      lookup: byAttempt([
        { status: 500, body: { error: 'boom' } },
        { status: 200, body: lookupWith({ amiami: ['https://amiami.test/ok'] }) },
      ]),
    });
    const s = await runInitiatorPass(mkCfg({ stores: ['amiami'], terms: ['t'], maxRequests: 2 }), { fetch: fake.fetch });
    expect(fake.lookupCalls().length).toBe(2);
    expect(s.requestsIssued).toBe(2); // both lookup attempts spent the budget
    expect(fake.ingestCalls().length).toBe(0); // nothing left for the ingest POST
    expect(s.budgetExhausted).toBe(true);
    expect(s.stores[0].discovered).toBe(1);
    expect(s.stores[0].enqueued).toBe(0);
  });

  it('does not retry when the budget is spent: no second call, failure recorded, budget flagged', async () => {
    const fake = makeFake({ lookup: () => ({ status: 500, body: { error: 'boom' } }) });
    const s = await runInitiatorPass(mkCfg({ stores: ['amiami'], terms: ['t'], maxRequests: 1 }), { fetch: fake.fetch });
    expect(fake.lookupCalls().length).toBe(1);
    expect(s.stores[0].lookupAttempts).toBe(1);
    expect(s.stores[0].lookupRetries).toBe(0);
    expect(s.stores[0].lookupFailures).toBe(1);
    expect(s.budgetExhausted).toBe(true);
  });

  it('the pass-level lookupFailures is the per-store sum, and a failing store leaves the others whole', async () => {
    const fake = makeFake({
      lookup: (_term, store) =>
        store === 'amiami' ? { status: 500, body: { error: 'boom' } } : { status: 200, body: lookupWith({ [store]: [`https://${store}.test/ok`] }) },
    });
    const s = await runInitiatorPass(mkCfg({ stores: ['amiami', 'gkloot'], terms: ['t1', 't2'] }), { fetch: fake.fetch });

    const amiami = s.stores.find((x) => x.siteId === 'amiami')!;
    const gkloot = s.stores.find((x) => x.siteId === 'gkloot')!;
    expect(amiami.lookupAttempts).toBe(4); // 2 terms x (attempt + retry)
    expect(amiami.lookupRetries).toBe(2);
    expect(amiami.lookupFailures).toBe(2);
    expect(gkloot.lookupAttempts).toBe(2);
    expect(gkloot.lookupRetries).toBe(0);
    expect(gkloot.lookupFailures).toBe(0);
    expect(s.lookupFailures).toBe(2);
    expect(gkloot.discovered).toBe(1);
    expect(gkloot.enqueued).toBe(1);
  });

  it('does not retry a 2xx body it cannot parse (not a transport fault)', async () => {
    const fake = makeFake({ lookup: () => ({ status: 200, body: undefined }) });
    const bad: FetchLike = async (url, init) => {
      const r = await fake.fetch(url, init);
      return url.includes('/lookup') ? { ...r, json: async () => { throw new Error('bad json'); } } : r;
    };
    const s = await runInitiatorPass(mkCfg({ stores: ['amiami'], terms: ['t'] }), { fetch: bad });
    expect(fake.lookupCalls().length).toBe(1);
    expect(s.stores[0].lookupRetries).toBe(0);
    expect(s.stores[0].lookupFailures).toBe(1);
  });
});

describe('runInitiatorPass — default retry delay (no injected sleep)', () => {
  it('waits the configured delay with the real timer when deps.sleep is not provided', async () => {
    let first = true;
    const fake = makeFake({
      lookup: () => {
        if (first) {
          first = false;
          return { status: 502, body: { error: 'bad gateway' } };
        }
        return { status: 200, body: lookupWith({ amiami: ['https://amiami.test/ok'] }) };
      },
    });
    const started = Date.now();
    const s = await runInitiatorPass(mkCfg({ stores: ['amiami'], terms: ['t'], lookupRetryDelayMs: 60 }), { fetch: fake.fetch });
    expect(Date.now() - started).toBeGreaterThanOrEqual(55);
    expect(fake.lookupCalls().length).toBe(2);
    expect(s.stores[0].lookupRetries).toBe(1);
    expect(s.stores[0].discovered).toBe(1);
  });
});

describe('runInitiatorPass — enqueue fairness under a spent budget', () => {
  it('spends the last of the budget round-robin across stores instead of on the first stores in the list', async () => {
    const fake = makeFake({
      lookup: (_term, store) => ({ status: 200, body: lookupWith({ [store]: [`https://${store}.test/1`, `https://${store}.test/2`] }) }),
    });
    // 3 lookups + 3 of the 6 discovered URLs fit the budget: every store must get one, not the head of the list two.
    const s = await runInitiatorPass(
      mkCfg({ stores: ['amiami', 'gkloot', 'orzgk'], terms: ['t'], maxUrlsPerStore: 2, maxRequests: 6 }),
      { fetch: fake.fetch },
    );
    expect(s.totalDiscovered).toBe(6);
    expect(s.totalEnqueued).toBe(3);
    expect(s.budgetExhausted).toBe(true);
    expect(s.stores.map((x) => x.enqueued)).toEqual([1, 1, 1]);
  });

  it('WARNs, with store and url in the message, for every URL the spent budget drops', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const fake = makeFake({ lookup: () => ({ status: 200, body: lookupWith({ amiami: ['https://amiami.test/1', 'https://amiami.test/2'] }) }) });
      await runInitiatorPass(mkCfg({ stores: ['amiami'], terms: ['t'], maxUrlsPerStore: 2, maxRequests: 2 }), { fetch: fake.fetch });
      const dropped = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('ingest skipped'));
      expect(dropped).toHaveLength(1);
      expect(dropped[0]).toContain('store=amiami');
      expect(dropped[0]).toContain('https://amiami.test/2');
    } finally {
      warn.mockRestore();
    }
  });

  it('does not double-POST a URL when a siteId appears twice in INITIATOR_STORES', async () => {
    const fake = makeFake({ lookup: () => ({ status: 200, body: lookupWith({ amiami: ['https://amiami.test/x'] }) }) });
    const s = await runInitiatorPass(mkCfg({ stores: ['amiami', 'amiami'], terms: ['t'] }), { fetch: fake.fetch });
    expect(fake.lookupCalls().length).toBe(1);
    expect(fake.ingestCalls().map((c) => c.body.url)).toEqual(['https://amiami.test/x']);
    expect(s.totalEnqueued).toBe(1);
    expect(s.totalDiscovered).toBe(1);
  });
});
