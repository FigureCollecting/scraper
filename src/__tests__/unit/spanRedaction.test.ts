import { RedactingSpanExporter } from '../../tracing';
import { ExportResultCode } from '@opentelemetry/core';
import type { ExportResult } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';

/**
 * Proves RedactingSpanExporter scrubs secret/PII span attributes (via fc-shared's
 * redactAttributes) before the wrapped exporter ever sees them — so even with a
 * collector attached, an 'authorization' header stamped onto a span never leaves
 * the host. Non-sensitive attributes pass through untouched, and lifecycle calls
 * delegate.
 */
describe('RedactingSpanExporter', () => {
  function makeSpan(attributes: Record<string, unknown>): ReadableSpan {
    return { attributes } as unknown as ReadableSpan;
  }

  it('scrubs sensitive attributes before the delegate receives the span', () => {
    const received: ReadableSpan[] = [];
    const delegate: SpanExporter = {
      export(spans: ReadableSpan[], cb: (r: ExportResult) => void): void {
        received.push(...spans);
        cb({ code: ExportResultCode.SUCCESS });
      },
      shutdown: () => Promise.resolve(),
    };

    const exporter = new RedactingSpanExporter(delegate);
    const span = makeSpan({ authorization: 'Bearer abcdefghij', 'http.method': 'GET' });

    const cb = jest.fn();
    exporter.export([span], cb);

    expect(cb).toHaveBeenCalledWith({ code: ExportResultCode.SUCCESS });
    expect(received).toHaveLength(1);
    const attrs = received[0].attributes as Record<string, unknown>;
    expect(attrs.authorization).toBe('[REDACTED]');
    // Non-sensitive attribute survives the scrub.
    expect(attrs['http.method']).toBe('GET');
  });

  it('delegates shutdown and forceFlush to the wrapped exporter', async () => {
    const shutdown = jest.fn().mockResolvedValue(undefined);
    const forceFlush = jest.fn().mockResolvedValue(undefined);
    const delegate = {
      export: jest.fn(),
      shutdown,
      forceFlush,
    } as unknown as SpanExporter;

    const exporter = new RedactingSpanExporter(delegate);

    await exporter.shutdown();
    await exporter.forceFlush();

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(forceFlush).toHaveBeenCalledTimes(1);
  });
});
