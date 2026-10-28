/**
 * The ingest-initiator CronJob on fc-shared's server logging (LG-ADOPT-2): one pass is one run (one root trace, one
 * job.start, one job.end with the pass's counts), every line carries the run's trace id, and the lookups and enqueues it
 * sends our own scraper carry the run's W3C traceparent. The scraper is a recording fetch (or a server on localhost for the
 * real entrypoint): nothing here reaches a store.
 */
import { initiatorCounts, runInitiatorJob } from '../../initiator/job';
import { INGEST_INITIATOR, createServiceLogger } from '../../telemetry';
import { HEX32, fakeSpine, json, localServer, parseLines, recordingFetch, runEntry, stdoutLines } from '../helpers/jobTelemetry';

const SCRAPER = 'http://scraper.fc.svc.cluster.local:3050';
const env = (over: Record<string, string> = {}): Record<string, string> => ({
  SCRAPER_SERVICE_URL: SCRAPER, INITIATOR_STORES: 'shop', INITIATOR_TERMS: 'nendoroid', INITIATOR_REQUEST_SPACING_MS: '1',
  INITIATOR_LOOKUP_RETRY_DELAY_MS: '0', REPORT_FETCH_FAILURES: 'false', ...over,
});

describe('runInitiatorJob', () => {
  it('one pass is one run with every count on job.end, one trace id on every line, the run\'s traceparent on every call', async () => {
    const scraper = recordingFetch(url => (url.includes('/lookup')
      ? json(200, { results: [{ siteId: 'shop', candidates: [{ url: 'https://shop.example/p/1?ref=REFTOKEN9' }, { url: 'https://shop.example/p/2' }] }] })
      : url.includes('/ingest/scrape') && scraper.calls.filter(c => c.url.endsWith('/ingest/scrape')).length === 1
        ? json(403, { error: 'refused' })
        : json(202, { success: true, deduplicated: false })));
    const out: string[] = [];
    const logger = createServiceLogger(INGEST_INITIATOR, { env: env(), sink: l => out.push(l) });
    const s = await runInitiatorJob({ env: env(), logger, fetchImpl: scraper.fetchImpl });
    const lines = parseLines(out);

    expect(lines[0]).toMatchObject({ event: 'job.start', job: 'ingest-initiator', service: 'ingest-initiator' });
    const end = lines[lines.length - 1]!;
    expect(lines.filter(l => l.event === 'job.end')).toHaveLength(1);
    expect(end).toMatchObject({
      event: 'job.end', code: 'ok', stores_configured: 1, terms_configured: 1, requests_issued: s.requestsIssued, budget_exhausted: false,
      deadline_exceeded: false, lookup_failures: 0, discovered: 2, enqueued: 1, errors: 1,
    });
    expect(Object.keys(initiatorCounts(s))).toHaveLength(10);

    const runId = String(lines[0]?.trace_id);
    expect(HEX32.test(runId)).toBe(true);
    expect(lines.every(l => l.trace_id === runId)).toBe(true);
    expect(lines.find(l => String(l.msg).startsWith('lookup store=shop term=nendoroid status=200'))).toMatchObject({ tag: 'INITIATOR', level: 'info' });
    // the refused enqueue names its url without the query, and the query's value is nowhere
    expect(lines.find(l => String(l.msg).startsWith('ingest rejected'))).toMatchObject({ level: 'warn', msg: 'ingest rejected store=shop status=403 url=https://shop.example/p/1' });
    expect(out.join('\n')).not.toContain('REFTOKEN9');

    expect(scraper.calls.map(c => `${c.method} ${new URL(c.url).pathname}`)).toEqual(['GET /lookup', 'POST /ingest/scrape', 'POST /ingest/scrape']);
    for (const call of scraper.calls) expect(call.headers.traceparent).toMatch(new RegExp(`^00-${runId}-[0-9a-f]{16}-01$`));
  });
});

describe('runInitiatorJob: the failure ledger and the defaults', () => {
  it('a terminal lookup failure is reported to the ingest server on the run\'s trace, drained before job.end', async () => {
    const spine = await fakeSpine();
    try {
      const scraper = recordingFetch(() => json(400, { error: 'bad term' }));
      const out: string[] = [];
      const e = env({ INGEST_BASE_URL: spine.url, REPORT_FETCH_FAILURES: 'true' });
      await runInitiatorJob({ env: e, logger: createServiceLogger(INGEST_INITIATOR, { env: e, sink: l => out.push(l) }), fetchImpl: scraper.fetchImpl });
      const lines = parseLines(out);
      const runId = String(lines[0]?.trace_id);
      expect(spine.calls.map(c => c.path)).toEqual(['/ingest.v1.SpineIngest/ReportFetchFailure']);
      expect(String(spine.calls[0]?.headers.traceparent)).toMatch(new RegExp(`^00-${runId}-[0-9a-f]{16}-01$`));
      const rpcAt = lines.findIndex(l => l.event === 'rpc.out');
      expect(rpcAt).toBeGreaterThan(0);
      expect(rpcAt).toBeLessThan(lines.findIndex(l => l.event === 'job.end'));
      expect(lines[lines.length - 1]).toMatchObject({ event: 'job.end', code: 'ok', lookup_failures: 1 });
    } finally {
      await spine.close();
    }
  });

  it('with no options it reads process.env, fetches with the global fetch and writes its lines to stdout', async () => {
    const keys = env();
    const saved = Object.fromEntries(Object.keys(keys).map(k => [k, process.env[k]]));
    Object.assign(process.env, keys);
    const seen: Array<Record<string, string>> = [];
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      seen.push({ ...(init?.headers as Record<string, string>) });
      return json(200, { results: [] });
    });
    const written: string[] = [];
    const write = jest.spyOn(process.stdout, 'write').mockImplementation(chunk => { written.push(String(chunk)); return true; });
    try {
      await runInitiatorJob();
    } finally {
      write.mockRestore();
      fetchSpy.mockRestore();
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
    const lines = parseLines(written.map(chunk => chunk.trimEnd()));
    expect(lines[0]).toMatchObject({ event: 'job.start', service: 'ingest-initiator' });
    expect(lines[lines.length - 1]).toMatchObject({ event: 'job.end', code: 'ok', discovered: 0 });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.traceparent).toMatch(new RegExp(`^00-${String(lines[0]?.trace_id)}-[0-9a-f]{16}-01$`));
  });
});

describe('the initiator entrypoint (src/initiator/run.ts, what the CronJob runs)', () => {
  it('writes only JSON lines from job.start to job.end, exits 0, and our scraper sees the run\'s traceparent', async () => {
    const scraper = await localServer(() => ({ status: 200, type: 'application/json', body: JSON.stringify({ results: [] }) }));
    try {
      const r = await runEntry('src/initiator/run.ts', env({ SCRAPER_SERVICE_URL: scraper.url }));
      expect(r.stderr).toBe('');
      expect(r.code).toBe(0);
      const lines = stdoutLines(r.stdout);
      expect(lines[0]).toMatchObject({ event: 'job.start', service: 'ingest-initiator' });
      expect(lines[lines.length - 1]).toMatchObject({ event: 'job.end', code: 'ok', discovered: 0 });
      const runId = String(lines[0]?.trace_id);
      expect(lines.every(l => l.trace_id === runId)).toBe(true);
      expect(scraper.calls.map(c => c.path.split('?')[0])).toEqual(['/lookup']);
      expect(String(scraper.calls[0]?.headers.traceparent)).toMatch(new RegExp(`^00-${runId}-[0-9a-f]{16}-01$`));
    } finally {
      await scraper.close();
    }
  });
});
