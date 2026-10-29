/**
 * LG-QUEUE-2: the raw capture sink stores, and reports, each capture under the trace it was captured in.
 *
 * capture() only queues; a worker does the HEAD, the PUT and the asset's ReportCapture later. A worker keeps taking
 * captures until the queues are empty, so before this every capture after the first ran in the trace of the capture
 * that STARTED its worker (measured: with four workers, capture 5 ran under capture 1's trace, 6 under 2's, and so on).
 * The sink keeps each capture's traceparent with it and runs the capture under that, as the scrape queue does its items.
 *
 * Real pieces: fc-shared tracing (AsyncLocalStorage context), real spans, real timers. The object store is a local fake
 * that notes the trace active when it is called; nothing leaves the process.
 */
import { context, trace } from '@opentelemetry/api';
import { startTracing, type Tracing } from '@figurecollecting/fc-shared/server/tracing';
import { buildRawCapture, type RawCapture } from '../../services/captureSink';
import type { StoredCaptureReport } from '../../services/captureReporter';
import { ObjectStoreCaptureSink, type ObjectStore, type RawStoreConfig } from '../../services/objectStoreCaptureSink';
import { keepingExporter } from '../helpers/jobTelemetry';

const activeTraceId = (): string | undefined => trace.getSpanContext(context.active())?.traceId;
const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** A store that notes, per key, the trace active at its HEAD and at its PUT. Slow enough that captures pile up. */
class TraceNotingStore implements ObjectStore {
  readonly heads = new Map<string, string | undefined>();
  readonly puts = new Map<string, string | undefined>();

  async exists(key: string): Promise<boolean> {
    this.heads.set(key, activeTraceId());
    await delay(5);
    return false;
  }

  async put(key: string): Promise<void> {
    this.puts.set(key, activeTraceId());
    await delay(20);
  }
}

const CONFIG: RawStoreConfig = {
  endpoint: 'https://objects.example.test',
  region: 'test-1',
  bucket: 'raw',
  prefix: 'raw-html/',
  imagePrefix: 'raw-img/',
  keyScheme: 'sha256-v1',
  putTimeoutMs: 5_000,
  imagePutTimeoutMs: 5_000,
};

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('IHDR')]);

const page = (i: number): RawCapture =>
  buildRawCapture({ url: `https://shop.example.test/item/${i}`, lane: 'wire', bytes: Buffer.from(`<html>item ${i}</html>`), statusCode: 200 });

const image = (itemId: string, bytes: Buffer = PNG): RawCapture =>
  buildRawCapture({
    url: `https://cdn.example.test/img/${itemId}.png`,
    lane: 'asset',
    bytes,
    statusCode: 200,
    contentType: 'image/png',
    fetchedAt: '2026-10-28T00:00:00.000Z',
    sourceItem: { site: 'shop.example.test', itemId },
  });

const pageKey = (c: RawCapture): string => `raw-html/sha256/${c.sha256.slice(0, 2)}/${c.sha256}.html.gz`;

/** `item N` for the Nth of `traces`, `no trace` for none. */
const nameOf = (traces: string[], traceId: string | undefined): string =>
  traceId === undefined ? 'no trace' : traces.includes(traceId) ? `item ${traces.indexOf(traceId) + 1}` : `an unknown trace ${traceId}`;

/** Run fn inside a new active span (an item's processing, say); returns the span's trace id and fn's result. */
function inTrace<T>(name: string, fn: () => T): { traceId: string; result: T } {
  return trace.getTracer('test').startActiveSpan(name, span => {
    try {
      return { traceId: span.spanContext().traceId, result: fn() };
    } finally {
      span.end();
    }
  });
}

let tracing: Tracing;

beforeAll(() => {
  tracing = startTracing('scraper-sink-trace-test', { env: {}, exporter: keepingExporter() });
});

afterAll(async () => {
  await tracing.shutdown();
});

describe('ObjectStoreCaptureSink: each capture runs in its own trace (LG-QUEUE-2)', () => {
  it('stores every capture under the trace it was captured in, however many captures one worker goes on to take', async () => {
    const store = new TraceNotingStore();
    const sink = new ObjectStoreCaptureSink(store, CONFIG); // four workers: captures 5 to 8 wait for one
    const want = new Map<string, string>();
    for (let i = 1; i <= 8; i++) {
      const c = page(i);
      const { traceId } = inTrace(`item ${i}`, () => void sink.capture(c));
      want.set(pageKey(c), traceId);
    }
    await sink.flush();

    const traces = [...want.values()];
    expect(new Set(traces).size).toBe(8);
    expect(store.puts.size).toBe(8);
    // Named by item, so a failure reads as "item 5's PUT ran in item 1's trace".
    const ranIn = [...want.keys()].map((key, i) => ({ item: i + 1, head: nameOf(traces, store.heads.get(key)), put: nameOf(traces, store.puts.get(key)) }));
    expect(ranIn).toEqual(traces.map((_, i) => ({ item: i + 1, head: `item ${i + 1}`, put: `item ${i + 1}` })));
  });

  it('stores a capture made in no trace in no trace, never in the trace of the worker that takes it', async () => {
    const store = new TraceNotingStore();
    const sink = new ObjectStoreCaptureSink(store, { ...CONFIG, concurrency: 1 });
    const first = page(1);
    const later = [page(2), page(3)];
    const { traceId } = inTrace('item 1', () => void sink.capture(first)); // starts the only worker, in its trace
    for (const c of later) void sink.capture(c); // queued behind it, outside any trace
    await sink.flush();

    expect([first, ...later].map(c => nameOf([traceId], store.puts.get(pageKey(c))))).toEqual(['item 1', 'no trace', 'no trace']);
  });

  it("reports each stored image under its own item's trace, the in-flight dedup loser's report included", async () => {
    const store = new TraceNotingStore();
    const reported: Array<{ itemId: string | undefined; traceId: string | undefined }> = [];
    const sink = new ObjectStoreCaptureSink(store, { ...CONFIG, concurrency: 2 }, async (r: StoredCaptureReport) => {
      reported.push({ itemId: r.itemId, traceId: activeTraceId() });
    });
    // Two items share one image (the second loses the in-flight race and reports against the winner's object), and
    // three more each have their own: five captures on two workers.
    const shared = Buffer.concat([PNG, Buffer.from('shared')]);
    const captures: Array<[string, Buffer]> = [
      ['winner', shared],
      ['loser', shared],
      ['a', Buffer.concat([PNG, Buffer.from('a')])],
      ['b', Buffer.concat([PNG, Buffer.from('b')])],
      ['c', Buffer.concat([PNG, Buffer.from('c')])],
    ];
    const want = new Map<string, string>();
    for (const [itemId, bytes] of captures) {
      want.set(itemId, inTrace(`item ${itemId}`, () => void sink.capture(image(itemId, bytes))).traceId);
    }
    await sink.flush();
    await delay(0); // the reports are fire-and-forget off the worker

    expect(sink.stats().assetDeduped).toBe(1);
    const traces = [...want.values()];
    const items = [...want.keys()];
    const ranIn = (traceId: string | undefined): string => {
      const name = nameOf(traces, traceId);
      return name.startsWith('item ') ? `${items[Number(name.slice(5)) - 1]}'s trace` : name;
    };
    expect(reported).toHaveLength(5);
    expect(Object.fromEntries(reported.map(r => [r.itemId, ranIn(r.traceId)]))).toEqual(
      Object.fromEntries(items.map(itemId => [itemId, `${itemId}'s trace`])),
    );
  });
});
