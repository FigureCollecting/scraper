/**
 * The ingest-crawler CronJob (and ingest-seed-mfc, the same entry with CRAWLER_MODE=seed) on fc-shared's server logging
 * (LG-ADOPT-2): ONE pass is ONE run, so one root trace, one job.start line and one job.end line carrying the pass's
 * counts; every line in between (the crawler's own, an rpc.out) carries that run's trace id; the calls to our own scraper
 * and to the ingest server carry the run's W3C traceparent; nothing secret reaches a line.
 *
 * The scraper is a recording fetch (or, for the real entrypoint, a server on localhost) and the ingest server is a stand-in
 * on localhost: nothing here reaches a store.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { crawlerCounts, runCrawlerJob } from '../../crawler/job';
import { INGEST_CRAWLER, createServiceLogger } from '../../telemetry';
import {
  HEX32, fakeSpine, json, localServer, parseLines, recordingFetch, runEntry, stdoutLines, type Line,
} from '../helpers/jobTelemetry';

const SCRAPER = 'http://scraper.fc.svc.cluster.local:3050';

describe('runCrawlerJob', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'crawler-job-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const env = (over: Record<string, string> = {}): Record<string, string> => ({
    SCRAPER_SERVICE_URL: SCRAPER, CRAWLER_STORES: 'shop', CRAWLER_MODE: 'recent', CRAWLER_LEDGER_DIR: dir,
    CRAWLER_RECENT_MAX_PAGES: '1', CRAWLER_REQUEST_SPACING_MS: '1', CRAWLER_MAX_CONCURRENCY: '1', REPORT_FETCH_FAILURES: 'false',
    ...over,
  });
  const catalogOf = (ids: string[]) => json(200, { siteId: 'shop', items: ids.map(id => ({ itemId: id, collectUrl: `https://shop.example/p/${id}` })), hasMore: false });

  async function run(e: Record<string, string>, fetchImpl: typeof fetch) {
    const out: string[] = [];
    const logger = createServiceLogger(INGEST_CRAWLER, { env: e, sink: l => out.push(l) });
    let summary: Awaited<ReturnType<typeof runCrawlerJob>> | undefined;
    let thrown: unknown;
    try { summary = await runCrawlerJob({ env: e, argv: [], logger, fetchImpl }); } catch (err) { thrown = err; }
    return { out, lines: parseLines(out), summary, thrown };
  }

  it('one pass is one run: job.start, the pass, ONE job.end with every count; one trace id on every line and every call', async () => {
    const scraper = recordingFetch(url => (url.includes('/catalog') ? catalogOf(['1', '2']) : json(202, { success: true, deduplicated: false })));
    const r = await run(env(), scraper.fetchImpl);
    expect(r.thrown).toBeUndefined();
    const s = r.summary!;
    expect(s.totalEnqueued).toBe(2);

    const events = r.lines.map(l => l.event);
    expect(events[0]).toBe('job.start');
    expect(events[events.length - 1]).toBe('job.end');
    expect(events.filter(e => e === 'job.start')).toHaveLength(1);
    expect(events.filter(e => e === 'job.end')).toHaveLength(1);
    const end = r.lines[r.lines.length - 1]!;
    expect(end).toMatchObject({ level: 'info', code: 'ok', job: 'ingest-crawler', service: 'ingest-crawler' });
    // the end line's counts ARE the pass's own summary (crawlerCounts), printed snake_case
    expect(end).toMatchObject({
      mode: 'recent', stores_configured: 1, requests_issued: s.requestsIssued, budget_exhausted: false, pages_fetched: 1,
      discovered: 2, enqueued: 2, reobserved: 0, reobserve_landed: 0, range_walked: 0, gap_ids_swept: 0, gap_enqueued: 0,
      lists_enqueued: 0, errors: 0, skipped: 0,
    });
    expect(Object.keys(crawlerCounts(s))).toHaveLength(16);

    const runId = String(r.lines[0]?.trace_id);
    expect(HEX32.test(runId)).toBe(true);
    expect(r.lines.every(l => l.trace_id === runId)).toBe(true);
    // the crawler's own lines are in the shape too: the legacy [CRAWLER] text became a tag and a message, its data fields
    const starting = r.lines.find(l => l.msg === 'pass starting');
    expect(starting).toMatchObject({ event: 'app.log', tag: 'CRAWLER', mode: 'recent' });
    expect(r.out.every(l => !l.includes('\n'))).toBe(true);

    // every call to our own scraper carries the run's traceparent
    expect(scraper.calls.map(c => `${c.method} ${new URL(c.url).pathname}`)).toEqual(['GET /catalog', 'POST /ingest/scrape', 'POST /ingest/scrape']);
    for (const call of scraper.calls) expect(call.headers.traceparent).toMatch(new RegExp(`^00-${runId}-[0-9a-f]{16}-01$`));
    expect(scraper.calls[1]?.headers['Content-Type']).toBe('application/json');
  });

  it('a scraper address outside the cluster gets no traceparent (the lines keep their trace id)', async () => {
    const scraper = recordingFetch(url => (url.includes('/catalog') ? catalogOf([]) : json(202, {})));
    const r = await run(env({ SCRAPER_SERVICE_URL: 'http://scraper.example.com:3050' }), scraper.fetchImpl);
    expect(r.thrown).toBeUndefined();
    expect(scraper.calls).toHaveLength(1);
    expect(scraper.calls[0]?.headers.traceparent).toBeUndefined();
    expect(r.lines.every(l => HEX32.test(String(l.trace_id)))).toBe(true);
  });

  it('a failure report reaches the ingest server with the run\'s traceparent and one rpc.out line; planted secrets never reach a line', async () => {
    const spine = await fakeSpine();
    try {
      const PLANTED = ['CFCLEAR1', 'BMCOOKIE2', 'SESSV3', 'PROXYPW4', 'TOKQ5'];
      const scraper = recordingFetch(() => {
        throw new Error('socket hang up for https://shop.example/c?token=TOKQ5 via http://exit:PROXYPW4@proxy.example:8080; '
          + 'upstream Cookie: cf_clearance=CFCLEAR1; __cf_bm=BMCOOKIE2; PHPSESSID=SESSV3');
      });
      const r = await run(env({ INGEST_BASE_URL: spine.url, REPORT_FETCH_FAILURES: 'true' }), scraper.fetchImpl);
      expect(r.thrown).toBeUndefined();
      const runId = String(r.lines[0]?.trace_id);

      expect(spine.calls.map(c => c.path)).toEqual(['/ingest.v1.SpineIngest/ReportFetchFailure']);
      expect(String(spine.calls[0]?.headers.traceparent)).toMatch(new RegExp(`^00-${runId}-[0-9a-f]{16}-01$`));
      const out = r.lines.filter(l => l.event === 'rpc.out');
      expect(out).toEqual([expect.objectContaining({ call: 'ingest.v1.SpineIngest/ReportFetchFailure', code: 'ok', trace_id: runId })]);
      // the report is drained BEFORE the run ends: its rpc.out precedes job.end
      expect(r.lines.findIndex(l => l.event === 'rpc.out')).toBeLessThan(r.lines.findIndex(l => l.event === 'job.end'));

      const errored = r.lines.find(l => l.msg === 'catalog errored');
      expect(errored).toMatchObject({ level: 'warn', tag: 'CRAWLER', site_id: 'shop' });
      expect(r.lines[r.lines.length - 1]).toMatchObject({ event: 'job.end', code: 'ok', errors: r.summary!.totalErrors });
      const all = r.out.join('\n');
      for (const s of PLANTED) expect(all).not.toContain(s);
      expect(errored?.error).toBe('socket hang up for https://shop.example/c via http://proxy.example:8080; upstream [REDACTED]');
    } finally {
      await spine.close();
    }
  });

  it('with no options it reads process.env, fetches with the global fetch and writes its lines to stdout', async () => {
    const keys = env({ CRAWLER_MAX_CONCURRENCY: '1' });
    const saved = Object.fromEntries(Object.keys(keys).map(k => [k, process.env[k]]));
    Object.assign(process.env, keys);
    const seen: Array<Record<string, string>> = [];
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      seen.push({ ...(init?.headers as Record<string, string>) });
      return catalogOf([]);
    });
    const written: string[] = [];
    const write = jest.spyOn(process.stdout, 'write').mockImplementation(chunk => { written.push(String(chunk)); return true; });
    try {
      await runCrawlerJob();
    } finally {
      write.mockRestore();
      fetchSpy.mockRestore();
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
    const lines = parseLines(written.map(chunk => chunk.trimEnd()));
    expect(lines[0]).toMatchObject({ event: 'job.start', service: 'ingest-crawler' });
    expect(lines[lines.length - 1]).toMatchObject({ event: 'job.end', code: 'ok', discovered: 0 });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.traceparent).toMatch(new RegExp(`^00-${String(lines[0]?.trace_id)}-[0-9a-f]{16}-01$`));
  });

  it('a run that cannot start (an unknown CRAWLER_MODE) is one start and one end, code=error, rethrown, and fetches nothing', async () => {
    const scraper = recordingFetch(() => json(200, {}));
    const r = await run(env({ CRAWLER_MODE: 'bogus' }), scraper.fetchImpl);
    expect(r.thrown).toBeInstanceOf(Error);
    expect((r.thrown as Error).message).toMatch(/CRAWLER_MODE names an unknown phase/);
    expect(r.lines.map(l => [l.event, l.level])).toEqual([['job.start', 'info'], ['job.end', 'error']]);
    expect(r.lines[1]).toMatchObject({ code: 'error', err: { message: expect.stringMatching(/CRAWLER_MODE names an unknown phase/) } });
    expect(scraper.calls).toEqual([]);
  });
});

describe('the crawler entrypoint (src/crawler/run.ts, what the CronJob runs)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'crawler-entry-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes only JSON lines, job.start first and job.end last, and our scraper sees the run\'s traceparent', async () => {
    const scraper = await localServer(() => ({ status: 200, type: 'application/json', body: JSON.stringify({ siteId: 'shop', items: [], hasMore: false }) }));
    try {
      const r = await runEntry('src/crawler/run.ts', {
        SCRAPER_SERVICE_URL: scraper.url, CRAWLER_STORES: 'shop', CRAWLER_MODE: 'recent', CRAWLER_LEDGER_DIR: dir,
        CRAWLER_RECENT_MAX_PAGES: '1', CRAWLER_REQUEST_SPACING_MS: '1', REPORT_FETCH_FAILURES: 'false',
      });
      expect(r.stderr).toBe('');
      expect(r.code).toBe(0);
      const lines: Line[] = stdoutLines(r.stdout);
      expect(lines[0]).toMatchObject({ event: 'job.start', service: 'ingest-crawler' });
      expect(lines[lines.length - 1]).toMatchObject({ event: 'job.end', code: 'ok', discovered: 0 });
      const runId = String(lines[0]?.trace_id);
      expect(lines.every(l => l.service === 'ingest-crawler' && l.trace_id === runId)).toBe(true);
      expect(scraper.calls.map(c => c.path.split('?')[0])).toEqual(['/catalog']);
      expect(String(scraper.calls[0]?.headers.traceparent)).toMatch(new RegExp(`^00-${runId}-[0-9a-f]{16}-01$`));
    } finally {
      await scraper.close();
    }
  });

  it('a failed run exits 1 with exactly job.start and job.end on stdout, the failure written once, nothing on stderr', async () => {
    const r = await runEntry('src/crawler/run.ts', { CRAWLER_MODE: 'bogus', CRAWLER_LEDGER_DIR: dir, REPORT_FETCH_FAILURES: 'false' });
    expect(r.stderr).toBe('');
    expect(r.code).toBe(1);
    const lines = stdoutLines(r.stdout);
    expect(lines.map(l => [l.event, l.code])).toEqual([['job.start', undefined], ['job.end', 'error']]);
    expect(lines[0]?.trace_id).toBe(lines[1]?.trace_id);
  });
});
