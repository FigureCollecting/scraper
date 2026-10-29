/**
 * One trace per queued ITEM (LG-QUEUE-1).
 *
 * The crawler and the initiator make each item its own trace and POST it to /ingest/scrape with that traceparent.
 * The queue keeps the trace with the item, in memory and in its durable row, and processes the item under it
 * (withTraceparent), so the item's Ingest call and every line written while it is processed carry it, across
 * retries and restarts. fc-shared's queue pair does the carrying: currentTraceparent stores it, withTraceparent
 * restores it (@figurecollecting/fc-shared/server/job, 1.9.0). The run the item was enqueued in goes with it
 * (LG-RUNID): currentRunId stores it, withTraceparent's runId restores it, so the item's lines keep their run_id.
 *
 * Enqueueing opens a PRODUCER span, `scrape.enqueue`, in the active trace and stores ITS traceparent: the
 * enqueuer's trace when there is one, and the root of a NEW trace when there is none. A row written before items
 * carried a trace (or one whose value does not parse) gets a new root when it is loaded. No item ever falls back to
 * whatever context the dispatch loop happens to hold. With tracing off, every traceparent is undefined and the item
 * runs in no trace, as before.
 */
import { ROOT_CONTEXT, SpanKind, context, trace } from '@opentelemetry/api';
import { currentTraceparent, parseTraceparent } from '@figurecollecting/fc-shared/server/job';

export { currentRunId, withTraceparent } from '@figurecollecting/fc-shared/server/job';

export const QUEUE_TRACER_NAME = 'scraper/queue';
export const ENQUEUE_SPAN_NAME = 'scrape.enqueue';

/** The traceparent to store with a new item: a `scrape.enqueue` span in the active trace, or a new root trace. */
export function enqueueTraceparent(): string | undefined {
  const span = trace.getTracer(QUEUE_TRACER_NAME).startSpan(ENQUEUE_SPAN_NAME, { kind: SpanKind.PRODUCER });
  try {
    return context.with(trace.setSpan(context.active(), span), currentTraceparent);
  } finally {
    span.end();
  }
}

/** A stored traceparent when it parses; otherwise the root of a new trace for the item. */
export function restoredTraceparent(stored: string | undefined): string | undefined {
  return parseTraceparent(stored) === undefined ? context.with(ROOT_CONTEXT, enqueueTraceparent) : stored;
}
