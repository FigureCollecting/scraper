/**
 * LG-QUEUE-2: the ledger calls to the spine ingest server (ReportCapture, ReportFetchFailure) carry the active item's
 * trace, as the Ingest call does.
 *
 * Nothing else puts it there in the service: connect-node imports node:http as a namespace, which the http
 * auto-instrumentation never patches in this ESM service (measured, LG-QUEUE-1), and the server installs no client
 * interceptor into the outbound hook (a batch job does: its rpc.out CLIENT span must stay the parent the spine sees).
 * The trace goes through the propagation allowlist, so a spine at a host off the allowlist gets none.
 *
 * Real pieces: fc-shared tracing (AsyncLocalStorage context, the W3C propagator behind the allowlist, whose defaults
 * include localhost but not 127.0.0.1), the real reporters over Connect/HTTP/1.1, and an in-process SpineIngest server
 * that keeps the traceparent each call arrives with. Nothing leaves this machine.
 */
import * as http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { SpanKind, context, trace } from '@opentelemetry/api';
import type { ConnectRouter, HandlerContext } from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import { create } from '@bufbuild/protobuf';
import {
  CaptureAckSchema,
  FetchFailureAckSchema,
  SpineIngest,
  type CaptureBatch,
  type FetchFailure,
} from '@figurecollecting/ingest-contract';
import { startTracing, type Tracing } from '@figurecollecting/fc-shared/server/tracing';
import { createLogger } from '@figurecollecting/fc-shared/server/log';
import { rpcClientInterceptor } from '@figurecollecting/fc-shared/server/connect';
import { CaptureReporter, resetCaptureReportStats, type StoredCaptureReport } from '../../services/captureReporter';
import { FailureReporter, resetFetchFailureReportStats, type FetchFailureReport } from '../../services/failureReporter';
import { installOutboundRpcInterceptors } from '../../services/outboundRpc';
import { buildRawCapture } from '../../services/captureSink';
import { ObjectStoreCaptureSink, type ObjectStore } from '../../services/objectStoreCaptureSink';
import { keepingExporter } from '../helpers/jobTelemetry';

interface SpineCall {
  method: 'ReportCapture' | 'ReportFetchFailure';
  itemId: string;
  traceparent: string | null;
}
interface Spine {
  port: number;
  calls: SpineCall[];
  close: () => Promise<void>;
}

/** A SpineIngest server on every local interface (localhost AND 127.0.0.1 reach it) that keeps each call's traceparent. */
async function startSpine(): Promise<Spine> {
  const calls: SpineCall[] = [];
  const routes = (router: ConnectRouter): void => {
    router.service(SpineIngest, {
      reportCapture: (req: CaptureBatch, ctx: HandlerContext) => {
        calls.push({ method: 'ReportCapture', itemId: req.captures[0]?.source?.itemId ?? '', traceparent: ctx.requestHeader.get('traceparent') });
        return create(CaptureAckSchema, {});
      },
      reportFetchFailure: (req: FetchFailure, ctx: HandlerContext) => {
        calls.push({ method: 'ReportFetchFailure', itemId: req.source?.itemId ?? '', traceparent: ctx.requestHeader.get('traceparent') });
        return create(FetchFailureAckSchema, {});
      },
    });
  };
  const server = http.createServer(connectNodeAdapter({ routes }));
  const sockets = new Set<Socket>();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>(resolve => server.listen(0, resolve));
  return {
    port: (server.address() as AddressInfo).port,
    calls,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

const SHA = 'ab'.repeat(32);
const captureReport = (itemId: string): StoredCaptureReport => ({
  site: 'shop.example.test',
  itemId,
  url: `https://cdn.example.test/img/${itemId}.png`,
  lane: 'asset',
  sha256: SHA,
  bytesLen: 12,
  storageKey: `raw-img/sha256/ab/${SHA}.png`,
  fetchedAt: '2026-10-28T00:00:00.000Z',
  alreadyStored: false,
});
const failureReport = (itemId: string): FetchFailureReport => ({
  site: 'shop.example.test',
  itemId,
  target: `https://shop.example.test/item/${itemId}`,
  kind: 'record',
  origin: 'ingest',
  reasonClass: 'timeout',
});

/** The two ledger calls, each through its real reporter and transport, to the spine at `base`. */
const LEDGER: Array<[SpineCall['method'], (base: string, itemId: string) => Promise<void>]> = [
  ['ReportCapture', (base, itemId) => new CaptureReporter({ baseUrl: base, retryDelayMs: 0 }).report(captureReport(itemId))],
  ['ReportFetchFailure', (base, itemId) => new FailureReporter({ baseUrl: base, retryDelayMs: 0 }).report(failureReport(itemId))],
];

/** Run fn inside a new active span (an item's processing); returns the span's trace and span ids with fn's promise. */
async function inItem(fn: () => Promise<void>): Promise<{ traceId: string; spanId: string }> {
  return trace.getTracer('test').startActiveSpan('item', async span => {
    try {
      await fn();
      return { traceId: span.spanContext().traceId, spanId: span.spanContext().spanId };
    } finally {
      span.end();
    }
  });
}

const exporter = keepingExporter();
let tracing: Tracing;
let spine: Spine;

beforeAll(() => {
  tracing = startTracing('scraper-ledger-trace-test', { env: {}, exporter });
});

afterAll(async () => {
  await tracing.shutdown();
});

beforeEach(async () => {
  resetCaptureReportStats();
  resetFetchFailureReportStats();
  spine = await startSpine();
});

afterEach(async () => {
  await spine.close();
});

const callFor = (method: SpineCall['method'], itemId: string): SpineCall => {
  const found = spine.calls.filter(c => c.method === method && c.itemId === itemId);
  expect(found).toHaveLength(1);
  return found[0];
};

describe("ledger calls to the spine carry the item's trace (LG-QUEUE-2)", () => {
  it.each(LEDGER)("%s to an in-cluster spine carries the active item's traceparent", async (method, send) => {
    const item = await inItem(() => send(`http://localhost:${spine.port}`, 'in-cluster'));

    expect(callFor(method, 'in-cluster').traceparent).toBe(`00-${item.traceId}-${item.spanId}-01`);
  });

  it.each(LEDGER)('%s to a spine off the propagation allowlist carries no traceparent', async (method, send) => {
    await inItem(() => send(`http://127.0.0.1:${spine.port}`, 'off-list'));

    expect(callFor(method, 'off-list').traceparent).toBeNull();
  });

  it.each(LEDGER)('%s made in no trace carries no traceparent', async (method, send) => {
    await send(`http://localhost:${spine.port}`, 'no-trace');

    expect(callFor(method, 'no-trace').traceparent).toBeNull();
  });

  it.each(LEDGER)("%s in a batch job carries its rpc.out CLIENT span, a child of the item's, not the item's own", async (method, send) => {
    const restore = installOutboundRpcInterceptors([rpcClientInterceptor({ logger: createLogger({ service: 'scraper-ledger-trace-test', env: {}, sink: () => undefined }) })]);
    try {
      const item = await inItem(() => send(`http://localhost:${spine.port}`, 'in-job'));
      await tracing.forceFlush();

      const client = exporter.spans.find(s => s.kind === SpanKind.CLIENT && s.name === `ingest.v1.SpineIngest/${method}` && s.spanContext().traceId === item.traceId);
      expect(client?.parentSpanContext?.spanId).toBe(item.spanId);
      expect(callFor(method, 'in-job').traceparent).toBe(`00-${item.traceId}-${client!.spanContext().spanId}-01`);
    } finally {
      restore();
    }
  });

  it("the raw store's ReportCapture for each image carries that image's item's trace, whichever worker stored it", async () => {
    // The sink (LG-QUEUE-2) and the reporter together, as the server wires them: five images, two workers.
    const store: ObjectStore = {
      exists: async () => false,
      put: async () => new Promise(resolve => setTimeout(resolve, 10)),
    };
    const reporter = new CaptureReporter({ baseUrl: `http://localhost:${spine.port}`, retryDelayMs: 0 });
    const sink = new ObjectStoreCaptureSink(
      store,
      { endpoint: 'https://objects.example.test', region: 'test-1', bucket: 'raw', prefix: 'raw-html/', imagePrefix: 'raw-img/', keyScheme: 'sha256-v1', concurrency: 2 },
      report => reporter.report(report),
    );
    const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x49, 0x48, 0x44, 0x52]);
    const want = new Map<string, string>();
    for (const itemId of ['i1', 'i2', 'i3', 'i4', 'i5']) {
      const capture = buildRawCapture({
        url: `https://cdn.example.test/img/${itemId}.png`, lane: 'asset', bytes: Buffer.concat([PNG, Buffer.from(itemId)]), statusCode: 200,
        contentType: 'image/png', fetchedAt: '2026-10-28T00:00:00.000Z', sourceItem: { site: 'shop.example.test', itemId },
      });
      const span = trace.getTracer('test').startSpan(`item ${itemId}`);
      await context.with(trace.setSpan(context.active(), span), () => sink.capture(capture));
      span.end();
      want.set(itemId, span.spanContext().traceId);
    }
    await sink.flush();
    for (let i = 0; spine.calls.length < 5 && i < 200; i++) await new Promise(resolve => setTimeout(resolve, 10));

    const traceOf = (itemId: string): string | undefined => /^00-([0-9a-f]{32})-/.exec(callFor('ReportCapture', itemId).traceparent ?? '')?.[1];
    expect(Object.fromEntries([...want.keys()].map(itemId => [itemId, traceOf(itemId)]))).toEqual(Object.fromEntries(want));
  });
});
