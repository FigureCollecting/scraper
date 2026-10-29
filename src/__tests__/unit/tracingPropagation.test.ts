/**
 * The scraper SERVICE's outgoing trace propagation (src/tracing.ts), measured in a real process: no store, CDN or
 * image host may ever receive traceparent, tracestate or baggage; in-cluster hosts get them, so the item's trace
 * still reaches the spine.
 *
 * The probe (fixtures/propagationProbe.ts) runs under tsx with NODE_ENV=production, so the real tracing module starts
 * its SDK and auto-instrumentation exactly as the image does; 127.0.0.1 stands in for a third-party host (not on
 * fc-shared's default allowlist) and localhost for an in-cluster one (on it). Everything stays on this machine.
 *
 * The run id (LG-RUNID) rides the same headers as the W3C baggage entry fc.run_id: sent with traceparent to in-cluster
 * hosts only, taken from an inbound request so its handler runs in the caller's run, and stored with an item the
 * request enqueues (queue_items.run_id).
 */
import { runEntry } from '../helpers/jobTelemetry';

const PROBE_TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const INBOUND_TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const INGEST_PATH = '/ingest.v1.SpineIngest/Ingest';
const REPORT_CAPTURE_PATH = '/ingest.v1.SpineIngest/ReportCapture';
const REPORT_FAILURE_PATH = '/ingest.v1.SpineIngest/ReportFetchFailure';
const RUN_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

interface Seen {
  path: string;
  host: string;
  traceparent: string | null;
  tracestate: string | null;
  baggage: string | null;
  inboundTraceId?: string | null;
  inboundRunId?: string | null;
  inboundBaggageKeys?: string[];
}

let seen: Seen[] = [];
let queued: Array<{ url: string; status: number; runId: string | null }> = [];
const at = (host: string, path: string): Seen => {
  const found = seen.find(s => s.host === host && s.path === path);
  if (found === undefined) throw new Error(`probe saw no ${path} request to ${host}: ${JSON.stringify(seen)}`);
  return found;
};
const w3c = (s: Seen) => ({ traceparent: s.traceparent, tracestate: s.tracestate, baggage: s.baggage });
const NONE = { traceparent: null, tracestate: null, baggage: null };

beforeAll(async () => {
  const run = await runEntry('src/__tests__/fixtures/propagationProbe.ts', { NODE_ENV: 'production' });
  const line = run.stdout.split('\n').find(l => l.startsWith('PROBE_RESULT '));
  if (run.code !== 0 || line === undefined) throw new Error(`probe exited ${run.code}: ${run.stdout.slice(-600)} ${run.stderr.slice(-600)}`);
  seen = JSON.parse(line.slice('PROBE_RESULT '.length)) as Seen[];
  const queue = run.stdout.split('\n').find(l => l.startsWith('PROBE_QUEUE '));
  if (queue === undefined) throw new Error(`probe printed no PROBE_QUEUE line: ${run.stdout.slice(-600)}`);
  queued = JSON.parse(queue.slice('PROBE_QUEUE '.length)) as typeof queued;
}, 90_000);

describe('scraper service tracing: outgoing W3C headers go to in-cluster hosts only', () => {
  it.each([['/fetch'], ['/http'], [INGEST_PATH], [REPORT_CAPTURE_PATH], [REPORT_FAILURE_PATH]])('sends a third-party host nothing on %s (no traceparent, tracestate or baggage)', path => {
    expect(w3c(at('127.0.0.1', path))).toEqual(NONE);
  });

  it.each([['/fetch'], ['/http'], [INGEST_PATH], [REPORT_CAPTURE_PATH], [REPORT_FAILURE_PATH]])('sends an in-cluster host the active trace on %s', path => {
    const s = at('localhost', path);
    expect(s.traceparent).toMatch(new RegExp(`^00-${PROBE_TRACE_ID}-[0-9a-f]{16}-01$`));
    expect(s.tracestate).toBe('fc=probe');
    expect(s.baggage).toBe('probe=yes');
  });

  it('impit adds no trace headers to any host: the native lane is not instrumented', () => {
    expect(w3c(at('127.0.0.1', '/impit'))).toEqual(NONE);
    expect(w3c(at('localhost', '/impit'))).toEqual(NONE);
  });

  it("still continues an inbound request's trace", () => {
    expect(at('127.0.0.1', '/inbound').inboundTraceId).toBe(INBOUND_TRACE_ID);
  });
});

describe('scraper service tracing: the run id (baggage fc.run_id) goes where traceparent goes, and comes in with it', () => {
  const RUN_PATHS = [['/run/fetch'], ['/run/http'], [`/run${INGEST_PATH}`], [`/run${REPORT_CAPTURE_PATH}`], [`/run${REPORT_FAILURE_PATH}`]];

  it.each(RUN_PATHS)('sends a third-party host nothing inside a run on %s (no traceparent, tracestate or baggage)', path => {
    expect(w3c(at('127.0.0.1', path))).toEqual(NONE);
  });

  it.each(RUN_PATHS)('sends an in-cluster host the run as the first baggage entry beside the trace on %s', path => {
    const s = at('localhost', path);
    expect(s.traceparent).toMatch(new RegExp(`^00-${PROBE_TRACE_ID}-[0-9a-f]{16}-01$`));
    expect(s.tracestate).toBe('fc=probe');
    expect(s.baggage).toBe(`fc.run_id=${RUN_ID},probe=yes`);
  });

  it('impit adds nothing inside a run either', () => {
    expect(w3c(at('127.0.0.1', '/run/impit'))).toEqual(NONE);
    expect(w3c(at('localhost', '/run/impit'))).toEqual(NONE);
  });

  it("serves an inbound request carrying fc.run_id in the caller's run, and drops the raw entry from its baggage", () => {
    const s = at('127.0.0.1', '/inbound-run');
    expect(s.inboundTraceId).toBe(INBOUND_TRACE_ID);
    expect(s.inboundRunId).toBe(RUN_ID);
    expect(s.inboundBaggageKeys).toEqual(['k']);
  });

  it('serves an inbound request without one in no run', () => {
    expect(at('127.0.0.1', '/inbound').inboundRunId).toBeNull();
  });

  it("stores the caller's run with the item POST /ingest/scrape enqueues (queue_items.run_id), and none without one", () => {
    expect(queued).toEqual([
      { url: 'https://shop.example.test/item/in-run', status: 202, runId: RUN_ID },
      { url: 'https://shop.example.test/item/no-run', status: 202, runId: null },
    ]);
  });
});
