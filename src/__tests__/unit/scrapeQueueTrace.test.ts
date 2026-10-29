/**
 * LG-QUEUE-1: one trace per queued ITEM, carried from the enqueue to the item's Ingest call.
 *
 * The crawler and the initiator POST each item to /ingest/scrape with the item's traceparent; the queue must process
 * that item, retries and restarts included, under that trace, so the spine's Ingest call (and every line written
 * while the item is processed) carries it. An item enqueued with no trace gets a NEW root trace of its own, and the
 * dispatch loop's own context never leaks into an item.
 *
 * Real pieces: fc-shared tracing (AsyncLocalStorage context, the W3C propagator behind the allowlist), the real
 * IngestEmitter over Connect/HTTP/1.1, and an in-process SpineIngest server on localhost that reads the traceparent
 * the call arrives with. Real timers: the leak this guards against travels through setTimeout.
 */
jest.mock('../../services/genericScraper', () => ({
  BrowserPool: {
    getStealthBrowser: jest.fn(),
    getBrowser: jest.fn(),
    returnBrowser: jest.fn(),
    getPoolSize: jest.fn().mockReturnValue(2),
    getPoolCapacity: jest.fn().mockReturnValue(3),
    reset: jest.fn(),
  },
}));
jest.mock('../../services/webhookClient', () => ({
  notifyItemSuccess: jest.fn().mockResolvedValue(true),
  notifyItemFailed: jest.fn().mockResolvedValue(true),
  notifyItemSkipped: jest.fn().mockResolvedValue(true),
}));

import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { context, trace } from '@opentelemetry/api';
import { Code, ConnectError, type ConnectRouter, type HandlerContext } from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import { create } from '@bufbuild/protobuf';
import { SpineIngest, WriteStatsSchema, type ExtractedData as WireExtractedData } from '@figurecollecting/ingest-contract';
import type { ExtractionRuleset } from '@figurecollecting/scraper-plugin-contract';
import { startTracing, type Tracing } from '@figurecollecting/fc-shared/server/tracing';
import { ScrapeQueue, resetScrapeQueue } from '../../services/scrapeQueue';
import { createExtractionRegistry, type ExtractionRegistryImpl } from '../../services/extractionRegistry';
import { IngestEmitter } from '../../services/ingestEmitter';
import { QUEUE_DB_FILE, openQueueStore } from '../../services/queueStore';
import { keepingExporter, traceIdOf } from '../helpers/jobTelemetry';

const HOSTS = ['shop-a.example.test', 'shop-b.example.test', 'shop-c.example.test', 'shop-d.example.test'];
const url = (host: string, id: string): string => `https://${host}/item/${id}`;

// ---------------------------------------------------------------------------------------------
// The spine: a real SpineIngest server on localhost (an allowlisted host) that keeps, per call,
// the item it was sent and the traceparent the call carried.
// ---------------------------------------------------------------------------------------------
interface SpineCall {
  itemId: string;
  traceparent: string | null;
}
interface Spine {
  url: string;
  calls: SpineCall[];
  close: () => Promise<void>;
}

async function startSpine(fail: (call: SpineCall, n: number) => boolean = () => false): Promise<Spine> {
  const calls: SpineCall[] = [];
  const routes = (router: ConnectRouter): void => {
    router.service(SpineIngest, {
      ingest: (req: WireExtractedData, ctx: HandlerContext) => {
        const call = { itemId: req.source?.itemId ?? '', traceparent: ctx.requestHeader.get('traceparent') };
        calls.push(call);
        if (fail(call, calls.length)) throw new ConnectError('spine down', Code.Unavailable);
        return create(WriteStatsSchema, { sourceId: 'src-1', claims: { emitted: 1, inserted: 1 } });
      },
    });
  };
  const server = http.createServer(connectNodeAdapter({ routes }));
  const sockets = new Set<Socket>();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>(resolve => server.listen(0, 'localhost', resolve));
  return {
    url: `http://localhost:${(server.address() as AddressInfo).port}`,
    calls,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

// ---------------------------------------------------------------------------------------------
// A store ruleset for HOSTS that notes the trace active while each item is extracted (plugin code
// running inside the item's processing, as any log line it writes would be).
// ---------------------------------------------------------------------------------------------
const seenWhileProcessing = new Map<string, string | undefined>();

function makeRegistry(): ExtractionRegistryImpl {
  const ruleset: ExtractionRuleset = {
    siteId: 'trace-shop',
    version: '1.0.0',
    extract: (_html: string, pageUrl: string) => {
      const itemId = pageUrl.split('/').pop() ?? '';
      seenWhileProcessing.set(itemId, trace.getSpanContext(context.active())?.traceId);
      return {
        source: { site: 'trace-shop', itemId, url: pageUrl, extractedAt: '2026-10-28T00:00:00Z', rulesetVersion: '1.0.0' },
        fields: { name: itemId },
        warnings: [],
      };
    },
    validate: () => ({ valid: true, errors: [], warnings: [] }),
  };
  const registry = createExtractionRegistry();
  registry.registerSite({
    siteId: 'trace-shop',
    name: 'Trace Shop',
    domains: HOSTS,
    rateLimit: { domain: HOSTS[0], baseDelayMs: 1, minDelayMs: 1, maxDelayMs: 10, backoffMultiplier: 1.5, recoveryDivisor: 1.5, successThreshold: 3 },
    requiresBrowser: false,
    allowedCookies: [],
  });
  registry.registerRuleset(ruleset);
  return registry;
}

// jest.config resets mock implementations before every test: beforeEach gives scrapePage its answer.
const scraping = { scrapePage: jest.fn(), scrapePageStealth: jest.fn() };

function wire(queue: ScrapeQueue, spine: Spine): ScrapeQueue {
  queue.setPluginRegistry(makeRegistry());
  queue.setIngestEmitter(new IngestEmitter({ baseUrl: spine.url, timeoutMs: 5000, retryDelayMs: 1 }));
  queue.setScrapingService(scraping);
  return queue;
}

/** Run fn inside a new active span (an inbound request's SERVER span, say); returns its trace id and fn's result. */
function inTrace<T>(name: string, fn: () => T): { traceId: string; result: T } {
  return trace.getTracer('test').startActiveSpan(name, span => {
    try {
      return { traceId: span.spanContext().traceId, result: fn() };
    } finally {
      span.end();
    }
  });
}

const traceOfCall = (spine: Spine, itemId: string): Array<string | undefined> =>
  spine.calls.filter(c => c.itemId === itemId).map(c => traceIdOf(c.traceparent));

async function until(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

// ---------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------
const exporter = keepingExporter();
let tracing: Tracing;
let spine: Spine;
let queue: ScrapeQueue | undefined;

beforeAll(() => {
  tracing = startTracing('scraper-queue-trace-test', { env: {}, exporter });
});

afterAll(async () => {
  await tracing.shutdown();
});

beforeEach(async () => {
  // Host pacing down to 1 ms, so the loop dispatches back to back.
  process.env.SCRAPER_HOST_HARD_FLOOR_MS = '1';
  process.env.SCRAPER_HOST_BASE_DELAY_MS = '1';
  resetScrapeQueue();
  seenWhileProcessing.clear();
  scraping.scrapePage.mockImplementation(async (pageUrl: string) => ({ html: '<html><body>item</body></html>', url: pageUrl, title: 'Item', statusCode: 200 }));
  spine = await startSpine();
});

afterEach(async () => {
  queue?.stop();
  queue?.clear();
  queue?.closeQueueStore();
  queue = undefined;
  resetScrapeQueue();
  await spine.close();
  delete process.env.SCRAPER_HOST_HARD_FLOOR_MS;
  delete process.env.SCRAPER_HOST_BASE_DELAY_MS;
  jest.restoreAllMocks();
});

describe('ScrapeQueue: one trace per item (LG-QUEUE-1)', () => {
  it("processes an item under its enqueuer's trace: the Ingest call's traceparent and the code run for it both carry it", async () => {
    queue = wire(new ScrapeQueue(false), spine);
    const a = inTrace('POST /ingest/scrape', () => queue!.enqueue(url(HOSTS[0], 'a1'), { url: url(HOSTS[0], 'a1') }));
    await a.result.promise;

    expect(traceOfCall(spine, 'a1')).toEqual([a.traceId]);
    expect(seenWhileProcessing.get('a1')).toBe(a.traceId);
  });

  it('keeps two items enqueued under different traces apart, even when one dispatch-loop run processes both', async () => {
    queue = wire(new ScrapeQueue(false), spine);
    // B is enqueued while A is already on the wire: the loop A's enqueue started goes on to B.
    const a = inTrace('POST a', () => queue!.enqueue(url(HOSTS[0], 'a1'), { url: url(HOSTS[0], 'a1') }));
    const b = inTrace('POST b', () => queue!.enqueue(url(HOSTS[1], 'b1'), { url: url(HOSTS[1], 'b1') }));
    await Promise.all([a.result.promise, b.result.promise]);

    expect(a.traceId).not.toBe(b.traceId);
    expect(traceOfCall(spine, 'a1')).toEqual([a.traceId]);
    expect(traceOfCall(spine, 'b1')).toEqual([b.traceId]);
    expect(seenWhileProcessing.get('a1')).toBe(a.traceId);
    expect(seenWhileProcessing.get('b1')).toBe(b.traceId);
  });

  it('keeps the trace across retries: every Ingest attempt of the item carries it', async () => {
    await spine.close();
    // The first three calls fail UNAVAILABLE: the emitter's own three tries, then the queue's retry succeeds.
    spine = await startSpine((_call, n) => n <= 3);
    queue = wire(new ScrapeQueue(false), spine);
    const r = inTrace('POST r', () => queue!.enqueue(url(HOSTS[2], 'r1'), { url: url(HOSTS[2], 'r1') }));
    await r.result.promise;

    expect(scraping.scrapePage).toHaveBeenCalledTimes(2); // dispatched twice: the queue retried it
    expect(traceOfCall(spine, 'r1')).toEqual([r.traceId, r.traceId, r.traceId, r.traceId]);
  });

  it('gives an item enqueued with no active trace a NEW root trace of its own, never the dispatch loop\'s', async () => {
    queue = wire(new ScrapeQueue(false), spine);
    const a = inTrace('POST a', () => queue!.enqueue(url(HOSTS[0], 'a1'), { url: url(HOSTS[0], 'a1') }));
    // Enqueued outside any span while A's trace drives the loop.
    const n1 = queue.enqueue(url(HOSTS[1], 'n1'), { url: url(HOSTS[1], 'n1') });
    const n2 = queue.enqueue(url(HOSTS[3], 'n2'), { url: url(HOSTS[3], 'n2') });
    await Promise.all([a.result.promise, n1.promise, n2.promise]);

    const [t1] = traceOfCall(spine, 'n1');
    const [t2] = traceOfCall(spine, 'n2');
    expect(t1).toMatch(/^[0-9a-f]{32}$/);
    expect(t2).toMatch(/^[0-9a-f]{32}$/);
    expect(new Set([a.traceId, t1, t2]).size).toBe(3);
    expect(seenWhileProcessing.get('n1')).toBe(t1);
    expect(seenWhileProcessing.get('n2')).toBe(t2);

    await tracing.forceFlush();
    const roots = exporter.spans.filter(s => s.name === 'scrape.enqueue' && (s.spanContext().traceId === t1 || s.spanContext().traceId === t2));
    expect(roots).toHaveLength(2);
    for (const root of roots) expect(root.parentSpanContext).toBeUndefined();
  });

  it("runs the dispatch loop itself in no item's trace", async () => {
    const loopLines: Array<string | undefined> = [];
    // The suite's setup makes console.log a jest.fn; note the trace active when the loop writes its idle line.
    jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      if (String(args[0]).includes('Queue empty, processing stopped')) loopLines.push(trace.getSpanContext(context.active())?.traceId);
    });
    queue = wire(new ScrapeQueue(false), spine);
    const a = inTrace('POST a', () => queue!.enqueue(url(HOSTS[0], 'a1'), { url: url(HOSTS[0], 'a1') }));
    await a.result.promise;
    await until(() => loopLines.length > 0);

    expect(loopLines).toEqual([undefined]);
  });

  it("restores each item's trace from the durable store after a restart; a row an older build wrote gets a new root", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrape-queue-trace-'));
    try {
      // Process one: enqueue, never dispatch (test mode), shut down.
      const before = new ScrapeQueue(true);
      const store = openQueueStore({ dir });
      before.setQueueStore(store);
      const a = inTrace('POST a', () => before.enqueue(url(HOSTS[0], 'a1'), { url: url(HOSTS[0], 'a1') }));
      a.result.promise.catch(() => undefined);
      // A row as the develop build writes it: no trace.
      store.put({ id: 'old-1', mfcId: url(HOSTS[1], 'o1'), url: url(HOSTS[1], 'o1'), priority: 'WARM', attempts: 0, maxRetries: 3, enqueuedAt: Date.now(), state: 'pending' });
      before.stop();
      before.closeQueueStore();

      // Process two: restore and dispatch.
      queue = wire(new ScrapeQueue(false), spine);
      queue.setQueueStore(openQueueStore({ dir }));
      expect(queue.restoreFromStore().pending).toBe(2);
      await until(() => spine.calls.length === 2);

      expect(traceOfCall(spine, 'a1')).toEqual([a.traceId]);
      const [old] = traceOfCall(spine, 'o1');
      expect(old).toMatch(/^[0-9a-f]{32}$/);
      expect(old).not.toBe(a.traceId);
      expect(seenWhileProcessing.get('o1')).toBe(old);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('restores a row whose stored traceparent is malformed as a NEW root trace of its own: never continued, never a crash', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrape-queue-trace-'));
    // What a damaged or hand-edited file might hold. None of these parses (fc-shared parseTraceparent), so none may
    // be continued or carried into the item: each item is processed under a new root trace, as a row with no trace is.
    const id32 = '4bf92f3577b34da6a3ce929d0e0e4736';
    const MALFORMED: Array<[string, string]> = [
      ['garbage', 'not-a-traceparent'],
      ['empty', ''],
      ['zero-trace', `00-${'0'.repeat(32)}-00f067aa0ba902b7-01`],
      ['zero-span', `00-${id32}-${'0'.repeat(16)}-01`],
      ['version-ff', `ff-${id32}-00f067aa0ba902b7-01`],
      ['upper-case', `00-${id32.toUpperCase()}-00F067AA0BA902B7-01`],
      ['header-injection', `00-${id32}-00f067aa0ba902b7-01\r\nx-injected: 1`],
      ['overlong', `00-${id32}-00f067aa0ba902b7-01${'0'.repeat(65_536)}`],
    ];
    const ids = [...MALFORMED.map(([id]) => id), 'integer', 'blob'];
    try {
      const store = openQueueStore({ dir });
      MALFORMED.forEach(([id, traceparent], i) => {
        const u = url(HOSTS[i % HOSTS.length], id);
        store.put({ id, mfcId: u, url: u, priority: 'WARM', attempts: 0, maxRetries: 3, enqueuedAt: Date.now() + i, state: 'pending', traceparent });
      });
      for (const id of ['integer', 'blob']) {
        const u = url(HOSTS[1], id);
        store.put({ id, mfcId: u, url: u, priority: 'WARM', attempts: 0, maxRetries: 3, enqueuedAt: Date.now() + 20, state: 'pending' });
      }
      store.close();
      // Two values no build writes: an integer (the TEXT column stores it as the text "42") and a blob (kept as bytes).
      const db = new DatabaseSync(path.join(dir, QUEUE_DB_FILE));
      db.prepare("UPDATE queue_items SET traceparent = 42 WHERE id = 'integer'").run();
      db.prepare("UPDATE queue_items SET traceparent = x'00ff' WHERE id = 'blob'").run();
      db.close();

      // Restored inside a span (a boot span, say): a new root is a root, never a child of whatever is active.
      queue = wire(new ScrapeQueue(false), spine);
      queue.setQueueStore(openQueueStore({ dir }));
      const boot = inTrace('boot', () => queue!.restoreFromStore());
      expect(boot.result.pending).toBe(ids.length);
      await until(() => spine.calls.length === ids.length);

      // Per item: the trace its one Ingest call carried, and the trace the code run for it saw.
      const called = Object.fromEntries(ids.map(id => [id, traceOfCall(spine, id).map(t => t ?? 'no trace')]));
      expect(called).toEqual(Object.fromEntries(ids.map(id => [id, [expect.stringMatching(/^[0-9a-f]{32}$/)]])));
      const restored = ids.map(id => called[id][0]);
      expect(Object.fromEntries(ids.map(id => [id, seenWhileProcessing.get(id)]))).toEqual(Object.fromEntries(ids.map((id, i) => [id, restored[i]])));
      // Each its own trace: not the stored one (repaired or not), not the boot span's, not another item's.
      expect(new Set([...restored, id32, boot.traceId]).size).toBe(ids.length + 2);

      await tracing.forceFlush();
      const roots = exporter.spans.filter(s => s.name === 'scrape.enqueue' && restored.includes(s.spanContext().traceId));
      expect(roots).toHaveLength(ids.length);
      for (const root of roots) expect(root.parentSpanContext).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
