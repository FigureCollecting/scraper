/**
 * telemetry.ts — the scraper's one seam onto fc-shared's node-only server subpaths, for the batch jobs
 * (LG-ADOPT-2). What a job's pod log must be, line by line:
 *   - one JSON object per line in the estate's shape, service named for the job;
 *   - one job.start and one job.end per run, the end line carrying the run's counts; a failed run is
 *     still one start and one end, code=error, the error rethrown unchanged;
 *   - every line of the run (the legacy logger's, a stray console call's, an rpc.out) carries the ONE
 *     run trace id, and tracing that cannot start never stops the run;
 *   - a call to an in-cluster service carries the run's W3C traceparent, a call anywhere else none;
 *   - no cookie, cf_clearance, token or proxy credential value in any line; a URL loses its userinfo,
 *     query and fragment.
 * Every request here goes to a server this test starts on localhost; nothing reaches a store.
 */
import { context, propagation, trace } from '@opentelemetry/api';
import { TracerProvider } from '@opentelemetry/sdk-trace';
import { logger as legacy } from '../../utils/logger';
import { FailureReporter } from '../../services/failureReporter';
import { CaptureReporter } from '../../services/captureReporter';
import {
  GALLERY_CAPTURE, INGEST_CRAWLER, INGEST_INITIATOR, createServiceLogger, legacyLine, routeLegacyLogger, runJobProcess,
  serviceName, startServiceTracing, traceHeaders, tracedFetch,
} from '../../telemetry';
import { HEX32, fakeSpine, type Line } from '../helpers/jobTelemetry';

function captured(service = INGEST_CRAWLER, env: Record<string, string> = {}) {
  const out: string[] = [];
  const logger = createServiceLogger(service, { env, sink: l => out.push(l) });
  return { out, logger, lines: (): Line[] => out.map(l => JSON.parse(l) as Line) };
}

describe('telemetry: names and the logger', () => {
  it('names each job as fc-infra does, and OTEL_SERVICE_NAME wins when the deployment sets one', () => {
    expect([INGEST_CRAWLER, INGEST_INITIATOR, GALLERY_CAPTURE]).toEqual(['ingest-crawler', 'ingest-initiator', 'gallery-capture']);
    expect(serviceName(INGEST_CRAWLER, {})).toBe('ingest-crawler');
    expect(serviceName(INGEST_CRAWLER, { OTEL_SERVICE_NAME: ' ingest-seed-mfc ' })).toBe('ingest-seed-mfc');
    expect(serviceName(INGEST_CRAWLER, { OTEL_SERVICE_NAME: '  ' })).toBe('ingest-crawler');
  });

  it('writes one JSON object per line, in the shape, named for the job', () => {
    const c = captured(INGEST_INITIATOR);
    c.logger.info({ event: 'x.y', siteId: 'orzgk' }, 'hello');
    expect(c.out).toHaveLength(1);
    expect(c.out[0]).not.toContain('\n');
    expect(c.lines()[0]).toMatchObject({ level: 'info', service: 'ingest-initiator', event: 'x.y', msg: 'hello', site_id: 'orzgk' });
  });

  it('reads process.env when no env is given', async () => {
    const saved = process.env.OTEL_SERVICE_NAME;
    process.env.OTEL_SERVICE_NAME = 'from-process-env';
    const written: string[] = [];
    const write = jest.spyOn(process.stdout, 'write').mockImplementation(chunk => { written.push(String(chunk)); return true; });
    try {
      expect(serviceName(INGEST_CRAWLER)).toBe('from-process-env');
      createServiceLogger(INGEST_CRAWLER).info('hello');
      const tracing = startServiceTracing(INGEST_CRAWLER);
      try { expect(tracing.state.service).toBe('from-process-env'); } finally { await tracing.shutdown(); }
      await runJobProcess(INGEST_CRAWLER, async () => 1, n => ({ n }));
    } finally {
      write.mockRestore();
      if (saved === undefined) delete process.env.OTEL_SERVICE_NAME; else process.env.OTEL_SERVICE_NAME = saved;
    }
    const lines = written.map(chunk => JSON.parse(chunk) as Line);
    expect(lines.map(l => [l.service, l.event])).toEqual([['from-process-env', 'app.log'], ['from-process-env', 'job.start'], ['from-process-env', 'job.end']]);
    expect(lines[2]).toMatchObject({ n: 1 });
  });

  it('sends lines to stdout when no sink is given', () => {
    const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      createServiceLogger(GALLERY_CAPTURE, { env: {} }).info('to stdout');
      expect(String(write.mock.calls[0]?.[0])).toMatch(/^\{.*"service":"gallery-capture".*"msg":"to stdout".*\}\n$/);
    } finally {
      write.mockRestore();
    }
  });
});

describe('telemetry: redaction (store cookies, cf_clearance, tokens, proxy credentials)', () => {
  const SECRETS = ['CFCLEAR123secret', 'BMCOOKIE456', 'PHPSESS789', 'TFATRUST000', 'PROXYPASS1', 'SOCKSPASS2', 'BAREPASS3', 'TOKENQ4', 'FRAGSECRET5', 'USERPASS6', 'SETCOOKIE7', 'APIKEY8', 'ACCESS9'];

  it('masks every planted secret, whichever path the line takes, and strips URLs to scheme, host and path', async () => {
    const c = captured();
    const restore = routeLegacyLogger(c.logger);
    try {
      // the legacy logger, as the crawler and initiator write
      legacy.warn('[CRAWLER] ingest errored', {
        siteId: 'shop',
        error: 'upstream said cf_clearance=CFCLEAR123secret; __cf_bm=BMCOOKIE456 expired',
        cookie: 'PHPSESSID=PHPSESS789',
        proxy: 'http://user:PROXYPASS1@proxy.example:8080',
      });
      legacy.error('[CRAWLER] catalog errored', new Error('via socks5h://u:SOCKSPASS2@exit.example:1080 and u:BAREPASS3@exit.example:1081'));
      legacy.info('[CRAWLER] item https://buyer:USERPASS6@shop.example/p/1?token=TOKENQ4#t=FRAGSECRET5 queued');
      legacy.warn('[CRAWLER] lookup refused', { detail: 'the store said api_key=APIKEY8 and access_token=ACCESS9 are stale' });
      // a stray console call inside a run, through fc-shared's bridge
      const { installConsoleBridge } = await import('@figurecollecting/fc-shared/server/log');
      const unbridge = installConsoleBridge(c.logger);
      try {
        console.warn('[FAILURE LEDGER] report dropped for shop: header Cookie: tfaTrust=TFATRUST000; x=1');
        console.warn('[IMAGE-CAPTURE] answer had set-cookie: __cf_bm=SETCOOKIE7; path=/');
      } finally {
        unbridge();
      }
    } finally {
      restore();
    }
    const all = c.out.join('\n');
    for (const s of SECRETS) expect(all).not.toContain(s);
    expect(c.lines()[2]?.msg).toBe('item https://shop.example/p/1 queued');
    expect(c.lines()[3]?.detail).toBe('the store said [REDACTED] and [REDACTED] are stale');
    expect(c.out).toHaveLength(6);
    expect(c.lines().map(l => l.tag)).toEqual(['CRAWLER', 'CRAWLER', 'CRAWLER', 'CRAWLER', 'FAILURE LEDGER', 'IMAGE-CAPTURE']);
  });
});

describe('telemetry: the legacy logger, routed', () => {
  it('splits the [TAG] prefix off, keeps data as fields, and never lets data take a key the shape owns', () => {
    const [fields, msg] = legacyLine('[CRAWLER] store summary', {
      siteId: 'orzgk', durationMs: 12, version: 'r1', event: 'e', time: 't', code: 'c', job: 'j', err: 'x', tag: 'mine', msg: 'm',
    });
    expect(msg).toBe('store summary');
    expect(fields).toEqual({
      tag: 'CRAWLER', siteId: 'orzgk', durationMs: 12,
      data_version: 'r1', data_event: 'e', data_time: 't', data_code: 'c', data_job: 'j', data_err: 'x', data_tag: 'mine', data_msg: 'm',
    });
  });

  it('carries an Error as err, any other value as data, and nothing for an empty one', () => {
    const boom = new Error('boom');
    expect(legacyLine('[INITIATOR] pass crashed', boom)).toEqual([{ tag: 'INITIATOR', err: boom }, 'pass crashed']);
    expect(legacyLine('plain text', ['a', 'b'])).toEqual([{ data: ['a', 'b'] }, 'plain text']);
    expect(legacyLine('plain text', 7)).toEqual([{ data: 7 }, 'plain text']);
    for (const empty of [undefined, null, '', 0, false]) expect(legacyLine('[X] y', empty)).toEqual([{ tag: 'X' }, 'y']);
    expect(legacyLine('[scraper:mfc] parsed', { n: 1 }, 'scraper:mfc')).toEqual([{ namespace: 'scraper:mfc', tag: 'scraper:mfc', n: 1 }, 'parsed']);
  });

  it('sends every legacy line through the job logger at its own level, and gives the console back on restore', () => {
    const c = captured();
    const restore = routeLegacyLogger(c.logger);
    try {
      legacy.info('[CRAWLER] pass starting', { mode: 'recent' });
      legacy.warn('[CRAWLER] catalog failed', { status: 503 });
      legacy.error('[CRAWLER] pass crashed', new Error('disk full'));
      legacy.error('[CRAWLER] odd failure', { reason: 'x' });
      legacy.debug('scraper:off', 'not enabled, never written');
    } finally {
      restore();
    }
    expect(c.lines().map(l => [l.level, l.event, l.tag, l.msg])).toEqual([
      ['info', 'app.log', 'CRAWLER', 'pass starting'],
      ['warn', 'app.log', 'CRAWLER', 'catalog failed'],
      ['error', 'app.log', 'CRAWLER', 'pass crashed'],
      ['error', 'app.log', 'CRAWLER', 'odd failure'],
    ]);
    expect(c.lines()[0]).toMatchObject({ mode: 'recent' });
    expect(c.lines()[2]).toMatchObject({ err: { type: 'Error', message: 'disk full' } });
    // restored: the legacy logger writes to the console again, and the job logger hears nothing more
    legacy.info('[CRAWLER] after');
    legacy.warn('[CRAWLER] after, warned');
    expect(c.out).toHaveLength(4);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('[INFO] [CRAWLER] after'), '');
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('[WARN] [CRAWLER] after, warned'), '');
  });

  it('routes an enabled debug namespace at debug level (written only when LOG_LEVEL lets debug through)', () => {
    const quiet = captured();
    const loud = captured(INGEST_CRAWLER, { LOG_LEVEL: 'debug' });
    const enabled = (legacy as unknown as { enabledNamespaces: Set<string> }).enabledNamespaces;
    enabled.add('scraper:test');
    try {
      for (const target of [quiet, loud]) {
        const restore = routeLegacyLogger(target.logger);
        try { legacy.debug('scraper:test', 'detail', { n: 2 }); } finally { restore(); }
      }
      // not routed: the console line, as before
      legacy.debug('scraper:test', 'to the console');
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('[DEBUG] [scraper:test] to the console'), '');
    } finally {
      enabled.delete('scraper:test');
    }
    expect(quiet.out).toEqual([]);
    expect(loud.lines()).toEqual([expect.objectContaining({ level: 'debug', namespace: 'scraper:test', msg: 'detail', n: 2 })]);
  });
});

describe('telemetry: tracing and traceparent', () => {
  it('records spans with real ids and never exports, whatever OTEL_EXPORTER_OTLP_* says', async () => {
    const tracing = startServiceTracing(INGEST_CRAWLER, {
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector.example:4317', OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://collector.example:4317',
    });
    try {
      expect(tracing.state).toMatchObject({ service: 'ingest-crawler', exporter: 'noop' });
      const span = trace.getTracer('t').startSpan('s');
      expect(HEX32.test(span.spanContext().traceId)).toBe(true);
      span.end();
    } finally {
      await tracing.shutdown();
    }
  });

  it('puts the active span\'s traceparent on a request to an in-cluster host, and nothing on any other', async () => {
    expect(traceHeaders('http://scraper.fc.svc.cluster.local:3050/ingest/scrape')).toEqual({});
    const tracing = startServiceTracing(INGEST_CRAWLER, {});
    try {
      const span = trace.getTracer('t').startSpan('run');
      const { traceId, spanId } = span.spanContext();
      context.with(trace.setSpan(context.active(), span), () => {
        const internal = traceHeaders('http://scraper.fc.svc.cluster.local:3050/ingest/scrape', { 'Content-Type': 'application/json' });
        expect(internal).toEqual({ 'Content-Type': 'application/json', traceparent: `00-${traceId}-${spanId}-01` });
        expect(traceHeaders('https://shop.example/item/1')).toEqual({});
        expect(traceHeaders('http://127.0.0.1:3050/x')).toEqual({});
      });
      span.end();
      expect(traceHeaders('http://scraper.fc.svc.cluster.local:3050/x')).toEqual({});
    } finally {
      await tracing.shutdown();
    }
    expect(propagation.fields()).toEqual([]);
  });
});

describe('telemetry: tracedFetch', () => {
  it('adds the active span\'s traceparent to an in-cluster request, with or without request options, and keeps the caller\'s', async () => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    const base = (async (url: string | URL | Request, init?: RequestInit) => { seen.push({ url: String(url), init }); return new Response('{}'); }) as typeof fetch;
    const traced = tracedFetch(base);
    const tracing = startServiceTracing(INGEST_CRAWLER, {});
    try {
      const span = trace.getTracer('t').startSpan('run');
      await context.with(trace.setSpan(context.active(), span), async () => {
        await traced('http://scraper.fc.svc.cluster.local:3050/health/detailed');
        await traced('http://scraper.fc.svc.cluster.local:3050/ingest/scrape', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        await traced('https://shop.example/item/1', { method: 'GET' });
      });
      const parent = `00-${span.spanContext().traceId}-${span.spanContext().spanId}-01`;
      span.end();
      expect(seen.map(c => c.init)).toEqual([
        { headers: { traceparent: parent } },
        { method: 'POST', headers: { 'Content-Type': 'application/json', traceparent: parent }, body: '{}' },
        { method: 'GET', headers: {} },
      ]);
    } finally {
      await tracing.shutdown();
    }
  });
});

describe('telemetry: runJobProcess', () => {
  it('is one run: one job.start, one job.end with the counts, every line on the run trace id, and the process put back after', async () => {
    const c = captured();
    const result = await runJobProcess(INGEST_CRAWLER, async logger => {
      expect(logger).toBe(c.logger);
      legacy.info('[CRAWLER] pass starting', { mode: 'recent' });
      console.warn('[FAILURE LEDGER] a stray console line');
      return { enqueued: 3, errors: 1 };
    }, r => ({ enqueued: r.enqueued, errors: r.errors }), { logger: c.logger, env: {} });
    expect(result).toEqual({ enqueued: 3, errors: 1 });
    const lines = c.lines();
    expect(lines.map(l => l.event)).toEqual(['job.start', 'app.log', 'app.console', 'job.end']);
    expect(lines[3]).toMatchObject({ code: 'ok', job: 'ingest-crawler', service: 'ingest-crawler', enqueued: 3, errors: 1 });
    expect(typeof lines[3]?.duration_ms).toBe('number');
    expect('enqueued' in (lines[0] ?? {})).toBe(false);
    const runId = String(lines[0]?.trace_id);
    expect(HEX32.test(runId)).toBe(true);
    expect(lines.every(l => l.trace_id === runId)).toBe(true);
    // put back: the console, the legacy logger, and the OpenTelemetry globals
    console.warn('after the run');
    legacy.info('[CRAWLER] after the run');
    expect(c.out).toHaveLength(4);
    expect(console.warn).toHaveBeenCalledWith('after the run');
    expect(trace.getTracer('t').startSpan('x').spanContext().traceId).toBe('00000000000000000000000000000000');
  });

  it('a failed run is one start and one end, code=error, the error rethrown unchanged', async () => {
    const c = captured();
    const boom = new Error('CRAWLER_MODE names an unknown phase "bogus"');
    await expect(runJobProcess(INGEST_CRAWLER, async () => { throw boom; }, () => ({ n: 1 }), { logger: c.logger, env: {} })).rejects.toBe(boom);
    const lines = c.lines();
    expect(lines.map(l => [l.event, l.level])).toEqual([['job.start', 'info'], ['job.end', 'error']]);
    expect(lines[1]).toMatchObject({ code: 'error', err: { message: 'CRAWLER_MODE names an unknown phase "bogus"' } });
    expect('n' in (lines[1] ?? {})).toBe(false);
    expect(lines[0]?.trace_id).toBe(lines[1]?.trace_id);
  });

  it('a run whose tracing cannot start says so once and still runs to job.end', async () => {
    expect(trace.setGlobalTracerProvider(new TracerProvider())).toBe(true);
    const c = captured();
    try {
      await runJobProcess(INGEST_INITIATOR, async () => 'done', () => ({}), { logger: c.logger, env: {} });
    } finally {
      trace.disable();
    }
    const lines = c.lines();
    expect(lines.filter(l => l.event === 'tracing.unavailable' && l.level === 'warn')).toHaveLength(1);
    expect(lines.map(l => l.event)).toEqual(['tracing.unavailable', 'job.start', 'job.end']);
  });

  it('builds its own logger from the env when none is given (stdout, the job\'s name)', async () => {
    const written: string[] = [];
    const write = jest.spyOn(process.stdout, 'write').mockImplementation(chunk => { written.push(String(chunk)); return true; });
    try {
      await runJobProcess(GALLERY_CAPTURE, async () => 0, code => ({ exitCode: code }), { env: { OTEL_SERVICE_NAME: 'gallery-capture-probe' } });
    } finally {
      write.mockRestore();
    }
    const lines = written.map(chunk => JSON.parse(chunk) as Line);
    expect(lines.map(l => [l.event, l.service])).toEqual([['job.start', 'gallery-capture-probe'], ['job.end', 'gallery-capture-probe']]);
    expect(lines[1]).toMatchObject({ exit_code: 0 });
  });

  it('a reporter built BEFORE the run sends the run\'s traceparent to the ingest server and writes one rpc.out per call; outside a run, neither', async () => {
    const spine = await fakeSpine();
    try {
      const failures = new FailureReporter({ baseUrl: spine.url, retryDelayMs: 0 });
      const captures = new CaptureReporter({ baseUrl: spine.url, retryDelayMs: 0 });
      const c = captured();
      await runJobProcess(INGEST_CRAWLER, async () => {
        await failures.report({ site: 'shop', kind: 'listing', origin: 'crawler', reasonClass: 'network', target: 'fc:listing/shop?axis=recent&page=1', message: 'x' } as never);
        await captures.report({
          url: 'https://img.shop.example/a.jpg', site: 'shop', itemId: '1', lane: 'asset', storageKey: 'sha256-v1/aa/k', sha256: 'a'.repeat(64), bytesLen: 3, contentType: 'image/jpeg',
        } as never);
      }, () => ({}), { logger: c.logger, env: {} });
      const lines = c.lines();
      const runId = String(lines[0]?.trace_id);
      const outs = lines.filter(l => l.event === 'rpc.out');
      expect(spine.calls.map(call => call.path)).toEqual(['/ingest.v1.SpineIngest/ReportFetchFailure', '/ingest.v1.SpineIngest/ReportCapture']);
      for (const call of spine.calls) expect(String(call.headers.traceparent)).toMatch(new RegExp(`^00-${runId}-[0-9a-f]{16}-01$`));
      expect(outs.map(l => l.call)).toEqual(spine.calls.map(call => call.path.slice(1)));
      expect(outs.every(l => l.code === 'ok' && l.trace_id === runId && String(l.peer).startsWith('localhost:'))).toBe(true);

      // outside a run: no interceptor, no header, no line
      const before = spine.calls.length;
      await failures.report({ site: 'shop', kind: 'listing', origin: 'crawler', reasonClass: 'network', target: 'fc:listing/shop?axis=recent&page=2', message: 'y' } as never);
      expect(spine.calls.length).toBe(before + 1);
      expect(spine.calls[before]?.headers.traceparent).toBeUndefined();
      expect(c.out.length).toBe(lines.length);
    } finally {
      await spine.close();
    }
  });

  it('a reporter with no base URL still swallows its failure inside a run: the run goes on, the drop is one bridged warn line', async () => {
    const failures = new FailureReporter({ retryDelayMs: 0 });
    const captures = new CaptureReporter({ retryDelayMs: 0 });
    const c = captured();
    await runJobProcess(INGEST_CRAWLER, async () => {
      await failures.report({ site: 'shop', kind: 'listing', origin: 'crawler', reasonClass: 'network', target: 'fc:listing/shop?axis=recent&page=3', message: 'z' } as never);
      await captures.report({
        url: 'https://img.shop.example/b.jpg', site: 'shop', itemId: '2', lane: 'asset', storageKey: 'sha256-v1/bb/k', sha256: 'b'.repeat(64), bytesLen: 3,
      } as never);
    }, () => ({}), { logger: c.logger, env: {} });
    const lines = c.lines();
    expect(lines[lines.length - 1]).toMatchObject({ event: 'job.end', code: 'ok' });
    expect(lines.filter(l => l.event === 'app.console' && l.level === 'warn').map(l => l.tag)).toEqual(['FAILURE LEDGER', 'CAPTURE LEDGER']);
  });
});
