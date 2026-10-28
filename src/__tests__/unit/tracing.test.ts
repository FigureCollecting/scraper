import { ROOT_CONTEXT, SpanKind, propagation, trace, type Context, type SpanContext } from '@opentelemetry/api';
import { withPropagationTarget } from '@figurecollecting/fc-shared/server/tracing';
import { outboundPropagator, propagationHosts, shouldEnableTracing } from '../../tracing';

/**
 * Importing src/tracing runs its module side effect (startTracing), which is a
 * no-op here because jest sets NODE_ENV=test — so these tests exercise only the
 * pure gate decision, with no SDK started.
 */
describe('shouldEnableTracing', () => {
  it('is disabled under the test environment', () => {
    expect(shouldEnableTracing({ NODE_ENV: 'test' })).toBe(false);
  });

  it('never traces the suite even if explicitly enabled', () => {
    expect(shouldEnableTracing({ NODE_ENV: 'test', OTEL_TRACES_ENABLED: 'true' })).toBe(false);
  });

  it('treats OTEL_TRACES_ENABLED=false as a kill switch anywhere', () => {
    expect(shouldEnableTracing({ OTEL_TRACES_ENABLED: 'false', NODE_ENV: 'development' })).toBe(false);
    expect(shouldEnableTracing({ OTEL_TRACES_ENABLED: 'false', NODE_ENV: 'production' })).toBe(false);
    expect(shouldEnableTracing({ OTEL_TRACES_ENABLED: 'false' })).toBe(false);
  });

  it('defaults on everywhere outside test — production included', () => {
    expect(shouldEnableTracing({ NODE_ENV: 'development' })).toBe(true);
    expect(shouldEnableTracing({})).toBe(true);
    expect(shouldEnableTracing({ NODE_ENV: 'production' })).toBe(true);
    expect(shouldEnableTracing({ NODE_ENV: 'production', OTEL_TRACES_ENABLED: 'true' })).toBe(true);
  });
});

/**
 * LG-QUEUE-1 part B: the service's propagator. Without it the http and undici auto-instrumentation put
 * traceparent, tracestate and baggage on EVERY outgoing request: store pages, image hosts, the object store.
 * fc-shared's allowlist decides instead (the jobs' rule), plus the spine this service calls (INGEST_BASE_URL).
 */
describe('propagationHosts', () => {
  const DEFAULTS = ['*.svc.cluster.local', '*.svc', 'localhost'];

  it("is fc-shared's default list when nothing is configured", () => {
    expect(propagationHosts({})).toEqual(DEFAULTS);
  });

  it('adds the spine ingest server (INGEST_BASE_URL) and ignores a blank one', () => {
    expect(propagationHosts({ INGEST_BASE_URL: 'http://spine.internal:50051' })).toEqual([...DEFAULTS, 'http://spine.internal:50051']);
    expect(propagationHosts({ INGEST_BASE_URL: '  ' })).toEqual(DEFAULTS);
  });

  it('reads the process environment by default', () => {
    expect(propagationHosts()).toEqual(propagationHosts(process.env));
    expect(outboundPropagator().fields()).toEqual(outboundPropagator(process.env).fields());
  });

  it('takes OTEL_PROPAGATION_ALLOWLIST as the list when it is set', () => {
    expect(propagationHosts({ OTEL_PROPAGATION_ALLOWLIST: 'a.example, *.mesh', INGEST_BASE_URL: 'http://x:1' })).toEqual(['a.example', '*.mesh', 'http://x:1']);
  });
});

describe('outboundPropagator', () => {
  const sc: SpanContext = { traceId: '4bf92f3577b34da6a3ce929d0e0e4736', spanId: '00f067aa0ba902b7', traceFlags: 1, isRemote: true };
  const env = { INGEST_BASE_URL: 'http://spine.internal:50051' };
  const active = propagation.setBaggage(trace.setSpanContext(ROOT_CONTEXT, sc), propagation.createBaggage({ k: { value: 'v' } }));
  const injected = (ctx: Context): Record<string, string> => {
    const carrier: Record<string, string> = {};
    outboundPropagator(env).inject(ctx, carrier, { set: (c, k, v) => { c[k] = v; } });
    return carrier;
  };
  /** The CLIENT span an http/undici instrumentation opens before it injects, naming its target. */
  const clientSpanTo = (attributes: Record<string, string>): Context =>
    trace.setSpan(active, Object.assign(trace.wrapSpanContext(sc), { kind: SpanKind.CLIENT, attributes }));

  it.each([
    ['a store page', 'https://www.amiami.com/eng/detail/?gcode=FIGURE-1'],
    ['an image CDN', 'https://img.amiami.com/images/product/main/1.jpg'],
    ['the object store', 'https://fsn1.your-objectstorage.com/bucket/key'],
    ['a loopback IP', 'http://127.0.0.1:3050/'],
  ])('injects nothing for %s', (_what, target) => {
    expect(injected(withPropagationTarget(active, target))).toEqual({});
    expect(injected(clientSpanTo({ 'url.full': target }))).toEqual({});
  });

  it.each([
    ['an in-cluster service', 'http://scraper.fc.svc.cluster.local:3050/ingest/scrape'],
    ['the configured spine', 'http://spine.internal:50051/ingest.v1.SpineIngest/Ingest'],
  ])('injects traceparent and baggage for %s', (_what, target) => {
    for (const ctx of [withPropagationTarget(active, target), clientSpanTo({ 'server.address': new URL(target).hostname })]) {
      expect(injected(ctx)).toEqual({ traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01', baggage: 'k=v' });
    }
  });

  it('injects nothing when it cannot tell where the request goes', () => {
    expect(injected(active)).toEqual({});
  });

  it("still extracts an inbound caller's trace, whoever the caller is", () => {
    const ctx = outboundPropagator({}).extract(ROOT_CONTEXT, { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' }, {
      get: (c: Record<string, string>, k) => c[k],
      keys: c => Object.keys(c),
    });
    expect(trace.getSpanContext(ctx)?.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(outboundPropagator({}).fields()).toEqual(expect.arrayContaining(['traceparent', 'tracestate', 'baggage']));
  });
});
