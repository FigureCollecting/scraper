import { trace, context, ROOT_CONTEXT } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { logger } from '../../utils/logger';

/**
 * Proves the scraper's DebugLogger threads the ACTIVE span's traceId/spanId into
 * each log line, sourced from fc-shared's getTraceContext. Uses a real
 * AsyncLocalStorage context manager + a real wrapped span context (no mocking of
 * the logger), so this exercises the actual cross-package correlation path that
 * carries a backend->scraper request's traceId into scraper logs.
 */
describe('logger trace correlation', () => {
  const contextManager = new AsyncLocalStorageContextManager();

  beforeAll(() => {
    contextManager.enable();
    context.setGlobalContextManager(contextManager);
  });

  afterAll(() => {
    context.disable();
    contextManager.disable();
  });

  let errSpy: jest.SpyInstance;
  beforeEach(() => {
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    errSpy.mockRestore();
  });

  const TRACE_ID = 'abcdef12345678901234567890abcdef';
  const SPAN_ID = 'fedcba0987654321';

  it('threads trace and span ids into the log line when a span is active', () => {
    const span = trace.wrapSpanContext({ traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: 1 });

    context.with(trace.setSpan(ROOT_CONTEXT, span), () => {
      logger.error('boom');
    });

    expect(errSpy).toHaveBeenCalledTimes(1);
    // The scraper logger embeds the trace tag inside the formatted prefix string.
    expect(errSpy.mock.calls[0][0]).toContain(`trace=${TRACE_ID} span=${SPAN_ID}`);
  });

  it('leaves the log shape unchanged when no span is active', () => {
    logger.error('boom');

    expect(errSpy.mock.calls[0][0]).not.toContain('trace=');
  });
});
