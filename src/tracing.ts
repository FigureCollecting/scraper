/**
 * OpenTelemetry tracing bootstrap for the scraper service.
 *
 * MUST be imported before any instrumented module (express, http) so
 * auto-instrumentation can patch them — `src/index.ts` imports this on its first
 * line.
 *
 * Behaviour splits into two independent gates:
 *   - RUN THE SDK (create spans, patch http/express, expose the traceId to logs):
 *     ON by default everywhere EXCEPT test. Disabled under test (NODE_ENV=test)
 *     so auto-instrumentation never adds global state/flakiness to the suite.
 *     Kill switch: OTEL_TRACES_ENABLED=false.
 *   - EXPORT spans off-box: only when OTEL_EXPORTER_OTLP_ENDPOINT is set. With no
 *     endpoint, spans are still created (so the traceId flows into every log
 *     line) but nothing is shipped — no collector required, no connection errors,
 *     no telemetry leaving the host until a secured collector exists.
 *
 * This lets a backend→scraper request carry one trace: the backend's HTTP call
 * propagates W3C traceparent, scraper's auto-instrumentation continues the trace,
 * and getTraceContext() threads that same traceId into scraper's logs.
 *
 * "Instrument now, ship dark, flip on a collector later": the day a Tempo/OTLP
 * endpoint exists, set the env var and full traces flow with no code change.
 */
import dotenv from 'dotenv';
dotenv.config();

import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { SimpleSpanProcessor, SpanExporter, ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { ExportResult, ExportResultCode } from '@opentelemetry/core';

/**
 * A SpanExporter that ships nothing. Paired with a real SimpleSpanProcessor it
 * keeps the TracerProvider RECORDING — so spans have real trace IDs that flow
 * into logs — while exporting zero telemetry off-box. This is the correct
 * "instrument without shipping" primitive when no collector is configured.
 * (OTEL_TRACES_EXPORTER=none, by contrast, disables tracing entirely, leaving
 * an all-zero/no-op span context and NO trace IDs in logs.)
 */
class NoopSpanExporter implements SpanExporter {
  export(_spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    resultCallback({ code: ExportResultCode.SUCCESS });
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Pure decision: should the tracing SDK start for this environment?
 * Exported so the gate logic can be tested without side effects.
 */
export function shouldEnableTracing(env: NodeJS.ProcessEnv = process.env): boolean {
  // Never under tests — auto-instrumentation adds global state/flakiness, and
  // tracing behaviour is covered deterministically by its own unit tests.
  if (env.NODE_ENV === 'test') return false;
  // Kill switch: OTEL_TRACES_ENABLED=false force-disables anywhere (e.g. to
  // isolate a suspected instrumentation regression in prod). Any other value
  // (set or unset) leaves tracing enabled.
  if (env.OTEL_TRACES_ENABLED === 'false') return false;
  // On by default everywhere else — PRODUCTION INCLUDED — so logs get traceId
  // correlation immediately. EXPORT is gated separately in startTracing() (only
  // when OTEL_EXPORTER_OTLP_ENDPOINT is set), so no telemetry leaves the host
  // until a secured collector exists.
  return true;
}

let sdk: NodeSDK | undefined;

/**
 * Start the tracing SDK if the environment calls for it. Idempotent.
 * Returns the SDK instance (or undefined when tracing is disabled).
 */
export function startTracing(env: NodeJS.ProcessEnv = process.env): NodeSDK | undefined {
  if (sdk || !shouldEnableTracing(env)) return sdk;

  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT;

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: env.OTEL_SERVICE_NAME || 'scraper',
      [ATTR_SERVICE_VERSION]: process.env.npm_package_version || 'dev',
    }),
    // With a collector endpoint -> export via OTLP (OTLPTraceExporter reads the
    // endpoint from the env). Without one -> keep the provider RECORDING (real
    // trace IDs for log correlation) but drop spans through a no-op exporter, so
    // nothing leaves the host and there are no connection errors.
    ...(endpoint
      ? { traceExporter: new OTLPTraceExporter() }
      : { spanProcessors: [new SimpleSpanProcessor(new NoopSpanExporter())] }),
    instrumentations: [getNodeAutoInstrumentations()],
  });

  sdk.start();
  // eslint-disable-next-line no-console
  console.log(`[TRACING] OpenTelemetry started for scraper (export: ${endpoint || 'off — recording for log correlation only'})`);

  const shutdown = (): void => {
    const current = sdk;
    if (!current) return;
    sdk = undefined;
    current.shutdown().catch(() => undefined);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  return sdk;
}

// Auto-start on import — this module exists to be imported first for its side effect.
startTracing();
